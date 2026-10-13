"""Bounded, process-local room state and rate limits; use one Uvicorn worker."""

import asyncio
import secrets
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field

from fastapi import WebSocket, WebSocketDisconnect

from .config import Settings

ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_LENGTH = 16


class RoomError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message


class RateLimiter:
    """Rolling window with bounded IP storage and no persistent identifiers."""

    def __init__(self, capacity: int = 2048):
        self.capacity = capacity
        self.buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def allow(self, key: str, limit: int, window: float = 60) -> bool:
        now = time.monotonic()
        bucket = self.buckets.get(key)
        if bucket is None:
            if len(self.buckets) >= self.capacity:
                self.buckets.popitem(last=False)
            bucket = deque()
            self.buckets[key] = bucket
        self.buckets.move_to_end(key)
        while bucket and bucket[0] <= now - window:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


@dataclass
class Peer:
    websocket: WebSocket
    name: str
    peer_id: str = field(default_factory=lambda: secrets.token_hex(12))
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: bool = False

    async def send(self, message: dict) -> bool:
        if self.closed:
            return False
        try:
            async with self.send_lock:
                if self.closed:
                    return False
                await asyncio.wait_for(self.websocket.send_json(message), timeout=5)
            return True
        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
            return False

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        try:
            async with self.send_lock:
                await asyncio.wait_for(self.websocket.close(code=code, reason=reason), 2)
        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
            pass


@dataclass
class Room:
    room_id: str
    expires_at: float
    peers: list[Peer] = field(default_factory=list)
    pair_id: str | None = None
    negotiation_state: str = "waiting"


class RoomManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.rooms: dict[str, Room] = {}
        self.lock = asyncio.Lock()
        self.peer_count = 0

    async def create(self) -> Room:
        await self.expire()
        async with self.lock:
            if len(self.rooms) >= self.settings.max_rooms:
                raise RoomError("capacity", "The server is busy. Please try again in a minute.")
            while True:
                room_id = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(ROOM_LENGTH))
                if room_id not in self.rooms:
                    break
            room = Room(room_id, time.time() + self.settings.room_ttl_seconds)
            self.rooms[room_id] = room
            return room

    async def join(self, room_id: str, peer: Peer) -> tuple[Room, Peer | None]:
        async with self.lock:
            room = self.rooms.get(room_id)
            if not room or room.expires_at <= time.time():
                raise RoomError("room-not-found", "This room has expired or does not exist. Create a new room.")
            if len(room.peers) >= 2:
                raise RoomError("room-full", "This room already has two devices. Create another room.")
            if self.peer_count >= self.settings.max_peers:
                raise RoomError("capacity", "The server is busy. Please try again shortly.")
            other = room.peers[0] if room.peers else None
            room.peers.append(peer)
            self.peer_count += 1
            if other:
                room.pair_id = secrets.token_hex(12)
                room.negotiation_state = "ready"
            return room, other

    async def leave(self, room_id: str, peer: Peer) -> None:
        async with self.lock:
            room = self.rooms.get(room_id)
            if not room or peer not in room.peers:
                return
            room.peers.remove(peer)
            self.peer_count -= 1
            room.pair_id = None
            room.negotiation_state = "waiting"
            other = room.peers[0] if room.peers else None
            if not other:
                room.expires_at = min(room.expires_at, time.time() + self.settings.empty_room_grace_seconds)
        if other:
            if not await other.send({"type": "peer-left", "initiator": True}):
                await self.leave(room_id, other)
                await other.close()

    async def relay(self, room_id: str, peer: Peer, message: dict) -> None:
        """Atomically validate the pair/state, then send to that specific peer object."""
        async with self.lock:
            room = self.rooms.get(room_id)
            if not room or peer not in room.peers or room.expires_at <= time.time():
                raise RoomError("peer-unavailable", "This room is no longer connected. Please rejoin.")
            if len(room.peers) != 2:
                raise RoomError("peer-unavailable", "Wait for the other device to join.")
            if message["pair_id"] != room.pair_id:
                raise RoomError("stale-pair", "This connection has changed. Please rejoin the room.")
            initiator = room.peers[0] is peer
            kind = message["type"]
            if (kind == "offer" and not initiator) or (kind == "answer" and initiator):
                raise RoomError("invalid-role", "Signaling negotiation roles did not match. Please rejoin.")
            if kind == "offer":
                if room.negotiation_state != "ready":
                    raise RoomError("invalid-state", "A connection offer has already been sent. Please rejoin.")
                room.negotiation_state = "offered"
            elif kind == "answer":
                if room.negotiation_state != "offered":
                    raise RoomError("invalid-state", "There is no pending connection offer. Please rejoin.")
                room.negotiation_state = "answered"
            # ICE can arrive before offer emission because setLocalDescription starts gathering.
            target = next(p for p in room.peers if p is not peer)
        if not await target.send(message):
            await self.leave(room_id, target)
            await target.close()
            raise RoomError("peer-unavailable", "The other device disconnected. Ask them to rejoin.")

    async def target(self, room_id: str, peer: Peer) -> tuple[Peer | None, bool]:
        async with self.lock:
            room = self.rooms.get(room_id)
            if not room or peer not in room.peers or room.expires_at <= time.time():
                return None, False
            return next((p for p in room.peers if p is not peer), None), room.peers[0] is peer

    async def expire(self) -> None:
        async with self.lock:
            expired = [room for room in self.rooms.values() if room.expires_at <= time.time()]
            for room in expired:
                del self.rooms[room.room_id]
                self.peer_count -= len(room.peers)
        async def close_peer(peer: Peer) -> None:
            await peer.send({"type": "room-expired"})
            await peer.close(reason="Room expired")
        await asyncio.gather(*(close_peer(peer) for room in expired for peer in room.peers))
