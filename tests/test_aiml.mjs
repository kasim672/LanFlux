import test from 'node:test';
import assert from 'node:assert/strict';
import {TelemetrySampler, AINetworkMonitor} from '../lanflux/static/aiml.js';

const measurement = (bytes,rtt=20) => ({totalBytes:bytes,rttMs:rtt,dataChannelState:'open',route:'direct'});

test('AI sampler derives decimal Mbps from actual byte-count differences and elapsed time', () => {
  const sampler = new TelemetrySampler();
  assert.equal(sampler.sample(measurement(0),true,false,1000),null);
  assert.equal(sampler.sample(measurement(100),true,false,1500),null);
  const sample = sampler.sample(measurement(1_000_000),true,false,2000);
  assert.equal(sample.throughput_mbps,8);
  assert.equal(sample.interval_ms,1000);
  assert.equal(sample.active_transfer,true);
  assert.equal(sample.rtt_ms,20);
  assert.equal(sampler.sample(measurement(1_000_000),true,false,3000).throughput_mbps,0);
});

test('AI observation recognizes engine transfer state even during a zero-byte interval', () => {
  let observedActive;
  const monitor = {
    connected:false, write(){}, controls(){},
    sampler:{sample(_measurement,_connected,active){observedActive=active;return null;}},
  };
  const client = {connected:true,transfers:new Map([['file',{status:'transferring'}]])};
  AINetworkMonitor.prototype.observe.call(monitor,{...measurement(100),signalingState:'open'},client,1000);
  assert.equal(observedActive,true);
  client.transfers.get('file').status = 'awaiting-approval';
  AINetworkMonitor.prototype.observe.call(monitor,{...measurement(100),signalingState:'open'},client,2000);
  assert.equal(observedActive,false);
});

test('AI sampler skips unavailable latency, disconnected peers, reload counters and suspended intervals', () => {
  const sampler = new TelemetrySampler();
  sampler.sample(measurement(100),true,false,0);
  assert.equal(sampler.sample(measurement(200,null),true,false,1000),null);
  assert.equal(sampler.sample(measurement(300),false,false,2000),null);
  assert.equal(sampler.sample(measurement(400),true,false,3000),null);
  assert.equal(sampler.sample(measurement(0),true,false,4000),null);
  assert.equal(sampler.sample(measurement(100),true,false,15000),null);
  assert.equal(sampler.sample(measurement(200,NaN),true,false,16000),null);
  assert.equal(sampler.sample({...measurement(300),dataChannelState:'closed'},true,false,17000),null);
});
