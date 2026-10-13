# AI Network Monitor

LANFLUX's experimental unsupervised detector reuses existing WebRTC diagnostics. It does not inspect files, modify transfer messages, throttle transfers or claim to detect attacks reliably.

## Observations

Connected browsers sample approximately once per second:

| Field | Source | Used by model |
| --- | --- | --- |
| RTT, milliseconds | Explicit DataChannel ping/pong elapsed time | Yes, `log1p` |
| Payload throughput, decimal Mbps | Actual sent-plus-received file-byte counter delta / elapsed sample time | Yes, `log1p` |
| Active transfer | Transfer-engine `transferring` state or observed payload in the interval, including short completed transfers and stalled active intervals | Yes, boolean |
| Cumulative bytes, interval and observed route | Transfer counters, clock and selected ICE candidate statistics | Export context only |

RTT probes run approximately every five seconds, so adjacent one-second rows may share the latest observation. Browser scheduling and channel queueing affect RTT; this is not ICMP latency. Sender counts indicate bytes handed to the channel, receiver counts indicate accepted payload. A measured idle interval can legitimately have zero throughput. Missing RTT, disconnected sessions, counter resets and sampling gaps over ten seconds are skipped, never replaced with fabricated values.

## Training and prediction

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
python -m aiml.evaluate /path/to/lanflux-network.csv --output network-predictions.csv
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
