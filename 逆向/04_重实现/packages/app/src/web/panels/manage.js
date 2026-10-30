/**
 * Manage panel — the original Manage view (status tiles + log status + field table) rebuilt on top
 * of the local JSON API.
 *
 * Markup and class names are transcribed from the unpacked Application Suite:
 *   view/positionStatus/positionStatus.html   positioning tile
 *   view/deviceInfo/deviceInfo.html           device tile
 *   view/logStatus/logStatus.html             log status tile
 * and every colour / size in manage.css is quoted from view/css/style.css (line numbers there).
 *
 * Contract with the shell (`src/web/shell.js`):
 *   mount(root, ctx)   root = <div id="panel-manage">
 *   unmount(root)
 *   ctx = { api: { get(path, params), post(path, body) }, capture, onCaptureChange(cb) }
 *
 * The panel keeps its own capture selection so it stays usable on its own; it follows the shell's
 * selection through `onCaptureChange` and never assumes it exists.
 */

const CSS_URL = new URL('./manage.css', import.meta.url).href;
const CSS_ID = 'nas-panel-manage-css';

const POSITION_PATHS = [
  ['solution_status', 'Operating Mode'],
  ['position_type', 'Position Type'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
  ['orthometric_height', 'Height (MSL)'],
  ['height_std_dev', 'Height Accuracy'],
  ['latitude_std_dev', 'Latitude SD'],
  ['longitude_std_dev', 'Longitude SD'],
  ['datum_id', 'Datum'],
  ['num_soln_svs', 'Used SVs'],
  ['diff_age', 'Differential Age'],
];

/* ---------------- small helpers (kept local: the shell may load one panel at a time) ---------- */

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function withQuery(path, params) {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
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
    get: (path, params) => request(withQuery(path, params)),
    post: (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function utcText(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function shownValue(field) {
  if (!field) return '—';
  const text = field.text;
  if (text === undefined || text === null || text === '') return String(field.value);
  return String(text);
}

/** `data-el="field-filter"` becomes `el.fieldFilter`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function statusRow(label, value, hint) {
  return (
    '<div class="row">' +
    `<span class="title">${esc(label)}</span>` +
    `<span class="value posStats"${hint ? ` title="${esc(hint)}"` : ''}>${esc(value)}</span>` +
    '</div>'
  );
}

/** One deviceInfo.html row: title | value | its own traffic light (`.deviceinfo-field`). */
function deviceRow(label, value, good) {
  return (
    '<div class="row">' +
    `<span class="title device-fields">${esc(label)}</span>` +
    `<span class="value">${esc(value)}</span>` +
    '<div class="statustiles-traffic deviceinfo-field">' +
    `<span class="green-status${good ? ' is-on' : ''}">Good</span>` +
    `<span class="yellow-status${good ? '' : ' is-on'}">Warning</span>` +
    '</div>' +
    '</div>'
  );
}

function badgeGroup(kind, state) {
  const on = (name) => (state === name ? ' is-on' : '');
  return (
    `<div class="statustiles-traffic" data-badge="${kind}">` +
    `<span class="green-status${on('good')}">Good</span>` +
    `<span class="yellow-status${on('warn')}">Warning</span>` +
    `<span class="red-status${on('bad')}">Error</span>` +
    '</div>'
  );
}

function template() {
  return `
<div class="manage-band">
  <div class="tile status-tile position-status">
    <div class="position-status-header status-header">
      <span class="heading">Positioning</span>
      ${badgeGroup('position', 'good')}
    </div>
    <div class="status-tile-main-container">
      <div class="oem-positionStatus" data-el="position-rows"></div>
      <div class="manage-note" data-el="position-note"></div>
    </div>
  </div>

  <div class="tile status-tile device-status">
    <div class="device-status-header status-header">
      <span class="heading">Device</span>
      ${badgeGroup('device', 'good')}
    </div>
    <div class="status-tile-main-container" data-el="device-rows"></div>
    <div class="manage-note" data-el="device-note"></div>
  </div>
</div>

<div class="notice" data-el="error" hidden></div>

<div class="tile manage-log-tile">
  <div class="log-status-header status-header">
    <span class="heading">Log Status</span>
    ${badgeGroup('log', 'good')}
  </div>
  <div class="manage-toolbar">
    <label class="manage-field"><span>Capture</span><select data-el="capture"></select></label>
    <label class="manage-field grow"><span>Filter<em data-el="count"></em></span>
      <input type="search" data-el="filter" placeholder="RANGE / 43 / #RANGEA" autocomplete="off">
    </label>
    <button class="btn btn-default darkBtn" type="button" data-el="refresh">Refresh</button>
  </div>
  <p class="manage-meta" data-el="meta">Reading capture list…</p>
  <div class="manage-table-wrap">
    <table class="g3-devicedetails-table log-message-table">
      <thead>
        <tr>
          <th class="num">ID</th>
          <th>Message</th>
          <th class="num">Records</th>
          <th class="num">CRC fail</th>
          <th>GPS window</th>
          <th>Sample</th>
        </tr>
      </thead>
      <tbody data-el="rows"></tbody>
    </table>
  </div>
</div>

<div class="tile manage-record-tile" data-el="record" hidden>
  <div class="status-header">
    <span class="heading" data-el="record-title">Decoded fields</span>
    <div class="manage-pager">
      <button class="btn btn-default lightBtn" type="button" data-el="prev">Prev</button>
      <span class="manage-pager-index" data-el="index">— / —</span>
      <button class="btn btn-default lightBtn" type="button" data-el="next">Next</button>
    </div>
  </div>
  <table class="g3-devicedetails-table record-head-table" data-el="record-head"></table>
  <div class="manage-field-tools">
    <input type="search" data-el="field-filter" placeholder="Filter fields (latitude, obs[3].psr)" autocomplete="off">
    <span class="manage-meta" data-el="field-count"></span>
  </div>
  <div class="manage-table-wrap">
    <table class="g3-devicedetails-table field-table">
      <thead>
        <tr><th class="num idx">#</th><th>Field path</th><th>Value</th><th>Raw</th></tr>
      </thead>
      <tbody data-el="field-rows"></tbody>
    </table>
  </div>
</div>`;
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__manageCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__manageCleanup = null;
}

export function mount(root, ctx = {}) {
  unmount(root);
  ensureCss();

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();
  root.classList.add('manage-panel');
  root.innerHTML = template();
  const el = collect(root);

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    logs: null,
    selectedId: null,
    offset: 0,
    detail: null,
    fieldFilter: '',
    position: null,
    device: null,
    rx: null,
  };

  function badge(kind, value) {
    const target = { good: 'green-status', warn: 'yellow-status', bad: 'red-status' }[value];
    for (const span of root.querySelectorAll(`[data-badge="${kind}"] > span`)) {
      span.classList.toggle('is-on', span.classList.contains(target));
    }
  }

  function alert(message) {
    if (!message) {
      el.error.hidden = true;
      el.error.textContent = '';
      return;
    }
    el.error.hidden = false;
    el.error.textContent = message;
  }

  /* ---- capture list ---- */

  function fillCaptures() {
    el.capture.innerHTML = state.captures.length
      ? state.captures
          .map((item) => `<option value="${esc(item.path)}">${esc(`${item.name} · ${item.path} · ${bytesText(item.bytes)}`)}</option>`)
          .join('')
      : '<option value="">(no capture under samples/)</option>';
    if (state.capture && state.captures.some((item) => item.path === state.capture)) {
      el.capture.value = state.capture;
    } else if (state.captures.length) {
      const preferred =
        state.captures.find((item) => item.path === 'convert/clean-9600.gps') ||
        state.captures.find((item) => item.name === 'clean-9600.gps') ||
        state.captures[0];
      state.capture = preferred.path;
      el.capture.value = preferred.path;
    }
  }

  /* ---- status tiles ---- */

  function renderPosition(record) {
    const rows = [];
    if (!record) {
      rows.push(statusRow('Operating Mode', 'no BESTPOS in capture'));
      el.positionRows.innerHTML = rows.join('');
      el.positionNote.textContent = 'Positioning comes from the first BESTPOS (#42) record.';
      badge('position', 'warn');
      return;
    }
    for (const [path, label] of POSITION_PATHS) {
      const field = record.fields.find((item) => item.path === path);
      let value = shownValue(field);
      if (field && typeof field.value === 'number' && !field.text) {
        if (path === 'latitude' || path === 'longitude') value = `${fixed(field.value, 9)}°`;
        else if (path === 'orthometric_height') value = `${fixed(field.value, 3)} m`;
        else if (path.endsWith('_std_dev')) value = `${fixed(field.value, 4)} m`;
        else if (path === 'diff_age') value = `${fixed(field.value, 3)} s`;
      }
      rows.push(statusRow(label, value, `BESTPOS.${path}`));
    }
    el.positionRows.innerHTML = rows.join('');
    const solid = record.fields.find((item) => item.path === 'solution_status');
    const computed = shownValue(solid) === 'SOL_COMPUTED';
    badge('position', computed ? 'good' : 'warn');
    el.positionNote.textContent = computed
      ? 'SOL_COMPUTED — the receiver reports a valid position solution.'
      : 'Solution not computed; the values above come from the last BESTPOS record.';
  }

  function renderDevice(logs, hw, rx) {
    const rows = [];
    const rxError = rx ? shownValue(rx.fields.find((item) => item.path === 'rx_error')) : '—';
    rows.push(
      deviceRow(
        'Receiver Status',
        rxError === '00000000' ? 'OK (00000000)' : rxError,
        rxError === '00000000',
      ),
    );
    rows.push(deviceRow('Log Records', `${logs.accepted} / ${logs.totalRecords}`, logs.dropped === 0));
    rows.push(deviceRow('CRC Failed', String(logs.dropped), logs.dropped === 0));
    rows.push(deviceRow('Message Types', String(logs.types), true));

    const measurement = (index) => {
      if (!hw) return null;
      return hw.fields.find((item) => item.path === `measurements[${index}].value`) ?? null;
    };
    const temp = measurement(0);
    const volt = measurement(3);
    rows.push(
      deviceRow(
        'Board Temperature',
        temp ? `${fixed(temp.value, 2)} °C` : '—',
        temp ? Number(temp.value) < 70 : false,
      ),
    );
    rows.push(
      deviceRow(
        'Supply Voltage',
        volt ? `${fixed(volt.value, 3)} V` : '—',
        volt ? Number(volt.value) > 4.5 && Number(volt.value) < 5.5 : false,
      ),
    );
    el.deviceRows.innerHTML = rows.join('');

    const healthy = logs.dropped === 0 && (rxError === '00000000' || rxError === '—');
    badge('device', healthy ? 'good' : 'warn');
    el.deviceNote.textContent = hw
      ? 'Temperature / voltage are HWMONITOR (#963) measurements[0] and [3].'
      : 'No HWMONITOR record in this capture.';
  }

  /* ---- message table ---- */

  function visibleGroups() {
    if (!state.logs) return [];
    const needle = el.filter.value.trim().toLowerCase();
    if (!needle) return state.logs.groups;
    return state.logs.groups.filter(
      (group) =>
        String(group.id).includes(needle) ||
        group.name.toLowerCase().includes(needle) ||
        group.sample.toLowerCase().includes(needle),
    );
  }

  function renderRows() {
    if (!state.logs) {
      el.rows.innerHTML = '<tr class="empty-row"><td colspan="6">No statistics yet.</td></tr>';
      el.count.textContent = '';
      return;
    }
    const groups = visibleGroups();
    el.count.textContent = ` ${groups.length}/${state.logs.groups.length}`;
    if (!groups.length) {
      el.rows.innerHTML = '<tr class="empty-row"><td colspan="6">No message type matches this filter.</td></tr>';
      return;
    }
    el.rows.innerHTML = groups
      .map((group) => {
        const gps = `W${group.firstWeek} · ${(group.firstMilliseconds / 1000).toFixed(3)} – ${(group.lastMilliseconds / 1000).toFixed(3)}`;
        const utc = `${utcText(group.firstUtc)} → ${utcText(group.lastUtc).slice(11)}`;
        const crc = group.crcFailed
          ? `<span class="crc-fail">${group.crcFailed}</span>`
          : '<span class="crc-ok">0</span>';
        const unknown = group.known ? '' : ' <span class="tag">no layout</span>';
        return (
          `<tr class="clickable${state.selectedId === group.id ? ' selected' : ''}" data-msgid="${group.id}" tabindex="0">` +
          `<td class="num id-cell">${group.id}</td>` +
          `<td><span class="type-name">${esc(group.name)}</span>${unknown}</td>` +
          `<td class="num">${group.count}</td>` +
          `<td class="num">${crc}</td>` +
          `<td><span class="gps-window">${esc(gps)}</span><br><span class="utc-window">${esc(utc)} UTC</span></td>` +
          `<td><span class="sample" title="${esc(group.sample)}">${esc(group.sample)}</span></td>` +
          '</tr>'
        );
      })
      .join('');
  }

  function renderMeta() {
    const logs = state.logs;
    if (!logs) return;
    el.meta.textContent =
      `${logs.capture} · ${bytesText(logs.bytes)} · ${logs.totalRecords} records · ` +
      `${logs.accepted} CRC-good · ${logs.dropped} dropped · first record ${utcText(logs.spanUtc ?? logs.span?.utc)} UTC` +
      (logs.textRecords ? ` · ${logs.textRecords} text records (not converted)` : '');
  }

  /* ---- field table ---- */

  function renderRecord() {
    const data = state.detail;
    if (!data || !data.records.length) {
      el.record.hidden = true;
      return;
    }
    const record = data.records[0];
    const header = record.header;
    el.record.hidden = false;
    el.recordTitle.textContent = `${data.name} · #${data.messageId} · decoded fields`;
    el.index.textContent = `${record.index + 1} / ${data.total}`;
    el.prev.disabled = record.index <= 0;
    el.next.disabled = record.index >= data.total - 1;

    const pairs = [
      ['Frame', String(record.index + 1)],
      ['Port', header.portName],
      ['Sequence', String(header.sequence)],
      ['GPS', `W${header.week} · ${(header.milliseconds / 1000).toFixed(3)}`],
      ['UTC', `${utcText(header.utc)} UTC`],
      ['Time status', header.timeStatus],
      ['Receiver status', header.receiverStatus],
      ['Payload', `${header.payloadLength} B`],
      ['Record', `${header.frameBytes} B`],
      ['CRC', header.crcOk ? 'OK' : 'FAIL'],
    ];
    let headHtml = '';
    for (let i = 0; i < pairs.length; i += 2) {
      const left = pairs[i];
      const right = pairs[i + 1];
      headHtml +=
        '<tr>' +
        `<th>${esc(left[0])}</th><td>${esc(left[1])}</td>` +
        (right ? `<th>${esc(right[0])}</th><td>${esc(right[1])}</td>` : '<td></td><td></td>') +
        '</tr>';
    }
    el.recordHead.innerHTML = headHtml;

    const needle = state.fieldFilter.trim().toLowerCase();
    const fields = record.fields.filter(
      (field) =>
        !needle ||
        field.path.toLowerCase().includes(needle) ||
        String(field.text ?? '').toLowerCase().includes(needle) ||
        String(field.value).toLowerCase().includes(needle),
    );
    el.fieldCount.textContent = `${fields.length} / ${record.fieldTotal} fields` + (data.layoutKnown ? '' : ' · no EDIE layout');
    if (!fields.length) {
      el.fieldRows.innerHTML = '<tr class="empty-row"><td colspan="4">No field matches this filter.</td></tr>';
      return;
    }
    let html = fields
      .slice(0, 800)
      .map((field, index) => {
        const shown = shownValue(field);
        const raw = String(field.value);
        return (
          '<tr>' +
          `<td class="num idx">${index + 1}</td>` +
          `<td class="path">${esc(field.path)}</td>` +
          `<td class="shown">${esc(shown)}</td>` +
          `<td class="raw">${esc(raw === shown ? '' : raw)}</td>` +
          '</tr>'
        );
      })
      .join('');
    if (fields.length > 800) {
      html += `<tr class="empty-row"><td colspan="4">Showing the first 800 of ${fields.length} filtered fields.</td></tr>`;
    }
    el.fieldRows.innerHTML = html;
  }

  /* ---- loading ---- */

  async function loadRecord(messageId, offset, scroll) {
    state.selectedId = messageId;
    state.offset = offset;
    renderRows();
    try {
      const data = await api.get('/api/records', { capture: state.capture, msgId: messageId, offset, limit: 1 });
      if (!state.alive) return;
      state.detail = data;
      renderRecord();
      if (scroll && el.record.scrollIntoView) el.record.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (!state.alive) return;
      alert(`Field decode failed: ${error.message}`);
    }
  }

  async function loadData() {
    if (!state.capture) return;
    alert('');
    el.meta.textContent = 'Reading log statistics…';
    try {
      const logs = await api.get('/api/logs', { capture: state.capture });
      if (!state.alive) return;
      state.logs = logs;
      state.selectedId = null;
      state.detail = null;
      state.offset = 0;
      el.record.hidden = true;
      renderMeta();
      renderRows();
      const logState = logs.dropped === 0 ? 'good' : 'warn';
      badge('log', logState);
    } catch (error) {
      if (!state.alive) return;
      alert(`Log statistics failed: ${error.message}`);
      el.meta.textContent = '—';
      return;
    }

    // The tiles are decoration on top of the statistics: a capture without BESTPOS / HWMONITOR /
    // RXSTATUS must still show the table, so each probe fails soft.
    const probe = async (msgId) => {
      try {
        const data = await api.get('/api/records', { capture: state.capture, msgId, limit: 1 });
        return data.records && data.records[0] ? data.records[0] : null;
      } catch {
        return null;
      }
    };
    const [position, rx] = await Promise.all([probe(42), probe(93)]);
    const hw = state.logs && state.logs.groups.some((group) => group.id === 963) ? await probe(963) : null;
    if (!state.alive) return;
    state.position = position;
    state.rx = rx;
    renderPosition(position);
    renderDevice(state.logs, hw, rx);
  }

  async function boot() {
    try {
      const captures = await api.get('/api/captures');
      if (!state.alive) return;
      state.captures = captures.captures ?? [];
      fillCaptures();
      await loadData();
    } catch (error) {
      if (!state.alive) return;
      alert(`Capture list failed: ${error.message}`);
      el.meta.textContent = '—';
    }
  }

  /* ---- events ---- */

  const onCapturePick = () => {
    state.capture = el.capture.value;
    loadData();
  };
  const onFilter = () => renderRows();
  const onRefresh = () => loadData();
  const onRowsClick = (event) => {
    const row = event.target.closest('tr[data-msgid]');
    if (!row) return;
    loadRecord(Number(row.dataset.msgid), 0, true);
  };
  const onRowsKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-msgid]');
    if (!row) return;
    event.preventDefault();
    loadRecord(Number(row.dataset.msgid), 0, true);
  };
  const onPrev = () => {
    if (!state.detail) return;
    loadRecord(state.detail.messageId, Math.max(0, state.detail.offset - 1), false);
  };
  const onNext = () => {
    if (!state.detail) return;
    loadRecord(state.detail.messageId, state.detail.offset + 1, false);
  };
  const onFieldFilter = () => {
    state.fieldFilter = el.fieldFilter.value;
    renderRecord();
  };

  el.capture.addEventListener('change', onCapturePick);
  el.filter.addEventListener('input', onFilter);
  el.refresh.addEventListener('click', onRefresh);
  el.rows.addEventListener('click', onRowsClick);
  el.rows.addEventListener('keydown', onRowsKey);
  el.prev.addEventListener('click', onPrev);
  el.next.addEventListener('click', onNext);
  el.fieldFilter.addEventListener('input', onFieldFilter);

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || name === state.capture) return;
      state.capture = name;
      if (state.captures.some((item) => item.path === name)) el.capture.value = name;
      loadData();
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__manageCleanup = () => {
    state.alive = false;
    el.capture.removeEventListener('change', onCapturePick);
    el.filter.removeEventListener('input', onFilter);
    el.refresh.removeEventListener('click', onRefresh);
    el.rows.removeEventListener('click', onRowsClick);
    el.rows.removeEventListener('keydown', onRowsKey);
    el.prev.removeEventListener('click', onPrev);
    el.next.removeEventListener('click', onNext);
    el.fieldFilter.removeEventListener('input', onFieldFilter);
    if (offCapture) offCapture();
  };

  boot();
}

export default { mount, unmount };
