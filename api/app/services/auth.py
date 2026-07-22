from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import Settings
from app.db import utcnow
from app.errors import AppError, auth_required, permission_denied
from app.models import RefreshToken, Role, RoleName, User, UserRole, UserStatus

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

ROLE_RANK = {
    RoleName.VIEWER.value: 1,
    RoleName.OPERATOR.value: 2,
    RoleName.ADMIN.value: 3,
}


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(settings: Settings, user: User, roles: list[str]) -> str:
    now = utcnow()
    payload = {
        "sub": user.id,
        "email": user.email,
        "roles": roles,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_refresh_token(settings: Settings, db: Session, user: User) -> str:
    raw = secrets.token_urlsafe(48)
    expires_at = utcnow() + timedelta(days=settings.refresh_token_ttl_days)
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            expires_at=expires_at,
        )
    )
    db.flush()
    return raw


def decode_access_token(settings: Settings, token: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise auth_required("Invalid or expired access token") from exc
    if payload.get("type") != "access":
        raise auth_required("Invalid access token type")
    return payload


def get_user_roles(user: User) -> list[str]:
    return sorted({item.role.name for item in user.roles if item.role is not None})


def require_roles(user_roles: list[str], minimum: RoleName) -> None:
    best = max((ROLE_RANK.get(role, 0) for role in user_roles), default=0)
    if best < ROLE_RANK[minimum.value]:
        raise permission_denied()


def authenticate_user(db: Session, email: str, password: str) -> User:
    user = db.scalar(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role)).where(User.email == email)
    )
    if user is None or user.status != UserStatus.ACTIVE.value:
        raise AppError(status_code=401, code="AUTH_REQUIRED", message="Invalid credentials")
    if not verify_password(password, user.password_hash):
        raise AppError(status_code=401, code="AUTH_REQUIRED", message="Invalid credentials")
    return user


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def rotate_refresh_token(settings: Settings, db: Session, refresh_token: str) -> tuple[User, str, str]:
    token_row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token)))
    if token_row is None or token_row.revoked_at is not None:
        raise auth_required("Refresh token revoked or unknown")
    if _as_utc(token_row.expires_at) < utcnow():
        raise auth_required("Refresh token expired")
    user = db.scalar(
        select(User)
        .options(selectinload(User.roles).selectinload(UserRole.role))
        .where(User.id == token_row.user_id)
    )
    if user is None or user.status != UserStatus.ACTIVE.value:
        raise auth_required("User is not active")
    token_row.revoked_at = utcnow()
    roles = get_user_roles(user)
    access = create_access_token(settings, user, roles)
    new_refresh = create_refresh_token(settings, db, user)
    return user, access, new_refresh


def ensure_role(db: Session, name: RoleName) -> Role:
    role = db.scalar(select(Role).where(Role.name == name.value))
    if role is None:
        role = Role(name=name.value)
        db.add(role)
        db.flush()
    return role


def ensure_admin_user(db: Session, settings: Settings) -> User:
    for role_name in RoleName:
        ensure_role(db, role_name)

    user = db.scalar(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role)).where(User.email == settings.bootstrap_admin_email)
    )
    if user is None:
        user = User(
            email=settings.bootstrap_admin_email,
            password_hash=hash_password(settings.bootstrap_admin_password),
            status=UserStatus.ACTIVE.value,
        )
        db.add(user)
        db.flush()
        admin_role = ensure_role(db, RoleName.ADMIN)
        db.add(UserRole(user_id=user.id, role_id=admin_role.id))
        db.flush()
        user = db.scalar(
            select(User).options(selectinload(User.roles).selectinload(UserRole.role)).where(User.id == user.id)
        )
        assert user is not None
    return user


def public_key_fingerprint(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii")


def isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")