"""Small authenticated metadata API, separate from the WebRTC transfer protocol."""

import asyncio
import json
import secrets
import time

from fastapi import HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .model import NetworkMonitor, Observation

MAX_BODY_BYTES = 2048
MAX_MONITORS = 32


class Identity(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    room_id: str = Field(pattern=r'^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$')
    peer_id: str = Field(pattern=r'^[a-f0-9]{24}$')


class SampleRequest(Identity):
    sample: Observation


def attach_api(app, manager, limiter, same_origin, client_ip, unique_object):
    workers = asyncio.Semaphore(2)

    async def authorize(request: Request, schema):
        if not same_origin(request, required=True):
            raise HTTPException(403, 'Network monitoring requires a trusted same-origin browser.')
        if not limiter.allow(f'aiml-ip:{client_ip(request)}', 180):
            raise HTTPException(429, 'Too many network monitoring requests. Wait a minute.')
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
            raise HTTPException(415, 'Network monitoring accepts JSON metadata only.')
        raw = bytearray()
        async for part in request.stream():
            if len(raw) + len(part) > MAX_BODY_BYTES:
                raise HTTPException(413, 'Network metadata exceeds the size limit.')
            raw.extend(part)
        try:
            payload = schema.model_validate(json.loads(raw, object_pairs_hook=unique_object))
        except (ValueError, ValidationError, RecursionError):
            raise HTTPException(422, 'Invalid network metadata.') from None
        room = manager.rooms.get(payload.room_id)
        peer = next((p for p in room.peers if p.peer_id == payload.peer_id), None) if room else None
        authorization = request.headers.getlist('authorization')
        token = authorization[0][7:] if len(authorization) == 1 and authorization[0].startswith('Bearer ') else ''
        if (not room or room.expires_at <= time.time() or not peer or peer.closed
                or not secrets.compare_digest(token.encode('utf-8'), peer.telemetry_token.encode('utf-8'))):
            raise HTTPException(403, 'This network monitoring session is unavailable. Rejoin the room.')
        if not room.pair_id or len(room.peers) != 2 or any(p.closed for p in room.peers):
            raise HTTPException(409, 'Connect both peers before collecting network measurements.')
        if not limiter.allow(f'aiml-peer:{peer.peer_id}', 90):
            raise HTTPException(429, 'Network monitoring is sampling too quickly.')
        if peer.aiml_lock.locked():
            raise HTTPException(409, 'A network monitoring request is already in progress.')
        if peer.aiml_pair != room.pair_id or peer.aiml_monitor is None:
            if peer.aiml_monitor is None and sum(p.aiml_monitor is not None for r in manager.rooms.values() for p in r.peers) >= MAX_MONITORS:
                raise HTTPException(503, 'The experimental network monitor is at capacity. File sharing remains available.')
            peer.aiml_pair = room.pair_id
            peer.aiml_monitor = NetworkMonitor()
        return payload, peer

    @app.post('/api/aiml/sample')
    async def sample(request: Request):
        payload, peer = await authorize(request, SampleRequest)
        monitor = peer.aiml_monitor
        async with peer.aiml_lock:
            async with workers:
                try:
                    return await asyncio.to_thread(monitor.add, payload.sample)
                except ValueError as exc:
                    raise HTTPException(429 if 'apart' in str(exc) else 422, str(exc)) from None

    @app.post('/api/aiml/reset')
    async def reset(request: Request):
        _, peer = await authorize(request, Identity)
        async with peer.aiml_lock:
            peer.aiml_monitor = NetworkMonitor()
            return peer.aiml_monitor.status(message='Baseline reset. Collecting new real measurements.')

    @app.post('/api/aiml/export')
    async def export(request: Request):
        _, peer = await authorize(request, Identity)
        async with peer.aiml_lock:
            return Response(peer.aiml_monitor.export_csv(), media_type='text/csv',
                            headers={'Content-Disposition': 'attachment; filename="lanflux-network.csv"'})
