import test from 'node:test';
import assert from 'node:assert/strict';
import {LanfluxClient} from '../lanflux/static/transfer.js';
import {parseIceUrl, validateIceServers, iceCapabilities, withoutTurnCredentials, applyPeerIce,
  peerConnectionConfig, networkState, networkStateLabel, connectionFailureHelp, CandidateErrors} from '../lanflux/static/ice.js';

const stun = {urls: ['stun:discovery.example:3478']};
const turn = {urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:443?transport=tcp'], username: 'test-user', credential: 'test-password'};
const config = () => ({ice_servers: [stun], ice_transport_policy: 'all', turn_configured: true, turn_tls_443_available: true,
  max_file_size: 1048576, max_memory_bytes: 2097152, max_queue_files: 20});
const pairing = (credential = 'fresh-password') => ({ice_servers: [stun, {...turn, credential}], ice_transport_policy: 'all', ice_expires_at: new Date(Date.now() + 600000).toISOString()});

test('ICE URIs accept STUN, TURN alternatives and TLS/TCP443 while rejecting unsafe syntax', () => {
  assert.equal(parseIceUrl('stuns:discovery.example').port, 5349);
  assert.equal(parseIceUrl('turns:[2001:db8::1]:443?transport=tcp').tls443, true);
  assert.equal(parseIceUrl('turn:relay.example?transport=tcp').transport, 'tcp');
  assert.equal(parseIceUrl('turns:relay.example:443').tls443, true);
  for (const uri of ['https://relay.example', 'turn://relay.example', 'turn:user:password@relay.example', 'turn:relay.example/path',
    'turn:relay.example:0', 'turn:relay.example:65536', 'turn:relay..example', 'turn:-relay.example', 'turn:999.999.999.999',
    'turns:relay.example?transport=udp', 'stun:discovery.example?transport=tcp', 'turn:relay.example?transport=tcp&secret=x',
    'turn:relay.example\n', 'turn:[not-ipv6]', 'turn:relay.example#fragment']) assert.throws(() => parseIceUrl(uri), /Invalid STUN or TURN/);
  assert.deepEqual(validateIceServers([stun, turn]), [stun, turn]);
  assert.throws(() => validateIceServers([{urls: turn.urls}]), /Invalid STUN or TURN/);
  assert.throws(() => validateIceServers([{...turn, credentialType: 'oauth'}]), /Invalid STUN or TURN/);
});

test('Default all policy supplies direct discovery and every relay alternative to native ICE without forcing relay', () => {
  const settings = applyPeerIce(config(), pairing());
  const rtc = peerConnectionConfig(settings);
  assert.equal(rtc.iceTransportPolicy, 'all');
  assert.deepEqual(rtc.iceServers.map((server) => server.urls), [stun.urls, turn.urls]);
  assert.equal(peerConnectionConfig(settings, true).iceTransportPolicy, 'relay');
  assert.equal(peerConnectionConfig({...settings, ice_transport_policy: 'relay'}, false).iceTransportPolicy, 'relay');
  assert.equal(settings.max_memory_bytes, 2097152);
  assert.equal(iceCapabilities(config()).turnConfigured, true, 'public flags work before credentials are issued');
});

test('Expired credentials cannot start a pair, while every fresh pairing update preserves resource limits', () => {
  const old = applyPeerIce(config(), {...pairing('old-password'), ice_expires_at: '2020-01-01T00:00:00.000Z'});
  assert.throws(() => peerConnectionConfig(old), /credentials expired/);
  const fresh = applyPeerIce(old, pairing('replacement-password'));
  assert.equal(peerConnectionConfig(fresh).iceServers[1].credential, 'replacement-password');
  assert.equal(fresh.max_file_size, old.max_file_size);
  assert.throws(() => applyPeerIce(old, {...pairing(), ice_expires_at: 'not-a-date'}), /Invalid STUN or TURN/);
  assert.throws(() => applyPeerIce({...config(), ice_transport_policy: 'relay'}, pairing()), /Invalid STUN or TURN/);
});

test('Clearing credentials retains public availability flags and only STUN discovery URLs', () => {
  const settings = applyPeerIce(config(), pairing());
  const cleared = withoutTurnCredentials(settings);
  assert.deepEqual(cleared.ice_servers, [stun]);
  assert.equal(cleared.ice_expires_at, null);
  assert.equal(cleared.turn_configured, true);
  assert.ok(!JSON.stringify(cleared).includes('password'));
  const mixed = withoutTurnCredentials({...config(), ice_servers: [{...turn, urls: [...stun.urls, ...turn.urls]}]});
  assert.deepEqual(mixed.ice_servers, [stun]);
});

test('Connection states require measured routes; zero statistics and relay configuration do not imply a relay or direct connection', () => {
  assert.equal(networkStateLabel(networkState({phase: 'connecting'})), 'Connecting');
  assert.equal(networkStateLabel(networkState({phase: 'failed'})), 'Failed');
  assert.equal(networkStateLabel(networkState({connected: true, route: 'direct'})), 'Direct P2P');
  assert.equal(networkStateLabel(networkState({connected: true, route: 'relay'})), 'TURN Relay');
  assert.equal(networkStateLabel(networkState({connected: true, route: 'unknown'})), 'Unavailable');
  assert.equal(networkStateLabel(networkState({connected: true, route: 'unknown', phase: 'connecting'})), 'Unavailable');
  assert.equal(networkStateLabel(networkState({connected: true, route: 'direct', peerState: 'disconnected'})), 'Connecting');
});

test('Failure advice is conditional and does not claim that client isolation or a firewall was detected', () => {
  assert.match(connectionFailureHelp({ice_servers: [stun]}), /No TURN relay is configured/);
  assert.match(connectionFailureHelp({turn_configured: true}), /no TLS\/TCP port 443 alternative/);
  assert.match(connectionFailureHelp(config(), {timeout: true}), /^Connection timed out/);
  assert.match(connectionFailureHelp(config()), /network may still block/);
  assert.match(connectionFailureHelp(config()), /cannot determine the cause/);
  assert.ok(!connectionFailureHelp(applyPeerIce(config(), pairing())).includes('relay.example'));
});

test('Candidate errors are bounded categorical counts and never read sensitive event properties', () => {
  const errors = new CandidateErrors();
  const sensitive = {errorCode: 701};
  for (const key of ['url', 'address', 'port', 'errorText']) Object.defineProperty(sensitive, key, {get() { throw new Error(`Sensitive ${key} must not be read`); }});
  errors.add(sensitive); errors.add({errorCode: 401}); errors.add({errorCode: 999});
  assert.equal(errors.count, 3);
  assert.equal(errors.unreachable, 1);
  assert.match(errors.summary(), /Other candidates may still work/);
  for (let count = 0; count < 2000; count++) errors.add({errorCode: 701});
  assert.equal(errors.count, 1000);
  assert.equal(errors.unreachable, 1000);
});

async function withPeer(callback) {
  const original = globalThis.RTCPeerConnection;
  const constructed = [];
  globalThis.RTCPeerConnection = class {
    constructor(options) { this.options = options; this.connectionState = 'new'; this.iceConnectionState = 'new'; constructed.push(this); }
    async getStats() { return new Map(); }
    close() { this.connectionState = 'closed'; }
  };
  try { await callback(constructed); }
  finally { if (original === undefined) delete globalThis.RTCPeerConnection; else globalThis.RTCPeerConnection = original; }
}

test('Actual engine applies replacement peer credentials before creating ICE, without an ICE restart', async () => {
  await withPeer(async (constructed) => {
    const events = [];
    const engine = new LanfluxClient({onEvent: (event) => events.push(event)});
    engine.config = applyPeerIce(config(), {...pairing('expired-password'), ice_expires_at: '2020-01-01T00:00:00.000Z'});
    engine.initiator = false;
    await engine._onSignal({type: 'peer-joined', pair_id: 'first-pair', name: 'Peer', ...pairing('fresh-first')});
    engine._makePeer();
    assert.equal(constructed[0].options.iceServers[1].credential, 'fresh-first');
    assert.equal(constructed[0].options.iceTransportPolicy, 'all');
    constructed[0].onicecandidateerror({errorCode: 701, url: 'sensitive-url', address: 'private-address', errorText: 'secret'});
    assert.equal(engine.pc, constructed[0], 'one server error does not restart or fail the pair');
    const diagnostics = events.filter((event) => event.type === 'diagnostics');
    assert.ok(diagnostics.some((event) => event.diagnostics.iceErrorCount === 1));
    assert.ok(!JSON.stringify(diagnostics).includes('sensitive-url'));
    assert.ok(!JSON.stringify(diagnostics).includes('private-address'));
    engine.connected = true;
    await engine._updateRoute();
    engine._emitDiagnostics();
    assert.equal(events.at(-1).diagnostics.connectionState, 'unknown');
    await engine._onSignal({type: 'peer-left', initiator: false});
    assert.deepEqual(engine.config.ice_servers, [stun]);
    await engine._onSignal({type: 'peer-joined', pair_id: 'second-pair', ...pairing('fresh-second')});
    engine._makePeer();
    assert.equal(constructed.length, 2);
    assert.equal(constructed[1].options.iceServers[1].credential, 'fresh-second');
    engine.leave();
    assert.ok(!JSON.stringify(engine.config).includes('fresh-second'));
  });
});

test('Actual engine honors public TURN flags and refuses to disable an administrator-required relay policy', () => {
  const engine = new LanfluxClient();
  engine.config = config();
  assert.equal(engine.setRelayOnly(true), true);
  engine.config = {...config(), ice_transport_policy: 'relay'};
  assert.equal(engine.setRelayOnly(false), false);
  assert.equal(engine.relayOnly, true);
});
