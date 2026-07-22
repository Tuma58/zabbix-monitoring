(() => {
  'use strict';

  const AGENT_DOWNLOAD = 'https://www.zabbix.com/download_agents';
  const ZABBIX_DOCS_AGENT = 'https://www.zabbix.com/documentation/7.0/en/manual/installation/install_from_packages/win_msi';
  const ZABBIX_DOCS_SNMP = 'https://www.zabbix.com/documentation/7.0/en/manual/config/templates_out_of_the_box/network_devices';

  function serverHost() {
    return window.location.hostname || 'ZABBIX_SERVER_IP';
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
      { value: 'parallels', label: 'Pro другие (SNMP UPS)' },
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

  const GUIDES = {
    'server:win': {
      title: 'Сервер Windows — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Windows by Zabbix agent / Windows by Zabbix agent active',
      body: `
        <p>Для серверов Windows используйте <strong>Zabbix agent 2</strong> (active checks через порт <code>10051</code> на сервер Zabbix).</p>
        ${steps([
          `Скачайте MSI Zabbix agent 2 (7.0): ${link(AGENT_DOWNLOAD, 'zabbix.com/download_agents')} → Windows → MSI.`,
          `Установите агент на сервер. В конфиге <code>C:\\Program Files\\Zabbix Agent 2\\zabbix_agent2.conf</code> укажите:<br>
            <code>Server=${serverHost()}</code><br>
            <code>ServerActive=${serverHost()}</code><br>
            <code>Hostname=</code>уникальное имя (как в Zabbix host).`,
          'Перезапустите службу <strong>Zabbix Agent 2</strong>. Разрешите исходящий TCP <code>10051</code> в firewall.',
          `В Zabbix UI (<strong>Data collection → Hosts</strong>) создайте host с тем же <code>Hostname</code>, шаблон <em>Windows by Zabbix agent active</em>.`,
          'Passive checks (опционально): откройте входящий <code>10050/TCP</code> на Windows и добавьте Agent interface в host.',
        ])}
        ${links([
          link(AGENT_DOWNLOAD, 'Скачать агенты Zabbix 7.0'),
          link(ZABBIX_DOCS_AGENT, 'Документация: установка agent на Windows'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/config/templates_out_of_the_box/zabbix_agent2', 'Шаблоны Windows by Zabbix agent'),
        ])}
      `,
    },
    'server:linux': {
      title: 'Сервер Linux — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Linux by Zabbix agent active',
      body: `
        <p>Для Linux-серверов (Debian/Ubuntu/RHEL/Alma) — пакет <strong>zabbix-agent2</strong> и active checks.</p>
        ${steps([
          `Добавьте репозиторий Zabbix 7.0 и установите <code>zabbix-agent2</code> (${link('https://www.zabbix.com/download?zabbix=7.0&os_distribution=ubuntu&os_version=22.04&components=agent_2&db=&ws=', 'инструкция для вашего дистрибутива')}).`,
          `В <code>/etc/zabbix/zabbix_agent2.conf</code>:<br>
            <code>Server=${serverHost()}</code><br>
            <code>ServerActive=${serverHost()}</code><br>
            <code>Hostname=</code>имя host в Zabbix`,
          '<code>systemctl enable --now zabbix-agent2</code>',
          'Создайте host в Zabbix, шаблон <em>Linux by Zabbix agent active</em>. Метрики: CPU, RAM, disk, systemd, сеть.',
        ])}
        ${links([
          link(AGENT_DOWNLOAD, 'Скачать / репозитории Zabbix'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/installation/install_from_packages', 'Установка из пакетов'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/config/templates_out_of_the_box/zabbix_agent2', 'Шаблоны Linux'),
        ])}
      `,
    },
    'computer:win': {
      title: 'Рабочая станция Windows — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Windows by Zabbix agent active',
      body: `
        <p>Для ПК с Windows 10/11 — тот же agent 2, обычно только active checks (без входящего 10050).</p>
        ${steps([
          `Скачайте и установите Zabbix agent 2 MSI: ${link(AGENT_DOWNLOAD, 'download_agents')}.`,
          `Настройте <code>Server</code> / <code>ServerActive</code> = <code>${serverHost()}</code>, уникальный <code>Hostname</code> (например <code>pc-office-ivanov</code>).`,
          'Убедитесь, что ПК видит Zabbix server: <code>Test-NetConnection ${serverHost()} -Port 10051</code> (PowerShell).',
          'В Zabbix: host + шаблон Windows. Для ноутбуков добавьте мониторинг батареи (опциональный template).',
        ])}
        ${links([
          link(AGENT_DOWNLOAD, 'Агенты Zabbix'),
          link(ZABBIX_DOCS_AGENT, 'Установка на Windows'),
        ])}
      `,
    },
    'computer:linux': {
      title: 'Рабочая станция Linux — Zabbix agent 2',
      protocol: 'Zabbix agent2',
      template: 'Linux by Zabbix agent active',
      body: `
        <p>Для рабочих станций Linux (Ubuntu/Fedora и др.) — пакет agent2.</p>
        ${steps([
          'Установите <code>zabbix-agent2</code> из репозитория Zabbix 7.0.',
          `Пропишите <code>ServerActive=${serverHost()}</code> и <code>Hostname</code> в конфиге.`,
          '<code>systemctl enable --now zabbix-agent2</code>',
          'Создайте host в Zabbix с шаблоном Linux active.',
        ])}
        ${links([
          link(AGENT_DOWNLOAD, 'Репозитории и пакеты'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/installation/install_from_packages', 'Документация по установке'),
        ])}
      `,
    },
    'router:mikrotik': {
      title: 'MikroTik RouterOS — SNMP',
      protocol: 'SNMPv3',
      template: 'Mikrotik SNMPv2 / Network Generic Device',
      body: `
        <p>RouterOS поддерживает SNMP v2/v3. Рекомендуется <strong>SNMPv3</strong> (authPriv).</p>
        ${steps([
          'В RouterOS: <code>/snmp set enabled=yes contact="NOC" location="site"</code>',
          'SNMPv3: <code>/snmp community add name=zabbix security=authorized read-access=yes write-access=no authentication-protocol=SHA1 encryption-protocol=AES auth-password=... enc-password=...</code> (или через WinBox → SNMP).',
          'Разрешите UDP <code>161</code> с IP Zabbix server / proxy.',
          'В Zabbix: host с SNMP interface (порт 161), macro <code>{$SNMP_COMMUNITY}</code> или SNMPv3 credentials, шаблон <em>Mikrotik</em> или <em>Network Generic Device by SNMP</em>.',
        ])}
        ${links([
          link('https://wiki.mikrotik.com/wiki/Manual:SNMP', 'Wiki MikroTik: SNMP'),
          link(ZABBIX_DOCS_SNMP, 'Шаблоны сетевых устройств Zabbix'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/config/items/itemtypes/snmp', 'SNMP items в Zabbix'),
        ])}
      `,
    },
    'router:keenetic': {
      title: 'Keenetic — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP / Keenetic (community)',
      body: `
        <p>На роутерах Keenetic (OS 3.x+) включите компонент «SNMP» в облаке/веб-интерфейсе.</p>
        ${steps([
          'Веб-UI Keenetic → <strong>Управление → Общие настройки</strong> → включить SNMP (если доступно для модели).',
          'Задайте community (v2c) или настройте SNMPv3 — предпочтительно v3 для production.',
          'Разрешите опрос с IP Zabbix server. Проверка: <code>snmpwalk -v3 ... IP</code> с сервера мониторинга.',
          'Zabbix: SNMP interface, шаблон generic network; для Wi‑Fi/clients — доп. items по OID Keenetic.',
        ])}
        ${links([
          link('https://help.keenetic.com/hc/en-us/categories/360002798880-User-Manual', 'Документация Keenetic'),
          link(ZABBIX_DOCS_SNMP, 'Zabbix: сетевые шаблоны'),
        ])}
      `,
    },
    'router:cisco': {
      title: 'Cisco — SNMP',
      protocol: 'SNMPv3',
      template: 'Cisco IOS by SNMP / Network Generic Device',
      body: `
        <p>Для Cisco IOS / IOS-XE / NX-OS — SNMPv3 (authPriv), ACL на management VRF.</p>
        ${steps([
          '<code>snmp-server group ZABBIX v3 priv</code>, создайте user с auth/sha и priv/aes.',
          '<code>snmp-server host ${serverHost()} version 3 priv ZABBIX_USER</code> (traps опционально).',
          'Ограничьте SNMP ACL только IP Zabbix: <code>snmp-server community</code> / <code>control-plane</code> filter.',
          'Zabbix: шаблон <em>Cisco IOS by SNMP</em>, SNMPv3 credentials в host macro или interface.',
        ])}
        ${links([
          link('https://www.cisco.com/c/en/us/support/docs/ip/simple-network-management-protocol-snmp/20370-snmpsecurity.html', 'Cisco SNMP security'),
          link(ZABBIX_DOCS_SNMP, 'Zabbix network templates'),
        ])}
      `,
    },
    'router:dlink': {
      title: 'D-Link — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `
        <p>Управляемые коммутаторы D-Link (DGS/DWS) — SNMP v2/v3 через web/CLI.</p>
        ${steps([
          'Включите SNMP в web-интерфейсе: <strong>Management → SNMP</strong> → Enable, community или SNMPv3 user.',
          'Укажите Read community / v3 credentials, trap host при необходимости.',
          'Разрешите UDP 161 с IP Zabbix. Проверка: <code>snmpwalk -v2c -c community IP 1.3.6.1.2.1.1</code>',
          'Zabbix: generic SNMP template + при необходимости D-Link specific OID.',
        ])}
        ${links([
          link('https://support.dlink.com/', 'Support D-Link'),
          link(ZABBIX_DOCS_SNMP, 'Zabbix SNMP templates'),
        ])}
      `,
    },
    'router:tplink': {
      title: 'TP-Link — SNMP',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP / TP-LINK',
      body: `
        <p>Коммутаторы TP-Link JetStream / Omada (L2/L3) с поддержкой SNMP.</p>
        ${steps([
          'Web UI → <strong>System → SNMP</strong> → Enable SNMP, community (v2c) или SNMPv3.',
          'Management VLAN: устройство должно быть доступно с Zabbix server по UDP 161.',
          'Omada Controller: для AP/контроллера — отдельный host или SNMP через controller API (Stage 2).',
          'Zabbix: SNMP interface + шаблон generic / TP-LINK by SNMP (если есть в Zabbix share).',
        ])}
        ${links([
          link('https://www.tp-link.com/support/', 'TP-Link Support'),
          link('https://share.zabbix.com/network_devices', 'Community templates (TP-Link)'),
        ])}
      `,
    },
    'router:hp': {
      title: 'HP / Aruba — SNMP',
      protocol: 'SNMPv3',
      template: 'HP Enterprise Switch by SNMP / Network Generic Device',
      body: `
        <p>Коммутаторы HPE / Aruba (ProCurve, Aruba CX) — SNMPv3 preferred.</p>
        ${steps([
          'CLI: <code>snmp-server community "..." operator unrestricted</code> или SNMPv3 user (authPriv).',
          'Ограничьте management access list (ACL) IP адресом Zabbix.',
          'Для Aruba CX — включите SNMP в группе <code>mgmt</code> VRF.',
          'Zabbix: шаблон <em>HP Enterprise Switch</em> / generic SNMP, интерфейсы — discovery.',
        ])}
        ${links([
          link('https://arubanetworking.hpe.com/techdocs', 'Aruba / HPE TechDocs'),
          link(ZABBIX_DOCS_SNMP, 'Zabbix SNMP templates'),
        ])}
      `,
    },
    'ups:apc': {
      title: 'APC (Smart-UPS, SRT, Back-UPS) — SNMP',
      protocol: 'SNMPv3',
      template: 'APC UPS by SNMP / APC Smart-UPS SRT 3000',
      body: `
        <p>ИБП APC с SNMP-картой (AP9630, AP9640, встроенный SNMP в Smart-UPS SRT).</p>
        ${steps([
          'Подключите SNMP/NMC карту к management-сети, задайте IP, включите SNMP (v1/v2c или v3 в NMC web UI).',
          'Community по умолчанию часто <code>public</code> — смените на уникальный; лучше SNMPv3 authPriv.',
          'Проверка: <code>snmpwalk -v2c -c community IP 1.3.6.1.4.1.318</code> (enterprise APC).',
          'Zabbix: шаблон <em>APC UPS by SNMP</em> или <em>APC Smart-UPS SRT 3000 by SNMP</em>.',
        ])}
        ${links([
          link('https://www.apc.com/us/en/support/product-support.jsp', 'APC Support'),
          link('https://www.zabbix.com/documentation/7.0/en/manual/config/templates_out_of_the_box/appliance', 'Zabbix: UPS templates'),
        ])}
      `,
    },
    'ups:eaton': {
      title: 'Eaton / IPPON — SNMP',
      protocol: 'SNMPv3',
      template: 'Eaton UPS SNMP / Network UPS Tools',
      body: `
        <p>Eaton 5P/5PX/9PX с картой SNMP/Web или IPPON с SNMP-модулем.</p>
        ${steps([
          'Установите/настройте SNMP-карту (IP, маска, gateway в management VLAN).',
          'Web UI карты → SNMP → community или SNMPv3 user.',
          'OID base: <code>1.3.6.1.4.1.534</code> (Eaton). Проверка snmpwalk с Zabbix server.',
          'Zabbix: шаблон <em>Eaton UPS</em> или generic UPS SNMP + macros.',
        ])}
        ${links([
          link('https://www.eaton.com/us/en-us/support.html', 'Eaton Support'),
          link('https://share.zabbix.com/cat/ups', 'Community UPS templates'),
        ])}
      `,
    },
    'ups:cyberpower': {
      title: 'CyberPower — SNMP',
      protocol: 'SNMPv3',
      template: 'CyberPower UPS SNMP',
      body: `
        <p>CyberPower Smart App Sinewave / OR2200 с RMCARD205 или встроенным SNMP.</p>
        ${steps([
          'Настройте IP management-карты, включите SNMP (v2c/v3) в web-интерфейсе карты.',
          'Enterprise OID: <code>1.3.6.1.4.1.3808</code>. Ограничьте доступ UDP 161 ACL.',
          'Zabbix: community template CyberPower UPS или generic SNMP UPS.',
        ])}
        ${links([
          link('https://www.cyberpowersystems.com/support/', 'CyberPower Support'),
          link('https://share.zabbix.com/cat/ups', 'Zabbix share: UPS'),
        ])}
      `,
    },
    'ups:parallels': {
      title: 'Прочие ИБП — SNMP',
      protocol: 'SNMPv3',
      template: 'Generic UPS SNMP / Network UPS Tools (NUT)',
      body: `
        <p>Другие модели с SNMP-картой (Powercom, Riello, Socomec и др.) или через NUT (<code>upsd</code>).</p>
        ${steps([
          'Уточните enterprise OID производителя (snmpwalk sysObjectID).',
          'Настройте SNMPv3 на карте; не используйте <code>public</code> в production.',
          'Альтернатива: NUT + Zabbix agent на шлюзе, опрос localhost (<code>upsmon</code>).',
          'Zabbix: generic template + item overrides по OID.',
        ])}
        ${links([
          link('https://networkupstools.org/', 'Network UPS Tools (NUT)'),
          link('https://share.zabbix.com/cat/ups', 'Community UPS templates'),
        ])}
      `,
    },
    'router:icmp': {
      title: 'Сетевое оборудование — только ICMP',
      protocol: 'ICMP',
      template: 'ICMP Ping',
      body: `<p>Минимальный мониторинг доступности без SNMP: ping с Zabbix server.</p>${steps(['Host с agent interface не нужен.', 'Шаблон <em>ICMP Ping</em>.', 'Убедитесь, что ICMP разрешён firewall на устройстве.'])}`,
    },
    default_agent: {
      title: 'Zabbix agent 2 — общая схема',
      protocol: 'Zabbix agent2',
      template: 'См. тип ОС',
      body: `<p>Выберите тип устройства на шаге 1 и уточните ОС/производителя ниже.</p>${links([link(AGENT_DOWNLOAD, 'Скачать агенты')])}`,
    },
    default_snmp: {
      title: 'SNMP — общая схема',
      protocol: 'SNMPv3',
      template: 'Network Generic Device by SNMP',
      body: `<p>Выберите производителя в списке. Требуется UDP <code>161</code> с Zabbix server к устройству.</p>${links([link(ZABBIX_DOCS_SNMP, 'Документация SNMP в Zabbix')])}`,
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
