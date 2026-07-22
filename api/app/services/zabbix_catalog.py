from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MonitoringProfileSpec:
    """Portal + Zabbix defaults for a device type / subtype / protocol tuple."""

    key: str
    name: str
    profile_type: str
    zabbix_templates: tuple[str, ...]
    interface: str  # snmp | agent | icmp
    snmp_port: str = "161"
    agent_port: str = "10050"
    public: dict[str, Any] | None = None

    def default_secrets(self, settings: Any) -> dict[str, Any]:
        if self.profile_type == "snmp_v3":
            return {
                "version": 3,
                "security_level": "authPriv",
                "username": settings.zabbix_default_snmpv3_user,
                "auth_protocol": "SHA256",
                "auth_passphrase": settings.zabbix_default_snmpv3_auth_pass or "change-me-auth",
                "priv_protocol": "AES128",
                "priv_passphrase": settings.zabbix_default_snmpv3_priv_pass or "change-me-priv",
            }
        if self.profile_type == "agent_psk":
            return {
                "mode": "psk",
                "psk_identity": settings.zabbix_default_agent_psk_identity or "netmon-agent",
                "psk": settings.zabbix_default_agent_psk or "change-me-psk-key-32-chars-min!!",
            }
        return {}


def _agent_spec(device_type: str, subtype: str, template: str, label: str) -> MonitoringProfileSpec:
    return MonitoringProfileSpec(
        key=f"{device_type}:{subtype}:Zabbix agent2",
        name=f"Auto · Agent · {label}",
        profile_type="agent_psk",
        zabbix_templates=(template,),
        interface="agent",
        public={"device_type": device_type, "subtype": subtype, "protocol": "Zabbix agent2"},
    )


def _snmp_spec(device_type: str, subtype: str, template: str, label: str) -> MonitoringProfileSpec:
    return MonitoringProfileSpec(
        key=f"{device_type}:{subtype}:SNMPv3",
        name=f"Auto · SNMP · {label}",
        profile_type="snmp_v3",
        zabbix_templates=(template, "Network Generic Device by SNMP"),
        interface="snmp",
        public={"device_type": device_type, "subtype": subtype, "protocol": "SNMPv3"},
    )


PROFILE_CATALOG: dict[str, MonitoringProfileSpec] = {
    "server:win:Zabbix agent2": _agent_spec(
        "server", "win", "Windows by Zabbix agent active", "Windows Server"
    ),
    "server:linux:Zabbix agent2": _agent_spec(
        "server", "linux", "Linux by Zabbix agent active", "Linux Server"
    ),
    "computer:win:Zabbix agent2": _agent_spec(
        "computer", "win", "Windows by Zabbix agent active", "Windows PC"
    ),
    "computer:linux:Zabbix agent2": _agent_spec(
        "computer", "linux", "Linux by Zabbix agent active", "Linux PC"
    ),
    "router:mikrotik:SNMPv3": _snmp_spec(
        "router", "mikrotik", "Mikrotik by SNMP", "MikroTik"
    ),
    "router:keenetic:SNMPv3": _snmp_spec(
        "router", "keenetic", "Network Generic Device by SNMP", "Keenetic"
    ),
    "router:cisco:SNMPv3": _snmp_spec(
        "router", "cisco", "Cisco IOS by SNMP", "Cisco IOS"
    ),
    "router:dlink:SNMPv3": _snmp_spec(
        "router", "dlink", "Network Generic Device by SNMP", "D-Link"
    ),
    "router:tplink:SNMPv3": _snmp_spec(
        "router", "tplink", "Network Generic Device by SNMP", "TP-Link"
    ),
    "router:hp:SNMPv3": _snmp_spec(
        "router", "hp", "HP Enterprise Switch by SNMP", "HP / Aruba"
    ),
    "router::ICMP": MonitoringProfileSpec(
        key="router::ICMP",
        name="Auto · ICMP · Network device",
        profile_type="icmp",
        zabbix_templates=("ICMP Ping",),
        interface="icmp",
        public={"device_type": "router", "protocol": "ICMP"},
    ),
    "ups:apc:SNMPv3": _snmp_spec("ups", "apc", "APC UPS by SNMP", "APC"),
    "ups:eaton:SNMPv3": _snmp_spec("ups", "eaton", "Eaton UPS by SNMP", "Eaton"),
    "ups:cyberpower:SNMPv3": _snmp_spec(
        "ups", "cyberpower", "CyberPower UPS by SNMP", "CyberPower"
    ),
    "ups:parallels:SNMPv3": _snmp_spec(
        "ups", "parallels", "Generic UPS SNMP", "Generic UPS"
    ),
    "router::SNMPv3": _snmp_spec(
        "router", "", "Network Generic Device by SNMP", "Generic network"
    ),
    "ups::SNMPv3": _snmp_spec("ups", "", "Generic UPS SNMP", "Generic UPS"),
}


def resolve_profile_key(device_type: str, monitoring_subtype: str | None, protocol: str) -> str:
    subtype = monitoring_subtype or ""
    key = f"{device_type}:{subtype}:{protocol}"
    if key in PROFILE_CATALOG:
        return key
    if protocol == "ICMP" and device_type == "router":
        return "router::ICMP"
    fallback = f"{device_type}::{protocol}"
    if fallback in PROFILE_CATALOG:
        return fallback
    if protocol == "Zabbix agent2":
        return "server:linux:Zabbix agent2"
    if protocol == "SNMPv3":
        return "router::SNMPv3"
    return "router::ICMP"


def get_profile_spec(
    device_type: str,
    monitoring_subtype: str | None,
    protocol: str,
) -> MonitoringProfileSpec:
    return PROFILE_CATALOG[resolve_profile_key(device_type, monitoring_subtype, protocol)]


def list_catalog_entries() -> list[dict[str, Any]]:
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for spec in PROFILE_CATALOG.values():
        if spec.key in seen:
            continue
        seen.add(spec.key)
        items.append(
            {
                "key": spec.key,
                "name": spec.name,
                "profile_type": spec.profile_type,
                "zabbix_templates": list(spec.zabbix_templates),
                "interface": spec.interface,
                **(spec.public or {}),
            }
        )
    return sorted(items, key=lambda item: item["key"])
