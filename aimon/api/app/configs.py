from __future__ import annotations

import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ALLOWED_SUFFIXES = {
    ".conf",
    ".cfg",
    ".ini",
    ".yaml",
    ".yml",
    ".json",
    ".txt",
    ".sh",
    ".env.example",
    ".md",
}
MAX_BYTES = 512_000
SECRET_RE = re.compile(
    r"(?i)(password|secret|api[_-]?key|token|authorization)\s*[=:]\s*['\"]?([^\s'\"]+)"
)


class ConfigManager:
    """Safe read/analyze/write for allowlisted config files under config_root."""

    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "custom").mkdir(parents=True, exist_ok=True)

    def _safe(self, rel: str) -> Path:
        raw = (rel or "").strip().lstrip("/")
        if not raw or ".." in raw.split("/"):
            raise ValueError("invalid path")
        path = (self.root / raw).resolve()
        if not str(path).startswith(str(self.root) + os.sep) and path != self.root:
            raise ValueError("path escapes config root")
        if path.suffix.lower() not in ALLOWED_SUFFIXES and not any(
            str(path).endswith(s) for s in ALLOWED_SUFFIXES
        ):
            raise ValueError(f"suffix not allowed: {path.suffix}")
        return path

    def list_files(self) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        for p in sorted(self.root.rglob("*")):
            if not p.is_file():
                continue
            if p.suffix.lower() not in ALLOWED_SUFFIXES and not any(
                str(p).endswith(s) for s in ALLOWED_SUFFIXES
            ):
                continue
            if p.name.endswith(".bak") or ".bak." in p.name:
                continue
            rel = str(p.relative_to(self.root))
            st = p.stat()
            files.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime)})
        return {"ok": True, "root": str(self.root), "files": files, "count": len(files)}

    def read(self, rel: str, max_chars: int = 40_000) -> dict[str, Any]:
        path = self._safe(rel)
        if not path.is_file():
            return {"ok": False, "error": "file not found", "path": rel}
        data = path.read_bytes()
        if len(data) > MAX_BYTES:
            return {"ok": False, "error": f"file too large (>{MAX_BYTES} bytes)", "path": rel}
        text = data.decode("utf-8", "replace")
        return {
            "ok": True,
            "path": rel,
            "size": len(data),
            "content": text[:max_chars],
            "truncated": len(text) > max_chars,
        }

    def analyze(self, rel: str) -> dict[str, Any]:
        got = self.read(rel)
        if not got.get("ok"):
            return got
        text = got["content"]
        findings: list[str] = []
        listens = re.findall(r"(?im)^\s*listen\s+([^;]+);", text)
        upstreams = re.findall(r"(?im)^\s*proxy_pass\s+([^;]+);", text)
        servers = re.findall(r"(?im)^\s*server_name\s+([^;]+);", text)
        if listens:
            findings.append(f"nginx listen: {', '.join(x.strip() for x in listens[:12])}")
        if upstreams:
            findings.append(f"proxy_pass: {', '.join(x.strip() for x in upstreams[:12])}")
        if servers:
            findings.append(f"server_name: {', '.join(x.strip() for x in servers[:8])}")
        if text.count("{") != text.count("}"):
            findings.append("warning: unbalanced braces { }")
        secrets = SECRET_RE.findall(text)
        if secrets:
            findings.append(f"warning: possible secrets in file ({len(secrets)} match(es))")
        if rel.endswith((".yaml", ".yml")):
            try:
                import json as _json  # noqa: F401 — structure hint only

                # lightweight YAML sanity: indentation tabs
                if "\t" in text:
                    findings.append("warning: YAML contains tabs")
            except Exception:  # noqa: BLE001
                pass
        if not text.strip():
            findings.append("file is empty")
        return {
            "ok": True,
            "path": rel,
            "lines": text.count("\n") + (1 if text else 0),
            "findings": findings,
            "preview": "\n".join(text.splitlines()[:40]),
        }

    def write(self, rel: str, content: str, *, backup: bool = True) -> dict[str, Any]:
        path = self._safe(rel)
        if content is None:
            return {"ok": False, "error": "content required"}
        raw = content.encode("utf-8")
        if len(raw) > MAX_BYTES:
            return {"ok": False, "error": f"content too large (>{MAX_BYTES} bytes)"}
        path.parent.mkdir(parents=True, exist_ok=True)
        backup_path = None
        if backup and path.exists():
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_path = path.with_name(path.name + f".bak.{ts}")
            shutil.copy2(path, backup_path)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, path)
        restart = []
        name = path.name.lower()
        if "edge" in name or name == "nginx.conf" and "dashboard" not in str(path):
            restart.append("edge")
        if "dashboard" in name:
            restart.append("dashboard")
        return {
            "ok": True,
            "path": rel,
            "bytes": len(raw),
            "backup": str(backup_path.relative_to(self.root)) if backup_path else None,
            "restart_hint": restart,
        }

    def patch(self, rel: str, old: str, new: str, *, replace_all: bool = False) -> dict[str, Any]:
        got = self.read(rel, max_chars=MAX_BYTES)
        if not got.get("ok"):
            return got
        text = got["content"]
        if old not in text:
            return {"ok": False, "error": "old text not found", "path": rel}
        count = text.count(old)
        if not replace_all and count > 1:
            return {
                "ok": False,
                "error": f"old text found {count} times; set replace_all=true or make old unique",
                "path": rel,
            }
        updated = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        result = self.write(rel, updated, backup=True)
        result["replacements"] = count if replace_all else 1
        return result
