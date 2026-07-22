#!/usr/bin/env bash
# Однокомандный деплой Zabbix Agent 2 с зеркала NetMon dashboard.
#
# Примеры:
#   curl -fsSL "https://HOST:7444/agents/scripts/deploy-agent2-linux.sh" \
#     | sudo bash -s -- --base "https://HOST:7444" --server HOST --hostname my-host
#
#   NETMON_BASE_URL=https://HOST:7444 curl -fsSL "$NETMON_BASE_URL/agents/scripts/deploy-agent2-linux.sh" \
#     | sudo bash -s -- HOST my-host
#
set -euo pipefail

BASE_URL="${NETMON_BASE_URL:-}"
SERVER="${ZABBIX_SERVER:-}"
HOSTNAME_VALUE="${ZABBIX_HOSTNAME:-$(hostname -s 2>/dev/null || echo agent-host)}"
ACTIVE_ONLY=0

usage() {
  cat <<'EOF'
Usage:
  deploy-agent2-linux.sh --base URL --server IP_OR_DNS [--hostname NAME]
  deploy-agent2-linux.sh [--base URL] SERVER [HOSTNAME]

Options:
  --base URL       Base URL of NetMon dashboard (e.g. https://94.181.181.43:7444)
  --server HOST    Zabbix Server / ServerActive address
  --hostname NAME  Agent Hostname (must match Zabbix host name)
  --active-only    Leave ListenPort commented / prefer active checks
  -h, --help       Show this help

Environment:
  NETMON_BASE_URL, ZABBIX_SERVER, ZABBIX_HOSTNAME
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_URL="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --hostname) HOSTNAME_VALUE="${2:-}"; shift 2 ;;
    --active-only) ACTIVE_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    *)
      if [[ -z "$SERVER" ]]; then SERVER="$1"
      else HOSTNAME_VALUE="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$SERVER" ]]; then
  usage
  exit 1
fi

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="https://${SERVER}:7444"
fi
BASE_URL="${BASE_URL%/}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "/etc/os-release not found" >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  local url="$1" out="$2"
  echo "↓ $url"
  curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
}

configure_agent() {
  local conf="/etc/zabbix/zabbix_agent2.conf"
  if [[ ! -f "$conf" ]]; then
    echo "Config not found: $conf" >&2
    exit 1
  fi
  sed -i \
    -e "s/^Server=.*/Server=${SERVER}/" \
    -e "s/^ServerActive=.*/ServerActive=${SERVER}/" \
    -e "s/^Hostname=.*/Hostname=${HOSTNAME_VALUE}/" \
    "$conf"
  if ! grep -q '^Server=' "$conf"; then echo "Server=${SERVER}" >>"$conf"; fi
  if ! grep -q '^ServerActive=' "$conf"; then echo "ServerActive=${SERVER}" >>"$conf"; fi
  if ! grep -q '^Hostname=' "$conf"; then echo "Hostname=${HOSTNAME_VALUE}" >>"$conf"; fi
  if [[ "$ACTIVE_ONLY" -eq 1 ]]; then
    sed -i -e 's/^ListenPort=/# ListenPort=/' "$conf" || true
  fi
}

install_deb_family() {
  local release_path="$1"
  local url="${BASE_URL}/agents/linux/${release_path}"
  download "$url" "$TMP/zabbix-release.deb"
  dpkg -i "$TMP/zabbix-release.deb"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y zabbix-agent2
}

install_rhel_family() {
  local url="${BASE_URL}/agents/linux/rhel/zabbix-release-latest-7.0.el9.noarch.rpm"
  download "$url" "$TMP/zabbix-release.rpm"
  rpm -Uvh "$TMP/zabbix-release.rpm"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y zabbix-agent2
  else
    yum install -y zabbix-agent2
  fi
}

case "${ID}-${VERSION_ID}" in
  ubuntu-22.04|ubuntu-22.04.*)
    install_deb_family "ubuntu/zabbix-release_7.0-2+ubuntu22.04_all.deb"
    ;;
  ubuntu-24.04|ubuntu-24.04.*)
    # 22.04 release package often works for apt repo metadata on 24.04 mirrors;
    # if it fails, install matching release from repo.zabbix.com manually.
    install_deb_family "ubuntu/zabbix-release_7.0-2+ubuntu22.04_all.deb" || {
      echo "Ubuntu 24.04: release package from mirror failed. Falling back to Debian 12 package path is not supported." >&2
      exit 1
    }
    ;;
  debian-12|debian-12.*)
    install_deb_family "debian/zabbix-release_latest_7.0+debian12_all.deb"
    ;;
  rhel-9*|centos-9*|almalinux-9*|rocky-9*|ol-9*)
    install_rhel_family
    ;;
  *)
    echo "Unsupported distro: ${ID} ${VERSION_ID}" >&2
    echo "Supported: Ubuntu 22.04/24.04, Debian 12, RHEL/Alma/Rocky 9." >&2
    echo "Static tarball: ${BASE_URL}/agents/linux/zabbix_agent-7.0.28-linux-3.0-amd64-static.tar.gz" >&2
    exit 1
    ;;
esac

configure_agent
systemctl enable --now zabbix-agent2
systemctl --no-pager --full status zabbix-agent2 || true

echo
echo "OK: Zabbix Agent 2 installed"
echo "  Hostname=${HOSTNAME_VALUE}"
echo "  Server=${SERVER}"
echo "  ServerActive=${SERVER}"
echo "  Mirror=${BASE_URL}"
echo "Import template: ${BASE_URL}/templates/os/linux_active/template_os_linux_active.yaml"
echo "Check: nc -vz ${SERVER} 10051   # or: curl -v telnet://${SERVER}:10051"
