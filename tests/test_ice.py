"""ICE syntax and room-gated TURN credentials; no live relay is needed here."""

from dataclasses import replace
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import lanflux.config as config_module
from lanflux.config import Settings, ice_url
from lanflux.main import create_app
from lanflux.turn import temporary_credentials
from test_signaling import make_room, ws

SECRET = "0123456789abcdef0123456789abcdef"
PEER = "abcdef012345abcdef012345"


@pytest.mark.parametrize(("value", "is_turn", "expected"), [
    ("stun:stun.example:3478", False, "stun:stun.example:3478"),
    ("STUN:STUN.Example", False, "stun:stun.example"),
    ("stuns:stun.example:5349", False, "stuns:stun.example:5349"),
    ("stun:192.168.1.2:3478", False, "stun:192.168.1.2:3478"),
    ("turn:relay.example:3478?transport=udp", True, "turn:relay.example:3478?transport=udp"),
    ("turn:relay.example:3478?transport=tcp", True, "turn:relay.example:3478?transport=tcp"),
    ("turns:relay.example:443?transport=tcp", True, "turns:relay.example:443?transport=tcp"),
    ("turns:relay.example:443", True, "turns:relay.example:443"),
    ("turns:[2001:0db8::1]:443?transport=tcp", True, "turns:[2001:db8::1]:443?transport=tcp"),
    ("turn:[::1]:3478", True, "turn:[::1]:3478"),
])
def test_ice_uri_validated_and_normalized(value, is_turn, expected):
    assert ice_url(value, turn=is_turn) == expected


@pytest.mark.parametrize("value", [
    "https://relay.example", "turn://relay.example", "turn:relay.example/path",
    "turn:user:password@relay.example", "turn:relay.example#fragment", "turn:relay.example?",
    "turn:relay.example?transport=ws", "turn:relay.example?transport=tcp&token=secret",
    "turn:relay.example?transport=tcp&transport=udp", "turns:relay.example?transport=udp",
    "turn:relay.example:0", "turn:relay.example:65536", "turn:relay.example:-1",
    "turn:relay.example:", "turn:", "turn:evil.example\n", "turn:evil example",
    "turn:relay.example\\evil", "turn:relay.example%2fpath", "turn:[::1%eth0]:443",
    "turn:[not-ipv6]:443", "turn:::1:443", "turn:999.1.1.1:3478",
    "turn:relay..example", "turn:[::1]evil.example:443", "stun:stun.example:3478",
])
def test_invalid_turn_uri_rejected(value):
    with pytest.raises(ValueError):
        ice_url(value, turn=True)


@pytest.mark.parametrize("value", ["stun:example?transport=tcp", "stuns:example?transport=udp", "turn:example", "stun:example/"])
def test_invalid_stun_uri_rejected(value):
    with pytest.raises(ValueError):
        ice_url(value)


def test_coturn_rest_known_vector_and_identity():
    username, credential, expires = temporary_credentials(SECRET, PEER, 600, now=1700000000)
    assert username == "1700000600:abcdef012345abcdef012345"
    assert credential == "KM9fJiVpVgzv76uBe+eCPDfT6GY="
    assert expires == 1700000600
    assert temporary_credentials(SECRET, "123456abcdef123456abcdef", 600, now=1700000000)[1] != credential
    assert temporary_credentials(SECRET, PEER, 600, now=1700000001)[1] != credential
    with pytest.raises(ValueError, match="identity"):
        temporary_credentials(SECRET, "room-code:not-an-identity", 600)


@pytest.fixture
def clean_ice_env(monkeypatch):
    for name in ("LANFLUX_STUN_URLS", "LANFLUX_TURN_URLS", "LANFLUX_TURN_USERNAME",
                 "LANFLUX_TURN_CREDENTIAL", "LANFLUX_TURN_SHARED_SECRET",
                 "LANFLUX_TURN_CREDENTIAL_TTL_SECONDS", "LANFLUX_ICE_TRANSPORT_POLICY"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_rest_environment_defaults_and_secret_privacy(clean_ice_env):
    clean_ice_env.setenv("LANFLUX_TURN_URLS", "turns:RELAY.example:443?transport=tcp")
    clean_ice_env.setenv("LANFLUX_TURN_SHARED_SECRET", SECRET)
    settings = Settings.from_env()
    assert settings.ice_transport_policy == "all"
    assert settings.turn_credential_ttl_seconds == 600
    assert settings.turn_urls == ("turns:relay.example:443?transport=tcp",)
    assert settings.browser_config(public=True)["turn_tls_443_available"] is True
    assert SECRET not in repr(settings)
    assert SECRET not in str(settings.browser_config())
    assert settings.peer_ice_config(PEER)["ice_servers"][-1]["username"].endswith(PEER)


@pytest.mark.parametrize("updates", [
    {"LANFLUX_TURN_URLS": "turn:relay.example"},
    {"LANFLUX_TURN_SHARED_SECRET": SECRET},
    {"LANFLUX_TURN_URLS": "turn:relay.example", "LANFLUX_TURN_SHARED_SECRET": "too-short"},
    {"LANFLUX_TURN_URLS": "turn:relay.example", "LANFLUX_TURN_SHARED_SECRET": SECRET,
     "LANFLUX_TURN_USERNAME": "mixed", "LANFLUX_TURN_CREDENTIAL": "mixed"},
    {"LANFLUX_TURN_CREDENTIAL_TTL_SECONDS": "59"},
    {"LANFLUX_TURN_CREDENTIAL_TTL_SECONDS": "3601"},
    {"LANFLUX_TURN_URLS": "turn:relay.example", "LANFLUX_TURN_USERNAME": "test",
     "LANFLUX_TURN_CREDENTIAL": "contains\ncontrol"},
])
def test_invalid_turn_modes_fail_without_echoing_credentials(clean_ice_env, updates):
    for name, value in updates.items():
        clean_ice_env.setenv(name, value)
    with pytest.raises(ValueError) as caught:
        Settings.from_env()
    assert SECRET not in str(caught.value)
    assert "contains\ncontrol" not in str(caught.value)


def test_ice_resource_bounds_and_duplicates():
    with pytest.raises(ValueError, match="Duplicate"):
        replace(Settings(), stun_urls=("stun:EXAMPLE:3478", "stun:example:3478"))
    with pytest.raises(ValueError, match="16"):
        replace(Settings(), stun_urls=tuple(f"stun:server{i}.example" for i in range(17)))


def test_public_api_never_returns_static_turn_password():
    settings = replace(Settings(), turn_urls=("turns:relay.example:443?transport=tcp",),
                       turn_username="private-user", turn_credential="private-password")
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/config")
        config = response.json()
        assert response.headers["cache-control"] == "no-store"
        assert config["turn_configured"] and config["turn_tls_443_available"]
        assert all("credential" not in server for server in config["ice_servers"])
        assert "private-password" not in response.text and "private-user" not in response.text
        with ws(client, make_room(client)) as peer:
            welcome = peer.receive_json()
            assert welcome["ice_servers"][-1]["credential"] == "private-password"
            assert welcome["ice_expires_at"] is None
        assert settings.browser_config()["ice_servers"][-1]["credential"] == "private-password"
    assert "private-password" not in repr(settings)


def test_room_gate_and_replacement_refresh_rest_credentials(monkeypatch):
    settings = replace(Settings(), turn_urls=("turns:relay.example:443?transport=tcp",),
                       turn_shared_secret=SECRET)
    clock = [1700000000]
    monkeypatch.setattr(config_module, "temporary_credentials",
                        lambda secret, peer_id, ttl: temporary_credentials(secret, peer_id, ttl, now=clock[0]))
    with TestClient(create_app(settings)) as client:
        config = client.get("/api/config")
        assert SECRET not in config.text and "credential" not in config.text
        room = make_room(client)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/{room}", headers={"origin": "https://evil.example"}):
                pass
        with ws(client, "A" * 16) as invalid:
            error = invalid.receive_json()
            assert error["type"] == "error" and "ice_servers" not in error
        with ws(client, room, "Host") as first:
            welcome = first.receive_json()
            assert welcome["ice_servers"][-1]["username"] == f"1700000600:{welcome['peer_id']}"
            assert SECRET not in str(welcome)
            # The host's original credentials expire while waiting for a guest.
            clock[0] += 700
            with ws(client, room, "Guest") as second:
                guest_welcome = second.receive_json()
                guest_joined = second.receive_json()
                host_joined = first.receive_json()
                assert host_joined["type"] == guest_joined["type"] == "peer-joined"
                assert host_joined["ice_servers"][-1]["username"] == f"1700001300:{welcome['peer_id']}"
                assert guest_joined["ice_servers"][-1]["username"].endswith(guest_welcome["peer_id"])
                assert datetime.fromisoformat(host_joined["ice_expires_at"]).timestamp() == 1700001300
                with ws(client, room, "Uninvited-third") as third:
                    error = third.receive_json()
                    assert error["code"] == "room-full" and "ice_servers" not in error
            assert first.receive_json()["type"] == "peer-left"
            clock[0] += 700
            with ws(client, room, "Replacement") as replacement:
                replacement.receive_json()
                replacement.receive_json()
                refreshed = first.receive_json()
                assert refreshed["ice_servers"][-1]["username"] == f"1700002000:{welcome['peer_id']}"
                assert refreshed["pair_id"] != host_joined["pair_id"]


def test_no_turn_config_and_explicit_relay_mode():
    config = Settings().browser_config(public=True)
    assert config["ice_transport_policy"] == "all"
    assert config["turn_configured"] is False
    assert config["turn_tls_443_available"] is False
    with pytest.raises(ValueError, match="TURN"):
        replace(Settings(), ice_transport_policy="relay")
    settings = replace(Settings(), turn_urls=("turn:relay.example",), turn_shared_secret=SECRET,
                       ice_transport_policy="relay")
    assert settings.peer_ice_config(PEER)["ice_transport_policy"] == "relay"
