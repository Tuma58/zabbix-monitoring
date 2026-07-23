from __future__ import annotations

import secrets as pysecrets
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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

P = settings.api_prefix


# ---------- models ----------
class HostIn(BaseModel):
    name: str
    address: str = ""
    type: str = "agent"
    snmp_profile_id: str | None = None


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
        return await cmk.list_hosts()
    except httpx.HTTPError:
        return []


@app.post(f"{P}/hosts", status_code=201)
async def create_host(payload: HostIn) -> dict[str, Any]:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    community = _community_for(payload.snmp_profile_id)
    try:
        return await cmk.register_and_activate(payload.name, payload.address, snmp_community=community)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


@app.delete(f"{P}/hosts/{{name}}", status_code=204)
async def delete_host(name: str) -> None:
    if not cmk.enabled:
        raise HTTPException(503, "Checkmk is not configured")
    try:
        await cmk.delete_host(name)
        await cmk.activate_changes()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Checkmk error: {exc}") from exc


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


@app.delete(f"{P}/secrets/{{secret_id}}", status_code=204)
async def delete_secret(secret_id: str) -> None:
    if not store.delete_secret(secret_id):
        raise HTTPException(404, "Secret not found")


# ---------- AI assistant (DeepSeek) ----------
@app.post(f"{P}/ai/chat")
async def ai_chat(payload: ChatIn = Body(...)) -> dict[str, Any]:
    if not settings.deepseek_api_key:
        raise HTTPException(404, "AI service is not configured")
    system = (
        "You are AIMon, an assistant for a Checkmk-based monitoring system. "
        "Answer concisely in Russian. Only use facts provided; never invent metrics."
    )
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.deepseek_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.deepseek_api_key}"},
                json={
                    "model": settings.deepseek_model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": payload.message},
                    ],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"DeepSeek error: {exc}") from exc
    return {"reply": reply, "action": None}
