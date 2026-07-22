from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import Settings
from app.errors import dependency_unavailable, zabbix_api_error


@dataclass
class CircuitBreaker:
    failure_threshold: int = 5
    reset_seconds: float = 30.0
    failures: int = 0
    opened_at: float | None = None

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        if time.monotonic() - self.opened_at >= self.reset_seconds:
            self.opened_at = None
            self.failures = 0
            return True
        return False

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= self.failure_threshold:
            self.opened_at = time.monotonic()


@dataclass
class ZabbixGateway:
    settings: Settings
    _auth_token: str | None = None
    _breaker: CircuitBreaker = field(default_factory=CircuitBreaker)

    @property
    def enabled(self) -> bool:
        return bool(
            self.settings.zabbix_enabled
            and self.settings.zabbix_api_url
            and self.settings.zabbix_api_user
            and self.settings.zabbix_api_password
        )

    async def call(self, method: str, params: dict[str, Any] | list[Any] | None = None) -> Any:
        if not self.enabled:
            raise dependency_unavailable("Zabbix API integration is not configured")
        if not self._breaker.allow():
            raise dependency_unavailable("Zabbix API circuit breaker is open")

        if method != "user.login" and self._auth_token is None:
            await self.login()

        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": 1,
            "auth": None if method in {"user.login", "apiinfo.version"} else self._auth_token,
        }

        try:
            async with httpx.AsyncClient(timeout=self.settings.zabbix_api_timeout_seconds) as client:
                response = await client.post(self.settings.zabbix_api_url, json=payload)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPError as exc:
            self._breaker.record_failure()
            raise dependency_unavailable("Zabbix API is unreachable", details={"error": str(exc)}) from exc

        if "error" in body:
            self._breaker.record_failure()
            error = body["error"]
            raise zabbix_api_error(
                error.get("data") or error.get("message") or "Zabbix API error",
                details={"code": error.get("code"), "message": error.get("message")},
            )

        self._breaker.record_success()
        return body.get("result")

    async def login(self) -> str:
        token = await self.call(
            "user.login",
            {"username": self.settings.zabbix_api_user, "password": self.settings.zabbix_api_password},
        )
        if not isinstance(token, str) or not token:
            raise zabbix_api_error("Zabbix login did not return an auth token")
        self._auth_token = token
        return token

    async def api_version(self) -> str | None:
        if not self.enabled:
            return None
        try:
            result = await self.call("apiinfo.version")
        except Exception:  # noqa: BLE001 - readiness probes must stay soft
            return None
        return str(result) if result is not None else None

    async def ping(self) -> dict[str, Any]:
        if not self.enabled:
            return {"status": "disabled"}
        version = await self.api_version()
        if version is None:
            return {"status": "unavailable"}
        return {"status": "ok", "version": version}

    def capability_matrix(self, version: str | None) -> dict[str, Any]:
        """Conservative capability matrix for Zabbix 7.0 LTS."""
        major_minor = ".".join((version or "0.0").split(".")[:2])
        supported = major_minor.startswith("7.0")
        return {
            "zabbix_version": version,
            "supported": supported,
            "features": {
                "problems.get": supported,
                "host.create": supported,
                "event.acknowledge": supported,
                "token_auth": supported,
            },
        }