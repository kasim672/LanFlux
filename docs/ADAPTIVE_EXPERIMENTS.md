# Adaptive transfer experiments

LANFLUX compares its existing sender behavior with observation-based pacing and forecast-assisted pacing. The research question is whether short-horizon throughput prediction helps the throughput–latency trade-off under changing conditions. A faster transfer, a lower latency measurement, or a better forecast is not guaranteed.

## Three strategies

- **Baseline:** ordinary sending with the existing WebRTC message-size limits and DataChannel backpressure.
- **Rules:** conservative application pacing informed by measured conditions.
- **ML-assisted:** conservative pacing informed by usable recent forecasts and observations, with baseline fallback when predictive evidence is unavailable.

The sender chooses the strategy. WebRTC continues to provide its own transport congestion control; application pacing does not replace it. Approval, cancellation, file metadata, receiver verification and encrypted transport remain applicable in every mode.

The requested strategy and observed effective strategy are recorded separately. An ML request that falls back to baseline must not be described as successful ML adaptation. The effective label records an observed intervention, not exclusive pacing throughout the transfer. A transfer with both observed baseline behavior and intervention is marked `mixed`. These are experimental strategies, not claims of a new congestion-control algorithm.

## Reproducible demonstration

1. Start LANFLUX, pair two browsers, and confirm a working baseline transfer. Keep the same browser versions, devices, route and power settings for comparisons.
2. Collect enough real active-transfer observations for the predictor. A short transfer or idle period is not sufficient. Read the model status and validation error against the last-speed baseline; do not present test fixtures as experimental observations.
3. Use files of approximately 1 MiB, 10 MiB and 50 MiB, below the existing 64 MiB limit. Use the same bytes for each repeated size. Remove downloaded/retained received files between runs to respect the 128 MiB receive budget.
4. For each file size, perform at least three trials of each strategy. Alternate order, for example baseline/rules/ML, rules/ML/baseline, ML/baseline/rules. Do not run opposing transfers simultaneously during the primary comparison.
5. Repeat under a separately recorded network condition, such as another permitted Wi-Fi location or controlled competing traffic. Do not interfere with campus infrastructure or bypass network restrictions.
6. Inspect the completed comparison records and export the CSV and readable report. Record the environment and run order in your lab notes; exports intentionally omit identifying filenames and private network details.
7. Present failures and unavailable measurements along with successful trials. Compare identical file size, observed route, requested/effective strategy and traffic condition. Do not pool tiny and large transfers into one throughput average.

The comparison operates on real outgoing attempts in the current page session. It does not generate network traffic or synthetic benchmark results. Refreshing the page clears these records. Export before refreshing. The clear action removes finished records while retaining active trial tracking and duplicate suppression.

## Measurements and interpretation

| Measurement | Meaning |
| --- | --- |
| Payload throughput | Actual sent payload bytes × 8 / transfer duration / 1,000,000, in decimal Mbps |
| Duration | Existing transfer measurement from payload start through terminal completion/failure handling; excludes initial receiver approval wait |
| Peak observed throughput | Highest observed sampling-interval payload rate; unavailable without an interval |
| Median / p95 RTT | Interpolated percentiles of distinct application DataChannel ping/pong measurements during payload activity |
| Integrity | Verified only when actual and expected SHA-256 digests match |
| Requested / effective strategy | Selected experiment arm versus behavior actually observed during sending |
| Pacing delay | Accumulated sender-side pacing wait, when supplied by the transfer engine, in milliseconds |
| Route | Selected ICE pair classified as direct or relay; unknown when evidence is unavailable |
| Traffic condition | Outgoing-only or observed overlap with an incoming payload transfer |

RTT is application-level round-trip time, including browser scheduling and DataChannel queuing; it is not a raw physical-link latency measurement. Ping measurements can be sparse, especially for small files. The median requires at least two distinct pings and p95 requires at least 20; otherwise they are unavailable. Missing RTT is unavailable, never an invented zero. At most the latest 600 distinct RTT observations are retained per active trial; long trials therefore describe that bounded tail. A cached RTT is not counted repeatedly as a fresh ping.

Summary groups retain failed, cancelled, rejected and unverified attempts as outcomes. Mean throughput and duration use verified completions only, so always read those means alongside the failure counts. Group RTT summaries are medians of per-run medians and per-run p95 values, **not** percentiles of all raw pings pooled together.

At most 100 terminal records and 20 pending outgoing attempts are retained. The report exports numeric/categorical measurements only: no file contents, names, SHA-256 digests, private ICE addresses, peer identifiers or room credentials. Data stays in the browser unless the user downloads the report. The existing authenticated ML telemetry remains a separate metadata-only service.

## What a convincing result looks like

Report the number of trials, variability, invalid or unavailable trials, file size and network conditions. Explain any trade-off: lower latency may cost throughput. A negative result is valid: if ML pacing does not outperform rules or baseline, say so and identify where the prediction was unreliable.

Sequential runs share changing conditions, so these observations do not establish causation by themselves. Alternate or randomize order, repeat enough runs and keep measurement conditions comparable. Pacing changes the throughput being observed; a paced sending rate is not an estimate of available link capacity. Training and evaluation must account for which strategy produced the observations.

The automated fixtures exercise calculations and failure handling. They are synthetic test inputs and must never be presented as real performance evaluation. No benchmark improvement, funding outcome or universal novelty is claimed.
