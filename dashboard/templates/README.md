# Шаблоны Zabbix 7.0 (YAML)

Официальные шаблоны из ветки `release/7.0` репозитория [zabbix/zabbix](https://github.com/zabbix/zabbix).
Импорт: **Zabbix UI → Data collection → Templates → Import**.

## ОС (Agent)

| Каталог | Шаблон в UI | Файл |
|---------|-------------|------|
| `os/windows_agent_active` | Windows by Zabbix agent active | `template_os_windows_agent_active.yaml` |
| `os/windows_agent` | Windows by Zabbix agent | `template_os_windows_agent.yaml` |
| `os/linux_active` | Linux by Zabbix agent active | `template_os_linux_active.yaml` |
| `os/linux` | Linux by Zabbix agent | `template_os_linux.yaml` |

## Сеть / ICMP

| Каталог | Шаблон | Файл |
|---------|--------|------|
| `network/icmp_ping` | ICMP Ping | `template_module_icmp_ping.yaml` |
| `network/generic_device_snmp` | Network Generic Device by SNMP | `template_module_generic_snmp_snmp.yaml` |
| `network/mikrotik_snmp` | Mikrotik by SNMP | `template_net_mikrotik_snmp.yaml` |
| `network/cisco_ios_snmp` | Cisco IOS by SNMP | `template_net_cisco_snmp.yaml` |

## ИБП

| Каталог | Шаблон | Файл |
|---------|--------|------|
| `power/apc_ups_snmp` | APC UPS by SNMP | `template_power_apc_ups_snmp.yaml` |

## Импорт

1. Откройте Zabbix: `https://<server>:7443`
2. **Data collection → Templates → Import**
3. Выберите YAML-файл, оставьте Create new / Update existing
4. После импорта привяжите шаблон к host (мастер NetMon делает это автоматически при provisioning)

Скачать с dashboard: `/templates/...`
