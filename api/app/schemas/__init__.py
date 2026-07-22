from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _require_email(value: str) -> str:
    normalized = value.strip().lower()
    if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
        raise ValueError("Invalid email address")
    local, _, domain = normalized.partition("@")
    if not local or not domain or " " in normalized:
        raise ValueError("Invalid email address")
    return normalized


class LoginRequest(APIModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _require_email(value)


class TokenResponse(APIModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RefreshRequest(APIModel):
    refresh_token: str


class MeResponse(APIModel):
    id: str
    email: str
    roles: list[str]
    permissions: list[str]

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _require_email(value)


class SiteCreate(APIModel):
    name: str = Field(min_length=1, max_length=128)
    timezone: str = "Europe/Moscow"
    proxy_id: str | None = None
    tags: list[str] = Field(default_factory=list)


class SiteOut(APIModel):
    id: str
    name: str
    timezone: str
    proxy_id: str | None
    tags: list[str]


class DeviceCreate(APIModel):
    site_id: str
    name: str = Field(min_length=1, max_length=255)
    address: str = Field(min_length=1, max_length=255)
    device_type: str = Field(min_length=1, max_length=64)
    vendor: str | None = None
    model: str | None = None


class DeviceOut(APIModel):
    id: str
    site_id: str
    zabbix_host_id: str | None
    name: str
    address: str
    device_type: str
    vendor: str | None
    model: str | None
    status: str
    version: int


class ProblemAckRequest(APIModel):
    message: str | None = Field(default=None, max_length=512)


class ProblemOut(APIModel):
    event_id: str
    severity: str
    host: str
    site: str
    summary: str
    duration: str
    acknowledged: bool
    owner: str | None = None


class DashboardSummary(APIModel):
    generated_at: datetime
    source: str
    availability: dict[str, int]
    problems: dict[str, int]
    devices_total: int
    sites_total: int
    monitoring_gaps: int
    stale: bool = False
    zabbix: dict[str, Any] = Field(default_factory=dict)


class HealthLive(APIModel):
    status: str


class HealthReady(APIModel):
    status: str
    database: str
    redis: str
    zabbix: dict[str, Any]


class CredentialProfileCreate(APIModel):
    name: str = Field(min_length=1, max_length=128)
    profile_type: str = Field(min_length=1, max_length=32)
    secrets: dict[str, Any]


class CredentialProfileOut(APIModel):
    id: str
    name: str
    profile_type: str
    key_version: int
    public: dict[str, Any]


class OperationOut(APIModel):
    id: str
    kind: str
    state: str
    progress: int
    error_code: str | None = None
    result: dict[str, Any] = Field(default_factory=dict)
    links: dict[str, str] = Field(default_factory=dict)


class ProbeRequest(APIModel):
    site_id: str
    address: str
    device_type: str
    protocol: str
    credential_profile_id: str | None = None


class AuditEventOut(APIModel):
    id: str
    actor_id: str | None
    action: str
    target_type: str | None
    target_id: str | None
    request_id: str | None
    result: str
    ip: str | None
    created_at: datetime
    diff: dict[str, Any] = Field(default_factory=dict)