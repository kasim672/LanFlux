// Application pacing experiment, not a replacement for WebRTC congestion control.
export const STRATEGIES = Object.freeze(['baseline', 'rules', 'ml']);
export const MAX_PACING_DELAY_MS = 20;
export class AdaptivePacer {
  constructor() { this.mode = 'baseline'; this.reset(); }
  reset() { this.observation = null; this.minimumRtt = null; this.nextAt = 0; this.burstStarted = null; this.cooldownUntil = 0; this.anchorMbps = null; }
  setMode(mode) {
    if (!STRATEGIES.includes(mode)) return false;
    this.mode = mode; this.reset(); return true;
  }
  update(observation) {
    const {throughputMbps, rttMs, measuredAt, active} = observation || {};
    if (!Number.isFinite(throughputMbps) || throughputMbps <= 0 || throughputMbps > 1e6 ||
        !Number.isFinite(rttMs) || rttMs < 0 || rttMs > 60000 || !Number.isFinite(measuredAt) || !active) {
      this.observation = null; this.nextAt = 0; return;
    }
    this.minimumRtt = this.minimumRtt === null ? rttMs : Math.min(this.minimumRtt, rttMs);
    const f = observation.forecast;
    this.observation = {throughputMbps, rttMs, measuredAt,
      forecast: f && {status:f.status, predicted_mbps:f.predicted_mbps, measuredAt:f.measuredAt,
        validation:f.validation && {...f.validation}}};
  }
  decision(now = performance.now()) {
    const fallback = reason => ({mode:this.mode, effectiveMode:'baseline', targetMbps:null, reason});
    if (this.mode === 'baseline') return fallback('Original WebRTC sending and backpressure.');
    if (now < this.cooldownUntil) return fallback('Baseline recovery interval: collect unpaced observations before another adjustment.');
    const o = this.observation;
    if (!o || now < o.measuredAt || now - o.measuredAt > 3000) return fallback('Recent active measurements unavailable; original sending restored.');
    const raisedRtt = o.rttMs > Math.max(this.minimumRtt * 1.5, this.minimumRtt + 5);
    if (this.mode === 'rules') return raisedRtt
      ? {mode:this.mode, effectiveMode:'rules', targetMbps:(this.anchorMbps ?? o.throughputMbps) * .9,
        reason:'Rule: RTT rose above the session minimum; gently pace at 90% of the burst-start observed throughput.'}
      : fallback('Rule: no measured latency rise; original sending retained.');
    const f = o.forecast, v = f?.validation;
    if (f?.status !== 'trained' || !Number.isFinite(f.measuredAt) || now < f.measuredAt || now - f.measuredAt > 3000 || !Number.isFinite(f.predicted_mbps) || f.predicted_mbps < 0 ||
        !Number.isFinite(v?.mae_mbps) || v.mae_mbps < 0 || !Number.isFinite(v?.baseline_mae_mbps) ||
        v.mae_mbps >= v.baseline_mae_mbps) return fallback('Forecast unavailable or has not beaten the holdout baseline; original sending restored.');
    if (!raisedRtt && f.predicted_mbps >= o.throughputMbps * .85) return fallback('Forecast and RTT do not justify slowing application sending.');
    return {mode:this.mode, effectiveMode:'ml', targetMbps:Math.max((this.anchorMbps ?? o.throughputMbps) * .8,
      Math.min((this.anchorMbps ?? o.throughputMbps) * .95, f.predicted_mbps)),
      reason:'Experimental ML rule: forecast decline or raised RTT; bounded pacing at 80–95% of the burst-start observed throughput.'};
  }
  delay(bytes, now = performance.now()) {
    // A hard three-second intervention followed by five unpaced seconds prevents
    // recursively slowing the next forecast and mistaking pacing for lost capacity.
    if (this.burstStarted !== null && now - this.burstStarted >= 3000) {
      this.burstStarted = null; this.anchorMbps = null; this.cooldownUntil = now + 5000;
    }
    const decision = this.decision(now);
    if (!Number.isFinite(bytes) || bytes <= 0 || !decision.targetMbps) { this.nextAt = 0; return 0; }
    if (this.burstStarted === null) {
      this.burstStarted = now; this.anchorMbps = this.observation.throughputMbps;
    }
    // No accumulated debt; <=20 ms per wait. Very low target rates may not be attained.
    const delay = Math.max(0, Math.min(MAX_PACING_DELAY_MS, this.nextAt - now));
    const interval = Math.min(MAX_PACING_DELAY_MS, bytes * 8 / (decision.targetMbps * 1000));
    this.nextAt = now + delay + interval;
    return delay;
  }
}
