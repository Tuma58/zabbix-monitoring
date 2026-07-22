from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import Settings
from app.errors import AppError


def _fernet_from_master_key(master_key: str) -> Fernet:
    digest = hashlib.sha256(master_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


class SecretBox:
    """Envelope encryption for write-only credential payloads."""

    def __init__(self, settings: Settings) -> None:
        self._fernet = _fernet_from_master_key(settings.secrets_master_key)
        self.key_version = 1

    def encrypt(self, payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        return self._fernet.encrypt(raw).decode("ascii")

    def decrypt(self, encrypted_payload: str) -> dict[str, Any]:
        try:
            raw = self._fernet.decrypt(encrypted_payload.encode("ascii"))
        except InvalidToken as exc:
            raise AppError(
                status_code=500,
                code="SECRET_DECRYPT_FAILED",
                message="Unable to decrypt credential payload",
            ) from exc
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise AppError(
                status_code=500,
                code="SECRET_DECRYPT_FAILED",
                message="Credential payload format is invalid",
            )
        return data

    @staticmethod
    def public_view(profile_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Return non-secret metadata only."""
        safe_keys = {"username", "security_level", "auth_protocol", "priv_protocol", "version", "mode"}
        return {
            "type": profile_type,
            **{key: value for key, value in payload.items() if key in safe_keys},
            "has_secrets": True,
        }