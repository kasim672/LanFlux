import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PayloadMetrics, selectedPair, pairRoute, equalDigest} from '../lanflux/static/metrics.js';

test('Rates use payload bytes/second, ETA uses current rate, duration uses active time', () => {
  const metrics = new PayloadMetrics(0);
  assert.equal(metrics.snapshot(0).averageBytesPerSecond, null);
  assert.equal(metrics.snapshot(0).durationSeconds, null);
  metrics.start(0);
  metrics.add(4096);
  assert.equal(metrics.snapshot(500).currentBytesPerSecond, null);
  const sample = metrics.sample(1000, 8192);
  assert.equal(sample.currentBytesPerSecond, 4096);
  assert.equal(sample.averageBytesPerSecond, 4096);
  assert.equal(sample.etaSeconds, 2);
  assert.equal(sample.peakBytesPerSecond, 4096);
  metrics.stop(2000);
  assert.equal(metrics.snapshot(9000).durationSeconds, 2);
  assert.equal(metrics.snapshot(9000).averageBytesPerSecond, 2048);
  assert.equal(metrics.snapshot(9000).etaSeconds, null);
});

test('Room aggregate averages use union of concurrent active intervals and exclude idle gaps', () => {
  const metrics = new PayloadMetrics(0);
  metrics.start(1000);
  metrics.start(1500);
  metrics.add(2000);
  metrics.stop(2000);
  metrics.stop(3000);
  metrics.start(8000);
  metrics.add(1000);
  metrics.stop(9000);
  assert.equal(metrics.snapshot(50000).durationSeconds, 3);
  assert.equal(metrics.snapshot(50000).averageBytesPerSecond, 1000);
  assert.equal(metrics.snapshot(50000).totalBytes, 3000);
  metrics.stop(60000);
  assert.equal(metrics.snapshot(60000).durationSeconds, 3);
});

test('Short transfers have no invented peak sample, and history stays bounded to 60 samples', () => {
  const short = new PayloadMetrics(0);
  short.start(0);
  short.add(10);
  short.stop(100);
  assert.equal(short.sample(100).peakBytesPerSecond, null);
  const metrics = new PayloadMetrics(0);
  metrics.start(0);
  for (let second = 1; second <= 100; second++) {
    metrics.add(second);
    metrics.sample(second * 1000);
  }
  assert.equal(metrics.history.length, 60);
  assert.deepEqual(metrics.history[0], {timeSeconds: 41, bytesPerSecond: 41});
  assert.equal(metrics.history.at(-1).bytesPerSecond, 100);
  assert.throws(() => metrics.add(-1), /byte count/);
});

test('Selected ICE route requires a reliable unambiguous successful candidate pair', () => {
  const local = {id: 'local', type: 'local-candidate', candidateType: 'host'};
  const remote = {id: 'remote', type: 'remote-candidate', candidateType: 'srflx'};
  const pair = {id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote'};
  const stats = new Map([[local.id, local], [remote.id, remote], [pair.id, pair]]);
  assert.equal(selectedPair(stats), pair);
  assert.equal(pairRoute(stats), 'direct');
  remote.candidateType = 'relay';
  assert.equal(pairRoute(stats), 'relay');
  stats.set('second', {...pair, id: 'second'});
  assert.equal(selectedPair(stats), null);
  assert.equal(pairRoute(stats), 'unknown');
  stats.set('transport', {type: 'transport', selectedCandidatePairId: 'pair'});
  assert.equal(pairRoute(stats), 'relay');
  pair.state = 'failed';
  assert.equal(pairRoute(stats), 'unknown');
  pair.state = 'succeeded';
  stats.set('transport2', {type: 'transport', selectedCandidatePairId: 'second'});
  assert.equal(pairRoute(stats), 'unknown');
  stats.delete('transport2');
  local.candidateType = 'future-unknown-type';
  assert.equal(pairRoute(stats), 'unknown');
});

test('Digest comparison requires two full identical digests', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(equalDigest(digest, digest), true);
  assert.equal(equalDigest(digest, `${digest.slice(0, 63)}c`), false);
  assert.equal(equalDigest(digest, digest.slice(0, 63)), false);
  assert.equal(equalDigest(null, digest), false);
});
