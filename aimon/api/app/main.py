from __future__ import annotations

import secrets as pysecrets
from typing import Any

import httpx
from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.ai_assistant import AIAssistant
from app.auth import (
    ROLES,
    create_token,
    decode_token,
    filter_hosts_for_user,
    hash_password,
    public_user,
    require_caps,
    verify_password,
)
from app.checkmk import CheckmkClient
from app.config import get_settings
from app.scan import cidr_is_allowed, scan_snmp, suggest_device_name
from app.secrets import SecretBox
from app.store import JsonStore

settings = get_settings()
app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = JsonStore(settings.data_dir)
box = SecretBox(settings.secrets_master_key)
cmk = CheckmkClient(settings)
assistant = AIAssistant(settings, cmk, store, box)

P = settings.api_prefix
AuthUser = dict[str, Any]


def _bootstrap_admin() -> None:
    if store.list_users():
        return
    store.create_user(
        username=settings.aimon_admin_username or "admin",
        password_hash=hash_password(settings.aimon_admin_password or "AdminChangeMe!"),
        role="admin",
        display_name="Администратор",
        hosts=[],
        enabled=True,
    )


_bootstrap_admin()


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    request.state.user = None
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
        try:
            payload = decode_token(token, settings.secrets_master_key)
            user = store.get_user(str(payload.get("sub") or ""))
            if user and user.get("enabled", True):
                request.state.user = user
        except ValueError:
            request.state.user = None
    return await call_next(request)


# ---------- models ----------
class LoginIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    username: str
    password: str = ""
    display_name: str = ""
    role: str = "user"
    hosts: list[str] = Field(default_factory=list)
    enabled: bool = True


class UserUpdateIn(BaseModel):
    username: str | None = None
    password: str | None = None
    display_name: str | None = None
    role: str | None = None
    hosts: list[str] | None = None
    enabled: bool | None = None


class HostIn(BaseModel):
    name: str
    address: str = ""
    type: str = "agent"
    snmp_profile_id: str | None = None
    folder: str = "/"
    alias: str = ""


class HostUpdateIn(BaseModel):
    new_name: str | None = None
    address: str | None = None
    type: str | None = None
    snmp_profile_id: str | None = None
    folder: str | None = None
    alias: str | None = None


class SiteIn(BaseModel):
    name: str
    title: str = ""
    parent: str = "/"


class SiteUpdateIn(BaseModel):
    title: str


class SecretIn(BaseModel):
    name: str
    kind: str
    value: str


class AgentRegisterIn(BaseModel):
    hostname: str
    ip: str = ""
    os: str = ""
    token: str = ""


class ScanIn(BaseModel):
    cidr: str
    snmp_profile_id: str | None = None


class ScanAddIn(BaseModel):
    devices: list[dict[str, Any]]
    snmp_profile_id: str | None = None


class ChatIn(BaseModel):
    message: str
    session_id: str = "default"


# ---------- helpers ----------
def _community_for(profile_id: str | None) -> str | None:
    if not profile_id:
        return None
    sec = store.get_secret(profile_id)
    if not sec:
        return None
    if sec["kind"] in ("snmp_v2c",):
        return box.decrypt(sec["value"])
    return None


async def _hosts_enriched() -> list[dict[str, Any]]:
    if not cmk.enabled:
        return []
    try:
        hosts = await cmk.list_hosts()
    except httpx.HTTPError:
        return []
    titles: dict[str, str] = {}
    try:
        for f in await cmk.list_folders():
            titles[f["path"]] = f.get("title") or f["path"]
    except httpx.HTTPError:
        pass
    for h in hosts:
        path = h.get("folder") or "/"
        h["site_path"] = path
        h["site_title"] = titles.get(path, "Корень" if path == "/" else path)
    return hosts


def _assert_host_visible(user: AuthUser, name: str) -> None:
    if user.get("role") in ("admin", "engineer"):
        return
    if name not in set(user.get("hosts") or []):
        raise HTTPException(403, "Нет доступа к этому узлу")


# ---------- auth ----------
@app.post(f"{P}/auth/login")
async def login(payload: LoginIn) -> dict[str, Any]:
    user = store.get_user_by_username(payload.username)
    if not user or not user.get("enabled", True) or not verify_password(payload.password, user.get("password_hash", "")):
        raise HTTPException(401, "Неверный логин или пароль")
    token = create_token(
        {"sub": user["id"], "role": user.get("role"), "username": user.get("username")},
        settings.secrets_master_key,
        ttl_seconds=settings.auth_token_ttl_seconds,
    )
    return {"token": token, "user": public_user(user)}


@app.get(f"{P}/auth/me")
async def me(user: AuthUser = Depends(require_caps("hosts_read"))) -> dict[str, Any]:
    return public_user(user)


# ---------- users (admin) ----------
@app.get(f"{P}/users")
async def list_users(_: AuthUser = Depends(require_caps("users"))) -> list[dict[str, Any]]:
    return [public_user(u) for u in store.list_users()]


@app.post(f"{P}/users", status_code=201)
async def create_user(payload: UserIn, _: AuthUser = Depends(require_caps("users"))) -> dict[str, Any]:
    if payload.role not in ROLES:
        raise HTTPException(400, f"role must be one of: {', '.join(ROLES)}")
    if not payload.password or len(payload.password) < 6:
        raise HTTPException(400, "Пароль не короче 6 символов")
    try:
        user = store.create_user(
            username=payload.username,
            password_hash=hash_password(payload.password),
            role=payload.role,
            display_name=payload.display_name,
            hosts=payload.hosts if payload.role == "user" else [],
            enabled=payload.enabled,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return public_user(user)


@app.patch(f"{P}/users/{{user_id}}")
async def update_user(
    user_id: str,
    payload: UserUpdateIn,
    actor: AuthUser = Depends(require_caps("users")),
) -> dict[str, Any]:
    existing = store.get_user(user_id)
    if not existing:
        raise HTTPException(404, "User not found")
    role = payload.role if payload.role is not None else existing.get("role")
    if role not in ROLES:
        raise HTTPException(400, f"role must be one of: {', '.join(ROLES)}")
    fields: dict[str, Any] = {}
    if payload.username is not None:
        fields["username"] = payload.username
    if payload.display_name is not None:
        fields["display_name"] = payload.display_name
    if payload.role is not None:
        fields["role"] = payload.role
    if payload.enabled is not None:
        fields["enabled"] = payload.enabled
    if payload.hosts is not None:
        fields["hosts"] = payload.hosts if role == "user" else []
    if payload.password:
        if len(payload.password) < 6:
            raise HTTPException(400, "Пароль не короче 6 символов")
        fields["password_hash"] = hash_password(payload.password)
    # prevent locking yourself out
    if actor.get("id") == user_id and fields.get("enabled") is False:
        raise HTTPException(400, "Нельзя отключить свою учётную запись")
    if actor.get("id") == user_id and fields.get("role") and fields["role"] != "admin":
        raise HTTPException(400, "Нельзя снять с себя роль администратора")
    try:
        updated = store.update_user(user_id, **fields)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "User not found")
    return public_user(updated)


@app.delete(f"{P}/users/{{user_id}}", status_code=204, response_class=Response)
async def delete_user(user_id: str, actor: AuthUser = Depends(require_caps("users"))) -> Response:
    if actor.get("id") == user_id:
        raise HTTPException(400, "Нельзя удалить свою учётную запись")
    if not store.delete_user(user_id):
        raise HTTPException(404, "User not found")
    return Response(status_code=204)


# ---------- health / summary ----------
@app.get(f"{P}/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get(f"{P}/summary")
async def summary(user: AuthUser = Depends(require_caps("hosts_read"))) -> dict[str, Any]:
    engine: dict[str, Any] = {"status": "disabled"}
    hosts: list[dict[str, Any]] = []
    if cmk.enabled:
        try:
            ver = await cmk.version()
            engine = {"status": "ok", "version": ver.get("versions", {}).get("checkmk", "Checkmk")}
            hosts = await _hosts_enriched()
        except (httpx.HTTPError, Exception):  # noqa: BLE001
            engine = {"status": "down"}
    hosts = filter_hosts_for_user(user, hosts)
    up = sum(1 for h in hosts if h.get("state") in ("up", "ok"))
    return {
        "engine": engine,
        "hosts_total": len(hosts),
        "hosts_up": up,
        "hosts_down": len(hosts) - up,
        "services_total": sum(h.get("services", 0) for h in hosts),
        "problems": len(hosts) - up,
    }


# ---------- hosts ----------
@app.get(f"{P}/hosts")
async def list_hosts(user: AuthUser = Depends(require_caps("hosts_read"))) -> list[dict[str, Any]]:
    hosts = await _hosts_enriched()
    return filter_hosts_for_user(user, hosts)


@app.get(f"{P}/hosts/{{name}}")
async def get_host(name: str, user: AuthUser = Depends(require_caps("hosts_read"))) -> dict[str, Any]:
    _assert_host_visible(user, name)
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    host = await cmk.get_host(name)
    if not host:
        raise HTTPException(404, "Host not found")
    return host


@app.post(f"{P}/hosts", status_code=201)
async def create_host(payload: HostIn, _: AuthUser = Depends(require_caps("hosts_write"))) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id)
    if payload.type == "snmp" and not community:
        community = "public"
    try:
        return await cmk.register_and_activate(
            payload.name,
            payload.address,
            snmp_community=community if payload.type == "snmp" else None,
            folder=payload.folder or "/",
            alias=payload.alias or "",
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


@app.patch(f"{P}/hosts/{{name}}")
async def update_host(
    name: str,
    payload: HostUpdateIn,
    _: AuthUser = Depends(require_caps("hosts_write")),
) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id)
    current = name
    try:
        existing = await cmk.get_host(current)
        if not existing:
            raise HTTPException(404, f"Host not found: {current}")

        address = payload.address
        alias = payload.alias
        host_type = payload.type
        if address is not None and address == (existing.get("address") or ""):
            address = None
        if alias is not None and alias == (existing.get("alias") or ""):
            alias = None
        if host_type is not None and host_type == (existing.get("type") or "agent"):
            if not (host_type == "snmp" and community):
                host_type = None

        result = await cmk.update_host(
            current,
            address=address,
            alias=alias,
            snmp_community=community if payload.type == "snmp" else None,
            host_type=host_type,
        )

        target_folder = payload.folder
        if target_folder is not None:
            current_folder = existing.get("folder") or "/"
            if (target_folder or "/") != current_folder:
                await cmk.move_host(current, target_folder or "/")
            result["folder"] = target_folder or "/"

        await cmk.activate_changes()
        result["activated"] = True

        new_name = (payload.new_name or "").strip()
        if new_name and new_name != current:
            renamed = await cmk.rename_host(current, new_name)
            result.update(renamed)
            store.rename_host_refs(current, new_name)
            current = new_name
            await cmk.activate_changes()
            result["activated"] = True

        result["host"] = current
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


@app.delete(f"{P}/hosts/{{name}}", status_code=204, response_class=Response)
async def delete_host(name: str, _: AuthUser = Depends(require_caps("hosts_write"))) -> Response:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        await cmk.delete_host(name)
        await cmk.activate_changes()
        store.remove_host_refs(name)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    return Response(status_code=204)


# ---------- sites ----------
@app.get(f"{P}/sites")
async def list_sites(user: AuthUser = Depends(require_caps("hosts_read"))) -> list[dict[str, Any]]:
    if user.get("role") == "user":
        # viewers see only folders of assigned hosts
        hosts = filter_hosts_for_user(user, await _hosts_enriched())
        paths = {h.get("folder") or "/" for h in hosts}
        out = []
        for path in sorted(paths):
            out.append(
                {
                    "id": "~" if path == "/" else "~" + path.strip("/").replace("/", "~"),
                    "path": path,
                    "name": "" if path == "/" else path.strip("/").split("/")[-1],
                    "title": "Корень" if path == "/" else path,
                    "hosts_count": sum(1 for h in hosts if (h.get("folder") or "/") == path),
                }
            )
        return out or [{"id": "~", "path": "/", "name": "", "title": "Корень", "hosts_count": 0}]
    if not cmk.enabled:
        return [{"id": "~", "path": "/", "name": "", "title": "Корень", "hosts_count": 0}]
    try:
        folders = await cmk.list_folders()
        hosts = await cmk.list_hosts()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    counts: dict[str, int] = {}
    for h in hosts:
        p = h.get("folder") or "/"
        counts[p] = counts.get(p, 0) + 1
    for f in folders:
        f["hosts_count"] = counts.get(f["path"], 0)
    return folders


@app.post(f"{P}/sites", status_code=201)
async def create_site(payload: SiteIn, _: AuthUser = Depends(require_caps("sites"))) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        site = await cmk.create_folder(payload.name, title=payload.title or payload.name, parent=payload.parent or "/")
        await cmk.activate_changes()
        site["hosts_count"] = 0
        site["activated"] = True
        return site
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


@app.patch(f"{P}/sites/{{site_id}}")
async def update_site(
    site_id: str, payload: SiteUpdateIn, _: AuthUser = Depends(require_caps("sites"))
) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        site = await cmk.update_folder(site_id, title=payload.title)
        await cmk.activate_changes()
        site["activated"] = True
        return site
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


@app.delete(f"{P}/sites/{{site_id}}", status_code=204, response_class=Response)
async def delete_site(site_id: str, _: AuthUser = Depends(require_caps("sites"))) -> Response:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        await cmk.delete_folder(site_id)
        await cmk.activate_changes()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    return Response(status_code=204)


# ---------- agent auto-registration (open for installers) ----------
@app.post(f"{P}/agents/register")
async def agent_register(payload: AgentRegisterIn) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        result = await cmk.register_and_activate(payload.hostname, payload.ip)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    return {"registered": True, **result, "os": payload.os}


@app.post(f"{P}/agents/token")
async def issue_agent_token(_: AuthUser = Depends(require_caps("agents_token"))) -> dict[str, str]:
    token = pysecrets.token_urlsafe(24)
    store.add_secret(name=f"agent-token-{token[:6]}", kind="agent_token", encrypted_value=box.encrypt(token))
    return {"token": token}


# ---------- SNMP network scan ----------
@app.post(f"{P}/scan")
async def scan(payload: ScanIn, _: AuthUser = Depends(require_caps("scan"))) -> dict[str, Any]:
    if not cidr_is_allowed(payload.cidr, settings.scan_allowlist_cidrs):
        raise HTTPException(400, "CIDR is not in the scan allowlist")
    community = _community_for(payload.snmp_profile_id) or "public"
    return await scan_snmp(payload.cidr, community)


@app.post(f"{P}/scan/add")
async def scan_add(payload: ScanAddIn, _: AuthUser = Depends(require_caps("hosts_write"))) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id) or "public"
    added = []
    used: set[str] = set()
    for dev in payload.devices:
        ip = (dev.get("ip") or "").strip()
        if not ip:
            continue
        name = suggest_device_name(dev, used=used)
        alias = (dev.get("sysdescr") or dev.get("sysname") or "").strip()[:120]
        try:
            await cmk.register_and_activate(name, ip, snmp_community=community, alias=alias)
            added.append(name)
        except httpx.HTTPError:
            continue
    return {"added": added, "count": len(added)}


# ---------- secrets ----------
@app.get(f"{P}/secrets")
async def list_secrets(_: AuthUser = Depends(require_caps("secrets"))) -> list[dict[str, Any]]:
    return store.list_secrets()


@app.post(f"{P}/secrets", status_code=201)
async def add_secret(payload: SecretIn, _: AuthUser = Depends(require_caps("secrets"))) -> dict[str, Any]:
    if payload.kind not in ("snmp_v2c", "snmp_v3", "agent_token", "checkmk_automation"):
        raise HTTPException(400, "Unknown secret kind")
    return store.add_secret(payload.name, payload.kind, box.encrypt(payload.value))


@app.patch(f"{P}/secrets/{{secret_id}}")
async def update_secret(
    secret_id: str,
    payload: SecretIn,
    _: AuthUser = Depends(require_caps("secrets")),
) -> dict[str, Any]:
    if payload.kind not in ("snmp_v2c", "snmp_v3", "agent_token", "checkmk_automation"):
        raise HTTPException(400, "Unknown secret kind")
    updated = store.update_secret(
        secret_id,
        name=payload.name,
        kind=payload.kind,
        encrypted_value=box.encrypt(payload.value) if payload.value else None,
    )
    if not updated:
        raise HTTPException(404, "Secret not found")
    return updated


@app.delete(f"{P}/secrets/{{secret_id}}", status_code=204, response_class=Response)
async def delete_secret(secret_id: str, _: AuthUser = Depends(require_caps("secrets"))) -> Response:
    if not store.delete_secret(secret_id):
        raise HTTPException(404, "Secret not found")
    return Response(status_code=204)


# ---------- AI assistant ----------
@app.post(f"{P}/ai/chat")
async def ai_chat(payload: ChatIn = Body(...), user: AuthUser = Depends(require_caps("ai"))) -> dict[str, Any]:
    if not settings.deepseek_api_key:
        raise HTTPException(404, "AI service is not configured")
    try:
        return await assistant.chat(
            payload.message,
            session_id=payload.session_id or "default",
            actor=user,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"DeepSeek error: {exc}") from exc


@app.get(f"{P}/ai/history")
async def ai_history(session_id: str = "default", _: AuthUser = Depends(require_caps("ai"))) -> dict[str, Any]:
    if not settings.deepseek_api_key:
        raise HTTPException(404, "AI service is not configured")
    msgs = assistant.history(session_id)
    return {"session_id": session_id, "ttl_seconds": settings.chat_ttl_seconds, "messages": msgs}


@app.delete(f"{P}/ai/history", status_code=204, response_class=Response)
async def ai_history_clear(session_id: str = "default", _: AuthUser = Depends(require_caps("ai"))) -> Response:
    assistant.clear_history(session_id)
    return Response(status_code=204)
