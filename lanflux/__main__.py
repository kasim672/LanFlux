"""Run a single signaling process with safe logging and bounded WebSocket frames."""

import argparse
from copy import deepcopy
import ipaddress
from pathlib import Path

import uvicorn


def proxy_ips(value: str) -> str:
    """Allow only explicit reverse-proxy addresses to supply forwarded headers."""
    try:
        entries = value.split(',')
        if not entries or len(entries) > 16:
            raise ValueError
        return ','.join(str(ipaddress.ip_address(entry.strip())) for entry in entries)
    except ValueError:
        raise argparse.ArgumentTypeError('Trusted proxies must be explicit IP addresses; wildcards and networks are not allowed.') from None


def main() -> None:
    parser = argparse.ArgumentParser(description="LANFLUX browser file sharing")
    binding = parser.add_mutually_exclusive_group()
    binding.add_argument("--host", help="Explicit bind address")
    binding.add_argument("--lan", action="store_true", help="Bind all interfaces for trusted local-network use")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--env-file", default=None)
    parser.add_argument("--ssl-certfile")
    parser.add_argument("--ssl-keyfile")
    parser.add_argument("--forwarded-allow-ips", type=proxy_ips, default="127.0.0.1,::1",
                        help="Comma-separated exact trusted reverse-proxy IPs (default: loopback only)")
    parser.add_argument("--no-proxy-headers", action="store_true", help="Ignore forwarded client IP and scheme headers")
    args = parser.parse_args()
    log_config = deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["filters"] = {"lanflux_safe": {"()": "lanflux.logging.SafeLogFilter"}}
    for handler in log_config["handlers"].values():
        handler["filters"] = ["lanflux_safe"]
    uvicorn.run("lanflux.main:app", host=args.host or ("0.0.0.0" if args.lan else "127.0.0.1"), port=args.port, workers=1,
                ws_max_size=65536, ws_max_queue=16, log_config=log_config,
                access_log=False,
                proxy_headers=not args.no_proxy_headers,
                forwarded_allow_ips=args.forwarded_allow_ips,
                env_file=args.env_file or (".env" if Path(".env").is_file() else None),
                ssl_certfile=args.ssl_certfile, ssl_keyfile=args.ssl_keyfile)


if __name__ == "__main__":
    main()
