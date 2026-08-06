from __future__ import annotations

import socket
import subprocess
from urllib.parse import urlparse


def pin_hostname(hostname: str, *, port: int = 443) -> str | None:
    """Ensure hostname resolves inside flaky Docker DNS by pinning /etc/hosts.

    Returns the IPv4 address used, or None if resolution failed.
    """
    host = (hostname or "").strip().rstrip(".")
    if not host:
        return None

    def _ipv4_ok() -> str | None:
        try:
            infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
            if infos:
                return infos[0][4][0]
        except OSError:
            return None
        return None

    existing = _ipv4_ok()
    if existing:
        return existing

    ip: str | None = None
    for cmd in (
        ["getent", "ahostsv4", host],
        ["getent", "hosts", host],
    ):
        try:
            out = subprocess.check_output(cmd, text=True, timeout=5, stderr=subprocess.DEVNULL)
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            continue
        for line in out.splitlines():
            part = (line.split() or [""])[0]
            if part.count(".") == 3 and all(p.isdigit() and 0 <= int(p) <= 255 for p in part.split(".")):
                ip = part
                break
        if ip:
            break

    if not ip:
        # last resort: public DNS via dig if available on image (usually not)
        try:
            out = subprocess.check_output(
                ["dig", "+short", "A", host, "@8.8.8.8"],
                text=True,
                timeout=5,
                stderr=subprocess.DEVNULL,
            )
            for line in out.splitlines():
                part = line.strip()
                if part.count(".") == 3 and not part.endswith("."):
                    ip = part
                    break
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            pass

    if not ip:
        return None

    try:
        with open("/etc/hosts", encoding="utf-8") as fh:
            text = fh.read()
        marker = f" {host}"
        lines = [ln for ln in text.splitlines() if marker not in f" {ln}" and not ln.endswith(f" {host}")]
        lines = [ln for ln in text.splitlines() if not any(p == host for p in ln.split()[1:])]
        lines.append(f"{ip} {host}")
        with open("/etc/hosts", "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError:
        return ip

    return _ipv4_ok() or ip


def pin_url_host(url: str) -> str | None:
    host = urlparse(url).hostname
    if not host:
        return None
    return pin_hostname(host)
