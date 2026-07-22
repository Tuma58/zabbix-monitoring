(() => {
  'use strict';

  const ASSETS = {
    winAgent2Msi: '/agents/windows/zabbix_agent2-7.0.28-windows-amd64-openssl.msi',
    winAgent2Zip: '/agents/windows/zabbix_agent2-7.0.28-windows-amd64-openssl-static.zip',
    winAgentMsi: '/agents/windows/zabbix_agent-7.0.28-windows-amd64-openssl.msi',
    ubuntuRelease: '/agents/linux/ubuntu/zabbix-release_7.0-2+ubuntu22.04_all.deb',
    debianRelease: '/agents/linux/debian/zabbix-release_latest_7.0+debian12_all.deb',
    rhelRelease: '/agents/linux/rhel/zabbix-release-latest-7.0.el9.noarch.rpm',
    linuxStatic: '/agents/linux/zabbix_agent-7.0.28-linux-3.0-amd64-static.tar.gz',
    ps1Install: '/agents/scripts/install-agent2-windows.ps1',
    ps1Deploy: '/agents/scripts/deploy-agent2-windows.ps1',
    shDebUbuntu: '/agents/scripts/install-agent2-debian-ubuntu.sh',
    shRhel: '/agents/scripts/install-agent2-rhel.sh',
    shDeployLinux: '/agents/scripts/deploy-agent2-linux.sh',
    confExample: '/agents/configs/zabbix_agent2.conf.example',
    agentsReadme: '/agents/README.md',
    tplWinActive: '/templates/os/windows_agent_active/template_os_windows_agent_active.yaml',
    tplLinuxActive: '/templates/os/linux_active/template_os_linux_active.yaml',
    tplWinPassive: '/templates/os/windows_agent/template_os_windows_agent.yaml',
    tplLinuxPassive: '/templates/os/linux/template_os_linux.yaml',
    tplIcmp: '/templates/network/icmp_ping/template_module_icmp_ping.yaml',
    tplGenericSnmp: '/templates/network/generic_device_snmp/template_module_generic_snmp_snmp.yaml',
    tplMikrotik: '/templates/network/mikrotik_snmp/template_net_mikrotik_snmp.yaml',
    tplCisco: '/templates/network/cisco_ios_snmp/template_net_cisco_snmp.yaml',
    tplApc: '/templates/power/apc_ups_snmp/template_power_apc_ups_snmp.yaml',
    templatesReadme: '/templates/README.md',
  };

  function serverHost() {
    return window.location.hostname || 'ZABBIX_SERVER_IP';
  }

  function serverUrl() {
    return window.location.origin || `${window.location.protocol}//${window.location.hostname}`;
  }

  function assetUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return `${serverUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  }

  const SUBTYPES = {
    server: [
      { value: 'win', label: 'Windows Server' },
      { value: 'linux', label: 'Linux Server' },
    ],
    computer: [
      { value: 'win', label: 'Windows (рабочая станция)' },
      { value: 'linux', label: 'Linux (рабочая станция)' },
    ],
    router: [
      { value: 'mikrotik', label: 'MikroTik (RouterOS)' },
      { value: 'keenetic', label: 'Keenetic' },
      { value: 'cisco', label: 'Cisco' },
      { value: 'dlink', label: 'D-Link' },
      { value: 'tplink', label: 'TP-Link' },
      { value: 'hp', label: 'HP / Aruba' },
    ],
    ups: [
      { value: 'apc', label: 'APC (Smart-UPS, SRT, SMC)' },
      { value: 'eaton', label: 'Eaton / IPPON (SNMP-карта)' },
      { value: 'cyberpower', label: 'CyberPower' },
      { value: 'parallels', label: 'Proчие (SNMP UPS)' },
    ],
  };

  function link(href, text) {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }

  function steps(items) {
    return `<ol class="guide-steps">${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;
  }

  function links(items) {
    return `<ul class="guide-links">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  }

  function callout(html) {
    return `<div class="guide-callout">${html}</div>`;
  }

  function warn(html) {
    return `<div class="guide-warn">${html}</div>`;
  }

  function pre(code) {
    return `<pre class="guide-pre">${code}</pre>`;
  }

  function section(title, html) {
    return `<section class="guide-section"><h5>${title}</h5>${html}</section>`;
  }

  function kv(pairs) {
    const rows = pairs
      .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
      .join('');
    return `<table class="guide-kv"><tbody>${rows}</tbody></table>`;
  }

  function host() {
    return serverHost();
  }

  function agentConfSnippet(hostnameHint) {
    return pre(
      `Server=${host()}\n`
      + `ServerActive=${host()}\n`
      + `Hostname=${hostnameHint}\n`
      + `# ListenPort=10050\n`
      + `# Timeout=10`,
    );
  }

  function windowsAgentBody(opts) {
    const {
      roleLabel,
      hostnameExample,
      extraNotes,
    } = opts;

    return `
      <p>Подключение ${roleLabel} к NetMon выполняется через <strong>Zabbix agent 2</strong>
      (active checks: агент сам отправляет данные на сервер, TCP <code>10051</code>).
      Пакеты и скрипты скачиваются с <strong>локального зеркала</strong> дашборда — интернет на целевом хосте не обязателен.</p>

      ${callout(`Адрес сервера мониторинга (подставляется автоматически): <code>${host()}</code>.
        Базовый URL зеркала: <code>${serverUrl()}</code>.`)}

      ${section('0. Деплой одной командой (рекомендуется)', `
        <p>PowerShell <strong>от имени администратора</strong> на целевом Windows-хосте:</p>
        ${pre(
          `& ([scriptblock]::Create((irm "${assetUrl(ASSETS.ps1Deploy)}"))) \`\n`
          + `  -BaseUrl "${serverUrl()}" -ZabbixServer ${host()} -Hostname ${hostnameExample}`,
        )}
        <p>Скрипт скачает MSI с зеркала, установит Agent 2 и пропишет Server / ServerActive / Hostname.</p>
        ${links([
          link(ASSETS.ps1Deploy, 'deploy-agent2-windows.ps1 — one-command'),
        ])}
      `)}

      ${section('1. Предварительные требования', `
        ${steps([
          `Права локального администратора на ${roleLabel}.`,
          'Доступ к дашборду NetMon из браузера или с машины, с которой копируете MSI/скрипт.',
          `Сетевая связность до <code>${host()}</code>: исходящий TCP <code>10051</code> (active) и при необходимости входящий TCP <code>10050</code> (passive).`,
          'Антивирус/EDR не должен блокировать службу <code>Zabbix Agent 2</code> и каталог установки.',
          'Имя хоста в конфиге агента должно <strong>точно совпадать</strong> с полем Host name в Zabbix UI.',
        ])}
        ${warn('Не используйте пробелы и кириллицу в <code>Hostname</code>. Рекомендуемый формат: латиница, цифры, дефис (например <code>' + hostnameExample + '</code>).')}
      `)}

      ${section('2. Скачивание с локального зеркала', `
        <p>Откройте ссылки ниже с машины администратора или скачайте напрямую на целевой сервер/ПК:</p>
        ${links([
          link(ASSETS.winAgent2Msi, 'Zabbix agent 2 7.0.28 — MSI (amd64, OpenSSL)'),
          link(ASSETS.winAgent2Zip, 'Zabbix agent 2 — static ZIP (без установщика)'),
          link(ASSETS.winAgentMsi, 'Zabbix agent (классический) 7.0.28 — MSI (только при необходимости)'),
          link(ASSETS.ps1Deploy, 'Скрипт one-command deploy-agent2-windows.ps1'),
          link(ASSETS.ps1Install, 'Скрипт тихой установки install-agent2-windows.ps1 (локальный MSI)'),
          link(ASSETS.confExample, 'Пример конфига zabbix_agent2.conf.example'),
          link(ASSETS.agentsReadme, 'README по агентам'),
        ])}
        ${callout('Предпочтительно: <strong>agent 2 MSI</strong> через one-command скрипт. Классический agent используйте только если политика безопасности запрещает agent 2.')}
      `)}

      ${section('3. Установка (GUI или тихий MSI)', `
        <p><strong>Вариант A — графический установщик:</strong> запустите MSI, выберите путь по умолчанию
        <code>C:\\Program Files\\Zabbix Agent 2\\</code>, в мастере укажите Server / ServerActive = <code>${host()}</code>
        и Hostname = <code>${hostnameExample}</code>.</p>
        <p><strong>Вариант B — тихая установка из PowerShell (от имени администратора):</strong></p>
        ${pre(
          `$msi = "$env:TEMP\\zabbix_agent2-7.0.28-windows-amd64-openssl.msi"\n`
          + `Invoke-WebRequest -Uri "${assetUrl(ASSETS.winAgent2Msi)}" -OutFile $msi\n`
          + `msiexec /i $msi /qn /norestart \`\n`
          + `  SERVER=${host()} \`\n`
          + `  SERVERACTIVE=${host()} \`\n`
          + `  HOSTNAME=${hostnameExample} \`\n`
          + `  ENABLEPATH=1`,
        )}
        <p>Либо скачайте и выполните локальный скрипт зеркала (нужен уже скачанный MSI рядом):</p>
        ${pre(
          `Invoke-WebRequest -Uri "${assetUrl(ASSETS.ps1Install)}" -OutFile .\\install-agent2-windows.ps1\n`
          + `powershell -ExecutionPolicy Bypass -File .\\install-agent2-windows.ps1 \`\n`
          + `  -ZabbixServer ${host()} -Hostname ${hostnameExample}`,
        )}
      `)}

      ${section('4. Конфигурация агента', `
        <p>Основной файл:</p>
        ${kv([
          ['Путь к конфигу', '<code>C:\\Program Files\\Zabbix Agent 2\\zabbix_agent2.conf</code>'],
          ['Служба Windows', '<code>Zabbix Agent 2</code>'],
          ['Логи (типично)', '<code>C:\\Program Files\\Zabbix Agent 2\\zabbix_agent2.log</code>'],
          ['Passive port', '<code>10050/TCP</code> (входящий)'],
          ['Active port на сервере', '<code>10051/TCP</code> (исходящий с агента)'],
        ])}
        <p>Обязательные ключи (после правки сохраните файл в UTF-8 без BOM):</p>
        ${agentConfSnippet(hostnameExample)}
        <p>Перезапуск службы:</p>
        ${pre(
          `Restart-Service "Zabbix Agent 2"\n`
          + `Get-Service "Zabbix Agent 2"\n`
          + `Get-Content "C:\\Program Files\\Zabbix Agent 2\\zabbix_agent2.log" -Tail 40`,
        )}
      `)}

      ${section('5. Брандмауэр Windows', `
        ${steps([
          `Разрешите <strong>исходящий</strong> TCP <code>10051</code> к <code>${host()}</code> (для active checks обязательно).`,
          'Для passive checks добавьте входящее правило TCP <code>10050</code> только с IP сервера NetMon.',
          'Проверка из PowerShell на целевом хосте:',
        ])}
        ${pre(`Test-NetConnection -ComputerName ${host()} -Port 10051`)}
        ${callout('Ожидайте <code>TcpTestSucceeded : True</code>. Если False — проверьте ACL на маршрутизаторе, NSG/firewall и что процесс <code>zabbix_server</code>/<code>zabbix_proxy</code> слушает 10051.')}
      `)}

      ${section('6. Импорт шаблона из локального YAML', `
        <p>В Zabbix UI: <strong>Data collection → Templates → Import</strong>. Загрузите файл с зеркала:</p>
        ${links([
          link(ASSETS.tplWinActive, 'template_os_windows_agent_active.yaml (рекомендуется)'),
          link(ASSETS.tplWinPassive, 'template_os_windows_agent.yaml (passive / смешанный режим)'),
          link(ASSETS.templatesReadme, 'README по шаблонам'),
        ])}
        ${steps([
          'Выберите файл YAML, оставьте Create new / Update existing по необходимости.',
          'После импорта шаблон появится в списке (обычно <em>Windows by Zabbix agent active</em>).',
        ])}
      `)}

      ${section('7. Создание host в Zabbix UI', `
        ${steps([
          'Откройте <strong>Data collection → Hosts → Create host</strong>.',
          `Host name = <code>${hostnameExample}</code> (строго как в <code>Hostname=</code> агента).`,
          `Visible name — произвольное удобное имя (например «${roleLabel}»).`,
          'Groups: выберите группу (Servers / Workstations).',
          'Interfaces: для active-only можно добавить Agent interface с IP хоста (порт 10050) — даже если passive не используете, интерфейс часто нужен шаблонам.',
          'Templates: привяжите <em>Windows by Zabbix agent active</em> (импортированный YAML).',
          'Macros (опционально): <code>{$AGENT.TIMEOUT}</code>, кастомные пороги дисков.',
          'Сохраните host. Статус Availability перейдёт в зелёный после первых успешных данных.',
        ])}
      `)}

      ${section('8. Проверка сбора данных', `
        ${steps([
          'Monitoring → Latest data → фильтр по host: появятся CPU, memory, disk, network, services.',
          'Monitoring → Problems: убедитесь, что нет «Zabbix agent is not available».',
          'На агенте в логе не должно быть <code>Unable to connect</code> / <code>active check configuration update from ... failed</code>.',
        ])}
        ${extraNotes || ''}
      `)}

      ${section('9. Типовые проблемы', `
        ${kv([
          ['Hostname mismatch', 'Имя в conf ≠ Host name в UI → active items не привязываются.'],
          ['Firewall 10051', 'Test-NetConnection падает → агент не достучится до ServerActive.'],
          ['Служба Stopped', 'Проверьте MSI-параметры и права на каталог Program Files.'],
          ['TLS/PSK', 'Если включён encryption на сервере — настройте TLSConnect/TLSAccept в conf.'],
          ['Дубликат Hostname', 'Два агента с одним Hostname конфликтуют — переименуйте.'],
        ])}
      `)}
    `;
  }

  function linuxAgentBody(opts) {
    const {
      roleLabel,
      hostnameExample,
      extraNotes,
    } = opts;

    return `
      <p>Подключение ${roleLabel} к NetMon — через <strong>zabbix-agent2</strong> (active checks на порт
      <code>10051</code>). Репозитории и скрипты берутся с <strong>локального зеркала</strong> дашборда.</p>

      ${callout(`Сервер мониторинга: <code>${host()}</code>. Зеркало: <code>${serverUrl()}</code>.`)}

      ${section('0. Деплой одной командой (рекомендуется)', `
        <p>На целевом Linux-хосте (root / sudo):</p>
        ${pre(
          `curl -fsSL "${assetUrl(ASSETS.shDeployLinux)}" | sudo bash -s -- \\\n`
          + `  --base "${serverUrl()}" --server ${host()} --hostname ${hostnameExample}`,
        )}
        <p>Скрипт определит дистрибутив (Ubuntu/Debian/RHEL), скачает release-пакет с зеркала, установит
        <code>zabbix-agent2</code> и пропишет Server / ServerActive / Hostname.</p>
        ${links([
          link(ASSETS.shDeployLinux, 'deploy-agent2-linux.sh — one-command'),
        ])}
      `)}

      ${section('1. Предварительные требования', `
        ${steps([
          'Права root / sudo на целевой системе.',
          'Дистрибутив: Ubuntu 22.04+, Debian 12+, RHEL/Alma/Rocky 9+ (или static tarball для прочих).',
          `Исходящий TCP <code>10051</code> до <code>${host()}</code>.`,
          'Свободное имя Hostname, совпадающее с Host name в Zabbix.',
          'SELinux/AppArmor: при enforcing-режиме разрешите агенту сеть и чтение /proc.',
        ])}
      `)}

      ${section('2. Скачивание пакетов с зеркала', `
        ${links([
          link(ASSETS.ubuntuRelease, 'zabbix-release (Ubuntu 22.04)'),
          link(ASSETS.debianRelease, 'zabbix-release (Debian 12)'),
          link(ASSETS.rhelRelease, 'zabbix-release (RHEL 9 / Alma / Rocky)'),
          link(ASSETS.linuxStatic, 'Static tarball agent (без репозитория)'),
          link(ASSETS.shDeployLinux, 'Скрипт deploy-agent2-linux.sh (one-command)'),
          link(ASSETS.shDebUbuntu, 'Скрипт install-agent2-debian-ubuntu.sh (локальные файлы)'),
          link(ASSETS.shRhel, 'Скрипт install-agent2-rhel.sh (локальные файлы)'),
          link(ASSETS.confExample, 'Пример zabbix_agent2.conf.example'),
          link(ASSETS.agentsReadme, 'README по агентам'),
        ])}
      `)}

      ${section('3. Установка на Ubuntu / Debian', `
        ${pre(
          `# Ubuntu 22.04\n`
          + `curl -fsSL -o /tmp/zabbix-release.deb "${assetUrl(ASSETS.ubuntuRelease)}"\n`
          + `sudo dpkg -i /tmp/zabbix-release.deb\n`
          + `sudo apt-get update\n`
          + `sudo apt-get install -y zabbix-agent2\n\n`
          + `# Debian 12 — тот же порядок, но release-пакет:\n`
          + `# curl -fsSL -o /tmp/zabbix-release.deb "${assetUrl(ASSETS.debianRelease)}"`,
        )}
        <p>Или скриптом зеркала (если пакеты уже лежат рядом со скриптом):</p>
        ${pre(
          `curl -fsSL -o /tmp/install-agent2-debian-ubuntu.sh "${assetUrl(ASSETS.shDebUbuntu)}"\n`
          + `sudo bash /tmp/install-agent2-debian-ubuntu.sh ${host()} ${hostnameExample}`,
        )}
      `)}

      ${section('4. Установка на RHEL / Alma / Rocky', `
        ${pre(
          `curl -fsSL -o /tmp/zabbix-release.rpm "${assetUrl(ASSETS.rhelRelease)}"\n`
          + `sudo rpm -Uvh /tmp/zabbix-release.rpm\n`
          + `sudo dnf install -y zabbix-agent2\n\n`
          + `# или:\n`
          + `curl -fsSL -o /tmp/install-agent2-rhel.sh "${assetUrl(ASSETS.shRhel)}"\n`
          + `sudo bash /tmp/install-agent2-rhel.sh ${host()} ${hostnameExample}`,
        )}
      `)}

      ${section('5. Конфигурация', `
        <p>Файл: <code>/etc/zabbix/zabbix_agent2.conf</code></p>
        ${agentConfSnippet(hostnameExample)}
        <p>Можно сверить с примером с зеркала:</p>
        ${pre(`curl -fsSL "${assetUrl(ASSETS.confExample)}" | less`)}
        <p>Запуск и автозагрузка:</p>
        ${pre(
          `sudo systemctl enable --now zabbix-agent2\n`
          + `sudo systemctl status zabbix-agent2 --no-pager\n`
          + `sudo journalctl -u zabbix-agent2 -n 50 --no-pager`,
        )}
      `)}

      ${section('6. Firewall и проверка сети', `
        ${steps([
          `Исходящий доступ к <code>${host()}:10051</code> должен быть открыт.`,
          'Для passive: <code>firewall-cmd --add-port=10050/tcp --permanent && firewall-cmd --reload</code> (или ufw allow from SERVER to any port 10050).',
        ])}
        ${pre(
          `ss -lntp | grep 10050 || true\n`
          + `curl -v telnet://${host()}:10051\n`
          + `# либо: nc -vz ${host()} 10051`,
        )}
        ${warn('Если <code>curl</code>/<code>nc</code> не открывают сессию — active checks работать не будут, пока не исправите маршрутизацию/ACL.')}
      `)}

      ${section('7. Импорт шаблона YAML', `
        <p>Zabbix UI → <strong>Data collection → Templates → Import</strong>:</p>
        ${links([
          link(ASSETS.tplLinuxActive, 'template_os_linux_active.yaml (рекомендуется)'),
          link(ASSETS.tplLinuxPassive, 'template_os_linux.yaml (passive)'),
          link(ASSETS.templatesReadme, 'README по шаблонам'),
        ])}
      `)}

      ${section('8. Создание host в UI', `
        ${steps([
          'Data collection → Hosts → Create host.',
          `Host name = <code>${hostnameExample}</code> (= параметр Hostname в conf).`,
          'Groups: Linux servers / Workstations.',
          'Agent interface: IP целевого хоста, port 10050.',
          'Templates: <em>Linux by Zabbix agent active</em>.',
          'Сохраните и дождитесь зелёного Availability / появления Latest data.',
        ])}
      `)}

      ${section('9. Верификация', `
        ${pre(
          `sudo zabbix_agent2 -t agent.hostname\n`
          + `sudo zabbix_agent2 -t system.uname\n`
          + `sudo zabbix_agent2 -t vfs.fs.size[/,pused]`,
        )}
        ${extraNotes || ''}
      `)}

      ${section('10. Troubleshooting', `
        ${kv([
          ['unit failed', 'journalctl -u zabbix-agent2; проверьте синтаксис conf.'],
          ['Permission denied /proc', 'SELinux: setsebool / custom policy или временно permissive для диагностики.'],
          ['No data', 'Hostname mismatch или закрыт 10051.'],
          ['Conflict ListenIP', 'Укажите ListenIP=0.0.0.0 или конкретный адрес интерфейса.'],
        ])}
      `)}
    `;
  }

  function snmpCommonPrereqs(deviceLabel) {
    return section('1. Предварительные требования', `
      ${steps([
        `${deviceLabel} доступно по IP из management-сети (reachability с хоста NetMon).`,
        'Предпочтительно <strong>SNMPv3 authPriv</strong> (аутентификация + шифрование). SNMPv2c — только в изолированных сегментах.',
        `С хоста мониторинга открыт UDP <code>161</code> к устройству; обратные ACL не режут ответы.`,
        'Заранее подготовлены: username, auth protocol (SHA/SHA256), priv protocol (AES), пароли auth/priv.',
        'Community <code>public</code>/<code>private</code> в production <strong>запрещены</strong>.',
      ])}
      ${callout(`Адрес Zabbix/NetMon для ACL: <code>${host()}</code>. Разрешайте SNMP только с этого IP (или подсети proxy).`)}
    `);
  }

  function snmpAclAndWalk(extraOid) {
    const oid = extraOid || '1.3.6.1.2.1.1';
    return section('Проверка snmpwalk с сервера NetMon', `
      <p>SNMPv3 (рекомендуется):</p>
      ${pre(
        `snmpwalk -v3 -l authPriv \\\n`
        + `  -u netmon_ro \\\n`
        + `  -a SHA -A 'AUTH_PASSWORD' \\\n`
        + `  -x AES -X 'PRIV_PASSWORD' \\\n`
        + `  DEVICE_IP ${oid}`,
      )}
      <p>SNMPv2c (только если v3 недоступен):</p>
      ${pre(`snmpwalk -v2c -c 'SECURE_COMMUNITY' DEVICE_IP ${oid}`)}
      ${warn('Если timeout — проверьте UDP 161, VRF management, ACL и что SNMP включён на нужном интерфейсе.')}
    `);
  }

  function snmpZabbixHostSteps(templateName, templateLink, templateLabel) {
    return `
      ${section('Импорт шаблона с локального зеркала', `
        <p>Data collection → Templates → Import:</p>
        ${links([
          link(templateLink, templateLabel),
          link(ASSETS.tplGenericSnmp, 'Запасной: template_module_generic_snmp_snmp.yaml'),
          link(ASSETS.templatesReadme, 'README по шаблонам'),
        ])}
      `)}
      ${section('Создание host в Zabbix UI', `
        ${steps([
          'Data collection → Hosts → Create host.',
          'Host name — уникальный идентификатор (латиница).',
          'Interfaces → Add → SNMP: IP устройства, port <code>161</code>, SNMP version <code>SNMPv3</code>.',
          'Заполните Context name (часто пусто), Security name, Security level <code>authPriv</code>, Auth/Priv protocol и пароли.',
          `Templates: привяжите <em>${templateName}</em>.`,
          'Macros при необходимости: <code>{$SNMP.TIMEOUT}</code>, пороги интерфейсов.',
          'Сохраните. Availability SNMP станет зелёным после успешного опроса.',
        ])}
      `)}
    `;
  }

  const GUIDES = {
    'server:win': {
      title: 'Сервер Windows — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Windows by Zabbix agent active',
      body: windowsAgentBody({
        roleLabel: 'сервера Windows Server',
        hostnameExample: 'srv-app-01',
        extraNotes: callout('Для кластеров/Hyper-V: ставьте агент на каждый узел с уникальным Hostname; гостевые ВМ мониторьте отдельно.'),
      }),
    },

    'server:linux': {
      title: 'Сервер Linux — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Linux by Zabbix agent active',
      body: linuxAgentBody({
        roleLabel: 'Linux-сервера',
        hostnameExample: 'srv-linux-01',
        extraNotes: callout('Для Docker/KVM-хостов после базового шаблона можно добавить LLD дисков и systemd units.'),
      }),
    },

    'computer:win': {
      title: 'Рабочая станция Windows — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Windows by Zabbix agent active',
      body: windowsAgentBody({
        roleLabel: 'рабочей станции Windows 10/11',
        hostnameExample: 'pc-office-ivanov',
        extraNotes: `
          ${callout('На ноутбуках обычно достаточно active-only: не открывайте входящий 10050 в публичных сетях.')}
          ${section('Дополнительно для ПК', steps([
            'Используйте уникальный Hostname на каждого пользователя/ПК.',
            'Через GPO можно распространить MSI и conf (ServerActive уже задан).',
            'VPN: убедитесь, что маршрут к NetMon есть при подключении к корпоративной сети.',
          ]))}
        `,
      }),
    },

    'computer:linux': {
      title: 'Рабочая станция Linux — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Linux by Zabbix agent active',
      body: linuxAgentBody({
        roleLabel: 'рабочей станции Linux',
        hostnameExample: 'ws-linux-anna',
        extraNotes: callout('На laptop с NetworkManager проверьте, что после смены Wi‑Fi агент снова достучится до ServerActive.'),
      }),
    },

    'router:mikrotik': {
      title: 'MikroTik RouterOS — SNMP',
      protocol: 'SNMPv3',
      template: 'MikroTik by SNMP',
      body: `
        <p>Мониторинг MikroTik (RouterOS 6/7) через <strong>SNMPv3 authPriv</strong>.
        Шаблон и generic SNMP берутся с локального зеркала NetMon.</p>
        ${snmpCommonPrereqs('MikroTik')}

        ${section('2. Включение SNMP в RouterOS', `
          <p>CLI (WinBox / SSH / Terminal):</p>
          ${pre(
            `/snmp set enabled=yes contact="NOC" location="DC1-RACK"\n`
            + `/snmp community remove [find where name=public]\n\n`
            + `# SNMPv3 user (пример)\n`
            + `/user group add name=snmp_ro policy=read,test,api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!password,!sniff,!sensitive,!romon\n`
            + `/user add name=netmon_ro group=snmp_ro password="LOCAL_LOGIN_PASS"\n\n`
            + `/snmp community add name=netmon_ro addresses=${host()}/32 security=private \\
    authentication-protocol=SHA1 encryption-protocol=AES \\
    authentication-password="AUTH_PASSWORD" encryption-password="PRIV_PASSWORD" \\
    read-access=yes write-access=no`,
          )}
          <p>В WinBox: <strong>IP → SNMP</strong> — Enabled, Contact/Location; вкладка Communities — создайте community/security с authPriv.</p>
        `)}

        ${section('3. ACL / firewall UDP 161', `
          ${steps([
            `Разрешите вход UDP 161 только с <code>${host()}</code> (filter input chain).`,
            'На устройствах с несколькими VRF/WAN не публикуйте SNMP на внешний интерфейс.',
            'Проверьте, что management IP маршрутизатора доступен с NetMon (ping / traceroute).',
          ])}
          ${pre(
            `/ip firewall filter add chain=input protocol=udp dst-port=161 \\
    src-address=${host()} action=accept comment="Zabbix SNMP" place-before=0\n`
            + `/ip firewall filter add chain=input protocol=udp dst-port=161 action=drop comment="block other SNMP"`,
          )}
        `)}

        ${snmpAclAndWalk('1.3.6.1.4.1.14988')}
        ${snmpZabbixHostSteps(
          'MikroTik by SNMP',
          ASSETS.tplMikrotik,
          'template_net_mikrotik_snmp.yaml',
        )}

        ${section('Troubleshooting MikroTik', `
          ${kv([
            ['empty walk', 'SNMP disabled или community без read-access.'],
            ['partial OID', 'Старый RouterOS — обновите; часть MIB появляется только на ROS7.'],
            ['high CPU', 'Увеличьте SNMP timeout / уменьшите частоту discovery в шаблоне.'],
          ])}
        `)}
      `,
    },

    'router:keenetic': {
      title: 'Keenetic — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Роутеры Keenetic (OS 3.x+) с компонентом SNMP. Для production — SNMPv3;
        если модель отдаёт только v2c — ограничьте community ACL по IP NetMon.</p>
        ${snmpCommonPrereqs('Keenetic')}

        ${section('2. Включение SNMP в веб-интерфейсе', `
          ${steps([
            'Войдите в веб-UI Keenetic (обычно http://192.168.1.1).',
            'Управление → Общие настройки / Приложения и компоненты — установите компонент <strong>SNMP</strong>, если не установлен.',
            'Откройте параметры SNMP: включите службу, задайте community (v2c) или учётную запись SNMPv3.',
            'Укажите system contact / location для удобства инвентаризации.',
            `В фильтрах доступа разрешите опрос только с <code>${host()}</code>.`,
          ])}
          ${warn('На домашних прошивках часть OID Wi‑Fi/клиентов может отсутствовать — базовый шаблон Generic SNMP всё равно даст sysUpTime, интерфейсы, трафик.')}
        `)}

        ${section('3. Сеть и UDP 161', `
          ${steps([
            'Keenetic должен быть в management VLAN, доступном с NetMon.',
            'Проверьте, что «Межсетевой экран» не блокирует UDP 161 с IP сервера.',
            'При Dual-WAN SNMP слушайте на LAN/management, не на публичном WAN.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}

        ${section('Дополнительно', `
          ${links([
            link(ASSETS.tplIcmp, 'Параллельно можно добавить ICMP Ping: template_module_icmp_ping.yaml'),
          ])}
          ${callout('Для клиентов Wi‑Fi и гостевых сетей часто нужны отдельные OID/скрипты — начните с generic SNMP, затем расширяйте items.')}
        `)}
      `,
    },

    'router:cisco': {
      title: 'Cisco IOS / IOS-XE — SNMP',
      protocol: 'SNMPv3',
      template: 'Cisco IOS by SNMP',
      body: `
        <p>Коммутаторы и маршрутизаторы Cisco (IOS, IOS-XE; частично NX-OS) —
        мониторинг через <strong>SNMPv3 authPriv</strong> и локальный шаблон Cisco.</p>
        ${snmpCommonPrereqs('Cisco')}

        ${section('2. Конфигурация SNMPv3 на устройстве', `
          ${pre(
            `configure terminal\n`
            + `access-list 99 permit host ${host()}\n`
            + `access-list 99 deny any\n\n`
            + `snmp-server view NETMON_VIEW internet included\n`
            + `snmp-server group ZABBIX v3 priv read NETMON_VIEW access 99\n`
            + `snmp-server user netmon_ro ZABBIX v3 auth sha AUTH_PASSWORD priv aes 128 PRIV_PASSWORD\n`
            + `snmp-server location DC1\n`
            + `snmp-server contact NOC\n`
            + `snmp-server enable traps\n`
            + `snmp-server host ${host()} version 3 priv netmon_ro\n`
            + `end\n`
            + `write memory`,
          )}
          ${callout('На NX-OS синтаксис отличается (snmp-server user … auth … priv …), но модель authPriv та же. Ограничьте SNMP ACL management VRF.')}
        `)}

        ${section('3. ACL и control-plane', `
          ${steps([
            `Разрешите UDP 161 только с <code>${host()}</code>.`,
            'На edge-устройствах не слушайте SNMP на внешних интерфейсах.',
            'Проверьте CoPP: SNMP не должен дропаться политикой control-plane.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.4.1.9')}
        ${snmpZabbixHostSteps(
          'Cisco IOS by SNMP',
          ASSETS.tplCisco,
          'template_net_cisco_snmp.yaml',
        )}

        ${section('Troubleshooting Cisco', `
          ${kv([
            ['Authorization error', 'Неверный group/user или level не priv.'],
            ['ACL deny', 'src IP NetMon не в access-list 99.'],
            ['Wrong VRF', 'Укажите management interface / VRF для SNMP.'],
          ])}
        `)}
      `,
    },

    'router:dlink': {
      title: 'D-Link — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Управляемые коммутаторы D-Link (DGS/DWS и аналоги) — SNMP v2c/v3 через Web или CLI.
        Базовый шаблон: Generic Device SNMP с локального зеркала.</p>
        ${snmpCommonPrereqs('D-Link')}

        ${section('2. Настройка в Web UI', `
          ${steps([
            'Management → SNMP → SNMP Global Settings → Enable.',
            'SNMP → Community Table: удалите public/private, создайте read-only community или перейдите на SNMPv3.',
            'SNMPv3 → User Table: создайте пользователя с Auth Protocol SHA, Priv Protocol AES, Security Level authPriv.',
            'SNMP → View / Group: назначьте read-only view.',
            `Access control / Management host: разрешите только <code>${host()}</code>.`,
            'Сохраните конфигурацию во flash (Save / Tools → Save).',
          ])}
        `)}

        ${section('3. CLI (пример)', `
          ${pre(
            `enable\n`
            + `config snmp system_name NETMON-SW1\n`
            + `create snmp user netmon_ro encrypted by_password auth SHA AUTH_PASSWORD priv AES PRIV_PASSWORD\n`
            + `create snmp group ZABBIX user netmon_ro security_model v3 read_view CommunityView\n`
            + `create snmp host ${host()} v3 user netmon_ro\n`
            + `save`,
          )}
          ${warn('Синтаксис CLI зависит от серии DGS — сверяйте с мануалом модели. При сомнении используйте Web UI.')}
        `)}

        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}
      `,
    },

    'router:tplink': {
      title: 'TP-Link — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Коммутаторы TP-Link JetStream / часть Omada L2/L3 с поддержкой SNMP.
        Используйте SNMPv3 и generic-шаблон с зеркала.</p>
        ${snmpCommonPrereqs('TP-Link')}

        ${section('2. Web UI / Omada', `
          ${steps([
            'Standalone switch: System → SNMP → Enable SNMP.',
            'Задайте SNMPv2c community (временный) или сразу SNMPv3 User (Auth+Priv).',
            'System → Access Control / Management Access: ограничьте IP NetMon.',
            'Убедитесь, что management VLAN доступен с сервера мониторинга.',
            'Omada Controller: для AP чаще удобнее отдельный сценарий; SNMP на switch всё равно настраивается на устройстве или через шаблон контроллера.',
            'Сохраните конфигурацию.',
          ])}
          ${callout('Omada cloud/controller API — вне текущего мастера; для Stage 1 достаточно SNMP на коммутаторе + ICMP.')}
        `)}

        ${section('3. Сеть', `
          ${steps([
            `UDP 161 с <code>${host()}</code> до management IP коммутатора.`,
            'Не публикуйте SNMP на WAN-порт роутера TP-Link.',
            'Проверьте, что Spanning Tree / isolation не режет management.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}
      `,
    },

    'router:hp': {
      title: 'HP / Aruba — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Коммутаторы HPE ProCurve / Aruba CX / ArubaOS-Switch — предпочтительно SNMPv3 authPriv.
        Локальный шаблон: Generic SNMP (при наличии vendor-specific — добавьте позже).</p>
        ${snmpCommonPrereqs('HP / Aruba')}

        ${section('2. ArubaOS-Switch / ProCurve (пример CLI)', `
          ${pre(
            `configure\n`
            + `snmp-server community "SECURE_RO" operator restricted\n`
            + `snmpv3 enable\n`
            + `snmpv3 user netmon_ro auth sha AUTH_PASSWORD priv aes PRIV_PASSWORD\n`
            + `snmpv3 group ManagerPriv user netmon_ro sec-model ver3\n`
            + `snmp-server host ${host()} "SECURE_RO"\n`
            + `write memory`,
          )}
        `)}

        ${section('3. Aruba CX', `
          ${pre(
            `configure terminal\n`
            + `snmp-server vrf mgmt\n`
            + `snmpv3 user netmon_ro auth sha AUTH_PASSWORD priv aes PRIV_PASSWORD\n`
            + `snmp-server community SECURE_RO\n`
            + `apply\n`
            + `write memory`,
          )}
          ${callout('На CX SNMP часто слушает только VRF <code>mgmt</code> — NetMon должен иметь маршрут в management VRF.')}
        `)}

        ${section('4. ACL', `
          ${steps([
            `Ограничьте management access list IP адресом <code>${host()}</code>.`,
            'Отключите SNMP на пользовательских VLAN, если не нужны ifHC counters там.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}
      `,
    },

    'ups:apc': {
      title: 'APC Smart-UPS / SRT — SNMP',
      protocol: 'SNMPv3',
      template: 'APC UPS by SNMP',
      body: `
        <p>ИБП APC с картой NMC (AP9630/AP9640) или встроенным SNMP (Smart-UPS SRT и др.).
        Используйте локальный шаблон APC UPS SNMP.</p>
        ${snmpCommonPrereqs('APC UPS / NMC')}

        ${section('2. Настройка NMC / Web UI', `
          ${steps([
            'Подключите management-порт карты к management VLAN, задайте IP, маску, gateway, DNS.',
            'Войдите в Web UI карты (HTTPS), смените пароль администратора по умолчанию.',
            'Configuration → Network → SNMPv1/v3: отключите v1 при возможности; создайте SNMPv3 user с authPriv.',
            'Удалите community public/private.',
            `Access control: разрешите SNMP только с <code>${host()}</code>.`,
            'Configuration → General → задайте Name / Location.',
            'Apply и дождитесь перезапуска SNMP-службы карты.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.4.1.318')}
        ${snmpZabbixHostSteps(
          'APC UPS by SNMP',
          ASSETS.tplApc,
          'template_power_apc_ups_snmp.yaml',
        )}

        ${section('Что обычно мониторится', `
          ${steps([
            'Статус батареи, заряд %, температура, входное/выходное напряжение.',
            'Оставшееся время работы (runtime), нагрузка в % / Вт.',
            'События на батарею / bypass / fault.',
          ])}
          ${warn('После замены батареи сбросьте соответствующие triggers/acknowledge в Zabbix.')}
        `)}
      `,
    },

    'ups:eaton': {
      title: 'Eaton / IPPON — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>ИБП Eaton (5P/5PX/9PX и др.) с картой Network-MS / Industrial Gateway или IPPON с SNMP-модулем.
        Vendor OID Eaton: <code>1.3.6.1.4.1.534</code>. Базовый шаблон — Generic SNMP; при наличии community-template — импортируйте дополнительно.</p>
        ${snmpCommonPrereqs('Eaton / IPPON UPS')}

        ${section('2. Настройка SNMP-карты', `
          ${steps([
            'Установите карту, подключите Ethernet к management-сети, назначьте IP.',
            'Web UI карты → Network / SNMP → Enable.',
            'Создайте SNMPv3 user (authPriv) или сильный community + ACL.',
            `Разрешите опрос только с <code>${host()}</code>.`,
            'Сохраните и перезапустите SNMP при запросе UI.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.4.1.534')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}

        ${section('Альтернатива: NUT', `
          <p>Если SNMP-карты нет — поставьте Network UPS Tools на шлюз и мониторьте через Zabbix agent:</p>
          ${links([
            link(ASSETS.tplLinuxActive, 'Агент на шлюзе: template_os_linux_active.yaml'),
          ])}
        `)}
      `,
    },

    'ups:cyberpower': {
      title: 'CyberPower — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>CyberPower Smart App / Professional с RMCARD205/305 или встроенным сетевым модулем.
        Enterprise OID: <code>1.3.6.1.4.1.3808</code>.</p>
        ${snmpCommonPrereqs('CyberPower UPS')}

        ${section('2. Web UI карты', `
          ${steps([
            'Задайте IP management-карты, смените пароли по умолчанию.',
            'SNMP → Enable; предпочтительно SNMPv3 authPriv.',
            'Удалите default communities.',
            `Access Control List: allow <code>${host()}</code>, deny others.`,
            'Save / Reboot SNMP service.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.4.1.3808')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}
      `,
    },

    'ups:parallels': {
      title: 'Прочие ИБП — SNMP / NUT',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Powercom, Riello, Socomec и другие ИБП с SNMP-картой, либо мониторинг через
        <strong>Network UPS Tools (NUT)</strong> на шлюзе.</p>
        ${snmpCommonPrereqs('ИБП с SNMP')}

        ${section('2. Универсальная настройка SNMP-карты', `
          ${steps([
            'Определите sysObjectID: <code>snmpwalk … 1.3.6.1.2.1.1.2</code>.',
            'Включите SNMPv3 authPriv, смените пароли, ограничьте ACL IP NetMon.',
            'Задокументируйте enterprise OID производителя для дальнейших item.',
            'Импортируйте generic SNMP шаблон, затем добавьте кастомные OID по мере необходимости.',
          ])}
        `)}

        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${snmpZabbixHostSteps(
          'Network Generic Device by SNMP',
          ASSETS.tplGenericSnmp,
          'template_module_generic_snmp_snmp.yaml',
        )}

        ${section('3. Вариант через NUT (без SNMP-карты)', `
          ${steps([
            'На Linux-шлюзе: установите <code>nut-server</code> / <code>nut-client</code>, настройте <code>ups.conf</code> / <code>upsd.conf</code>.',
            'Проверка: <code>upsc ups@localhost</code>.',
            'Установите Zabbix agent 2 на тот же шлюз (см. гайд Linux) и собирайте метрики скриптом/UserParameter.',
          ])}
          ${links([
            link(ASSETS.shDebUbuntu, 'install-agent2-debian-ubuntu.sh'),
            link(ASSETS.tplLinuxActive, 'template_os_linux_active.yaml'),
          ])}
        `)}
      `,
    },

    'router:icmp': {
      title: 'Сетевое оборудование — только ICMP',
      protocol: 'ICMP',
      template: 'ICMP Ping',
      body: `
        <p>Минимальный мониторинг доступности: Zabbix server/proxy периодически пингует устройство.
        SNMP и агент не требуются. Подходит как временная схема или для «чёрных ящиков».</p>

        ${section('1. Предварительные требования', `
          ${steps([
            `С NetMon (<code>${host()}</code>) разрешён ICMP echo к IP устройства.`,
            'На устройстве ICMP не блокируется firewall / control-plane policer.',
            'Известен стабильный management IP (не DHCP без резервации).',
          ])}
        `)}

        ${section('2. Импорт шаблона', `
          ${links([
            link(ASSETS.tplIcmp, 'template_module_icmp_ping.yaml'),
            link(ASSETS.templatesReadme, 'README по шаблонам'),
          ])}
          ${steps([
            'Data collection → Templates → Import → выберите YAML.',
            'Убедитесь, что модуль fping доступен на сервере Zabbix (обычно уже есть в пакете).',
          ])}
        `)}

        ${section('3. Создание host', `
          ${steps([
            'Create host → Host name уникальный.',
            'Agent interface: укажите IP устройства (для ICMP шаблона Zabbix использует IP интерфейса host).',
            'Привяжите шаблон <em>ICMP Ping</em> / Module ICMP Ping.',
            'SNMP interface не нужен.',
            'Сохраните и проверьте Latest data: icmpping, icmppingloss, icmppingsec.',
          ])}
        `)}

        ${section('4. Проверка с сервера', `
          ${pre(
            `ping -c 5 DEVICE_IP\n`
            + `fping -c 5 DEVICE_IP`,
          )}
          ${warn('Если ping с сервера не проходит — шаблон тоже будет в PROBLEM. Сначала почините маршрутизацию/ACL.')}
        `)}

        ${section('5. Когда переходить на SNMP', `
          ${callout('ICMP показывает только «жив/не жив». Для интерфейсов, CPU, температуры и трафика настройте SNMP (см. гайды MikroTik/Cisco/Generic).')}
          ${links([
            link(ASSETS.tplGenericSnmp, 'Следующий шаг: template_module_generic_snmp_snmp.yaml'),
          ])}
        `)}
      `,
    },

    default_agent: {
      title: 'Zabbix agent 2 — общая схема',
      protocol: 'Zabbix agent2',
      template: 'См. тип ОС',
      body: `
        <p>Выберите тип устройства (сервер / компьютер) и ОС на шагах мастера — откроется подробная инструкция.
        Кратко общая схема active agent:</p>
        ${steps([
          'Скачайте agent 2 с локального зеркала <code>/agents/…</code> (не с интернета).',
          `В конфиге задайте <code>Server=${host()}</code>, <code>ServerActive=${host()}</code>, уникальный <code>Hostname</code>.`,
          'Откройте исходящий TCP 10051 до NetMon.',
          'Импортируйте YAML-шаблон Windows/Linux active из <code>/templates/os/…</code>.',
          'Создайте host в UI с тем же Hostname и привяжите шаблон.',
        ])}
        ${section('Зеркало агентов', links([
          link(ASSETS.winAgent2Msi, 'Windows agent 2 MSI'),
          link(ASSETS.ubuntuRelease, 'Ubuntu zabbix-release'),
          link(ASSETS.debianRelease, 'Debian zabbix-release'),
          link(ASSETS.rhelRelease, 'RHEL zabbix-release'),
          link(ASSETS.confExample, 'Пример conf'),
          link(ASSETS.agentsReadme, 'README агентов'),
        ]))}
        ${section('Шаблоны', links([
          link(ASSETS.tplWinActive, 'Windows agent active YAML'),
          link(ASSETS.tplLinuxActive, 'Linux agent active YAML'),
        ]))}
      `,
    },

    default_snmp: {
      title: 'SNMP — общая схема',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Выберите производителя в списке подтипа — откроется детальный гайд.
        Общие правила для всех SNMP-устройств:</p>
        ${steps([
          'Включите SNMPv3 authPriv на устройстве; запретите public/private.',
          `Разрешите UDP 161 только с <code>${host()}</code>.`,
          'Проверьте доступность snmpwalk с сервера NetMon.',
          'Импортируйте YAML с зеркала <code>/templates/…</code>.',
          'Создайте host с SNMP interface (port 161) и привяжите шаблон.',
        ])}
        ${snmpAclAndWalk('1.3.6.1.2.1.1')}
        ${section('Локальные шаблоны', links([
          link(ASSETS.tplGenericSnmp, 'Generic Device SNMP'),
          link(ASSETS.tplMikrotik, 'MikroTik SNMP'),
          link(ASSETS.tplCisco, 'Cisco IOS SNMP'),
          link(ASSETS.tplApc, 'APC UPS SNMP'),
          link(ASSETS.tplIcmp, 'ICMP Ping (без SNMP)'),
          link(ASSETS.templatesReadme, 'README шаблонов'),
        ]))}
      `,
    },
  };

  function suggestedProtocol(deviceType) {
    if (deviceType === 'server' || deviceType === 'computer') return 'Zabbix agent2';
    if (deviceType === 'router' || deviceType === 'ups') return 'SNMPv3';
    return 'ICMP';
  }

  function resolveGuideKey(deviceType, subtype, protocol) {
    if (protocol === 'ICMP' && deviceType === 'router') return 'router:icmp';
    if (deviceType && subtype && GUIDES[`${deviceType}:${subtype}`]) {
      return `${deviceType}:${subtype}`;
    }
    if (protocol === 'Zabbix agent2') return 'default_agent';
    if (protocol === 'SNMPv3') return 'default_snmp';
    return 'default_snmp';
  }

  function getGuide(deviceType, subtype, protocol) {
    const key = resolveGuideKey(deviceType, subtype, protocol);
    return GUIDES[key] || GUIDES.default_snmp;
  }

  function renderGuide(container, deviceType, subtype, protocol) {
    if (!container) return;
    const guide = getGuide(deviceType, subtype, protocol);
    container.innerHTML = `
      <header class="guide-frame-head">
        <span class="guide-badge">${guide.protocol}</span>
        <h4>${guide.title}</h4>
        <p class="guide-template">Шаблон Zabbix: <em>${guide.template}</em></p>
      </header>
      <div class="guide-frame-body">${guide.body}</div>
    `;
  }

  function populateSubtypeSelect(select, deviceType, currentValue) {
    if (!select) return;
    const options = SUBTYPES[deviceType] || [];
    if (!options.length) {
      select.innerHTML = '';
      select.closest('.guide-subtype-field')?.setAttribute('hidden', '');
      return;
    }
    select.closest('.guide-subtype-field')?.removeAttribute('hidden');
    select.innerHTML = options.map((opt) =>
      `<option value="${opt.value}"${opt.value === currentValue ? ' selected' : ''}>${opt.label}</option>`,
    ).join('');
  }

  window.NetmonConnectionGuides = {
    SUBTYPES,
    suggestedProtocol,
    renderGuide,
    populateSubtypeSelect,
    getGuide,
  };
})();
