from fastapi import APIRouter, Request

from app.deps import AppSettings, DbSession
from app.schemas import LoginRequest, RefreshRequest, TokenResponse
from app.services.audit import record_audit
from app.services.auth import (
    authenticate_user,
    create_access_token,
    create_refresh_token,
    get_user_roles,
    rotate_refresh_token,
)

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession, settings: AppSettings) -> TokenResponse:
    user = authenticate_user(db, payload.email, payload.password)
    roles = get_user_roles(user)
    access = create_access_token(settings, user, roles)
    refresh = create_refresh_token(settings, db, user)
    record_audit(
        db,
        actor_id=user.id,
        action="auth.login",
        target_type="user",
        target_id=user.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
    )
    db.commit()
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, request: Request, db: DbSession, settings: AppSettings) -> TokenResponse:
    user, access, refresh_token = rotate_refresh_token(settings, db, payload.refresh_token)
    record_audit(
        db,
        actor_id=user.id,
        action="auth.refresh",
        target_type="user",
        target_id=user.id,
        request_id=getattr(request.state, "request_id", None),
        ip=request.client.host if request.client else None,
    )
    db.commit()
    return TokenResponse(
        access_token=access,
        refresh_token=refresh_token,
        expires_in=settings.access_token_ttl_minutes * 60,
    )