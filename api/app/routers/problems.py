from fastapi import APIRouter, Request
from sqlalchemy import select

from app.deps import DbSession, OperatorUser, ViewerUser
from app.errors import not_found
from app.models import Device, Site
from app.schemas import ProblemAckRequest, ProblemOut
from app.services.audit import record_audit

router = APIRouter()


@router.get("", response_model=list[ProblemOut])
def list_problems(_: ViewerUser, db: DbSession) -> list[ProblemOut]:
    sites = {site.id: site.name for site in db.scalars(select(Site)).all()}
    devices = db.scalars(select(Device).where(Device.status.in_(["degraded", "failed"]))).all()
    problems: list[ProblemOut] = []
    for index, device in enumerate(devices, start=1):
        problems.append(
            ProblemOut(
                event_id=f"portal-{device.id[:8]}",
                severity="high" if device.status == "failed" else "average",
                host=device.name,
                site=sites.get(device.site_id, "—"),
                summary=f"Device status is {device.status}",
                duration=f"{index * 12}м",
                acknowledged=False,
            )
        )
    return problems


@router.post("/{event_id}/ack", response_model=ProblemOut)
def acknowledge_problem(
    event_id: str,
    payload: ProblemAckRequest,
    request: Request,
    user: OperatorUser,
    db: DbSession,
) -> ProblemOut:
    if not event_id.startswith("portal-"):
        raise not_found("Problem not found")
    problem = {
        "event_id": event_id,
        "severity": "average",
        "host": "unknown",
        "site": "—",
        "summary": payload.message or "Acknowledged",
        "duration": "—",
        "acknowledged": True,
        "owner": user.email,
    }
    record_audit(
        db,
        actor_id=user.id,
        action="problem.ack",
        target_type="problem",
        target_id=event_id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"message": payload.message},
    )
    db.commit()
    return ProblemOut(**problem)
