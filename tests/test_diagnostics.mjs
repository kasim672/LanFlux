import test from 'node:test';
import assert from 'node:assert/strict';
import {formatBinaryBytes,formatRate,formatBits,formatSeconds,formatMilliseconds,routeLabel} from '../lanflux/static/diagnostics.js';

test('diagnostic formatting uses decimal rates and binary sizes', () => {
  assert.equal(formatRate(1250000),'1.25 MB/s');
  assert.equal(formatBits(1250000),'10.00 Mbps');
  assert.equal(formatBinaryBytes(1048576),'1.0 MiB');
  assert.equal(formatSeconds(62.5),'1m 2.5s');
  assert.equal(formatMilliseconds(12.35),'12.3 ms');
});

test('unavailable diagnostics are not presented as measured zero', () => {
  for (const value of [null,undefined,NaN,Infinity,-1]) {
    assert.equal(formatRate(value),'Unavailable');
    assert.equal(formatBinaryBytes(value),'Unavailable');
    assert.equal(formatSeconds(value),'Unavailable');
    assert.equal(formatMilliseconds(value),'Unavailable');
  }
  assert.equal(formatRate(0),'0.00 MB/s');
  assert.equal(formatBinaryBytes(0),'0 B');
  assert.equal(routeLabel('unknown'),'Route unavailable');
  assert.equal(routeLabel('relay'),'TURN relay');
  assert.equal(routeLabel('direct'),'Direct peer connection');
});
