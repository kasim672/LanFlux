"""Redact bearer room links and disable protocol frame dumps in server logs."""

import logging
import re


class SafeLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.name.startswith(("uvicorn", "websockets")) and record.levelno < logging.INFO:
            # WebSocket debug frames can contain SDP and ICE; never emit their bodies.
            return False
        if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
            args = list(record.args)
            args[2] = redact(str(args[2]))
            record.args = tuple(args)
            return True
        message = redact(record.getMessage())
        record.msg, record.args = message, ()
        return True


def redact(message: str) -> str:
    message = re.sub(r"(/(?:ws|api/rooms)/)[^/?\s\"']+", r"\1[room]", message)
    message = re.sub(r"\?[^\s\"']*", "?[redacted]", message)
    return message


def install_safe_logging() -> None:
    """Also protect the conventional `uvicorn lanflux.main:app` entry point."""
    for name in ("", "uvicorn", "uvicorn.access", "uvicorn.error", "uvicorn.asgi", "websockets", "websockets.server", "websockets.client"):
        logger = logging.getLogger(name)
        for target in (logger, *logger.handlers):
            if not any(isinstance(item, SafeLogFilter) for item in target.filters):
                target.addFilter(SafeLogFilter())
