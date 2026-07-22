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
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    log "Installing Docker Engine from the official Docker repository"
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
    log "Docker Engine and Compose plugin are already installed"
  fi

  prefer_iptables_legacy
  ensure_docker_daemon
}

prefer_iptables_legacy() {
  # Mixed nft/legacy iptables breaks Docker bridge forwarding on some hosts.
  if [[ -x /usr/sbin/iptables-legacy ]]; then
    update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
  fi
  if [[ -x /usr/sbin/ip6tables-legacy ]]; then
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
  fi
}

ensure_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  log "Starting Docker daemon"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable --now docker || true
  fi

  if ! docker info >/dev/null 2>&1; then
    # Environments without systemd (some CI/cloud agents): start dockerd directly.
    mkdir -p /var/run /var/log
    # Nested overlay filesystems cannot use the overlay storage driver.
    if [[ ! -f /etc/docker/daemon.json ]] && findmnt -no FSTYPE /var/lib 2>/dev/null | grep -qi overlay; then
      mkdir -p /etc/docker
      printf '{\n  "storage-driver": "vfs"\n}\n' > /etc/docker/daemon.json
      log "Detected nested overlay FS; configured Docker storage-driver=vfs"
    fi
    if ! pgrep -x dockerd >/dev/null 2>&1; then
      dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
    fi
  fi

  local attempts=0
  while (( attempts < 30 )); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon is ready"
      return
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  fail "Docker daemon did not become ready; see /var/log/dockerd.log"
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
    printf 'BOOTSTRAP_ADMIN_EMAIL=%s\n' "${BOOTSTRAP_ADMIN_EMAIL:-admin@example.com}"
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
  # Pull only published images; netmon-api is built locally.
  compose pull postgres zabbix-server zabbix-web dashboard || true
  if ! compose build api; then
    log "BuildKit failed; retrying API image build with legacy builder"
    DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 compose build api \
      || fail "Failed to build API image"
  fi
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
}

print_next_steps() {
  # shellcheck disable=SC1090
  source "${ENV_FILE}"

  local zabbix_url dashboard_url api_url ssh_hint
  if [[ "${ZABBIX_WEB_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    zabbix_url="http://127.0.0.1:${ZABBIX_WEB_PORT:-8080}"
  else
    zabbix_url="http://SERVER_IP:${ZABBIX_WEB_PORT:-8080}"
  fi
  if [[ "${DASHBOARD_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    dashboard_url="http://127.0.0.1:${DASHBOARD_PORT:-8081}"
  else
    dashboard_url="http://SERVER_IP:${DASHBOARD_PORT:-8081}"
  fi
  if [[ "${API_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    api_url="http://127.0.0.1:${API_PORT:-8000}/api/v1"
  else
    api_url="http://SERVER_IP:${API_PORT:-8000}/api/v1"
  fi
  ssh_hint="ssh -L ${ZABBIX_WEB_PORT:-8080}:127.0.0.1:${ZABBIX_WEB_PORT:-8080} -L ${DASHBOARD_PORT:-8081}:127.0.0.1:${DASHBOARD_PORT:-8081} -L ${API_PORT:-8000}:127.0.0.1:${API_PORT:-8000} user@VPS_IP"

  printf '\n'
  log "============================================================"
  log " Installation completed"
  log "============================================================"
  printf '\n'
  log "Service status:"
  compose ps
  printf '\n'
  log "Access URLs:"
  log "  Zabbix UI:  ${zabbix_url}"
  log "  Dashboard:  ${dashboard_url}"
  log "  API docs:   ${api_url}/docs"
  log "  API live:   ${api_url}/health/live"
  if [[ "${ZABBIX_WEB_BIND:-127.0.0.1}" == "127.0.0.1" \
     || "${DASHBOARD_BIND:-127.0.0.1}" == "127.0.0.1" \
     || "${API_BIND:-127.0.0.1}" == "127.0.0.1" ]]; then
    log "  SSH tunnel (from your laptop):"
    log "    ${ssh_hint}"
  fi
  printf '\n'
  log "------------------------------------------------------------"
  log " Secrets (store securely, then clear the terminal scrollback)"
  log "------------------------------------------------------------"
  log "  .env file:              ${ENV_FILE} (mode 0600)"
  log "  PostgreSQL user:        ${POSTGRES_USER:-zabbix}"
  log "  PostgreSQL password:    ${POSTGRES_PASSWORD}"
  log "  Zabbix DB name:         ${POSTGRES_DB:-zabbix}"
  log "  Portal DB name:         ${PORTAL_DB:-netmon}"
  log "  Portal admin email:     ${BOOTSTRAP_ADMIN_EMAIL:-admin@example.com}"
  log "  Portal admin password:  ${BOOTSTRAP_ADMIN_PASSWORD}"
  log "  JWT secret:             ${JWT_SECRET}"
  log "  Secrets master key:     ${SECRETS_MASTER_KEY}"
  log "  Zabbix UI login:        Admin"
  log "  Zabbix UI password:     zabbix   (change immediately)"
  printf '\n'
  log "Network binds:"
  log "  Zabbix web:   ${ZABBIX_WEB_BIND:-127.0.0.1}:${ZABBIX_WEB_PORT:-8080}"
  log "  Dashboard:    ${DASHBOARD_BIND:-127.0.0.1}:${DASHBOARD_PORT:-8081}"
  log "  API:          ${API_BIND:-127.0.0.1}:${API_PORT:-8000}"
  log "  Trapper:      ${ZABBIX_SERVER_BIND:-127.0.0.1}:${ZABBIX_SERVER_PORT:-10051}"
  printf '\n'
  log "Useful commands:"
  log "  cd ${SCRIPT_DIR}"
  log "  docker compose --env-file .env ps"
  log "  docker compose --env-file .env logs -f api"
  log "  curl -fsS ${api_url}/health/live"
  printf '\n'
  log "Next: read ${SCRIPT_DIR}/docs/DEPLOYMENT.md"
  log "============================================================"
  printf '\n'
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
