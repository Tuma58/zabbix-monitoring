from __future__ import annotations

import ipaddress
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.errors import validation_failed
from app.models import SystemSetting

PROBE_NETWORKS_KEY = "probe_network_allowlist"


def normalize_cidrs(cidrs: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in cidrs:
        value = (raw or "").strip()
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise validation_failed(
                f"Некорректная сеть: {value}",
                details={"cidr": value},
            ) from exc
        item = str(network)
        if item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    if not normalized:
        raise validation_failed("Список сетей не может быть пустым")
    return normalized


def default_probe_networks(settings: Settings) -> list[str]:
    return list(settings.probe_allowlist_cidrs)


def get_probe_networks(db: Session, settings: Settings) -> list[str]:
    row = db.get(SystemSetting, PROBE_NETWORKS_KEY)
    if row is None:
        return default_probe_networks(settings)
    try:
        payload = json.loads(row.value_json)
    except json.JSONDecodeError:
        return default_probe_networks(settings)
    if isinstance(payload, list):
        return [str(item).strip() for item in payload if str(item).strip()]
    if isinstance(payload, str):
        return [item.strip() for item in payload.split(",") if item.strip()]
    return default_probe_networks(settings)


def set_probe_networks(
    db: Session,
    settings: Settings,
    cidrs: list[str],
    *,
    actor_id: str | None = None,
) -> list[str]:
    normalized = normalize_cidrs(cidrs)
    row = db.get(SystemSetting, PROBE_NETWORKS_KEY)
    value = json.dumps(normalized, ensure_ascii=False)
    if row is None:
        row = SystemSetting(
            key=PROBE_NETWORKS_KEY,
            value_json=value,
            updated_at=utcnow(),
            updated_by=actor_id,
        )
        db.add(row)
    else:
        row.value_json = value
        row.updated_at = utcnow()
        row.updated_by = actor_id
    db.flush()
    return normalized


def probe_networks_payload(db: Session, settings: Settings) -> dict[str, Any]:
    networks = get_probe_networks(db, settings)
    row = db.get(SystemSetting, PROBE_NETWORKS_KEY)
    return {
        "networks": networks,
        "defaults": default_probe_networks(settings),
        "source": "database" if row is not None else "env",
        "updated_at": row.updated_at if row is not None else None,
    }
