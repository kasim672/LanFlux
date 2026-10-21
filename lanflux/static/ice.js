/* Configuration and network status only. File protocol and ICE selection stay native. */
const INVALID = 'Invalid STUN or TURN configuration. Ask the LANFLUX administrator to check the connection settings.';

export function parseIceUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error(INVALID);
  const match = /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match) throw new Error(INVALID);
  const [, scheme, host, portText, query] = match;
  if (host.startsWith('[')) {
    try { new URL(`http://${host}/`); } catch { throw new Error(INVALID); }
  } else {
    if (host.length > 253 || !host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) throw new Error(INVALID);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split('.').some((part) => Number(part) > 255)) throw new Error(INVALID);
  }
  const turn = scheme === 'turn' || scheme === 'turns';
  const port = portText ? Number(portText) : scheme.endsWith('s') ? 5349 : 3478;
  if (port < 1 || port > 65535 || (!turn && query) || (scheme === 'turns' && query === 'udp')) throw new Error(INVALID);
  const transport = query || (scheme.endsWith('s') ? 'tcp' : 'udp');
  return { scheme, port, transport, turn, tls443: scheme === 'turns' && port === 443 && transport === 'tcp' };
}

export function validateIceServers(servers) {
  if (!Array.isArray(servers) || servers.length > 16) throw new Error(INVALID);
  return servers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error(INVALID);
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.length || urls.length > 16) throw new Error(INVALID);
    const parsed = urls.map(parseIceUrl);
    const result = { urls: [...urls] };
    if (parsed.some((url) => url.turn)) {
      for (const key of ['username', 'credential']) {
        if (typeof server[key] !== 'string' || !server[key].length || server[key].length > 4096 || /[\u0000-\u001f\u007f]/.test(server[key])) throw new Error(INVALID);
        result[key] = server[key];
      }
      if (server.credentialType !== undefined && server.credentialType !== 'password') throw new Error(INVALID);
    }
    return result;
  });
}

export function iceCapabilities(config = {}) {
  const urls = (config.ice_servers || []).flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).map(parseIceUrl));
  return {
    stunConfigured: urls.some((url) => !url.turn),
    turnConfigured: config.turn_configured === true || urls.some((url) => url.turn),
    tls443Configured: config.turn_tls_443_available === true || urls.some((url) => url.tls443),
  };
}

export function withoutTurnCredentials(config) {
  const ice_servers = validateIceServers(config.ice_servers || []).flatMap((server) => {
    const urls = server.urls.filter((url) => !parseIceUrl(url).turn);
    return urls.length ? [{ urls }] : [];
  });
  return { ...config, ice_servers, ice_expires_at: null };
}

export function applyPeerIce(config, message) {
  if (!Object.hasOwn(message, 'ice_servers')) return config;
  const ice_servers = validateIceServers(message.ice_servers);
  const policy = message.ice_transport_policy ?? config.ice_transport_policy ?? 'all';
  if (!['all', 'relay'].includes(policy)) throw new Error(INVALID);
  if (config.ice_transport_policy === 'relay' && policy !== 'relay') throw new Error(INVALID);
  const expires = message.ice_expires_at ?? null;
  if (expires !== null && (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires)))) throw new Error(INVALID);
  return { ...config, ice_servers, ice_transport_policy: policy, ice_expires_at: expires };
}

export function peerConnectionConfig(config, relayOnly = false, now = Date.now()) {
  const iceServers = validateIceServers(config?.ice_servers || []);
  const hasTurn = iceServers.some((server) => server.urls.some((url) => parseIceUrl(url).turn));
  const forceRelay = config?.ice_transport_policy === 'relay' || relayOnly;
  if (config?.ice_expires_at && !Number.isFinite(Date.parse(config.ice_expires_at))) throw new Error(INVALID);
  if (hasTurn && config.ice_expires_at && Date.parse(config.ice_expires_at) <= now) throw new Error('TURN credentials expired. Leave and rejoin the room to refresh them.');
  if (forceRelay && !hasTurn) throw new Error('Relay-only mode needs current TURN credentials. Leave and rejoin the room to refresh them.');
  return { iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all' };
}

export function networkState({ connected = false, route = 'unknown', phase = 'idle', peerState } = {}) {
  if (phase === 'failed' || peerState === 'failed') return 'failed';
  if (peerState === 'disconnected') return 'connecting';
  if (connected) return ['direct', 'relay'].includes(route) ? route : 'unknown';
  return phase === 'connecting' ? 'connecting' : 'unavailable';
}

export function networkStateLabel(state) {
  return { direct: 'Direct P2P', relay: 'TURN Relay', connecting: 'Connecting', failed: 'Failed' }[state] || 'Unavailable';
}

export function connectionFailureHelp(config = {}, { timeout = false } = {}) {
  const { turnConfigured, tls443Configured } = iceCapabilities(config);
  const start = timeout ? 'Connection timed out.' : 'The browsers could not establish a working connection.';
  const possible = ' Client isolation, a firewall, or blocked traffic may be involved; LANFLUX cannot determine the cause.';
  const advice = !turnConfigured
    ? ' No TURN relay is configured. Ask the administrator to add a reachable TURN server, including TURN over TLS/TCP on port 443 for restricted networks.'
    : !tls443Configured
      ? ' TURN is configured, but no TLS/TCP port 443 alternative is available. Ask the administrator to add it and check relay reachability and credentials.'
      : ' TURN over TLS/TCP on port 443 is configured, but the network may still block it. Ask the administrator to check relay reachability and credentials, or use an IT-approved network.';
  return start + possible + advice + ' Leave and rejoin to try again.';
}

export class CandidateErrors {
  constructor() { this.count = 0; this.unreachable = 0; this.authentication = 0; this.other = 0; }
  add(event) {
    this.count = Math.min(this.count + 1, 1000);
    const key = event.errorCode === 701 ? 'unreachable' : [401, 438].includes(event.errorCode) ? 'authentication' : 'other';
    this[key] = Math.min(this[key] + 1, 1000);
  }
  summary() {
    if (!this.count) return 'No ICE server errors reported. Some browsers do not expose these events.';
    const parts = [];
    if (this.unreachable) parts.push(`${this.unreachable} discovery or relay server reachability errors`);
    if (this.authentication) parts.push(`${this.authentication} authentication or credential challenges`);
    if (this.other) parts.push(`${this.other} other discovery or relay server errors`);
    return `${parts.join('; ')}. Other candidates may still work. These events do not identify the network policy or root cause.`;
  }
}
