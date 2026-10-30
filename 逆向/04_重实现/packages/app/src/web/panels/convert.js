/**
 * Convert panel — the suite's Convert *Format* screen plus a result summary and a 200-line preview.
 *
 * The screen structure is transcribed from `view/convert/convert.html`:
 *   `.convertLayout` > `.convert-screens.convert-settings`
 *     `.selected-file-info`  > `.sel-files-view.single-file-view`
 *     `.output-settings`     > `.output-title` · `.tabStyle` · `.format-settings-layout`
 *                              (`.msg-format-selection` + `.format-gereral-settings`) · `.btnsRow`
 *   `.convert-screens.convert-summary` > `.summary-container` > `.conversion-summary-formats`
 *                              + `.conversion-details-container` (the preview, which the
 *                              original does not have — it shows the output folder instead).
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./convert.css', import.meta.url).href;
const CSS_ID = 'nas-panel-convert-css';

/* ---------------- helpers ---------------- */

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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stampFromInputs(dateValue, hh, mm, ss) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || '').trim());
  if (!match) return null;
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  if (![h, m, s].every((n) => Number.isFinite(n))) return null;
  if (h > 23 || m > 59 || s > 59) return null;
  const stamp = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), h, m, s),
  );
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
}

/** The suite names its output directory `Converted_On_YYYYMMDD_THHMM` (see summary.ts). */
function convertedOn(iso) {
  const date = new Date(String(iso ?? ''));
  if (Number.isNaN(date.getTime())) return null;
  const p = (value) => String(value).padStart(2, '0');
  return (
    `Converted_On_${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `_T${p(date.getUTCHours())}${p(date.getUTCMinutes())}`
  );
}

function fillStampInputs(current) {
  return {
    date: `${current.getUTCFullYear()}-${pad2(current.getUTCMonth() + 1)}-${pad2(current.getUTCDate())}`,
    hh: pad2(current.getUTCHours()),
    mm: pad2(current.getUTCMinutes()),
    ss: pad2(current.getUTCSeconds()),
  };
}

/** `data-el="preview-note"` becomes `el.previewNote`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function template() {
  return `
<div class="convertLayout">
  <div class="notice" data-el="error" hidden></div>

  <div class="convert-screens convert-settings" data-el="settings">
    <div class="selected-file-info">
      <div class="sel-files-view single-file-view">
        <label class="single-file-msg">Selected file:</label>
        <label class="single-file-name elidedText" data-el="capture-name">&mdash;</label>
        <select class="convert-capture" data-el="capture" aria-label="Capture file"></select>
      </div>
    </div>

    <div class="output-settings">
      <label class="output-title">Output Settings</label>
      <div class="tabStyle">
        <span class="active formatSettings">Format</span>
      </div>

      <div class="format-settings-tab">
        <div class="format-settings-layout">
          <div class="msg-format-selection">
            <label>Format</label>
            <div class="msg-format-list" data-el="formats" role="radiogroup" aria-label="Output format"></div>
          </div>

          <div class="format-gereral-settings">
            <div class="time-interval-layout">
              <div class="single-file-time-interval">
                <label class="timeIntervalHeading">Converted On (UTC)</label>
                <p class="convert-hint">Stamped into the output folder name, exactly like the suite does.</p>
                <div class="utc-time-inputs">
                  <div class="time-row">
                    <label class="time-label">Date</label>
                    <div class="datetime-input-group">
                      <input type="text" class="date-input" data-el="date" placeholder="YYYY-MM-DD" maxlength="10">
                      <input type="number" class="time-input" data-el="hh" placeholder="HH" min="0" max="23">
                      <span class="time-separator">:</span>
                      <input type="number" class="time-input" data-el="mm" placeholder="mm" min="0" max="59">
                      <span class="time-separator">:</span>
                      <input type="number" class="time-input" data-el="ss" placeholder="ss" min="0" max="59">
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="destination-selection-layout">
              <label class="format-settings-headings">Destination</label>
              <p class="convert-hint">
                Nothing is written to disk: the artifact stays in the server's memory and the
                <em>Download</em> button below streams it back.
              </p>
              <input readonly class="destination-folder-path" data-el="destination" value="(in memory)">
            </div>
          </div>
        </div>

        <div class="row btnsRow">
          <div class="need-help"><span data-el="source-note">Reading capture list…</span></div>
          <button type="button" class="lightBtn start-over-button" data-el="clear">Clear</button>
          <button type="button" class="btn btn-default darkBtn format-convert-button" data-el="convert">Convert</button>
        </div>
      </div>
    </div>
  </div>

  <div class="convert-screens convert-summary" data-el="summary" hidden>
    <div class="summary-container">
      <label class="conversion-heading">Conversion Results</label>
      <div class="conversion-summary-formats">
        <div class="individual-format-details" data-el="meta"></div>
      </div>

      <div class="conversion-details-container">
        <div class="summary-details-tabbing">
          <div class="summary-details-tabs active-tab"><a>Preview</a></div>
          <span class="summary-preview-note" data-el="preview-note"></span>
        </div>
        <div class="convert-preview" data-el="preview"></div>
      </div>
    </div>
  </div>
</div>`;
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__convertCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__convertCleanup = null;
}

export function mount(root, ctx = {}) {
  unmount(root);
  ensureCss();

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();
  root.innerHTML = template();
  const el = collect(root);

  const stamp = fillStampInputs(new Date());
  el.date.value = stamp.date;
  el.hh.value = stamp.hh;
  el.mm.value = stamp.mm;
  el.ss.value = stamp.ss;

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    formats: [],
    format: 'ASCII',
    busy: false,
    result: null,
  };

  function alert(message) {
    if (!message) {
      el.error.hidden = true;
      el.error.textContent = '';
      return;
    }
    el.error.hidden = false;
    el.error.textContent = message;
  }

  function currentCapture() {
    return state.captures.find((item) => item.path === state.capture) ?? null;
  }

  function renderCapture() {
    const item = currentCapture();
    el.captureName.textContent = item ? item.name : '—';
    el.captureName.title = item ? item.path : '';
    el.sourceNote.textContent = item
      ? `${item.path} · ${item.bytes.toLocaleString('en-US')} bytes · read-only`
      : 'No capture selected.';
  }

  function fillCaptures() {
    el.capture.innerHTML = state.captures.length
      ? state.captures
          .map((item) => `<option value="${esc(item.path)}">${esc(item.path)} · ${bytesText(item.bytes)}</option>`)
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
    renderCapture();
  }

  function renderFormats() {
    el.formats.innerHTML = state.formats
      .map((item) => {
        const active = item.id === state.format;
        return (
          `<div class="format-entry${active ? ' active' : ''}" data-format="${esc(item.id)}" role="radio" ` +
          `aria-checked="${active ? 'true' : 'false'}" tabindex="0">` +
          '<div class="format-details">' +
          `<label>${esc(item.label)}</label>` +
          `<p class="convert-hint">${esc(item.note)}</p>` +
          '</div>' +
          `<button type="button" class="select-device-btn${active ? ' active-select-btn' : ''}" ` +
          `aria-label="${esc(item.label)}"></button>` +
          '</div>'
        );
      })
      .join('');
  }

  function selectFormat(id) {
    if (!state.formats.some((item) => item.id === id)) return;
    state.format = id;
    renderFormats();
  }

  function renderPreview(data) {
    const body = data.preview ?? data.text ?? '';
    el.preview.innerHTML = '';
    if (!body) {
      el.preview.innerHTML = '<div class="preview-empty">(empty artifact)</div>';
      return;
    }
    const lines = String(body).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const shown = lines.slice(0, 200);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < shown.length; i++) {
      const row = document.createElement('div');
      row.className = 'preview-line';
      const number = document.createElement('span');
      number.className = 'ln';
      number.textContent = String(i + 1);
      const code = document.createElement('span');
      code.className = 'lc';
      code.textContent = shown[i];
      row.appendChild(number);
      row.appendChild(code);
      fragment.appendChild(row);
    }
    el.preview.appendChild(fragment);
  }

  function renderResult(data) {
    state.result = data;
    const folder = convertedOn(data.at);
    const rows = [
      ['Output file', data.fileName, 'mono'],
      ['Size', bytesText(data.bytes), ''],
      [data.binary ? 'Hex lines' : 'Lines', String(data.lineTotal), ''],
      ['Records', `${data.records.accepted} / ${data.records.total}`, ''],
      ['Elapsed', `${Number(data.elapsedMs).toFixed(1)} ms`, ''],
      ['Output folder', folder ? `${folder}/${data.formatDirectory}/` : data.formatDirectory, 'mono small'],
    ];
    let html = rows
      .map(
        (row) =>
          '<div class="format-row">' +
          `<span class="format-row-label">${esc(row[0])}</span>` +
          `<span class="format-row-value ${row[2]}">${esc(row[1])}</span>` +
          '</div>',
      )
      .join('');
    html +=
      '<div class="format-row actions">' +
      '<span class="format-row-label">Download</span>' +
      `<a class="btn btn-default darkBtn" data-el="download" href="${esc(data.downloadUrl)}" ` +
      `download="${esc(data.fileName)}">Download ${esc(data.fileName)}</a>` +
      '</div>';
    el.meta.innerHTML = html;

    el.previewNote.textContent = data.truncated
      ? `first ${data.shownLines} of ${data.lineTotal} lines — download for the rest`
      : data.binary
        ? `hex dump, first ${data.shownLines} lines`
        : `all ${data.lineTotal} lines · ${bytesText(data.bytes)}`;
    renderPreview(data);
    el.summary.hidden = false;
    el.destination.value = folder ? `${folder}/${data.formatDirectory}/` : data.formatDirectory || '(in memory)';
    alert('');
  }

  async function run() {
    if (state.busy) return;
    if (!state.capture) {
      alert('No capture file selected.');
      return;
    }
    state.busy = true;
    const label = el.convert.textContent;
    el.convert.disabled = true;
    el.convert.textContent = 'Converting…';
    alert('');
    try {
      const body = { capture: state.capture, format: state.format };
      const at = stampFromInputs(el.date.value, el.hh.value, el.mm.value, el.ss.value);
      if (at) body.at = at;
      const data = await api.post('/api/convert', body);
      if (!state.alive) return;
      renderResult(data);
      if (el.summary.scrollIntoView) el.summary.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (!state.alive) return;
      el.summary.hidden = true;
      alert(`Conversion failed: ${error.message}`);
    } finally {
      state.busy = false;
      el.convert.disabled = false;
      el.convert.textContent = label;
    }
  }

  function clear() {
    state.result = null;
    el.summary.hidden = true;
    el.destination.value = '(in memory)';
    alert('');
  }

  async function boot() {
    try {
      const data = await api.get('/api/captures');
      if (!state.alive) return;
      state.captures = data.captures ?? [];
      state.formats = data.formats ?? [];
      if (state.formats.length && !state.formats.some((item) => item.id === state.format)) {
        state.format = state.formats[0].id;
      }
      fillCaptures();
      renderFormats();
    } catch (error) {
      if (!state.alive) return;
      alert(`Capture list failed: ${error.message}`);
      el.sourceNote.textContent = '—';
    }
  }

  /* ---- events ---- */

  const onCapture = () => {
    state.capture = el.capture.value;
    renderCapture();
  };
  const onFormatsClick = (event) => {
    const entry = event.target.closest('.format-entry');
    if (!entry) return;
    selectFormat(entry.dataset.format);
  };
  const onFormatsKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const entry = event.target.closest('.format-entry');
    if (!entry) return;
    event.preventDefault();
    selectFormat(entry.dataset.format);
  };
  const onConvert = () => run();
  const onClear = () => clear();

  el.capture.addEventListener('change', onCapture);
  el.formats.addEventListener('click', onFormatsClick);
  el.formats.addEventListener('keydown', onFormatsKey);
  el.convert.addEventListener('click', onConvert);
  el.clear.addEventListener('click', onClear);

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || name === state.capture) return;
      state.capture = name;
      if (state.captures.some((item) => item.path === name)) el.capture.value = name;
      renderCapture();
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__convertCleanup = () => {
    state.alive = false;
    el.capture.removeEventListener('change', onCapture);
    el.formats.removeEventListener('click', onFormatsClick);
    el.formats.removeEventListener('keydown', onFormatsKey);
    el.convert.removeEventListener('click', onConvert);
    el.clear.removeEventListener('click', onClear);
    if (offCapture) offCapture();
  };

  boot();
}

export default { mount, unmount };
