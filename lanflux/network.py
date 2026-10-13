"""Read local adapter configuration; never probe peers or execute user commands."""

import ipaddress
import json
import platform
import re
import socket
import struct
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .config import origin

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
VIRTUAL = re.compile(r'^(lo$|loopback|docker|br-|bridge|veth|virbr|vmnet|vbox|vethernet|virtual|tun|tap|utun|tailscale|wg\d|zt)|vmware|hyper-v|virtualbox', re.I)


@dataclass(frozen=True)
class Adapter:
    name: str
    address: str
    metric: int | None = None
    physical: bool = True
    up: bool = True


def choose_lan_ip(adapters: list[Adapter]) -> str | None:
    candidates = []
    for adapter in adapters:
        if not adapter.physical or not adapter.up or VIRTUAL.search(adapter.name):
            continue
        try:
            address = ipaddress.IPv4Address(adapter.address)
        except ipaddress.AddressValueError:
            continue
        if not any(address in network for network in PRIVATE_NETWORKS):
            continue
        candidates.append(adapter)
    candidates.sort(key=lambda item: (item.metric is None, item.metric or 0, not bool(re.search(r'wi-?fi|wlan|^wl', item.name, re.I)), item.name, item.address))
    return candidates[0].address if candidates else None


def _read(command: list[str], timeout: float = 3) -> str:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, check=False)
        return result.stdout if result.returncode == 0 and len(result.stdout) < 1024 * 1024 else ''
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return ''


def _linux_adapters() -> list[Adapter]:
    import fcntl

    metrics = {}
    for line in Path('/proc/net/route').read_text().splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 8 and fields[1] == '00000000' and fields[7] == '00000000' and int(fields[3], 16) & 1:
            metric = int(fields[6])
            metrics[fields[0]] = min(metric, metrics.get(fields[0], metric))
    adapters = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for _, name in socket.if_nameindex():
            if VIRTUAL.search(name) or not (Path('/sys/class/net') / name / 'device').exists():
                continue
            try:
                request = struct.pack('256s', name.encode()[:15])
                flags = struct.unpack_from('H', fcntl.ioctl(sock.fileno(), 0x8913, request), 16)[0]
                address = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, request)[20:24])
                adapters.append(Adapter(name, address, metrics.get(name), up=bool(flags & 1)))
            except OSError:
                continue
    return adapters


def _windows_adapters() -> list[Adapter]:
    # Static, read-only PowerShell command. No request or environment text interpolated.
    script = r"""
$ErrorActionPreference='Stop'
@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
  $adapter=$_
  $config=Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex
  $ipInterface=Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4
  $route=Get-NetRoute -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
  foreach ($ip in $config.IPv4Address) {
    [PSCustomObject]@{name=$adapter.Name;address=$ip.IPAddress;metric=$(if($route){[int]$route.RouteMetric+[int]$ipInterface.InterfaceMetric}else{$null})}
  }
}) | ConvertTo-Json -Compress
"""
    data = json.loads(_read(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], timeout=5) or '[]')
    if isinstance(data, dict):
        data = [data]
    return [Adapter(row['name'], row['address'], row.get('metric')) for row in data]


def _mac_adapters() -> list[Adapter]:
    ports = _read(['/usr/sbin/networksetup', '-listallhardwareports'])
    names = re.findall(r'^Device: ([A-Za-z0-9_.-]+)$', ports, re.M)
    route = _read(['/sbin/route', '-n', 'get', 'default'])
    match = re.search(r'^\s*interface:\s*(\S+)', route, re.M)
    default = match.group(1) if match else None
    names.sort(key=lambda name: name != default)
    return [Adapter(name, _read(['/usr/sbin/ipconfig', 'getifaddr', name]).strip(), 0 if name == default else None)
            for name in names[:4] if not VIRTUAL.search(name)]


def detect_lan_ip() -> str | None:
    readers = {'Linux': _linux_adapters, 'Windows': _windows_adapters, 'Darwin': _mac_adapters}
    reader = readers.get(platform.system())
    if not reader:
        return None
    try:
        return choose_lan_ip(reader())
    except (OSError, ValueError, TypeError, KeyError):
        # No guessed Docker/loopback address. Explicit PUBLIC_URL or request origin remains usable.
        return None


class LANDiscovery:
    """Small cache avoids repeated OS reads; new rooms follow changed LAN addresses."""
    def __init__(self):
        self._checked = float('-inf')
        self._address = None
        self._lock = threading.Lock()

    def address(self) -> str | None:
        with self._lock:
            if time.monotonic() - self._checked >= 30:
                self._address = detect_lan_ip()
                self._checked = time.monotonic()
            return self._address


def invitation_base(request_origin: str, public_url: str = '', lan_ip: str | None = None) -> str:
    if public_url:
        return origin(public_url)
    base = origin(request_origin)
    parsed = urlsplit(base)
    host = parsed.hostname
    loopback = host == 'localhost' or host.endswith('.localhost')
    try:
        address = ipaddress.ip_address(host)
        loopback = loopback or address.is_loopback or address.is_unspecified
    except ValueError:
        pass
    if loopback and lan_ip:
        suffix = f':{parsed.port}' if parsed.port else ''
        return origin(f'{parsed.scheme}://{lan_ip}{suffix}')
    return base
