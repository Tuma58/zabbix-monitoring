#!/usr/bin/env bash
# Диагностика доступа NetMon на самом VPS (запускать локально: sudo ./scripts/diagnose-netmon.sh)
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SCRIPT_DIR}"

log() { printf '[diagnose] %s\n' "$*"; }

log "=== Хост ==="
hostname -f 2>/dev/null || hostname
date
log "Адреса:"
hostname -I 2>/dev/null || true
ip -4 addr show 2>/dev/null | sed -n 's/.*inet //p' || true

log "=== .env (порты/bind) ==="
if [[ -f .env ]]; then
  grep -E '^(LOCAL_ACCESS_IP|ZABBIX_WEB_|DASHBOARD_|API_|TLS_|CORS_|ZABBIX_TLS_|DASHBOARD_TLS_|API_TLS_)' .env || true
else
  log "НЕТ файла .env"
fi

log "=== Сертификат ==="
if [[ -f certs/netmon.crt ]]; then
  openssl x509 -in certs/netmon.crt -noout -subject -dates -ext subjectAltName 2>/dev/null || \
    openssl x509 -in certs/netmon.crt -noout -text | grep -A3 'Subject Alternative Name' || true
else
  log "НЕТ certs/netmon.crt — edge HTTPS не поднимется"
fi

log "=== Docker ==="
docker compose --env-file .env ps 2>/dev/null || docker compose ps 2>/dev/null || true
log "--- edge logs ---"
docker compose --env-file .env logs --tail=40 edge 2>/dev/null || true
log "--- dashboard logs ---"
docker compose --env-file .env logs --tail=20 dashboard 2>/dev/null || true
log "--- api logs ---"
docker compose --env-file .env logs --tail=20 api 2>/dev/null || true

log "=== Слушающие порты ==="
ss -lntp 2>/dev/null | grep -E ':(22|7080|7081|7000|7443|7444|7445)\b' || \
  netstat -lntp 2>/dev/null | grep -E ':(22|7080|7081|7000|7443|7444|7445)\b' || true

log "=== Локальные HTTP/HTTPS проверки ==="
for url in \
  http://127.0.0.1:7080/ \
  http://127.0.0.1:7081/ \
  http://127.0.0.1:7000/api/v1/health/live \
  http://127.0.0.1:7081/api/v1/health/live \
  https://127.0.0.1:7443/ \
  https://127.0.0.1:7444/ \
  https://127.0.0.1:7445/api/v1/health/live
do
  code="$(curl -k -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 -m 8 "${url}" 2>/dev/null || echo ERR)"
  log "  ${code}  ${url}"
done

LOCAL_IP="$(grep -E '^LOCAL_ACCESS_IP=' .env 2>/dev/null | cut -d= -f2- || true)"
LOCAL_IP="${LOCAL_IP:-100.10.10.66}"
log "=== Проверка через LOCAL_ACCESS_IP=${LOCAL_IP} ==="
for url in \
  "http://${LOCAL_IP}:7081/" \
  "http://${LOCAL_IP}:7081/api/v1/health/live" \
  "https://${LOCAL_IP}:7444/" \
  "https://${LOCAL_IP}:7445/api/v1/health/live"
do
  code="$(curl -k -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 -m 8 "${url}" 2>/dev/null || echo ERR)"
  log "  ${code}  ${url}"
done

log "=== Firewall ==="
command -v ufw >/dev/null && ufw status verbose || true
iptables -L DOCKER-USER -n 2>/dev/null | head -20 || true
iptables -L INPUT -n 2>/dev/null | head -20 || true

log "=== Готово. Пришлите весь вывод, если нужна помощь. ==="
