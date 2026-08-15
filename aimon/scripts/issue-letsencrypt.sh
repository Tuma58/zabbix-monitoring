#!/usr/bin/env bash
# Выпуск / продление Let's Encrypt для AIMon (HTTP-01 standalone).
# Только системный certbot (apt) — без Docker Hub.
#
#   curl -fsSL …/issue-letsencrypt.sh | AIMON_DOMAIN=aimon.coresupport.ru bash
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

log "AIMon LE script v3 (apt certbot only)"
log "Домен: ${DOMAIN}"
log "Каталог: ${ROOT}"

RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
log "DNS ${DOMAIN} → ${RESOLVED:-?}; egress IP хоста → ${PUBLIC_IP:-?}"
if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
  log "NOTE: DNS и egress IP различаются — OK, если NAT :80/:443 на DNS-IP → этот LXC"
fi

compose() { docker compose "$@"; }

if ! command -v certbot >/dev/null 2>&1; then
  log "Устанавливаем certbot через apt…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y certbot
fi
command -v certbot >/dev/null 2>&1 || {
  echo "certbot не установлен. Проверьте apt / сеть до deb.debian.org" >&2
  exit 1
}

log "Останавливаем edge (освобождаем :80)…"
compose stop edge >/dev/null

cleanup() {
  log "Поднимаем edge обратно…"
  compose up -d edge >/dev/null 2>&1 || compose start edge >/dev/null 2>&1 || true
}
trap cleanup EXIT

LE_DIR="${ROOT}/certs/letsencrypt"
mkdir -p "${LE_DIR}/work" "${LE_DIR}/logs"

log "Запрос сертификата Let's Encrypt (host certbot)…"
certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "${EMAIL}" \
  --preferred-challenges http \
  --keep-until-expiring \
  --config-dir "${LE_DIR}" \
  --work-dir "${LE_DIR}/work" \
  --logs-dir "${LE_DIR}/logs" \
  -d "${DOMAIN}"

LIVE="${LE_DIR}/live/${DOMAIN}"
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
curl -fsS --max-time 15 "https://${DOMAIN}/api/v1/health" && echo || \
  curl -skS --max-time 15 "https://${DOMAIN}/api/v1/health" && echo || true

echo
echo "== Let's Encrypt готов =="
echo "https://${DOMAIN}"
echo "Продление: AIMON_DOMAIN=${DOMAIN} bash $0"
