# Real interface screenshots

Captured on **22 October 2026** from the running LANFLUX application by its Playwright Chromium regression suite. These are browser screenshots, not mockups or generated product renders. Screenshot-only framing makes navigation non-sticky when capturing the desktop workspace; it does not alter application data or transfer results.

## Gallery

| Image | Observed state |
| --- | --- |
| [Homepage](homepage.png) | Desktop landing and room creation/joining |
| [Desktop workspace](desktop.png) | Actual connected browsers, file selection and verified transfers |
| [Mobile workspace](mobile.png) | Connected peer and file selection at a 390 x 844 viewport |
| [Mobile homepage](mobile-homepage.png) | Room creation/joining on the narrow viewport |
| [Connected peers](connected-devices.png) | Open DataChannel and observed direct route |
| [QR pairing](qr-pairing.png) | Real invitation dialog, with its capability-bearing QR/code masked |
| [Receiver approval](incoming-approval.png) | Actual file offer waiting for consent; no payload received yet |
| [Active transfer](active-transfer.png) | Actual approved file in progress under test-only sender pacing |
| [Verified receive](verified-transfer.png) | Exact received bytes and SHA-256 verified, with download available |
| [Mobile verified receive](mobile-transfer.png) | The verified receiver card at mobile width |
| [Network diagnostics](network.png) | Observed states, direct route, payload counters, speed history and RTT during activity |
| [Anomaly monitor](ai-monitor.png) | Trained IsolationForest evaluated on later actual observations; forecast still learning |
| [AI Transfer Intelligence](ai-intelligence.png) | Both trained models, observed speed/RTT, forecast, validation errors and advisory text |
| [Settings](settings.png) | Real device label, relay preference and memory-limit information |
| [Full landing page](landing.png) | Full desktop page for closer inspection |

## Reproduce

From the repository root with Python dependencies, Node dependencies and Chromium installed:

```bash
npm run test:e2e
```

That default refreshes the documented PNGs while exercising real two-browser transfers. To keep committed images untouched during development:

```bash
LANFLUX_SCREENSHOT_DIR=output/playwright/screenshots npm run test:e2e
```

PowerShell equivalent:

```powershell
$env:LANFLUX_SCREENSHOT_DIR = "output/playwright/screenshots"
npm run test:e2e
Remove-Item Env:LANFLUX_SCREENSHOT_DIR
```

## Evidence and privacy

- The fixture starts a temporary loopback/LAN-bound Python service and two real browser contexts. The desktop viewport is 1440 x 1000; mobile is 390 x 844. Reduced-motion browser preference avoids animation/scroll movement during privacy masking. Mobile viewport emulation is not physical-device or Safari testing.
- File offers, approval, actual DataChannel bytes, SHA-256 verification and downloaded byte equality are exercised. File fixtures are test content, not a person's private files.
- The AI forecast and active network screenshots use real observations from an approved 8 MiB transfer with bounded test-only sender delays. This workload makes learning observable; it is not normal application pacing or a general throughput/accuracy result.
- Metrics are captured as observed. Zero and Unavailable remain visible where appropriate. No prediction, chart, speed or completion label is invented or retouched.
- Public images mask room capabilities, invitation addresses and QR contents. Private ICE inspection stays hidden. The screenshot mask is a deliberate redaction, not an application placeholder.
- Temporary rooms close after the fixture exits. Raw CSVs and test artifacts remain in ignored `output/playwright/`.
