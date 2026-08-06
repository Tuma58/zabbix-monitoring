from __future__ import annotations

import asyncio
import ipaddress
import re
from typing import Any

# SNMP sysObjectID / sysDescr vendor hints (best-effort classification)
VENDOR_HINTS = {
    "mikrotik": ["mikrotik", "routeros"],
    "cisco": ["cisco", "ios-xe", "ios ", "nx-os", "catalyst"],
    "hp": ["hewlett", "procurve", "aruba", "hpe ", "hp "],
    "dell": ["dell ", "poweredge", "force10"],
    "dlink": ["d-link", "dlink"],
    "tplink": ["tp-link", "tplink"],
    "ubiquiti": ["ubiquiti", "unifi", "edgemax", "edgeswitch"],
    "juniper": ["juniper", "junos"],
    "huawei": ["huawei", "vrp"],
    "zyxel": ["zyxel"],
    "apc": ["apc ", "american power", "smart-ups"],
    "eaton": ["eaton", "ippon"],
    "brother": ["brother"],
    "canon": ["canon"],
    "epson": ["epson"],
    "kyocera": ["kyocera"],
    "xerox": ["xerox"],
    "windows": ["windows"],
    "linux": ["linux", "ubuntu", "centos", "debian", "red hat"],
    "vmware": ["vmware", "esxi", "vsphere"],
}

# device class → needles (order matters: more specific first)
DEVICE_TYPE_HINTS: list[tuple[str, list[str]]] = [
    ("printer", [
        "printer", "laserjet", "laser jet", "mfp", "multifunction",
        "xerox", "brother", "canon", "epson", "kyocera", "ricoh", "print server",
    ]),
    ("ups", ["apc", "eaton", "ippon", "ups", "smart-ups", "powerware", "cyberpower"]),
    ("ap", [
        "access point", "wireless", "wifi", "wlan", "hap ac", "hapac", "cape",
        "wap", "unifi ap", "aironet", "cap ", "cAP",
    ]),
    ("firewall", ["firewall", "asa", "fortigate", "fortinet", "palo alto", "sophos", "pfsense"]),
    ("router", [
        "mikrotik", "routeros", "router", "ccr", "edge router", "isr",
        "rb4011", "rb5009", "rb3011", "hex ",
    ]),
    ("switch", [
        "catalyst", "switch", "procurve", "d-link", "dlink", "tplink", "tp-link",
        "aruba", "nexus", "edgeswitch", "crs3", "crs1", "managed switch",
    ]),
    ("server", [
        "dell", "poweredge", "proliant", "supermicro", "server", "windows",
        "linux", "ubuntu", "centos", "debian", "esxi", "vmware", "hypervisor",
    ]),
    ("camera", ["camera", "ipcam", "hikvision", "dahua", "axis"]),
    ("nas", ["synology", "qnap", "nas ", "truenas", "freenas"]),
]

DEVICE_TYPE_LABELS = {
    "printer": "Принтер",
    "ups": "ИБП",
    "ap": "Точка доступа",
    "firewall": "Файрвол",
    "router": "Роутер",
    "switch": "Коммутатор",
    "server": "Сервер",
    "camera": "Камера",
    "nas": "NAS",
    "network": "Сеть",
    "host": "Хост",
    "unknown": "Не определено",
}

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def guess_vendor(*parts: str) -> str:
    low = " ".join(str(p or "") for p in parts).lower()
    for vendor, needles in VENDOR_HINTS.items():
        if any(n in low for n in needles):
            return vendor
    return ""


def guess_device_type(*parts: str, monitor_type: str = "") -> tuple[str, str]:
    """Return (device_type, confidence: high|medium|low)."""
    blob = " ".join(str(p or "") for p in parts).lower().replace("_", " ").replace("-", " ")
    hits = 0
    matched = ""
    for dtype, needles in DEVICE_TYPE_HINTS:
        local = sum(1 for n in needles if n in blob)
        if local and local >= hits:
            hits = local
            matched = dtype
    if matched and hits >= 2:
        return matched, "high"
    if matched:
        return matched, "medium"
    if (monitor_type or "").lower() == "snmp":
        return "network", "low"
    if monitor_type:
        return "host", "low"
    return "unknown", "low"


def device_type_label(device_type: str) -> str:
    return DEVICE_TYPE_LABELS.get(device_type or "unknown", device_type or "Не определено")


def sanitize_hostname(name: str, fallback_ip: str = "") -> str:
    """Make a Checkmk-safe host name (latin, digits, . _ -)."""
    raw = (name or "").strip()
    if not raw and fallback_ip:
        raw = f"dev-{fallback_ip.replace('.', '-')}"
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


def _is_generic_sysname(name: str) -> bool:
    n = (name or "").strip().lower()
    if not n or IP_RE.match(n):
        return True
    generics = {
        "localhost", "router", "switch", "gateway", "host", "device",
        "mikrotik", "cisco", "default", "unknown", "null", "(none)",
    }
    if n in generics:
        return True
    if re.fullmatch(r"host-\d+", n) or re.fullmatch(r"snmp-[\d-]+", n):
        return True
    return False


def _model_from_sysdescr(sysdescr: str, vendor: str = "") -> str:
    text = (sysdescr or "").strip()
    if not text:
        return ""
    # RouterOS / MikroTik model
    m = re.search(r"RouterOS\s+([A-Za-z0-9][A-Za-z0-9_.+-]{1,40})", text, re.I)
    if m:
        return m.group(1)
    # Cisco product family
    m = re.search(r"Cisco[^,]*,\s*([A-Za-z0-9][A-Za-z0-9_.+-]{1,40})", text, re.I)
    if m:
        return m.group(1)
    # HP LaserJet 400 / LaserJet Pro MFP
    m = re.search(r"(LaserJet(?:\s+Pro)?(?:\s+MFP)?\s*[A-Za-z0-9-]*)", text, re.I)
    if m:
        return re.sub(r"\s+", "-", m.group(1).strip())[:40]
    # Dell PowerEdge R720
    m = re.search(r"PowerEdge\s+([A-Za-z0-9-]+)", text, re.I)
    if m:
        return f"PowerEdge-{m.group(1)}"
    # Generic: Vendor ModelToken
    if vendor:
        m = re.search(rf"{re.escape(vendor)}\s+([A-Za-z0-9][A-Za-z0-9_.+-]{{1,30}})", text, re.I)
        if m and m.group(1).lower() not in ("router", "switch", "software", "os", "routeros"):
            return m.group(1)
    # First informative token
    for tok in re.split(r"[\s,;/|]+", text):
        t = tok.strip("()[]\"'")
        if len(t) < 3:
            continue
        if t.lower().startswith(("software", "version", "linux", "windows", "copyright", "http")):
            continue
        if re.search(r"\d", t) or t.isupper() or "-" in t:
            return t[:40]
    return ""


def build_alias(dev: dict[str, Any]) -> str:
    """Human-readable alias shown in the dashboard."""
    sysname = str(dev.get("sysname") or "").strip()
    sysdescr = str(dev.get("sysdescr") or "").strip()
    vendor = str(dev.get("vendor") or "").strip()
    model = str(dev.get("model") or "").strip()
    dtype = device_type_label(str(dev.get("device_type") or ""))
    ip = str(dev.get("ip") or "").strip()

    title_bits: list[str] = []
    if vendor:
        title_bits.append(vendor.capitalize() if vendor.islower() else vendor)
    if model and model.lower() not in (vendor or "").lower():
        title_bits.append(model)
    if not title_bits and sysname and not _is_generic_sysname(sysname):
        title_bits.append(sysname)
    if not title_bits and sysdescr:
        title_bits.append(re.split(r"[\r\n]", sysdescr)[0][:60])
    head = " ".join(title_bits).strip() or "Устройство"
    parts = [head]
    if dtype and dtype not in head:
        parts.append(dtype)
    if ip:
        parts.append(ip)
    alias = " · ".join(parts)
    return alias[:120]


def suggest_device_identity(dev: dict[str, Any], *, used: set[str] | None = None) -> dict[str, Any]:
    """Compute name, alias, vendor, model, device_type with confidence."""
    ip = str(dev.get("ip") or "").strip()
    sysname = str(dev.get("sysname") or "").strip()
    sysdescr = str(dev.get("sysdescr") or "").strip()
    vendor = str(dev.get("vendor") or "").strip() or guess_vendor(sysdescr, sysname)
    model = str(dev.get("model") or "").strip() or _model_from_sysdescr(sysdescr, vendor)

    dtype, confidence = guess_device_type(
        sysname, sysdescr, vendor, model, str(dev.get("name") or ""),
        monitor_type="snmp",
    )
    # Prefer explicit AI / caller override
    if dev.get("device_type") and str(dev.get("device_type")) in DEVICE_TYPE_LABELS:
        dtype = str(dev["device_type"])
        confidence = str(dev.get("device_type_confidence") or "high")

    # Hostname candidates (readable, not IP-based when possible)
    candidates: list[str] = []
    if sysname and not _is_generic_sysname(sysname):
        candidates.append(sysname)
    if vendor and model:
        candidates.append(f"{vendor}-{model}")
    elif model:
        candidates.append(model)
    elif vendor and dtype not in ("unknown", "network", "host"):
        candidates.append(f"{vendor}-{dtype}")
    if dev.get("name") and not _is_generic_sysname(str(dev.get("name"))):
        candidates.append(str(dev.get("name")))

    base = ""
    for c in candidates:
        if c and not IP_RE.match(c.strip()):
            base = c
            break
    name = sanitize_hostname(base, ip)

    out = dict(dev)
    out.update(
        {
            "vendor": vendor,
            "model": model,
            "device_type": dtype,
            "device_type_label": device_type_label(dtype),
            "device_type_confidence": confidence,
            "needs_ai": confidence == "low" or dtype in ("unknown", "network"),
        }
    )
    if not out.get("alias"):
        out["alias"] = build_alias(out)

    if used is None:
        out["name"] = name
        return out

    if name not in used:
        used.add(name)
        out["name"] = name
        return out
    suffix = ip.split(".")[-1] if ip else str(len(used) + 1)
    alt = sanitize_hostname(f"{name}-{suffix}", ip)
    n = 2
    while alt in used:
        alt = sanitize_hostname(f"{name}-{suffix}-{n}", ip)
        n += 1
    used.add(alt)
    out["name"] = alt
    return out


# Back-compat wrappers -------------------------------------------------
def suggest_device_name(dev: dict[str, Any], *, used: set[str] | None = None) -> str:
    return str(suggest_device_identity(dev, used=used).get("name") or "")


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
    """SNMP GET sysName + sysDescr."""
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
    if not sysdescr and sysname and (" " in sysname or len(sysname) > 48):
        sysdescr, sysname = sysname, ""
    if not sysdescr and not sysname:
        return None
    if not sysdescr:
        sysdescr = sysname
    draft = {"ip": ip, "sysname": sysname, "sysdescr": sysdescr, "added": False}
    return suggest_device_identity(draft)


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
    used: set[str] = set()
    enriched: list[dict] = []
    for d in results:
        enriched.append(suggest_device_identity(d, used=used))
    return {
        "scanned": len(hosts),
        "devices": enriched,
        "needs_ai": sum(1 for d in enriched if d.get("needs_ai")),
    }
