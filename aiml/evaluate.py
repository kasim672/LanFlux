"""Chronological evaluation of an exported CSV; never generate training samples.

Run: python -m aiml.evaluate lanflux-network.csv --output predictions.csv
"""

import argparse
import csv
from pathlib import Path
from statistics import mean
from datetime import datetime

from .model import MIN_SAMPLES, MAX_RECORDS, Observation, fit_baseline, prediction


def load_csv(path: Path) -> list[tuple[str, Observation]]:
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Use a bounded LANFLUX export (at most 2 MiB).')
    rows = []
    last_time, last_total = None, None
    with path.open(newline='', encoding='utf-8-sig') as source:
        for row in csv.DictReader(source):
            flag = row['active_transfer'].lower()
            if flag not in ('true', 'false'):
                raise ValueError('Invalid active_transfer value in CSV.')
            stamp = datetime.fromisoformat(row['observed_at'])
            if stamp.tzinfo is None or (last_time is not None and stamp <= last_time):
                raise ValueError('CSV must contain chronological, timezone-aware measurement timestamps.')
            sample = Observation(rtt_ms=float(row['rtt_ms']), throughput_mbps=float(row['throughput_mbps']),
                                 active_transfer=flag == 'true', interval_ms=float(row['interval_ms']),
                                 total_bytes=int(row['total_bytes']), route=row['route'],
                                 strategy=row.get('strategy', 'baseline'))
            if last_total is not None and sample.total_bytes < last_total:
                raise ValueError('CSV must contain measurements from one uninterrupted baseline session.')
            rows.append((row['observed_at'], sample))
            last_time, last_total = stamp, sample.total_bytes
            if len(rows) > MAX_RECORDS:
                raise ValueError(f'At most {MAX_RECORDS} rows are supported.')
    return rows


def evaluate(rows: list[tuple[str, Observation]], train_samples: int = MIN_SAMPLES, *, baseline_only: bool = False):
    excluded = sum(sample.strategy != 'baseline' for _, sample in rows) if baseline_only else 0
    if baseline_only:
        rows = [(stamp, sample) for stamp, sample in rows if sample.strategy == 'baseline']
    if train_samples < MIN_SAMPLES or len(rows) < train_samples + 10:
        raise ValueError(f'Need at least {train_samples} baseline rows and 10 later evaluation rows. Collect more real samples.')
    baseline = [sample for _, sample in rows[:train_samples]]
    if len({(round(s.rtt_ms, 3), round(s.throughput_mbps, 3), s.active_transfer) for s in baseline}) < 3:
        raise ValueError('Baseline needs more observed variation; collect during representative network activity.')
    model = fit_baseline(baseline)
    results = []
    for stamp, sample in rows[train_samples:]:
        label, score = prediction(model, sample)
        results.append({'observed_at': stamp, **sample.model_dump(), 'prediction': label, 'anomaly_score': score})
    anomalies = sum(row['prediction'] == 'Anomaly' for row in results)
    report = (
        f'IsolationForest chronological evaluation\n'
        f'Nonbaseline/unknown rows explicitly excluded: {excluded}\n'
        f'Training rows: {train_samples}; later evaluation rows: {len(results)}\n'
        f'Flagged anomalies: {anomalies} ({anomalies / len(results):.1%})\n'
        f'Mean observed RTT: {mean(row["rtt_ms"] for row in results):.3f} ms\n'
        f'Mean observed payload throughput: {mean(row["throughput_mbps"] for row in results):.3f} Mbps\n'
        f'Scores: {min(row["anomaly_score"] for row in results):.5f} to {max(row["anomaly_score"] for row in results):.5f}\n'
        'Positive score = anomaly relative to this baseline; not an attack verdict or probability.\n'
        'Paced holdout rows are intervention-conditioned; pacing itself may cause a deviation.\n'
        'Accuracy/precision/recall unavailable: these observations have no verified ground-truth labels.\n'
        'The CSV is supplied by the caller; this script cannot attest its measurement provenance.\n'
    )
    return report, results


def main():
    parser = argparse.ArgumentParser(description='Evaluate real LANFLUX telemetry without fabricated training data.')
    parser.add_argument('csv', type=Path, help='CSV downloaded from AI Network Monitor')
    parser.add_argument('--baseline-only', action='store_true', help='Explicitly exclude paced/unknown rows from both training and evaluation; report the count')
    parser.add_argument('--train-samples', type=int, default=MIN_SAMPLES)
    parser.add_argument('--output', type=Path, help='Write holdout predictions to a new CSV file')
    args = parser.parse_args()
    try:
        if args.output and args.output.exists():
            raise ValueError('Output already exists. Choose a new output filename.')
        report, results = evaluate(load_csv(args.csv), args.train_samples, baseline_only=args.baseline_only)
        if args.output:
            with args.output.open('x', newline='', encoding='utf-8') as target:
                writer = csv.DictWriter(target, fieldnames=list(results[0]))
                writer.writeheader()
                writer.writerows(results)
        print(report)
    except (OSError, ValueError, TypeError, KeyError, csv.Error) as exc:
        parser.error(str(exc))


if __name__ == '__main__':
    main()
