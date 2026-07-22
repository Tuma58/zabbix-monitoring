#!/usr/bin/env bash
# Установка Zabbix agent 2 на RHEL 9 / Alma / Rocky из локального release RPM.
set -euo pipefail

ZABBIX_SERVER="${1:-}"
HOSTNAME_VALUE="${2:-$(hostname -s)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_RPM="$AGENTS_ROOT/linux/rhel/zabbix-release-latest-7.0.el9.noarch.rpm"

if [[ -z "$ZABBIX_SERVER" ]]; then
  echo "Usage: $0 <zabbix_server_ip_or_dns> [hostname]"
  exit 1
fi
if [[ ! -f "$RELEASE_RPM" ]]; then
  echo "Release package not found: $RELEASE_RPM"
  exit 1
fi

sudo rpm -Uvh "$RELEASE_RPM"
sudo dnf install -y zabbix-agent2
sudo sed -i \
  -e "s/^Server=.*/Server=${ZABBIX_SERVER}/" \
  -e "s/^ServerActive=.*/ServerActive=${ZABBIX_SERVER}/" \
  -e "s/^Hostname=.*/Hostname=${HOSTNAME_VALUE}/" \
  /etc/zabbix/zabbix_agent2.conf
sudo systemctl enable --now zabbix-agent2
echo "Installed. Hostname=${HOSTNAME_VALUE} ServerActive=${ZABBIX_SERVER}"
