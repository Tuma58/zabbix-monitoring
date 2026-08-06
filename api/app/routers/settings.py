from fastapi import APIRouter, Request

from app.deps import AdminUser, AppSettings, DbSession, ViewerUser
from app.schemas import ProbeNetworksOut, ProbeNetworksUpdate
from app.services.audit import record_audit
from app.services.portal_settings import (
    default_probe_networks,
    probe_networks_payload,
    set_probe_networks,
)

router = APIRouter()


@router.get("/probe-networks", response_model=ProbeNetworksOut)
def read_probe_networks(_: ViewerUser, db: DbSession, settings: AppSettings) -> ProbeNetworksOut:
    payload = probe_networks_payload(db, settings)
    return ProbeNetworksOut(**payload)


@router.put("/probe-networks", response_model=ProbeNetworksOut)
def update_probe_networks(
    payload: ProbeNetworksUpdate,
    request: Request,
    user: AdminUser,
    db: DbSession,
    settings: AppSettings,
) -> ProbeNetworksOut:
    networks = set_probe_networks(db, settings, payload.networks, actor_id=user.id)
    record_audit(
        db,
        actor_id=user.id,
        action="settings.probe_networks.update",
        target_type="system_setting",
        target_id="probe_network_allowlist",
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"networks": networks},
    )
    db.commit()
    return ProbeNetworksOut(**probe_networks_payload(db, settings))


@router.post("/probe-networks/reset", response_model=ProbeNetworksOut)
def reset_probe_networks(
    request: Request,
    user: AdminUser,
    db: DbSession,
    settings: AppSettings,
) -> ProbeNetworksOut:
    networks = set_probe_networks(
        db,
        settings,
        default_probe_networks(settings),
        actor_id=user.id,
    )
    record_audit(
        db,
        actor_id=user.id,
        action="settings.probe_networks.reset",
        target_type="system_setting",
        target_id="probe_network_allowlist",
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"networks": networks},
    )
    db.commit()
    return ProbeNetworksOut(**probe_networks_payload(db, settings))
