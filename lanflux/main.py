"""FastAPI signaling and static frontend. There are deliberately no upload routes."""

import asyncio
import contextlib
import io
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from aiml.api import attach_api

from . import __version__

from .config import Settings, origin, local_host
from .logging import install_safe_logging
from .network import LANDiscovery, invitation_base
from .rooms import Peer, RateLimiter, RoomError, RoomManager, ROOM_ALPHABET, ROOM_LENGTH
from .signals import signal_adapter

logger = logging.getLogger("lanflux")
STATIC_DIR = Path(__file__).parent / "static"
ROOM_PATTERN = re.compile(f"^[{ROOM_ALPHABET}]{{{ROOM_LENGTH}}}$")
MAX_SIGNAL_BYTES = 64 * 1024


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate signaling field")
        result[key] = value
    return result


def expires_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def create_app(settings: Settings | None = None) -> FastAPI:
    install_safe_logging()
    settings = settings or Settings.from_env()
    manager = RoomManager(settings)
    limiter = RateLimiter()
    discovery = LANDiscovery()

    async def base_url(connection: Request | WebSocket) -> str:
        scheme = connection.url.scheme.replace("wss", "https").replace("ws", "http")
        request_origin = f"{scheme}://{connection.headers['host']}"
        if settings.public_url:
            return invitation_base(request_origin, settings.public_url)
        address = await asyncio.to_thread(discovery.address)
        return invitation_base(request_origin, settings.public_url, address)

    async def sweep() -> None:
        while True:
            await asyncio.sleep(settings.cleanup_interval_seconds)
            await manager.expire()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        task = asyncio.create_task(sweep())
        logger.info("LANFLUX signaling ready; one process, rooms expire after %s seconds", settings.room_ttl_seconds)
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            for room in manager.rooms.values():
                room.expires_at = 0
            await manager.expire()

    app = FastAPI(title="LANFLUX", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.rooms = manager
    app.state.settings = settings
    app.state.limiter = limiter

    def same_origin(connection: Request | WebSocket, required: bool = False) -> bool:
        headers = connection.headers.getlist("origin")
        if not headers:
            return not required
        if len(headers) != 1:
            return False
        try:
            normalized = origin(headers[0])
            scheme = connection.url.scheme.replace("wss", "https").replace("ws", "http")
            expected = origin(f"{scheme}://{connection.headers['host']}")
            allowed = {*(origin(value) for value in settings.allowed_origins), expected}
            if settings.public_url:
                allowed.add(settings.public_url)
            return normalized in allowed
        except ValueError:
            return False

    def trusted_host(connection: Request | WebSocket) -> bool:
        hosts = connection.headers.getlist("host")
        if len(hosts) != 1:
            return False
        try:
            normalized = origin(f"http://{hosts[0]}")
            hostname = urlsplit(normalized).hostname
            trusted = set(settings.trusted_hosts)
            for value in (*settings.allowed_origins, settings.public_url):
                if value:
                    trusted.add(urlsplit(origin(value)).hostname)
            return hostname in trusted or local_host(hostname)
        except (ValueError, UnicodeError):
            return False

    def client_ip(connection: Request | WebSocket) -> str:
        # Never trust an arbitrary X-Forwarded-For header; Uvicorn handles trusted proxies.
        return connection.client.host if connection.client else "unknown"

    attach_api(app, manager, limiter, same_origin, client_ip, unique_object)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        if not trusted_host(request):
            return Response("Untrusted Host header", status_code=400)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: blob:; connect-src 'self' ws: wss:; "
            "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": "lanflux"}

    @app.get("/api/config")
    async def config(request: Request):
        return {**settings.browser_config(), "invitation_base_url": await base_url(request)}

    @app.post("/api/rooms", status_code=201)
    async def create_room(request: Request):
        if not limiter.allow(f"create:{client_ip(request)}", settings.room_rate_limit):
            raise HTTPException(429, "Too many room requests. Wait a minute and try again.", headers={"Retry-After": "60"})
        if not same_origin(request):
            raise HTTPException(403, "Open LANFLUX from the same website to create a room.")
        try:
            room = await manager.create(await base_url(request))
        except RoomError as exc:
            raise HTTPException(503, exc.message) from exc
        return {"room_id": room.room_id, "expires_at": expires_iso(room.expires_at), "invitation_url": room.invitation_url}

    @app.get("/api/rooms/{room_id}/qr")
    @app.get("/api/rooms/{room_id}/qr.svg")
    async def qr(room_id: str, request: Request, url: str | None = None):
        if not limiter.allow(f"qr:{client_ip(request)}", 60):
            raise HTTPException(429, "Too many QR requests. Please wait a minute.")
        room = manager.rooms.get(room_id)
        if not ROOM_PATTERN.fullmatch(room_id) or not room or room.expires_at <= time.time():
            raise HTTPException(404, "This room has expired or does not exist.")
        invitation = room.invitation_url or f"{await base_url(request)}/?room={room_id}"
        if url is not None and url != invitation:
            raise HTTPException(400, "QR URL must match this room's invitation URL.")
        qr_image = qrcode.make(invitation, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=3)
        buffer = io.BytesIO()
        qr_image.save(buffer)
        return Response(buffer.getvalue(), media_type="image/svg+xml")

    async def error(websocket: WebSocket, code: str, message: str, close_code: int = 1008):
        try:
            await asyncio.wait_for(websocket.send_json({"type": "error", "code": code, "message": message}), 5)
            await asyncio.wait_for(websocket.close(code=close_code), 2)
        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
            pass

    @app.websocket("/ws/{room_id}")
    async def signaling(websocket: WebSocket, room_id: str):
        allowed_attempt = limiter.allow(f"join:{client_ip(websocket)}", settings.join_rate_limit)
        if not trusted_host(websocket) or not same_origin(websocket, required=True):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        if not allowed_attempt:
            await error(websocket, "rate-limit", "Too many connection attempts. Wait a minute before trying again.")
            return
        name = websocket.query_params.get("name", "Browser")
        if not ROOM_PATTERN.fullmatch(room_id) or not name or len(name) > 48 or any(ord(c) < 32 for c in name):
            await error(websocket, "invalid-room", "Use a valid room code and a device name of 1–48 characters.")
            return
        peer = Peer(websocket, name)
        try:
            room, other = await manager.join(room_id, peer)
        except RoomError as exc:
            await error(websocket, exc.code, exc.message)
            return
        try:
            if not await peer.send({"type": "welcome", "peer_id": peer.peer_id, "initiator": other is None,
                                    "room_id": room_id, "expires_at": expires_iso(room.expires_at),
                                    "telemetry_token": peer.telemetry_token,
                                    "invitation_url": room.invitation_url or f"{await base_url(websocket)}/?room={room_id}"}):
                return
            if other:
                if not await peer.send({"type": "peer-joined", "name": other.name, "pair_id": room.pair_id}):
                    return
                if not await other.send({"type": "peer-joined", "name": peer.name, "pair_id": room.pair_id}):
                    await manager.leave(room_id, other)
                    await other.close()
            peer_limiter = RateLimiter(capacity=1)
            while True:
                try:
                    raw = await asyncio.wait_for(websocket.receive(), settings.peer_idle_timeout_seconds)
                except asyncio.TimeoutError:
                    await error(websocket, "idle-timeout", "This device went idle. Rejoin the room to continue.")
                    break
                if raw["type"] == "websocket.disconnect":
                    break
                text = raw.get("text")
                if text is None:
                    await error(websocket, "invalid-message", "Only text signaling messages are allowed.", 1003)
                    break
                if len(text.encode("utf-8")) > MAX_SIGNAL_BYTES:
                    await error(websocket, "message-too-large", "Signaling message exceeded the safety limit.", 1009)
                    break
                if not peer_limiter.allow("signals", settings.signal_rate_limit):
                    await error(websocket, "rate-limit", "Signaling is too busy. Rejoin the room in a minute.")
                    break
                try:
                    message = signal_adapter.validate_python(json.loads(text, object_pairs_hook=unique_object))
                except (json.JSONDecodeError, ValidationError, ValueError, RecursionError):
                    await error(websocket, "invalid-message", "This browser sent an invalid signaling message. Please rejoin.")
                    break
                if message.type == "ping":
                    if not await peer.send({"type": "pong"}):
                        break
                    continue
                try:
                    await manager.relay(room_id, peer, message.model_dump())
                except RoomError as exc:
                    if exc.code == "peer-unavailable":
                        if not await peer.send({"type": "error", "code": exc.code, "message": exc.message}):
                            break
                        continue
                    await error(websocket, exc.code, exc.message)
                    break
        except (WebSocketDisconnect, RuntimeError, OSError):
            logger.info("Browser disconnected from signaling")
        finally:
            await manager.leave(room_id, peer)
            await peer.close()

    @app.get("/")
    async def frontend():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
