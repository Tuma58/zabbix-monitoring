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
            self._write({"secrets": [], "scans": [], "chats": {}})
        # ensure chats key exists on older stores
        with self._lock:
            data = self._read()
            if "chats" not in data:
                data["chats"] = {}
                self._write(data)

    def _read(self) -> dict[str, Any]:
        try:
            with open(self._path, encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"secrets": [], "scans": [], "chats": {}}

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
