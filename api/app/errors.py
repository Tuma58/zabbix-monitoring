from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


def error_payload(request: Request, exc: AppError) -> dict[str, Any]:
    request_id = getattr(request.state, "request_id", None) or request.headers.get("X-Request-ID")
    return {
        "code": exc.code,
        "message": exc.message,
        "request_id": request_id,
        "details": exc.details or None,
    }


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=error_payload(request, exc))


def auth_required(message: str = "Authentication required") -> AppError:
    return AppError(status_code=401, code="AUTH_REQUIRED", message=message)


def permission_denied(message: str = "Insufficient permissions") -> AppError:
    return AppError(status_code=403, code="PERMISSION_DENIED", message=message)


def not_found(message: str = "Resource not found") -> AppError:
    return AppError(status_code=404, code="RESOURCE_NOT_FOUND", message=message)


def validation_failed(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(status_code=400, code="VALIDATION_FAILED", message=message, details=details)


def dependency_unavailable(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(status_code=503, code="DEPENDENCY_UNAVAILABLE", message=message, details=details)


def zabbix_api_error(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(status_code=502, code="ZABBIX_API_ERROR", message=message, details=details)