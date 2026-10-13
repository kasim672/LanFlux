"""Behavior/security tests for ephemeral discovery. File bytes never enter this API."""

import asyncio
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from lanflux.config import Settings
from lanflux.main import create_app
from lanflux.rooms import RateLimiter, RoomManager, ROOM_ALPHABET

HEADERS = {"origin": "http://testserver"}


@pytest.fixture
def client():
    with TestClient(create_app(Settings())) as test_client:
        yield test_client


def make_room(client):
    response = client.post("/api/rooms", headers=HEADERS)
    assert response.status_code == 201
    return response.json()["room_id"]


def ws(client, room, name="Browser"):
    return client.websocket_connect(f"/ws/{room}?name={name}", headers=HEADERS)


def pair(client, room, first, second):
    first_message = first.receive_json()
    assert first_message["type"] == "peer-joined"
    assert second.receive_json()["type"] == "welcome"
    second_message = second.receive_json()
    assert second_message["type"] == "peer-joined"
    assert first_message["pair_id"] == second_message["pair_id"]
    return first_message["pair_id"]


def test_health_config_and_no_upload_routes(client):
    assert client.get("/health").json() == {"status": "ok", "service": "lanflux"}
    config = client.get("/api/config").json()
    assert config["max_file_size"] == 64 * 1024 * 1024
    assert config["max_memory_bytes"] == 128 * 1024 * 1024
    assert config["ice_servers"][0]["urls"][0].startswith("stun:")
    assert client.post("/uploadfile/", files={"file": ("test.txt", b"no storage")}).status_code == 404
    assert client.get("/downloadfile/anything").status_code == 404


def test_room_ids_are_secure_and_unique(client):
    rooms = {make_room(client) for _ in range(8)}
    assert len(rooms) == 8
    assert all(len(room) == 16 and set(room) <= set(ROOM_ALPHABET) for room in rooms)
    assert "expires_at" in client.post("/api/rooms", headers=HEADERS).json()


def test_signaling_pairing_and_bidirectional_ice(client):
    room = make_room(client)
    with ws(client, room, "Desktop") as first:
        welcome = first.receive_json()
        assert welcome["initiator"] is True
        with ws(client, room, "Phone") as second:
            assert second.receive_json()["initiator"] is False
            second_join = second.receive_json()
            first_join = first.receive_json()
            assert second_join["name"] == "Desktop"
            assert first_join["name"] == "Phone"
            pair_id = second_join["pair_id"]
            assert first_join["pair_id"] == pair_id
            first.send_json({"type": "offer", "sdp": "v=0\r\n", "pair_id": pair_id})
            assert second.receive_json() == {"type": "offer", "sdp": "v=0\r\n", "pair_id": pair_id}
            second.send_json({"type": "answer", "sdp": "v=0\r\n", "pair_id": pair_id})
            assert first.receive_json() == {"type": "answer", "sdp": "v=0\r\n", "pair_id": pair_id}
            second.send_json({"type": "ice", "pair_id": pair_id, "candidate": {"candidate": "candidate:1", "sdpMid": "0", "sdpMLineIndex": 0}})
            ice = first.receive_json()
            assert ice["candidate"]["candidate"] == "candidate:1"
            assert ice["candidate"]["sdpMLineIndex"] == 0
            first.send_json({"type": "ice", "candidate": None, "pair_id": pair_id})
            assert second.receive_json() == {"type": "ice", "candidate": None, "pair_id": pair_id}
            first.send_json({"type": "ping"})
            assert first.receive_json() == {"type": "pong"}


def test_third_peer_rejected_and_replacement_roles(client):
    room = make_room(client)
    with ws(client, room, "First") as first:
        assert first.receive_json()["initiator"] is True
        with ws(client, room, "Second") as second:
            pair(client, room, first, second)
            with ws(client, room, "Third") as third:
                assert third.receive_json()["code"] == "room-full"
            first.close()
            assert second.receive_json() == {"type": "peer-left", "initiator": True}
            with ws(client, room, "Replacement") as replacement:
                assert replacement.receive_json()["initiator"] is False
                assert replacement.receive_json()["name"] == "Second"
                join_message = second.receive_json()
                assert join_message["name"] == "Replacement"
                second.send_json({"type": "offer", "sdp": "replacement", "pair_id": join_message["pair_id"]})
                assert replacement.receive_json()["sdp"] == "replacement"


@pytest.mark.parametrize("payload", [
    {"type": "upload", "file": "data"},
    {"type": "offer", "sdp": "valid", "filename": "ignored?"},
    {"type": "offer", "sdp": 42},
    {"type": "offer", "sdp": ""},
    {"type": "ice", "candidate": {"candidate": "c", "sdpMLineIndex": -1}},
    {"type": "ice", "candidate": {"candidate": "c", "sdpMLineIndex": True}},
    {"type": "ice", "candidate": {"candidate": "c", "extra": "field"}},
    {"type": "ping", "extra": "field"},
    [],
])
def test_invalid_signals_rejected(client, payload):
    room = make_room(client)
    with ws(client, room) as peer:
        peer.receive_json()
        if isinstance(payload, dict) and payload.get("type") in {"offer", "answer", "ice"}:
            payload = {**payload, "pair_id": "a" * 24}
        peer.send_json(payload)
        assert peer.receive_json()["code"] == "invalid-message"
        with pytest.raises(WebSocketDisconnect):
            peer.receive_json()


def test_invalid_json_binary_and_oversized_messages(client):
    for payload, code in [("{bad", "invalid-message"), (b"file bytes", "invalid-message"), ("x" * 65537, "message-too-large")]:
        with ws(client, make_room(client)) as peer:
            peer.receive_json()
            peer.send_bytes(payload) if isinstance(payload, bytes) else peer.send_text(payload)
            assert peer.receive_json()["code"] == code


def test_unknown_room_and_bad_name(client):
    with ws(client, "A" * 16) as peer:
        assert peer.receive_json()["code"] == "room-not-found"
    with ws(client, "short") as peer:
        assert peer.receive_json()["code"] == "invalid-room"
    with ws(client, make_room(client), "x" * 49) as peer:
        assert peer.receive_json()["code"] == "invalid-room"


def test_origin_validation(client):
    assert client.post("/api/rooms", headers={"origin": "https://attacker.example"}).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/{make_room(client)}", headers={"origin": "https://attacker.example"}):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/{make_room(client)}"):
            pass


def test_allowed_origin_and_public_url():
    config = replace(Settings(), allowed_origins=("https://trusted.example",), public_url="https://lanflux.example")
    with TestClient(create_app(config)) as client:
        response = client.post("/api/rooms", headers={"origin": "https://trusted.example"})
        assert response.status_code == 201
        room = response.json()["room_id"]
        assert client.get(f"/api/rooms/{room}/qr?url=https://lanflux.example/?room={room}").status_code == 200


def test_qr_scope_and_security_headers(client):
    room = make_room(client)
    response = client.get(f"/api/rooms/{room}/qr?url=http://testserver/?room={room}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert "<svg" in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.get(f"/api/rooms/{room}/qr?url=https://evil.example").status_code == 400
    assert client.get(f"/api/rooms/{'A' * 16}/qr").status_code == 404
    assert client.get("/static/../../app.py").status_code == 404


def test_room_creation_capacity_and_rate_limits():
    with TestClient(create_app(replace(Settings(), max_rooms=1))) as client:
        make_room(client)
        assert client.post("/api/rooms", headers=HEADERS).status_code == 503
    with TestClient(create_app(replace(Settings(), room_rate_limit=1))) as client:
        make_room(client)
        response = client.post("/api/rooms", headers=HEADERS)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"


def test_failed_joins_are_rate_limited():
    with TestClient(create_app(replace(Settings(), join_rate_limit=1))) as client:
        with ws(client, "A" * 16) as peer:
            assert peer.receive_json()["code"] == "room-not-found"
        with ws(client, "A" * 16) as peer:
            assert peer.receive_json()["code"] == "rate-limit"


def test_global_peer_capacity_and_disconnect_cleanup():
    with TestClient(create_app(replace(Settings(), max_peers=2))) as client:
        room, other_room = make_room(client), make_room(client)
        with ws(client, room) as first:
            first.receive_json()
            with ws(client, room) as second:
                pair(client, room, first, second)
                with ws(client, other_room) as third:
                    assert third.receive_json()["code"] == "capacity"
        manager = client.app.state.rooms
        assert manager.peer_count == 0
        assert manager.rooms[room].peers == []
        assert manager.rooms[room].expires_at <= time.time() + 60
        assert manager.rooms[other_room].expires_at > time.time() + 3000


def test_signal_rate_and_roles():
    with TestClient(create_app(replace(Settings(), signal_rate_limit=1))) as client:
        with ws(client, make_room(client)) as peer:
            peer.receive_json()
            peer.send_json({"type": "ping"})
            assert peer.receive_json()["type"] == "pong"
            peer.send_json({"type": "ping"})
            assert peer.receive_json()["code"] == "rate-limit"
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first:
            first.receive_json()
            with ws(client, room) as second:
                pair_id = pair(client, room, first, second)
                second.send_json({"type": "offer", "sdp": "unexpected", "pair_id": pair_id})
                assert second.receive_json()["code"] == "invalid-role"


def test_live_room_expiry_and_cleanup():
    with TestClient(create_app(replace(Settings(), cleanup_interval_seconds=0.01))) as client:
        room = make_room(client)
        with ws(client, room) as peer:
            peer.receive_json()
            client.app.state.rooms.rooms[room].expires_at = time.time() - 1
            assert peer.receive_json() == {"type": "room-expired"}
            with pytest.raises(WebSocketDisconnect):
                peer.receive_json()
        assert room not in client.app.state.rooms.rooms
        assert client.app.state.rooms.peer_count == 0


def test_room_manager_empty_cleanup_and_limiter_bounds():
    async def scenario():
        manager = RoomManager(Settings())
        room = await manager.create()
        room.expires_at = time.time() - 1
        await manager.expire()
        assert manager.rooms == {}
    asyncio.run(scenario())
    limiter = RateLimiter(capacity=3)
    for number in range(10):
        assert limiter.allow(str(number), 1)
    assert len(limiter.buckets) == 3
    assert not limiter.allow("9", 1)


def test_configuration_validation(monkeypatch):
    monkeypatch.setenv("LANFLUX_ICE_TRANSPORT_POLICY", "relay")
    with pytest.raises(ValueError, match="TURN"):
        Settings.from_env()
    monkeypatch.setenv("LANFLUX_TURN_URLS", "turn:relay.example:3478")
    monkeypatch.setenv("LANFLUX_TURN_USERNAME", "test")
    monkeypatch.setenv("LANFLUX_TURN_CREDENTIAL", "temporary")
    settings = Settings.from_env()
    assert settings.browser_config()["ice_transport_policy"] == "relay"
    assert settings.browser_config()["ice_servers"][-1]["credential"] == "temporary"
    monkeypatch.setenv("LANFLUX_MAX_FILE_MIB", "65")
    with pytest.raises(ValueError, match="LANFLUX_MAX_FILE_MIB"):
        Settings.from_env()
