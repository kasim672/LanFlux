# Changelog

## Unreleased — predictive networking and restricted-network connectivity

- Add past-only RandomForest throughput prediction, purged chronological validation against a last-speed baseline, and transparent transfer-advisor rules using real session metadata.
- Add stale/idle forecast cleanup and focused predictor/API/browser regressions without changing file-transfer pacing or protocol.
- Expand user, architecture, security, AI, configuration and evaluation documentation; include a reproducible PDF technical report.
- Refresh the real interface screenshot gallery with focused desktop/mobile views, approval, QR privacy redaction, active transfer, measured diagnostics and settings.
- Preserve native ICE direct preference while supporting validated STUN, TURN/UDP, TURN/TCP and TURN/TLS on TCP 443 alternatives.
- Keep TURN passwords out of anonymous configuration; issue short-lived coturn REST credentials only after room admission, refreshing them on every pairing. Preserve controlled static credential mode.
- Report observed Direct P2P / TURN Relay / Connecting / Failed states and safe ICE server error summaries, with conditional troubleshooting guidance.
- Support explicit, exact reverse-proxy trust with private loopback defaults; add authenticated Nginx HTTPS/WSS, systemd and coturn deployment templates.
- Preserve receiver approval, QR autojoining, sequential bidirectional transfers, SHA-256, cancellation and AI telemetry across the new connection modes.
- Add ICE/authentication regression tests and real loopback coturn TCP/TLS transfer checks; extend CI with isolated relay and reverse-proxy validation.

## 0.3.0 — 2026-10-13

- Add an experimental IsolationForest AI Network Monitor trained on real session metadata, with live predictions, bounded CSV export and chronological evaluation.
- Generate consistent LAN-reachable QR/copy/display invitations from physical-adapter discovery, with an explicit base URL override and automatic link joining.
- Preserve encrypted browser-to-browser transfers, receiver approval, independent sequential queues, cancellation, downloads and incremental SHA-256 verification.
- Refine dark-theme typography, transfer states, QR pairing, metric readability, keyboard focus and mobile layouts.
- Publish a product-focused README, privacy-redacted screenshots, dependency notices and reproducible verification instructions.
- Add CI for Python, JavaScript, Chromium sharing and evaluation of actual exported observations.
- Correct the AI active-transfer state mapping and explicitly require Pydantic 2.
- Reinitialize sharing and AI controls when a cached page is restored after connection cleanup.

## 0.2.0

- Introduce incremental SHA-256 integrity checks, measured WebRTC diagnostics, bounded backpressure and stronger room/signaling authorization.
- Validate browser-to-browser transfer, rejection, cancellation, corruption handling, interruptions and narrow layouts with real Chromium contexts.
