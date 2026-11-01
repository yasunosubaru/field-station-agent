/**
 * Manage panel — the suite's **device status dashboard** (the screen the original shows once a
 * receiver is connected), rebuilt on top of the local JSON API.
 *
 * Reference: `ref-ui/manage-device-open.png` (2560×1600 at 150 % → CSS = physical / 1.5, y measured
 * from the client area, i.e. the OS title bar 22.67 px already removed by the shell).
 *
 * Blocks, in the original's stacking order:
 *
 *   1. app bar            the shell's 70 px bar gains the open-file tab `clean-9600.gp… (0) ×`
 *                         and a disabled `+ Add Device`, both injected from here (index.html is
 *                         owned by the shell, so nothing there is edited)
 *   2. black menu bar     50 px #000: Status (the only real page) · Configuration · Settings ▾ ·
 *                         Tools ▾ · Device ▾, bell + "0" chip at the right end
 *   3. status band        135 px #E4E4E4 + 1 px #B6B6B6 rule, liner at 591: Positioning [Good]
 *                         (Position / Latitude / Longitude / Height (MSL)) | Device [Good]
 *                         (Model / CPU Usage / Logging, Time (UTC) / Interference)
 *   4. tab strip          Positioning (active, 2 px #115C7C underline) · Tracking
 *   5. three tiles        Positioning (8 fields) · Device (4 rows, one badge each) · Interference
 *   6. second row         Satellite View (2 columns: legend + 8 constellation rows + sky plot) ·
 *                         PPP Corrections - Off
 *
 * Two sources, never mixed, and the mode is always on screen:
 *
 *   **Live**     a receiver session is open (`LiveLink`, polled through `/api/live/status` and
 *                `/api/live/logs?after=<cursor>`). The four tiles read the decoded records the
 *                receiver is actually emitting; anything the stream does not carry prints `--`
 *                with the reason in the tile. The mode strip above the tabs says `Live`, names the
 *                target and the time of the newest record.
 *   **Capture**  no live session in this page: the dashboard replays a capture through
 *                `/api/records`, exactly as before. The strip says `Capture` and names the file, so
 *                replayed numbers can never be mistaken for a connected receiver.
 *   **Live lost**  a live session existed and the transport dropped (receiver unplugged, socket
 *                closed). Every live field falls back to `--` — the panel deliberately does *not*
 *                swap in capture values and pretend the receiver is back. `Back to capture replay`
 *                is an explicit action.
 *
 * Where the numbers come from (all of them from the local JSON API, nothing invented):
 *
 *   live mode (fields decoded by `LiveLink` from the EDIE dictionary, same paths `/api/records`
 *   returns for a capture):
 *     BESTPOS #42       → band left half + Positioning tile
 *     HWMONITOR #963    → Device tile + band right half; the status word's high byte is the reading
 *                         type (1 temperature · 2 antenna current · 7 antenna voltage), its low byte
 *                         the boundary limit. CPU Usage is `100 − idleTime / 2` (GRIT §5.6).
 *     RANGE #43         → constellation counts (`(c_status >> 16) & 7`, the same table as
 *                         `graph/src/range-charts.ts`); In Use = newest epoch, Not Used = seen
 *                         earlier in this session
 *     SATVIS2 #1043     → real azimuth/elevation for the sky dots, and Missing = visible but not in
 *                         the newest RANGE epoch. Without SATVIS2 the dots stay symbolic.
 *     VERSION #37       → Model. ITDETECTSTATUS #2065 → Interference.
 *     FILESTATUS #2127 / LOGLIST #5 are not asked for, so Logging stays `--`.
 *
 *   capture mode: the same four sources come from the capture's first/last records via
 *   `/api/records`; a capture that lacks VERSION / ITDETECTSTATUS prints the same `--` it always did.
 *
 * Without an open capture the panel falls back to the capture list (`ref-ui/manage-clean.png`):
 * the original's "All devices" page with one card per capture and a Connect/Open action.
 *
 * Contract with the shell (`src/web/index.html`): `mount(root, ctx)` / `unmount(root)`,
 * ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./manage.css', import.meta.url).href;
const CSS_ID = 'nas-panel-manage-css';

const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;
const VERSION_LOG = 37;
const SATVIS2 = 1043;
const ITDETECTSTATUS = 2065;

/** `system` = `(c_status >> 16) & 7` — same table as `packages/graph/src/range-charts.ts`. */
const SYSTEM_GPS = 0;
const SYSTEM_GLO = 1;
const SYSTEM_SBAS = 2;
const SYSTEM_GAL = 3;
const SYSTEM_BDS = 4;
const SYSTEM_QZSS = 5;
const SYSTEM_NAVIC = 6;

/** Rows of the Satellite View tile, in the original's DOM order (`satelliteView.html:27-124`). */
const CONSTELLATIONS = [
  { key: 'gps', label: 'GPS', system: SYSTEM_GPS, icon: 'gps-legend', tone: 'gps' },
  { key: 'glo', label: 'GLO', system: SYSTEM_GLO, icon: 'glonass-legend', tone: 'glo' },
  { key: 'gal', label: 'GAL', system: SYSTEM_GAL, icon: 'galileo-legend', tone: 'gal' },
  { key: 'bds', label: 'BDS', system: SYSTEM_BDS, icon: 'bds-legend', tone: 'bds' },
  { key: 'qzss', label: 'QZSS', system: SYSTEM_QZSS, icon: 'qzss-legend', tone: 'qzss' },
  { key: 'navic', label: 'NAVIC', system: SYSTEM_NAVIC, icon: 'navic-legend', tone: 'navic' },
  { key: 'lband', label: 'LBAND', system: null, icon: 'lband-legend', tone: 'lband' },
  { key: 'sbas', label: 'SBAS', system: SYSTEM_SBAS, icon: 'sbas-legend', tone: 'sbas' },
];

/**
 * `HwMonitorStatusReadingType` → the row it feeds. The status word's high byte is the type, its
 * low byte the boundary limit (0 acceptable · 1 lower warning · 2 lower error · 3 upper warning ·
 * 4 upper error). A capture's binary HWMONITOR has no `idleTime`, but a live one does (the session
 * decoder keeps it), so CPU Usage is answered in live mode only.
 */
const HW_TYPES = { temperature: [1, 22], antennaCurrent: [2], antennaVoltage: [7], cpuUsage: [] };

/** `SATVIS2.system_type` → the Satellite View row it belongs to. */
const SATVIS_KEYS = {
  GPS: 'gps',
  GLONASS: 'glo',
  GLO: 'glo',
  GALILEO: 'gal',
  GAL: 'gal',
  BEIDOU: 'bds',
  BDS: 'bds',
  QZSS: 'qzss',
  NAVIC: 'navic',
  SBAS: 'sbas',
  LBAND: 'lband',
};

/** How many RANGE epochs the live session keeps for "seen but not in use" (≈2 min at 1 Hz). */
const LIVE_RANGE_HISTORY = 120;

/** Entries the Terminal asks for when it opens: enough context without a multi-MB backfill. */
const TERMINAL_BACKFILL = 150;

/**
 * The black bar under the app bar. `Status` and `Configuration` are real pages in this build;
 * `Settings` carries the two shipped settings pages it has (General, Networking) and opens them in
 * the same drawer the Configuration pages use. `Tools` carries the Terminal, the Events drawer and
 * the Device `.cfg` pair — the same doors the original has.
 */
const MENU = [
  { key: 'status', label: 'Status', icon: 'status', caret: false, wired: true },
  { key: 'configuration', label: 'Configuration', icon: 'configuration', caret: false, wired: true },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    caret: true,
    wired: true,
    items: [
      { key: 'generalSettings', label: 'General…', wired: true },
      { key: 'networkingSettings', label: 'Networking…', wired: true },
    ],
  },
  {
    key: 'tools',
    label: 'Tools',
    icon: 'tools',
    caret: true,
    wired: true,
    items: [
      { key: 'terminal', label: 'Terminal', wired: true },
      { key: 'events', label: 'Events', wired: true },
      {
        key: 'device',
        label: 'Device',
        wired: true,
        items: [
          { key: 'exportCfg', label: 'Export Configuration…', wired: true },
          { key: 'importCfg', label: 'Import Configuration…', wired: true },
        ],
      },
    ],
  },
  { key: 'device', label: 'Device', icon: 'device', caret: true, wired: false },
];

const UNWIRED_NOTE =
  'Not wired in this build: the local API only serves Status (this page) from a capture — ' +
  'the other pages need a live receiver.';

/** `Settings ▸ …` entries: each opens the drawer on the shipped page it names. */
const SETTINGS_PAGES = new Set(['generalSettings', 'networkingSettings']);

/* Material-style glyphs, 24×24 viewBox, drawn with `currentColor` so the bar can dim the
 * unwired items. The gear is the same path the shell's app-bar settings icon uses
 * (`icons/menubar_settings.svg`). */
const ICONS = {
  status:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M12 12 L16.4 7.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M12 3 A9 9 0 0 1 21 12" fill="none" stroke="currentColor" stroke-width="2.6"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>',
  configuration:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58C4.84 11.36 4.8 11.69 4.8 12s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  tools:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>',
  device:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/></svg>',
};

/* ---------------- small helpers (local: one panel at a time is loaded) ---------- */

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

function utcClock(iso) {
  if (!iso) return '--:--:--';
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return match ? match[1] : String(iso);
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

/** `SINGLE` prints as `Single`, `SOL_COMPUTED` stays as-is — the original's tooltips do the same. */
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

/** `data-el="band-lat"` becomes `el.bandLat`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function kvRow(label, target, extra) {
  return (
    '<div class="mg-kv-row">' +
    `<span class="mg-kv-label">${esc(label)}</span>` +
    `<span class="mg-kv-value${extra ? ` ${extra}` : ''}" data-el="${target}">--</span>` +
    '</div>'
  );
}

function deviceRow(label, valueTarget, badgeTarget) {
  return (
    '<div class="mg-device-row">' +
    `<span class="mg-kv-label">${esc(label)}</span>` +
    `<span class="mg-kv-value" data-el="${valueTarget}">--</span>` +
    `<span class="mg-badge mg-badge-unknown" data-el="${badgeTarget}" data-tone="unknown">--</span>` +
    '</div>'
  );
}

function satRow(item) {
  /* The six GNSS glyphs in `sats-sprite.png` already carry their own name under the shape; only
   * LBAND and SBAS are bare icons, so they get a text label (S:29712 `.lband-label`/`.sbas-label`). */
  const needsLabel = item.key === 'lband' || item.key === 'sbas';
  return (
    `<div class="mg-sat-row" data-constellation="${item.key}">` +
    '<div class="mg-constel-shape">' +
    `<span class="mg-sat-glyph ${item.icon}" aria-hidden="true"></span>` +
    (needsLabel ? `<span class="mg-sat-name">${esc(item.label)}</span>` : '') +
    '</div>' +
    '<div class="mg-constel-value">' +
    `<div class="mg-good-chip" data-sat="${item.key}-use" title="In Use — distinct PRNs in the last RANGE epoch of this capture">0</div>` +
    `<div class="mg-idle-chip" data-sat="${item.key}-idle" title="Not Used — PRNs seen earlier in this capture but not in the last epoch">0</div>` +
    '<div class="mg-outer">' +
    `<div class="mg-bad-chip" data-sat="${item.key}-missing" title="Missing — needs SATVIS2, which this capture does not contain">0</div>` +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

/** Horizon, 30°/60° rings and the compass labels — drawn once, dots are added per capture. */
function skySvg() {
  const size = 300;
  const c = size / 2;
  return (
    `<svg class="mg-sky-svg" viewBox="0 0 ${size} ${size}" role="img" ` +
    'aria-label="Polar sky plot: horizon, 30 and 60 degree elevation rings; RANGE carries no azimuth or elevation, so the dots are symbolic">' +
    `<circle class="mg-sky-disc" cx="${c}" cy="${c}" r="148"/>` +
    `<circle class="mg-sky-ring" cx="${c}" cy="${c}" r="98"/>` +
    `<circle class="mg-sky-ring mg-sky-ring-inner" cx="${c}" cy="${c}" r="74"/>` +
    `<line class="mg-sky-axis" x1="2" y1="${c}" x2="${size - 2}" y2="${c}"/>` +
    `<line class="mg-sky-axis" x1="${c}" y1="2" x2="${c}" y2="${size - 2}"/>` +
    `<text class="mg-sky-dir" x="${c + 6}" y="14">N</text>` +
    `<text class="mg-sky-dir" x="${size - 14}" y="${c + 5}">E</text>` +
    `<text class="mg-sky-dir" x="4" y="${c + 5}">W</text>` +
    `<text class="mg-sky-dir" x="${c + 6}" y="${size - 5}">S</text>` +
    `<text class="mg-sky-deg" x="${c + 6}" y="${c - 94}">30&deg;</text>` +
    `<text class="mg-sky-deg" x="${c + 6}" y="${c - 70}">60&deg;</text>` +
    '<g class="mg-sky-sats" data-el="skySats"></g>' +
    '</svg>'
  );
}

/** A dropdown entry: a leaf (`data-menu-item`) or a nested flyout (`data-submenu`). */
function dropEntry(entry) {
  if (!entry.items) {
    const off = entry.wired ? '' : ' is-off';
    const disabled = entry.wired ? '' : `aria-disabled="true" disabled title="${esc(UNWIRED_NOTE)}"`;
    return (
      `<button type="button" class="mg-drop-item${off}" data-menu-item="${esc(entry.key)}" ` +
      `role="menuitem" ${disabled}>${esc(entry.label)}</button>`
    );
  }
  const entries = entry.items.map(dropEntry).join('');
  return (
    '<span class="mg-drop-host mg-drop-nested">' +
    `<button type="button" class="mg-drop-item mg-drop-parent" data-submenu="${esc(entry.key)}" ` +
    `role="menuitem" aria-haspopup="true" aria-expanded="false">${esc(entry.label)}` +
    '<span class="mg-drop-arrow" aria-hidden="true">›</span></button>' +
    `<span class="mg-drop mg-drop-fly" data-drop="${esc(entry.key)}" hidden>${entries}</span>` +
    '</span>'
  );
}

function menuBar() {
  const items = MENU.map((item) => {
    const off = item.wired ? '' : ' is-off';
    const title = item.wired ? `${item.label} — this page` : `${item.label}: ${UNWIRED_NOTE}`;
    const button =
      `<button type="button" class="mg-menu-btn${off}${item.wired && !item.items ? ' is-current' : ''}" ` +
      `data-menu="${esc(item.key)}" role="menuitem" title="${esc(title)}" ` +
      `${item.wired ? '' : 'aria-disabled="true" disabled'}>` +
      `<span class="mg-menu-icon" aria-hidden="true">${ICONS[item.icon] ?? ''}</span>` +
      `<span class="mg-menu-text">${esc(item.label)}</span>` +
      (item.caret ? '<span class="mg-menu-caret" aria-hidden="true"></span>' : '') +
      '</button>';
    if (!item.items) return button;
    const entries = item.items.map(dropEntry).join('');
    return `<span class="mg-drop-host">${button}<span class="mg-drop" data-drop="${esc(item.key)}" hidden>${entries}</span></span>`;
  }).join('');
  return (
    '<div class="mg-menubar" role="menubar" aria-label="Device pages">' +
    items +
    '<span class="mg-menu-spacer"></span>' +
    '<span class="mg-bell" aria-hidden="true"></span>' +
    '<span class="mg-bell-count">0</span>' +
    '</div>'
  );
}

function template() {
  return `
<div class="mg-device" data-el="device" hidden>
  ${menuBar()}

  <div class="mg-band">
    <div class="mg-band-inner">
      <div class="mg-band-half mg-band-left">
        <div class="mg-band-head">
          <span class="mg-band-title">Positioning</span>
          <span class="mg-badge mg-badge-good" data-el="bandPosBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-band-fields">
          <div class="mg-band-row mg-r1c1">
            <span class="mg-band-label">Position</span>
            <span class="mg-band-value mg-underlined" data-el="bandPosition">--</span>
          </div>
          <div class="mg-band-row mg-r2c1">
            <span class="mg-band-label">Latitude</span>
            <span class="mg-band-value" data-el="bandLat">--</span>
          </div>
          <div class="mg-band-row mg-r3c1">
            <span class="mg-band-label">Longitude</span>
            <span class="mg-band-value" data-el="bandLon">--</span>
          </div>
          <div class="mg-band-row mg-r2c2">
            <span class="mg-band-label">Height (MSL)</span>
            <span class="mg-band-value" data-el="bandHeight">--</span>
          </div>
        </div>
      </div>

      <div class="mg-band-split" aria-hidden="true"></div>

      <div class="mg-band-half mg-band-device">
        <div class="mg-band-head">
          <span class="mg-band-title">Device</span>
          <span class="mg-badge mg-badge-good" data-el="bandDevBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-band-fields mg-band-fields-device">
          <div class="mg-band-row mg-r1c1">
            <span class="mg-band-label">Model</span>
            <span class="mg-band-value" data-el="bandModel">--</span>
          </div>
          <div class="mg-band-row mg-r2c1">
            <span class="mg-band-label">CPU Usage</span>
            <span class="mg-band-value" data-el="bandCpu">--</span>
          </div>
          <div class="mg-band-row mg-r3c1">
            <span class="mg-band-label">Logging</span>
            <span class="mg-band-value" data-el="bandLogging">--</span>
          </div>
          <div class="mg-band-row mg-r1c2">
            <span class="mg-band-label">Time (UTC)</span>
            <span class="mg-band-value" data-el="bandTime">--</span>
          </div>
          <div class="mg-band-row mg-r2c2">
            <span class="mg-band-label">Interference</span>
            <span class="mg-band-value" data-el="bandInterference">Not detected</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="mg-page">
    <div class="mg-mode" data-el="mode" data-mode="capture" role="status" aria-live="polite">
      <span class="mg-mode-badge" data-el="modeBadge" data-tone="off">Capture</span>
      <span class="mg-mode-source" data-el="modeSource">no capture</span>
      <span class="mg-mode-detail" data-el="modeDetail"></span>
      <span class="mg-mode-spacer"></span>
      <button type="button" class="mg-mode-action" data-mode-action="connect">Connect live…</button>
      <button type="button" class="mg-mode-action" data-mode-action="disconnect" hidden>Disconnect</button>
      <button type="button" class="mg-mode-action" data-mode-action="replay" hidden>Back to capture replay</button>
    </div>

    <div class="mg-tabstrip" role="tablist" aria-label="Status pages">
      <button type="button" class="mg-tab is-active" role="tab" aria-selected="true">Positioning</button>
      <button type="button" class="mg-tab is-off" role="tab" aria-selected="false" disabled
              title="Tracking: ${esc(UNWIRED_NOTE)}">Tracking</button>
    </div>

    <div class="mg-grid">
      <section class="mg-card" data-area="positioning">
        <div class="mg-card-head">
          <h2 class="mg-heading">Positioning</h2>
          <span class="mg-badge mg-badge-good" data-el="cardPosBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Operating Mode', 'posMode')}
          ${kvRow('Position', 'posPosition', 'mg-underlined')}
          ${kvRow('Latitude', 'posLat')}
          ${kvRow('Longitude', 'posLon')}
          ${kvRow('Height (MSL)', 'posHeight')}
          ${kvRow('Height Accuracy', 'posHeightAcc')}
          ${kvRow('2d-SD', 'pos2d')}
          ${kvRow('Datum', 'posDatum')}
        </div>
        <p class="mg-reason" data-el="posReason"></p>
        <button type="button" class="mg-help" data-help="positioning"
                title="Positioning comes from the first BESTPOS (#42) record of the capture, or the newest BESTPOS in a live session: Operating Mode is solution_status, Position is position_type, Height Accuracy is height_std_dev, 2d-SD is sqrt(latitude_std_dev² + longitude_std_dev²).">Help</button>
      </section>

      <section class="mg-card" data-area="device">
        <div class="mg-card-head">
          <h2 class="mg-heading">Device</h2>
        </div>
        <div class="mg-kv mg-device-list">
          ${deviceRow('CPU Usage', 'devCpu', 'devCpuBadge')}
          ${deviceRow('Temperature', 'devTemp', 'devTempBadge')}
          ${deviceRow('Antenna Voltage', 'devVoltage', 'devVoltageBadge')}
          ${deviceRow('Antenna Current', 'devCurrent', 'devCurrentBadge')}
        </div>
        <p class="mg-reason" data-el="devReason"></p>
        <button type="button" class="mg-help" data-help="device"
                title="Device readings are HWMONITOR (#963) measurements[]: the status word's high byte is the reading type (1 temperature · 2 antenna current · 7 antenna voltage), the low byte the boundary limit the badge reports. In a live session the session decoder keeps idleTime, so CPU Usage prints 100 − idleTime / 2; a capture's binary HWMONITOR has no idleTime and stays --.">Help</button>
      </section>

      <section class="mg-card" data-area="interference">
        <div class="mg-card-head">
          <h2 class="mg-heading">Interference</h2>
          <span class="mg-badge mg-badge-good" data-el="intBadge" data-tone="good">Good</span>
        </div>
        <p class="mg-interference" data-el="interference">Not detected</p>
        <p class="mg-reason" data-el="intReason"></p>
        <button type="button" class="mg-help" data-help="interference"
                title="Interference reads ITDETECTSTATUS (#2065): rfPath, detection method and the four parameters, with the tile badge driven by the severity words. A live session that does not log #2065 prints -- and says so; the captures in this build do not contain it, so capture mode keeps the original's Not detected with no number invented.">Help</button>
      </section>

      <section class="mg-card mg-card-wide" data-area="satellite">
        <div class="mg-card-head">
          <h2 class="mg-heading">Satellite View</h2>
          <span class="mg-badge mg-badge-unknown" data-el="satBadge" data-tone="unknown">--</span>
        </div>
        <div class="mg-sat-body">
          <div class="mg-sat-left">
            <div class="mg-sat-legend">
              <div class="mg-tracked">
                <p>Tracked</p>
                <div>
                  <div class="mg-inuse">In Use</div>
                  <div class="mg-notused">Not Used</div>
                </div>
              </div>
              <div class="mg-missing">Missing</div>
            </div>
            <div class="mg-shapes">${CONSTELLATIONS.map(satRow).join('')}</div>
            <p class="mg-sat-note" data-el="satNote">Counting RANGE (#43) observations…</p>
          </div>
          <div class="mg-sat-right" data-el="sky">${skySvg()}</div>
        </div>
        <button type="button" class="mg-help" data-help="satellite"
                title="Satellite View counts RANGE (#43) observations: system = (c_status >> 16) & 7 (0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC), In Use = distinct sv_prn in the newest epoch, Not Used = PRNs seen in earlier epochs only. In a live session SATVIS2 (#1043) adds real azimuth/elevation for the sky dots and Missing = visible but not in the newest epoch; a capture has neither, so its dots are symbolic and Missing stays 0.">Help</button>
      </section>

      <section class="mg-card" data-area="ppp">
        <div class="mg-card-head">
          <h2 class="mg-heading">PPP Corrections - Off</h2>
          <span class="mg-badge mg-badge-off" data-tone="off">Off</span>
        </div>
        <button type="button" class="mg-ppp-link" data-help="ppp"
                title="PPP Corrections are switched on through Configuration › PPP, which needs a live receiver; this build reads a capture and cannot change receiver settings.">Switch on via configuration</button>
      </section>
    </div>
  </div>
</div>

<div class="mg-list" data-el="list" hidden>
  <div class="mg-list-head">
    <h1 class="mg-list-title">All captures</h1>
    <button type="button" class="mg-add-device" disabled
            title="Add Device: this build reads captures from 逆向/00_来源/samples through the local API, it cannot talk to a receiver.">
      <span class="mg-plus" aria-hidden="true"></span>Add Device</button>
  </div>
  <p class="mg-list-note" data-el="listNote">Reading the capture list…</p>
  <div class="mg-list-grid" data-el="listCards"></div>
  <p class="mg-list-help"><span class="mg-help-disc" aria-hidden="true">?</span>
    One card per capture under <code>逆向/00_来源/samples</code>. Open one to see the device
    dashboard the original shows for a connected receiver.</p>
</div>

<div class="notice mg-notice" data-el="error" hidden></div>

<div class="mg-terminal" data-el="terminal" role="dialog" aria-label="Terminal" hidden>
  <div class="mg-term-head">
    <span class="mg-term-title">Terminal</span>
    <span class="mg-term-status" data-term="status">Not connected</span>
    <button type="button" class="mg-term-close" data-term="close" aria-label="Close">×</button>
  </div>
  <div class="mg-term-rows">
    <label class="mg-term-field"><span>Serial</span>
      <input type="text" data-term="path" placeholder="COM8" spellcheck="false"></label>
    <label class="mg-term-field"><span>Baud</span>
      <input type="text" data-term="baud" value="115200" spellcheck="false"></label>
    <label class="mg-term-field"><span>or TCP</span>
      <input type="text" data-term="host" placeholder="127.0.0.1" spellcheck="false"></label>
    <label class="mg-term-field"><span>Port</span>
      <input type="text" data-term="port" placeholder="3001" spellcheck="false"></label>
    <button type="button" class="mg-term-btn" data-term="connect">Connect</button>
    <button type="button" class="mg-term-btn" data-term="disconnect">Disconnect</button>
  </div>
  <div class="mg-term-output" data-term="output" tabindex="0"></div>
  <form class="mg-term-send" data-term="form">
    <span class="mg-term-prompt" aria-hidden="true">&gt;</span>
    <input type="text" data-term="line" placeholder="LOG COM1 BESTPOSB ONTIME 1" spellcheck="false" autocomplete="off">
    <button type="submit" class="mg-term-btn">Send</button>
  </form>
</div>

<div class="mg-config" data-el="config" role="dialog" aria-label="Configuration" hidden>
  <div class="mg-config-head">
    <span class="mg-config-title" data-config="title">Configuration</span>
    <label class="mg-config-pick">
      <span class="mg-config-pick-label">Page</span>
      <select class="mg-config-select" data-config="page"></select>
    </label>
    <span class="mg-config-note" data-config="note">Replaces nothing: the shipped page, served by the suite's own controller.</span>
    <button type="button" class="mg-config-close" data-config="close" aria-label="Close configuration">×</button>
  </div>
  <iframe class="mg-config-frame" data-config="frame" title="Configuration page"></iframe>
</div>

<div class="mg-cfg" data-el="cfg" role="dialog" aria-modal="true" aria-label="Device configuration file" hidden>
  <div class="mg-cfg-sheet">
    <div class="mg-cfg-head">
      <span class="mg-cfg-title" data-cfg="title">Configuration file</span>
      <button type="button" class="mg-cfg-close" data-cfg="close" aria-label="Close">×</button>
    </div>
    <div class="mg-cfg-tabs" role="tablist">
      <button type="button" class="mg-cfg-tab is-active" data-cfg-tab="export" role="tab" aria-selected="true">Export</button>
      <button type="button" class="mg-cfg-tab" data-cfg-tab="import" role="tab" aria-selected="false">Import</button>
    </div>
    <section class="mg-cfg-body" data-cfg-body="export">
      <p class="mg-cfg-state" data-cfg="exportState">Checking the receiver…</p>
      <p class="mg-cfg-reason" data-cfg="exportReason"></p>
      <p class="mg-cfg-line" data-cfg="exportFile"></p>
      <div class="mg-cfg-actions">
        <button type="button" class="mg-cfg-btn" data-cfg="download" disabled>Download .cfg</button>
        <button type="button" class="mg-cfg-btn mg-cfg-btn-quiet" data-cfg="refresh">Re-check</button>
      </div>
    </section>
    <section class="mg-cfg-body" data-cfg-body="import" hidden>
      <p class="mg-cfg-state" data-cfg="importState">Parse first — the .cfg is read with the shipped loader, nothing is sent.</p>
      <label class="mg-cfg-pick">
        <span>Choose a .cfg</span>
        <input type="file" data-cfg="file" accept=".cfg,.txt,.gps,.asc">
      </label>
      <textarea class="mg-cfg-text" data-cfg="text" spellcheck="false"
        placeholder="…or paste the file’s text here"></textarea>
      <div class="mg-cfg-actions">
        <button type="button" class="mg-cfg-btn" data-cfg="parse">Parse</button>
        <button type="button" class="mg-cfg-btn mg-cfg-btn-primary" data-cfg="import" disabled>Import to receiver</button>
      </div>
      <p class="mg-cfg-reason" data-cfg="importReason"></p>
      <pre class="mg-cfg-report" data-cfg="report" hidden></pre>
    </section>
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

  /* ---------------- live session + terminal (one poller feeds both) ---------------- */

  const term = { open: false, backfilling: false, lines: [] };
  const termEls = {};
  for (const node of root.querySelectorAll('[data-term]')) termEls[node.dataset.term] = node;

  /* ---- Configuration drawer: the shipped pages, served by the suite's own controller ---- */

  const configEls = {};
  for (const node of root.querySelectorAll('[data-config]')) configEls[node.dataset.config] = node;
  const fileEls = {};
  for (const node of root.querySelectorAll('[data-cfg]')) fileEls[node.dataset.cfg] = node;

  const drawer = { pages: null, page: '' };

  /** `/api/config/pages` is fetched once: the 14 pill pages plus the operational ones (Events). */
  async function configPages() {
    if (drawer.pages) return drawer.pages;
    try {
      const data = await api.get('/api/config/pages');
      drawer.pages = Array.isArray(data.pages) ? data.pages : [];
    } catch (error) {
      drawer.pages = [];
      if (configEls.note) configEls.note.textContent = `Page list failed: ${error.message}`;
    }
    if (configEls.page) {
      // Grouped by the menu the page belongs to, so the same one select covers Configuration and
      // Settings without pretending they are the same page family.
      const groups = [
        { label: 'Configuration', pages: drawer.pages.filter((page) => !page.settings && !page.operational) },
        { label: 'Settings', pages: drawer.pages.filter((page) => page.settings) },
        { label: 'Operational', pages: drawer.pages.filter((page) => page.operational) },
      ].filter((group) => group.pages.length);
      configEls.page.innerHTML = groups
        .map(
          (group) =>
            `<optgroup label="${esc(group.label)}">` +
            group.pages
              .map((page) => `<option value="${esc(page.name)}">${esc(page.label)}</option>`)
              .join('') +
            '</optgroup>',
        )
        .join('');
      if (drawer.page) configEls.page.value = drawer.page;
    }
    return drawer.pages;
  }

  function setConfigFrame(page) {
    if (!page) return;
    drawer.page = page;
    if (configEls.page) configEls.page.value = page;
    if (configEls.frame) configEls.frame.src = `/config/${encodeURIComponent(page)}`;
    const settings = SETTINGS_PAGES.has(page);
    if (configEls.title) configEls.title.textContent = settings ? 'Settings' : 'Configuration';
    if (configEls.note) {
      const entry = (drawer.pages ?? []).find((item) => item.name === page);
      configEls.note.textContent = entry
        ? `${entry.label}${settings ? ' (Settings page)' : ''} — the suite’s shipped markup and controller (${page})`
        : page;
    }
  }

  async function openConfigDrawer(page) {
    if (!el.config) return;
    await configPages();
    el.config.hidden = false;
    setConfigFrame(page || drawer.page || 'portConfig');
  }

  function closeConfigDrawer() {
    if (!el.config) return;
    el.config.hidden = true;
    if (configEls.frame) configEls.frame.src = 'about:blank';
  }

  /* ---- Tools ▸ Device ▸ Export / Import Configuration (.cfg) ---- */

  const device = { status: null, parsed: null };

  function setCfgDisabled(node, disabled) {
    if (node) node.disabled = Boolean(disabled);
  }

  async function loadDeviceStatus() {
    try {
      device.status = await api.get('/api/config/device/status');
    } catch (error) {
      device.status = null;
      if (fileEls.exportReason) fileEls.exportReason.textContent = `Status failed: ${error.message}`;
      return;
    }
    const status = device.status;
    if (fileEls.exportState) {
      fileEls.exportState.textContent = status.connected
        ? 'A receiver session is open.'
        : 'No receiver connected — a .cfg is the receiver’s own configuration, so there is nothing to read it from.';
    }
    if (fileEls.exportReason) fileEls.exportReason.textContent = status.export?.reason ?? '';
    if (fileEls.exportFile) {
      fileEls.exportFile.textContent = status.suggestedFileName
        ? `File name the suite would use: ${status.suggestedFileName}` +
          (status.export?.records > 0 ? ` · ${status.export.records} receiver record(s) on the link` : '')
        : '';
    }
    if (fileEls.importReason) fileEls.importReason.textContent = status.import?.reason ?? '';
    setCfgDisabled(fileEls.download, !status.export?.available);
    setCfgDisabled(fileEls.import, !(status.import?.available && device.parsed?.ok));
  }

  function openDeviceModal(tab) {
    if (!el.cfg) return;
    el.cfg.hidden = false;
    selectCfgTab(tab);
    void loadDeviceStatus();
  }

  function closeDeviceModal() {
    if (el.cfg) el.cfg.hidden = true;
  }

  function selectCfgTab(tab) {
    for (const node of root.querySelectorAll('[data-cfg-tab]')) {
      const active = node.dataset.cfgTab === tab;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const node of root.querySelectorAll('[data-cfg-body]')) {
      node.hidden = node.dataset.cfgBody !== tab;
    }
    if (fileEls.title) {
      fileEls.title.textContent =
        tab === 'export' ? 'Export Configuration (.cfg)' : 'Import Configuration (.cfg)';
    }
  }

  function showReport(text) {
    if (!fileEls.report) return;
    fileEls.report.hidden = !text;
    fileEls.report.textContent = text ?? '';
  }

  async function downloadCfg() {
    try {
      const response = await fetch('/api/config/device/export');
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.includes('text/plain')) {
        const body = type.includes('application/json') ? await response.json() : null;
        showReport(`Export refused (HTTP ${response.status}): ${(body && body.reason) || 'no .cfg available'}`);
        return;
      }
      const text = await response.text();
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name ? name[1] : 'receiver.cfg';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showReport(`Downloaded ${anchor.download} (${text.length} bytes).`);
    } catch (error) {
      showReport(`Export failed: ${error.message}`);
    }
  }

  async function parseCfg() {
    const text = fileEls.text ? fileEls.text.value : '';
    try {
      const result = await api.post('/api/config/device/import/preview', { text });
      device.parsed = result;
      const lines = [
        `loadable commands: ${result.commands.length} · skipped lines: ${result.skipped} · comments: ${result.comments}`,
      ];
      if (result.currentPort) lines.push(`current port: ${result.currentPort} (its own CONFIG line is skipped)`);
      if (result.mismatches && result.mismatches.length) {
        lines.push(`version warnings: ${result.mismatches.join(', ')}`);
      }
      if (result.error) lines.push(`error: ${result.error}`);
      if (result.reason) lines.push(result.reason);
      for (const command of (result.commands ?? []).slice(0, 40)) lines.push(`  ${command}`);
      if ((result.commands ?? []).length > 40) {
        lines.push(`  … ${result.commands.length - 40} more`);
      }
      showReport(lines.join('\n'));
      if (fileEls.importState) {
        fileEls.importState.textContent = result.ok
          ? `Parsed — ${result.commands.length} command(s) would be sent.`
          : 'Parse finished, but nothing in this file can be loaded.';
      }
      setCfgDisabled(fileEls.import, !(device.status?.import?.available && result.ok));
    } catch (error) {
      showReport(`Parse failed: ${error.message}`);
    }
  }

  async function importCfg() {
    const text = fileEls.text ? fileEls.text.value : '';
    // One line goes out at a time and each waits for the receiver's own `<OK`/`<ERR…`; the button
    // stays disabled until the file is parsed again, so a second click cannot re-send a file whose
    // first line was already refused.
    setCfgDisabled(fileEls.import, true);
    if (fileEls.importReason) fileEls.importReason.textContent = '';
    if (fileEls.importState) {
      fileEls.importState.textContent =
        'Sending one line at a time — each line waits for the receiver’s <OK before the next one goes out.';
    }
    showReport('');
    try {
      const response = await fetch('/api/config/device/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const result = await response.json();
      applyImportOutcome(result, response.status);
      // A finished import must be re-parsed before it can run again (its text may have changed).
      device.parsed = null;
    } catch (error) {
      if (fileEls.importState) fileEls.importState.textContent = 'Import failed — nothing is claimed.';
      if (fileEls.importReason) fileEls.importReason.textContent = `Import failed: ${error.message}`;
      showReport(`Import failed: ${error.message}`);
    }
  }

  /**
   * Render one import answer. The reason under the button, the state line and the button's
   * disabled flag all come from this one object, so a failure cannot show one thing in the report
   * and another under the button.
   */
  function applyImportOutcome(result, httpStatus) {
    const answer = result ?? {};
    const steps = Array.isArray(answer.steps) ? answer.steps : [];
    const verification = answer.verification ?? null;
    const matched = verification ? Number(verification.matched) || 0 : 0;
    const absent = verification && Array.isArray(verification.absent) ? verification.absent : [];
    const report = [];
    if (answer.ok) {
      report.push(
        `Imported ${answer.sent} command(s): the receiver answered every line.`,
        `Read-back ${answer.verified ? 'confirmed' : 'did not confirm'} ${matched} of ${answer.sent}` +
          (absent.length ? ` · ${absent.length} line(s) are not reported by LOG RXCONFIG` : '') +
          '.',
      );
    } else {
      const status = httpStatus === 200 ? '' : ` (HTTP ${httpStatus})`;
      report.push(`Import stopped${status}: ${answer.reason ?? 'no reason given'}`);
    }
    for (const step of steps) {
      const verdict = step.verified ? ` · read-back ${step.verified}` : '';
      const reply = step.reply ?? `(no reply: ${step.status})`;
      report.push(`${step.ok ? 'OK  ' : 'FAIL'} ${step.index}. ${step.line} → ${reply} (${step.elapsedMs} ms)${verdict}`);
      if (step.verified === 'mismatch' && Array.isArray(step.readback)) {
        for (const line of step.readback) report.push(`      receiver: ${line}`);
      }
    }
    if (verification && verification.request) {
      report.push(`Read-back: ${verification.request} → ${verification.lines} configuration line(s).`);
    }
    showReport(report.join('\n'));
    if (fileEls.importReason) fileEls.importReason.textContent = answer.reason ?? '';
    if (fileEls.importState) {
      if (answer.ok) {
        fileEls.importState.textContent = answer.verified
          ? `Written: ${answer.sent} command(s) applied and read back.`
          : `Written: ${answer.sent} command(s) applied; the read-back did not confirm every line.`;
      } else if (answer.failedLine) {
        fileEls.importState.textContent = `Stopped at “${answer.failedLine}” — nothing after it was sent.`;
      } else {
        fileEls.importState.textContent = 'Import refused — nothing was written.';
      }
    }
    setCfgDisabled(fileEls.import, true);
  }

  /**
   * Everything the Status dashboard knows about the live link. `latest`/`ranges`/`satvis` are fed
   * incrementally from `/api/live/logs?after=<cursor>` so the device's one-shot VERSION record
   * survives the server's 400-record ring buffer.
   */
  const live = {
    connected: false,
    /** A live session existed at least once on this page — that is what "lost" means. */
    everConnected: false,
    /** The user chose "Back to capture replay" while the link was down. */
    dismissed: false,
    /** `connectedAt` of the session the cached data belongs to; a new one resets it. */
    session: '',
    target: '',
    disconnectedAt: '',
    lastError: '',
    lastRecordAt: '',
    cursor: 0,
    records: 0,
    /** Last `/api/live/status` body, so the Terminal can render without its own request. */
    status: null,
    latest: new Map(),
    ranges: [],
    satvis: new Map(),
    pollTimer: 0,
  };

  /** `live` wins over `lost` over `capture`; "lost" never silently falls back to replay. */
  function liveMode() {
    if (live.connected) return 'live';
    if (live.everConnected && !live.dismissed) return 'lost';
    return 'capture';
  }

  function resetLiveData() {
    live.latest = new Map();
    live.ranges = [];
    live.satvis = new Map();
    live.records = 0;
    live.lastRecordAt = '';
  }

  function applyLiveEntry(entry) {
    live.records += 1;
    if (entry.time) live.lastRecordAt = entry.time;
    const data = entry.data;
    if (!data) return;
    live.latest.set(entry.messageId, { data, time: entry.time, seq: entry.seq });
    if (data.kind === 'range') {
      live.ranges.push({ time: entry.time, observations: data.observations ?? [] });
      if (live.ranges.length > LIVE_RANGE_HISTORY) live.ranges.splice(0, live.ranges.length - LIVE_RANGE_HISTORY);
    } else if (data.kind === 'satvis') {
      const key = SATVIS_KEYS[String(data.system || '').toUpperCase()];
      if (key) live.satvis.set(key, { time: entry.time, satellites: data.satellites ?? [] });
    }
  }

  function termStatus(text) {
    if (termEls.status) termEls.status.textContent = text;
  }
  function termStatusText(status) {
    if (!status.connected) {
      return status.disconnectedAt ? `Disconnected — ${utcClock(status.disconnectedAt)} UTC` : 'Not connected';
    }
    const base = `Connected — ${status.target} — ${status.records} records`;
    return status.lastError ? `${base} — ${status.lastError}` : base;
  }
  function termAppend(text) {
    term.lines.push(text);
    if (term.lines.length > 400) term.lines.splice(0, term.lines.length - 400);
    if (termEls.output) {
      termEls.output.textContent = term.lines.join('\n');
      termEls.output.scrollTop = termEls.output.scrollHeight;
    }
  }

  /**
   * One poll for the whole panel: status first (the mode depends on it), then the log cursor. The
   * terminal drawer prints the same entries, so opening it never restarts or races the poll.
   */
  async function livePoll() {
    if (!state.alive) return;
    let status;
    try {
      status = await api.get('/api/live/status');
    } catch (error) {
      termStatus(`API error: ${error.message}`);
      /* The server itself is unreachable: stop claiming Live. The next successful poll restores
       * it (or reports the session gone), so this is not a dead end. */
      if (live.connected) {
        live.connected = false;
        live.lastError = `API error: ${error.message}`;
        live.disconnectedAt = live.disconnectedAt || new Date().toISOString();
        render();
      }
      return;
    }
    if (!state.alive) return;

    live.target = status.target || live.target;
    live.lastError = status.lastError || '';
    live.status = status;
    const connected = Boolean(status.connected);

    if (connected) {
      live.everConnected = true;
      live.dismissed = false;
      live.disconnectedAt = '';
      if (live.session !== (status.connectedAt || '')) {
        live.session = status.connectedAt || '';
        live.cursor = 0;
        resetLiveData();
      }
      if (status.lastRecordAt) live.lastRecordAt = status.lastRecordAt;
      try {
        const page = await api.get('/api/live/logs', { after: live.cursor });
        if (!state.alive) return;
        live.cursor = Number(page.cursor) || live.cursor;
        for (const entry of page.entries ?? []) {
          applyLiveEntry(entry);
          if (term.open && !term.backfilling) termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
        }
      } catch (error) {
        live.lastError = error.message;
      }
    } else {
      live.disconnectedAt = status.disconnectedAt || live.disconnectedAt;
    }

    live.connected = connected;
    termStatus(termStatusText(status));

    /* A session opened from the Terminal (or before this page mounted) takes over the dashboard. */
    if (connected && !state.open) {
      state.open = true;
      setBodyState();
      renderDeviceShell();
    }
    render();
  }

  function startLivePolling() {
    stopLivePolling();
    live.pollTimer = setInterval(() => {
      void livePoll();
    }, 900);
    void livePoll();
  }
  function stopLivePolling() {
    if (live.pollTimer) {
      clearInterval(live.pollTimer);
      live.pollTimer = 0;
    }
  }

  async function termConnect() {
    const path = (termEls.path?.value ?? '').trim();
    const body = path
      ? { kind: 'serial', path, baud: Number(termEls.baud?.value) || 115200 }
      : { kind: 'tcp', host: (termEls.host?.value ?? '').trim() || '127.0.0.1', port: Number(termEls.port?.value) || 3001 };
    try {
      const status = await api.post('/api/live/connect', body);
      term.lines = [];
      termAppend(`Connected to ${status.target}`);
      live.session = status.connectedAt || '';
      live.cursor = 0;
      live.everConnected = true;
      live.dismissed = false;
      resetLiveData();
      void livePoll();
    } catch (error) {
      termAppend(`Connect failed: ${error.message}`);
    }
  }
  async function termDisconnect() {
    try {
      await api.post('/api/live/disconnect', {});
      termAppend('Disconnected');
      live.disconnectedAt = new Date().toISOString();
      void livePoll();
    } catch (error) {
      termAppend(`Disconnect failed: ${error.message}`);
    }
  }
  async function termSend(line) {
    if (!line.trim()) return;
    try {
      const status = await api.post('/api/live/command', { line });
      if (status.lastError) termAppend(`> ${line}   (${status.lastError})`);
      else termAppend(`> ${line}`);
      void livePoll();
    } catch (error) {
      termAppend(`> ${line}   (${error.message})`);
    }
  }
  function termOpen() {
    term.open = true;
    if (el.terminal) el.terminal.hidden = false;
    if (!live.pollTimer) startLivePolling();
    if (live.status) termStatus(termStatusText(live.status));
    void termBackfill();
    termEls.line?.focus();
  }
  /** Re-open the drawer after a long session: the newest slice of the ring buffer, newest last. */
  async function termBackfill() {
    if (term.backfilling) return;
    term.backfilling = true;
    try {
      const page = await api.get('/api/live/logs', { after: 0, limit: TERMINAL_BACKFILL });
      term.lines = [];
      for (const entry of page.entries ?? []) {
        termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
      }
    } catch (error) {
      termAppend(`API error: ${error.message}`);
    } finally {
      term.backfilling = false;
    }
  }
  function termClose() {
    term.open = false;
    if (el.terminal) el.terminal.hidden = true;
  }

  /* The 1232 px column is centred in the area *left of the scrollbar* (the reference window has a
   * 15 px one). Chromium draws overlay scrollbars in this environment, which reserve nothing, so
   * the missing gutter is measured and passed to CSS instead of guessing. */
  {
    const scroller = document.querySelector('.nas-content');
    const gutter = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
    root.style.setProperty('--mg-gutter', `${gutter >= 8 ? 0 : 15}px`);
  }

  /** `gps-use` / `gps-idle` / `gps-missing` → the three count chips of every constellation row. */
  const satCount = {};
  for (const node of root.querySelectorAll('[data-sat]')) satCount[node.dataset.sat] = node;

  /* The open-file tab and "+ Add Device" live in the shell's app bar (`index.html #tabs-list`),
   * exactly like the original puts them next to the app name. Injected from here so the shell is
   * not edited; CSS pins them to this page and removes them again in the cleanup below. */
  const appBar = document.getElementById('tabs-list');
  const appTab = appBar ? document.createElement('li') : null;
  if (appTab) {
    appTab.className = 'mg-filetabs';
    appTab.setAttribute('role', 'presentation');
    appBar.appendChild(appTab);
  }

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    open: false,
    logs: null,
    position: null,
    device: null,
    range: null,
    version: null,
    interference: null,
    time: '',
    /** Bumped per open; a slower response for an older capture never overwrites a newer one. */
    token: 0,
  };

  /* ---- shared bits ---- */

  function setBadge(node, tone, text) {
    if (!node) return;
    const labels = { good: 'Good', warn: 'Warning', bad: 'Error', off: 'Off', unknown: '--' };
    node.className = `mg-badge mg-badge-${tone}`;
    node.textContent = text ?? labels[tone] ?? '--';
    node.dataset.tone = tone;
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function alert(message) {
    if (!el.error) return;
    el.error.hidden = !message;
    el.error.textContent = message || '';
  }

  function setBodyState() {
    if (state.open) document.body.dataset.manageState = 'device';
    else document.body.dataset.manageState = 'list';
  }

  /* ---- app bar file tab ---- */

  function renderAppBar() {
    if (!appTab) return;
    if (!state.open) {
      appTab.hidden = true;
      appTab.innerHTML = '';
      delete appTab.dataset.manageKey;
      return;
    }
    appTab.hidden = false;
    const mode = liveMode();
    const key = `${mode}|${live.target}|${state.capture}`;
    if (appTab.dataset.manageKey === key) return;
    appTab.dataset.manageKey = key;
    if (mode !== 'capture') {
      /* A live dashboard is not a file: no ✕ that would look like it disconnects the receiver. */
      const label = mode === 'live' ? `Live · ${live.target || 'receiver'}` : 'Live lost';
      const title = mode === 'live'
        ? `Live session on ${live.target}. The cards read what the receiver is emitting right now.`
        : `The live session to ${live.target || 'the receiver'} closed — the cards show -- until it is connected again.`;
      appTab.innerHTML =
        '<span class="mg-filetab-plate mg-filetab-plate-live">' +
        `<span class="mg-filetab mg-filetab-live" title="${esc(title)}">` +
        `<span class="mg-filetab-name">${esc(label)}</span></span>` +
        '</span>' +
        '<button type="button" class="mg-add-tab" disabled ' +
        `title="${esc('Add Device: one live session per process; disconnect it in the mode strip first.')}">` +
        '<span class="mg-plus" aria-hidden="true"></span>Add Device</button>';
      return;
    }
    const name = baseName(state.capture);
    const short = name.length > 12 ? `${name.slice(0, 12)}…` : name;
    appTab.innerHTML =
      '<span class="mg-filetab-plate">' +
      `<a class="mg-filetab" href="#" title="${esc(state.capture)}">` +
      `<span class="mg-filetab-name">${esc(short)} (0)</span></a>` +
      '<button type="button" class="mg-filetab-close" aria-label="Close file">&times;</button>' +
      '</span>' +
      '<button type="button" class="mg-add-tab" disabled ' +
      `title="${esc('Add Device: this build reads captures from the local API and cannot talk to a receiver.')}">` +
      '<span class="mg-plus" aria-hidden="true"></span>Add Device</button>';
  }

  /* ---- capture list (no open file) ---- */

  function renderList() {
    el.list.hidden = false;
    el.device.hidden = true;
    el.listNote.textContent = state.captures.length
      ? `${state.captures.length} capture${state.captures.length === 1 ? '' : 's'} · pick one to open its dashboard`
      : 'No capture under 逆向/00_来源/samples.';
    if (!state.captures.length) {
      el.listCards.innerHTML = '<p class="mg-list-empty">No capture found.</p>';
      return;
    }
    el.listCards.innerHTML = state.captures
      .map((item) => {
        const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '.';
        return (
          `<article class="mg-capture-card" data-capture="${esc(item.path)}">` +
          '<div class="mg-capture-menu" aria-hidden="true">⋮</div>' +
          `<h2 class="mg-capture-name" title="${esc(item.path)}">${esc(item.name)}</h2>` +
          '<div class="mg-capture-fields">' +
          `<span>File</span><span>${esc(item.name)}</span>` +
          `<span>Folder</span><span>${esc(folder)}</span>` +
          `<span>Size</span><span>${esc(bytesText(item.bytes))}</span>` +
          '</div>' +
          `<button type="button" class="mg-capture-open" data-open="${esc(item.path)}">` +
          '<span class="mg-link-glyph" aria-hidden="true"></span>Open</button>' +
          '</article>'
        );
      })
      .join('');
  }

  function renderDeviceShell() {
    el.list.hidden = true;
    el.device.hidden = false;
  }

  /* ---- mode strip + dashboard dispatch --------------------------------------
   * One place decides which source the cards read. `render()` is called by the poller every tick,
   * so it must be cheap and idempotent; it never fetches anything itself. */

  function setModeBadge(tone, text) {
    if (!el.modeBadge) return;
    el.modeBadge.className = `mg-mode-badge mg-mode-badge-${tone}`;
    el.modeBadge.dataset.tone = tone;
    el.modeBadge.textContent = text;
  }

  function renderModeStrip() {
    const mode = liveMode();
    if (el.mode) el.mode.dataset.mode = mode;
    root.dataset.mode = mode;

    const actions = { connect: mode !== 'live', disconnect: mode === 'live', replay: mode === 'lost' };
    for (const node of root.querySelectorAll('[data-mode-action]')) {
      node.hidden = !actions[node.dataset.modeAction];
    }

    if (mode === 'live') {
      setModeBadge('good', 'Live');
      if (el.modeBadge) el.modeBadge.title = `A receiver session is open on ${live.target}; the four tiles read its decoded records.`;
      setText(el.modeSource, live.target || 'receiver');
      if (el.modeSource) el.modeSource.title = 'The receiver this dashboard is connected to.';
      const at = live.lastRecordAt ? utcClock(live.lastRecordAt) : '—';
      const since = live.session ? utcClock(live.session) : '—';
      setText(el.modeDetail, `实时数据 · 会话连接于 ${since} UTC · 已收 ${live.records} 条 · 最后一条 ${at}（接收机时间）`);
      return;
    }

    if (mode === 'lost') {
      setModeBadge('bad', 'Live lost');
      if (el.modeBadge) el.modeBadge.title = 'The live session closed. Fields show -- until the receiver is connected again; capture values are never substituted.';
      setText(el.modeSource, live.target || 'receiver');
      const when = live.disconnectedAt ? utcClock(live.disconnectedAt) : '—';
      const error = live.lastError ? ` · ${live.lastError}` : '';
      setText(el.modeDetail, `连接已断开 ${when} UTC${error} · 字段回到 --，不会改用抓包数据`);
      const connect = root.querySelector('[data-mode-action="connect"]');
      if (connect) connect.textContent = 'Reconnect…';
      return;
    }

    setModeBadge('off', 'Capture');
    if (el.modeBadge) el.modeBadge.title = 'No live session: the numbers below are replayed from a capture, not read from a receiver.';
    setText(el.modeSource, state.capture ? baseName(state.capture) : 'no capture');
    if (el.modeSource) el.modeSource.title = state.capture ? `离线回放：${state.capture}` : 'No capture open.';
    setText(el.modeDetail, '离线回放 — 没有实时会话；数值来自抓包，不是接收机');
    const connect = root.querySelector('[data-mode-action="connect"]');
    if (connect) connect.textContent = 'Connect live…';
  }

  /** The single entry point: mode strip first, then whichever source the mode allows. */
  function render() {
    const mode = liveMode();
    renderModeStrip();
    renderAppBar();
    if (!state.open) return;
    if (mode === 'live') renderLiveDashboard();
    else if (mode === 'lost') renderLostDashboard();
    else renderCaptureDashboard();
  }

  function renderCaptureDashboard() {
    renderPosition();
    renderDevice();
    renderInterference(state.interference ? { entries: state.interference.entries, time: state.interference.time } : null, 'capture');
    renderSatellite();
  }

  /* ---- numbers shared by both modes ---------------------------------------- */

  /** `Number(null)` is 0 — a missing EDIE field must stay missing, not become a real zero. */
  function numberOrNaN(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function withFixed(value, digits, suffix = '') {
    const parsed = numberOrNaN(value);
    return Number.isFinite(parsed) ? `${parsed.toFixed(digits)}${suffix}` : '--';
  }

  /** `/api/records` and `LiveLink` both speak `path → field`, so one reader serves both. */
  function fieldMap(record) {
    const map = new Map();
    if (!record || !Array.isArray(record.fields)) return map;
    for (const field of record.fields) if (!map.has(field.path)) map.set(field.path, field);
    return map;
  }

  /* ---- BESTPOS #42 → band left half + Positioning tile ---- */

  function readPosition(record) {
    if (!record) return null;
    const fields = new Map();
    for (const field of record.fields) if (!fields.has(field.path)) fields.set(field.path, field);
    const get = (path) => fields.get(path);
    const latDev = Number(get('latitude_std_dev')?.value);
    const lonDev = Number(get('longitude_std_dev')?.value);
    return {
      mode: shown(get('solution_status')),
      position: shown(get('position_type')),
      latitude: Number(get('latitude')?.value),
      longitude: Number(get('longitude')?.value),
      height: Number(get('orthometric_height')?.value),
      heightDev: Number(get('height_std_dev')?.value),
      twoSigma: Number.isFinite(latDev) && Number.isFinite(lonDev) ? Math.sqrt(latDev * latDev + lonDev * lonDev) : NaN,
      datum: shown(get('datum_id')),
      solved: shown(get('solution_status')) === 'SOL_COMPUTED',
    };
  }

  function renderPosition() {
    const p = state.position;
    const tone = p ? (p.solved ? 'good' : 'warn') : 'warn';
    if (!p) {
      setText(el.bandPosition, '--');
      setText(el.bandLat, '--');
      setText(el.bandLon, '--');
      setText(el.bandHeight, '--');
      for (const node of [el.posMode, el.posPosition, el.posLat, el.posLon, el.posHeight, el.posHeightAcc, el.pos2d, el.posDatum]) {
        setText(node, '--');
      }
      setBadge(el.bandPosBadge, tone);
      setBadge(el.cardPosBadge, tone);
      setText(
        el.posReason,
        `抓包回放 · ${baseName(state.capture) || '这个抓包'} 里没有 BESTPOS (#42) — 字段保持 --。`,
      );
      return;
    }
    const position = p.position ? titleCase(p.position) : '--';
    const lat = `${fixed(p.latitude, 7)}°`;
    const lon = `${fixed(p.longitude, 7)}°`;
    const height = `${fixed(p.height, 2)} m`;

    setText(el.bandPosition, position);
    setText(el.bandLat, lat);
    setText(el.bandLon, lon);
    setText(el.bandHeight, height);

    setText(el.posMode, p.mode ?? '--');
    setText(el.posPosition, position);
    setText(el.posLat, lat);
    setText(el.posLon, lon);
    setText(el.posHeight, height);
    setText(el.posHeightAcc, `${fixed(p.heightDev, 2)} m`);
    setText(el.pos2d, `${fixed(p.twoSigma, 2)} m`);
    setText(el.posDatum, p.datum ?? '--');

    setBadge(el.bandPosBadge, tone);
    setBadge(el.cardPosBadge, tone);
    setText(
      el.posReason,
      `抓包回放 · BESTPOS (#42) 首条记录 · 离线数据，不是接收机实时值`,
    );
  }

  /* ---- HWMONITOR #963 → Device tile + band right half ---- */

  function readDevice(record) {
    if (!record) return null;
    const values = new Map();
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
    };
  }

  /** Sensor row tone: the receiver's own boundary limit wins when it flagged something. */
  function sensorTone(reading) {
    if (!reading) return 'unknown';
    const limit = reading.limit;
    if (limit === 0) return 'good';
    if (limit === 1 || limit === 3) return 'warn';
    return 'bad';
  }

  function renderDevice() {
    const d = state.device;
    // The original prints °C without decimals, V and mA with one — same convention here.
    const temp = d?.temperature ? `${withFixed(d.temperature.value, 0, ' °C')}` : '--';
    const volt = d?.antennaVoltage ? `${withFixed(d.antennaVoltage.value, 1, ' V')}` : '--';
    const amp = d?.antennaCurrent ? `${withFixed(d.antennaCurrent.value * 1000, 1, ' mA')}` : '--';
    const cpu = d?.cpuUsage ? `${withFixed(d.cpuUsage.value, 0, ' %')}` : '--';

    setText(el.devCpu, cpu);
    setText(el.devTemp, temp);
    setText(el.devVoltage, volt);
    setText(el.devCurrent, amp);

    setBadge(el.devCpuBadge, d?.cpuUsage ? sensorTone(d.cpuUsage) : 'unknown');
    setBadge(el.devTempBadge, sensorTone(d?.temperature));
    setBadge(el.devVoltageBadge, sensorTone(d?.antennaVoltage));
    setBadge(el.devCurrentBadge, sensorTone(d?.antennaCurrent));

    // Band right half: only what the capture can actually answer.
    setText(el.bandModel, state.version ? state.version.hardware || state.version.model || '--' : '--');
    setText(el.bandCpu, cpu);
    setText(el.bandLogging, '--'); // needs FILESTATUS (#2127) / LOGLIST (#5)
    setText(el.bandInterference, interferenceText(state.interference));
    setText(el.bandTime, state.time || '--');

    const complete = Boolean(d && d.temperature && d.antennaVoltage && d.antennaCurrent);
    setBadge(el.bandDevBadge, complete || d ? 'good' : 'warn');
    // The band's badge follows the readings the capture can answer; a missing CPU usage stays a
    // `--` in its own row rather than turning the whole device amber.
    el.bandDevBadge.title = d
      ? 'Device health from the HWMONITOR (#963) boundary limits; CPU Usage / Logging have no source in a capture.'
      : 'No HWMONITOR (#963) record in this capture.';

    const missing = [];
    if (!d) missing.push('HWMONITOR (#963) 不在这个抓包里');
    else if (!d.temperature || !d.antennaVoltage || !d.antennaCurrent) missing.push('HWMONITOR 缺温度/电压/电流读数');
    missing.push(d?.cpuUsage ? '' : 'CPU Usage：抓包的二进制 HWMONITOR 没有 idleTime');
    missing.push(state.version ? '' : 'Model：抓包里没有 VERSION (#37)');
    missing.push('Logging：需要 FILESTATUS (#2127)/LOGLIST (#5)');
    setText(el.devReason, `抓包回放 · ${missing.filter(Boolean).join(' · ')}`);
  }

  /* ---- VERSION #37 / ITDETECTSTATUS #2065 in a capture ---- */

  function readVersion(record) {
    if (!record) return null;
    const fields = fieldMap(record);
    const total = Number(fields.get('versions.count')?.value) || 0;
    let fallback = null;
    for (let index = 0; index < Math.min(total, 16); index += 1) {
      const base = `versions[${index}]`;
      const candidate = {
        model: shown(fields.get(`${base}.model_name`)) ?? '',
        hardware: shown(fields.get(`${base}.hardware_version`)) ?? '',
        software: shown(fields.get(`${base}.software_version`)) ?? '',
        component: shown(fields.get(`${base}.component_type`)) ?? '',
      };
      if (!fallback && (candidate.model || candidate.hardware)) fallback = candidate;
      if (candidate.component === 'GPSCARD' || candidate.component === 'GPSCARD2') return candidate;
    }
    return fallback;
  }

  function readInterference(record) {
    if (!record) return null;
    const fields = fieldMap(record);
    const total = Number(fields.get('interference_statuses.count')?.value) || 0;
    const entries = [];
    for (let index = 0; index < Math.min(total, 64); index += 1) {
      const base = `interference_statuses[${index}]`;
      entries.push({
        rfPath: shown(fields.get(`${base}.frequency`)) ?? '',
        detectionType: shown(fields.get(`${base}.int_detect_method`)) ?? '',
        centerFrequency: numberOrNaN(fields.get(`${base}.parameter1`)?.value),
        bandwidth: numberOrNaN(fields.get(`${base}.parameter2`)?.value),
        power: numberOrNaN(fields.get(`${base}.parameter3`)?.value),
        estimatedPower: numberOrNaN(fields.get(`${base}.parameter4`)?.value),
        severity: [
          numberOrNaN(fields.get(`${base}.severity1`)?.value) || 0,
          numberOrNaN(fields.get(`${base}.severity2`)?.value) || 0,
        ],
      });
    }
    return entries.length ? { entries, time: record.header?.utc ?? '' } : null;
  }

  /** Any non-zero severity word is the receiver saying it detected interference. */
  function interferenceDetected(data) {
    return (data?.entries ?? []).some((entry) => (entry.severity ?? []).some((value) => Number(value) !== 0));
  }

  function interferenceText(data) {
    if (!data) return null;
    return interferenceDetected(data) ? 'Detected' : 'Not detected';
  }

  /**
   * The Interference tile is shared by both modes: live fills it from ITDETECTSTATUS (#2065) when
   * the receiver logs it, and a capture prints the original's "Not detected" only when its own
   * #2065 record is absent — never a number that was invented.
   */
  function renderInterference(data, source) {
    const live_ = source === 'live';
    if (!data || !data.entries || !data.entries.length) {
      setText(el.interference, live_ ? '--' : 'Not detected');
      setBadge(el.intBadge, live_ ? 'unknown' : 'good');
      setText(
        el.intReason,
        live_
          ? 'Live · ITDETECTSTATUS (#2065) 没有到达 — 接收机没有在这一路输出干扰检测报文，字段保持 --。'
          : '抓包回放 · 这个抓包没有 ITDETECTSTATUS (#2065) — 沿用原界面的 Not detected，没有编造数值。',
      );
      return;
    }
    const detected = interferenceDetected(data);
    setText(el.interference, detected ? 'Detected' : 'Not detected');
    setBadge(el.intBadge, detected ? 'warn' : 'good', detected ? 'Detected' : 'Good');
    const detail = data.entries
      .map(
        (entry) =>
          `${entry.rfPath || '--'} · ${entry.detectionType || '--'} · ` +
          `center ${withFixed(entry.centerFrequency, 2)} · width ${withFixed(entry.bandwidth, 2)} · ` +
          `power ${withFixed(entry.power, 2)} · est ${withFixed(entry.estimatedPower, 2)}`,
      )
      .join(' ; ');
    const when = data.time ? `${utcClock(data.time)} UTC` : '—';
    setText(el.intReason, `${live_ ? 'Live' : '抓包回放'} · ITDETECTSTATUS (#2065) ${when} · ${detail}`);
  }

  /* ---- RANGE #43 → Satellite View ---- */

  const systemOf = (entry) => (Number(entry.c_status) >> 16) & 7;

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
      const system = systemOf(entry);
      if (!counts.has(system)) counts.set(system, new Set());
      counts.get(system).add(Number(entry.sv_prn));
    }
    return { counts, utc: record.header?.utc ?? '', observed: obs.size };
  }

  /**
   * Up to five RANGE epochs of the capture: the first, three in the middle and the last one. The
   * last epoch is "now" (In Use); the union of the sampled epochs is what the receiver has seen
   * (Not Used = seen − now), the same rule Playback applies while scrubbing.
   */
  function epochOffsets(total) {
    if (total <= 0) return [];
    if (total <= 5) return Array.from({ length: total }, (_v, i) => i);
    const wanted = [0, Math.round((total - 1) * 0.25), Math.round((total - 1) * 0.5), Math.round((total - 1) * 0.75), total - 1];
    return [...new Set(wanted)];
  }

  async function loadRange(capture) {
    const probe = await api.get('/api/records', { capture, msgId: RANGE, offset: 0, limit: 1 });
    const total = Number(probe.total) || 0;
    if (!total) return null;
    const offsets = epochOffsets(total);
    const records = new Map();
    if (probe.records && probe.records[0]) records.set(0, parseEpoch(probe.records[0]));
    await Promise.all(
      offsets
        .filter((offset) => offset !== 0)
        .map(async (offset) => {
          const data = await api.get('/api/records', { capture, msgId: RANGE, offset, limit: 1 });
          const record = data.records && data.records[0];
          if (record) records.set(offset, parseEpoch(record));
        }),
    );
    const lastOffset = offsets[offsets.length - 1];
    const current = records.get(lastOffset) ?? null;
    const seen = new Map();
    for (const epoch of records.values()) {
      for (const [system, prns] of epoch.counts) {
        if (!seen.has(system)) seen.set(system, new Set());
        for (const prn of prns) seen.get(system).add(prn);
      }
    }
    return { total, current, seen, sampled: records.size };
  }

  function renderSatellite() {
    const range = state.range;
    const current = range?.current ?? null;
    let inUseTotal = 0;
    const dots = [];
    for (const item of CONSTELLATIONS) {
      const inUse = item.system === null || !current ? 0 : (current.counts.get(item.system)?.size ?? 0);
      const seen = item.system === null || !range ? 0 : (range.seen.get(item.system)?.size ?? 0);
      const notUsed = Math.max(0, seen - inUse);
      inUseTotal += inUse;
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (useNode) useNode.textContent = String(inUse);
      if (idleNode) idleNode.textContent = String(notUsed);
      if (missNode) missNode.textContent = '0';
      if (item.system !== null && current && inUse) {
        for (const prn of [...(current.counts.get(item.system) ?? [])].sort((a, b) => a - b)) {
          dots.push({ prn, tone: item.tone });
        }
      }
    }

    if (!range) setBadge(el.satBadge, 'unknown');
    else setBadge(el.satBadge, inUseTotal > 0 ? 'good' : 'warn');

    const when = current && current.utc ? utcClock(current.utc) : '--:--:--';
    el.satNote.textContent = range
      ? `RANGE (#43) epoch ${when} UTC · ${inUseTotal} tracked PRNs · ` +
        `In Use = last epoch, Not Used = seen in ${range.sampled} sampled epoch(s) only`
      : 'No RANGE (#43) record in this capture — nothing to count.';

    /* Symbolic sky dots: one per tracked PRN, spread by a golden-angle walk so neighbouring PRNs
       do not overlap. RANGE has no az/el, so the position is explicitly not a sky position. */
    paintSky(symbolicSky(dots));
  }

  /* ---- sky plot painting (shared: capture is always symbolic, live prefers SATVIS2) ---- */

  function paintSky(dots) {
    if (!el.skySats) return;
    el.skySats.innerHTML = dots
      .map(
        (dot) =>
          `<g class="mg-sky-dot mg-sky-dot-${esc(dot.tone)}">` +
          `<circle cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="10"/>` +
          `<text x="${dot.x.toFixed(1)}" y="${(dot.y + 3.6).toFixed(1)}">${esc(dot.label)}</text>` +
          '</g>',
      )
      .join('');
  }

  function symbolicSky(prns) {
    return prns.map((dot, index) => {
      const angle = (-90 + index * 137.508) * (Math.PI / 180);
      const radius = 34 + ((index * 29) % 104);
      return {
        label: String(dot.prn),
        tone: dot.tone,
        x: 150 + Math.cos(angle) * radius,
        y: 150 + Math.sin(angle) * radius,
      };
    });
  }

  /** Real sky positions from SATVIS2: azimuth clockwise from north, elevation from the horizon. */
  function satvisSky() {
    const dots = [];
    for (const item of CONSTELLATIONS) {
      const visible = live.satvis.get(item.key);
      if (!visible) continue;
      for (const satellite of visible.satellites ?? []) {
        const elevation = numberOrNaN(satellite.elevation);
        const azimuth = numberOrNaN(satellite.azimuth);
        if (!Number.isFinite(elevation) || !Number.isFinite(azimuth) || elevation <= 0) continue;
        const radius = ((90 - Math.min(90, elevation)) / 90) * 140;
        const angle = (azimuth * Math.PI) / 180;
        dots.push({
          label: String(satellite.id),
          tone: item.tone,
          x: 150 + Math.sin(angle) * radius,
          y: 150 - Math.cos(angle) * radius,
        });
      }
    }
    return dots;
  }

  /* ---- live mode: the four tiles read the receiver's own records ---- */

  function renderLiveDashboard() {
    renderLivePosition();
    renderLiveDevice();
    const interference = live.latest.get(ITDETECTSTATUS);
    renderInterference(
      interference ? { entries: interference.data.entries, time: interference.time } : null,
      'live',
    );
    renderLiveSatellite();
  }

  function renderLivePosition() {
    const cached = live.latest.get(BESTPOS);
    const p = cached ? cached.data : null;
    const columns = [
      el.bandPosition,
      el.bandLat,
      el.bandLon,
      el.bandHeight,
      el.posMode,
      el.posPosition,
      el.posLat,
      el.posLon,
      el.posHeight,
      el.posHeightAcc,
      el.pos2d,
      el.posDatum,
    ];
    if (!p) {
      for (const node of columns) setText(node, '--');
      setBadge(el.bandPosBadge, 'unknown');
      setBadge(el.cardPosBadge, 'unknown');
      setText(el.posReason, 'Live · 还没有收到 BESTPOS (#42) — 这一路流没有位置报文，字段保持 --。');
      return;
    }

    const solved = p.solutionStatus === 'SOL_COMPUTED';
    const tone = solved ? 'good' : 'warn';
    const position = p.positionType ? titleCase(p.positionType) : '--';
    const lat = withFixed(p.latitude, 7, '°');
    const lon = withFixed(p.longitude, 7, '°');
    const height = withFixed(p.height, 2, ' m');
    const latDev = numberOrNaN(p.latitudeDeviation);
    const lonDev = numberOrNaN(p.longitudeDeviation);
    const twoSigma = Number.isFinite(latDev) && Number.isFinite(lonDev) ? Math.sqrt(latDev * latDev + lonDev * lonDev) : NaN;

    setText(el.bandPosition, position);
    setText(el.bandLat, lat);
    setText(el.bandLon, lon);
    setText(el.bandHeight, height);

    setText(el.posMode, p.solutionStatus || '--');
    setText(el.posPosition, position);
    setText(el.posLat, lat);
    setText(el.posLon, lon);
    setText(el.posHeight, height);
    setText(el.posHeightAcc, withFixed(p.heightDeviation, 2, ' m'));
    setText(el.pos2d, withFixed(twoSigma, 2, ' m'));
    setText(el.posDatum, p.datumId || '--');

    setBadge(el.bandPosBadge, tone);
    setBadge(el.cardPosBadge, tone);
    const used = Number.isFinite(numberOrNaN(p.satellitesUsed)) ? `${p.satellitesUsed} used` : 'used --';
    const tracked = Number.isFinite(numberOrNaN(p.satellitesTracked)) ? `${p.satellitesTracked} tracked` : 'tracked --';
    setText(el.posReason, `Live · BESTPOS (#42) ${utcClock(cached.time)} UTC · ${used} / ${tracked}`);
  }

  function sensorOf(sensors, types) {
    for (const type of types) {
      const hit = sensors.find((sensor) => sensor.type === type);
      if (hit) return hit;
    }
    return null;
  }

  /** Worst boundary limit across the readings on screen; a missing reading is simply absent. */
  function worstTone(readings) {
    const rank = { unknown: 0, good: 1, warn: 2, bad: 3 };
    let worst = 'unknown';
    for (const reading of readings) {
      const tone = sensorTone(reading);
      if (rank[tone] > rank[worst]) worst = tone;
    }
    return worst;
  }

  function renderLiveDevice() {
    const hwCached = live.latest.get(HWMONITOR);
    const hw = hwCached ? hwCached.data : null;
    const versionCached = live.latest.get(VERSION_LOG);
    const version = versionCached ? versionCached.data : null;
    const sensors = hw?.sensors ?? [];
    const temperature = sensorOf(sensors, HW_TYPES.temperature);
    const current = sensorOf(sensors, HW_TYPES.antennaCurrent);
    const voltage = sensorOf(sensors, HW_TYPES.antennaVoltage);
    const idleTime = numberOrNaN(hw?.idleTime);
    const cpu = Number.isFinite(idleTime) ? Math.max(0, Math.min(100, 100 - idleTime / 2)) : NaN;

    const temp = temperature ? withFixed(temperature.value, 0, ' °C') : '--';
    const volt = voltage ? withFixed(voltage.value, 1, ' V') : '--';
    const amp = current ? withFixed(current.value * 1000, 1, ' mA') : '--';
    const cpuText = Number.isFinite(cpu) ? `${cpu.toFixed(0)} %` : '--';

    setText(el.devCpu, cpuText);
    setText(el.devTemp, temp);
    setText(el.devVoltage, volt);
    setText(el.devCurrent, amp);

    setBadge(el.devCpuBadge, Number.isFinite(cpu) ? 'good' : 'unknown');
    setBadge(el.devTempBadge, sensorTone(temperature));
    setBadge(el.devVoltageBadge, sensorTone(voltage));
    setBadge(el.devCurrentBadge, sensorTone(current));

    const model = version ? version.hardwareVersion || version.model : '';
    setText(el.bandModel, model || '--');
    setText(el.bandCpu, cpuText);
    setText(el.bandLogging, '--');
    setText(
      el.bandInterference,
      interferenceText(live.latest.get(ITDETECTSTATUS)?.data) ?? '--',
    );
    setText(el.bandTime, live.lastRecordAt ? `${utcClock(live.lastRecordAt)} UTC` : '--');

    const tone = worstTone([temperature, voltage, current]);
    setBadge(el.bandDevBadge, hw ? (tone === 'unknown' ? 'good' : tone) : 'unknown');
    el.bandDevBadge.title = hw
      ? 'Device health from the live HWMONITOR (#963) boundary limits.'
      : 'No HWMONITOR (#963) in the live stream.';

    const reasons = [];
    reasons.push(hwCached ? `HWMONITOR (#963) ${utcClock(hwCached.time)} UTC` : 'HWMONITOR (#963) 未到达');
    reasons.push(
      version
        ? `Model: VERSION (#37) ${version.model || version.hardwareVersion || '--'}${version.softwareVersion ? ` / ${version.softwareVersion}` : ''}`
        : 'Model: 流里没有 VERSION (#37)',
    );
    reasons.push(Number.isFinite(idleTime) ? 'CPU Usage = 100 − idleTime / 2' : 'CPU Usage: 这一路没有 idleTime，保持 --');
    reasons.push('Logging: 需要 FILESTATUS (#2127)/LOGLIST (#5)，未读取');
    setText(el.devReason, `Live · ${reasons.join(' · ')}`);
  }

  function renderLiveSatellite() {
    const newest = live.ranges.length ? live.ranges[live.ranges.length - 1] : null;
    const inUse = new Map();
    const seen = new Map();
    const add = (map, system, prn) => {
      if (!map.has(system)) map.set(system, new Set());
      map.get(system).add(prn);
    };
    if (newest) for (const observation of newest.observations) add(inUse, observation.system, observation.prn);
    for (const range of live.ranges) {
      for (const observation of range.observations) add(seen, observation.system, observation.prn);
    }

    let inUseTotal = 0;
    let satvisTotal = 0;
    const symbolic = [];
    for (const item of CONSTELLATIONS) {
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (!newest || item.system === null) {
        if (useNode) useNode.textContent = '--';
        if (idleNode) idleNode.textContent = '--';
        if (missNode) missNode.textContent = '--';
        continue;
      }
      const inUseSet = inUse.get(item.system) ?? new Set();
      const seenSet = seen.get(item.system) ?? new Set();
      const notUsed = Math.max(0, seenSet.size - inUseSet.size);
      inUseTotal += inUseSet.size;
      if (useNode) useNode.textContent = String(inUseSet.size);
      if (idleNode) idleNode.textContent = String(notUsed);

      const visible = live.satvis.get(item.key);
      if (visible) {
        const missing = (visible.satellites ?? []).filter(
          (satellite) => numberOrNaN(satellite.elevation) > 0 && !inUseSet.has(satellite.id),
        ).length;
        satvisTotal += (visible.satellites ?? []).length;
        if (missNode) missNode.textContent = String(missing);
      } else if (missNode) {
        missNode.textContent = '--';
      }

      for (const prn of [...inUseSet].sort((a, b) => a - b)) symbolic.push({ prn, tone: item.tone });
    }

    const liveBadge = newest ? (inUseTotal > 0 ? 'good' : 'warn') : 'unknown';
    setBadge(el.satBadge, liveBadge);

    const when = newest ? `${utcClock(newest.time)} UTC` : '—';
    const source = satvisTotal > 0
      ? '星点来自 SATVIS2 (#1043) 的实际方位角/高度角'
      : '流里没有 SATVIS2 (#1043)，星点按符号位置摆放';
    setText(
      el.satNote,
      newest
        ? `Live · RANGE (#43) ${when} · ${inUseTotal} 个在用 PRN · In Use = 最新历元，Not Used = 本次会话更早历元见过 · ${source}`
        : 'Live · 还没有收到 RANGE (#43) — 星座计数与星点保持 --。',
    );

    const real = satvisSky();
    paintSky(real.length ? real : symbolicSky(symbolic));
  }

  /* ---- lost mode: show the gap, never substitute captured values ---- */

  function renderLostDashboard() {
    const when = live.disconnectedAt ? `${utcClock(live.disconnectedAt)} UTC` : '—';
    const error = live.lastError ? `（${live.lastError}）` : '';

    for (const node of [
      el.bandPosition,
      el.bandLat,
      el.bandLon,
      el.bandHeight,
      el.posMode,
      el.posPosition,
      el.posLat,
      el.posLon,
      el.posHeight,
      el.posHeightAcc,
      el.pos2d,
      el.posDatum,
    ]) {
      setText(node, '--');
    }
    setBadge(el.bandPosBadge, 'unknown');
    setBadge(el.cardPosBadge, 'unknown');
    setText(el.posReason, `Live lost · 会话在 ${when} 断开${error} — 位置字段回到 --，不会改用抓包数据。`);

    setText(el.devCpu, '--');
    setText(el.devTemp, '--');
    setText(el.devVoltage, '--');
    setText(el.devCurrent, '--');
    setBadge(el.devCpuBadge, 'unknown');
    setBadge(el.devTempBadge, 'unknown');
    setBadge(el.devVoltageBadge, 'unknown');
    setBadge(el.devCurrentBadge, 'unknown');
    setText(el.bandModel, '--');
    setText(el.bandCpu, '--');
    setText(el.bandLogging, '--');
    setText(el.bandInterference, '--');
    setText(el.bandTime, '--');
    setBadge(el.bandDevBadge, 'unknown');
    el.bandDevBadge.title = 'The live session closed; no device readings are available.';
    setText(el.devReason, `Live lost · 会话在 ${when} 断开 — Device 读数不可用，重新连接后自动恢复。`);

    setText(el.interference, '--');
    setBadge(el.intBadge, 'unknown');
    setText(el.intReason, 'Live lost · 会话已断开 — 没有干扰检测数据。');

    for (const item of CONSTELLATIONS) {
      for (const suffix of ['use', 'idle', 'missing']) {
        const node = satCount[`${item.key}-${suffix}`];
        if (node) node.textContent = '--';
      }
    }
    setBadge(el.satBadge, 'unknown');
    setText(el.satNote, `Live lost · 会话在 ${when} 断开 — 星座计数与星点已清空。`);
    paintSky([]);
  }

  /* ---- loading ---- */

  async function probe(msgId) {
    try {
      const data = await api.get('/api/records', { capture: state.capture, msgId, limit: 1 });
      return data.records && data.records[0] ? data.records[0] : null;
    } catch {
      return null;
    }
  }

  async function openCapture(capture) {
    if (!capture) return;
    const token = (state.token += 1);
    const stale = () => !state.alive || token !== state.token;
    state.capture = capture;
    state.open = true;
    state.version = null;
    state.interference = null;
    setBodyState();
    renderDeviceShell();

    /* A live dashboard owns the tiles: do not parse a 3 MB capture the user cannot see, and do
     * not let a slower capture response overwrite live values. */
    if (liveMode() === 'live') {
      render();
      return;
    }

    alert('');
    setText(el.bandTime, '--');

    let logs = null;
    try {
      logs = await api.get('/api/logs', { capture });
    } catch (error) {
      if (!stale()) alert(`Capture statistics failed: ${error.message}`);
    }
    if (stale()) return;
    state.logs = logs;

    /* A capture without BESTPOS / HWMONITOR / RANGE still shows the dashboard: every probe fails
       soft and leaves `--` behind. */
    const [bestpos, hw, version, interference] = await Promise.all([
      probe(BESTPOS),
      probe(HWMONITOR),
      probe(VERSION_LOG),
      probe(ITDETECTSTATUS),
    ]);
    if (stale()) return;
    state.position = readPosition(bestpos);
    state.device = readDevice(hw);
    state.version = readVersion(version);
    state.interference = readInterference(interference);

    let latest = '';
    if (logs && Array.isArray(logs.groups)) {
      for (const group of logs.groups) {
        if (group.lastUtc && group.lastUtc > latest) latest = group.lastUtc;
      }
    }
    state.time = latest ? utcClock(latest) : '';

    render();

    try {
      state.range = await loadRange(capture);
    } catch {
      state.range = null; // an unreadable RANGE only empties the counters
    }
    if (stale()) return;
    render();
  }

  function closeCapture() {
    state.open = false;
    state.logs = null;
    state.position = null;
    state.device = null;
    state.range = null;
    state.version = null;
    state.interference = null;
    setBodyState();
    renderAppBar();
    renderList();
  }

  async function boot() {
    try {
      const data = await api.get('/api/captures');
      if (!state.alive) return;
      state.captures = data.captures ?? [];
    } catch (error) {
      if (state.alive) alert(`Capture list failed: ${error.message}`);
    }
    if (!state.alive) return;

    /* A session may already be open (Tools ▸ Terminal connects without leaving this page, and a
     * reload must not drop back to a capture while the receiver is streaming). */
    await livePoll();
    if (!state.alive) return;
    if (liveMode() === 'live') {
      state.open = true;
      setBodyState();
      renderDeviceShell();
      render();
      startLivePolling();
      return;
    }

    /* ctx.capture is empty on the very first mount (the shell fills its picker asynchronously),
       so the panel picks the same default the shell does. */
    const wanted =
      (state.capture && state.captures.some((item) => item.path === state.capture) && state.capture) ||
      (ctx.capture && state.captures.some((item) => item.path === ctx.capture) && ctx.capture) ||
      state.captures.find((item) => item.path === 'convert/clean-9600.gps')?.path ||
      state.captures[0]?.path ||
      '';

    if (wanted) await openCapture(wanted);
    else closeCapture();
    startLivePolling();
  }

  /* ---- events ---- */

  /** The injected app-bar node: the file tab is the current page, the ✕ closes it again. */
  const onAppTabClick = (event) => {
    event.preventDefault();
    if (event.target.closest('.mg-filetab-close')) closeCapture();
  };
  const onListClick = (event) => {
    const open = event.target.closest('[data-open]');
    if (!open) return;
    openCapture(open.dataset.open);
  };
  const onHelpClick = (event) => {
    const node = event.target.closest('[data-help]');
    if (!node) return;
    event.preventDefault();
  };

  /* Tools ▸ Terminal / Events / Device ▸ .cfg, and the Configuration drawer. */
  const closeDrops = () => {
    root.querySelectorAll('[data-drop]').forEach((node) => {
      node.hidden = true;
    });
    root.querySelectorAll('[data-submenu]').forEach((node) => {
      node.setAttribute('aria-expanded', 'false');
    });
  };
  const onMenuClick = (event) => {
    /* A nested flyout is opened by its own button and must not run the leaf action. Its parent
     * dropdown has to stay open, otherwise `closeDrops()` would hide the flyout along with it. */
    const submenu = event.target.closest('[data-submenu]');
    if (submenu) {
      const host = submenu.closest('.mg-drop-nested');
      const drop = host ? host.querySelector('[data-drop]') : null;
      const parentDrop = submenu.closest('.mg-drop');
      const wasOpen = drop ? !drop.hidden : false;
      closeDrops();
      if (parentDrop) parentDrop.hidden = false;
      if (drop && !wasOpen) {
        drop.hidden = false;
        submenu.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    const button = event.target.closest('[data-menu]');
    if (button) {
      const key = button.dataset.menu;
      if (key === 'configuration') {
        closeDrops();
        void openConfigDrawer();
        return;
      }
      const host = button.closest('.mg-drop-host');
      const drop = host ? host.querySelector('[data-drop]') : null;
      const wasOpen = drop ? !drop.hidden : false;
      closeDrops();
      if (drop && !wasOpen) drop.hidden = false;
      return;
    }
    const dropItem = event.target.closest('[data-menu-item]');
    if (!dropItem) return;
    const key = dropItem.dataset.menuItem;
    closeDrops();
    if (key === 'terminal') termOpen();
    else if (key === 'events') void openConfigDrawer('events');
    else if (SETTINGS_PAGES.has(key)) void openConfigDrawer(key);
    else if (key === 'exportCfg') openDeviceModal('export');
    else if (key === 'importCfg') openDeviceModal('import');
  };
  const onConfigClick = (event) => {
    const node = event.target.closest('[data-config]');
    if (!node) return;
    if (node.dataset.config === 'close') closeConfigDrawer();
  };
  const onConfigChange = (event) => {
    if (!event.target.matches('[data-config="page"]')) return;
    setConfigFrame(event.target.value);
  };
  const onCfgClick = (event) => {
    const node = event.target.closest('[data-cfg]');
    if (!node) return;
    const action = node.dataset.cfg;
    if (action === 'close') closeDeviceModal();
    else if (action === 'refresh') void loadDeviceStatus();
    else if (action === 'download') void downloadCfg();
    else if (action === 'parse') void parseCfg();
    else if (action === 'import') void importCfg();
  };
  const onCfgTabClick = (event) => {
    const node = event.target.closest('[data-cfg-tab]');
    if (!node) return;
    selectCfgTab(node.dataset.cfgTab);
    if (node.dataset.cfgTab === 'export') void loadDeviceStatus();
  };
  const onCfgFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (fileEls.text) fileEls.text.value = String(reader.result ?? '');
      void parseCfg();
    };
    reader.readAsText(file);
  };
  const onTermClick = (event) => {
    const button = event.target.closest('[data-term]');
    if (!button) return;
    const action = button.dataset.term;
    if (action === 'close') termClose();
    else if (action === 'connect') void termConnect();
    else if (action === 'disconnect') void termDisconnect();
  };
  const onTermSubmit = (event) => {
    if (!event.target.matches('[data-term="form"]')) return;
    event.preventDefault();
    const line = termEls.line?.value ?? '';
    if (termEls.line) termEls.line.value = '';
    void termSend(line);
  };
  /** The mode strip's buttons: Connect/Reconnect opens the Terminal drawer, Disconnect closes the
   *  session, Back to capture replay is the only way out of "Live lost". */
  const onModeAction = (event) => {
    const button = event.target.closest('[data-mode-action]');
    if (!button) return;
    const action = button.dataset.modeAction;
    if (action === 'connect') termOpen();
    else if (action === 'disconnect') void termDisconnect();
    else if (action === 'replay') {
      live.dismissed = true;
      if (state.capture) void openCapture(state.capture);
      else closeCapture();
      render();
    }
  };


  if (appTab) {
    appTab.addEventListener('click', onAppTabClick);
  }
  el.listCards.addEventListener('click', onListClick);
  el.device.addEventListener('click', onHelpClick);
  el.device.addEventListener('click', onMenuClick);
  el.device.addEventListener('click', onModeAction);
  if (el.config) {
    el.config.addEventListener('click', onConfigClick);
    el.config.addEventListener('change', onConfigChange);
  }
  if (el.cfg) {
    el.cfg.addEventListener('click', onCfgClick);
    el.cfg.addEventListener('click', onCfgTabClick);
    el.cfg.addEventListener('change', onCfgFile);
  }
  if (el.terminal) {
    el.terminal.addEventListener('click', onTermClick);
    el.terminal.addEventListener('submit', onTermSubmit);
  }

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || !state.alive) return;
      if (state.open && name === state.capture) return;
      openCapture(name);
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__manageCleanup = () => {
    state.alive = false;
    stopLivePolling();
    el.listCards.removeEventListener('click', onListClick);
    el.device.removeEventListener('click', onHelpClick);
    el.device.removeEventListener('click', onMenuClick);
    el.device.removeEventListener('click', onModeAction);
    if (el.config) {
      el.config.removeEventListener('click', onConfigClick);
      el.config.removeEventListener('change', onConfigChange);
    }
    if (el.cfg) {
      el.cfg.removeEventListener('click', onCfgClick);
      el.cfg.removeEventListener('click', onCfgTabClick);
      el.cfg.removeEventListener('change', onCfgFile);
    }
    if (el.terminal) {
      el.terminal.removeEventListener('click', onTermClick);
      el.terminal.removeEventListener('submit', onTermSubmit);
    }
    if (appTab) {
      appTab.removeEventListener('click', onAppTabClick);
      appTab.remove();
    }
    if (offCapture) offCapture();
    if (document.body.dataset.manageState) delete document.body.dataset.manageState;
  };

  boot();
}

export default { mount, unmount };
