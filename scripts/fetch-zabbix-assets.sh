#!/usr/bin/env bash
# Обновление локального зеркала Zabbix agent 7.0.x и ключевых шаблонов.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${ZABBIX_AGENT_VERSION:-7.0.28}"
BASE="https://cdn.zabbix.com/zabbix/binaries/stable/7.0/${VER}"
AGENTS="$ROOT/dashboard/agents"
mkdir -p "$AGENTS/windows" "$AGENTS/linux"

download() {
  local url="$1" out="$2"
  echo "→ $out"
  curl -fL --retry 3 --retry-delay 2 -o "$out" "$url"
}

download "$BASE/zabbix_agent2-${VER}-windows-amd64-openssl.msi" \
  "$AGENTS/windows/zabbix_agent2-${VER}-windows-amd64-openssl.msi"
download "$BASE/zabbix_agent2-${VER}-windows-amd64-openssl-static.zip" \
  "$AGENTS/windows/zabbix_agent2-${VER}-windows-amd64-openssl-static.zip" || true
download "$BASE/zabbix_agent-${VER}-windows-amd64-openssl.msi" \
  "$AGENTS/windows/zabbix_agent-${VER}-windows-amd64-openssl.msi"
download "$BASE/zabbix_agent-${VER}-linux-3.0-amd64-static.tar.gz" \
  "$AGENTS/linux/zabbix_agent-${VER}-linux-3.0-amd64-static.tar.gz"

echo "Agents updated under $AGENTS"
echo "Templates: keep YAML under dashboard/templates (from zabbix/zabbix release/7.0)."
