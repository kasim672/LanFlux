# LANFLUX: explainable adaptive transfer intelligence

## The contribution

LANFLUX combines browser-to-browser file sharing with a testable networking question:

> Does a short-horizon throughput forecast improve the throughput–latency trade-off compared with ordinary sending and simple application-level pacing rules?

Browser P2P sharing, anomaly detection, and ML-based networking already exist. This project does not claim to invent these fields or be the first implementation worldwide. Its proposed contribution is a working integration of explicit receiver consent, byte-integrity verification, real network observations, bounded adaptive sending, explainable advice, and a reproducible three-strategy comparison.

The software and experimental methodology support a competition demonstration. They do not guarantee a prize, funding, faster transfers, lower latency, or commercial readiness. A measured lack of improvement is a legitimate result.

## What to demonstrate

1. Open LANFLUX on a computer and another browser/device. Pair through the room invitation.
2. Send a file, approve it on the receiving device, and show the verified downloadable result.
3. Show measured throughput and peer RTT. Explain that RTT includes browser scheduling and is not an independently calibrated link measurement.
4. Collect varied active sending observations in the ordinary baseline strategy until the throughput predictor meets its requirements. Fast individual transfers may be too short. Receiving-only observations cannot establish the remote sender's pacing policy, so they are excluded from training.
5. Show the forecast together with its chronological validation MAE and the last-observed-speed baseline MAE. If it is still learning or is worse than the baseline, say so.
6. Compare baseline, rule-based, and ML-assisted sending using the same file sizes and repeated trials. Explain the actual pacing decision and its fallback.
7. Export the observed results. Present transfer time, throughput, latency, failures, and integrity together rather than selecting only favorable numbers.

The unchanged baseline remains the reference behavior. Application pacing cooperates with WebRTC's existing congestion control; it does not replace the transport implementation or bypass network restrictions.

## Algorithms and evidence

**IsolationForest** models unusual observations relative to an unpaced baseline. An anomaly means a deviation from those observations, not a cyberattack or a proven firewall problem. Paced measurements can differ precisely because the application changed its behavior.

**RandomForestRegressor** estimates approximately the next three seconds of achieved payload throughput conditional on continued transfer activity. Its five-observation inputs use only the past: last speed, rolling mean and standard deviation, trend, RTT and RTT variation, activity, and reliable route categories. Labels come from subsequent measured intervals. Missing intervals and policy changes break pending windows. The chronological holdout removes overlapping training-label/validation-input intervals, and MAE is compared with a last-speed baseline.

**Advisor and pacing policy** are explicit engineering rules using measurements and model output. They are not additional trained models. Validation is evidence about a recent local workload, not a probability that the next prediction will be correct. Predictions on paced windows are intervention-conditioned and must not be described as estimates of physical network capacity.

## Avoiding a misleading feedback loop

Pacing lowers the observed achieved rate. Training on that rate as though it were unconstrained capacity would create a feedback loop in which the model learns the controller's previous limit.

Telemetry therefore records `strategy`: `baseline`, `rules`, `ml`, or `unknown`. Only eligible baseline observations train either model. RF anchors and rolling windows reset across policy transitions; future paced intervals cannot complete a baseline training label. A known model may inspect paced observations for inference, but these do not become training examples. Unknown remote pacing policy is also excluded. The CSV keeps this distinction for external review.

Legacy CSV files without the new field are read as baseline for compatibility; this is a provenance assumption, not independent proof. Do not label an older paced dataset as an unpaced baseline. The evaluator rejects explicit paced or unknown-policy observations in its training segment.

## A defensible comparison

Use approximately 1 MiB, 10 MiB, and 50 MiB files, within the application's existing limits. Repeat each strategy at least three times per size. Rotate strategy order between repetitions. Keep devices, file content, browser versions, and location constant within a comparison; record changes. Allow downloads to be cleared between trials to stay within retained-memory limits.

Collect the baseline training session separately before comparing strategies. Keep the model and its validation evidence consistent when comparing a batch. Record when a model was unavailable or the controller fell back; such a trial is not evidence of a successful ML intervention. Observe both endpoints when explaining asymmetric or bidirectional activity.

Compare completion time and achieved Mbps alongside RTT and failure rate. Where RTT samples exist, report median and p95 with the number of observations. A peak sample is a sampling-window observation, not physical link capacity. Integrity verification proves the received bytes match the sender's announced digest, not the sender's real-world identity.

Do not pool different routes, file sizes, or network conditions into a single improvement claim. Report individual trials and variability. Three repetitions are a demonstration, not enough evidence for a broad production-performance claim. Missing metrics should remain unavailable. Synthetic unit fixtures establish code correctness only; they are not performance results.

## Interrupted-transfer recovery: deliberately deferred

The current safe behavior after a terminal connection interruption is cleanup and an explicit restart. No resumable-byte-transfer claim is made. Temporary ICE interruptions may recover through the browser while the existing DataChannel survives, but this is different from resuming a destroyed channel or reloaded page.

Verified recovery needs a separately reviewed protocol extension. The current protocol has no offsets, verified segment manifests, or durable continuity credentials; disconnected peers are deliberately assigned new pairing identities. Simply retaining buffers and trusting a room code would weaken authorization and permit stale or replacement-peer data to be confused with the original transfer.

A follow-up implementation must establish:

- An opt-in recovery capability negotiated by both peers, with strict version handling.
- A cryptographic continuity token bound to the original approved transfer and both peers, never exposed to a replacement room occupant.
- Segment boundaries, offsets, hashes, and duplicate/replay rejection, followed by final whole-file SHA-256 verification.
- Explicit reauthorization before releasing or accepting retained data after reconnecting.
- A short expiration, bounded retained-memory accounting, cleanup on cancellation/leave, and defined handling of zero-byte files and incomplete segments.
- Tests for malicious offsets, forged continuity credentials, replacement peers, stale completion messages, cancellation, and memory exhaustion.

The first scope should retain state only while both original tabs remain open. Surviving a reload or closed tab additionally requires explicit storage design and browser compatibility testing. It is not part of this release.

## Funding-oriented next milestone

A useful funding proposal is to support independent evaluation across physical devices, more browsers, realistic Wi-Fi conditions, and controlled relay routes; a separately audited recovery extension; and accessibility and resource profiling on lower-memory phones. Define acceptance criteria before collecting results. Present evidence from the implemented system, known limitations, reproducibility instructions, and the cost of the next validation step rather than promising an unsupported performance gain.

See [AI monitor](AI_MONITOR.md), [network experiments](NETWORK_EXPERIMENTS.md), [security model](SECURITY.md), and [verification record](VERIFICATION.md) for implementation details and existing limitations.


## Five-minute professor demonstration

- **0:00-0:45:** State the problem and research question. Explain that browser P2P transfer already exists; the contribution is the implemented, explainable comparison of measured and predictive sending decisions.
- **0:45-1:45:** Pair the computer and phone through QR, send a small file, approve it and show the verified download. Show the actual direct/relay classification.
- **1:45-2:45:** Use a session already trained on real baseline activity. Show the last five-observation input idea, three-second future target, model MAE and simple baseline MAE. If learning is incomplete or the model is worse, show that honestly.
- **2:45-3:45:** Select a strategy before queuing a new file. Show its requested and effective behavior, explanation and observed pacing wait. Explain fallback when the evidence is insufficient.
- **3:45-4:30:** Open the comparison export from repeated physical-device trials. Show file-size/route grouping, verified completions, failures and RTT sample counts. Do not present the automated loopback fixture as a Wi-Fi performance result.
- **4:30-5:00:** Present the next validation milestone: independent devices, browser coverage, comparable network trials and separately reviewed authenticated recovery. Explain exactly what further funding would validate; no winning result or budget is invented.

Prepare the training session and real repeated trials before the live presentation. Keep the original exports and environment notes available for questions. The fresh app starts in baseline mode and never ships a pretrained demonstration model.

## Related work to acknowledge

- [Official WebRTC file-transfer example](https://github.com/webrtc/samples/blob/gh-pages/src/content/datachannel/filetransfer/index.html): existing browser data-channel file sharing.
- [PairDrop](https://pairdrop.net/): an established browser sharing application.
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html): transport requirements, including congestion control.
- [A Deep Reinforcement Learning Perspective on Internet Congestion Control](https://proceedings.mlr.press/v97/jay19a): prior research on ML-based networking. LANFLUX uses a small supervised random forest and application policy rather than claiming to invent ML congestion control.
