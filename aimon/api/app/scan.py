from __future__ import annotations

import asyncio
import ipaddress

# SNMP sysObjectID / sysDescr vendor hints (best-effort classification)
VENDOR_HINTS = {
    "mikrotik": ["mikrotik", "routeros"],
    "cisco": ["cisco", "ios"],
    "hp": ["hp ", "hewlett", "aruba", "procurve"],
    "dlink": ["d-link", "dlink"],
    "tplink": ["tp-link", "tplink"],
    "apc": ["apc ", "american power"],
    "eaton": ["eaton", "ippon"],
    "windows": ["windows"],
    "linux": ["linux"],
}


def guess_vendor(sysdescr: str) -> str:
    low = (sysdescr or "").lower()
    for vendor, needles in VENDOR_HINTS.items():
        if any(n in low for n in needles):
            return vendor
    return ""


def cidr_is_allowed(cidr: str, allowlist: list[str]) -> bool:
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False
    for allowed in allowlist:
        try:
            if net.subnet_of(ipaddress.ip_network(allowed, strict=False)):
                return True
        except (ValueError, TypeError):
            continue
    return False


def expand_hosts(cidr: str, limit: int = 512) -> list[str]:
    net = ipaddress.ip_network(cidr, strict=False)
    hosts = [str(ip) for ip in net.hosts()]
    return hosts[:limit]


async def _probe_snmp(ip: str, community: str, timeout: float) -> dict | None:
    """Best-effort SNMP GET of sysDescr.0 using net-snmp `snmpget` if present.

    Kept dependency-free: shells out to snmpget. Returns device dict or None.
    Replace with pysnmp for pure-Python operation.
    """
    cmd = [
        "snmpget", "-v2c", "-c", community, "-t", "1", "-r", "0", "-Ovq",
        ip, "1.3.6.1.2.1.1.1.0",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 1)
    except (FileNotFoundError, asyncio.TimeoutError):
        return None
    if proc.returncode != 0:
        return None
    sysdescr = out.decode("utf-8", "replace").strip().strip('"')
    if not sysdescr:
        return None
    return {"ip": ip, "sysdescr": sysdescr, "vendor": guess_vendor(sysdescr), "added": False}


async def scan_snmp(
    cidr: str,
    community: str,
    *,
    timeout: float = 2.0,
    concurrency: int = 64,
) -> dict:
    hosts = expand_hosts(cidr)
    sem = asyncio.Semaphore(concurrency)
    results: list[dict] = []

    async def worker(ip: str) -> None:
        async with sem:
            dev = await _probe_snmp(ip, community, timeout)
            if dev:
                results.append(dev)

    await asyncio.gather(*(worker(ip) for ip in hosts))
    results.sort(key=lambda d: tuple(int(p) for p in d["ip"].split(".")))
    return {"scanned": len(hosts), "devices": results}
