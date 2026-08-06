import pytest

from app.config import Settings
from app.services.zabbix_catalog import get_profile_spec, list_catalog_entries, resolve_profile_key


def test_resolve_profile_key_for_mikrotik():
    key = resolve_profile_key("router", "mikrotik", "SNMPv3")
    assert key == "router:mikrotik:SNMPv3"


def test_get_profile_spec_for_windows_server():
    spec = get_profile_spec("server", "win", "Zabbix agent2")
    assert spec.profile_type == "agent_psk"
    assert "Windows by Zabbix agent active" in spec.zabbix_templates


def test_catalog_entries_are_unique():
    entries = list_catalog_entries()
    keys = [entry["key"] for entry in entries]
    assert len(keys) == len(set(keys))
    assert any(entry["profile_type"] == "snmp_v3" for entry in entries)


def test_default_snmp_secrets_use_settings():
    settings = Settings(
        zabbix_default_snmpv3_user="monitor",
        zabbix_default_snmpv3_auth_pass="auth-secret",
        zabbix_default_snmpv3_priv_pass="priv-secret",
    )
    spec = get_profile_spec("router", "mikrotik", "SNMPv3")
    secrets = spec.default_secrets(settings)
    assert secrets["username"] == "monitor"
    assert secrets["auth_passphrase"] == "auth-secret"
    assert secrets["priv_passphrase"] == "priv-secret"
