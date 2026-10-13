// Protocol tests use the actual browser engine with a bounded in-process DataChannel.
// Browser integration separately verifies real WebRTC and downloaded file bytes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {LanfluxClient} from '../lanflux/static/transfer.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}

function client() {
  const events = [];
  const engine = new LanfluxClient({onEvent: event => events.push(event)});
  engine.config = {max_file_size: 64 * 1048576, max_memory_bytes: 128 * 1048576, max_queue_files: 20, ice_servers: []};
  engine.connected = true;
  engine.channel = new Channel();
  return {engine, events, channel: engine.channel};
}

const control = (engine, message) => engine._onControl(JSON.stringify(message));
const offers = channel => channel.sent.filter(data => typeof data === 'string').map(data => JSON.parse(data));
const settle = () => new Promise(resolve => setImmediate(resolve));
const checksum = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const offer = (engine, message, bytes = []) => control(engine, {type: 'file-offer', protocolVersion: 2, sha256: checksum(bytes), ...message});
async function waitFor(predicate) {
  for (let index = 0; index < 2000; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('State transition timed out');
}
function frame(id, contents) {
  const bytes = new Uint8Array(16 + contents.length);
  bytes.set(Uint8Array.from(id.match(/../g), part => parseInt(part, 16)));
  bytes.set(contents, 16);
  return bytes.buffer;
}

test('No file bytes are sent before consent; reliable send queue advances after completion acknowledgement', async () => {
  const {engine, channel} = client();
  const ids = engine.addFiles([new File(['one'], 'first.txt'), new File(['two'], 'second.txt')]);
  await waitFor(() => engine.transfers.get(ids[0]).status === 'awaiting-approval');
  assert.equal(ids.length, 2);
  assert.deepEqual(offers(channel).map(item => item.type), ['file-offer']);
  assert.equal(engine.transfers.get(ids[1]).status, 'queued');
  control(engine, {type: 'accept', id: ids[0]});
  await settle();
  await settle();
  const binary = channel.sent.find(item => item instanceof Uint8Array);
  assert.deepEqual([...binary.subarray(16)], [...new TextEncoder().encode('one')]);
  assert.equal(engine.transfers.get(ids[0]).status, 'transferring');
  assert.equal(engine.transfers.get(ids[1]).status, 'queued');
  control(engine, {type: 'complete', id: ids[0], sha256: engine.transfers.get(ids[0]).sha256});
  await waitFor(() => engine.transfers.get(ids[1]).status === 'awaiting-approval');
  assert.equal(engine.transfers.get(ids[0]).status, 'completed');
  assert.equal(engine.transfers.get(ids[1]).status, 'awaiting-approval');
  assert.equal(engine.transfers.get(ids[0])._file, null);
  engine.leave();
});

test('Receive approval, chunk bounds, exact Blob bytes, safe filename, and explicit memory release', async () => {
  const {engine, channel} = client();
  const id = '01'.repeat(16);
  offer(engine, {id, name: '../<script>\u0000.txt', size: 3}, [1, 2, 3]);
  assert.equal(engine.transfers.get(id).status, 'approval-needed');
  assert.equal(engine._memoryUsed, 3);
  assert.throws(() => engine._onBinary(frame(id, [1, 2, 3])), /without consent/);
  engine.approve(id);
  assert.equal(offers(channel).at(-1).type, 'accept');
  engine._onBinary(frame(id, [1, 2]));
  engine._onBinary(frame(id, [3]));
  control(engine, {type: 'finish', id});
  await waitFor(() => engine.transfers.get(id).status === 'completed');
  const transfer = engine.transfers.get(id);
  assert.equal(transfer.status, 'completed');
  assert.ok(!/[\\/\u0000]/.test(transfer.name));
  assert.deepEqual([...new Uint8Array(await (await fetch(transfer.url)).arrayBuffer())], [1, 2, 3]);
  assert.equal(offers(channel).at(-1).type, 'complete');
  engine.leave();
  assert.equal(engine._memoryUsed, 3, 'completed downloads remain available after leaving');
  assert.ok(engine.transfers.get(id).url);
  engine.clearCompleted();
  assert.equal(engine._memoryUsed, 0);
  assert.equal(engine.transfers.size, 0);
  await assert.rejects(fetch(transfer.url));
});

test('Cancellation isolates queued stale bytes from the next consented transfer', () => {
  const {engine, channel} = client();
  const oldId = '02'.repeat(16);
  const newId = '03'.repeat(16);
  offer(engine, {id: oldId, name: 'old.bin', size: 4});
  engine.approve(oldId);
  engine._onBinary(frame(oldId, [1]));
  engine.cancel(oldId);
  assert.equal(engine._memoryUsed, 0);
  offer(engine, {id: newId, name: 'new.bin', size: 1});
  engine.approve(newId);
  engine._onBinary(frame(oldId, [2, 3, 4]));
  engine._onBinary(frame(newId, [9]));
  assert.equal(engine.transfers.get(newId).bytes, 1);
  assert.equal(engine.transfers.get(oldId).status, 'cancelled');
  assert.equal(offers(channel).filter(item => item.type === 'cancel').length, 1);
  engine.leave();
  engine.clearCompleted();
});

test('Receive memory, overannounced data, and malicious control frames are bounded', () => {
  const {engine, channel} = client();
  engine.config.max_file_size = 8;
  engine.config.max_memory_bytes = 4;
  const id = '04'.repeat(16);
  offer(engine, {id, name: 'too-large.bin', size: 5});
  assert.equal(engine.transfers.size, 0);
  assert.equal(engine._memoryUsed, 0);
  assert.equal(offers(channel).at(-1).type, 'reject');
  const validId = '05'.repeat(16);
  offer(engine, {id: validId, name: 'oversend.bin', size: 1});
  engine.approve(validId);
  engine._onBinary(frame(validId, [1, 2]));
  assert.equal(engine.transfers.get(validId).status, 'failed');
  assert.equal(engine._memoryUsed, 0);
  assert.throws(() => offer(engine, {id: '06'.repeat(16), name: 'bad.bin', size: -1}), /metadata/);
  assert.throws(() => control(engine, {type: 'execute', id}), /control/);
  assert.throws(() => control(engine, {type: 'accept', id: '../unsafe'}), /control/);
  assert.throws(() => engine._onControl('a'.repeat(8193)), /Oversized/);
  engine.leave();
});

test('Zero-byte files complete with explicit approval and rejection does not block the next file', async () => {
  const {engine, channel} = client();
  const ids = engine.addFiles([new File([''], 'empty.txt'), new File(['yes'], 'later.txt')]);
  await waitFor(() => engine.transfers.get(ids[0]).status === 'awaiting-approval');
  control(engine, {type: 'reject', id: ids[0]});
  await waitFor(() => engine.transfers.get(ids[1]).status === 'awaiting-approval');
  assert.equal(engine.transfers.get(ids[0]).status, 'rejected');
  assert.equal(engine.transfers.get(ids[1]).status, 'awaiting-approval');
  const receiveId = '07'.repeat(16);
  offer(engine, {id: receiveId, name: 'empty.bin', size: 0});
  engine.approve(receiveId);
  control(engine, {type: 'finish', id: receiveId});
  await waitFor(() => engine.transfers.get(receiveId).status === 'completed');
  assert.equal(engine.transfers.get(receiveId).status, 'completed');
  assert.equal((await fetch(engine.transfers.get(receiveId).url)).headers.get('content-length'), '0');
  assert.equal(offers(channel).at(-1).type, 'complete');
  engine.leave();
  engine.clearCompleted();
});

test('Backpressure pauses sends until a low-buffer notification; cancellation releases the waiter', async () => {
  const {engine, channel} = client();
  const transfer = {status: 'transferring'};
  channel.bufferedAmount = 300000;
  let drained = false;
  const waiting = engine._waitForBuffer(channel, transfer).then(() => { drained = true; });
  await settle();
  assert.equal(drained, false);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await waiting;
  assert.equal(drained, true);
  channel.bufferedAmount = 300000;
  const cancelling = engine._waitForBuffer(channel, transfer);
  transfer.status = 'cancelled';
  await cancelling;
  engine.leave();
});

test('Remaining second peer becomes initiator for a replacement and disconnect cleans unfinished state', async () => {
  const {engine} = client();
  const id = engine.addFiles([new File(['bytes'], 'disconnect.txt')])[0];
  engine.initiator = false;
  await engine._onSignal({type: 'peer-left', initiator: true});
  assert.equal(engine.initiator, true);
  assert.equal(engine.connected, false);
  assert.equal(engine.transfers.get(id).status, 'failed');
  assert.equal(engine.transfers.get(id)._file, null);
  engine.leave();
});

test('Completed record metadata cannot grow without limit, even for zero-byte files', () => {
  const {engine, events} = client();
  for (let index = 0; index < 100; index++) {
    const id = index.toString(16).padStart(32, '0');
    offer(engine, {id, name: 'empty.txt', size: 0});
    engine.reject(id);
  }
  assert.equal(engine.transfers.size, 100);
  offer(engine, {id: 'ff'.repeat(16), name: 'extra.txt', size: 0});
  assert.equal(engine.transfers.size, 100);
  assert.equal(engine.addFiles([new File([''], 'one-more.txt')]).length, 0);
  assert.ok(events.some(event => event.type === 'error'));
  engine.clearCompleted();
  assert.equal(engine.transfers.size, 0);
  engine.leave();
});

test('Tiny-frame flooding cannot turn a bounded file into unbounded buffer overhead', () => {
  const {engine, channel} = client();
  const id = '08'.repeat(16);
  offer(engine, {id, name: 'tiny-chunks.bin', size: 100});
  engine.approve(id);
  for (let index = 0; index < 64; index++) engine._onBinary(frame(id, [index]));
  const transfer = engine.transfers.get(id);
  assert.equal(transfer.status, 'transferring');
  assert.equal(transfer._chunks.length, 64);
  engine._onBinary(frame(id, [65]));
  assert.equal(transfer.status, 'failed');
  assert.match(transfer.error, /too many small chunks/);
  assert.equal(transfer._chunks.length, 0);
  assert.equal(engine._memoryUsed, 0);
  assert.equal(offers(channel).at(-1).type, 'cancel');
  engine._onBinary(frame(id, [66]));
  assert.equal(engine._memoryUsed, 0, 'stale frames remain discarded after cancelling the flood');
  engine.leave();
});

test('Download names are portable to Windows and never contain path/control characters', () => {
  const {engine} = client();
  const [id] = engine.addFiles([new File(['portable'], 'CON.txt:<>"|?*\\/\u0000. ')]);
  const name = engine.transfers.get(id).name;
  assert.ok(name.startsWith('_CON.txt'));
  assert.ok(!/[<>:"|?*\\/\u0000-\u001f]/.test(name));
  assert.ok(!/[. ]$/.test(name));
  engine.leave();
});

test('Corrupt content, missing bytes, missing digest, and incompatible protocol cannot create downloads', async () => {
  for (const mode of ['corrupt', 'missing-bytes', 'missing-digest', 'version']) {
    const {engine, channel} = client();
    const id = '09'.repeat(16);
    const message = {type: 'file-offer', id, name: 'integrity.bin', size: 3, protocolVersion: 2, sha256: checksum([1, 2, 3])};
    if (mode === 'missing-digest') delete message.sha256;
    if (mode === 'version') message.protocolVersion = 1;
    control(engine, message);
    if (['corrupt', 'missing-bytes'].includes(mode)) {
      engine.approve(id);
      engine._onBinary(frame(id, mode === 'corrupt' ? [1, 2, 4] : [1]));
      control(engine, {type: 'finish', id});
    }
    await waitFor(() => engine.transfers.get(id).status === 'failed');
    const transfer = engine.transfers.get(id);
    assert.equal(transfer.hashStatus, 'failed', mode);
    assert.ok(!transfer.url, mode);
    assert.equal(engine._memoryUsed, 0, mode);
    assert.equal(offers(channel).at(-1).type, 'integrity-failed', mode);
    assert.ok(!offers(channel).some(item => item.type === 'complete'), mode);
    engine.leave();
  }
});

test('Sender prehashes empty files correctly; unavailable hash engine prevents offers and approval', async () => {
  const sender = client();
  const [id] = sender.engine.addFiles([new File([], 'empty.txt')]);
  await waitFor(() => sender.engine.transfers.get(id).status === 'awaiting-approval');
  assert.equal(offers(sender.channel)[0].sha256, checksum([]));
  assert.equal(offers(sender.channel)[0].protocolVersion, 2);
  sender.engine.leave();
  const unavailable = client();
  unavailable.engine._createHash = () => { throw new Error('Hash unavailable'); };
  const [failedId] = unavailable.engine.addFiles([new File(['x'], 'unavailable.txt')]);
  await waitFor(() => unavailable.engine.transfers.get(failedId).status === 'failed');
  assert.equal(offers(unavailable.channel).length, 0);
  assert.equal(unavailable.engine.transfers.get(failedId).hashStatus, 'failed');
  const incomingId = '0a'.repeat(16);
  offer(unavailable.engine, {id: incomingId, name: 'no-hash.txt', size: 1}, [1]);
  unavailable.engine.approve(incomingId);
  assert.equal(unavailable.engine.transfers.get(incomingId).status, 'failed');
  assert.equal(unavailable.engine._memoryUsed, 0);
  assert.ok(!offers(unavailable.channel).some(item => item.type === 'accept'));
  unavailable.engine.leave();
});

test('Cancellation during asynchronous hashing or verification cannot resurrect the transfer', async () => {
  const sender = client();
  let finishRead;
  const delayedFile = {name: 'slow.bin', size: 1, slice: () => ({arrayBuffer: () => new Promise(resolve => { finishRead = resolve; })})};
  const [id] = sender.engine.addFiles([delayedFile]);
  assert.equal(sender.engine.transfers.get(id).status, 'hashing');
  sender.engine.cancel(id);
  finishRead(new Uint8Array([1]).buffer);
  await settle();
  assert.equal(sender.engine.transfers.get(id).status, 'cancelled');
  assert.equal(offers(sender.channel).length, 0);
  sender.engine.leave();
  const receiver = client();
  const receiveId = '0b'.repeat(16);
  offer(receiver.engine, {id: receiveId, name: 'verify.bin', size: 1}, [1]);
  receiver.engine.approve(receiveId);
  receiver.engine._onBinary(frame(receiveId, [1]));
  control(receiver.engine, {type: 'finish', id: receiveId});
  assert.equal(receiver.engine.transfers.get(receiveId).status, 'verifying');
  receiver.engine.cancel(receiveId);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(receiver.engine.transfers.get(receiveId).status, 'cancelled');
  assert.ok(!receiver.engine.transfers.get(receiveId).url);
  assert.equal(receiver.engine._memoryUsed, 0);
  assert.ok(!offers(receiver.channel).some(item => item.type === 'complete'));
  receiver.engine.leave();
});

test('Missing and mismatched completion checksums fail; late conflicting acknowledgements cannot change verified results', async () => {
  for (const mode of ['missing', 'mismatch', 'conflicting']) {
    const {engine} = client();
    const [id] = engine.addFiles([new File(['file'], 'original.txt')]);
    await waitFor(() => engine.transfers.get(id).status === 'awaiting-approval');
    control(engine, {type: 'accept', id});
    await waitFor(() => engine.transfers.get(id)._finishSent);
    if (mode === 'conflicting') {
      control(engine, {type: 'complete', id, sha256: engine.transfers.get(id).sha256});
      assert.equal(engine.transfers.get(id).status, 'completed');
    }
    control(engine, {type: 'complete', id, ...(mode === 'missing' ? {} : {sha256: 'ff'.repeat(32)})});
    assert.equal(engine.transfers.get(id).status, mode === 'conflicting' ? 'completed' : 'failed');
    assert.equal(engine.transfers.get(id).hashStatus, mode === 'conflicting' ? 'verified' : 'failed');
    engine.leave();
  }
});

test('Negotiated message limits bound frame sizes and reject frames that cannot fit the prefix', async () => {
  const {engine, channel} = client();
  engine.pc = {sctp: {maxMessageSize: 1024}, close() {}};
  const [id] = engine.addFiles([new File([new Uint8Array(2000)], 'small-frames.bin')]);
  await waitFor(() => engine.transfers.get(id).status === 'awaiting-approval');
  control(engine, {type: 'accept', id});
  await waitFor(() => engine.transfers.get(id)._finishSent);
  assert.ok(channel.sent.filter(item => item instanceof Uint8Array).every(item => item.byteLength <= 1024));
  engine.leave();
  const tiny = client();
  tiny.engine.pc = {sctp: {maxMessageSize: 16}, close() {}};
  const [tinyId] = tiny.engine.addFiles([new File(['x'], 'cannot-fit.bin')]);
  await waitFor(() => tiny.engine.transfers.get(tinyId).status === 'awaiting-approval');
  control(tiny.engine, {type: 'accept', id: tinyId});
  await waitFor(() => tiny.engine.transfers.get(tinyId).status === 'failed');
  assert.match(tiny.engine.transfers.get(tinyId).error, /too small/);
  assert.equal(tiny.engine.transfers.get(tinyId).bytes, 0);
  tiny.engine.leave();
  const impractical = client();
  impractical.engine.pc = {sctp: {maxMessageSize: 32}, close() {}};
  const [largeId] = impractical.engine.addFiles([new File([new Uint8Array(2048)], 'too-many-small.bin')]);
  await waitFor(() => impractical.engine.transfers.get(largeId).status === 'awaiting-approval');
  control(impractical.engine, {type: 'accept', id: largeId});
  await waitFor(() => impractical.engine.transfers.get(largeId).status === 'failed');
  assert.match(impractical.engine.transfers.get(largeId).error, /too many small chunks/);
  assert.equal(impractical.engine.transfers.get(largeId).bytes, 0);
  impractical.engine.leave();
});

test('Channel closure immediately releases backpressure waiters and detaches handlers', async () => {
  const {engine, channel} = client();
  engine._bindChannel(channel);
  channel.bufferedAmount = 300000;
  const pending = engine._waitForBuffer(channel, {status: 'transferring'});
  assert.equal(engine._bufferWaiters.size, 1);
  engine.leave();
  await assert.rejects(pending, /disconnected/);
  assert.equal(engine._bufferWaiters.size, 0);
  assert.equal(channel.onmessage, null);
  assert.equal(channel.onopen, null);
  assert.equal(channel.onclose, null);
});

test('DataChannel ping measures monotonic RTT; timeouts and failed statistics become unavailable', async () => {
  const {engine, channel, events} = client();
  await engine._sampleMetrics();
  const ping = offers(channel).find(message => message.type === 'ping');
  assert.match(ping.nonce, /^[a-f0-9]{32}$/);
  engine._pendingPing.started -= 40;
  control(engine, {type: 'pong', nonce: ping.nonce});
  assert.ok(engine._rttMs >= 40 && engine._rttMs < 500);
  engine._pendingPing = {nonce: '0c'.repeat(16), started: performance.now() - 4000};
  engine._lastPingAt = performance.now();
  engine._route = 'direct';
  engine.pc = {iceConnectionState: 'connected', getStats: async () => { throw new Error('Unavailable'); }, close() {}};
  await engine._sampleMetrics();
  assert.equal(engine._rttMs, null);
  assert.equal(engine._route, 'unknown');
  const diagnostics = events.filter(event => event.type === 'diagnostics').at(-1).diagnostics;
  assert.equal(diagnostics.rttMs, null);
  assert.equal(diagnostics.totalBytes, 0);
  assert.equal(diagnostics.averageBytesPerSecond, null);
  assert.ok(!JSON.stringify(diagnostics).includes('address'));
  control(engine, {type: 'ping', nonce: '0d'.repeat(16)});
  assert.equal(offers(channel).at(-1).type, 'pong');
  assert.throws(() => control(engine, {type: 'ping', nonce: '0d'.repeat(16), address: 'private'}), /fields/);
  engine.leave();
});

test('Strict control schemas reject extra fields and invalid state transitions', async () => {
  const {engine} = client();
  const [id] = engine.addFiles([new File(['x'], 'states.bin')]);
  assert.throws(() => control(engine, {type: 'accept', id}), /Unexpected approval/);
  await waitFor(() => engine.transfers.get(id).status === 'awaiting-approval');
  assert.throws(() => control(engine, {type: 'accept', id, auto: true}), /fields/);
  assert.throws(() => control(engine, {type: 'complete', id, sha256: '00'.repeat(32)}), /Unexpected verification/);
  assert.throws(() => control(engine, {type: 'finish', id}), /Unexpected transfer finish/);
  assert.throws(() => control(engine, {type: 'cancel', id: [id]}), /Invalid transfer control/);
  engine.leave();
});

test('Both directions independently verify content and count actual payload bytes', async () => {
  class LinkedChannel extends Channel {
    send(data) {
      super.send(data);
      const delivered = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      queueMicrotask(() => this.other?.onmessage?.({data: delivered}));
    }
  }
  const a = client().engine;
  const b = client().engine;
  const channelA = new LinkedChannel();
  const channelB = new LinkedChannel();
  channelA.other = channelB;
  channelB.other = channelA;
  a._bindChannel(channelA);
  b._bindChannel(channelB);
  const bytesA = Uint8Array.from({length: 32 * 1024}, (_, index) => index % 251);
  const bytesB = Uint8Array.from({length: 48 * 1024}, (_, index) => index % 127);
  const [idA] = a.addFiles([new File([bytesA], 'from-a.bin')]);
  const [idB] = b.addFiles([new File([bytesB], 'from-b.bin')]);
  await waitFor(() => a.transfers.get(idB)?.status === 'approval-needed' && b.transfers.get(idA)?.status === 'approval-needed');
  a.approve(idB);
  b.approve(idA);
  await waitFor(() => [...a.transfers.values(), ...b.transfers.values()].every(transfer => transfer.status === 'completed'));
  assert.deepEqual(new Uint8Array(await (await fetch(b.transfers.get(idA).url)).arrayBuffer()), bytesA);
  assert.deepEqual(new Uint8Array(await (await fetch(a.transfers.get(idB).url)).arrayBuffer()), bytesB);
  assert.equal(a._metrics.totalBytes, bytesA.length + bytesB.length);
  assert.equal(b._metrics.totalBytes, bytesA.length + bytesB.length);
  for (const transfer of [...a.transfers.values(), ...b.transfers.values()]) {
    assert.equal(transfer.hashStatus, 'verified');
    assert.equal(transfer.sha256, transfer.actualSha256);
    assert.ok(transfer.durationSeconds > 0);
    assert.ok(transfer.averageSpeed > 0);
    assert.ok(transfer.finishedAt >= transfer.startedAt);
  }
  const duration = a.transfers.get(idA).durationSeconds;
  await new Promise(resolve => setTimeout(resolve, 5));
  await a._sampleMetrics();
  assert.equal(a.transfers.get(idA).durationSeconds, duration, 'completed metrics remain frozen');
  a.leave(); b.leave();
  a.clearCompleted(); b.clearCompleted();
});

test('Invalid offers cannot bypass the bounded history through emitted UI transfer events', () => {
  const {engine, events} = client();
  for (let index = 0; index < 200; index++) {
    control(engine, {type: 'file-offer', id: index.toString(16).padStart(32, '0'), name: 'invalid.bin', size: 0,
      protocolVersion: index % 2 ? 1 : 2});
  }
  assert.equal(engine.transfers.size, 100);
  assert.equal(new Set(events.filter(event => event.type === 'transfer').map(event => event.transfer.id)).size, 100);
  assert.equal(engine._memoryUsed, 0);
  assert.equal(events.filter(event => event.type === 'error').length, 1, 'capacity warning is bounded for repeated offers');
  engine.leave();
  engine.clearCompleted();
});

test('A cancelled and cleared transfer identifier cannot be replayed into a new approval', () => {
  const {engine, channel} = client();
  const id = '0e'.repeat(16);
  offer(engine, {id, name: 'old.bin', size: 1}, [1]);
  engine.cancel(id);
  engine.clearCompleted();
  offer(engine, {id, name: 'replay.bin', size: 1}, [1]);
  assert.equal(engine.transfers.size, 0);
  assert.equal(engine._memoryUsed, 0);
  assert.equal(offers(channel).at(-1).type, 'reject');
  engine.leave();
});
