// Presentation only: every value comes from a real engine measurement.
export function formatBinaryBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}

export function formatRate(value) {
  return Number.isFinite(value) && value >= 0 ? `${(value / 1e6).toFixed(2)} MB/s` : 'Unavailable';
}

export function formatBits(value) {
  return Number.isFinite(value) && value >= 0 ? `${(value * 8 / 1e6).toFixed(2)} Mbps` : 'Mbps unavailable';
}

export function formatSeconds(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value >= 60) return `${Math.floor(value / 60)}m ${(value % 60).toFixed(1)}s`;
  return `${value.toFixed(2)} s`;
}

export function formatMilliseconds(value) {
  return Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} ms` : 'Unavailable';
}

export function routeLabel(route) {
  return route === 'direct' ? 'Direct peer connection' : route === 'relay' ? 'TURN relay' : 'Route unavailable';
}

export class DiagnosticsView {
  constructor() {
    this.history = [];
    this.canvas = document.getElementById('speed-chart');
    this.context = this.canvas.getContext('2d');
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.draw()) : null;
    this.observer?.observe(this.canvas);
    this.draw();
  }

  update(measurement) {
    const write = (id, text) => { document.getElementById(id).textContent = text; };
    write('metric-current', formatRate(measurement.currentBytesPerSecond));
    write('metric-current-bits', formatBits(measurement.currentBytesPerSecond));
    write('metric-average', formatRate(measurement.averageBytesPerSecond));
    write('metric-average-bits', formatBits(measurement.averageBytesPerSecond));
    write('metric-total', formatBinaryBytes(measurement.totalBytes));
    write('metric-duration', formatSeconds(measurement.durationSeconds));
    write('metric-eta', formatSeconds(measurement.etaSeconds));
    write('metric-rtt', formatMilliseconds(measurement.rttMs));
    write('state-setup', formatMilliseconds(measurement.setupMs));
    write('state-signaling', measurement.signalingState || 'Unavailable');
    write('state-ice', measurement.iceState || 'Unavailable');
    write('state-channel', measurement.dataChannelState || 'Unavailable');
    write('diagnostic-route', routeLabel(measurement.route));
    this.history = Array.isArray(measurement.history)
      ? measurement.history.filter((point) => Number.isFinite(point.timeSeconds) && Number.isFinite(point.bytesPerSecond) && point.bytesPerSecond >= 0).slice(-60)
      : [];
    document.getElementById('chart-empty').hidden = this.history.length > 0;
    if (this.history.length) {
      const peak = Math.max(...this.history.map((point) => point.bytesPerSecond));
      write('chart-summary', `${this.history.length} measured samples. Latest ${formatRate(this.history.at(-1).bytesPerSecond)}. Peak ${formatRate(peak)}.`);
    } else write('chart-summary', 'No measured speed samples yet.');
    this.draw();
  }

  draw() {
    if (!this.context) return;
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = 185;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(width * scale);
    this.canvas.height = Math.floor(height * scale);
    const ctx = this.context;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = 50;
    const right = width - 10;
    const top = 15;
    const bottom = height - 30;
    ctx.strokeStyle = '#34443b';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const y = top + (bottom - top) * i / 3;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    }
    if (!this.history.length) return;
    const peak = Math.max(...this.history.map((point) => point.bytesPerSecond));
    const maximum = peak > 0 ? peak : 1;
    const firstTime = this.history[0].timeSeconds;
    const lastTime = this.history.at(-1).timeSeconds;
    const span = Math.max(lastTime - firstTime, 1);
    const points = this.history.map((point) => ({
      x: this.history.length === 1 ? right : left + (right - left) * (point.timeSeconds - firstTime) / span,
      y: bottom - (bottom - top) * point.bytesPerSecond / maximum,
    }));
    const shade = ctx.createLinearGradient(0, top, 0, bottom);
    shade.addColorStop(0, '#83e4c132');
    shade.addColorStop(1, '#83e4c102');
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.moveTo(points[0].x, bottom);
    points.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points.at(-1).x, bottom); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#83e4c1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.stroke();
    if (points.length === 1) {
      ctx.fillStyle = '#83e4c1';
      ctx.beginPath(); ctx.arc(points[0].x, points[0].y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.fillStyle = '#a6b6b1';
    ctx.textAlign = 'right';
    ctx.fillText((peak / 1e6).toFixed(1), left - 8, top + 5);
    ctx.fillText('0', left - 8, bottom + 3);
    ctx.textAlign = 'left';
    ctx.fillText('MB/s', 0, height - 9);
    ctx.fillText('Earlier', left, height - 9);
    ctx.textAlign = 'right';
    ctx.fillText('Now', right, height - 9);
  }

  close() { this.observer?.disconnect(); }
}
