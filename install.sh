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

create_environment() {
  if [[ -f "${ENV_FILE}" ]]; then
    log "Keeping existing ${ENV_FILE} and its secrets"
    chmod 600 "${ENV_FILE}"
    return
  fi

  local db_password
  db_password="$(random_secret)"

  umask 077
  {
    printf 'ZABBIX_VERSION=7.0-alpine-latest\n'
    printf 'POSTGRES_VERSION=16-alpine\n'
    printf 'POSTGRES_DB=zabbix\n'
    printf 'POSTGRES_USER=zabbix\n'
    printf 'POSTGRES_PASSWORD=%s\n' "${db_password}"
    printf 'PHP_TZ=%s\n' "${PHP_TZ:-Europe/Moscow}"
    printf 'ZABBIX_WEB_BIND=%s\n' "${ZABBIX_WEB_BIND:-127.0.0.1}"
    printf 'ZABBIX_WEB_PORT=%s\n' "${ZABBIX_WEB_PORT:-8080}"
    printf 'ZABBIX_SERVER_PORT=%s\n' "${ZABBIX_SERVER_PORT:-10051}"
    printf 'DASHBOARD_BIND=%s\n' "${DASHBOARD_BIND:-127.0.0.1}"
    printf 'DASHBOARD_PORT=%s\n' "${DASHBOARD_PORT:-8081}"
    printf 'ZBX_CACHESIZE=128M\n'
    printf 'ZBX_HISTORYCACHESIZE=64M\n'
    printf 'ZBX_TRENDCACHESIZE=32M\n'
    printf 'ZBX_VALUECACHESIZE=128M\n'
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Created ${ENV_FILE} with a random database password"
}

start_stack() {
  [[ -f "${COMPOSE_FILE}" ]] || fail "Missing ${COMPOSE_FILE}; deploy the complete repository"
  log "Validating Docker Compose configuration"
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet

  log "Downloading images and starting the base monitoring stack"
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull
  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans
}

wait_for_services() {
  local attempts=0
  local postgres_status
  while (( attempts < 30 )); do
    postgres_status="$(docker inspect --format '{{.State.Health.Status}}' netmon-postgres-1 2>/dev/null || true)"
    if [[ "${postgres_status}" == "healthy" ]]; then
      log "PostgreSQL is healthy"
      break
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  [[ "${postgres_status:-}" == "healthy" ]] || fail "PostgreSQL did not become healthy; inspect docker compose logs"

  docker compose --project-directory "${SCRIPT_DIR}" \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps
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
    log "Dashboard preview: ssh -L ${DASHBOARD_PORT:-8081}:127.0.0.1:${DASHBOARD_PORT:-8081} user@VPS_IP"
  else
    log "Dashboard preview: http://SERVER_IP:${DASHBOARD_PORT:-8081}"
  fi
  log "Initial Zabbix login: Admin / zabbix. Change it immediately."
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
