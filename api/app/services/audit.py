from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent


SENSITIVE_KEYS = {
    "password",
    "secret",
    "token",
    "community",
    "auth_passphrase",
    "priv_passphrase",
    "psk",
    "authorization",
    "api_password",
}


def sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            if key.lower() in SENSITIVE_KEYS or key.lower().endswith("_password") or key.lower().endswith("_secret"):
                cleaned[key] = "***"
            else:
                cleaned[key] = sanitize_payload(item)
        return cleaned
    if isinstance(value, list):
        return [sanitize_payload(item) for item in value]
    return value


def record_audit(
    db: Session,
    *,
    actor_id: str | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    request_id: str | None = None,
    result: str = "success",
    ip: str | None = None,
    diff: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=request_id,
        result=result,
        ip=ip,
        diff_json=json.dumps(sanitize_payload(diff or {}), ensure_ascii=False),
    )
    db.add(event)
    db.flush()
    return event