# LANFLUX user guide

LANFLUX shares files between two ordinary browsers using an encrypted WebRTC DataChannel. Python provides the website, temporary rooms, signaling and experimental network analysis. File contents, filenames and file SHA-256 digests do not pass through FastAPI. A direct route connects the browsers; a TURN route forwards their encrypted WebRTC traffic through a configured relay.

This guide describes implemented behavior. See [configuration](CONFIGURATION.md) for every setting, [deployment](DEPLOYMENT.md) for public hosting, and [AI monitor](AI_MONITOR.md) for model details.

## 1. Install and start

Use Python 3.10 or newer. Install dependencies on the computer running the server; the receiving phone needs only a browser. Node.js is required for development tests, not normal use.

```bash
git clone https://github.com/kasim672/LanFlux.git
cd LanFlux
```

### Linux and macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m lanflux
```

If an existing checkout already contains a virtual environment, activate it and install the current requirements rather than cloning another copy. Some Linux distributions require their `python3-venv` package before creating an environment.

### Windows PowerShell

These commands do not require changing the PowerShell activation policy:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m lanflux
```

Open **http://localhost:8000** on the server computer. The default bind address is `127.0.0.1`, so this mode is intentionally reachable only on that computer. **http://localhost:8000/health** is the health endpoint. Stop the server with Ctrl+C; restarting clears temporary rooms and AI sessions.

### Enable trusted local Wi-Fi access

```bash
python -m lanflux --lan --port 8000
```

On Windows:

```powershell
.\.venv\Scripts\python.exe -m lanflux --lan --port 8000
```

`--lan` binds all network interfaces. Use a trusted network and allow Python/TCP port 8000 through the computer's firewall for the appropriate private network. Do not expose this development port publicly. Changing `--port` also changes the port used in invitations. Keep one Python worker: room membership and models live in one process.

### Optional configuration

Copy `.env.example` to `.env`, edit only the needed settings, then restart. The CLI loads `.env` automatically; `--env-file PATH` selects another file. Keep secrets and private keys outside Git.

```bash
python -m lanflux --help
```

For public use, provide HTTPS/WSS hosting and a trusted public invitation origin. A website being reachable does not guarantee WebRTC connectivity; separate TURN infrastructure may be needed. Follow the [HTTPS/WSS and coturn deployment guide](DEPLOYMENT.md).

## 2. Pair the computer and phone

1. Put both devices on the same trusted Wi-Fi. Keep both browsers foregrounded and prevent the phone from sleeping during the test.
2. Start LANFLUX with `--lan`. Open `http://localhost:8000` on the computer.
3. Select **Create a room**. LANFLUX generates an unpredictable temporary room code.
4. Open **QR code** and scan it with the phone camera. Alternatively use **Copy invite link**, or open the displayed LAN URL on the phone and enter the room code.
5. Opening an invitation containing `?room=CODE` automatically attempts to join that room. No second manual code entry is required.
6. Wait for **Connected and ready** before choosing files. Both devices can now send.

The QR image, copied invitation and displayed URL refer to the same room. When the computer opened localhost, LANFLUX attempts to discover a private IPv4 address on a physical network adapter, excluding Docker, VPN and virtual interfaces. It preserves the configured port. A phone's `localhost` means the phone itself, so an invitation containing localhost will not reach the computer.

If adapter discovery is unavailable or selects an unreachable physical network, open LANFLUX through the computer's reachable LAN address before creating a room, or set this in `.env`:

```dotenv
LANFLUX_PUBLIC_URL=http://YOUR_REACHABLE_LAN_IP:8000
```

Replace the placeholder with the actual address; do not copy it literally. Restart and create a **new room**. Existing invitations remain pinned for consistency. On a public deployment this setting should be the actual HTTPS origin, without a path.

Treat room links and QR images as private invitations. A room admits two peers and expires after one hour by default. Invalid, expired or full rooms produce an error; ask the other person to leave or create a fresh room. Do not repeatedly retry an invalid code: admission requests are rate-limited.

## 3. Send, approve and download

1. On either device, select **Choose files**. Desktop users can also drag files into the drop area.
2. LANFLUX reads bounded slices to calculate the original SHA-256 digest. Hashing can take time on a slower phone.
3. The receiving device sees an incoming offer with the file's name and size. Select **Accept** or **Reject**. File payload does not start before approval.
4. Watch transfer progress, status and observed rate. Multiple outgoing files run sequentially; the opposite device has its own independent queue.
5. The receiver checks the exact byte count and computes SHA-256 over the received bytes.
6. **Integrity Verified** appears only after both checks succeed. Use the download control to save the completed file.

A digest match proves that the received bytes match the peer's announced digest. It does not prove the sender's real-world identity, certify a file as safe, or replace your device's normal precautions for opening files.

### Cancel, reject, leave and restart

- **Reject** declines an incoming offer without accepting its payload.
- **Cancel** stops the selected transfer from either side. Cancelled data cannot become a verified completed download.
- Leaving, reloading, losing the connection or closing a tab interrupts unfinished work and releases its transfer state.
- Reconnect and select the file again to restart. Automatic resume is not implemented.
- Download received files before **Clear finished files**, closing the tab or reloading. Clearing finished files releases retained receive buffers and download URLs; it is not a backup mechanism.

Confirmation dialogs protect actions that would discard active work or retained files. Read the dialog and save any completed downloads first.

### Practical memory and queue limits

| Limit | Default maximum |
| --- | --- |
| Individual file | 64 MiB |
| Reserved and retained received payload | 128 MiB |
| Active/queued transfers | 20 |
| Retained transfer records | 100 |
| Peers per room | 2 |

One MiB is 1,048,576 bytes. Receive reservations include approved incoming work and completed data not yet cleared. Browser buffers and Blobs require additional memory beyond these payload figures. Lower `LANFLUX_MAX_FILE_MIB` and `LANFLUX_MAX_MEMORY_MIB` for constrained devices. This implementation does not stream large downloads directly to disk. Three retained 50 MiB files exceed the 128 MiB limit: save and clear between runs.

## 4. Read Network Diagnostics

Open **Network diagnostics** after pairing. Measurements come from the actual browser connection and transfer counters. **Unavailable** means the browser has not provided a reliable observation; it does not mean a measured zero.

| Value | Interpretation |
| --- | --- |
| Signaling status | WebSocket link to Python for pairing and negotiation. It is separate from the file DataChannel. |
| ICE state | WebRTC connectivity establishment or failure state. |
| DataChannel state | Whether the reliable browser-to-browser channel is open. |
| Direct P2P / TURN Relay | Classification from the selected ICE candidate pair, when reliable statistics exist. Configuring TURN alone does not prove relay use. |
| Connecting / Failed | Connection progress/failure. Unsupported routing statistics can remain Unavailable even when connected. |
| Current / average speed | File payload rate, excluding WebRTC/network overhead. Current rates use observed sampling intervals. |
| Total bytes / duration / ETA | Observed transfer accounting; remaining-time estimates depend on recent measured rates and may change. |
| Peer RTT | Explicit DataChannel ping/pong elapsed time, including browser scheduling and channel queueing; not ICMP latency. |
| Speed chart | A bounded history of recent measured rates, not a link-capacity prediction. |

File sizes use binary MiB. Rates use decimal **MB/s** (1,000,000 bytes/second) or **Mbps** (1,000,000 bits/second); 1 MB/s equals 8 Mbps. AI throughput aggregates actual sent and received payload during its sampling interval. Sender counters count payload handed to the channel; receiver counters count accepted payload. Successful receiver verification provides the final receipt check.

**Inspect connection details** deliberately reveals candidate information that may include private addresses. Hide it before sharing screenshots. Public reports and AI telemetry do not include private ICE addresses. Safe connection-error summaries help investigation but do not identify a firewall's exact policy.

## 5. Use AI Transfer Intelligence

The existing AI Network Monitor runs two session-local scikit-learn models. It receives network metadata only and does not inspect files, change pacing or control approval.

| Component | Learning requirement and output |
| --- | --- |
| IsolationForest | At least 30 real observations, 25 server-measured seconds and three distinct rounded feature combinations. Later samples are classified Normal or Anomaly against the frozen baseline. |
| RandomForestRegressor | At least 60 real, future-labeled active windows, sufficient variation and chronological training/validation coverage. Predicts approximate payload throughput over the next three seconds if activity continues. |
| Advisor | Explicit rules combine anomaly state, forecast direction and validation comparison. This is advisory logic, not a third trained model. |

The model statuses are independent: IsolationForest can be trained while the forecast still says **Learning from network activity**. RTT probes run approximately every five seconds; one-second telemetry rows can share the latest observed RTT. Missing RTT, disconnects and invalid sampling gaps do not become invented values.

### Demonstrate real training

1. Pair devices and keep both tabs foregrounded. Open Network diagnostics.
2. Send representative files in either direction and approve the offers. Continue genuine transfer activity for roughly **70-90 seconds or longer**, with real observed variation.
3. Keep each file below 64 MiB and clear saved receives before reaching 128 MiB retention. Fast transfers separated by idle time may never provide complete active windows; do not claim training in that case.
4. Once trained, observe measured Mbps, predicted next-three-second Mbps, network trend, anomaly status and advisory text during continued transfer activity.
5. Compare the model's displayed **validation MAE** with the **last-speed baseline MAE**. Lower MAE is better on this particular holdout; the model may be worse than the baseline. Neither value is an accuracy percentage or a promised speed improvement.
6. Select **Export real samples CSV** before leaving or resetting. Record the actual devices, network conditions and outcomes separately.

Anomaly scores are the negative IsolationForest decision function: positive means Anomaly; zero/negative means Normal. They are not attack probabilities. Changes in workload, CPU scheduling, hashing, congestion or idle behavior can all affect observations. Never claim an anomaly proves a cyberattack or guarantees an impending failure.

The three-second forecast disappears when idle, RTT is missing, requests fail or no fresh result arrives within three seconds. An unavailable or failed AI component must not prevent normal file sharing. **Experimental Smart Transfer Mode is not implemented**; existing transmission behavior stays the baseline.

### Export and evaluate

The AI CSV contains bounded session observations and model results, without file contents, names, digests, room credentials or private ICE addresses. Export while connected, before **Reset learning baseline** or departure; models and observations are not persisted by the server. Reset clears both models for the current peer.

For the existing **IsolationForest-only** chronological evaluation CLI, collect at least 40 rows:

```bash
python -m aiml.evaluate /path/to/lanflux-network.csv --output network-predictions.csv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m aiml.evaluate "$env:USERPROFILE\Downloads\lanflux-network.csv" --output network-predictions.csv
```

The CLI trains on the first 30 observations and evaluates at least ten later rows. It validates the input, does not generate a dataset and refuses to overwrite an output file. RandomForest validation happens in the live monitor and its actual MAEs are exported; the CLI does not independently evaluate that model. See [AI methodology](AI_MONITOR.md) and [reproducible experiments](NETWORK_EXPERIMENTS.md).

## 6. Settings and browser behavior

Settings lets you change your local device label and request **Use TURN relay only** for the next connection. A host-required relay policy cannot be disabled. Select relay-only only when a relay is configured, recreate the connection, and confirm the observed route in diagnostics. A setting is not evidence that TURN worked.

Use a current desktop or mobile browser exposing WebRTC DataChannels and downloads. Chrome, Edge, Firefox and Safari are intended targets; automated browser coverage is Chromium, including narrow viewport layouts. Other engines and physical phones require their own regression checks. Local HTTP can work where WebRTC is exposed; incremental hashing does not depend on Web Crypto secure-context support. HTTPS/WSS remains required for safe internet deployment and recommended on untrusted networks.

Mobile browsers can suspend a background tab or sleeping device. Keep the tab visible and screen awake during sharing. Browser download handling varies; save into the location offered by the browser and verify the result is present before clearing LANFLUX's copy.

## 7. Troubleshooting

| Symptom | Action |
| --- | --- |
| Phone cannot load the page | Use `--lan`, the computer's reachable LAN address and matching port; permit the private-network firewall rule. A guest network may isolate clients. |
| QR still contains localhost or a wrong address | Check the warning, configure the reachable `LANFLUX_PUBLIC_URL`, restart and create a new room. Confirm the phone can open that origin directly. |
| Invitation fails to join | Check the code/link, expiry and two-peer capacity. Create a fresh room if needed. An old tab may still occupy the second membership. |
| Website opens but connection fails | Inspect signaling, ICE and DataChannel states. Try an authorized network; ask the operator to check STUN/TURN, certificates and credentials. Page access alone does not prove peer connectivity. |
| College Wi-Fi blocks sharing | Public HTTPS can remove the need to reach a laptop port; configured TURN/TLS on TCP 443 may provide an allowed relay path. Protocol filtering can still block it. Ask IT for an approved configuration. |
| Transfer waits without progress | Check whether receiver approval or sender hashing is pending. Keep both tabs foregrounded and inspect the actual connection state. |
| File or memory limit reached | Use a smaller file; download and clear retained completed receives. Large-file disk streaming is unavailable. |
| Integrity fails | Do not use the incomplete result. Reconnect and send again; preserve the observed failure reason for diagnosis. |
| AI keeps learning | Wait for actual RTT and sufficient active, varied measurements. Idle time and very short files do not satisfy forecasting requirements. |
| Forecast or peak speed unavailable | The active window, browser observation or complete sampling interval may be missing. Do not substitute a fabricated value. |
| Server rejects configured origins/hosts | Use exact reachable origins and hostnames in documented configuration. Do not disable Origin checks or use wildcards. |

## 8. Final computer-and-phone check

Create and join by QR, repeat by code/link, send and verify a file in each direction, reject one offer, cancel from each side, test several queued files and an empty file, then reload during a transfer and confirm a clean restart. Inspect diagnostics and actual AI collection, export before leaving, and save downloads before clearing. These are manual procedures to perform on your devices; the guide does not claim they were executed on every supported device.
