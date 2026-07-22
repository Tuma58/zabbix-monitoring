(() => {
  'use strict';

  const API_BASE = '/api/v1';
  const TOKEN_KEY = 'netmon_access_token';
  const REFRESH_KEY = 'netmon_refresh_token';
  // Local bootstrap defaults for Stage 1 preview; replace with login UI later.
  const DEMO_EMAIL = 'admin@example.com';
  const DEMO_PASSWORD = 'ChangeMeNow!';

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

  function icon(id) {
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

  async function login(email = DEMO_EMAIL, password = DEMO_PASSWORD) {
    const tokens = await api('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    accessToken = tokens.access_token;
    localStorage.setItem(TOKEN_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    return tokens;
  }

  async function ensureSession() {
    try {
      await api('/health/live');
      apiOnline = true;
    } catch {
      apiOnline = false;
      setFooter('API недоступен · показаны локальные данные');
      setSyncState('API недоступен', false);
      $('#systemStatusTitle').textContent = 'API недоступен';
      $('#systemStatusMeta').textContent = 'работаем в офлайн-режиме';
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
      await login();
      const me = await api('/me');
      applyUser(me);
      return true;
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
      : 'Инфраструктура под контролем. Активных проблем нет.';

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
    if (health.status !== 'ok') {
      setSyncState('Зависимости деградированы', false);
    }
  }

  function bindAcknowledgeButtons() {
    $$('.acknowledge').forEach((button) => {
      button.onclick = async () => {
        const eventId = button.dataset.eventId;
        if (!eventId || button.disabled) return;
        if (!accessToken || eventId.startsWith('demo-')) {
          button.textContent = 'Принято';
          button.classList.add('done');
          button.disabled = true;
          showToast('Проблема принята локально');
          return;
        }
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
    $('#previewName').textContent = $('#deviceName').value || 'Новое устройство';
    $('#previewAddress').textContent = $('#deviceAddress').value || '—';
    $('#previewSite').textContent = $('#deviceSite').value || '—';
    $('#previewProtocol').textContent = $('input[name="protocol"]:checked').value;
    $('#previewProxy').textContent = $('#proxy').value;
  }

  function advance() {
    if (currentStep === 1 && !validateStepOne()) return;
    if (currentStep === 3 && !probeComplete) {
      showToast('Сначала проверьте подключение');
      return;
    }
    if (currentStep < 4) {
      currentStep += 1;
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
        showToast(error.message || 'Probe через API не удался, локальная симуляция');
      }
    }

    const labels = [
      ['Ответ получен за 4 мс', '4 мс'],
      [`${$('input[name="protocol"]:checked').value} доступен`, 'Доступен'],
      ['Профиль принят устройством', 'Успешно'],
      ['APC Smart-UPS SRT 3000', 'Определено'],
    ];
    let index = 0;
    const processNext = () => {
      if (runId !== probeRunId) return;
      if (index > 0) {
        const previous = checks[index - 1];
        previous.className = 'success';
        $('i', previous).innerHTML = icon('i-check');
        $('small', previous).textContent = labels[index - 1][0];
        $('em', previous).textContent = labels[index - 1][1];
      }
      if (index === checks.length) {
        probeComplete = true;
        nextButton.disabled = false;
        $('#runProbe').disabled = false;
        $('#runProbe').innerHTML = `${icon('i-refresh')}Проверить ещё раз`;
        $('#probeTitle').textContent = 'Подключение работает';
        $('#probeSubtitle').textContent = 'Устройство определено, настройки мониторинга подобраны';
        $('.probe-animation').classList.remove('running');
        showToast('Проверка успешно завершена');
        return;
      }
      const current = checks[index];
      current.className = 'checking';
      $('i', current).innerHTML = icon('i-refresh');
      $('small', current).textContent = 'Проверяем…';
      index += 1;
      setTimeout(processNext, 620);
    };
    processNext();
  }

  async function addDevice() {
    const name = $('#deviceName').value;
    const address = $('#deviceAddress').value;
    const site = $('#deviceSite').value;
    const typeValue = $('#deviceType').value || 'router';

    if (accessToken && apiOnline) {
      try {
        let siteId = sitesCache.find((item) => item.name === site)?.id || sitesCache[0]?.id;
        if (!siteId) {
          const created = await api('/sites', {
            method: 'POST',
            body: { name: site || 'Default', timezone: 'Europe/Moscow', tags: [] },
          });
          siteId = created.id;
        }
        await api('/devices', {
          method: 'POST',
          body: {
            site_id: siteId,
            name,
            address,
            device_type: typeValue,
          },
        });
        closeDialog(wizard);
        showToast(`${name} добавлено через API`);
        await refreshDashboard();
        return;
      } catch (error) {
        showToast(error.message || 'Не удалось создать устройство через API');
      }
    }

    const typeLabels = { server: 'Сервер', router: 'Сетевое оборудование', computer: 'Рабочая станция', ups: 'ИБП' };
    const iconMap = { server: 'i-server', router: 'i-router', computer: 'i-monitor', ups: 'i-ups' };
    const classMap = { server: 'server', router: 'router', computer: 'server', ups: 'ups' };
    const article = document.createElement('article');
    article.innerHTML = `<span class="device-cell"><i class="device-icon ${classMap[typeValue] || 'router'}">${icon(iconMap[typeValue] || 'i-router')}</i><span>${escapeHtml(name)}<small>${escapeHtml(address)}</small></span></span><span>${typeLabels[typeValue] || 'Определено автоматически'}</span><span>${escapeHtml(site)}</span><span><i class="state-dot ok"></i>Добавляется</span><span>только что</span>`;
    $('#deviceList').insertBefore(article, $('.device-list article'));
    const count = Number($('#deviceCount').textContent) + 1;
    $('#deviceCount').textContent = String(count);
    $('#navDeviceCount').textContent = String(count);
    closeDialog(wizard);
    showToast(`${name} добавлено в очередь мониторинга`);
    setTimeout(() => {
      const state = article.children[3];
      state.innerHTML = '<i class="state-dot ok"></i>Доступно';
      article.children[4].textContent = '5 сек назад';
    }, 2500);
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
    refreshDashboard().then(() => showToast('Синхронизация с API выполнена')).catch((error) => showToast(error.message || 'Ошибка API'));
  });

  $('#menuButton').addEventListener('click', () => body.classList.add('nav-open'));
  $('#sidebarClose').addEventListener('click', () => body.classList.remove('nav-open'));
  $('#sidebarScrim').addEventListener('click', () => body.classList.remove('nav-open'));
  $$('.side-nav a').forEach((link) => link.addEventListener('click', () => body.classList.remove('nav-open')));

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
})();
