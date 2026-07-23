#!/usr/bin/env bash
# AIMon — установка Checkmk-агента и АВТОДОБАВЛЕНИЕ узла в мониторинг одной командой.
#
# Пример:
#   curl -fsSLk "https://HOST/agents/install-linux.sh" \
#     | sudo bash -s -- --server HOST --token <REG_TOKEN> --hostname auto
#
# Dashboard/сервер использует самоподписанный TLS — скачивание идёт с -k.
set -euo pipefail

SERVER=""
TOKEN=""
HOSTNAME_VALUE=""
BASE_URL="${AIMON_BASE_URL:-}"
INSECURE="${AIMON_INSECURE:-1}"

usage() {
  cat <<'EOF'
Usage:
  install-linux.sh --server HOST [--base URL] [--token TOKEN] [--hostname NAME|auto]

Options:
  --server HOST     Адрес сервера AIMon/Checkmk (агент шлёт данные сюда)
  --base URL        Базовый URL дашборда (по умолчанию https://SERVER)
  --token TOKEN     Токен регистрации агента (из раздела «Секреты»)
  --hostname NAME   Имя хоста; "auto" = hostname -f
  --secure          Требовать валидный TLS-сертификат
  -h, --help        Помощь
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --base) BASE_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --hostname) HOSTNAME_VALUE="${2:-}"; shift 2 ;;
    --secure) INSECURE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -z "$SERVER" ]] && { usage; exit 1; }
[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }
[[ -z "$BASE_URL" ]] && BASE_URL="https://${SERVER}"
BASE_URL="${BASE_URL%/}"
if [[ -z "$HOSTNAME_VALUE" || "$HOSTNAME_VALUE" == "auto" ]]; then
  HOSTNAME_VALUE="$(hostname -f 2>/dev/null || hostname)"
fi

CURL=(curl -fsSL --retry 3 --retry-delay 2)
[[ "$INSECURE" == "1" ]] && CURL+=(-k)

. /etc/os-release 2>/dev/null || true
echo "AIMon: installing Checkmk agent for ${HOSTNAME_VALUE} (server ${SERVER})"

install_pkg() {
  local url="$1" out="$2"
  echo "↓ $url"
  "${CURL[@]}" -o "$out" "$url"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 1) Скачать пакет агента с сервера Checkmk (раздаётся дашбордом по /agent/)
case "${ID:-}" in
  ubuntu|debian)
    install_pkg "${BASE_URL}/agent/check-mk-agent.deb" "$TMP/cmk-agent.deb"
    apt-get install -y "$TMP/cmk-agent.deb" || dpkg -i "$TMP/cmk-agent.deb"
    ;;
  rhel|centos|almalinux|rocky|ol)
    install_pkg "${BASE_URL}/agent/check-mk-agent.rpm" "$TMP/cmk-agent.rpm"
    rpm -Uvh "$TMP/cmk-agent.rpm" || dnf install -y "$TMP/cmk-agent.rpm"
    ;;
  *)
    echo "Unsupported distro: ${ID:-unknown}. Установите агент вручную." >&2
    exit 1
    ;;
esac

# 2) Регистрация агента через agent controller (TLS), если доступен
if command -v cmk-agent-ctl >/dev/null 2>&1 && [[ -n "$TOKEN" ]]; then
  echo "Registering agent controller with server ${SERVER}…"
  cmk-agent-ctl register \
    --server "${SERVER}" \
    --site cmk \
    --hostname "${HOSTNAME_VALUE}" \
    --user automation \
    --password "${TOKEN}" \
    --trust-cert || echo "cmk-agent-ctl register failed (продолжаю, узел добавит backend)"
fi

# 3) Автодобавление узла в мониторинг через backend AIMon
echo "Auto-registering node in AIMon backend…"
IP_GUESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
"${CURL[@]}" -X POST "${BASE_URL}/api/v1/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"hostname\":\"${HOSTNAME_VALUE}\",\"ip\":\"${IP_GUESS}\",\"os\":\"${ID:-linux}\",\"token\":\"${TOKEN}\"}" \
  && echo || echo "Backend auto-register не удался — добавьте узел вручную в дашборде."

echo
echo "OK: агент установлен. Узел «${HOSTNAME_VALUE}» появится в мониторинге автоматически."
