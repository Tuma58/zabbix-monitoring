from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

import httpx

from app.checkmk import CheckmkClient
from app.config import Settings
from app.scan import cidr_is_allowed, scan_snmp

ToolFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")


def sanitize_hostname(name: str, fallback_ip: str = "") -> str:
    raw = (name or "").strip()
    if not raw and fallback_ip:
        raw = f"host-{fallback_ip.replace('.', '-')}"
    raw = raw.replace(" ", "-")
    raw = re.sub(r"[^A-Za-z0-9_.-]", "-", raw)
    raw = re.sub(r"-{2,}", "-", raw).strip("-._")
    if not raw:
        raw = "host"
    if not HOST_RE.match(raw):
        raw = f"host-{abs(hash(raw)) % 10_000_000}"
    return raw[:63]


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Получить сводку мониторинга: число узлов, проблемы, статус Checkmk.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_hosts",
            "description": "Список узлов, которые уже есть в мониторинге.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_host",
            "description": (
                "Добавить узел в Checkmk и активировать изменения. "
                "Вызывай сразу, когда пользователь просит добавить/подключить/мониторить хост, "
                "сервер, микротик, свитч и т.п. с IP или именем."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Hostname в Checkmk. Если не задан — сгенерируй из IP.",
                    },
                    "address": {
                        "type": "string",
                        "description": "IP или FQDN узла.",
                    },
                    "type": {
                        "type": "string",
                        "enum": ["agent", "snmp"],
                        "description": "agent — Checkmk agent; snmp — сетевое устройство (роутер/свитч/MikroTik).",
                    },
                    "snmp_community": {
                        "type": "string",
                        "description": "SNMP community для type=snmp (по умолчанию public).",
                    },
                },
                "required": ["address"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scan_network",
            "description": "Просканировать CIDR по SNMP и вернуть найденные устройства (без автодобавления).",
            "parameters": {
                "type": "object",
                "properties": {
                    "cidr": {"type": "string", "description": "Например 10.0.0.0/24"},
                    "snmp_community": {"type": "string", "description": "По умолчанию public"},
                },
                "required": ["cidr"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_hosts_from_scan",
            "description": "Добавить в мониторинг список устройств (обычно после scan_network).",
            "parameters": {
                "type": "object",
                "properties": {
                    "devices": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ip": {"type": "string"},
                                "name": {"type": "string"},
                            },
                            "required": ["ip"],
                        },
                    },
                    "snmp_community": {"type": "string"},
                },
                "required": ["devices"],
                "additionalProperties": False,
            },
        },
    },
]


SYSTEM_PROMPT = """Ты AIMon — ассистент мониторинга на Checkmk.
Отвечай кратко по-русски.

Правила:
- Если пользователь просит добавить/подключить/создать узел — СРАЗУ вызови tool add_host. Не спрашивай лишнего, если есть IP.
- Для MikroTik / свитч / роутер / SNMP-устройства используй type=snmp.
- Для серверов / Linux / Windows используй type=agent.
- Если имени нет — передай только address, hostname сгенерируется.
- Для «просканируй сеть» сначала scan_network; если просят сразу добавить найденное — add_hosts_from_scan.
- Не выдумывай метрики: опирайся только на результаты tools.
- После успешного добавления коротко подтверди имя и IP.
"""


class AIAssistant:
    def __init__(self, settings: Settings, cmk: CheckmkClient) -> None:
        self.settings = settings
        self.cmk = cmk

    async def chat(self, message: str) -> dict[str, Any]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": message},
        ]
        actions: list[dict[str, Any]] = []
        reply = ""

        async with httpx.AsyncClient(timeout=60) as client:
            for _ in range(4):
                data = await self._complete(client, messages)
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                tool_calls = msg.get("tool_calls") or []

                if tool_calls:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content") or "",
                            "tool_calls": tool_calls,
                        }
                    )
                    for call in tool_calls:
                        fn = (call.get("function") or {})
                        name = fn.get("name") or ""
                        try:
                            args = json.loads(fn.get("arguments") or "{}")
                        except json.JSONDecodeError:
                            args = {}
                        result = await self._run_tool(name, args if isinstance(args, dict) else {})
                        actions.append({"tool": name, "args": args, "result": result})
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.get("id") or name,
                                "content": json.dumps(result, ensure_ascii=False),
                            }
                        )
                    continue

                reply = (msg.get("content") or "").strip()
                break

        if not reply:
            if any(a.get("tool") == "add_host" and a.get("result", {}).get("ok") for a in actions):
                host = next(
                    a["result"]["host"]
                    for a in actions
                    if a.get("tool") == "add_host" and a.get("result", {}).get("ok")
                )
                reply = f"Узел «{host}» добавлен в мониторинг."
            else:
                reply = "Готово."

        primary = actions[-1] if actions else None
        return {"reply": reply, "action": primary, "actions": actions}

    async def _complete(self, client: httpx.AsyncClient, messages: list[dict[str, Any]]) -> dict[str, Any]:
        resp = await client.post(
            f"{self.settings.deepseek_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.settings.deepseek_api_key}"},
            json={
                "model": self.settings.deepseek_model,
                "messages": messages,
                "tools": TOOLS,
                "tool_choice": "auto",
            },
        )
        resp.raise_for_status()
        return resp.json()

    async def _run_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "get_summary":
                return await self._get_summary()
            if name == "list_hosts":
                return await self._list_hosts()
            if name == "add_host":
                return await self._add_host(args)
            if name == "scan_network":
                return await self._scan_network(args)
            if name == "add_hosts_from_scan":
                return await self._add_hosts_from_scan(args)
            return {"ok": False, "error": f"unknown tool: {name}"}
        except httpx.HTTPError as exc:
            return {"ok": False, "error": f"Checkmk/HTTP: {exc}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    async def _get_summary(self) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": True, "engine": "disabled", "hosts_total": 0}
        ver = await self.cmk.version()
        hosts = await self.cmk.list_hosts()
        return {
            "ok": True,
            "engine": ver.get("versions", {}).get("checkmk", "Checkmk"),
            "hosts_total": len(hosts),
            "hosts": [{"name": h["name"], "address": h.get("address"), "type": h.get("type")} for h in hosts[:50]],
        }

    async def _list_hosts(self) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": True, "hosts": []}
        hosts = await self.cmk.list_hosts()
        return {
            "ok": True,
            "count": len(hosts),
            "hosts": [{"name": h["name"], "address": h.get("address"), "type": h.get("type")} for h in hosts],
        }

    async def _add_host(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        address = str(args.get("address") or "").strip()
        if not address:
            return {"ok": False, "error": "address is required"}
        name = sanitize_hostname(str(args.get("name") or ""), address)
        host_type = str(args.get("type") or "agent").lower()
        community = None
        if host_type == "snmp":
            community = str(args.get("snmp_community") or "public")
        result = await self.cmk.register_and_activate(name, address, snmp_community=community)
        return {"ok": True, "host": result["host"], "address": address, "type": host_type, "activated": True}

    async def _scan_network(self, args: dict[str, Any]) -> dict[str, Any]:
        cidr = str(args.get("cidr") or "").strip()
        if not cidr:
            return {"ok": False, "error": "cidr is required"}
        if not cidr_is_allowed(cidr, self.settings.scan_allowlist_cidrs):
            return {"ok": False, "error": f"CIDR {cidr} is not in scan allowlist"}
        community = str(args.get("snmp_community") or "public")
        result = await scan_snmp(cidr, community)
        devices = result.get("devices") if isinstance(result, dict) else result
        return {"ok": True, "cidr": cidr, "count": len(devices or []), "devices": devices}

    async def _add_hosts_from_scan(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        community = str(args.get("snmp_community") or "public")
        added: list[str] = []
        errors: list[str] = []
        for dev in args.get("devices") or []:
            if not isinstance(dev, dict):
                continue
            ip = str(dev.get("ip") or "").strip()
            if not ip:
                continue
            name = sanitize_hostname(str(dev.get("name") or ""), ip)
            try:
                await self.cmk.register_and_activate(name, ip, snmp_community=community)
                added.append(name)
            except httpx.HTTPError as exc:
                errors.append(f"{ip}: {exc}")
        return {"ok": True, "added": added, "count": len(added), "errors": errors}
