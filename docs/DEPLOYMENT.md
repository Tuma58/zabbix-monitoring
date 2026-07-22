# Установка и развёртывание

## Что устанавливает bootstrap

Текущий `install.sh` устанавливает Docker Engine/Compose plugin и запускает
PostgreSQL, Zabbix server, Zabbix web и статический прототип CoreSupport Monitor.
Прототип показывает будущий dashboard и мастер добавления, но пока работает на
демонстрационных данных: custom API будет подключён на следующем этапе.

Поддерживаемая платформа:

- чистая Ubuntu Server 22.04 или 24.04;
- `amd64` или `arm64`;
- минимум 2 vCPU, 4 GB RAM и 40 GB SSD для лаборатории;
- рекомендуется 4 vCPU, 8 GB RAM и 100 GB SSD для пилота;
- исходящий HTTPS для Docker repository и registry.

## Подготовка сети

- `22/TCP`: SSH, только из административной сети;
- `10051/TCP`: active agents и Zabbix proxies, только из разрешённых подсетей;
- `443/TCP`: custom portal после добавления Caddy;
- `8080/TCP`: не публиковать; bootstrap по умолчанию bind-ит его на loopback;
- `8081/TCP`: preview dashboard, также только loopback до подключения TLS;
- от VPS/proxy к устройствам: ICMP, `10050/TCP`, `161/UDP`, при необходимости
  `623/UDP` IPMI и vendor API ports.

Docker может обходить часть привычных UFW-правил при публикации портов. Правила
ограничения `10051/TCP` следует задавать в `DOCKER-USER` chain либо на внешнем
firewall/security group.

## Однокомандная установка

После публикации этого проекта в Git замените `REPOSITORY_URL` на реальный URL.
Для чистого VPS вся операция укладывается в одну shell-команду:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone REPOSITORY_URL /opt/netmon && sudo /opt/netmon/install.sh
```

Если репозиторий уже загружен в `/opt/netmon`:

```bash
sudo /opt/netmon/install.sh
```

Скрипт идемпотентен для повторного запуска: существующий `.env` и пароль БД не
перезаписываются, Compose приводит сервисы к описанному состоянию.

Допустимые параметры задаются environment variables:

```bash
sudo PHP_TZ=Europe/Moscow ZABBIX_WEB_BIND=127.0.0.1 ZABBIX_WEB_PORT=8080 /opt/netmon/install.sh
```

## Что делает скрипт

1. Проверяет root, ОС и архитектуру.
2. Если Docker/Compose отсутствуют, подключает официальный Docker apt repository
   и устанавливает Engine, Buildx и Compose plugin.
3. Создаёт `.env` с правами `0600` и случайным 256-битным паролем PostgreSQL.
4. Проверяет `docker compose config`.
5. Загружает образы, запускает сервисы, dashboard preview и ожидает healthy PostgreSQL.
6. Показывает состояние сервисов и безопасный способ открыть UI.

## Первый вход

При loopback bind выполните на рабочем компьютере:

```bash
ssh -L 8080:127.0.0.1:8080 user@VPS_IP
```

Откройте `http://127.0.0.1:8080`, войдите как `Admin` / `zabbix` и немедленно:

1. смените пароль;
2. создайте отдельного администратора;
3. задайте корректный timezone;
4. создайте API service account для будущего custom backend;
5. ограничьте доступ к встроенному Zabbix UI VPN/SSH-туннелем.

Для просмотра кастомного dashboard откройте второй туннель:

```bash
ssh -L 8081:127.0.0.1:8081 user@VPS_IP
```

Интерфейс будет доступен на `http://127.0.0.1:8081`. Надпись
«Данные демонстрационные» исчезнет после подключения `/api/v1`.

## Проверка

На VPS:

```bash
cd /opt/netmon
sudo docker compose ps
sudo docker compose logs --tail=100 zabbix-server
curl -I http://127.0.0.1:8080
```

Ожидается: PostgreSQL `healthy`, Zabbix server и web — `Up`, HTTP-ответ от web.

## Production hardening перед вводом

- заменить floating `*-latest` на проверенные digest-значения образов;
- установить Caddy и сертификат для custom portal;
- хранить master encryption key вне Compose `.env`;
- закрыть `10051/TCP` allowlist-ом;
- подключить внешнее backup-хранилище;
- включить NTP, системный мониторинг VPS и оповещение о неуспешном backup;
- настроить retention history/trends по фактическому NVPS;
- провести recovery drill на отдельном сервере;
- удалить/заблокировать стандартную учётную запись после создания именных.

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
