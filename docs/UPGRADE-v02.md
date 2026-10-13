# LANFLUX v0.2 changes

This upgrades the existing working FastAPI/WebRTC application in place. The original transfer flow and queues remain, with stronger signaling authorization, actual incremental SHA-256 verification, measured networking diagnostics and a responsive dashboard. No desktop app, remote control, server file storage or frontend framework was added.

The work was divided into parallel backend/security, transfer/metrics and interface tasks, then integrated and tested with real browser transfers. The baseline source was safeguarded before edits. The original repository had no tracked commit baseline; the upgrade was prepared on `upgrade/lanflux-v0.2` before the user requested publication to the configured LANFLUX remote. No unrelated user files or original upstream source were discarded. Preserved unlicensed upstream source is excluded from publication.

## Modified files

- `.env.example`, `.gitignore`: trusted-host/idle settings and ignored experiment fixtures.
- `README.md`, `docs/REPOSITORY_INSPECTION.md`, `docs/VERIFICATION.md`: accurate v0.2 setup, security, limits, architecture, attribution and test evidence.
- `lanflux/config.py`, `lanflux/main.py`, `lanflux/rooms.py`, `lanflux/signals.py`: origin/Host validation, pair generations, negotiation state, cleanup, bounded signaling and v0.2 metadata.
- `lanflux/static/app.js`, `index.html`, `styles.css`, `transfer.js`: preserve existing flows, introduce verification and diagnostics UI, confirmations, cleanup and robust protocol handling.
- `package.json`, `package-lock.json`: pinned licensed hash development source and complete unit-test/vendoring commands.
- `tests/test_signaling.py`, `tests/test_transfer.mjs`, `tests/browser.test.mjs`: retain and extend regressions for the upgraded protocol and real browser workflow.

## Created files

- `lanflux/__main__.py`, `lanflux/logging.py`: localhost-by-default CLI and sensitive-log filtering.
- `lanflux/static/metrics.js`, `diagnostics.js`, `experiments.js`, `favicon.svg`: actual measurements, bounded chart, local report/CSV exports and application icon.
- `lanflux/static/vendor/noble-hashes/`: unmodified `sha2.js`, `_md.js`, `_u64.js`, `utils.js`, MIT `LICENSE`, provenance `README.md` and checksummed `manifest.json`.
- `tests/test_security_v02.py`, `test_hash.mjs`, `test_metrics.mjs`, `test_experiments.mjs`, `test_diagnostics.mjs`: additional security, integrity, statistics/export and presentation regressions.
- `scripts/generate_test_files.py`, `scripts/vendor-hashes.mjs`, `scripts/check_frontend.py`: bounded local fixtures, reproducible vendoring and dependency-free static checks.
- `docs/NETWORK_EXPERIMENTS.md`: reproducible 1/10/50 MiB, three-run methodology without invented results.
- `docs/VERIFICATION-v01.md`: retained historical verification report.
- `docs/screenshots/landing.png`, `desktop.png`, `mobile.png`, `network.png`: screenshots of the real running application with actual test observations.

Runtime requirements stay minimal and unchanged. Limits remain 64 MiB/file and 128 MiB reserved/retained receive payload. Browser Blob/download overhead can exceed those payload counters. Transfer restart is explicit; no automatic resume is advertised. Public TURN credential management, real phone/browser regression and external-network deployment still need operator/device verification; see [verification evidence](VERIFICATION.md).
