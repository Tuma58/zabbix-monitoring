(() => {
  'use strict';

  const API = '/api/v1';
  const TOKEN_KEY = 'aimon_token';
  const USER_KEY = 'aimon_user';
  const CAPS = {
    admin: new Set(['users', 'hosts_read', 'hosts_write', 'sites', 'scan', 'secrets', 'ai', 'settings', 'agents_token']),
    engineer: new Set(['hosts_read', 'hosts_write', 'sites', 'scan', 'secrets', 'ai', 'settings', 'agents_token']),
    user: new Set(['hosts_read']),
  };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const body = document.body;

  let toastTimer;
  let cache = { hosts: [], sites: [], secrets: [], users: [] };
  let currentUser = null;
  let refreshTimer = null;
  let hostSort = { key: 'name', dir: 1 };
  let hostFilters = { name: '', address: '', site: '', type: '', device: '', state: '' };
  let clientAccessDraft = [];
  let clientAccessInfo = { client_ip: '', source: 'env' };

  function toast(message, ok = true) {
    const el = $('#toast');
    $('p', el).textContent = message;
    el.classList.toggle('err', !ok);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function can(cap) {
    const role = currentUser?.role || 'user';
    return (CAPS[role] || CAPS.user).has(cap);
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    currentUser = user;
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    currentUser = null;
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      logout(false);
      const err = new Error('Требуется авторизация');
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const detail = data?.detail;
      const msg = typeof detail === 'string' ? detail : (detail?.msg || data?.message || `HTTP ${res.status}`);
      const err = new Error(msg);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function esc(v) { const d = document.createElement('span'); d.textContent = v == null ? '' : String(v); return d.innerHTML; }

  function applyPermissions() {
    const role = currentUser?.role || 'user';
    body.classList.toggle('can-write', can('hosts_write'));
    body.classList.toggle('can-sites', can('sites'));
    body.classList.toggle('can-ai', can('ai'));
    body.dataset.role = role;
    $$('.nav-item[data-cap]').forEach((n) => {
      n.hidden = !can(n.dataset.cap);
    });
    const name = currentUser?.display_name || currentUser?.username || '—';
    const roleLabel = currentUser?.role_label || role;
    if ($('#userName')) $('#userName').textContent = name;
    if ($('#userRole')) $('#userRole').textContent = roleLabel;
    if ($('#setUser')) $('#setUser').textContent = `${name} · ${roleLabel}`;
    if ($('#usersCard')) $('#usersCard').hidden = !can('users');
    if ($('#aiFab')) $('#aiFab').hidden = !can('ai');
  }

  function showLogin() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    body.classList.remove('authed', 'can-write', 'can-sites', 'can-ai');
    if ($('#appShell')) $('#appShell').hidden = true;
    if ($('#loginGate')) $('#loginGate').hidden = false;
    if ($('#aiFab')) $('#aiFab').hidden = true;
    if ($('#loginPass')) $('#loginPass').value = '';
    if ($('#loginError')) $('#loginError').hidden = true;
    $('#loginUser')?.focus();
  }

  function enterApp() {
    if ($('#loginGate')) $('#loginGate').hidden = true;
    if ($('#appShell')) $('#appShell').hidden = false;
    body.classList.add('authed');
    applyPermissions();
    let view = location.hash.slice(1) || 'overview';
    const nav = $(`.nav-item[data-view="${view}"]`);
    if (!nav || nav.hidden) view = 'overview';
    showView(view);
    refresh();
    if (can('ai')) loadChatHistory();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 30000);
  }

  function logout(showToast = true) {
    clearSession();
    showLogin();
    if (showToast) toast('Вы вышли из системы');
  }

  /* ---------- Navigation ---------- */
  function showView(name) {
    const nav = $(`.nav-item[data-view="${name}"]`);
    if (nav?.hidden) name = 'overview';
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    body.classList.remove('nav-open');
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
    if (name === 'settings' && can('users')) loadUsers();
    if (name === 'settings' && can('settings')) loadClientAccess();
  }
  $$('.nav-item').forEach((n) => n.addEventListener('click', (e) => { e.preventDefault(); showView(n.dataset.view); }));
  $$('[data-goto]').forEach((b) => {
    const go = () => {
      showView(b.dataset.goto);
      if (b.dataset.goto === 'assistant') $('#chatInput')?.focus();
    };
    b.addEventListener('click', go);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v) showView(v); });

  $('#navOpen')?.addEventListener('click', () => body.classList.add('nav-open'));
  $('#navClose')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $('#scrim')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $('#aiFab')?.addEventListener('click', () => { showView('assistant'); $('#chatInput')?.focus(); });
  $('#logoutBtn')?.addEventListener('click', () => logout(true));

  /* ---------- Login ---------- */
  $('#loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    const errEl = $('#loginError');
    errEl.hidden = true;
    $('#loginSubmit').disabled = true;
    try {
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      setSession(res.token, res.user);
      enterApp();
      toast(`Добро пожаловать, ${res.user.display_name || res.user.username}`);
    } catch (err) {
      errEl.textContent = err.message || 'Неверный логин или пароль';
      errEl.hidden = false;
    } finally {
      $('#loginSubmit').disabled = false;
    }
  });

  /* ---------- Data rendering ---------- */
  function stateClass(s) { return s === 'up' || s === 'ok' ? '' : s === 'warn' || s === 'degraded' ? 'warn' : 'down'; }
  function stateLabel(s) { return ({ up: 'Доступен', ok: 'Доступен', warn: 'Предупреждение', degraded: 'Предупреждение', down: 'Недоступен' })[s] || s; }
  function typeLabel(t) { return t === 'snmp' ? 'SNMP' : 'Агент'; }
  function deviceLabel(h) {
    return h.device_type_label || ({
      printer: 'Принтер', ups: 'ИБП', ap: 'Точка доступа', router: 'Роутер',
      switch: 'Коммутатор', server: 'Сервер', network: 'Сеть', host: 'Хост',
    })[h.device_type] || h.device_type || 'Хост';
  }

  function renderMetrics(sum) {
    $('#mHosts').textContent = sum.hosts_total ?? 0;
    $('#navHosts').textContent = sum.hosts_total ?? 0;
    const pct = sum.hosts_total ? Math.round(((sum.hosts_up || 0) / sum.hosts_total) * 100) : 100;
    $('#mUp').innerHTML = `${pct}<span>%</span>`;
    $('#mUpNote').textContent = sum.hosts_down ? `${sum.hosts_down} недоступны` : 'все узлы доступны';
    $('#mProblems').textContent = sum.problems ?? 0;
    $('#mProblemsNote').textContent = sum.problems ? `${sum.problems} требуют внимания` : 'проблем нет';
    $('#mServices').textContent = sum.services_total ?? 0;
    $('#overviewLead').textContent = sum.hosts_total
      ? `На мониторинге ${sum.hosts_total} узлов, доступность ${pct}%.`
      : 'Узлов пока нет — установите агент одной командой или просканируйте сеть.';
  }

  function renderHostMini(hosts) {
    const box = $('#hostMini');
    if (!hosts.length) { box.innerHTML = '<div class="empty">Пока нет узлов. Установите агент одной командой или просканируйте сеть.</div>'; return; }
    box.innerHTML = hosts.slice(0, 6).map((h) => `
      <div class="row"><div><b>${esc(h.name)}</b><br><small>${esc(h.address || '')} · ${esc(deviceLabel(h))} · ${esc(typeLabel(h.type))}</small></div>
      <span class="state ${stateClass(h.state)} state-right">${stateLabel(h.state)}</span></div>`).join('');
  }

  function filteredHosts() {
    const f = hostFilters;
    let list = cache.hosts.slice();
    list = list.filter((h) => {
      if (f.name && !(h.name || '').toLowerCase().includes(f.name) && !(h.alias || '').toLowerCase().includes(f.name)) return false;
      if (f.address && !(h.address || '').toLowerCase().includes(f.address)) return false;
      const path = h.folder || h.site_path || '/';
      if (f.site && path !== f.site) return false;
      if (f.device && (h.device_type || 'host') !== f.device) return false;
      if (f.type && (h.type || 'agent') !== f.type) return false;
      if (f.state) {
        const st = h.state === 'ok' ? 'up' : (h.state === 'degraded' ? 'warn' : h.state);
        if (st !== f.state) return false;
      }
      return true;
    });
    const key = hostSort.key;
    const dir = hostSort.dir;
    list.sort((a, b) => {
      const va = (() => {
        if (key === 'site') return (a.site_title || a.folder || '').toLowerCase();
        if (key === 'device_type') return deviceLabel(a).toLowerCase();
        if (key === 'type') return typeLabel(a.type || 'agent').toLowerCase();
        if (key === 'state') return stateLabel(a.state || '').toLowerCase();
        return String(a[key] || '').toLowerCase();
      })();
      const vb = (() => {
        if (key === 'site') return (b.site_title || b.folder || '').toLowerCase();
        if (key === 'device_type') return deviceLabel(b).toLowerCase();
        if (key === 'type') return typeLabel(b.type || 'agent').toLowerCase();
        if (key === 'state') return stateLabel(b.state || '').toLowerCase();
        return String(b[key] || '').toLowerCase();
      })();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return list;
  }

  function updateSortIndicators() {
    $$('.th-sort').forEach((btn) => {
      const on = btn.dataset.sort === hostSort.key;
      btn.classList.toggle('active', on);
      btn.dataset.dir = on ? (hostSort.dir > 0 ? 'asc' : 'desc') : '';
      const ind = $('.sort-ind', btn);
      if (ind) ind.textContent = on ? (hostSort.dir > 0 ? ' ↑' : ' ↓') : '';
    });
  }

  function renderHostTable() {
    const tb = $('#hostRows');
    const write = can('hosts_write');
    const hosts = filteredHosts();
    const cols = write ? 8 : 7;
    updateSortIndicators();
    if (!hosts.length) {
      tb.innerHTML = `<tr><td colspan="${cols}" class="empty">${cache.hosts.length ? 'Нет узлов по фильтру.' : 'Узлов пока нет.'}</td></tr>`;
      updateHostBulk();
      return;
    }
    tb.innerHTML = hosts.map((h) => `
      <tr>
        ${write ? `<td><input type="checkbox" class="host-pick" value="${esc(h.name)}"></td>` : ''}
        <td><b>${esc(h.name)}</b>${h.alias ? `<br><small>${esc(h.alias)}</small>` : ''}</td>
        <td>${esc(h.address || '—')}</td>
        <td>${esc(h.site_title || h.folder || 'Корень')}</td>
        <td><span class="type-pill device">${esc(deviceLabel(h))}</span></td>
        <td><span class="type-pill ${h.type === 'snmp' ? 'snmp' : 'agent'}">${esc(typeLabel(h.type))}</span></td>
        <td><span class="state ${stateClass(h.state)}">${stateLabel(h.state)}</span></td>
        ${write ? `<td><div class="row-actions">
          <button class="btn ghost" type="button" data-edit-host="${esc(h.name)}"><svg><use href="#i-edit"/></svg>Изменить</button>
          <button class="btn ghost" type="button" data-del-host="${esc(h.name)}">Удалить</button>
        </div></td>` : ''}
      </tr>`).join('');
    if (write) {
      $$('[data-edit-host]', tb).forEach((b) => b.addEventListener('click', () => openHostModal(b.dataset.editHost)));
      $$('[data-del-host]', tb).forEach((b) => b.addEventListener('click', () => deleteHost(b.dataset.delHost)));
      $$('.host-pick', tb).forEach((c) => c.addEventListener('change', updateHostBulk));
    }
    updateHostBulk();
  }

  function selectedHostNames() {
    return $$('.host-pick').filter((c) => c.checked).map((c) => c.value);
  }

  function updateHostBulk() {
    const bar = $('#hostBulkBar');
    if (!bar) return;
    const names = selectedHostNames();
    const count = names.length;
    bar.hidden = !can('hosts_write');
    $('#hostBulkCount').textContent = count ? `Выбрано: ${count}` : 'Выберите узлы для переноса';
    $('#bulkMoveHosts').disabled = !count || !$('#bulkMoveSite')?.value;
    const all = $('#hostAll');
    if (all) {
      const picks = $$('.host-pick');
      all.checked = picks.length > 0 && picks.every((c) => c.checked);
      all.indeterminate = picks.some((c) => c.checked) && !all.checked;
    }
  }

  function fillBulkMoveSite() {
    fillSiteSelect($('#bulkMoveSite'), '/');
    fillSiteSelect($('#scanSite'), $('#scanSite')?.value || '/');
  }

  function renderSites(sites) {
    const tb = $('#siteRows');
    const countEl = $('#navSites');
    const write = can('sites');
    if (countEl) countEl.textContent = String((sites || []).length);
    if (!sites.length) { tb.innerHTML = `<tr><td colspan="${write ? 4 : 3}" class="empty">Площадок пока нет.</td></tr>`; return; }
    tb.innerHTML = sites.map((s) => {
      const isRoot = s.path === '/' || s.id === '~';
      return `<tr>
        <td><b>${esc(s.title || s.name || 'Корень')}</b>${isRoot ? '<br><small>корневая</small>' : ''}</td>
        <td><code>${esc(s.path || '/')}</code></td>
        <td>${s.hosts_count ?? 0}</td>
        ${write ? `<td><div class="row-actions">
          ${isRoot ? '' : `<button class="btn ghost" type="button" data-edit-site="${esc(s.id)}"><svg><use href="#i-edit"/></svg>Изменить</button>
          <button class="btn ghost" type="button" data-del-site="${esc(s.id)}">Удалить</button>`}
        </div></td>` : ''}
      </tr>`;
    }).join('');
    if (write) {
      $$('[data-edit-site]', tb).forEach((b) => b.addEventListener('click', () => openSiteModal(b.dataset.editSite)));
      $$('[data-del-site]', tb).forEach((b) => b.addEventListener('click', () => deleteSite(b.dataset.delSite)));
    }
  }

  function fillSiteSelect(sel, selected) {
    if (!sel) return;
    const sites = cache.sites.length ? cache.sites : [{ path: '/', title: 'Корень', id: '~' }];
    sel.innerHTML = sites.map((s) =>
      `<option value="${esc(s.path)}" ${s.path === selected ? 'selected' : ''}>${esc(s.title || s.path)}</option>`
    ).join('');
  }

  function fillHostSiteFilter() {
    const sel = $('#fHostSite');
    if (!sel) return;
    const cur = sel.value;
    const sites = cache.sites.length ? cache.sites : [{ path: '/', title: 'Корень', id: '~' }];
    sel.innerHTML = '<option value="">Все</option>' + sites.map((s) =>
      `<option value="${esc(s.path)}">${esc(s.title || s.path)}</option>`
    ).join('');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function fillSnmpSelect(sel, selected) {
    if (!sel) return;
    const snmp = cache.secrets.filter((s) => s.kind === 'snmp_v2c' || s.kind === 'snmp_v3');
    sel.innerHTML = '<option value="">public (по умолчанию)</option>' +
      snmp.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }

  function renderSecrets(items) {
    const box = $('#secretList');
    const sel = $('#scanProfile');
    if (sel) {
      const snmp = items.filter((s) => s.kind === 'snmp_v2c' || s.kind === 'snmp_v3');
      sel.innerHTML = '<option value="">Выберите профиль</option>' + snmp.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    }
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="empty">Секретов пока нет.</div>'; return; }
    const label = { snmp_v2c: 'SNMP v2c', snmp_v3: 'SNMP v3', agent_token: 'Токен агента', checkmk_automation: 'Checkmk automation' };
    box.innerHTML = items.map((s) => `
      <div class="secret">
        <span class="s-ic"><svg><use href="#i-key"/></svg></span>
        <div><b>${esc(s.name)}</b><br><small>${label[s.kind] || s.kind} · создан ${esc(s.created_at || '')}</small></div>
      </div>`).join('');
  }

  function renderUsers(users) {
    const tb = $('#userRows');
    if (!tb) return;
    if (!users.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Пользователей пока нет.</td></tr>'; return; }
    tb.innerHTML = users.map((u) => {
      const hosts = (u.hosts || []).join(', ') || (u.role === 'user' ? '—' : 'все');
      return `<tr>
        <td><b>${esc(u.display_name || u.username)}</b><br><small>${esc(u.username)}</small></td>
        <td>${esc(u.role_label || u.role)}</td>
        <td>${esc(hosts)}</td>
        <td><span class="state ${u.enabled ? '' : 'down'}">${u.enabled ? 'Активен' : 'Отключён'}</span></td>
        <td><div class="row-actions">
          <button class="btn ghost" type="button" data-edit-user="${esc(u.id)}"><svg><use href="#i-edit"/></svg>Изменить</button>
          <button class="btn ghost" type="button" data-del-user="${esc(u.id)}">Удалить</button>
        </div></td>
      </tr>`;
    }).join('');
    $$('[data-edit-user]', tb).forEach((b) => b.addEventListener('click', () => openUserModal(b.dataset.editUser)));
    $$('[data-del-user]', tb).forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.delUser)));
  }

  /* ---------- Load ---------- */
  async function refresh() {
    if (!getToken() || !currentUser) return;
    try {
      const tasks = [
        api('/summary').catch(() => ({})),
        api('/hosts').catch(() => []),
        api('/sites').catch(() => []),
      ];
      if (can('secrets')) tasks.push(api('/secrets').catch(() => []));
      const results = await Promise.all(tasks);
      const sum = results[0] || {};
      const hosts = results[1] || [];
      const sites = results[2] || [];
      const secrets = can('secrets') ? (results[3] || []) : [];
      cache.hosts = hosts;
      cache.sites = sites;
      cache.secrets = secrets;
      fillHostSiteFilter();
      fillBulkMoveSite();
      renderMetrics(sum);
      renderHostMini(cache.hosts);
      renderHostTable();
      renderSites(cache.sites);
      if (can('secrets')) renderSecrets(cache.secrets);
      setSync(true);
      const eng = sum.engine || {};
      $('#engineDot').className = 'dot' + (eng.status === 'ok' ? '' : eng.status === 'down' ? ' down' : ' warn');
      $('#engineMeta').textContent = eng.status === 'ok' ? `связь есть · ${eng.version || 'Checkmk'}` : 'нет связи с Checkmk';
      $('#setEngine').textContent = eng.status === 'ok' ? `подключено (${eng.version || 'Checkmk'})` : 'нет связи';
      if (can('users') && $('#usersCard') && !$('#usersCard').hidden) loadUsers();
    } catch (e) {
      setSync(false);
      $('#footStatus').textContent = 'API недоступен';
    }
  }

  async function loadUsers() {
    if (!can('users')) return;
    try {
      cache.users = await api('/users');
      renderUsers(cache.users);
    } catch (e) {
      $('#userRows').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message || 'Ошибка')}</td></tr>`;
    }
  }

  function renderClientAccess() {
    const list = $('#clientAccessList');
    const pill = $('#clientAccessPill');
    const meta = $('#clientAccessMeta');
    if (!list) return;
    if (!clientAccessDraft.length) {
      list.innerHTML = '<li class="empty">Список пуст — подключаться можно с любого IP</li>';
    } else {
      list.innerHTML = clientAccessDraft.map((cidr, index) => `
        <li>
          <code>${esc(cidr)}</code>
          <button type="button" class="btn ghost" data-access-del="${index}" ${currentUser?.role === 'admin' ? '' : 'disabled'}>Удалить</button>
        </li>`).join('');
      $$('[data-access-del]', list).forEach((btn) => {
        btn.addEventListener('click', () => {
          clientAccessDraft.splice(Number(btn.dataset.accessDel), 1);
          renderClientAccess();
        });
      });
    }
    if (pill) {
      pill.textContent = clientAccessDraft.length
        ? `${clientAccessDraft.length} правил`
        : 'без ограничений';
      pill.classList.toggle('on', clientAccessDraft.length > 0);
    }
    if (meta) {
      const ip = clientAccessInfo.client_ip || '—';
      const src = clientAccessInfo.source === 'database' ? 'сохранено в AIMon' : 'из .env / по умолчанию';
      meta.textContent = `Ваш IP: ${ip} · источник: ${src}`;
    }
    const locked = currentUser?.role !== 'admin';
    ['clientAccessAdd', 'clientAccessAddMine', 'clientAccessClear', 'clientAccessReset', 'clientAccessSave', 'clientAccessInput']
      .forEach((id) => { const el = $('#' + id); if (el) el.disabled = locked; });
  }

  async function loadClientAccess() {
    if (!can('settings')) return;
    const card = $('#clientAccessCard');
    if (card) card.hidden = false;
    try {
      const payload = await api('/settings/client-access');
      clientAccessDraft = [...(payload.networks || [])];
      clientAccessInfo = {
        client_ip: payload.client_ip || '',
        source: payload.source || 'env',
      };
      renderClientAccess();
    } catch (e) {
      toast(e.message || 'Не удалось загрузить доступ по IP', false);
    }
  }

  async function saveClientAccess() {
    if (currentUser?.role !== 'admin') {
      toast('Только администратор может менять доступ по IP', false);
      return;
    }
    try {
      const payload = await api('/settings/client-access', {
        method: 'PUT',
        body: { networks: clientAccessDraft },
      });
      clientAccessDraft = [...(payload.networks || [])];
      clientAccessInfo = {
        client_ip: payload.client_ip || '',
        source: payload.source || 'database',
      };
      renderClientAccess();
      toast(clientAccessDraft.length ? 'Ограничение доступа сохранено' : 'Доступ открыт для всех IP');
    } catch (e) {
      toast(e.message || 'Не удалось сохранить', false);
    }
  }

  async function resetClientAccess() {
    if (currentUser?.role !== 'admin') return;
    try {
      const payload = await api('/settings/client-access/reset', { method: 'POST' });
      clientAccessDraft = [...(payload.networks || [])];
      clientAccessInfo = {
        client_ip: payload.client_ip || '',
        source: payload.source || 'env',
      };
      renderClientAccess();
      toast('Сброшено к значениям из .env');
    } catch (e) {
      toast(e.message || 'Не удалось сбросить', false);
    }
  }

  function setSync(ok) {
    const el = $('#sync');
    el.className = 'sync ' + (ok ? 'ok' : 'bad');
    el.innerHTML = `<span class="dot ${ok ? '' : 'down'}"></span>${ok ? 'Данные актуальны' : 'API недоступен'}`;
    $('#footStatus').textContent = ok ? 'API /v1 · Checkmk' : 'API недоступен';
  }

  async function deleteHost(name) {
    if (!confirm(`Удалить узел «${name}» из мониторинга?`)) return;
    try { await api(`/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast(`Узел «${name}» удалён`); refresh(); }
    catch (e) { toast(e.message || 'Не удалось удалить узел', false); }
  }

  async function deleteSite(id) {
    const site = cache.sites.find((s) => s.id === id);
    if (!confirm(`Удалить площадку «${site?.title || id}»? Папка должна быть пустой.`)) return;
    try {
      await api(`/sites/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Площадка удалена');
      refresh();
    } catch (e) { toast(e.message || 'Не удалось удалить площадку', false); }
  }

  async function deleteUser(id) {
    const u = cache.users.find((x) => x.id === id);
    if (!confirm(`Удалить пользователя «${u?.username || id}»?`)) return;
    try {
      await api(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Пользователь удалён');
      loadUsers();
    } catch (e) { toast(e.message || 'Не удалось удалить', false); }
  }

  /* ---------- Host modal ---------- */
  const hostModal = $('#hostModal');
  function openHostModal(editName) {
    const editing = Boolean(editName);
    const host = editing ? cache.hosts.find((h) => h.name === editName) : null;
    $('#hostModalTitle').textContent = editing ? `Изменить «${editName}»` : 'Новый узел';
    $('#hostEditName').value = editName || '';
    $('#hostName').value = host?.name || '';
    $('#hostName').disabled = false;
    $('#hostAddress').value = host?.address || '';
    $('#hostAlias').value = host?.alias || '';
    $('#hostType').value = host?.type || 'agent';
    $('#hostDeviceType').value = host?.device_type || '';
    fillSiteSelect($('#hostSite'), host?.folder || host?.site_path || '/');
    fillSnmpSelect($('#hostSnmpProfile'), '');
    toggleHostSnmp();
    hostModal?.showModal();
    $('#hostName')?.focus();
  }

  function toggleHostSnmp() {
    const snmp = $('#hostType')?.value === 'snmp';
    $('#hostSnmpWrap').hidden = !snmp;
  }
  $('#hostType')?.addEventListener('change', toggleHostSnmp);

  function closeHostModal() { hostModal?.close(); }
  $('#hostModalClose')?.addEventListener('click', closeHostModal);
  $('#hostModalCancel')?.addEventListener('click', closeHostModal);

  $('#hostForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editName = $('#hostEditName').value.trim();
    const bodyPayload = {
      name: $('#hostName').value.trim(),
      address: $('#hostAddress').value.trim(),
      alias: $('#hostAlias').value.trim(),
      type: $('#hostType').value,
      device_type: $('#hostDeviceType')?.value || '',
      folder: $('#hostSite').value || '/',
      snmp_profile_id: $('#hostType').value === 'snmp' ? ($('#hostSnmpProfile').value || null) : null,
    };
    if (!bodyPayload.name) { toast('Укажите имя узла', false); return; }
    try {
      if (editName) {
        const patch = {
          address: bodyPayload.address,
          alias: bodyPayload.alias,
          type: bodyPayload.type,
          device_type: bodyPayload.device_type || '',
          folder: bodyPayload.folder,
          snmp_profile_id: bodyPayload.snmp_profile_id,
        };
        if (bodyPayload.name && bodyPayload.name !== editName) patch.new_name = bodyPayload.name;
        const res = await api(`/hosts/${encodeURIComponent(editName)}`, {
          method: 'PATCH',
          body: patch,
        });
        const finalName = res?.host || bodyPayload.name || editName;
        toast(finalName !== editName ? `Узел переименован: «${editName}» → «${finalName}»` : `Узел «${finalName}» обновлён`);
      } else {
        await api('/hosts', { method: 'POST', body: bodyPayload });
        toast(`Узел «${bodyPayload.name}» добавлен`);
      }
      closeHostModal();
      refresh();
    } catch (err) {
      toast(err.message || 'Не удалось сохранить узел', false);
    }
  });

  /* ---------- Site modal ---------- */
  const siteModal = $('#siteModal');
  function openSiteModal(editId) {
    const editing = Boolean(editId);
    const site = editing ? cache.sites.find((s) => s.id === editId) : null;
    $('#siteModalTitle').textContent = editing ? `Изменить «${site?.title || editId}»` : 'Новая площадка';
    $('#siteEditId').value = editId || '';
    $('#siteName').value = site?.name || '';
    $('#siteName').disabled = editing;
    $('#siteTitle').value = site?.title || '';
    $('#siteParentWrap').hidden = editing;
    const parents = cache.sites.length ? cache.sites : [{ path: '/', title: 'Корень' }];
    $('#siteParent').innerHTML = parents.map((s) =>
      `<option value="${esc(s.path)}">${esc(s.title || s.path)}</option>`
    ).join('');
    siteModal?.showModal();
    (editing ? $('#siteTitle') : $('#siteName'))?.focus();
  }

  function closeSiteModal() { siteModal?.close(); }
  $('#siteModalClose')?.addEventListener('click', closeSiteModal);
  $('#siteModalCancel')?.addEventListener('click', closeSiteModal);

  $('#siteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('#siteEditId').value.trim();
    const name = $('#siteName').value.trim();
    const title = $('#siteTitle').value.trim() || name;
    try {
      if (editId) {
        await api(`/sites/${encodeURIComponent(editId)}`, { method: 'PATCH', body: { title } });
        toast('Площадка обновлена');
      } else {
        if (!name) { toast('Укажите код площадки', false); return; }
        await api('/sites', {
          method: 'POST',
          body: { name, title, parent: $('#siteParent').value || '/' },
        });
        toast(`Площадка «${title}» создана`);
      }
      closeSiteModal();
      refresh();
    } catch (err) {
      toast(err.message || 'Не удалось сохранить площадку', false);
    }
  });

  /* ---------- User modal ---------- */
  const userModal = $('#userModal');
  function fillUserHosts(selected) {
    const box = $('#userHosts');
    const set = new Set(selected || []);
    const hosts = cache.hosts.length ? cache.hosts : [];
    if (!hosts.length) {
      box.innerHTML = '<div class="empty">Сначала добавьте узлы мониторинга.</div>';
      return;
    }
    box.innerHTML = hosts.map((h) => `
      <label><input type="checkbox" value="${esc(h.name)}" ${set.has(h.name) ? 'checked' : ''}>
      <span>${esc(h.name)}${h.address ? ` · ${esc(h.address)}` : ''}</span></label>`).join('');
  }

  function toggleUserHosts() {
    const isUser = $('#userRoleSelect')?.value === 'user';
    $('#userHostsWrap').hidden = !isUser;
  }
  $('#userRoleSelect')?.addEventListener('change', toggleUserHosts);

  function openUserModal(editId) {
    const editing = Boolean(editId);
    const u = editing ? cache.users.find((x) => x.id === editId) : null;
    $('#userModalTitle').textContent = editing ? `Изменить «${u?.username || editId}»` : 'Новый пользователь';
    $('#userEditId').value = editId || '';
    $('#userUsername').value = u?.username || '';
    $('#userDisplayName').value = u?.display_name || '';
    $('#userRoleSelect').value = u?.role || 'user';
    $('#userPassword').value = '';
    $('#userPassword').placeholder = editing ? 'оставьте пустым, чтобы не менять' : 'минимум 6 символов';
    $('#userPassword').required = !editing;
    $('#userEnabled').checked = u ? Boolean(u.enabled) : true;
    fillUserHosts(u?.hosts || []);
    toggleUserHosts();
    userModal?.showModal();
    $('#userUsername')?.focus();
  }

  function closeUserModal() { userModal?.close(); }
  $('#userModalClose')?.addEventListener('click', closeUserModal);
  $('#userModalCancel')?.addEventListener('click', closeUserModal);
  $('#addUser')?.addEventListener('click', () => openUserModal(null));

  $('#userForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('#userEditId').value.trim();
    const role = $('#userRoleSelect').value;
    const hosts = $$('#userHosts input:checked').map((c) => c.value);
    const payload = {
      username: $('#userUsername').value.trim(),
      display_name: $('#userDisplayName').value.trim(),
      role,
      enabled: $('#userEnabled').checked,
      hosts: role === 'user' ? hosts : [],
    };
    const password = $('#userPassword').value;
    if (password) payload.password = password;
    if (!payload.username) { toast('Укажите логин', false); return; }
    try {
      if (editId) {
        await api(`/users/${encodeURIComponent(editId)}`, { method: 'PATCH', body: payload });
        toast('Пользователь обновлён');
      } else {
        if (!password || password.length < 6) { toast('Пароль не короче 6 символов', false); return; }
        payload.password = password;
        await api('/users', { method: 'POST', body: payload });
        toast('Пользователь создан');
      }
      closeUserModal();
      loadUsers();
    } catch (err) {
      toast(err.message || 'Не удалось сохранить пользователя', false);
    }
  });

  $('#addSite')?.addEventListener('click', () => openSiteModal(null));
  $('#addHost')?.addEventListener('click', () => openHostModal(null));
  $('#quickAdd')?.addEventListener('click', () => openHostModal(null));
  $('#refreshHosts')?.addEventListener('click', refresh);

  /* ---------- Scan ---------- */
  $('#runScan')?.addEventListener('click', async () => {
    const cidr = $('#scanCidr').value.trim();
    const profile = $('#scanProfile').value;
    if (!cidr) { toast('Укажите подсеть (CIDR)', false); return; }
    const status = $('#scanStatus');
    status.hidden = false; status.textContent = `Сканирую ${cidr}…`;
    $('#scanRows').innerHTML = '<tr><td colspan="7" class="empty">Идёт сканирование…</td></tr>';
    try {
      const res = await api('/scan', { method: 'POST', body: { cidr, snmp_profile_id: profile || null } });
      const found = res.devices || [];
      const aiNote = res.ai_classified ? ' · типы уточнены AI' : '';
      status.textContent = `Найдено устройств: ${found.length} из ${res.scanned ?? '?'} адресов${aiNote}.`;
      renderScan(found);
    } catch (e) {
      status.textContent = e.message || 'Ошибка скана';
      $('#scanRows').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message || 'Ошибка')}</td></tr>`;
    }
  });

  function renderScan(devices) {
    const tb = $('#scanRows');
    if (!devices.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">SNMP-устройств не найдено.</td></tr>'; return; }
    tb.innerHTML = devices.map((d) => {
      const typeLbl = d.device_type_label || d.device_type || '—';
      let typeNote = '';
      if (d.ai_classified) typeNote = 'AI';
      else if (d.needs_ai) typeNote = 'уточнить';
      else if (d.device_type_confidence === 'low') typeNote = 'низкая уверенность';
      return `
      <tr>
        <td><input type="checkbox" class="scan-pick"
          data-ip="${esc(d.ip)}"
          data-name="${esc(d.name || '')}"
          data-alias="${esc(d.alias || '')}"
          data-sysname="${esc(d.sysname || '')}"
          data-descr="${esc(d.sysdescr || '')}"
          data-vendor="${esc(d.vendor || '')}"
          data-model="${esc(d.model || '')}"
          data-dtype="${esc(d.device_type || '')}"
          data-conf="${esc(d.device_type_confidence || '')}"></td>
        <td>${esc(d.ip)}</td>
        <td><b>${esc(d.name || d.sysname || '—')}</b>${d.sysname && d.sysname !== d.name ? `<br><small>${esc(d.sysname)}</small>` : ''}</td>
        <td>${esc(d.alias || '—')}</td>
        <td><span class="type-pill device">${esc(typeLbl)}</span>${typeNote ? `<br><small>${esc(typeNote)}</small>` : ''}</td>
        <td>${esc(d.vendor || '—')}${d.model ? `<br><small>${esc(d.model)}</small>` : ''}</td>
        <td><span class="state ${d.added ? '' : 'warn'}">${d.added ? 'Добавлен' : 'Найден'}</span></td>
      </tr>`;
    }).join('');
    $$('.scan-pick', tb).forEach((c) => c.addEventListener('change', updateSelected));
    updateSelected();
  }

  function updateSelected() {
    const any = $$('.scan-pick').some((c) => c.checked);
    $('#addSelected').disabled = !any;
  }
  $('#scanAll')?.addEventListener('change', (e) => { $$('.scan-pick').forEach((c) => { c.checked = e.target.checked; }); updateSelected(); });

  $('#addSelected')?.addEventListener('click', async () => {
    const picks = $$('.scan-pick').filter((c) => c.checked).map((c) => ({
      ip: c.dataset.ip,
      name: c.dataset.name || '',
      alias: c.dataset.alias || '',
      sysname: c.dataset.sysname || '',
      sysdescr: c.dataset.descr || '',
      vendor: c.dataset.vendor || '',
      model: c.dataset.model || '',
      device_type: c.dataset.dtype || '',
      device_type_confidence: c.dataset.conf || '',
    }));
    if (!picks.length) return;
    const profile = $('#scanProfile').value;
    const folder = $('#scanSite')?.value || '/';
    try {
      const res = await api('/scan/add', {
        method: 'POST',
        body: { devices: picks, snmp_profile_id: profile || null, folder, use_ai: true },
      });
      const site = folder === '/' ? 'корень' : folder;
      toast(`Добавлено на «${site}»: ${res.count || picks.length}${res.added?.length ? ` (${res.added.join(', ')})` : ''}`);
      refresh();
    } catch (e) { toast(e.message || 'Не удалось добавить', false); }
  });

  $('#hostAll')?.addEventListener('change', (e) => {
    $$('.host-pick').forEach((c) => { c.checked = e.target.checked; });
    updateHostBulk();
  });
  $('#bulkMoveSite')?.addEventListener('change', updateHostBulk);
  $('#bulkMoveHosts')?.addEventListener('click', async () => {
    const names = selectedHostNames();
    const folder = $('#bulkMoveSite')?.value || '/';
    if (!names.length) return;
    if (!confirm(`Перенести ${names.length} узлов на площадку «${folder === '/' ? 'Корень' : folder}»?`)) return;
    try {
      const res = await api('/hosts/move', { method: 'POST', body: { names, folder } });
      toast(`Перенесено: ${res.count || 0}${res.errors?.length ? ` · ошибок: ${res.errors.length}` : ''}`);
      refresh();
    } catch (e) {
      toast(e.message || 'Не удалось перенести', false);
    }
  });

  $('#addSecret')?.addEventListener('click', () => {
    const name = prompt('Название секрета:');
    if (!name) return;
    const kind = prompt('Тип: snmp_v2c | snmp_v3 | agent_token | checkmk_automation', 'snmp_v2c') || 'snmp_v2c';
    const value = prompt('Значение (community / token / пароль):') || '';
    api('/secrets', { method: 'POST', body: { name, kind, value } })
      .then(() => { toast('Секрет сохранён'); refresh(); })
      .catch((e) => toast(e.message || 'Не удалось сохранить', false));
  });

  /* ---------- Assistant ---------- */
  function sessionId() {
    const key = 'aimon_chat_session';
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  }

  /* ---------- Gera ---------- */
  const GERA_AVA = 'assets/gera-bot-still.jpg';
  const GERA_WELCOME = 'Здравствуйте! Я Гера. Могу добавить узлы, проверить ping/порт/SNMP, разобрать конфиги. Например: «проверь 10.0.0.1», «покажи типы устройств», «добавь сервер 10.0.0.5».';

  function setGeraState(state) {
    const next = state === 'thinking' ? 'thinking' : 'idle';
    const rate = next === 'thinking' ? 1.35 : 1;
    $$('.gera').forEach((el) => {
      el.dataset.state = next;
      const idle = $('.gera-vid.idle', el);
      const think = $('.gera-vid.think', el);
      if (idle && think) {
        if (next === 'thinking') {
          try { idle.pause(); } catch (_) {}
          think.playbackRate = rate;
          think.currentTime = 0;
          const p = think.play();
          if (p && p.catch) p.catch(() => {});
        } else {
          try { think.pause(); } catch (_) {}
          idle.playbackRate = rate;
          idle.currentTime = 0;
          const p = idle.play();
          if (p && p.catch) p.catch(() => {});
        }
      }
    });
    const status = $('#geraStatus');
    if (status) status.textContent = next === 'thinking' ? 'Думаю…' : 'Жду команду';
    const fab = $('#aiFab');
    if (fab) {
      fab.classList.toggle('thinking', next === 'thinking');
      const face = $('#aiFabFace') || $('video', fab);
      if (face) {
        face.playbackRate = rate;
        const p = face.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }

  // Start idle loops when the assistant view is shown / page loads
  function bootGeraVideos() {
    $$('.gera-vid.idle').forEach((v) => {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    });
    const fabFace = $('#aiFabFace');
    if (fabFace) {
      const p = fabFace.play();
      if (p && p.catch) p.catch(() => {});
    }
  }
  bootGeraVideos();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      $$('.gera-vid, #aiFabFace').forEach((v) => { try { v.pause(); } catch (_) {} });
    } else {
      setGeraState($('#geraHero')?.dataset.state || 'idle');
    }
  });

  function resetChatWelcome() {
    const chat = $('#chat');
    chat.innerHTML = '';
    addMsg(GERA_WELCOME, 'bot');
    setGeraState('idle');
  }

  async function loadChatHistory() {
    try {
      const res = await api(`/ai/history?session_id=${encodeURIComponent(sessionId())}`);
      const msgs = res.messages || [];
      if (!msgs.length) return;
      const chat = $('#chat');
      chat.innerHTML = '';
      msgs.forEach((m) => addMsg(m.content || '', m.role === 'user' ? 'user' : 'bot'));
      setGeraState('idle');
    } catch (_) { /* AI optional */ }
  }

  $('#clearChat')?.addEventListener('click', async () => {
    try {
      await api(`/ai/history?session_id=${encodeURIComponent(sessionId())}`, { method: 'DELETE' });
      resetChatWelcome();
      toast('Память диалога очищена');
    } catch (e) {
      toast(e.message || 'Не удалось очистить', false);
    }
  });

  $('#chatForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    setGeraState('thinking');
    const typing = addMsg('Гера думает…', 'bot', { thinking: true });
    try {
      const res = await api('/ai/chat', {
        method: 'POST',
        body: { message: text, session_id: sessionId() },
      });
      typing.textContent = res.reply || 'Готово.';
      typing.parentElement?.classList.remove('thinking');
      setGeraState('idle');
      const actions = Array.isArray(res.actions) ? res.actions : (res.action ? [res.action] : []);
      const mutated = actions.some((a) =>
        a && [
          'add_host', 'update_host', 'delete_host', 'add_hosts_from_scan', 'move_hosts',
          'create_site', 'update_site', 'delete_site',
          'create_user', 'update_user', 'delete_user',
          'create_secret', 'update_secret', 'delete_secret',
          'create_custom_tool', 'update_custom_tool', 'delete_custom_tool',
          'write_config', 'patch_config',
        ].includes(a.tool) && a.result && a.result.ok
      );
      if (mutated) {
        const added = actions
          .filter((a) => a.tool === 'add_host' && a.result?.ok)
          .map((a) => a.result.host)
          .concat(...actions.filter((a) => a.tool === 'add_hosts_from_scan' && a.result?.ok).map((a) => a.result.added || []));
        const moved = actions.filter((a) => a.tool === 'move_hosts' && a.result?.ok).map((a) => a.result.count || 0);
        if (added.length) toast(`Гера добавила: ${added.join(', ')}`);
        if (moved.length) toast(`Гера перенесла узлов: ${moved.reduce((a, b) => a + b, 0)}`);
        refresh();
      } else if (res.action || actions.length) {
        refresh();
      }
    } catch (e2) {
      typing.textContent = e2.status === 404
        ? 'Гера ещё не подключена к AI-сервису.'
        : (e2.message || 'Ошибка запроса к Гере.');
      typing.parentElement?.classList.remove('thinking');
      setGeraState('idle');
    }
  });

  function addMsg(text, who, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${who}${opts.thinking ? ' thinking' : ''}`;
    if (who === 'bot') {
      const ava = document.createElement('img');
      ava.className = 'msg-ava';
      ava.src = GERA_AVA;
      ava.alt = 'Гера';
      wrap.appendChild(ava);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    const chat = $('#chat');
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  /* ---------- Search / host filters ---------- */
  function syncHostFiltersFromUi() {
    hostFilters = {
      name: ($('#fHostName')?.value || '').trim().toLowerCase(),
      address: ($('#fHostAddr')?.value || '').trim().toLowerCase(),
      site: $('#fHostSite')?.value || '',
      device: $('#fHostDevice')?.value || '',
      type: $('#fHostType')?.value || '',
      state: $('#fHostState')?.value || '',
    };
    renderHostTable();
  }
  ['fHostName', 'fHostAddr'].forEach((id) => {
    $(`#${id}`)?.addEventListener('input', syncHostFiltersFromUi);
  });
  ['fHostSite', 'fHostDevice', 'fHostType', 'fHostState'].forEach((id) => {
    $(`#${id}`)?.addEventListener('change', syncHostFiltersFromUi);
  });
  $$('.th-sort').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (hostSort.key === key) hostSort.dir *= -1;
      else { hostSort.key = key; hostSort.dir = 1; }
      renderHostTable();
    });
  });

  $('#search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if ($('#fHostName')) {
      $('#fHostName').value = e.target.value.trim();
      syncHostFiltersFromUi();
      return;
    }
    $$('#hostRows tr').forEach((tr) => {
      if (tr.querySelector('.empty')) return;
      tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
    });
  });

  $('#clientAccessForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (currentUser?.role !== 'admin') return;
    const input = $('#clientAccessInput');
    const value = (input?.value || '').trim();
    if (!value) return;
    if (clientAccessDraft.includes(value)) {
      toast('Уже в списке', false);
      return;
    }
    clientAccessDraft.push(value);
    if (input) input.value = '';
    renderClientAccess();
  });
  $('#clientAccessAddMine')?.addEventListener('click', () => {
    const ip = (clientAccessInfo.client_ip || '').trim();
    if (!ip) {
      toast('Текущий IP неизвестен — сначала обновите страницу', false);
      return;
    }
    if (!clientAccessDraft.includes(ip)) clientAccessDraft.push(ip);
    renderClientAccess();
  });
  $('#clientAccessClear')?.addEventListener('click', () => {
    clientAccessDraft = [];
    renderClientAccess();
  });
  $('#clientAccessReset')?.addEventListener('click', () => resetClientAccess());
  $('#clientAccessSave')?.addEventListener('click', () => saveClientAccess());

  /* ---------- Boot ---------- */
  async function boot() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }
    try {
      const cached = localStorage.getItem(USER_KEY);
      if (cached) {
        try { currentUser = JSON.parse(cached); } catch { currentUser = null; }
      }
      currentUser = await api('/auth/me');
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      enterApp();
    } catch (_) {
      clearSession();
      showLogin();
    }
  }

  boot();
})();
