# AIMon — AI-мониторинг на базе Checkmk

Новая платформа мониторинга: **Checkmk** как движок сбора телеметрии, собственный
**backend** (FastAPI) для управления и абстракции, современный **дашборд** и
**AI-ассистент** (DeepSeek) для онбординга, триажа и ответов на естественном языке.

Ключевые цели:

- **Автодобавление узлов** при установке агента (agent auto-registration).
- **Скан сегмента сети** на предмет SNMP-устройств и их добавление в мониторинг.
- **Красивый современный дашборд** (палитра coresupport.ru), крупные читаемые шрифты,
  анимированный AI-ассистент, полноценная работа с мобильного.
- **Полное управление** системой и всеми секретами (agent PSK/registration token, SNMP v2c/v3).
- **Деплой одной командой** и **установка агентов одной командой**.

## Структура

```
aimon/
├── dashboard/        # фронтенд (статичный, отдаётся nginx)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── api/              # backend (FastAPI) — абстракция над Checkmk REST API
│   ├── app/
│   ├── requirements.txt
│   └── Dockerfile
├── agents/           # one-command установщики агентов
│   ├── install-linux.sh
│   └── install-windows.ps1
├── compose.yaml      # Checkmk (raw) + api + dashboard (nginx)
├── deploy.sh         # one-command деплой на VPS
└── .env.example
```

## Быстрый старт (одна команда)

```bash
curl -fsSLk "https://RAW_HOST/aimon/deploy.sh" | sudo bash
```

Скрипт установит Docker и поднимет Checkmk + API + дашборд. После старта в консоли
будут URL и первичные секреты.

## Установка агента (одна команда)

Linux:

```bash
curl -fsSLk "https://HOST/agents/install-linux.sh" \
  | sudo bash -s -- --server HOST --token <REG_TOKEN> --hostname auto
```

Агент устанавливается, регистрируется и **сам появляется** в мониторинге
(host + service discovery + активация изменений выполняются автоматически).

См. `docs/AIMON_PROJECT.md` — архитектура и решения.
