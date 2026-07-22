from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "NetMon API"
    api_prefix: str = "/api/v1"
    environment: str = "development"
    database_url: str = "sqlite+pysqlite:////tmp/netmon.db"
    redis_url: str = "redis://redis:6379/0"
    redis_required: bool = False

    jwt_secret: str = Field(default="change-me-jwt-secret-in-production")
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14

    secrets_master_key: str = Field(
        default="change-me-32-byte-master-key!!",
        description="Master key for credential envelope encryption",
    )

    bootstrap_admin_email: str = "admin@example.com"
    bootstrap_admin_password: str = "ChangeMeNow!"

    zabbix_api_url: str = "http://zabbix-web:8080/api_jsonrpc.php"
    zabbix_api_user: str = ""
    zabbix_api_password: str = ""
    zabbix_api_timeout_seconds: float = 10.0
    zabbix_enabled: bool = False

    cors_origins: str = "http://127.0.0.1:7081,https://127.0.0.1:7444,http://100.10.10.66:7081,https://100.10.10.66:7444,http://localhost:7081"
    probe_network_allowlist: str = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _strip_origins(cls, value: str) -> str:
        return value or ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def probe_allowlist_cidrs(self) -> list[str]:
        return [item.strip() for item in self.probe_network_allowlist.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()