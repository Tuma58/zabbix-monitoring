# Установка и развёртывание

## Что устанавливает bootstrap

Текущий `install.sh` устанавливает Docker Engine/Compose plugin и запускает
PostgreSQL, Zabbix server, Zabbix web, custom API (`/api/v1`) и dashboard.
Образы PostgreSQL/Zabbix/nginx закреплены digest-ами в `compose.yaml`. Порт
`10051` по умолчанию bind-ится на `127.0.0.1`. Dashboard проксирует `/api/` на
сервис API.

Поддерживаемая платформа:

- чистая Ubuntu Server 22.04 или 24.04;
- `amd64` или `arm64`;
- минимум 2 vCPU, 4 GB RAM и 40 GB SSD для лаборатории;
- рекомендуется 4 vCPU, 8 GB RAM и 100 GB SSD для пилота;
- исходящий HTTPS для Docker repository и registry.

## Подготовка сети

- `22/TCP`: SSH, только из административной сети;
- `10051/TCP`: active agents и Zabbix proxies, только из разрешённых подсетей
  (bootstrap по умолчанию публикует trapper на `0.0.0.0` — ограничьте firewall/
  security group сетями agent/proxy);
- `443/TCP`: custom portal после добавления Caddy;
- `7080/TCP`: Zabbix UI, по умолчанию доступен с внешнего IP (`0.0.0.0`);
- `7081/TCP`: dashboard, по умолчанию доступен с внешнего IP;
- `7000/TCP`: custom API docs/health, по умолчанию доступен с внешнего IP;
- от VPS/proxy к устройствам: ICMP, `10050/TCP`, `161/UDP`, при необходимости
  `623/UDP` IPMI и vendor API ports.

## Сеть Compose

Сервисы общаются в сети `netmon-backend`. Веб-порты UI/API по умолчанию
публикуются на `0.0.0.0` (внешний IP VPS). При необходимости верните loopback
через `ZABBIX_WEB_BIND` / `DASHBOARD_BIND` / `API_BIND=127.0.0.1` в `.env`.
Trapper (`10051`) тоже на `0.0.0.0` — ограничьте его firewall allowlist-ом.

## Однокомандная установка

Для чистого Ubuntu 22.04/24.04 VPS (повторный запуск безопасен, если
`/opt/netmon` уже существует):

```bash
sudo apt-get update && sudo apt-get install -y git && \
sudo mkdir -p /opt/netmon && \
if [ -d /opt/netmon/.git ]; then
  sudo git -C /opt/netmon fetch --prune origin &&
  sudo git -C /opt/netmon checkout zabbix-monitoring &&
  sudo git -C /opt/netmon pull --ff-only origin zabbix-monitoring
else
  sudo rm -rf /opt/netmon &&
  sudo git clone -b zabbix-monitoring https://github.com/Tuma58/zabbix-monitoring.git /opt/netmon
fi && \
sudo /opt/netmon/install.sh
```

Если репозиторий уже на месте и нужно только поднять/обновить стек:

```bash
cd /opt/netmon && sudo git pull --ff-only && sudo ./install.sh
```

Для установки конкретной feature-ветки:

```bash
sudo git -C /opt/netmon fetch origin && \
sudo git -C /opt/netmon checkout cursor/stage1-platform-foundation-6c05 && \
sudo git -C /opt/netmon pull --ff-only && \
sudo /opt/netmon/install.sh
```

Скрипт идемпотентен для повторного запуска: существующий `.env` и пароль БД не
перезаписываются, Compose приводит сервисы к описанному состоянию.

Допустимые параметры задаются environment variables:

```bash
sudo PHP_TZ=Europe/Moscow ZABBIX_WEB_BIND=0.0.0.0 ZABBIX_WEB_PORT=7080 /opt/netmon/install.sh
```

## Что делает скрипт

1. Проверяет root, ОС и архитектуру.
2. Если Docker/Compose отсутствуют, подключает официальный Docker apt repository
   и устанавливает Engine, Buildx и Compose plugin.
3. Создаёт `.env` с правами `0600`, случайным паролем PostgreSQL и секретами API.
4. Проверяет `docker compose config`.
5. Собирает образ API, загружает pinned images, создаёт БД портала `netmon`,
   запускает сервисы и ожидает healthy PostgreSQL/API.
6. Показывает состояние сервисов и безопасный способ открыть UI/API.

## Первый вход

При loopback bind выполните на рабочем компьютере:

```bash
ssh -L 7080:127.0.0.1:7080 user@VPS_IP
```

Откройте `http://127.0.0.1:7080`, войдите как `Admin` / `zabbix` и немедленно:

1. смените пароль;
2. создайте отдельного администратора;
3. задайте корректный timezone;
4. создайте API service account для будущего custom backend;
5. ограничьте доступ к встроенному Zabbix UI VPN/SSH-туннелем.

Для просмотра кастомного dashboard и API откройте туннели:

```bash
ssh -L 7081:127.0.0.1:7081 -L 7000:127.0.0.1:7000 user@VPS_IP
```

- Dashboard: `http://127.0.0.1:7081` (проксирует `/api/` на custom API)
- OpenAPI UI: `http://127.0.0.1:7000/api/v1/docs`
- Portal login: значения `BOOTSTRAP_ADMIN_*` из `.env`

## Проверка

На VPS:

```bash
cd /opt/netmon
sudo docker compose ps
sudo docker compose logs --tail=100 zabbix-server
curl -I http://127.0.0.1:7080
curl -fsS http://127.0.0.1:7000/api/v1/health/live
curl -fsS http://127.0.0.1:7081/api/v1/health/live
```

Ожидается: PostgreSQL/API `healthy`, Zabbix server/web — `Up`, HTTP-ответ от
web и `{"status":"ok"}` от API.

## Production hardening перед вводом

- образы уже закреплены digest-ами; обновляйте их осознанно после staging;
- установить Caddy и сертификат для custom portal;
- хранить master encryption key вне Compose `.env`;
- закрыть `10051/TCP` allowlist-ом (не публиковать на `0.0.0.0` без необходимости);
- подключить внешнее backup-хранилище;
- включить NTP, системный мониторинг VPS и оповещение о неуспешном backup;
- настроить retention history/trends по фактическому NVPS;
- провести recovery drill на отдельном сервере;
- удалить/заблокировать стандартную учётную запись после создания именных;
- сменить `BOOTSTRAP_ADMIN_PASSWORD` и отключить demo auto-login в UI.

## Обновление базового контура

Не меняйте major/minor Zabbix без чтения release notes и тестового
восстановления. Для обновления внутри выбранной линии:

```bash
cd /opt/netmon
sudo docker compose pull
sudo docker compose up -d
sudo docker compose logs --tail=200 zabbix-server
```

Перед обновлением обязателен backup. Для перехода между minor/major сначала
поднимите копию БД на staging и прогоните smoke/integration tests custom API.
После смены digest-ов в `compose.yaml` выполните `docker compose build api && docker compose up -d`.

## Удаление

Остановка без удаления данных:

```bash
cd /opt/netmon
sudo docker compose down
```

Удаление volume с PostgreSQL необратимо и поэтому намеренно не включено в
установщик или обычный runbook.

## Ссылки

- [официальная установка Docker Engine на Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [официальная установка Zabbix из контейнеров](https://www.zabbix.com/documentation/7.0/en/manual/installation/containers)
- [официальные теги Zabbix server PostgreSQL](https://hub.docker.com/r/zabbix/zabbix-server-pgsql/tags/)
- [документация Zabbix frontend](https://www.zabbix.com/documentation/7.0/en/manual/installation/frontend)
