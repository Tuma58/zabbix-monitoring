import pytest

from app.config import Settings
from app.errors import AppError
from app.services.ssrf import assert_probe_target_allowed
from app.services.zabbix_gateway import ZabbixGateway


def test_ssrf_allowlist_accepts_private_ip():
    assert_probe_target_allowed("10.20.1.15", ["10.0.0.0/8"])


def test_ssrf_allowlist_rejects_public_ip():
    with pytest.raises(AppError) as exc:
        assert_probe_target_allowed("8.8.8.8", ["10.0.0.0/8"])
    assert exc.value.code == "VALIDATION_FAILED"


def test_zabbix_gateway_disabled_by_default():
    gateway = ZabbixGateway(settings=Settings(zabbix_enabled=False))
    assert gateway.enabled is False


@pytest.mark.asyncio
async def test_zabbix_gateway_call_requires_config():
    gateway = ZabbixGateway(settings=Settings(zabbix_enabled=False))
    with pytest.raises(AppError) as exc:
        await gateway.call("apiinfo.version")
    assert exc.value.code == "DEPENDENCY_UNAVAILABLE"


def test_capability_matrix_for_70():
    gateway = ZabbixGateway(settings=Settings())
    matrix = gateway.capability_matrix("7.0.28")
    assert matrix["supported"] is True
    assert matrix["features"]["host.create"] is True
