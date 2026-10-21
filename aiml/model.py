"""IsolationForest baseline: no bundled, generated or fallback training data."""

import csv
import io
import math
import time
from collections import deque
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sklearn.ensemble import IsolationForest

from .predictor import ThroughputPredictor, advise

MIN_SAMPLES = 30
MIN_TRAINING_SECONDS = 25
MAX_RECORDS = 600
FEATURES = ('rtt_ms', 'throughput_mbps', 'active_transfer')


class Observation(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    rtt_ms: float = Field(ge=0, le=60000)
    throughput_mbps: float = Field(ge=0, le=1_000_000)
    active_transfer: bool
    interval_ms: float = Field(ge=750, le=10000)
    total_bytes: int = Field(ge=0, le=2**53 - 1)
    route: Literal['direct', 'relay', 'unknown']


def feature_row(observation: Observation) -> list[float]:
    # Log compression reduces the range of timing/rate magnitudes. Zero stays zero.
    return [math.log1p(observation.rtt_ms), math.log1p(observation.throughput_mbps), float(observation.active_transfer)]


def fit_baseline(observations: list[Observation]) -> IsolationForest:
    if len(observations) < MIN_SAMPLES:
        raise ValueError(f'At least {MIN_SAMPLES} measured samples are required.')
    model = IsolationForest(n_estimators=64, max_samples=min(len(observations), 256),
                            contamination='auto', random_state=42, n_jobs=1)
    model.fit([feature_row(sample) for sample in observations])
    return model


def prediction(model: IsolationForest, observation: Observation) -> tuple[str, float]:
    # sklearn's negative decision function identifies outliers. Invert for the UI.
    score = -float(model.decision_function([feature_row(observation)])[0])
    return ('Anomaly' if score > 0 else 'Normal'), score


class NetworkMonitor:
    """Freeze the first adequate real baseline; evaluate only later observations.

    The caller serializes operations. All observations are untrusted client reports,
    not independently attested measurements. Nothing is written to disk.
    """
    def __init__(self):
        self.forecaster = ThroughputPredictor()
        self.records = deque(maxlen=MAX_RECORDS)
        self.training: list[Observation] = []
        self.model = None
        self.first_at = None
        self.last_at = None
        self.last_total = None

    def status(self, label=None, score=None, message=None) -> dict:
        return {
            'status': 'trained' if self.model is not None else 'collecting',
            'training_samples': len(self.training), 'min_samples': MIN_SAMPLES,
            'samples_retained': len(self.records), 'max_records': MAX_RECORDS,
            'prediction': label, 'anomaly_score': score,
            'forecast': self.forecaster.status(),
            'message': message or ('Baseline trained; evaluating new measurements.' if self.model is not None
                                   else 'Collecting training data from this connected session.'),
        }

    def add(self, observation: Observation, *, now: float | None = None) -> dict:
        now = time.monotonic() if now is None else now
        if self.last_at is not None and now - self.last_at < .75:
            raise ValueError('Samples must be at least 750 ms apart.')
        if self.last_total is not None and observation.total_bytes < self.last_total:
            raise ValueError('Payload byte counts must not decrease within a session.')
        if self.first_at is None:
            self.first_at = now
        self.last_at, self.last_total = now, observation.total_bytes
        phase = 'evaluation' if self.model is not None else 'training'
        label, score, message = None, None, None
        if self.model is None:
            # At most 120 candidates, even when telemetry is constant/uninformative.
            self.training.append(observation)
            self.training = self.training[-120:]
            varied = len({(round(sample.rtt_ms, 3), round(sample.throughput_mbps, 3), sample.active_transfer)
                          for sample in self.training}) >= 3
            if len(self.training) >= MIN_SAMPLES and now - self.first_at >= MIN_TRAINING_SECONDS and varied:
                self.model = fit_baseline(self.training)
                message = 'Baseline trained. Prediction begins with the next measured sample.'
            elif len(self.training) >= MIN_SAMPLES and not varied:
                message = 'Collecting training data: more measurement variation is needed. Try normal file transfers.'
        else:
            label, score = prediction(self.model, observation)
        result = self.status(label, score, message)
        try:
            forecast = self.forecaster.add(observation, now)
        except Exception:
            # Forecast failures must not suppress the existing anomaly monitor or sharing.
            forecast = {'status': 'unavailable', 'predicted_mbps': None, 'validation': None,
                        'message': 'Forecast unavailable; file sharing continues independently.'}
        result['forecast'] = forecast
        result['advice'] = advise(forecast, label, observation.throughput_mbps)
        self.records.append({
            'observed_at': datetime.now(timezone.utc).isoformat(), **observation.model_dump(),
            'phase': phase, 'model_status': result['status'], 'prediction': label or '',
            'anomaly_score': score if score is not None else '',
            'forecast_status': forecast['status'],
            'forecast_mbps': forecast.get('predicted_mbps') if forecast.get('predicted_mbps') is not None else '',
            'forecast_mae_mbps': (forecast.get('validation') or {}).get('mae_mbps', ''),
            'baseline_mae_mbps': (forecast.get('validation') or {}).get('baseline_mae_mbps', ''),
            'network_trend': result['advice']['trend'] or '',
        })
        result['samples_retained'] = len(self.records)
        return result

    def export_csv(self) -> str:
        columns = ['observed_at', *FEATURES, 'interval_ms', 'total_bytes', 'route',
                   'phase', 'model_status', 'prediction', 'anomaly_score',
                   'forecast_status', 'forecast_mbps', 'forecast_mae_mbps', 'baseline_mae_mbps', 'network_trend']
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        writer.writerows(self.records)
        return output.getvalue()
