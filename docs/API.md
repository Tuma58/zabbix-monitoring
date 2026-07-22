# Контракт REST API

Базовый путь: `/api/v1`. Формат: JSON, UTF-8. Все даты — RFC 3339 UTC. Каждая
ошибка содержит стабильный `code`, человекочитаемый `message`, `request_id` и
опциональные `details`.

Машинночитаемый контракт Stage 1: [`docs/openapi.json`](openapi.json)
(генерируется из FastAPI).

## Общие правила

- bearer token или защищённая HttpOnly session cookie;
- `Idempotency-Key` обязателен для provisioning и массовых изменений;
- pagination: `limit` (до 200) и opaque `cursor`;
- фильтры передаются query-параметрами, сортировка — `sort=field,-field`;
- длительные действия отвечают `202 Accepted` и ссылкой на operation;
- `X-Request-ID` принимается от reverse proxy или создаётся API.

## Основные endpoints

| Метод и путь | Назначение | Роль |
|---|---|---|
| `POST /auth/login` | локальный вход | public |
| `POST /auth/refresh` | ротация сессии/token | authenticated |
| `GET /me` | пользователь и permissions | authenticated |
| `GET/POST /sites` | список/создание площадок | viewer/admin |
| `GET/POST /devices` | каталог/создание draft | viewer/operator |
| `GET/PATCH /devices/{id}` | карточка/изменение | viewer/operator |
| `POST /devices/probe` | проверить доступ и определить модель | operator |
| `POST /devices/plan` | построить preview конфигурации | operator |
| `POST /devices/apply` | применить plan в Zabbix | operator |
| `POST /devices/imports` | загрузить CSV import | admin |
| `GET /operations/{id}` | прогресс фоновой операции | viewer |
| `GET/POST /credential-profiles` | список/создание профиля | operator/admin |
| `PATCH /credential-profiles/{id}` | ротация секретов | admin |
| `GET /dashboard/summary` | KPI и состояние площадок | viewer |
| `GET /problems` | активные проблемы | viewer |
| `POST /problems/{event_id}/ack` | acknowledge/comment | operator |
| `GET /devices/{id}/metrics` | нормализованные series/trends | viewer |
| `GET/POST /maintenances` | окна обслуживания | viewer/operator |
| `GET /events/stream` | SSE обновлений | viewer |
| `GET /audit-events` | аудит | admin |
| `GET /health/live` | liveness | internal/public |
| `GET /health/ready` | БД, Redis, Zabbix dependency status | internal |

## Пример probe

```http
POST /api/v1/devices/probe
Authorization: Bearer <token>
Content-Type: application/json

{
  "site_id": "0d384f1c-ff71-4078-8880-e808b3bd7609",
  "address": "10.20.1.15",
  "device_type": "ups",
  "protocol": "snmpv3",
  "credential_profile_id": "e920b52c-fc43-45ed-90bd-c470cb794e30"
}
```

Ответ `202`:

```json
{
  "operation_id": "3fa59553-acde-4d64-99ea-fb489b9bf35a",
  "state": "queued",
  "links": {"self": "/api/v1/operations/3fa59553-acde-4d64-99ea-fb489b9bf35a"}
}
```

Завершённая операция не раскрывает credential material:

```json
{
  "id": "3fa59553-acde-4d64-99ea-fb489b9bf35a",
  "kind": "device_probe",
  "state": "succeeded",
  "progress": 100,
  "result": {
    "icmp": {"ok": true, "latency_ms": 4.2},
    "protocol": {"ok": true, "version": "3"},
    "identity": {
      "vendor": "APC",
      "model": "Smart-UPS",
      "sys_object_id": "1.3.6.1.4.1.318..."
    },
    "warnings": []
  }
}
```

## Пример plan/apply

`POST /devices/plan` принимает адрес, site, protocol profile и найденную identity.
Ответ содержит неизменяемый `plan_id`, срок действия, предполагаемые Zabbix
group/template IDs, macros и предупреждения. Секретные macro values в preview
заменяются на `********`.

```http
POST /api/v1/devices/apply
Idempotency-Key: add-ups-msk-01-20260722
```

```json
{
  "plan_id": "b2189191-7f7e-4fd8-9450-4d277f372417",
  "display_name": "UPS server room 1"
}
```

Одинаковые тело и ключ возвращают первоначальную operation. Повтор ключа с
другим телом возвращает `409 IDEMPOTENCY_KEY_REUSED`.

## Error codes

| HTTP | Code | Значение |
|---:|---|---|
| 400 | `VALIDATION_FAILED` | некорректный запрос |
| 401 | `AUTH_REQUIRED` | отсутствует/истёкшая сессия |
| 403 | `PERMISSION_DENIED` | недостаточно permissions |
| 404 | `RESOURCE_NOT_FOUND` | объект отсутствует или недоступен |
| 409 | `DEVICE_ALREADY_EXISTS` | address/name уже зарегистрирован |
| 409 | `VERSION_CONFLICT` | объект изменился после чтения |
| 422 | `PROBE_AUTH_FAILED` | сеть доступна, protocol auth не прошёл |
| 422 | `TEMPLATE_NOT_RESOLVED` | policy не выбрала шаблон |
| 429 | `RATE_LIMITED` | превышен лимит |
| 502 | `ZABBIX_API_ERROR` | Zabbix вернул ошибку |
| 503 | `DEPENDENCY_UNAVAILABLE` | Zabbix/Redis/БД временно недоступны |

## WebSocket/SSE

Для первого релиза используется SSE `GET /events/stream`, поскольку поток
однонаправленный. События: `problem.created`, `problem.updated`,
`device.status_changed`, `operation.updated`. Клиент передаёт `Last-Event-ID` для
восстановления после разрыва; при слишком старом ID выполняет REST refresh.
