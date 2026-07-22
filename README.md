# NetMon — платформа мониторинга

Этот репозиторий содержит backend-платформу для мониторинга сетевого
оборудования, компьютеров, серверов и ИБП. В качестве движка сбора и обработки
метрик выбран Zabbix 7.0 LTS, а поверх него — собственный API и веб-интерфейс.

> Текущий статус: Stage 1 foundation. Подняты PostgreSQL + Zabbix, custom API
> (`/api/v1`) с auth/RBAC, audit, secrets и Zabbix gateway skeleton, а dashboard
> подключается к API через nginx reverse proxy. Полный provisioning и React UI
> ещё впереди.

## Что входит

- [архитектура и границы системы](docs/ARCHITECTURE.md);
- [подробный план backend и этапы разработки](docs/BACKEND_PLAN.md);
- [контракт API](docs/API.md) и сгенерированный [OpenAPI](docs/openapi.json);
- [спецификация dashboard и окна настроек](docs/UI_SPEC.md);
- [`api/`](api/) — FastAPI Stage 1 (auth, inventory stubs, dashboard, gateway);
- [`dashboard/`](dashboard/) — адаптивный UI в фирменном стиле CoreSupport;
- [установка на чистый VPS](docs/DEPLOYMENT.md);
- [эксплуатация, резервное копирование и обновление](docs/OPERATIONS.md);
- `compose.yaml` для PostgreSQL + Zabbix + API + dashboard;
- `install.sh` для установки Docker и запуска контура на Ubuntu 22.04/24.04.

## Быстрый запуск базового контура

На чистом VPS:

```bash
sudo apt-get update && sudo apt-get install -y git && \
sudo mkdir -p /opt/netmon && \
if [ -d /opt/netmon/.git ]; then
  sudo git -C /opt/netmon pull --ff-only
else
  sudo rm -rf /opt/netmon &&
  sudo git clone https://github.com/Tuma58/zabbix-monitoring.git /opt/netmon
fi && \
sudo /opt/netmon/install.sh
```

Если репозиторий уже лежит в `/opt/netmon`:

```bash
cd /opt/netmon && sudo git pull --ff-only && sudo ./install.sh
```

По умолчанию Zabbix UI (`:7080`), dashboard (`:7081`) и API (`:7000`) слушаются
на `0.0.0.0` и доступны по внешнему IP и по локальному/VPN IP
(`LOCAL_ACCESS_IP`, по умолчанию `100.10.10.66`). Дополнительно edge-nginx
отдаёт HTTPS по IP (самоподписанный сертификат с SAN):

- HTTPS Zabbix: `https://IP:7443`
- HTTPS Dashboard: `https://IP:7444`
- HTTPS API: `https://IP:7445`

После установки скрипт печатает точные URL и секреты. Браузер покажет
предупреждение о самоподписанном сертификате — это ожидаемо для TLS по IP.

- Zabbix UI: `http://VPS_IP:7080` или `http://100.10.10.66:7080` (`Admin` / `zabbix`);
- Dashboard: `http://VPS_IP:7081` или `http://100.10.10.66:7081`;
- API docs: `http://VPS_IP:7000/api/v1/docs`.

Учётная запись портала задаётся в `.env`
(`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`).

Порт trapper `10051` тоже публикуется наружу — ограничьте его firewall allowlist-ом
для сетей agent/proxy.

## Локальная разработка API

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL=sqlite+pysqlite:////tmp/netmon.db
export JWT_SECRET=dev-jwt-secret-value-32-chars-min
export SECRETS_MASTER_KEY=dev-master-key-32-bytes-long-key!
python -m scripts.bootstrap
uvicorn app.main:app --reload --port 8000
pytest -q
```

## Основное архитектурное решение

Zabbix остаётся единственным владельцем конфигурации мониторинга, метрик,
триггеров и событий. Кастомный backend не пишет напрямую в таблицы Zabbix, а
работает через JSON-RPC API. Собственная PostgreSQL-схема (`netmon`) хранит
пользователей портала, профили подключения, аудит и состояние фоновых операций.

## Официальные материалы

- [Zabbix 7.0: установка из контейнеров](https://www.zabbix.com/documentation/7.0/en/manual/installation/containers)
- [Zabbix 7.0 API](https://www.zabbix.com/documentation/7.0/en/manual/api)
- [Zabbix: готовые шаблоны](https://www.zabbix.com/documentation/current/en/manual/config/templates_out_of_the_box)
- [Docker Engine: установка на Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
