import json

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.deps import AppSettings, DbSession, Gateway, OperatorUser, Secrets, ViewerUser
from app.errors import AppError, not_found
from app.models import CredentialProfile
from app.schemas import (
    CredentialEnsureRequest,
    CredentialEnsureResponse,
    CredentialProfileCreate,
    CredentialProfileOut,
    MonitoringCatalogEntry,
)
from app.services.audit import record_audit
from app.services.secrets import SecretBox
from app.services.zabbix_catalog import list_catalog_entries
from app.services.zabbix_provisioner import ensure_credential_profile, profile_out

router = APIRouter()


@router.get("/catalog", response_model=list[MonitoringCatalogEntry])
def list_monitoring_catalog(_: ViewerUser) -> list[MonitoringCatalogEntry]:
    return [MonitoringCatalogEntry(**entry) for entry in list_catalog_entries()]


@router.get("", response_model=list[CredentialProfileOut])
def list_credential_profiles(_: ViewerUser, db: DbSession, secrets: Secrets) -> list[CredentialProfileOut]:
    profiles = db.scalars(select(CredentialProfile).order_by(CredentialProfile.name)).all()
    return [CredentialProfileOut(**profile_out(profile, secrets)) for profile in profiles]


@router.post("", response_model=CredentialProfileOut, status_code=201)
def create_credential_profile(
    payload: CredentialProfileCreate,
    request: Request,
    user: OperatorUser,
    db: DbSession,
    secrets: Secrets,
) -> CredentialProfileOut:
    duplicate = db.scalar(select(CredentialProfile).where(CredentialProfile.name == payload.name))
    if duplicate is not None:
        raise AppError(
            status_code=409,
            code="CREDENTIAL_PROFILE_EXISTS",
            message="Credential profile name already exists",
        )
    profile = CredentialProfile(
        name=payload.name,
        profile_type=payload.profile_type,
        encrypted_payload=secrets.encrypt(payload.secrets),
        key_version=secrets.key_version,
    )
    db.add(profile)
    db.flush()
    record_audit(
        db,
        actor_id=user.id,
        action="credential.create",
        target_type="credential_profile",
        target_id=profile.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={"name": profile.name, "profile_type": profile.profile_type},
    )
    db.commit()
    db.refresh(profile)
    return CredentialProfileOut(**profile_out(profile, secrets))


@router.post("/ensure", response_model=CredentialEnsureResponse)
def ensure_monitoring_profile(
    payload: CredentialEnsureRequest,
    request: Request,
    user: OperatorUser,
    db: DbSession,
    secrets: Secrets,
    settings: AppSettings,
) -> CredentialEnsureResponse:
    profile, spec = ensure_credential_profile(
        db,
        secrets,
        settings,
        payload.device_type,
        payload.monitoring_subtype,
        payload.protocol,
    )
    record_audit(
        db,
        actor_id=user.id,
        action="credential.ensure",
        target_type="credential_profile",
        target_id=profile.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
        diff={
            "device_type": payload.device_type,
            "monitoring_subtype": payload.monitoring_subtype,
            "protocol": payload.protocol,
            "catalog_key": spec.key,
        },
    )
    db.commit()
    db.refresh(profile)
    return CredentialEnsureResponse(
        profile=CredentialProfileOut(**profile_out(profile, secrets)),
        catalog_key=spec.key,
        zabbix_templates=list(spec.zabbix_templates),
    )


@router.get("/{profile_id}", response_model=CredentialProfileOut)
def get_credential_profile(profile_id: str, _: ViewerUser, db: DbSession, secrets: Secrets) -> CredentialProfileOut:
    profile = db.get(CredentialProfile, profile_id)
    if profile is None:
        raise not_found("Credential profile not found")
    return CredentialProfileOut(**profile_out(profile, secrets))
