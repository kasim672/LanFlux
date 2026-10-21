# LANFLUX documentation

Start with the [project overview](../README.md) or read the **[complete PDF technical report](LANFLUX_Technical_Report.pdf)**. Documentation describes the current implementation; it does not promise deployment services, benchmark improvements or unperformed device tests.

| Guide | What you will find |
| --- | --- |
| [User guide](USER_GUIDE.md) | Installation, Windows/Linux/macOS, phone pairing, approval, transfer controls, settings and troubleshooting |
| [Architecture](ARCHITECTURE.md) | Python/browser responsibilities, room lifecycle, signaling, file-transfer state machine, module map and resource management |
| [Security and privacy](SECURITY.md) | Trust boundaries, room capabilities, Origin checks, metadata authorization, SHA-256, logging and remaining risks |
| [AI Network Monitor](AI_MONITOR.md) | Observations, IsolationForest, past-only RandomForest labels/features, validation, advisor and demonstration |
| [Configuration](CONFIGURATION.md) | Every environment variable, invitation discovery, limits, origins, ICE and credentials |
| [Deployment](DEPLOYMENT.md) | Public HTTPS/WSS, Nginx, coturn, TLS/TCP 443, systemd and operator requirements |
| [Network experiments](NETWORK_EXPERIMENTS.md) | Real 1/10/50 MiB trials, units, CSV, comparison methodology and manual phone regression |
| [Verification](VERIFICATION.md) | Exact executed checks, evidence provenance, coverage and unverified environments |
| [Technical report source](REPORT.md) | Report introduction, glossary, reading order and reproducible PDF build |
| [Changelog](../CHANGELOG.md) | Published history and current unreleased additions |
| [PDF font notices](FONT_NOTICES.md) | Permission notice for the embedded report fonts |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Distributed dependency notices and provenance |

## Choose a path

**First use:** User guide → Configuration → AI Network Monitor.

**College demonstration:** User guide → AI Network Monitor → Network experiments → Verification.

**Engineering review:** Architecture → Security → AI Network Monitor → source/tests.

**Public operator:** Security → Configuration → Deployment; supply your own approved hosting and relay infrastructure.

The PDF is generated from the canonical guides rather than maintained as a separate explanation. Runtime installation does not need the PDF-building dependencies. Files and personal datasets remain outside Git; the report includes interface evidence, not users' transferred content or private ICE addresses.
