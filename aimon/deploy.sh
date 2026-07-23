#!/usr/bin/env bash
# AIMon — деплой на чистый VPS одной командой.
#   curl -fsSLk "https://RAW_HOST/aimon/deploy.sh" | sudo bash
# или локально из каталога репозитория:
#   sudo ./deploy.sh
set -euo pipefail

REPO_URL="${AIMON_REPO_URL:-https://github.com/Tuma58/zabbix-monitoring.git}"
BRANCH="${AIMON_BRANCH:-cursor/ai-monitoring-6c05}"
TARGET="${AIMON_DIR:-/opt/aimon}"

[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }

echo "== AIMon deploy =="

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin required" >&2; exit 1; }

# 2) Код проекта
if [[ -d "$TARGET/.git" ]]; then
  echo "Updating $TARGET…"
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout "$BRANCH"
  git -C "$TARGET" pull origin "$BRANCH"
else
  echo "Cloning into $TARGET…"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET"
fi

cd "$TARGET/aimon"

# 3) .env
if [[ ! -f .env ]]; then
  echo "Creating .env with generated secrets…"
  cp .env.example .env
  gen() { python3 -c "import secrets;print(secrets.token_urlsafe(32))" 2>/dev/null || head -c 32 /dev/urandom | base64; }
  ADMIN_PW="$(gen)"; MASTER="$(gen)"
  sed -i "s#^CHECKMK_ADMIN_PASSWORD=.*#CHECKMK_ADMIN_PASSWORD=${ADMIN_PW}#" .env
  sed -i "s#^SECRETS_MASTER_KEY=.*#SECRETS_MASTER_KEY=${MASTER}#" .env
  echo "Generated Checkmk admin password: ${ADMIN_PW}"
fi

# 4) Поднять стек
echo "Starting stack…"
docker compose up -d --build

echo
echo "== AIMon запущен =="
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(grep -E '^DASHBOARD_PORT=' .env | cut -d= -f2 || echo 8080)"
echo "Дашборд:  http://${IP:-<host>}:${PORT:-8080}"
echo "Checkmk:  http://${IP:-<host>}:5000/cmk/ (внутри сети docker; настройте edge при необходимости)"
echo
echo "Дальше: в Checkmk создайте automation secret и впишите CHECKMK_AUTOMATION_SECRET в .env,"
echo "затем: docker compose up -d api"
