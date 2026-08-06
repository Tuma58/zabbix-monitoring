from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from app.scan import _probe_snmp


PRIVATE_HINT = re.compile(
    r"^(?:10\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)"
)


def _host_allowed(host: str, allowlist: list[str], known_hosts: set[str] | None = None) -> bool:
    h = (host or "").strip().lower()
    if not h:
        return False
    if h in {"localhost", "checkmk", "api", "dashboard", "edge"}:
        return True
    if known_hosts and (h in known_hosts or host in known_hosts):
        return True
    # strip brackets / port from host-only checks
    if h.startswith("[") and "]" in h:
        h = h[1 : h.index("]")]
    try:
        ip = ipaddress.ip_address(h)
        if ip.is_loopback or ip.is_link_local:
            return True
        for cidr in allowlist:
            try:
                if ip in ipaddress.ip_network(cidr, strict=False):
                    return True
            except ValueError:
                continue
        return False
    except ValueError:
        # hostname: allow if looks private-ish or known; otherwise allow FQDN for monitoring admin
        return bool(PRIVATE_HINT.match(h)) or "." in h or h.replace("-", "").isalnum()


async def test_ping(host: str, count: int = 3) -> dict[str, Any]:
    count = max(1, min(int(count or 3), 5))
    cmd = ["ping", "-c", str(count), "-W", "2", host]
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=15)
    except FileNotFoundError:
        return {"ok": False, "error": "ping binary not available"}
    except asyncio.TimeoutError:
        return {"ok": False, "host": host, "error": "timeout"}
    text = out.decode("utf-8", "replace") + err.decode("utf-8", "replace")
    loss_m = re.search(r"(\d+(?:\.\d+)?)% packet loss", text)
    rtt_m = re.search(r"rtt min/avg/max/[^=]+=\s*([\d.]+)/([\d.]+)/([\d.]+)", text)
    return {
        "ok": proc.returncode == 0,
        "host": host,
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        "packet_loss_pct": float(loss_m.group(1)) if loss_m else None,
        "rtt_avg_ms": float(rtt_m.group(2)) if rtt_m else None,
        "summary": text.strip().splitlines()[-2:] if text.strip() else [],
    }


async def test_tcp(host: str, port: int, timeout: float = 3.0) -> dict[str, Any]:
    port = int(port)
    if not (1 <= port <= 65535):
        return {"ok": False, "error": "invalid port"}
    t0 = time.monotonic()
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return {
            "ok": True,
            "host": host,
            "port": port,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "host": host,
            "port": port,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "error": str(exc),
        }


async def test_http(url: str, timeout: float = 8.0, verify_tls: bool = False) -> dict[str, Any]:
    raw = (url or "").strip()
    if not raw:
        return {"ok": False, "error": "url required"}
    if "://" not in raw:
        raw = "http://" + raw
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        return {"ok": False, "error": "only http/https supported"}
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify_tls, follow_redirects=True) as client:
            resp = await client.get(raw)
        return {
            "ok": 200 <= resp.status_code < 500,
            "url": raw,
            "status_code": resp.status_code,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "server": resp.headers.get("server"),
            "content_type": resp.headers.get("content-type"),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "url": raw,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "error": str(exc),
        }


async def test_snmp(host: str, community: str = "public") -> dict[str, Any]:
    t0 = time.monotonic()
    dev = await _probe_snmp(host, community or "public", timeout=2.0)
    if not dev:
        return {
            "ok": False,
            "host": host,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "error": "SNMP no response",
        }
    return {
        "ok": True,
        "host": host,
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        "sysdescr": dev.get("sysdescr"),
        "vendor": dev.get("vendor"),
    }


async def test_checkmk_agent(host: str, port: int = 6556) -> dict[str, Any]:
    """Probe Checkmk agent TCP port and read a short banner/chunk if any."""
    port = int(port or 6556)
    t0 = time.monotonic()
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=4.0)
        try:
            chunk = await asyncio.wait_for(reader.read(256), timeout=2.0)
        except asyncio.TimeoutError:
            chunk = b""
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        text = chunk.decode("utf-8", "replace").strip()
        return {
            "ok": True,
            "host": host,
            "port": port,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "banner_preview": text[:200],
            "looks_like_agent": "<<<" in text or bool(text),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "host": host,
            "port": port,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            "error": str(exc),
        }


async def resolve_dns(host: str) -> dict[str, Any]:
    try:
        infos = await asyncio.get_event_loop().getaddrinfo(host, None, family=socket.AF_UNSPEC)
        addrs = sorted({i[4][0] for i in infos})
        return {"ok": bool(addrs), "host": host, "addresses": addrs}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "host": host, "error": str(exc)}


# re-export for assistant
host_allowed = _host_allowed
