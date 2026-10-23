/* LANFLUX: signaling carries connection messages only; file metadata and bytes use encrypted WebRTC. */
import {AdaptivePacer} from './adaptive.js';
import {sha256} from './vendor/noble-hashes/sha2.js';
import {PayloadMetrics, selectedPair, pairRoute, equalDigest} from './metrics.js';
import {validateIceServers, iceCapabilities, withoutTurnCredentials, applyPeerIce, peerConnectionConfig, networkState, connectionFailureHelp, CandidateErrors} from './ice.js';
const CHUNK_SIZE = 16 * 1024;
const HASH_CHUNK_SIZE = 256 * 1024;
const BUFFER_HIGH = 256 * 1024;
const BUFFER_LOW = 64 * 1024;
const APPROVAL_TIMEOUT = 120000;
const TRANSFER_TIMEOUT = 90000;
const TERMINAL = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const ID_PATTERN = /^[a-f0-9]{32}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);
const validHash = value => typeof value === 'string' && HASH_PATTERN.test(value);
const CONTROL_TYPES = new Set(['file-offer', 'accept', 'reject', 'cancel', 'finish', 'complete', 'integrity-failed', 'ping', 'pong']);
const MAX_HISTORY = 100;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const digestHex = hash => Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');

function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeName(name) {
  let result = String(name || 'Untitled file').replace(/[<>:"|?*\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 240).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result.slice(0, 240) || 'Untitled file';
}

function idBytes(id) {
  return Uint8Array.from(id.match(/../g), pair => parseInt(pair, 16));
}

function frameId(bytes) {
  return Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class LanfluxClient {
  constructor({onEvent = () => {}} = {}) {
    this.onEvent = onEvent;
    this.config = null;
    this.roomId = null;
    this.connected = false;
    this.transfers = new Map();
    this.pc = null;
    this.channel = null;
    this.socket = null;
    this.initiator = false;
    this.peerName = '';
    this.relayOnly = false;
    this._outgoing = [];
    this._activeSend = null;
    this._activeReceive = null;
    this._memoryUsed = 0;
    this._discardedIds = new Set();
    this._candidates = [];
    this._session = 0;
    this._peerSession = 0;
    this._signalChain = Promise.resolve();
    this._receiveChain = Promise.resolve();
    this._timers = null;
    this._route = 'unknown';
    this._metrics = new PayloadMetrics();
    this._receivedPayloadBytes = 0;
    this._metricsTimer = null;
    this._rttMs = null;
    this._pendingPing = null;
    this._lastPingAt = null;
    this._setupStarted = null;
    this._setupMs = null;
    this._pairId = null;
    this._joinReject = null;
    this._joinTimeout = null;
    this._bufferWaiters = new Set();
    this._sampling = false;
    this._historyWarned = false;
    this._connectionPhase = 'idle';
    this._iceErrors = new CandidateErrors();
    this._pacer = new AdaptivePacer();
    this.strategyEpoch = 0;
    this._rttSampleAt = null;
  }

  _emit(event) { this.onEvent(event); }
  _status(status, message) {
    this._connectionPhase = status;
    this._emit({type: 'status', status, message});
    this._emitDiagnostics();
  }
  _error(message) { this._emit({type: 'error', message}); }
  _update(transfer) {
    const {id, name, size, direction, status, bytes, speed, error, url, hashStatus, sha256: expectedSha256, actualSha256,
      currentSpeed, averageSpeed, durationSeconds, etaSeconds, peakBytesPerSecond, startedAt, finishedAt,
      connectionSetupMs, route, resultReason, hashSeconds, strategy, effectiveStrategy, pacingDelayMs, pacingAdjustments} = transfer;
    this._emit({type: 'transfer', transfer: {id, name, size, direction, status, bytes, speed, error, url,
      hashStatus, sha256: expectedSha256, actualSha256, currentSpeed, averageSpeed, durationSeconds,
      etaSeconds, peakBytesPerSecond, startedAt, finishedAt, connectionSetupMs, route, resultReason, hashSeconds, strategy, effectiveStrategy, pacingDelayMs, pacingAdjustments, payloadActive: Boolean(transfer._meterActive)}});
  }
  _memory() { this._emit({type: 'memory', used: this._memoryUsed, limit: this.config?.max_memory_bytes || 0}); }

  async init() {
    const response = await fetch('/api/config', {cache: 'no-store'});
    if (!response.ok) throw new Error('LANFLUX could not load its connection settings. Refresh and try again.');
    const config = await response.json();
    if (!['all', 'relay'].includes(config.ice_transport_policy ?? 'all')) throw new Error('Invalid connection mode configured by the LANFLUX administrator.');
    this.config = {...config, ice_servers: validateIceServers(config.ice_servers || [])};
    this.relayOnly = this.config.ice_transport_policy === 'relay';
    this._emit({type: 'config', config: this.config});
    this._memory();
    if (!window.RTCPeerConnection) this._error('This browser does not support WebRTC. Use a current Chrome, Firefox, Edge, or Safari browser.');
    return this.config;
  }

  async createRoom(name = 'My device') {
    if (!this.config) await this.init();
    const response = await fetch('/api/rooms', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).detail; } catch { /* use fallback */ }
      throw new Error(typeof detail === 'string' ? detail : 'Could not create a room. Wait a moment and try again.');
    }
    const room = await response.json();
    await this.joinRoom(room.room_id, name);
    return room;
  }

  async joinRoom(roomId, name = 'My device') {
    if (!this.config) await this.init();
    roomId = String(roomId).replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{16}$/.test(roomId)) throw new Error('Enter the complete 16-character room code.');
    if (!window.RTCPeerConnection) throw new Error('WebRTC is unavailable in this browser.');
    this.leave();
    const session = ++this._session;
    this.roomId = roomId;
    this._metrics = new PayloadMetrics();
    this._receivedPayloadBytes = 0;
    this._iceErrors = new CandidateErrors();
    this._signalChain = Promise.resolve();
    this._receiveChain = Promise.resolve();
    this._status('connecting', 'Joining your private room…');
    const endpoint = new URL(`/ws/${roomId}`, location.href);
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('name', String(name || 'My device').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48) || 'My device');
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    this._timers = setInterval(() => this._tick(), 5000);
    this._metricsTimer = setInterval(() => this._sampleMetrics(), 1000);
    let welcomed = false;
    return new Promise((resolve, reject) => {
      this._joinReject = reject;
      const joinTimeout = this._joinTimeout = setTimeout(() => {
        if (!welcomed && this.socket === socket) {
          this.leave();
          reject(new Error('The signaling server did not respond. Please try again.'));
        }
      }, 15000);
      socket.onmessage = event => {
        if (session !== this._session) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'welcome') {
          try { this._applyPeerIce(message); }
          catch {
            this._joinReject = null;
            this.leave();
            reject(new Error('The room supplied invalid STUN or TURN settings. Ask the administrator to check the connection configuration.'));
            return;
          }
          welcomed = true;
          clearTimeout(joinTimeout);
          this._joinReject = null;
          this._joinTimeout = null;
          this.initiator = Boolean(message.initiator);
          this._emit({type: 'room', roomId: this.roomId, expiresAt: message.expires_at, invitationUrl: message.invitation_url,
            peerId: message.peer_id, telemetryToken: message.telemetry_token});
          this._status('waiting', 'Room ready. Invite one other device to connect.');
          resolve({room_id: this.roomId, expires_at: message.expires_at});
        }
        if (message.type === 'error' && !welcomed) {
          clearTimeout(joinTimeout);
          this._joinReject = null;
          reject(new Error(message.message || 'This room is unavailable. Create a new room.'));
        }
        this._signalChain = this._signalChain.then(() => {
          if (session === this._session) return this._onSignal(message);
        }).catch(() => {
          if (session === this._session) this._connectionFailure('Could not negotiate the peer connection. Leave and reconnect to try again.');
        });
      };
      socket.onerror = () => {
        if (session !== this._session) return;
        if (!welcomed) {
          clearTimeout(joinTimeout);
          reject(new Error('Cannot reach the signaling server. Check your connection and room address.'));
        }
      };
      socket.onclose = () => {
        clearTimeout(joinTimeout);
        if (session !== this._session) return;
        if (!welcomed) reject(new Error('The room is unavailable, full, or expired. Create a new room and share its code.'));
        this.socket = null;
        this._closePeer('The signaling connection closed. Rejoin the room to continue.');
        this._clearIceCredentials();
        clearInterval(this._timers);
        clearInterval(this._metricsTimer);
        this._timers = null;
        this._metricsTimer = null;
        this._joinReject = null;
        this._joinTimeout = null;
        this._status('disconnected', 'Disconnected from the room. Rejoin or create a new room.');
      };
    });
  }

  _signal(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  async _onSignal(message) {
    if (['offer', 'answer', 'ice'].includes(message.type) && message.pair_id !== this._pairId) return;
    switch (message.type) {
      case 'welcome': break;
      case 'role': this.initiator = Boolean(message.initiator); break;
      case 'peer-joined':
        this._applyPeerIce(message);
        this._pairId = message.pair_id;
        this._setupStarted = performance.now();
        this._setupMs = null;
        this.peerName = String(message.name || 'Other device');
        this._emit({type: 'peer', name: this.peerName, connected: false});
        this._connectDeadline = Date.now() + 45000;
        this._status('connecting', 'Device joined. Establishing an encrypted connection…');
        if (this.initiator) {
          this._makePeer();
          const pc = this.pc;
          this._bindChannel(pc.createDataChannel('lanflux-files', {ordered: true}));
          const offer = await pc.createOffer();
          if (pc !== this.pc) return;
          await pc.setLocalDescription(offer);
          if (pc === this.pc) this._signal({type: 'offer', sdp: pc.localDescription.sdp, pair_id: this._pairId});
        }
        break;
      case 'offer': {
        if (this.initiator) return;
        this._makePeer();
        const pc = this.pc;
        await pc.setRemoteDescription({type: 'offer', sdp: message.sdp});
        await this._flushCandidates(pc);
        const answer = await pc.createAnswer();
        if (pc !== this.pc) return;
        await pc.setLocalDescription(answer);
        if (pc === this.pc) this._signal({type: 'answer', sdp: pc.localDescription.sdp, pair_id: this._pairId});
        break;
      }
      case 'answer': {
        const pc = this.pc;
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({type: 'answer', sdp: message.sdp});
        await this._flushCandidates(pc);
        break;
      }
      case 'ice':
        if (!message.candidate) break;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(message.candidate);
        else if (this._candidates.length < 100) this._candidates.push(message.candidate);
        break;
      case 'peer-left':
        this._closePeer('The other device disconnected. Unfinished transfers were stopped.');
        this._clearIceCredentials();
        if ('initiator' in message) this.initiator = Boolean(message.initiator);
        this.peerName = '';
        this._emit({type: 'peer', name: '', connected: false});
        this._status('waiting', 'The other device left. Share this room with another device.');
        break;
      case 'room-expired':
        this.leave();
        this._status('disconnected', 'This room expired. Create a new room to keep sharing.');
        break;
      case 'error': this._error(message.message || 'The signaling server could not process that request.'); break;
      case 'ping': this._signal({type: 'pong'}); break;
    }
  }

  async _flushCandidates(pc) {
    const candidates = this._candidates.splice(0);
    for (const candidate of candidates) {
      if (pc !== this.pc) return;
      await pc.addIceCandidate(candidate);
    }
  }

  _makePeer() {
    if (this.pc && this.pc.connectionState !== 'closed') return;
    const peerSession = ++this._peerSession;
    const pairId = this._pairId;
    const pc = new RTCPeerConnection(peerConnectionConfig(this.config, this.relayOnly));
    this.pc = pc;
    this._iceErrors = new CandidateErrors();
    pc.onicecandidate = event => {
      if (this.pc === pc && event.candidate) this._signal({type: 'ice', candidate: event.candidate.toJSON(), pair_id: pairId});
    };
    pc.onicecandidateerror = event => {
      if (this.pc !== pc || peerSession !== this._peerSession) return;
      this._iceErrors.add(event);
      this._emitDiagnostics();
    };
    pc.ondatachannel = event => {
      if (this.pc !== pc || peerSession !== this._peerSession) return;
      if (this.channel) { event.channel.close(); return; }
      this._bindChannel(event.channel);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed') this._connectionFailure(connectionFailureHelp(this.config));
      else if (pc.connectionState === 'disconnected') this._status('connecting', 'Peer connection interrupted. Waiting for it to recover…');
      else if (pc.connectionState === 'connected' && this.connected) {
        this._status('connected', 'Connected. Choose files to share.');
        this._updateRoute();
      }
    };
    this._connectDeadline = Date.now() + 45000;
  }

  _bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onopen = () => {
      if (this.channel !== channel) return;
      this.connected = true;
      this._setupMs = this._setupStarted === null ? null : Math.max(0, performance.now() - this._setupStarted);
      this._connectDeadline = null;
      this._status('connected', 'Connected. Choose files to share.');
      this._emit({type: 'peer', name: this.peerName, connected: true});
      this._updateRoute();
      this._pump();
    };
    channel.onmessage = event => {
      // Serialized processing prevents Blob conversion from reordering data/control frames.
      this._receiveChain = this._receiveChain.then(async () => {
        if (this.channel !== channel) return;
        if (typeof event.data === 'string') this._onControl(event.data);
        else {
          const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          if (this.channel === channel) this._onBinary(data);
        }
      }).catch(() => {
        if (this.channel === channel) this._connectionFailure('The other device sent invalid transfer data. Reconnect to try again.');
      });
    };
    channel.onerror = () => {
      if (this.channel === channel) this._connectionFailure('The file connection encountered an error. Rejoin the room to try again.');
    };
    channel.onclose = () => {
      if (this.channel === channel) this._connectionFailure('The other device closed the file connection. Rejoin the room to continue.');
    };
  }

  _control(message) {
    if (this.channel?.readyState !== 'open') return false;
    try { this.channel.send(JSON.stringify(message)); return true; }
    catch { this._connectionFailure('The peer connection closed while sending.'); return false; }
  }

  addFiles(files) {
    if (!this.connected) { this._error('Connect another device before selecting files.'); return []; }
    const accepted = [];
    for (const file of Array.from(files)) {
      if (this.transfers.size >= MAX_HISTORY) { this._error('Clear completed transfers before adding more files.'); break; }
      const pending = [...this.transfers.values()].filter(item => !TERMINAL.has(item.status)).length;
      if (pending >= this.config.max_queue_files) { this._error(`The queue holds up to ${this.config.max_queue_files} active files. Wait for transfers to finish.`); break; }
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.config.max_file_size) {
        this._error(`${safeName(file.name)} exceeds the per-file browser memory limit (${Math.floor(this.config.max_file_size / 1048576)} MiB).`);
        continue;
      }
      const transfer = this._newTransfer({id: makeId(), name: safeName(file.name), size: file.size, direction: 'send', status: 'queued', _file: file});
      this.transfers.set(transfer.id, transfer);
      this._outgoing.push(transfer.id);
      this._update(transfer);
      accepted.push(transfer.id);
    }
    this._pump();
    return accepted;
  }

  _pump() {
    if (!this.connected || this._activeSend) return;
    while (this._outgoing.length) {
      const id = this._outgoing.shift();
      const transfer = this.transfers.get(id);
      if (!transfer || transfer.status !== 'queued') continue;
      this._activeSend = id;
      transfer.status = 'hashing';
      transfer._activity = Date.now();
      this._update(transfer);
      this._prepareOffer(transfer).catch(() => {
        if (transfer.status === 'hashing') {
          transfer.hashStatus = 'failed';
          this._finish(transfer, 'failed', 'Could not calculate the file checksum. Select the file again; it will not be sent without integrity verification.');
        }
      });
      return;
    }
  }

  _newTransfer(fields) {
    return {bytes: 0, speed: 0, hashStatus: 'pending', sha256: null, actualSha256: null,
      currentSpeed: null, averageSpeed: null, durationSeconds: null, etaSeconds: null,
      peakBytesPerSecond: null, startedAt: null, finishedAt: null, connectionSetupMs: this._setupMs,
      route: this._route, resultReason: null, hashSeconds: null, strategy: fields.direction === 'send' ? this._pacer.mode : 'unknown',
      effectiveStrategy: 'baseline', pacingDelayMs: 0, pacingAdjustments: 0, _activity: Date.now(), ...fields};
  }

  _createHash() { return sha256.create(); }

  async _prepareOffer(transfer) {
    const channel = this.channel;
    const peerSession = this._peerSession;
    const start = performance.now();
    const hash = this._createHash();
    transfer._hash = hash;
    try {
      for (let offset = 0; offset < transfer.size; offset += HASH_CHUNK_SIZE) {
        if (transfer.status !== 'hashing' || channel !== this.channel || peerSession !== this._peerSession) return;
        const bytes = await transfer._file.slice(offset, Math.min(offset + HASH_CHUNK_SIZE, transfer.size)).arrayBuffer();
        if (transfer.status !== 'hashing' || channel !== this.channel || peerSession !== this._peerSession) return;
        if (bytes.byteLength !== Math.min(HASH_CHUNK_SIZE, transfer.size - offset)) throw new Error('Incomplete file read');
        hash.update(new Uint8Array(bytes));
        transfer._activity = Date.now();
        await yieldTask();
      }
      // Even empty-file hashing yields so cancellation remains a valid interaction.
      await yieldTask();
      if (transfer.status !== 'hashing' || channel !== this.channel || peerSession !== this._peerSession) return;
      transfer.sha256 = digestHex(hash);
      transfer._hash = null;
      transfer.hashSeconds = Math.max(0, (performance.now() - start) / 1000);
      transfer.status = 'awaiting-approval';
      transfer._activity = Date.now();
      this._update(transfer);
      if (!this._control({type: 'file-offer', id: transfer.id, name: transfer.name, size: transfer.size, protocolVersion: 2, sha256: transfer.sha256})) {
        this._finish(transfer, 'failed', 'The connection closed before the offer was sent.');
      }
    } finally {
      hash.destroy?.();
      if (transfer._hash === hash) transfer._hash = null;
    }
  }

  _onControl(raw) {
    if (raw.length > 8192) throw new Error('Oversized control frame');
    const message = JSON.parse(raw);
    if (!message || Array.isArray(message) || typeof message !== 'object' || !CONTROL_TYPES.has(message.type)) throw new Error('Invalid transfer control');
    const keys = {
      'file-offer': ['type', 'id', 'name', 'size', 'protocolVersion', 'sha256'],
      complete: ['type', 'id', 'sha256'], 'integrity-failed': ['type', 'id', 'reason'],
      ping: ['type', 'nonce'], pong: ['type', 'nonce'],
      accept: ['type', 'id'], reject: ['type', 'id'], cancel: ['type', 'id'], finish: ['type', 'id'],
    }[message.type];
    if (Object.keys(message).some(key => !keys.includes(key))) throw new Error('Invalid transfer control fields');
    if (message.type === 'ping' || message.type === 'pong') {
      if (!validId(message.nonce) || Object.keys(message).length !== 2) throw new Error('Invalid diagnostic ping');
      if (message.type === 'ping') this._control({type: 'pong', nonce: message.nonce});
      else if (this._pendingPing?.nonce === message.nonce) {
        this._rttSampleAt = performance.now();
        this._rttMs = Math.max(0, this._rttSampleAt - this._pendingPing.started);
        this._pendingPing = null;
      }
      return;
    }
    if (!validId(message.id)) throw new Error('Invalid transfer control');
    if (message.type === 'file-offer') {
      this._offer(message);
      return;
    }
    const transfer = this.transfers.get(message.id);
    if (transfer && TERMINAL.has(transfer.status)) return;
    if (message.type === 'complete' && !validHash(message.sha256)) {
      if (transfer?.direction === 'send') this._integrityFailure(transfer, 'The receiver did not return a valid checksum.');
      else throw new Error('Invalid completion checksum');
      return;
    }
    if (message.type === 'integrity-failed' && (typeof message.reason !== 'string' || message.reason.length > 160)) throw new Error('Invalid integrity failure');
    if (!transfer) {
      if (this._discardedIds.has(message.id)) return;
      throw new Error('Unknown transfer identifier');
    }
    switch (message.type) {
      case 'accept':
        if (transfer.direction !== 'send' || transfer.status !== 'awaiting-approval' || this._activeSend !== transfer.id) throw new Error('Unexpected approval');
        transfer.status = 'transferring';
        transfer._activity = Date.now();
        this._startTransfer(transfer);
        this._update(transfer);
        this._sendFile(transfer).catch(error => {
          if (!TERMINAL.has(transfer.status)) {
            this._control({type: 'cancel', id: transfer.id});
            this._finish(transfer, 'failed', error.message || 'Could not read or send this file.');
          }
        });
        break;
      case 'reject':
        if (transfer.direction !== 'send' || transfer.status !== 'awaiting-approval') throw new Error('Unexpected rejection');
        this._finish(transfer, 'rejected', 'The receiver declined this file.');
        break;
      case 'cancel': this._finish(transfer, 'cancelled', 'Cancelled by the other device.'); break;
      case 'finish':
        if (transfer.direction !== 'receive' || transfer.status !== 'transferring') throw new Error('Unexpected transfer finish');
        transfer.status = 'verifying';
        transfer._activity = Date.now();
        this._update(transfer);
        this._verify(transfer);
        break;
      case 'complete':
        if (transfer.direction !== 'send' || transfer.status !== 'transferring' || !transfer._finishSent) throw new Error('Unexpected verification acknowledgement');
        transfer.actualSha256 = message.sha256;
        if (!equalDigest(transfer.sha256, message.sha256)) this._integrityFailure(transfer, 'The receiver checksum did not match the original file.');
        else { transfer.hashStatus = 'verified'; this._finish(transfer, 'completed'); }
        break;
      case 'integrity-failed': this._integrityFailure(transfer, 'The other device could not verify this file.'); break;
      default: throw new Error('Unknown control frame');
    }
  }

  _offer(message) {
    if (this.transfers.has(message.id)) throw new Error('Duplicate transfer identifier');
    if (this._discardedIds.has(message.id)) { this._control({type: 'reject', id: message.id}); return; }
    if (typeof message.name !== 'string' || message.name.length > 1024 || !Number.isSafeInteger(message.size) || message.size < 0) throw new Error('Invalid file metadata');
    if (this.transfers.size >= MAX_HISTORY) {
      this._control({type: 'reject', id: message.id});
      this._rememberDiscarded(message.id);
      if (!this._historyWarned) {
        this._historyWarned = true;
        this._error('Transfer history is full. Clear completed transfers before receiving more files.');
      }
      return;
    }
    if (message.protocolVersion !== 2 || !validHash(message.sha256)) {
      const transfer = this._newTransfer({id: message.id, name: safeName(message.name), size: message.size, direction: 'receive', status: 'approval-needed'});
      this.transfers.set(transfer.id, transfer);
      this._integrityFailure(transfer, message.protocolVersion !== 2 ? 'Incompatible transfer protocol. Refresh both devices to the latest LANFLUX version.' : 'The file offer is missing a valid SHA-256 checksum.');
      return;
    }
    const pending = [...this.transfers.values()].filter(item => !TERMINAL.has(item.status)).length;
    if (this._activeReceive || message.size > this.config.max_file_size || this._memoryUsed + message.size > this.config.max_memory_bytes || pending >= this.config.max_queue_files) {
      this._control({type: 'reject', id: message.id});
      this._rememberDiscarded(message.id);
      this._error('An incoming file was declined because the receive queue or browser memory limit is full. Clear completed downloads to free memory.');
      return;
    }
    const transfer = this._newTransfer({id: message.id, name: safeName(message.name), size: message.size, direction: 'receive', status: 'approval-needed', sha256: message.sha256, _chunks: [], _reserved: message.size});
    this.transfers.set(transfer.id, transfer);
    this._activeReceive = transfer.id;
    this._memoryUsed += transfer.size;
    this._memory();
    this._update(transfer);
  }

  _startTransfer(transfer) {
    const now = performance.now();
    transfer._started = now;
    if (transfer.direction === 'send') { transfer.strategy = this._pacer.mode; this._pacer.nextAt = 0; }
    transfer.startedAt = Date.now();
    transfer._metrics = new PayloadMetrics(now);
    transfer._metrics.start(now);
    transfer._meterActive = true;
    this._metrics.start(now);
    transfer.connectionSetupMs = this._setupMs;
    transfer.route = this._route;
  }

  async _verify(transfer) {
    const channel = this.channel;
    const peerSession = this._peerSession;
    try {
      await yieldTask();
      if (transfer.status !== 'verifying' || channel !== this.channel || peerSession !== this._peerSession) return;
      if (transfer.bytes !== transfer.size || !transfer._hash || !validHash(transfer.sha256)) {
        this._integrityFailure(transfer, 'The file ended before all bytes and a valid checksum arrived.');
        return;
      }
      transfer.actualSha256 = digestHex(transfer._hash);
      transfer._hash = null;
      if (!equalDigest(transfer.sha256, transfer.actualSha256)) {
        this._integrityFailure(transfer, 'SHA-256 verification failed. The received file was discarded.');
        return;
      }
      await yieldTask();
      if (transfer.status !== 'verifying' || channel !== this.channel || peerSession !== this._peerSession) return;
      const blob = new Blob(transfer._chunks, {type: 'application/octet-stream'});
      transfer.url = URL.createObjectURL(blob);
      transfer._chunks = [];
      transfer.hashStatus = 'verified';
      this._finish(transfer, 'completed');
      this._control({type: 'complete', id: transfer.id, sha256: transfer.actualSha256});
    } catch {
      if (transfer.status === 'verifying') this._integrityFailure(transfer, 'The browser could not verify this file. It was discarded; try a smaller file.');
    }
  }

  _integrityFailure(transfer, reason) {
    if (TERMINAL.has(transfer.status)) return;
    transfer.hashStatus = 'failed';
    this._control({type: 'integrity-failed', id: transfer.id, reason: reason.slice(0, 160)});
    this._finish(transfer, 'failed', reason);
  }

  approve(id) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.status !== 'approval-needed' || transfer.direction !== 'receive') return;
    try { transfer._hash = this._createHash(); }
    catch { this._integrityFailure(transfer, 'The browser checksum engine is unavailable. No file bytes will be accepted.'); return; }
    transfer.status = 'transferring';
    transfer._activity = Date.now();
    this._startTransfer(transfer);
    this._update(transfer);
    if (!this._control({type: 'accept', id})) this._finish(transfer, 'failed', 'The connection closed before approval was sent.');
  }

  reject(id) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.status !== 'approval-needed' || transfer.direction !== 'receive') return;
    this._control({type: 'reject', id});
    this._finish(transfer, 'rejected', 'You declined this file.');
  }

  cancel(id) {
    const transfer = this.transfers.get(id);
    if (!transfer || TERMINAL.has(transfer.status)) return;
    if (!['queued', 'hashing'].includes(transfer.status)) this._control({type: 'cancel', id});
    this._finish(transfer, 'cancelled', 'Cancelled on this device.');
  }

  async _sendFile(transfer) {
    const channel = this.channel;
    const negotiated = this.pc?.sctp?.maxMessageSize;
    if (Number.isFinite(negotiated) && negotiated > 0 && negotiated <= 16) throw new Error('The peer supports messages too small for LANFLUX file frames.');
    const chunkSize = Math.min(CHUNK_SIZE, negotiated > 16 ? negotiated - 16 : CHUNK_SIZE);
    if (Math.ceil(transfer.size / chunkSize) > Math.max(64, Math.ceil(transfer.size / 4096))) {
      throw new Error('The peer message limit would require too many small chunks. Try a smaller file or a newer browser.');
    }
    const prefix = idBytes(transfer.id);
    let offset = 0;
    while (offset < transfer.size) {
      if (transfer.status !== 'transferring' || channel !== this.channel || channel.readyState !== 'open') return;
      // No wire fields change; pacing never replaces DataChannel backpressure.
      if (this._pacer.mode !== 'baseline') {
        let delay = 0;
        try { delay = this._pacer.delay(Math.min(chunkSize, transfer.size - offset)); }
        catch { this._pacer.reset(); }
        if (delay > 0) {
          transfer.effectiveStrategy = this._pacer.mode;
          const waitStarted = performance.now();
          await new Promise(resolve => setTimeout(resolve, delay));
          if (transfer.status !== 'transferring' || channel !== this.channel || channel.readyState !== 'open') return;
          transfer.pacingDelayMs += Math.max(0, performance.now() - waitStarted);
          transfer.pacingAdjustments++;
        }
        if (transfer.status !== 'transferring' || channel !== this.channel || channel.readyState !== 'open') return;
      }
      await this._waitForBuffer(channel, transfer);
      if (transfer.status !== 'transferring' || channel !== this.channel) return;
      const chunk = await transfer._file.slice(offset, offset + chunkSize).arrayBuffer();
      if (transfer.status !== 'transferring' || channel !== this.channel) return;
      if (!chunk.byteLength) throw new Error('The selected file could not be read. Select it again.');
      const frame = new Uint8Array(16 + chunk.byteLength);
      frame.set(prefix);
      frame.set(new Uint8Array(chunk), 16);
      channel.send(frame);
      offset += chunk.byteLength;
      transfer.bytes = offset;
      transfer._metrics.add(chunk.byteLength);
      this._metrics.add(chunk.byteLength);
      transfer._activity = Date.now();
      this._progress(transfer);
    }
    if (transfer.status !== 'transferring' || channel !== this.channel) return;
    await this._waitForBuffer(channel, transfer);
    if (transfer.status !== 'transferring' || channel !== this.channel) return;
    transfer._finishSent = true;
    transfer._activity = Date.now();
    this._control({type: 'finish', id: transfer.id});
    this._progress(transfer, true);
  }

  _waitForBuffer(channel, transfer) {
    if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(cancelPoll);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        this._bufferWaiters.delete(onClose);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('The peer disconnected while sending.')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('The connection stalled. Try again on a more stable network.')); }, 30000);
      const cancelPoll = setInterval(() => {
        if (transfer.status !== 'transferring' || channel !== this.channel) { cleanup(); resolve(); }
      }, 100);
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
      this._bufferWaiters.add(onClose);
      // Recheck after subscribing to avoid a missed drain notification.
      if (channel.readyState !== 'open') onClose();
      else if (channel.bufferedAmount <= BUFFER_LOW) onLow();
    });
  }

  _onBinary(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength <= 16 || data.byteLength > CHUNK_SIZE + 16) throw new Error('Invalid binary frame');
    const frame = new Uint8Array(data);
    const id = frameId(frame);
    const transfer = this.transfers.get(id);
    if (this._discardedIds.has(id) || (transfer && TERMINAL.has(transfer.status))) return;
    if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring' || this._activeReceive !== id) throw new Error('File bytes arrived without consent');
    const length = data.byteLength - 16;
    if (transfer.bytes + length > transfer.size) {
      this._integrityFailure(transfer, 'The incoming file exceeded its announced size.');
      return;
    }
    // Payload accounting alone cannot bound the overhead of millions of tiny buffers.
    const maxChunks = Math.max(64, Math.ceil(transfer.size / 4096));
    if (transfer._chunks.length >= maxChunks) {
      this._control({type: 'cancel', id});
      this._finish(transfer, 'failed', 'The incoming file used too many small chunks. Try sending it again.');
      return;
    }
    try { transfer._hash.update(frame.subarray(16)); }
    catch { this._integrityFailure(transfer, 'The browser could not calculate the incoming file checksum.'); return; }
    transfer._chunks.push(data.slice(16));
    transfer.bytes += length;
    transfer._metrics.add(length);
    this._metrics.add(length);
    this._receivedPayloadBytes += length;
    transfer._activity = Date.now();
    this._progress(transfer);
  }

  _progress(transfer, force = false) {
    const now = performance.now();
    this._transferMetrics(transfer, now);
    if (force || !transfer._lastUpdate || now - transfer._lastUpdate > 100) {
      transfer._lastUpdate = now;
      this._update(transfer);
    }
  }

  _finish(transfer, status, error) {
    if (TERMINAL.has(transfer.status)) return;
    transfer.status = status;
    transfer.error = error;
    transfer.resultReason = error || (status === 'completed' ? 'SHA-256 checksums matched.' : status);
    transfer.finishedAt = Date.now();
    if (transfer._meterActive) {
      const now = performance.now();
      transfer._metrics.stop(now);
      this._metrics.stop(now);
      transfer._meterActive = false;
      this._transferMetrics(transfer, now);
    }
    transfer.currentSpeed = null;
    transfer.etaSeconds = null;
    transfer._file = null;
    transfer._hash?.destroy?.();
    transfer._hash = null;
    if (status !== 'completed') {
      transfer._chunks = [];
      this._releaseMemory(transfer);
      this._rememberDiscarded(transfer.id);
    }
    if (this._activeSend === transfer.id) this._activeSend = null;
    if (this._activeReceive === transfer.id) this._activeReceive = null;
    this._update(transfer);
    queueMicrotask(() => this._pump());
  }

  _rememberDiscarded(id) {
    this._discardedIds.add(id);
    if (this._discardedIds.size > 200) this._discardedIds.delete(this._discardedIds.values().next().value);
  }

  _releaseMemory(transfer) {
    if (transfer._reserved) {
      this._memoryUsed = Math.max(0, this._memoryUsed - transfer._reserved);
      transfer._reserved = 0;
      this._memory();
    }
  }

  download(id) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.status !== 'completed' || transfer.hashStatus !== 'verified' || transfer.direction !== 'receive' || !transfer.url) return;
    const anchor = document.createElement('a');
    anchor.href = transfer.url;
    anchor.download = transfer.name;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  clearCompleted() {
    for (const [id, transfer] of this.transfers) {
      if (!TERMINAL.has(transfer.status)) continue;
      if (transfer.url) URL.revokeObjectURL(transfer.url);
      this._releaseMemory(transfer);
      this.transfers.delete(id);
      this._rememberDiscarded(id);
    }
    this._historyWarned = false;
    this._emit({type: 'cleared'});
  }

  get transferStrategy() { return this._pacer.mode; }

  setTransferStrategy(mode) {
    if (this._activeSend) return false;
    const changed = this._pacer.setMode(mode);
    if (changed) this.strategyEpoch++;
    return changed;
  }

  updateTransferIntelligence(observation) {
    try { this._pacer.update(observation); }
    catch { this._pacer.reset(); }
  }

  clearTransferIntelligence() { this._pacer.reset(); }

  setRelayOnly(enabled) {
    if (!enabled && this.config?.ice_transport_policy === 'relay') {
      this._error('This LANFLUX host requires TURN relay connections. The administrator controls this setting.');
      return false;
    }
    if (this.roomId && this.socket) {
      this._error('Leave the current room before changing the connection mode.');
      return false;
    }
    if (enabled && !iceCapabilities(this.config || {}).turnConfigured) {
      this._error('Relay-only mode needs a TURN server configured by the LANFLUX host.');
      return false;
    }
    this.relayOnly = Boolean(enabled);
    return true;
  }

  _applyPeerIce(message) {
    const next = applyPeerIce(this.config || {}, message);
    if (next !== this.config) {
      this.config = next;
      if (next.ice_transport_policy === 'relay') this.relayOnly = true;
      this._emit({type: 'config', config: this.config});
    }
  }

  _clearIceCredentials() {
    if (!this.config) return;
    this.config = withoutTurnCredentials(this.config);
    this._emit({type: 'config', config: this.config});
  }

  _transferMetrics(transfer, now = performance.now(), sample = false) {
    if (!transfer._metrics) return;
    const metrics = sample ? transfer._metrics.sample(now, transfer.size - transfer.bytes) : transfer._metrics.snapshot(now, transfer.size - transfer.bytes);
    transfer.currentSpeed = metrics.currentBytesPerSecond;
    transfer.averageSpeed = metrics.averageBytesPerSecond;
    transfer.speed = metrics.averageBytesPerSecond ?? 0;
    transfer.durationSeconds = metrics.durationSeconds;
    transfer.etaSeconds = metrics.etaSeconds;
    transfer.peakBytesPerSecond = metrics.peakBytesPerSecond;
  }

  async _updateRoute() {
    const pc = this.pc;
    let route = 'unknown';
    if (pc && this.connected) {
      try {
        const stats = await pc.getStats();
        if (pc !== this.pc) return;
        route = pairRoute(stats);
      } catch { /* An unavailable statistic must not retain a previously asserted route. */ }
    }
    if (pc !== this.pc) return;
    this._route = route;
    this._emit({type: 'route', route});
    for (const transfer of this.transfers.values()) {
      if (!TERMINAL.has(transfer.status)) transfer.route = route;
    }
  }

  async inspectIce() {
    const pc = this.pc;
    if (!pc || !this.connected) return {available: false, route: 'unknown', reason: 'Connect a peer to inspect the selected ICE pair.'};
    try {
      const stats = await pc.getStats();
      if (pc !== this.pc) return {available: false, route: 'unknown', reason: 'The peer disconnected.'};
      const pair = selectedPair(stats);
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      if (!local || !remote) return {available: false, route: 'unknown', reason: 'This browser did not expose a reliable selected ICE pair.'};
      const candidate = report => ({candidateType: report.candidateType ?? null, protocol: report.protocol ?? null,
        address: report.address ?? report.ip ?? null, port: report.port ?? null});
      return {available: true, route: pairRoute(stats, pair), local: candidate(local), remote: candidate(remote)};
    } catch { return {available: false, route: 'unknown', reason: 'ICE statistics are unavailable in this browser.'}; }
  }

  async _sampleMetrics() {
    if (this._sampling) return;
    const sampleToken = {};
    this._sampling = sampleToken;
    const peerSession = this._peerSession;
    try {
      let now = performance.now();
      if (this._pendingPing && now - this._pendingPing.started > 3000) {
        this._pendingPing = null;
        this._rttMs = null;
      }
      if (this.connected && !this._pendingPing && (this._lastPingAt === null || now - this._lastPingAt >= 5000)) {
        const nonce = makeId();
        this._pendingPing = {nonce, started: now};
        this._lastPingAt = now;
        if (!this._control({type: 'ping', nonce})) { this._pendingPing = null; this._rttMs = null; }
      }
      await this._updateRoute();
      if (peerSession !== this._peerSession) return;
      now = performance.now();
      let remaining = 0;
      for (const transfer of this.transfers.values()) {
        if (transfer._meterActive) {
          remaining += Math.max(0, transfer.size - transfer.bytes);
          this._transferMetrics(transfer, now, true);
          this._update(transfer);
        }
      }
      const measured = this._metrics.sample(now, remaining);
      this._emitDiagnostics(now, measured);
    } finally { if (this._sampling === sampleToken) this._sampling = false; }
  }

  _emitDiagnostics(now = performance.now(), measured = this._metrics.snapshot(now)) {
    this._emit({type: 'diagnostics', diagnostics: {
        receivedPayloadBytes:this._receivedPayloadBytes, strategyEpoch:this.strategyEpoch,
        adaptive: this._pacer.decision(now), rttSampleAt: this._rttSampleAt,
        signalingState: this.socket?.readyState === 1 ? 'open' : 'closed',
        iceState: this.pc?.iceConnectionState ?? 'unavailable',
        dataChannelState: this.channel?.readyState ?? 'unavailable',
        route: this._route, currentBytesPerSecond: this.connected ? measured.currentBytesPerSecond : null,
        averageBytesPerSecond: measured.averageBytesPerSecond, totalBytes: measured.totalBytes,
        durationSeconds: measured.durationSeconds, etaSeconds: this.connected ? measured.etaSeconds : null,
        peakBytesPerSecond: measured.peakBytesPerSecond, rttMs: this._rttMs, setupMs: this._setupMs,
        history: this._metrics.history.map(sample => ({...sample})),
        connectionState: networkState({connected: this.connected, route: this._route, phase: this._connectionPhase, peerState: this.pc?.connectionState}),
        iceErrorCount: this._iceErrors.count, iceErrorSummary: this._iceErrors.summary(),
        ...iceCapabilities(this.config || {}),
    }});
  }

  _tick() {
    if (this.socket?.readyState === WebSocket.OPEN) this._signal({type: 'ping'});
    if (this._connectDeadline && Date.now() > this._connectDeadline && !this.connected) {
      this._connectionFailure(connectionFailureHelp(this.config, {timeout: true}));
    }
    for (const transfer of this.transfers.values()) {
      if (TERMINAL.has(transfer.status) || transfer.status === 'queued') continue;
      const limit = ['approval-needed', 'awaiting-approval'].includes(transfer.status) ? APPROVAL_TIMEOUT : TRANSFER_TIMEOUT;
      if (Date.now() - transfer._activity > limit) {
        this._control({type: 'cancel', id: transfer.id});
        this._finish(transfer, 'failed', limit === APPROVAL_TIMEOUT ? 'Approval timed out. Select the file again when the receiver is ready.' : 'The transfer stalled. Keep both browser tabs open and try again.');
      }
    }
  }

  _connectionFailure(message) {
    this._closePeer(message);
    this._status('failed', message);
    this._emit({type: 'peer', connected: false});
  }

  _closePeer(message) {
    this._pacer.reset();
    this._rttSampleAt = null;
    this.connected = false;
    this._connectDeadline = null;
    ++this._peerSession;
    const channel = this.channel;
    this.channel = null;
    for (const closeWaiter of [...this._bufferWaiters]) closeWaiter();
    if (channel) {
      channel.onclose = null; channel.onerror = null; channel.onopen = null; channel.onmessage = null;
      channel.close();
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) { pc.onconnectionstatechange = null; pc.onicecandidate = null; pc.onicecandidateerror = null; pc.ondatachannel = null; pc.close(); }
    this._candidates = [];
    this._outgoing = [];
    this._activeSend = null;
    this._activeReceive = null;
    this._route = 'unknown';
    this._pairId = null;
    this._pendingPing = null;
    this._rttMs = null;
    this._lastPingAt = null;
    this._setupStarted = null;
    this._setupMs = null;
    this._sampling = false;
    this.peerName = '';
    this._receiveChain = Promise.resolve();
    this._emit({type: 'route', route: 'unknown'});
    for (const transfer of this.transfers.values()) {
      if (!TERMINAL.has(transfer.status)) this._finish(transfer, 'failed', message);
    }
    this._emitDiagnostics();
  }

  leave() {
    ++this._session;
    if (this._joinReject) this._joinReject(new Error('Room connection was cancelled.'));
    this._joinReject = null;
    clearTimeout(this._joinTimeout);
    this._joinTimeout = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); }
    clearInterval(this._timers);
    this._timers = null;
    clearInterval(this._metricsTimer);
    this._metricsTimer = null;
    this._closePeer('You left the room. Unfinished transfers were stopped.');
    this._clearIceCredentials();
    this.roomId = null;
    this.initiator = false;
    this.peerName = '';
    this._signalChain = Promise.resolve();
    this._emit({type: 'left'});
    this._status('idle', 'Create a room or join a friend to get started.');
  }
}
