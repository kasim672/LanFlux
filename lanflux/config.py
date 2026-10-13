"""Small, validated environment configuration. No file content reaches this service."""

import os
import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit


def integer(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def origin(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048 or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("Invalid origin")
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc or "@" in parsed.netloc
            or parsed.path or parsed.query or parsed.fragment or "?" in value or "#" in value):
        raise ValueError("Origins must be absolute http(s) URLs without credentials, paths or queries")
    if not re.fullmatch(r"(?:\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::[0-9]+)?", parsed.netloc):
        raise ValueError("Invalid origin authority")
    hostname = normalize_host(parsed.hostname or "")
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Invalid origin port")
    host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if parsed.scheme == "https" else 80
    suffix = f":{port}" if port and port != default_port else ""
    return f"{parsed.scheme}://{host}{suffix}"


def normalize_host(value: str) -> str:
    """Canonical IP or DNS host, never credentials, wildcards or URL syntax."""
    value = value.lower()
    if not value or len(value) > 253 or any(c in value for c in "/\\%@?#"):
        raise ValueError("Invalid host")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if ":" in value:
            raise ValueError("Invalid IPv6 host") from None
    ascii_host = value.encode("idna").decode("ascii")
    if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in ascii_host.split(".")):
        raise ValueError("Invalid DNS host")
    return ascii_host


def local_host(host: str) -> bool:
    if host == "localhost" or host.endswith((".localhost", ".local")) or "." not in host and ":" not in host:
        return True
    try:
        address = ipaddress.ip_address(host)
        return not address.is_unspecified and (address.is_private or address.is_loopback or address.is_link_local)
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    room_ttl_seconds: int = 3600
    empty_room_grace_seconds: int = 60
    cleanup_interval_seconds: float = 5
    max_rooms: int = 1000
    max_peers: int = 512
    max_file_size: int = 64 * 1024 * 1024
    max_memory_bytes: int = 128 * 1024 * 1024
    max_queue_files: int = 20
    room_rate_limit: int = 10
    join_rate_limit: int = 30
    signal_rate_limit: int = 180
    peer_idle_timeout_seconds: float = 60
    trusted_hosts: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ()
    public_url: str = ""
    stun_urls: tuple[str, ...] = ("stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302")
    turn_urls: tuple[str, ...] = ()
    turn_username: str = ""
    turn_credential: str = ""
    ice_transport_policy: str = "all"

    @classmethod
    def from_env(cls) -> "Settings":
        def entries(name: str, default: str = "") -> tuple[str, ...]:
            return tuple(item.strip() for item in os.getenv(name, default).split(",") if item.strip())

        public_url = os.getenv("LANFLUX_PUBLIC_URL", "").strip().rstrip("/")
        if public_url:
            public_url = origin(public_url)
        turns = entries("LANFLUX_TURN_URLS")
        username = os.getenv("LANFLUX_TURN_USERNAME", "")
        credential = os.getenv("LANFLUX_TURN_CREDENTIAL", "")
        policy = os.getenv("LANFLUX_ICE_TRANSPORT_POLICY", "all")
        if policy not in {"all", "relay"}:
            raise ValueError("LANFLUX_ICE_TRANSPORT_POLICY must be all or relay")
        if turns and (not username or not credential):
            raise ValueError("TURN URLs require LANFLUX_TURN_USERNAME and LANFLUX_TURN_CREDENTIAL")
        if policy == "relay" and not turns:
            raise ValueError("Relay-only mode requires TURN configuration")
        stuns = entries("LANFLUX_STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
        if any(not url.startswith("stun:") for url in stuns):
            raise ValueError("STUN URLs must start with stun:")
        if any(not url.startswith(("turn:", "turns:")) for url in turns):
            raise ValueError("TURN URLs must start with turn: or turns:")
        max_file = integer("LANFLUX_MAX_FILE_MIB", 64, 1, 64) * 1024 * 1024
        memory = integer("LANFLUX_MAX_MEMORY_MIB", 128, 1, 128) * 1024 * 1024
        if max_file > memory:
            raise ValueError("The file limit cannot exceed the browser memory limit")
        allowed = tuple(origin(value) for value in entries("LANFLUX_ALLOWED_ORIGINS"))
        return cls(
            room_ttl_seconds=integer("LANFLUX_ROOM_TTL_SECONDS", 3600, 60, 86400),
            max_rooms=integer("LANFLUX_MAX_ROOMS", 1000, 1, 10000),
            max_peers=integer("LANFLUX_MAX_PEERS", 512, 2, 10000),
            max_file_size=max_file, max_memory_bytes=memory,
            peer_idle_timeout_seconds=integer("LANFLUX_PEER_IDLE_TIMEOUT_SECONDS", 60, 15, 300),
            trusted_hosts=tuple(normalize_host(value.strip("[]")) for value in entries("LANFLUX_TRUSTED_HOSTS")),
            allowed_origins=allowed, public_url=public_url, stun_urls=stuns,
            turn_urls=turns, turn_username=username, turn_credential=credential,
            ice_transport_policy=policy,
        )

    def browser_config(self) -> dict:
        servers = [{"urls": list(self.stun_urls)}] if self.stun_urls else []
        if self.turn_urls:
            servers.append({"urls": list(self.turn_urls), "username": self.turn_username, "credential": self.turn_credential})
        return {
            "ice_servers": servers, "ice_transport_policy": self.ice_transport_policy,
            "max_file_size": self.max_file_size, "max_memory_bytes": self.max_memory_bytes,
            "max_queue_files": self.max_queue_files, "room_ttl_seconds": self.room_ttl_seconds,
            "public_url": self.public_url or None,
        }
