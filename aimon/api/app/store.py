from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any


class JsonStore:
    """Tiny thread-safe JSON store so the scaffold has no DB dependency.

    Replace with Postgres/SQLAlchemy for production.
    """

    def __init__(self, data_dir: str) -> None:
        self._dir = data_dir
        self._lock = threading.Lock()
        os.makedirs(data_dir, exist_ok=True)
        self._path = os.path.join(data_dir, "store.json")
        if not os.path.exists(self._path):
            self._write({"secrets": [], "scans": [], "chats": {}, "users": []})
        # ensure keys exist on older stores
        with self._lock:
            data = self._read()
            changed = False
            for key, default in (("chats", {}), ("users", []), ("secrets", []), ("scans", [])):
                if key not in data:
                    data[key] = default
                    changed = True
            if changed:
                self._write(data)

    def _read(self) -> dict[str, Any]:
        try:
            with open(self._path, encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"secrets": [], "scans": [], "chats": {}, "users": []}

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self._path)

    # secrets -----------------------------------------------------------
    def list_secrets(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {k: v for k, v in s.items() if k != "value"}
                for s in self._read().get("secrets", [])
            ]

    def get_secret(self, secret_id: str) -> dict[str, Any] | None:
        with self._lock:
            for s in self._read().get("secrets", []):
                if s["id"] == secret_id:
                    return s
        return None

    def add_secret(self, name: str, kind: str, encrypted_value: str) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            entry = {
                "id": uuid.uuid4().hex,
                "name": name,
                "kind": kind,
                "value": encrypted_value,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            }
            data.setdefault("secrets", []).append(entry)
            self._write(data)
            return {k: v for k, v in entry.items() if k != "value"}

    def delete_secret(self, secret_id: str) -> bool:
        with self._lock:
            data = self._read()
            before = len(data.get("secrets", []))
            data["secrets"] = [s for s in data.get("secrets", []) if s["id"] != secret_id]
            self._write(data)
            return len(data["secrets"]) < before

    # chat memory (1 hour rolling window) --------------------------------
    def append_chat(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        ttl_seconds: int = 3600,
        meta: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        sid = (session_id or "").strip() or "default"
        now = datetime.now(timezone.utc)
        cutoff = now.timestamp() - ttl_seconds
        entry: dict[str, Any] = {
            "role": role,
            "content": content,
            "ts": now.isoformat(),
            "epoch": now.timestamp(),
        }
        if meta:
            entry["meta"] = meta
        with self._lock:
            data = self._read()
            chats = data.setdefault("chats", {})
            msgs = [m for m in chats.get(sid, []) if float(m.get("epoch", 0)) >= cutoff]
            msgs.append(entry)
            chats[sid] = msgs[-80:]
            stale = [k for k, v in chats.items() if not v or float(v[-1].get("epoch", 0)) < cutoff]
            for k in stale:
                chats.pop(k, None)
            self._write(data)
            return list(chats[sid])

    def get_chat(self, session_id: str, *, ttl_seconds: int = 3600) -> list[dict[str, Any]]:
        sid = (session_id or "").strip() or "default"
        cutoff = datetime.now(timezone.utc).timestamp() - ttl_seconds
        with self._lock:
            data = self._read()
            return [
                m
                for m in data.get("chats", {}).get(sid, [])
                if float(m.get("epoch", 0)) >= cutoff
            ]

    def clear_chat(self, session_id: str) -> bool:
        sid = (session_id or "").strip() or "default"
        with self._lock:
            data = self._read()
            chats = data.setdefault("chats", {})
            existed = sid in chats
            chats.pop(sid, None)
            self._write(data)
            return existed

    # users -------------------------------------------------------------
    def list_users(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._read().get("users", []))

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self._lock:
            for u in self._read().get("users", []):
                if u.get("id") == user_id:
                    return dict(u)
        return None

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        uname = (username or "").strip().lower()
        with self._lock:
            for u in self._read().get("users", []):
                if str(u.get("username", "")).lower() == uname:
                    return dict(u)
        return None

    def create_user(
        self,
        *,
        username: str,
        password_hash: str,
        role: str,
        display_name: str = "",
        hosts: list[str] | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        uname = (username or "").strip()
        if not uname:
            raise ValueError("username required")
        with self._lock:
            data = self._read()
            users = data.setdefault("users", [])
            if any(str(u.get("username", "")).lower() == uname.lower() for u in users):
                raise ValueError("username already exists")
            entry = {
                "id": uuid.uuid4().hex,
                "username": uname,
                "password_hash": password_hash,
                "role": role,
                "display_name": (display_name or uname).strip(),
                "hosts": list(hosts or []),
                "enabled": bool(enabled),
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            }
            users.append(entry)
            self._write(data)
            return dict(entry)

    def update_user(self, user_id: str, **fields: Any) -> dict[str, Any] | None:
        with self._lock:
            data = self._read()
            users = data.setdefault("users", [])
            for i, u in enumerate(users):
                if u.get("id") != user_id:
                    continue
                updated = dict(u)
                if "username" in fields and fields["username"]:
                    new_name = str(fields["username"]).strip()
                    if any(
                        str(x.get("username", "")).lower() == new_name.lower() and x.get("id") != user_id
                        for x in users
                    ):
                        raise ValueError("username already exists")
                    updated["username"] = new_name
                if "display_name" in fields and fields["display_name"] is not None:
                    updated["display_name"] = str(fields["display_name"]).strip()
                if "role" in fields and fields["role"]:
                    updated["role"] = fields["role"]
                if "hosts" in fields and fields["hosts"] is not None:
                    updated["hosts"] = list(fields["hosts"])
                if "enabled" in fields and fields["enabled"] is not None:
                    updated["enabled"] = bool(fields["enabled"])
                if "password_hash" in fields and fields["password_hash"]:
                    updated["password_hash"] = fields["password_hash"]
                users[i] = updated
                self._write(data)
                return dict(updated)
        return None

    def delete_user(self, user_id: str) -> bool:
        with self._lock:
            data = self._read()
            before = len(data.get("users", []))
            data["users"] = [u for u in data.get("users", []) if u.get("id") != user_id]
            self._write(data)
            return len(data["users"]) < before

    def rename_host_refs(self, old_name: str, new_name: str) -> None:
        """Keep user host ACLs in sync when a Checkmk host is renamed."""
        with self._lock:
            data = self._read()
            changed = False
            for u in data.get("users", []):
                hosts = list(u.get("hosts") or [])
                if old_name in hosts:
                    u["hosts"] = [new_name if h == old_name else h for h in hosts]
                    changed = True
            if changed:
                self._write(data)

    def remove_host_refs(self, name: str) -> None:
        """Drop a deleted host from all user ACLs."""
        with self._lock:
            data = self._read()
            changed = False
            for u in data.get("users", []):
                hosts = list(u.get("hosts") or [])
                if name in hosts:
                    u["hosts"] = [h for h in hosts if h != name]
                    changed = True
            if changed:
                self._write(data)
