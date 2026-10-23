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

test('Forecast presentation uses server values and clears idle, stale or invalid predictions', () => {
  const fields = new Map();
  const view = {activeTransfer:true,forecastAt:null,write:(id,text)=>fields.set(id,text)};
  view.clearForecast = () => AINetworkMonitor.prototype.clearForecast.call(view);
  const render = (forecast,advice={},time=performance.now()) => AINetworkMonitor.prototype.renderForecast.call(view,forecast,advice,time);
  const forecast = {status:'trained',predicted_mbps:12.5,labeled_samples:70,
    validation:{mae_mbps:1.234,baseline_mae_mbps:2.345}};
  render(forecast,{trend:'stable',recommendation:'Actual server recommendation'});
  assert.equal(fields.get('ai-forecast'),'12.50');
  assert.equal(fields.get('ai-forecast-mae'),'1.234');
  assert.equal(fields.get('ai-trend'),'stable');
  assert.equal(fields.get('ai-advice'),'Actual server recommendation');
  render(forecast,{},performance.now()-4000);
  assert.equal(fields.get('ai-forecast'),'Unavailable');
  view.activeTransfer=false;render(forecast);
  assert.equal(fields.get('ai-forecast'),'Unavailable');
  view.activeTransfer=true;render({...forecast,predicted_mbps:NaN});
  assert.equal(fields.get('ai-forecast'),'Unavailable');
  render({status:'learning',labeled_samples:3,min_labeled_samples:60});
  assert.match(fields.get('ai-forecast-status'),/Learning from network activity/);
  assert.equal(fields.get('ai-forecast-mae'),'Unavailable');
});


test('Sampling provenance excludes receive bytes earlier in an interval and policy switches', () => {
  const sampler=new TelemetrySampler();
  const m=(bytes,received,epoch=0)=>({...measurement(bytes),receivedPayloadBytes:received,strategyEpoch:epoch});
  sampler.sample(m(0,0),true,true,0);
  sampler.sample(m(100,100),true,true,1000);
  assert.equal(sampler.receivedInInterval,true);
  sampler.sample(m(200,100),true,true,2000);
  assert.equal(sampler.receivedInInterval,false);
  sampler.sample(m(300,100,2),true,true,3000);
  assert.equal(sampler.policyChanged,true);
});

test('Intervention-conditioned forecasts are visibly qualified', () => {
  const fields=new Map();
  const view={activeTransfer:true,forecastAt:null,write:(id,text)=>fields.set(id,text)};
  view.clearForecast=()=>AINetworkMonitor.prototype.clearForecast.call(view);
  AINetworkMonitor.prototype.renderForecast.call(view,{status:'trained',intervention_conditioned:true,predicted_mbps:3,validation:{}},{},performance.now());
  assert.match(fields.get('ai-forecast-status'),/not network capacity/);
});
