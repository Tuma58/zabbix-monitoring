import json

from fastapi import APIRouter
from sqlalchemy import select

from app.deps import AdminUser, DbSession
from app.models import AuditEvent
from app.schemas import AuditEventOut

router = APIRouter()


@router.get("", response_model=list[AuditEventOut])
def list_audit_events(_: AdminUser, db: DbSession) -> list[AuditEventOut]:
    events = db.scalars(select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(100)).all()
    result: list[AuditEventOut] = []
    for event in events:
        diff = json.loads(event.diff_json or "{}")
        result.append(
            AuditEventOut(
                id=event.id,
                actor_id=event.actor_id,
                action=event.action,
                target_type=event.target_type,
                target_id=event.target_id,
                request_id=event.request_id,
                result=event.result,
                ip=event.ip,
                created_at=event.created_at,
                diff=diff if isinstance(diff, dict) else {},
            )
        )
    return result