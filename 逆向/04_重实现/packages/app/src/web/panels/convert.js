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
const LIVE_CSS_ID = 'nas-panel-convert-live-css';

/**
 * The shipped stylesheet greys out the blocks whose controls were `disabled` (`.unconverted-bytes-layout`
 * and `.prefix-suffix-options` carry `opacity: .5`, and the Prefix/Suffix tick uses the *disabled*
 * glyph, `view/css/style.css` S:22064). They are live here, so the panel lifts exactly those rules —
 * kept in the panel rather than in `convert.css` so the transcribed stylesheet stays a transcription.
 * The Prefix/Suffix pair still greys out while the text box is empty, which is what the suite does
 * (`convert.js:1552-1559`).
 */
const LIVE_CSS = `
.convertLayout .unconverted-bytes-layout { opacity: 1; }
.convertLayout .prefix-suffix-options { opacity: 1; }
.convertLayout .prefix-suffix-options.is-disabled { opacity: 0.5; }
.convertLayout .prefix-suffix-options .radio-input-container.is-selected .checkmark {
  background-image: url("/assets/images/btn_radio_selected.svg");
}
.convertLayout .format-settings-error {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 12px;
  font-family: var(--cv-sans);
  line-height: 16px;
  color: #b00020;
}
.convertLayout .destination-folder-path[readonly] { cursor: pointer; }
.convertLayout .common-sample-freq.error-border {
  border-bottom-color: #b00020;
  box-shadow: inset 0 -1px 0 #b00020;
  outline: none;
}
`;

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
  const live = document.createElement('style');
  live.id = LIVE_CSS_ID;
  live.textContent = LIVE_CSS;
  document.head.appendChild(live);
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

/* ---------------- Output Settings → /api/convert ---------------- */

/** The suite's own limits on the Prefix/Suffix box (`convert.html` `maxlength="18"`, `:1862-1873`). */
const AFFIX_MAX = 18;
const AFFIX_FORBIDDEN = /[\\/:*?"<>|]/;

/**
 * The five Output Settings controls, as the body `/api/convert` takes.
 *
 * Every rule below is the suite's, read off `01_解包/app/view/convert/convert.js`:
 *
 *  - **Sample Rate (Hz)** → `decimationFilter = 1 / rate` **seconds** (`:1922`), which is exactly
 *    what `--decimate` carries (`cli.js:220`, comment "sample rate in UI"). Empty — or a literal
 *    `0`, which the suite also treats as "off" (`:1922`) — means no thinning. The suite validates
 *    with `parseInt` against 0..999.99 (`:1852-1859`), so `0.5` passes its check *and* then divides
 *    by half; here the bounds are the same and the value is not truncated, and anything that is not
 *    a number in range is an error rather than a silent 0.
 *  - **Unknown Data** → `unconvertedBytes` `SEPARATEFILE` / `INTERLEAVE` (`:1547`, `:1923`), the
 *    native names of `--unknown-bytes=file|interleave` (`cli.js:161-164`).
 *  - **Destination** → `outputPath` (`:1924-1934`); "Source file folder" sends nothing at all, so the
 *    files never leave the run's memory and the browser only previews/downloads them.
 *  - **Prefix/Suffix** → `outputFileName = {valid, name, type}` (`:1937-1941`); the server turns
 *    `prefix`/`suffix` into the same object. Measured on the native: `abc` + `clean-9600` →
 *    `abcclean-9600.ASCII`, `SUFFIX` → `clean-9600abc.ASCII`.
 *  - **Time Interval** → `timeInterval = {startTime, endTime}` (`:1889-1893`), both ends; the page
 *    sends ISO instants and the server converts them to GPS week/seconds.
 *
 * Pure on purpose: `test/convert-gui.test.ts` drives it without a DOM.
 *
 * @returns `{ body, error }` — `error` is a sentence the panel shows as-is.
 */
export function outputSettings(fields = {}) {
  const body = {};

  const rateText = String(fields.sampleRate ?? '').trim();
  if (rateText !== '') {
    const rate = Number(rateText);
    if (!Number.isFinite(rate)) return { body: null, error: 'Sample Rate must be a number in Hz.' };
    if (rate < 0) return { body: null, error: 'Sample Rate cannot be negative.' };
    if (rate > 999.99) return { body: null, error: 'Sample Rate is at most 999.99 Hz.' };
    // The suite compares the box with `==` to 0 (`:1922`), so "0" disables thinning like "" does.
    if (rate !== 0) body.decimate = 1 / rate;
  }

  body.unknown = fields.unknown === 'INTERLEAVE' ? 'interleave' : 'separate';

  if (fields.destinationMode === 'SELECTED') {
    const destination = String(fields.destination ?? '').trim();
    if (!destination) {
      return { body: null, error: 'Destination: type an absolute folder, or choose “Source file folder”.' };
    }
    body.destination = destination;
  }

  const affix = String(fields.affixName ?? '').trim();
  if (affix !== '') {
    if (affix.length > AFFIX_MAX) return { body: null, error: `Prefix/Suffix is at most ${AFFIX_MAX} characters.` };
    if (AFFIX_FORBIDDEN.test(affix)) {
      return { body: null, error: 'Prefix/Suffix cannot contain \\ / : * ? " < > |' };
    }
    if (fields.affixType === 'SUFFIX') body.suffix = affix;
    else body.prefix = affix;
  }

  // Both ends of the Time Interval. The suite only sends the interval when the user edited it
  // (`isTimeIntervalEdited`, `:1889`), which is exactly "both fields parse".
  const start = fields.start instanceof Date && !Number.isNaN(fields.start.getTime()) ? fields.start : null;
  const finish = fields.finish instanceof Date && !Number.isNaN(fields.finish.getTime()) ? fields.finish : null;
  if (start && finish && finish.getTime() < start.getTime()) {
    return { body: null, error: 'End time is before the start time.' };
  }
  if (start) body.start = start.toISOString();
  if (finish) body.finish = finish.toISOString();

  return { body, error: null };
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
                  placeholder="Example: 100" inputmode="decimal" autocomplete="off">
                <span class="sampleRate-units">(Hz)</span>
              </div>
              <p class="format-settings-help">This will apply a single rate to all output files.</p>
              <p class="format-settings-error" data-el="rate-error" hidden></p>
            </div>

            <div class="unconverted-bytes-layout">
              <label class="format-settings-headings">Unknown Data</label>
              <div class="format-choice-row">
                <label class="radio-input-container is-selected" data-el="unknown-separate">
                  <input type="radio" name="cv-unknown" value="SEPARATE" checked>
                  <span class="checkmark"></span><label>Separate file</label>
                </label>
                <label class="radio-input-container" data-el="unknown-interleave">
                  <input type="radio" name="cv-unknown" value="INTERLEAVE">
                  <span class="checkmark"></span><label>Interleave</label>
                </label>
              </div>
              <p class="format-settings-help" data-el="unknown-help">This will separate the unknown bytes
                into a single separate file for each chosen output format.</p>
            </div>

            <div class="destination-selection-layout">
              <label class="format-settings-headings">Destination</label>
              <div class="format-choice-row">
                <label class="radio-input-container is-selected" data-el="dest-source">
                  <input type="radio" name="cv-dest" value="SOURCE" checked>
                  <span class="checkmark"></span><label>Source file folder</label>
                </label>
                <label class="radio-input-container" data-el="dest-selected">
                  <input type="radio" name="cv-dest" value="SELECTED">
                  <span class="checkmark"></span><label>Select folder</label>
                </label>
              </div>
              <input readonly class="destination-folder-path" data-el="destination"
                value="" spellcheck="false" aria-label="Output folder">
              <span class="browse-dest-folder" aria-hidden="true"></span>
              <p class="format-settings-help" data-el="dest-help">Files are written to this folder as
                &lt;folder&gt;\&lt;capture&gt;\Converted_On_&lt;stamp&gt;\&lt;format&gt;\.</p>
            </div>

            <div class="prefix-suffix-layout">
              <label class="format-settings-headings" for="cv-prefix">Prefix/Suffix (Optional)</label>
              <div class="prefix-text-field">
                <input type="text" class="prefix-suffix-value" id="cv-prefix" data-el="prefix"
                  placeholder="Example: my-gps" maxlength="18" autocomplete="off">
              </div>
              <p class="format-settings-help">This will be added to the output file name(s)</p>
              <div class="prefix-suffix-options is-disabled" data-el="affix-options">
                <label class="radio-input-container is-selected" data-el="affix-prefix">
                  <input type="radio" name="cv-affix" value="PREFIX" checked disabled>
                  <span class="checkmark"></span><label>Prefix</label>
                </label>
                <label class="radio-input-container" data-el="affix-suffix">
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
    /** the same root as an absolute path, for the Destination field */
    samplesAbsolute: '',
    groups: [],
    bytes: 0,
    /** name → ticked; every type is ticked when a capture loads (the suite's default). */
    selected: new Set(),
    /** Full span of the capture, so Reset can restore it. */
    span: null,
    /** The suite only sends the Time Interval once the user has edited it (`isTimeIntervalEdited`). */
    intervalEdited: false,
    /** id → ticked */
    formats: new Set(),
    /* ---- Output Settings ---- */
    /** Unknown Data: 'SEPARATE' (`.UNKNOWN` file) or 'INTERLEAVE' (spliced back in). */
    unknown: 'SEPARATE',
    /** Destination: 'SOURCE' keeps the bytes in memory, 'SELECTED' writes to `destPath`. */
    destMode: 'SOURCE',
    destPath: '',
    affixType: 'PREFIX',
    affixName: '',
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
   *  The suite shows an absolute path; `/api/captures` reports both the repo-relative samples root
   *  and its absolute path, so the field shows the real folder when the server knows it. */
  function folderText() {
    const capture = String(state.capture || '');
    const cut = Math.max(capture.lastIndexOf('/'), capture.lastIndexOf('\\'));
    const dir = cut >= 0 ? capture.slice(0, cut) : '';
    const root = state.samplesAbsolute || state.samples;
    return [root, dir].filter(Boolean).join('/').split('/').join('\\');
  }

  /* ---- Output Settings ---- */

  /** Both radio rows are plain `<input type=radio>`; the tick is a CSS class on the label. */
  function selectRadio(label, on) {
    label.classList.toggle('is-selected', on);
    const input = label.querySelector('input');
    if (input) input.checked = on;
  }

  function syncUnknown() {
    const interleave = state.unknown === 'INTERLEAVE';
    selectRadio(el.unknownSeparate, !interleave);
    selectRadio(el.unknownInterleave, interleave);
    // The suite swaps these two notes with the choice (`convert.js:1539-1546`); the interleave text
    // is the manual's (4.3.2.4).
    el.unknownHelp.textContent = interleave
      ? 'Information not recognized as a log is included in the file and labeled UNKNOWN.'
      : 'This will separate the unknown bytes into a single separate file for each chosen output format.';
  }

  function syncDestination() {
    const selected = state.destMode === 'SELECTED';
    selectRadio(el.destSource, !selected);
    selectRadio(el.destSelected, selected);
    el.destination.readOnly = !selected;
    el.destination.value = selected ? state.destPath : folderText();
    el.destination.title = el.destination.value;
    // The suite opens a folder picker here (`convert.js:1580-1599`); a web page has no picker, so
    // the field itself becomes the input and the note says where the files land.
    el.destHelp.textContent = selected
      ? 'Files are written to <folder>\\<capture>\\Converted_On_<stamp>\\<format>\\ (the suite layout).'
      : 'Files stay in memory: preview and download only. Choose “Select folder” to write them to disk.';
  }

  function syncAffix() {
    const empty = String(el.prefix.value ?? '').trim() === '';
    state.affixName = el.prefix.value;
    el.affixOptions.classList.toggle('is-disabled', empty);
    for (const label of [el.affixPrefix, el.affixSuffix]) {
      const input = label.querySelector('input');
      if (input) input.disabled = empty;
    }
    const suffix = state.affixType === 'SUFFIX';
    selectRadio(el.affixPrefix, !suffix);
    selectRadio(el.affixSuffix, suffix);
  }

  function showRateError(message) {
    el.rateError.hidden = !message;
    el.rateError.textContent = message || '';
    el.sampleRate.classList.toggle('error-border', Boolean(message));
    el.sampleRate.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function renderDestination() {
    syncDestination();
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
    // Reset restores the capture's own span and **withdraws** the interval: the suite clears
    // `isTimeIntervalEdited` here (`convert.js:1261`), and sending the prefilled span would drop the
    // records before the first observation (b2's leading `ALMANAC`).
    state.intervalEdited = false;
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

  /**
   * Where this run's files are: the folder actually written, or — when Destination is "Source file
   * folder", which keeps the bytes in memory — the folder the suites's layout *would* use
   * (`Converted_On_<stamp>/<FORMAT>/`, see `summary.ts`).
   */
  function outputFolderText(result) {
    if (result.directory) return result.directory;
    const folder = convertedOn(result.at);
    const dir = result.formatDirectory ?? '';
    return folder ? `${folder}\\${dir}\\` : `${dir}\\`;
  }

  function footRow(label, value) {
    return `<div class="result-foot"><span class="result-foot-label">${esc(label)}</span>` +
      `<span class="result-foot-value mono">${esc(value)}</span></div>`;
  }

  function renderResults() {
    if (!state.results.length) {
      el.summary.hidden = true;
      return;
    }
    const rows = state.results
      .map((result, index) => {
        const active = index === state.activeResult;
        const extra = (result.files?.length ?? 0) > 1 ? ' +' + (result.files.length - 1) : '';
        return (
          `<div class="result-row${active ? ' active' : ''}" data-result="${index}" tabindex="0" ` +
          `role="button" aria-pressed="${active ? 'true' : 'false'}" title="Show the preview of ${esc(
            result.fileName,
          )}">` +
          `<span class="result-format">${esc(result.label ?? result.format)}</span>` +
          `<span class="result-file mono">${esc(result.fileName)}${esc(extra)}</span>` +
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

    const active = state.results[state.activeResult] ?? state.results[0];
    const folders = state.results.map(outputFolderText);
    const folderValue = folders.every((folder) => folder === folders[0]) ? folders[0] : folders.join(' · ');
    const filesValue = (active.files ?? [{ fileName: active.fileName, bytes: active.bytes }])
      .map((file) => `${file.fileName} (${exactBytes(file.bytes)})`)
      .join(' · ');
    // `--unknown-bytes=file` / SEPARATE: the count is what the run could not attribute to a log,
    // and the name is the file it went into.
    const unknownValue = state.results
      .filter((result) => Number(result.unknownBytes) > 0)
      .map((result) => `${Number(result.unknownBytes).toLocaleString('en-US')} B`
        + (result.unknownFileName ? ` → ${result.unknownFileName}` : ' (not written: Interleave)'))
      .join(' · ');

    el.results.innerHTML =
      `<div class="result-table">${rows}</div>` +
      footRow('Output folder', folderValue) +
      footRow('Files', filesValue) +
      (unknownValue ? footRow('Unknown bytes', unknownValue) : '') +
      (active.directory
        ? ''
        : footRow('Saved', 'no — Destination is “Source file folder”; pick “Select folder” to write the files to disk'));
    el.summary.hidden = false;
    renderPreview();
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

    // The five Output Settings, exactly as the suite maps them (see `outputSettings`).
    const settings = outputSettings({
      sampleRate: el.sampleRate.value,
      unknown: state.unknown,
      destinationMode: state.destMode,
      destination: el.destination.value,
      affixType: state.affixType,
      affixName: el.prefix.value,
      // Time Interval is optional and, like the suite, only sent once it has been edited
      // (`isTimeIntervalEdited`, `convert.js:1889`). The prefilled span is the capture's first and
      // last record rounded **down** to the second, so sending it unedited would clip a last record
      // that sits between the whole second and the span's end (b2 ends at `577792.050`).
      start: state.intervalEdited ? startStamp() : null,
      finish: state.intervalEdited ? endStamp() : null,
    });
    if (settings.error) {
      showRateError(settings.error.startsWith('Sample Rate') ? settings.error : '');
      alert(settings.error);
      return;
    }
    showRateError('');

    state.busy = true;
    el.convert.disabled = true;
    el.convert.classList.add('customDisableButton');
    el.convert.textContent = 'Converting…';
    alert('');

    // `at` is the conversion timestamp (the `Converted_On_…` folder and the RINEX header date); the
    // panel has always used the interval's start, which keeps a run reproducible.
    const at = startStamp();
    const body = { capture: state.capture, ...settings.body };
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
    // The suite's `resetData` puts every Output Setting back to its default too
    // (`convert.js:987-994`: sample rate, unknown bytes, destination, prefix/suffix).
    state.unknown = 'SEPARATE';
    state.destMode = 'SOURCE';
    state.destPath = '';
    state.affixType = 'PREFIX';
    state.affixName = '';
    el.sampleRate.value = '';
    el.prefix.value = '';
    showRateError('');
    buildMessageList();
    buildFormats();
    syncUnknown();
    syncAffix();
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
      if (typeof roots.value.samplesAbsolute === 'string') state.samplesAbsolute = roots.value.samplesAbsolute;
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
        if (typeof data.samplesAbsolute === 'string') state.samplesAbsolute = data.samplesAbsolute;
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

  /** Any edit to the eight fields makes the Time Interval part of the request (suite: `:1250`). */
  const onIntervalInput = () => {
    state.intervalEdited = true;
    renderDuration();
  };

  /* ---- Output Settings ---- */

  /**
   * The pills are `<label>`s wrapping a hidden radio, and the visible text is itself a `<label>`
   * (the shipped markup does the same) — a click there does not reach the outer label's input, so
   * the choice is read off the click target instead of a `change` event. That is also how the suite
   * binds it (`$('.destination-selection-layout .list-inline li').on('click')`, `convert.js:1569`).
   */
  const onSettingsClick = (event) => {
    const container = event.target.closest('.radio-input-container');
    if (!container || !root.contains(container)) return;
    const input = container.querySelector('input');
    if (!input || input.disabled) return;
    if (input.name === 'cv-unknown') {
      state.unknown = input.value === 'INTERLEAVE' ? 'INTERLEAVE' : 'SEPARATE';
      syncUnknown();
    } else if (input.name === 'cv-dest') {
      state.destMode = input.value === 'SELECTED' ? 'SELECTED' : 'SOURCE';
      if (state.destMode === 'SELECTED' && !state.destPath) state.destPath = folderText();
      syncDestination();
      if (state.destMode === 'SELECTED') el.destination.focus();
    } else if (input.name === 'cv-affix') {
      state.affixType = input.value === 'SUFFIX' ? 'SUFFIX' : 'PREFIX';
      syncAffix();
    }
  };

  const onDestinationInput = () => {
    if (state.destMode !== 'SELECTED') return;
    state.destPath = el.destination.value;
  };

  const onAffixName = () => {
    syncAffix();
    // A stray rate error must not survive a corrected field.
    if (!el.rateError.hidden) showRateError('');
  };

  const onSampleRate = () => {
    if (!el.rateError.hidden) showRateError('');
  };

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
  el.stepFormat.addEventListener('click', onSettingsClick);
  el.destination.addEventListener('input', onDestinationInput);
  el.prefix.addEventListener('input', onAffixName);
  el.sampleRate.addEventListener('input', onSampleRate);

  const intervals = [el.startDate, el.startHh, el.startMm, el.startSs, el.endDate, el.endHh, el.endMm, el.endSs];
  for (const input of intervals) input.addEventListener('input', onIntervalInput);

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
    el.stepFormat.removeEventListener('click', onSettingsClick);
    el.destination.removeEventListener('input', onDestinationInput);
    el.prefix.removeEventListener('input', onAffixName);
    el.sampleRate.removeEventListener('input', onSampleRate);
    for (const input of intervals) input.removeEventListener('input', onIntervalInput);
    if (offCapture) offCapture();
  };

  buildFormats();
  buildMessageList();
  syncUnknown();
  syncAffix();
  resetInterval();
  setStep(1);
  boot();
}

export default { mount, unmount };
