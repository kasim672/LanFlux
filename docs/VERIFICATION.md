# Release verification — LANFLUX 0.3.0

## Automated results

| Check | Local result |
| --- | --- |
| Python 3.12 / pytest | 117 passed |
| Node 24 unit tests | 41 passed |
| Playwright Chromium | 15 real scenarios plus their parent test passed |
| Frontend references and syntax | 115 unique IDs and 20 JavaScript files checked |
| Release file audit | Indexed/tracked paths and contents checked; secret-guard self-tests passed |
| AI CSV evaluation | Actual browser-exported observations; chronological baseline and holdout, no invented dataset |

CI additionally runs Python 3.10 and 3.12, JavaScript/static checks, Chromium and evaluation of the actual browser export. Current runs are available in [GitHub Actions](https://github.com/kasim672/LanFlux/actions/workflows/ci.yml).

## Reproduce

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
npm ci --ignore-scripts
npx playwright install chromium
npm run test:unit
npm run test:e2e
python scripts/check_frontend.py
python scripts/check_release.py --self-test
python scripts/check_release.py
python -m aiml.evaluate output/playwright/ai-observed.csv --output ai-holdout.csv
```

The browser fixture uses a temporary Python server on port 8765 and separate real browser contexts. Downloads are compared byte-for-byte. Generated evidence stays in ignored `output/playwright/`. By default selected real screenshots update `docs/screenshots`; set `LANFLUX_SCREENSHOT_DIR=output/playwright/screenshots` to keep committed images untouched, as CI does.

## Regression coverage

- Secure room generation, expiration/cleanup, membership, Origin/Host validation, rate/resource limits and malformed signaling/state transitions.
- LAN-reachable QR invitations, consistent Copy Link/display URL, automatic link joining, invalid/full invitation recovery and platform-specific adapter detection.
- Actual bidirectional file transfer, approval, rejection, sequential queues, empty files, sender/receiver cancellation, channel/peer interruptions and retained-memory limits.
- SHA-256 known-answer vectors, vendored-source checksums, received-byte verification, corrupted/missing data rejection and cancellation during hashing/verification.
- Measured statistics, unit formatting, bounded charts, route classification and privacy-preserving exports.
- AI thresholds, frozen baseline, later predictions, active/stalled-transfer classification, strict metadata, authorization, pacing, bounded retention and chronological CSV evaluation.
- Real WebRTC-derived AI observations, training, prediction, download/export and reset in Chromium.
- Narrow mobile viewport overflow checks and cached-page cleanup/reinitialization. The latter dispatches persisted page lifecycle events to test the application's hook; it is not a claim of native BFCache behavior across engines.

## Screenshots and privacy

Homepage, desktop/mobile dashboard, connected peer, successful verified receive, network diagnostics and trained AI panel images were captured from the running application. Browser tests mask room capabilities and invitation addresses. Measurement fields and transfer results are not fabricated. No physical-network address inspection is shown publicly.

## Remaining verification

This release does not claim fresh physical computer↔phone testing, Safari/Firefox coverage, public HTTPS hosting, cross-network or TURN connectivity, labeled anomaly accuracy, or general Wi-Fi throughput benchmarks. Mobile viewport emulation is not a physical phone. Previous physical-device success should be followed by the [manual computer-and-phone regression](NETWORK_EXPERIMENTS.md#manual-computer-and-phone-regression) before relying on a new deployment.

The installed FastAPI/Starlette test client currently emits one dependency deprecation warning while all Python tests pass; it does not indicate a failed application test.
