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
  const isAddDevicePage = body.dataset.page === 'add-device';
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
  let devicesCache = [];
  let credentialProfiles = [];
  let selectedCredentialProfileId = '';
  let probeNetworksDraft = [];
  let probeNetworksDefaults = [];
  const siteDialog = $('#siteDialog');
  const deviceEditDialog = $('#deviceEditDialog');

  const NAV_SECTIONS = ['overview', 'devices', 'problems', 'sites'];

  function icon(id) {
    return `<svg><use href="#${id}"/></svg>`;
  }

  function showToast(message, variant = 'ok') {
    $('p', toast).textContent = message;
    toast.classList.toggle('toast-error', variant === 'error');
    const iconWrap = $('span', toast);
    if (iconWrap) {
      iconWrap.innerHTML = variant === 'error' ? icon('i-alert') : icon('i-check');
    }
    // Native <dialog showModal()> uses the top layer; toast must live inside an open dialog to be visible.
    const openModal = document.querySelector('dialog[open]');
    if (openModal && toast.parentElement !== openModal) openModal.appendChild(toast);
    else if (!openModal && toast.parentElement !== document.body) document.body.appendChild(toast);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function setProbeChecks(state, details = []) {
    const checks = $$('.check-list > div');
    checks.forEach((item, index) => {
      const detail = details[index];
      if (state === 'checking') {
        item.className = 'checking';
        $('i', item).innerHTML = icon('i-refresh');
        $('small', item).textContent = 'Проверяем…';
        $('em', item).textContent = '…';
        return;
      }
      if (state === 'failed') {
        item.className = 'failed';
        $('i', item).innerHTML = icon('i-alert');
        $('small', item).textContent = detail?.[0] || 'Проверка не выполнена';
        $('em', item).textContent = detail?.[1] || 'Ошибка';
        return;
      }
      if (state === 'success') {
        item.className = 'success';
        $('i', item).innerHTML = icon('i-check');
        $('small', item).textContent = detail?.[0] || 'Успешно';
        $('em', item).textContent = detail?.[1] || 'OK';
      }
    });
  }

  function resolveWizardSiteId() {
    const selected = $('#deviceSite')?.value || '';
    if (selected && selected !== '__new__') {
      const byName = sitesCache.find((item) => item.name === selected);
      if (byName) return byName.id;
      const byId = sitesCache.find((item) => item.id === selected);
      if (byId) return byId.id;
    }
    return sitesCache[0]?.id || '';
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function closeWizard() {
    if (!wizard) return;
    if (wizard.tagName === 'DIALOG') closeDialog(wizard);
    else window.location.href = 'index.html#devices';
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
      if ($('#systemStatusTitle')) $('#systemStatusTitle').textContent = 'API недоступен';
      if ($('#systemStatusMeta')) $('#systemStatusMeta').textContent = 'проверьте подключение';
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
      if ($('#systemStatusTitle')) $('#systemStatusTitle').textContent = 'Нет сессии';
      if ($('#systemStatusMeta')) $('#systemStatusMeta').textContent = error.message || 'login failed';
      return false;
    }
  }

  function applyUser(me) {
    const name = me.email.split('@')[0];
    if ($('#userName')) $('#userName').textContent = name;
    if ($('#userRole')) $('#userRole').textContent = (me.roles || []).join(', ') || 'viewer';
    if ($('#userAvatar')) $('#userAvatar').textContent = name.slice(0, 2).toUpperCase();
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
    devicesCache = devices;
    const head = list.querySelector('.device-list-head');
    list.innerHTML = '';
    if (head) list.appendChild(head);
    else {
      const heading = document.createElement('div');
      heading.className = 'device-list-head';
      heading.innerHTML = '<span>Устройство</span><span>Тип</span><span>Площадка</span><span>Состояние</span><span>Действия</span>';
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
      article.innerHTML = `
        <span class="device-cell"><i class="device-icon ${device.device_type === 'ups' ? 'ups' : device.device_type === 'server' ? 'server' : 'router'}">${icon(device.device_type === 'ups' ? 'i-ups' : device.device_type === 'server' ? 'i-server' : 'i-router')}</i><span>${escapeHtml(device.name)}<small>${escapeHtml(device.address)}</small></span></span>
        <span>${escapeHtml(device.device_type)}${device.protocol ? `<small>${escapeHtml(device.protocol)}</small>` : ''}</span>
        <span>${escapeHtml(siteName)}</span>
        <span><i class="state-dot ${statusDot(device.status)}"></i>${statusLabel(device.status)}</span>
        <span class="device-actions">
          <button type="button" class="row-action" data-edit-device="${escapeHtml(device.id)}">Изменить</button>
          <button type="button" class="row-action danger" data-delete-device="${escapeHtml(device.id)}">Удалить</button>
        </span>`;
      list.appendChild(article);
    });
    bindDeviceActions();
  }

  function renderSites(sites, devices) {
    const grid = $('#siteGrid');
    if (!grid) return;
    if (!sites.length) {
      grid.innerHTML = '<article class="site-card empty-state"><p>Площадок пока нет. Создайте первую кнопкой «Добавить площадку».</p></article>';
      const filter = $('#siteFilter');
      if (filter) filter.innerHTML = '<option value="all">Все площадки</option>';
      return;
    }
    const counts = devices.reduce((acc, device) => {
      acc[device.site_id] = (acc[device.site_id] || 0) + 1;
      return acc;
    }, {});
    grid.innerHTML = sites.map((site) => {
      const count = counts[site.id] || site.devices_count || 0;
      const slug = site.name.toLowerCase().replace(/\s+/g, '-');
      return `<article class="site-card" data-site-card="${escapeHtml(slug)}" data-site-id="${escapeHtml(site.id)}">
        <div class="site-top"><span class="site-icon">${icon('i-map')}</span><span class="site-health ok">В норме</span></div>
        <h3>${escapeHtml(site.name)}</h3>
        <p>${escapeHtml(site.timezone)} · ${escapeHtml(site.proxy_id || 'без proxy')}</p>
        <div class="site-stats"><span><b>${count}</b> устройств</span><span><b>0</b> проблем</span></div>
        <div class="site-bar"><span style="width:96%"></span></div>
        <div class="site-actions">
          <button type="button" class="row-action" data-edit-site="${escapeHtml(site.id)}">Изменить</button>
          <button type="button" class="row-action danger" data-delete-site="${escapeHtml(site.id)}" ${count ? 'disabled title="Сначала удалите устройства"' : ''}>Удалить</button>
        </div>
      </article>`;
    }).join('');
    bindSiteActions();

    const filter = $('#siteFilter');
    if (filter) {
      filter.innerHTML = '<option value="all">Все площадки</option>' + sites.map((site) => {
        const slug = site.name.toLowerCase().replace(/\s+/g, '-');
        return `<option value="${escapeHtml(slug)}">${escapeHtml(site.name)}</option>`;
      }).join('');
    }
  }

  function populateSiteEditSelect(selectedId = '') {
    const select = $('#deviceEditSite');
    if (!select) return;
    select.innerHTML = sitesCache.map((site) =>
      `<option value="${escapeHtml(site.id)}"${site.id === selectedId ? ' selected' : ''}>${escapeHtml(site.name)}</option>`,
    ).join('');
  }

  function openSiteDialog(site = null) {
    $('#siteEditId').value = site?.id || '';
    $('#siteEditName').value = site?.name || '';
    $('#siteEditTimezone').value = site?.timezone || 'Europe/Moscow';
    $('#siteEditProxy').value = site?.proxy_id || '';
    $('#siteDialogTitle').textContent = site ? 'Редактирование площадки' : 'Новая площадка';
    $('#siteDialogHint').textContent = site
      ? `ID: ${site.id}`
      : 'Площадка используется для группировки устройств';
    openDialog(siteDialog);
    setTimeout(() => $('#siteEditName')?.focus(), 50);
  }

  function openDeviceEditDialog(device) {
    if (!device) return;
    $('#deviceEditId').value = device.id;
    $('#deviceEditName').value = device.name || '';
    $('#deviceEditAddress').value = device.address || '';
    $('#deviceEditType').value = device.device_type || 'router';
    $('#deviceEditProtocol').value = device.protocol || 'SNMPv3';
    $('#deviceEditStatus').value = device.status || 'draft';
    populateSiteEditSelect(device.site_id);
    $('#deviceEditTitle').textContent = device.name || 'Редактирование';
    openDialog(deviceEditDialog);
  }

  function bindSiteActions() {
    $$('[data-edit-site]').forEach((button) => {
      button.onclick = () => {
        const site = sitesCache.find((item) => item.id === button.dataset.editSite);
        if (site) openSiteDialog(site);
      };
    });
    $$('[data-delete-site]').forEach((button) => {
      button.onclick = async () => {
        if (button.disabled) return;
        const site = sitesCache.find((item) => item.id === button.dataset.deleteSite);
        if (!site) return;
        if (!window.confirm(`Удалить площадку «${site.name}»?`)) return;
        try {
          await api(`/sites/${encodeURIComponent(site.id)}`, { method: 'DELETE' });
          showToast(`Площадка «${site.name}» удалена`);
          await refreshDashboard();
        } catch (error) {
          showToast(error.payload?.message || error.message || 'Не удалось удалить площадку', 'error');
        }
      };
    });
  }

  function bindDeviceActions() {
    $$('[data-edit-device]').forEach((button) => {
      button.onclick = () => {
        const device = devicesCache.find((item) => item.id === button.dataset.editDevice);
        if (device) openDeviceEditDialog(device);
      };
    });
    $$('[data-delete-device]').forEach((button) => {
      button.onclick = async () => {
        const device = devicesCache.find((item) => item.id === button.dataset.deleteDevice);
        if (!device) return;
        if (!window.confirm(`Удалить устройство «${device.name}» (${device.address})?`)) return;
        try {
          await api(`/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
          showToast(`Устройство «${device.name}» удалено`);
          await refreshDashboard();
        } catch (error) {
          showToast(error.payload?.message || error.message || 'Не удалось удалить устройство', 'error');
        }
      };
    });
  }

  async function saveSiteForm(event) {
    event.preventDefault();
    const id = $('#siteEditId')?.value || '';
    const name = ($('#siteEditName')?.value || '').trim();
    const timezone = ($('#siteEditTimezone')?.value || 'Europe/Moscow').trim();
    const proxyId = ($('#siteEditProxy')?.value || '').trim();
    if (!name) {
      showToast('Укажите название площадки', 'error');
      return;
    }
    const body = {
      name,
      timezone: timezone || 'Europe/Moscow',
      proxy_id: proxyId || null,
      tags: [],
    };
    try {
      if (id) {
        await api(`/sites/${encodeURIComponent(id)}`, { method: 'PATCH', body });
        showToast(`Площадка «${name}» обновлена`);
      } else {
        await api('/sites', { method: 'POST', body });
        showToast(`Площадка «${name}» создана`);
      }
      closeDialog(siteDialog);
      await refreshDashboard();
      navigateToSection('sites');
    } catch (error) {
      showToast(error.payload?.message || error.message || 'Не удалось сохранить площадку', 'error');
    }
  }

  async function saveDeviceEditForm(event) {
    event.preventDefault();
    const id = $('#deviceEditId')?.value;
    if (!id) return;
    const body = {
      name: ($('#deviceEditName')?.value || '').trim(),
      address: ($('#deviceEditAddress')?.value || '').trim(),
      site_id: $('#deviceEditSite')?.value,
      device_type: $('#deviceEditType')?.value,
      protocol: $('#deviceEditProtocol')?.value,
      status: $('#deviceEditStatus')?.value,
    };
    if (!body.name || !body.address || !body.site_id) {
      showToast('Заполните обязательные поля', 'error');
      return;
    }
    try {
      await api(`/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      closeDialog(deviceEditDialog);
      showToast(`Устройство «${body.name}» обновлено`);
      await refreshDashboard();
      navigateToSection('devices');
    } catch (error) {
      showToast(error.payload?.message || error.message || 'Не удалось сохранить устройство', 'error');
    }
  }

  async function createSiteInteractive() {
    if (!accessToken || !apiOnline) {
      const loggedIn = await promptLogin('Войдите, чтобы добавить площадку');
      if (!loggedIn) return;
    }
    openSiteDialog(null);
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
    const settingsDevicesMeta = $('#settingsDevicesMeta');
    const settingsDevicesCount = $('#settingsDevicesCount');
    if (settingsDevicesMeta) settingsDevicesMeta.textContent = `${summary.devices_total || 0} в каталоге`;
    if (settingsDevicesCount) settingsDevicesCount.textContent = String(summary.devices_total || 0);
    const settingsSystemMeta = $('#settingsSystemMeta');
    const settingsSystemStatus = $('#settingsSystemStatus');
    if (settingsSystemMeta) settingsSystemMeta.textContent = summary.stale ? 'Данные устарели' : 'API и portal DB';
    if (settingsSystemStatus) {
      settingsSystemStatus.textContent = summary.stale ? 'Внимание' : 'В норме';
      settingsSystemStatus.classList.toggle('setting-ok', !summary.stale);
    }
  }

  function showSettingsHome() {
    $('#settingsHome')?.removeAttribute('hidden');
    $('#probeNetworksPanel')?.setAttribute('hidden', '');
  }

  function showProbeNetworksPanel() {
    $('#settingsHome')?.setAttribute('hidden', '');
    $('#probeNetworksPanel')?.removeAttribute('hidden');
  }

  function renderProbeNetworksList() {
    const list = $('#probeNetworksList');
    if (!list) return;
    if (!probeNetworksDraft.length) {
      list.innerHTML = '<li><span>Список пуст</span></li>';
      return;
    }
    list.innerHTML = probeNetworksDraft.map((cidr, index) =>
      `<li><code>${escapeHtml(cidr)}</code><button type="button" class="text-button" data-remove-network="${index}">Удалить</button></li>`,
    ).join('');
    $$('[data-remove-network]', list).forEach((button) => {
      button.addEventListener('click', () => {
        const idx = Number(button.dataset.removeNetwork);
        probeNetworksDraft.splice(idx, 1);
        renderProbeNetworksList();
      });
    });
  }

  function normalizeNetworkInput(value) {
    const raw = (value || '').trim();
    if (!raw) return '';
    if (raw.includes('/')) return raw;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return `${raw}/32`;
    return raw;
  }

  async function loadProbeNetworks() {
    if (!accessToken || !apiOnline) return;
    try {
      const payload = await api('/settings/probe-networks');
      probeNetworksDraft = [...(payload.networks || [])];
      probeNetworksDefaults = [...(payload.defaults || [])];
      const count = probeNetworksDraft.length;
      const meta = $('#settingsNetworksMeta');
      const countNode = $('#settingsNetworksCount');
      const source = $('#probeNetworksSource');
      if (meta) meta.textContent = `${count} сетей · источник ${payload.source === 'database' ? 'БД' : 'env'}`;
      if (countNode) countNode.textContent = String(count);
      if (source) {
        source.textContent = payload.source === 'database'
          ? 'Сети сохранены в базе портала и используются при проверке устройств.'
          : 'Сейчас используются значения по умолчанию из конфигурации сервера. Сохраните список, чтобы управлять им здесь.';
      }
      renderProbeNetworksList();
    } catch (error) {
      showToast(error.message || 'Не удалось загрузить список сетей', 'error');
    }
  }

  async function saveProbeNetworks() {
    if (!probeNetworksDraft.length) {
      showToast('Добавьте хотя бы одну сеть', 'error');
      return;
    }
    try {
      const payload = await api('/settings/probe-networks', {
        method: 'PUT',
        body: { networks: probeNetworksDraft },
      });
      probeNetworksDraft = [...payload.networks];
      renderProbeNetworksList();
      await loadProbeNetworks();
      showToast('Список разрешённых сетей сохранён');
    } catch (error) {
      showToast(error.payload?.message || error.message || 'Не удалось сохранить сети', 'error');
    }
  }

  async function resetProbeNetworks() {
    try {
      const payload = await api('/settings/probe-networks/reset', { method: 'POST' });
      probeNetworksDraft = [...payload.networks];
      renderProbeNetworksList();
      await loadProbeNetworks();
      showToast('Список сетей сброшен к умолчанию');
    } catch (error) {
      showToast(error.payload?.message || error.message || 'Не удалось сбросить сети', 'error');
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

    if (isAddDevicePage) {
      const [sites, health] = await Promise.all([
        api('/sites'),
        api('/health/ready'),
      ]);
      sitesCache = sites;
      populateWizardSites(sites);
      await loadCredentialProfiles();
      if ($('#systemStatusTitle')) {
        $('#systemStatusTitle').textContent = health.status === 'ok' ? 'Система работает' : 'Зависимости деградированы';
      }
      if ($('#systemStatusMeta')) {
        $('#systemStatusMeta').textContent = health.status === 'ok' ? 'API · готов к добавлению' : 'проверьте сервисы';
      }
      setSyncState(health.status === 'ok' ? 'Готово к добавлению' : 'Зависимости деградированы', health.status === 'ok');
      setFooter('Мастер добавления · /api/v1');
      return;
    }

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
    await loadProbeNetworks();
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

  function navigateToSection(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target) return;
    window.location.hash = sectionId;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    syncNavFromHash();
    body.classList.remove('nav-open');
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
    $('#probeError')?.setAttribute('hidden', '');
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
    const address = ($('#deviceAddress')?.value || '').trim();
    probeComplete = false;
    nextButton.disabled = true;
    $('#runProbe').disabled = true;
    $('#runProbe').innerHTML = `${icon('i-refresh')}Проверяем…`;
    $('#probeTitle').textContent = `Проверяем ${address || 'устройство'}`;
    $('#probeSubtitle').textContent = 'Запрос выполняется через API портала';
    $('#probeError')?.setAttribute('hidden', '');
    $('.probe-animation')?.classList.add('running');
    setProbeChecks('checking');

    if (!address) {
      finishProbeFailure(runId, 'Укажите IP-адрес или FQDN устройства', [
        ['Адрес не задан', 'Ошибка'],
        ['Протокол не проверялся', '—'],
        ['Авторизация не проверялась', '—'],
        ['Модель не определена', '—'],
      ]);
      return;
    }

    if (!accessToken || !apiOnline) {
      finishProbeFailure(runId, 'Нет сессии API. Войдите в систему и повторите проверку.', [
        ['API недоступен или нет сессии', 'Ошибка'],
        ['Протокол не проверялся', '—'],
        ['Авторизация не проверялась', '—'],
        ['Модель не определена', '—'],
      ]);
      return;
    }

    try {
      let siteId = resolveWizardSiteId();
      if (!siteId) {
        const sites = await api('/sites');
        sitesCache = sites;
        siteId = resolveWizardSiteId() || sites[0]?.id;
      }
      if (!siteId) {
        const siteName = ($('#deviceSite')?.value && $('#deviceSite').value !== '__new__')
          ? $('#deviceSite').value
          : 'Основная';
        const created = await api('/sites', {
          method: 'POST',
          body: { name: siteName, timezone: 'Europe/Moscow', tags: [] },
        });
        siteId = created.id;
        sitesCache = [created, ...sitesCache.filter((item) => item.id !== created.id)];
        populateWizardSites(sitesCache);
      }

      const operation = await api('/devices/probe', {
        method: 'POST',
        headers: { 'Idempotency-Key': `probe-${address}-${Date.now()}` },
        body: {
          site_id: siteId,
          address,
          device_type: $('#deviceType').value || 'router',
          protocol: $('input[name="protocol"]:checked')?.value || 'SNMPv3',
          credential_profile_id: selectedCredentialProfileId || $('#credentialProfile')?.value || null,
        },
      });
      if (runId !== probeRunId) return;

      const result = operation.result || {};
      const failed = result.icmp?.ok === false || result.protocol?.ok === false;
      const labels = [
        [
          result.icmp?.ok
            ? `Ответ получен за ${result.icmp.latency_ms ?? '—'} мс`
            : (result.icmp?.error || 'ICMP недоступен'),
          result.icmp?.ok ? `${result.icmp.latency_ms ?? '—'} мс` : 'Ошибка',
        ],
        [
          result.protocol?.ok
            ? `${result.protocol.version || 'protocol'} доступен`
            : (result.protocol?.error || 'Протокол недоступен'),
          result.protocol?.ok ? 'Доступен' : 'Ошибка',
        ],
        [
          result.auth?.ok === false
            ? (result.auth?.error || 'Авторизация не прошла')
            : 'Профиль принят устройством',
          result.auth?.ok === false ? 'Ошибка' : 'Успешно',
        ],
        [
          `${result.identity?.vendor || 'Unknown'} ${result.identity?.model || ''}`.trim(),
          result.identity ? 'Определено' : '—',
        ],
      ];

      if (failed) {
        finishProbeFailure(
          runId,
          result.warnings?.[0] || 'Устройство не ответило на проверку. Проверьте адрес, firewall и протокол.',
          labels.map((label, index) => {
            if (index === 0 && result.icmp?.ok === false) return label;
            if (index === 1 && result.protocol?.ok === false) return label;
            return label;
          }),
        );
        return;
      }

      setProbeChecks('success', labels);
      probeComplete = true;
      nextButton.disabled = false;
      $('#runProbe').disabled = false;
      $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить ещё раз`;
      $('#probeTitle').textContent = 'Подключение работает';
      $('#probeSubtitle').textContent = 'Устройство определено, настройки мониторинга подобраны';
      $('#probeError')?.setAttribute('hidden', '');
      $('.probe-animation')?.classList.remove('running');
      showToast('Проверка через API завершена');
    } catch (error) {
      const message = error?.payload?.message || error.message || 'Проверка не удалась';
      const details = error?.payload?.details;
      const detailText = details?.address
        ? `${message} (адрес: ${details.address})`
        : message;
      finishProbeFailure(runId, detailText, [
        [detailText, 'Ошибка'],
        ['Протокол не проверялся', '—'],
        ['Авторизация не проверялась', '—'],
        ['Модель не определена', '—'],
      ]);
    }
  }

  function finishProbeFailure(runId, message, labels) {
    if (runId !== probeRunId) return;
    probeComplete = false;
    nextButton.disabled = true;
    $('#runProbe').disabled = false;
    $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить подключение`;
    $('#probeTitle').textContent = 'Проверка не выполнена';
    $('#probeSubtitle').textContent = message;
    const errorNode = $('#probeError');
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = message;
    }
    setProbeChecks('failed', labels);
    $('.probe-animation')?.classList.remove('running');
    showToast(message, 'error');
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
      closeWizard();
      const provisionNote = $('#startMonitoring')?.checked !== false
        ? ' и отправлено в Zabbix (если API включён)'
        : '';
      showToast(`${name} добавлено в инвентарь портала${provisionNote}`);
      if (isAddDevicePage) {
        setTimeout(() => { window.location.href = 'index.html#devices'; }, 600);
        return;
      }
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

  [$('#addDeviceTop'), $('#addDeviceInline')].filter(Boolean).forEach((button) => {
    if (button.tagName === 'A') return;
    button.addEventListener('click', () => {
      window.location.href = 'add-device.html';
    });
  });

  if (isAddDevicePage && wizard && form) {
    resetWizard();
    setTimeout(() => $('#deviceName')?.focus(), 80);
  }

  $('#openSettings')?.addEventListener('click', () => {
    body.classList.remove('nav-open');
    if (!settings) {
      showToast('Диалог настроек не найден');
      return;
    }
    showSettingsHome();
    loadProbeNetworks();
    openDialog(settings);
  });
  $('#openProbeNetworks')?.addEventListener('click', () => {
    showProbeNetworksPanel();
    loadProbeNetworks();
  });
  $('#backToSettingsHome')?.addEventListener('click', () => showSettingsHome());
  $('#probeNetworkAdd')?.addEventListener('click', () => {
    const input = $('#probeNetworkInput');
    const value = normalizeNetworkInput(input?.value || '');
    if (!value) {
      showToast('Введите CIDR или IP', 'error');
      return;
    }
    if (probeNetworksDraft.includes(value)) {
      showToast('Такая сеть уже есть', 'error');
      return;
    }
    probeNetworksDraft.push(value);
    if (input) input.value = '';
    renderProbeNetworksList();
  });
  $('#probeNetworkInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#probeNetworkAdd')?.click();
    }
  });
  $('#probeNetworksForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveProbeNetworks();
  });
  $('#probeNetworksReset')?.addEventListener('click', () => resetProbeNetworks());
  $('#runProbe')?.addEventListener('click', () => { runProbe(); });
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
  nextButton?.addEventListener('click', advance);
  backButton?.addEventListener('click', () => { if (currentStep > 1) { currentStep -= 1; renderStep(); } });

  $$('[data-close]').forEach((button) => button.addEventListener('click', () => {
    const dialog = $(`#${button.dataset.close}`);
    if (button.dataset.close === 'loginDialog') closeLoginDialog(false);
    else if (button.dataset.close === 'deviceWizard') closeWizard();
    else closeDialog(dialog);
  }));
  [wizard, settings, siteDialog, deviceEditDialog, $('#loginDialog')].filter(Boolean).forEach((dialog) => {
    if (dialog.tagName !== 'DIALOG') return;
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      if (dialog.id === 'loginDialog') closeLoginDialog(false);
      else if (dialog.id === 'deviceWizard') closeWizard();
      else closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'loginDialog' && typeof dialog._loginResolve === 'function') {
        dialog._loginResolve(false);
        dialog._loginResolve = null;
      }
    });
  });

  $('#siteForm')?.addEventListener('submit', saveSiteForm);
  $('#deviceEditForm')?.addEventListener('submit', saveDeviceEditForm);

  bindAcknowledgeButtons();
  $$('[data-toast]').forEach((button) => button.addEventListener('click', () => showToast(button.dataset.toast)));
  $$('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
    const selector = button.dataset.scroll;
    const id = selector?.startsWith('#') ? selector.slice(1) : selector;
    if (id) navigateToSection(id);
  }));
  $$('[data-nav-section]').forEach((button) => button.addEventListener('click', () => {
    closeDialog(settings);
    navigateToSection(button.dataset.navSection);
  }));
  $('#siteFilter')?.addEventListener('change', (event) => filterBySite(event.target.value));
  $('#globalSearch')?.addEventListener('search', (event) => searchDashboard(event.target.value));
  $('#globalSearch')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchDashboard(event.target.value); });
  $('#addSite')?.addEventListener('click', () => { createSiteInteractive(); });
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

  $('#menuButton')?.addEventListener('click', () => body.classList.add('nav-open'));
  $('#sidebarClose')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $('#sidebarScrim')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $$('.side-nav a[href^="#"]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const sectionId = link.getAttribute('href')?.slice(1);
    if (sectionId) navigateToSection(sectionId);
  }));
  window.addEventListener('hashchange', syncNavFromHash);

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#globalSearch')?.focus();
    }
  });

  refreshDashboard().catch((error) => {
    setFooter('Не удалось загрузить API');
    showToast(error.message || 'Ошибка загрузки dashboard');
  });
  if (!isAddDevicePage) syncNavFromHash();
})();
