#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="${SCRIPT_DIR}/.env"
readonly COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"

log() {
  printf '[netmon] %s\n' "$*"
}

fail() {
  printf '[netmon] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Run as root: sudo ${SCRIPT_DIR}/install.sh"
  fi
}

check_platform() {
  [[ -r /etc/os-release ]] || fail "Cannot detect the operating system"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "Supported OS: Ubuntu 22.04 or 24.04"
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) fail "Unsupported Ubuntu version ${VERSION_ID:-unknown}; use 22.04 or 24.04" ;;
  esac
  case "$(dpkg --print-architecture)" in
    amd64|arm64) ;;
    *) fail "Supported architectures: amd64 and arm64" ;;
  esac
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Engine and Compose plugin are already installed"
    return
  fi

  log "Installing Docker Engine from the official Docker repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl openssl
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
  systemctl enable --now docker
}

random_secret() {
  openssl rand -hex 32
}

compose() {
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

create_environment() {
  if [[ -f "${ENV_FILE}" ]]; then
    log "Keeping existing ${ENV_FILE} and its secrets"
    chmod 600 "${ENV_FILE}"
    return
  fi

  local db_password jwt_secret secrets_key
  db_password="$(random_secret)"
  jwt_secret="$(random_secret)"
  secrets_key="$(random_secret)"

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
    printf 'BOOTSTRAP_ADMIN_EMAIL=%s\n' "${BOOTSTRAP_ADMIN_EMAIL:-admin@netmon.local}"
    printf 'BOOTSTRAP_ADMIN_PASSWORD=%s\n' "${BOOTSTRAP_ADMIN_PASSWORD:-ChangeMeNow!}"
    printf 'ZABBIX_ENABLED=%s\n' "${ZABBIX_ENABLED:-false}"
    printf 'ZABBIX_API_URL=%s\n' "${ZABBIX_API_URL:-http://zabbix-web:8080/api_jsonrpc.php}"
    printf 'ZABBIX_API_USER=%s\n' "${ZABBIX_API_USER:-}"
    printf 'ZABBIX_API_PASSWORD=%s\n' "${ZABBIX_API_PASSWORD:-}"
    printf 'PHP_TZ=%s\n' "${PHP_TZ:-Europe/Moscow}"
    printf 'ZABBIX_WEB_BIND=%s\n' "${ZABBIX_WEB_BIND:-127.0.0.1}"
    printf 'ZABBIX_WEB_PORT=%s\n' "${ZABBIX_WEB_PORT:-8080}"
    printf 'ZABBIX_SERVER_BIND=%s\n' "${ZABBIX_SERVER_BIND:-127.0.0.1}"
    printf 'ZABBIX_SERVER_PORT=%s\n' "${ZABBIX_SERVER_PORT:-10051}"
    printf 'DASHBOARD_BIND=%s\n' "${DASHBOARD_BIND:-127.0.0.1}"
    printf 'DASHBOARD_PORT=%s\n' "${DASHBOARD_PORT:-8081}"
    printf 'API_BIND=%s\n' "${API_BIND:-127.0.0.1}"
    printf 'API_PORT=%s\n' "${API_PORT:-8000}"
    printf 'CORS_ORIGINS=%s\n' "${CORS_ORIGINS:-http://127.0.0.1:8081,http://localhost:8081}"
    printf 'PROBE_NETWORK_ALLOWLIST=%s\n' "${PROBE_NETWORK_ALLOWLIST:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
    printf 'ZBX_CACHESIZE=128M\n'
    printf 'ZBX_HISTORYCACHESIZE=64M\n'
    printf 'ZBX_TRENDCACHESIZE=32M\n'
    printf 'ZBX_VALUECACHESIZE=128M\n'
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Created ${ENV_FILE} with random database and API secrets"
}

ensure_portal_database() {
  local postgres_id portal_db
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  portal_db="${PORTAL_DB:-netmon}"
  postgres_id="$(compose ps -q postgres)"
  [[ -n "${postgres_id}" ]] || fail "PostgreSQL container is not running"
  # Safe for existing volumes created before portal DB support.
  if docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -e PGUSER="${POSTGRES_USER:-zabbix}" \
    "${postgres_id}" \
    psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${portal_db}'" | grep -q 1; then
    log "Portal database ${portal_db} already exists"
  else
    log "Creating portal database ${portal_db}"
    docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -e PGUSER="${POSTGRES_USER:-zabbix}" \
      "${postgres_id}" \
      psql -d postgres -c "CREATE DATABASE ${portal_db}"
  fi
}

start_stack() {
  [[ -f "${COMPOSE_FILE}" ]] || fail "Missing ${COMPOSE_FILE}; deploy the complete repository"
  log "Validating Docker Compose configuration"
  compose config --quiet

  log "Building API image and starting the monitoring stack"
  compose pull || true
  compose build api
  compose up -d postgres
  wait_for_postgres
  ensure_portal_database
  compose up -d --remove-orphans
}

wait_for_postgres() {
  local attempts=0
  local postgres_id
  local postgres_status=""

  postgres_id="$(compose ps -q postgres)"
  [[ -n "${postgres_id}" ]] || fail "PostgreSQL container was not created"

  while (( attempts < 30 )); do
    postgres_status="$(docker inspect --format '{{.State.Health.Status}}' "${postgres_id}" 2>/dev/null || true)"
    if [[ "${postgres_status}" == "healthy" ]]; then
      log "PostgreSQL is healthy"
      return
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  fail "PostgreSQL did not become healthy; inspect docker compose logs"
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
        log "Custom API is healthy"
        break
      fi
      attempts=$((attempts + 1))
      sleep 2
    done
    [[ "${api_status:-}" == "healthy" ]] || log "WARNING: API is not healthy yet; check: docker compose logs api"
  fi

  compose ps
}

print_next_steps() {
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  log "Installation completed"
  if [[ "${ZABBIX_WEB_BIND}" == "127.0.0.1" ]]; then
    log "Zabbix UI is local-only. Use: ssh -L ${ZABBIX_WEB_PORT}:127.0.0.1:${ZABBIX_WEB_PORT} user@VPS_IP"
  else
    log "Zabbix UI: http://SERVER_IP:${ZABBIX_WEB_PORT} (configure firewall and TLS before production)"
  fi
  if [[ "${DASHBOARD_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    log "Dashboard: ssh -L ${DASHBOARD_PORT:-8081}:127.0.0.1:${DASHBOARD_PORT:-8081} user@VPS_IP"
  else
    log "Dashboard: http://SERVER_IP:${DASHBOARD_PORT:-8081}"
  fi
  if [[ "${API_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    log "API docs: ssh -L ${API_PORT:-8000}:127.0.0.1:${API_PORT:-8000} user@VPS_IP then http://127.0.0.1:${API_PORT:-8000}/api/v1/docs"
  else
    log "API docs: http://SERVER_IP:${API_PORT:-8000}/api/v1/docs"
  fi
  log "Portal login: ${BOOTSTRAP_ADMIN_EMAIL:-admin@netmon.local} / (see BOOTSTRAP_ADMIN_PASSWORD in .env)"
  log "Initial Zabbix login: Admin / zabbix. Change it immediately."
  log "Trapper port ${ZABBIX_SERVER_PORT:-10051} is bound to ${ZABBIX_SERVER_BIND:-127.0.0.1}; open it only for agent/proxy networks."
  log "Next: read ${SCRIPT_DIR}/docs/DEPLOYMENT.md"
}

main() {
  require_root
  check_platform
  install_docker
  create_environment
  start_stack
  wait_for_services
  print_next_steps
}

main "$@"
