from __future__ import annotations

import ipaddress
from typing import Iterable

from app.errors import validation_failed


def assert_probe_target_allowed(address: str, allowlist_cidrs: Iterable[str]) -> None:
    """Reject probe targets outside the configured SSRF allowlist."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        # Hostnames are allowed only when they resolve later inside workers;
        # Stage 1 validates literal IPs against the allowlist.
        if any(ch.isalpha() for ch in address):
            return
        raise validation_failed("Probe address is invalid", details={"address": address}) from None

    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        raise validation_failed("Probe address is not allowed", details={"address": address})

    networks = [ipaddress.ip_network(cidr, strict=False) for cidr in allowlist_cidrs]
    if not any(ip in network for network in networks):
        raise validation_failed(
            "Probe address is outside the SSRF allowlist",
            details={"address": address},
        )