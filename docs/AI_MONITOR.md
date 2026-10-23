# AI Network Monitor

LANFLUX combines experimental IsolationForest anomaly detection with a supervised RandomForest throughput forecast, reusing existing WebRTC diagnostics. It does not inspect files, modify transfer messages, throttle transfers or claim to detect attacks reliably.

## Observations

Connected browsers sample approximately once per second:

| Field | Source | Used by IsolationForest |
| --- | --- | --- |
| RTT, milliseconds | Explicit DataChannel ping/pong elapsed time | Yes, `log1p` |
| Payload throughput, decimal Mbps | Actual sent-plus-received file-byte counter delta / elapsed sample time | Yes, `log1p` |
| Active transfer | Transfer-engine `transferring` state or observed payload in the interval, including short completed transfers and stalled active intervals | Yes, boolean |
| Cumulative bytes, interval and observed route | Transfer counters, clock and selected ICE candidate statistics | Export context only |

RTT probes run approximately every five seconds, so adjacent one-second rows may share the latest observation. Browser scheduling and channel queueing affect RTT; this is not ICMP latency. Sender counts indicate bytes handed to the channel, receiver counts indicate accepted payload. A measured idle interval can legitimately have zero throughput. Missing RTT, disconnected sessions, counter resets and sampling gaps over ten seconds are skipped, never replaced with fabricated values.

## IsolationForest training and prediction

Each peer has its own session-local monitor. Training requires at least **30 actual observations**, at least **25 seconds measured by the server's monotonic clock**, and **three distinct rounded feature combinations**. The UI stays **Collecting training data** when any requirement is missing; constant telemetry explains that more variation is needed.

`aiml/model.py` fits scikit-learn `IsolationForest` with 64 trees, `contamination='auto'`, a fixed reproducibility seed, one worker and at most 120 baseline rows. The baseline then freezes. The observation completing training is not presented as a holdout prediction; later observations are evaluated against the baseline.

Prediction `-1` becomes **Anomaly**, `1` becomes **Normal**. The displayed score is the negative decision function: positive means anomaly, zero/negative means normal. It is not a probability or confidence percentage. The fixed seed makes model fitting reproducible; it does not generate training observations.

Reset deletes the current peer's model and records. Pair replacement, departure, room expiry and server restart clear session data. Models and CSV rows are never persisted server-side. Retention is bounded to 600 observations per monitor, 32 monitors per server and two concurrent model operations.

## Metadata endpoint access

`POST /api/aiml/sample`, `/api/aiml/reset` and `/api/aiml/export` require a per-peer bearer token delivered through the authorized room WebSocket, a trusted browser Origin, a non-expired room and both live peer memberships. Tokens stay in browser memory, outside invitation links and localStorage.

Strict schemas reject invalid/nonfinite numbers, unrelated fields and malformed JSON. Requests are capped at 2 KiB before complete buffering, paced and rate-limited to 180/IP/minute and 90/peer/minute. Per-peer locks serialize operations; model work runs off the async event loop. File bytes, filenames, hashes, private ICE addresses and room credentials are absent from telemetry exports.

Authorized clients can falsify telemetry. HTTPS/WSS protects the transport on untrusted networks; these measurements are browser reports, not independently attested observations.

## Real-data CSV and evaluation

Choose **Export real samples CSV** while connected. The download includes UTC server receipt time, measured fields, baseline/evaluation phase, model state, prediction and score. Export before resetting or disconnecting.

Collect at least 40 rows, then evaluate locally:

```bash
python -m aiml.evaluate /path/to/lanflux-network.csv --baseline-only --output network-predictions.csv
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m aiml.evaluate "$env:USERPROFILE\Downloads\lanflux-network.csv" --output network-predictions.csv
```

The first 30 chronological rows train the evaluation baseline; at least ten later rows form the holdout. `--train-samples 60` requires at least 70 rows. Inputs are strictly validated, bounded to 600 rows/2 MiB, and must include monotonic cumulative byte counts and valid timestamps. The CLI does not generate data or overwrite an existing output file.

The human-readable report states baseline/holdout counts, mean observed RTT/throughput, score range and actual anomaly count; the output CSV contains holdout predictions and scores. Evaluation can differ from the live model if older rows have rolled out of bounded retention. Accuracy/precision/recall remain unavailable without independently verified labels. Unit tests use explicitly synthetic fixtures for algorithm correctness; production and browser evaluation never use those fixtures as observations.

## Demonstration and limitations

Pair the computer and phone, keep both foregrounded, open Network diagnostics, and send representative files during collection. Wait at least 30–45 seconds; insufficient variation or missing RTT can take longer. After training, observe the score and prediction during later transfers or a real change in distance/congestion. Export all outcomes, including normal ones. An anomaly is not guaranteed and should not be manufactured for a presentation.

Thirty rows are an MVP threshold, not proof of statistical adequacy or 30 independent latency probes. Workload changes, file hashing, CPU scheduling, idle time and Wi-Fi variation can produce false positives; the model can miss anomalies. No labeled accuracy, Wi-Fi benchmark or physical-device performance claim is supplied. Stronger evaluation needs longer representative sessions and independent ground-truth annotation.


## Three-second throughput forecast and transfer advice

`aiml/predictor.py` adds a supervised **RandomForestRegressor** alongside IsolationForest. It predicts aggregate sent-plus-received payload Mbps over approximately the next three seconds **if transfer activity continues**, not link capacity or a specific file's completion speed. Five past observations provide last/mean/standard-deviation throughput, throughput slope, last RTT/RTT variation, active fraction and reliable direct/relay indicators. Unknown routes are not guessed.

An input window is anchored before its label exists. The following measured intervals supply the duration-weighted three-second target; the final interval is proportionally clipped at the horizon. This is an interval-rate approximation, not sub-second ground truth. Only fully active input and future windows contribute labels; stalled active intervals may have real zero throughput. Idle periods cannot manufacture a good evaluation. Samples outside 750–2000 ms, inconsistent receipt gaps, missing observations and disconnections break pending windows.

Training requires **60 genuinely labeled windows**, at least 30 training and 12 validation examples after purging, six distinct recent-speed values, and meaningful throughput variation. The first 70% of windows are training candidates; later windows validate. Training examples whose labels overlap the first validation input window are removed. Validation MAE in Mbps is displayed beside the MAE of always predicting the last observed speed. These are measured holdout errors, not accuracy percentages or proof of improvement. Overlapping windows remain correlated, so this small validation is not an independent network benchmark.

The target and validation calculations are explicit:

```text
future Mbps = sum(observed interval Mbps * included interval seconds) / 3
model MAE = mean(abs(actual future Mbps - RandomForest prediction Mbps))
baseline MAE = mean(abs(actual future Mbps - last observed Mbps))
```

For example, an anchor's five input rates are already fixed before any later observation arrives. Only the next intervals can create its target; changing those later rates cannot change the stored input features. The purge criterion is `training.label_end < first_validation.input_start`. The fitted model uses the training fold only, so validation rows are not subsequently folded back into the reported live model. This protects the stated holdout comparison; it does not make correlated rolling windows independent.

The forest uses 48 trees, depth at most six, minimum leaf size three and one worker. At most 240 labeled examples, five history points and eight pending anchors are retained per existing session monitor. Refitting needs 30 new labels and at least 60 seconds since the last fit. Fitting/prediction uses the existing off-event-loop, authenticated telemetry request path; no new service, dependency, model download or file metadata is needed. Reset/session cleanup clears both models. CSV exports append actual forecasts, validation MAEs and trend; the existing `aiml.evaluate` CLI still evaluates IsolationForest only.

**AI Transfer Intelligence** shows measured speed alongside a fresh forecast, learning/trained status, trend and advisory text. Recommendations are explicitly **rules**, combining IsolationForest status, forecast direction and the measured validation comparison. Trend uses a change threshold of the larger of 0.25 Mbps or 15% of measured speed. Advice flags experimental forecasts that have not beaten the last-speed baseline. An anomaly is not proof of an attack. Forecasts disappear during idle activity, missing latency, request failure or after three seconds without a fresh result; normal file sharing remains independent.

### Demonstrate

1. Start `python -m lanflux --lan --port 8000`, pair the devices and open Network diagnostics.
2. Keep tabs foregrounded and send representative files while approving incoming offers. Collect at least roughly 70–90 seconds of **active**, varied measurements; idle time does not count. Several short transfers may not supply complete five-second inputs plus three-second labels. Use files within the existing 64 MiB limit and clear saved receives before hitting 128 MiB retention.
3. Wait for the separate RandomForest status to become trained. During continued transfers, observe measured/predicted Mbps, trend, model MAE and baseline MAE. Predictions may be worse than the baseline; report that result honestly.
4. Export the real CSV before resetting/disconnecting. No synthetic test fixtures are used in live training. Fast or short sessions may legitimately remain “Learning from network activity”.

## Adaptive Transfer Lab

The monitor includes three sender strategies, selectable before outgoing files are queued. **Baseline** is the original sender and remains the default on every page load. **Rule-based** may pace when peer RTT exceeds both 1.5 times the strategy session minimum and that minimum plus 5 ms. **ML-assisted** additionally requires a trained, finite, independently fresh forecast whose purged chronological validation MAE is strictly lower than the last-speed baseline MAE. Stale or missing evidence restores original sending.

These are transparent application policies, not additional trained models or a replacement for WebRTC congestion control. Rule-based pacing targets 90% of the burst-start observed throughput. ML pacing targets a forecast-informed rate bounded to 80-95% of that anchor. The anchor stays fixed for a burst so the controller cannot repeatedly multiply its own reduced observations downward. An intervention lasts at most three seconds, then requires five seconds of unpaced recovery. A requested per-chunk wait is capped at 20 ms; actual browser timer scheduling can exceed that time. These targets are requested pacing rates, not guaranteed achieved rates or link-capacity estimates.

File protocol v2, frame limits, backpressure, approval, verification and cancellation are preserved. Delays recheck transfer state and channel identity before sending. No pause, automatic cancellation, byte dropping or chunk-size expansion is introduced. ML and API failures cannot prevent ordinary sharing. The selected strategy is locked while an outgoing transfer is pending, and every new page starts in baseline mode.

### Policy-aware learning

Metadata adds a categorical `strategy`: `baseline`, `rules`, `ml`, or `unknown`. Only eligible baseline observations train IsolationForest or create supervised forecast examples. A policy transition clears pending feature/label windows. Incoming-byte deltas and strategy-change generations exclude mixed intervals, including incoming bytes that arrived before a local outgoing file began. Receiving-only and bidirectional measurements are `unknown` because the current file protocol does not disclose the remote sender's policy.

A trained model can infer from paced or unknown-policy windows, but the UI labels these forecasts as intervention-conditioned. They predict achieved workload throughput, not unpaced network capacity. Those intervals never become training labels. Selecting a strategy does not fabricate training data. If the model has not beaten its holdout baseline, ML mode honestly continues baseline sending.

The existing telemetry CSV preserves `strategy`. The offline anomaly evaluator accepts older CSV files without that column as baseline for compatibility; that is an explicit provenance assumption. By default it rejects paced/unknown observations in its training segment. Use `--baseline-only` to explicitly exclude those rows from both fitting and evaluation; the report states the excluded count. No rows are relabeled or invented. Runtime source measurements are client reports, not independently attested observations.

### Comparison and demonstration

Open **Network Diagnostics → AI Network Monitor → Adaptive Transfer Lab**. Collect varied active **outgoing** baseline observations first. Then compare equal-size files with each strategy, alternating order and recording all attempts. The monitor shows the current effective decision, requested pacing rate and its explanation. Expand **Compare real transfer outcomes** to export the CSV or readable report. Reports omit names, digests, file content and private addresses and remain in browser memory until downloaded.

The [experiment guide](ADAPTIVE_EXPERIMENTS.md) defines grouping, units, RTT sample requirements and repeated-trial methodology. The [competition brief](COMPETITION_BRIEF.md) gives a defensible research question and demonstration. Neither the app nor its tests establish an improvement in Wi-Fi performance. Interrupted byte recovery remains a separate protocol project, described in the brief.

## Implementation and test map

| File | Responsibility |
| --- | --- |
| `aiml/model.py` | Strict observations, anomaly baseline, session records and forecaster/advisor composition |
| `aiml/predictor.py` | Past-only features, delayed labels, bounded forest fitting, chronological validation and advisory rules |
| `aiml/api.py` | Existing peer authorization, request caps, per-peer serialization and off-event-loop operations |
| `lanflux/static/aiml.js` | Actual browser sampling, authenticated requests, fresh/unavailable presentation and CSV/reset controls |
| `tests/test_predictor.py` | Synthetic correctness fixtures for leakage, alignment, timing gaps, eligibility, fitting, evaluation, advisor and failure fallback |
| `tests/test_aiml.py`, `tests/test_aiml.mjs` | API authorization, strict metadata, sampler calculations and forecast freshness |
| `lanflux/static/adaptive.js`, `tests/test_adaptive.mjs` | Bounded policy decisions, stale evidence, safe fallback, cancellation and message-limit regressions |
| `lanflux/static/comparison.js`, `tests/test_comparison.mjs` | Local strategy outcomes, privacy-safe export, distinct-ping percentiles, grouping and retention |
| `tests/browser.test.mjs` | Actual browser observations, approved verified transfers, model training and displayed predictions |

Run `python -m pytest -q tests/test_predictor.py tests/test_aiml.py`, `npm run test:unit` and `npm run test:e2e`. Full executed results and limits are recorded in [verification](VERIFICATION.md). Synthetic unit-test fixtures never seed a live session.
