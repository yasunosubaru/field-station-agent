/**
 * Playback panel — the suite's status dashboard in **playback mode**.
 *
 * The original screen (screenshot: `ref-ui/playback-loaded.png`) is not a timeline page: it is the
 * Manage dashboard (`statusBar.html` + `positionStatus.html` + `deviceInfo.html` + `satelliteView.html`)
 * fed from a capture instead of a live receiver, with the transport collapsed into a floating
 * `Timeline ▲` bar at the bottom right (`view/playbackcontrol/playbackcontrol.html`).
 *
 * Rebuilt blocks, in the order the original stacks them:
 *
 *   1. app bar file tab      `#tabs-list` gains one tab per open capture (`clean-9600.gps ✕`);
 *                            closing it returns to the "Recent Activity" empty state
 *   2. status band           `.status-bar` (#E4E4E4, 112 px): Positioning [Good] | Device [Error]
 *   3. tab strip             the single `Positioning` page tab, 3 px #00516F underline (S:14554)
 *   4. two tiles             Positioning (8 fields) · Device (4 fields, one badge per row)
 *   5. Satellite View tile   legend + 8 constellation rows + polar sky plot
 *   6. Timeline dock         `Timeline ▲`, expands into the transport (scrub, play, speed,
 *                            current record, snippet export) — the old panel's whole body
 *
 * Where the numbers come from (all from the local JSON API, nothing invented):
 *   BESTPOS #42   first record  → Positioning card + left half of the band
 *   HWMONITOR #963 measurements → Device card + right half of the band (`(status >> 8) & 0xff`
 *                   is `HwMonitorStatusReadingType`, see `06_Graph应用.md` §… and
 *                   `01_Manage主界面与视图层.md`; 1 Temperature · 2 Antenna Current ·
 *                   6/8/15/17/21/23 supply rails · 7 Antenna Voltage · 22 Secondary Temperature)
 *   RANGE #43     `sv_prn` + `c_status >> 16 & 7` → constellation counts (`range-charts.ts`
 *                   uses the same three bits: 0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC)
 *
 * Deliberate differences from the original screen are listed in `逆向/03_分析/11_UI壳.md` §13.
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./playback.css', import.meta.url).href;
const CSS_ID = 'nas-panel-playback-css';

/** Message ids this page reads (SBF / EDIE). */
const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;

/** `system` = `(c_status >> 16) & 7` — same table as `packages/graph/src/range-charts.ts`. */
const SYSTEM_GPS = 0;
const SYSTEM_GLO = 1;
const SYSTEM_SBAS = 2;
const SYSTEM_GAL = 3;
const SYSTEM_BDS = 4;
const SYSTEM_QZSS = 5;
const SYSTEM_NAVIC = 6;

/**
 * Rows of the Satellite View tile, in the original's DOM order (`satelliteView.html:27-124`).
 * `system` is `null` for LBAND, which is a correction service rather than a constellation and
 * never appears in RANGE.
 */
const CONSTELLATIONS = [
  { key: 'gps', label: 'GPS', system: SYSTEM_GPS, icon: 'gps-legend' },
  { key: 'glo', label: 'GLO', system: SYSTEM_GLO, icon: 'glonass-legend' },
  { key: 'gal', label: 'GAL', system: SYSTEM_GAL, icon: 'galileo-legend' },
  { key: 'bds', label: 'BDS', system: SYSTEM_BDS, icon: 'bds-legend' },
  { key: 'qzss', label: 'QZSS', system: SYSTEM_QZSS, icon: 'qzss-legend' },
  { key: 'navic', label: 'NAVIC', system: SYSTEM_NAVIC, icon: 'navic-legend' },
  { key: 'lband', label: 'LBAND', system: null, icon: 'lband-legend' },
  { key: 'sbas', label: 'SBAS', system: SYSTEM_SBAS, icon: 'sbas-legend' },
];

/**
 * `HwMonitorStatusReadingType` → the row it feeds. The status word's high byte is the type,
 * its low byte is the boundary limit (`0 acceptable · 1 lower warning · 2 lower error ·
 * 3 upper warning · 4 upper error`), which is what the per-row badge reports.
 */
const HW_TYPES = {
  temperature: [1, 22],
  antennaCurrent: [2],
  antennaVoltage: [7],
  cpuUsage: [], // see the comment in `readDevice()` — the binary HWMONITOR has no idleTime
};

const TICK_COLORS = ['#00abc8', '#27a0bf', '#7fd3e8', '#f5a623', '#d0021b', '#9b9b9b', '#ffffff'];

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

function clockText(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

function utcClock(iso) {
  if (!iso) return '--:--:--';
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return match ? match[1] : String(iso);
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

/** `SOL_COMPUTED` stays as-is; `SINGLE` is printed title-case like the original ("Single"). */
function titleCase(text) {
  const value = String(text ?? '');
  if (!value) return '--';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function baseName(path) {
  const text = String(path ?? '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function shown(field) {
  if (!field) return null;
  const text = field.text;
  if (text === undefined || text === null || text === '') return String(field.value);
  return String(text);
}

/** `data-el="frame-body"` becomes `el.frameBody`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function kvRow(label, target, className) {
  return (
    '<div class="pb-kv-row">' +
    `<span class="pb-kv-label">${esc(label)}</span>` +
    `<span class="pb-kv-value ${className || ''}" data-el="${target}">--</span>` +
    '</div>'
  );
}

function deviceRow(label, valueTarget, badgeTarget) {
  return (
    '<div class="pb-device-row">' +
    `<span class="pb-kv-label">${esc(label)}</span>` +
    `<span class="pb-device-value" data-el="${valueTarget}">--</span>` +
    `<span class="pb-badge pb-badge-unknown" data-el="${badgeTarget}">--</span>` +
    '</div>'
  );
}

function satRow(item) {
  /* The six GNSS glyphs in `sats-sprite.png` already carry their own name under the shape; only
   * LBAND and SBAS are bare icons, so they get a text label (S:29712 `.lband-label`/`.sbas-label`). */
  const needsLabel = item.key === 'lband' || item.key === 'sbas';
  return (
    `<div class="sat-shape pb-sat-row" data-constellation="${item.key}">` +
    '<div class="constel-shape">' +
    `<span class="sat-legends ${item.icon} constellation-symbol" aria-hidden="true"></span>` +
    (needsLabel ? `<span class="pb-sat-name">${esc(item.label)}</span>` : '') +
    '</div>' +
    '<div class="shape-detail"><div class="constellation-value">' +
    `<div class="good-health" data-sat="${item.key}-use" title="In Use — distinct PRNs in the RANGE epoch at the play head">0</div>` +
    `<div class="moderate-health" data-sat="${item.key}-idle" title="Not Used — PRNs this playback has seen but that are not in the current epoch">0</div>` +
    '<div class="outer-div">' +
    `<div class="bad-health" data-sat="${item.key}-missing" title="Missing — needs SATVIS2 (absent from this capture), so it cannot be computed">0</div>` +
    '</div>' +
    '</div></div>' +
    '</div>'
  );
}

/** Ring + cross + labels; drawn once, the constellation dots are added per epoch. */
function skySvg() {
  const size = 300;
  const c = size / 2;
  const parts = [
    `<svg class="pb-sky-svg" viewBox="0 0 ${size} ${size}" role="img" ` +
      'aria-label="Polar sky plot: horizon, 30 and 60 degree elevation rings, no azimuth/elevation data in this capture">',
    `<circle class="pb-sky-disc" cx="${c}" cy="${c}" r="148"/>`,
    `<circle class="pb-sky-ring" cx="${c}" cy="${c}" r="98"/>`,
    `<circle class="pb-sky-ring pb-sky-ring-inner" cx="${c}" cy="${c}" r="74"/>`,
    `<line class="pb-sky-axis" x1="2" y1="${c}" x2="${size - 2}" y2="${c}"/>`,
    `<line class="pb-sky-axis" x1="${c}" y1="2" x2="${c}" y2="${size - 2}"/>`,
    `<text class="pb-sky-dir" x="${c + 6}" y="14">N</text>`,
    `<text class="pb-sky-dir" x="${size - 14}" y="${c + 5}">E</text>`,
    `<text class="pb-sky-dir" x="4" y="${c + 5}">W</text>`,
    `<text class="pb-sky-dir" x="${c + 6}" y="${size - 5}">S</text>`,
    `<text class="pb-sky-deg" x="${c + 6}" y="${c - 94}">30&deg;</text>`,
    `<text class="pb-sky-deg" x="${c + 6}" y="${c - 70}">60&deg;</text>`,
    '<g class="pb-sky-sats"></g>',
    '</svg>',
  ];
  return parts.join('');
}

function template(speedOptions) {
  return `
<div class="notice pb-notice" data-el="error" role="status" hidden></div>

<div class="pb-empty-state" data-el="empty" hidden>
  <div class="pb-empty-head">
    <span class="pb-empty-title">Recent Activity</span>
    <button type="button" class="pb-open-btn" data-el="open">Open Playback File</button>
  </div>
  <p class="pb-empty-note">No recent activity.</p>
</div>

<div class="pb-loaded" data-el="loaded" hidden>

  <!-- 原版加载后的状态在应用栏与状态带之间有一条满宽纯黑带（ref-ui/playback-150.png 实测：
       物理 y=139..213，75 物理 = 50 CSS 高，纯黑 #000），空态没有。来源未查明（不是
       statusBar.html 的灰条，style.css 里也没有对应的黑色背景规则），这里按实测高度与颜色
       复刻；带右端是通知铃铛 + 青色计数徽标（原版 .event-notifications-on，style.css:29581）。 -->
  <div class="pb-eventbar" aria-hidden="true">
    <span class="pb-bell"></span>
    <span class="pb-bell-count">0</span>
  </div>

  <div class="pb-bandwrap">
    <div class="pb-band">
      <div class="pb-band-half">
        <div class="pb-band-head">
          <span class="pb-band-title">Positioning</span>
          <span class="pb-badge pb-badge-good" data-el="posBadge">Good</span>
        </div>
        <div class="pb-band-fields">
          <div class="pb-band-row pb-band-r1c1">
            <span class="pb-band-label">Position</span>
            <span class="pb-band-value pb-underlined" data-el="bandPosition">--</span>
          </div>
          <div class="pb-band-row pb-band-r2c1">
            <span class="pb-band-label">Latitude</span>
            <span class="pb-band-value" data-el="bandLat">--</span>
          </div>
          <div class="pb-band-row pb-band-r3c1">
            <span class="pb-band-label">Longitude</span>
            <span class="pb-band-value" data-el="bandLon">--</span>
          </div>
          <div class="pb-band-row pb-band-r2c2">
            <span class="pb-band-label">Height (MSL)</span>
            <span class="pb-band-value" data-el="bandHeight">--</span>
          </div>
        </div>
      </div>

      <div class="pb-band-split" aria-hidden="true"></div>

      <div class="pb-band-half">
        <div class="pb-band-head">
          <span class="pb-band-title">Device</span>
          <span class="pb-badge pb-badge-bad" data-el="devBadge">Error</span>
        </div>
        <div class="pb-band-fields pb-band-fields-device">
          <div class="pb-band-row pb-band-r1c1">
            <span class="pb-band-label">Model</span>
            <span class="pb-band-value" data-el="devModel">--</span>
          </div>
          <div class="pb-band-row pb-band-r2c1">
            <span class="pb-band-label">CPU Usage</span>
            <span class="pb-band-value" data-el="devCpu">--</span>
          </div>
          <div class="pb-band-row pb-band-r3c1">
            <span class="pb-band-label">Logging</span>
            <span class="pb-band-value" data-el="devLogging">--</span>
          </div>
          <div class="pb-band-row pb-band-r1c2">
            <span class="pb-band-label">Time (UTC)</span>
            <span class="pb-band-value" data-el="devTime">--</span>
          </div>
          <div class="pb-band-row pb-band-r2c2">
            <span class="pb-band-label">Interference</span>
            <span class="pb-band-value" data-el="devInterference">--</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="pb-page">
    <div class="pb-tabstrip" role="tablist" aria-label="Status pages">
      <button type="button" class="pb-tab active-tab" role="tab" aria-selected="true">Positioning</button>
    </div>

    <div class="pb-cards">
      <section class="tile pb-card">
        <div class="pb-card-head">
          <h2 class="heading">Positioning</h2>
          <span class="pb-badge pb-badge-good" data-el="cardPosBadge">Good</span>
        </div>
        <div class="pb-kv">
          ${kvRow('Operating Mode', 'posMode')}
          ${kvRow('Position', 'posPosition', 'pb-underlined')}
          ${kvRow('Latitude', 'posLat')}
          ${kvRow('Longitude', 'posLon')}
          ${kvRow('Height (MSL)', 'posHeight')}
          ${kvRow('Height Accuracy', 'posHeightAcc')}
          ${kvRow('2d-SD', 'pos2d')}
          ${kvRow('Datum', 'posDatum')}
        </div>
        <div class="need-help">
          <a href="#" data-el="helpPosition" title="Where these numbers come from">Help</a>
        </div>
      </section>

      <section class="tile pb-card">
        <div class="pb-card-head">
          <h2 class="heading">Device</h2>
        </div>
        <div class="pb-kv pb-device-list">
          ${deviceRow('CPU Usage', 'devCpuRow', 'devCpuRowBadge')}
          ${deviceRow('Temperature', 'devTemp', 'devTempBadge')}
          ${deviceRow('Antenna Voltage', 'devVoltage', 'devVoltageBadge')}
          ${deviceRow('Antenna Current', 'devCurrent', 'devCurrentBadge')}
        </div>
        <div class="need-help">
          <a href="#" data-el="helpDevice" title="Where these numbers come from">Help</a>
        </div>
      </section>
    </div>

    <section class="tile pb-card pb-sat" id="SatelliteViewPanel">
      <div class="pb-card-head">
        <h2 class="heading">Satellite View</h2>
        <span class="pb-badge pb-badge-unknown" data-el="satBadge">--</span>
      </div>
      <div class="pb-sat-body">
        <div class="pb-sat-left">
          <div class="satelliteview-legend">
            <div class="tracked-legends">
              <p>Tracked</p>
              <div>
                <div class="inuse">In Use</div>
                <div class="notused">Not Used</div>
              </div>
            </div>
            <div class="missing-label">Missing</div>
          </div>
          <div class="shapes">${CONSTELLATIONS.map(satRow).join('')}</div>
          <p class="pb-sat-note" data-el="satNote">Counting RANGE (#43) observations at the play head.</p>
        </div>
        <div class="pb-sat-right" data-el="sky">${skySvg()}</div>
      </div>
      <div class="need-help">
        <a href="#" data-el="helpSatellite" title="Where these numbers come from">Help</a>
      </div>
    </section>
  </div>
</div>

<div class="pb-dock" data-el="dock" hidden>
  <div class="pb-drawer" data-el="drawer" id="pb-drawer" hidden>
    <div class="pb-progress" data-el="bar" role="slider" tabindex="0"
         aria-label="Playback position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
      <div class="pb-fill" data-el="fill"><span class="pb-scrub" data-el="scrub"></span></div>
      <div class="pb-snippet" data-el="snippet" hidden></div>
      <div class="pb-ticks" data-el="ticks"></div>
    </div>

    <div class="pb-transport">
      <div class="pb-transport-left">
        <span class="pb-label">Start</span>
        <span class="pb-strong" data-el="start">--:--:--</span>
        <span class="pb-label pb-label-gap">End</span>
        <span class="pb-strong" data-el="end">--:--:--</span>
      </div>
      <div class="pb-transport-middle">
        <button class="pb-rewind" type="button" data-el="rewind" aria-label="Back 30 seconds"></button>
        <button class="pb-play" type="button" data-el="play" aria-label="Play"></button>
        <span class="pb-clock">
          <span data-el="clock">0:00.000</span><span class="pb-clock-sep"> | </span><span data-el="duration">0:00.000</span>
        </span>
      </div>
      <div class="pb-transport-right">
        <label class="pb-label" for="pb-speed">Speed</label>
        <select class="pb-speed" id="pb-speed" data-el="speed" aria-label="Playback speed">${speedOptions}</select>
        <button class="pb-action" type="button" data-el="snippetBtn">Create Snippet</button>
      </div>
    </div>

    <div class="pb-export">
      <label class="pb-field"><span>From (s)</span>
        <input type="number" data-el="from" min="0" step="0.001" value="0">
      </label>
      <label class="pb-field"><span>To (s)</span>
        <input type="number" data-el="to" min="0" step="0.001" value="0">
      </label>
      <button class="pb-action" type="button" data-el="download" disabled>Download SBF</button>
      <span class="pb-export-note" data-el="snippetNote">Load a timeline first.</span>
    </div>

    <div class="pb-record">
      <span class="pb-record-name" data-el="frameName">--</span>
      <span class="pb-record-note" data-el="frameNote"></span>
      <button class="pb-action pb-action-small" type="button" data-el="frameToggle"
              aria-expanded="false" aria-controls="pb-frame-body">Fields</button>
    </div>
    <div class="pb-fields" id="pb-frame-body" data-el="frameBody" hidden></div>
  </div>

  <button class="pb-dock-btn" type="button" data-el="dockToggle" aria-expanded="false" aria-controls="pb-drawer">
    <span>Timeline</span><span class="pb-caret" aria-hidden="true"></span>
  </button>
</div>

<div class="pb-open-dialog" data-el="dialog" hidden>
  <div class="pb-open-panel" role="dialog" aria-modal="true" aria-label="Open playback file">
    <div class="pb-open-head">
      <span>Open Playback File</span>
      <button type="button" class="pb-open-close" data-el="dialogClose" aria-label="Close">&times;</button>
    </div>
    <p class="pb-open-note" data-el="dialogNote">Reading the capture list…</p>
    <div class="pb-open-list" data-el="openList"></div>
  </div>
</div>`;
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__playbackCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__playbackCleanup = null;
}

export function mount(root, ctx = {}) {
  unmount(root);
  ensureCss();

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();
  const speeds = [0.5, 1, 2, 4, 8];

  root.classList.add('playback-panel');
  root.innerHTML = template(speeds.map((value) => `<option value="${value}">${value}×</option>`).join(''));
  const el = collect(root);

  /** `gps-use` / `gps-idle` / `gps-missing` → the three count boxes of every constellation row. */
  const satCount = {};
  for (const node of root.querySelectorAll('[data-sat]')) {
    satCount[node.dataset.sat] = node;
  }

  /* The file tab lives in the shell's app bar (index.html #tabs-list). Injecting it from here keeps
   * the bar exactly as the original has it — "Playback" then the open file — without editing the
   * shell. It is removed again in the cleanup below, and CSS hides it on every other page. */
  const appBar = document.getElementById('tabs-list');
  const fileTabs = appBar ? document.createElement('li') : null;
  if (fileTabs) {
    fileTabs.className = 'pb-filetabs';
    fileTabs.setAttribute('role', 'presentation');
    appBar.appendChild(fileTabs);
  }

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    open: false,

    info: null,
    frames: [],
    duration: 0,
    time: 0,
    speed: 1,
    playing: false,
    raf: 0,
    last: 0,

    /** frame index → RANGE record ordinal (-1 when that frame is not a RANGE record). */
    rangeOrdinal: [],
    /** RANGE ordinal → { counts: Map(system → Set(prn)), utc }. */
    epochs: new Map(),
    /** system → Set(prn) seen in every epoch this playback has shown (drives "Not Used"). */
    seen: new Map(),
    epochOrdinal: -2,
    epochPending: false,
    epochWanted: -2,

    detailIndex: -1,
    detailPending: false,
    pendingDetail: null,

    from: 0,
    to: 0,
  };

  function alert(message, kind = 'error') {
    if (!message) {
      el.error.hidden = true;
      el.error.textContent = '';
      el.error.className = 'notice pb-notice';
      return;
    }
    el.error.hidden = false;
    el.error.className = `notice pb-notice ${kind}`;
    el.error.textContent = message;
  }

  /* ---- app-bar file tab + empty state ---- */

  function renderFileTabs() {
    if (!fileTabs) return;
    if (!state.open) {
      fileTabs.innerHTML = '';
      fileTabs.hidden = true;
      return;
    }
    fileTabs.hidden = false;
    fileTabs.innerHTML =
      '<span class="pb-filetab-name" title="' + esc(state.capture) + '">' + esc(baseName(state.capture)) + '</span>' +
      '<button type="button" class="pb-filetab-close" data-role="close-file" ' +
      'aria-label="Close ' + esc(baseName(state.capture)) + '">&times;</button>';
  }

  function renderShell() {
    el.loaded.hidden = !state.open;
    el.empty.hidden = state.open;
    el.dock.hidden = !state.open;
    renderFileTabs();
  }

  /* ---- capture list / open dialog ---- */

  function fillCaptures() {
    if (!state.captures.length) {
      el.dialogNote.textContent = 'No capture under samples/.';
      el.openList.innerHTML = '<p class="pb-open-empty">Nothing to open.</p>';
      return;
    }
    el.dialogNote.textContent = `${state.captures.length} captures under samples/ · read-only`;
    el.openList.innerHTML = state.captures
      .map(
        (item) =>
          '<button type="button" class="pb-open-item" data-role="open-capture" data-path="' + esc(item.path) + '">' +
          '<span class="pb-open-name">' + esc(item.name) + '</span>' +
          '<span class="pb-open-meta">' + esc(item.path) + ' · ' + bytesText(item.bytes) + '</span>' +
          '</button>',
      )
      .join('');
  }

  function openDialog() {
    el.dialog.hidden = false;
    el.dialogClose.focus();
  }

  function closeDialog() {
    el.dialog.hidden = true;
  }

  /** Keeps the shell's capture picker (and every other panel) in step with our file tab. */
  function syncShellCapture(path) {
    const select = document.getElementById('capture-select');
    if (!select || select.value === path) return;
    select.value = path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---- Positioning (first BESTPOS #42) ---- */

  function readPosition(record) {
    if (!record) return null;
    const fields = new Map();
    for (const field of record.fields) if (!fields.has(field.path)) fields.set(field.path, field);
    const get = (path) => fields.get(path);
    const lat = Number(get('latitude')?.value);
    const lon = Number(get('longitude')?.value);
    const latDev = Number(get('latitude_std_dev')?.value);
    const lonDev = Number(get('longitude_std_dev')?.value);
    return {
      mode: shown(get('solution_status')),
      position: shown(get('position_type')),
      latitude: lat,
      longitude: lon,
      height: Number(get('orthometric_height')?.value),
      heightDev: Number(get('height_std_dev')?.value),
      twoSigma:
        Number.isFinite(latDev) && Number.isFinite(lonDev) ? Math.sqrt(latDev * latDev + lonDev * lonDev) : NaN,
      datum: shown(get('datum_id')),
      solved: shown(get('solution_status')) === 'SOL_COMPUTED',
    };
  }

  function renderPosition() {
    const p = state.position;
    const band = (node, text) => {
      if (node) node.textContent = text;
    };
    if (!p) {
      band(el.bandPosition, '--');
      band(el.bandLat, '--');
      band(el.bandLon, '--');
      band(el.bandHeight, '--');
      band(el.posMode, '--');
      band(el.posPosition, '--');
      band(el.posLat, '--');
      band(el.posLon, '--');
      band(el.posHeight, '--');
      band(el.posHeightAcc, '--');
      band(el.pos2d, '--');
      band(el.posDatum, '--');
      setBadge(el.posBadge, 'warn');
      setBadge(el.cardPosBadge, 'warn');
      return;
    }
    const position = p.position ? titleCase(p.position) : '--';
    const lat = `${fixed(p.latitude, 7)}°`;
    const lon = `${fixed(p.longitude, 7)}°`;
    const height = `${fixed(p.height, 2)} m`;

    band(el.bandPosition, position);
    band(el.bandLat, lat);
    band(el.bandLon, lon);
    band(el.bandHeight, height);

    band(el.posMode, p.mode ?? '--');
    band(el.posPosition, position);
    band(el.posLat, lat);
    band(el.posLon, lon);
    band(el.posHeight, height);
    band(el.posHeightAcc, `${fixed(p.heightDev, 2)} m`);
    band(el.pos2d, `${fixed(p.twoSigma, 2)} m`);
    band(el.posDatum, p.datum ?? '--');

    setBadge(el.posBadge, p.solved ? 'good' : 'warn');
    setBadge(el.cardPosBadge, p.solved ? 'good' : 'warn');
  }

  /* ---- Device (HWMONITOR #963) ---- */

  /**
   * Binary HWMONITOR in this build carries `measurements.count` + `measurements[10]` only
   * (84 byte payload, see `09_EDIE消息字典与ASCII一致性.md`), i.e. the `idleTime` field the GRIT
   * status bar turns into "CPU Usage" (`100 − raw/2`, `05_GRIT-Monitor.md` §5.6) is not in it.
   * The original screenshot shows 29 % because it had that field; we print `--` instead of
   * inventing a percentage from one of the supply rails.
   */
  function readDevice(record) {
    if (!record) return null;
    const values = new Map();
    const limits = new Map();
    for (const field of record.fields) {
      const match = /^measurements\[(\d+)\]\.(value|status)$/.exec(field.path);
      if (!match) continue;
      const index = Number(match[1]);
      if (!values.has(index)) values.set(index, {});
      values.get(index)[match[2]] = field.value;
    }
    const byType = new Map();
    for (const entry of values.values()) {
      const status = Number(entry.status) || 0;
      const type = (status >> 8) & 0xff;
      if (!byType.has(type)) byType.set(type, { value: Number(entry.value), limit: status & 0xff });
    }
    const pick = (types) => {
      for (const type of types) if (byType.has(type)) return byType.get(type);
      return null;
    };
    return {
      temperature: pick(HW_TYPES.temperature),
      antennaCurrent: pick(HW_TYPES.antennaCurrent),
      antennaVoltage: pick(HW_TYPES.antennaVoltage),
      cpuUsage: pick(HW_TYPES.cpuUsage),
      types: [...byType.keys()],
    };
  }

  function setBadge(node, tone, text) {
    if (!node) return;
    const labels = { good: 'Good', warn: 'Warning', bad: 'Error', unknown: '--' };
    node.className = `pb-badge pb-badge-${tone}`;
    node.textContent = text ?? labels[tone] ?? '--';
    node.dataset.tone = tone;
  }

  /** Sensor row badge: the receiver's own boundary limit wins when it flagged something. */
  function sensorTone(reading) {
    if (!reading) return 'unknown';
    const limit = reading.limit;
    if (limit === 0) return 'good';
    if (limit === 1 || limit === 3) return 'warn';
    return 'bad';
  }

  function renderDevice() {
    const d = state.device;
    const set = (node, text) => {
      if (node) node.textContent = text;
    };
    const temp = d?.temperature ? `${fixed(d.temperature.value, 2)} °C` : '--';
    const volt = d?.antennaVoltage ? `${fixed(d.antennaVoltage.value, 2)} V` : '--';
    const amp = d?.antennaCurrent ? `${fixed(d.antennaCurrent.value, 2)} A` : '--';
    const cpu = d?.cpuUsage ? `${fixed(d.cpuUsage.value, 0)} %` : '--';

    set(el.devTemp, temp);
    set(el.devVoltage, volt);
    set(el.devCurrent, amp);
    set(el.devCpuRow, cpu);

    setBadge(el.devTempBadge, sensorTone(d?.temperature));
    setBadge(el.devVoltageBadge, sensorTone(d?.antennaVoltage));
    setBadge(el.devCurrentBadge, sensorTone(d?.antennaCurrent));
    setBadge(el.devCpuRowBadge, d?.cpuUsage ? sensorTone(d.cpuUsage) : 'unknown');

    // Band right half: only the values the device card already decoded, plus the unknowns.
    set(el.devModel, '--'); // needs VERSION (#37); not in this capture
    set(el.devCpu, cpu);
    set(el.devLogging, '--'); // needs FILESTATUS (#2127) / LOGLIST (#5)
    set(el.devInterference, '--'); // needs ITDETECTSTATUS (#2065)

    // The original band is red whenever the device picture is incomplete; ours follows the data.
    const incomplete = !d || !d.cpuUsage || !d.temperature || !d.antennaVoltage || !d.antennaCurrent;
    setBadge(el.devBadge, incomplete ? 'bad' : 'good');
  }

  /* ---- Satellite View (RANGE #43) ---- */

  function buildRangeMap() {
    const map = new Array(state.frames.length).fill(-1);
    let ordinal = 0;
    for (let i = 0; i < state.frames.length; i++) {
      if (state.frames[i].messageId === RANGE) {
        map[i] = ordinal;
        ordinal += 1;
      }
    }
    state.rangeOrdinal = map;
    return ordinal;
  }

  function parseEpoch(record) {
    const obs = new Map();
    for (const field of record.fields) {
      const match = /^obs\[(\d+)\]\.(sv_prn|c_status)$/.exec(field.path);
      if (!match) continue;
      const index = Number(match[1]);
      if (!obs.has(index)) obs.set(index, {});
      obs.get(index)[match[2]] = field.value;
    }
    const counts = new Map();
    for (const entry of obs.values()) {
      const system = (Number(entry.c_status) >> 16) & 7;
      if (!counts.has(system)) counts.set(system, new Set());
      counts.get(system).add(Number(entry.sv_prn));
    }
    return { counts, utc: record.header?.utc ?? '', observed: obs.size };
  }

  function renderSatellite() {
    const epoch = state.epochs.get(state.epochOrdinal) ?? null;
    let total = 0;
    for (const item of CONSTELLATIONS) {
      const inUse = item.system === null ? 0 : epoch ? (epoch.counts.get(item.system)?.size ?? 0) : 0;
      const seen = item.system === null ? 0 : (state.seen.get(item.system)?.size ?? 0);
      const notUsed = Math.max(0, seen - inUse);
      total += inUse;
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (useNode) useNode.textContent = String(inUse);
      if (idleNode) idleNode.textContent = String(notUsed);
      if (missNode) missNode.textContent = '0';
    }

    if (!state.info) {
      setBadge(el.satBadge, 'unknown');
    } else if (epoch) {
      setBadge(el.satBadge, total > 0 ? 'good' : 'warn');
    } else {
      setBadge(el.satBadge, 'warn');
    }

    const when = epoch && epoch.utc ? utcClock(epoch.utc) : '--:--:--';
    el.satNote.textContent = state.info
      ? `RANGE (#43) epoch ${when} UTC · ${total} tracked PRNs · ` +
        `${epoch ? 'In Use = PRNs in this epoch, Not Used = seen earlier in this capture' : 'no RANGE record yet'}` +
        ' · Missing needs SATVIS2 (absent in this capture)'
      : 'Counting RANGE (#43) observations at the play head.';
  }

  function requestEpoch(ordinal) {
    if (ordinal < 0) {
      state.epochOrdinal = -2;
      renderSatellite();
      return;
    }
    if (state.epochs.has(ordinal)) {
      state.epochOrdinal = ordinal;
      renderSatellite();
      return;
    }
    if (state.epochPending) {
      state.epochWanted = ordinal;
      return;
    }
    state.epochPending = true;
    const wanted = state.capture;
    api
      .get('/api/records', { capture: state.capture, msgId: RANGE, offset: ordinal, limit: 1 })
      .then((data) => {
        if (!state.alive || state.capture !== wanted) return;
        const record = data.records && data.records[0];
        if (record) {
          const parsed = parseEpoch(record);
          state.epochs.set(ordinal, parsed);
          for (const [system, prns] of parsed.counts) {
            if (!state.seen.has(system)) state.seen.set(system, new Set());
            for (const prn of prns) state.seen.get(system).add(prn);
          }
          while (state.epochs.size > 40) {
            const oldest = state.epochs.keys().next().value;
            if (oldest === undefined) break;
            state.epochs.delete(oldest);
          }
        }
        state.epochOrdinal = ordinal;
        renderSatellite();
      })
      .catch(() => {
        /* a missing RANGE record only empties the counters — never worth a banner */
      })
      .finally(() => {
        state.epochPending = false;
        const next = state.epochWanted;
        state.epochWanted = -2;
        if (state.alive && next >= 0 && next !== ordinal) requestEpoch(next);
      });
  }

  function syncSatellite() {
    if (!state.frames.length) return;
    const index = frameIndexAt(state.time);
    const ordinal = state.rangeOrdinal[index] ?? -1;
    if (ordinal === state.epochOrdinal) return;
    requestEpoch(ordinal);
  }

  /* ---- transport ---- */

  function frameIndexAt(seconds) {
    const frames = state.frames;
    if (!frames.length) return -1;
    const target = seconds * 1000 + 0.5;
    let low = 0;
    let high = frames.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid].offsetMs <= target) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function renderTicks() {
    if (!state.frames.length || !state.duration) {
      el.ticks.innerHTML = '';
      return;
    }
    const colors = {};
    const parts = [];
    for (const frame of state.frames) {
      const key = String(frame.messageId);
      if (!colors[key]) colors[key] = TICK_COLORS[Object.keys(colors).length % TICK_COLORS.length];
      const left = (frame.offsetMs / (state.duration * 1000)) * 100;
      parts.push(
        `<span class="pb-tick" title="${esc(`${frame.name} #${frame.index + 1} · ${(frame.offsetMs / 1000).toFixed(3)} s`)}" ` +
          `style="left:${left.toFixed(3)}%;background:${colors[key]}"></span>`,
      );
    }
    el.ticks.innerHTML = parts.join('');
  }

  function renderSnippet() {
    if (!state.open || !state.duration) {
      el.snippet.hidden = true;
      return;
    }
    const from = Math.min(Math.max(state.from, 0), state.duration);
    const to = Math.min(Math.max(state.to, 0), state.duration);
    if (to <= from) {
      el.snippet.hidden = true;
      return;
    }
    el.snippet.hidden = false;
    el.snippet.style.left = `${((from / state.duration) * 100).toFixed(3)}%`;
    el.snippet.style.width = `${(((to - from) / state.duration) * 100).toFixed(3)}%`;
  }

  function renderClock() {
    const ratio = state.duration ? state.time / state.duration : 0;
    el.fill.style.width = `${(ratio * 100).toFixed(4)}%`;
    el.clock.textContent = clockText(state.time);
    el.duration.textContent = clockText(state.duration);
    el.bar.setAttribute('aria-valuenow', state.time.toFixed(3));
    el.bar.setAttribute('aria-valuemax', state.duration.toFixed(3));
    el.bar.setAttribute('aria-valuetext', `${clockText(state.time)} of ${clockText(state.duration)}`);
  }

  /** UTC of the record under the play head, computed from the capture's first UTC + the offset. */
  function frameUtc() {
    if (!state.info || !state.info.startUtc) return '--:--:--';
    const base = Date.parse(state.info.startUtc);
    if (Number.isNaN(base)) return '--:--:--';
    return utcClock(new Date(base + state.time * 1000).toISOString());
  }

  function setPlayButton() {
    el.play.classList.toggle('is-playing', state.playing);
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.play.disabled = !state.open;
  }

  function renderRecord() {
    const index = frameIndexAt(state.time);
    if (index < 0) {
      el.frameName.textContent = '--';
      el.frameNote.textContent = '';
      return;
    }
    const frame = state.frames[index];
    el.frameName.textContent = `${frame.name} · #${frame.index + 1} / ${state.frames.length}`;
    el.frameNote.textContent = `offset ${clockText(frame.time)} · ${frame.bytes} B record`;

    if (index === state.detailIndex) return;
    state.detailIndex = index;
    if (!el.frameBody.hidden) {
      el.frameBody.innerHTML = '<p class="pb-empty">Decoding…</p>';
      fetchFrameDetail(index);
    }
  }

  function renderFrameFields(data) {
    if (!data.fields.length) {
      el.frameBody.innerHTML = '<p class="pb-empty">No EDIE layout for this message — only the SBF header is available.</p>';
      return;
    }
    const rows = data.fields
      .slice(0, 60)
      .map((field) => {
        const value =
          field.text === undefined || field.text === null || field.text === '' ? String(field.value) : field.text;
        return `<tr><td class="path">${esc(field.path)}</td><td class="shown">${esc(value)}</td></tr>`;
      })
      .join('');
    el.frameBody.innerHTML =
      '<div class="pb-frame-table-wrap"><table class="pb-frame-table"><tbody>' +
      rows +
      '</tbody></table></div>' +
      `<p class="pb-hint">${data.fields.length} of ${data.fieldTotal} fields` +
      `${data.fieldsTruncated ? ' (decoder cap)' : ''}` +
      ` · UTC ${esc(data.utc || '--')}${data.layoutKnown ? '' : ' · no EDIE layout'}</p>`;
  }

  function fetchFrameDetail(index) {
    if (state.detailPending) {
      state.pendingDetail = index;
      return;
    }
    state.detailPending = true;
    const wanted = state.capture;
    api
      .get('/api/playback/frame', { capture: state.capture, index })
      .then((data) => {
        if (!state.alive || state.capture !== wanted || state.detailIndex !== index) return;
        renderFrameFields(data);
      })
      .catch(() => {
        /* a frame that scrolled out while the request was in flight is not worth a banner */
      })
      .finally(() => {
        state.detailPending = false;
        const next = state.pendingDetail;
        state.pendingDetail = null;
        if (state.alive && next !== null && next !== index) fetchFrameDetail(next);
      });
  }

  function updateDashboard() {
    el.devTime.textContent = frameUtc();
    renderRecord();
    syncSatellite();
  }

  function setTime(seconds) {
    if (!state.open) return;
    state.time = Math.min(Math.max(seconds, 0), state.duration);
    renderClock();
    updateDashboard();
  }

  function stop() {
    state.playing = false;
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    setPlayButton();
  }

  function tick(now) {
    if (!state.playing) return;
    if (!state.last) state.last = now;
    let delta = now - state.last;
    state.last = now;
    if (delta > 250) delta = 250; // tab was hidden: never jump the whole capture
    setTime(state.time + (delta * state.speed) / 1000);
    if (state.time >= state.duration - 1e-9) {
      stop();
      el.frameNote.textContent = `end of capture · ${clockText(state.duration)}`;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!state.open || state.playing) return;
    if (state.time >= state.duration - 1e-9) setTime(0);
    state.playing = true;
    state.last = 0;
    setPlayButton();
    state.raf = requestAnimationFrame(tick);
  }

  /* ---- snippet / export ---- */

  function exportUrl(from, to) {
    return withQuery('/api/playback/export', { capture: state.capture, from: from.toFixed(3), to: to.toFixed(3) });
  }

  function syncSnippet() {
    const from = Number(el.from.value);
    const to = Number(el.to.value);
    if (!state.open) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Load a timeline first.';
      return;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from > to) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Invalid range: need 0 ≤ from ≤ to.';
      return;
    }
    state.from = from;
    state.to = Math.min(to, state.duration);
    renderSnippet();
    el.download.disabled = false;
    el.snippetBtn.disabled = false;
    el.snippetNote.textContent =
      `[ ${from.toFixed(3)} s , ${state.to.toFixed(3)} s ] of ${clockText(state.duration)}` +
      ` · ${(((state.to - from) / (state.duration || 1)) * 100).toFixed(1)}% of the capture`;
  }

  function download(from, to) {
    if (!state.open) return;
    const anchor = document.createElement('a');
    anchor.href = exportUrl(from, to);
    const stem = (state.capture.split('/').pop() || 'capture').replace(/\.[^.]+$/, '');
    anchor.download = `${stem}_${from.toFixed(3)}-${to.toFixed(3)}.sbf`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  /* ---- load / close ---- */

  async function load(capture) {
    stop();
    alert('');
    state.capture = capture;
    state.open = true;
    state.info = null;
    state.frames = [];
    state.duration = 0;
    state.time = 0;
    state.detailIndex = -1;
    state.epochs.clear();
    state.seen.clear();
    state.epochOrdinal = -2;
    state.rangeOrdinal = [];
    el.frameBody.hidden = true;
    el.frameToggle.setAttribute('aria-expanded', 'false');
    el.frameBody.innerHTML = '';
    el.ticks.innerHTML = '';
    el.snippet.hidden = true;
    renderShell();
    renderPosition();
    renderDevice();
    renderSatellite();
    closeDialog();
    syncShellCapture(capture);

    try {
      const [info, frames] = await Promise.all([
        api.get('/api/playback/info', { capture }),
        api.post('/api/playback/frames', { capture }),
      ]);
      if (!state.alive || !state.open || state.capture !== capture) return;
      state.info = info;
      state.frames = frames.frames ?? [];
      state.duration = (info.durationMs || 0) / 1000;
      state.time = 0;
      state.speed = Number(info.speeds?.[1]) || 1;

      const options = (info.speeds ?? speeds).map((value) => `<option value="${value}">${value}×</option>`).join('');
      el.speed.innerHTML = options;
      el.speed.value = String(state.speed);

      el.start.textContent = utcClock(info.startUtc);
      el.end.textContent = utcClock(info.finishUtc);
      el.from.value = '0';
      el.to.value = state.duration.toFixed(3);

      buildRangeMap();
      renderTicks();
      setPlayButton();
      renderClock();
      setTime(0);
      syncSnippet();
    } catch (error) {
      if (!state.alive) return;
      alert(`Timeline failed: ${error.message}`);
      renderClock();
      setPlayButton();
      return;
    }

    // The two tiles fail soft: a capture without BESTPOS / HWMONITOR still shows the dashboard.
    const probe = async (msgId) => {
      try {
        const data = await api.get('/api/records', { capture, msgId, offset: 0, limit: 1 });
        return data.records && data.records[0] ? data.records[0] : null;
      } catch {
        return null;
      }
    };
    const [bestpos, hw] = await Promise.all([probe(BESTPOS), probe(HWMONITOR)]);
    if (!state.alive || !state.open || state.capture !== capture) return;
    state.position = readPosition(bestpos);
    state.device = readDevice(hw);
    renderPosition();
    renderDevice();
    updateDashboard();
  }

  function closeFile() {
    stop();
    state.open = false;
    state.capture = '';
    state.info = null;
    state.frames = [];
    state.duration = 0;
    state.position = null;
    state.device = null;
    state.epochs.clear();
    state.seen.clear();
    state.epochOrdinal = -2;
    state.detailIndex = -1;
    el.frameBody.hidden = true;
    el.ticks.innerHTML = '';
    el.snippet.hidden = true;
    renderShell();
    alert('');
  }

  /* ---- pointer + keyboard on the scrub strip ---- */

  function seekFromEvent(event) {
    const rect = el.bar.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    setTime(ratio * state.duration);
  }

  let dragging = false;
  const onBarDown = (event) => {
    if (!state.open) return;
    event.preventDefault();
    dragging = true;
    stop();
    seekFromEvent(event);
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
  };
  const onDocMove = (event) => {
    if (dragging) seekFromEvent(event);
  };
  const onDocUp = () => {
    dragging = false;
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', onDocUp);
  };
  const onBarKey = (event) => {
    if (!state.open) return;
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setTime(state.time + step);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setTime(state.time - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setTime(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setTime(state.duration);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (state.playing) stop();
      else play();
    }
  };

  const onPlay = () => {
    if (state.playing) stop();
    else play();
  };
  const onRewind = () => {
    if (!state.open) return;
    stop();
    setTime(state.time - 30);
  };
  const onSpeed = () => {
    state.speed = Number(el.speed.value) || 1;
    state.last = 0;
  };
  const onRange = () => syncSnippet();
  const onDownload = () => download(state.from, state.to);
  const onSnippet = () => download(state.from, state.to);

  function toggleDock() {
    const open = el.drawer.hidden;
    el.drawer.hidden = !open;
    el.dockToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.dock.classList.toggle('is-open', open);
    if (open && state.open) setTime(state.time);
  }

  const onDock = () => toggleDock();
  const onFrameToggle = () => {
    const open = el.frameBody.hidden;
    el.frameBody.hidden = !open;
    el.frameToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && state.open) {
      state.detailIndex = -1;
      renderRecord();
    }
  };

  const onOpen = () => openDialog();
  const onDialogClose = () => closeDialog();
  const onDialogBackdrop = (event) => {
    if (event.target === el.dialog) closeDialog();
  };
  const onDialogKey = (event) => {
    if (event.key === 'Escape' && !el.dialog.hidden) closeDialog();
  };
  const onDialogClick = (event) => {
    const item = event.target.closest('[data-role="open-capture"]');
    if (!item) return;
    load(item.dataset.path);
  };
  const onFileTabClick = (event) => {
    if (event.target.closest('[data-role="close-file"]')) closeFile();
  };
  const onHelp = (event) => {
    const which = event.currentTarget.dataset.el;
    event.preventDefault();
    const notes = {
      helpPosition:
        'Positioning comes from the first BESTPOS (#42) record of the capture: Position / Latitude / ' +
        'Longitude / Height (MSL) / Datum are its own fields, Height Accuracy is height_std_dev and ' +
        '2d-SD is sqrt(latitude_std_dev² + longitude_std_dev²).',
      helpDevice:
        'Device rows come from HWMONITOR (#963) measurements, keyed by (status >> 8) & 0xff: ' +
        '1 Temperature · 2 Antenna Current · 7 Antenna Voltage. Each badge repeats the receiver’s own ' +
        'boundary limit (status & 0xff). CPU Usage is idleTime (100 − raw/2) in GRIT, and the binary ' +
        'HWMONITOR of this capture does not carry that field, so it reads --.',
      helpSatellite:
        'This capture has no SATVIS2 (#1043), so the original screen shows 0 everywhere. We count the ' +
        'RANGE (#43) observations of the epoch at the play head instead: In Use = distinct sv_prn per ' +
        'constellation (system = (c_status >> 16) & 7), Not Used = PRNs already seen earlier in the ' +
        'capture but missing now, Missing stays 0 because only SATVIS2 can say what should be visible. ' +
        'RANGE has no azimuth/elevation, so the sky plot is an empty grid.',
    };
    alert(notes[which] ?? '', 'info');
  };

  el.bar.addEventListener('mousedown', onBarDown);
  el.bar.addEventListener('keydown', onBarKey);
  el.play.addEventListener('click', onPlay);
  el.rewind.addEventListener('click', onRewind);
  el.speed.addEventListener('change', onSpeed);
  el.from.addEventListener('change', onRange);
  el.to.addEventListener('change', onRange);
  el.download.addEventListener('click', onDownload);
  el.snippetBtn.addEventListener('click', onSnippet);
  el.dockToggle.addEventListener('click', onDock);
  el.frameToggle.addEventListener('click', onFrameToggle);
  el.open.addEventListener('click', onOpen);
  el.dialogClose.addEventListener('click', onDialogClose);
  el.dialog.addEventListener('click', onDialogBackdrop);
  el.openList.addEventListener('click', onDialogClick);
  el.helpPosition.addEventListener('click', onHelp);
  el.helpDevice.addEventListener('click', onHelp);
  el.helpSatellite.addEventListener('click', onHelp);
  document.addEventListener('keydown', onDialogKey);
  if (fileTabs) fileTabs.addEventListener('click', onFileTabClick);

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || name === state.capture) return;
      load(name);
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__playbackCleanup = () => {
    state.alive = false;
    stop();
    onDocUp();
    el.bar.removeEventListener('mousedown', onBarDown);
    el.bar.removeEventListener('keydown', onBarKey);
    el.play.removeEventListener('click', onPlay);
    el.rewind.removeEventListener('click', onRewind);
    el.speed.removeEventListener('change', onSpeed);
    el.from.removeEventListener('change', onRange);
    el.to.removeEventListener('change', onRange);
    el.download.removeEventListener('click', onDownload);
    el.snippetBtn.removeEventListener('click', onSnippet);
    el.dockToggle.removeEventListener('click', onDock);
    el.frameToggle.removeEventListener('click', onFrameToggle);
    el.open.removeEventListener('click', onOpen);
    el.dialogClose.removeEventListener('click', onDialogClose);
    el.dialog.removeEventListener('click', onDialogBackdrop);
    el.openList.removeEventListener('click', onDialogClick);
    el.helpPosition.removeEventListener('click', onHelp);
    el.helpDevice.removeEventListener('click', onHelp);
    el.helpSatellite.removeEventListener('click', onHelp);
    document.removeEventListener('keydown', onDialogKey);
    if (fileTabs) {
      fileTabs.removeEventListener('click', onFileTabClick);
      fileTabs.remove();
    }
    if (offCapture) offCapture();
  };

  setPlayButton();
  renderShell();
  renderPosition();
  renderDevice();
  renderSatellite();

  /* Boot: read the capture list, then open whatever the shell has selected (or the sample). */
  api
    .get('/api/captures')
    .then(async (data) => {
      if (!state.alive) return;
      state.captures = data.captures ?? [];
      fillCaptures();
      const preferred =
        state.captures.find((item) => item.path === state.capture) ||
        state.captures.find((item) => item.path === 'convert/clean-9600.gps') ||
        state.captures.find((item) => item.name === 'clean-9600.gps') ||
        state.captures[0];
      if (preferred) await load(preferred.path);
      else {
        state.open = false;
        renderShell();
        el.dialogNote.textContent = 'No capture under samples/.';
      }
    })
    .catch((error) => {
      if (!state.alive) return;
      alert(`Capture list failed: ${error.message}`);
      el.dialogNote.textContent = '—';
    });
}

export default { mount, unmount };
