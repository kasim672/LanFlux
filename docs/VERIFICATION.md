# Verification - predictive networking and restricted-network upgrade

Local checks below were executed on 21 October 2026. This record describes the current implementation extending published 0.3.0; it is not a new versioned release or a physical-network performance benchmark.

## Automated results

| Check | Local result |
| --- | --- |
| Python 3.12 / pytest | 195 passed |
| Node 24 unit tests | 51 passed |
| Existing Chromium suite | 16 real scenarios plus their parent test passed |
| Actual local coturn suite | Four integration cases plus parent passed; zero skipped |
| Actual Nginx HTTPS/WSS suite | Three integration cases plus parent passed; zero skipped |
| Frontend references and syntax | 125 unique IDs and 24 JavaScript files checked |
| Release file audit | Indexed/tracked paths and contents checked; secret-guard self-tests passed |
| AI CSV evaluation | Actual browser-exported observations; chronological baseline and holdout, no invented dataset |

CI is configured to run Python 3.10 and 3.12, JavaScript/static checks, Chromium and actual browser CSV evaluation, plus a new isolated coturn/Nginx job. Remote results are tracked separately by commit in GitHub Actions; the table records executed local checks. The published 0.3.0 baseline passed 117 Python tests, 41 JavaScript tests and the existing browser suite. Current runs are available in [GitHub Actions](https://github.com/kasim672/LanFlux/actions/workflows/ci.yml).

## Reproduce

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
npm ci --ignore-scripts
npx playwright install chromium
npm run test:unit
LANFLUX_SCREENSHOT_DIR=output/playwright/screenshots npm run test:e2e
# Install coturn/Nginx locally first, or set the binary variables below:
npm run test:turn
npm run test:proxy
python scripts/check_frontend.py
python scripts/check_release.py --self-test
python scripts/check_release.py
python -m aiml.evaluate output/playwright/ai-observed.csv --output output/ai-holdout.csv
```

The browser fixture uses a temporary Python server on port 8765 and separate real browser contexts. Downloads are compared byte-for-byte. Generated evidence stays in ignored `output/playwright/`. By default selected real screenshots update `docs/screenshots`; set `LANFLUX_SCREENSHOT_DIR=output/playwright/screenshots` to keep committed images untouched, as CI does.

The optional suites use the installed `turnserver`/`nginx`, or explicit `LANFLUX_TURN_BINARY` / `LANFLUX_NGINX_BINARY` paths. They report a skip when dependencies are missing; set `LANFLUX_REQUIRE_NETWORK_SERVICES=1` to require execution, as CI does. Neither runtime package is bundled with LANFLUX. Test processes bind only loopback, use temporary credentials and certificates, and clean up afterward. Chromium pins only the generated test certificate key; system trust and production certificate verification are unchanged. Coturn's loopback-peer exception exists only in this isolated fixture; production templates deny those destinations.

## Actual infrastructure checks

- Native `all` policy keeps a direct path with a working relay configured.
- With direct candidates withheld only by the test harness, actual relayed file bytes complete and verify. This simulates candidate unavailability, not a physical firewall.
- An unavailable UDP TURN endpoint and a reachable TCP alternative produce an observed relay and verified download.
- Actual TURN TLS/TCP carries approved file bytes with HTTPS/WSS signaling. Listeners use ephemeral high ports locally; TCP 443 configuration is covered by URI tests, not an external port-443 connectivity claim.
- The shipped Nginx template passes its config check, rejects anonymous config/room/WebSocket access, and forwards exact AI Bearer routes to real backend authorization.
- Authenticated HTTPS/WSS QR/automatic joining, receiver approval, exact SHA-256/download bytes, actual AI observations, CSV export and reset succeed through Nginx. Tests respect edge rate limits rather than disabling them.

## Regression coverage

- Secure room generation, expiration/cleanup, membership, Origin/Host validation, rate/resource limits and malformed signaling/state transitions.
- LAN-reachable QR invitations, consistent Copy Link/display URL, automatic link joining, invalid/full invitation recovery and platform-specific adapter detection.
- Actual bidirectional file transfer, approval, rejection, sequential queues, empty files, sender/receiver cancellation, channel/peer interruptions and retained-memory limits.
- SHA-256 known-answer vectors, vendored-source checksums, received-byte verification, corrupted/missing data rejection and cancellation during hashing/verification.
- Measured statistics, unit formatting, bounded charts, route classification and privacy-preserving exports.
- AI thresholds, frozen baseline, later predictions, active/stalled-transfer classification, strict metadata, authorization, pacing, bounded retention and chronological CSV evaluation.
- Real WebRTC-derived AI observations, training, prediction, download/export and reset in Chromium.
- RandomForest past-only features and subsequent measured labels, future-data leakage guards, gap/idle exclusion, bounded fitting, purged chronological validation, baseline MAE, advisor logic and safe unavailable/stale fallback.
- A real 8 MiB DataChannel file with test-only bounded sender pacing supplies varied active observations for forecast training in Chromium. The receiver verifies and downloads the original bytes; UI forecasts and validation errors are populated from actual measurements, then cleared when idle. No telemetry injection is used. This controlled loopback workload is not a Wi-Fi speed benchmark.
- Narrow mobile viewport overflow checks and cached-page cleanup/reinitialization. The latter dispatches persisted page lifecycle events to test the application's hook; it is not a claim of native BFCache behavior across engines.

## Current execution details

- `.venv/bin/python -m pytest -q`: 195 passed, one Starlette/httpx dependency deprecation warning; 8.15 seconds.
- `npm run test:unit`: 51 passed, zero failed/skipped.
- `LANFLUX_SCREENSHOT_DIR=output/playwright/documentation npm run test:e2e`: 17 passed (16 child scenarios and parent), zero failed/skipped; approximately 146 seconds.
- `LANFLUX_REQUIRE_NETWORK_SERVICES=1 npm run test:turn`: 5 passed (four cases and parent), zero skipped, using the explicit local coturn binary and its extracted library path; approximately 29 seconds.
- `LANFLUX_REQUIRE_NETWORK_SERVICES=1 npm run test:proxy`: 4 passed (three cases and parent), zero skipped, using the explicit local Nginx binary; approximately 14 seconds.
- `python scripts/check_frontend.py`: 125 unique element IDs, navigation/control/assets/CSP references and 24 JavaScript syntax checks passed.

The first attempt to invoke the extracted coturn binary lacked its shared-library path and correctly failed the required-service gate. Supplying that fixture's local library directory allowed the complete actual relay suite above to pass. No application security setting was disabled. Normally installed packages do not need that fixture-specific path.

The real exported CSV is also evaluated with `aiml.evaluate`; no ground-truth accuracy is inferred from a count of anomalies. Generated CSVs, certificates and browser artifacts remain ignored. Report generation is an optional documentation operation and does not change runtime dependencies. PDF layout is checked by rendering pages as images and inspecting the resulting pages.

## Screenshots and privacy

Homepage, desktop/mobile dashboard, connected peer, successful verified receive, network diagnostics and trained AI panel images were captured from the running application. Browser tests mask room capabilities and invitation addresses. Measurement fields and transfer results are not fabricated. No physical-network address inspection is shown publicly.

## Remaining verification

This upgrade does not claim fresh physical computer↔phone testing, Safari/Firefox coverage, public HTTPS hosting, college/cross-network reachability, publicly trusted TURN certificates or production relay operation, labeled anomaly accuracy, or general Wi-Fi throughput benchmarks. Mobile viewport emulation is not a physical phone. Previous physical-device success should be followed by the [manual computer-and-phone regression](NETWORK_EXPERIMENTS.md#manual-computer-and-phone-regression) before relying on a new deployment.

The installed FastAPI/Starlette test client currently emits one dependency deprecation warning while all Python tests pass; it does not indicate a failed application test.
