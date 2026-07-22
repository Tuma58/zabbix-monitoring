from fastapi import APIRouter

from app.routers import audit, auth, credentials, dashboard, devices, health, me, operations, problems, settings, sites

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(me.router, tags=["identity"])
api_router.include_router(sites.router, prefix="/sites", tags=["inventory"])
api_router.include_router(devices.router, prefix="/devices", tags=["inventory"])
api_router.include_router(credentials.router, prefix="/credentials", tags=["inventory"])
api_router.include_router(settings.router, prefix="/settings", tags=["settings"])
api_router.include_router(operations.router, prefix="/operations", tags=["operations"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(problems.router, prefix="/problems", tags=["dashboard"])
api_router.include_router(audit.router, prefix="/audit-events", tags=["audit"])