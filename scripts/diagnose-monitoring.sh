#!/usr/bin/env bash
# Диагностика «нет данных» в Zabbix для NetMon.
# Запуск на хосте с /opt/netmon: sudo ./scripts/diagnose-monitoring.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
source .env
set +a

API="${ZABBIX_API_URL:-http://127.0.0.1:7080/api_jsonrpc.php}"
# Prefer published web port when URL is internal docker DNS
if [[ "$API" == *zabbix-web* ]]; then
  API="http://127.0.0.1:7080/api_jsonrpc.php"
fi

echo "== NetMon monitoring diagnosis =="
echo "API: $API"
echo

python3 - <<'PY'
import json, os, socket, struct, subprocess, urllib.request
from pathlib import Path

env = {}
for line in Path(".env").read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip().strip('"').strip("'")

api = os.environ.get("API_OVERRIDE") or (
    "http://127.0.0.1:7080/api_jsonrpc.php"
    if "zabbix-web" in env.get("ZABBIX_API_URL", "")
    else env.get("ZABBIX_API_URL", "http://127.0.0.1:7080/api_jsonrpc.php")
)
password = env.get("ZABBIX_API_PASSWORD", "")
user = env.get("ZABBIX_API_USER", "Admin")


def rpc(method, params, auth=None):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    if auth:
        payload["auth"] = auth
    req = urllib.request.Request(
        api, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    resp = json.load(urllib.request.urlopen(req, timeout=20))
    if "error" in resp:
        raise SystemExit(f"API error: {resp['error']}")
    return resp["result"]


def zabbix_get(ip: str, key: str, port: int = 10050) -> str:
    s = socket.create_connection((ip, port), 3)
    payload = key.encode()
    s.sendall(b"ZBXD\x01" + struct.pack("<Q", len(payload)) + payload)
    s.settimeout(3)
    data = b""
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
    except Exception as exc:  # noqa: BLE001
        s.close()
        return f"ERROR: {exc}"
    s.close()
    if data.startswith(b"ZBXD"):
        return data[13:].decode("utf-8", "replace")
    return repr(data[:120])


token = rpc("user.login", {"username": user, "password": password})
hosts = rpc(
    "host.get",
    {
        "output": ["hostid", "host", "name", "status"],
        "selectInterfaces": ["type", "ip", "port", "available", "error", "details"],
        "selectParentTemplates": ["name"],
    },
    token,
)

print(f"Hosts: {len(hosts)}\n")
for h in hosts:
    if h["host"] == "Zabbix server":
        continue
    print(f"## {h['host']} ({h['name']})")
    print("  templates:", ", ".join(t["name"] for t in h.get("parentTemplates") or []) or "(none)")
    for iface in h.get("interfaces") or []:
        avail = {"0": "unknown", "1": "available", "2": "unavailable"}.get(str(iface.get("available")), iface.get("available"))
        print(f"  interface type={iface['type']} {iface.get('ip')}:{iface.get('port')} avail={avail}")
        if iface.get("error"):
            print(f"    error: {iface['error']}")
        details = iface.get("details") or {}
        if str(iface.get("type")) == "2":
            print(
                "    snmp:",
                f"v{details.get('version')} user={details.get('securityname')!r}",
                f"level={details.get('securitylevel')}",
            )
            if details.get("authpassphrase") in {"change-me-auth", "", None}:
                print("    ⚠ SNMP auth passphrase is placeholder/empty — device will not answer")
        if str(iface.get("type")) == "1":
            ip = iface.get("ip")
            print(f"    agent.ping probe: {zabbix_get(ip, 'agent.ping')}")
            print(f"    agent.hostname: {zabbix_get(ip, 'agent.hostname')}")
            print("    Если Connection reset — на агенте Server= не содержит IP монитора (обычно 100.10.10.66).")
            print("    Для active-шаблона нужны ServerActive=<IP монитора> и Hostname=точное имя хоста в Zabbix.")

    items = rpc(
        "item.get",
        {
            "hostids": [h["hostid"]],
            "output": ["key_", "type", "error", "lastclock", "state"],
            "filter": {"status": 0},
        },
        token,
    )
    with_data = sum(1 for it in items if int(it.get("lastclock") or 0) > 0)
    errs = [it for it in items if it.get("error")]
    print(f"  items={len(items)} with_data={with_data} errors={len(errs)}")
    for it in errs[:5]:
        print(f"    ERR {it['key_']}: {it['error']}")
    print()

# fping check inside server container
print("## ICMP / fping (zabbix-server container)")
try:
    out = subprocess.check_output(
        ["docker", "compose", "exec", "-T", "zabbix-server", "sh", "-c", "fping -c1 -t500 1.1.1.1 2>&1 | tail -2"],
        text=True,
        timeout=15,
    )
    print(out)
except Exception as exc:  # noqa: BLE001
    print("fping check failed:", exc)

print(
    """
## Что обычно чинит «нет данных»
1) Linux/Windows agent (active):
   Server=100.10.10.66,94.181.181.43
   ServerActive=100.10.10.66
   Hostname=<точное Host name из Zabbix>
   systemctl restart zabbix-agent2

2) SNMP:
   На устройстве должен быть тот же SNMPv3 user/auth/priv, что в интерфейсе хоста Zabbix.
   Сейчас по умолчанию portal подставляет placeholder change-me-auth / change-me-priv —
   либо задайте реальные пароли в профиле, либо создайте такого пользователя на железе.

3) ICMP:
   В compose у zabbix-server не должно быть security_opt: no-new-privileges
   (ломает setuid fping).
"""
)
PY
