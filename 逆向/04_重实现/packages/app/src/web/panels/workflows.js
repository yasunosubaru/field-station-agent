/**
 * Workflows panel — the hybrid app's console for A−B gaps.
 *
 * Every row on the left is one fixed workflow from `workflows/*.yaml`. The right side shows the
 * same fields the agent-facing CLI returns (`describe`), so the UI cannot drift from the catalog:
 * parameters, risk, whether an approval gate is required, and the step count all come from
 * `/api/workflows`.
 *
 * Running starts a real job through the Python executor. High-risk jobs stop at a gate; this panel
 * is where a person approves or rejects it. `gate` / `resume` return 202 because the executor may
 * continue into a long flash/reboot, so the panel polls `/api/workflows/job` and shows the failure
 * class and artifacts when it settles. Nothing here ever reports success on its own — the status
 * comes from `job.json`.
 */

const POLL_MS = 1500;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function defaultApi() {
  const request = async (path, init) => {
    const response = await fetch(path, init);
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  };
  return {
    get: (path) => request(path),
    post: (path, body) => request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  };
}

function riskLabel(risk) {
  return risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
}

function statusLabel(status) {
  const table = {
    pending: '排队中',
    running: '运行中',
    waiting_approval: '等待审批',
    waiting_operator: '等待人工',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
  };
  return table[status] || status || '—';
}

function styleOnce() {
  if (document.getElementById('workflow-panel-style')) return;
  const style = document.createElement('style');
  style.id = 'workflow-panel-style';
  style.textContent = `
    .wf-layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; padding: 16px; }
    .wf-list { border: 1px solid #d7dde3; border-radius: 6px; overflow: hidden; background: #fff; }
    .wf-list button { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0;
      border-bottom: 1px solid #eef1f4; background: #fff; cursor: pointer; font: inherit; }
    .wf-list button:last-child { border-bottom: 0; }
    .wf-list button.active { background: #eaf3f8; box-shadow: inset 3px 0 0 #00516f; }
    .wf-list .wf-id { font-family: Consolas, monospace; font-size: 12px; color: #4a5b68; }
    .wf-list .wf-title { font-weight: 600; margin-top: 2px; }
    .wf-detail, .wf-job { border: 1px solid #d7dde3; border-radius: 6px; background: #fff; padding: 14px 16px; }
    .wf-detail h2 { margin: 0 0 4px; font-size: 18px; }
    .wf-badges { margin: 8px 0 12px; display: flex; gap: 6px; flex-wrap: wrap; }
    .wf-badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eef1f4; }
    .wf-badge.high { background: #fbe3e1; color: #9b1c12; }
    .wf-badge.gate { background: #fff3d6; color: #7a5200; }
    .wf-summary { color: #43535f; line-height: 1.5; }
    .wf-params { margin: 12px 0; display: grid; gap: 8px; }
    .wf-param { display: grid; grid-template-columns: 180px 1fr; gap: 8px; align-items: center; }
    .wf-param label { font-family: Consolas, monospace; font-size: 12px; }
    .wf-param .req { color: #9b1c12; }
    .wf-param input { padding: 5px 7px; border: 1px solid #c6ced6; border-radius: 4px; font: inherit; }
    .wf-param .hint { grid-column: 2; font-size: 12px; color: #6b7b88; }
    .wf-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .wf-btn { padding: 6px 14px; border: 1px solid #00516f; background: #00516f; color: #fff;
      border-radius: 4px; cursor: pointer; font: inherit; }
    .wf-btn.secondary { background: #fff; color: #00516f; }
    .wf-btn.danger { background: #9b1c12; border-color: #9b1c12; }
    .wf-btn:disabled { opacity: .5; cursor: default; }
    .wf-job { margin-top: 16px; }
    .wf-job[hidden] { display: none; }
    .wf-job h3 { margin: 0 0 6px; font-size: 16px; }
    .wf-kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 10px; font-size: 13px; }
    .wf-kv dt { color: #6b7b88; }
    .wf-kv dd { margin: 0; word-break: break-all; }
    .wf-gate { margin: 10px 0; padding: 10px 12px; border-left: 3px solid #c88a00; background: #fffaf0; }
    .wf-gate p { margin: 0 0 8px; white-space: pre-wrap; }
    .wf-failure { margin: 10px 0; padding: 10px 12px; border-left: 3px solid #9b1c12; background: #fdf1f0; }
    .wf-failure code { font-family: Consolas, monospace; }
    .wf-artifacts { margin-top: 8px; }
    .wf-artifacts a { display: block; font-family: Consolas, monospace; font-size: 12px; }
    .wf-note { color: #6b7b88; font-size: 12px; }
    .wf-unavailable { padding: 12px 14px; border-left: 3px solid #9b1c12; background: #fdf1f0; }
  `;
  document.head.appendChild(style);
}

export function mount(root, ctx = {}) {
  const api = (ctx && ctx.api) || defaultApi();
  styleOnce();
  root.innerHTML = `
    <div class="wf-layout">
      <div>
        <div class="wf-list" id="wf-list"><div class="wf-note" style="padding:12px">载入流程目录…</div></div>
        <p class="wf-note" id="wf-bridge"></p>
      </div>
      <div>
        <div class="wf-detail" id="wf-detail"><p class="wf-note">选择左侧一条流程。</p></div>
        <div class="wf-job" id="wf-job" hidden></div>
      </div>
    </div>`;

  const listEl = root.querySelector('#wf-list');
  const detailEl = root.querySelector('#wf-detail');
  const jobEl = root.querySelector('#wf-job');
  const bridgeEl = root.querySelector('#wf-bridge');

  let catalog = null;
  let current = null;
  let jobId = null;
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function renderBridge(info) {
    if (!info) {
      bridgeEl.textContent = '';
      return;
    }
    if (!info.available) {
      bridgeEl.textContent = `工作流不可用：${info.reason}`;
      bridgeEl.style.color = '#9b1c12';
      return;
    }
    const caps = info.capabilities || {};
    const engine = (caps.engine && caps.engine.reachable) ? '已连引擎' : '引擎未连（只影响需要接收机的流程）';
    bridgeEl.textContent = `执行器：${info.python} · ${engine}`;
    bridgeEl.style.color = '';
  }

  function renderList() {
    if (!catalog) return;
    if (!catalog.available) {
      listEl.innerHTML = `<div class="wf-unavailable">${esc(catalog.reason)}<br><br>
        装好 Python 3.11 并把 <code>NAS_PYTHON</code> 指过去，或把本机 <code>python</code> 加进 PATH。</div>`;
      return;
    }
    const rows = catalog.workflows || [];
    if (!rows.length) {
      listEl.innerHTML = '<div class="wf-note" style="padding:12px">workflows/ 下没有规格。</div>';
      return;
    }
    listEl.innerHTML = rows.map((row) => `
      <button type="button" data-wf="${esc(row.id)}" class="${current === row.id ? 'active' : ''}">
        <div class="wf-id">${esc(row.id)}</div>
        <div class="wf-title">${esc(row.title)}</div>
      </button>`).join('');
    listEl.querySelectorAll('button[data-wf]').forEach((button) => {
      button.addEventListener('click', () => {
        current = button.getAttribute('data-wf');
        renderList();
        showDetail(current);
      });
    });
  }

  function paramValue(name, spec) {
    const input = detailEl.querySelector(`[data-param="${CSS.escape(name)}"]`);
    if (!input) return undefined;
    const raw = input.value.trim();
    if (raw === '') {
      if (Object.prototype.hasOwnProperty.call(spec || {}, 'default')) return spec.default;
      return undefined;
    }
    if (spec && (spec.type === 'integer' || spec.type === 'number')) {
      const number = Number(raw);
      return Number.isFinite(number) ? number : raw;
    }
    if (spec && spec.type === 'boolean') return raw === 'true';
    return raw;
  }

  function showDetail(id) {
    const row = (catalog.workflows || []).find((item) => item.id === id);
    if (!row) return;
    const params = row.params || {};
    const paramRows = Object.keys(params).map((name) => {
      const spec = params[name] || {};
      const required = spec.required ? '<span class="req">*</span>' : '';
      const value = spec.default == null ? '' : String(spec.default);
      return `
        <div class="wf-param">
          <label for="wf-p-${esc(name)}">${esc(name)} ${required}</label>
          <input id="wf-p-${esc(name)}" data-param="${esc(name)}" value="${esc(value)}"
            placeholder="${esc(spec.type || 'string')}">
          <div class="hint">${esc(spec.description || '')}</div>
        </div>`;
    }).join('') || '<p class="wf-note">这条流程没有参数。</p>';

    detailEl.innerHTML = `
      <h2>${esc(row.title)}</h2>
      <div class="wf-id" style="font-family:Consolas,monospace;color:#4a5b68">${esc(row.id)}</div>
      <div class="wf-badges">
        <span class="wf-badge ${row.risk === 'high' ? 'high' : ''}">${esc(riskLabel(row.risk))}</span>
        ${row.approval && row.approval.required ? '<span class="wf-badge gate">审批门</span>' : ''}
        <span class="wf-badge">${row.steps} 步</span>
        <span class="wf-badge">${esc(row.intent)}</span>
      </div>
      <p class="wf-summary">${esc(row.summary || '')}</p>
      <div class="wf-params">${paramRows}</div>
      <div class="wf-actions">
        <button type="button" class="wf-btn" id="wf-run">运行</button>
        <span class="wf-note" id="wf-run-note"></span>
      </div>`;
    detailEl.querySelector('#wf-run').addEventListener('click', () => runSelected(row, params));
  }

  async function runSelected(row, params) {
    const note = detailEl.querySelector('#wf-run-note');
    const button = detailEl.querySelector('#wf-run');
    const values = {};
    for (const name of Object.keys(params)) {
      const value = paramValue(name, params[name]);
      if (value !== undefined) values[name] = value;
    }
    button.disabled = true;
    note.textContent = '已提交，等待执行器返回…';
    try {
      const view = await api.post('/api/workflows/run', { id: row.id, params: values });
      note.textContent = '';
      renderJob(view);
      if (view.job_id) poll(view.job_id);
    } catch (error) {
      note.textContent = String(error.message || error);
    } finally {
      button.disabled = false;
    }
  }

  function renderJob(view) {
    if (!view || !view.job_id) {
      jobEl.hidden = true;
      return;
    }
    jobEl.hidden = false;
    const gate = view.gate;
    const failure = view.failure;
    const artifacts = view.artifacts || [];
    const actions = (view.next_actions || []).map((line) => `<div class="wf-note">${esc(line)}</div>`).join('');

    let gateHtml = '';
    if (gate) {
      const options = gate.kind === 'approval' ? ['approved', 'rejected'] : ['done', 'failed'];
      gateHtml = `
        <div class="wf-gate">
          <strong>${gate.kind === 'approval' ? '等待审批' : '等待人工完成'} · ${esc(gate.step)}</strong>
          <p>${esc(gate.prompt || gate.reason || '')}</p>
          <div class="wf-actions">
            ${options.map((option) => `<button type="button" class="wf-btn ${option === 'rejected' || option === 'failed' ? 'danger' : ''}"
              data-decision="${esc(option)}">${option === 'approved' ? '批准' : option === 'rejected' ? '拒绝' : option === 'done' ? '已完成' : '失败'}</button>`).join('')}
          </div>
        </div>`;
    }

    const failureHtml = failure ? `
      <div class="wf-failure">
        <strong>失败 · ${esc(failure.class)}</strong>
        <div>步骤 <code>${esc(failure.step)}</code>：${esc(failure.message)}</div>
      </div>` : '';

    const artifactHtml = artifacts.length ? `
      <div class="wf-artifacts">
        <div class="wf-note">证据（sha256 在 job.json 里）</div>
        ${artifacts.map((item) => `<a href="/api/workflows/artifact?id=${encodeURIComponent(view.job_id)}&name=${encodeURIComponent(item.name)}"
          target="_blank" rel="noopener">${esc(item.name)} · ${esc(item.bytes)} B</a>`).join('')}
      </div>` : '';

    jobEl.innerHTML = `
      <h3>${esc(view.title || view.workflow || '')}</h3>
      <dl class="wf-kv">
        <dt>job</dt><dd>${esc(view.job_id)}</dd>
        <dt>状态</dt><dd>${esc(statusLabel(view.status))}</dd>
        <dt>步骤</dt><dd>${esc(view.current_step || '—')}（${esc(view.step_index)}/${esc(view.steps_total)}）</dd>
        <dt>参数</dt><dd>${esc(JSON.stringify(view.params || {}))}</dd>
      </dl>
      ${gateHtml}${failureHtml}${artifactHtml}${actions}
      <div class="wf-actions" style="margin-top:10px">
        <button type="button" class="wf-btn secondary" id="wf-refresh">刷新</button>
        <button type="button" class="wf-btn secondary" id="wf-cancel">取消 job</button>
      </div>`;

    jobEl.querySelector('#wf-refresh').addEventListener('click', () => poll(view.job_id, true));
    jobEl.querySelector('#wf-cancel').addEventListener('click', async () => {
      try {
        renderJob(await api.post('/api/workflows/job/cancel', { id: view.job_id, reason: 'cancelled from UI' }));
      } catch (error) {
        jobEl.querySelector('.wf-kv').insertAdjacentHTML('afterend', `<div class="wf-note">${esc(error.message)}</div>`);
      }
    });
    jobEl.querySelectorAll('button[data-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        const decision = button.getAttribute('data-decision');
        jobEl.querySelectorAll('button[data-decision]').forEach((b) => { b.disabled = true; });
        const path = gate.kind === 'approval' ? '/api/workflows/job/gate' : '/api/workflows/job/resume';
        try {
          await api.post(path, { id: view.job_id, decision, by: 'operator', note: '' });
          poll(view.job_id, true, true);
        } catch (error) {
          jobEl.querySelectorAll('button[data-decision]').forEach((b) => { b.disabled = false; });
          jobEl.insertAdjacentHTML('beforeend', `<div class="wf-note">${esc(error.message)}</div>`);
        }
      });
    });
  }

  function poll(id, immediate = false, untilTerminal = false) {
    stopPolling();
    jobId = id;
    const tick = async () => {
      if (jobId !== id) return;
      try {
        const view = await api.get(`/api/workflows/job?id=${encodeURIComponent(id)}`);
        renderJob(view);
        const terminal = ['succeeded', 'failed', 'cancelled'].includes(view.status);
        // After gate/resume the worker may not have written the new status yet; keep polling
        // until it settles. A plain run only polls while it is still running.
        if (!terminal && (untilTerminal || view.status === 'running' || view.status === 'pending')) {
          pollTimer = setTimeout(tick, POLL_MS);
        }
      } catch (error) {
        jobEl.insertAdjacentHTML('beforeend', `<div class="wf-note">${esc(error.message)}</div>`);
      }
    };
    if (immediate) tick();
    else pollTimer = setTimeout(tick, POLL_MS);
  }

  api.get('/api/workflows')
    .then((data) => {
      catalog = data;
      renderBridge(data);
      renderList();
      if ((data.workflows || []).length) {
        current = data.workflows[0].id;
        renderList();
        showDetail(current);
      }
    })
    .catch((error) => {
      listEl.innerHTML = `<div class="wf-unavailable">流程目录读取失败：${esc(error.message)}</div>`;
    });

  return () => stopPolling();
}
