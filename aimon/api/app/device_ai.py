from __future__ import annotations

import json
from typing import Any

import httpx

from app.config import Settings
from app.dns_pin import pin_url_host
from app.scan import DEVICE_TYPE_LABELS, suggest_device_identity

ALLOWED_TYPES = set(DEVICE_TYPE_LABELS.keys()) - {"unknown"}


async def classify_devices_with_ai(
    devices: list[dict[str, Any]],
    settings: Settings,
) -> list[dict[str, Any]]:
    """Ask DeepSeek to classify unclear SNMP devices; merge into device dicts."""
    unclear = [d for d in devices if d.get("needs_ai")]
    if not unclear or not settings.deepseek_api_key:
        return devices

    pin_url_host(settings.deepseek_base_url or "https://api.deepseek.com")
    payload_devs = [
        {
            "ip": d.get("ip"),
            "sysname": d.get("sysname"),
            "sysdescr": (d.get("sysdescr") or "")[:240],
            "vendor": d.get("vendor"),
            "model": d.get("model"),
            "suggested_name": d.get("name"),
        }
        for d in unclear[:40]
    ]
    types_list = ", ".join(sorted(ALLOWED_TYPES))
    prompt = (
        "Ты классификатор сетевых устройств для системы мониторинга.\n"
        f"Для каждого устройства верни JSON-массив объектов с полями: "
        f"ip, device_type (одно из: {types_list}), "
        "vendor (латиница коротко), model (коротко), "
        "name (латиница hostname без пробелов, понятное имя), "
        "alias (человекочитаемый псевдоним на русском/латинице до 100 символов).\n"
        "Только JSON-массив, без markdown.\n\n"
        f"Устройства:\n{json.dumps(payload_devs, ensure_ascii=False)}"
    )

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {settings.deepseek_api_key}"},
                json={
                    "model": settings.deepseek_model,
                    "messages": [
                        {"role": "system", "content": "Отвечай только валидным JSON."},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                },
            )
            resp.raise_for_status()
            content = ((resp.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    except Exception:  # noqa: BLE001
        return devices

    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    try:
        arr = json.loads(text)
    except json.JSONDecodeError:
        # try extract array
        start, end = text.find("["), text.rfind("]")
        if start < 0 or end < 0:
            return devices
        try:
            arr = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return devices
    if not isinstance(arr, list):
        return devices

    by_ip = {str(x.get("ip")): x for x in arr if isinstance(x, dict) and x.get("ip")}
    out: list[dict[str, Any]] = []
    used: set[str] = {str(d.get("name") or "") for d in devices if d.get("name") and not d.get("needs_ai")}
    for d in devices:
        ip = str(d.get("ip") or "")
        if ip not in by_ip:
            out.append(d)
            continue
        ai = by_ip[ip]
        merged = dict(d)
        dtype = str(ai.get("device_type") or "").strip().lower()
        if dtype in ALLOWED_TYPES:
            merged["device_type"] = dtype
            merged["device_type_confidence"] = "high"
            merged["needs_ai"] = False
        if ai.get("vendor"):
            merged["vendor"] = str(ai.get("vendor")).strip().lower()
        if ai.get("model"):
            merged["model"] = str(ai.get("model")).strip()
        if ai.get("name"):
            merged["name"] = str(ai.get("name")).strip()
        if ai.get("alias"):
            merged["alias"] = str(ai.get("alias")).strip()[:120]
        merged = suggest_device_identity(merged, used=used)
        merged["device_type_confidence"] = "high" if dtype in ALLOWED_TYPES else merged.get("device_type_confidence")
        merged["needs_ai"] = False if dtype in ALLOWED_TYPES else merged.get("needs_ai", False)
        merged["ai_classified"] = True
        out.append(merged)
    return out
