from __future__ import annotations

import asyncio
import ipaddress
import re

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

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")


def guess_vendor(sysdescr: str) -> str:
    low = (sysdescr or "").lower()
    for vendor, needles in VENDOR_HINTS.items():
        if any(n in low for n in needles):
            return vendor
    return ""


def sanitize_hostname(name: str, fallback_ip: str = "") -> str:
    """Make a Checkmk-safe host name (latin, digits, . _ -)."""
    raw = (name or "").strip()
    if not raw and fallback_ip:
        raw = f"snmp-{fallback_ip.replace('.', '-')}"
    raw = raw.replace(" ", "-")
    raw = re.sub(r"[^A-Za-z0-9_.-]", "-", raw)
    raw = re.sub(r"-{2,}", "-", raw).strip("-._")
    if not raw:
        raw = "host"
    if raw[0].isdigit():
        raw = f"h-{raw}"
    if not HOST_RE.match(raw):
        raw = f"host-{abs(hash(raw)) % 10_000_000}"
    return raw[:63]


def _name_from_sysdescr(sysdescr: str) -> str:
    """Best-effort short name from SNMP sysDescr text."""
    text = (sysdescr or "").strip()
    if not text:
        return ""
    # RouterOS: "RouterOS CCR2004..." / "MikroTik RouterOS CCR2004..."
    m = re.search(r"RouterOS\s+([A-Za-z0-9][A-Za-z0-9_.+-]{1,40})", text, re.I)
    if m:
        return m.group(1)
    m = re.search(r"MikroTik\s+([A-Za-z0-9][A-Za-z0-9_.+-]{1,40})", text, re.I)
    if m and m.group(1).lower() != "routeros":
        return m.group(1)
    # Cisco: "Cisco IOS Software, C2960 Software ..."
    m = re.search(r"Cisco[^,]*,\s*([A-Za-z0-9][A-Za-z0-9_.+-]{1,40})", text, re.I)
    if m:
        return m.group(1)
    # First token that looks like a product/hostname
    first = re.split(r"[\s,;/|]+", text, maxsplit=1)[0]
    if first and len(first) >= 2 and not first.lower().startswith(("software", "version", "linux", "mikrotik", "routeros")):
        return first[:40]
    return ""


def suggest_device_name(dev: dict, *, used: set[str] | None = None) -> str:
    """Prefer device sysName / product name over IP for host registration."""
    ip = str(dev.get("ip") or "").strip()
    candidates = [
        str(dev.get("sysname") or "").strip(),
        str(dev.get("name") or "").strip(),
        _name_from_sysdescr(str(dev.get("sysdescr") or "")),
        str(dev.get("vendor") or "").strip(),
    ]
    base = ""
    for c in candidates:
        if not c:
            continue
        # skip pure IPs
        if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", c):
            continue
        base = c
        break
    name = sanitize_hostname(base, ip)
    if used is None:
        return name
    if name not in used:
        used.add(name)
        return name
    # collide → append last IP octet / fragment
    suffix = ip.split(".")[-1] if ip else str(len(used))
    alt = sanitize_hostname(f"{name}-{suffix}", ip)
    n = 2
    while alt in used:
        alt = sanitize_hostname(f"{name}-{suffix}-{n}", ip)
        n += 1
    used.add(alt)
    return alt


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


def _clean_snmp_value(raw: str) -> str:
    return (raw or "").strip().strip('"').strip()


async def _probe_snmp(ip: str, community: str, timeout: float) -> dict | None:
    """Best-effort SNMP GET of sysName + sysDescr via net-snmp `snmpget`."""
    cmd = [
        "snmpget", "-v2c", "-c", community, "-t", "1", "-r", "0", "-Ovq",
        ip,
        "1.3.6.1.2.1.1.5.0",  # sysName
        "1.3.6.1.2.1.1.1.0",  # sysDescr
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
    lines = [ln for ln in out.decode("utf-8", "replace").splitlines() if ln.strip()]
    if not lines:
        return None
    sysname = _clean_snmp_value(lines[0]) if lines else ""
    sysdescr = _clean_snmp_value(lines[1]) if len(lines) > 1 else ""
    # Some agents return only one value / empty sysName
    if not sysdescr and sysname and (" " in sysname or len(sysname) > 48):
        sysdescr, sysname = sysname, ""
    if not sysdescr and not sysname:
        return None
    if not sysdescr:
        sysdescr = sysname
    vendor = guess_vendor(sysdescr)
    draft = {"ip": ip, "sysname": sysname, "sysdescr": sysdescr, "vendor": vendor, "added": False}
    draft["name"] = suggest_device_name(draft)
    return draft


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
    # ensure unique suggested names across the scan result
    used: set[str] = set()
    for d in results:
        d["name"] = suggest_device_name(d, used=used)
    return {"scanned": len(hosts), "devices": results}
