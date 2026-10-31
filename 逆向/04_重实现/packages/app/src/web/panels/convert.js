/**
 * Convert panel — the suite's two-step wizard, transcribed from
 * `逆向/01_解包/app/view/convert/convert.html` (+ its CSS in `view/css/style.css`):
 *
 *   `.convertLayout` > `.convert-screens`
 *     `.selected-file-info` > `.sel-files-view.single-file-view`
 *     `.output-settings`    > `.output-title` · `.tabStyle` (1. Messages ▸ 2. Format)
 *                             + `.message-settings-tab`   (step 1: the log types)
 *                             + `.format-settings-tab`    (step 2: interval + 9 formats)
 *                             + `.btnsRow`                (Help · Start over · Next/Convert)
 *   `.convert-screens.convert-summary` — the results (+ the 200-line preview the suite
 *   does not have; it wrote files to a folder instead).
 *
 * Wire format: step 1 lists the message types of the selected capture from
 * `GET /api/logs?capture=…`, step 2's interval comes from `GET /api/playback/info?capture=…`,
 * and Convert posts `{capture, format}` to `/api/convert` once per ticked format.
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./convert.css', import.meta.url).href;
const CSS_ID = 'nas-panel-convert-css';

/**
 * The nine ticks of the original Format panel, in its DOM order (row-major, two columns):
 * left column ends up ASCII · Abbreviated ASCII · RINEX v2.1 · v3.02 · v3.04, right column
 * Binary · KML · v3.01 · v3.03 — exactly the reference screenshot.
 *
 * `wired: false` marks the four RINEX 3.0x variants the HTTP layer does not accept yet
 * (`packages/app/src/convert.ts` only declares five formats; `cli --to` has all nine).
 * They stay visible — the wizard is four rows of the original — but cannot be ticked,
 * so Convert never posts a format the server would answer with 400.
 */
const FORMAT_ROWS = [
  { id: 'ASCII', label: 'ASCII', wired: true },
  { id: 'BINARY', label: 'Binary', wired: true },
  { id: 'ABBREV_ASCII', label: 'Abbreviated ASCII', wired: true },
  { id: 'KML', label: 'KML - Google Earth', wired: true },
  { id: 'RINEX21', label: 'RINEX v2.1', wired: true },
  { id: 'RINEX301', label: 'RINEX v3.01', wired: true },
  { id: 'RINEX302', label: 'RINEX v3.02', wired: true },
  { id: 'RINEX303', label: 'RINEX v3.03', wired: true },
  { id: 'RINEX304', label: 'RINEX v3.04', wired: true },
];

const UNWIRED_NOTE = 'Not wired in this build';

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

/** The suite prints "264.52 KB"; keep two decimals and the space it uses. */
function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function exactBytes(bytes) {
  return `${(Number(bytes) || 0).toLocaleString('en-US')} B`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stampParts(date) {
  return {
    date: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    hh: pad2(date.getUTCHours()),
    mm: pad2(date.getUTCMinutes()),
    ss: pad2(date.getUTCSeconds()),
  };
}

/** Four inputs → UTC Date, or null when the fields are not a valid stamp. */
function readStamp(dateValue, hh, mm, ss) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || '').trim());
  if (!match) return null;
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  if (![h, m, s].every((n) => Number.isFinite(n))) return null;
  const asDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), h, m, s));
  if (Number.isNaN(asDate.getTime())) return null;
  if (asDate.getUTCHours() !== h || asDate.getUTCMinutes() !== m || asDate.getUTCSeconds() !== s) return null;
  return asDate;
}

/** `HH:MM:SS`, the format the suite prints next to "Duration:". */
function durationText(from, to) {
  if (!from || !to || to.getTime() < from.getTime()) return '--';
  let seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  const h = Math.floor(seconds / 3600);
  seconds -= h * 3600;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** The suite names its output directory `Converted_On_YYYYMMDD_THHMM` (see summary.ts). */
function convertedOn(iso) {
  const date = new Date(String(iso ?? ''));
  if (Number.isNaN(date.getTime())) return null;
  return (
    `Converted_On_${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `_T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`
  );
}

function baseName(path) {
  const text = String(path ?? '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut >= 0 ? text.slice(cut + 1) : text;
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
  <div class="notice" data-el="error" role="status" hidden></div>

  <div class="convert-screens convert-settings" data-el="settings">
    <div class="selected-file-info">
      <div class="sel-files-view single-file-view">
        <label class="single-file-msg">File ready to convert</label>
        <span class="file-pipe">|</span>
        <label class="file-label">Name:</label>
        <label class="single-file-name elidedText" data-el="capture-name">&mdash;</label>
        <span class="size-group">
          <label class="size-colon">Size:</label>
          <label class="single-file-size" data-el="capture-size">&mdash;</label>
        </span>
      </div>
    </div>

    <div class="output-settings">
      <label class="output-title">Output Settings</label>

      <div class="tabStyle">
        <span class="messageSettings active" data-el="pill-messages" aria-current="step">1. Messages</span>
        <span class="step-arrow" aria-hidden="true"></span>
        <span class="formatSettings" data-el="pill-format">2. Format</span>
      </div>

      <div class="message-settings-tab" data-el="step-messages">
        <div class="settings-header">
          <label class="msgs-label">Messages</label>
          <div class="all-files-selection">
            <label class="select-all-label">Select all messages</label>
            <button type="button" class="select-device-btn active-select-btn" data-el="select-all"
              data-role="msg-all" role="checkbox" aria-checked="true" aria-label="Select all messages"></button>
          </div>
        </div>
        <div class="all-files-messages-view" data-el="msg-list" role="group" aria-label="Message types"></div>
        <p class="messages-note" data-el="msg-note"></p>
      </div>

      <div class="format-settings-tab" data-el="step-format" hidden>
        <div class="single-file-time-interval">
          <label class="timeIntervalHeading">Time Interval (Optional)</label>
          <div class="utc-time-inputs">
            <div class="time-row">
              <label class="time-label" for="cv-start-date">Start Date/Time (UTC)</label>
              <div class="datetime-input-group">
                <input type="text" class="date-input" id="cv-start-date" data-el="start-date"
                  placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" aria-label="Start date (UTC)">
                <input type="number" class="time-input" data-el="start-hh" min="0" max="23"
                  placeholder="HH" aria-label="Start hour (UTC)">
                <span class="time-separator">:</span>
                <input type="number" class="time-input" data-el="start-mm" min="0" max="59"
                  placeholder="mm" aria-label="Start minute (UTC)">
                <span class="time-separator">:</span>
                <input type="number" class="time-input" data-el="start-ss" min="0" max="59"
                  placeholder="ss" aria-label="Start second (UTC)">
              </div>
            </div>
            <div class="time-row">
              <label class="time-label" for="cv-end-date">End Date/Time (UTC)</label>
              <div class="datetime-input-group">
                <input type="text" class="date-input" id="cv-end-date" data-el="end-date"
                  placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" aria-label="End date (UTC)">
                <input type="number" class="time-input" data-el="end-hh" min="0" max="23"
                  placeholder="HH" aria-label="End hour (UTC)">
                <span class="time-separator">:</span>
                <input type="number" class="time-input" data-el="end-mm" min="0" max="59"
                  placeholder="mm" aria-label="End minute (UTC)">
                <span class="time-separator">:</span>
                <input type="number" class="time-input" data-el="end-ss" min="0" max="59"
                  placeholder="ss" aria-label="End second (UTC)">
              </div>
            </div>
            <div class="duration-row">
              <span class="duration-label">Duration:</span>
              <span class="duration-value" data-el="duration">--</span>
              <button type="button" class="btn lightBtn resetTime" data-el="reset">Reset</button>
            </div>
          </div>
        </div>

        <div class="format-settings-layout">
          <div class="msg-format-selection">
            <label>Format</label>
            <div class="msg-format-list" data-el="formats" role="group" aria-label="Output format"></div>
          </div>

          <div class="format-gereral-settings">
            <div class="sample-rate-layout">
              <label class="format-settings-headings" for="cv-sample-rate">Sample Rate</label>
              <div class="common-sample-rate">
                <input type="text" class="common-sample-freq" id="cv-sample-rate" data-el="sample-rate"
                  placeholder="Example: 100" disabled>
                <span class="sampleRate-units">(Hz)</span>
              </div>
              <p class="format-settings-help">This will apply a single rate to all output files.</p>
            </div>

            <div class="unconverted-bytes-layout">
              <label class="format-settings-headings">Unknown Data</label>
              <div class="format-choice-row customDisableButton">
                <label class="radio-input-container is-selected">
                  <input type="radio" name="cv-unknown" value="SEPARATE" checked disabled>
                  <span class="checkmark"></span><label>Separate file</label>
                </label>
                <label class="radio-input-container is-disabled">
                  <input type="radio" name="cv-unknown" value="INTERLEAVE" disabled>
                  <span class="checkmark"></span><label>Interleave</label>
                </label>
              </div>
              <p class="format-settings-help">This will separate the unknown bytes into a single
                separate file for each chosen output format.</p>
            </div>

            <div class="destination-selection-layout">
              <label class="format-settings-headings">Destination</label>
              <div class="format-choice-row customDisableButton">
                <label class="radio-input-container is-selected">
                  <input type="radio" name="cv-dest" value="SOURCE" checked disabled>
                  <span class="checkmark"></span><label>Source file folder</label>
                </label>
                <label class="radio-input-container is-disabled">
                  <input type="radio" name="cv-dest" value="SELECTED" disabled>
                  <span class="checkmark"></span><label>Select folder</label>
                </label>
              </div>
              <input readonly class="destination-folder-path" data-el="destination"
                value="" spellcheck="false" aria-label="Capture folder">
              <span class="browse-dest-folder" aria-hidden="true"></span>
            </div>

            <div class="prefix-suffix-layout">
              <label class="format-settings-headings" for="cv-prefix">Prefix/Suffix (Optional)</label>
              <div class="prefix-text-field">
                <input type="text" class="prefix-suffix-value" id="cv-prefix" data-el="prefix"
                  placeholder="Example: my-gps" maxlength="18" disabled>
              </div>
              <p class="format-settings-help">This will be added to the output file name(s)</p>
              <div class="prefix-suffix-options customDisableButton">
                <label class="radio-input-container is-selected">
                  <input type="radio" name="cv-affix" value="PREFIX" checked disabled>
                  <span class="checkmark"></span><label>Prefix</label>
                </label>
                <label class="radio-input-container is-disabled">
                  <input type="radio" name="cv-affix" value="SUFFIX" disabled>
                  <span class="checkmark"></span><label>Suffix</label>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="btnsRow convert-actions">
        <div class="need-help"><span class="help-link">Help</span></div>
        <button type="button" class="lightBtn start-over-button" data-el="startover">Start over</button>
        <span class="actions-spacer"></span>
        <button type="button" class="lightBtn format-previous-button" data-el="previous" hidden>Previous</button>
        <button type="button" class="btn darkBtn message-settings-next" data-el="next">Next</button>
        <button type="button" class="btn darkBtn format-convert-button customDisableButton"
          data-el="convert" hidden disabled>Convert</button>
      </div>
    </div>
  </div>

  <div class="convert-screens convert-summary" data-el="summary" hidden>
    <div class="summary-container">
      <label class="conversion-heading">Conversion Results</label>
      <div class="conversion-summary-formats" data-el="results"></div>
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

  const state = {
    alive: true,
    step: 1,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    /** repo-relative samples root from `/api/captures` (what the Destination field shows) */
    samples: '',
    groups: [],
    bytes: 0,
    /** name → ticked; every type is ticked when a capture loads (the suite's default). */
    selected: new Set(),
    /** Full span of the capture, so Reset can restore it. */
    span: null,
    /** id → ticked */
    formats: new Set(),
    busy: false,
    results: [],
    activeResult: 0,
  };

  function alert(message, kind = 'error') {
    if (!message) {
      el.error.hidden = true;
      el.error.textContent = '';
      el.error.className = 'notice';
      return;
    }
    el.error.hidden = false;
    el.error.className = `notice ${kind}`;
    el.error.textContent = message;
  }

  /* ---- step chrome ---- */

  function setStep(step) {
    state.step = step;
    const first = step === 1;
    el.stepMessages.hidden = !first;
    el.stepFormat.hidden = first;
    el.pillMessages.classList.toggle('active', first);
    el.pillFormat.classList.toggle('active', !first);
    if (first) el.pillMessages.setAttribute('aria-current', 'step');
    else el.pillMessages.removeAttribute('aria-current');
    if (!first) el.pillFormat.setAttribute('aria-current', 'step');
    else el.pillFormat.removeAttribute('aria-current');
    el.next.hidden = !first;
    el.previous.hidden = first;
    el.convert.hidden = first;
    syncConvertButton();
  }

  function syncConvertButton() {
    const picks = wiredPicks();
    const blocked = state.busy || picks.length === 0 || !state.capture;
    el.convert.disabled = blocked;
    el.convert.classList.toggle('customDisableButton', blocked);
    if (!state.busy) el.convert.textContent = 'Convert';
  }

  function wiredPicks() {
    return FORMAT_ROWS.filter((row) => row.wired && state.formats.has(row.id));
  }

  /* ---- capture header ---- */

  /** `逆向\00_来源\samples\convert` — the folder the capture was read from.
   *  The suite shows an absolute path; this build only knows the repo-relative samples root
   *  that `/api/captures` reports, so the rows are joined with the platform separator. */
  function folderText() {
    const capture = String(state.capture || '');
    const cut = Math.max(capture.lastIndexOf('/'), capture.lastIndexOf('\\'));
    const dir = cut >= 0 ? capture.slice(0, cut) : '';
    return [state.samples, dir].filter(Boolean).join('/').split('/').join('\\');
  }

  function renderDestination() {
    const folder = folderText();
    el.destination.value = folder;
    el.destination.title = folder;
  }

  function renderCapture() {
    const name = state.capture ? baseName(state.capture) : '—';
    el.captureName.textContent = name;
    el.captureName.title = state.capture || '';
    el.captureSize.textContent = state.bytes ? bytesText(state.bytes) : '—';
    el.captureSize.title = state.bytes ? exactBytes(state.bytes) : '';
    renderDestination();
  }

  /* ---- step 1 ---- */

  function buildMessageList() {
    if (!state.groups.length) {
      el.msgList.innerHTML = '<div class="messages-empty">No message types in this capture.</div>';
      el.msgNote.textContent = '';
      el.next.disabled = true;
      return;
    }
    el.msgList.innerHTML = state.groups
      .map((group) => {
        const on = state.selected.has(group.name);
        const bad = group.crcFailed ? ` (${group.crcFailed} bad CRC)` : '';
        return (
          `<div class="log-entry" data-msg="${esc(group.name)}">` +
          '<div class="log-details">' +
          `<label title="${esc(group.name)} · id ${group.id}${esc(bad)}">${esc(group.name)}</label>` +
          '<div class="log-instances-messages">' +
          `<label class="log-instances">${group.count} instances</label>` +
          '</div>' +
          '</div>' +
          '<div class="log-selection-checkbox">' +
          `<button type="button" class="select-device-btn${on ? ' active-select-btn' : ''}" ` +
          `data-role="msg-toggle" data-msg="${esc(group.name)}" role="checkbox" ` +
          `aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(group.name)}"></button>` +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    el.next.disabled = state.groups.length === 0;
    syncSelectAll();
  }

  function syncSelectAll() {
    const total = state.groups.length;
    const on = state.groups.filter((group) => state.selected.has(group.name)).length;
    const all = total > 0 && on === total;
    el.selectAll.classList.toggle('active-select-btn', all);
    el.selectAll.classList.toggle('partial-select-btn', on > 0 && !all);
    el.selectAll.setAttribute('aria-checked', all ? 'true' : on > 0 ? 'mixed' : 'false');
    el.msgNote.textContent = total
      ? `${on} of ${total} types selected · the whole capture is converted; ticks are recorded only`
      : '';
  }

  function toggleMessage(name) {
    if (state.selected.has(name)) state.selected.delete(name);
    else state.selected.add(name);
    buildMessageList();
  }

  function toggleAllMessages() {
    const all = state.groups.length > 0 && state.groups.every((group) => state.selected.has(group.name));
    state.selected.clear();
    if (!all) for (const group of state.groups) state.selected.add(group.name);
    buildMessageList();
  }

  /* ---- step 2: interval ---- */

  function fillRow(which, date) {
    const parts = date ? stampParts(date) : { date: '', hh: '', mm: '', ss: '' };
    if (which === 'start') {
      el.startDate.value = parts.date;
      el.startHh.value = parts.hh;
      el.startMm.value = parts.mm;
      el.startSs.value = parts.ss;
    } else {
      el.endDate.value = parts.date;
      el.endHh.value = parts.hh;
      el.endMm.value = parts.mm;
      el.endSs.value = parts.ss;
    }
  }

  function startStamp() {
    return readStamp(el.startDate.value, el.startHh.value, el.startMm.value, el.startSs.value);
  }

  function endStamp() {
    return readStamp(el.endDate.value, el.endHh.value, el.endMm.value, el.endSs.value);
  }

  function renderDuration() {
    const from = startStamp();
    const to = endStamp();
    el.duration.textContent = durationText(from, to);
    el.duration.classList.toggle('invalid', Boolean(from && to && to.getTime() < from.getTime()));
  }

  function resetInterval() {
    if (!state.span) {
      fillRow('start', null);
      fillRow('end', null);
      renderDuration();
      return;
    }
    fillRow('start', state.span.start);
    fillRow('end', state.span.end);
    renderDuration();
  }

  /* ---- step 2: formats ---- */

  function buildFormats() {
    el.formats.innerHTML = FORMAT_ROWS.map((row) => {
      const on = row.wired && state.formats.has(row.id);
      const cls = row.wired ? '' : ' customDisableButton';
      const note = row.wired
        ? ''
        : `<p class="format-not-supported" title="${esc(
            'This build only accepts ASCII / BINARY / ABBREV_ASCII / KML / RINEX21 over HTTP; ' +
              'cli --to does support ' + row.id,
          )}">${UNWIRED_NOTE}</p>`;
      return (
        `<div class="format-entry${cls}" data-format="${esc(row.id)}">` +
        '<div class="format-details">' +
        `<label>${esc(row.label)}</label> ` +
        // S:21896 `.format-settings-icon` — decorative in this build (the suite opens a
        // per-format options popup there; the HTTP layer has nothing to configure).
        `<span class="format-settings-icon" aria-hidden="true" title="${esc(row.label)} options"></span>` +
        note +
        '</div>' +
        `<button type="button" class="select-device-btn${on ? ' active-select-btn' : ''}" ` +
        `data-role="format-toggle" data-format="${esc(row.id)}" role="checkbox" ` +
        `aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(row.label)}"` +
        `${row.wired ? '' : ' disabled'}></button>` +
        '</div>'
      );
    }).join('');
  }

  function toggleFormat(id) {
    const row = FORMAT_ROWS.find((item) => item.id === id);
    if (!row || !row.wired) return;
    // Keep the set in DOM order so multi-format runs post in the order the wizard lists.
    if (state.formats.has(id)) state.formats.delete(id);
    else state.formats.add(id);
    state.formats = new Set(FORMAT_ROWS.filter((item) => state.formats.has(item.id)).map((item) => item.id));
    buildFormats();
    syncConvertButton();
  }

  /* ---- results ---- */

  function resultPreview(result) {
    const body = result.text ?? result.preview ?? '';
    if (!body) return [];
    const lines = String(body).split(/\r\n|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(0, 200);
  }

  function renderPreview() {
    const result = state.results[state.activeResult];
    el.preview.innerHTML = '';
    el.previewNote.textContent = '';
    if (!result) return;
    const lines = resultPreview(result);
    if (!lines.length) {
      el.preview.innerHTML = '<div class="preview-empty">(empty artifact)</div>';
    } else {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        const row = document.createElement('div');
        row.className = 'preview-line';
        const number = document.createElement('span');
        number.className = 'ln';
        number.textContent = String(i + 1);
        const code = document.createElement('span');
        code.className = 'lc';
        code.textContent = lines[i];
        row.appendChild(number);
        row.appendChild(code);
        fragment.appendChild(row);
      }
      el.preview.appendChild(fragment);
    }
    el.previewNote.textContent = result.binary
      ? `hex dump, first ${lines.length} lines · ${exactBytes(result.bytes)}`
      : result.truncated
        ? `first ${result.shownLines} of ${result.lineTotal} lines — download for the rest`
        : `all ${result.lineTotal} lines · ${exactBytes(result.bytes)}`;
  }

  function renderResults() {
    if (!state.results.length) {
      el.summary.hidden = true;
      return;
    }
    const rows = state.results
      .map((result, index) => {
        const active = index === state.activeResult;
        return (
          `<div class="result-row${active ? ' active' : ''}" data-result="${index}" tabindex="0" ` +
          `role="button" aria-pressed="${active ? 'true' : 'false'}" title="Show the preview of ${esc(
            result.fileName,
          )}">` +
          `<span class="result-format">${esc(result.label ?? result.format)}</span>` +
          `<span class="result-file mono">${esc(result.fileName)}</span>` +
          `<span class="result-size">${exactBytes(result.bytes)} <span class="result-pretty">${esc(
            bytesText(result.bytes),
          )}</span></span>` +
          `<span class="result-lines">${Number(result.lineTotal || 0).toLocaleString('en-US')} ${
            result.binary ? 'hex lines' : 'lines'
          }</span>` +
          `<a class="btn darkBtn result-download" href="${esc(result.downloadUrl)}" ` +
          `download="${esc(result.fileName)}">Download</a>` +
          '</div>'
        );
      })
      .join('');
    const dirs = state.results
      .map((result) => {
        const folder = convertedOn(result.at);
        return `${esc(folder ? `${folder}/${result.formatDirectory}/` : result.formatDirectory)}`;
      })
      .join(' · ');
    el.results.innerHTML =
      `<div class="result-table">${rows}</div>` +
      `<div class="result-foot"><span class="result-foot-label">Output folder</span>` +
      `<span class="result-foot-value mono">${dirs}</span></div>`;
    el.summary.hidden = false;
    renderPreview();
  }

  function readStampOrNull(which) {
    return which === 'start' ? startStamp() : endStamp();
  }

  async function run() {
    if (state.busy) return;
    const picks = wiredPicks();
    if (!state.capture) {
      alert('No capture file selected.');
      return;
    }
    if (!picks.length) {
      alert('Tick at least one output format.');
      return;
    }

    state.busy = true;
    el.convert.disabled = true;
    el.convert.classList.add('customDisableButton');
    el.convert.textContent = 'Converting…';
    alert('');

    const at = readStampOrNull('start');
    const body = { capture: state.capture };
    if (at) body.at = at.toISOString();

    const done = [];
    try {
      for (const row of picks) {
        el.convert.textContent = `Converting ${row.label}…`;
        const data = await api.post('/api/convert', { ...body, format: row.id });
        if (!state.alive) return;
        done.push(data);
      }
      if (!state.alive) return;
      state.results = done;
      state.activeResult = 0;
      renderResults();
      if (el.summary.scrollIntoView) el.summary.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (!state.alive) return;
      state.results = done;
      renderResults();
      alert(`Conversion failed: ${error.message}`);
    } finally {
      state.busy = false;
      syncConvertButton();
    }
  }

  /* ---- start over ---- */

  function startOver() {
    state.formats.clear();
    state.selected = new Set(state.groups.map((group) => group.name));
    state.results = [];
    state.activeResult = 0;
    buildMessageList();
    buildFormats();
    resetInterval();
    el.summary.hidden = true;
    el.preview.innerHTML = '';
    renderDestination();
    alert('');
    setStep(1);
  }

  /* ---- boot ---- */

  async function loadCapture(capture) {
    alert('');
    el.captureName.textContent = '—';
    el.captureSize.textContent = '—';
    el.msgList.innerHTML = '<div class="messages-empty">Reading messages…</div>';
    el.msgNote.textContent = '';
    renderCapture();

    const [logs, info, roots] = await Promise.allSettled([
      api.get('/api/logs', { capture }),
      api.get('/api/playback/info', { capture }),
      // Only needed when the shell handed us a capture before boot() saw `/api/captures`.
      state.samples ? Promise.resolve(null) : api.get('/api/captures'),
    ]);
    if (!state.alive) return;

    if (roots.status === 'fulfilled' && roots.value && typeof roots.value.samples === 'string') {
      state.samples = roots.value.samples;
      renderDestination();
    }

    if (logs.status === 'fulfilled') {
      // The suite lists the types alphabetically (BESTPOS, HWMONITOR, PORTSTATS, …); `/api/logs`
      // hands them over busiest-first, which is Manage's order.
      state.groups = [...(logs.value.groups ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      state.bytes = Number(logs.value.bytes) || 0;
      state.selected = new Set(state.groups.map((group) => group.name));
      renderCapture();
      buildMessageList();
    } else {
      state.groups = [];
      state.bytes = 0;
      buildMessageList();
      alert(`Message list failed: ${logs.reason?.message ?? logs.reason}`);
    }

    if (info.status === 'fulfilled') {
      const start = new Date(String(info.value.startUtc ?? ''));
      const end = new Date(String(info.value.finishUtc ?? ''));
      state.span =
        Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
    } else {
      state.span = null;
    }
    resetInterval();
    syncConvertButton();
  }

  async function boot() {
    if (!state.capture) {
      try {
        const data = await api.get('/api/captures');
        if (!state.alive) return;
        if (typeof data.samples === 'string') state.samples = data.samples;
        const captures = data.captures ?? [];
        const preferred =
          captures.find((item) => item.path === 'convert/clean-9600.gps') ||
          captures.find((item) => item.name === 'clean-9600.gps') ||
          captures[0];
        if (preferred) state.capture = preferred.path;
      } catch (error) {
        if (!state.alive) return;
        alert(`Capture list failed: ${error.message}`);
        return;
      }
    }
    if (!state.capture) {
      alert('No capture under samples/.');
      buildMessageList();
      resetInterval();
      return;
    }
    await loadCapture(state.capture);
  }

  /* ---- events ---- */

  const onClick = (event) => {
    const toggle = event.target.closest('[data-role]');
    if (!toggle || !root.contains(toggle)) return;
    const role = toggle.dataset.role;
    if (role === 'msg-toggle') toggleMessage(toggle.dataset.msg);
    else if (role === 'msg-all') toggleAllMessages();
    else if (role === 'format-toggle') toggleFormat(toggle.dataset.format);
  };

  const onResultClick = (event) => {
    if (event.target.closest('.result-download')) return;
    const row = event.target.closest('[data-result]');
    if (!row) return;
    state.activeResult = Number(row.dataset.result) || 0;
    renderResults();
  };

  const onResultKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-result]');
    if (!row) return;
    event.preventDefault();
    state.activeResult = Number(row.dataset.result) || 0;
    renderResults();
  };

  const onNext = () => setStep(2);
  const onPrevious = () => setStep(1);
  const onReset = () => resetInterval();
  const onConvert = () => run();

  el.msgList.addEventListener('click', onClick);
  el.selectAll.addEventListener('click', toggleAllMessages);
  el.formats.addEventListener('click', onClick);
  el.next.addEventListener('click', onNext);
  el.previous.addEventListener('click', onPrevious);
  el.reset.addEventListener('click', onReset);
  el.convert.addEventListener('click', onConvert);
  el.startover.addEventListener('click', startOver);
  el.results.addEventListener('click', onResultClick);
  el.results.addEventListener('keydown', onResultKey);

  const intervals = [el.startDate, el.startHh, el.startMm, el.startSs, el.endDate, el.endHh, el.endMm, el.endSs];
  for (const input of intervals) input.addEventListener('input', renderDuration);

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || name === state.capture) return;
      state.capture = name;
      state.formats.clear();
      state.results = [];
      state.activeResult = 0;
      buildFormats();
      el.summary.hidden = true;
      setStep(1);
      void loadCapture(name);
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__convertCleanup = () => {
    state.alive = false;
    el.msgList.removeEventListener('click', onClick);
    el.selectAll.removeEventListener('click', toggleAllMessages);
    el.formats.removeEventListener('click', onClick);
    el.next.removeEventListener('click', onNext);
    el.previous.removeEventListener('click', onPrevious);
    el.reset.removeEventListener('click', onReset);
    el.convert.removeEventListener('click', onConvert);
    el.startover.removeEventListener('click', startOver);
    el.results.removeEventListener('click', onResultClick);
    el.results.removeEventListener('keydown', onResultKey);
    for (const input of intervals) input.removeEventListener('input', renderDuration);
    if (offCapture) offCapture();
  };

  buildFormats();
  buildMessageList();
  resetInterval();
  setStep(1);
  boot();
}

export default { mount, unmount };
