# Работа с dashboard и подключение Windows-сервера

## Доступ к dashboard

| Где | URL |
|-----|-----|
| Из интернета (HTTPS) | `https://94.181.181.43:7444` |
| Локально / VPN | `https://100.10.10.66:7444` или `http://100.10.10.66:7081` |

При первом открытии HTTPS примите самоподписанный сертификат (Advanced → Proceed).

Dashboard автоматически входит в portal API с учётной записью из `.env`:

- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

Статус синхронизации — в правом верхнем углу («Данные актуальны» / «API недоступен»).

## Обзор интерфейса

1. **Обзор** — сводка: число устройств, доступность, активные проблемы.
2. **Устройства** — инвентарь портала (то, что добавлено через мастер или API).
3. **Проблемы** — события со статусом `degraded` / `failed` (пока из портала; позже — из Zabbix).
4. **Площадки** — логические группы (офис, ЦОД и т.д.).
5. **Настройки** — статус Zabbix API и системы (без демо-цифр).

Кнопка **«Добавить устройство»** открывает отдельную страницу `add-device.html`
с 4-шаговым мастером:

| Шаг | Что делает |
|-----|------------|
| 1. Основное | Имя, IP/FQDN, площадка, тип |
| 2. Подключение | Протокол + **фрейм с инструкцией** по типу/производителю |
| 3. Проверка | Probe через API (ICMP + протокол) |
| 4. Готово | Подтверждение и запись в инвентарь портала |

После успешного добавления мастер возвращает на `index.html#devices`.

### Шаг 2 — инструкции по типам

| Тип устройства | Варианты в списке |
|----------------|-------------------|
| Сервер | Windows Server, Linux Server |
| Рабочая станция | Windows, Linux |
| Сетевое оборудование | MikroTik, Keenetic, Cisco, D-Link, TP-Link, HP/Aruba |
| ИБП | APC, Eaton/IPPON, CyberPower, прочие SNMP |

В фрейме: подробная пошаговая настройка, рекомендуемый шаблон Zabbix,
скачивание агентов и YAML-шаблонов **с локального зеркала dashboard**:

- агенты и скрипты: `/agents/` (см. `/agents/README.md`)
- шаблоны YAML: `/templates/` (см. `/templates/README.md`)
- one-command деплой агента:
  - Linux: `/agents/scripts/deploy-agent2-linux.sh`
  - Windows: `/agents/scripts/deploy-agent2-windows.ps1`

Протокол подбирается автоматически (agent2 для ОС, SNMPv3 для сети и ИБП).

Пример Linux (одна команда; `-k` из‑за самоподписанного сертификата):

```bash
curl -fsSLk "https://94.181.181.43:7444/agents/scripts/deploy-agent2-linux.sh" \
  | sudo bash -s -- --base "https://94.181.181.43:7444" \
      --server 94.181.181.43 --hostname my-linux-host
```

Обновить зеркало агентов на сервере:

```bash
sudo ./scripts/fetch-zabbix-assets.sh
```

> Мастер регистрирует устройство в БД портала и при включённом Zabbix API
> создаёт host. Для Windows/Linux сначала установите agent по инструкции шага 2.

## Если в Zabbix «нет данных»

На сервере:

```bash
sudo /opt/netmon/scripts/diagnose-monitoring.sh
```

| Тип | Симптом | Что сделать |
|-----|---------|-------------|
| Agent (PVE/Linux/Windows) | `active_agent available=0`, график «нет данных» | На устройстве: `Server=100.10.10.66,94.181.181.43`, `ServerActive=100.10.10.66`, `Hostname=` **точно** как Host name в Zabbix; `systemctl restart zabbix-agent2` |
| SNMP | timeout OID / snmp unavailable | Настроить SNMPv3 на устройстве под профиль NetMon (по умолчанию placeholder `zabbix-monitor` / `change-me-auth` / `change-me-priv`) или задать реальные пароли |
| ICMP | fping «must run as root» | У `zabbix-server` не должно быть `security_opt: no-new-privileges` |

## Подключение Windows-сервера (Zabbix agent2)

### 1. Сеть и порты

На **Windows-сервере**:

- исходящий доступ к Zabbix: `94.181.181.43:10051` (или `100.10.10.66:10051` в локальной сети);
- входящий **10050/TCP** — если используете passive checks (опционально).

На **роутере** (если сервер в другой сети, а Zabbix за NAT):

- проброс **10051/TCP** → `100.10.10.66:10051` (уже настроен для trapper).

### 2. Установка Zabbix Agent 2 на Windows

1. Скачайте MSI для Zabbix 7.0:  
   https://www.zabbix.com/download_agents
2. Установите **Zabbix agent 2** (64-bit).
3. Отредактируйте `C:\Program Files\Zabbix Agent 2\zabbix_agent2.conf`:

```ini
Server=100.10.10.66,94.181.181.43
ServerActive=100.10.10.66
Hostname=win-srv-01
```

`Hostname` — **уникальное** имя; его же укажете в Zabbix.

4. Перезапустите службу **Zabbix Agent 2**.
5. Разрешите в Windows Firewall исходящие подключения к `:10051`.

Проверка на Windows (PowerShell):

```powershell
Test-NetConnection 94.181.181.43 -Port 10051
Get-Service "Zabbix Agent 2"
```

### 3. Добавление host в Zabbix UI

1. Откройте Zabbix: `https://94.181.181.43:7443`
2. Войдите: `Admin` / `zabbix` (смените пароль, если ещё не меняли).
3. **Data collection → Hosts → Create host**
   - **Host name:** `win-srv-01` (как `Hostname` в agent)
   - **Groups:** `Windows servers` (создайте при необходимости)
   - **Interfaces:** Agent — IP Windows-сервера, port `10050` (passive)  
     или только active checks без интерфейса
4. **Templates:** добавьте `Windows by Zabbix agent` (или `Windows by Zabbix agent active`).
5. **Add** → через 1–2 минуты в **Monitoring → Latest data** появятся метрики.

### 4. Регистрация в dashboard (инвентарь портала)

1. Dashboard → **Добавить устройство**
2. Тип: **Сервер**
3. Протокол: **Zabbix agent2**
4. IP: адрес Windows-сервера
5. Площадка: создайте, например, «Офис Пенза»
6. Пройдите проверку и сохраните

Устройство появится в списке **Устройства**; метрики смотрите в Zabbix UI до появления
полной синхронизации portal ↔ Zabbix.

## Очистка демо-данных на уже установленном сервере

Если после обновления в портале остались старые demo-записи:

```bash
cd /opt/netmon
sudo ./scripts/purge-demo-inventory.sh
sudo docker compose --env-file .env up -d --build api
```

Обновите страницу dashboard (Ctrl+F5).

## Полезные команды

```bash
# Статус стека
cd /opt/netmon && sudo docker compose --env-file .env ps

# Логи API
sudo docker compose --env-file .env logs -f api

# Health API через dashboard
curl -kfsS https://127.0.0.1:7444/api/v1/health/live
```

## Что дальше

- Включить `ZABBIX_ENABLED=true` и API-пользователя Zabbix в `.env` для интеграции gateway.
- Автоматическое создание host в Zabbix из мастера dashboard — Stage 2.
