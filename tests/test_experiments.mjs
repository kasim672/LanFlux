import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExperimentReport,experimentsToCsv,experimentRecords} from '../lanflux/static/experiments.js';

const digest='ab'.repeat(32);
const complete = () => ({name:'test.bin',size:1048576,bytes:1048576,direction:'send',status:'completed',hashStatus:'verified',sha256:digest,actualSha256:digest,
  durationSeconds:2,averageSpeed:524288,peakBytesPerSecond:1000000,connectionSetupMs:125,route:'direct',startedAt:'2026-10-13T01:00:00Z',finishedAt:'2026-10-13T01:00:02Z'});

test('Observed payload bytes and duration produce correct decimal Mbps, not MiB/s',()=>{
  const [row] = experimentRecords([complete()]);
  assert.equal(row.fileSizeBytes,1048576);
  assert.equal(row.averageThroughputMbps,4.194304);
  assert.equal(row.peakObservedThroughputMbps,8);
  assert.equal(row.sha256Verification,'Verified');
  assert.equal(row.connectionSetupMs,125);
});
test('Unavailable measurements stay unavailable and empty completed files can have measured zero throughput',()=>{
  const row={...complete(),bytes:0,size:0,averageSpeed:null,peakBytesPerSecond:null,connectionSetupMs:null,route:'unknown'};
  const [record]=experimentRecords([row]);
  assert.equal(record.averageThroughputMbps,0);
  assert.equal(record.peakObservedThroughputMbps,null);
  assert.equal(record.connectionSetupMs,null);
  const report=buildExperimentReport([row]);
  assert.match(report,/peak observed: Unavailable/);
  assert.match(report,/route: Unavailable/);
});
test('A verification label never fabricates a match when the actual digest is absent or differs',()=>{
  assert.equal(experimentRecords([{...complete(),actualSha256:null}])[0].sha256Verification,'Unavailable');
  assert.equal(experimentRecords([{...complete(),hashStatus:'failed',actualSha256:'cd'.repeat(32),status:'failed',error:'Digest mismatch'}])[0].sha256Verification,'Failed');
});
test('Reports include only bounded terminal observations and do not invent empty benchmark runs',()=>{
  assert.equal(experimentRecords([{...complete(),status:'transferring'}]).length,0);
  assert.match(buildExperimentReport([]),/No terminal transfer observations/);
  assert.equal(experimentRecords(Array.from({length:101},complete)).length,100);
  assert.match(buildExperimentReport([complete()],{environmentLabel:'Wi-Fi run 1'}),/entered by user\): Wi-Fi run 1/);
});
test('CSV safely quotes user text, blocks formula injection, and omits room and ICE credentials',()=>{
  const csv=experimentsToCsv([{...complete(),name:'=HYPERLINK("evil")',roomId:'SECRETROOM',candidate:'192.168.1.10'}],{notes:' +SUM(1,2)',environmentLabel:'Wi-Fi,"test"'});
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\' +SUM(1,2)"'));
  assert.ok(csv.includes('Wi-Fi,""test""'));
  assert.ok(!csv.includes('SECRETROOM'));
  assert.ok(!csv.includes('192.168.1.10'));
});
