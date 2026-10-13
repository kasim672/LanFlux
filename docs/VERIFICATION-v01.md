# Verification

Run on 2026-10-13. The application is implemented and its real browser transfer flow passed; no public deployment was made.

## Passing checks

- **25 Python cases**: health/configuration, secure unique room identifiers, two-peer restriction, SDP/ICE relay, heartbeat, role replacement after disconnect, unknown/expired rooms, bad names, strict signaling schemas, invalid JSON, binary and oversized messages, origins, rate limits, bounded room/peer state, QR URL validation, security headers, room expiration, abandoned-room cleanup, and absence of legacy upload/download routes.
- **10 JavaScript protocol tests**: approval prevents binary sends, send queue waits for completion acknowledgement, receive bytes/Blob correctness, memory cleanup, rejected/zero-byte files, stale frames after cancellation, malformed controls, size/resource limits, actual backpressure pause and cancellation release, disconnect/replacement roles, bounded history, portable safe filenames, and tiny-frame flood cleanup.
- **8 browser scenarios plus their parent test**, using a live Uvicorn fixture and separate real Chromium contexts: create/join/invitation/QR/direct ICE route; consent before bytes; sequential binary and empty-file downloads; reverse-direction exact-byte download; rejection and cancellation; cancellation during binary chunk streaming followed by a successful next file; mobile-width layout and memory clearing; replacement peer pairing; simultaneous opposite-direction transfers; and pairing/download on non-localhost HTTP with `isSecureContext === false` and no `crypto.randomUUID`. Some behaviors are grouped into one scenario.
- Captured and reviewed desktop and 390px mobile layouts in `output/playwright/`. No horizontal mobile overflow. No browser JavaScript errors. Signaling frames contained only offer/answer/ICE/ping, not file metadata or chunks. Downloaded payloads were compared byte-for-byte with their input buffers.
- JavaScript syntax checks, Python compilation, dependency consistency (`pip check`), HTML element-reference/duplicate-ID/CSP audit, and preservation of original source SHA-256 checksums.

Commands:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
node tests/test_transfer.mjs
npm install
npx playwright install chromium
npm run test:e2e
```

The browser test starts/stops its own server on port 8765; it does not leave the product running. Set `LANFLUX_TEST_URL` to test an already-running server, or `LANFLUX_CHROMIUM_PATH` to select a Chromium executable. The LAN-style hostname test runs only with the local fixture. Browser tests disable external STUN in their fixture to make local testing deterministic; STUN/TURN environment configuration is verified separately by Python tests.

## Workspace constraints and actual execution

Python/npm network downloads were blocked. An isolated `.venv` was prepared from compatible locally installed distributions; `pip check` passed. Cached Playwright/Chromium were used for browser checks. This is specific to the coding environment; ordinary installs use the requirements files and npm development dependencies.

The restricted shell initially prevented socket binding and asyncio cross-thread self-pipe wakeups. An escalation request was automatically rejected. The browser integration subsequently ran successfully under the already-authorized ordinary `node --test tests/browser.test.mjs` runner, including its server fixture. No product code was changed to work around the sandbox.

Python TestClient checks used a temporary `/tmp/lanflux-pytest-sandbox.py` launcher which polls the selector every 10ms to handle denied cross-thread wakeup sockets. The tests still exercise the actual ASGI app, lifespan, and WebSocket handlers. On a normal host run standard `python -m pytest -q`. The installed Starlette emitted one TestClient/httpx deprecation warning; there were no test failures. Direct `node tests/test_transfer.mjs` reported all 10 protocol tests; the sandbox's isolated Node reporter sometimes collapsed them into a single file result.

## Still requires a real device/network

- Physical Android/iPhone pairing, downloads, camera QR scanning, and mobile sleep/background behavior.
- Safari, Firefox, and Edge runtime behavior; the automated browser is Chromium. Mobile viewport emulation is not an iPhone browser test.
- Actual Wi-Fi across two physical devices, isolated/guest Wi-Fi, router/firewall configurations, public HTTPS/reverse-proxy deployment, and cross-network NAT traversal.
- A real TURN service and forced-relay route. Configuration and route-selection logic are implemented, but no TURN credentials/service were supplied. TURN is never described as a direct route.
- Maximum-size memory behavior on low-memory phones. This MVP deliberately caps files at 64MiB and reserved/retained received bytes at 128MiB; it does not stream to disk or promise arbitrarily large files.
