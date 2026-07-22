# Дистрибутивы Zabbix Agent (зеркало для NetMon)

Локальные пакеты **Zabbix 7.0.28**, лежат в git и отдаются dashboard по URL `/agents/...`.

## Деплой одной командой

Подставьте адрес вашего dashboard (обычно `https://PUBLIC_IP:7444`) и имя хоста агента.

### Linux (Ubuntu 22.04/24.04, Debian 12, RHEL/Alma/Rocky 9)

```bash
curl -fsSL "https://HOST:7444/agents/scripts/deploy-agent2-linux.sh" \
  | sudo bash -s -- --base "https://HOST:7444" --server HOST --hostname my-linux-host
```

Скрипт: [`scripts/deploy-agent2-linux.sh`](scripts/deploy-agent2-linux.sh)

### Windows (PowerShell от администратора)

```powershell
& ([scriptblock]::Create((irm "https://HOST:7444/agents/scripts/deploy-agent2-windows.ps1"))) `
  -BaseUrl "https://HOST:7444" -ZabbixServer HOST -Hostname win-srv-01
```

Скрипт: [`scripts/deploy-agent2-windows.ps1`](scripts/deploy-agent2-windows.ps1)

## Windows (ручная установка)

| Файл | Назначение |
|------|------------|
| `windows/zabbix_agent2-7.0.28-windows-amd64-openssl.msi` | **Рекомендуется** — Agent 2 MSI |
| `windows/zabbix_agent2-7.0.28-windows-amd64-openssl-static.zip` | Portable Agent 2 |
| `windows/zabbix_agent-7.0.28-windows-amd64-openssl.msi` | Классический Agent 1 |
| `windows/zabbix_agent-7.0.28-windows-amd64-openssl.zip` | Portable Agent 1 |

Локальный скрипт (MSI рядом): [`scripts/install-agent2-windows.ps1`](scripts/install-agent2-windows.ps1)

## Linux (ручная установка)

| Файл | Назначение |
|------|------------|
| `linux/ubuntu/zabbix-release_*.deb` | Подключение репозитория Ubuntu 22.04 |
| `linux/debian/zabbix-release_*.deb` | Репозиторий Debian 12 |
| `linux/rhel/zabbix-release-*.rpm` | Репозиторий RHEL 9 / Alma / Rocky |
| `linux/zabbix_agent-*-linux-*-static.tar.gz` | Статический Agent 1 (без package manager) |

Скрипты (работают от файлов в дереве репозитория):

- [`scripts/install-agent2-debian-ubuntu.sh`](scripts/install-agent2-debian-ubuntu.sh)
- [`scripts/install-agent2-rhel.sh`](scripts/install-agent2-rhel.sh)

## Конфиги

- [`configs/zabbix_agent2.conf.example`](configs/zabbix_agent2.conf.example)
- [`configs/zabbix_agent2.active-only.conf.example`](configs/zabbix_agent2.active-only.conf.example)

## Обновление зеркала

```bash
sudo ./scripts/fetch-zabbix-assets.sh
```
