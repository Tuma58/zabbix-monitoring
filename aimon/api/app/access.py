from __future__ import annotations

import ipaddress
from typing import Any, Iterable


def normalize_client_cidrs(cidrs: list[str]) -> list[str]:
    """Normalize IPs/CIDRs; empty list means allow-all (restriction off)."""
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in cidrs:
        value = (raw or "").strip()
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise ValueError(f"Некорректный IP или подсеть: {value}") from exc
        item = str(network)
        if item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def client_ip_allowed(ip: str, allowlist: Iterable[str]) -> bool:
    """Empty allowlist → allow everyone. Otherwise IP must fall into a listed network."""
    networks = [str(n).strip() for n in allowlist if str(n).strip()]
    if not networks:
        return True
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    for item in networks:
        try:
            if addr in ipaddress.ip_network(item, strict=False):
                return True
        except ValueError:
            continue
    return False


def extract_client_ip(request: Any) -> str:
    """Prefer edge-forwarded client IP (X-Real-IP / X-Forwarded-For)."""
    headers = getattr(request, "headers", {}) or {}
    real = (headers.get("X-Real-IP") or headers.get("x-real-ip") or "").strip()
    if real:
        try:
            ipaddress.ip_address(real.split(",")[0].strip())
            return real.split(",")[0].strip()
        except ValueError:
            pass
    forwarded = (headers.get("X-Forwarded-For") or headers.get("x-forwarded-for") or "").strip()
    if forwarded:
        for part in forwarded.split(","):
            candidate = part.strip()
            if not candidate:
                continue
            try:
                ipaddress.ip_address(candidate)
                return candidate
            except ValueError:
                continue
    client = getattr(request, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    if host:
        return str(host)
    return ""
