import json

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.deps import DbSession, OperatorUser, ViewerUser
from app.errors import AppError, not_found, validation_failed
from app.models import Device, Site
from app.schemas import SiteCreate, SiteOut, SiteUpdate
from app.services.audit import record_audit

router = APIRouter()


def _site_out(site: Site, devices_count: int = 0) -> SiteOut:
    tags = json.loads(site.tags_json or "[]")
    return SiteOut(
        id=site.id,
        name=site.name,
        timezone=site.timezone,
        proxy_id=site.proxy_id,
        tags=tags if isinstance(tags, list) else [],
        devices_count=devices_count,
    )


def _devices_count_map(db: DbSession) -> dict[str, int]:
    rows = db.execute(select(Device.site_id, func.count(Device.id)).group_by(Device.site_id)).all()
    return {site_id: count for site_id, count in rows}


@router.get("", response_model=list[SiteOut])
def list_sites(_: ViewerUser, db: DbSession) -> list[SiteOut]:
    counts = _devices_count_map(db)
    sites = db.scalars(select(Site).order_by(Site.name)).all()
    return [_site_out(site, counts.get(site.id, 0)) for site in sites]


@router.post("", response_model=SiteOut, status_code=201)
def create_site(payload: SiteCreate, request: Request, user: OperatorUser, db: DbSession) -> SiteOut:
    existing = db.scalar(select(Site).where(Site.name == payload.name))
    if existing is not None:
        raise validation_failed("Site already exists", details={"name": payload.name})
    site = Site(
        name=payload.name,
        timezone=payload.timezone,
        proxy_id=payload.proxy_id,
        tags_json=json.dumps(payload.tags, ensure_ascii=False),
    )
    db.add(site)
    db.flush()
    record_audit(
        db,
        actor_id=user.id,
        action="site.create",
        target_type="site",
        target_id=site.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"name": site.name},
    )
    db.commit()
    db.refresh(site)
    return _site_out(site, 0)


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: str, _: ViewerUser, db: DbSession) -> SiteOut:
    site = db.get(Site, site_id)
    if site is None:
        raise not_found("Site not found")
    count = db.scalar(select(func.count()).select_from(Device).where(Device.site_id == site_id)) or 0
    return _site_out(site, count)


@router.patch("/{site_id}", response_model=SiteOut)
def update_site(
    site_id: str,
    payload: SiteUpdate,
    request: Request,
    user: OperatorUser,
    db: DbSession,
) -> SiteOut:
    site = db.get(Site, site_id)
    if site is None:
        raise not_found("Site not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] != site.name:
        duplicate = db.scalar(select(Site).where(Site.name == data["name"]))
        if duplicate is not None:
            raise validation_failed("Site already exists", details={"name": data["name"]})
        site.name = data["name"]
    if "timezone" in data and data["timezone"] is not None:
        site.timezone = data["timezone"]
    if "proxy_id" in data:
        site.proxy_id = data["proxy_id"] or None
    if "tags" in data and data["tags"] is not None:
        site.tags_json = json.dumps(data["tags"], ensure_ascii=False)
    record_audit(
        db,
        actor_id=user.id,
        action="site.update",
        target_type="site",
        target_id=site.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff=data,
    )
    db.commit()
    db.refresh(site)
    count = db.scalar(select(func.count()).select_from(Device).where(Device.site_id == site_id)) or 0
    return _site_out(site, count)


@router.delete("/{site_id}", status_code=204)
def delete_site(site_id: str, request: Request, user: OperatorUser, db: DbSession) -> None:
    site = db.get(Site, site_id)
    if site is None:
        raise not_found("Site not found")
    count = db.scalar(select(func.count()).select_from(Device).where(Device.site_id == site_id)) or 0
    if count:
        raise AppError(
            status_code=409,
            code="SITE_HAS_DEVICES",
            message="Нельзя удалить площадку, пока к ней привязаны устройства",
            details={"devices_count": count},
        )
    record_audit(
        db,
        actor_id=user.id,
        action="site.delete",
        target_type="site",
        target_id=site.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"name": site.name},
    )
    db.delete(site)
    db.commit()
