// Real Chromium contexts, real Uvicorn signaling, real WebRTC, byte-verified downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';

const base = process.env.LANFLUX_TEST_URL || 'http://127.0.0.1:8765';
const output = resolve('output/playwright');
const docsShots = resolve('docs/screenshots');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const transfer = (page, name) => page.locator('[data-transfer-id]').filter({hasText:name});

test('LANFLUX real browser sharing and lifecycle', {timeout:180000}, async t => {
  await mkdir(output, {recursive:true});
  await mkdir(docsShots, {recursive:true});
  let server, browser;
  let logs = '';
  const errors = [];
  const signals = [];
  const rooms = [];
  try {
    if (!process.env.LANFLUX_TEST_URL) {
      const python = process.env.LANFLUX_PYTHON || resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
      server = spawn(python, ['-m','lanflux','--port','8765'], {
        cwd:resolve('.'), env:{...process.env, LANFLUX_STUN_URLS:'',LANFLUX_TRUSTED_HOSTS:'lanflux.test'}, stdio:['ignore','pipe','pipe'],
      });
      server.stdout.on('data', data => {logs += data;});
      server.stderr.on('data', data => {logs += data;});
      for (let i=0;i<80;i++) {
        try {if ((await fetch(`${base}/health`)).ok) break;} catch {}
        if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
        await pause(250);
      }
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
    browser = await chromium.launch({headless:true, channel:'chromium', args:['--host-resolver-rules=MAP lanflux.test 127.0.0.1', '--no-proxy-server'], ...(process.env.LANFLUX_CHROMIUM_PATH ? {executablePath:process.env.LANFLUX_CHROMIUM_PATH} : {})});
    const contextA = await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
    const contextB = await browser.newContext({acceptDownloads:true,viewport:{width:390,height:844}});
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    for (const p of [a,b]) {
      p.on('pageerror', e => errors.push(e.message));
      p.on('websocket', ws => ws.on('framesent', frame => signals.push(JSON.parse(String(frame.payload)))));
    }
    await Promise.all([a.goto(base),b.goto(base)]);
    await a.waitForFunction(() => window.lanfluxClient?.config);
    await b.waitForFunction(() => window.lanfluxClient?.config);
    await a.screenshot({path:resolve(output,'desktop.png'),fullPage:true});
    await b.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
    await a.screenshot({path:resolve(docsShots,'landing.png'),fullPage:true});

    await t.test('create, invitation join, QR, and direct connection', async () => {
      await a.locator('#device-name').fill('Desktop');
      await a.locator('#create-room').click();
      await a.waitForFunction(() => window.lanfluxClient.roomId && window.lanfluxClient.socket?.readyState === 1);
      const room = await a.evaluate(() => window.lanfluxClient.roomId);
      rooms.push(room);
      assert.match(room,/^[A-Z2-9]{16}$/);
      const qr = await fetch(`${base}/api/rooms/${room}/qr`);
      assert.equal(qr.status,200);
      assert.match(await qr.text(),/<svg/);
      await b.goto(`${base}/?room=${room}`);
      await b.waitForFunction(() => window.lanfluxClient?.config);
      await b.locator('#device-name').fill('Phone browser');
      await b.locator('#join-room').click();
      await Promise.all([a.waitForFunction(() => window.lanfluxClient.connected, null, {timeout:30000}), b.waitForFunction(() => window.lanfluxClient.connected, null, {timeout:30000})]);
      await a.waitForFunction(() => window.lanfluxClient._route === 'direct');
    });

    await t.test('consent gates file bytes; sequential binary and empty files download exactly', async () => {
      const bytes = Buffer.alloc(1024*1024);
      for(let i=0;i<bytes.length;i++) bytes[i]=i%251;
      await a.locator('#file-input').setInputFiles([
        {name:'sample.bin',mimeType:'application/octet-stream',buffer:bytes},
        {name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)},
      ]);
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'sample.bin' && x.status === 'approval-needed'));
      assert.equal(await b.evaluate(() => [...window.lanfluxClient.transfers.values()].find(x => x.name === 'sample.bin').bytes),0);
      assert.equal(await a.evaluate(() => [...window.lanfluxClient.transfers.values()].find(x => x.name === 'empty.txt').status),'queued');
      await transfer(b,'sample.bin').locator('[data-action="approve"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'sample.bin' && x.status === 'completed'));
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'sample.bin' && x.status === 'completed'));
      for (const page of [a,b]) {
        const record = await page.evaluate(() => {
          const x = [...window.lanfluxClient.transfers.values()].find(x => x.name === 'sample.bin');
          return {hashStatus:x.hashStatus,sha256:x.sha256,actualSha256:x.actualSha256};
        });
        assert.equal(record.hashStatus,'verified');
        assert.equal(record.sha256,createHash('sha256').update(bytes).digest('hex'));
        assert.equal(record.actualSha256,record.sha256);
        assert.match(await transfer(page,'sample.bin').innerText(),/Integrity Verified/);
      }
      const download = b.waitForEvent('download');
      await transfer(b,'sample.bin').locator('[data-action="download"]').click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(),'sample.bin');
      assert.deepEqual(await readFile(await saved.path()),bytes);
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'empty.txt' && x.status === 'approval-needed'));
      await transfer(b,'empty.txt').locator('[data-action="approve"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'empty.txt' && x.status === 'completed'));
      const emptyDownload = b.waitForEvent('download');
      await transfer(b,'empty.txt').locator('[data-action="download"]').click();
      assert.equal((await readFile(await (await emptyDownload).path())).length,0);
      await Promise.all([a.locator('#toast').waitFor({state:'hidden'}),b.locator('#toast').waitFor({state:'hidden'})]);
      await a.evaluate(() => {document.activeElement?.blur();window.scrollTo(0,0);});
      await b.evaluate(() => {document.activeElement?.blur();window.scrollTo(0,0);});
      await a.screenshot({path:resolve(docsShots,'desktop.png'),fullPage:true});
      await b.screenshot({path:resolve(docsShots,'mobile.png'),fullPage:true});
    });

    await t.test('reverse transfer sanitizes filename and preserves file bytes', async () => {
      const bytes = Buffer.from('LANFLUX reverse transfer \u0000 with a null byte');
      await b.locator('#file-input').setInputFiles({name:'unsafe<file>.txt',mimeType:'text/plain',buffer:bytes});
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.direction === 'receive' && x.status === 'approval-needed'));
      await a.locator('[data-action="approve"]').click();
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.direction === 'receive' && x.status === 'completed'));
      assert.equal(await a.locator('script').count(),1);
      const download = a.waitForEvent('download');
      await a.locator('[data-action="download"]').click();
      assert.deepEqual(await readFile(await (await download).path()),bytes);
    });

    await t.test('reject and cancel waiting approval clean up both queues', async () => {
      await a.locator('#file-input').setInputFiles({name:'reject.txt',mimeType:'text/plain',buffer:Buffer.from('decline')});
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'reject.txt' && x.status === 'approval-needed'));
      await transfer(b,'reject.txt').locator('[data-action="reject"]').click();
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'reject.txt' && x.status === 'rejected'));
      await a.locator('#file-input').setInputFiles({name:'cancel.txt',mimeType:'text/plain',buffer:Buffer.from('cancel')});
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'cancel.txt' && x.status === 'approval-needed'));
      await transfer(a,'cancel.txt').locator('[data-action="cancel"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'cancel.txt' && x.status === 'cancelled'));
    });

    await t.test('receiver cancellation during chunk streaming permits the next file', async () => {
      await a.evaluate(() => {
        const client = window.lanfluxClient;
        const original = client.channel.send.bind(client.channel);
        window.binaryFrames = 0;
        window.maxBuffered = 0;
        client.channel.send = data => {
          if (typeof data !== 'string') window.binaryFrames++;
          window.maxBuffered = Math.max(window.maxBuffered,client.channel.bufferedAmount);
          return original(data);
        };
        client.addFiles([new File([new Uint8Array(16*1024*1024)],'midstream.bin')]);
      });
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'midstream.bin' && x.status === 'approval-needed'));
      await b.evaluate(() => {
        const client = window.lanfluxClient;
        const binary = client._onBinary.bind(client);
        client._onBinary = data => {
          binary(data);
          const active = [...client.transfers.values()].find(x => x.name === 'midstream.bin');
          if (active?.status === 'transferring' && active.bytes >= 65536) client.cancel(active.id);
        };
        client.approve([...client.transfers.values()].find(x => x.name === 'midstream.bin').id);
      });
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'midstream.bin' && x.status === 'cancelled'));
      assert.ok(await a.evaluate(() => window.binaryFrames > 1));
      assert.ok(await a.evaluate(() => window.maxBuffered <= 256*1024+16400));
      await a.locator('#file-input').setInputFiles({name:'after-cancel.txt',mimeType:'text/plain',buffer:Buffer.from('still connected')});
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-cancel.txt' && x.status === 'approval-needed'));
      await transfer(b,'after-cancel.txt').locator('[data-action="approve"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-cancel.txt' && x.status === 'completed'));
    });

    await t.test('real diagnostics, privacy controls, report exports, dialogs, and narrow layouts', async () => {
      await a.waitForFunction(() => Number.isFinite(window.lanfluxClient._rttMs));
      await a.waitForFunction(() => document.getElementById('metric-total').textContent !== '0 B');
      assert.match(await a.locator('#metric-rtt').innerText(),/ms/);
      assert.equal(await a.locator('#state-signaling').innerText(),'open');
      assert.equal(await a.locator('#state-channel').innerText(),'open');
      assert.equal(await a.locator('#ice-details-panel').isVisible(),false);
      await a.locator('a[href="#network-diagnostics"]').click();
      assert.equal(new URL(a.url()).hash,'#network-diagnostics');
      await a.locator('#inspect-connection').click();
      assert.equal(await a.locator('#ice-details-panel').isVisible(),true);
      await a.locator('#hide-ice-details').click();
      assert.equal(await a.locator('#ice-details').innerText(),'');
      await a.locator('#network-diagnostics').screenshot({path:resolve(docsShots,'network.png')});
      await a.locator('#experiment-environment').fill('Chromium automated loopback test');
      const csvDownload = a.waitForEvent('download');
      await a.locator('#export-csv').click();
      const csv = await readFile(await (await csvDownload).path(),'utf8');
      assert.match(csv,/sample\.bin/);
      assert.match(csv,/Verified/);
      assert.match(csv,/Chromium automated loopback test/);
      assert.ok(!csv.includes(await a.evaluate(() => window.lanfluxClient.roomId)));
      const reportDownload = a.waitForEvent('download');
      await a.locator('#export-report').click();
      assert.match(await readFile(await (await reportDownload).path(),'utf8'),/SHA-256/);
      await a.locator('#settings-open').click();
      assert.equal(await a.locator('#settings-dialog').isVisible(),true);
      await a.keyboard.press('Escape');
      assert.equal(await a.locator('#settings-dialog').isVisible(),false);
      await a.locator('#qr-open').click();
      await a.waitForFunction(() => document.getElementById('qr-image').complete && document.getElementById('qr-image').naturalWidth > 0);
      await a.keyboard.press('Escape');
      for (const width of [320,390,768]) {
        await b.setViewportSize({width,height:844});
        assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`Overflow at ${width}px`);
      }
      await b.setViewportSize({width:390,height:844});
    });

    await t.test('mobile layout, memory cleanup, and replacement peer re-pairing', async () => {
      assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await b.screenshot({path:resolve(output,'mobile-connected.png'),fullPage:true});
      await a.screenshot({path:resolve(output,'desktop-connected.png'),fullPage:true});
      await b.locator('#clear-completed').click();
      await b.locator('#confirm-action').click();
      assert.equal(await b.evaluate(() => window.lanfluxClient._memoryUsed),0);
      const room = await a.evaluate(() => window.lanfluxClient.roomId);
      await a.locator('#leave-room').click();
      await b.waitForFunction(() => !window.lanfluxClient.connected && window.lanfluxClient.initiator);
      await a.locator('#room-code').fill(room);
      await a.locator('#join-room').click();
      await Promise.all([a.waitForFunction(() => window.lanfluxClient.connected),b.waitForFunction(() => window.lanfluxClient.connected)]);
      assert.ok(signals.length>0);
      assert.ok(signals.every(x => ['offer','answer','ice','ping'].includes(x.type)), 'File contents or metadata leaked into signaling');
      assert.deepEqual(errors,[]);
    });

    await t.test('simultaneous opposite-direction transfers use independent reliable queues', async () => {
      await Promise.all([
        a.locator('#file-input').setInputFiles({name:'duplex-a.txt',mimeType:'text/plain',buffer:Buffer.from('from a')}),
        b.locator('#file-input').setInputFiles({name:'duplex-b.txt',mimeType:'text/plain',buffer:Buffer.from('from b')}),
      ]);
      await Promise.all([
        a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'duplex-b.txt' && x.status === 'approval-needed')),
        b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'duplex-a.txt' && x.status === 'approval-needed')),
      ]);
      await Promise.all([
        transfer(a,'duplex-b.txt').locator('[data-action="approve"]').click(),
        transfer(b,'duplex-a.txt').locator('[data-action="approve"]').click(),
      ]);
      await Promise.all([
        a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'duplex-b.txt' && x.status === 'completed')),
        b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'duplex-a.txt' && x.status === 'completed')),
      ]);
    });

    await t.test('actual corrupted DataChannel payload fails integrity and permits a clean next file', async () => {
      await a.evaluate(() => {
        const client = window.lanfluxClient;
        const channel = client.channel;
        const original = channel.send.bind(channel);
        let changed = false;
        channel.send = data => {
          if (typeof data !== 'string' && !changed) {
            changed = true;
            const copy = new Uint8Array(data.byteLength);
            copy.set(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength));
            copy[16] ^= 1;
            channel.send = original;
            return original(copy);
          }
          return original(data);
        };
        client.addFiles([new File(['actual corruption test'],'corrupt.bin')]);
      });
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'corrupt.bin' && x.status === 'approval-needed'));
      await transfer(b,'corrupt.bin').locator('[data-action="approve"]').click();
      for (const page of [a,b]) {
        await page.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'corrupt.bin' && x.status === 'failed'));
        assert.equal(await page.evaluate(() => [...window.lanfluxClient.transfers.values()].find(x => x.name === 'corrupt.bin').hashStatus),'failed');
        assert.equal(await transfer(page,'corrupt.bin').locator('[data-action="download"]').count(),0);
      }
      await a.locator('#file-input').setInputFiles({name:'after-corruption.txt',mimeType:'text/plain',buffer:Buffer.from('clean restart')});
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-corruption.txt' && x.status === 'approval-needed'));
      await transfer(b,'after-corruption.txt').locator('[data-action="approve"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-corruption.txt' && x.status === 'completed'));
    });

    await t.test('sender cancellation during hashing and streaming never becomes verified completion', async () => {
      await a.evaluate(() => {
        const client = window.lanfluxClient;
        const [id] = client.addFiles([new File([new Uint8Array(8*1024*1024)],'hash-cancel.bin')]);
        client.cancel(id);
      });
      await a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'hash-cancel.bin' && x.status === 'cancelled' && !x._hash));
      assert.equal(await b.evaluate(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'hash-cancel.bin')),false);
      await a.evaluate(() => {
        const client = window.lanfluxClient;
        const channel = client.channel;
        const original = channel.send.bind(channel);
        let sent = 0;
        channel.send = data => {
          const result = original(data);
          if (typeof data !== 'string') {
            sent += data.byteLength - 16;
            if (sent >= 65536) {
              channel.send = original;
              const id = client._activeSend;
              queueMicrotask(() => client.cancel(id));
            }
          }
          return result;
        };
        client.addFiles([new File([new Uint8Array(2*1024*1024)],'sender-cancel.bin')]);
      });
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'sender-cancel.bin' && x.status === 'approval-needed'));
      await transfer(b,'sender-cancel.bin').locator('[data-action="approve"]').click();
      for (const page of [a,b]) {
        await page.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'sender-cancel.bin' && x.status === 'cancelled'));
        assert.equal(await page.evaluate(() => [...window.lanfluxClient.transfers.values()].find(x => x.name === 'sender-cancel.bin').hashStatus),'pending');
      }
      assert.equal(await transfer(b,'sender-cancel.bin').locator('[data-action="download"]').count(),0);
    });

    await t.test('DataChannel interruption and browser reload stop unfinished transfers and allow rejoining', async () => {
      await a.evaluate(() => window.lanfluxClient.addFiles([new File([new Uint8Array(2*1024*1024)],'interrupted.bin')]));
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'interrupted.bin' && x.status === 'approval-needed'));
      await b.evaluate(() => {
        const client = window.lanfluxClient;
        const binary = client._onBinary.bind(client);
        client._onBinary = data => {binary(data);client.channel?.close();};
        client.approve([...client.transfers.values()].find(x => x.name === 'interrupted.bin').id);
      });
      await Promise.all([a.waitForFunction(() => !window.lanfluxClient.connected),b.waitForFunction(() => !window.lanfluxClient.connected)]);
      for (const page of [a,b]) {
        assert.equal(await page.evaluate(() => [...window.lanfluxClient.transfers.values()].find(x => x.name === 'interrupted.bin').status),'failed');
      }
      const room = await a.evaluate(() => window.lanfluxClient.roomId);
      await b.reload();
      await b.waitForFunction(() => window.lanfluxClient?.config);
      await a.waitForFunction(() => window.lanfluxClient.initiator && !window.lanfluxClient.pc);
      await b.locator('#room-code').fill(room);
      await b.locator('#join-room').click();
      await Promise.all([a.waitForFunction(() => window.lanfluxClient.connected),b.waitForFunction(() => window.lanfluxClient.connected)]);
      await a.locator('#file-input').setInputFiles({name:'after-reload.txt',mimeType:'text/plain',buffer:Buffer.from('reload restart')});
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-reload.txt' && x.status === 'approval-needed'));
      await transfer(b,'after-reload.txt').locator('[data-action="approve"]').click();
      await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.name === 'after-reload.txt' && x.status === 'completed'));
      assert.deepEqual(errors,[]);
    });

    if (!process.env.LANFLUX_TEST_URL) await t.test('LAN-style insecure HTTP supports room pairing and real downloads', async () => {
      // The reserved .test hostname maps locally but is not a trustworthy localhost origin.
      const lanContext = await browser.newContext({acceptDownloads:true,viewport:{width:390,height:844}});
      const x = await lanContext.newPage();
      const y = await lanContext.newPage();
      const lanBase = 'http://lanflux.test:8765';
      await Promise.all([x.goto(lanBase),y.goto(lanBase)]);
      await Promise.all([x.waitForFunction(() => window.lanfluxClient?.config),y.waitForFunction(() => window.lanfluxClient?.config)]);
      assert.equal(await x.evaluate(() => window.isSecureContext),false);
      assert.equal(await x.evaluate(() => typeof crypto.randomUUID),'undefined');
      assert.equal(await x.evaluate(() => typeof crypto.subtle),'undefined');
      await x.locator('#create-room').click();
      await x.waitForFunction(() => window.lanfluxClient.roomId && window.lanfluxClient.socket?.readyState === 1);
      const room = await x.evaluate(() => window.lanfluxClient.roomId);
      rooms.push(room);
      await y.locator('#room-code').fill(room.match(/.{4}/g).join(' '));
      await y.locator('#join-room').click();
      await Promise.all([x.waitForFunction(() => window.lanfluxClient.connected),y.waitForFunction(() => window.lanfluxClient.connected)]);
      assert.equal(await x.locator('#local-link-warning').isVisible(),false);
      await x.locator('#file-input').setInputFiles({name:'lan-http.txt',mimeType:'text/plain',buffer:Buffer.from('plain HTTP local development')});
      await y.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.status === 'approval-needed'));
      await y.locator('[data-action="approve"]').click();
      await y.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(x => x.status === 'completed'));
      assert.equal(await y.evaluate(() => [...window.lanfluxClient.transfers.values()][0].hashStatus),'verified');
      const download = y.waitForEvent('download');
      await y.locator('[data-action="download"]').click();
      assert.equal(await readFile(await (await download).path(),'utf8'),'plain HTTP local development');
      await lanContext.close();
    });
    assert.deepEqual(errors,[]);
    if (server) for (const room of rooms) assert.ok(!logs.includes(room),'Room capability leaked into server logs');
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill('SIGINT');
      await Promise.race([new Promise(resolve => server.once('exit',resolve)),pause(3000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
  }
});
