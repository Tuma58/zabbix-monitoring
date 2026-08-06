#!/usr/bin/env bash
# AIMon — установка Checkmk-агента и АВТОДОБАВЛЕНИЕ узла в мониторинг одной командой.
#
# Пример:
#   curl -fsSLk "https://HOST:7444/agents/install-linux.sh" \
#     | sudo bash -s -- --server HOST --token <REG_TOKEN> --hostname auto
#
# Dashboard использует самоподписанный TLS — нужен curl -k (или :7081 HTTP).
set -euo pipefail

SERVER=""
TOKEN=""
HOSTNAME_VALUE=""
BASE_URL="${AIMON_BASE_URL:-}"
INSECURE="${AIMON_INSECURE:-1}"
CMK_VERSION="2.3.0p48"

usage() {
  cat <<'EOF'
Usage:
  install-linux.sh --server HOST [--base URL] [--token TOKEN] [--hostname NAME|auto]

Options:
  --server HOST     Адрес сервера AIMon/Checkmk (IP или DNS без порта)
  --base URL        Базовый URL дашборда (по умолчанию https://SERVER:7444)
  --token TOKEN     Токен регистрации агента (из раздела «Секреты»)
  --hostname NAME   Имя хоста в Checkmk; "auto" = hostname -f
  --secure          Требовать валидный TLS-сертификат
  -h, --help        Помощь
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)   SERVER="${2:-}";         shift 2 ;;
    --base)     BASE_URL="${2:-}";       shift 2 ;;
    --token)    TOKEN="${2:-}";          shift 2 ;;
    --hostname) HOSTNAME_VALUE="${2:-}"; shift 2 ;;
    --secure)   INSECURE=0;             shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -z "$SERVER" ]] && { usage; exit 1; }
[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }
[[ -z "$BASE_URL" ]] && BASE_URL="https://${SERVER}:7444"
BASE_URL="${BASE_URL%/}"
if [[ -z "$HOSTNAME_VALUE" || "$HOSTNAME_VALUE" == "auto" ]]; then
  HOSTNAME_VALUE="$(hostname -f 2>/dev/null || hostname)"
fi

CURL=(curl -fsSL --retry 3 --retry-delay 2)
[[ "$INSECURE" == "1" ]] && CURL+=(-k)

. /etc/os-release 2>/dev/null || true
echo "AIMon: устанавливаю Checkmk ${CMK_VERSION} агент для «${HOSTNAME_VALUE}» → сервер ${SERVER}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 1) Скачать пакет с дашборда AIMon (зеркало /agents/linux/)
case "${ID:-}" in
  ubuntu|debian)
    echo "↓ check-mk-agent_${CMK_VERSION}-1_all.deb"
    "${CURL[@]}" -o "$TMP/cmk-agent.deb" \
      "${BASE_URL}/agents/linux/check-mk-agent_${CMK_VERSION}-1_all.deb"
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$TMP/cmk-agent.deb" 2>/dev/null \
      || dpkg -i "$TMP/cmk-agent.deb"
    ;;
  rhel|centos|almalinux|rocky|ol|fedora)
    echo "↓ check-mk-agent-${CMK_VERSION}-1.noarch.rpm"
    "${CURL[@]}" -o "$TMP/cmk-agent.rpm" \
      "${BASE_URL}/agents/linux/check-mk-agent-${CMK_VERSION}-1.noarch.rpm"
    rpm -Uvh "$TMP/cmk-agent.rpm" 2>/dev/null \
      || dnf install -y "$TMP/cmk-agent.rpm" 2>/dev/null \
      || yum install -y "$TMP/cmk-agent.rpm"
    ;;
  *)
    # Fallback: shell-агент (без пакетного менеджера)
    echo "Пакетный дистрибутив не распознан (${ID:-?}). Установка shell-агента…"
    "${CURL[@]}" -o /usr/local/bin/check_mk_agent \
      "${BASE_URL}/agents/linux/check_mk_agent.linux"
    chmod +x /usr/local/bin/check_mk_agent
    # xinetd / systemd socket — базовая настройка
    if command -v systemctl >/dev/null 2>&1; then
      cat >/etc/systemd/system/check_mk_agent.socket <<'SOCK'
[Unit]
Description=Checkmk agent socket

[Socket]
ListenStream=6556
Accept=yes

[Install]
WantedBy=sockets.target
SOCK
      cat >/etc/systemd/system/check_mk_agent@.service <<'SVC'
[Unit]
Description=Checkmk agent instance

[Service]
ExecStart=/usr/local/bin/check_mk_agent
StandardInput=socket
SVC
      systemctl daemon-reload
      systemctl enable --now check_mk_agent.socket 2>/dev/null || true
    fi
    echo "Shell-агент установлен в /usr/local/bin/check_mk_agent"
    ;;
esac

# 2) Регистрация через cmk-agent-ctl (TLS encrypted transport)
if command -v cmk-agent-ctl >/dev/null 2>&1 && [[ -n "$TOKEN" ]]; then
  echo "Регистрирую agent-controller на сервере ${SERVER}…"
  cmk-agent-ctl register \
    --server "${SERVER}" \
    --site cmk \
    --hostname "${HOSTNAME_VALUE}" \
    --user automation \
    --password "${TOKEN}" \
    --trust-cert \
  || echo "[warn] cmk-agent-ctl register не удался — узел добавит AIMon backend"
fi

# 3) Автодобавление узла в мониторинг через AIMon API
echo "Регистрирую узел в AIMon backend…"
IP_GUESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
"${CURL[@]}" -X POST "${BASE_URL}/api/v1/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"hostname\":\"${HOSTNAME_VALUE}\",\"ip\":\"${IP_GUESS}\",\"os\":\"${ID:-linux}\",\"token\":\"${TOKEN}\"}" \
  && echo "  ✓ Узел зарегистрирован." \
  || echo "  [warn] Автодобавление не удалось — добавьте узел вручную в дашборде."

echo
echo "✓ Готово: агент Checkmk ${CMK_VERSION} установлен."
echo "  Узел «${HOSTNAME_VALUE}» появится в мониторинге через 1–2 минуты."
