# Дистрибутивы Zabbix Agent (зеркало для NetMon)

Локальные пакеты **Zabbix 7.0.28**, доступны с dashboard по URL `/agents/...`.

## Windows

| Файл | Назначение |
|------|------------|
| `windows/zabbix_agent2-7.0.28-windows-amd64-openssl.msi` | **Рекомендуется** — Agent 2 MSI |
| `windows/zabbix_agent2-7.0.28-windows-amd64-openssl-static.zip` | Portable Agent 2 |
| `windows/zabbix_agent-7.0.28-windows-amd64-openssl.msi` | Классический Agent 1 |
| `windows/zabbix_agent-7.0.28-windows-amd64-openssl.zip` | Portable Agent 1 |

Скрипт: [`scripts/install-agent2-windows.ps1`](scripts/install-agent2-windows.ps1)

## Linux

| Файл | Назначение |
|------|------------|
| `linux/ubuntu/zabbix-release_*.deb` | Подключение репозитория Ubuntu 22.04 |
| `linux/debian/zabbix-release_*.deb` | Репозиторий Debian 12 |
| `linux/rhel/zabbix-release-*.rpm` | Репозиторий RHEL 9 / Alma / Rocky |
| `linux/zabbix_agent-*-linux-*-static.tar.gz` | Статический Agent 1 (без package manager) |

Скрипты:

- [`scripts/install-agent2-debian-ubuntu.sh`](scripts/install-agent2-debian-ubuntu.sh)
- [`scripts/install-agent2-rhel.sh`](scripts/install-agent2-rhel.sh)

## Конфиги

- [`configs/zabbix_agent2.conf.example`](configs/zabbix_agent2.conf.example)
- [`configs/zabbix_agent2.active-only.conf.example`](configs/zabbix_agent2.active-only.conf.example)

## Обновление зеркала

```bash
sudo ./scripts/fetch-zabbix-assets.sh
```
