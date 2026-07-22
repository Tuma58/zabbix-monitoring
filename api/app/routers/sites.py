import json

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.deps import DbSession, OperatorUser, ViewerUser
from app.errors import validation_failed
from app.models import Site
from app.schemas import SiteCreate, SiteOut
from app.services.audit import record_audit

router = APIRouter()


def _site_out(site: Site) -> SiteOut:
    tags = json.loads(site.tags_json or "[]")
    return SiteOut(
        id=site.id,
        name=site.name,
        timezone=site.timezone,
        proxy_id=site.proxy_id,
        tags=tags if isinstance(tags, list) else [],
    )


@router.get("", response_model=list[SiteOut])
def list_sites(_: ViewerUser, db: DbSession) -> list[SiteOut]:
    sites = db.scalars(select(Site).order_by(Site.name)).all()
    return [_site_out(site) for site in sites]


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
    return _site_out(site)