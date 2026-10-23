import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AdaptivePacer, MAX_PACING_DELAY_MS} from '../lanflux/static/adaptive.js';
import {LanfluxClient} from '../lanflux/static/transfer.js';
const observation = overrides => ({throughputMbps:10, rttMs:10, measuredAt:1000, active:true, ...overrides});
const forecast = {status:'trained', measuredAt:1000, predicted_mbps:5, validation:{mae_mbps:1, baseline_mae_mbps:2}};
test('Default baseline never paces; modes validated', () => {
  const p = new AdaptivePacer(); p.update(observation({forecast}));
  assert.equal(p.delay(16384, 1000), 0); assert.equal(p.delay(16384, 1000), 0);
  assert.equal(p.setMode('unsafe'), false); assert.equal(p.mode, 'baseline');
});
test('Rules require observed RTT increase, enforce bounded wait and clear stale/invalid data', () => {
  const p = new AdaptivePacer(); p.setMode('rules'); p.update(observation());
  assert.equal(p.decision(1000).effectiveMode, 'baseline');
  p.update(observation({rttMs:40})); assert.equal(p.decision(1000).targetMbps,9);
  for (let i=0;i<100;i++) assert.ok(p.delay(16384,1000)<=MAX_PACING_DELAY_MS);
  assert.equal(p.delay(16384,4001),0); assert.equal(p.delay(16384,999),0);
  p.update(observation({rttMs:NaN})); assert.equal(p.delay(16384,1000),0);
});
test('ML requires trained, better evaluated, fresh forecast; clamps reduction to 20 percent', () => {
  const p = new AdaptivePacer(); p.setMode('ml');
  p.update(observation({forecast})); assert.equal(p.decision(1000).targetMbps,8);
  p.update(observation({forecast:{...forecast, validation:{mae_mbps:3,baseline_mae_mbps:2}}}));
  assert.equal(p.decision(1000).effectiveMode,'baseline');
  p.update(observation({forecast:{...forecast,predicted_mbps:NaN}})); assert.equal(p.delay(1000,1000),0);
  p.update(observation({forecast,active:false})); assert.equal(p.delay(1000,1000),0);
  p.reset(); assert.equal(p.mode,'ml'); assert.equal(p.minimumRtt,null);
});
test('Strategy changes blocked during active send and observation errors fail open', () => {
  const c=new LanfluxClient(); assert.equal(c.setTransferStrategy('rules'),true);
  c._activeSend='active'; assert.equal(c.setTransferStrategy('ml'),false);
  c.updateTransferIntelligence({get throughputMbps(){throw Error('bad')}});
  assert.equal(c._pacer.decision().effectiveMode,'baseline');
});
test('Cancellation during bounded pacing sends no extra bytes or completion', async () => {
  const c=new LanfluxClient(); c.connected=true; c.setTransferStrategy('ml');
  const frames=[]; c.channel={readyState:'open', bufferedAmount:0, send:frame=>frames.push(frame)};
  c._pacer.delay=()=>20;
  const t=c._newTransfer({id:'01'.repeat(16), direction:'send',size:32000,status:'transferring',_file:new Blob([new Uint8Array(32000)])});
  c.transfers.set(t.id,t); c._activeSend=t.id; c._startTransfer(t);
  const sending=c._sendFile(t); c.cancel(t.id); await sending;
  assert.equal(t.status,'cancelled'); assert.equal(t.bytes,0);
  assert.equal(frames.filter(x=>typeof x!=='string').length,0);
  assert.equal(frames.some(x=>typeof x==='string'&&JSON.parse(x).type==='finish'),false);
});
test('Pacing preserves negotiated frame limits, payload bytes and finish control', async () => {
  const c=new LanfluxClient(); c.connected=true; c.setTransferStrategy('rules');
  const frames=[]; c.channel={readyState:'open',bufferedAmount:0,send:frame=>frames.push(frame)};
  c.pc={sctp:{maxMessageSize:8192}}; c._pacer.delay=()=>1;
  const bytes=new Uint8Array(20000).map((_,i)=>i%251);
  const t=c._newTransfer({id:'02'.repeat(16),direction:'send',size:bytes.length,status:'transferring',_file:new Blob([bytes])});
  c._startTransfer(t); await c._sendFile(t);
  const binary=frames.filter(x=>typeof x!=='string'); assert.ok(binary.every(x=>x.length<=8192));
  assert.deepEqual(new Uint8Array(binary.flatMap(x=>Array.from(x.slice(16)))),bytes);
  assert.equal(JSON.parse(frames.at(-1)).type,'finish'); assert.equal(t.effectiveStrategy,'rules');
  assert.ok(t.pacingDelayMs>0); assert.equal(t.pacingAdjustments,binary.length);
});

test('Repeated paced observations cannot ratchet the anchor and force baseline recovery', () => {
  const p=new AdaptivePacer(); p.setMode('ml'); p.update(observation({forecast}));
  p.delay(16384,1000);
  for (let i=1;i<4;i++) {
    p.update(observation({throughputMbps:10/(i+1),measuredAt:1000+i*700,forecast:{...forecast,predicted_mbps:0}}));
    assert.ok(p.decision(1000+i*700).targetMbps>=8);
    p.delay(16384,1000+i*700);
  }
  assert.equal(p.delay(16384,4000),0);
  p.update(observation({forecast,measuredAt:5000}));
  assert.equal(p.decision(5000).effectiveMode,'baseline');
  assert.equal(p.delay(16384,5000),0);
});

test('Fresh throughput cannot refresh a stale forecast', () => {
  const p=new AdaptivePacer(); p.setMode('ml');
  p.update(observation({measuredAt:5000,forecast}));
  assert.equal(p.decision(5000).effectiveMode,'baseline');
  p.update(observation({measuredAt:5000,forecast:{...forecast,measuredAt:5000}}));
  assert.equal(p.decision(5000).effectiveMode,'ml');
});

test('Closed DataChannel during pacing cannot emit payload or finish', async () => {
  const c=new LanfluxClient(); c.connected=true; c.setTransferStrategy('rules');
  const sent=[]; c.channel={readyState:'open',bufferedAmount:0,send:x=>sent.push(x)};
  c._pacer.delay=()=>20;
  const t=c._newTransfer({id:'03'.repeat(16),direction:'send',size:100,status:'transferring',_file:new Blob([new Uint8Array(100)])});
  c._startTransfer(t); const sending=c._sendFile(t); c.channel.readyState='closed';
  await sending; assert.deepEqual(sent,[]); assert.equal(t.bytes,0);
});
