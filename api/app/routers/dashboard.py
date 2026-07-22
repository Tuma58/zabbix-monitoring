from datetime import datetime, timezone

from fastapi import APIRouter
from sqlalchemy import func, select

from app.deps import DbSession, Gateway, ViewerUser
from app.models import Device, Site
from app.schemas import DashboardSummary

router = APIRouter()


@router.get("/summary", response_model=DashboardSummary)
async def dashboard_summary(_: ViewerUser, db: DbSession, gateway: Gateway) -> DashboardSummary:
    devices_total = db.scalar(select(func.count()).select_from(Device)) or 0
    sites_total = db.scalar(select(func.count()).select_from(Site)) or 0
    active = db.scalar(select(func.count()).select_from(Device).where(Device.status == "active")) or 0
    degraded = db.scalar(select(func.count()).select_from(Device).where(Device.status == "degraded")) or 0
    failed = db.scalar(select(func.count()).select_from(Device).where(Device.status == "failed")) or 0
    drafts = db.scalar(select(func.count()).select_from(Device).where(Device.status == "draft")) or 0

    zabbix = await gateway.ping()
    stale = zabbix.get("status") == "unavailable"
    source = "zabbix" if zabbix.get("status") == "ok" else "portal"

    return DashboardSummary(
        generated_at=datetime.now(timezone.utc),
        source=source,
        availability={
            "available": active,
            "unknown": drafts,
            "unavailable": failed + degraded,
        },
        problems={
            "disaster": 0,
            "high": 1 if degraded or failed else 0,
            "average": 1 if drafts else 0,
            "warning": 0,
        },
        devices_total=devices_total,
        sites_total=sites_total,
        monitoring_gaps=drafts,
        stale=stale,
        zabbix=zabbix,
    )