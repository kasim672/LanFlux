# Configuration and deployment

Copy `.env.example` to `.env`; `python -m lanflux` loads it automatically. Alternatively pass `--env-file PATH`. Run `python -m lanflux --help` for binding, port and TLS options. Keep real credentials and private keys out of Git.

## Environment variables

| Variable | Purpose / default |
| --- | --- |
| `LANFLUX_PUBLIC_URL` | Explicit HTTP(S) invitation origin, without a path. Empty uses physical-LAN discovery for localhost, otherwise the page origin. |
| `LANFLUX_ALLOWED_ORIGINS` | Additional exact HTTP(S) browser origins, comma-separated, without paths or wildcards. Same-origin access works by default. |
| `LANFLUX_TRUSTED_HOSTS` | Additional exact public/custom DNS hostnames, without ports or wildcards. Hosts from PUBLIC_URL and ALLOWED_ORIGINS are also trusted. |
| `LANFLUX_ROOM_TTL_SECONDS` | Absolute room life: default 3600; range 60–86400. |
| `LANFLUX_PEER_IDLE_TIMEOUT_SECONDS` | Idle signaling cleanup: default 60; range 15–300. Clients heartbeat every five seconds. |
| `LANFLUX_MAX_ROOMS`, `LANFLUX_MAX_PEERS` | In-process resource caps: defaults 1000 and 512. |
| `LANFLUX_MAX_FILE_MIB`, `LANFLUX_MAX_MEMORY_MIB` | Browser payload limits: maximum/default 64 and 128 MiB. Lower them for constrained phones. |
| `LANFLUX_STUN_URLS` | Comma-separated STUN URLs; Google STUN defaults. Empty disables STUN for isolated-LAN tests. |
| `LANFLUX_TURN_URLS` | Comma-separated `turn:`/`turns:` URLs; requires username and credential. |
| `LANFLUX_TURN_USERNAME`, `LANFLUX_TURN_CREDENTIAL` | Browser-visible relay credentials. Never commit actual values. |
| `LANFLUX_ICE_TRANSPORT_POLICY` | `all` (default) or `relay`; relay-only requires a reachable configured TURN service. |

## Local Wi-Fi

The default CLI binds `127.0.0.1`. Explicitly enable LAN access:

```bash
python -m lanflux --lan --port 8000
```

Open `http://localhost:8000` on the computer and create a room. The invitation chooses an active physical adapter's private IPv4 address, preferring the default route. Docker, virtual and VPN adapters are excluded. Detection refreshes every 30 seconds for new rooms; each existing room retains one consistent QR/copy/display invitation.

On systems with multiple physical networks or unavailable adapter discovery, set `LANFLUX_PUBLIC_URL` to the actual reachable scheme, hostname/address and port. Restart and create a new room. This changes invitations, not the server bind address. Opening the computer's LAN origin directly also preserves that origin. Find addresses with `ipconfig` on Windows, `ip -4 addr` on Linux, or `ipconfig getifaddr en0` on macOS (adapter names vary).

Allow the selected port on private-network firewall rules. Avoid guest-network client isolation. Keep both browser tabs foregrounded; sleeping/backgrounded mobile browsers may suspend WebRTC and heartbeats.

## Origin and Host controls

Browser WebSocket and AI requests require a canonical same-origin match or an explicitly configured trusted origin, including scheme and port. Missing/null/malformed/duplicate Origins are rejected. Adding a trusted Host does not independently permit a cross-origin browser.

Host validation accepts localhost, private/loopback IPs, unqualified LAN names and `.local`. Public/custom DNS names need explicit trust. Wildcard public Hosts and arbitrary cross-site connections are rejected.

## HTTPS and internet deployment

Use HTTPS/WSS on untrusted networks. Trusted local HTTP may expose WebRTC, but HTTP signaling can be intercepted or modified and does not authenticate the sending person. The hash implementation itself works without Web Crypto or a secure context.

Run **one Python worker**: room membership, signaling and AI models are process-local. Put a TLS reverse proxy in front of a private Uvicorn upstream, forward WebSocket Upgrade, and preserve the browser-visible Host. Configure the exact public origin and avoid caching `/api/config`. Trust forwarded headers only from your own proxy; do not expose an upstream with blanket forwarded-IP trust. Proxy logs should redact invitation queries and room socket paths.

For local TLS with certificates trusted by both devices:

```bash
python -m lanflux --lan --ssl-certfile PATH --ssl-keyfile PATH
```

The development server is not exposed publicly by default. A public deployment also needs edge abuse controls and appropriate operating-system/server maintenance.

## Optional TURN

Example placeholders, not operational credentials:

```dotenv
LANFLUX_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
LANFLUX_TURN_USERNAME=short-lived-user
LANFLUX_TURN_CREDENTIAL=short-lived-credential
```

Credentials are delivered to browsers. Public hosting needs restricted, expiring relay credentials and quotas; LANFLUX currently reads environment credentials and does not issue or rotate them. No TURN service is bundled. Restrictive NATs, firewalls or isolated Wi-Fi may prevent remote connectivity without a suitable relay.

Settings → Relay only applies to the next connection. Confirm **TURN relay** from the observed selected ICE pair before labeling an experiment as relayed. A configured relay is not proof that it was used.

## Security and resource boundaries

The server never receives or stores file contents. Room identifiers are cryptographically generated 16-character bearer capabilities; share invitations privately. Rooms have two peers, absolute expiration, disconnected-peer cleanup and fresh pairing IDs. Signaling validates message sizes, fields and negotiation transitions. Default per-client limits are room creation 10/minute, joins 30/minute and QR requests 60/minute; signaling is 180/peer/minute. State tables are bounded.

Files require receiver approval and exact byte-count/SHA-256 verification. Filenames are normalized and rendered as text. No upload, arbitrary filesystem or remote-command routes exist. Completed receives count toward the 128 MiB payload limit until cleared; browser buffers/Blobs add overhead beyond this limit. No streaming-to-disk or automatic resume is advertised.

The recommended CLI disables access logging and filters sensitive WebSocket payloads and room credentials. A matching hash proves transferred-byte integrity relative to the peer's metadata, not identity or file safety. An authorized malicious peer can still send unwanted content or cause denial of service.
