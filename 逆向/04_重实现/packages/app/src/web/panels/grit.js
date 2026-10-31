/**
 * GRIT Monitor panel — the device dashboard of the receiver app.
 *
 * Reference screen: `ref-ui/grit-open.png` (2560×1600 at 150 %, i.e. 1706×1066 CSS).
 * Everything below is measured off that image; every block quotes the CSS-px numbers it
 * was built to, so the numbers can be re-checked against the reference.
 *
 * Structure, top to bottom (the app bar above it belongs to the shell — `index.html`
 * `#tabs-list`, 36 px banner + 34 px strip = the original's 70 px app bar; this panel only
 * injects the file tab and the `+ Add Device` button into that strip while it is mounted):
 *
 *   1. menu bar        `.grit-menubar`, 50 px, #000: Dashboard · Settings▾ · Tools▾ · Help▾,
 *                      bell + count badge on the right
 *   2. status band     `.grit-band`, 135 px, #E4E4E4 + 1 px #B6B6B6 bottom:
 *                      Positioning [Good] (Position/Latitude/Longitude + Height (MSL)/
 *                      Satellite Tracked/Satellite Used) | divider | Device [Good]
 *                      (Model/CPU Usage/Time (UTC) + Interference/Jamming)
 *   3. four tiles      `.tile` from `css/style.css:379` — 392 px wide, 1 px #005170 border,
 *                      #FCFCFC, padding 15/9/9/15, 26 px gutter:
 *                      Mitigation Assistant | Spectrum Viewer
 *                      Signal Matrix        | Position Overview
 *   4. Timeline ▲      collapsed dock, bottom right (same idea as the Playback panel's dock)
 *
 * Where the numbers come from — all of it from the local JSON API, nothing invented:
 *   BESTPOS   #42  last record → Positioning + the time shown as `Time (UTC)`
 *   RANGE     #43  last epoch   → `Satellite Tracked` (distinct `sv_prn`), the Signal Matrix
 *                  counts, and `Satellite Used` via BESTPOS `num_soln_svs` (the RANGE epoch
 *                  of this receiver carries 65 observations but only 25 distinct PRNs, which
 *                  is exactly BESTPOS `num_svs` — the same two numbers the Playback panel
 *                  derives, see `panels/playback.js` CONSTELLATIONS/SYSTEM_*)
 *   HWMONITOR #963 first record → CPU Usage / Model. Not every capture has it; when it is
 *                  absent the field stays `--` rather than being guessed.
 *
 * Blocks that are deliberately empty on this build, because the data is not in the capture:
 *   Interference / Jamming / Mitigation Assistant → `Not detected` (no ITK in any sample)
 *   Spectrum Viewer                                → axes + band chips + the note
 *                                                    "No spectrum data in this capture"
 *   Position Overview                              → blank canvas (no basemap renderer here)
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./grit.css', import.meta.url).href;
const CSS_ID = 'nas-panel-grit-css';

/** Message ids this page reads (SBF). */
const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;

/** `system` = `(c_status >> 16) & 7` — the same three bits `packages/graph/src/range-charts.ts`
 *  and `panels/playback.js` use. */
const SYSTEM_GPS = 0;
const SYSTEM_SBAS = 2;
const SYSTEM_BDS = 4;
const SYSTEM_QZSS = 5;

/**
 * `sv_freq` → band. NovAtel numbers this per constellation and 0 is always the constellation's
 * primary band (L1 / B1 / E1); 5 and 9 are the GPS/QZSS L2/L5 channel numbers, 205 marks the
 * L-band correction channel (`sv_freq` 205 shows up on this receiver's LBAND channel).
 * Anything outside this table falls back to L1 — the capture itself is the authority and it
 * is reported as-is rather than spread over bands it never named.
 */
const FREQ_BAND = { 0: 'L1', 5: 'L2', 9: 'L5', 205: 'LBAND' };

/** Signal Matrix rows, in the original's DOM order. `system` null = not a RANGE constellation. */
const MATRIX_ROWS = [
  { key: 'gps', label: 'GPS', system: SYSTEM_GPS },
  { key: 'bds', label: 'BDS', system: SYSTEM_BDS },
  { key: 'qzss', label: 'QZSS', system: SYSTEM_QZSS },
  { key: 'lband', label: 'LBAND', system: null },
  { key: 'sbas', label: 'SBAS', system: SYSTEM_SBAS },
];

const MATRIX_BANDS = ['L5', 'L2', 'L1'];

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

function baseName(path) {
  const text = String(path ?? '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

/** `SINGLE` → `Single`, like the original's `.grit_configuredPositions` labels. */
function titleCase(text) {
  const value = String(text ?? '');
  if (!value) return '--';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function hhmmss(iso, fallbackSeconds) {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso ?? ''));
  if (match) return match[1];
  if (Number.isFinite(fallbackSeconds)) {
    const total = ((fallbackSeconds % 86400) + 86400) % 86400;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  }
  return '--:--:--';
}

function fieldMap(record) {
  const map = {};
  for (const field of record?.fields ?? []) {
    if (!field || typeof field.path !== 'string') continue;
    // Observed SBF logs repeat `sv_prn` for every observation; keep the first level keys and
    // let `readObservations` walk the `obs[i].*` paths itself.
    // Enumerated fields (`position_type`) carry the number in `value` and the readable name in
    // `text` ("SINGLE") — the readable one is what the original prints on the band.
    map[field.path] = field.text === undefined || field.text === null ? field.value : field.text;
  }
  return map;
}

/** `obs[3].sv_prn` style paths → array of per-observation objects. */
function readObservations(record) {
  const observations = [];
  const index = new Map();
  for (const field of record?.fields ?? []) {
    const match = /^obs\[(\d+)\]\.(.+)$/.exec(field?.path ?? '');
    if (!match) continue;
    const slot = Number(match[1]);
    let target = index.get(slot);
    if (!target) {
      target = {};
      index.set(slot, target);
      observations[slot] = target;
    }
    target[match[2]] = field.value;
  }
  return observations.filter(Boolean);
}

/* ---------------- inline icons (no extra files, no 404s) ---------------- */

const ICON = {
  dashboard:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="currentColor">' +
    '<rect x="1" y="1" width="8" height="8" rx="1"/><rect x="11" y="1" width="8" height="8" rx="1"/>' +
    '<rect x="1" y="11" width="8" height="8" rx="1"/><rect x="11" y="11" width="8" height="8" rx="1"/>' +
    '</g></svg>',
  bell:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
    'd="M12 2.4a1.5 1.5 0 0 1 1.5 1.5v.66a6.2 6.2 0 0 1 4.7 6.02v4.1l1.5 2.3a.9.9 0 0 1-.76 1.39H5.06a.9.9 0 0 1-.76-1.39l1.5-2.3v-4.1a6.2 6.2 0 0 1 4.7-6.02v-.66A1.5 1.5 0 0 1 12 2.4Zm0 19.2a2.6 2.6 0 0 0 2.5-1.9h-5A2.6 2.6 0 0 0 12 21.6Z"/>' +
    '</svg>',
  gear:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
    'd="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm9 3.6c0-.5 0-1-.1-1.5l2-1.6-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L15.5 2h-4l-.4 2.6c-.9.3-1.8.8-2.6 1.5l-2.4-1-2 3.4 2 1.6a10 10 0 0 0 0 3l-2 1.6 2 3.4 2.4-1c.8.7 1.7 1.2 2.6 1.5l.4 2.4h4l.4-2.4c.9-.3 1.8-.8 2.6-1.5l2.4 1 2-3.4-2-1.6c.1-.5.1-1 .1-1.5Z"/>' +
    '</svg>',
  dots:
    '<svg viewBox="0 0 4 18" aria-hidden="true"><g fill="currentColor">' +
    '<circle cx="2" cy="2" r="1.8"/><circle cx="2" cy="9" r="1.8"/><circle cx="2" cy="16" r="1.8"/>' +
    '</g></svg>',
  pin:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
    'd="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2Z"/>' +
    '</svg>',
  caret: '<svg viewBox="0 0 10 6" aria-hidden="true"><path fill="currentColor" d="M0 0h10L5 6Z"/></svg>',
  caretUp: '<svg viewBox="0 0 10 6" aria-hidden="true"><path fill="currentColor" d="M5 0l5 6H0Z"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
    '<path d="M12 5v14M5 12h14"/></g></svg>',
  wrench:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
    'd="M15.6 2.2a6.4 6.4 0 0 1 5.9 8.6 1 1 0 0 1-1.7.3l-2.6-3-1.1.9-7.6 7.6a3.1 3.1 0 1 1-4.4-4.4l7.6-7.6.9-1.1-3-2.6a1 1 0 0 1 .3-1.7 6.4 6.4 0 0 1 5.7 3Z"/>' +
    '</svg>',
  help:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" ' +
    'd="M12.1 6.6c1.9 0 3.4 1.2 3.4 3 0 1.3-.8 2-1.9 2.6-.9.5-1.2.9-1.2 1.7v.3h-1.8v-.5c0-1.3.6-1.9 1.6-2.5.8-.5 1.2-.9 1.2-1.6 0-.8-.6-1.3-1.4-1.3-.9 0-1.5.7-1.5 1.7H9.4c0-2 1.2-3.4 2.7-3.4Zm-.4 8.2a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z"/>' +
    '</svg>',
};

/* ---------------- markup ---------------- */

function bandRow(label, target, extra) {
  return (
    `<span class="grit-lbl">${esc(label)}</span>` +
    `<span class="grit-val${extra ? ` ${extra}` : ''}" data-el="${target}">--</span>`
  );
}

function matrixCells() {
  return MATRIX_BANDS.map(
    (band) => `<span class="grit-cell" data-cell="${band}"></span>`,
  ).join('');
}

function matrixTiles() {
  return MATRIX_ROWS.map(
    (row) =>
      `<div class="grit-matrix-row" data-row="${row.key}">` +
      `<span class="grit-matrix-name">${esc(row.label)}</span>` +
      `<span class="grit-matrix-cells">${matrixCells()}</span>` +
      '</div>',
  ).join('');
}

/**
 * Spectrum Viewer plot. Coordinates are the reference's own CSS px, in an SVG whose origin sits
 * at tile-relative (16, 46): the thumbnail strip occupies y 31..48, the plot y 74..300, and the
 * x axis labels y 304..314. Two panels with a break at x 592, left 1150..1305 MHz and right
 * 1535..1625 MHz — the original draws the L1 window zoomed 2.3× relative to the L5/L2 window,
 * which is why the tick pitches differ.
 */
function spectrumSvg() {
  const W = 1185;
  const H = 320;
  const top = 74;
  const bottom = 300;
  const leftMin = 26;
  const leftMax = 592;
  const rightMin = 604;
  const rightMax = 1176;

  const dbToY = (db) => top + ((-40 - db) / 90) * (bottom - top);
  const parts = [
    `<svg class="grit-spec-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spectrum viewer: ` +
      'dBm axis -40 to -130, frequency axis 1150-1305 MHz and 1535-1625 MHz, no spectrum samples in this capture">',
  ];

  /* ---- thumbnail strip (y 31..48) ---- */
  parts.push(`<g class="grit-spec-thumb">`);
  parts.push(`<rect x="${leftMin}" y="31" width="${leftMax - leftMin}" height="17" class="grit-spec-thumbbox"/>`);
  parts.push(
    `<rect x="${rightMin}" y="31" width="${rightMax - rightMin}" height="17" class="grit-spec-thumbbox"/>`,
  );
  parts.push(
    `<path d="M${leftMax + 1} 31 l5 4 -5 4 5 4 -5 5" class="grit-spec-break"/>`,
  );
  const thumbTicks = [
    [76, '1150'],
    [242, '1200'],
    [416, '1250'],
    [584, '1300'],
    [706, '1550'],
    [982, '1600'],
  ];
  for (const [x, label] of thumbTicks) {
    parts.push(`<line x1="${x}" y1="26" x2="${x}" y2="31" class="grit-spec-tick"/>`);
    parts.push(`<text x="${x}" y="20" class="grit-spec-ticklabel" text-anchor="middle">${label}</text>`);
  }
  /* band chips: L5 / L2 in the left window, L1 in the right one (labels as in the original) */
  const chips = [
    [107, 73, 'L5'],
    [268, 62, 'L2'],
    [716, 152, 'L1'],
  ];
  for (const [x, w, label] of chips) {
    parts.push(`<rect x="${x}" y="32" width="${w}" height="15" class="grit-spec-chip"/>`);
    parts.push(
      `<text x="${x + w / 2}" y="43.5" class="grit-spec-chiplabel" text-anchor="middle">${label}</text>`,
    );
  }
  parts.push('</g>');

  /* ---- plot frame ---- */
  parts.push(
    `<rect x="${leftMin}" y="${top}" width="${leftMax - leftMin}" height="${bottom - top}" class="grit-spec-plot"/>`,
  );
  parts.push(
    `<rect x="${rightMin}" y="${top}" width="${rightMax - rightMin}" height="${bottom - top}" class="grit-spec-plot"/>`,
  );
  parts.push(`<path d="M${leftMax + 1} ${top} l5 5 -5 6 5 6 -5 6" class="grit-spec-break"/>`);

  /* ---- dBm gridlines + labels ---- */
  for (let db = -40; db >= -130; db -= 10) {
    const y = dbToY(db);
    parts.push(
      `<line x1="${leftMin}" y1="${y.toFixed(1)}" x2="${rightMax}" y2="${y.toFixed(1)}" class="grit-spec-grid"/>`,
    );
    parts.push(
      `<text x="${leftMin - 6}" y="${(y + 3.4).toFixed(1)}" class="grit-spec-axis" text-anchor="end">${db}</text>`,
    );
  }

  /* ---- x ticks ---- */
  const axis = (min, max, x0, x1, from, to, step) => {
    const out = [];
    for (let mhz = from; mhz <= to; mhz += step) {
      const x = x0 + ((mhz - min) / (max - min)) * (x1 - x0);
      out.push(`<line x1="${x.toFixed(1)}" y1="${bottom}" x2="${x.toFixed(1)}" y2="${bottom + 4}" class="grit-spec-tick"/>`);
      out.push(
        `<text x="${x.toFixed(1)}" y="${bottom + 15}" class="grit-spec-axis" text-anchor="middle">${mhz}</text>`,
      );
    }
    return out.join('');
  };
  parts.push(axis(1150, 1305, leftMin, leftMax, 1160, 1300, 20));
  parts.push(axis(1535, 1625, rightMin, rightMax, 1540, 1620, 20));

  /* ---- band annotations: white chips with a teal hairline, as in the original ---- */
  const boxes = [
    [1150, 1190, -44, 'L5'],
    [1200, 1250, -44, 'L2'],
    [1572, 1606, -44, 'L1'],
    [1160, 1218, -70, 'B2 / B2B'],
    [1550, 1582, -70, 'B1'],
    [1152, 1200, -100, 'L5'],
    [1216, 1250, -100, 'L2'],
    [1560, 1596, -100, 'L1'],
    [1554, 1594, -126, 'L1'],
  ];
  for (const [f0, f1, db, label] of boxes) {
    const isRight = f0 >= 1305;
    const min = isRight ? 1535 : 1150;
    const max = isRight ? 1625 : 1305;
    const x0 = isRight ? rightMin : leftMin;
    const x1 = isRight ? rightMax : leftMax;
    const px = (mhz) => x0 + ((mhz - min) / (max - min)) * (x1 - x0);
    const xa = px(f0);
    const xb = px(f1);
    const y = dbToY(db);
    parts.push(`<rect x="${xa.toFixed(1)}" y="${(y - 10).toFixed(1)}" width="${(xb - xa).toFixed(1)}" height="20" rx="10" class="grit-spec-band"/>`);
    parts.push(
      `<text x="${((xa + xb) / 2).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="grit-spec-bandlabel" text-anchor="middle">${esc(label)}</text>`,
    );
  }

  /* ---- the honest note: this capture has no spectrum samples ---- */
  parts.push(
    `<text x="${((leftMin + rightMax) / 2).toFixed(1)}" y="${(dbToY(-88) + 4).toFixed(1)}" class="grit-spec-empty" text-anchor="middle">No spectrum data in this capture</text>`,
  );

  /* ---- constellation ruler on the right, clipped by the tile like the original ---- */
  const ruler = [
    [-86, 'GPS'],
    [-154, 'BDS'],
    [-218, 'QZSS'],
    [-269, 'SBAS'],
  ];
  for (const [db, label] of ruler) {
    parts.push(
      `<text x="${rightMax - 6}" y="${(dbToY(db) + 4).toFixed(1)}" class="grit-spec-ruler" text-anchor="start">${esc(label)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

function template() {
  return `
<div class="grit-page" data-el="page">

  <div class="grit-menubar" data-el="menubar">
    <button type="button" class="grit-menu-item grit-menu-dash is-active" data-el="menuDashboard">
      <span class="grit-menu-ico">${ICON.dashboard}</span><span class="grit-menu-label">Dashboard</span>
    </button>
    <button type="button" class="grit-menu-item" data-grit-menu="settings" aria-haspopup="true" aria-expanded="false">
      <span class="grit-menu-ico">${ICON.gear}</span><span class="grit-menu-label">Settings</span><span class="grit-caret">${ICON.caret}</span>
    </button>
    <button type="button" class="grit-menu-item" data-grit-menu="tools" aria-haspopup="true" aria-expanded="false">
      <span class="grit-menu-ico">${ICON.wrench}</span><span class="grit-menu-label">Tools</span><span class="grit-caret">${ICON.caret}</span>
    </button>
    <button type="button" class="grit-menu-item" data-grit-menu="help" aria-haspopup="true" aria-expanded="false">
      <span class="grit-menu-ico">${ICON.help}</span><span class="grit-menu-label">Help</span><span class="grit-caret">${ICON.caret}</span>
    </button>
    <div class="grit-menubar-right">
      <button type="button" class="grit-events" data-el="events" title="Events" aria-label="Events">
        <span class="grit-events-ico">${ICON.bell}</span>
        <span class="grit-events-count" data-el="eventsCount">0</span>
      </button>
      <div class="grit-menu-pop" data-el="menuPop" hidden></div>
    </div>
  </div>

  <div class="grit-band">
    <div class="grit-band-inner">
      <div class="grit-band-half grit-band-pos">
        <div class="grit-band-head">
          <span class="grit-band-title">Positioning</span>
          <span class="grit-badge is-good" data-el="posBadge">Good</span>
        </div>
        <div class="grit-band-grid grit-band-grid-pos">
          ${bandRow('Position', 'bandPosition', 'grit-val-under')}
          ${bandRow('Height (MSL)', 'bandHeight')}
          ${bandRow('Latitude', 'bandLat')}
          ${bandRow('Satellite Tracked', 'bandTracked')}
          ${bandRow('Longitude', 'bandLon')}
          ${bandRow('Satellite Used', 'bandUsed')}
        </div>
      </div>
      <div class="grit-band-split" aria-hidden="true"></div>
      <div class="grit-band-half grit-band-dev">
        <div class="grit-band-head">
          <span class="grit-band-title">Device</span>
          <span class="grit-badge is-good" data-el="devBadge">Good</span>
        </div>
        <div class="grit-band-grid grit-band-grid-dev">
          ${bandRow('Model', 'devModel')}
          ${bandRow('Interference', 'devInterference')}
          ${bandRow('CPU Usage', 'devCpu')}
          ${bandRow('Jamming', 'devJamming')}
          ${bandRow('Time (UTC)', 'devTime')}
          <span></span><span></span>
        </div>
      </div>
    </div>
  </div>

  <div class="grit-tiles">
    <div class="grit-row">
      <section class="grit-tile" data-tile="mitigation">
        <h2 class="grit-tile-title">Mitigation Assistant</h2>
        <button type="button" class="grit-tile-more" aria-label="More">${ICON.dots}</button>
        <div class="grit-mitigation">
          <span class="grit-mitigation-value" data-el="mitigation">Not detected</span>
        </div>
      </section>

      <section class="grit-tile grit-tile-wide" data-tile="spectrum">
        <h2 class="grit-tile-title">Spectrum Viewer</h2>
        <div class="grit-tile-tools">
          <div class="grit-seg" role="tablist" aria-label="Spectrum view">
            <button type="button" class="grit-seg-btn is-active" role="tab" aria-selected="true" data-spec="spectrum">Spectrum</button>
            <button type="button" class="grit-seg-btn" role="tab" aria-selected="false" data-spec="waterfall">Waterfall</button>
          </div>
          <button type="button" class="grit-icon-btn" data-el="specGear" aria-label="Spectrum settings">${ICON.gear}</button>
          <button type="button" class="grit-tile-more grit-tile-more-inline" aria-label="More">${ICON.dots}</button>
        </div>
        <div class="grit-spec" data-el="spectrum">${spectrumSvg()}</div>
        <div class="grit-spec-note" data-el="specNote" hidden></div>
      </section>
    </div>

    <div class="grit-row">
      <section class="grit-tile" data-tile="matrix">
        <h2 class="grit-tile-title">Signal Matrix</h2>
        <button type="button" class="grit-tile-more" aria-label="More">${ICON.dots}</button>
        <div class="grit-matrix">
          <div class="grit-matrix-main">
            <div class="grit-matrix-head">
              <span></span>
              <span class="grit-matrix-cells">
                <span class="grit-matrix-band">L5 Band</span>
                <span class="grit-matrix-band">L2 Band</span>
                <span class="grit-matrix-band">L1 Band</span>
              </span>
            </div>
            ${matrixTiles()}
          </div>
          <div class="grit-matrix-split" aria-hidden="true"></div>
          <div class="grit-matrix-legend">
            <span class="grit-legend-title">Legend</span>
            <div class="grit-legend-group">
              <span class="grit-legend-sub">SIGNALS</span>
              <div class="grit-legend-item"><span class="grit-legend-box is-good"></span>Good</div>
              <div class="grit-legend-item"><span class="grit-legend-box is-warn"></span>Warning</div>
              <div class="grit-legend-item"><span class="grit-legend-box is-poor"></span>Poor</div>
            </div>
            <div class="grit-legend-group">
              <span class="grit-legend-sub">CONSTELLATION</span>
              <div class="grit-legend-item"><span class="grit-legend-box is-interf"></span>Interference</div>
              <div class="grit-legend-item"><span class="grit-legend-box is-empty"></span>No signals visible</div>
            </div>
          </div>
        </div>
      </section>

      <section class="grit-tile grit-tile-wide" data-tile="position">
        <div class="grit-pos-head">
          <h2 class="grit-tile-title">Position Overview</h2>
          <div class="grit-tile-tools">
            <button type="button" class="grit-poi-btn" data-el="addPoi">
              <span class="grit-poi-ico">${ICON.pin}</span>Add Point of Interest
            </button>
            <button type="button" class="grit-icon-btn" data-el="posGear" aria-label="Map settings">${ICON.gear}</button>
            <button type="button" class="grit-tile-more grit-tile-more-inline" aria-label="More">${ICON.dots}</button>
          </div>
        </div>
        <div class="grit-pos-tabs" role="tablist" aria-label="Position overview view">
          <button type="button" class="grit-pos-tab is-active" role="tab" aria-selected="true" data-view="map">Map</button>
          <button type="button" class="grit-pos-tab" role="tab" aria-selected="false" data-view="satellite">Satellite</button>
        </div>
        <div class="grit-pos-canvas" data-el="posCanvas">
          <p class="grit-pos-note" data-el="posNote" hidden></p>
        </div>
      </section>
    </div>
  </div>

  <div class="grit-dock" data-el="dock">
    <div class="grit-drawer" data-el="drawer" hidden>
      <div class="grit-drawer-row">
        <span class="grit-drawer-label">Capture</span>
        <span class="grit-drawer-strong" data-el="dockCapture">--</span>
      </div>
      <div class="grit-drawer-row">
        <span class="grit-drawer-label">Start</span>
        <span class="grit-drawer-strong" data-el="dockStart">--:--:--</span>
        <span class="grit-drawer-label grit-drawer-gap">End</span>
        <span class="grit-drawer-strong" data-el="dockEnd">--:--:--</span>
        <span class="grit-drawer-label grit-drawer-gap">Duration</span>
        <span class="grit-drawer-strong" data-el="dockDuration">--</span>
      </div>
      <div class="grit-drawer-row">
        <span class="grit-drawer-label">Records</span>
        <span class="grit-drawer-strong" data-el="dockRecords">--</span>
        <span class="grit-drawer-note">时间轴由 Playback 面板负责播放；这里只读 GRIT 抓包的跨度。</span>
      </div>
    </div>
    <button type="button" class="grit-dock-btn" data-el="dockToggle" aria-expanded="false" aria-controls="grit-drawer">
      <span class="grit-dock-label">Timeline</span><span class="grit-dock-caret">${ICON.caretUp}</span>
    </button>
  </div>
</div>`;
}

/* ---------------- data ---------------- */

/**
 * @param {object} ctx
 * @param {string} capture
 */
async function readStatus(ctx, capture) {
  const query = capture ? { capture } : undefined;
  const out = {
    capture,
    position: null,
    tracked: null,
    used: null,
    time: null,
    device: null,
    matrix: null,
    spectrum: null,
    info: null,
  };

  const [info, logs] = await Promise.allSettled([
    ctx.api.get('/api/playback/info', query),
    ctx.api.get('/api/logs', query),
  ]);
  if (info.status === 'fulfilled') out.info = info.value;
  /* `/api/logs` reports `types` as a *count*; the per-message rows live in `groups`
     (`{ id, name, count, firstUtc, … }`). */
  const types = logs.status === 'fulfilled' ? logs.value.groups ?? [] : [];
  const counts = new Map();
  for (const type of types) counts.set(Number(type.id), Number(type.count) || 0);

  const records = async (msgId, offset) => {
    if (!counts.has(msgId)) return null;
    try {
      const data = await ctx.api.get('/api/records', {
        capture: capture || undefined,
        msgId,
        offset: offset ?? 0,
        limit: 25,
      });
      return data;
    } catch {
      return null;
    }
  };

  /* ---- BESTPOS: the last solution in the capture ---- */
  const bestTotal = counts.get(BESTPOS) ?? 0;
  if (bestTotal > 0) {
    const data = await records(BESTPOS, bestTotal - 1);
    const record = data?.records?.[0];
    if (record) {
      const fields = fieldMap(record);
      out.position = {
        mode: titleCase(fields.position_type ?? fields.solution_status),
        lat: fixed(fields.latitude, 7),
        lon: fixed(fields.longitude, 7),
        height: fixed(fields.orthometric_height, 2),
        numSvs: Number(fields.num_svs),
        numSoln: Number(fields.num_soln_svs),
      };
      out.time = hhmmss(record.header?.utc, record.header?.milliseconds ? record.header.milliseconds / 1000 : undefined);
    }
  }

  /* ---- RANGE: last complete epoch ---- */
  const rangeTotal = counts.get(RANGE) ?? 0;
  if (rangeTotal > 0) {
    const data = await records(RANGE, rangeTotal - 1);
    const record = data?.records?.[0];
    if (record) {
      const observations = readObservations(record);
      const prns = new Set();
      /* Per cell: the set of PRNs seen on that band, because the original's matrix counts
         *signals* — one square per satellite per band, not one per observation (a PRN repeats
         once per signal the receiver tracks). */
      const matrix = new Map();
      for (const row of MATRIX_ROWS) matrix.set(row.key, { L5: new Set(), L2: new Set(), L1: new Set() });
      let lband = 0;
      for (const observation of observations) {
        const system = (Number(observation.c_status) >>> 16) & 7;
        const prn = Number(observation.sv_prn);
        const freq = Number(observation.sv_freq);
        const band = FREQ_BAND[freq] ?? 'L1';
        if (band === 'LBAND' || freq === 205) {
          lband += 1;
          continue;
        }
        const row =
          system === SYSTEM_GPS ? 'gps'
            : system === SYSTEM_BDS ? 'bds'
              : system === SYSTEM_QZSS ? 'qzss'
                : system === SYSTEM_SBAS ? 'sbas'
                  : null;
        if (!row) continue;
        if (Number.isFinite(prn)) prns.add(`${system}:${prn}`);
        const cell = matrix.get(row);
        if (cell && band in cell) cell[band].add(`${system}:${prn}`);
      }
      out.tracked = prns.size;
      out.matrix = { counts: matrix, lband, observations: observations.length };
      out.time = out.time ?? hhmmss(record.header?.utc);
    }
  }
  out.used = out.position?.numSoln;

  /* ---- HWMONITOR: CPU usage + model, when the receiver logged one ---- */
  if ((counts.get(HWMONITOR) ?? 0) > 0) {
    const data = await records(HWMONITOR, 0);
    const record = data?.records?.[0];
    if (record) out.device = readDevice(record);
  }

  /* ---- spectrum: only when a capture actually carries an ITK/spectrum log ---- */
  out.spectrum = await readSpectrum(ctx, capture, types);
  return out;
}

/**
 * `HWMONITOR` measurements. The high byte of `status` is `HwMonitorStatusReadingType`
 * (1/22 temperature, 2 antenna current, 7 antenna voltage, …); the binary log carries no idle
 * time, so `CPU Usage` can only be answered by a build that also logs `HWMONITOR`-ASCII — see
 * `panels/playback.js` `readDevice()`, which came to the same conclusion. Until then: `--`.
 */
function readDevice(record) {
  const measurements = readObservations(record);
  const temperatures = measurements.filter((item) => ((Number(item.status) >> 8) & 0xff) === 1 || ((Number(item.status) >> 8) & 0xff) === 22);
  return {
    model: null,
    cpu: null,
    temperature: temperatures.length ? fixed(temperatures[0].value, 1) : null,
  };
}

/**
 * Spectrum samples. No sample capture in this repo carries ITK / spectrum logs, so this returns
 * `null` and the plot keeps its "No spectrum data in this capture" note. It only produces
 * points when a record exposes paired frequency/amplitude arrays, which is what an ITK
 * `SPECTRUM` payload would look like once the parser knows it.
 */
async function readSpectrum(ctx, capture, types) {
  const candidate = (types ?? []).find((type) => /spectrum|itk/i.test(String(type.name ?? '')));
  if (!candidate) return null;
  try {
    const data = await ctx.api.get('/api/records', {
      capture: capture || undefined,
      msgId: candidate.id,
      offset: 0,
      limit: 1,
    });
    const record = data?.records?.[0];
    const fields = record?.fields ?? [];
    const freqs = fields.filter((field) => /freq/i.test(field.path));
    const powers = fields.filter((field) => /(psd|power|amplitude|dbm)/i.test(field.path));
    if (!freqs.length || !powers.length) return null;
    const points = freqs
      .map((field, index) => [Number(field.value), Number(powers[index]?.value)])
      .filter(([hz, dbm]) => Number.isFinite(hz) && Number.isFinite(dbm));
    return points.length > 1 ? points : null;
  } catch {
    return null;
  }
}

/* ---------------- render ---------------- */

function setText(root, name, text) {
  const node = root.querySelector(`[data-el="${name}"]`);
  if (node) node.textContent = text;
}

function renderMatrix(root, state) {
  const counts = state.matrix?.counts;
  for (const row of MATRIX_ROWS) {
    const rowEl = root.querySelector(`.grit-matrix-row[data-row="${row.key}"]`);
    if (!rowEl) continue;
    const rowCounts = counts?.get(row.key);
    for (const band of MATRIX_BANDS) {
      const cell = rowEl.querySelector(`[data-cell="${band}"]`);
      if (!cell) continue;
      const count = rowCounts ? rowCounts[band].size : 0;
      /* No signal in that band → the light grey placeholder box the original draws
         (`#signal-components .frequencieBand-box`, rgba(0,0,0,0.04)); otherwise 7×7 squares on
         an 8 px pitch, five per row inside the 43 px box. */
      if (!count) {
        cell.className = 'grit-cell';
        cell.innerHTML = '';
        continue;
      }
      cell.className = 'grit-cell has-signal';
      cell.innerHTML = Array.from({ length: Math.min(count, 30) }, () => '<i class="grit-sq"></i>').join('');
      cell.title = `${row.label} ${band}: ${count} signal${count === 1 ? '' : 's'} in the last RANGE epoch`;
    }
  }
}

function renderBand(root, state) {
  setText(root, 'bandPosition', state.position?.mode ?? '--');
  setText(root, 'bandLat', state.position?.lat ?? '--');
  setText(root, 'bandLon', state.position?.lon ?? '--');
  setText(root, 'bandHeight', state.position ? `${state.position.height} m` : '--');
  setText(root, 'bandTracked', state.tracked == null ? '--' : String(state.tracked));
  setText(root, 'bandUsed', state.used == null ? '--' : String(state.used));

  setText(root, 'devModel', state.device?.model ?? '--');
  setText(root, 'devCpu', state.device?.cpu ?? '--');
  setText(root, 'devTime', state.time ?? '--:--:--');
  /* No ITK data in these captures — the original prints `Not detected`, never a number.
     Interference / Jamming / Mitigation Assistant all come from the same (absent) ITK stream. */
  setText(root, 'devInterference', 'Not detected');
  setText(root, 'devJamming', 'Not detected');
  setText(root, 'mitigation', 'Not detected');

  const posBadge = root.querySelector('[data-el="posBadge"]');
  if (posBadge) {
    posBadge.textContent = state.position ? 'Good' : '--';
    posBadge.className = `grit-badge ${state.position ? 'is-good' : 'is-unknown'}`;
  }
}

function renderSpectrum(root, state) {
  const note = root.querySelector('[data-el="specNote"]');
  const plot = root.querySelector('[data-el="spectrum"]');
  if (!plot) return;
  const empty = plot.querySelector('.grit-spec-empty');
  if (state.spectrum?.length) {
    if (empty) empty.remove();
    if (note) {
      note.hidden = false;
      note.textContent = `${state.spectrum.length} spectrum samples`;
    }
    return;
  }
  if (empty) empty.style.display = '';
  if (note) note.hidden = true;
}

function renderDock(root, state) {
  setText(root, 'dockCapture', state.capture ? baseName(state.capture) : '--');
  const info = state.info;
  setText(root, 'dockStart', info?.startUtc ? hhmmss(info.startUtc) : '--:--:--');
  setText(root, 'dockEnd', info?.finishUtc ? hhmmss(info.finishUtc) : '--:--:--');
  setText(
    root,
    'dockDuration',
    info?.durationSeconds == null ? '--' : `${Number(info.durationSeconds).toFixed(2)} s`,
  );
  setText(root, 'dockRecords', info?.frameCount == null ? '--' : String(info.frameCount));
}

/* ---------------- app bar injection ---------------- */

/**
 * The original app bar (70 px: 36 px banner + 34 px strip) carries the receiver's file tab and
 * `+ Add Device` next to the app name. The shell owns that strip (`index.html` `#tabs-list`), so
 * the panel adds its two items while mounted and removes them again on unmount. `grit.css` hides
 * them whenever another page is selected.
 */
function injectAppBar(root, state) {
  const tabs = document.getElementById('tabs-list');
  if (!tabs) return;

  let fileTab = tabs.querySelector('.grit-appbar-file');
  if (!fileTab) {
    fileTab = document.createElement('li');
    fileTab.className = 'grit-appbar-file';
    fileTab.innerHTML =
      '<span class="grit-appbar-name" data-el="appbarName">--</span>' +
      '<span class="grit-appbar-count" data-el="appbarCount">(0)</span>' +
      '<button type="button" class="grit-appbar-close" aria-label="关闭抓包">✕</button>';
    const addBtn = document.createElement('li');
    addBtn.className = 'grit-appbar-add';
    addBtn.innerHTML =
      `<button type="button" class="grit-appbar-add-btn"><span class="grit-appbar-plus">${ICON.plus}</span>Add Device</button>`;
    tabs.appendChild(fileTab);
    tabs.appendChild(addBtn);
    root.__gritAppBar = [fileTab, addBtn];
  }

  const name = state.capture ? baseName(state.capture) : '--';
  const nameEl = fileTab.querySelector('[data-el="appbarName"]');
  const countEl = fileTab.querySelector('[data-el="appbarCount"]');
  if (nameEl) nameEl.textContent = name;
  /* The original's parenthetical is the event count — the same number the bell badge shows
     ("OEM729-C… (0)"). No event stream is computed here, so it stays 0 rather than borrowing
     an unrelated number such as the frame count. */
  if (countEl) countEl.textContent = `(${state.events ?? 0})`;
  fileTab.title = state.capture || '';
}

function removeAppBar(root) {
  const injected = root.__gritAppBar;
  if (injected) {
    for (const node of injected) node.remove();
    root.__gritAppBar = null;
  }
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__gritCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__gritCleanup = null;
  removeAppBar(root);
}

export function mount(root, ctx = {}) {
  ensureCss();
  root.innerHTML = template();

  const page = root.querySelector('[data-el="page"]');
  const state = {
    capture: '',
    position: null,
    tracked: null,
    used: null,
    time: null,
    device: null,
    matrix: null,
    spectrum: null,
    info: null,
    events: 0,
  };

  let token = 0;
  let disposed = false;

  const load = async () => {
    const mine = ++token;
    const capture = ctx.capture || '';
    try {
      const next = await readStatus(ctx, capture);
      if (disposed || mine !== token) return;
      Object.assign(state, next);
      renderBand(root, state);
      renderMatrix(root, state);
      renderSpectrum(root, state);
      renderDock(root, state);
      injectAppBar(root, state);
    } catch (error) {
      if (disposed || mine !== token) return;
      console.error('[grit] 读取抓包失败：', error);
    }
  };

  /* ---- Timeline dock (collapsed by default, exactly like the original's `Timeline ▲`) ---- */
  const dock = root.querySelector('[data-el="dock"]');
  const drawer = root.querySelector('[data-el="drawer"]');
  const dockToggle = root.querySelector('[data-el="dockToggle"]');
  const onDock = () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    dockToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    dock.classList.toggle('is-open', open);
    const caret = dockToggle.querySelector('.grit-dock-caret svg');
    if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
  };
  dockToggle.addEventListener('click', onDock);

  /* ---- Map / Satellite tabs: both draw an empty canvas; the basemap renderer is not part of
     this build, so nothing is faked (the original's map layer is Luciad, not available offline). ---- */
  const tabs = Array.from(root.querySelectorAll('[data-view]'));
  const posNote = root.querySelector('[data-el="posNote"]');
  const onTab = (event) => {
    const view = event.currentTarget.getAttribute('data-view');
    for (const tab of tabs) {
      const on = tab === event.currentTarget;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (posNote) {
      if (view === 'satellite') {
        posNote.hidden = false;
        posNote.textContent = 'Satellite view needs the basemap renderer — this build has no map layer.';
      } else {
        posNote.hidden = true;
        posNote.textContent = '';
      }
    }
  };
  for (const tab of tabs) tab.addEventListener('click', onTab);

  /* ---- Spectrum / Waterfall segment: same plot, the waterfall raster needs samples ---- */
  const segs = Array.from(root.querySelectorAll('[data-spec]'));
  const onSeg = (event) => {
    for (const seg of segs) {
      const on = seg === event.currentTarget;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };
  for (const seg of segs) seg.addEventListener('click', onSeg);

  /* ---- menu bar dropdowns: the original's items have no implementation behind them in this
     build (Terminal, Networking, Map settings, Help file), so the popover states that. ---- */
  const menuPop = root.querySelector('[data-el="menuPop"]');
  const menuButtons = Array.from(root.querySelectorAll('[data-grit-menu]'));
  const MENU_TEXT = {
    settings: 'Networking · Map — 原版打开 Settings 面板；这一版没有实现。',
    tools: 'Terminal — 原版打开终端面板；这一版没有实现。',
    help: 'Help — 原版打开离线帮助文件；这一版没有实现。',
  };
  const onMenu = (event) => {
    const key = event.currentTarget.getAttribute('data-grit-menu');
    const open = menuPop.hidden || menuPop.dataset.for !== key;
    for (const button of menuButtons) {
      const on = open && button.getAttribute('data-grit-menu') === key;
      button.setAttribute('aria-expanded', on ? 'true' : 'false');
      button.classList.toggle('is-open', on);
    }
    if (!open) {
      menuPop.hidden = true;
      menuPop.dataset.for = '';
      return;
    }
    menuPop.dataset.for = key || '';
    menuPop.textContent = MENU_TEXT[key] ?? '';
    menuPop.hidden = false;
  };
  for (const button of menuButtons) button.addEventListener('click', onMenu);

  const onDocumentClick = (event) => {
    if (!menuPop || menuPop.hidden) return;
    if (menuPop.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-grit-menu]')) return;
    menuPop.hidden = true;
    menuPop.dataset.for = '';
    for (const button of menuButtons) {
      button.setAttribute('aria-expanded', 'false');
      button.classList.remove('is-open');
    }
  };
  document.addEventListener('click', onDocumentClick);

  const offCapture = typeof ctx.onCaptureChange === 'function' ? ctx.onCaptureChange(load) : () => {};

  root.__gritCleanup = () => {
    disposed = true;
    token += 1;
    offCapture?.();
    document.removeEventListener('click', onDocumentClick);
    dockToggle.removeEventListener('click', onDock);
    for (const tab of tabs) tab.removeEventListener('click', onTab);
    for (const seg of segs) seg.removeEventListener('click', onSeg);
    for (const button of menuButtons) button.removeEventListener('click', onMenu);
  };

  load();
  return page;
}
