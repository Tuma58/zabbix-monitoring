from fastapi import APIRouter
from sqlalchemy import text

from app.deps import AppSettings, DbSession, Gateway
from app.schemas import HealthLive, HealthReady

router = APIRouter()


@router.get("/health/live", response_model=HealthLive)
def live() -> HealthLive:
    return HealthLive(status="ok")


@router.get("/health/ready", response_model=HealthReady)
async def ready(db: DbSession, settings: AppSettings, gateway: Gateway) -> HealthReady:
    database = "ok"
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        database = "unavailable"

    redis_status = "disabled" if not settings.redis_required else "unchecked"
    zabbix = await gateway.ping()
    status = "ok"
    if database != "ok":
        status = "degraded"
    if zabbix.get("status") == "unavailable":
        status = "degraded"
    return HealthReady(status=status, database=database, redis=redis_status, zabbix=zabbix)