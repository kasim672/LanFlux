"""Reverse proxy support keeps one private application worker and explicit trust."""
import argparse

import pytest

from lanflux.__main__ import main, proxy_ips


@pytest.mark.parametrize('value', ['*', '0.0.0.0/0', '10.0.0.0/8', 'proxy.example', '', '127.0.0.1,'])
def test_proxy_trust_rejects_wildcards_networks_and_invalid_addresses(value):
    with pytest.raises(argparse.ArgumentTypeError):
        proxy_ips(value)


def test_proxy_trust_normalizes_explicit_ips_only():
    assert proxy_ips('127.0.0.1, ::1, 192.168.1.2') == '127.0.0.1,::1,192.168.1.2'
    with pytest.raises(argparse.ArgumentTypeError):
        proxy_ips(','.join(['127.0.0.1'] * 17))


@pytest.mark.parametrize('options,expected', [
    ([], {'host': '127.0.0.1', 'proxy_headers': True, 'forwarded_allow_ips': '127.0.0.1,::1'}),
    (['--lan', '--no-proxy-headers'], {'host': '0.0.0.0', 'proxy_headers': False, 'forwarded_allow_ips': '127.0.0.1,::1'}),
    (['--forwarded-allow-ips', '192.168.1.2'], {'host': '127.0.0.1', 'proxy_headers': True, 'forwarded_allow_ips': '192.168.1.2'}),
])
def test_cli_preserves_one_worker_safe_logs_and_explicit_proxy_trust(monkeypatch, options, expected):
    captured = {}
    monkeypatch.setattr('sys.argv', ['lanflux', *options])
    monkeypatch.setattr('lanflux.__main__.uvicorn.run', lambda app, **kwargs: captured.update(kwargs))
    main()
    for key, value in expected.items():
        assert captured[key] == value
    assert captured['workers'] == 1
    assert captured['access_log'] is False
    assert captured['ws_max_size'] == 65536
    assert captured['log_config']['filters']['lanflux_safe']['()'] == 'lanflux.logging.SafeLogFilter'
