from app.services.zabbix_provisioner import _build_interfaces
from app.services.zabbix_catalog import get_profile_spec


def test_snmp_authpriv_uses_securitylevel_two():
    spec = get_profile_spec("router", "mikrotik", "SNMPv3")
    secrets = {
        "username": "zabbix-monitor",
        "security_level": "authPriv",
        "auth_protocol": "SHA256",
        "auth_passphrase": "auth-secret",
        "priv_protocol": "AES128",
        "priv_passphrase": "priv-secret",
    }
    interfaces = _build_interfaces("10.20.1.15", spec, secrets)
    details = interfaces[0]["details"]
    assert details["securitylevel"] == 2
    assert details["authprotocol"] == 3
    assert details["privprotocol"] == 1
    assert len(spec.zabbix_templates) == 1
