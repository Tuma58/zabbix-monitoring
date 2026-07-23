(() => {
  'use strict';

  const API = '/api/v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const body = document.body;

  let toastTimer;
  function toast(message, ok = true) {
    const el = $('#toast');
    $('p', el).textContent = message;
    el.classList.toggle('err', !ok);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    const res = await fetch(`${API}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
    if (!res.ok) { const err = new Error(data?.message || `HTTP ${res.status}`); err.status = res.status; err.payload = data; throw err; }
    return data;
  }

  /* ---------- Navigation ---------- */
  function showView(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    body.classList.remove('nav-open');
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  }
  $$('.nav-item').forEach((n) => n.addEventListener('click', (e) => { e.preventDefault(); showView(n.dataset.view); }));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v) showView(v); });

  $('#navOpen')?.addEventListener('click', () => body.classList.add('nav-open'));
  $('#navClose')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $('#scrim')?.addEventListener('click', () => body.classList.remove('nav-open'));
  $('#aiFab')?.addEventListener('click', () => { showView('assistant'); $('#chatInput')?.focus(); });

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
      <div class="row"><div><b>${esc(h.name)}</b><br><small>${esc(h.address || '')} · ${esc(h.type || 'agent')}</small></div>
      <span class="state ${stateClass(h.state)} state-right">${stateLabel(h.state)}</span></div>`).join('');
  }

  function renderHostTable(hosts) {
    const tb = $('#hostRows');
    if (!hosts.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Узлов пока нет.</td></tr>'; return; }
    tb.innerHTML = hosts.map((h) => `
      <tr>
        <td><b>${esc(h.name)}</b></td>
        <td>${esc(h.address || '—')}</td>
        <td>${esc(h.type || 'agent')}</td>
        <td><span class="state ${stateClass(h.state)}">${stateLabel(h.state)}</span></td>
        <td>${h.services ?? 0}</td>
        <td><button class="btn ghost" data-del="${esc(h.name)}">Удалить</button></td>
      </tr>`).join('');
    $$('[data-del]', tb).forEach((b) => b.addEventListener('click', () => deleteHost(b.dataset.del)));
  }

  function renderSecrets(items) {
    const box = $('#secretList');
    const sel = $('#scanProfile');
    if (sel) {
      const snmp = items.filter((s) => s.kind === 'snmp_v2c' || s.kind === 'snmp_v3');
      sel.innerHTML = '<option value="">Выберите профиль</option>' + snmp.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    }
    if (!items.length) { box.innerHTML = '<div class="empty">Секретов пока нет.</div>'; return; }
    const label = { snmp_v2c: 'SNMP v2c', snmp_v3: 'SNMP v3', agent_token: 'Токен агента', checkmk_automation: 'Checkmk automation' };
    box.innerHTML = items.map((s) => `
      <div class="secret">
        <span class="s-ic"><svg><use href="#i-key"/></svg></span>
        <div><b>${esc(s.name)}</b><br><small>${label[s.kind] || s.kind} · создан ${esc(s.created_at || '')}</small></div>
      </div>`).join('');
  }

  function esc(v) { const d = document.createElement('span'); d.textContent = v == null ? '' : String(v); return d.innerHTML; }

  /* ---------- Load ---------- */
  async function refresh() {
    try {
      const [sum, hosts, secrets] = await Promise.all([
        api('/summary').catch(() => ({})),
        api('/hosts').catch(() => []),
        api('/secrets').catch(() => []),
      ]);
      renderMetrics(sum || {});
      renderHostMini(hosts || []);
      renderHostTable(hosts || []);
      renderSecrets(secrets || []);
      setSync(true);
      const eng = (sum && sum.engine) || {};
      $('#engineDot').className = 'dot' + (eng.status === 'ok' ? '' : eng.status === 'down' ? ' down' : ' warn');
      $('#engineMeta').textContent = eng.status === 'ok' ? `связь есть · ${eng.version || 'Checkmk'}` : 'нет связи с Checkmk';
      $('#setEngine').textContent = eng.status === 'ok' ? `подключено (${eng.version || 'Checkmk'})` : 'нет связи';
    } catch (e) {
      setSync(false);
      $('#footStatus').textContent = 'API недоступен';
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
    tb.innerHTML = devices.map((d, i) => `
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

  /* ---------- Add host quick ---------- */
  function quickAdd() {
    const name = prompt('Имя узла (Hostname в Checkmk):');
    if (!name) return;
    const address = prompt('IP-адрес или FQDN:', '') || '';
    api('/hosts', { method: 'POST', body: { name, address, type: 'agent' } })
      .then(() => { toast(`Узел «${name}» добавлен`); refresh(); })
      .catch((e) => toast(e.message || 'Не удалось добавить', false));
  }
  $('#quickAdd')?.addEventListener('click', quickAdd);
  $('#addHost')?.addEventListener('click', quickAdd);
  $('#refreshHosts')?.addEventListener('click', refresh);

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
        const cfg = actions.find((a) => ['write_config', 'patch_config'].includes(a.tool) && a.result?.ok);
        if (cfg?.result?.restart_hint?.length) {
          toast(`Конфиг обновлён. Перезапустите: ${cfg.result.restart_hint.join(', ')}`);
        } else if (cfg) {
          toast(`Конфиг обновлён: ${cfg.result.path}`);
        }
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
  const initial = location.hash.slice(1);
  if (initial) showView(initial);
  refresh();
  loadChatHistory();
  setInterval(refresh, 30000);
})();
