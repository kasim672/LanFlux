"""Synthetic unit fixtures only; runtime/browser training uses actual telemetry."""

import csv
import io
from datetime import datetime, timezone, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from aiml.model import MAX_RECORDS, Observation, NetworkMonitor, fit_baseline, prediction
from aiml.evaluate import evaluate, load_csv
from lanflux.config import Settings
from lanflux.main import create_app
from test_signaling import make_room, ws


def observation(index=0, **changes):
    return Observation(**{
        'rtt_ms': 10.0 + index % 10, 'throughput_mbps': 8.0 + index % 7 / 10,
        'active_transfer': True, 'interval_ms': 1000.0, 'total_bytes': index * 1000000,
        'route': 'direct', **changes,
    })


def test_no_samples_and_insufficient_samples_never_predict():
    monitor = NetworkMonitor()
    assert monitor.status()['status'] == 'collecting'
    assert monitor.status()['anomaly_score'] is None
    for index in range(29):
        result = monitor.add(observation(index), now=index)
        assert result['status'] == 'collecting'
        assert result['prediction'] is None
    assert monitor.model is None
    with pytest.raises(ValueError):
        fit_baseline([observation()])


def test_trains_real_input_baseline_and_predicts_only_later_samples():
    monitor = NetworkMonitor()
    for index in range(30):
        result = monitor.add(observation(index), now=index)
    assert result['status'] == 'trained'
    assert result['prediction'] is None  # Do not evaluate a training row as a holdout.
    assert len(monitor.training) == 30
    normal = monitor.add(observation(30, rtt_ms=14.0, throughput_mbps=8.3), now=30)
    outlier = monitor.add(observation(31, rtt_ms=2500.0, throughput_mbps=.01), now=31)
    assert normal['prediction'] == 'Normal'
    assert normal['anomaly_score'] <= 0
    assert outlier['prediction'] == 'Anomaly'
    assert outlier['anomaly_score'] > 0
    assert len(monitor.training) == 30  # No silent retraining on outliers.


def test_constant_samples_stay_collecting_and_are_bounded():
    monitor = NetworkMonitor()
    for index in range(650):
        result = monitor.add(observation(0), now=index)
    assert result['status'] == 'collecting'
    assert 'variation' in result['message']
    assert len(monitor.records) == MAX_RECORDS
    assert len(monitor.training) == 120


def test_monotonic_byte_counts_and_sample_pacing():
    monitor = NetworkMonitor()
    monitor.add(observation(1), now=1)
    with pytest.raises(ValueError, match='apart'):
        monitor.add(observation(2), now=1.1)
    with pytest.raises(ValueError, match='decrease'):
        monitor.add(observation(0), now=2)
    assert len(monitor.records) == 1


@pytest.mark.parametrize('changes', [
    {'rtt_ms': float('nan')}, {'rtt_ms': float('inf')}, {'rtt_ms': -1.0},
    {'throughput_mbps': -1.0}, {'throughput_mbps': '100'}, {'total_bytes': True},
    {'interval_ms': 100.0}, {'interval_ms': 15000.0}, {'active_transfer': 'true'},
    {'route': '192.168.1.2'}, {'file_content': 'forbidden'},
])
def test_strict_metadata_validation(changes):
    with pytest.raises(ValidationError):
        observation(**changes)


def test_csv_contains_only_actual_supplied_observations_and_predictions(tmp_path):
    monitor = NetworkMonitor()
    for index in range(40):
        monitor.add(observation(index), now=index)
    exported = list(csv.DictReader(io.StringIO(monitor.export_csv())))
    assert len(exported) == 40
    assert exported[0]['rtt_ms'] == '10.0'
    assert exported[0]['prediction'] == ''
    assert exported[-1]['prediction'] in ('Normal', 'Anomaly')
    assert not {'room_id', 'peer_id', 'token', 'filename', 'file_content'} & exported[0].keys()
    # Timestamps are controlled unit fixtures, never live training substitutes.
    initial = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for index, row in enumerate(exported):
        row['observed_at'] = (initial + timedelta(seconds=index)).isoformat()
    path = tmp_path / 'unit-fixture.csv'
    with path.open('w', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=exported[0].keys())
        writer.writeheader(); writer.writerows(exported)
    rows = load_csv(path)
    report, results = evaluate(rows)
    assert len(results) == 10
    assert 'unavailable' in report
    with pytest.raises(ValueError, match='Collect more real'):
        evaluate(rows[:35])


def api_payload(room, welcome):
    return {'room_id': room, 'peer_id': welcome['peer_id'], 'sample': observation().model_dump()}


def auth(welcome, origin='http://testserver'):
    return {'Origin': origin, 'Authorization': f'Bearer {welcome["telemetry_token"]}'}


def test_api_access_control_origin_membership_and_cleanup():
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first:
            one = first.receive_json()
            payload = api_payload(room, one)
            assert client.post('/api/aiml/sample', json=payload, headers=auth(one)).status_code == 409
            with ws(client, room) as second:
                two = second.receive_json()
                assert first.receive_json()['type'] == 'peer-joined'
                assert second.receive_json()['type'] == 'peer-joined'
                assert client.post('/api/aiml/sample', json=payload).status_code == 403
                assert client.post('/api/aiml/sample', json=payload, headers=auth(one, 'http://evil.example')).status_code == 403
                assert client.post('/api/aiml/sample', json=payload, headers=auth(two)).status_code == 403
                response = client.post('/api/aiml/sample', json=payload, headers=auth(one))
                assert response.status_code == 200
                assert response.json()['prediction'] is None
                assert response.json()['training_samples'] == 1
                assert client.post('/api/aiml/sample', json=payload, headers=auth(one)).status_code == 429
                identity = {k: v for k, v in payload.items() if k != 'sample'}
                export = client.post('/api/aiml/export', json=identity, headers=auth(one))
                assert export.status_code == 200 and 'text/csv' in export.headers['content-type']
                assert room not in export.text and one['telemetry_token'] not in export.text
                assert client.post('/api/aiml/reset', json=identity, headers=auth(one)).json()['training_samples'] == 0
                peer = client.app.state.rooms.rooms[room].peers[0]
            first.receive_json()  # peer-left; remaining peer model freed immediately.
            assert peer.aiml_monitor is None
            assert client.post('/api/aiml/sample', json=payload, headers=auth(one)).status_code == 409
        assert client.post('/api/aiml/sample', json=payload, headers=auth(one)).status_code == 403


def test_api_rejects_oversized_malformed_extra_fields_and_rate_limits():
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first, ws(client, room) as second:
            one = first.receive_json(); second.receive_json()
            assert first.receive_json()['type'] == 'peer-joined'
            assert second.receive_json()['type'] == 'peer-joined'
            headers = {**auth(one), 'Content-Type': 'application/json'}
            assert client.post('/api/aiml/sample', content='x' * 2049, headers=headers).status_code == 413
            assert client.post('/api/aiml/sample', content='{}{}', headers=headers).status_code == 422
            assert client.post('/api/aiml/sample', content='{"room_id":"x","room_id":"y"}', headers=headers).status_code == 422
            payload = api_payload(room, one)
            assert client.post('/api/aiml/sample', json={**payload,'file':'no'}, headers=auth(one)).status_code == 422
            identity = {k: v for k, v in payload.items() if k != 'sample'}
            statuses = [client.post('/api/aiml/export', json=identity, headers=auth(one)).status_code for _ in range(92)]
            assert 429 in statuses
