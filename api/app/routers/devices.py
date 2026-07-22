import json

from fastapi import APIRouter, Header, Request
from sqlalchemy import select

from app.deps import AppSettings, DbSession, OperatorUser, ViewerUser
from app.errors import AppError, not_found
from app.models import Device, DeviceStatus, Operation, OperationState, Site
from app.schemas import DeviceCreate, DeviceOut, OperationOut, ProbeRequest
from app.services.audit import record_audit
from app.services.ssrf import assert_probe_target_allowed

router = APIRouter()


def _device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        site_id=device.site_id,
        zabbix_host_id=device.zabbix_host_id,
        name=device.name,
        address=device.address,
        device_type=device.device_type,
        vendor=device.vendor,
        model=device.model,
        status=device.status,
        version=device.version,
    )


@router.get("", response_model=list[DeviceOut])
def list_devices(_: ViewerUser, db: DbSession) -> list[DeviceOut]:
    devices = db.scalars(select(Device).order_by(Device.name)).all()
    return [_device_out(device) for device in devices]


@router.post("", response_model=DeviceOut, status_code=201)
def create_device(payload: DeviceCreate, request: Request, user: OperatorUser, db: DbSession) -> DeviceOut:
    site = db.get(Site, payload.site_id)
    if site is None:
        raise not_found("Site not found")
    duplicate = db.scalar(
        select(Device).where((Device.address == payload.address) | (Device.name == payload.name))
    )
    if duplicate is not None:
        raise AppError(
            status_code=409,
            code="DEVICE_ALREADY_EXISTS",
            message="Device name or address already registered",
        )
    device = Device(
        site_id=payload.site_id,
        name=payload.name,
        address=payload.address,
        device_type=payload.device_type,
        vendor=payload.vendor,
        model=payload.model,
        status=DeviceStatus.DRAFT.value,
    )
    db.add(device)
    db.flush()
    record_audit(
        db,
        actor_id=user.id,
        action="device.create",
        target_type="device",
        target_id=device.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"name": device.name, "address": device.address},
    )
    db.commit()
    db.refresh(device)
    return _device_out(device)


@router.get("/{device_id}", response_model=DeviceOut)
def get_device(device_id: str, _: ViewerUser, db: DbSession) -> DeviceOut:
    device = db.get(Device, device_id)
    if device is None:
        raise not_found("Device not found")
    return _device_out(device)


@router.post("/probe", response_model=OperationOut, status_code=202)
def probe_device(
    payload: ProbeRequest,
    request: Request,
    user: OperatorUser,
    db: DbSession,
    settings: AppSettings,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> OperationOut:
    site = db.get(Site, payload.site_id)
    if site is None:
        raise not_found("Site not found")
    assert_probe_target_allowed(payload.address, settings.probe_allowlist_cidrs)

    if idempotency_key:
        existing = db.scalar(select(Operation).where(Operation.idempotency_key == idempotency_key))
        if existing is not None:
            result = json.loads(existing.result_json or "{}")
            return OperationOut(
                id=existing.id,
                kind=existing.kind,
                state=existing.state,
                progress=existing.progress,
                error_code=existing.error_code,
                result=result if isinstance(result, dict) else {},
                links={"self": f"/api/v1/operations/{existing.id}"},
            )

    # Stage 1: synchronous stub probe that never returns secrets.
    result = {
        "icmp": {"ok": True, "latency_ms": 4.2},
        "protocol": {"ok": True, "version": payload.protocol},
        "identity": {
            "vendor": "Generic",
            "model": payload.device_type.upper(),
            "sys_object_id": None,
        },
        "warnings": [],
    }
    operation = Operation(
        kind="device_probe",
        state=OperationState.SUCCEEDED.value,
        progress=100,
        idempotency_key=idempotency_key,
        result_json=json.dumps(result, ensure_ascii=False),
    )
    db.add(operation)
    db.flush()
    record_audit(
        db,
        actor_id=user.id,
        action="device.probe",
        target_type="site",
        target_id=site.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"address": payload.address, "protocol": payload.protocol},
    )
    db.commit()
    db.refresh(operation)
    return OperationOut(
        id=operation.id,
        kind=operation.kind,
        state=operation.state,
        progress=operation.progress,
        result=result,
        links={"self": f"/api/v1/operations/{operation.id}"},
    )