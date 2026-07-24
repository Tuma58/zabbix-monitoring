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
  }
  $$('.nav-item').forEach((n) => n.addEventListener('click', (e) => { e.preventDefault(); showView(n.dataset.view); }));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
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
      <div class="row"><div><b>${esc(h.name)}</b><br><small>${esc(h.address || '')} · ${esc(h.site_title || h.folder || '/')} · ${esc(h.type || 'agent')}</small></div>
      <span class="state ${stateClass(h.state)} state-right">${stateLabel(h.state)}</span></div>`).join('');
  }

  function renderHostTable(hosts) {
    const tb = $('#hostRows');
    const write = can('hosts_write');
    if (!hosts.length) { tb.innerHTML = `<tr><td colspan="${write ? 6 : 5}" class="empty">Узлов пока нет.</td></tr>`; return; }
    tb.innerHTML = hosts.map((h) => `
      <tr>
        <td><b>${esc(h.name)}</b>${h.alias ? `<br><small>${esc(h.alias)}</small>` : ''}</td>
        <td>${esc(h.address || '—')}</td>
        <td>${esc(h.site_title || h.folder || 'Корень')}</td>
        <td>${esc(h.type || 'agent')}</td>
        <td><span class="state ${stateClass(h.state)}">${stateLabel(h.state)}</span></td>
        ${write ? `<td><div class="row-actions">
          <button class="btn ghost" type="button" data-edit-host="${esc(h.name)}"><svg><use href="#i-edit"/></svg>Изменить</button>
          <button class="btn ghost" type="button" data-del-host="${esc(h.name)}">Удалить</button>
        </div></td>` : ''}
      </tr>`).join('');
    if (write) {
      $$('[data-edit-host]', tb).forEach((b) => b.addEventListener('click', () => openHostModal(b.dataset.editHost)));
      $$('[data-del-host]', tb).forEach((b) => b.addEventListener('click', () => deleteHost(b.dataset.delHost)));
    }
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
      renderMetrics(sum);
      renderHostMini(cache.hosts);
      renderHostTable(cache.hosts);
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
    $('#scanRows').innerHTML = '<tr><td colspan="5" class="empty">Идёт сканирование…</td></tr>';
    try {
      const res = await api('/scan', { method: 'POST', body: { cidr, snmp_profile_id: profile || null } });
      const found = res.devices || [];
      status.textContent = `Найдено устройств: ${found.length} из ${res.scanned ?? '?'} адресов.`;
      renderScan(found);
    } catch (e) {
      status.textContent = e.message || 'Ошибка скана';
      $('#scanRows').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message || 'Ошибка')}</td></tr>`;
    }
  });

  function renderScan(devices) {
    const tb = $('#scanRows');
    if (!devices.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">SNMP-устройств не найдено.</td></tr>'; return; }
    tb.innerHTML = devices.map((d) => `
      <tr>
        <td><input type="checkbox" class="scan-pick" data-ip="${esc(d.ip)}" data-descr="${esc(d.sysdescr || '')}" data-vendor="${esc(d.vendor || '')}"></td>
        <td>${esc(d.ip)}</td>
        <td>${esc(d.sysdescr || '—')}</td>
        <td>${esc(d.vendor || '—')}</td>
        <td><span class="state ${d.added ? '' : 'warn'}">${d.added ? 'Добавлен' : 'Найден'}</span></td>
      </tr>`).join('');
    $$('.scan-pick', tb).forEach((c) => c.addEventListener('change', updateSelected));
    updateSelected();
  }

  function updateSelected() {
    const any = $$('.scan-pick').some((c) => c.checked);
    $('#addSelected').disabled = !any;
  }
  $('#scanAll')?.addEventListener('change', (e) => { $$('.scan-pick').forEach((c) => { c.checked = e.target.checked; }); updateSelected(); });

  $('#addSelected')?.addEventListener('click', async () => {
    const picks = $$('.scan-pick').filter((c) => c.checked).map((c) => ({ ip: c.dataset.ip, sysdescr: c.dataset.descr, vendor: c.dataset.vendor }));
    if (!picks.length) return;
    const profile = $('#scanProfile').value;
    try {
      await api('/scan/add', { method: 'POST', body: { devices: picks, snmp_profile_id: profile || null } });
      toast(`Добавлено узлов: ${picks.length}`);
      refresh();
    } catch (e) { toast(e.message || 'Не удалось добавить', false); }
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

  function resetChatWelcome() {
    const chat = $('#chat');
    chat.innerHTML = '';
    addMsg('Память очищена. Могу снова добавить узлы, проверить связь или разобрать конфиги.', 'bot');
  }

  async function loadChatHistory() {
    try {
      const res = await api(`/ai/history?session_id=${encodeURIComponent(sessionId())}`);
      const msgs = res.messages || [];
      if (!msgs.length) return;
      const chat = $('#chat');
      chat.innerHTML = '';
      msgs.forEach((m) => addMsg(m.content || '', m.role === 'user' ? 'user' : 'bot'));
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
    const typing = addMsg('…', 'bot');
    try {
      const res = await api('/ai/chat', {
        method: 'POST',
        body: { message: text, session_id: sessionId() },
      });
      typing.textContent = res.reply || 'Готово.';
      const actions = Array.isArray(res.actions) ? res.actions : (res.action ? [res.action] : []);
      const mutated = actions.some((a) =>
        a && ['add_host', 'add_hosts_from_scan', 'write_config', 'patch_config'].includes(a.tool) && a.result && a.result.ok
      );
      if (mutated) {
        const added = actions
          .filter((a) => a.tool === 'add_host' && a.result?.ok)
          .map((a) => a.result.host)
          .concat(...actions.filter((a) => a.tool === 'add_hosts_from_scan' && a.result?.ok).map((a) => a.result.added || []));
        if (added.length) toast(`AI добавил: ${added.join(', ')}`);
        refresh();
      } else if (res.action || actions.length) {
        refresh();
      }
    } catch (e2) {
      typing.textContent = e2.status === 404
        ? 'AI-сервис ещё не подключён. Скоро здесь появятся ответы DeepSeek.'
        : (e2.message || 'Ошибка запроса к AI.');
    }
  });

  function addMsg(text, who) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${who}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    const chat = $('#chat');
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  /* ---------- Search ---------- */
  $('#search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('#hostRows tr').forEach((tr) => {
      if (tr.querySelector('.empty')) return;
      tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
    });
  });

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
