# Эксплуатация

## Ежедневные проверки

- статус контейнеров и возраст последнего restart;
- очередь Zabbix (`Queue overview`) и unsupported items;
- внутренние items `Zabbix server health`;
- свободное место БД, WAL и volume;
- возраст последней успешной резервной копии;
- ошибки proxy/agent connectivity и истёкшие certificates/PSK policies.

## Логи

```bash
cd /opt/netmon
sudo docker compose logs --since=1h zabbix-server
sudo docker compose logs --since=1h zabbix-web
sudo docker compose logs --since=1h postgres
```

В custom backend JSON-логи должны содержать `timestamp`, `level`, `service`,
`request_id`, `operation_id`, `actor_id` и `error_code`. Password, community,
PSK, session cookie, authorization header и полный encrypted payload запрещены.

## Backup

Минимальный логический backup Zabbix БД:

```bash
cd /opt/netmon
set -a
. ./.env
set +a
sudo docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "zabbix-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Файл необходимо шифровать и копировать за пределы VPS. Production-процесс
должен запускаться по timer/backup-сервису, иметь retention (например 7 daily,
4 weekly, 12 monthly) и отдельный alert при ошибке. `.env`, Caddy config,
экспортированные Zabbix templates и конфигурация custom portal копируются
отдельно; `.env` хранится только в зашифрованном backup.

## Restore drill

Восстановление всегда проверяется на отдельном стенде:

1. развернуть чистый PostgreSQL той же major-версии;
2. остановить Zabbix server/web на стенде;
3. создать пустую БД с нужным owner;
4. выполнить `pg_restore --clean --if-exists`;
5. запустить Zabbix и проверить автоматическую миграцию схемы;
6. проверить login, hosts, latest data, problems, templates и API;
7. зафиксировать длительность и фактические RPO/RTO.

Команда production restore намеренно не автоматизирована в bootstrap: она
перезаписывает данные и должна требовать отдельного подтверждённого runbook.

## Retention и sizing

Начальные ориентиры для пилота:

- numeric history: 14–30 дней;
- text/log history: 7–14 дней или меньше для шумных items;
- trends: 365 дней;
- audit custom portal: 365 дней;
- API/application logs: 30 дней с ротацией.

После двух недель измерить new values per second, рост БД/сутки, cache usage,
queue и busy processes. По результатам корректировать poll intervals, history,
trends, preprocessing и число pollers. Универсальная оценка только по числу hosts
недостаточна.

## Обработка инцидента

1. Зафиксировать время, симптомы и request/event IDs.
2. Проверить VPS, Docker, PostgreSQL, затем Zabbix server и proxy.
3. Не перезапускать все сервисы одновременно до сбора логов и метрик.
4. При деградации custom portal использовать встроенный Zabbix UI через VPN/SSH.
5. После восстановления оформить timeline, причину, corrective actions и
   обновить alert/runbook.

## Управление шаблонами

- каждый template экспортируется в YAML и хранится в Git;
- изменение проходит review и staging import;
- template содержит owner, назначение, supported models и changelog;
- macros с секретами не хранятся в Git;
- массовое linking выполняется через preview и ограниченный batch;
- rollback — возврат версии template и повторный import, проверенный на staging.

## Обновления

1. Прочитать release notes Zabbix, PostgreSQL и custom services.
2. Сделать backup и успешно восстановить его на staging.
3. Прогнать contract tests Zabbix gateway и smoke tests wizard/dashboard.
4. Обновить staging, выдержать наблюдение минимум один рабочий день.
5. Назначить maintenance window и подготовить rollback.
6. Обновить production, проверить queue, unsupported items, events и workers.

## Самомониторинг

Платформа должна мониторить саму себя отдельным путём: внешний HTTP probe,
уведомление о пропавшем heartbeat, проверка backup age и disk forecast. Только
внутренний Zabbix trigger недостаточен: при полном отказе Zabbix он не отправит
собственное оповещение.
