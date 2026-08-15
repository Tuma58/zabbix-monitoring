#!/usr/bin/env bash
# Выпуск / продление Let's Encrypt для AIMon (HTTP-01 standalone).
#
# По умолчанию использует системный certbot (apt) — без docker.io pull.
# Docker-образ — только fallback, если certbot уже есть локально в Docker.
#
# На сервере:
#   curl -fsSL …/issue-letsencrypt.sh | sudo AIMON_DOMAIN=aimon.coresupport.ru bash
#
# Переменные:
#   AIMON_DOMAIN=aimon.coresupport.ru
#   AIMON_LE_EMAIL=admin@coresupport.ru
#   AIMON_DIR=/opt/aimon/aimon
set -euo pipefail

DOMAIN="${AIMON_DOMAIN:-aimon.coresupport.ru}"
EMAIL="${AIMON_LE_EMAIL:-admin@coresupport.ru}"
ROOT="${AIMON_DIR:-}"
if [[ -z "$ROOT" ]]; then
  if [[ -f ./compose.yaml && -d ./certs ]]; then
    ROOT="$(pwd)"
  elif [[ -f /opt/aimon/aimon/compose.yaml ]]; then
    ROOT=/opt/aimon/aimon
  else
    echo "Не найден каталог AIMon (compose.yaml). Задайте AIMON_DIR." >&2
    exit 1
  fi
fi

[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }

cd "$ROOT"
mkdir -p certs/letsencrypt certs/certbot-www

log() { printf '==> %s\n' "$*"; }

log "Домен: ${DOMAIN}"
log "Каталог: ${ROOT}"

RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
log "DNS ${DOMAIN} → ${RESOLVED:-?}; egress IP хоста → ${PUBLIC_IP:-?}"
if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
  log "NOTE: DNS и egress IP различаются — для HTTP-01 это нормально, если NAT :80/:443 на DNS-IP ведёт на этот LXC"
fi

compose() {
  docker compose "$@"
}

ensure_host_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    return 0
  fi
  log "Устанавливаем certbot через apt (без Docker Hub)…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y certbot
  command -v certbot >/dev/null 2>&1
}

run_certbot_host() {
  local le_dir="${ROOT}/certs/letsencrypt"
  mkdir -p "$le_dir"
  certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "${EMAIL}" \
    --preferred-challenges http \
    --keep-until-expiring \
    --config-dir "${le_dir}" \
    --work-dir "${le_dir}/work" \
    --logs-dir "${le_dir}/logs" \
    -d "${DOMAIN}"
}

run_certbot_docker() {
  log "Fallback: пробуем образ certbot/certbot…"
  # лёгкий IPv4/DNS nudge (часто ломается docker.io в LXC)
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >/etc/resolv.conf 2>/dev/null || true
  local ok=0 attempt
  for attempt in 1 2 3; do
    if docker pull certbot/certbot:v2.11.0; then
      ok=1
      break
    fi
    log "docker pull failed (${attempt}/3)…"
    sleep $((attempt * 5))
  done
  [[ "$ok" -eq 1 ]] || return 1
  docker run --rm \
    -p 80:80 \
    -v "${ROOT}/certs/letsencrypt:/etc/letsencrypt" \
    certbot/certbot:v2.11.0 \
    certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "${EMAIL}" \
    --preferred-challenges http \
    --keep-until-expiring \
    -d "${DOMAIN}"
}

# Останавливаем edge, чтобы освободить :80 для standalone-challenge
log "Останавливаем edge (освобождаем :80)…"
compose stop edge >/dev/null

cleanup() {
  log "Поднимаем edge обратно…"
  compose up -d edge >/dev/null 2>&1 || compose start edge >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Запрос сертификата Let's Encrypt…"
if ensure_host_certbot; then
  run_certbot_host
else
  log "apt certbot недоступен — fallback на Docker"
  run_certbot_docker
fi

LIVE="${ROOT}/certs/letsencrypt/live/${DOMAIN}"
[[ -f "${LIVE}/fullchain.pem" && -f "${LIVE}/privkey.pem" ]] || {
  echo "Сертификат не найден в ${LIVE}" >&2
  exit 1
}

umask 077
cp -f "${LIVE}/fullchain.pem" "${ROOT}/certs/aimon.crt"
cp -f "${LIVE}/privkey.pem" "${ROOT}/certs/aimon.key"
chmod 644 "${ROOT}/certs/aimon.crt"
chmod 600 "${ROOT}/certs/aimon.key"

log "Сертификат установлен → certs/aimon.crt / certs/aimon.key"
openssl x509 -in "${ROOT}/certs/aimon.crt" -noout -subject -issuer -dates

trap - EXIT
log "Перезапуск edge с новым сертификатом…"
compose up -d --force-recreate edge

sleep 2
log "Проверка HTTPS…"
if curl -fsS --max-time 15 "https://${DOMAIN}/api/v1/health"; then
  echo
else
  log "WARNING: строгая проверка TLS не прошла — смотрите openssl/curl -vk"
  curl -skS --max-time 15 "https://${DOMAIN}/api/v1/health" && echo || true
fi

echo
echo "== Let's Encrypt готов =="
echo "https://${DOMAIN}"
echo "Продление: cd ${ROOT} && sudo bash scripts/issue-letsencrypt.sh"
echo "Cron: 0 3 1 * * root cd ${ROOT} && bash scripts/issue-letsencrypt.sh >>/var/log/aimon-le.log 2>&1"
