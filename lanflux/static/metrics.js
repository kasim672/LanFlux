// All rates are payload bytes/second. Monotonic timestamps are milliseconds.
export class PayloadMetrics {
  constructor(now = performance.now()) {
    this.totalBytes = 0;
    this.active = 0;
    this.activeMs = 0;
    this.activeSince = null;
    this.lastAt = now;
    this.lastBytes = 0;
    this.origin = now;
    this.current = null;
    this.peak = null;
    this.history = [];
  }
  start(now = performance.now()) {
    if (this.active++ === 0) this.activeSince = now;
  }
  stop(now = performance.now()) {
    if (this.active <= 0) return;
    if (--this.active === 0) {
      this.activeMs += Math.max(0, now - this.activeSince);
      this.activeSince = null;
    }
  }
  add(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid payload byte count');
    this.totalBytes += bytes;
  }
  snapshot(now = performance.now(), remaining = null) {
    const milliseconds = this.activeMs + (this.activeSince === null ? 0 : Math.max(0, now - this.activeSince));
    const seconds = milliseconds / 1000;
    return {totalBytes: this.totalBytes, currentBytesPerSecond: this.current,
      averageBytesPerSecond: seconds > 0 ? this.totalBytes / seconds : null,
      durationSeconds: seconds > 0 ? seconds : null,
      etaSeconds: this.active && Number.isFinite(remaining) && this.current > 0 ? Math.max(0, remaining) / this.current : null,
      peakBytesPerSecond: this.peak};
  }
  sample(now = performance.now(), remaining = null) {
    const elapsed = (now - this.lastAt) / 1000;
    if (elapsed >= 1) {
      this.current = (this.totalBytes - this.lastBytes) / elapsed;
      this.peak = this.peak === null ? this.current : Math.max(this.peak, this.current);
      this.history.push({timeSeconds: (now - this.origin) / 1000, bytesPerSecond: this.current});
      if (this.history.length > 60) this.history.shift();
      this.lastAt = now;
      this.lastBytes = this.totalBytes;
    }
    return this.snapshot(now, remaining);
  }
}

export function selectedPair(stats) {
  const transportIds = new Set();
  for (const report of stats.values()) {
    if (report.type === 'transport' && report.selectedCandidatePairId) transportIds.add(report.selectedCandidatePairId);
  }
  if (transportIds.size > 1) return null;
  if (transportIds.size === 1) {
    const pair = stats.get([...transportIds][0]);
    return pair?.type === 'candidate-pair' && pair.state === 'succeeded' ? pair : null;
  }
  const pairs = [...stats.values()].filter(report => report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected === true || report.nominated === true));
  return pairs.length === 1 ? pairs[0] : null;
}

export function pairRoute(stats, pair = selectedPair(stats)) {
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  const knownTypes = new Set(['host', 'srflx', 'prflx', 'relay']);
  if (!knownTypes.has(local?.candidateType) || !knownTypes.has(remote?.candidateType)) return 'unknown';
  return local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct';
}

export function equalDigest(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== 64 || actual.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}
