'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
  const labels = {
    pass: '正确',
    fail: '答错',
    inconclusive: '未能判定',
    error: '接口异常',
    timeout: '超时',
    cancelled: '已取消',
  };
  const familyNames = {
    candy: '糖果推理',
    arithmetic: '运算与约束',
    'shortest-path': '最短路径',
    table: '表格筛选',
    json: '结构化指令',
  };
  const sources = { automatic: '自动', manual: '手动', comparison: '同题比较' };
  const time = (value) =>
    value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const percent = (value) => (value == null ? '—' : (value * 100).toFixed(1) + '%');
  const display = (value) =>
    typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—');
  let token = '',
    state = null,
    records = [],
    selectedId = '',
    editingId = null,
    online = false,
    pending = false,
    streamController = null,
    refreshTimer = null,
    toastTimer = null,
    lastBatch = null,
    refreshGeneration = 0,
    activeTab = 'overview';
  try {
    token =
      new URLSearchParams(location.hash.slice(1)).get('token') ||
      sessionStorage.getItem('sentinel-token') ||
      '';
    if (token) sessionStorage.setItem('sentinel-token', token);
    selectedId = sessionStorage.getItem('sentinel-selected') || '';
  } catch {
    /* The panel also works with in-memory authentication. */
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const active = () => state?.profiles.find((p) => p.id === selectedId) || null;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 6000);
  }
  function connection(good) {
    online = good;
    $('connection').textContent = good ? '本机已连接' : '连接中断';
    $('connection').className = 'connection' + (good ? ' online' : '');
  }
  function auth(message = '') {
    if (!$('auth-dialog').open) $('auth-dialog').showModal();
    $('auth-error').textContent = message;
  }
  async function api(route, body, method = body ? 'POST' : 'GET') {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(route, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          connection(false);
          auth();
        }
        throw Error(data.error || '请求失败');
      }
      return data;
    } catch (e) {
      throw Error(e.name === 'AbortError' ? '本机操作等待超时，请检查状态后再操作' : e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  async function refresh() {
    if (!token) return;
    const expectedToken = token,
      generation = ++refreshGeneration;
    try {
      const [snapshot, historyData] = await Promise.all([api('/api/status'), api('/api/history')]);
      if (token !== expectedToken || generation !== refreshGeneration) return;
      state = snapshot;
      records = historyData.records;
      connection(true);
      if (!state.profiles.some((p) => p.id === selectedId))
        selectedId = state.profiles[0]?.id || '';
      render();
    } catch (e) {
      if (token !== expectedToken || generation !== refreshGeneration) return;
      connection(false);
      renderActions();
      $('server-note').textContent = e.message;
    }
  }
  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 100);
  }
  async function stream() {
    streamController?.abort();
    if (!token) return;
    const controller = (streamController = new AbortController());
    try {
      const response = await fetch('/api/events', {
        headers: { Authorization: 'Bearer ' + token },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw Error('事件连接失败');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('\n\n')) {
          if (buffer.includes('event: change')) queueRefresh();
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        }
      }
    } catch {
      /* Polling remains available while the event stream reconnects. */
    }
    if (!controller.signal.aborted) setTimeout(() => void stream(), 4000);
  }
  async function action(fn, message) {
    if (pending) return;
    pending = true;
    renderActions();
    try {
      await fn();
      if (message) toast(message);
    } catch (e) {
      toast(e.message);
    } finally {
      pending = false;
      await refresh();
      renderActions();
    }
  }
  function badge(status, text = labels[status] || status) {
    return el('span', text, 'badge ' + status);
  }
  function choose(profileId) {
    selectedId = profileId;
    try {
      sessionStorage.setItem('sentinel-selected', profileId);
    } catch {}
    render();
  }
  function render() {
    if (!state) return;
    $('demo-banner').hidden = !state.demo;
    $('fatal-banner').hidden = !state.fatal;
    $('fatal-banner').textContent = state.fatal || '';
    $('profile-count').textContent = state.profiles.length;
    $('profiles').replaceChildren();
    for (const profile of state.profiles) {
      const button = el(
        'button',
        undefined,
        'profile-card' + (profile.id === selectedId ? ' selected' : ''),
      );
      button.setAttribute('aria-pressed', String(profile.id === selectedId));
      const line = el('span', undefined, 'profile-name');
      line.append(
        el(
          'span',
          '',
          'indicator' + (profile.runtime.enabled ? ' on' : profile.stats.failures ? ' fail' : ''),
        ),
        el('span', profile.name),
      );
      button.append(line, el('small', profile.model));
      button.onclick = () => choose(profile.id);
      $('profiles').append(button);
    }
    const p = active();
    $('empty').hidden = !!p;
    $('detail').hidden = !p;
    $('stop-all-btn').disabled =
      !online || pending || !state.profiles.some((p) => p.runtime.enabled || p.runtime.running);
    $('server-note').textContent = `${state.activeRequests} / ${state.maxConcurrent} 个请求执行中`;
    if (!p) return;
    $('profile-title').textContent = p.name;
    $('profile-subtitle').textContent =
      `${p.model} · ${p.protocol === 'responses' ? 'Responses' : 'Chat Completions'} · ${p.pack === 'original' ? '原糖果题' : '五维变体轮换'}`;
    $('monitor-state').replaceWith(
      Object.assign(
        badge(
          p.runtime.enabled ? 'active' : 'idle',
          p.runtime.running ? '正在检测' : p.runtime.enabled ? '后台运行中' : '已暂停',
        ),
        { id: 'monitor-state' },
      ),
    );
    $('next-run').textContent = p.runtime.running
      ? '正在等待本次响应；关闭网页不影响后台'
      : p.runtime.enabled
        ? '下次检测：' + time(p.runtime.nextRunAt)
        : p.runtime.lastReason;
    const incidents = state.incidents.filter((i) => i.profileId === p.id);
    $('incident').hidden = !incidents.length;
    $('incident').textContent = incidents.length
      ? '最近告警 · ' + time(incidents[0].timestamp) + ' · ' + incidents[0].message
      : '';
    const stats = p.stats;
    $('pass-rate').textContent = percent(stats.passRate);
    $('pass-detail').textContent = stats.scored
      ? `${stats.passes} / ${stats.scored} 可判定 · 95%区间 ${percent(stats.passInterval.low)}–${percent(stats.passInterval.high)}`
      : '等待可判定样本';
    $('availability').textContent = percent(stats.availability);
    $('latency').textContent = stats.p95Ms == null ? '—' : (stats.p95Ms / 1000).toFixed(2) + ' s';
    $('tokens').textContent = stats.knownTokens.toLocaleString('zh-CN');
    $('usage-detail').textContent =
      `${stats.total} 次当前配置记录 · ${stats.unknownUsage} 次用量未知`;
    const current = records.filter(
        (r) => r.profileId === p.id && r.configurationId === p.configurationId,
      ),
      profileRecords = records.filter((r) => r.profileId === p.id);
    $('timeline').replaceChildren();
    for (const record of current.slice(0, 36).reverse()) {
      const button = el('button', undefined, record.status);
      button.title = time(record.timestamp) + ' · ' + labels[record.status];
      button.setAttribute('aria-label', button.title);
      button.onclick = () => showRecord(record);
      $('timeline').append(button);
    }
    if (!current.length)
      $('timeline').append(el('span', '检测后会在这里形成记录。', 'muted small'));
    $('trend').textContent = stats.trendReady
      ? `最近20个可判定样本：${percent(stats.recentRate)}；此前最多80个：${percent(stats.baselineRate)}。参数变化会开始新统计。`
      : '积累至少30个可判定样本后显示近期与基线对比；样本少时保留不确定性。';
    const rules = [
      ['检测间隔', `每 ${p.intervalMin} 分钟`],
      ['请求预算', p.outputBudget + ' token'],
      ['推理强度', p.reasoningEffort === 'default' ? '供应商默认' : p.reasoningEffort],
      ['超时限制', p.timeoutSec + ' 秒'],
      ['答错时', p.guard ? '暂停并停止本机Codex' : '暂停本配置监测'],
      ['异常 / 超时', '按原间隔继续'],
    ];
    $('rules').replaceChildren();
    for (const [key, value] of rules) $('rules').append(el('dt', key), el('dd', value));
    $('power-note').textContent =
      state.power.state === 'active'
        ? '空闲睡眠保护已生效，屏幕可熄灭。'
        : state.power.state === 'unsupported'
          ? '此平台未提供空闲睡眠保护，请保持主机唤醒。'
          : state.power.state === 'error'
            ? '空闲睡眠保护未生效，请检查系统电源设置。'
            : '手动睡眠或关机期间无法检测。';
    $('latest').replaceChildren();
    const latest = profileRecords[0];
    $('latest-time').textContent = latest ? time(latest.timestamp) : '';
    if (latest) {
      $('latest').append(
        badge(latest.status),
        el('div', latest.answer || '—', 'latest-answer'),
        el('p', latest.reason, 'muted small'),
      );
      if (latest.warnings?.length)
        $('latest').append(el('p', latest.warnings.join('；'), 'inconclusive small'));
      const more = el('button', '查看完整记录', 'text-button');
      more.onclick = () => showRecord(latest);
      $('latest').append(more);
    } else $('latest').append(el('p', '点击“检测一次”，建立第一份观察。', 'muted'));
    $('family-stats').replaceChildren();
    for (const [family, summary] of Object.entries(p.familyStats)) {
      const item = el('div', undefined, 'family-stat');
      item.append(
        el('span', familyNames[family] || family),
        el('strong', percent(summary.passRate)),
        el('span', summary.scored + ' 个可判定样本'),
      );
      $('family-stats').append(item);
    }
    if (!Object.keys(p.familyStats).length)
      $('family-stats').append(el('p', '尚无当前配置记录。', 'muted small'));
    renderHistory(profileRecords);
    renderCompare();
    renderActions();
  }
  function renderActions() {
    const p = active();
    if (!p) return;
    const busy = !!p.runtime.running || p.runtime.enabled;
    $('edit-btn').disabled = pending || !online || busy;
    $('run-btn').disabled = pending || !online || busy;
    $('start-btn').disabled = pending || !online || busy || !!state?.fatal;
    $('pause-btn').disabled = pending || !online;
    $('start-btn').hidden = p.runtime.enabled;
    $('pause-btn').hidden = !p.runtime.enabled && !p.runtime.running;
    $('compare-btn').disabled = pending || !online;
  }
  function renderHistory(rows) {
    const filter = $('history-filter').value;
    rows = rows.filter(
      (r) =>
        filter === 'all' ||
        (filter === 'error'
          ? ['error', 'timeout', 'cancelled'].includes(r.status)
          : r.status === filter),
    );
    $('history').replaceChildren();
    for (const record of rows) {
      const tr = el('tr'),
        date = el('td'),
        link = el('button', time(record.timestamp), 'record-link');
      link.onclick = () => showRecord(record);
      date.append(link, el('p', sources[record.source] || record.source));
      const result = el('td');
      result.append(badge(record.status));
      const content = el('td');
      content.append(el('code', record.answer || '—'), el('p', record.reason));
      if (record.guardAction) content.append(el('p', record.guardAction, 'fail'));
      const tokenCount =
        record.usage?.total == null ? '未知' : record.usage.total.toLocaleString('zh-CN');
      tr.append(
        date,
        result,
        content,
        el('td', (record.durationMs / 1000).toFixed(2) + ' s'),
        el('td', tokenCount),
      );
      $('history').append(tr);
    }
    if (!rows.length) {
      const tr = el('tr'),
        td = el('td', '暂无匹配的记录', 'muted');
      td.colSpan = 5;
      tr.append(td);
      $('history').append(tr);
    }
  }
  function renderCompare() {
    for (const target of ['compare-a', 'compare-b']) {
      const select = $(target),
        previous = select.value;
      select.replaceChildren();
      for (const p of state.profiles) {
        const option = el('option', p.name);
        option.value = p.id;
        option.disabled = p.runtime.enabled || !!p.runtime.running;
        select.append(option);
      }
      if (state.profiles.some((p) => p.id === previous)) select.value = previous;
      else if (target === 'compare-b' && state.profiles[1]) select.value = state.profiles[1].id;
    }
    if (lastBatch) {
      const rows = records.filter((r) => r.batchId === lastBatch);
      $('compare-result').replaceChildren();
      for (const row of rows) {
        const p = state.profiles.find((p) => p.id === row.profileId);
        const line = el(
          'p',
          (p?.name || '已删除配置') +
            ' · ' +
            labels[row.status] +
            ' · 答案 ' +
            (row.answer || '—') +
            ' · ' +
            (row.durationMs / 1000).toFixed(2) +
            ' s',
        );
        $('compare-result').append(line);
      }
      if (rows.length < 2) $('compare-result').append(el('p', '正在等待比较结果…'));
    }
  }
  function showRecord(record) {
    const detail = $('record-detail');
    detail.replaceChildren();
    const dl = el('dl');
    for (const [label, value] of [
      ['时间', time(record.timestamp)],
      ['结果', labels[record.status]],
      ['来源', sources[record.source]],
      ['原因', record.reason],
      ['实际答案', record.answer || '—'],
      ['标准答案', display(record.probe?.expected)],
      ['探针版本', record.probe?.version],
      ['随机种子', record.probe?.seed],
      [
        '调度延迟',
        record.schedulingDelayMs == null
          ? '不适用'
          : (record.schedulingDelayMs / 1000).toFixed(2) + ' 秒',
      ],
      ['模型返回名称（未经验证）', record.modelReported || '未提供'],
      ['费用提示', record.warnings?.join('；') || '无'],
      ['排查建议', record.diagnostic?.hint || '—'],
      ['本机保护', record.guardAction || '未触发'],
    ]) {
      dl.append(el('dt', label), el('dd', display(value)));
    }
    detail.append(
      dl,
      el('h3', '本次实际发送的提示词'),
      el('pre', record.probe?.prompt || '未记录'),
      el('h3', '供应商用量与响应状态'),
      el(
        'pre',
        JSON.stringify(
          {
            usage: record.usage,
            diagnostic: record.diagnostic,
            providerRequestId: record.providerRequestId,
          },
          null,
          2,
        ),
      ),
    );
    $('record-dialog').showModal();
  }
  function edit(profile = null) {
    editingId = profile?.id || null;
    const form = $('profile-form');
    form.reset();
    $('profile-dialog-title').textContent = profile ? '编辑配置' : '新建配置';
    $('form-error').textContent = '';
    $('delete-btn').hidden = !profile;
    if (profile)
      for (const [name, value] of Object.entries(profile)) {
        const field = form.elements.namedItem(name);
        if (!field || name === 'apiKey') continue;
        if (field.type === 'checkbox') field.checked = value;
        else if (value !== null) field.value = value;
      }
    form.elements.namedItem('apiKey').value = '';
    $('profile-dialog').showModal();
  }
  function tab(name) {
    activeTab = name;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const selected = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $('panel-' + button.dataset.tab).hidden = !selected;
    }
    if (name === 'probes') void preview();
  }
  async function preview() {
    try {
      const value = $('probe-family').value,
        probe = await api(
          '/api/probes/preview?' +
            new URLSearchParams({
              pack: value === 'original' ? 'original' : 'rotating',
              sequence: value === 'original' ? '0' : value,
              seed: '2026',
            }),
        );
      $('probe-prompt').textContent = probe.prompt;
      $('probe-answer').textContent = display(probe.expected);
      $('probe-version').textContent =
        probe.version + (probe.seed !== null ? ' · seed ' + probe.seed : '');
    } catch (e) {
      toast(e.message);
    }
  }
  async function download(route, name, csv = false) {
    try {
      const response = await fetch(route, {
        headers: { Authorization: 'Bearer ' + token },
        cache: 'no-store',
      });
      if (!response.ok) throw Error('导出失败');
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = el('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(e.message);
    }
  }
  $('new-btn').onclick = $('empty-new-btn').onclick = () => edit();
  $('edit-btn').onclick = () => edit(active());
  $('run-btn').onclick = () =>
    action(() => api(`/api/profiles/${selectedId}/run`, {}), '已发送一次检测请求');
  $('start-btn').onclick = () =>
    action(
      () => api(`/api/profiles/${selectedId}/start`, {}),
      '后台监测已开启，关闭网页后仍会继续',
    );
  $('pause-btn').onclick = () =>
    action(() => api(`/api/profiles/${selectedId}/stop`, {}), '已暂停该配置的检测');
  $('stop-all-btn').onclick = () => action(() => api('/api/stop-all', {}), '所有监测已暂停');
  $('help-btn').onclick = () => $('help-dialog').showModal();
  $('history-filter').onchange = () =>
    renderHistory(records.filter((r) => r.profileId === selectedId));
  $('probe-family').onchange = () => void preview();
  for (const button of document.querySelectorAll('[data-close]'))
    button.onclick = () => $(button.dataset.close).close();
  for (const button of document.querySelectorAll('[data-tab]'))
    button.onclick = () => tab(button.dataset.tab);
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[data-tab]')],
      index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tab(tabs[next].dataset.tab);
    tabs[next].focus();
  });
  $('profile-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      body = {};
    for (const name of [
      'name',
      'model',
      'baseUrl',
      'apiKey',
      'protocol',
      'pack',
      'reasoningEffort',
      'chatTokenField',
      'contextTag',
    ])
      body[name] = form.elements.namedItem(name).value;
    for (const name of ['intervalMin', 'timeoutSec', 'outputBudget'])
      body[name] = Number(form.elements.namedItem(name).value);
    body.temperature =
      form.elements.namedItem('temperature').value === ''
        ? null
        : Number(form.elements.namedItem('temperature').value);
    body.guard = form.elements.namedItem('guard').checked;
    body.clearApiKey = form.elements.namedItem('clearApiKey').checked;
    body.keepAwake = form.elements.namedItem('keepAwake').checked;
    $('save-btn').disabled = true;
    $('form-error').textContent = '';
    try {
      if (body.guard) {
        const ready = await api('/api/guard/check', {});
        if (!ready.supported) throw Error('本机保护尚不可用');
      }
      const result = await api(
        '/api/profiles' + (editingId ? '/' + editingId : ''),
        body,
        editingId ? 'PUT' : 'POST',
      );
      selectedId = result.profile.id;
      $('profile-dialog').close();
      form.elements.namedItem('apiKey').value = '';
      toast('配置已加密保存');
      await refresh();
    } catch (e) {
      $('form-error').textContent = e.message;
    } finally {
      $('save-btn').disabled = false;
    }
  };
  $('delete-btn').onclick = () => {
    if (confirm('删除此配置及其检测记录？建议先导出需要保留的记录。'))
      void action(async () => {
        await api('/api/profiles/' + editingId, {}, 'DELETE');
        $('profile-dialog').close();
      }, '已删除配置');
  };
  $('compare-btn').onclick = () =>
    action(async () => {
      const result = await api('/api/compare', {
        profileIds: [$('compare-a').value, $('compare-b').value],
      });
      lastBatch = result.batchId;
    }, '已发送同题比较，共两次请求');
  $('csv-btn').onclick = () =>
    download(
      '/api/export/history?format=csv&profileId=' + selectedId,
      'sentinel-history.csv',
      true,
    );
  $('json-btn').onclick = () =>
    download('/api/export/history?profileId=' + selectedId, 'sentinel-history.json');
  $('config-export-btn').onclick = () =>
    download('/api/export/config', 'sentinel-config-no-keys.json');
  $('import-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = async () => {
    const file = $('import-file').files[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      toast('配置文件超过512 KiB，请只导出需要迁移的配置');
      return;
    }
    void action(async () => {
      const parsed = JSON.parse(await file.text());
      const result = await api('/api/import', parsed);
      selectedId = result.profiles[0].id;
    }, '导入成功；所有配置保持暂停，本机停止保护默认关闭');
    $('import-file').value = '';
  };
  $('auth-form').onsubmit = (event) => {
    event.preventDefault();
    token = $('auth-token').value.trim();
    if (!/^[a-f0-9]{64}$/.test(token)) {
      auth('连接码应为64位十六进制字符');
      return;
    }
    try {
      sessionStorage.setItem('sentinel-token', token);
    } catch {}
    $('auth-dialog').close();
    $('auth-token').value = '';
    void refresh();
    void stream();
  };
  $('auth-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('lock-btn').onclick = () => {
    token = '';
    streamController?.abort();
    try {
      sessionStorage.removeItem('sentinel-token');
    } catch {}
    connection(false);
    auth('已锁定面板；后台监测仍会继续');
  };
  setInterval(() => void refresh(), 10000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener('pagehide', () => streamController?.abort());
  if (token) {
    void refresh();
    void stream();
  } else auth();
})();
