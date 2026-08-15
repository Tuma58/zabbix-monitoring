#!/usr/bin/env bash
# AIMon — деплой на LXC/VPS одной командой.
#
# Пример для нового LXC:
#   sudo LOCAL_ACCESS_IP=100.10.10.52 AIMON_DOMAIN=aimon.coresupport.ru ./deploy.sh
#
# Или с нуля:
#   curl -fsSL "https://raw.githubusercontent.com/Tuma58/zabbix-monitoring/cursor/ai-monitoring-6c05/aimon/deploy.sh" \
#     | sudo LOCAL_ACCESS_IP=100.10.10.52 AIMON_DOMAIN=aimon.coresupport.ru bash
set -euo pipefail

REPO_URL="${AIMON_REPO_URL:-https://github.com/Tuma58/zabbix-monitoring.git}"
BRANCH="${AIMON_BRANCH:-cursor/ai-monitoring-6c05}"
TARGET="${AIMON_DIR:-/opt/aimon}"
CLEAN_NETMON="${AIMON_CLEAN_NETMON:-0}"
LOCAL_IP="${LOCAL_ACCESS_IP:-100.10.10.52}"
DOMAIN="${AIMON_DOMAIN:-aimon.coresupport.ru}"

[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }

log() { printf '==> %s\n' "$*"; }

collect_ips() {
  local ips=()
  ips+=("127.0.0.1" "$LOCAL_IP")
  while read -r ip; do
    [[ -n "$ip" ]] && ips+=("$ip")
  done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true)
  printf '%s\n' "${ips[@]}" | awk '!seen[$0]++'
}

ensure_tls_cert() {
  local cert_dir="$1/certs"
  local crt="${cert_dir}/aimon.crt"
  local key="${cert_dir}/aimon.key"
  mkdir -p "$cert_dir"
  if [[ -f "$crt" && -f "$key" ]]; then
    if openssl x509 -in "$crt" -noout -text 2>/dev/null | grep -q "$DOMAIN" \
       && openssl x509 -in "$crt" -noout -text 2>/dev/null | grep -q "$LOCAL_IP"; then
      log "TLS-сертификат уже есть: $crt"
      return 0
    fi
    log "Сертификат без SAN для ${DOMAIN}/${LOCAL_IP} — пересоздаём"
  fi
  command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }
  local cfg; cfg="$(mktemp)"
  local san=""
  local i=1
  while read -r ip; do
    san="${san}IP.${i} = ${ip}"$'\n'
    i=$((i + 1))
  done < <(collect_ips)
  cat > "$cfg" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = RU
O = CoreSupport
OU = AIMon Self-Signed TLS
CN = ${DOMAIN}

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
DNS.2 = ${DOMAIN}
${san}
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$key" -out "$crt" -config "$cfg" >/dev/null 2>&1
  rm -f "$cfg"
  chmod 600 "$key"
  log "Создан TLS-сертификат (SAN: ${DOMAIN}, ${LOCAL_IP})"
}

build_cors() {
  local origins=()
  origins+=(
    "http://127.0.0.1:7081"
    "https://127.0.0.1:7444"
    "http://${LOCAL_IP}:7081"
    "https://${LOCAL_IP}:7444"
    "http://${DOMAIN}"
    "https://${DOMAIN}"
  )
  local pub
  pub="$(curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || true)"
  if [[ -n "$pub" ]]; then
    origins+=("http://${pub}:7081" "https://${pub}:7444")
  fi
  local out="" o
  for o in "${origins[@]}"; do
    [[ -n "$out" ]] && out="${out},"
    out="${out}${o}"
  done
  printf '%s' "$out"
}

clean_netmon() {
  log "Полная очистка NetMon / Zabbix…"
  if [[ -d /opt/netmon ]]; then
    (cd /opt/netmon && docker compose down -v --remove-orphans 2>/dev/null) || true
  fi
  docker ps -aq --filter 'name=netmon-' | xargs -r docker rm -f
  docker volume ls -q | grep -E '^netmon' | xargs -r docker volume rm || true
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | awk '/^netmon-|^zabbix\// {print $2}' | xargs -r docker rmi -f || true
  rm -rf /opt/netmon
  log "NetMon удалён"
}

echo "== AIMon deploy =="
echo "    LOCAL_IP=${LOCAL_IP}"
echo "    DOMAIN=${DOMAIN}"
echo "    TARGET=${TARGET}"
echo "    BRANCH=${BRANCH}"

if [[ "$CLEAN_NETMON" == "1" ]]; then
  clean_netmon
fi

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git openssl curl ca-certificates; }

# LXC / nested Docker tips
if [[ -f /.dockerenv ]] || grep -qa container=lxc /proc/1/environ 2>/dev/null || [[ -n "${container:-}" ]]; then
  log "Обнаружен container/LXC — проверяем nesting/docker"
fi

# 2) Код проекта
if [[ -d "$TARGET/.git" ]]; then
  log "Updating $TARGET…"
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout "$BRANCH"
  git -C "$TARGET" pull origin "$BRANCH"
else
  log "Cloning into $TARGET…"
  mkdir -p "$(dirname "$TARGET")"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET"
fi

cd "$TARGET/aimon"

# 3) TLS
ensure_tls_cert "$(pwd)"

# 4) .env
CORS="$(build_cors)"
if [[ ! -f .env ]]; then
  log "Creating .env with generated secrets…"
  cp .env.example .env
  gen() { python3 -c "import secrets;print(secrets.token_urlsafe(24))" 2>/dev/null || openssl rand -base64 24; }
  ADMIN_PW="$(gen)"
  MASTER="$(gen)"
  PORTAL_PW="${AIMON_ADMIN_PASSWORD:-$(gen)}"
  sed -i "s#^CHECKMK_ADMIN_PASSWORD=.*#CHECKMK_ADMIN_PASSWORD=${ADMIN_PW}#" .env
  sed -i "s#^SECRETS_MASTER_KEY=.*#SECRETS_MASTER_KEY=${MASTER}#" .env
  sed -i "s#^LOCAL_ACCESS_IP=.*#LOCAL_ACCESS_IP=${LOCAL_IP}#" .env
  sed -i "s#^AIMON_ADMIN_PASSWORD=.*#AIMON_ADMIN_PASSWORD=${PORTAL_PW}#" .env
  if grep -q '^CORS_ORIGINS=' .env; then
    sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=${CORS}#" .env
  else
    echo "CORS_ORIGINS=${CORS}" >>.env
  fi
  if grep -q '^AIMON_DOMAIN=' .env; then
    sed -i "s#^AIMON_DOMAIN=.*#AIMON_DOMAIN=${DOMAIN}#" .env
  else
    echo "AIMON_DOMAIN=${DOMAIN}" >>.env
  fi
  umask 077
  {
    echo "CHECKMK_ADMIN_PASSWORD=${ADMIN_PW}"
    echo "SECRETS_MASTER_KEY=${MASTER}"
    echo "AIMON_ADMIN_USERNAME=admin"
    echo "AIMON_ADMIN_PASSWORD=${PORTAL_PW}"
    echo "AIMON_DOMAIN=${DOMAIN}"
    echo "LOCAL_ACCESS_IP=${LOCAL_IP}"
  } > .admin-credentials
  chmod 600 .admin-credentials
  log "Секреты сохранены в $(pwd)/.admin-credentials"
else
  sed -i "s#^LOCAL_ACCESS_IP=.*#LOCAL_ACCESS_IP=${LOCAL_IP}#" .env || true
  if grep -q '^CORS_ORIGINS=' .env; then
    sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=${CORS}#" .env
  else
    echo "CORS_ORIGINS=${CORS}" >>.env
  fi
  if grep -q '^AIMON_DOMAIN=' .env; then
    sed -i "s#^AIMON_DOMAIN=.*#AIMON_DOMAIN=${DOMAIN}#" .env
  else
    echo "AIMON_DOMAIN=${DOMAIN}" >>.env
  fi
  ADMIN_PW="$(grep '^CHECKMK_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
fi

prefer_ipv4_docker() {
  sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
  sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >/etc/resolv.conf 2>/dev/null || true
  grep -q 'precedence :ffff:0:0/96  100' /etc/gai.conf 2>/dev/null \
    || echo 'precedence :ffff:0:0/96  100' >>/etc/gai.conf 2>/dev/null || true
  if command -v dig >/dev/null 2>&1; then
    sed -i -E '/[[:space:]](registry-1\.docker\.io|auth\.docker\.io|registry\.docker\.io)$/d' /etc/hosts 2>/dev/null || true
    for host in registry-1.docker.io auth.docker.io registry.docker.io; do
      ip="$(dig +short A "$host" @8.8.8.8 | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"
      [[ -n "$ip" ]] && echo "$ip $host" >>/etc/hosts
    done
  fi
  mkdir -p /etc/docker
  if [[ ! -f /etc/docker/daemon.json ]]; then
    cat >/etc/docker/daemon.json <<'EOF'
{"ipv6": false, "ip6tables": false, "dns": ["8.8.8.8", "1.1.1.1"]}
EOF
    systemctl restart docker 2>/dev/null || true
    sleep 3
  fi
}

# 5) Поднять стек
log "Starting stack…"
prefer_ipv4_docker
pull_ok=0
for attempt in 1 2 3 4 5; do
  if docker compose pull --ignore-buildable 2>&1; then
    pull_ok=1
    break
  fi
  log "docker compose pull failed (attempt ${attempt}/5) — жду и повторяю…"
  prefer_ipv4_docker
  sleep $((attempt * 8))
done
[[ "$pull_ok" -eq 1 ]] || log "WARNING: pull не удался — пробуем up с локальными/кэшированными образами"
docker compose up -d --build

# 6) Ждём Checkmk
log "Ожидание Checkmk (до 3 минут)…"
for i in $(seq 1 36); do
  if curl -fsS "http://127.0.0.1:7080/${CHECKMK_SITE:-cmk}/check_mk/login.py" >/dev/null 2>&1 \
     || curl -fsS "http://127.0.0.1:7080/" >/dev/null 2>&1; then
    log "Checkmk отвечает"
    break
  fi
  sleep 5
done

PUBLIC_IP="$(curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"

# 7) Let's Encrypt (если домен смотрит на этот хост и :80 снаружи открыт)
LE_FLAG="${AIMON_LETSENCRYPT:-1}"
if [[ "$LE_FLAG" == "1" && -n "$DOMAIN" && "$DOMAIN" != "localhost" ]]; then
  log "Выпуск Let's Encrypt для ${DOMAIN}…"
  if AIMON_DIR="$(pwd)" AIMON_DOMAIN="$DOMAIN" bash scripts/issue-letsencrypt.sh; then
    log "Let's Encrypt OK"
  else
    log "WARNING: Let's Encrypt не выпущен — остаётся self-signed. Повторите:"
    log "  cd $(pwd) && sudo AIMON_DOMAIN=${DOMAIN} bash scripts/issue-letsencrypt.sh"
  fi
fi

echo
echo "== AIMon запущен =="
echo "Domain:          https://${DOMAIN}"
echo "Dashboard HTTP:  http://${LOCAL_IP}:7081"
echo "Dashboard HTTPS: https://${LOCAL_IP}:7444"
echo "Checkmk:         http://${LOCAL_IP}:7080/${CHECKMK_SITE:-cmk}/  |  https://${DOMAIN}/cmk/"
echo "API:             https://${DOMAIN}/api/v1/health"
echo "Agent port:      ${LOCAL_IP}:10051  /  ${PUBLIC_IP:-PUBLIC}:10051"
echo
echo "Portal login:    admin / (см. .admin-credentials)"
echo "Checkmk login:   cmkadmin / (см. .admin-credentials)"
echo "Дальше: создайте automation secret в Checkmk и впишите CHECKMK_AUTOMATION_SECRET в .env,"
echo "затем: cd ${TARGET}/aimon && docker compose up -d api"
