// Optional integration against the actual Nginx deployment template and Python app.
// Certificates/credentials are temporary; Chromium trusts only this fixture's SPKI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createHash, randomBytes} from 'node:crypto';
import {chromium} from 'playwright';

const nginxBinary = process.env.LANFLUX_NGINX_BINARY || 'nginx';
const probe = spawnSync(nginxBinary, ['-v'], {timeout:5000, stdio:'ignore'});
const missing = probe.error?.code === 'ENOENT' || probe.status === 127;
const skip = missing && process.env.LANFLUX_REQUIRE_NETWORK_SERVICES !== '1'
  ? 'Install Nginx or set LANFLUX_NGINX_BINARY to run the real HTTPS proxy integration.' : false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise((resolve, reject) => {
  const socket = createServer();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const value = socket.address().port;
    socket.close(() => resolve(value));
  });
});

function openssl(args, input) {
  const result = spawnSync('openssl', args, {input, timeout:10000});
  assert.equal(result.status, 0, 'OpenSSL fixture generation must succeed');
  return result.stdout;
}

function request(url, {ca, method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const request = send(url, {ca, method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode, body:Buffer.concat(chunks).toString()}));
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({status:response.statusCode, body:''});
    });
    request.setTimeout(2000, () => request.destroy(new Error('Fixture HTTP request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(1000)]);
  }
}

test('real Nginx HTTPS edge preserves WSS, file bytes and live-peer AI authorization',
  {skip, timeout:120000}, async t => {
    assert.ok(!probe.error && probe.status === 0,
      'Nginx is required; install it or set LANFLUX_NGINX_BINARY to an executable binary');
    const folder = await mkdtemp(join(tmpdir(), 'lanflux-proxy-'));
    let application, nginx, browser;
    const contexts = [];
    try {
      const cert = join(folder, 'cert.pem'), key = join(folder, 'key.pem');
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
      const ca = await readFile(cert);
      const publicKey = openssl(['x509', '-in', cert, '-pubkey', '-noout']);
      const der = openssl(['pkey', '-pubin', '-outform', 'DER'], publicKey);
      const pin = createHash('sha256').update(der).digest('base64');
      const username = `fixture-${randomBytes(8).toString('hex')}`;
      const password = randomBytes(24).toString('hex');
      const passwordHash = openssl(['passwd', '-6', '-stdin'], Buffer.from(password)).toString().trim();
      const passwordFile = join(folder, 'htpasswd');
      await writeFile(passwordFile, `${username}:${passwordHash}\n`, {mode:0o600});
      const appPort = await port(), webPort = await port(), redirectPort = await port();
      const base = `https://localhost:${webPort}`;
      const upstream = `http://127.0.0.1:${appPort}`;
      const python = process.env.LANFLUX_PYTHON || resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
      application = spawn(python, ['-m', 'lanflux', '--host', '127.0.0.1', '--port', String(appPort),
        '--forwarded-allow-ips', '127.0.0.1,::1'], {
        cwd:resolve('.'), stdio:'ignore', env:{...process.env,
          LANFLUX_PUBLIC_URL:base, LANFLUX_ALLOWED_ORIGINS:base, LANFLUX_TRUSTED_HOSTS:'localhost',
          LANFLUX_STUN_URLS:'', LANFLUX_TURN_URLS:'', LANFLUX_TURN_USERNAME:'', LANFLUX_TURN_CREDENTIAL:'',
          LANFLUX_TURN_SHARED_SECRET:'', LANFLUX_TURN_CREDENTIAL_TTL_SECONDS:'600', LANFLUX_ICE_TRANSPORT_POLICY:'all'},
      });
      let ready = false;
      for (let n = 0; n < 80; n++) {
        try { if ((await request(`${upstream}/health`)).status === 200) { ready = true; break; } } catch {}
        assert.equal(application.exitCode, null, 'Private Python upstream exited during startup');
        await pause(200);
      }
      assert.ok(ready, 'Private Python upstream did not become ready');

      // Use the shipped template, changing only bind ports, host, upstream and fixture paths.
      let template = await readFile(resolve('deploy/nginx/lanflux.conf.example'), 'utf8');
      template = template.replaceAll('share.example.com', 'localhost')
        .replace('listen 80;', `listen 127.0.0.1:${redirectPort};`)
        .replace('listen 443 ssl;', `listen 127.0.0.1:${webPort} ssl;`)
        .replace('/etc/letsencrypt/live/localhost/fullchain.pem', cert)
        .replace('/etc/letsencrypt/live/localhost/privkey.pem', key)
        .replace('/etc/nginx/lanflux.htpasswd', passwordFile)
        .replace('/var/log/nginx/lanflux-error.log', join(folder, 'error.log'))
        .replace('http://127.0.0.1:8000', upstream);
      const config = join(folder, 'nginx.conf');
      const prefix = [
        // A root-run container must keep fixture workers able to read private temp files.
        ...(process.getuid?.() === 0 ? [`user ${userInfo().username};`] : []),
        'worker_processes 1;', `pid ${join(folder, 'nginx.pid')};`,
        `error_log ${join(folder, 'master.log')} warn;`, 'events { worker_connections 128; }',
        'http {', 'access_log off;',
        ...['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map(name => `${name}_temp_path ${join(folder, name)};`),
      ].join('\n');
      await writeFile(config, `${prefix}\n${template}\n}\n`, {mode:0o600});
      const nginxArgs = ['-p', `${folder}/`, '-c', config];
      const validate = spawnSync(nginxBinary, [...nginxArgs, '-t'], {timeout:5000, stdio:'ignore'});
      assert.equal(validate.status, 0, 'The actual deployment template must pass nginx -t');
      nginx = spawn(nginxBinary, [...nginxArgs, '-g', 'daemon off;'], {stdio:'ignore'});
      ready = false;
      for (let n = 0; n < 50; n++) {
        try { if ((await request(`${base}/health`, {ca})).status === 401) { ready = true; break; } } catch {}
        assert.equal(nginx.exitCode, null, 'Nginx exited during startup');
        await pause(100);
      }
      assert.ok(ready, 'HTTPS edge did not become ready with valid fixture trust');

      await t.test('anonymous admission stays denied; exact AI routes retain backend authorization', async () => {
        assert.equal((await request(`${base}/api/config`, {ca})).status, 401);
        assert.equal((await request(`${base}/api/rooms`, {ca, method:'POST', headers:{Origin:base}})).status, 401);
        assert.equal((await request(`${base}/ws/${'A'.repeat(16)}`, {ca, headers:{
          Origin:base, Connection:'Upgrade', Upgrade:'websocket',
          'Sec-WebSocket-Version':'13', 'Sec-WebSocket-Key':randomBytes(16).toString('base64'),
        }})).status, 401);
        for (const action of ['sample', 'reset', 'export']) {
          // Valid schema, invalid identity/token: the REAL Python API must deny this with 403.
          const body = {room_id:'A'.repeat(16), peer_id:'a'.repeat(24)};
          if (action === 'sample') body.sample = {
            rtt_ms:1, throughput_mbps:0, interval_ms:1000, total_bytes:0,
            active_transfer:false, route:'unknown',
          };
          const response = await request(`${base}/api/aiml/${action}`, {ca, method:'POST',
            headers:{Origin:base, 'Content-Type':'application/json', Authorization:'Bearer invalidFixtureToken'},
            body:JSON.stringify(body)});
          assert.equal(response.status, 403, `${action} must reach backend authorization, not Nginx Basic auth`);
          assert.match(response.body, /monitoring session is unavailable/);
        }
        for (const path of ['/api/aiml/other', '/api/aiml/sample/', '/API/aiml/sample']) {
          assert.equal((await request(`${base}${path}`, {ca, headers:{Authorization:'Bearer invalidFixtureToken'}})).status, 401);
        }
      });

      // HTTP negative cases and complete module graphs share one loopback source IP.
      // Respect the shipped edge limiter rather than disabling it for this test.
      await pause(2000);

      browser = await chromium.launch({headless:true, channel:'chromium',
        args:[`--ignore-certificate-errors-spki-list=${pin}`, '--no-proxy-server'],
        ...(process.env.LANFLUX_CHROMIUM_PATH ? {executablePath:process.env.LANFLUX_CHROMIUM_PATH} : {})});
      const errors = [];
      for (let n = 0; n < 2; n++) contexts.push(await browser.newContext({acceptDownloads:true,
        httpCredentials:{username, password, origin:base}}));
      const a = await contexts[0].newPage(), b = await contexts[1].newPage();
      const signalingEvents = [];
      const httpFailures = [];
      for (const [index, page] of [a, b].entries()) {
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
          if (response.status() < 400 || httpFailures.length >= 40) return;
          const path = new URL(response.url()).pathname;
          const category = path.startsWith('/static/') ? 'static asset' : path === '/api/config' ? 'config'
            : path.startsWith('/ws/') ? 'WebSocket' : path.startsWith('/api/rooms') ? 'room API'
              : path.startsWith('/api/aiml/') ? 'AI API' : 'page';
          httpFailures.push({peer:index, status:response.status(), category});
        });
        page.on('websocket', socket => socket.on('framereceived', frame => {
          try {
            const message = JSON.parse(String(frame.payload));
            // Diagnose protocol transitions only; never log IDs, credentials, candidates or SDP.
            if (signalingEvents.length < 60) signalingEvents.push({peer:index, type:message.type, code:message.code});
          } catch {}
        }));
      }
      await Promise.all([a.goto(base), b.goto(base)]);
      await Promise.all([a.waitForFunction(() => window.lanfluxClient?.config), b.waitForFunction(() => window.lanfluxClient?.config)]);

      let sharingVerified = false;
      await t.test('authenticated invitation/QR joins over WSS and downloads verified actual bytes', async () => {
        await a.locator('#create-room').click();
        await a.waitForFunction(() => window.lanfluxClient.roomId && window.lanfluxClient.socket?.readyState === 1);
        const invitation = await a.locator('#invitation-url').inputValue();
        assert.equal(new URL(invitation).origin, base);
        await a.locator('#qr-open').click();
        await a.waitForFunction(() => document.getElementById('qr-image').complete
          && document.getElementById('qr-image').naturalWidth > 0);
        const qr = await a.locator('#qr-image').getAttribute('src');
        const qrResponse = await a.evaluate(async src => {
          const response = await fetch(src, {credentials:'same-origin'});
          return {status:response.status, body:await response.text()};
        }, qr);
        assert.equal(qrResponse.status, 200);
        assert.match(qrResponse.body, /<svg/);
        await a.locator('[data-close="qr-dialog"]').click();
        await pause(2000);
        await b.goto(invitation);
        try {
          await Promise.all([a.waitForFunction(() => window.lanfluxClient?.connected, null, {timeout:15000}),
            b.waitForFunction(() => window.lanfluxClient?.connected, null, {timeout:15000})]);
        } catch (error) {
          for (const [index, page] of [a, b].entries()) t.diagnostic(JSON.stringify({peer:index,
            state:await page.evaluate(() => ({loaded:Boolean(window.lanfluxClient), connected:window.lanfluxClient?.connected,
              status:document.getElementById('connection-status')?.textContent,
              error:document.getElementById('alert-text')?.textContent}))}));
          t.diagnostic(JSON.stringify({signalingEvents}));
          t.diagnostic(JSON.stringify({httpFailures}));
          throw error;
        }
        for (const page of [a, b]) {
          assert.equal(await page.evaluate(() => window.isSecureContext), true);
          assert.equal(new URL(await page.evaluate(() => window.lanfluxClient.socket.url)).protocol, 'wss:');
        }
        const bytes = Buffer.alloc(256 * 1024);
        for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
        const digest = createHash('sha256').update(bytes).digest('hex');
        await a.locator('#file-input').setInputFiles({name:'proxy-proof.bin', mimeType:'application/octet-stream', buffer:bytes});
        await b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(item => item.status === 'approval-needed'));
        assert.equal(await b.evaluate(() => [...window.lanfluxClient.transfers.values()][0].bytes), 0);
        await b.locator('[data-action="approve"]').click();
        await Promise.all([a.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(item => item.status === 'completed' && item.hashStatus === 'verified')),
          b.waitForFunction(() => [...window.lanfluxClient.transfers.values()].some(item => item.status === 'completed' && item.hashStatus === 'verified'))]);
        const downloaded = b.waitForEvent('download');
        await b.locator('[data-action="download"]').click();
        const actual = await readFile(await (await downloaded).path());
        assert.deepEqual(actual, bytes);
        assert.equal(createHash('sha256').update(actual).digest('hex'), digest);
        sharingVerified = true;
      });

      await t.test('actual measured AI samples, CSV export and reset survive edge authentication',
        {skip:sharingVerified ? false : 'File-sharing prerequisite failed'}, async () => {
        // Wait for the application's real DataChannel RTT/payload sampler; inject no telemetry.
        const sampled = await a.waitForResponse(response => new URL(response.url()).pathname === '/api/aiml/sample'
          && response.status() === 200, {timeout:20000});
        const observation = await sampled.json();
        assert.ok(observation.samples_retained >= 1);
        await a.waitForFunction(() => !document.getElementById('ai-export').disabled);
        const exported = a.waitForResponse(response => new URL(response.url()).pathname === '/api/aiml/export');
        const downloaded = a.waitForEvent('download');
        await a.locator('#ai-export').click();
        assert.equal((await exported).status(), 200);
        const csv = await readFile(await (await downloaded).path(), 'utf8');
        assert.match(csv, /rtt_ms,throughput_mbps,active_transfer/);
        assert.ok(csv.trim().split(/\r?\n/).length >= 2);
        assert.ok(!csv.includes('proxy-proof.bin'));
        const reset = a.waitForResponse(response => new URL(response.url()).pathname === '/api/aiml/reset');
        await a.locator('#ai-reset').click();
        const response = await reset;
        assert.equal(response.status(), 200);
        assert.equal((await response.json()).samples_retained, 0);
        assert.equal(await a.evaluate(() => window.lanfluxClient.connected), true);
      });
      assert.deepEqual(errors, []);
    } finally {
      for (const context of contexts) await context.close();
      if (browser) await browser.close();
      await stop(nginx);
      await stop(application);
      await rm(folder, {recursive:true, force:true});
    }
  });
