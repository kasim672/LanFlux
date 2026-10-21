// Observed metadata only. No transfer protocol, file content, filename or ICE address.
import {formatBits, formatMilliseconds} from './diagnostics.js';

export class TelemetrySampler {
  constructor() { this.previous = null; }
  reset() { this.previous = null; }
  sample(measurement, connected, active, now) {
    if (!connected || measurement.dataChannelState !== 'open' || !Number.isSafeInteger(measurement.totalBytes) || measurement.totalBytes < 0) {
      this.reset(); return null;
    }
    const previous = this.previous;
    if (!previous || now - previous.time > 10000 || measurement.totalBytes < previous.bytes) {
      this.previous = {time:now, bytes:measurement.totalBytes}; return null;
    }
    const elapsed = now - previous.time;
    if (elapsed < 900) return null;
    this.previous = {time:now, bytes:measurement.totalBytes};
    if (!Number.isFinite(measurement.rttMs) || measurement.rttMs < 0 || measurement.rttMs > 60000) return null;
    const delta = measurement.totalBytes - previous.bytes;
    return {
      rtt_ms:measurement.rttMs, throughput_mbps:delta * 8 / elapsed / 1000,
      interval_ms:elapsed, total_bytes:measurement.totalBytes,
      active_transfer:Boolean(active || delta > 0),
      route:['direct','relay'].includes(measurement.route) ? measurement.route : 'unknown',
    };
  }
}

export class AINetworkMonitor {
  constructor() {
    this.sampler = new TelemetrySampler();
    this.identity = null;
    this.generation = 0;
    this.pending = false;
    this.connected = false;
    this.controller = null;
    this.samples = 0;
    this.forecastAt = null;
    this.activeTransfer = false;
    this.downloads = new Map();
    this.resetHandler = () => this.resetBaseline();
    this.exportHandler = () => this.exportCsv();
    document.getElementById('ai-reset').addEventListener('click',this.resetHandler);
    document.getElementById('ai-export').addEventListener('click',this.exportHandler);
    this.write('ai-message','Connect two browsers to collect actual network measurements.');
  }

  write(id,text) { document.getElementById(id).textContent = text; }
  controls() {
    document.getElementById('ai-reset').disabled = !this.identity || !this.connected || this.pending;
    document.getElementById('ai-export').disabled = !this.identity || !this.connected || !this.samples || this.pending;
  }
  join(room) {
    this.leave();
    if (room.peerId && room.telemetryToken) this.identity = {room_id:room.roomId,peer_id:room.peerId,token:room.telemetryToken};
    this.controls();
  }
  pause() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.pending = false;
    this.connected = false;
    this.sampler.reset();
    this.samples = 0;
    this.write('ai-model-status','Collecting training data');
    this.write('ai-sample-count','0 / 30 baseline samples');
    this.clearForecast();
    this.write('ai-forecast-status','Learning from network activity');
    this.write('ai-forecast-mae','Unavailable'); this.write('ai-baseline-mae','Unavailable');
    this.activeTransfer = false;
    this.write('ai-prediction','Unavailable');
    this.write('ai-score','Unavailable');
    this.write('ai-throughput','Unavailable');
    this.write('ai-latency','Unavailable');
    this.write('ai-message','Connect both browsers. New peer connections start a fresh baseline.');
    document.getElementById('ai-panel').dataset.prediction = '';
    this.controls();
  }
  leave() {
    this.identity = null;
    this.pause();
    for (const [url,timer] of this.downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    this.downloads.clear();
  }

  observe(measurement,client,now = performance.now()) {
    const connected = client.connected && measurement.dataChannelState === 'open' && measurement.signalingState === 'open';
    if (!connected) {
      if (this.connected) this.pause();
      return;
    }
    this.connected = true;
    this.write('ai-latency',formatMilliseconds(measurement.rttMs));
    const active = Array.from(client.transfers.values()).some(transfer => transfer.status === 'transferring');
    this.activeTransfer = active;
    if (!active || (this.forecastAt !== null && now - this.forecastAt > 3000)) this.clearForecast?.();
    const sample = this.sampler.sample(measurement,connected,active,now);
    this.controls();
    if (!sample) {
      if (!Number.isFinite(measurement.rttMs)) {
        this.clearForecast?.();
        this.write('ai-prediction','Unavailable');
        this.write('ai-score','Unavailable');
        this.write('ai-message','Waiting for measured DataChannel round-trip latency. Missing values are never replaced with zero.');
      }
      return;
    }
    this.write('ai-throughput',formatBits(sample.throughput_mbps * 1e6 / 8));
    if (!this.identity || this.pending) return;
    this.request('sample',{sample}).then(result => { if (result) this.render(result,now); }).catch(error => {
      this.clearForecast?.();
      if (error.name !== 'AbortError') {
        this.write('ai-prediction','Unavailable'); this.write('ai-score','Unavailable');
        this.write('ai-message',`Monitor unavailable: ${error.message}. File sharing continues independently.`);
      }
    });
  }

  async request(action,extra = {},csv = false) {
    if (!this.identity || this.pending) return null;
    const identity = this.identity;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = true;
    this.controls();
    const timer = setTimeout(() => controller.abort(),8000);
    try {
      const response = await fetch(`/api/aiml/${action}`,{
        method:'POST', credentials:'same-origin', signal:controller.signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${identity.token}`},
        body:JSON.stringify({room_id:identity.room_id,peer_id:identity.peer_id,...extra}),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(typeof error.detail === 'string' ? error.detail : 'Check the signaling server.');
      }
      const value = csv ? await response.text() : await response.json();
      return generation === this.generation ? value : null;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) {
        this.controller = null; this.pending = false; this.controls();
      }
    }
  }

  clearForecast() {
    this.forecastAt = null;
    this.write('ai-forecast','Unavailable'); this.write('ai-trend','Unavailable');
    this.write('ai-advice','Keep collecting active-transfer observations before relying on predictive advice.');
  }

  renderForecast(forecast = {}, advice = {}, measuredAt = performance.now()) {
    this.clearForecast();
    const trained = forecast.status === 'trained';
    this.write('ai-forecast-status',trained ? `Trained · RandomForest · ${forecast.labeled_samples} labeled windows · last holdout ${forecast.validation?.validation_samples ?? 'Unavailable'} windows` :
      forecast.status === 'unavailable' ? 'Forecast unavailable' : `Learning from network activity · ${forecast.labeled_samples || 0} / ${forecast.min_labeled_samples || 60} labeled windows`);
    const evaluation = forecast.validation;
    this.write('ai-forecast-mae',Number.isFinite(evaluation?.mae_mbps) ? evaluation.mae_mbps.toFixed(3) : 'Unavailable');
    this.write('ai-baseline-mae',Number.isFinite(evaluation?.baseline_mae_mbps) ? evaluation.baseline_mae_mbps.toFixed(3) : 'Unavailable');
    if (trained && this.activeTransfer && performance.now() - measuredAt <= 3000 && Number.isFinite(forecast.predicted_mbps) && forecast.predicted_mbps >= 0) {
      this.write('ai-forecast',forecast.predicted_mbps.toFixed(2));
      this.write('ai-trend',['improving','stable','degrading'].includes(advice.trend) ? advice.trend : 'Unavailable');
      this.forecastAt = measuredAt;
    }
    if (advice.recommendation && (this.forecastAt !== null || advice.recommendation.startsWith('Unusual'))) this.write('ai-advice',advice.recommendation);
  }

  render(result, measuredAt = performance.now()) {
    this.samples = result.samples_retained;
    this.write('ai-model-status',result.status === 'trained' ? 'Trained · IsolationForest' : 'Collecting training data');
    this.write('ai-sample-count',`${result.training_samples} / ${result.min_samples} baseline samples · ${result.samples_retained} retained`);
    this.write('ai-prediction',result.prediction || 'Unavailable');
    this.write('ai-score',Number.isFinite(result.anomaly_score) ? result.anomaly_score.toFixed(5) : 'Unavailable');
    this.write('ai-message',result.message);
    this.renderForecast(result.forecast, result.advice, measuredAt);
    document.getElementById('ai-panel').dataset.prediction = result.prediction || '';
    this.controls();
  }

  async resetBaseline() {
    try {
      const result = await this.request('reset');
      if (result) { this.sampler.reset(); this.render(result); }
    } catch (error) { if (error.name !== 'AbortError') this.write('ai-message',error.message); }
  }

  async exportCsv() {
    try {
      const csv = await this.request('export',{},true);
      if (csv === null) return;
      const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      const link = document.createElement('a');
      link.href = url; link.download = 'lanflux-network.csv';
      document.body.append(link); link.click(); link.remove();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloads.delete(url); },5000);
      this.downloads.set(url,timer);
    } catch (error) { if (error.name !== 'AbortError') this.write('ai-message',error.message); }
  }

  close() {
    this.leave();
    document.getElementById('ai-reset').removeEventListener('click',this.resetHandler);
    document.getElementById('ai-export').removeEventListener('click',this.exportHandler);
  }
}
