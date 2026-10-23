"""Bounded, past-only three-second payload forecasts. No seed training data."""
from collections import deque
from dataclasses import dataclass
import math
from statistics import mean, pstdev

from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error

WINDOW = 5
HORIZON = 3.0
MIN_LABELS = 60
MAX_LABELS = 240
FEATURE_NAMES = ('last_mbps', 'mean_mbps', 'std_mbps', 'trend_mbps_s',
                 'last_rtt_ms', 'std_rtt_ms', 'active_fraction', 'direct', 'relay')


@dataclass(frozen=True)
class Example:
    features: tuple
    target: float
    input_start: float
    origin: float
    label_end: float


def rolling_features(points):
    """Only the supplied, already-observed five-point window is inspected."""
    if len(points) != WINDOW:
        raise ValueError('A complete past observation window is required.')
    rates = [sample.throughput_mbps for _, sample in points]
    latencies = [sample.rtt_ms for _, sample in points]
    span = points[-1][0] - points[0][0]
    last = points[-1][1]
    return (rates[-1], mean(rates), pstdev(rates), (rates[-1] - rates[0]) / span,
            latencies[-1], pstdev(latencies), mean(float(s.active_transfer) for _, s in points),
            float(last.route == 'direct'), float(last.route == 'relay'))


def chronological_fit(examples):
    """Purge overlapping input/label intervals before evaluating later active data."""
    if len(examples) < MIN_LABELS:
        raise ValueError('More genuinely labeled active observations are required.')
    split = int(len(examples) * .7)
    validation = examples[split:]
    train = [row for row in examples[:split] if row.label_end < validation[0].input_start]
    if len(train) < 30 or len(validation) < 12:
        raise ValueError('Insufficient disjoint chronological training and validation windows.')
    rates = [row.features[0] for row in train]
    if (len({round(value, 3) for value in rates}) < 6
            or max(rates) - min(rates) < max(.05, mean(rates) * .05)):
        raise ValueError('More measured throughput variation is needed.')
    model = RandomForestRegressor(n_estimators=48, max_depth=6, min_samples_leaf=3,
                                  max_features=1.0, random_state=42, n_jobs=1)
    model.fit([row.features for row in train], [row.target for row in train])
    targets = [row.target for row in validation]
    predicted = model.predict([row.features for row in validation])
    evaluation = {
        'mae_mbps': float(mean_absolute_error(targets, predicted)),
        'baseline_mae_mbps': float(mean_absolute_error(targets, [row.features[0] for row in validation])),
        'training_samples': len(train), 'validation_samples': len(validation),
        'method': 'purged chronological holdout',
    }
    return model, evaluation


class ThroughputPredictor:
    def __init__(self):
        self.window = deque(maxlen=WINDOW)
        self.pending = deque(maxlen=8)
        self.examples = deque(maxlen=MAX_LABELS)
        self.model = None
        self.evaluation = None
        self.last_at = None
        self.clock = 0.0
        self.accepted_labels = 0
        self.fitted_labels = 0
        self.last_fit = None
        self.last_strategy = None

    def status(self, predicted=None, message=None):
        return {'status': 'trained' if self.model is not None else 'learning',
                'predicted_mbps': predicted, 'horizon_seconds': HORIZON,
                'labeled_samples': len(self.examples), 'min_labeled_samples': MIN_LABELS,
                'validation': self.evaluation,
                'message': message or 'Learning from network activity'}

    def add(self, sample, now):
        strategy = sample.strategy
        if self.last_strategy is not None and strategy != self.last_strategy:
            self.window.clear()
            self.pending.clear()
        self.last_strategy = strategy
        interval = sample.interval_ms / 1000
        gap = None if self.last_at is None else now - self.last_at
        self.last_at = now
        valid = (.75 <= interval <= 2 and (gap is None or
                 (.75 <= gap <= 2 and abs(gap - interval) <= .75)))
        if not valid:
            self.window.clear(); self.pending.clear()
            return self.status(message='Learning from network activity: interrupted measurements skipped.')
        self.clock += interval
        # Each pending anchor was created BEFORE this measurement. Labels use ONLY
        # subsequent measured intervals; clip the last interval at the 3s horizon.
        for anchor in list(self.pending):
            duration = min(interval, HORIZON - anchor['duration'])
            anchor['area'] += sample.throughput_mbps * duration
            anchor['duration'] += duration
            anchor['active'] = anchor['active'] and sample.active_transfer
            if anchor['duration'] >= HORIZON - 1e-9:
                if anchor['active']:
                    self.examples.append(Example(anchor['features'], anchor['area'] / HORIZON,
                                                 anchor['start'], anchor['origin'], self.clock))
                    self.accepted_labels += 1
                self.pending.remove(anchor)
        self.window.append((self.clock, sample))
        usable = len(self.window) == WINDOW and all(s.active_transfer for _, s in self.window)
        if usable:
            features = rolling_features(self.window)
            if features[1] > 0 and strategy == 'baseline':
                self.pending.append({'features': features, 'start': self.window[0][0] - self.window[0][1].interval_ms / 1000,
                                     'origin': self.clock, 'duration': 0., 'area': 0., 'active': True})
        if (len(self.examples) >= MIN_LABELS and self.accepted_labels - self.fitted_labels >= 30
                and (self.last_fit is None or now - self.last_fit >= 60)):
            # Failed variation gates are inexpensive; successful fitting is at most once/minute.
            try:
                model, evaluation = chronological_fit(list(self.examples))
            except ValueError:
                pass
            else:
                self.model, self.evaluation = model, evaluation
                self.last_fit, self.fitted_labels = now, self.accepted_labels
        if not usable or self.model is None:
            return self.status(message='Learning from network activity' if self.model is None
                               else 'Forecast unavailable: keep a transfer active for five measured intervals.')
        predicted = float(self.model.predict([rolling_features(self.window)])[0])
        if not math.isfinite(predicted) or predicted < 0:
            return self.status(message='Forecast unavailable; normal file sharing continues.')
        result = self.status(predicted, 'Experimental forecast for the next three seconds of active transfer.'
                             if strategy == 'baseline' else
                             'Intervention-conditioned forecast: pacing changes achieved throughput; this is not network capacity.')
        result['intervention_conditioned'] = strategy != 'baseline'
        return result


def advise(forecast, anomaly, current):
    """Transparent advisory rules, NOT another trained model or an attack verdict."""
    predicted = forecast.get('predicted_mbps')
    trend = None
    if predicted is not None and math.isfinite(predicted) and current is not None:
        threshold = max(.25, current * .15)
        trend = 'improving' if predicted - current > threshold else 'degrading' if current - predicted > threshold else 'stable'
    if anomaly == 'Anomaly':
        message = 'Unusual network observations: investigate connection conditions; this does not prove an attack.'
    elif trend is None:
        message = 'Keep collecting active-transfer observations before relying on predictive advice.'
    elif (forecast.get('validation') or {}).get('mae_mbps', math.inf) > (forecast.get('validation') or {}).get('baseline_mae_mbps', -1):
        message = 'This model has not outperformed the last-speed baseline on validation. Treat its forecast cautiously.'
    elif trend == 'degrading':
        message = 'The forecast suggests throughput may decline. Keep both tabs active and observe conditions.'
    elif trend == 'improving':
        message = 'The forecast suggests throughput may improve; actual transfer speed can differ.'
    elif anomaly == 'Normal':
        message = 'Stable forecast and normal observations: the connection appears suitable for transferring.'
    else:
        message = 'The forecast is stable; anomaly assessment is still learning.'
    return {'trend': trend, 'recommendation': message, 'logic': 'Advisory rules using measured speed, RandomForest forecast and IsolationForest status.'}
