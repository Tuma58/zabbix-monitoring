#!/usr/bin/env bash
# Обновление зеркала Checkmk-агентов в aimon/dashboard/agents.
# Копирует пакеты из работающего контейнера checkmk.
#
# Запуск: sudo ./aimon/scripts/fetch-cmk-agents.sh [--commit]
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$COMPOSE_DIR/dashboard/agents"
CONTAINER="${CMK_CONTAINER:-aimon-checkmk-1}"
CMK_AGENTS="/omd/sites/cmk/share/check_mk/agents"

COMMIT=0
[[ "${1:-}" == "--commit" ]] && COMMIT=1

echo "Контейнер: $CONTAINER"
echo "Целевая папка: $AGENTS_DIR"

mkdir -p "$AGENTS_DIR/linux" "$AGENTS_DIR/windows"

copy() {
  local src="$1" dst="$2"
  echo "→ $(basename "$dst")"
  docker cp "$CONTAINER:$src" "$dst"
}

# Linux
copy "$CMK_AGENTS/check-mk-agent_"*"_all.deb"     "$AGENTS_DIR/linux/"
copy "$CMK_AGENTS/check-mk-agent-"*".noarch.rpm"   "$AGENTS_DIR/linux/"
copy "$CMK_AGENTS/check_mk_agent.linux"            "$AGENTS_DIR/linux/check_mk_agent.linux"
copy "$CMK_AGENTS/linux/cmk-agent-ctl"             "$AGENTS_DIR/linux/cmk-agent-ctl"
copy "$CMK_AGENTS/linux/cmk-agent-ctl.gz"          "$AGENTS_DIR/linux/cmk-agent-ctl.gz"

# Windows
copy "$CMK_AGENTS/windows/check_mk_agent.msi"      "$AGENTS_DIR/windows/check_mk_agent.msi"

echo "Готово. Файлы:"
ls -lh "$AGENTS_DIR/linux" "$AGENTS_DIR/windows"

if [[ "$COMMIT" == "1" ]]; then
  VER=$(docker exec "$CONTAINER" omd version 2>/dev/null | grep -oP '\d+\.\d+\.\d+p\d+' | head -1 || echo "unknown")
  cd "$COMPOSE_DIR/.."
  git add aimon/dashboard/agents/linux aimon/dashboard/agents/windows
  git commit -m "chore(aimon): update Checkmk agent mirror to $VER"
  echo "Закоммичено."
fi
