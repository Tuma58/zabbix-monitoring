from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import AppError, dependency_unavailable, not_found
from app.models import CredentialProfile, Device, DeviceStatus, Site
from app.services.secrets import SecretBox
from app.services.zabbix_catalog import MonitoringProfileSpec, get_profile_spec
from app.services.zabbix_gateway import ZabbixGateway


def ensure_credential_profile(
    db: Session,
    secret_box: SecretBox,
    settings: Settings,
    device_type: str,
    monitoring_subtype: str | None,
    protocol: str,
) -> tuple[CredentialProfile, MonitoringProfileSpec]:
    spec = get_profile_spec(device_type, monitoring_subtype, protocol)
    existing = db.scalar(select(CredentialProfile).where(CredentialProfile.name == spec.name))
    if existing is not None:
        return existing, spec

    secrets_payload = spec.default_secrets(settings)
    profile = CredentialProfile(
        name=spec.name,
        profile_type=spec.profile_type,
        encrypted_payload=secret_box.encrypt(secrets_payload),
        key_version=secret_box.key_version,
    )
    db.add(profile)
    db.flush()
    return profile, spec


def _public_profile(profile: CredentialProfile, secret_box: SecretBox) -> dict[str, Any]:
    payload = secret_box.decrypt(profile.encrypted_payload)
    return SecretBox.public_view(profile.profile_type, payload)


async def _ensure_host_group(gateway: ZabbixGateway, group_name: str) -> str:
    groups = await gateway.call(
        "hostgroup.get",
        {"output": ["groupid"], "filter": {"name": [group_name]}},
    )
    if groups:
        return str(groups[0]["groupid"])
    created = await gateway.call("hostgroup.create", {"name": group_name})
    return str(created["groupids"][0])


async def _resolve_template_ids(gateway: ZabbixGateway, template_names: tuple[str, ...]) -> list[str]:
    template_ids: list[str] = []
    for name in template_names:
        result = await gateway.call(
            "template.get",
            {"output": ["templateid"], "filter": {"host": [name]}, "limit": 1},
        )
        if result:
            template_ids.append(str(result[0]["templateid"]))
    return template_ids


def _build_interfaces(
    address: str,
    spec: MonitoringProfileSpec,
    secrets: dict[str, Any],
) -> list[dict[str, Any]]:
    if spec.interface == "snmp":
        details: dict[str, Any] = {"version": 3, "bulk": 1, "securityname": secrets.get("username", "")}
        security_level = secrets.get("security_level", "authPriv")
        level_map = {"noAuthNoPriv": 0, "authNoPriv": 1, "authPriv": 2}
        details["securitylevel"] = level_map.get(security_level, 2)
        auth_map = {"MD5": 0, "SHA1": 1, "SHA224": 2, "SHA256": 3, "SHA384": 4, "SHA512": 5}
        priv_map = {"DES": 0, "AES128": 1, "AES192": 2, "AES256": 3, "AES192C": 4, "AES256C": 5}
        if security_level in {"authNoPriv", "authPriv"}:
            details["authpassphrase"] = secrets.get("auth_passphrase", "")
            details["authprotocol"] = auth_map.get(secrets.get("auth_protocol", "SHA256"), 3)
        if security_level == "authPriv":
            details["privpassphrase"] = secrets.get("priv_passphrase", "")
            details["privprotocol"] = priv_map.get(secrets.get("priv_protocol", "AES128"), 1)
        return [
            {
                "type": 2,
                "main": 1,
                "useip": 1,
                "ip": address,
                "dns": "",
                "port": spec.snmp_port,
                "details": details,
            }
        ]
    if spec.interface == "agent":
        return [
            {
                "type": 1,
                "main": 1,
                "useip": 1,
                "ip": address,
                "dns": "",
                "port": spec.agent_port,
            }
        ]
    return []


async def provision_device_in_zabbix(
    gateway: ZabbixGateway,
    secret_box: SecretBox,
    settings: Settings,
    device: Device,
    site: Site,
    spec: MonitoringProfileSpec,
    profile: CredentialProfile,
    *,
    visible_name: str | None = None,
) -> dict[str, Any]:
    if not gateway.enabled:
        raise dependency_unavailable("Zabbix API integration is not configured")

    secrets = secret_box.decrypt(profile.encrypted_payload)
    host_group = settings.zabbix_default_hostgroup or "NetMon"
    group_id = await _ensure_host_group(gateway, host_group)
    template_ids = await _resolve_template_ids(gateway, spec.zabbix_templates)

    params: dict[str, Any] = {
        "host": device.name,
        "name": visible_name or device.name,
        "groups": [{"groupid": group_id}],
        "interfaces": _build_interfaces(device.address, spec, secrets),
    }
    if template_ids:
        params["templates"] = [{"templateid": template_id} for template_id in template_ids]
    if site.proxy_id:
        params["monitored_by"] = 1
        params["proxyid"] = site.proxy_id

    result = await gateway.call("host.create", params)
    host_id = str(result["hostids"][0])
    return {
        "zabbix_host_id": host_id,
        "templates_linked": template_ids,
        "host_group": host_group,
        "interface": spec.interface,
    }


async def provision_portal_device(
    db: Session,
    gateway: ZabbixGateway,
    secret_box: SecretBox,
    settings: Settings,
    device: Device,
    site: Site,
    *,
    device_type: str,
    monitoring_subtype: str | None,
    protocol: str,
    auto_provision: bool,
    credential_profile_id: str | None = None,
) -> dict[str, Any]:
    if credential_profile_id:
        profile = db.get(CredentialProfile, credential_profile_id)
        if profile is None:
            raise not_found("Credential profile not found")
        spec = get_profile_spec(device_type, monitoring_subtype, protocol)
    else:
        profile, spec = ensure_credential_profile(
            db, secret_box, settings, device_type, monitoring_subtype, protocol
        )
    device.protocol = protocol
    device.monitoring_subtype = monitoring_subtype
    device.credential_profile_id = profile.id

    outcome: dict[str, Any] = {
        "credential_profile_id": profile.id,
        "credential_profile_name": profile.name,
        "zabbix_templates": list(spec.zabbix_templates),
        "zabbix_provisioned": False,
    }

    if not auto_provision:
        device.status = DeviceStatus.DRAFT.value
        return outcome

    device.status = DeviceStatus.PROVISIONING.value
    if not gateway.enabled:
        device.status = DeviceStatus.DRAFT.value
        outcome["warning"] = "Zabbix API disabled; host not created"
        return outcome

    try:
        zabbix_result = await provision_device_in_zabbix(
            gateway,
            secret_box,
            settings,
            device,
            site,
            spec,
            profile,
        )
    except AppError as exc:
        device.status = DeviceStatus.FAILED.value
        outcome["error"] = exc.message
        outcome["error_code"] = exc.code
        return outcome

    device.zabbix_host_id = zabbix_result["zabbix_host_id"]
    device.status = DeviceStatus.ACTIVE.value
    outcome["zabbix_provisioned"] = True
    outcome.update(zabbix_result)
    return outcome


def profile_out(profile: CredentialProfile, secret_box: SecretBox) -> dict[str, Any]:
    return {
        "id": profile.id,
        "name": profile.name,
        "profile_type": profile.profile_type,
        "key_version": profile.key_version,
        "public": _public_profile(profile, secret_box),
    }


def serialize_provision_result(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False)
