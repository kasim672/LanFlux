"""Synthetic correctness fixtures only, never reported as real network evaluation."""
import math

import pytest

from aiml.model import NetworkMonitor
from aiml.predictor import (ThroughputPredictor, chronological_fit, rolling_features,
                            advise, MIN_LABELS, MAX_LABELS)
from test_aiml import observation


def sample(index, **changes):
    return observation(index, throughput_mbps=float(10 + 4 * math.sin(index / 7) + index % 4), **changes)


def collected(count=100):
    predictor = ThroughputPredictor()
    for i in range(count):
        result = predictor.add(sample(i), float(i))
    return predictor, result


def test_past_window_features_and_future_label_alignment():
    predictor = ThroughputPredictor()
    for i in range(7):
        predictor.add(observation(i, throughput_mbps=float(i + 1)), i)
    assert len(predictor.examples) == 0  # Future horizon not fully observed yet.
    predictor.add(observation(7, throughput_mbps=8.), 7)
    first = predictor.examples[0]
    assert first.features[0] == 5
    assert first.features[1] == 3
    assert first.features[3] == 1
    assert first.origin == 5 and first.label_end == 8
    assert first.target == 7  # ACTUAL subsequent interval rates 6, 7, 8.
    assert first.input_start < first.origin < first.label_end


def test_future_changes_labels_but_cannot_change_anchored_features():
    a, b = ThroughputPredictor(), ThroughputPredictor()
    for i in range(8):
        a.add(observation(i, throughput_mbps=float(i + 1)), i)
        b.add(observation(i, throughput_mbps=float(i + 1) if i < 5 else 100.), i)
    assert a.examples[0].features == b.examples[0].features
    assert a.examples[0].target != b.examples[0].target
    with pytest.raises(ValueError):
        rolling_features([])


@pytest.mark.parametrize('interval,gap', [(3000., 3.), (1000., 4.), (1000., 2.), (750., .1)])
def test_missing_or_irregular_samples_break_windows_and_pending_labels(interval, gap):
    predictor = ThroughputPredictor()
    for i in range(6):
        predictor.add(sample(i), i)
    predictor.add(sample(6, interval_ms=interval), 5 + gap)
    assert not predictor.pending and not predictor.window
    assert not predictor.examples


def test_future_interval_weights_are_based_on_measured_durations():
    predictor = ThroughputPredictor()
    for i in range(5):
        predictor.add(observation(i, throughput_mbps=2.), i)
    predictor.add(observation(5, interval_ms=2000., throughput_mbps=4.), 6)
    predictor.add(observation(6, interval_ms=2000., throughput_mbps=10.), 8)
    assert predictor.examples[0].target == 6  # 2s*4 + 1s*10 over next 3s.
    assert predictor.examples[0].label_end == 9  # Last measurement ends beyond horizon.


def test_idle_and_constant_workloads_do_not_fake_training_success():
    for active, rate in [(False, 0.), (True, 10.)]:
        predictor = ThroughputPredictor()
        for i in range(100):
            result = predictor.add(observation(i, active_transfer=active, throughput_mbps=rate), i)
        assert predictor.model is None and result['predicted_mbps'] is None
        assert result['validation'] is None and result['status'] == 'learning'
    with pytest.raises(ValueError):
        chronological_fit([])


def test_training_forecast_and_honest_chronological_baseline_evaluation():
    predictor, result = collected()
    assert predictor.model is not None
    assert result['status'] == 'trained'
    assert math.isfinite(result['predicted_mbps']) and result['predicted_mbps'] >= 0
    _, validation = chronological_fit(list(predictor.examples))
    assert validation['training_samples'] >= 30 and validation['validation_samples'] >= 12
    assert validation['mae_mbps'] >= 0 and validation['baseline_mae_mbps'] >= 0
    rows = list(predictor.examples)
    split = int(len(rows) * .7)
    purged = [row for row in rows[:split] if row.label_end < rows[split].input_start]
    assert len(purged) == validation['training_samples']
    assert max(row.label_end for row in purged) < min(row.input_start for row in rows[split:])


def test_bounded_history_refitting_and_idle_forecast_unavailability():
    predictor, _ = collected(80)
    model, fitted_at = predictor.model, predictor.last_fit
    for i in range(80, 100):
        predictor.add(sample(i), i)
    assert predictor.model is model and predictor.last_fit == fitted_at
    result = predictor.add(sample(100, active_transfer=False), 100)
    assert result['predicted_mbps'] is None
    predictor, _ = collected(700)
    assert len(predictor.examples) == MAX_LABELS
    assert len(predictor.window) == 5 and len(predictor.pending) <= 8


def test_advisor_is_transparent_and_never_invents_anomaly_or_performance_improvement():
    forecast = {'predicted_mbps': 10., 'validation': {'mae_mbps': 1., 'baseline_mae_mbps': 2.}}
    assert advise(forecast, 'Normal', 10.)['trend'] == 'stable'
    assert 'suitable' in advise(forecast, 'Normal', 10.)['recommendation']
    assert advise(forecast, 'Normal', 20.)['trend'] == 'degrading'
    assert advise(forecast, 'Normal', 5.)['trend'] == 'improving'
    assert 'does not prove an attack' in advise(forecast, 'Anomaly', 10.)['recommendation']
    assert advise({}, None, 0.)['trend'] is None
    forecast['validation']['mae_mbps'] = 3.
    assert 'not outperformed' in advise(forecast, 'Normal', 10.)['recommendation']


def test_forecast_failure_does_not_disable_anomaly_monitor(monkeypatch):
    monitor = NetworkMonitor()
    def broken(*args):
        raise RuntimeError('test-only predictor failure')
    monkeypatch.setattr(monitor.forecaster, 'add', broken)
    result = monitor.add(sample(0), now=0)
    assert result['training_samples'] == 1
    assert result['forecast']['status'] == 'unavailable'
    assert result['forecast']['predicted_mbps'] is None
    assert 'forecast_mbps' in monitor.export_csv()


def test_validation_targets_never_influence_fitted_model():
    from dataclasses import replace
    predictor, _ = collected(100)
    rows = list(predictor.examples)
    split = int(len(rows) * .7)
    model, original = chronological_fit(rows)
    changed = [replace(row, target=row.target + 100.) if i >= split else row for i, row in enumerate(rows)]
    other, modified = chronological_fit(changed)
    features = [row.features for row in rows[split:]]
    assert model.predict(features).tolist() == other.predict(features).tolist()
    assert modified['mae_mbps'] != original['mae_mbps']
    expected_baseline = sum(abs(row.target - row.features[0]) for row in rows[split:]) / len(rows[split:])
    assert original['baseline_mae_mbps'] == pytest.approx(expected_baseline)


def test_idle_future_intervals_invalidate_pending_supervised_labels():
    predictor = ThroughputPredictor()
    for i in range(5):
        predictor.add(sample(i), i)
    predictor.add(sample(5, active_transfer=False), 5)
    for i in range(6, 9):
        predictor.add(sample(i), i)
    assert not predictor.examples


def test_authorized_api_trains_and_exports_forecasts_on_explicitly_synthetic_fixtures(monkeypatch):
    from fastapi.testclient import TestClient
    from lanflux.main import create_app
    from lanflux.config import Settings
    from test_signaling import make_room, ws
    from test_aiml import auth
    original = NetworkMonitor.add
    clock = iter(range(80))
    def fixture_clock(self, sample):
        return original(self, sample, now=next(clock))
    monkeypatch.setattr(NetworkMonitor, 'add', fixture_clock)
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first, ws(client, room) as second:
            welcome = first.receive_json(); second.receive_json()
            first.receive_json()
            identity = {'room_id': room, 'peer_id': welcome['peer_id']}
            for i in range(80):
                response = client.post('/api/aiml/sample', json={**identity, 'sample': sample(i).model_dump()}, headers=auth(welcome))
                assert response.status_code == 200
            forecast = response.json()['forecast']
            assert forecast['status'] == 'trained'
            assert forecast['validation']['validation_samples'] >= 12
            assert forecast['predicted_mbps'] >= 0
            csv = client.post('/api/aiml/export', json=identity, headers=auth(welcome)).text
            assert 'forecast_mbps' in csv and room not in csv
            reset = client.post('/api/aiml/reset', json=identity, headers=auth(welcome)).json()
            assert reset['forecast']['status'] == 'learning'
