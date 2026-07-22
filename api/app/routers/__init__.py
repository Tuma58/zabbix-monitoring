from fastapi import APIRouter

from app.routers import audit, auth, dashboard, devices, health, me, operations, problems, sites

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(me.router, tags=["identity"])
api_router.include_router(sites.router, prefix="/sites", tags=["inventory"])
api_router.include_router(devices.router, prefix="/devices", tags=["inventory"])
api_router.include_router(operations.router, prefix="/operations", tags=["operations"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(problems.router, prefix="/problems", tags=["dashboard"])
api_router.include_router(audit.router, prefix="/audit-events", tags=["audit"])