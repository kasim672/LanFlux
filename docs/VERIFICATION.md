# LANFLUX 0.2 verification

Performed in this workspace on **2026-10-13**, on branch `upgrade/lanflux-v0.2`. This report records pre-publication checks of the in-place upgrade. No public application deployment or physical-device v0.2 test was performed.

## Safeguard and baseline

Before edits, README, configuration, Python room/signaling handlers, native frontend, protocol tests, dependencies, licensing/attribution and Git state were inspected. The existing Git branch was unborn `main`, with all LANFLUX files untracked and no commits. A source snapshot was saved at `/tmp/lanflux-v01-before-upgrade-20261013.tar.gz`, then a dedicated unborn upgrade branch was created without staging, resetting or discarding files. Original unlicensed source and unrelated workspace files were preserved.

Baseline verification used normal runners: **25 Python tests**, **10 JavaScript protocol tests**, and **8 Chromium browser scenarios plus their parent test (9 reported tests)** passed. The user separately reported actual computer↔phone success for v0.1; that is user-reported evidence and is not a new physical-device test of v0.2. The previous verification report is preserved as [VERIFICATION-v01.md](VERIFICATION-v01.md).

## Current passing checks

| Command | Actual result |
| --- | --- |
| `.venv/bin/python -m pytest -q` | **72 passed**, one upstream Starlette TestClient/httpx deprecation warning |
| `npm run test:unit` | **36 passed**, zero failures/skips |
| `npm run test:e2e` | **12 Chromium scenarios + parent = 13 passed**, zero failures/skips |
| `.venv/bin/python scripts/check_frontend.py` | 108 unique IDs, navigation/assets/control references, CSP audit and 16 JavaScript syntax checks passed |
| `.venv/bin/python -m compileall -q lanflux scripts tests` | Passed |
| `.venv/bin/python -m pip check` | No broken requirements found |
| `.venv/bin/python -m lanflux --help` | CLI help/options passed |
| `npm run vendor:hashes` | Pinned MIT-licensed sources regenerated; checksum tests passed |

All root-side Python checks ran through **standard pytest**, without the temporary selector workaround mentioned in the historical v0.1 report. The environment has Python 3.12.2 and Node 24.21.0; this does not establish execution on every supported Python/Node version. Chromium uses the installed Playwright browser, not a physical mobile browser.

The JavaScript unit suite includes **21 transfer protocol**, **5 metrics**, **3 hash**, **5 export/report**, and **2 diagnostics formatting** tests. Incremental SHA-256 is checked against independent Node cryptography for standard vectors, a million `a` bytes, padding boundaries, multiple slice sizes and a 1 MiB fixture. Vendored source checksums and its MIT license are verified.

Python checks preserve the original cases and add wrong/malformed/duplicate origins, default ports and IPv6, exact trusted-host rules/DNS-rebinding defenses, duplicate JSON fields, peer roles, stale pair IDs, repeated/invalid offer/answer transitions, early ICE, replacement-pair reset, idle-peer removal, failed send cleanup, room/peer/rate bounds, expiration and safe logging. No legacy file-upload/download route is exposed.

Protocol checks cover consent before payload, queues in both directions, exact receive bytes/Blob, safe filenames, file/payload/history limits, tiny-buffer flood overhead, actual backpressure pause/drain/cancellation, empty files, unavailable hashing, modified/missing data, invalid metadata, mismatched checksum acknowledgement, immutable terminal states, hashing/verification cancellation, peer/channel cleanup, negotiated message-size handling, real RTT calculations, unavailable statistics, malformed control types and bounded UI-event history. Invalid offers cannot bypass the 100-record cap, and cleared cancelled transfer IDs are rejected within the bounded discard history.

## Real browser scenarios

The browser suite starts the real `python -m lanflux --port 8765` CLI on localhost, connects separate Chromium contexts through actual WebSocket signaling and WebRTC DataChannels, and closes its server/browser fixture afterward. External STUN is disabled for deterministic loopback tests. The reserved `lanflux.test` hostname is explicitly trusted and mapped locally to exercise non-localhost insecure HTTP without claiming a physical LAN test.

The 12 scenarios exercise:

1. Room creation, invitation joining, real QR SVG and selected direct ICE route.
2. Consent gates payload; sequential 1 MiB binary and empty-file downloads; exact bytes and independently calculated SHA-256; visible Integrity Verified only after success.
3. Reverse-direction transfer, malicious filename sanitization and exact downloaded bytes.
4. Rejection and cancellation while approval is pending.
5. Receiver cancellation after actual binary chunks, bounded send buffer, then a successful next file.
6. Observed signaling/channel/RTT/payload diagnostics, explicit ICE inspect/hide, actual report/CSV downloads without room capabilities, real navigation/settings/QR dialogs, and widths 320/390/768 pixels without horizontal overflow.
7. Confirmed memory clearing and replacement-peer pairing.
8. Simultaneous opposite-direction reliable queues and verified completion.
9. A deliberately changed actual DataChannel payload byte causes sender/receiver integrity failure with no download; a subsequent clean file succeeds.
10. Sender cancellation during actual prehash and after actual streamed payload; no verified completion or receive download.
11. Actual DataChannel closure interrupts an unfinished file; browser reload cleans peer state, rejoining succeeds and the next file verifies.
12. Non-localhost HTTP pairing and actual download with `isSecureContext === false`, `crypto.subtle` and `crypto.randomUUID` unavailable; incremental SHA-256 still verifies.

No browser JavaScript errors were observed. Captured WebSocket messages contain only offer/answer/ICE/ping, never file offers/contents. CLI logs were checked for room-capability leakage. Downloaded file buffers were compared to their originals. Snapshot files in [screenshots/](screenshots/) show the actual running v0.2 application and measured loopback diagnostics, with optional private ICE inspection hidden. Screenshot timings/rates are correctness-test observations, **not Wi-Fi benchmark claims**.

The interface agent also independently tested actual Settings dialogs at 320/390/768/1440 pixels, joining, SHA-256 receipt, selected ICE inspection, CSV download and confirmed clearing through a live Uvicorn/Chromium fixture. These exploratory checks are additional evidence, not additional counted test cases.

## Fixture and preservation checks

The fixture generator was run with its default 1/10/50 MiB sizes into `/tmp/lanflux-v02-fixtures-20261013`. Exact sizes and the SHA-256 manifest were independently rechecked; repeat invocation refused to overwrite the fixtures. This is fixture generation, not network-performance evidence. The manual [experiment methodology](NETWORK_EXPERIMENTS.md) specifies three actual runs per size, saving/exporting and clearing between runs to avoid the 128 MiB receive cap.

Original `app.py`, `templates/index.html` and archived README/requirements checksums remain consistent with [REPOSITORY_INSPECTION.md](REPOSITORY_INSPECTION.md). No license was inferred for the original project. Licensed hash sources retain their own copyright/license/provenance; no general repository license was assigned.

## Remaining verification and limitations

- **Repeat the computer↔phone regression on v0.2.** The prior physical success was v0.1. QR camera scanning, Android/iOS downloads, phone memory behavior, backgrounding and sleep were not re-tested physically.
- Safari, Firefox, Edge and other runtime/OS versions were not tested; Chromium mobile widths do not emulate their browser engines.
- A real two-device Wi-Fi path, guest isolation, varying Wi-Fi conditions, restrictive NATs, real STUN discovery, actual TURN relay and public HTTPS/WSS/proxy deployment remain unverified.
- No benchmark results for the requested three runs of each size are fabricated. The UI exports actual observations; the experiment fixtures/method are ready for real devices.
- Payload caps remain 64 MiB/file and 128 MiB retained/reserved receive bytes. Browser Blob/buffer/download overhead can exceed those payload counts. There is no disk streaming or automatic resume, and no maximum-size reliability promise for low-memory phones.
- SHA-256 matches prove byte integrity relative to encrypted-channel peer metadata, not the sender's real-world identity. Trusted-LAN HTTP signaling is not protected from interception. Use HTTPS/WSS on untrusted/public networks.
- Rooms/signaling/rate limits are single-process; one worker is required. Public TURN credential issuance/rotation, edge abuse controls and deployment remain operator responsibilities.

## Reproduce

```bash
python -m pip install -r requirements-dev.txt
npm ci
npx playwright install chromium
python -m pytest -q
npm run test:unit
npm run test:e2e
python scripts/check_frontend.py
python -m compileall -q lanflux scripts tests
python -m pip check
```

Set `LANFLUX_PYTHON` if the browser fixture's Python executable is elsewhere, `LANFLUX_CHROMIUM_PATH` to choose a Chromium binary, or `LANFLUX_TEST_URL` for an already-running instance. The local-hostname scenario runs only against the built-in local fixture. Runtime startup needs Python dependencies only, not npm.
