from fastapi import APIRouter

from app.deps import CurrentUser
from app.schemas import MeResponse
from app.services.auth import get_user_roles

router = APIRouter()

PERMISSIONS = {
    "admin": [
        "sites:write",
        "devices:write",
        "credentials:write",
        "problems:ack",
        "audit:read",
        "settings:write",
    ],
    "operator": ["devices:write", "problems:ack", "credentials:read"],
    "viewer": ["sites:read", "devices:read", "problems:read", "dashboard:read"],
}


@router.get("/me", response_model=MeResponse)
def me(user: CurrentUser) -> MeResponse:
    roles = get_user_roles(user)
    permissions: set[str] = set()
    for role in roles:
        permissions.update(PERMISSIONS.get(role, []))
    return MeResponse(id=user.id, email=user.email, roles=roles, permissions=sorted(permissions))