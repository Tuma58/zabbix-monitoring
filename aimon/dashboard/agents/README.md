# Дистрибутивы Checkmk Agent (зеркало AIMon)

Версия: **Checkmk 2.3.0p48 CRE**

Файлы хранятся в репозитории и раздаются AIMon Dashboard по URL `/agents/...`.

---

## Быстрая установка одной командой

### Linux (Ubuntu, Debian, RHEL / Alma / Rocky)

```bash
curl -fsSLk "https://HOST:7444/agents/install-linux.sh" \
  | sudo bash -s -- --server HOST --token <TOKEN> --hostname auto
```

или HTTP:

```bash
curl -fsSL "http://HOST:7081/agents/install-linux.sh" \
  | sudo bash -s -- --server HOST --token <TOKEN>
```

### Windows (PowerShell от администратора)

```powershell
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
& ([scriptblock]::Create((irm "https://HOST:7444/agents/install-windows.ps1"))) `
    -Server HOST -Token <TOKEN> -Hostname auto
```

---

## Файлы

### Linux

| Файл | Назначение |
|------|------------|
| `linux/check-mk-agent_2.3.0p48-1_all.deb` | Пакет для Ubuntu / Debian |
| `linux/check-mk-agent-2.3.0p48-1.noarch.rpm` | Пакет для RHEL / Alma / Rocky |
| `linux/check_mk_agent.linux` | Shell-агент (без пакетного менеджера) |
| `linux/cmk-agent-ctl` | Agent Controller (TLS, бинарник) |
| `linux/cmk-agent-ctl.gz` | Agent Controller (сжатый) |

### Windows

| Файл | Назначение |
|------|------------|
| `windows/check_mk_agent.msi` | Инсталлятор Windows-агента |

### Скрипты

| Файл | Назначение |
|------|------------|
| `install-linux.sh` | Установка + авторегистрация в AIMon (Linux) |
| `install-windows.ps1` | Установка + авторегистрация в AIMon (Windows) |

---

## Обновление зеркала

При обновлении Checkmk перезапустите `scripts/fetch-cmk-agents.sh`
(скрипт копирует пакеты из контейнера Checkmk и коммитит изменения).
