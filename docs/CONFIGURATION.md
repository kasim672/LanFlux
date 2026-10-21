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
| `LANFLUX_TURN_URLS` | Comma-separated `turn:`/`turns:` URLs; requires either the shared secret or both static credentials below. |
| `LANFLUX_TURN_SHARED_SECRET` | Server-only coturn REST authentication secret, 32–4096 characters. Recommended for public deployments; must match coturn's `static-auth-secret`. Mutually exclusive with static username/credential. |
| `LANFLUX_TURN_CREDENTIAL_TTL_SECONDS` | Lifetime of newly issued ephemeral TURN credentials: default 600; range 60–3600 seconds. |
| `LANFLUX_TURN_USERNAME`, `LANFLUX_TURN_CREDENTIAL` | Alternative static browser-visible relay credentials for controlled private/admin deployments. Never commit actual values; leave both empty in shared-secret mode. |
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

The supported CLI accepts `--forwarded-allow-ips 127.0.0.1,::1` to trust exact proxy IPs; wildcards and CIDR ranges are rejected. Use `--no-proxy-headers` when no trusted proxy supplies these headers. The deployment example binds Python to `127.0.0.1:8000`, with Nginx on the same host. Do not publish port 8000 or add arbitrary public clients to the proxy trust list. See the complete [HTTPS, coturn and systemd deployment guide](DEPLOYMENT.md).

For local TLS with certificates trusted by both devices:

```bash
python -m lanflux --lan --ssl-certfile PATH --ssl-keyfile PATH
```

The development server is not exposed publicly by default. A public deployment also needs edge abuse controls and appropriate operating-system/server maintenance.

## Optional TURN

For a separately operated coturn service, use ephemeral credentials. Example placeholders, not operational credentials:

```dotenv
LANFLUX_TURN_URLS=turns:turn.example.com:443?transport=tcp
# Required: fill with a private random secret, >=32 characters; match coturn.
LANFLUX_TURN_SHARED_SECRET=
LANFLUX_TURN_CREDENTIAL_TTL_SECONDS=600
LANFLUX_TURN_USERNAME=
LANFLUX_TURN_CREDENTIAL=
```

The shared secret remains on the Python and coturn servers. `/api/config` exposes STUN and TURN availability flags, without TURN passwords. After room admission, `welcome` and each `peer-joined` WebSocket message deliver fresh per-peer TURN credentials and their expiration. LANFLUX uses coturn's timestamped username and Base64 HMAC-SHA1 credential format. Credentials reaching a browser are usable until their expiry; never treat them as private from that browser's user. Existing allocations can retain their session credentials; expiry primarily prevents new allocations with old credentials. Replacement peers receive fresh credentials. Keep both server clocks synchronized. [Coturn REST authentication reference](https://github.com/coturn/coturn/blob/master/README.turnserver#turn-rest-api).

Room creation is anonymous, so admission is not account authentication. A public operator must apply edge access control, request limits, coturn allocation/bandwidth quotas and monitoring. The [deployment examples](DEPLOYMENT.md) include a password-protected Nginx edge and a separate TURN host. No TURN service is bundled or automatically provisioned.

With the default `all` policy, the browser's native ICE agent evaluates permitted host, STUN and TURN candidates; TURN is available without an application-level reconnect loop. This does not guarantee a specific selection order or connectivity on every network. `relay` permits only relay candidates. [WebRTC ICE transport policy](https://w3c.github.io/webrtc-pc/#rtcicetransportpolicy-enum).

TURN over TLS on TCP 443 is TURN traffic, not HTTPS. It may still be blocked by a college firewall, protocol inspection or allowlist. Both devices must reach the public website and TURN endpoint, and the TURN host needs working relay UDP ports. Ask the network administrator for an authorized path when policy blocks the service.

Settings → Relay only applies to the next connection. Confirm **TURN relay** from the observed selected ICE pair before labeling an experiment as relayed. A configured relay is not proof that it was used.

## Security and resource boundaries

The server never receives or stores file contents. Room identifiers are cryptographically generated 16-character bearer capabilities; share invitations privately. Rooms have two peers, absolute expiration, disconnected-peer cleanup and fresh pairing IDs. Signaling validates message sizes, fields and negotiation transitions. Default per-client limits are room creation 10/minute, joins 30/minute and QR requests 60/minute; signaling is 180/peer/minute. State tables are bounded.

Files require receiver approval and exact byte-count/SHA-256 verification. Filenames are normalized and rendered as text. No upload, arbitrary filesystem or remote-command routes exist. Completed receives count toward the 128 MiB payload limit until cleared; browser buffers/Blobs add overhead beyond this limit. No streaming-to-disk or automatic resume is advertised.

The recommended CLI disables access logging and filters sensitive WebSocket payloads and room credentials. A matching hash proves transferred-byte integrity relative to the peer's metadata, not identity or file safety. An authorized malicious peer can still send unwanted content or cause denial of service.
