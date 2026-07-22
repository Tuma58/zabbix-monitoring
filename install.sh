#!/usr/bin/env bash
# Установщик базового контура NetMon (PostgreSQL + Zabbix + API + dashboard).
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="${SCRIPT_DIR}/.env"
readonly COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"

log() {
  printf '[netmon] %s\n' "$*"
}

fail() {
  printf '[netmon] ОШИБКА: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Запустите от root: sudo ${SCRIPT_DIR}/install.sh"
  fi
}

check_platform() {
  [[ -r /etc/os-release ]] || fail "Не удалось определить операционную систему"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "Поддерживается только Ubuntu 22.04 или 24.04"
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) fail "Неподдерживаемая версия Ubuntu ${VERSION_ID:-unknown}; используйте 22.04 или 24.04" ;;
  esac
  case "$(dpkg --print-architecture)" in
    amd64|arm64) ;;
    *) fail "Поддерживаемые архитектуры: amd64 и arm64" ;;
  esac
}

detect_public_ip() {
  local ip=""
  ip="$(curl -fsS --connect-timeout 3 https://ifconfig.me/ip 2>/dev/null || true)"
  if [[ -z "${ip}" ]]; then
    ip="$(curl -fsS --connect-timeout 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [[ -z "${ip}" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "${ip:-SERVER_IP}"
}

# Локальный / VPN IP для доступа (Tailscale и т.п.). По умолчанию 100.10.10.66.
detect_local_access_ip() {
  local configured="${LOCAL_ACCESS_IP:-}"
  if [[ -n "${configured}" ]]; then
    printf '%s' "${configured}"
    return
  fi
  if [[ -f "${ENV_FILE}" ]] && grep -q '^LOCAL_ACCESS_IP=' "${ENV_FILE}"; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    if [[ -n "${LOCAL_ACCESS_IP:-}" ]]; then
      printf '%s' "${LOCAL_ACCESS_IP}"
      return
    fi
  fi
  # Предпочитаем адрес из подсети 100.x (Tailscale/CGNAT), иначе первый non-loopback.
  local candidate
  candidate="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^100\.' | head -n1 || true)"
  if [[ -z "${candidate}" ]]; then
    candidate="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "${candidate:-100.10.10.66}"
}

# Собирает IP для SAN сертификата: local, public, все адреса хоста, loopback.
collect_tls_san_ips() {
  local local_ip public_ip
  local_ip="$(detect_local_access_ip)"
  public_ip="$(detect_public_ip)"

  local -a ips=()
  local ip
  for ip in "${local_ip}" "${public_ip}" 127.0.0.1; do
    if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      ips+=("${ip}")
    fi
  done
  while read -r ip; do
    if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      ips+=("${ip}")
    fi
  done < <(hostname -I 2>/dev/null | tr ' ' '\n' || true)

  printf '%s\n' "${ips[@]}" | awk 'NF && !seen[$0]++'
}

ensure_tls_certificates() {
  local cert_dir="${SCRIPT_DIR}/certs"
  local cert_file="${cert_dir}/netmon.crt"
  local key_file="${cert_dir}/netmon.key"
  local local_ip public_ip
  local_ip="$(detect_local_access_ip)"
  public_ip="$(detect_public_ip)"

  mkdir -p "${cert_dir}"
  chmod 700 "${cert_dir}"

  local need_generate=0
  if [[ ! -f "${cert_file}" || ! -f "${key_file}" ]]; then
    need_generate=1
  else
    # Пересоздаём, если в SAN нет локального IP доступа.
    if ! openssl x509 -in "${cert_file}" -noout -text 2>/dev/null \
      | grep -Eq "IP Address:${local_ip}([^0-9]|$)"; then
      need_generate=1
      log "Сертификат без SAN для ${local_ip} — будет пересоздан"
    fi
  fi

  if (( need_generate == 0 )); then
    log "TLS-сертификат уже есть: ${cert_file}"
    return
  fi

  command -v openssl >/dev/null 2>&1 || fail "openssl не найден (нужен для TLS-сертификата)"

  local san_entries="" san_line ip
  while read -r ip; do
    [[ -n "${ip}" ]] || continue
    if [[ -n "${san_entries}" ]]; then
      san_entries+=","
    fi
    san_entries+="IP:${ip}"
  done < <(collect_tls_san_ips)
  san_entries+=",DNS:localhost,DNS:netmon.local"

  local openssl_cfg
  openssl_cfg="$(mktemp)"
  cat > "${openssl_cfg}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = NetMon
O = NetMon
OU = Self-Signed IP TLS

[v3_req]
subjectAltName = ${san_entries}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF

  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "${key_file}" \
    -out "${cert_file}" \
    -config "${openssl_cfg}" >/dev/null 2>&1 \
    || fail "Не удалось создать TLS-сертификат"
  rm -f "${openssl_cfg}"

  chmod 600 "${key_file}"
  chmod 644 "${cert_file}"
  log "Создан самоподписанный TLS-сертификат (SAN: ${local_ip}, ${public_ip}, …)"
  log "  ${cert_file}"
}


install_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    log "Установка Docker Engine из официального репозитория Docker"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl openssl iptables
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    # shellcheck disable=SC1091
    source /etc/os-release
    local architecture
    architecture="$(dpkg --print-architecture)"
    printf '%s\n' \
      'Types: deb' \
      'URIs: https://download.docker.com/linux/ubuntu' \
      "Suites: ${UBUNTU_CODENAME:-${VERSION_CODENAME}}" \
      'Components: stable' \
      "Architectures: ${architecture}" \
      'Signed-By: /etc/apt/keyrings/docker.asc' \
      > /etc/apt/sources.list.d/docker.sources

    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
  else
    log "Docker Engine и плагин Compose уже установлены"
  fi

  prefer_iptables_legacy
  ensure_docker_daemon
}

prefer_iptables_legacy() {
  # Смешение nft/legacy iptables ломает Docker bridge forwarding и создание сетей
  # (ошибки вида "DOCKER-FORWARD ... No chain/target/match by that name").
  local changed=0
  if [[ -x /usr/sbin/iptables-legacy ]]; then
    local current
    current="$(readlink -f "$(command -v iptables)" 2>/dev/null || true)"
    if [[ "${current}" != "/usr/sbin/iptables-legacy" ]]; then
      update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 && changed=1 || true
    fi
  fi
  if [[ -x /usr/sbin/ip6tables-legacy ]]; then
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
  fi

  # Если переключили backend, а Docker уже работает под systemd — перезапускаем,
  # чтобы daemon пересоздал свои цепочки iptables.
  if (( changed )) && command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    log "iptables переключён на legacy; перезапуск Docker для пересоздания цепочек"
    systemctl restart docker || true
    sleep 2
  fi
}

ensure_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  log "Запуск Docker daemon"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable --now docker || true
  fi

  if ! docker info >/dev/null 2>&1; then
    # Среды без systemd (часть CI/cloud-агентов): запускаем dockerd напрямую.
    mkdir -p /var/run /var/log
    # На вложенном overlay нельзя использовать storage-driver=overlay.
    if [[ ! -f /etc/docker/daemon.json ]] && findmnt -no FSTYPE /var/lib 2>/dev/null | grep -qi overlay; then
      mkdir -p /etc/docker
      printf '{\n  "storage-driver": "vfs"\n}\n' > /etc/docker/daemon.json
      log "Обнаружена вложенная overlay FS; настроен Docker storage-driver=vfs"
    fi
    if ! pgrep -x dockerd >/dev/null 2>&1; then
      dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
    fi
  fi

  local attempts=0
  while (( attempts < 30 )); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon готов"
      return
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  fail "Docker daemon не стал готовым; смотрите /var/log/dockerd.log"
}

random_secret() {
  openssl rand -hex 32
}

compose() {
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

# Дозаполняет обязательные переменные в уже существующем .env (старые установки).
ensure_required_env_vars() {
  [[ -f "${ENV_FILE}" ]] || return 0

  ensure_env_default() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "${ENV_FILE}"; then
      # Пустое значение тоже считаем отсутствующим.
      if grep -q "^${key}=$" "${ENV_FILE}" || grep -q "^${key}=[[:space:]]*$" "${ENV_FILE}"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
        log "Обновлена пустая переменная ${key}"
      fi
    else
      printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
      log "Добавлена отсутствующая переменная ${key}"
    fi
  }

  ensure_env_default "JWT_SECRET" "$(random_secret)"
  ensure_env_default "SECRETS_MASTER_KEY" "$(random_secret)"
  ensure_env_default "PORTAL_DB" "netmon"
  ensure_env_default "BOOTSTRAP_ADMIN_EMAIL" "admin@example.com"
  ensure_env_default "BOOTSTRAP_ADMIN_PASSWORD" "ChangeMeNow!"
  ensure_env_default "ZABBIX_ENABLED" "false"
  ensure_env_default "ZABBIX_API_URL" "http://zabbix-web:8080/api_jsonrpc.php"
  ensure_env_default "API_BIND" "0.0.0.0"
  ensure_env_default "API_PORT" "7000"
  ensure_env_default "DASHBOARD_BIND" "0.0.0.0"
  ensure_env_default "DASHBOARD_PORT" "7081"
  ensure_env_default "ZABBIX_WEB_BIND" "0.0.0.0"
  ensure_env_default "ZABBIX_WEB_PORT" "7080"
  ensure_env_default "ZABBIX_SERVER_BIND" "0.0.0.0"
  ensure_env_default "ZABBIX_SERVER_PORT" "10051"
  ensure_env_default "TLS_BIND" "0.0.0.0"
  ensure_env_default "ZABBIX_TLS_PORT" "7443"
  ensure_env_default "DASHBOARD_TLS_PORT" "7444"
  ensure_env_default "API_TLS_PORT" "7445"
  ensure_env_default "LOCAL_ACCESS_IP" "100.10.10.66"
  ensure_env_default "PHP_TZ" "Europe/Moscow"

  # Миграция со старых портов 80xx/8000 на 70xx.
  if grep -q '^ZABBIX_WEB_PORT=8080$' "${ENV_FILE}"; then
    sed -i 's/^ZABBIX_WEB_PORT=8080$/ZABBIX_WEB_PORT=7080/' "${ENV_FILE}"
    log "ZABBIX_WEB_PORT переключён на 7080"
  fi
  if grep -q '^DASHBOARD_PORT=8081$' "${ENV_FILE}"; then
    sed -i 's/^DASHBOARD_PORT=8081$/DASHBOARD_PORT=7081/' "${ENV_FILE}"
    log "DASHBOARD_PORT переключён на 7081"
  fi
  if grep -q '^API_PORT=8000$' "${ENV_FILE}"; then
    sed -i 's/^API_PORT=8000$/API_PORT=7000/' "${ENV_FILE}"
    log "API_PORT переключён на 7000"
  fi
  chmod 600 "${ENV_FILE}"
}

# Веб-интерфейсы по умолчанию слушаются на всех интерфейсах (внешний IP VPS).
ensure_public_web_binds() {
  [[ -f "${ENV_FILE}" ]] || return 0

  local public_ip local_ip dash_port api_port web_port
  local dash_tls api_tls web_tls
  public_ip="$(detect_public_ip)"
  local_ip="$(detect_local_access_ip)"
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  dash_port="${DASHBOARD_PORT:-7081}"
  api_port="${API_PORT:-7000}"
  web_port="${ZABBIX_WEB_PORT:-7080}"
  dash_tls="${DASHBOARD_TLS_PORT:-7444}"
  api_tls="${API_TLS_PORT:-7445}"
  web_tls="${ZABBIX_TLS_PORT:-7443}"

  # Обновляем bind веб-сервисов на 0.0.0.0, если ещё loopback.
  if grep -q '^ZABBIX_WEB_BIND=127.0.0.1$' "${ENV_FILE}"; then
    sed -i 's/^ZABBIX_WEB_BIND=127.0.0.1$/ZABBIX_WEB_BIND=0.0.0.0/' "${ENV_FILE}"
    log "ZABBIX_WEB_BIND переключён на 0.0.0.0 (доступ с внешнего IP)"
  fi
  if grep -q '^DASHBOARD_BIND=127.0.0.1$' "${ENV_FILE}"; then
    sed -i 's/^DASHBOARD_BIND=127.0.0.1$/DASHBOARD_BIND=0.0.0.0/' "${ENV_FILE}"
    log "DASHBOARD_BIND переключён на 0.0.0.0 (доступ с внешнего IP)"
  fi
  if grep -q '^API_BIND=127.0.0.1$' "${ENV_FILE}"; then
    sed -i 's/^API_BIND=127.0.0.1$/API_BIND=0.0.0.0/' "${ENV_FILE}"
    log "API_BIND переключён на 0.0.0.0 (доступ с внешнего IP)"
  fi
  # На случай, если API_BIND вовсе отсутствует (старый .env) — уже добавлен выше,
  # но если был только ZABBIX/DASHBOARD — API мог остаться без строки.
  if ! grep -q '^API_BIND=' "${ENV_FILE}"; then
    printf 'API_BIND=0.0.0.0\n' >> "${ENV_FILE}"
  fi

  # CORS: HTTP + HTTPS, внешний IP + локальный/VPN IP (100.10.10.66).
  local cors_value
  cors_value="$(
    printf '%s,' \
      "http://${public_ip}:${dash_port}" \
      "https://${public_ip}:${dash_tls}" \
      "http://${public_ip}:${web_port}" \
      "https://${public_ip}:${web_tls}" \
      "http://${local_ip}:${dash_port}" \
      "https://${local_ip}:${dash_tls}" \
      "http://${local_ip}:${web_port}" \
      "https://${local_ip}:${web_tls}" \
      "http://127.0.0.1:${dash_port}" \
      "https://127.0.0.1:${dash_tls}" \
      "http://localhost:${dash_port}" \
      "https://localhost:${dash_tls}"
  )"
  cors_value="${cors_value%,}"
  if grep -q '^CORS_ORIGINS=' "${ENV_FILE}"; then
    sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${cors_value}|" "${ENV_FILE}"
  else
    printf 'CORS_ORIGINS=%s\n' "${cors_value}" >> "${ENV_FILE}"
  fi

  # Фиксируем LOCAL_ACCESS_IP, если ещё нет.
  if ! grep -q '^LOCAL_ACCESS_IP=' "${ENV_FILE}"; then
    printf 'LOCAL_ACCESS_IP=%s\n' "${local_ip}" >> "${ENV_FILE}"
  elif grep -q '^LOCAL_ACCESS_IP=$' "${ENV_FILE}"; then
    sed -i "s|^LOCAL_ACCESS_IP=.*|LOCAL_ACCESS_IP=${local_ip}|" "${ENV_FILE}"
  fi

  chmod 600 "${ENV_FILE}"
}

create_environment() {
  if [[ -f "${ENV_FILE}" ]]; then
    log "Сохранён существующий ${ENV_FILE} и его секреты"
    chmod 600 "${ENV_FILE}"
    ensure_required_env_vars
    ensure_public_web_binds
    return
  fi

  local db_password jwt_secret secrets_key public_ip local_ip
  db_password="$(random_secret)"
  jwt_secret="$(random_secret)"
  secrets_key="$(random_secret)"
  public_ip="$(detect_public_ip)"
  local_ip="$(detect_local_access_ip)"

  umask 077
  {
    printf 'ZABBIX_VERSION=alpine-7.0.28\n'
    printf 'POSTGRES_VERSION=16.6-alpine\n'
    printf 'POSTGRES_DB=zabbix\n'
    printf 'PORTAL_DB=netmon\n'
    printf 'POSTGRES_USER=zabbix\n'
    printf 'POSTGRES_PASSWORD=%s\n' "${db_password}"
    printf 'JWT_SECRET=%s\n' "${jwt_secret}"
    printf 'SECRETS_MASTER_KEY=%s\n' "${secrets_key}"
    printf 'BOOTSTRAP_ADMIN_EMAIL=%s\n' "${BOOTSTRAP_ADMIN_EMAIL:-admin@example.com}"
    printf 'BOOTSTRAP_ADMIN_PASSWORD=%s\n' "${BOOTSTRAP_ADMIN_PASSWORD:-ChangeMeNow!}"
    printf 'ZABBIX_ENABLED=%s\n' "${ZABBIX_ENABLED:-false}"
    printf 'ZABBIX_API_URL=%s\n' "${ZABBIX_API_URL:-http://zabbix-web:8080/api_jsonrpc.php}"
    printf 'ZABBIX_API_USER=%s\n' "${ZABBIX_API_USER:-}"
    printf 'ZABBIX_API_PASSWORD=%s\n' "${ZABBIX_API_PASSWORD:-}"
    printf 'PHP_TZ=%s\n' "${PHP_TZ:-Europe/Moscow}"
    # Веб-интерфейсы сразу доступны по внешнему IP VPS.
    printf 'ZABBIX_WEB_BIND=%s\n' "${ZABBIX_WEB_BIND:-0.0.0.0}"
    printf 'ZABBIX_WEB_PORT=%s\n' "${ZABBIX_WEB_PORT:-7080}"
    # Trapper по умолчанию тоже на всех интерфейсах — для agent/proxy.
    printf 'ZABBIX_SERVER_BIND=%s\n' "${ZABBIX_SERVER_BIND:-0.0.0.0}"
    printf 'ZABBIX_SERVER_PORT=%s\n' "${ZABBIX_SERVER_PORT:-10051}"
    printf 'DASHBOARD_BIND=%s\n' "${DASHBOARD_BIND:-0.0.0.0}"
    printf 'DASHBOARD_PORT=%s\n' "${DASHBOARD_PORT:-7081}"
    printf 'API_BIND=%s\n' "${API_BIND:-0.0.0.0}"
    printf 'API_PORT=%s\n' "${API_PORT:-7000}"
    # HTTPS edge (самоподписанный сертификат с SAN по IP).
    printf 'TLS_BIND=%s\n' "${TLS_BIND:-0.0.0.0}"
    printf 'ZABBIX_TLS_PORT=%s\n' "${ZABBIX_TLS_PORT:-7443}"
    printf 'DASHBOARD_TLS_PORT=%s\n' "${DASHBOARD_TLS_PORT:-7444}"
    printf 'API_TLS_PORT=%s\n' "${API_TLS_PORT:-7445}"
    # Локальный/VPN IP (Tailscale и т.п.) для HTTP/HTTPS и CORS.
    printf 'LOCAL_ACCESS_IP=%s\n' "${LOCAL_ACCESS_IP:-${local_ip}}"
    printf 'CORS_ORIGINS=%s\n' "${CORS_ORIGINS:-http://${public_ip}:7081,https://${public_ip}:7444,http://${local_ip}:7081,https://${local_ip}:7444,http://127.0.0.1:7081,http://localhost:7081}"
    printf 'PROBE_NETWORK_ALLOWLIST=%s\n' "${PROBE_NETWORK_ALLOWLIST:-10.0.0.0/8,100.64.0.0/10,172.16.0.0/12,192.168.0.0/16}"
    printf 'ZBX_CACHESIZE=128M\n'
    printf 'ZBX_HISTORYCACHESIZE=64M\n'
    printf 'ZBX_TRENDCACHESIZE=32M\n'
    printf 'ZBX_VALUECACHESIZE=128M\n'
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Создан ${ENV_FILE} со случайными секретами БД и API"
  log "Веб-интерфейсы будут слушать 0.0.0.0 (доступ по внешнему и локальному IP)"
}

ensure_portal_database() {
  local postgres_id portal_db
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  portal_db="${PORTAL_DB:-netmon}"
  postgres_id="$(compose ps -q postgres)"
  [[ -n "${postgres_id}" ]] || fail "Контейнер PostgreSQL не запущен"
  # Безопасно для томов, созданных до поддержки БД портала.
  if docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -e PGUSER="${POSTGRES_USER:-zabbix}" \
    "${postgres_id}" \
    psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${portal_db}'" | grep -q 1; then
    log "БД портала ${portal_db} уже существует"
  else
    log "Создание БД портала ${portal_db}"
    docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -e PGUSER="${POSTGRES_USER:-zabbix}" \
      "${postgres_id}" \
      psql -d postgres -c "CREATE DATABASE ${portal_db}"
  fi
}

start_stack() {
  [[ -f "${COMPOSE_FILE}" ]] || fail "Не найден ${COMPOSE_FILE}; разместите полный репозиторий"
  log "Проверка конфигурации Docker Compose"
  compose config --quiet

  log "Сборка образа API и запуск стека мониторинга"
  # Тянем только публикуемые образы; netmon-api собирается локально.
  compose pull postgres zabbix-server zabbix-web dashboard || true
  if ! compose build api; then
    log "BuildKit не удался; повторная сборка API legacy-сборщиком"
    DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 compose build api \
      || fail "Не удалось собрать образ API"
  fi
  compose up -d postgres
  wait_for_postgres
  ensure_portal_database
  if ! compose up -d --remove-orphans; then
    log "Сбой запуска (остаточные контейнеры/сеть Docker); полная очистка и повтор"
    cleanup_stale_stack
    compose up -d postgres
    wait_for_postgres
    ensure_portal_database
    compose up -d --remove-orphans \
      || fail "Не удалось запустить стек; смотрите: docker compose logs"
  fi
}

# Удаляет остаточные контейнеры и сети от прежних запусков (в т.ч. старую
# сеть netmon_backend с подчёркиванием), сохраняя тома с данными.
cleanup_stale_stack() {
  log "Очистка остаточных контейнеров и сетей NetMon (тома сохраняются)"
  compose down --remove-orphans >/dev/null 2>&1 || true

  # Принудительно удаляем любые контейнеры проекта netmon.
  local stale
  stale="$(docker ps -aq --filter 'name=netmon-' 2>/dev/null || true)"
  if [[ -n "${stale}" ]]; then
    docker rm -f ${stale} >/dev/null 2>&1 || true
  fi

  # Сносим возможные старые/битые сети (текущая netmon-backend пересоздастся).
  docker network rm netmon_backend netmon-backend netmon-monitoring netmon_monitoring >/dev/null 2>&1 || true

  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl restart docker || true
    sleep 3
  fi
}

wait_for_postgres() {
  local attempts=0
  local postgres_id
  local postgres_status=""

  postgres_id="$(compose ps -q postgres)"
  [[ -n "${postgres_id}" ]] || fail "Контейнер PostgreSQL не был создан"

  while (( attempts < 30 )); do
    postgres_status="$(docker inspect --format '{{.State.Health.Status}}' "${postgres_id}" 2>/dev/null || true)"
    if [[ "${postgres_status}" == "healthy" ]]; then
      log "PostgreSQL готов (healthy)"
      return
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  fail "PostgreSQL не стал healthy; смотрите: docker compose logs postgres"
}

wait_for_services() {
  local attempts=0
  local api_id api_status=""

  wait_for_postgres

  api_id="$(compose ps -q api)"
  if [[ -n "${api_id}" ]]; then
    while (( attempts < 45 )); do
      api_status="$(docker inspect --format '{{.State.Health.Status}}' "${api_id}" 2>/dev/null || true)"
      if [[ "${api_status}" == "healthy" ]]; then
        log "Custom API готов (healthy)"
        break
      fi
      attempts=$((attempts + 1))
      sleep 2
    done
    [[ "${api_status:-}" == "healthy" ]] || log "ПРЕДУПРЕЖДЕНИЕ: API ещё не healthy; проверьте: docker compose logs api"
  fi
}

print_next_steps() {
  # shellcheck disable=SC1090
  source "${ENV_FILE}"

  local public_ip local_ip host_label
  local zabbix_url dashboard_url api_url
  local zabbix_https dashboard_https api_https
  local zabbix_local dashboard_local api_local
  local zabbix_local_https dashboard_local_https api_local_https
  public_ip="$(detect_public_ip)"
  local_ip="${LOCAL_ACCESS_IP:-$(detect_local_access_ip)}"
  if [[ "${ZABBIX_WEB_BIND:-0.0.0.0}" == "127.0.0.1" ]]; then
    host_label="127.0.0.1"
  else
    host_label="${public_ip}"
  fi

  zabbix_url="http://${host_label}:${ZABBIX_WEB_PORT:-7080}"
  dashboard_url="http://${host_label}:${DASHBOARD_PORT:-7081}"
  api_url="http://${host_label}:${API_PORT:-7000}/api/v1"
  zabbix_https="https://${host_label}:${ZABBIX_TLS_PORT:-7443}"
  dashboard_https="https://${host_label}:${DASHBOARD_TLS_PORT:-7444}"
  api_https="https://${host_label}:${API_TLS_PORT:-7445}/api/v1"
  zabbix_local="http://${local_ip}:${ZABBIX_WEB_PORT:-7080}"
  dashboard_local="http://${local_ip}:${DASHBOARD_PORT:-7081}"
  api_local="http://${local_ip}:${API_PORT:-7000}/api/v1"
  zabbix_local_https="https://${local_ip}:${ZABBIX_TLS_PORT:-7443}"
  dashboard_local_https="https://${local_ip}:${DASHBOARD_TLS_PORT:-7444}"
  api_local_https="https://${local_ip}:${API_TLS_PORT:-7445}/api/v1"

  printf '\n'
  log "============================================================"
  log " Установка завершена"
  log "============================================================"
  printf '\n'
  log "Статус сервисов:"
  compose ps
  printf '\n'
  log "HTTPS по IP (самоподписанный сертификат — примите в браузере):"
  log "  Zabbix UI:     ${zabbix_https}"
  log "  Dashboard:     ${dashboard_https}"
  log "  API docs:      ${api_https}/docs"
  log "  Сертификат:    ${SCRIPT_DIR}/certs/netmon.crt"
  printf '\n'
  log "HTTP (внешний IP):"
  log "  Zabbix UI:     ${zabbix_url}"
  log "  Dashboard:     ${dashboard_url}"
  log "  API docs:      ${api_url}/docs"
  log "  Внешний IP:    ${public_ip}"
  printf '\n'
  log "Локальный / VPN доступ (${local_ip}):"
  log "  Zabbix HTTP:   ${zabbix_local}"
  log "  Dashboard HTTP:${dashboard_local}"
  log "  API HTTP:      ${api_local}/docs"
  log "  Zabbix HTTPS:  ${zabbix_local_https}"
  log "  Dashboard HTTPS:${dashboard_local_https}"
  log "  API HTTPS:     ${api_local_https}/docs"
  printf '\n'
  log "------------------------------------------------------------"
  log " Секреты (сохраните и очистите историю терминала)"
  log "------------------------------------------------------------"
  log "  Файл .env:                 ${ENV_FILE} (права 0600)"
  log "  Пользователь PostgreSQL:   ${POSTGRES_USER:-zabbix}"
  log "  Пароль PostgreSQL:         ${POSTGRES_PASSWORD}"
  log "  БД Zabbix:                 ${POSTGRES_DB:-zabbix}"
  log "  БД портала:                ${PORTAL_DB:-netmon}"
  log "  Email админа портала:      ${BOOTSTRAP_ADMIN_EMAIL:-admin@example.com}"
  log "  Пароль админа портала:     ${BOOTSTRAP_ADMIN_PASSWORD}"
  log "  JWT secret:                ${JWT_SECRET}"
  log "  Secrets master key:        ${SECRETS_MASTER_KEY}"
  log "  Логин Zabbix UI:           Admin"
  log "  Пароль Zabbix UI:          zabbix   (смените сразу после входа)"
  printf '\n'
  log "Сетевые привязки:"
  log "  Zabbix web HTTP:  ${ZABBIX_WEB_BIND:-0.0.0.0}:${ZABBIX_WEB_PORT:-7080}"
  log "  Dashboard HTTP:   ${DASHBOARD_BIND:-0.0.0.0}:${DASHBOARD_PORT:-7081}"
  log "  API HTTP:         ${API_BIND:-0.0.0.0}:${API_PORT:-7000}"
  log "  Zabbix HTTPS:     ${TLS_BIND:-0.0.0.0}:${ZABBIX_TLS_PORT:-7443}"
  log "  Dashboard HTTPS:  ${TLS_BIND:-0.0.0.0}:${DASHBOARD_TLS_PORT:-7444}"
  log "  API HTTPS:        ${TLS_BIND:-0.0.0.0}:${API_TLS_PORT:-7445}"
  log "  Trapper:          ${ZABBIX_SERVER_BIND:-0.0.0.0}:${ZABBIX_SERVER_PORT:-10051}"
  printf '\n'
  log "Полезные команды:"
  log "  cd ${SCRIPT_DIR}"
  log "  docker compose --env-file .env ps"
  log "  docker compose --env-file .env logs -f api"
  log "  curl -fsS ${api_url}/health/live"
  log "  curl -kfsS ${api_https}/health/live"
  printf '\n'
  log "Рекомендация по firewall: ограничьте 10051/TCP сетями agent/proxy."
  log "Далее: ${SCRIPT_DIR}/docs/DEPLOYMENT.md"
  log "============================================================"
  printf '\n'
}

main() {
  require_root
  check_platform
  install_docker
  create_environment
  ensure_tls_certificates
  start_stack
  wait_for_services
  print_next_steps
}

main "$@"
