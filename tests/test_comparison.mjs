import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StrategyComparison,percentile} from '../lanflux/static/comparison.js';
const hash='ab'.repeat(32);
const transfer=(extra={})=>({id:'a',direction:'send',strategy:'baseline',effectiveStrategy:'baseline',size:1000000,bytes:1000000,durationSeconds:2,status:'transferring',payloadActive:true,sha256:hash,actualSha256:hash,hashStatus:'verified',route:'direct',pacingDelayMs:0,...extra});
const finish=(c,t)=>c.observeTransfer({...t,status:'completed',payloadActive:false});
test('Actual payload duration and unique fresh pings produce Mbps and percentiles',()=>{
 const c=new StrategyComparison(()=>10),t=transfer();c.observeTransfer(t);
 for(const [at,rtt] of [[9,99],[10,10],[10,10],[20,30]])c.observeDiagnostics({dataChannelState:'open',rttMs:rtt,rttSampleAt:at});
 finish(c,t);const r=c.snapshot().records[0];assert.equal(r.throughputMbps,4);assert.equal(r.medianRttMs,20);assert.equal(r.p95RttMs,null);assert.equal(r.rttSamples,2);
 finish(c,t);assert.equal(c.snapshot().count,1);
});
test('Missing RTT is unavailable; missing digest never marks completion verified',()=>{
 const c=new StrategyComparison(()=>0),t=transfer({actualSha256:null});c.observeTransfer(t);
 c.observeDiagnostics({dataChannelState:'open',rttMs:5});finish(c,t);
 assert.equal(c.snapshot().records[0].medianRttMs,null);assert.equal(c.snapshot().groups[0].completed,0);assert.equal(c.snapshot().groups[0].failed,1);assert.equal(c.snapshot().groups[0].meanThroughputMbps,null);
});
test('Groups separate sizes, route, mixed effective modes and bidirectional observations',()=>{
 const c=new StrategyComparison(()=>0);
 const a=transfer({strategy:'ml',effectiveStrategy:'ml',pacingDelayMs:12.5});c.observeTransfer(a);c.observeTransfer({...a,effectiveStrategy:'baseline'});
 c.observeTransfer(transfer({id:'receiver',direction:'receive'}));finish(c,a);
 c.observeTransfer(transfer({id:'receiver',direction:'receive',status:'completed',payloadActive:false}));
 for(const t of [transfer({id:'b',size:2000000}),transfer({id:'c',route:'relay'})]){c.observeTransfer(t);finish(c,t);}
 const s=c.snapshot();assert.equal(s.groups[0].totalPacingDelayMs,12.5);assert.equal(s.groups.length,3);assert.equal(s.records[0].effectiveStrategy,'mixed');assert.equal(s.records[0].condition,'bidirectional');assert.equal(s.records[1].condition,'outgoing-only');
});
test('Failure outcomes remain visible without polluting completion means',()=>{
 const c=new StrategyComparison(()=>0);finish(c,transfer());
 for(const status of ['cancelled','rejected','failed'])c.observeTransfer(transfer({id:status,status,durationSeconds:500}));
 const g=c.snapshot().groups[0];assert.equal(g.runs,4);assert.equal(g.completed,1);assert.equal(g.meanDurationSeconds,2);assert.equal(g.failed,1);assert.equal(g.cancelled,1);assert.equal(g.rejected,1);
});
test('Records and RTT history bounded; exports omit identifying file and ICE metadata',()=>{
 const c=new StrategyComparison(()=>0),t=transfer({name:'SECRETFILE',room:'SECRETROOM',candidate:'192.168.1.2'});c.observeTransfer(t);
 for(let i=0;i<700;i++)c.observeDiagnostics({dataChannelState:'open',rttMs:i,rttSampleAt:i});finish(c,t);assert.equal(c.snapshot().records[0].rttSamples,600);
 assert.ok(!c.csv().includes('SECRET'));assert.ok(!c.csv().includes(hash));assert.ok(!c.report().includes('192.168'));
 for(let i=0;i<110;i++)finish(c,transfer({id:String(i)}));assert.equal(c.snapshot().count,100);
 c.clear();assert.equal(c.snapshot().count,0);assert.match(c.report(),/No observations/);
});
test('Percentiles and zero-byte files retain honest zero or unavailable values',()=>{
 assert.equal(percentile([],0.95),null);assert.equal(percentile([0,10],.5),5);
 const c=new StrategyComparison(()=>0);finish(c,transfer({size:0,bytes:0}));assert.equal(c.snapshot().records[0].throughputMbps,0);
});

test('Clearing finished records preserves active RTT tracking and terminal deduplication',()=>{
 const c=new StrategyComparison(()=>100);const first=transfer({id:'first'});finish(c,first);
 const t=transfer();c.observeTransfer(t);
 c.observeDiagnostics({dataChannelState:'open',rttMs:1,rttSampleAt:100});c.clearFinished();finish(c,first);assert.equal(c.snapshot().count,0);
 for(let i=1;i<20;i++)c.observeDiagnostics({dataChannelState:'open',rttMs:i+1,rttSampleAt:100+i});
 finish(c,t);const r=c.snapshot().records[0];assert.equal(r.rttSamples,20);assert.equal(r.p95RttMs,19.05);assert.equal(r.medianRttMs,10.5);
});
test('One ping is insufficient for median; closed channels and null measurements are excluded',()=>{
 const c=new StrategyComparison(()=>100),t=transfer();c.observeTransfer(t);
 c.observeDiagnostics({dataChannelState:'closed',rttMs:2,rttSampleAt:101});
 c.observeDiagnostics({dataChannelState:'open',rttMs:null,rttSampleAt:102});
 c.observeDiagnostics({dataChannelState:'open',rttMs:4,rttSampleAt:103});finish(c,t);
 assert.equal(c.snapshot().records[0].rttSamples,1);assert.equal(c.snapshot().records[0].medianRttMs,null);
});
