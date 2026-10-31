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
 * Where the numbers come from (all of them from the local JSON API, nothing invented):
 *   BESTPOS #42    first record      → band left half + Positioning tile
 *   HWMONITOR #963 measurements[]    → Device tile + band right half; the status word's high byte
 *                                      is the reading type (1 temperature · 2 antenna current ·
 *                                      7 antenna voltage), its low byte the boundary limit
 *   RANGE #43      sv_prn + c_status → constellation counts (`(c_status >> 16) & 7`, the same
 *                                      table as `graph/src/range-charts.ts`); no azimuth/elevation
 *                                      is carried by RANGE, so the sky dots are symbolic
 *   ITK / ITDETECTSTATUS and VERSION / FILESTATUS are **not** in these captures: Interference
 *   reads "Not detected" (as the original does when nothing is detected) and Model / CPU Usage /
 *   Logging print `--` — the same honest gap Playback already prints.
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
 * 4 upper error). Binary HWMONITOR carries no `idleTime`, so CPU Usage has no source here.
 */
const HW_TYPES = { temperature: [1, 22], antennaCurrent: [2], antennaVoltage: [7], cpuUsage: [] };

/**
 * The black bar under the app bar. Only `Status` is a real page in this build; the other four are
 * rendered as the original's dropdowns (`▾`) but disabled, with the reason in `title` — the same
 * honest marking Convert uses for its unwired formats.
 */
const MENU = [
  { key: 'status', label: 'Status', icon: 'status', caret: false, wired: true },
  { key: 'configuration', label: 'Configuration', icon: 'configuration', caret: false, wired: false },
  { key: 'settings', label: 'Settings', icon: 'settings', caret: true, wired: false },
  {
    key: 'tools',
    label: 'Tools',
    icon: 'tools',
    caret: true,
    wired: true,
    items: [
      { key: 'terminal', label: 'Terminal', wired: true },
      { key: 'events', label: 'Events', wired: false },
    ],
  },
  { key: 'device', label: 'Device', icon: 'device', caret: true, wired: false },
];

const UNWIRED_NOTE =
  'Not wired in this build: the local API only serves Status (this page) from a capture — ' +
  'the other pages need a live receiver.';

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
    const entries = item.items
      .map(
        (entry) =>
          `<button type="button" class="mg-drop-item${entry.wired ? '' : ' is-off'}" ` +
          `data-menu-item="${esc(entry.key)}" role="menuitem" ` +
          `${entry.wired ? '' : `aria-disabled="true" disabled title="${esc(UNWIRED_NOTE)}"`}>` +
          `${esc(entry.label)}</button>`,
      )
      .join('');
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
        <button type="button" class="mg-help" data-help="positioning"
                title="Positioning comes from the first BESTPOS (#42) record of the capture: Operating Mode is solution_status, Position is position_type, Height Accuracy is height_std_dev, 2d-SD is sqrt(latitude_std_dev² + longitude_std_dev²).">Help</button>
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
        <button type="button" class="mg-help" data-help="device"
                title="Device readings are HWMONITOR (#963) measurements[]: the status word's high byte is the reading type (1 temperature · 2 antenna current · 7 antenna voltage), the low byte the boundary limit the badge reports. The binary log carries no idleTime, so CPU Usage has no source and prints --.">Help</button>
      </section>

      <section class="mg-card" data-area="interference">
        <div class="mg-card-head">
          <h2 class="mg-heading">Interference</h2>
          <span class="mg-badge mg-badge-good" data-tone="good">Good</span>
        </div>
        <p class="mg-interference" data-el="interference">Not detected</p>
        <button type="button" class="mg-help" data-help="interference"
                title="Interference needs ITDETECTSTATUS (#2065) / the ITK logs, which this capture does not contain. The original prints Not detected when the receiver reports no interference; no number is invented here.">Help</button>
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
                title="Satellite View counts RANGE (#43) observations: system = (c_status >> 16) & 7 (0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC), In Use = distinct sv_prn in the last epoch of the capture, Not Used = PRNs seen in earlier epochs only. RANGE carries no azimuth/elevation, so the sky dots are symbolic; Missing needs SATVIS2, absent here.">Help</button>
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

  /* ---------------- terminal (the live link behind Tools ▸ Terminal) ---------------- */

  const term = { open: false, cursor: 0, timer: 0, lines: [] };
  const termEls = {};
  for (const node of root.querySelectorAll('[data-term]')) termEls[node.dataset.term] = node;

  function termStatus(text) {
    if (termEls.status) termEls.status.textContent = text;
  }
  function termAppend(text) {
    term.lines.push(text);
    if (term.lines.length > 400) term.lines.splice(0, term.lines.length - 400);
    if (termEls.output) {
      termEls.output.textContent = term.lines.join('\n');
      termEls.output.scrollTop = termEls.output.scrollHeight;
    }
  }
  async function termRefresh() {
    try {
      const status = await api.get('/api/live/status');
      const base = status.connected ? `Connected — ${status.target} — ${status.records} records` : 'Not connected';
      termStatus(status.lastError ? `${base} — ${status.lastError}` : base);
      const page = await api.get('/api/live/logs', { after: term.cursor });
      term.cursor = page.cursor ?? term.cursor;
      for (const entry of page.entries ?? []) {
        termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
      }
    } catch (error) {
      termStatus(`API error: ${error.message}`);
    }
  }
  function termStartPolling() {
    termStopPolling();
    term.timer = setInterval(termRefresh, 800);
    void termRefresh();
  }
  function termStopPolling() {
    if (term.timer) {
      clearInterval(term.timer);
      term.timer = 0;
    }
  }
  async function termConnect() {
    const path = (termEls.path?.value ?? '').trim();
    const body = path
      ? { kind: 'serial', path, baud: Number(termEls.baud?.value) || 115200 }
      : { kind: 'tcp', host: (termEls.host?.value ?? '').trim() || '127.0.0.1', port: Number(termEls.port?.value) || 3001 };
    try {
      const status = await api.post('/api/live/connect', body);
      term.cursor = 0;
      term.lines = [];
      termAppend(`Connected to ${status.target}`);
      termStartPolling();
    } catch (error) {
      termAppend(`Connect failed: ${error.message}`);
    }
  }
  async function termDisconnect() {
    try {
      await api.post('/api/live/disconnect', {});
      termAppend('Disconnected');
      termStopPolling();
      termStatus('Not connected');
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
      termRefresh();
    } catch (error) {
      termAppend(`> ${line}   (${error.message})`);
    }
  }
  function termOpen() {
    term.open = true;
    if (el.terminal) el.terminal.hidden = false;
    termStartPolling();
    termEls.line?.focus();
  }
  function termClose() {
    term.open = false;
    if (el.terminal) el.terminal.hidden = true;
    termStopPolling();
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
      return;
    }
    appTab.hidden = false;
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
    const temp = d?.temperature ? `${fixed(d.temperature.value, 0)} °C` : '--';
    const volt = d?.antennaVoltage ? `${fixed(d.antennaVoltage.value, 1)} V` : '--';
    const amp = d?.antennaCurrent ? `${fixed(d.antennaCurrent.value * 1000, 1)} mA` : '--';
    const cpu = d?.cpuUsage ? `${fixed(d.cpuUsage.value, 0)} %` : '--';

    setText(el.devCpu, cpu);
    setText(el.devTemp, temp);
    setText(el.devVoltage, volt);
    setText(el.devCurrent, amp);

    setBadge(el.devCpuBadge, d?.cpuUsage ? sensorTone(d.cpuUsage) : 'unknown');
    setBadge(el.devTempBadge, sensorTone(d?.temperature));
    setBadge(el.devVoltageBadge, sensorTone(d?.antennaVoltage));
    setBadge(el.devCurrentBadge, sensorTone(d?.antennaCurrent));

    // Band right half: only what the capture can actually answer.
    setText(el.bandModel, '--'); // needs VERSION (#37), absent from these captures
    setText(el.bandCpu, cpu);
    setText(el.bandLogging, '--'); // needs FILESTATUS (#2127) / LOGLIST (#5)
    setText(el.bandInterference, 'Not detected'); // ITK / ITDETECTSTATUS absent — no number invented
    setText(el.bandTime, state.time || '--');

    const complete = Boolean(d && d.temperature && d.antennaVoltage && d.antennaCurrent);
    setBadge(el.bandDevBadge, complete || d ? 'good' : 'warn');
    // The band's badge follows the readings the capture can answer; a missing CPU usage stays a
    // `--` in its own row rather than turning the whole device amber.
    el.bandDevBadge.title = d
      ? 'Device health from the HWMONITOR (#963) boundary limits; CPU Usage / Logging have no source in a capture.'
      : 'No HWMONITOR (#963) record in this capture.';
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
    const skyNodes = el.skySats;
    if (skyNodes) {
      const cx = 150;
      const cy = 150;
      skyNodes.innerHTML = dots
        .map((dot, index) => {
          const angle = (-90 + index * 137.508) * (Math.PI / 180);
          const radius = 34 + ((index * 29) % 104);
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          return (
            `<g class="mg-sky-dot mg-sky-dot-${esc(dot.tone)}">` +
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"/>` +
            `<text x="${x.toFixed(1)}" y="${(y + 3.6).toFixed(1)}">${esc(dot.prn)}</text>` +
            '</g>'
          );
        })
        .join('');
    }
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
    setBodyState();
    renderAppBar();
    renderDeviceShell();
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
    const [bestpos, hw] = await Promise.all([probe(BESTPOS), probe(HWMONITOR)]);
    if (stale()) return;
    state.position = readPosition(bestpos);
    state.device = readDevice(hw);

    let latest = '';
    if (logs && Array.isArray(logs.groups)) {
      for (const group of logs.groups) {
        if (group.lastUtc && group.lastUtc > latest) latest = group.lastUtc;
      }
    }
    state.time = latest ? utcClock(latest) : '';

    renderPosition();
    renderDevice();

    try {
      state.range = await loadRange(capture);
    } catch {
      state.range = null; // an unreadable RANGE only empties the counters
    }
    if (stale()) return;
    renderSatellite();
  }

  function closeCapture() {
    state.open = false;
    state.logs = null;
    state.position = null;
    state.device = null;
    state.range = null;
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

  /* Tools ▸ Terminal: the only menu entry that does real work in this build. */
  const onMenuClick = (event) => {
    const dropItem = event.target.closest('[data-menu-item]');
    if (dropItem) {
      const key = dropItem.dataset.menuItem;
      if (key === 'terminal') termOpen();
      root.querySelectorAll('[data-drop]').forEach((node) => {
        node.hidden = true;
      });
      return;
    }
    const button = event.target.closest('[data-menu]');
    if (!button) return;
    const host = button.closest('.mg-drop-host');
    const drop = host ? host.querySelector('[data-drop]') : null;
    root.querySelectorAll('[data-drop]').forEach((node) => {
      if (node !== drop) node.hidden = true;
    });
    if (drop) drop.hidden = !drop.hidden;
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


  if (appTab) {
    appTab.addEventListener('click', onAppTabClick);
  }
  el.listCards.addEventListener('click', onListClick);
  el.device.addEventListener('click', onHelpClick);
  el.device.addEventListener('click', onMenuClick);
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
    termStopPolling();
    el.listCards.removeEventListener('click', onListClick);
    el.device.removeEventListener('click', onHelpClick);
    el.device.removeEventListener('click', onMenuClick);
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
