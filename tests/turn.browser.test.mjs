// Optional real coturn integration: loopback listeners, temporary credentials/certificates.
// No system trust store changes; Chromium trusts only this fixture's exact certificate key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {get as httpsGet} from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';

const binary=process.env.LANFLUX_TURN_BINARY || 'turnserver';
const probe=spawnSync(binary,['--help'],{timeout:5000,stdio:'ignore'});
const skip=probe.error || probe.status === 127 ? 'Install coturn or set LANFLUX_TURN_BINARY to run real relay tests.' : false;
if(skip && process.env.LANFLUX_REQUIRE_NETWORK_SERVICES === '1')throw new Error(skip);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const port=()=>new Promise((resolve,reject)=>{
  const socket=createServer(); socket.on('error',reject);
  socket.listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value));});
});
const openssl=(args,input)=>{
  const result=spawnSync('openssl',args,{input});
  assert.equal(result.status,0,'Fixture certificate generation failed');
  return result.stdout;
};
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>process.once('exit',resolve)),pause(3000)]);
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
}
function health(url,ca) {
  return new Promise(resolve=>{
    const request=httpsGet(url,{ca},response=>{response.resume();resolve(response.statusCode===200);});
    request.setTimeout(1000,()=>request.destroy());request.on('error',()=>resolve(false));
  });
}

// Core tests remain independent of coturn. This explicit suite needs its local binary.
test('real loopback coturn, HTTPS/WSS and observed direct/relay paths',{timeout:180000,skip},async t=>{
  const folder=await mkdtemp(join(tmpdir(),'lanflux-turn-'));
  const secret=randomBytes(32).toString('hex');
  let turn,browser;
  const processes=[];
  try {
    const cert=join(folder,'cert.pem'),key=join(folder,'key.pem');
    openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,
      '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const ca=await readFile(cert);
    const publicKey=openssl(['x509','-in',cert,'-pubkey','-noout']);
    const der=openssl(['pkey','-pubin','-outform','DER'],publicKey);
    const pin=createHash('sha256').update(der).digest('base64');
    const plain=await port(),tls=await port(),unreachable=await port();
    const config=join(folder,'turn.conf');
    await writeFile(config,[
      `listening-port=${plain}`,`tls-listening-port=${tls}`,'listening-ip=127.0.0.1','relay-ip=127.0.0.1',
      'relay-threads=1','realm=lanflux-fixture.test','fingerprint','use-auth-secret',`static-auth-secret=${secret}`,
      `cert=${cert}`,`pkey=${key}`,'no-tlsv1','no-tlsv1_1','no-dtls','no-cli','no-tcp-relay',
      // Test-only exception: both browser peers and relay bind to loopback. Never use in production.
      'allow-loopback-peers','min-port=20000','max-port=20100','user-quota=8','total-quota=32',
      `pidfile=${join(folder,'turn.pid')}`,`log-file=${join(folder,'turn.log')}`,'no-stdout-log','simple-log',
    ].join('\n')+'\n',{mode:0o600});
    turn=spawn(binary,['-c',config],{stdio:'ignore'});
    await pause(1000);
    assert.equal(turn.exitCode,null,'The loopback coturn fixture did not start');
    browser=await chromium.launch({headless:true,channel:'chromium',args:[`--ignore-certificate-errors-spki-list=${pin}`],
      ...(process.env.LANFLUX_CHROMIUM_PATH ? {executablePath:process.env.LANFLUX_CHROMIUM_PATH} : {})});

    async function scenario({policy,urls,blockDirect=false,expected}) {
      const appPort=await port(),base=`https://localhost:${appPort}`;
      const python=process.env.LANFLUX_PYTHON || resolve(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
      const app=spawn(python,['-m','lanflux','--port',String(appPort),'--ssl-certfile',cert,'--ssl-keyfile',key],{
        env:{...process.env,LANFLUX_PUBLIC_URL:base,LANFLUX_STUN_URLS:'',LANFLUX_TURN_URLS:urls,
          LANFLUX_TURN_SHARED_SECRET:secret,LANFLUX_TURN_USERNAME:'',LANFLUX_TURN_CREDENTIAL:'',
          LANFLUX_TURN_CREDENTIAL_TTL_SECONDS:'600',LANFLUX_ICE_TRANSPORT_POLICY:policy},stdio:'ignore'});
      processes.push(app);
      const context=await browser.newContext({acceptDownloads:true});
      if(blockDirect)await context.addInitScript(()=>{
        // Withhold direct ICE candidates only in this controlled regression, not in application code.
        Object.defineProperty(window,'lanfluxClient',{configurable:true,set(client){
          const signal=client._signal.bind(client);
          client._signal=message=>{
            if(message.type==='ice' && !/ typ relay(?: |$)/.test(message.candidate?.candidate || ''))return;
            if(['offer','answer'].includes(message.type))message={...message,sdp:message.sdp.replace(/^a=candidate:.*(?:\r?\n|$)/gm,line=>/ typ relay(?: |\r?\n|$)/.test(line)?line:'')};
            signal(message);
          };
          Object.defineProperty(window,'lanfluxClient',{value:client,writable:true,configurable:true});
        }});
      });
      const a=await context.newPage(),b=await context.newPage();
      const errors=[];for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
      try {
        let ready=false;
        for(let n=0;n<60;n++){
          if(await health(`${base}/health`,ca)){ready=true;break;}
          assert.equal(app.exitCode,null,'The HTTPS application fixture exited');await pause(250);
        }
        assert.ok(ready,'HTTPS application did not become ready');
        await Promise.all([a.goto(base),b.goto(base)]);
        for(const page of [a,b]){
          await page.waitForFunction(()=>window.lanfluxClient?.config);
          assert.equal(await page.evaluate(()=>window.isSecureContext),true);
          assert.equal(await page.evaluate(()=>window.lanfluxClient.config.ice_transport_policy),policy);
          assert.equal(await page.evaluate(()=>window.lanfluxClient.config.ice_servers.some(server=>'credential' in server)),false);

        }
        await a.locator('#create-room').click();
        await a.waitForFunction(()=>window.lanfluxClient.roomId && window.lanfluxClient.socket?.readyState===1);
        await b.goto(await a.locator('#invitation-url').inputValue());
        await Promise.all([a.waitForFunction(()=>window.lanfluxClient.connected,null,{timeout:60000}),b.waitForFunction(()=>window.lanfluxClient.connected,null,{timeout:60000})]);
        await Promise.all([a.waitForFunction(route=>window.lanfluxClient._route===route,expected),b.waitForFunction(route=>window.lanfluxClient._route===route,expected)]);
        for(const page of [a,b]){
          assert.match(await page.locator('#diagnostic-route').innerText(),expected==='relay'?/TURN Relay/:/Direct P2P/);
          assert.match(await page.evaluate(()=>window.lanfluxClient.socket.url),/^wss:/);
        }
        const bytes=Buffer.alloc(256*1024,0x5a);
        await a.locator('#file-input').setInputFiles({name:'relay-proof.bin',mimeType:'application/octet-stream',buffer:bytes});
        await b.waitForFunction(()=>[...window.lanfluxClient.transfers.values()].some(item=>item.status==='approval-needed'));
        assert.equal(await b.evaluate(()=>[...window.lanfluxClient.transfers.values()][0].bytes),0);
        await b.locator('[data-action="approve"]').click();
        await b.waitForFunction(()=>[...window.lanfluxClient.transfers.values()].some(item=>item.status==='completed' && item.hashStatus==='verified'));
        const downloaded=b.waitForEvent('download');await b.locator('[data-action="download"]').click();
        assert.deepEqual(await readFile(await (await downloaded).path()),bytes);
        assert.deepEqual(errors,[]);
      } finally {await context.close();await stop(app);}
    }
    await t.test('default all policy retains a real direct path with a relay available',()=>scenario({policy:'all',urls:`turn:localhost:${plain}?transport=tcp`,expected:'direct'}));
    await t.test('all policy uses a real relay when direct candidates are unavailable',()=>scenario({policy:'all',blockDirect:true,urls:`turn:localhost:${plain}?transport=tcp`,expected:'relay'}));
    await t.test('unreachable UDP endpoint falls back to authenticated TURN over TCP',()=>scenario({policy:'relay',urls:`turn:localhost:${unreachable}?transport=udp,turn:localhost:${plain}?transport=tcp`,expected:'relay'}));
    await t.test('TURN TLS/TCP transports actual verified files with HTTPS/WSS signaling',()=>scenario({policy:'relay',urls:`turns:localhost:${tls}?transport=tcp`,expected:'relay'}));
  } finally {
    if(browser)await browser.close();for(const child of processes)await stop(child);await stop(turn);
    await rm(folder,{recursive:true,force:true});
  }
});
