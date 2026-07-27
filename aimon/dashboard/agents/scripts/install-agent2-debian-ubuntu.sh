#!/usr/bin/env bash
# Установка Zabbix agent 2 на Ubuntu 22.04 / Debian 12 из локального release-пакета
# или из официального репозитория.
set -euo pipefail

ZABBIX_SERVER="${1:-}"
HOSTNAME_VALUE="${2:-$(hostname -s)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "$ZABBIX_SERVER" ]]; then
  echo "Usage: $0 <zabbix_server_ip_or_dns> [hostname]"
  exit 1
fi

. /etc/os-release
case "${ID}-${VERSION_ID}" in
  ubuntu-22.04)
    RELEASE_DEB="$AGENTS_ROOT/linux/ubuntu/zabbix-release_7.0-2+ubuntu22.04_all.deb"
    ;;
  debian-12)
    RELEASE_DEB="$AGENTS_ROOT/linux/debian/zabbix-release_latest_7.0+debian12_all.deb"
    ;;
  *)
    echo "Unsupported distro: ${ID} ${VERSION_ID}. Install repo package manually."
    exit 1
    ;;
esac

if [[ ! -f "$RELEASE_DEB" ]]; then
  echo "Release package not found: $RELEASE_DEB"
  exit 1
fi

sudo dpkg -i "$RELEASE_DEB"
sudo apt-get update
sudo apt-get install -y zabbix-agent2
sudo sed -i \
  -e "s/^Server=.*/Server=${ZABBIX_SERVER}/" \
  -e "s/^ServerActive=.*/ServerActive=${ZABBIX_SERVER}/" \
  -e "s/^Hostname=.*/Hostname=${HOSTNAME_VALUE}/" \
  /etc/zabbix/zabbix_agent2.conf
sudo systemctl enable --now zabbix-agent2
sudo systemctl status --no-pager zabbix-agent2 || true
echo "Installed. Hostname=${HOSTNAME_VALUE} ServerActive=${ZABBIX_SERVER}"
echo "Import template: templates/os/linux_active/template_os_linux_active.yaml"
