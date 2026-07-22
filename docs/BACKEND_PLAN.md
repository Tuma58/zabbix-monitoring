# План разработки backend

## 1. Объём MVP

MVP рассчитан на одну организацию, несколько площадок и до 500 устройств. Он
включает:

- вход по локальной учётной записи и готовность к OIDC;
- роли `admin`, `operator`, `viewer`;
- каталог площадок, устройств, профилей подключения и шаблонных политик;
- добавление одного устройства и импорт CSV;
- SNMP, Zabbix agent2, ICMP и IPMI;
- обзор проблем, availability, capacity и карточку устройства;
- acknowledge/close/comment в пределах возможностей Zabbix;
- maintenance windows;
- аудит и состояние фоновых операций.

Не входят в первый релиз: полноценный multi-tenant SaaS, биллинг, мобильное
приложение, конструктор произвольных Zabbix templates и автоматический remediation.

## 2. Модули

### `identity`

- users, roles, sessions, password policy;
- OIDC adapter как второй provider;
- access token 15 минут, refresh rotation, server-side revocation;
- permission checks на уровне service layer.

### `inventory`

- sites, device types, devices, tags и owners;
- связь внутреннего UUID с Zabbix `hostid`;
- состояние синхронизации: `draft`, `provisioning`, `active`, `degraded`,
  `failed`, `archived`;
- optimistic locking по `version`.

### `credentials`

- SNMPv3, SNMPv2c, agent PSK и IPMI profiles;
- секретные поля только write-only;
- master key вне БД, отдельный DEK на запись;
- ротация ключей без повторного добавления устройства.

### `provisioning`

- probe adapters по протоколам;
- rules `vendor + model + device_type -> templates/macros`;
- plan/apply модель, похожая на инфраструктурные инструменты;
- идемпотентные jobs, retry с exponential backoff;
- compensating action при частично выполненной операции.

### `zabbix_gateway`

- единая обёртка JSON-RPC API;
- service account с минимально достаточной ролью;
- pagination, batch calls, timeout, circuit breaker;
- перевод ошибок Zabbix в стабильные application error codes;
- version capability matrix для безопасного обновления Zabbix.

### `dashboard`

- фасад для problems, availability, SLA, inventory и capacity;
- Redis cache с коротким TTL и защитой от cache stampede;
- SSE-канал для обновления проблем; polling остаётся fallback;
- предвычисление дорогих агрегатов worker-ом.

### `audit`

- append-only события: actor, action, target, request ID, diff, result, IP;
- секреты и auth headers никогда не попадают в payload;
- выгрузка JSON/CSV и retention не менее 365 дней.

## 3. Модель данных портала

| Таблица | Ключевые поля |
|---|---|
| `users` | `id`, `email`, `password_hash`, `status`, timestamps |
| `roles`, `user_roles` | роль и привязка пользователя |
| `sites` | `id`, `name`, `timezone`, `proxy_id`, `tags` |
| `devices` | `id`, `site_id`, `zabbix_host_id`, `name`, `address`, `type`, `vendor`, `model`, `status`, `version` |
| `credential_profiles` | `id`, `type`, `name`, `encrypted_payload`, `key_version` |
| `monitoring_policies` | match rules, templates, macros, intervals, priority |
| `operations` | `id`, `kind`, `state`, `progress`, `error_code`, `idempotency_key`, timestamps |
| `operation_steps` | step, attempt, state, sanitized input/output |
| `audit_events` | actor, action, object, diff, result, correlation ID |
| `sync_cursors` | тип объекта, последняя ревизия/время синхронизации |

`devices` не дублирует metrics или problems. Источником истины для них остаётся
Zabbix. Soft delete применяется к пользовательским сущностям; аудит не удаляется
обычными API-операциями.

## 4. Мастер добавления устройства

### Шаг 1. Основное

Площадка, понятное имя, IP/FQDN, тип устройства и Zabbix proxy. UI сразу
проверяет формат и дубликаты.

### Шаг 2. Подключение

Выбор сохранённого credential profile или создание нового. Для SNMPv3: level,
user, auth/priv protocols и write-only secrets. Для agent2: active/passive и PSK.

### Шаг 3. Проверка

Backend запускает асинхронный probe и возвращает отдельно:

- DNS/route/ICMP;
- доступность порта/протокола;
- успешность аутентификации;
- sysObjectID/vendor/model;
- предупреждения о небезопасном протоколе.

### Шаг 4. Рекомендация

Показываются host group, templates, macros, tags и интервалы. Пользователь с
ролью `admin` может изменить preview, оператор — только подтвердить разрешённую
policy.

### Шаг 5. Применение

Операция выполняется в фоне. UI показывает этапы и диагностирует отсутствие
первых данных. Повторное нажатие не создаёт дубль благодаря idempotency key.

## 5. Нефункциональные требования

### Производительность

- p95 чтения dashboard API менее 500 мс при прогретом кэше;
- p95 обычных CRUD-запросов менее 300 мс;
- 50 одновременных provisioning jobs без потери задач;
- dashboard не делает более одного Zabbix API batch на виджет и интервал TTL.

### Доступность и восстановление

- целевой SLO MVP: 99,5% в месяц;
- RPO 24 часа на старте, затем 1 час после выноса PostgreSQL;
- RTO 4 часа на старте;
- graceful degradation: при недоступности Zabbix UI показывает возраст данных и
  не выдаёт кэш за актуальное состояние.

### Безопасность

- TLS 1.2+, HSTS после проверки домена;
- Argon2id для локальных паролей, MFA/OIDC в production;
- rate limit для login, probe и массовых операций;
- CSRF protection при cookie auth, строгий CORS, CSP;
- allowlist сетей/адресов для probe против SSRF;
- containers без privileged mode; `NET_RAW` только у Zabbix server;
- SBOM, vulnerability scan и pinned image digests перед production;
- журналирование всех изменений мониторинга.

## 6. Этапы и результаты

Оценка дана для команды из двух backend, одного frontend и part-time DevOps/QA.
Это ориентир для планирования, а не календарное обязательство.

| Этап | Срок | Результат |
|---|---:|---|
| 0. Discovery/PoC | 1–2 недели | перечень устройств, доступность протоколов, 10–20 пилотных hosts, измерение NVPS |
| 1. Platform foundation | 2 недели | CI, Compose, migrations, auth/RBAC, secrets, Zabbix gateway, audit skeleton |
| 2. Inventory & provisioning | 3 недели | sites/devices/profiles, probe, preview/apply, jobs, шаблонные policies |
| 3. Dashboard | 3 недели | overview, problems, device page, filters, cache и SSE |
| 4. Operations | 2 недели | maintenance, CSV import, retries, backup/restore, self-monitoring |
| 5. Hardening/pilot | 2 недели | load/security tests, runbooks, recovery drill, UAT и исправления |

Общий ориентир MVP: 12–14 недель после инвентаризации и получения доступов.

## 7. Definition of Done

- OpenAPI контракт версионирован и проходит schema tests;
- unit coverage бизнес-логики не ниже 80%, есть integration tests с Zabbix;
- повтор provisioning с тем же ключом не создаёт второй host;
- секреты отсутствуют в логах, API-ответах и audit payload;
- backup восстановлен на отдельном стенде и результат задокументирован;
- обновление с предыдущей версии выполняется по runbook;
- dashboard выдерживает согласованную пилотную нагрузку;
- инструкции оператора проверены человеком, не участвовавшим в разработке.

## 8. Риски и решения

| Риск | Мера |
|---|---|
| Несовместимые/бедные SNMP MIB | пилот, vendor templates, ручные overrides и fallback на ICMP |
| Слишком много items/NVPS | proxies, интервалы по классам, preprocessing, trends и housekeeping policy |
| Утечка community/password | SNMPv3, encrypted profiles, маскирование, rotation и запрет экспорта secrets |
| Расхождение портала и Zabbix | periodic reconciliation и явный sync status |
| API Zabbix изменился после обновления | capability matrix, contract tests и staged upgrade |
| VPS не видит внутренние сети | Zabbix proxy внутри площадки или VPN, без проброса management-сетей наружу |
