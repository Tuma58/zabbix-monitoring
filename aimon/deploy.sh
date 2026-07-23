#!/usr/bin/env bash
# AIMon — деплой на VPS одной командой (порты как у NetMon).
#   sudo AIMON_CLEAN_NETMON=1 ./deploy.sh
# или:
#   curl -fsSLk "https://RAW_HOST/aimon/deploy.sh" | sudo bash
set -euo pipefail

REPO_URL="${AIMON_REPO_URL:-https://github.com/Tuma58/zabbix-monitoring.git}"
BRANCH="${AIMON_BRANCH:-cursor/ai-monitoring-6c05}"
TARGET="${AIMON_DIR:-/opt/aimon}"
CLEAN_NETMON="${AIMON_CLEAN_NETMON:-1}"
LOCAL_IP="${LOCAL_ACCESS_IP:-100.10.10.66}"

[[ "$(id -u)" -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }

log() { printf '==> %s\n' "$*"; }

collect_ips() {
  local ips=()
  ips+=("127.0.0.1" "$LOCAL_IP")
  # публичный / все адреса хоста
  while read -r ip; do
    [[ -n "$ip" ]] && ips+=("$ip")
  done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true)
  # уникальные
  printf '%s\n' "${ips[@]}" | awk '!seen[$0]++'
}

ensure_tls_cert() {
  local cert_dir="$1/certs"
  local crt="${cert_dir}/aimon.crt"
  local key="${cert_dir}/aimon.key"
  mkdir -p "$cert_dir"
  if [[ -f "$crt" && -f "$key" ]]; then
    if openssl x509 -in "$crt" -noout -text 2>/dev/null | grep -q "$LOCAL_IP"; then
      log "TLS-сертификат уже есть: $crt"
      return 0
    fi
    log "Сертификат без SAN для ${LOCAL_IP} — пересоздаём"
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
OU = AIMon Self-Signed IP TLS
CN = aimon

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
${san}
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$key" -out "$crt" -config "$cfg" >/dev/null 2>&1
  rm -f "$cfg"
  chmod 600 "$key"
  log "Создан самоподписанный TLS-сертификат (SAN включает ${LOCAL_IP})"
}

clean_netmon() {
  log "Полная очистка NetMon / Zabbix…"
  if [[ -d /opt/netmon ]]; then
    (cd /opt/netmon && docker compose down -v --remove-orphans 2>/dev/null) || true
  fi
  # на случай, если контейнеры остались без compose-файла
  docker ps -aq --filter 'name=netmon-' | xargs -r docker rm -f
  docker volume ls -q | grep -E '^netmon' | xargs -r docker volume rm || true
  # старые образы zabbix/netmon (не трогаем checkmk / nginx / postgres чужие без префикса)
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | awk '/^netmon-|^zabbix\// {print $2}' | xargs -r docker rmi -f || true
  rm -rf /opt/netmon
  log "NetMon удалён"
}

echo "== AIMon deploy =="

# 0) Очистка старого стека
if [[ "$CLEAN_NETMON" == "1" ]]; then
  clean_netmon
fi

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git openssl curl; }

# 2) Код проекта
if [[ -d "$TARGET/.git" ]]; then
  log "Updating $TARGET…"
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout "$BRANCH"
  git -C "$TARGET" pull origin "$BRANCH"
else
  log "Cloning into $TARGET…"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET"
fi

cd "$TARGET/aimon"

# 3) TLS
ensure_tls_cert "$(pwd)"

# 4) .env
if [[ ! -f .env ]]; then
  log "Creating .env with generated secrets…"
  cp .env.example .env
  gen() { python3 -c "import secrets;print(secrets.token_urlsafe(24))" 2>/dev/null || openssl rand -base64 24; }
  ADMIN_PW="$(gen)"
  MASTER="$(gen)"
  sed -i "s#^CHECKMK_ADMIN_PASSWORD=.*#CHECKMK_ADMIN_PASSWORD=${ADMIN_PW}#" .env
  sed -i "s#^SECRETS_MASTER_KEY=.*#SECRETS_MASTER_KEY=${MASTER}#" .env
  sed -i "s#^LOCAL_ACCESS_IP=.*#LOCAL_ACCESS_IP=${LOCAL_IP}#" .env
  umask 077
  printf '%s\n' "CHECKMK_ADMIN_PASSWORD=${ADMIN_PW}" > .admin-credentials
  printf '%s\n' "SECRETS_MASTER_KEY=${MASTER}" >> .admin-credentials
  chmod 600 .admin-credentials
  log "Admin password сохранён в $(pwd)/.admin-credentials"
else
  ADMIN_PW="$(grep '^CHECKMK_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
fi

# 5) Поднять стек (retry при DNS/registry сбоях)
log "Starting stack…"
pull_ok=0
for attempt in 1 2 3 4 5; do
  if docker compose pull 2>&1; then
    pull_ok=1
    break
  fi
  log "docker compose pull failed (attempt ${attempt}/5) — жду и повторяю…"
  # иногда 1.1.1.1 отдаёт только AAAA; пробуем системный DNS
  if [[ $attempt -eq 2 ]]; then
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >/etc/resolv.conf.tmp
    cat /etc/resolv.conf >>/etc/resolv.conf.tmp 2>/dev/null || true
    mv /etc/resolv.conf.tmp /etc/resolv.conf || true
  fi
  sleep $((attempt * 8))
done
[[ "$pull_ok" -eq 1 ]] || { echo "Не удалось скачать образы" >&2; exit 1; }
docker compose up -d --build

# 6) Ждём Checkmk (первый старт долгий)
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
echo
echo "== AIMon запущен =="
echo "Dashboard HTTP:  http://${PUBLIC_IP}:7081   |  http://${LOCAL_IP}:7081"
echo "Dashboard HTTPS: https://${PUBLIC_IP}:7444  |  https://${LOCAL_IP}:7444"
echo "Checkmk HTTP:    http://${PUBLIC_IP}:7080/${CHECKMK_SITE:-cmk}/"
echo "Checkmk HTTPS:   https://${PUBLIC_IP}:7443/${CHECKMK_SITE:-cmk}/"
echo "API HTTPS:       https://${PUBLIC_IP}:7445/api/v1/health"
echo "Agent port:      ${PUBLIC_IP}:10051"
echo
echo "Checkmk login: cmkadmin / (см. .admin-credentials)"
echo "Дальше: создайте automation secret в Checkmk и впишите CHECKMK_AUTOMATION_SECRET в .env,"
echo "затем: cd ${TARGET}/aimon && docker compose up -d api"
