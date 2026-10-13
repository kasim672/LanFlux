"""v0.2 origin, pairing, lifecycle and safe logging regression cases."""

import asyncio
import logging
from dataclasses import replace

import pytest
import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from uvicorn.logging import AccessFormatter

from lanflux.config import Settings, origin
from lanflux.logging import SafeLogFilter
from lanflux.main import create_app
from lanflux.rooms import Peer, RoomError, RoomManager
from test_signaling import HEADERS, make_room, pair, ws


@pytest.mark.parametrize(("value", "expected"), [
    ("HTTP://LOCALHOST:80", "http://localhost"),
    ("HTTPS://Example.COM:443", "https://example.com"),
    ("https://example.com:8443", "https://example.com:8443"),
    ("http://[0:0:0:0:0:0:0:1]:80", "http://[::1]"),
    ("http://[fd12:0000::1]:8000", "http://[fd12::1]:8000"),
])
def test_origin_canonicalization(value, expected):
    assert origin(value) == expected


@pytest.mark.parametrize("value", [
    "null", "*", "https://user:secret@example.com", "https://@example.com",
    "https://example.com/", "https://example.com/path", "https://example.com?secret=1",
    "https://example.com?", "https://example.com#", "https://example.com#fragment",
    "https://one.example https://two.example", "http://localhost:65536", "http://localhost:0",
    "http://local_host", "http://localhost\\evil", "http://[::1%lo]", "http://localhost\n",
    "http://localhost:", "http://[::1]:", "http://[::1]evil.example", "http://[::1]evil.example:80",
])
def test_malformed_origins_rejected(value):
    with pytest.raises(ValueError):
        origin(value)


def test_duplicate_origin_and_host_headers_rejected():
    with TestClient(create_app(Settings())) as client:
        origins = [("origin", "http://testserver"), ("origin", "http://testserver")]
        assert client.post("/api/rooms", headers=origins).status_code == 403
        assert client.get("/health", headers=[("host", "testserver"), ("host", "evil.example")]).status_code == 400
        room = make_room(client)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/{room}", headers=httpx.Headers(origins)):
                pass


@pytest.mark.parametrize("host", ["localhost", "192.168.1.40", "10.1.2.3", "127.0.0.1", "laptop.local", "laptop", "[fd00::2]"])
def test_local_origins_work_on_http(host):
    with TestClient(create_app(Settings()), base_url=f"http://{host}:8000") as client:
        response = client.post("/api/rooms", headers={"origin": f"http://{host}:8000"})
        assert response.status_code == 201
        with client.websocket_connect(f"ws://{host}:8000/ws/{response.json()['room_id']}", headers={"origin": f"http://{host}:8000"}) as peer:
            assert peer.receive_json()["type"] == "welcome"


def test_dns_rebinding_host_and_untrusted_origins_rejected():
    with TestClient(create_app(Settings()), base_url="http://attacker.example:8000") as client:
        assert client.get("/health").status_code == 400
        assert client.post("/api/rooms", headers={"origin": "http://attacker.example:8000"}).status_code == 400
    with TestClient(create_app(replace(Settings(), trusted_hosts=("lanflux.test",))), base_url="http://lanflux.test") as client:
        response = client.post("/api/rooms", headers={"origin": "HTTP://LANFLUX.TEST:80"})
        assert response.status_code == 201
        room = response.json()["room_id"]
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/{room}", headers={"origin": "https://lanflux.test"}):
                pass


def test_explicit_trusted_https_origin_normalizes_ports():
    settings = replace(Settings(), allowed_origins=("https://TRUSTED.example:443",))
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/rooms", headers={"origin": "https://trusted.example"}).status_code == 201


@pytest.mark.parametrize("case", ["repeat-offer", "answer-before-offer", "repeat-answer", "wrong-answer-role", "stale-pair"])
def test_negotiation_transitions_reject_invalid_order(case):
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first:
            first.receive_json()
            with ws(client, room) as second:
                pair_id = pair(client, room, first, second)
                offer = {"type": "offer", "sdp": "v=0", "pair_id": pair_id}
                answer = {"type": "answer", "sdp": "v=0", "pair_id": pair_id}
                if case in {"repeat-offer", "repeat-answer"}:
                    first.send_json(offer)
                    assert second.receive_json()["type"] == "offer"
                if case == "repeat-answer":
                    second.send_json(answer)
                    assert first.receive_json()["type"] == "answer"
                if case == "repeat-offer":
                    first.send_json(offer)
                    assert first.receive_json()["code"] == "invalid-state"
                elif case in {"answer-before-offer", "repeat-answer"}:
                    second.send_json(answer)
                    assert second.receive_json()["code"] == "invalid-state"
                elif case == "wrong-answer-role":
                    first.send_json(answer)
                    assert first.receive_json()["code"] == "invalid-role"
                else:
                    first.send_json({**offer, "pair_id": "a" * 24})
                    assert first.receive_json()["code"] == "stale-pair"


def test_trickle_ice_before_offer_and_pair_reset():
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        with ws(client, room) as first:
            first.receive_json()
            with ws(client, room) as second:
                old_pair = pair(client, room, first, second)
                first.send_json({"type": "ice", "candidate": {}, "pair_id": old_pair})
                assert second.receive_json()["candidate"]["candidate"] == ""
                first.send_json({"type": "offer", "sdp": "v=0", "pair_id": old_pair})
                second.receive_json()
            assert first.receive_json()["type"] == "peer-left"
            with ws(client, room) as replacement:
                new_pair = pair(client, room, first, replacement)
                assert new_pair != old_pair
                first.send_json({"type": "offer", "sdp": "replacement", "pair_id": new_pair})
                assert replacement.receive_json()["sdp"] == "replacement"
                replacement.send_json({"type": "ice", "candidate": None, "pair_id": old_pair})
                assert replacement.receive_json()["code"] == "stale-pair"


def test_duplicate_signal_keys_rejected():
    with TestClient(create_app(Settings())) as client:
        with ws(client, make_room(client)) as peer:
            peer.receive_json()
            peer.send_text('{"type":"ping","type":"ping"}')
            assert peer.receive_json()["code"] == "invalid-message"


def test_silent_websocket_times_out_and_cleans_room():
    settings = replace(Settings(), peer_idle_timeout_seconds=0.08)
    with TestClient(create_app(settings)) as client:
        room = make_room(client)
        with ws(client, room) as peer:
            peer.receive_json()
            assert peer.receive_json()["code"] == "idle-timeout"
            with pytest.raises(WebSocketDisconnect):
                peer.receive_json()
        assert client.app.state.rooms.peer_count == 0
        assert client.app.state.rooms.rooms[room].peers == []


def test_failed_relay_cleans_dead_peer_once():
    class Socket:
        def __init__(self, fail=False):
            self.fail = fail
            self.messages = []
            self.closes = 0

        async def send_json(self, message):
            if self.fail:
                raise OSError("simulated socket disconnect")
            self.messages.append(message)

        async def close(self, **kwargs):
            self.closes += 1

    async def scenario():
        manager = RoomManager(Settings())
        room = await manager.create()
        first, second = Peer(Socket(), "First"), Peer(Socket(fail=True), "Second")
        await manager.join(room.room_id, first)
        await manager.join(room.room_id, second)
        with pytest.raises(RoomError) as result:
            await manager.relay(room.room_id, first, {"type": "offer", "sdp": "v=0", "pair_id": room.pair_id})
        assert result.value.code == "peer-unavailable"
        assert manager.peer_count == 1
        assert first.websocket.messages == [{"type": "peer-left", "initiator": True}]
        assert room.pair_id is None and room.negotiation_state == "waiting"
        await manager.leave(room.room_id, second)
        await second.close()
        assert second.websocket.closes == 1
        assert len(first.websocket.messages) == 1
        with pytest.raises(RoomError):
            await manager.relay(room.room_id, second, {"type": "offer", "sdp": "v=0", "pair_id": "a" * 24})
    asyncio.run(scenario())


def test_safe_log_filter_redacts_room_query_and_preserves_access_formatter():
    log_filter = SafeLogFilter()
    code = "ABCDEFGH23456789"
    record = logging.LogRecord("uvicorn.error", logging.INFO, "", 0, '%s - "WebSocket %s" [accepted]',
                               ("client", f"/ws/{code}?name=private&credential=secret"), None)
    assert log_filter.filter(record)
    assert code not in record.getMessage()
    assert "secret" not in record.getMessage() and "private" not in record.getMessage()
    access = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                               ("client", "GET", f"/api/rooms/{code}/qr?url=secret", "1.1", 200), None)
    assert log_filter.filter(access)
    formatted = AccessFormatter('%(request_line)s %(status_code)s').format(access)
    assert code not in formatted and "secret" not in formatted
    debug = logging.LogRecord("uvicorn.error", logging.DEBUG, "", 0, "frame SDP secret", (), None)
    assert not log_filter.filter(debug)


def test_unauthorized_attempts_count_towards_rate_limit():
    with TestClient(create_app(replace(Settings(), join_rate_limit=1, room_rate_limit=1))) as client:
        # Invalid origin consumes the attempt budget before authorization is evaluated.
        assert client.post("/api/rooms", headers={"origin": "null"}).status_code == 403
        assert client.post("/api/rooms", headers=HEADERS).status_code == 429
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/{'A' * 16}", headers={"origin": "null"}):
                pass
        with ws(client, "A" * 16) as peer:
            assert peer.receive_json()["code"] == "rate-limit"
