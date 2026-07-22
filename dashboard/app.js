(() => {
  'use strict';

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

  function runProbe() {
    const runId = ++probeRunId;
    const checks = $$('.check-list > div');
    const labels = [
      ['Ответ получен за 4 мс', '4 мс'],
      [`${$('input[name="protocol"]:checked').value} доступен`, 'Доступен'],
      ['Профиль принят устройством', 'Успешно'],
      ['APC Smart-UPS SRT 3000', 'Определено']
    ];
    let index = 0;
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

  function addDevice() {
    const name = $('#deviceName').value;
    const address = $('#deviceAddress').value;
    const site = $('#deviceSite').value;
    const typeValue = $('#deviceType').value || 'router';
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
    node.textContent = value;
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
  $('#runProbe').addEventListener('click', runProbe);
  nextButton.addEventListener('click', advance);
  backButton.addEventListener('click', () => { if (currentStep > 1) { currentStep -= 1; renderStep(); } });

  $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog($(`#${button.dataset.close}`))));
  [wizard, settings].forEach((dialog) => dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));

  $$('.acknowledge').forEach((button) => button.addEventListener('click', () => {
    button.textContent = 'Принято';
    button.classList.add('done');
    button.disabled = true;
    showToast('Проблема принята в работу');
  }));
  $$('[data-toast]').forEach((button) => button.addEventListener('click', () => showToast(button.dataset.toast)));
  $$('[data-scroll]').forEach((button) => button.addEventListener('click', () => $(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' })));
  $('#siteFilter').addEventListener('change', (event) => filterBySite(event.target.value));
  $('#globalSearch').addEventListener('search', (event) => searchDashboard(event.target.value));
  $('#globalSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchDashboard(event.target.value); });
  $('#addSite').addEventListener('click', () => showToast('Добавление площадки доступно в настройках'));

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
})();
