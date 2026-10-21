# Reproducible LANFLUX networking experiments

This procedure collects observations from actual browser transfers. No benchmark results are bundled or generated without transfers. The automated Chromium loopback regressions are correctness checks, not Wi-Fi performance claims.

## Prepare

1. Generate fixtures from the repository root: `python scripts/generate_test_files.py`. It creates `lanflux-1MiB.bin`, `lanflux-10MiB.bin`, `lanflux-50MiB.bin` and `sha256.json` in ignored `experiment-files/`. Python hashes bounded chunks independently; files are 1,048,576, 10,485,760 and 52,428,800 bytes. Existing files are preserved; use `--output ANOTHER_FOLDER` for fresh fixtures.
2. Start `python -m lanflux --lan --port 8000` on a trusted LAN. Open the computer's LAN URL on both devices. Configure HTTPS/WSS and suitable TURN if comparing internet networks.
3. Note the actual devices, browsers/versions, Wi-Fi band, distance, router, other traffic, VPN status, power mode and network condition. Do not infer link capacity from observed application throughput.
4. Pair the browsers. Check Network diagnostics for actual route and state. Record your conditions and run/direction information separately, or supply them to the developer export helpers below. These descriptions are self-reported.

## Save observations with developer tools

Record values from Network diagnostics and Transfer details manually, or use the tested local export helpers through the browser developer console:

```javascript
const {experimentsToCsv, buildExperimentReport, downloadText} = await import('/static/experiments.js');
const conditions = {environmentLabel: 'Same Wi-Fi, laptop to phone', notes: '1 MiB, run 1'};
downloadText(experimentsToCsv(window.lanfluxClient.transfers, conditions), 'lanflux-run.csv', 'text/csv');
// Alternatively download a human-readable report:
// downloadText(buildExperimentReport(window.lanfluxClient.transfers, conditions), 'lanflux-run.txt');
```

Replace the example descriptions with your actual conditions. These calls export existing terminal records, not fabricated measurements. Export before clearing finished records. Mobile browsers may require connected developer tools; manual recording remains an option.

## Run a condition

| Fixture | Repetitions | Maximum retained payload if uncleared |
| --- | --- | --- |
| 1 MiB | 3 | 3 MiB |
| 10 MiB | 3 | 30 MiB |
| 50 MiB | 3 | 150 MiB — exceeds the 128 MiB receive limit |

For each size, send the **same fixture three times** sequentially. Approve each file, keep both tabs foregrounded, wait for verified completion, then download and inspect its result. Export the report/CSV after **every run**, then clear finished files on both devices after saving/exporting. This prevents three 50 MiB receives from exceeding the payload limit and keeps comparisons independent of retained memory pressure. Combine exported CSV rows locally without duplicating their header rows.

Use the receiver's records as the primary transfer-completion observations, since those count actual received payload. Optionally export sender observations too, clearly labeled; do not treat both directions' records for the same file as independent experimental runs. Sender duration includes acknowledgement latency. Keep failure/cancellation records with their reasons instead of quietly excluding them.

To measure setup repeatability, leave and recreate a room for **each run** and record the observed setup time. Reusing a connection is valid for steady-state throughput testing, but its setup figure is the original pairing observation, not a new setup measurement.

Repeat the procedure in the reverse direction. For comparison conditions, vary one thing at a time where practical: same Wi-Fi at different distances, a controlled busy network, or different supported networks. Record changes explicitly. Avoid comparing a foreground desktop run with a sleeping phone run as if only the Wi-Fi changed.

## Optional TURN comparison

Configure a real relay using `.env.example`, manage relay credentials properly, and create a **new room** after selecting “Relay only” in Settings. Confirm Network diagnostics reports **TURN relay** from the selected candidate pair. If no relay route is observed, label the route unavailable or record the failure; do not assume a relay based on settings alone. TURN adds another network/service path and may be limited by that service, geography or quotas.

Remote connectivity can fail without a suitable relay. Automated loopback verification does not establish TURN or external-network performance.

## Interpret the exports

Each terminal record includes file size, transferred payload bytes, setup milliseconds, transfer seconds, average/peak Mbps, result/reason, SHA-256 verification/digests and observed route. Reports omit room codes, TURN credentials and private ICE addresses. Names and user notes are local report data; share only what you intend.

- **Average throughput (Mbps)** = observed payload bytes × 8 ÷ active transfer seconds ÷ 1,000,000. For verified completed files, payload bytes equal file size. Failed runs may contain partial bytes.
- **Transfer time** starts at acceptance/start and ends at verified receiver completion or sender acknowledgement. It excludes the sender's prehash and human approval delay. Measure a separate wall-clock user workflow if you need end-to-end usability latency.
- **Setup time** starts when two peers are paired and ends at DataChannel open. It excludes waiting for the second person to join.
- **Peak observed** is the highest complete approximately one-second sampling interval. It is not instantaneous peak link bandwidth. Short runs may finish without a sample and report **Unavailable**; do not substitute zero or the average.
- **RTT** on the dashboard is explicit DataChannel ping/pong elapsed time, including queueing/scheduling. It is not ICMP or physical propagation delay.
- **Integrity Verified** means exact length and matching sender/received SHA-256 over actual bytes. Compare the sender digest against the generator's `sha256.json` when available. A match does not authenticate a real-world person or prove a file is safe.
- Sizes use binary MiB; network rates use decimal Mbps and MB/s. Browser send counters indicate bytes handed to the channel, while receive counters indicate bytes accepted; transport overhead is excluded.

For each size/condition/direction, report all three observed outcomes, the successful runs' median/range of throughput and duration, and how many failed. Three repetitions are a small student experiment, not a statistically strong general benchmark. Include unavailable metrics and explain timing differences rather than inventing precision or results. Save screenshots with optional private ICE inspection hidden.

## Manual computer-and-phone regression

- Open the LAN URL on both devices; create and join by room code, then repeat by QR/invitation.
- Send a small file computer → phone and phone → computer. Before approval no file bytes should transfer. Download and check **Integrity Verified**.
- Queue multiple files, include an empty file, reject one, and cancel from each side. A later file should still work.
- Leave/reload during a transfer. Unfinished items should fail cleanly; rejoin and select again. No resume is promised.
- Check diagnostics, export real report/CSV records, and hide private ICE details before screenshots.
- Save files before confirming “Clear finished files”; verify memory is released. Test the 50 MiB fixture only if the phone has sufficient available memory.

## AI experiment: anomaly detection and throughput forecasting

Run AI experiments separately from short-file transfer benchmarks. A 1 MiB transfer can finish before a useful network sample; counting idle time around it as successful predictive evidence would be misleading. The AI sampler observes aggregate sent-plus-received payload throughput, so simultaneous bidirectional traffic changes the quantity being predicted. Use one transfer direction at a time for a simpler first experiment, then label bidirectional conditions explicitly.

### Collection procedure

1. Pair devices, open Network diagnostics and select **Reset learning baseline** before starting a new experimental session. Reset deletes the current peer's observations and both models; export an earlier session first if it matters.
2. Record the device/browser versions, actual route, network condition and intended workload. Keep the tabs foregrounded. Do not expose optional private ICE details in screenshots.
3. Transfer actual representative files for approximately **70-90 seconds or longer** of active observations. Keep each file at or below 64 MiB and save/clear received files before the 128 MiB retained-payload cap. The time suggestion is not a guarantee of training.
4. Observe the two separate statuses. IsolationForest needs at least 30 observations, 25 server-measured seconds and three distinct rounded feature combinations. RandomForest needs 60 eligible labeled windows, meaningful speed variation and sufficient chronological training/validation examples after overlap purging.
5. Continue activity after training. Record measured and forecast Mbps, actual validation MAE, last-observed-speed baseline MAE, anomaly state and score. Export **real samples CSV** while still connected, before reset or departure.
6. Repeat under another authorized, clearly described condition. Change one factor at a time where practical. Keep both successful and failed runs and report unavailable values.

Fast transfers, pauses between files, missing RTT or irregular browser scheduling may leave the forecast in **Learning from network activity**. This is a valid result: report why the eligibility requirements were not met. Do not inject fake observations or use automated unit-test fixtures as training data for a demonstration. A controlled automated browser test verifies the pipeline, but its loopback workload is not a physical Wi-Fi performance measurement.

### What the predictive evaluation measures

The regression target is the approximate duration-weighted payload throughput over the **three seconds after** each input anchor, conditional on continued transfer activity. Its features use only five already-observed samples: recent throughput, rolling mean/variation, trend, RTT/variation, activity and reliable route indicators. The target is built only when actual subsequent intervals arrive. The last interval is clipped proportionally at the horizon, so the label is an interval-rate approximation rather than exact sub-second ground truth.

Disconnected or invalid gaps break pending windows. Every input and future interval must be active; idle runs cannot create artificially low forecast errors. Valid forecasting samples have client intervals and server receipt gaps between 750 and 2000 ms, with a bounded timing discrepancy. Zero throughput during a genuinely active stall remains a real future observation.

The first 70% of eligible windows are training candidates and the final 30% validate. Earlier training examples whose labels overlap the first validation input interval are purged. The displayed errors are:

```text
model MAE (Mbps) = mean(abs(actual future Mbps - model forecast Mbps))
baseline MAE (Mbps) = mean(abs(actual future Mbps - last observed Mbps))
```

Compare both errors on the same holdout. If the forest's MAE is larger, the baseline performed better in that session; state this plainly. Lower model MAE supports only a result on that particular holdout, not a general accuracy or speed-improvement claim. Overlapping windows are correlated, session sizes are small and route/workload changes can cause distribution shift. Independent longer sessions and explicit test conditions are needed for stronger conclusions.

A useful student table contains **condition, route, eligible labels, training rows, validation rows, model MAE, baseline MAE, and collection limitations**. Fill it only from actual observations. No benchmark numbers or pre-filled result table are supplied.

### IsolationForest evaluation CLI

The existing CLI evaluates the anomaly detector, not the RandomForest regressor:

```bash
python -m aiml.evaluate /path/to/lanflux-network.csv --output network-predictions.csv
```

It uses the first 30 chronological observations as a baseline and requires at least ten later holdout observations. `--train-samples 60` instead needs at least 70 total rows. It validates bounded real-data CSV input, prints observed counts and score summaries, writes later predictions and refuses to overwrite an existing output. See [AI monitor](AI_MONITOR.md) for input restrictions and Windows syntax.

Without independent ground-truth anomaly labels, accuracy, precision and recall are unavailable. Anomaly counts and scores describe the model's output; they do not prove a cyberattack, congestion cause or predicted network failure. Do not deliberately disrupt a college network to obtain an anomaly.

## Keep the two export formats separate

| Export | How to obtain it | Includes | Appropriate use |
| --- | --- | --- | --- |
| Terminal-transfer report / CSV | Local developer helpers above | File names, sizes, digests, observed transfer timing/rates, route, result and user notes | File-transfer experiment outcomes and independent digest comparison |
| AI observations CSV | **Export real samples CSV** in AI Network Monitor | Network metadata, server receipt times, anomaly outputs, forecast outputs and validation errors | Session-local AI analysis and the anomaly evaluation CLI |

The transfer helper runs locally in the browser and does not upload its file-related fields. AI endpoints receive network metadata only and never receive filenames, digests or file content. Both formats omit room credentials and private ICE addresses. Review locally entered notes and file names before sharing transfer reports. The two CSV schemas are different: do not feed terminal-transfer CSV into `aiml.evaluate`.

There is no separate experiment-export form in the application dashboard. The removed form is not required for real measurements; use the documented developer helpers or manual records for transfer reports, and the working AI CSV button for telemetry.

## Reproducibility checklist for a college report

- State the tested commit, operating systems, browser versions and whether tests used physical devices or loopback browsers.
- Separate connection setup, file hashing, human approval and payload-transfer durations.
- Report binary file sizes and decimal rate units consistently.
- Include three actual runs per file size, condition and direction; explain exclusions and record failures.
- Confirm route from observed selected-pair statistics; keep unknown values unavailable.
- Record phone power/sleep state, network conditions and any relay quotas that could affect results.
- Distinguish SHA-256 byte integrity from sender identity and file safety.
- For forecasting, retain the actual chronological holdout and baseline comparison; do not label MAE as classification accuracy.
- Clearly distinguish synthetic automated-test fixtures from measured session observations.
- Keep raw exports private unless reviewed; publish only authorized, non-sensitive evidence.
