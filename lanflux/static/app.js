import { LanfluxClient } from './transfer.js';
import { DiagnosticsView, formatBinaryBytes as formatBytes, formatRate, formatSeconds, formatMilliseconds, routeLabel } from './diagnostics.js';
import { invitedRoom } from './invitation.js';
import { AINetworkMonitor } from './aiml.js';
import { StrategyComparison } from './comparison.js';
import { downloadText, releaseExportDownloads } from './experiments.js';
import { iceCapabilities, networkState, networkStateLabel } from './ice.js';

const $ = (id) => document.getElementById(id);
const terminalStates = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const transferViews = new Map();
const transfers = new Map();
let currentRoom = null;
let invitation = '';
let config = {};
let status = 'idle';
let currentRoute = 'unknown';
let busy = false;
let initialized = false;
let toastTimer;
let confirmationAction = null;
const diagnostics = new DiagnosticsView();
const aiMonitor = new AINetworkMonitor();
const comparison = new StrategyComparison();

function preferences() {
  try { return JSON.parse(localStorage.getItem('lanflux.preferences') || '{}'); }
  catch { return {}; }
}

const saved = preferences();
$('device-name').value = typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim().slice(0, 40) : 'My browser';
$('settings-name').value = $('device-name').value;
$('relay-only').checked = saved.relayOnly === true;
$('local-device-name').textContent = $('device-name').value;

function displayRoomCode(code) {
  return String(code).match(/.{1,4}/g)?.join(' ') || '';
}

function showError(message) {
  $('alert-text').textContent = message || 'Something went wrong. Try again.';
  $('alert').hidden = false;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function refreshControls() {
  const connected = status === 'connected';
  $('create-room').disabled = busy || !initialized;
  $('join-room').disabled = busy || !initialized;
  $('select-files').disabled = !connected;
  $('drop-zone').setAttribute('aria-disabled', String(!connected));
  $('drop-message').textContent = connected ? 'Drop files here, or choose them from your device.' : currentRoom ? 'Your peer will appear here when the connection is ready.' : 'Connect another device, then drop your files here.';
  $('connection-dot').className = `status-dot${connected ? ' connected' : status === 'failed' ? ' failed' : ''}`;
  $('remote-device-icon').classList.toggle('connected', connected);
  $('nav-connection-dot').className = $('connection-dot').className;
  $('nav-session-status').textContent = connected ? 'Peer connected' : currentRoom ? 'Room active' : 'No active room';
}

function setStatus(event) {
  status = event.status;
  const titles = { idle: 'Ready when you are', connecting: 'Making the connection', waiting: 'Waiting for your peer', connected: 'Connected and ready', disconnected: 'Peer disconnected', failed: 'Connection needs attention' };
  $('connection-status').textContent = titles[status] || 'Connecting';
  $('connection-message').textContent = event.message || '';
  if (['idle', 'waiting', 'disconnected', 'failed'].includes(status)) {
    currentRoute = 'unknown';
    $('route-description').textContent = 'File contents travel over an encrypted WebRTC connection. Python handles signaling and measured network metadata.';
  }
  $('connection-route').textContent = networkStateLabel(networkState({connected: status === 'connected', route: currentRoute, phase: status}));
  refreshControls();
}

function setRoom(room) {
  currentRoom = room;
  document.body.classList.add('room-active');
  const base = config.invitation_base_url || config.public_url || location.origin;
  invitation = room.invitationUrl || `${base.replace(/\/$/, '')}/?room=${encodeURIComponent(room.roomId)}`;
  $('invitation-url').value = invitation;
  $('room-id').textContent = displayRoomCode(room.roomId);
  $('room-panel').hidden = false;
  $('setup-panel').hidden = true;
  const expires = room.expiresAt ? new Date(room.expiresAt) : null;
  $('room-expiration').textContent = expires && !Number.isNaN(expires.valueOf()) ? `Expires at ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Temporary private room';
  const hostname = new URL(invitation).hostname;
  const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  $('local-link-warning').hidden = !localOnly;
  $('qr-warning').hidden = !localOnly;
  $('share-link').hidden = typeof navigator.share !== 'function';
  $('local-device-name').textContent = $('device-name').value.trim() || 'My browser';
  refreshControls();
}

function setRoute(route) {
  currentRoute = route;
  const state = networkStateLabel(networkState({connected: status === 'connected', route, phase: status}));
  $('diagnostic-route').textContent = state;
  $('connection-route').textContent = state;
  $('route-description').textContent = route === 'relay' ? 'Your encrypted file traffic passes through a TURN relay. It is not a direct connection.' : route === 'direct' ? 'Your file contents travel directly between these browsers over encrypted WebRTC.' : 'WebRTC encrypts file traffic. The browser has not exposed a reliable route measurement.';
}

function updateLimits() {
  const fileLimit = Number(config.max_file_size);
  const memoryLimit = Number(config.max_memory_bytes);
  const queueLimit = Number(config.max_queue_files);
  if (fileLimit > 0) $('file-limit').textContent = `Up to ${formatBytes(fileLimit)} per file · Sequential, approval required`;
  const limits = `Received files are held in memory${memoryLimit > 0 ? `, up to ${formatBytes(memoryLimit)} total` : ''}${fileLimit > 0 ? `, with ${formatBytes(fileLimit)} per file` : ''}. Download and clear completed files to free space. Keep this tab open.`;
  $('settings-limit-description').textContent = limits;
  $('help-limits').textContent = `${limits}${queueLimit > 0 ? ` The queue accepts up to ${queueLimit} files.` : ''}`;
  const capabilities = iceCapabilities(config);
  $('network-config-summary').textContent = capabilities.turnConfigured
    ? capabilities.tls443Configured ? 'TURN fallback is configured, including TLS/TCP port 443. This does not prove the relay is reachable from this network.' : 'TURN fallback is configured. No TLS/TCP port 443 alternative is configured.'
    : capabilities.stunConfigured ? 'STUN discovery is configured. No TURN relay fallback is configured.' : 'Local discovery only. No STUN or TURN servers are configured.';
  $('relay-only').disabled = config.ice_transport_policy === 'relay';
  if (config.ice_transport_policy === 'relay') $('relay-only').checked = true;
}

function actionButton(action, label, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${primary ? 'primary' : 'secondary'}`;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function createTransferView(transfer) {
  const card = document.createElement('article');
  card.className = 'transfer-card';
  card.dataset.transferId = transfer.id;
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.setAttribute('aria-hidden', 'true');
  const extension = transfer.name.includes('.') ? transfer.name.split('.').pop() : 'file';
  icon.textContent = extension.slice(0, 5);
  const main = document.createElement('div');
  main.className = 'file-main';
  const header = document.createElement('div');
  header.className = 'file-header';
  const name = document.createElement('h3');
  name.className = 'file-name';
  name.textContent = transfer.name;
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = formatBytes(transfer.size);
  header.append(name, size);
  const meta = document.createElement('p');
  meta.className = 'transfer-meta';
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute('aria-label', `Transfer progress for ${transfer.name}`);
  const details = document.createElement('div');
  details.className = 'transfer-details';
  const percent = document.createElement('span');
  const speed = document.createElement('span');
  details.append(percent, speed);
  const actions = document.createElement('div');
  actions.className = 'transfer-actions';
  const integrity = document.createElement('span');
  integrity.className = 'integrity-badge';
  const metrics = document.createElement('dl');
  metrics.className = 'transfer-metrics';
  const metricViews = Array.from({ length: 3 }, () => {
    const item = document.createElement('div');
    const label = document.createElement('dt');
    const value = document.createElement('dd');
    item.append(label, value); metrics.append(item);
    return { label, value };
  });
  const inspection = document.createElement('details');
  inspection.className = 'transfer-inspection';
  const summary = document.createElement('summary');
  summary.textContent = 'Transfer details';
  const inspectionMetrics = document.createElement('dl');
  inspectionMetrics.className = 'inspection-metrics';
  const inspectionViews = {};
  for (const [key, label] of Object.entries({ current: 'Current speed', average: 'Average speed', duration: 'Transfer duration', eta: 'Time remaining', peak: 'Peak sampled speed', setup: 'Connection setup', route: 'Connection route', reason: 'Result', expected: 'Sender SHA-256', actual: 'Received SHA-256' })) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const value = document.createElement('dd');
    if (key === 'expected' || key === 'actual') value.className = 'digest-value';
    inspectionViews[key] = value;
    item.append(term, value); inspectionMetrics.append(item);
  }
  inspection.append(summary, inspectionMetrics);
  main.append(header, meta, integrity, progress, details, metrics, actions, inspection);
  card.append(icon, main);
  const view = { card, meta, integrity, metrics, metricViews, inspectionViews, progress, percent, speed, details, actions, state: null };
  transferViews.set(transfer.id, view);
  return view;
}

function renderTransfer(transfer) {
  transfers.set(transfer.id, transfer);
  const view = transferViews.get(transfer.id) || createTransferView(transfer);
  if (transfer.status === 'approval-needed' && view.state !== transfer.status) {
    $('incoming-announcement').textContent = `Incoming file: ${transfer.name}, ${formatBytes(transfer.size)}. Choose Accept file or Decline in the transfer queue.`;
  }
  if (['hashing', 'verifying'].includes(transfer.status) && view.state !== transfer.status) {
    $('incoming-announcement').textContent = transfer.status === 'hashing' ? `Computing SHA-256 for ${transfer.name} before sending.` : `Verifying received bytes for ${transfer.name}. The download will be available after verification.`;
  }
  const done = terminalStates.has(transfer.status);
  const destination = done ? $('completed-transfers') : $('active-transfers');
  if (view.card.parentElement !== destination) destination.append(view.card);
  view.card.className = `transfer-card ${transfer.status}`;
  const incoming = transfer.direction === 'receive';
  const labels = { queued: 'Queued', hashing: 'Computing SHA-256 before sending', verifying: 'Verifying received bytes', 'awaiting-approval': 'Waiting for receiver approval', 'approval-needed': 'Your approval is needed', transferring: incoming ? 'Receiving' : 'Sending', completed: incoming ? 'Received · Ready to download' : 'Delivered', rejected: 'Transfer declined', cancelled: 'Transfer cancelled', failed: 'Transfer failed' };
  view.meta.textContent = transfer.error || `${incoming ? 'Incoming' : 'Outgoing'} · ${labels[transfer.status] || transfer.status}`;
  view.meta.className = `transfer-meta${transfer.status === 'failed' ? ' failed' : ''}`;
  const percentage = transfer.size ? Math.min(100, Math.floor((transfer.bytes || 0) / transfer.size * 100)) : transfer.status === 'completed' ? 100 : 0;
  view.progress.value = percentage;
  view.progress.hidden = transfer.status !== 'transferring';
  view.details.hidden = transfer.status !== 'transferring';
  view.percent.textContent = `${percentage}% · ${formatBytes(transfer.bytes || 0)} / ${formatBytes(transfer.size)}`;
  view.speed.textContent = formatRate(transfer.currentSpeed);
  view.integrity.textContent = transfer.hashStatus === 'verified' ? 'Integrity Verified' : transfer.hashStatus === 'failed' ? 'Integrity failed' : 'SHA-256 pending';
  view.integrity.className = `integrity-badge ${transfer.hashStatus === 'verified' ? 'verified' : transfer.hashStatus === 'failed' ? 'failed' : 'pending'}`;
  view.integrity.hidden = ['queued', 'approval-needed', 'rejected', 'cancelled'].includes(transfer.status) && transfer.hashStatus !== 'verified';
  const measuredMetrics = done
    ? [['Average speed', formatRate(transfer.averageSpeed)], ['Duration', formatSeconds(transfer.durationSeconds)], ['Peak sampled', formatRate(transfer.peakBytesPerSecond)]]
    : [['Current speed', formatRate(transfer.currentSpeed)], ['Average speed', formatRate(transfer.averageSpeed)], ['Remaining', formatSeconds(transfer.etaSeconds)]];
  measuredMetrics.forEach(([label, value], index) => {
    view.metricViews[index].label.textContent = label;
    view.metricViews[index].value.textContent = value;
  });
  view.metrics.hidden = ['queued', 'approval-needed', 'awaiting-approval', 'hashing'].includes(transfer.status);
  const inspectionValues = { current: formatRate(transfer.currentSpeed), average: formatRate(transfer.averageSpeed), duration: formatSeconds(transfer.durationSeconds), eta: formatSeconds(transfer.etaSeconds), peak: formatRate(transfer.peakBytesPerSecond), setup: formatMilliseconds(transfer.connectionSetupMs), route: routeLabel(transfer.route), reason: transfer.resultReason || transfer.error || 'Transfer in progress', expected: transfer.sha256 || 'Unavailable', actual: transfer.actualSha256 || 'Unavailable' };
  Object.entries(inspectionValues).forEach(([key, value]) => { view.inspectionViews[key].textContent = value; });
  const actionState = `${transfer.status}:${transfer.hashStatus}`;
  if (view.actionState !== actionState) {
    view.actions.replaceChildren();
    if (transfer.status === 'approval-needed') view.actions.append(actionButton('approve', 'Accept file', true), actionButton('reject', 'Decline'));
    else if (!done) view.actions.append(actionButton('cancel', 'Cancel'));
    else if (transfer.status === 'completed' && incoming && transfer.hashStatus === 'verified') view.actions.append(actionButton('download', 'Download file', true));
    view.actions.hidden = view.actions.childElementCount === 0;
    view.actionState = actionState;
  }
  view.state = transfer.status;
  updateCounts();
}

function updateCounts() {
  let active = 0;
  let finished = 0;
  transfers.forEach((transfer) => terminalStates.has(transfer.status) ? finished++ : active++);
  $('active-count').textContent = String(active);
  $('completed-count').textContent = String(finished);
  $('active-empty').hidden = active > 0;
  $('completed-empty').hidden = finished > 0;
  $('completed-note').hidden = finished === 0;
  $('clear-completed').hidden = finished === 0;
  $('nav-transfer-count').textContent = String(active);
}

function clearFinishedViews() {
  for (const [id, transfer] of transfers) {
    if (terminalStates.has(transfer.status)) {
      transferViews.get(id)?.card.remove();
      transferViews.delete(id);
      transfers.delete(id);
    }
  }
  updateCounts();
}

const client = new LanfluxClient({ onEvent(event) {
  switch (event.type) {
    case 'status': setStatus(event); break;
    case 'room': setRoom(event); aiMonitor.join(event); break;
    case 'peer': $('peer-name').textContent = event.name || (event.connected ? 'Other browser' : 'Not connected'); break;
    case 'transfer': comparison.observeTransfer(event.transfer); renderTransfer(event.transfer); refreshStrategy(); if (terminalStates.has(event.transfer.status)) renderComparison(); break;
    case 'route': setRoute(event.route); break;
    case 'error': showError(event.message); break;
    case 'config': config = event.config; updateLimits(); break;
    case 'memory': $('memory-status').textContent = `${formatBytes(event.used)} / ${formatBytes(event.limit)} browser memory`; break;
    case 'cleared': clearFinishedViews(); break;
    case 'diagnostics': diagnostics.update(event.diagnostics); comparison.observeDiagnostics(event.diagnostics); aiMonitor.observe(event.diagnostics,client); refreshStrategy(event.diagnostics.adaptive); break;
    case 'left':
      aiMonitor.leave();
      currentRoom = null;
      document.body.classList.remove('room-active');
      invitation = '';
      $('room-panel').hidden = true;
      $('setup-panel').hidden = false;
      $('peer-name').textContent = 'Not connected';
      $('ice-details-panel').hidden = true;
      $('ice-details').textContent = '';
      currentRoute = 'unknown';
      $('connection-route').textContent = 'Unavailable';
      $('route-description').textContent = 'File contents travel over an encrypted WebRTC connection. Python handles signaling and measured network metadata.';
      refreshControls();
      break;
  }
} });
// Exposes the real engine for development and end-to-end verification.
window.lanfluxClient = client;

const strategyNames = {baseline:'Baseline',rules:'Rule-based',ml:'ML-assisted',mixed:'Mixed',unknown:'Unavailable'};
function refreshStrategy(decision) {
  $('transfer-strategy').disabled = [...client.transfers.values()].some(t => t.direction === 'send' && !terminalStates.has(t.status));
  if (decision) {
    $('strategy-effective').textContent = strategyNames[decision.effectiveMode] || 'Unavailable';
    $('strategy-target').textContent = Number.isFinite(decision.targetMbps) ? decision.targetMbps.toFixed(2) : 'Unavailable';
    $('strategy-reason').textContent = decision.reason || 'Original sending continues.';
  }
}
function renderComparison() {
  const {count,groups} = comparison.snapshot();
  $('comparison-count').textContent = count ? `${count} finished outgoing runs · latest 100 retained in this tab` : 'No finished outgoing runs yet.';
  for (const id of ['comparison-csv','comparison-report','comparison-clear']) $(id).disabled = !count;
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const row = document.createElement('p');
    const speed = Number.isFinite(group.meanThroughputMbps) ? `${group.meanThroughputMbps.toFixed(2)} Mbps` : 'Unavailable';
    row.textContent = `${strategyNames[group.strategy]} → ${strategyNames[group.effectiveStrategy]} · ${formatBytes(group.fileSizeBytes)} · ${group.route} · ${group.condition}: ${group.completed}/${group.runs} verified completions; mean completed speed ${speed}; ${group.failed} failed, ${group.cancelled} cancelled, ${group.rejected} rejected; ${group.totalPacingDelayMs.toFixed(1)} ms observed pacing wait.`;
    fragment.append(row);
  }
  $('comparison-summary').replaceChildren(fragment);
}
$('transfer-strategy').addEventListener('change', () => {
  if (!client.setTransferStrategy($('transfer-strategy').value)) {
    $('transfer-strategy').value = client.transferStrategy;
    toast('Wait until outgoing transfers finish before changing strategy.');
  }
  aiMonitor.clearForecast();
  $('strategy-effective').textContent = 'Baseline';
  $('strategy-target').textContent = 'Unavailable';
  $('strategy-reason').textContent = 'Waiting for fresh observations under the selected strategy.';
  refreshStrategy();
});
$('comparison-csv').addEventListener('click', () => downloadText(comparison.csv(),'lanflux-strategy-comparison.csv','text/csv'));
$('comparison-report').addEventListener('click', () => downloadText(comparison.report(),'lanflux-strategy-comparison.txt'));
$('comparison-clear').addEventListener('click', () => { comparison.clearFinished(); renderComparison(); });

async function roomAction(action) {
  if (busy) return;
  const name = $('device-name').value.trim();
  if (!name) { $('device-name').focus(); showError('Give this device a name so your peer can recognize it.'); return; }
  busy = true;
  $('alert').hidden = true;
  $('create-room').textContent = action === 'create' ? 'Creating your room…' : 'Create a room ↗';
  $('join-room').textContent = action === 'join' ? 'Joining…' : 'Join →';
  refreshControls();
  try {
    if (client.setRelayOnly($('relay-only').checked) === false) {
      $('relay-only').checked = client.relayOnly;
      throw new Error('Your selected connection mode is unavailable. Check Settings and try again.');
    }
    if (action === 'create') await client.createRoom(name);
    else {
      let code = $('room-code').value.trim();
      if (/^https?:\/\//i.test(code)) {
        const link = new URL(code);
        code = link.searchParams.get('room') || '';
      }
      if (!code) throw new Error('Paste a room code or a LANFLUX invitation link.');
      await client.joinRoom(code.toUpperCase(), name);
    }
  } catch (error) {
    if (!currentRoom && client.roomId) client.leave();
    showError(error.message);
  }
  finally {
    busy = false;
    $('create-room').textContent = 'Create a room ↗';
    $('join-room').textContent = 'Join →';
    refreshControls();
  }
}

async function copyText(value, message) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea');
      input.value = value;
      input.className = 'sr-only';
      // Clipboard fallback must stay inside a currently open modal's focus scope.
      const modal = document.querySelector('dialog[open]');
      (modal || document.body).append(input);
      input.focus(); input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('Copy unavailable');
    }
    toast(message);
  } catch { showError('Your browser blocked copying. Use the room code shown in the invitation panel.'); }
}

$('create-room').addEventListener('click', () => roomAction('create'));
$('join-form').addEventListener('submit', (event) => { event.preventDefault(); roomAction('join'); });
$('device-name').addEventListener('input', () => { if (!currentRoom) $('local-device-name').textContent = $('device-name').value.trim() || 'My browser'; });
function requestConfirmation({ title, description, actionLabel, keepLabel = 'Keep sharing', action }) {
  confirmationAction = action;
  $('confirmation-title').textContent = title;
  $('confirmation-description').textContent = description;
  $('confirm-action').textContent = actionLabel;
  $('confirm-keep').textContent = keepLabel;
  $('confirmation-dialog').showModal();
  $('confirm-keep').focus();
}

function leaveRoom() {
  client.leave();
  toast('You left the room. Completed downloads remain available in this tab.');
}

$('leave-room').addEventListener('click', () => {
  const active = [...client.transfers.values()].some((transfer) => !terminalStates.has(transfer.status));
  if (!active) { leaveRoom(); return; }
  requestConfirmation({ title: 'Leave while files are active?', description: 'Leaving stops all queued, hashing, transferring, and verifying files. Completed received files remain available for download in this tab.', actionLabel: 'Stop transfers and leave', action: leaveRoom });
});
$('copy-code').addEventListener('click', () => copyText(currentRoom.roomId, 'Room code copied.'));
$('copy-link').addEventListener('click', () => copyText(invitation, 'Invitation link copied.'));
$('qr-copy-link').addEventListener('click', () => copyText(invitation, 'Invitation link copied.'));
$('share-link').addEventListener('click', async () => {
  try { await navigator.share({ title: 'Join me on LANFLUX', text: 'Connect our browsers to share files.', url: invitation }); }
  catch (error) { if (error.name !== 'AbortError') showError('Sharing is unavailable. Copy the invitation link instead.'); }
});
$('qr-open').addEventListener('click', () => {
  $('qr-image').src = `/api/rooms/${encodeURIComponent(currentRoom.roomId)}/qr`;
  $('qr-room-code').textContent = displayRoomCode(currentRoom.roomId);
  $('qr-dialog').showModal();
});
$('qr-image').addEventListener('error', () => { $('qr-dialog').close(); showError('The QR code could not load. Copy the room code or invitation link instead.'); });

function chooseFiles(files) {
  if (status !== 'connected') { showError('Connect your peer before choosing files.'); return; }
  try { client.addFiles(files); }
  catch (error) { showError(error.message); }
}
$('select-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => { chooseFiles(event.target.files); event.target.value = ''; });
let dragDepth = 0;
document.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
$('drop-zone').addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; if (status === 'connected') $('drop-zone').classList.add('drag-over'); });
$('drop-zone').addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('drop-zone').classList.remove('drag-over'); } });
$('drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = status === 'connected' ? 'copy' : 'none'; });
$('drop-zone').addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; $('drop-zone').classList.remove('drag-over'); chooseFiles(event.dataTransfer.files); });

for (const list of [$('active-transfers'), $('completed-transfers')]) {
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('[data-transfer-id]').dataset.transferId;
    button.disabled = true;
    try {
      await client[button.dataset.action](id);
      if (button.dataset.action === 'download') toast('Download requested. Check your browser downloads.');
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });
}
$('clear-completed').addEventListener('click', () => {
  requestConfirmation({ title: 'Clear finished files and records?', description: 'This removes finished transfer records and deletes received files from browser memory, including files you have not downloaded. Download anything you need first.', actionLabel: 'Clear finished files', keepLabel: 'Keep files', action: () => {
    client.clearCompleted();
    toast('Finished transfers cleared. Received file memory released.');
  } });
});

for (const id of ['confirm-cancel', 'confirm-keep']) $(id).addEventListener('click', () => { confirmationAction = null; $('confirmation-dialog').close(); });
$('confirm-action').addEventListener('click', () => {
  const action = confirmationAction;
  confirmationAction = null;
  $('confirmation-dialog').close();
  action?.();
});
$('confirmation-dialog').addEventListener('cancel', () => { confirmationAction = null; });

$('inspect-connection').addEventListener('click', async () => {
  const button = $('inspect-connection');
  button.disabled = true;
  $('ice-details-panel').hidden = false;
  $('ice-details-message').textContent = 'Inspecting the selected connection…';
  $('ice-details').textContent = '';
  try {
    const details = await client.inspectIce();
    $('ice-details-message').textContent = details.available ? 'Shown only on this screen. Hide these details before sharing a screenshot.' : details.reason || 'The browser has not exposed a selected candidate pair.';
    $('ice-details').textContent = details.available ? JSON.stringify({ route: details.route, local: details.local, remote: details.remote }, null, 2) : '';
  } catch (error) { $('ice-details-message').textContent = error.message || 'Connection details are unavailable in this browser.'; }
  finally { button.disabled = false; }
});
$('hide-ice-details').addEventListener('click', () => { $('ice-details-panel').hidden = true; $('ice-details').textContent = ''; $('inspect-connection').focus(); });

document.querySelectorAll('a.nav-link').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('a.nav-link').forEach((item) => { item.classList.remove('active'); item.removeAttribute('aria-current'); });
  link.classList.add('active');
  link.setAttribute('aria-current', 'location');
}));

window.addEventListener('pagehide', () => {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  confirmationAction = null;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  releaseExportDownloads();
  diagnostics.close();
  aiMonitor.close();
  client.leave();
  client.clearCompleted();
  $('ice-details').textContent = '';
});
// A cached document has closed channels and detached observers/listeners. Rebuild it.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });

function openSettings() { $('settings-name').value = $('device-name').value; $('settings-dialog').showModal(); }
$('settings-open').addEventListener('click', openSettings);
for (const id of ['help-open', 'footer-help']) $(id).addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('settings-name').value.trim();
  if (!name) { $('settings-name').focus(); return; }
  const relayOnly = $('relay-only').checked;
  if (relayOnly && !iceCapabilities(config).turnConfigured) {
    showError('TURN relay is not configured on this server. Ask the administrator to add TURN settings first.');
    $('settings-dialog').close();
    return;
  }
  try {
    if (!currentRoom && client.setRelayOnly(relayOnly) === false) {
      $('relay-only').checked = client.relayOnly;
      return;
    }
  }
  catch (error) { showError(error.message); return; }
  $('device-name').value = name;
  if (!currentRoom) $('local-device-name').textContent = name;
  try { localStorage.setItem('lanflux.preferences', JSON.stringify({ name, relayOnly })); }
  catch { /* Preferences remain usable when storage is disabled. */ }
  $('settings-dialog').close();
  toast(currentRoom ? 'Preferences saved for your next room.' : 'Preferences saved.');
});
$('alert-dismiss').addEventListener('click', () => { $('alert').hidden = true; });

async function start() {
  refreshControls();
  try {
    if (!window.RTCPeerConnection) throw new Error('WebRTC is unavailable in this browser. Try a current browser and open LANFLUX over HTTPS.');
    await client.init();
    // Validate persisted relay preference against this server's configuration.
    const hasTurn = iceCapabilities(config).turnConfigured;
    const relayOnly = config.ice_transport_policy === 'relay' || saved.relayOnly === true && hasTurn;
    $('relay-only').checked = Boolean(relayOnly);
    client.setRelayOnly(Boolean(relayOnly));
    initialized = true;
    const linkedRoom = invitedRoom(location.search);
    if (linkedRoom) {
      $('room-code').value = linkedRoom;
      await roomAction('join');
    }
  } catch (error) { showError(error.message || 'LANFLUX could not start. Refresh this page and check that the server is running.'); }
  refreshControls();
}
start();
