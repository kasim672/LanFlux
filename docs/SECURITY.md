# Security and privacy model

LANFLUX is a two-browser file-sharing application with a small signaling and metadata service. Its controls limit unintended access and resource use while preserving local-LAN operation. They do not authenticate a person's real identity, inspect file safety or guarantee connectivity on a restricted network.

For operational setup and hardened examples, read [configuration](CONFIGURATION.md) and [deployment](DEPLOYMENT.md). For message flows and implementation ownership, see [architecture](ARCHITECTURE.md).

## Trust boundaries

| Boundary | What crosses it | What must be trusted |
| --- | --- | --- |
| Browser ↔ FastAPI | Room capability, display name, SDP/ICE, heartbeat, peer-bound telemetry authorization. | The served application and signaling service; HTTPS/WSS for untrusted networks. |
| Browser ↔ peer | Approved file metadata, SHA-256, encrypted file chunks and diagnostic ping/pong. | The paired peer for offered content and its stated identity. |
| Browser ↔ STUN | Address-discovery traffic. | The configured discovery operator can observe connection metadata. |
| Browser ↔ TURN | WebRTC-encrypted relayed traffic and temporary allocation credentials. | The relay operator for availability and network metadata handling. |
| Browser ↔ ML API | Numeric network observations and categorical route; model results/CSV. | The authenticated reporting browser; reports are not independently attested. |

FastAPI has no file-upload or file-content storage path. Filenames, digests and payload are exchanged through the DataChannel. This statement concerns the supplied application; separately configured proxies, extensions and host software have their own behavior and retention.

## Transport and identity

WebRTC DataChannels use the browser's encrypted transport. Direct P2P means no TURN relay was observed in the selected candidate pair; it does not mean the devices are on the same Wi-Fi or that no routers exist between them. TURN Relay means a relay candidate was actually selected. Encrypted file packets passing through TURN do not become plaintext uploads to FastAPI.

Local HTTP remains supported for trusted development/LAN use. HTTP does **not** protect the served JavaScript or signaling from interception/modification. Use HTTPS/WSS for public or untrusted networks. WebRTC encryption does not compensate for an attacker replacing the application or manipulating unauthenticated signaling.

A room code is a bearer capability. Anyone with it can occupy an available room slot. The application does not provide accounts, a second-factor room password, a human identity certificate or out-of-band fingerprint verification. Verify the other device through a trusted conversation and share invitations privately. The second-peer capacity check prevents a third participant from joining that room, but it cannot identify whether the first two participants were the intended people.

## Room admission and authorization

Room IDs use cryptographically secure generation and a restricted 16-character alphabet. Peer IDs, transfer IDs, telemetry tokens and new pair generations are also randomly generated. Default room life is one hour, with periodic expiration and at most 60 seconds of empty-room grace after both members leave.

WebSocket admission validates a single trusted Host and requires one canonical Origin matching the current website or an explicitly allowed exact origin. Missing, null, malformed, duplicate or untrusted browser Origins are rejected. Trusted public/custom hosts and allowed origins are separately configurable; accepting a Host does not authorize arbitrary cross-origin pages. Localhost, supported private addresses and LAN names remain usable without a wildcard public policy.

Origin checks protect against ordinary cross-site browser connections. A non-browser client can forge an Origin header, so Origin alone is not user authentication or a defense against a client that already possesses a room code. Public deployments need additional edge admission controls and abuse monitoring.

The server binds each admitted socket to a specific peer object. It selects the other member itself rather than accepting an arbitrary client-supplied recipient. Paired messages must carry the current pair ID, use valid negotiation roles and follow `ready → offered → answered`. Replacement/departed peers cannot reuse a stale generation to negotiate the next pair.

## Strict messages and resource bounds

Signaling accepts text JSON only, rejects duplicate object keys and validates strict typed schemas with no extra fields. The application caps signaling at 64 KiB UTF-8, SDP at 49,152 characters and individual ICE candidate strings at 4,096 characters. ICE can precede offer forwarding because browser candidate gathering is asynchronous; other negotiation transitions remain checked.

| Default bound | Purpose |
| --- | --- |
| Two peers per room | Pairing capacity. |
| 1,000 rooms and 512 peers | Bounded process-local admission. |
| 10 room creations/IP/minute | Room-creation abuse limit. |
| 30 join attempts/IP/minute | WebSocket admission pacing. |
| 60 QR requests/IP/minute | QR rendering bound. |
| 180 signaling messages/peer/minute | Socket message pacing. |
| 64 MiB/file, 128 MiB retained/reserved receive payload | Browser payload memory budget. |
| 20 nonterminal/queued files, 100 retained records | Browser queue/history bound. |
| 60 chart samples | Bounded diagnostics history. |
| 2 KiB/ML request, 180 requests/IP/minute, 90 requests/peer/minute | Metadata API pacing and body bound. |
| 32 monitors, 600 retained rows/monitor, two model operations at a time | Model memory/CPU bounds. |

IP rate buckets themselves are bounded. These in-process controls are useful MVP protections, not a distributed denial-of-service system. Shared college NATs can make several legitimate users share an IP limit. Large-scale/public operation needs edge request limits, OS/service hardening, bandwidth quotas and monitoring.

## Receiver consent and file integrity

Every incoming file requires explicit approval. The receiver reserves its advertised size before accepting and refuses offers exceeding queue, file or receive-payload limits. It rejects payload before permission, invalid IDs, unknown controls, unexpected state transitions, excess declared bytes and excessive tiny chunks. Outgoing payload is chunked with negotiated-message-size checks and `bufferedAmount` backpressure.

The sender computes SHA-256 incrementally over the original file. The receiver computes SHA-256 over actual accepted payload and requires the exact declared byte count. Only matching, completed files receive a download Blob URL. A sender also waits for a valid matching completion digest. Missing bytes, corruption, unavailable hashing, cancellation and connection failure cannot produce a verified successful state.

**Integrity Verified means transferred bytes match the peer's digest.** An intentional malicious sender can offer dangerous content and its correct hash. SHA-256 verification does not establish real-world identity, perform malware scanning, make a file safe to open or provide nonrepudiation. A bare digest is not an independently signed identity claim.

The incremental hash implementation is bundled locally with its third-party license/provenance notices. It avoids a second complete file-sized hashing buffer and remains usable without `crypto.subtle` on local HTTP. No third-party model or JavaScript package is silently downloaded at runtime.

## Filenames, HTML and browser cleanup

Incoming filenames are treated as untrusted text. The transfer layer removes path separators, control/bidirectional characters and unsafe filename characters, bounds length, handles Windows reserved names and avoids trailing dot/space edge cases. Interface rendering uses text rather than interpreting filenames as markup. These names do not become server filesystem paths: the backend never saves the file.

Downloaded content uses an `application/octet-stream` Blob with a download filename. A user still chooses whether to open it using other software. Keep normal browser/operating-system file handling protections enabled.

Security headers disable framing, sniffing and unnecessary device permissions; CSP restricts application scripts/styles to its own origin and prevents embedded objects/base-URL replacement. CSP permits WebSocket connection schemes for signaling, so it should not be described as an absolute network-exfiltration barrier.

Incomplete transfer cleanup discards chunks, hash instances and file references and releases reserved receive payload. Leaving/disconnect closes WebRTC objects and drains buffer waiters; leave stops heartbeat/statistics timers. Completed receives remain deliberately retained for download until cleared; clearing revokes Blob URLs and releases their accounted payload. Browser allocation/Blob overhead can exceed the advertised payload budget, so the limit is not a total-RAM guarantee.

## ML authorization, privacy and failure isolation

The admitted WebSocket supplies a fresh per-peer telemetry Bearer token. Tokens stay in browser memory and are absent from invitation URLs and localStorage. Each metadata request also requires a trusted Origin, a non-expired room, the matching peer and two live members. Strict models reject unrelated fields and invalid/nonfinite values; body limits apply while streaming the request before complete buffering. Per-peer locks prevent overlapping model operations.

Models are separate for each reporting peer. Pair changes, departure, reset, expiry and restart clear them. Retained CSV rows contain observations, receipt timestamps, anomaly results, forecast values and validation errors. They exclude file contents, filenames, file hashes, private ICE addresses, room codes and authorization tokens. An exported CSV is a user-created local artifact; share it only with appropriate context and permission.

Authorized clients can submit misleading telemetry. The models are experimental, not adversarially robust attack detectors. IsolationForest outliers can reflect workload/CPU/browser scheduling changes; a forecast can be worse than the last-observed-speed baseline. Genuine future measurements are needed to label forecast examples, with chronological purging before holdout evaluation. Synthetic fixtures are limited to tests, and no idle-data success claim is substituted for active-transfer forecasting.

Model fitting and inference run off the async event loop under bounded concurrency. The frontend clears stale forecasts and treats API/model failures as unavailable. AI predictions do not change the file protocol, approval, integrity rules, chunk size or pacing. Sharing remains independent of AI availability.

## TURN credential handling

Public configuration exposes STUN and relay capability flags, not TURN passwords. Admitted peers receive fresh private ICE configuration in `welcome` and `peer-joined`, including replacement pairings. Browser-held relay credentials are usable by that browser's user; secrecy from an admitted user is not claimed.

Recommended coturn REST mode keeps a shared secret only on Python and the TURN service, producing timestamped per-peer usernames and Base64 HMAC-SHA1 credentials. The default issued lifetime is 600 seconds. HMAC-SHA1 here is coturn's credential protocol; it is distinct from file SHA-256 integrity verification. Credential expiry restricts new allocations; existing allocations may continue under their session credentials. Keep clocks synchronized. Static relay username/password configuration is available for controlled deployments but lacks the same short lifetime.

The shared secret must be at least 32 characters. Empty/inconsistent credentials, duplicate/invalid ICE URLs and unsupported relay-only configuration fail validation. Frontend configuration discards relay credentials on leave/pair loss and rejects expired credentials for a new connection. Do not log credentials or commit `.env`, certificate keys, TURN databases or generated datasets.

## Reverse proxy and restricted networks

The supported CLI binds loopback by default. `--lan` explicitly opens LAN binding. For public deployment, terminate HTTPS at a maintained proxy, keep Uvicorn private, run one worker and trust forwarded headers only from exact configured proxy IPs. The CLI rejects blanket wildcard/CIDR proxy trust. Preserve the external Host and WebSocket Upgrade, and configure the public origin consistently.

The supplied Nginx example uses Basic authentication for the website and signaling admission. Exactly `/api/aiml/sample`, `/api/aiml/reset` and `/api/aiml/export` use the backend's strong peer Bearer authentication instead, because Basic and Bearer occupy the same Authorization header. Do not broaden this exception to all APIs or WebSockets. A public operator must configure real access credentials, TLS and edge limits rather than treating example files as a deployed service.

A coturn TLS/TCP 443 listener needs its own public endpoint, typically a separate host/IP from the website's TCP 443. TURN/TLS is not HTTP and cannot be passed through an ordinary HTTPS location proxy. Relay UDP ports, certificates, allocation quotas, private/special peer-address denials and host firewalls must also be configured. Never enable an open unauthenticated relay.

Direct P2P remains available under the default ICE `all` policy; native ICE evaluates permitted candidates. Relay-only is explicit and requires configured TURN. No routing workaround bypasses a college's policies. A firewall can still block TURN/TLS on 443 or enforce client isolation. Ask the network administrator for an approved path. Actual connectivity requires externally supplied infrastructure and cannot be guaranteed by local code alone.

## Logs, retained data and remaining limitations

The supported startup disables access logging, filters bearer room paths/query strings and suppresses protocol debug frame bodies. Reverse proxies and custom instrumentation need their own redaction. Keep signaling payloads, tokens, private candidate addresses and room URLs out of production logs. Explicit local ICE inspection may reveal addresses to the user; it is not sent to AI or public reports by default.

The service has no account management, independent peer-identity verification, malware scanning, durable audit log, distributed rate limiter or automatic transfer recovery. Room URLs may remain in a user's browser history or be shared outside the app. An authorized hostile peer can still waste resources within/around client controls. Dependency/runtime patching, trusted hosting, endpoint security and careful handling of received files remain operator/user responsibilities.

Report a vulnerability privately to the repository maintainer before publishing exploit details; do not include credentials, private room URLs or unredacted user data in public issues.
