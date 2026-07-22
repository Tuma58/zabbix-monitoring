#!/usr/bin/env bash
# Удаляет демо-инвентарь из БД портала (sites/devices), не трогая Zabbix и пользователей.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

log() { printf '[purge] %s\n' "$*"; }

[[ -f "${ENV_FILE}" ]] || { log "Нет ${ENV_FILE}"; exit 1; }
# shellcheck disable=SC1090
source "${ENV_FILE}"

postgres_id="$(docker compose --project-directory "${SCRIPT_DIR}" --env-file "${ENV_FILE}" ps -q postgres)"
[[ -n "${postgres_id}" ]] || { log "PostgreSQL не запущен"; exit 1; }

portal_db="${PORTAL_DB:-netmon}"

log "Очистка таблиц devices и sites в БД ${portal_db}…"
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -e PGUSER="${POSTGRES_USER:-zabbix}" \
  "${postgres_id}" \
  psql -d "${portal_db}" -v ON_ERROR_STOP=1 -c "TRUNCATE devices, sites RESTART IDENTITY CASCADE;"

log "Готово. Обновите dashboard в браузере (Ctrl+F5)."
