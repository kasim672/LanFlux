"""Coturn REST authentication, issued only after admission to a live room.

HMAC-SHA1 is required by coturn's credential protocol; file verification uses
SHA-256 separately. Shared secrets and credentials are never logged here.
"""

import base64
import hashlib
import hmac
import re
import time


def temporary_credentials(secret: str, peer_id: str, ttl_seconds: int,
                          *, now: float | None = None) -> tuple[str, str, int]:
    """Return timestamp:peer, HMAC password and expiry in Unix seconds."""
    if not re.fullmatch(r"[a-f0-9]{24}", peer_id):
        raise ValueError("Invalid TURN peer identity")
    if not 60 <= ttl_seconds <= 3600:
        raise ValueError("TURN credential lifetime must be between 60 and 3600 seconds")
    if not 32 <= len(secret) <= 4096 or any(ord(c) < 32 or ord(c) == 127 for c in secret):
        raise ValueError("TURN shared secret must contain 32–4096 characters without controls")
    expires_at = int(time.time() if now is None else now) + ttl_seconds
    username = f"{expires_at}:{peer_id}"
    digest = hmac.new(secret.encode("utf-8"), username.encode("ascii"), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode("ascii"), expires_at
