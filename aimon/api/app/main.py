from __future__ import annotations

import secrets as pysecrets
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.ai_assistant import AIAssistant
from app.checkmk import CheckmkClient
from app.config import get_settings
from app.scan import cidr_is_allowed, guess_vendor, scan_snmp
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
assistant = AIAssistant(settings, cmk, store)

P = settings.api_prefix


# ---------- models ----------
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
    kind: str  # snmp_v2c | snmp_v3 | agent_token | checkmk_automation
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


# ---------- health / summary ----------
@app.get(f"{P}/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get(f"{P}/summary")
async def summary() -> dict[str, Any]:
    engine: dict[str, Any] = {"status": "disabled"}
    hosts: list[dict[str, Any]] = []
    if cmk.enabled:
        try:
            ver = await cmk.version()
            engine = {"status": "ok", "version": ver.get("versions", {}).get("checkmk", "Checkmk")}
            hosts = await cmk.list_hosts()
        except (httpx.HTTPError, Exception):  # noqa: BLE001 - degrade gracefully
            engine = {"status": "down"}
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
async def list_hosts() -> list[dict[str, Any]]:
    if not cmk.enabled:
        return []
    try:
        hosts = await cmk.list_hosts()
    except httpx.HTTPError:
        return []
    # enrich with site titles
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


@app.get(f"{P}/hosts/{{name}}")
async def get_host(name: str) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    host = await cmk.get_host(name)
    if not host:
        raise HTTPException(404, "Host not found")
    return host


@app.post(f"{P}/hosts", status_code=201)
async def create_host(payload: HostIn) -> dict[str, Any]:
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
async def update_host(name: str, payload: HostUpdateIn) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id)
    current = name
    try:
        existing = await cmk.get_host(current)
        if not existing:
            raise HTTPException(404, f"Host not found: {current}")

        # Only send attribute updates when values actually change.
        address = payload.address
        alias = payload.alias
        host_type = payload.type
        if address is not None and address == (existing.get("address") or ""):
            address = None
        if alias is not None and alias == (existing.get("alias") or ""):
            alias = None
        if host_type is not None and host_type == (existing.get("type") or "agent"):
            # Keep type only if SNMP community is being set; otherwise skip no-op tag rewrite.
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

        # Checkmk forbids rename while pending changes exist — activate first.
        await cmk.activate_changes()
        result["activated"] = True

        new_name = (payload.new_name or "").strip()
        if new_name and new_name != current:
            renamed = await cmk.rename_host(current, new_name)
            result.update(renamed)
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
async def delete_host(name: str) -> Response:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        await cmk.delete_host(name)
        await cmk.activate_changes()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    return Response(status_code=204)


# ---------- sites / площадки (Checkmk folders) ----------
@app.get(f"{P}/sites")
async def list_sites() -> list[dict[str, Any]]:
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
async def create_site(payload: SiteIn) -> dict[str, Any]:
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
async def update_site(site_id: str, payload: SiteUpdateIn) -> dict[str, Any]:
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
async def delete_site(site_id: str) -> Response:
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


# ---------- agent auto-registration ----------
@app.post(f"{P}/agents/register")
async def agent_register(payload: AgentRegisterIn) -> dict[str, Any]:
    """Called by the one-command installer after the agent is installed.

    Creates the host, runs discovery and activates changes so the node
    appears automatically without any manual UI step.
    """
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    name = payload.hostname
    try:
        result = await cmk.register_and_activate(name, payload.ip)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc
    return {"registered": True, **result, "os": payload.os}


@app.post(f"{P}/agents/token")
async def issue_agent_token() -> dict[str, str]:
    """Issue a short-lived registration token and store it as a secret."""
    token = pysecrets.token_urlsafe(24)
    store.add_secret(name=f"agent-token-{token[:6]}", kind="agent_token", encrypted_value=box.encrypt(token))
    return {"token": token}


# ---------- SNMP network scan ----------
@app.post(f"{P}/scan")
async def scan(payload: ScanIn) -> dict[str, Any]:
    if not cidr_is_allowed(payload.cidr, settings.scan_allowlist_cidrs):
        raise HTTPException(400, "CIDR is not in the scan allowlist")
    community = _community_for(payload.snmp_profile_id) or "public"
    return await scan_snmp(payload.cidr, community)


@app.post(f"{P}/scan/add")
async def scan_add(payload: ScanAddIn) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id) or "public"
    added = []
    for dev in payload.devices:
        ip = dev.get("ip")
        if not ip:
            continue
        name = dev.get("name") or f"snmp-{ip.replace('.', '-')}"
        try:
            await cmk.register_and_activate(name, ip, snmp_community=community)
            added.append(name)
        except httpx.HTTPError:
            continue
    return {"added": added, "count": len(added)}


# ---------- secrets ----------
@app.get(f"{P}/secrets")
async def list_secrets() -> list[dict[str, Any]]:
    return store.list_secrets()


@app.post(f"{P}/secrets", status_code=201)
async def add_secret(payload: SecretIn) -> dict[str, Any]:
    if payload.kind not in ("snmp_v2c", "snmp_v3", "agent_token", "checkmk_automation"):
        raise HTTPException(400, "Unknown secret kind")
    return store.add_secret(payload.name, payload.kind, box.encrypt(payload.value))


@app.delete(f"{P}/secrets/{{secret_id}}", status_code=204, response_class=Response)
async def delete_secret(secret_id: str) -> Response:
    if not store.delete_secret(secret_id):
        raise HTTPException(404, "Secret not found")
    return Response(status_code=204)


# ---------- AI assistant (DeepSeek + tools + memory) ----------
@app.post(f"{P}/ai/chat")
async def ai_chat(payload: ChatIn = Body(...)) -> dict[str, Any]:
    if not settings.deepseek_api_key:
        raise HTTPException(404, "AI service is not configured")
    try:
        return await assistant.chat(payload.message, session_id=payload.session_id or "default")
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"DeepSeek error: {exc}") from exc


@app.get(f"{P}/ai/history")
async def ai_history(session_id: str = "default") -> dict[str, Any]:
    if not settings.deepseek_api_key:
        raise HTTPException(404, "AI service is not configured")
    msgs = assistant.history(session_id)
    return {"session_id": session_id, "ttl_seconds": settings.chat_ttl_seconds, "messages": msgs}


@app.delete(f"{P}/ai/history", status_code=204, response_class=Response)
async def ai_history_clear(session_id: str = "default") -> Response:
    assistant.clear_history(session_id)
    return Response(status_code=204)
