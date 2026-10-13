"""LAN interface selection and one canonical invitation shared by HTTP/WS/QR."""
from dataclasses import replace
import json
import time

import pytest
from fastapi.testclient import TestClient

import lanflux.network as network
from lanflux.config import Settings
from lanflux.main import create_app
from lanflux.network import Adapter, choose_lan_ip, invitation_base
from test_signaling import make_room, ws


@pytest.mark.parametrize('name', ['docker0', 'br-deadbeef', 'vethabc', 'virbr0', 'VMware Network Adapter', 'VirtualBox Host-Only', 'vEthernet (Default Switch)', 'tun0', 'utun3', 'tailscale0', 'wg0', 'bridge0'])
def test_virtual_interfaces_never_chosen(name):
    assert choose_lan_ip([Adapter(name, '172.17.0.1', 0), Adapter('wlan0', '192.168.9.23', 100)]) == '192.168.9.23'


def test_active_physical_default_route_and_address_limits():
    assert choose_lan_ip([
        Adapter('eth0', '10.1.1.2', 0, physical=False),
        Adapter('wlan0', '192.168.9.23', 100), Adapter('enp1s0', '192.168.8.20', 50),
        Adapter('enp2s0', '192.168.7.20', 10, up=False),
    ]) == '192.168.8.20'
    for value in ['127.0.0.1', '0.0.0.0', '169.254.1.2', '8.8.8.8', '192.0.2.1', '::1', 'invalid']:
        assert choose_lan_ip([Adapter('wlan0', value)]) is None
    assert choose_lan_ip([Adapter('eth0', '10.0.0.1'), Adapter('wlan0', '192.168.9.23')]) == '192.168.9.23'


@pytest.mark.parametrize(('requested', 'public', 'lan', 'expected'), [
    ('http://localhost:8000', '', '192.168.9.23', 'http://192.168.9.23:8000'),
    ('http://127.0.0.1:8765', '', '192.168.9.23', 'http://192.168.9.23:8765'),
    ('https://[::1]:8443', '', '10.1.1.2', 'https://10.1.1.2:8443'),
    ('http://localhost', '', '192.168.9.23', 'http://192.168.9.23'),
    ('http://localhost:8000', 'https://share.example', '192.168.9.23', 'https://share.example'),
    ('http://localhost:8000', '', None, 'http://localhost:8000'),
    ('http://192.168.4.30:9000', '', '192.168.9.23', 'http://192.168.4.30:9000'),
    ('https://share.example', '', '192.168.9.23', 'https://share.example'),
])
def test_invitation_scheme_host_port_and_explicit_override(requested, public, lan, expected):
    assert invitation_base(requested, public, lan) == expected


def test_discovery_cache_refreshes_after_network_change(monkeypatch):
    clock = [0]
    found = ['192.168.9.23', '192.168.9.24']
    monkeypatch.setattr(network.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(network, 'detect_lan_ip', lambda: found.pop(0))
    discovery = network.LANDiscovery()
    assert discovery.address() == '192.168.9.23'
    clock[0] = 29
    assert discovery.address() == '192.168.9.23'
    clock[0] = 31
    assert discovery.address() == '192.168.9.24'


def test_unavailable_system_detection_has_safe_fallback(monkeypatch):
    monkeypatch.setattr(network.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(network, '_linux_adapters', lambda: (_ for _ in ()).throw(OSError('Unavailable')))
    assert network.detect_lan_ip() is None
    monkeypatch.setattr(network.platform, 'system', lambda: 'Unknown OS')
    assert network.detect_lan_ip() is None


def test_windows_and_mac_candidates_use_physical_configuration(monkeypatch):
    monkeypatch.setattr(network, '_read', lambda *args, **kwargs: json.dumps([
        {'name': 'Wi-Fi', 'address': '192.168.9.23', 'metric': 25},
        {'name': 'vEthernet (Default Switch)', 'address': '172.17.0.1', 'metric': 0},
    ]))
    assert choose_lan_ip(network._windows_adapters()) == '192.168.9.23'
    responses = {
        'networksetup': 'Hardware Port: Wi-Fi\nDevice: en1\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n\nHardware Port: Ethernet\nDevice: en0\n',
        'route': 'interface: en1\n', 'en1': '192.168.9.23\n', 'en0': '10.1.1.2\n',
    }
    monkeypatch.setattr(network, '_read', lambda command, **kw: responses.get(command[-1], responses.get(command[0].split('/')[-1], '')))
    assert choose_lan_ip(network._mac_adapters()) == '192.168.9.23'


def test_room_creation_welcome_config_and_qr_share_canonical_lan_url(monkeypatch):
    monkeypatch.setattr(network, 'detect_lan_ip', lambda: '192.168.9.23')
    import lanflux.main as main
    captured = []
    original = main.qrcode.make
    monkeypatch.setattr(main.qrcode, 'make', lambda value, **kwargs: (captured.append(value), original(value, **kwargs))[1])
    with TestClient(create_app(Settings()), base_url='http://localhost:9000') as client:
        assert client.get('/api/config').json()['invitation_base_url'] == 'http://192.168.9.23:9000'
        response = client.post('/api/rooms', headers={'origin': 'http://localhost:9000'})
        room = response.json()['room_id']
        invitation = f'http://192.168.9.23:9000/?room={room}'
        assert response.json()['invitation_url'] == invitation
        with client.websocket_connect(f'ws://localhost:9000/ws/{room}', headers={'origin':'http://localhost:9000'}) as peer:
            assert peer.receive_json()['invitation_url'] == invitation
            assert client.get(f'/api/rooms/{room}/qr', headers={'host': '192.168.9.23:9000'}).status_code == 200
            assert captured == [invitation]
            assert client.get(f'/api/rooms/{room}/qr', params={'url': invitation}).status_code == 200
            assert client.get(f'/api/rooms/{room}/qr', params={'url': f'http://localhost:9000/?room={room}'}).status_code == 400
        # The pinned room URL survives changed LAN selection and request origins.
        monkeypatch.setattr(network.LANDiscovery, 'address', lambda self: '10.1.1.2')
        assert client.get('/api/config').json()['invitation_base_url'] == 'http://10.1.1.2:9000'
        assert client.get(f'/api/rooms/{room}/qr').status_code == 200
        assert captured[-1] == invitation
        assert client.app.state.rooms.rooms[room].invitation_url == invitation


def test_public_url_works_without_interface_discovery(monkeypatch):
    monkeypatch.setattr(network, 'detect_lan_ip', lambda: (_ for _ in ()).throw(AssertionError('Should not detect')))
    with TestClient(create_app(replace(Settings(), public_url='https://share.example'))) as client:
        assert client.get('/api/config').json()['invitation_base_url'] == 'https://share.example'
        response = client.post('/api/rooms')
        assert response.json()['invitation_url'] == f'https://share.example/?room={response.json()["room_id"]}'


def test_expired_invitation_cannot_generate_qr_or_join():
    with TestClient(create_app(Settings())) as client:
        room = make_room(client)
        client.app.state.rooms.rooms[room].expires_at = time.time() - 1
        assert client.get(f'/api/rooms/{room}/qr').status_code == 404
        with ws(client, room) as peer:
            assert peer.receive_json()['code'] == 'room-not-found'
        assert client.app.state.rooms.peer_count == 0
