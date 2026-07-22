(() => {
  'use strict';

  const API_BASE = '/api/v1';
  const TOKEN_KEY = 'netmon_access_token';
  const REFRESH_KEY = 'netmon_refresh_token';
  // Default admin email for the login form; password is never stored in the client bundle.
  const DEFAULT_ADMIN_EMAIL = 'admin@example.com';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const body = document.body;
  const wizard = $('#deviceWizard');
  const settings = $('#settingsDialog');
  const form = $('#deviceForm');
  const nextButton = $('#wizardNext');
  const backButton = $('#wizardBack');
  const stepLabel = $('#currentStepLabel');
  const toast = $('#toast');
  let currentStep = 1;
  let probeComplete = false;
  let probeRunId = 0;
  let toastTimer;
  let accessToken = localStorage.getItem(TOKEN_KEY) || '';
  let apiOnline = false;
  let sitesCache = [];
  let credentialProfiles = [];
  let selectedCredentialProfileId = '';

  const NAV_SECTIONS = ['overview', 'devices', 'problems', 'sites'];
    return `<svg><use href="#${id}"/></svg>`;
  }

  function showToast(message) {
    $('p', toast).textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function setFooter(message) {
    const node = $('#footerStatus');
    if (node) node.textContent = message;
  }

  function setSyncState(message, ok = true) {
    const node = $('#syncState');
    if (!node) return;
    node.innerHTML = `<span></span>${message}`;
    node.classList.toggle('is-stale', !ok);
  }

  async function api(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function login(email = DEFAULT_ADMIN_EMAIL, password = '') {
    if (!password) {
      throw new Error('Password is required');
    }
    const tokens = await api('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    accessToken = tokens.access_token;
    localStorage.setItem(TOKEN_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    return tokens;
  }

  function openLoginDialog(message = '') {
    const dialog = $('#loginDialog');
    if (!dialog) return Promise.resolve(false);
    const emailField = $('#loginEmail');
    const passwordField = $('#loginPassword');
    const messageNode = $('#loginMessage');
    if (emailField && !emailField.value) emailField.value = DEFAULT_ADMIN_EMAIL;
    if (passwordField) passwordField.value = '';
    if (messageNode) messageNode.textContent = message;
    openDialog(dialog);
    passwordField?.focus();
    return new Promise((resolve) => {
      dialog.dataset.loginResolver = 'pending';
      dialog._loginResolve = resolve;
    });
  }

  function closeLoginDialog(success) {
    const dialog = $('#loginDialog');
    if (!dialog) return;
    if (typeof dialog._loginResolve === 'function') {
      dialog._loginResolve(success);
      dialog._loginResolve = null;
    }
    closeDialog(dialog);
  }

  async function promptLogin(message = 'Введите пароль администратора портала') {
    const ok = await openLoginDialog(message);
    if (!ok) return false;
    try {
      const email = $('#loginEmail')?.value || DEFAULT_ADMIN_EMAIL;
      const password = $('#loginPassword')?.value || '';
      await login(email, password);
      const me = await api('/me');
      applyUser(me);
      return true;
    } catch (error) {
      showToast(error.message || 'Неверный логин или пароль');
      return promptLogin('Неверный логин или пароль. Повторите попытку.');
    }
  }

  async function ensureSession() {
    try {
      await api('/health/live');
      apiOnline = true;
    } catch {
      apiOnline = false;
      setFooter('API недоступен');
      setSyncState('API недоступен', false);
      $('#systemStatusTitle').textContent = 'API недоступен';
      $('#systemStatusMeta').textContent = 'проверьте подключение';
      return false;
    }

    if (accessToken) {
      try {
        const me = await api('/me');
        applyUser(me);
        return true;
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        accessToken = '';
      }
    }

    try {
      return await promptLogin();
    } catch (error) {
      setFooter('API доступен, но вход не выполнен');
      setSyncState('Нужна авторизация', false);
      $('#systemStatusTitle').textContent = 'Нет сессии';
      $('#systemStatusMeta').textContent = error.message || 'login failed';
      return false;
    }
  }

  function applyUser(me) {
    const name = me.email.split('@')[0];
    $('#userName').textContent = name;
    $('#userRole').textContent = (me.roles || []).join(', ') || 'viewer';
    $('#userAvatar').textContent = name.slice(0, 2).toUpperCase();
    const greeting = `Здравствуйте, ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const greetingNode = $('#overviewGreeting');
    if (greetingNode) greetingNode.textContent = greeting;
  }

  function severityClass(severity) {
    const map = {
      disaster: 'disaster',
      high: 'high',
      average: 'average',
      warning: 'warning',
      information: 'average',
    };
    return map[severity] || 'average';
  }

  function severityLabel(severity) {
    const map = {
      disaster: 'Критическая',
      high: 'Высокая',
      average: 'Средняя',
      warning: 'Предупреждение',
      information: 'Информация',
    };
    return map[severity] || severity;
  }

  function statusLabel(status) {
    const map = {
      active: 'Доступно',
      degraded: 'Предупреждение',
      failed: 'Недоступно',
      draft: 'Черновик',
      provisioning: 'Добавляется',
      archived: 'Архив',
    };
    return map[status] || status;
  }

  function statusDot(status) {
    if (status === 'active') return 'ok';
    if (status === 'degraded' || status === 'provisioning') return 'warn';
    return 'down';
  }

  function renderProblems(problems) {
    const bodyNode = $('#problemsBody');
    if (!bodyNode) return;
    if (!problems.length) {
      bodyNode.innerHTML = '<tr class="empty-row"><td colspan="6">Активных проблем нет</td></tr>';
      return;
    }
    bodyNode.innerHTML = problems.map((problem) => `
      <tr data-site="${escapeHtml(problem.site)}">
        <td><span class="severity ${severityClass(problem.severity)}">${severityLabel(problem.severity)}</span></td>
        <td><strong>${escapeHtml(problem.summary)}</strong><small>${problem.acknowledged ? 'Принято' : 'Требует реакции'}</small></td>
        <td><span class="device-cell"><i class="device-icon router">${icon('i-router')}</i><span>${escapeHtml(problem.host)}<small>${escapeHtml(problem.event_id)}</small></span></span></td>
        <td>${escapeHtml(problem.site)}</td>
        <td>${escapeHtml(problem.duration)}</td>
        <td><button class="row-action acknowledge ${problem.acknowledged ? 'done' : ''}" data-event-id="${escapeHtml(problem.event_id)}" ${problem.acknowledged ? 'disabled' : ''}>${problem.acknowledged ? 'Принято' : 'Принять'}</button></td>
      </tr>
    `).join('');
    bindAcknowledgeButtons();
  }

  function renderDevices(devices, sitesById) {
    const list = $('#deviceList');
    if (!list) return;
    const head = list.querySelector('.device-list-head');
    list.innerHTML = '';
    if (head) list.appendChild(head);
    else {
      const heading = document.createElement('div');
      heading.className = 'device-list-head';
      heading.innerHTML = '<span>Устройство</span><span>Тип</span><span>Площадка</span><span>Состояние</span><span>Последние данные</span>';
      list.appendChild(heading);
    }
    if (!devices.length) {
      const empty = document.createElement('article');
      empty.className = 'empty-state';
      empty.innerHTML = '<span>Устройств пока нет. Нажмите «Добавить устройство».</span>';
      list.appendChild(empty);
      return;
    }
    devices.forEach((device) => {
      const article = document.createElement('article');
      const siteName = sitesById[device.site_id] || '—';
      article.innerHTML = `<span class="device-cell"><i class="device-icon ${device.device_type === 'ups' ? 'ups' : device.device_type === 'server' ? 'server' : 'router'}">${icon(device.device_type === 'ups' ? 'i-ups' : device.device_type === 'server' ? 'i-server' : 'i-router')}</i><span>${escapeHtml(device.name)}<small>${escapeHtml(device.address)}</small></span></span><span>${escapeHtml(device.device_type)}</span><span>${escapeHtml(siteName)}</span><span><i class="state-dot ${statusDot(device.status)}"></i>${statusLabel(device.status)}</span><span>только что</span>`;
      list.appendChild(article);
    });
  }

  function renderSites(sites, devices) {
    const grid = $('#siteGrid');
    if (!grid) return;
    if (!sites.length) {
      grid.innerHTML = '<article class="site-card empty-state"><p>Площадок пока нет. Создайте первую при добавлении устройства.</p></article>';
      const filter = $('#siteFilter');
      if (filter) filter.innerHTML = '<option value="all">Все площадки</option>';
      return;
    }
    const counts = devices.reduce((acc, device) => {
      acc[device.site_id] = (acc[device.site_id] || 0) + 1;
      return acc;
    }, {});
    grid.innerHTML = sites.map((site) => {
      const count = counts[site.id] || 0;
      const slug = site.name.toLowerCase().replace(/\s+/g, '-');
      return `<article class="site-card" data-site-card="${escapeHtml(slug)}"><div class="site-top"><span class="site-icon">${icon('i-map')}</span><span class="site-health ok">В норме</span></div><h3>${escapeHtml(site.name)}</h3><p>${escapeHtml(site.timezone)} · ${escapeHtml(site.proxy_id || 'без proxy')}</p><div class="site-stats"><span><b>${count}</b> устройств</span><span><b>0</b> проблем</span></div><div class="site-bar"><span style="width:96%"></span></div></article>`;
    }).join('');

    const filter = $('#siteFilter');
    if (filter) {
      filter.innerHTML = '<option value="all">Все площадки</option>' + sites.map((site) => {
        const slug = site.name.toLowerCase().replace(/\s+/g, '-');
        return `<option value="${escapeHtml(slug)}">${escapeHtml(site.name)}</option>`;
      }).join('');
    }
  }

  function applySummary(summary, problemTotal) {
    const available = summary.availability?.available || 0;
    const total = summary.devices_total || 0;
    const unavailable = summary.availability?.unavailable || 0;
    const pct = total ? Math.max(0, Math.min(100, (available / total) * 100)) : 100;
    const pctText = pct.toFixed(2).replace('.', ',');

    $('#deviceCount').textContent = String(total);
    $('#navDeviceCount').textContent = String(total);
    $('#deviceCountNote').innerHTML = `${icon('i-check')}${available} доступно`;
    $('#availabilityValue').innerHTML = `${pctText}<span>%</span>`;
    $('#availabilityNote').textContent = unavailable ? `${unavailable} требуют внимания` : 'Все активные устройства доступны';
    $('#availabilityBar').style.width = `${pct}%`;
    $('#problemCount').textContent = String(problemTotal);
    $('#navProblemCount').textContent = String(problemTotal);
    $('#problemCountNote').textContent = problemTotal ? `${problemTotal} активных событий` : 'Активных проблем нет';
    $('#overviewSubtitle').textContent = problemTotal
      ? `Инфраструктура под контролем. Требуют внимания ${problemTotal} событий.`
      : total
        ? 'Инфраструктура под контролем. Активных проблем нет.'
        : 'Добавьте первое устройство через мастер «Добавить устройство».';

    const chartAvailability = $('#chartAvailability');
    if (chartAvailability) chartAvailability.textContent = total ? `${pctText}%` : '—';
    const chartNote = $('#chartAvailabilityNote');
    if (chartNote) {
      chartNote.textContent = total ? `${available} из ${total} доступны` : 'Нет данных за период';
    }
    const donutTotal = $('#donutDeviceTotal');
    if (donutTotal) donutTotal.textContent = String(total);
    const statusAvailable = $('#statusAvailable');
    const statusDegraded = $('#statusDegraded');
    const statusFailed = $('#statusFailed');
    if (statusAvailable) statusAvailable.textContent = String(available);
    if (statusDegraded) statusDegraded.textContent = String(summary.availability?.unavailable || 0);
    if (statusFailed) statusFailed.textContent = '0';
    const typeBreakdown = $('#typeBreakdown');
    if (typeBreakdown) {
      typeBreakdown.innerHTML = total
        ? `<span><svg><use href="#i-server"/></svg>Устройств <b>${total}</b></span>`
        : '<span>Добавьте устройства через мастер</span>';
    }

    const zabbix = summary.zabbix || {};
    const zabbixLabel = zabbix.status === 'ok'
      ? `Zabbix ${zabbix.version || ''}`.trim()
      : zabbix.status === 'disabled'
        ? 'Zabbix API выключен'
        : 'Zabbix недоступен';
    $('#systemStatusTitle').textContent = summary.stale ? 'Данные устарели' : 'Система работает';
    $('#systemStatusMeta').textContent = `${zabbixLabel} · источник ${summary.source}`;
    setSyncState(summary.stale ? 'Устаревшие данные' : 'Данные актуальны', !summary.stale);
    setFooter(`API /v1 · источник ${summary.source} · ${zabbixLabel}`);

    const settingsZabbixMeta = $('#settingsZabbixMeta');
    const settingsZabbixStatus = $('#settingsZabbixStatus');
    if (settingsZabbixMeta) {
      settingsZabbixMeta.textContent = zabbix.status === 'ok'
        ? `API доступен · ${zabbix.version || 'Zabbix'}`
        : zabbix.status === 'disabled' ? 'Интеграция выключена' : 'Zabbix недоступен';
    }
    if (settingsZabbixStatus) {
      settingsZabbixStatus.textContent = zabbix.status === 'ok' ? 'Подключено' : '—';
      settingsZabbixStatus.classList.toggle('setting-ok', zabbix.status === 'ok');
    }
    const settingsSitesMeta = $('#settingsSitesMeta');
    const settingsSitesCount = $('#settingsSitesCount');
    if (settingsSitesMeta) settingsSitesMeta.textContent = `${summary.sites_total || 0} площадок`;
    if (settingsSitesCount) settingsSitesCount.textContent = String(summary.sites_total || 0);
    const settingsSystemMeta = $('#settingsSystemMeta');
    const settingsSystemStatus = $('#settingsSystemStatus');
    if (settingsSystemMeta) settingsSystemMeta.textContent = summary.stale ? 'Данные устарели' : 'API и portal DB';
    if (settingsSystemStatus) {
      settingsSystemStatus.textContent = summary.stale ? 'Внимание' : 'В норме';
      settingsSystemStatus.classList.toggle('setting-ok', !summary.stale);
    }
  }

  function populateWizardSites(sites) {
    const select = $('#deviceSite');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Выберите или создайте площадку</option>'
      + sites.map((site) => `<option value="${escapeHtml(site.name)}" data-site-id="${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join('')
      + '<option value="__new__">+ Создать новую площадку…</option>';
    if (current) select.value = current;
  }

  async function refreshDashboard() {
    const ready = await ensureSession();
    if (!ready) return;

    const [summary, problems, devices, sites, health] = await Promise.all([
      api('/dashboard/summary'),
      api('/problems'),
      api('/devices'),
      api('/sites'),
      api('/health/ready'),
    ]);
    sitesCache = sites;
    const sitesById = Object.fromEntries(sites.map((site) => [site.id, site.name]));
    applySummary(summary, problems.length);
    renderProblems(problems);
    renderDevices(devices, sitesById);
    renderSites(sites, devices);
    populateWizardSites(sites);
    await loadCredentialProfiles();
    if (health.status !== 'ok') {
      setSyncState('Зависимости деградированы', false);
    }
  }

  function bindAcknowledgeButtons() {
    $$('.acknowledge').forEach((button) => {
      button.onclick = async () => {
        const eventId = button.dataset.eventId;
        if (!eventId || button.disabled || !accessToken) return;
        try {
          await api(`/problems/${encodeURIComponent(eventId)}/ack`, {
            method: 'POST',
            body: { message: 'Acknowledged from dashboard' },
          });
          button.textContent = 'Принято';
          button.classList.add('done');
          button.disabled = true;
          showToast('Проблема принята в работу');
        } catch (error) {
          showToast(error.message || 'Не удалось подтвердить проблему');
        }
      };
    });
  }

  function subtypeLabels(deviceType) {
    const map = {
      server: 'Операционная система сервера',
      computer: 'Операционная система рабочей станции',
      router: 'Производитель сетевого оборудования',
      ups: 'Модель / производитель ИБП',
    };
    return map[deviceType] || 'Уточните тип / производителя';
  }

  function syncNavFromHash() {
    const hash = (window.location.hash || '#overview').replace('#', '');
    const activeId = NAV_SECTIONS.includes(hash) ? hash : 'overview';
    $$('.side-nav a[href^="#"]').forEach((link) => {
      link.classList.toggle('active', link.getAttribute('href') === `#${activeId}`);
    });
  }

  async function loadCredentialProfiles() {
    if (!accessToken || !apiOnline) return;
    try {
      credentialProfiles = await api('/credentials');
      populateCredentialProfiles();
    } catch {
      credentialProfiles = [];
    }
  }

  function populateCredentialProfiles(selectedId = selectedCredentialProfileId) {
    const select = $('#credentialProfile');
    if (!select) return;
    if (!credentialProfiles.length) {
      select.innerHTML = '<option value="">Профиль будет создан автоматически</option>';
      selectedCredentialProfileId = '';
      return;
    }
    select.innerHTML = credentialProfiles.map((profile) =>
      `<option value="${escapeHtml(profile.id)}"${profile.id === selectedId ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`,
    ).join('');
    selectedCredentialProfileId = select.value || credentialProfiles[0]?.id || '';
  }

  async function ensureMonitoringProfile() {
    if (!accessToken || !apiOnline) return null;
    const deviceType = $('#deviceType')?.value;
    const protocol = $('input[name="protocol"]:checked')?.value;
    if (!deviceType || !protocol) return null;
    const subtype = $('#guideSubtype')?.value || null;
    try {
      const result = await api('/credentials/ensure', {
        method: 'POST',
        body: {
          device_type: deviceType,
          monitoring_subtype: subtype,
          protocol,
        },
      });
      selectedCredentialProfileId = result.profile.id;
      if (!credentialProfiles.some((item) => item.id === result.profile.id)) {
        credentialProfiles.push(result.profile);
      }
      populateCredentialProfiles(result.profile.id);
      return result;
    } catch (error) {
      showToast(error.message || 'Не удалось подобрать профиль');
      return null;
    }
  }

  function updateConnectionGuide() {
    const guides = window.NetmonConnectionGuides;
    if (!guides) return;
    const deviceType = $('#deviceType')?.value || '';
    const protocol = $('input[name="protocol"]:checked')?.value || 'SNMPv3';
    const subtypeSelect = $('#guideSubtype');
    const subtypeField = $('#guideSubtypeField');
    const subtypeLabel = $('#guideSubtypeLabel');

    if (subtypeLabel) subtypeLabel.textContent = subtypeLabels(deviceType);

    let subtype = subtypeSelect?.value || '';
    if (deviceType && guides.SUBTYPES[deviceType]?.length) {
      if (!subtype || !guides.SUBTYPES[deviceType].some((item) => item.value === subtype)) {
        subtype = guides.SUBTYPES[deviceType][0].value;
      }
      guides.populateSubtypeSelect(subtypeSelect, deviceType, subtype);
    } else if (subtypeField) {
      subtypeField.setAttribute('hidden', '');
    }

    guides.renderGuide($('#connectionGuideContent'), deviceType, subtype, protocol);
    ensureMonitoringProfile();
  }

  function applySuggestedProtocol(deviceType) {
    const guides = window.NetmonConnectionGuides;
    if (!guides || !deviceType) return;
    const protocol = guides.suggestedProtocol(deviceType);
    const input = $(`input[name="protocol"][value="${protocol}"]`);
    if (input) input.checked = true;
  }

  function resetWizard() {
    form.reset();
    currentStep = 1;
    probeComplete = false;
    probeRunId += 1;
    $('#probeTitle').textContent = 'Готовы начать проверку';
    $('#probeSubtitle').textContent = 'Проверим сеть, протокол, авторизацию и определим модель';
    $('#runProbe').disabled = false;
    $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить подключение`;
    $$('.check-list > div').forEach((item) => {
      item.className = '';
      $('i', item).innerHTML = icon('i-clock');
      $('small', item).textContent = 'Ожидает проверки';
      $('em', item).textContent = '—';
    });
    $$('.field input, .field select', form).forEach((field) => field.classList.remove('invalid'));
    applySuggestedProtocol($('#deviceType')?.value || '');
    updateConnectionGuide();
    populateCredentialProfiles();
    renderStep();
  }

  function renderStep() {
    $$('.wizard-page').forEach((page) => page.classList.toggle('active', Number(page.dataset.step) === currentStep));
    $$('[data-step-nav]').forEach((item) => {
      const step = Number(item.dataset.stepNav);
      item.classList.toggle('active', step === currentStep);
      item.classList.toggle('complete', step < currentStep);
      $('i', item).innerHTML = step < currentStep ? icon('i-check') : String(step);
    });
    stepLabel.textContent = String(currentStep);
    backButton.hidden = currentStep === 1;
    nextButton.innerHTML = currentStep === 4 ? `${icon('i-plus')}Добавить в мониторинг` : `Продолжить${icon('i-chevron')}`;
    nextButton.disabled = currentStep === 3 && !probeComplete;
    if (currentStep === 2) updateConnectionGuide();
  }

  function validateStepOne() {
    const required = $$('[data-step="1"] [required]');
    let firstInvalid = null;
    required.forEach((field) => {
      const invalid = !field.value.trim();
      field.classList.toggle('invalid', invalid);
      if (invalid && !firstInvalid) firstInvalid = field;
    });
    if (firstInvalid) {
      firstInvalid.focus();
      showToast('Заполните обязательные поля');
      return false;
    }

    const address = $('#deviceAddress');
    if (/\s/.test(address.value)) {
      address.classList.add('invalid');
      address.focus();
      showToast('Проверьте IP-адрес или имя узла');
      return false;
    }
    return true;
  }

  function fillPreview() {
    const protocol = $('input[name="protocol"]:checked').value;
    const deviceType = $('#deviceType').value || 'server';
    const guides = window.NetmonConnectionGuides;
    const subtype = $('#guideSubtype')?.value || '';
    const guide = guides?.getGuide(deviceType, subtype, protocol);
    $('#previewName').textContent = $('#deviceName').value || 'Новое устройство';
    $('#previewAddress').textContent = $('#deviceAddress').value || '—';
    $('#previewSite').textContent = $('#deviceSite').value === '__new__'
      ? ($('#deviceSite').selectedOptions[0]?.textContent || 'Новая площадка')
      : ($('#deviceSite').value || '—');
    $('#previewProtocol').textContent = protocol;
    $('#previewProxy').textContent = $('#proxy').value || 'Сервер по умолчанию';
    const modelNode = $('#previewModel');
    const templateNode = $('#previewTemplate');
    const metricsNode = $('#previewMetrics');
    if (guide) {
      if (modelNode) modelNode.textContent = guide.title.replace(/ — .+$/, '');
      if (templateNode) templateNode.textContent = guide.template;
    }
    if (protocol === 'Zabbix agent2') {
      if (metricsNode) metricsNode.textContent = 'CPU, RAM, диски, сеть, службы, процессы';
    } else if (protocol === 'ICMP') {
      if (modelNode) modelNode.textContent = 'ICMP host';
      if (templateNode) templateNode.textContent = 'ICMP Ping';
      if (metricsNode) metricsNode.textContent = 'Доступность и время отклика';
    } else if (metricsNode) {
      if (metricsNode) metricsNode.textContent = 'Доступность, интерфейсы, температура, питание (UPS)';
    }
  }

  function advance() {
    if (currentStep === 1 && !validateStepOne()) return;
    if (currentStep === 3 && !probeComplete) {
      showToast('Сначала проверьте подключение');
      return;
    }
    if (currentStep < 4) {
      currentStep += 1;
      if (currentStep === 2) {
        applySuggestedProtocol($('#deviceType')?.value || '');
        updateConnectionGuide();
      }
      if (currentStep === 4) fillPreview();
      renderStep();
      return;
    }
    addDevice();
  }

  async function runProbe() {
    const runId = ++probeRunId;
    const checks = $$('.check-list > div');
    probeComplete = false;
    nextButton.disabled = true;
    $('#runProbe').disabled = true;
    $('#runProbe').innerHTML = `${icon('i-refresh')}Проверяем…`;
    $('#probeTitle').textContent = `Проверяем ${$('#deviceAddress').value || 'устройство'}`;
    $('#probeSubtitle').textContent = 'Запрос выполняется через proxy выбранной площадки';
    $('.probe-animation').classList.add('running');

    checks.forEach((item) => {
      item.className = '';
      $('i', item).innerHTML = icon('i-clock');
      $('small', item).textContent = 'Ожидает проверки';
      $('em', item).textContent = '—';
    });

    if (accessToken && apiOnline) {
      try {
        let siteId = sitesCache[0]?.id;
        if (!siteId) {
          const sites = await api('/sites');
          sitesCache = sites;
          siteId = sites[0]?.id;
        }
        if (!siteId) {
          const created = await api('/sites', {
            method: 'POST',
            body: { name: $('#deviceSite').value || 'Default', timezone: 'Europe/Moscow', tags: [] },
          });
          siteId = created.id;
          sitesCache = [created];
        }
        const operation = await api('/devices/probe', {
          method: 'POST',
          headers: { 'Idempotency-Key': `probe-${$('#deviceAddress').value}-${Date.now()}` },
          body: {
            site_id: siteId,
            address: $('#deviceAddress').value,
            device_type: $('#deviceType').value || 'router',
            protocol: $('input[name="protocol"]:checked').value,
          },
        });
        if (runId !== probeRunId) return;
        const result = operation.result || {};
        const labels = [
          [result.icmp?.ok ? `Ответ получен за ${result.icmp.latency_ms || '—'} мс` : 'ICMP недоступен', result.icmp?.ok ? `${result.icmp.latency_ms || '—'} мс` : 'Ошибка'],
          [result.protocol?.ok ? `${result.protocol.version || 'protocol'} доступен` : 'Протокол недоступен', result.protocol?.ok ? 'Доступен' : 'Ошибка'],
          ['Профиль принят устройством', 'Успешно'],
          [`${result.identity?.vendor || 'Unknown'} ${result.identity?.model || ''}`.trim(), 'Определено'],
        ];
        labels.forEach((label, index) => {
          const item = checks[index];
          item.className = 'success';
          $('i', item).innerHTML = icon('i-check');
          $('small', item).textContent = label[0];
          $('em', item).textContent = label[1];
        });
        probeComplete = true;
        nextButton.disabled = false;
        $('#runProbe').disabled = false;
        $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить ещё раз`;
        $('#probeTitle').textContent = 'Подключение работает';
        $('#probeSubtitle').textContent = 'Устройство определено, настройки мониторинга подобраны';
        $('.probe-animation').classList.remove('running');
        showToast('Проверка через API завершена');
        return;
      } catch (error) {
        showToast(error.message || 'Проверка не удалась');
      }
    } else {
      showToast('API недоступен — проверка невозможна');
    }

    probeComplete = false;
    nextButton.disabled = true;
    $('#runProbe').disabled = false;
    $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить подключение`;
    $('#probeTitle').textContent = 'Проверка не выполнена';
    $('#probeSubtitle').textContent = 'Подключитесь к API и повторите';
    $('.probe-animation').classList.remove('running');
  }

  async function addDevice() {
    const name = $('#deviceName').value;
    const address = $('#deviceAddress').value;
    let site = $('#deviceSite').value;
    const typeValue = $('#deviceType').value || 'server';

    if (!accessToken || !apiOnline) {
      showToast('API недоступен — устройство не добавлено');
      return;
    }

    try {
      let siteId = sitesCache.find((item) => item.name === site)?.id;
      if (site === '__new__' || !siteId) {
        const siteName = site === '__new__' ? (prompt('Имя новой площадки', 'Основная') || 'Основная') : (site || 'Основная');
        const created = await api('/sites', {
          method: 'POST',
          body: { name: siteName, timezone: 'Europe/Moscow', tags: [] },
        });
        siteId = created.id;
        sitesCache.push(created);
        populateWizardSites(sitesCache);
      }
      await api('/devices', {
        method: 'POST',
        body: {
          site_id: siteId,
          name,
          address,
          device_type: typeValue,
          protocol: $('input[name="protocol"]:checked').value,
          monitoring_subtype: $('#guideSubtype')?.value || null,
          credential_profile_id: selectedCredentialProfileId || $('#credentialProfile')?.value || null,
          auto_provision: $('#startMonitoring')?.checked !== false,
        },
      });
      closeDialog(wizard);
      const provisionNote = $('#startMonitoring')?.checked !== false
        ? ' и отправлено в Zabbix (если API включён)'
        : '';
      showToast(`${name} добавлено в инвентарь портала${provisionNote}`);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message || 'Не удалось создать устройство');
    }
  }

  function escapeHtml(value) {
    const node = document.createElement('span');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }

  function filterBySite(value) {
    $$('[data-site-card]').forEach((card) => card.classList.toggle('is-filtered', value !== 'all' && card.dataset.siteCard !== value));
    $$('.problems-table tbody tr').forEach((row) => {
      row.hidden = value !== 'all' && row.dataset.site !== value;
    });
  }

  function searchDashboard(query) {
    const normalized = query.trim().toLowerCase();
    $$('#deviceList article').forEach((row) => {
      row.hidden = normalized && !row.textContent.toLowerCase().includes(normalized);
    });
    if (normalized) $('#devices').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  [$('#addDeviceTop'), $('#addDeviceInline')].forEach((button) => button.addEventListener('click', () => {
    resetWizard();
    openDialog(wizard);
    setTimeout(() => $('#deviceName').focus(), 80);
  }));

  $('#openSettings').addEventListener('click', () => {
    body.classList.remove('nav-open');
    openDialog(settings);
  });
  $('#runProbe').addEventListener('click', () => { runProbe(); });
  $$('input[name="protocol"]').forEach((input) => input.addEventListener('change', updateConnectionGuide));
  $('#deviceType')?.addEventListener('change', () => {
    applySuggestedProtocol($('#deviceType').value || '');
    updateConnectionGuide();
  });
  $('#guideSubtype')?.addEventListener('change', updateConnectionGuide);
  $('#refreshCredentialProfile')?.addEventListener('click', () => {
    ensureMonitoringProfile().then((result) => {
      if (result) showToast(`Профиль «${result.profile.name}» готов`);
    });
  });
  $('#credentialProfile')?.addEventListener('change', (event) => {
    selectedCredentialProfileId = event.target.value;
  });
  nextButton.addEventListener('click', advance);
  backButton.addEventListener('click', () => { if (currentStep > 1) { currentStep -= 1; renderStep(); } });

  $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog($(`#${button.dataset.close}`))));
  [wizard, settings].forEach((dialog) => dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));

  bindAcknowledgeButtons();
  $$('[data-toast]').forEach((button) => button.addEventListener('click', () => showToast(button.dataset.toast)));
  $$('[data-scroll]').forEach((button) => button.addEventListener('click', () => $(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' })));
  $('#siteFilter').addEventListener('change', (event) => filterBySite(event.target.value));
  $('#globalSearch').addEventListener('search', (event) => searchDashboard(event.target.value));
  $('#globalSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchDashboard(event.target.value); });
  $('#addSite').addEventListener('click', () => showToast('Добавление площадки доступно в настройках'));
  $('#reconnectApi')?.addEventListener('click', () => {
    promptLogin().then((ok) => {
      if (!ok) return;
      refreshDashboard().then(() => showToast('Синхронизация с API выполнена')).catch((error) => showToast(error.message || 'Ошибка API'));
    });
  });

  $('#loginForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    closeLoginDialog(true);
  });
  $$('[data-close="loginDialog"]').forEach((button) => button.addEventListener('click', () => closeLoginDialog(false)));
  $('#loginDialog')?.addEventListener('click', (event) => {
    if (event.target.id === 'loginDialog') closeLoginDialog(false);
  });

  $('#menuButton').addEventListener('click', () => body.classList.add('nav-open'));
  $('#sidebarClose').addEventListener('click', () => body.classList.remove('nav-open'));
  $('#sidebarScrim').addEventListener('click', () => body.classList.remove('nav-open'));
  $$('.side-nav a').forEach((link) => link.addEventListener('click', () => {
    body.classList.remove('nav-open');
    syncNavFromHash();
  }));
  window.addEventListener('hashchange', syncNavFromHash);

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#globalSearch').focus();
    }
  });

  refreshDashboard().catch((error) => {
    setFooter('Не удалось загрузить API');
    showToast(error.message || 'Ошибка загрузки dashboard');
  });
  syncNavFromHash();
})();
