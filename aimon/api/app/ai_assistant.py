from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx

from app.checkmk import CheckmkClient
from app.config import Settings
from app.configs import ConfigManager
from app.probe import (
    host_allowed,
    resolve_dns,
    test_checkmk_agent,
    test_http,
    test_ping,
    test_snmp,
    test_tcp,
)
from app.scan import cidr_is_allowed, sanitize_hostname, scan_snmp, suggest_device_name
from app.store import JsonStore


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Сводка мониторинга: узлы, проблемы, статус Checkmk.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_hosts",
            "description": "Список узлов в мониторинге.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_host",
            "description": "Добавить узел в Checkmk и активировать изменения.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "address": {"type": "string"},
                    "type": {"type": "string", "enum": ["agent", "snmp"]},
                    "snmp_community": {"type": "string"},
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
            "description": "SNMP-скан CIDR (без автодобавления).",
            "parameters": {
                "type": "object",
                "properties": {
                    "cidr": {"type": "string"},
                    "snmp_community": {"type": "string"},
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
            "description": "Добавить устройства из скана в мониторинг.",
            "parameters": {
                "type": "object",
                "properties": {
                    "devices": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"ip": {"type": "string"}, "name": {"type": "string"}},
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
    {
        "type": "function",
        "function": {
            "name": "test_connection",
            "description": (
                "Проверить доступность узла: ping, TCP-порт, HTTP(S), SNMP или Checkmk agent. "
                "Вызывай при просьбах «проверь», «пингани», «тест порта», «доступен ли»."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "IP, hostname или URL"},
                    "kind": {
                        "type": "string",
                        "enum": ["ping", "tcp", "http", "snmp", "checkmk_agent", "dns"],
                    },
                    "port": {"type": "integer", "description": "Для tcp / checkmk_agent"},
                    "snmp_community": {"type": "string"},
                    "verify_tls": {"type": "boolean"},
                },
                "required": ["target", "kind"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_configs",
            "description": "Список управляемых конфиг-файлов AIMon.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_config",
            "description": "Прочитать содержимое конфиг-файла.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Относительный путь, напр. edge-nginx.conf"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_config",
            "description": "Разобрать конфиг: порты, proxy_pass, предупреждения.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_config",
            "description": "Записать конфиг целиком (создаёт .bak). Для новых файлов используй custom/...",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "patch_config",
            "description": "Точечная правка: заменить фрагмент old на new в конфиге.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old": {"type": "string"},
                    "new": {"type": "string"},
                    "replace_all": {"type": "boolean"},
                },
                "required": ["path", "old", "new"],
                "additionalProperties": False,
            },
        },
    },
]


SYSTEM_PROMPT = """Ты AIMon — ассистент мониторинга на Checkmk.
Отвечай кратко по-русски. У тебя есть память диалога за последний час — учитывай предыдущие реплики.

Правила:
- Добавить/подключить узел → сразу add_host (есть IP — не переспрашивай).
- MikroTik/свитч/роутер → type=snmp; сервер Linux/Windows → type=agent.
- «Проверь / пингани / порт / SNMP / агент» → test_connection.
- Конфиги: сначала list_configs / read_config / analyze_config, прав правь через patch_config (предпочтительно) или write_config.
- После правки конфига сообщи, нужен ли restart (restart_hint) и какой сервис.
- Не выдумывай метрики и результаты проверок — только данные tools.
- Не читай и не пиши секреты (.env с ключами); работай только с файлами из list_configs.
"""


class AIAssistant:
    def __init__(self, settings: Settings, cmk: CheckmkClient, store: JsonStore) -> None:
        self.settings = settings
        self.cmk = cmk
        self.store = store
        self.configs = ConfigManager(settings.config_root)

    async def chat(self, message: str, session_id: str = "default") -> dict[str, Any]:
        ttl = int(self.settings.chat_ttl_seconds or 3600)
        history = self.store.get_chat(session_id, ttl_seconds=ttl)
        messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for item in history:
            role = item.get("role")
            if role in ("user", "assistant") and item.get("content"):
                messages.append({"role": role, "content": str(item["content"])})
        messages.append({"role": "user", "content": message})
        self.store.append_chat(session_id, "user", message, ttl_seconds=ttl)

        actions: list[dict[str, Any]] = []
        reply = ""

        async with httpx.AsyncClient(timeout=90) as client:
            for _ in range(6):
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
                        fn = call.get("function") or {}
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
                                "content": json.dumps(result, ensure_ascii=False)[:12_000],
                            }
                        )
                    continue

                reply = (msg.get("content") or "").strip()
                break

        if not reply:
            reply = self._fallback_reply(actions)

        self.store.append_chat(
            session_id,
            "assistant",
            reply,
            ttl_seconds=ttl,
            meta={"actions": [{"tool": a.get("tool"), "ok": (a.get("result") or {}).get("ok")} for a in actions]},
        )
        primary = actions[-1] if actions else None
        return {
            "reply": reply,
            "action": primary,
            "actions": actions,
            "session_id": session_id,
            "memory_turns": len(self.store.get_chat(session_id, ttl_seconds=ttl)),
        }

    def history(self, session_id: str) -> list[dict[str, Any]]:
        ttl = int(self.settings.chat_ttl_seconds or 3600)
        return [
            {"role": m["role"], "content": m["content"], "ts": m.get("ts")}
            for m in self.store.get_chat(session_id, ttl_seconds=ttl)
            if m.get("role") in ("user", "assistant")
        ]

    def clear_history(self, session_id: str) -> bool:
        return self.store.clear_chat(session_id)

    @staticmethod
    def _fallback_reply(actions: list[dict[str, Any]]) -> str:
        for a in actions:
            if a.get("tool") == "add_host" and (a.get("result") or {}).get("ok"):
                return f"Узел «{a['result']['host']}» добавлен в мониторинг."
            if a.get("tool") == "test_connection":
                r = a.get("result") or {}
                return "Проверка успешна." if r.get("ok") else f"Проверка не прошла: {r.get('error', 'ошибка')}"
            if a.get("tool") in ("write_config", "patch_config") and (a.get("result") or {}).get("ok"):
                return f"Конфиг «{a['result'].get('path')}» обновлён."
        return "Готово."

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

    async def _known_hosts(self) -> set[str]:
        out: set[str] = set()
        if not self.cmk.enabled:
            return out
        try:
            for h in await self.cmk.list_hosts():
                if h.get("name"):
                    out.add(str(h["name"]).lower())
                if h.get("address"):
                    out.add(str(h["address"]).lower())
        except Exception:  # noqa: BLE001
            pass
        return out

    def _guard_target(self, target: str, known: set[str]) -> tuple[bool, str]:
        t = (target or "").strip()
        if not t:
            return False, "target required"
        host = t
        if "://" in t:
            host = urlparse(t if "://" in t else f"http://{t}").hostname or ""
        elif ":" in t and t.count(":") == 1 and not t.startswith("["):
            # host:port
            host = t.rsplit(":", 1)[0]
        if not host_allowed(host, self.settings.scan_allowlist_cidrs, known):
            return False, f"target not allowed by policy: {host}"
        return True, host

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
            if name == "test_connection":
                return await self._test_connection(args)
            if name == "list_configs":
                return self.configs.list_files()
            if name == "read_config":
                return self.configs.read(str(args.get("path") or ""))
            if name == "analyze_config":
                return self.configs.analyze(str(args.get("path") or ""))
            if name == "write_config":
                return self.configs.write(str(args.get("path") or ""), str(args.get("content") or ""))
            if name == "patch_config":
                return self.configs.patch(
                    str(args.get("path") or ""),
                    str(args.get("old") or ""),
                    str(args.get("new") or ""),
                    replace_all=bool(args.get("replace_all")),
                )
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
        community = str(args.get("snmp_community") or "public") if host_type == "snmp" else None
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
            name = suggest_device_name(dev)
            alias = str(dev.get("sysdescr") or dev.get("sysname") or "").strip()[:120]
            try:
                await self.cmk.register_and_activate(name, ip, snmp_community=community, alias=alias)
                added.append(name)
            except httpx.HTTPError as exc:
                errors.append(f"{ip}: {exc}")
        return {"ok": True, "added": added, "count": len(added), "errors": errors}

    async def _test_connection(self, args: dict[str, Any]) -> dict[str, Any]:
        target = str(args.get("target") or "").strip()
        kind = str(args.get("kind") or "ping").lower()
        known = await self._known_hosts()
        ok, host_or_err = self._guard_target(target, known)
        if not ok and kind != "http":
            return {"ok": False, "error": host_or_err}
        if kind == "ping":
            return await test_ping(host_or_err if ok else target)
        if kind == "tcp":
            port = int(args.get("port") or 0)
            if not port and ":" in target and "://" not in target:
                try:
                    port = int(target.rsplit(":", 1)[1])
                except ValueError:
                    port = 0
            if not port:
                return {"ok": False, "error": "port required for tcp"}
            return await test_tcp(host_or_err if ok else target.split(":")[0], port)
        if kind == "http":
            # allow http to private/public monitoring endpoints
            parsed_host = urlparse(target if "://" in target else f"http://{target}").hostname or ""
            if not host_allowed(parsed_host, self.settings.scan_allowlist_cidrs, known):
                return {"ok": False, "error": f"target not allowed by policy: {parsed_host}"}
            return await test_http(target, verify_tls=bool(args.get("verify_tls")))
        if kind == "snmp":
            return await test_snmp(host_or_err if ok else target, str(args.get("snmp_community") or "public"))
        if kind == "checkmk_agent":
            return await test_checkmk_agent(host_or_err if ok else target, int(args.get("port") or 6556))
        if kind == "dns":
            return await resolve_dns(host_or_err if ok else target)
        return {"ok": False, "error": f"unknown kind: {kind}"}
