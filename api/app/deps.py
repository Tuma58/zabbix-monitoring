from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import Settings, get_settings
from app.db import get_db
from app.errors import auth_required
from app.models import RoleName, User, UserRole
from app.services.auth import decode_access_token, get_user_roles, require_roles
from app.services.secrets import SecretBox
from app.services.zabbix_gateway import ZabbixGateway

bearer_scheme = HTTPBearer(auto_error=False)


def get_gateway(settings: Annotated[Settings, Depends(get_settings)]) -> ZabbixGateway:
    return ZabbixGateway(settings=settings)


def get_secret_box(settings: Annotated[Settings, Depends(get_settings)]) -> SecretBox:
    return SecretBox(settings)


def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise auth_required()
    payload = decode_access_token(settings, credentials.credentials)
    user = db.scalar(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role)).where(User.id == payload["sub"])
    )
    if user is None:
        raise auth_required("User not found")
    request.state.user_id = user.id
    request.state.user_roles = get_user_roles(user)
    return user


def require_role(minimum: RoleName) -> Callable[[User], User]:
    def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        require_roles(get_user_roles(user), minimum)
        return user

    return dependency


CurrentUser = Annotated[User, Depends(get_current_user)]
DbSession = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]
Gateway = Annotated[ZabbixGateway, Depends(get_gateway)]
Secrets = Annotated[SecretBox, Depends(get_secret_box)]
AdminUser = Annotated[User, Depends(require_role(RoleName.ADMIN))]
OperatorUser = Annotated[User, Depends(require_role(RoleName.OPERATOR))]
ViewerUser = Annotated[User, Depends(require_role(RoleName.VIEWER))]