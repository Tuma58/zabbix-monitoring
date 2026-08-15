#!/usr/bin/env bash
# Выпуск / продление Let's Encrypt для AIMon (HTTP-01 standalone).
#
# На сервере:
#   cd /opt/aimon/aimon && sudo bash scripts/issue-letsencrypt.sh
#
# Переменные:
#   AIMON_DOMAIN=aimon.coresupport.ru
#   AIMON_LE_EMAIL=admin@coresupport.ru
#   AIMON_DIR=/opt/aimon/aimon   # каталог со стеком (compose.yaml)
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

# Проверка, что DNS указывает сюда (или хотя бы резолвится)
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
log "DNS ${DOMAIN} → ${RESOLVED:-?}; публичный IP хоста → ${PUBLIC_IP:-?}"

compose() {
  docker compose "$@"
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

# Чтобы edge видел webroot для будущих renew через webroot (опционально)
if ! grep -q 'certbot-www:/var/www/certbot' compose.yaml 2>/dev/null; then
  log "В compose.yaml нет mount ACME webroot — standalone-renew через этот скрипт"
fi

log "Сертификат установлен → certs/aimon.crt / certs/aimon.key"
openssl x509 -in "${ROOT}/certs/aimon.crt" -noout -subject -issuer -dates

# trap поднимет edge; принудительно recreate чтобы подхватить новые файлы
trap - EXIT
log "Перезапуск edge с новым сертификатом…"
compose up -d --force-recreate edge

sleep 2
log "Проверка HTTPS…"
curl -fsS --max-time 15 "https://${DOMAIN}/api/v1/health" && echo || \
  curl -vk --max-time 15 "https://${DOMAIN}/" >/dev/null

echo
echo "== Let's Encrypt готов =="
echo "https://${DOMAIN}"
echo "Продление: cd ${ROOT} && sudo bash scripts/issue-letsencrypt.sh"
echo "Cron (раз в месяц): 0 3 1 * * root cd ${ROOT} && bash scripts/issue-letsencrypt.sh >>/var/log/aimon-le.log 2>&1"
