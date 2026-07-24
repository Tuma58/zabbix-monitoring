from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

import httpx

from app.auth import ROLE_LABELS, hash_password, public_user
from app.checkmk import CheckmkClient, folder_path_to_id
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
from app.scan import (
    DEVICE_TYPE_LABELS,
    cidr_is_allowed,
    device_type_label,
    sanitize_hostname,
    scan_snmp,
    suggest_device_identity,
)
from app.secrets import SecretBox
from app.store import JsonStore
from app.device_ai import classify_devices_with_ai

SECRET_KINDS = ("snmp_v2c", "snmp_v3", "agent_token", "checkmk_automation")

BUILTIN_TOOLS: list[dict[str, Any]] = [
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
            "description": (
                "Список узлов мониторинга с полями дашборда: name, address, alias, "
                "type (agent|snmp), device_type / device_type_label (тип устройства), "
                "vendor, folder, site_title, state."
            ),
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_host",
            "description": "Карточка одного узла со всеми полями дашборда, включая тип устройства.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
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
                    "type": {"type": "string", "enum": ["agent", "snmp"], "description": "Способ мониторинга"},
                    "snmp_community": {"type": "string"},
                    "folder": {"type": "string", "description": "Путь площадки, напр. /office"},
                    "alias": {"type": "string"},
                    "device_type": {
                        "type": "string",
                        "description": "Тип устройства: router, switch, ap, printer, server, ups, firewall, camera, nas, network, host",
                    },
                    "vendor": {"type": "string"},
                },
                "required": ["address"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_host",
            "description": (
                "Изменить узел: адрес, способ мониторинга (type), тип устройства (device_type), "
                "площадку, alias, vendor или переименовать."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Текущее имя узла"},
                    "new_name": {"type": "string"},
                    "address": {"type": "string"},
                    "type": {"type": "string", "enum": ["agent", "snmp"], "description": "Способ мониторинга"},
                    "snmp_community": {"type": "string"},
                    "folder": {"type": "string"},
                    "alias": {"type": "string"},
                    "device_type": {
                        "type": "string",
                        "description": "Тип устройства (колонка «Тип устройства» на дашборде)",
                    },
                    "vendor": {"type": "string"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_host",
            "description": "Удалить узел из мониторинга.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_sites",
            "description": "Список площадок (папок Checkmk).",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_site",
            "description": "Создать площадку мониторинга.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Код латиницей"},
                    "title": {"type": "string"},
                    "parent": {"type": "string", "description": "Родительский путь, по умолчанию /"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_site",
            "description": "Изменить название площадки.",
            "parameters": {
                "type": "object",
                "properties": {
                    "site_id": {"type": "string", "description": "id (~office) или путь (/office)"},
                    "title": {"type": "string"},
                },
                "required": ["site_id", "title"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_site",
            "description": "Удалить пустую площадку.",
            "parameters": {
                "type": "object",
                "properties": {"site_id": {"type": "string"}},
                "required": ["site_id"],
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
            "description": "Добавить устройства из скана в мониторинг (с псевдонимом и типом; можно указать площадку folder).",
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
                                "sysname": {"type": "string"},
                                "sysdescr": {"type": "string"},
                                "vendor": {"type": "string"},
                                "alias": {"type": "string"},
                                "device_type": {"type": "string"},
                            },
                            "required": ["ip"],
                        },
                    },
                    "snmp_community": {"type": "string"},
                    "folder": {"type": "string", "description": "Площадка, напр. /office"},
                },
                "required": ["devices"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_hosts",
            "description": "Массово перенести узлы на другую площадку (folder).",
            "parameters": {
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string"}},
                    "folder": {"type": "string", "description": "Целевая площадка, напр. /office"},
                },
                "required": ["names", "folder"],
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
            "name": "list_users",
            "description": "Список пользователей дашборда (без паролей). Только для администратора.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_user",
            "description": (
                "Создать пользователя дашборда. Роли: engineer или user (не admin). "
                "Для user можно указать hosts — список имён узлов."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "username": {"type": "string"},
                    "password": {"type": "string"},
                    "display_name": {"type": "string"},
                    "role": {"type": "string", "enum": ["engineer", "user"]},
                    "hosts": {"type": "array", "items": {"type": "string"}},
                    "enabled": {"type": "boolean"},
                },
                "required": ["username", "password", "role"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_user",
            "description": (
                "Изменить пользователя (не администратора): пароль, роль engineer/user, "
                "hosts, display_name, enabled."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "username": {"type": "string"},
                    "password": {"type": "string"},
                    "display_name": {"type": "string"},
                    "role": {"type": "string", "enum": ["engineer", "user"]},
                    "hosts": {"type": "array", "items": {"type": "string"}},
                    "enabled": {"type": "boolean"},
                },
                "required": ["username"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_user",
            "description": "Удалить пользователя (не администратора).",
            "parameters": {
                "type": "object",
                "properties": {"username": {"type": "string"}},
                "required": ["username"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_secrets",
            "description": "Список секретов/SNMP-профилей (без значений).",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_secret",
            "description": "Создать секрет или SNMP-профиль (snmp_v2c / snmp_v3 / agent_token).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": list(SECRET_KINDS)},
                    "value": {"type": "string", "description": "community / пароль / токен"},
                },
                "required": ["name", "kind", "value"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_secret",
            "description": "Изменить имя/тип/значение секрета или SNMP-профиля.",
            "parameters": {
                "type": "object",
                "properties": {
                    "secret_id": {"type": "string"},
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": list(SECRET_KINDS)},
                    "value": {"type": "string"},
                },
                "required": ["secret_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_secret",
            "description": "Удалить секрет / SNMP-профиль.",
            "parameters": {
                "type": "object",
                "properties": {"secret_id": {"type": "string"}},
                "required": ["secret_id"],
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
    {
        "type": "function",
        "function": {
            "name": "list_available_tools",
            "description": (
                "Список всех инструментов: встроенные и пользовательские. "
                "Используй перед созданием кастомного на базе существующего."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["all", "builtin", "custom"],
                        "description": "Фильтр: all | builtin | custom",
                    }
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_tool",
            "description": "Получить полное описание инструмента (встроенного или кастомного): параметры и шаги.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_custom_tools",
            "description": "Список пользовательских инструментов ассистента.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_custom_tool",
            "description": (
                "Создать кастомный инструмент. Можно с нуля (steps) или на базе существующего "
                "(based_on = имя builtin/custom): копируются параметры и шаги, затем применяются "
                "переданные description/parameters/steps. В args шагов — плейсхолдеры {{param}}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Имя латиницей, напр. check_office"},
                    "description": {"type": "string"},
                    "based_on": {
                        "type": "string",
                        "description": "Имя инструмента-основы (builtin или custom)",
                    },
                    "parameters": {
                        "type": "object",
                        "description": "JSON Schema параметров нового инструмента",
                    },
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "tool": {"type": "string"},
                                "args": {"type": "object"},
                            },
                            "required": ["tool"],
                        },
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_custom_tool",
            "description": (
                "Изменить кастомный инструмент: описание, параметры, шаги, имя. "
                "Можно взять шаблон based_on и поверх наложить правки."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Текущее имя кастомного инструмента"},
                    "new_name": {"type": "string"},
                    "description": {"type": "string"},
                    "based_on": {
                        "type": "string",
                        "description": "Подставить шаблон с другого инструмента, затем применить steps/parameters",
                    },
                    "parameters": {"type": "object"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "tool": {"type": "string"},
                                "args": {"type": "object"},
                            },
                            "required": ["tool"],
                        },
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_custom_tool",
            "description": "Удалить пользовательский инструмент.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
]

BUILTIN_TOOL_NAMES = {t["function"]["name"] for t in BUILTIN_TOOLS}
META_TOOL_NAMES = {
    "list_available_tools",
    "get_tool",
    "list_custom_tools",
    "create_custom_tool",
    "update_custom_tool",
    "delete_custom_tool",
}
# keep alias for older imports/tests
TOOLS = BUILTIN_TOOLS

SYSTEM_PROMPT = """Ты Гера — AI-ассистент мониторинга AIMon на Checkmk.
Отвечай кратко по-русски от лица Геры (можно представляться коротко, без лишней роли). У тебя есть память диалога за последний час — учитывай предыдущие реплики.

Сущности дашборда доступны через tools (те же данные, что в UI/API):
- узлы: list_hosts / get_host / add_host / update_host / delete_host / move_hosts
- площадки: list_sites / create_site / update_site / delete_site
- скан: scan_network / add_hosts_from_scan
- пользователи, секреты, конфиги, кастомные tools — соответствующие list_*/create_*/update_*/delete_*

Важно про типы:
- type = способ мониторинга: agent | snmp (колонка «Мониторинг»).
- device_type / device_type_label = тип устройства: router, switch, ap, printer, server, ups… (колонка «Тип устройства»).
  Когда пользователь спрашивает «тип устройства» — смотри device_type_label из list_hosts/get_host.
  Чтобы задать тип устройства — update_host(device_type=...).

Правила:
- Добавить/подключить узел → сразу add_host (есть IP — не переспрашивай). Если указана площадка — передай folder.
- Скан сети → scan_network; добавление найденных → add_hosts_from_scan с folder, если пользователь назвал площадку. Имена и псевдонимы уже подготовлены сканом.
- Массовый перенос узлов между площадками → move_hosts.
- Изменить/удалить узел → update_host / delete_host; площадки → create_site / update_site / delete_site / list_sites.
- MikroTik/свитч/роутер → type=snmp; сервер Linux/Windows → type=agent.
- «Проверь / пингани / порт / SNMP / агент» → test_connection.
- Пользователи дашборда: list_users / create_user / update_user / delete_user — только engineer и user, администраторов не создавать и не менять.
- SNMP-профили и секреты: list_secrets / create_secret / update_secret / delete_secret.
- Инструменты: list_available_tools / get_tool; создавать кастомные на базе существующих — create_custom_tool(based_on=...); менять — update_custom_tool; удалять — delete_custom_tool. Шаги сценария — вызовы других tools с {{placeholders}}.
- Конфиги: сначала list_configs / read_config / analyze_config, правь через patch_config или write_config.
- После правки конфига сообщи, нужен ли restart (restart_hint) и какой сервис.
- Не выдумывай метрики и результаты проверок — только данные tools.
- Не читай и не пиши секреты (.env с ключами); работай только с файлами из list_configs и API секретов.
"""


def _subst(value: Any, params: dict[str, Any]) -> Any:
    if isinstance(value, str):
        out = value
        for k, v in params.items():
            out = out.replace("{{" + str(k) + "}}", str(v))
        return out
    if isinstance(value, list):
        return [_subst(x, params) for x in value]
    if isinstance(value, dict):
        return {k: _subst(v, params) for k, v in value.items()}
    return value


class AIAssistant:
    def __init__(
        self,
        settings: Settings,
        cmk: CheckmkClient,
        store: JsonStore,
        box: SecretBox | None = None,
    ) -> None:
        self.settings = settings
        self.cmk = cmk
        self.store = store
        self.box = box or SecretBox(settings.secrets_master_key)
        self.configs = ConfigManager(settings.config_root)
        self._actor: dict[str, Any] | None = None

    def _tools_payload(self) -> list[dict[str, Any]]:
        custom = []
        for t in self.store.list_ai_tools():
            custom.append(
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t.get("description") or t["name"],
                        "parameters": t.get("parameters")
                        or {"type": "object", "properties": {}, "additionalProperties": False},
                    },
                }
            )
        return BUILTIN_TOOLS + custom

    async def chat(
        self,
        message: str,
        session_id: str = "default",
        actor: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._actor = actor
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
            for _ in range(8):
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
                                "content": json.dumps(result, ensure_ascii=False)[:12000],
                            }
                        )
                    continue

                reply = (msg.get("content") or "").strip() or self._fallback_reply(actions)
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
        return {
            "reply": reply,
            "actions": actions,
            "session_id": session_id,
            "ttl_seconds": ttl,
            "memory_turns": len(self.store.get_chat(session_id, ttl_seconds=ttl)),
        }

    def history(self, session_id: str) -> list[dict[str, Any]]:
        ttl = int(self.settings.chat_ttl_seconds or 3600)
        return [
            m
            for m in self.store.get_chat(session_id, ttl_seconds=ttl)
            if m.get("role") in ("user", "assistant")
        ]

    def clear_history(self, session_id: str) -> bool:
        return self.store.clear_chat(session_id)

    @staticmethod
    def _fallback_reply(actions: list[dict[str, Any]]) -> str:
        for a in actions:
            tool = a.get("tool")
            r = a.get("result") or {}
            if not r.get("ok"):
                continue
            if tool == "add_host":
                return f"Узел «{r.get('host')}» добавлен в мониторинг."
            if tool == "update_host":
                return f"Узел «{r.get('host')}» обновлён."
            if tool == "delete_host":
                return f"Узел «{r.get('host')}» удалён."
            if tool == "create_site":
                return f"Площадка «{r.get('title') or r.get('name')}» создана."
            if tool == "create_user":
                return f"Пользователь «{r.get('username')}» создан."
            if tool == "create_secret":
                return f"Секрет «{r.get('name')}» сохранён."
            if tool == "create_custom_tool":
                return f"Инструмент «{r.get('name')}» создан."
            if tool == "update_custom_tool":
                return f"Инструмент «{r.get('name')}» обновлён."
            if tool == "test_connection":
                return "Проверка успешна."
            if tool in ("write_config", "patch_config"):
                return f"Конфиг «{r.get('path')}» обновлён."
        for a in actions:
            r = a.get("result") or {}
            if r.get("error"):
                return f"Не удалось: {r.get('error')}"
        return "Готово."

    async def _complete(self, client: httpx.AsyncClient, messages: list[dict[str, Any]]) -> dict[str, Any]:
        resp = await client.post(
            f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self.settings.deepseek_api_key}"},
            json={
                "model": self.settings.deepseek_model,
                "messages": messages,
                "tools": self._tools_payload(),
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
            host = t.rsplit(":", 1)[0]
        if not host_allowed(host, self.settings.scan_allowlist_cidrs, known):
            return False, f"target not allowed by policy: {host}"
        return True, host

    def _require_admin(self) -> dict[str, Any] | None:
        actor = self._actor or {}
        if actor.get("role") != "admin":
            return {"ok": False, "error": "Нужны права администратора"}
        return None

    async def _run_tool(self, name: str, args: dict[str, Any], *, _depth: int = 0) -> dict[str, Any]:
        try:
            if name == "get_summary":
                return await self._get_summary()
            if name == "list_hosts":
                return await self._list_hosts()
            if name == "get_host":
                return await self._get_host(args)
            if name == "add_host":
                return await self._add_host(args)
            if name == "update_host":
                return await self._update_host(args)
            if name == "delete_host":
                return await self._delete_host(args)
            if name == "list_sites":
                return await self._list_sites()
            if name == "create_site":
                return await self._create_site(args)
            if name == "update_site":
                return await self._update_site(args)
            if name == "delete_site":
                return await self._delete_site(args)
            if name == "scan_network":
                return await self._scan_network(args)
            if name == "add_hosts_from_scan":
                return await self._add_hosts_from_scan(args)
            if name == "move_hosts":
                return await self._move_hosts(args)
            if name == "test_connection":
                return await self._test_connection(args)
            if name == "list_users":
                return self._list_users()
            if name == "create_user":
                return self._create_user(args)
            if name == "update_user":
                return self._update_user(args)
            if name == "delete_user":
                return self._delete_user(args)
            if name == "list_secrets":
                return self._list_secrets()
            if name == "create_secret":
                return self._create_secret(args)
            if name == "update_secret":
                return self._update_secret(args)
            if name == "delete_secret":
                return self._delete_secret(args)
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
            if name == "list_available_tools":
                return self._list_available_tools(args)
            if name == "get_tool":
                return self._get_tool(args)
            if name == "list_custom_tools":
                return self._list_custom_tools()
            if name == "create_custom_tool":
                return self._create_custom_tool(args)
            if name == "update_custom_tool":
                return self._update_custom_tool(args)
            if name == "delete_custom_tool":
                return self._delete_custom_tool(args)

            custom = self.store.get_ai_tool(name)
            if custom:
                return await self._run_custom_tool(custom, args, _depth=_depth)
            return {"ok": False, "error": f"unknown tool: {name}"}
        except httpx.HTTPError as exc:
            return {"ok": False, "error": f"Checkmk/HTTP: {exc}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    def _allowed_step_tools(self) -> set[str]:
        names = set(BUILTIN_TOOL_NAMES) - META_TOOL_NAMES
        for t in self.store.list_ai_tools():
            n = str(t.get("name") or "")
            if n:
                names.add(n)
        return names

    def _normalize_steps(self, steps: list[Any]) -> tuple[list[dict[str, Any]] | None, str | None]:
        if not isinstance(steps, list) or not steps:
            return None, "steps required (non-empty array)"
        allowed = self._allowed_step_tools()
        cleaned: list[dict[str, Any]] = []
        for step in steps:
            if not isinstance(step, dict):
                return None, "invalid step"
            tname = str(step.get("tool") or "").strip()
            if not tname or tname in META_TOOL_NAMES or tname not in allowed:
                return None, f"step tool not allowed: {tname}"
            cleaned.append(
                {
                    "tool": tname,
                    "args": step.get("args") if isinstance(step.get("args"), dict) else {},
                }
            )
        return cleaned, None

    def _params_from_steps(self, steps: list[dict[str, Any]]) -> dict[str, Any]:
        props: dict[str, Any] = {}
        for step in steps:
            for m in re.findall(r"\{\{(\w+)\}\}", json.dumps(step.get("args") or {}, ensure_ascii=False)):
                props[m] = {"type": "string"}
        return {"type": "object", "properties": props, "additionalProperties": False}

    def _template_from_tool(self, source_name: str) -> dict[str, Any] | None:
        """Build description/parameters/steps template from builtin or custom tool."""
        name = (source_name or "").strip()
        if not name:
            return None
        custom = self.store.get_ai_tool(name)
        if custom:
            return {
                "description": custom.get("description") or custom.get("name"),
                "parameters": custom.get("parameters")
                or {"type": "object", "properties": {}, "additionalProperties": False},
                "steps": list(custom.get("steps") or []),
                "based_on": custom.get("name"),
            }
        for t in BUILTIN_TOOLS:
            fn = t.get("function") or {}
            if fn.get("name") == name:
                if name in META_TOOL_NAMES:
                    return None
                params = fn.get("parameters") or {"type": "object", "properties": {}, "additionalProperties": False}
                props = (params.get("properties") or {}) if isinstance(params, dict) else {}
                # one step calling the builtin with {{param}} for each property
                args = {k: "{{" + k + "}}" for k in props.keys()}
                return {
                    "description": f"Кастом на базе {name}: {fn.get('description') or name}",
                    "parameters": params,
                    "steps": [{"tool": name, "args": args}],
                    "based_on": name,
                }
        return None

    async def _run_custom_tool(self, tool: dict[str, Any], args: dict[str, Any], *, _depth: int) -> dict[str, Any]:
        if _depth >= 4:
            return {"ok": False, "error": "custom tool nesting too deep"}
        steps = tool.get("steps") or []
        if not steps:
            return {"ok": False, "error": "custom tool has no steps"}
        allowed = self._allowed_step_tools()
        results: list[dict[str, Any]] = []
        for step in steps:
            if not isinstance(step, dict):
                continue
            tname = str(step.get("tool") or "").strip()
            if not tname or tname in META_TOOL_NAMES or tname not in allowed:
                return {"ok": False, "error": f"custom step tool not allowed: {tname}"}
            # prevent trivial infinite self-recursion
            if tname == tool.get("name") and _depth > 0:
                return {"ok": False, "error": f"recursive custom tool: {tname}"}
            raw_args = step.get("args") if isinstance(step.get("args"), dict) else {}
            call_args = _subst(raw_args, args)
            if not isinstance(call_args, dict):
                call_args = {}
            res = await self._run_tool(tname, call_args, _depth=_depth + 1)
            results.append({"tool": tname, "result": res})
            if not res.get("ok", True) and res.get("error"):
                return {"ok": False, "error": res.get("error"), "steps": results}
        return {"ok": True, "tool": tool.get("name"), "steps": results}

    def _site_titles(self, folders: list[dict[str, Any]] | None = None) -> dict[str, str]:
        titles: dict[str, str] = {"/": "Корень"}
        for f in folders or []:
            path = f.get("path") or "/"
            titles[path] = f.get("title") or path
        return titles

    def _serialize_host(self, h: dict[str, Any], *, site_titles: dict[str, str] | None = None) -> dict[str, Any]:
        path = h.get("folder") or h.get("site_path") or "/"
        titles = site_titles or {}
        dtype = str(h.get("device_type") or "")
        return {
            "name": h.get("name"),
            "address": h.get("address") or "",
            "alias": h.get("alias") or "",
            "type": h.get("type") or "agent",
            "type_label": "SNMP" if (h.get("type") or "") == "snmp" else "Агент",
            "device_type": dtype,
            "device_type_label": h.get("device_type_label") or device_type_label(dtype),
            "vendor": h.get("vendor") or "",
            "folder": path,
            "site_path": path,
            "site_title": h.get("site_title") or titles.get(path) or ("Корень" if path == "/" else path),
            "state": h.get("state") or "up",
        }

    async def _hosts_enriched(self) -> list[dict[str, Any]]:
        if not self.cmk.enabled:
            return []
        hosts = await self.cmk.list_hosts()
        titles: dict[str, str] = {"/": "Корень"}
        try:
            for f in await self.cmk.list_folders():
                titles[f.get("path") or "/"] = f.get("title") or f.get("path") or "/"
        except httpx.HTTPError:
            pass
        return [self._serialize_host(h, site_titles=titles) for h in hosts]

    def _normalize_device_type(self, value: Any) -> str:
        raw = str(value or "").strip().lower()
        if not raw:
            return ""
        if raw in DEVICE_TYPE_LABELS:
            return raw
        # accept Russian labels
        for key, label in DEVICE_TYPE_LABELS.items():
            if label.lower() == raw:
                return key
        return raw

    async def _get_summary(self) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": True, "engine": "disabled", "hosts_total": 0, "hosts": []}
        ver = await self.cmk.version()
        hosts = await self._hosts_enriched()
        by_device: dict[str, int] = {}
        for h in hosts:
            key = h.get("device_type_label") or "Не определено"
            by_device[key] = by_device.get(key, 0) + 1
        return {
            "ok": True,
            "engine": ver.get("versions", {}).get("checkmk", "Checkmk"),
            "hosts_total": len(hosts),
            "by_device_type": by_device,
            "hosts": hosts[:50],
        }

    async def _list_hosts(self) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": True, "count": 0, "hosts": []}
        hosts = await self._hosts_enriched()
        return {"ok": True, "count": len(hosts), "hosts": hosts}

    async def _get_host(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name is required"}
        host = await self.cmk.get_host(name)
        if not host:
            return {"ok": False, "error": f"host not found: {name}"}
        titles: dict[str, str] = {"/": "Корень"}
        try:
            for f in await self.cmk.list_folders():
                titles[f.get("path") or "/"] = f.get("title") or f.get("path") or "/"
        except httpx.HTTPError:
            pass
        return {"ok": True, "host": self._serialize_host(host, site_titles=titles)}

    async def _add_host(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        address = str(args.get("address") or "").strip()
        if not address:
            return {"ok": False, "error": "address is required"}
        name = sanitize_hostname(str(args.get("name") or ""), address)
        host_type = str(args.get("type") or "agent").lower()
        community = str(args.get("snmp_community") or "public") if host_type == "snmp" else None
        folder = str(args.get("folder") or "/").strip() or "/"
        alias = str(args.get("alias") or "").strip()
        device_type = self._normalize_device_type(args.get("device_type"))
        if not device_type:
            device_type = "server" if host_type == "agent" else "network"
        vendor = str(args.get("vendor") or "").strip().lower()
        labels = {
            "aimon/device_type": device_type,
            "aimon/vendor": vendor,
        }
        result = await self.cmk.register_and_activate(
            name,
            address,
            snmp_community=community,
            folder=folder,
            alias=alias,
            labels={k: v for k, v in labels.items() if v},
        )
        return {
            "ok": True,
            "host": result["host"],
            "address": address,
            "type": host_type,
            "device_type": device_type,
            "device_type_label": device_type_label(device_type),
            "vendor": vendor,
            "folder": folder,
            "alias": alias,
            "activated": True,
        }

    async def _update_host(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name is required"}
        existing = await self.cmk.get_host(name)
        if not existing:
            return {"ok": False, "error": f"host not found: {name}"}

        host_type = args.get("type")
        community = None
        if host_type == "snmp":
            community = str(args.get("snmp_community") or "public")
        address = args.get("address")
        alias = args.get("alias")
        if address is not None and address == (existing.get("address") or ""):
            address = None
        if alias is not None and alias == (existing.get("alias") or ""):
            alias = None
        if host_type is not None and host_type == (existing.get("type") or "agent"):
            if not (host_type == "snmp" and community):
                host_type = None

        labels: dict[str, str] | None = None
        if args.get("device_type") is not None or args.get("vendor") is not None:
            labels = {}
            if args.get("device_type") is not None:
                labels["aimon/device_type"] = self._normalize_device_type(args.get("device_type"))
            if args.get("vendor") is not None:
                labels["aimon/vendor"] = str(args.get("vendor") or "").strip().lower()

        result = await self.cmk.update_host(
            name,
            address=address,
            alias=alias,
            snmp_community=community if args.get("type") == "snmp" else None,
            host_type=host_type,
            labels=labels,
        )
        folder = args.get("folder")
        if folder is not None:
            current_folder = existing.get("folder") or "/"
            if (folder or "/") != current_folder:
                await self.cmk.move_host(name, folder or "/")
            result["folder"] = folder or "/"
        await self.cmk.activate_changes()
        result["activated"] = True
        if labels is not None:
            if "aimon/device_type" in labels:
                result["device_type"] = labels["aimon/device_type"]
                result["device_type_label"] = device_type_label(labels["aimon/device_type"])
            if "aimon/vendor" in labels:
                result["vendor"] = labels["aimon/vendor"]

        new_name = str(args.get("new_name") or "").strip()
        current = name
        if new_name and new_name != current:
            renamed = await self.cmk.rename_host(current, new_name)
            result.update(renamed)
            self.store.rename_host_refs(current, new_name)
            current = new_name
            await self.cmk.activate_changes()
            result["activated"] = True
        result["host"] = current
        result["ok"] = True
        return result

    async def _delete_host(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name is required"}
        await self.cmk.delete_host(name)
        await self.cmk.activate_changes()
        self.store.remove_host_refs(name)
        return {"ok": True, "host": name, "deleted": True}

    async def _list_sites(self) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": True, "count": 1, "sites": [{"id": "~", "path": "/", "title": "Корень", "hosts_count": 0}]}
        folders = await self.cmk.list_folders()
        counts: dict[str, int] = {}
        try:
            for h in await self.cmk.list_hosts():
                path = h.get("folder") or "/"
                counts[path] = counts.get(path, 0) + 1
        except httpx.HTTPError:
            pass
        sites = []
        for f in folders:
            path = f.get("path") or "/"
            sites.append({**f, "hosts_count": counts.get(path, 0)})
        return {"ok": True, "count": len(sites), "sites": sites}

    async def _create_site(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name is required"}
        title = str(args.get("title") or name).strip()
        parent = str(args.get("parent") or "/").strip() or "/"
        site = await self.cmk.create_folder(name, title=title, parent=parent)
        await self.cmk.activate_changes()
        return {"ok": True, **site, "activated": True}

    async def _update_site(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        site_id = str(args.get("site_id") or "").strip()
        title = str(args.get("title") or "").strip()
        if not site_id or not title:
            return {"ok": False, "error": "site_id and title required"}
        site = await self.cmk.update_folder(site_id, title=title)
        await self.cmk.activate_changes()
        return {"ok": True, **site, "activated": True}

    async def _delete_site(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        site_id = str(args.get("site_id") or "").strip()
        if not site_id:
            return {"ok": False, "error": "site_id required"}
        await self.cmk.delete_folder(site_id)
        await self.cmk.activate_changes()
        return {"ok": True, "site_id": site_id if site_id.startswith("~") else folder_path_to_id(site_id), "deleted": True}

    async def _scan_network(self, args: dict[str, Any]) -> dict[str, Any]:
        cidr = str(args.get("cidr") or "").strip()
        if not cidr:
            return {"ok": False, "error": "cidr is required"}
        if not cidr_is_allowed(cidr, self.settings.scan_allowlist_cidrs):
            return {"ok": False, "error": f"CIDR {cidr} is not in scan allowlist"}
        community = str(args.get("snmp_community") or "public")
        result = await scan_snmp(cidr, community)
        devices = list(result.get("devices") or []) if isinstance(result, dict) else list(result or [])
        ai_used = False
        if self.settings.deepseek_api_key and any(d.get("needs_ai") for d in devices):
            devices = await classify_devices_with_ai(devices, self.settings)
            ai_used = True
        compact = [
            {
                "ip": d.get("ip"),
                "name": d.get("name"),
                "alias": d.get("alias"),
                "vendor": d.get("vendor"),
                "model": d.get("model"),
                "device_type": d.get("device_type"),
                "device_type_label": d.get("device_type_label"),
                "sysname": d.get("sysname"),
                "sysdescr": (d.get("sysdescr") or "")[:160],
                "needs_ai": bool(d.get("needs_ai")),
            }
            for d in devices
        ]
        return {
            "ok": True,
            "cidr": cidr,
            "count": len(compact),
            "scanned": result.get("scanned") if isinstance(result, dict) else None,
            "ai_classified": ai_used,
            "devices": compact,
        }

    async def _add_hosts_from_scan(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        community = str(args.get("snmp_community") or "public")
        folder = str(args.get("folder") or "/").strip() or "/"
        devices = [d for d in (args.get("devices") or []) if isinstance(d, dict)]
        if self.settings.deepseek_api_key and any(
            not d.get("device_type") or d.get("needs_ai") or d.get("device_type") in ("unknown", "network", "host")
            for d in devices
        ):
            devices = [suggest_device_identity(d) for d in devices]
            devices = await classify_devices_with_ai(devices, self.settings)

        added: list[str] = []
        hosts: list[dict[str, Any]] = []
        errors: list[str] = []
        used: set[str] = set()
        for raw in devices:
            ip = str(raw.get("ip") or "").strip()
            if not ip:
                continue
            dev = suggest_device_identity(raw, used=used)
            name = str(dev.get("name") or "")
            alias = str(dev.get("alias") or "").strip()[:120]
            labels = {
                "aimon/device_type": str(dev.get("device_type") or "network"),
                "aimon/vendor": str(dev.get("vendor") or ""),
            }
            try:
                await self.cmk.register_and_activate(
                    name,
                    ip,
                    snmp_community=community,
                    folder=folder,
                    alias=alias,
                    labels={k: v for k, v in labels.items() if v},
                )
                added.append(name)
                hosts.append(
                    {
                        "name": name,
                        "ip": ip,
                        "alias": alias,
                        "device_type": dev.get("device_type"),
                        "folder": folder,
                    }
                )
            except httpx.HTTPError as exc:
                errors.append(f"{ip}/{name}: {exc}")
        return {
            "ok": True,
            "added": added,
            "hosts": hosts,
            "count": len(added),
            "folder": folder,
            "errors": errors,
        }

    async def _move_hosts(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self.cmk.enabled:
            return {"ok": False, "error": "Checkmk is not configured"}
        folder = str(args.get("folder") or "/").strip() or "/"
        names = [str(n).strip() for n in (args.get("names") or []) if str(n).strip()]
        if not names:
            return {"ok": False, "error": "names required"}
        moved: list[str] = []
        skipped: list[str] = []
        errors: list[str] = []
        for name in names:
            try:
                res = await self.cmk.move_host(name, folder)
                if res.get("moved"):
                    moved.append(name)
                else:
                    skipped.append(name)
            except httpx.HTTPError as exc:
                errors.append(f"{name}: {exc}")
        try:
            await self.cmk.activate_changes()
        except httpx.HTTPError as exc:
            return {"ok": False, "error": f"activate failed: {exc}", "moved": moved, "errors": errors}
        return {
            "ok": True,
            "folder": folder,
            "moved": moved,
            "skipped": skipped,
            "errors": errors,
            "count": len(moved),
        }

    def _list_users(self) -> dict[str, Any]:
        denied = self._require_admin()
        if denied:
            return denied
        users = [public_user(u) for u in self.store.list_users()]
        return {"ok": True, "count": len(users), "users": users}

    def _create_user(self, args: dict[str, Any]) -> dict[str, Any]:
        denied = self._require_admin()
        if denied:
            return denied
        role = str(args.get("role") or "user").strip()
        if role not in ("engineer", "user"):
            return {"ok": False, "error": "role must be engineer or user (admin запрещён)"}
        username = str(args.get("username") or "").strip()
        password = str(args.get("password") or "")
        if not username:
            return {"ok": False, "error": "username required"}
        if len(password) < 6:
            return {"ok": False, "error": "пароль не короче 6 символов"}
        try:
            user = self.store.create_user(
                username=username,
                password_hash=hash_password(password),
                role=role,
                display_name=str(args.get("display_name") or ""),
                hosts=list(args.get("hosts") or []) if role == "user" else [],
                enabled=bool(args.get("enabled", True)),
            )
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "user": public_user(user), "username": user["username"], "role_label": ROLE_LABELS.get(role)}

    def _update_user(self, args: dict[str, Any]) -> dict[str, Any]:
        denied = self._require_admin()
        if denied:
            return denied
        username = str(args.get("username") or "").strip()
        existing = self.store.get_user_by_username(username)
        if not existing:
            return {"ok": False, "error": "user not found"}
        if existing.get("role") == "admin":
            return {"ok": False, "error": "нельзя изменять администратора через ассистента"}
        role = args.get("role")
        if role is not None and role not in ("engineer", "user"):
            return {"ok": False, "error": "role must be engineer or user"}
        fields: dict[str, Any] = {}
        if args.get("display_name") is not None:
            fields["display_name"] = str(args.get("display_name") or "")
        if role is not None:
            fields["role"] = role
        if args.get("enabled") is not None:
            fields["enabled"] = bool(args.get("enabled"))
        effective_role = role if role is not None else existing.get("role")
        if args.get("hosts") is not None:
            fields["hosts"] = list(args.get("hosts") or []) if effective_role == "user" else []
        password = args.get("password")
        if password:
            if len(str(password)) < 6:
                return {"ok": False, "error": "пароль не короче 6 символов"}
            fields["password_hash"] = hash_password(str(password))
        try:
            updated = self.store.update_user(existing["id"], **fields)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        if not updated:
            return {"ok": False, "error": "user not found"}
        return {"ok": True, "user": public_user(updated)}

    def _delete_user(self, args: dict[str, Any]) -> dict[str, Any]:
        denied = self._require_admin()
        if denied:
            return denied
        username = str(args.get("username") or "").strip()
        existing = self.store.get_user_by_username(username)
        if not existing:
            return {"ok": False, "error": "user not found"}
        if existing.get("role") == "admin":
            return {"ok": False, "error": "нельзя удалять администратора через ассистента"}
        actor = self._actor or {}
        if actor.get("id") and actor.get("id") == existing.get("id"):
            return {"ok": False, "error": "нельзя удалить свою учётную запись"}
        if not self.store.delete_user(existing["id"]):
            return {"ok": False, "error": "user not found"}
        return {"ok": True, "username": username, "deleted": True}

    def _list_secrets(self) -> dict[str, Any]:
        items = self.store.list_secrets()
        return {"ok": True, "count": len(items), "secrets": items}

    def _create_secret(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args.get("name") or "").strip()
        kind = str(args.get("kind") or "").strip()
        value = str(args.get("value") or "")
        if not name or not value:
            return {"ok": False, "error": "name and value required"}
        if kind not in SECRET_KINDS:
            return {"ok": False, "error": f"kind must be one of: {', '.join(SECRET_KINDS)}"}
        entry = self.store.add_secret(name, kind, self.box.encrypt(value))
        return {"ok": True, **entry}

    def _update_secret(self, args: dict[str, Any]) -> dict[str, Any]:
        secret_id = str(args.get("secret_id") or "").strip()
        if not secret_id:
            return {"ok": False, "error": "secret_id required"}
        kind = args.get("kind")
        if kind is not None and kind not in SECRET_KINDS:
            return {"ok": False, "error": f"kind must be one of: {', '.join(SECRET_KINDS)}"}
        encrypted = None
        if args.get("value") is not None and str(args.get("value")) != "":
            encrypted = self.box.encrypt(str(args.get("value")))
        updated = self.store.update_secret(
            secret_id,
            name=str(args["name"]) if args.get("name") is not None else None,
            kind=str(kind) if kind is not None else None,
            encrypted_value=encrypted,
        )
        if not updated:
            return {"ok": False, "error": "secret not found"}
        return {"ok": True, **updated}

    def _delete_secret(self, args: dict[str, Any]) -> dict[str, Any]:
        secret_id = str(args.get("secret_id") or "").strip()
        if not secret_id:
            return {"ok": False, "error": "secret_id required"}
        if not self.store.delete_secret(secret_id):
            return {"ok": False, "error": "secret not found"}
        return {"ok": True, "secret_id": secret_id, "deleted": True}

    def _list_available_tools(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "all").lower()
        out: list[dict[str, Any]] = []
        if kind in ("all", "builtin"):
            for t in BUILTIN_TOOLS:
                fn = t.get("function") or {}
                name = fn.get("name")
                if not name:
                    continue
                out.append(
                    {
                        "name": name,
                        "kind": "builtin",
                        "meta": name in META_TOOL_NAMES,
                        "description": fn.get("description") or "",
                    }
                )
        if kind in ("all", "custom"):
            for t in self.store.list_ai_tools():
                out.append(
                    {
                        "name": t.get("name"),
                        "kind": "custom",
                        "meta": False,
                        "description": t.get("description") or "",
                        "based_on": t.get("based_on"),
                        "steps_count": len(t.get("steps") or []),
                    }
                )
        return {"ok": True, "count": len(out), "tools": out}

    def _get_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name required"}
        custom = self.store.get_ai_tool(name)
        if custom:
            return {
                "ok": True,
                "kind": "custom",
                "name": custom.get("name"),
                "description": custom.get("description"),
                "parameters": custom.get("parameters"),
                "steps": custom.get("steps") or [],
                "based_on": custom.get("based_on"),
                "created_at": custom.get("created_at"),
                "updated_at": custom.get("updated_at"),
            }
        for t in BUILTIN_TOOLS:
            fn = t.get("function") or {}
            if fn.get("name") == name:
                return {
                    "ok": True,
                    "kind": "builtin",
                    "name": name,
                    "description": fn.get("description"),
                    "parameters": fn.get("parameters"),
                    "meta": name in META_TOOL_NAMES,
                    "steps": None,
                }
        return {"ok": False, "error": f"tool not found: {name}"}

    def _list_custom_tools(self) -> dict[str, Any]:
        tools = [
            {
                "name": t.get("name"),
                "description": t.get("description"),
                "based_on": t.get("based_on"),
                "steps": t.get("steps") or [],
                "parameters": t.get("parameters"),
                "created_at": t.get("created_at"),
                "updated_at": t.get("updated_at"),
            }
            for t in self.store.list_ai_tools()
        ]
        return {"ok": True, "count": len(tools), "tools": tools}

    def _create_custom_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name required"}
        if name.lower() in {n.lower() for n in BUILTIN_TOOL_NAMES}:
            return {"ok": False, "error": "name conflicts with built-in tool"}

        based_on = str(args.get("based_on") or "").strip()
        template: dict[str, Any] = {}
        if based_on:
            template = self._template_from_tool(based_on) or {}
            if not template:
                return {"ok": False, "error": f"based_on tool not found or not allowed: {based_on}"}

        description = str(args.get("description") or template.get("description") or name).strip()
        params = args.get("parameters") if args.get("parameters") is not None else template.get("parameters")
        raw_steps = args.get("steps") if args.get("steps") is not None else template.get("steps")

        if not raw_steps:
            return {
                "ok": False,
                "error": "steps required (укажите steps или based_on с готовыми шагами)",
            }
        cleaned, err = self._normalize_steps(list(raw_steps))
        if err or cleaned is None:
            return {"ok": False, "error": err or "invalid steps"}

        if params is not None and not isinstance(params, dict):
            return {"ok": False, "error": "parameters must be object"}
        if not params:
            params = self._params_from_steps(cleaned)

        try:
            entry = self.store.create_ai_tool(
                name=name,
                description=description or name,
                parameters=params,
                steps=cleaned,
                based_on=based_on or str(template.get("based_on") or ""),
            )
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        return {
            "ok": True,
            "name": entry["name"],
            "description": entry["description"],
            "based_on": entry.get("based_on"),
            "parameters": entry.get("parameters"),
            "steps": entry["steps"],
        }

    def _update_custom_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name required"}
        existing = self.store.get_ai_tool(name)
        if not existing:
            return {"ok": False, "error": "custom tool not found"}

        fields: dict[str, Any] = {}
        based_on = str(args.get("based_on") or "").strip()
        if based_on:
            template = self._template_from_tool(based_on)
            if not template:
                return {"ok": False, "error": f"based_on tool not found or not allowed: {based_on}"}
            # apply template first; explicit args override below
            fields["description"] = template.get("description")
            fields["parameters"] = template.get("parameters")
            fields["steps"] = template.get("steps")
            fields["based_on"] = based_on

        if args.get("new_name") is not None and str(args.get("new_name") or "").strip():
            new_name = str(args.get("new_name")).strip()
            if new_name.lower() in {n.lower() for n in BUILTIN_TOOL_NAMES}:
                return {"ok": False, "error": "new_name conflicts with built-in tool"}
            fields["name"] = new_name
        if args.get("description") is not None:
            fields["description"] = str(args.get("description") or "")
        if args.get("parameters") is not None:
            if not isinstance(args.get("parameters"), dict):
                return {"ok": False, "error": "parameters must be object"}
            fields["parameters"] = args.get("parameters")
        if args.get("steps") is not None:
            cleaned, err = self._normalize_steps(list(args.get("steps") or []))
            if err or cleaned is None:
                return {"ok": False, "error": err or "invalid steps"}
            fields["steps"] = cleaned

        if "steps" in fields:
            # re-validate after merge against current allowed set
            cleaned, err = self._normalize_steps(list(fields["steps"]))
            if err or cleaned is None:
                return {"ok": False, "error": err or "invalid steps"}
            fields["steps"] = cleaned

        if not fields:
            return {"ok": False, "error": "no changes provided"}

        try:
            updated = self.store.update_ai_tool(name, **fields)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        if not updated:
            return {"ok": False, "error": "custom tool not found"}
        return {
            "ok": True,
            "name": updated.get("name"),
            "description": updated.get("description"),
            "based_on": updated.get("based_on"),
            "parameters": updated.get("parameters"),
            "steps": updated.get("steps") or [],
            "updated_at": updated.get("updated_at"),
        }

    def _delete_custom_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "name required"}
        if not self.store.delete_ai_tool(name):
            return {"ok": False, "error": "tool not found"}
        return {"ok": True, "name": name, "deleted": True}

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
