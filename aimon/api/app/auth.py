from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Iterable

from fastapi import Depends, HTTPException, Request

ROLES = ("admin", "engineer", "user")
ROLE_LABELS = {
    "admin": "Администратор",
    "engineer": "Инженер",
    "user": "Пользователь",
}

# role -> allowed capabilities
CAPS = {
    "admin": {
        "users", "hosts_read", "hosts_write", "sites", "scan", "secrets", "ai", "settings", "agents_token",
    },
    "engineer": {
        "hosts_read", "hosts_write", "sites", "scan", "secrets", "ai", "settings", "agents_token",
    },
    "user": {
        "hosts_read",
    },
}


def hash_password(password: str, *, iterations: int = 200_000) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_b64, hash_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iters_s)
        salt = base64.urlsafe_b64decode(salt_b64.encode())
        expected = base64.urlsafe_b64decode(hash_b64.encode())
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(dk, expected)
    except Exception:  # noqa: BLE001
        return False


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + pad).encode("ascii"))


def create_token(payload: dict[str, Any], secret: str, *, ttl_seconds: int = 86400 * 7) -> str:
    body = {
        **payload,
        "iat": int(time.time()),
        "exp": int(time.time()) + int(ttl_seconds),
    }
    raw = _b64url(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    sig = _b64url(hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).digest())
    return f"{raw}.{sig}"


def decode_token(token: str, secret: str) -> dict[str, Any]:
    try:
        raw, sig = token.split(".", 1)
        expect = _b64url(hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expect):
            raise ValueError("bad signature")
        body = json.loads(_b64url_decode(raw).decode("utf-8"))
        if int(body.get("exp", 0)) < int(time.time()):
            raise ValueError("expired")
        return body
    except Exception as exc:  # noqa: BLE001
        raise ValueError("invalid token") from exc


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name") or user["username"],
        "role": user.get("role") or "user",
        "role_label": ROLE_LABELS.get(user.get("role") or "user", user.get("role")),
        "enabled": bool(user.get("enabled", True)),
        "hosts": list(user.get("hosts") or []),
        "created_at": user.get("created_at"),
    }


def has_cap(role: str, cap: str) -> bool:
    return cap in CAPS.get(role, set())


def require_caps(*caps: str):
    async def _dep(request: Request) -> dict[str, Any]:
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(401, "Требуется авторизация")
        role = user.get("role") or "user"
        for cap in caps:
            if not has_cap(role, cap):
                raise HTTPException(403, "Недостаточно прав")
        return user

    return _dep


def filter_hosts_for_user(user: dict[str, Any], hosts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    role = user.get("role") or "user"
    if role in ("admin", "engineer"):
        return list(hosts)
    allowed = set(user.get("hosts") or [])
    return [h for h in hosts if h.get("name") in allowed]
