from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "AIMon API"
    api_prefix: str = "/api/v1"

    # Checkmk REST API
    checkmk_url: str = ""  # e.g. http://checkmk:5000/cmk/check_mk/api/1.0
    checkmk_site: str = "cmk"
    checkmk_user: str = "automation"
    checkmk_secret: str = ""
    checkmk_timeout: float = 60.0

    # Secrets envelope key (Fernet). Generate a stable value in production.
    secrets_master_key: str = "change-me-32-byte-master-key!!!!"

    # Data store (JSON on disk keeps the scaffold dependency-free)
    data_dir: str = "/data"

    # Network scan safety: only these CIDRs may be scanned
    scan_allowlist: str = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10"

    # Client access: empty = allow all; otherwise only listed IPs/CIDRs may call the API
    client_access_allowlist: str = ""

    # DeepSeek (AI service) — optional; empty disables AI endpoints gracefully
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"

    # AI dialog memory
    chat_ttl_seconds: int = 3600

    # Managed config files root (mounted / shared with host configs)
    config_root: str = "/data/configs"

    # Auth
    auth_token_ttl_seconds: int = 604800  # 7 days
    aimon_admin_username: str = "admin"
    aimon_admin_password: str = "AdminChangeMe!"

    cors_origins: str = "*"

    @property
    def scan_allowlist_cidrs(self) -> list[str]:
        return [c.strip() for c in self.scan_allowlist.split(",") if c.strip()]

    @property
    def client_access_allowlist_cidrs(self) -> list[str]:
        return [c.strip() for c in self.client_access_allowlist.split(",") if c.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()] or ["*"]

    @property
    def checkmk_enabled(self) -> bool:
        return bool(self.checkmk_url and self.checkmk_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
