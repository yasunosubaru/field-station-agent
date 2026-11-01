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
 *   Position Overview                              → blank canvas (no basemap renderer here)
 *
 * Spectrum Viewer / Waterfall — fed by two sources, one store:
 *
 *   - **live**: the samples come from `ITPSDFINAL` (#1968) / `ITPSDDETECT` (#2063), which the
 *     receiver emits while an `ITSPECTRALANALYSIS` sweep is running. `/api/live/logs` carries them
 *     in `entry.data` (see `LiveSpectrum` in `src/live.ts`), so this panel polls
 *     `/api/live/status` + `/api/live/logs?after=<cursor>` exactly like `panels/manage.js` does;
 *   - **capture**: the same logs sit inside an SBF recording, and `/api/records` hands the 1024
 *     samples over in `record.arrays` instead of 1024 field rows (`logs.ts` `projectFields`). One
 *     page — `limit` 25, the server's cap — holds more than the ten sweeps the waterfall keeps,
 *     and it is read *after* the band, the matrix and the dock have painted, so opening a capture
 *     never waits for the spectrum. A 1024-sample record is 7 043 B in that shape (measured on
 *     `b1-20261101.sbf`, 25 records = 172 395 B) against 50 381 B of field objects for one;
 *   - one sweep can span several logs (max 1024 samples each). They are grouped by the **OEM7
 *     header sequence word** — buffered while `sequence !== 0`, merged when `sequence === 0`, which
 *     is the manual's rule ("grouped together through the sequence number of the log header") and
 *     what `sample-b1` shows: one 1365-sample ITPSDDETECT sweep = sequence 1 (1024) + sequence 0
 *     (341). **Both sources go through `ingestSpectrum` / `mergeChunks`**: `captureSpectrumEntry`
 *     only reshapes an `/api/records` row into the `LiveSpectrum` shape, so the sequence rule
 *     exists once in this file;
 *   - the curve plots every merged sample in dBm (`raw/256 − 200`); the waterfall rasterises the
 *     ten most recent merged sweeps on a matching frequency grid, with the original's colour map
 *     (−135 dBm purple … −30 dBm red).
 *
 * A capture with no ITPSD record (most of them — the receiver only logs a PSD while a sweep runs)
 * keeps the reference frame and says so in the note; it never draws a made-up curve.
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./grit.css', import.meta.url).href;
const CSS_ID = 'nas-panel-grit-css';

/** Message ids this page reads (SBF). */
const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;
/** Spectrum: the processed PSD of a sweep, and the detection view of the same sweep. */
const ITPSD_FINAL = 1968;
const ITPSD_DETECT = 2063;

/** How many merged sweeps the waterfall keeps (the original's waterfall is a rolling strip). */
const WATERFALL_FRAMES = 10;
/** One poll of `/api/live/status` + `/api/live/logs`; `manage.js` uses 900 ms for the same pair. */
const LIVE_POLL_MS = 900;
/** `/api/records` caps `limit` at 25 — the most one capture page can ask for. */
const CAPTURE_SPECTRUM_PAGE = 25;
/**
 * `sample = raw / 256 − 200` dBm — the manual's two steps, the same conversion `live.ts`
 * `LiveSpectrum` applies to the same `uint16` samples (03_分析 §5.2, `logparsers.js:1126-1143`).
 */
const SAMPLE_SCALE = 256;
const SAMPLE_OFFSET = 200;

/** `ITSPECTRALANALYSIS` enums, OEM7 manual — 0..23, the word's bits 0-3 carry this value. */
const SPECTRUM_FREQUENCIES = [
  'GPSL1', 'GPSL2', 'GLONASSL1', 'GLONASSL2', 'Reserved', 'GPSL5', 'LBAND', 'GALILEOE1',
  'GALILEOE5A', 'GALILEOE5B', 'GALILEOALTBOC', 'BEIDOUB1', 'BEIDOUB2', 'QZSSL1', 'QZSSL2',
  'QZSSL5', 'QZSSL6', 'GALILEOE6', 'BEIDOUB3', 'GLONASSL3', 'NAVICL5', 'BEIDOUB1C', 'BEIDOUB2A',
  'BEIDOUB2B',
];
const SPECTRUM_DATA_SOURCES = ['OFF', 'PREDECIMATION', 'POSTDECIMATION', 'POSTFILTER'];
const SPECTRUM_FFT_SIZES = [1, 2, 4, 8, 16, 32, 64];

/** The original's waterfall colour map: −135 dBm … −30 dBm, `spectrumPlot.js:2795-2806`. */
const WATERFALL_STOPS = [
  [-135, [105, 41, 196]],
  [-120, [17, 146, 232]],
  [-105, [17, 146, 232]],
  [-90, [25, 128, 56]],
  [-75, [130, 173, 50]],
  [-60, [245, 166, 35]],
  [-45, [255, 131, 43]],
  [-30, [218, 30, 40]],
];
const WATERFALL_MIN = WATERFALL_STOPS[0][0];
const WATERFALL_MAX = WATERFALL_STOPS[WATERFALL_STOPS.length - 1][0];

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

/** Fallback API for a standalone panel import (the shell always passes its own `ctx.api`). */
function defaultApi() {
  const request = async (method, path, body, params) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    const text = query.toString();
    const init = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(text ? `${path}?${text}` : path, init);
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  };
  return {
    get: (path, params) => request('GET', path, undefined, params),
    post: (path, body) => request('POST', path, body),
  };
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
 * Empty state — the reference screenshot's frame: a thumbnail strip, two windows with a break at
 * x 592 (1150..1305 MHz and 1535..1625 MHz), band chips. It is drawn only while no ITPSD sample
 * has arrived; `renderSpectrum` replaces it with `spectrumPlotSvg`/`waterfallSvg` as soon as the
 * receiver sends one, and `specNote` always carries the reason this frame is still showing.
 */
function placeholderSpectrumSvg() {
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
    `<text x="${((leftMin + rightMax) / 2).toFixed(1)}" y="${(dbToY(-88) + 4).toFixed(1)}" class="grit-spec-empty" text-anchor="middle">No spectrum data</text>`,
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
    </div>
  </div>

  <!-- The popover lives on the page, not inside .grit-menubar-right (a positioned box at the right
       end of the bar): its left must be measured from .grit-page. -->
  <div class="grit-menu-pop" data-el="menuPop" hidden></div>

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
        <div class="grit-spec" data-el="spectrum">${placeholderSpectrumSvg()}</div>
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
    info: null,
    /** Chunks of each spectrum log in this capture — what sizes the one `/api/records` page. */
    spectrumTotals: null,
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

  /* Spectrum is not decoded here: `load()` kicks `requestCaptureSpectrum` off after the first
     paint, so the band, the matrix and the dock never wait for 1024-sample pages. Only the
     per-log counts are taken from `/api/logs`, which this page already fetched. */
  out.spectrumTotals = {
    final: counts.get(ITPSD_FINAL) ?? 0,
    detect: counts.get(ITPSD_DETECT) ?? 0,
  };
  return out;
}

/* ---------------- spectrum store (live ITPSD) ---------------- */

export function emptySpectrumStore() {
  return {
    /** Chunks of a sweep that has not finished yet, per log (`sequence !== 0`). */
    pending: { final: [], detect: [] },
    /** Merged sweeps, oldest first; at most `WATERFALL_FRAMES`. */
    frames: [],
    /** The newest merged sweep, what the curve draws. */
    latest: null,
    /** Counters the note and the export read, so nothing here is inferred. */
    chunks: 0,
    sweeps: 0,
    duplicates: 0,
    skipped: 0,
    lastError: '',
    /** Where the samples came from: a live session or the open capture. */
    source: 'live',
    /** Capture the sweeps were read from (empty for a live session). */
    capture: '',
  };
}

/**
 * Fold one live entry into the store. Returns true when the drawing changed.
 *
 * Grouping rule: the receiver caps one log at 1024 samples and numbers the chunks with the OEM7
 * header word at byte 10 — every chunk but the last has a non-zero sequence, the last one has 0
 * ("The output logs can be grouped together through the sequence number of the log header",
 * ITPSDFINAL). A chunk already held under the same sequence is dropped, which is what the
 * original's `processITPSDFinalData` does with a repeated `sequenceId`.
 *
 * This is the only place the sequence rule exists: the live stream and a capture both arrive here
 * (`captureSpectrumEntry` reshapes a `/api/records` row into the live entry's shape).
 */
export function ingestSpectrum(store, entry) {
  const data = entry?.data;
  if (!data || data.kind !== 'itpsd') return false;
  const log = data.log === 'detect' ? 'detect' : 'final';
  const samples = Array.isArray(data.samples) ? data.samples : [];
  store.lastError = '';
  if (!samples.length) {
    // A payload the ring buffer truncated (or a layout with no samples): say so, draw nothing.
    store.lastError = `${entry.name || 'ITPSD'} #${entry.messageId} carried no samples`;
    return true;
  }
  const chunk = {
    log,
    sequence: Number(data.sequence) || 0,
    frequencyStart: Number(data.frequencyStart),
    stepSize: Number(data.stepSize),
    samples,
    status: data.status ?? null,
    time: entry.time ?? '',
    milliseconds: Number(entry.milliseconds) || 0,
  };
  store.chunks += 1;

  const pending = store.pending[log];
  if (chunk.sequence !== 0) {
    /* A new millisecond means a new sweep: whatever is still buffered belongs to a sweep the
     * receiver never finished sending. */
    if (pending.length && pending[pending.length - 1].milliseconds !== chunk.milliseconds) pending.length = 0;
    if (pending.some((item) => item.sequence === chunk.sequence && item.frequencyStart === chunk.frequencyStart)) {
      store.duplicates += 1;
      return false;
    }
    pending.push(chunk);
    if (pending.length > 8) pending.shift();
    return true;
  }

  const group = pending.splice(0, pending.length);
  group.push(chunk);
  const frame = mergeChunks(group);
  if (!frame) {
    store.lastError = 'the chunks of this sweep do not line up on one frequency grid';
    return true;
  }
  store.skipped += frame.skipped;
  store.frames.push(frame);
  if (store.frames.length > WATERFALL_FRAMES) store.frames.splice(0, store.frames.length - WATERFALL_FRAMES);
  store.latest = frame;
  store.sweeps += 1;
  return true;
}

/** Sort the chunks by frequency and concatenate them when they are contiguous. */
export function mergeChunks(chunks) {
  const sorted = chunks.slice().sort((a, b) => a.frequencyStart - b.frequencyStart);
  const head = sorted[0];
  if (!head) return null;
  const samples = [];
  const parts = [];
  let expected = head.frequencyStart;
  let skipped = 0;
  for (const chunk of sorted) {
    const bin = chunk.stepSize / 1e6;
    const tolerance = bin > 0 ? bin / 2 : 1e-6;
    if (chunk.stepSize !== head.stepSize || Math.abs(chunk.frequencyStart - expected) > tolerance) {
      skipped += 1;
      continue;
    }
    for (let index = 0; index < chunk.samples.length; index += 1) samples.push(chunk.samples[index]);
    parts.push({ sequence: chunk.sequence, samples: chunk.samples.length });
    expected = chunk.frequencyStart + (chunk.samples.length * chunk.stepSize) / 1e6;
  }
  if (!samples.length) return null;
  return {
    log: head.log,
    frequencyStart: head.frequencyStart,
    stepSize: head.stepSize,
    samples,
    parts,
    skipped,
    status: head.status,
    time: head.time,
    milliseconds: head.milliseconds,
  };
}

/** Sweeps the waterfall can stack: the ones sharing the newest sweep's frequency grid. */
export function waterfallFrames(store) {
  const base = store.latest;
  if (!base) return [];
  return store.frames.filter(
    (frame) =>
      frame.frequencyStart === base.frequencyStart &&
      frame.stepSize === base.stepSize &&
      frame.samples.length === base.samples.length,
  );
}

/* ---------------- capture side: `/api/records` rows → the same store ---------------- */

/**
 * The `ITPSDFINAL` / `ITPSDDETECT` status word, decoded exactly like `live.ts` `LiveSpectrumStatus`:
 * bits 0-3 frequency index, 4-7 data source, 8-10 FFT size, 11-15 integration window, 16-19 time
 * average. It describes the sweep's configuration and carries **no** sequence number — that is the
 * OEM7 header word at byte 10, which `/api/records` exposes as `header.sequence`.
 */
export function spectrumStatus(word) {
  const value = Number(word) || 0;
  return {
    word: value,
    frequency: value & 0xf,
    dataSource: (value >>> 4) & 0xf,
    fftSize: (value >>> 8) & 0x7,
    integrationWindow: (value >>> 11) & 0x1f,
    timeAverage: (value >>> 16) & 0xf,
  };
}

/** Raw (not ASCII-rendered) value of one field — `status_word`'s `text` is hex, its `value` is the word. */
function rawField(record, path) {
  const found = (record?.fields ?? []).find((field) => field?.path === path);
  return found ? found.value : undefined;
}

/**
 * One `/api/records` row → the shape `/api/live/logs` gives a sweep chunk, so `ingestSpectrum`
 * cannot tell the two apart. `null` when the row is not an ITPSD log or carries no sample array.
 *
 * The samples travel in `record.arrays`: `logs.ts` `projectFields` lifts the 1024-element
 * `samples[i].samples` vector out of the 800-row field table and ships it as plain numbers. They
 * are still the wire's `uint16`, so the manual's `raw / 256 − 200` dBm conversion happens here —
 * the same two steps `live.ts` applies to the same bytes.
 */
export function captureSpectrumEntry(record) {
  const messageId = Number(record?.messageId ?? record?.header?.messageId);
  const log = messageId === ITPSD_FINAL ? 'final' : messageId === ITPSD_DETECT ? 'detect' : '';
  if (!log) return null;

  const array = (record?.arrays ?? []).find((item) => item?.path === 'samples');
  if (!array || !Array.isArray(array.values) || !array.values.length) return null;

  const frequencyStart = Number(rawField(record, 'frequency_start_m_hz'));
  const stepSize = Number(rawField(record, 'step_size_hz'));
  if (!Number.isFinite(frequencyStart) || !Number.isFinite(stepSize) || stepSize <= 0) return null;

  return {
    name: record?.header?.name || (log === 'final' ? 'ITPSDFINAL' : 'ITPSDDETECT'),
    messageId,
    time: record?.header?.utc ?? '',
    milliseconds: Number(record?.header?.milliseconds) || 0,
    data: {
      kind: 'itpsd',
      log,
      sequence: Number(record?.header?.sequence) || 0,
      status: spectrumStatus(rawField(record, 'status_word')),
      frequencyStart,
      stepSize,
      samples: array.values.map((value) => Number(value) / SAMPLE_SCALE - SAMPLE_OFFSET),
    },
  };
}

/**
 * Fold a page of `/api/records` rows into the store, in the order the server returned them (index
 * order — a DETECT sweep's chunks are `sequence 1 → 0`, and `ingestSpectrum` needs them in that
 * order). Returns how many entries changed the drawing.
 */
export function ingestCaptureRecords(store, records, capture = '') {
  let changed = 0;
  for (const record of records ?? []) {
    const entry = captureSpectrumEntry(record);
    if (!entry) continue;
    store.source = 'capture';
    if (capture) store.capture = capture;
    if (ingestSpectrum(store, entry)) changed += 1;
  }
  return changed;
}

function spectrumRange(frame) {
  let low = Infinity;
  let high = -Infinity;
  for (const value of frame.samples) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: -130, high: -40 };
  let bottom = Math.floor((low - 5) / 10) * 10;
  let top = Math.ceil((high + 5) / 10) * 10;
  if (top - bottom < 20) {
    bottom -= 5;
    top += 5;
  }
  return { low: bottom, high: top };
}

/** Frequency ticks: a round step, at most `max` of them across the sweep. */
function frequencyTicks(from, to, max) {
  const span = to - from;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100];
  const step = steps.find((candidate) => span / candidate <= max) ?? 100;
  const out = [];
  for (let value = Math.ceil(from / step) * step; value <= to; value += step) out.push(Number(value.toFixed(3)));
  return { tick: step, values: out };
}

/** Metadata line under the plot — every number comes from the frame itself. */
function spectrumCaption(frame) {
  if (!frame) return '';
  const n = frame.samples.length;
  const span = (n * frame.stepSize) / 1e6;
  const from = frame.frequencyStart;
  const to = from + span;
  const rbw = frame.stepSize >= 1000 ? `${(frame.stepSize / 1000).toFixed(2)} kHz` : `${frame.stepSize.toFixed(0)} Hz`;
  const log = frame.log === 'detect' ? 'ITPSDDETECT' : 'ITPSDFINAL';
  const chunks = frame.parts.length > 1 ? ` · ${frame.parts.length} logs (sequence ${frame.parts.map((part) => part.sequence).join(' → ')})` : '';
  return `${log} · ${from.toFixed(3)}–${to.toFixed(3)} MHz · RBW ${rbw} · ${n} samples${chunks} · ${frame.time ? frame.time.replace('T', ' ').replace('Z', '') + ' UTC' : '--'}`;
}

/**
 * The real plot: one point per merged sample, x from the frame's own `frequencyStart`/`stepSize`,
 * y auto-scaled around the data in 10 dB steps (the original's `calculateYRangeWithBuffer`).
 */
function spectrumPlotSvg(frame) {
  const W = 1185;
  const H = 300;
  const x0 = 64;
  const x1 = W - 16;
  const yTop = 20;
  const yBottom = H - 38;
  const n = frame.samples.length;
  const from = frame.frequencyStart;
  const to = from + (n * frame.stepSize) / 1e6;
  const { low, high } = spectrumRange(frame);
  const px = (mhz) => x0 + ((mhz - from) / (to - from)) * (x1 - x0);
  const py = (dbm) => yBottom - ((dbm - low) / (high - low)) * (yBottom - yTop);

  const parts = [
    `<svg class="grit-spec-svg" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="Spectrum ${from.toFixed(2)} to ${to.toFixed(2)} MHz, ${n} samples, ${low} to ${high} dBm" ` +
      `data-points="${n}" data-from="${from.toFixed(4)}" data-step="${frame.stepSize}">`,
    `<rect x="${x0}" y="${yTop}" width="${x1 - x0}" height="${yBottom - yTop}" class="grit-spec-plot"/>`,
  ];

  for (let dbm = high; dbm >= low; dbm -= 10) {
    const y = py(dbm).toFixed(1);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="grit-spec-grid"/>`);
    parts.push(`<text x="${x0 - 6}" y="${(Number(y) + 3.4).toFixed(1)}" class="grit-spec-axis" text-anchor="end">${dbm}</text>`);
  }

  const ticks = frequencyTicks(from, to, 10);
  for (const mhz of ticks.values) {
    const x = px(mhz).toFixed(1);
    parts.push(`<line x1="${x}" y1="${yBottom}" x2="${x}" y2="${yBottom + 4}" class="grit-spec-tick"/>`);
    const label = ticks.tick >= 1 ? mhz.toFixed(0) : mhz.toFixed(1);
    parts.push(`<text x="${x}" y="${yBottom + 17}" class="grit-spec-axis" text-anchor="middle">${label}</text>`);
  }
  parts.push(`<text x="${x1}" y="${H - 6}" class="grit-spec-ruler" text-anchor="end">MHz</text>`);

  let trace = '';
  for (let index = 0; index < n; index += 1) {
    const x = px(from + (index * frame.stepSize) / 1e6).toFixed(1);
    const y = py(frame.samples[index]).toFixed(1);
    trace += `${index ? 'L' : 'M'}${x} ${y}`;
  }
  const area =
    `M${px(from).toFixed(1)} ${yBottom}L${trace.slice(1)}L${px(from + ((n - 1) * frame.stepSize) / 1e6).toFixed(1)} ${yBottom}Z`;
  parts.push(`<path d="${area}" class="grit-spec-fill"/>`);
  parts.push(`<path d="${trace}" class="grit-spec-trace" data-points="${n}"/>`);

  /* The band the status word names, as a chip in the corner. */
  const status = frame.status ?? null;
  const bandName = status ? SPECTRUM_FREQUENCIES[status.frequency] ?? `#${status.frequency}` : '';
  const sourceName = status ? SPECTRUM_DATA_SOURCES[status.dataSource] ?? `${status.dataSource}` : '';
  if (bandName) {
    parts.push(`<rect x="${x0 + 8}" y="${yTop + 8}" width="${bandName.length * 6.4 + 14}" height="17" rx="3" class="grit-spec-chip"/>`);
    parts.push(
      `<text x="${x0 + 15}" y="${yTop + 20}" class="grit-spec-chiplabel" text-anchor="start">${esc(bandName)}</text>`,
    );
  }
  if (sourceName) {
    parts.push(
      `<text x="${x1 - 6}" y="${yTop + 20}" class="grit-spec-axis" text-anchor="end">${esc(sourceName)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

function waterfallColor(dbm) {
  if (!Number.isFinite(dbm)) return [0, 0, 0];
  const clamped = Math.min(WATERFALL_MAX, Math.max(WATERFALL_MIN, dbm));
  for (let index = 1; index < WATERFALL_STOPS.length; index += 1) {
    const [value, colour] = WATERFALL_STOPS[index];
    const [prevValue, prevColour] = WATERFALL_STOPS[index - 1];
    if (clamped <= value) {
      const t = value === prevValue ? 0 : (clamped - prevValue) / (value - prevValue);
      return [
        Math.round(prevColour[0] + (colour[0] - prevColour[0]) * t),
        Math.round(prevColour[1] + (colour[1] - prevColour[1]) * t),
        Math.round(prevColour[2] + (colour[2] - prevColour[2]) * t),
      ];
    }
  }
  return WATERFALL_STOPS[WATERFALL_STOPS.length - 1][1];
}

/**
 * Waterfall: newest sweep on top, one pixel per (sweep, bin). Rasterised on a canvas and embedded
 * as an `<image>`, because 10 × 1365 `<rect>`s would be tens of thousands of DOM nodes.
 */
function waterfallSvg(rows) {
  const base = rows[rows.length - 1];
  const n = base.samples.length;
  const W = 1185;
  const H = 300;
  const x0 = 64;
  const x1 = W - 16;
  const yTop = 20;
  const yBottom = H - 38;
  const from = base.frequencyStart;
  const to = from + (n * base.stepSize) / 1e6;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, n);
  canvas.height = Math.max(1, rows.length);
  const context = canvas.getContext('2d');
  let href = '';
  if (context) {
    const image = context.createImageData(canvas.width, canvas.height);
    for (let row = 0; row < rows.length; row += 1) {
      const samples = rows[rows.length - 1 - row].samples; // newest first
      for (let col = 0; col < n; col += 1) {
        const [r, g, b] = waterfallColor(samples[col]);
        const at = (row * n + col) * 4;
        image.data[at] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    href = canvas.toDataURL('image/png');
  }

  const parts = [
    `<svg class="grit-spec-svg" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="Waterfall of ${rows.length} sweeps, ${from.toFixed(2)} to ${to.toFixed(2)} MHz" ` +
      `data-frames="${rows.length}" data-points="${n}">`,
    `<rect x="${x0}" y="${yTop}" width="${x1 - x0}" height="${yBottom - yTop}" class="grit-spec-plot"/>`,
  ];
  if (href) {
    parts.push(
      `<image href="${href}" x="${x0}" y="${yTop}" width="${x1 - x0}" height="${yBottom - yTop}" preserveAspectRatio="none"/>`,
    );
  } else {
    parts.push(
      `<text x="${(x0 + x1) / 2}" y="${(yTop + yBottom) / 2}" class="grit-spec-empty" text-anchor="middle">Waterfall needs a canvas — this browser did not provide one</text>`,
    );
  }

  const ticks = frequencyTicks(from, to, 10);
  for (const mhz of ticks.values) {
    const x = (x0 + ((mhz - from) / (to - from)) * (x1 - x0)).toFixed(1);
    parts.push(`<line x1="${x}" y1="${yBottom}" x2="${x}" y2="${yBottom + 4}" class="grit-spec-tick"/>`);
    const label = ticks.tick >= 1 ? mhz.toFixed(0) : mhz.toFixed(1);
    parts.push(`<text x="${x}" y="${yBottom + 17}" class="grit-spec-axis" text-anchor="middle">${label}</text>`);
  }
  parts.push(`<text x="${x1}" y="${H - 6}" class="grit-spec-ruler" text-anchor="end">MHz</text>`);
  parts.push(`<text x="${x0 - 6}" y="${yTop + 10}" class="grit-spec-axis" text-anchor="end">newest</text>`);
  parts.push(`<text x="${x0 - 6}" y="${yBottom}" class="grit-spec-axis" text-anchor="end">oldest</text>`);

  /* Colour legend: the same −135 … −30 dBm map the raster uses, on a pale plate so it stays
     readable over the raster it sits on. */
  const legendX = x1 - 150;
  const legendY = yTop + 6;
  parts.push(
    `<rect x="${legendX - 8}" y="${legendY - 5}" width="172" height="26" rx="2" fill="#ffffff" fill-opacity="0.86"/>`,
  );
  for (let step = 0; step < 60; step += 1) {
    const dbm = WATERFALL_MIN + ((WATERFALL_MAX - WATERFALL_MIN) * step) / 59;
    const [r, g, b] = waterfallColor(dbm);
    parts.push(
      `<rect x="${legendX + step * 2}" y="${legendY}" width="2" height="8" fill="rgb(${r},${g},${b})"/>`,
    );
  }
  parts.push(
    `<text x="${legendX}" y="${legendY + 20}" class="grit-spec-axis" text-anchor="start">${WATERFALL_MIN} dBm</text>`,
    `<text x="${legendX + 120}" y="${legendY + 20}" class="grit-spec-axis" text-anchor="start">${WATERFALL_MAX} dBm</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
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
 * Why the Spectrum tile is empty. Every branch is something this build can actually check; none
 * of them guesses. The order is "what the user just did" first, so the sentence names the fix.
 */
function spectrumReason(state) {
  const live = state.live;
  const name = state.capture ? baseName(state.capture) : '';
  if (live.connected) {
    return (
      `Connected to ${live.target || 'the receiver'} — no ITPSDFINAL/ITPSDDETECT yet. ` +
      'The spectrum only arrives while a sweep runs: Settings → Spectrum Analysis (or ' +
      '`ITSPECTRALANALYSIS predecimation gpsl1 1000 1K 10 5` from Manage → Terminal).'
    );
  }
  if (state.spectrumLoading) {
    return `Reading ${name || 'the capture'} — the newest ITPSDFINAL/ITPSDDETECT records are being decoded from /api/records.`;
  }
  if (live.lastError && !name) return `Live link error: ${live.lastError}`;
  const totals = state.spectrumTotals;
  if (name && totals && !totals.final && !totals.detect) {
    return (
      `No spectrum data — ${name} carries no ITPSDFINAL #1968 / ITPSDDETECT #2063 record, and no live ` +
      'session is open. The receiver only logs a PSD while ITSPECTRALANALYSIS runs ' +
      '(Settings → Spectrum Analysis).'
    );
  }
  if (live.everConnected) {
    return `Live session closed${live.disconnectedAt ? ` at ${live.disconnectedAt.replace('T', ' ').replace('Z', '')} UTC` : ''} — no spectrum is drawn from a dead link.`;
  }
  return (
    'No spectrum data — open a capture that contains ITPSDFINAL/ITPSDDETECT (for example ' +
    'live-20261031/b1-20261101.sbf), or connect a receiver and start a sweep: ' +
    'Settings → Spectrum Analysis.'
  );
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
  /* A live session's own last record wins over the capture's clock; when it closes the band falls
     back to the capture's last solution (see `pollLive`). */
  setText(
    root,
    'devTime',
    state.live?.connected && state.live.lastRecordAt
      ? hhmmss(state.live.lastRecordAt)
      : state.time ?? '--:--:--',
  );
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

/**
 * Draw whichever view is selected. `state.spectrum` is the live store from `mount`; nothing here
 * invents a curve — with no merged sweep the placeholder frame stays and the note says why.
 */
function renderSpectrum(root, state) {
  const plot = root.querySelector('[data-el="spectrum"]');
  const note = root.querySelector('[data-el="specNote"]');
  if (!plot) return;
  const store = state.spectrum;
  const frame = store?.latest ?? null;

  if (!frame) {
    /* The reference frame is redrawn whenever anything else is on screen: opening a capture with
       no ITPSD after one that had a spectrum must not leave the previous curve behind. */
    if (!plot.querySelector('.grit-spec-empty')) plot.innerHTML = placeholderSpectrumSvg();
    const empty = plot.querySelector('.grit-spec-empty');
    if (empty) {
      empty.style.display = '';
      empty.textContent = 'No spectrum data';
    }
    if (note) {
      note.hidden = false;
      note.textContent = store?.lastError ? `${spectrumReason(state)} (${store.lastError})` : spectrumReason(state);
    }
    return;
  }

  const rows = waterfallFrames(store);
  if (state.view === 'waterfall') {
    plot.innerHTML = rows.length ? waterfallSvg(rows) : placeholderSpectrumSvg();
    if (!rows.length) {
      const empty = plot.querySelector('.grit-spec-empty');
      if (empty) empty.textContent = 'Waterfall needs two sweeps on one frequency grid';
    }
  } else {
    plot.innerHTML = spectrumPlotSvg(frame);
  }

  if (note) {
    note.hidden = false;
    const base = spectrumCaption(frame);
    const origin = store.source === 'capture' && store.capture ? ` · capture ${baseName(store.capture)}` : '';
    note.textContent =
      state.view === 'waterfall'
        ? `${base} · waterfall ${rows.length}/${WATERFALL_FRAMES} sweeps${origin}`
        : store.lastError
          ? `${base} · ${store.lastError}${origin}`
          : `${base}${origin}`;
  }
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

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();
  const page = root.querySelector('[data-el="page"]');
  const state = {
    capture: '',
    position: null,
    tracked: null,
    used: null,
    time: null,
    device: null,
    matrix: null,
    info: null,
    events: 0,
    /** `spectrum` | `waterfall` — which renderer the tile draws. */
    view: 'spectrum',
    /** ITPSD sweeps from whichever source owns the tile, see `ingestSpectrum`. */
    spectrum: emptySpectrumStore(),
    /** ITPSDFINAL / ITPSDDETECT chunk counts of the open capture (`/api/logs`). */
    spectrumTotals: null,
    /** True while the capture's spectrum page is in flight — the note says so instead of "none". */
    spectrumLoading: false,
    live: {
      connected: false,
      everConnected: false,
      session: '',
      target: '',
      disconnectedAt: '',
      lastError: '',
      lastRecordAt: '',
      cursor: 0,
      records: 0,
      busy: false,
      timer: 0,
    },
  };

  let token = 0;
  let disposed = false;
  /** The capture page already read (`capture|log|offset`), so a re-render never re-fetches it. */
  let spectrumPage = '';

  const load = async () => {
    const mine = ++token;
    const capture = ctx.capture || '';
    try {
      const next = await readStatus(ctx, capture);
      if (disposed || mine !== token) return;
      const captureChanged = state.capture !== capture;
      Object.assign(state, next);
      if (captureChanged) {
        state.spectrum = emptySpectrumStore();
        spectrumPage = '';
      }
      renderBand(root, state);
      renderMatrix(root, state);
      renderSpectrum(root, state);
      renderDock(root, state);
      injectAppBar(root, state);
      /* Only now that the dashboard has painted: the spectrum is a second, optional read. */
      void requestCaptureSpectrum();
    } catch (error) {
      if (disposed || mine !== token) return;
      console.error('[grit] 读取抓包失败：', error);
    }
  };

  /* ---------------- capture spectrum: one `/api/records` page into the same store ---------------- */

  /**
   * Read the newest ITPSD page of the open capture, once, after the first paint.
   *
   * `limit` is capped at 25 by `/api/records`, and 25 chunks are more than the ten sweeps the
   * waterfall keeps, so one request covers curve + waterfall. Measured on `b1-20261101.sbf`:
   * 25 ITPSDFINAL records = 172 395 B (7 043 B each — the 1024 samples as numbers, not as 1024
   * field rows, which cost 50 381 B per record). Nothing is fetched while a live session owns the
   * tile, and nothing is fetched twice for the same capture and page.
   */
  async function requestCaptureSpectrum() {
    const capture = state.capture;
    const totals = state.spectrumTotals;
    if (disposed || !capture || !totals || state.live.connected) return;

    /* ITPSDFINAL is the processed PSD the original's plot tab is built on; ITPSDDETECT is the
       detection view of the same sweep. Both decode into one store, one log at a time. */
    const log = totals.final > 0 ? 'final' : totals.detect > 0 ? 'detect' : '';
    if (!log) return;
    const total = log === 'final' ? totals.final : totals.detect;
    const msgId = log === 'final' ? ITPSD_FINAL : ITPSD_DETECT;
    /* A DETECT sweep is two chunks (`sequence 1 → 0`), so its page is even: an odd offset would
       be as likely to split a sweep as not. */
    const page = log === 'detect' ? CAPTURE_SPECTRUM_PAGE - 1 : CAPTURE_SPECTRUM_PAGE;
    const offset = Math.max(0, total - page);
    const key = `${capture}|${log}|${offset}`;
    if (key === spectrumPage) return;

    spectrumPage = key;
    state.spectrumLoading = true;
    renderSpectrum(root, state);
    try {
      const data = await api.get('/api/records', { capture, msgId, offset, limit: page });
      if (disposed) return;
      state.spectrumLoading = false;
      ingestCaptureRecords(state.spectrum, data?.records ?? [], capture);
      renderSpectrum(root, state);
    } catch (error) {
      if (disposed) return;
      state.spectrumLoading = false;
      state.spectrum.lastError = `capture spectrum: ${error.message}`;
      renderSpectrum(root, state);
    }
  }

  /* ---------------- live session: the other source of spectrum samples ---------------- */

  /**
   * One poll for the whole panel: `/api/live/status` decides whether the link is up, then the log
   * cursor feeds `ingestSpectrum`. A reconnect (`connectedAt` changed) starts a new sweep history,
   * so a stale curve never survives a different session.
   */
  async function pollLive() {
    if (disposed || state.live.busy) return;
    state.live.busy = true;
    try {
      await pollLiveOnce();
    } finally {
      state.live.busy = false;
    }
  }

  async function pollLiveOnce() {
    if (disposed) return;
    let status;
    try {
      status = await api.get('/api/live/status');
    } catch (error) {
      if (disposed) return;
      if (state.live.connected || !state.live.lastError) {
        state.live.connected = false;
        state.live.lastError = `API error: ${error.message}`;
        renderSpectrum(root, state);
      }
      return;
    }
    if (disposed) return;

    const connected = Boolean(status.connected);
    state.live.target = status.target || state.live.target;
    state.live.lastError = status.lastError || '';
    state.live.disconnectedAt = status.disconnectedAt || state.live.disconnectedAt;

    if (connected) {
      state.live.everConnected = true;
      state.live.disconnectedAt = '';
      if (state.live.session !== (status.connectedAt || '')) {
        state.live.session = status.connectedAt || '';
        state.live.cursor = 0;
        state.spectrum = emptySpectrumStore();
        renderSpectrum(root, state);
      }
      try {
        const page = await api.get('/api/live/logs', { after: state.live.cursor });
        if (disposed) return;
        state.live.cursor = Number(page.cursor) || state.live.cursor;
        let changed = false;
        for (const entry of page.entries ?? []) {
          state.live.records += 1;
          if (entry.time) state.live.lastRecordAt = entry.time;
          if (ingestSpectrum(state.spectrum, entry)) {
            changed = true;
            /* The live stream owns the tile from now on; a capture page must not blend into it. */
            state.spectrum.source = 'live';
            state.spectrum.capture = '';
          }
        }
        if (changed) renderSpectrum(root, state);
        if (state.live.lastRecordAt) setText(root, 'devTime', hhmmss(state.live.lastRecordAt));
      } catch (error) {
        if (disposed) return;
        state.live.lastError = error.message;
      }
    }

    const wasConnected = state.live.connected;
    state.live.connected = connected;
    if (wasConnected !== connected) {
      /* The band's clock follows the live records while a session is up, and falls back to the
         capture's own last solution when it closes. */
      if (!connected) {
        renderBand(root, state);
        /* The live stream's sweep history went with the session; hand the tile back to the
           capture. The store is empty again, so the capture page is read once more. */
        state.spectrum = emptySpectrumStore();
        spectrumPage = '';
        void requestCaptureSpectrum();
      }
      renderSpectrum(root, state);
    }
  }

  function startLive() {
    stopLive();
    state.live.timer = setInterval(() => {
      void pollLive();
    }, LIVE_POLL_MS);
    void pollLive();
  }
  function stopLive() {
    if (state.live.timer) {
      clearInterval(state.live.timer);
      state.live.timer = 0;
    }
  }

  /* ---------------- Timeline dock (collapsed by default, like the original's `Timeline ▲`) ---------------- */
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

  /* ---- Spectrum / Waterfall: two renderers over the same merged sweeps ---- */
  const segs = Array.from(root.querySelectorAll('[data-spec]'));
  const onSeg = (event) => {
    const view = event.currentTarget.getAttribute('data-spec');
    state.view = view === 'waterfall' ? 'waterfall' : 'spectrum';
    for (const seg of segs) {
      const on = seg === event.currentTarget;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    renderSpectrum(root, state);
  };
  for (const seg of segs) seg.addEventListener('click', onSeg);

  /* ---------------- menus ---------------- */

  const menuPop = root.querySelector('[data-el="menuPop"]');
  const menuButtons = Array.from(root.querySelectorAll('[data-grit-menu]'));
  const specGear = root.querySelector('[data-el="specGear"]');

  /** Advanced spectrum settings, as the original's `advSettings` object. */
  const adv = { mode: 'PREDECIMATION', frequency: 'GPSL1', updateRate: 1, resolution: 1, timeAverage: 10, sensitivity: 5 };

  /** Prefill from the newest status word when the receiver already told us the configuration. */
  function prefillFromStatus() {
    const status = state.spectrum.latest?.status;
    if (!status) return;
    const name = SPECTRUM_FREQUENCIES[status.frequency];
    if (name && name !== 'Reserved') adv.frequency = name;
    if (SPECTRUM_DATA_SOURCES[status.dataSource] && status.dataSource !== 0) adv.mode = SPECTRUM_DATA_SOURCES[status.dataSource];
    if (Number.isFinite(status.fftSize) && SPECTRUM_FFT_SIZES[status.fftSize]) adv.resolution = SPECTRUM_FFT_SIZES[status.fftSize];
    if (Number.isFinite(status.timeAverage)) adv.timeAverage = status.timeAverage;
    if (Number.isFinite(status.integrationWindow) && status.integrationWindow > 0) adv.sensitivity = status.integrationWindow;
  }

  function statusWordLine() {
    const status = state.spectrum.latest?.status;
    if (!status) return 'No status word yet — the receiver has not sent ITPSDFINAL/ITPSDDETECT.';
    return (
      `Receiver status word 0x${(status.word >>> 0).toString(16).padStart(8, '0')}: ` +
      `${SPECTRUM_FREQUENCIES[status.frequency] ?? status.frequency} · ` +
      `${SPECTRUM_DATA_SOURCES[status.dataSource] ?? status.dataSource} · ` +
      `${SPECTRUM_FFT_SIZES[status.fftSize] ?? '?'}K FFT · avg ${status.timeAverage} s · window ${status.integrationWindow}`
    );
  }

  function settingsPanel() {
    prefillFromStatus();
    const modeOptions = SPECTRUM_DATA_SOURCES.map(
      (name) => `<option value="${name}"${name === adv.mode ? ' selected' : ''}>${name}</option>`,
    ).join('');
    const frequencyOptions = SPECTRUM_FREQUENCIES.map(
      (name) => `<option value="${name}"${name === adv.frequency ? ' selected' : ''}>${name}</option>`,
    ).join('');
    const resolutionOptions = SPECTRUM_FFT_SIZES.map(
      (size) => `<option value="${size}"${size === adv.resolution ? ' selected' : ''}>${size}K</option>`,
    ).join('');
    const form = document.createElement('div');
    form.className = 'grit-pop-panel';
    form.innerHTML = `
      <p class="grit-pop-note">${esc(statusWordLine())}</p>
      <label class="grit-field"><span>Mode</span><select class="grit-input" data-adv="mode">${modeOptions}</select></label>
      <label class="grit-field"><span>Frequency</span><select class="grit-input" data-adv="frequency">${frequencyOptions}</select></label>
      <label class="grit-field"><span>Update Rate (s)</span><input class="grit-input" type="number" min="0.05" max="100" step="0.05" data-adv="updateRate" value="${adv.updateRate}"></label>
      <label class="grit-field"><span>Spectrum Resolution (K)</span><select class="grit-input" data-adv="resolution">${resolutionOptions}</select></label>
      <label class="grit-field"><span>Time Averaging (s)</span><input class="grit-input" type="number" min="0" max="50" step="1" data-adv="timeAverage" value="${adv.timeAverage}"></label>
      <label class="grit-field"><span>Detection Sensitivity (bins)</span><input class="grit-input" type="number" min="1" max="30" step="1" data-adv="sensitivity" value="${adv.sensitivity}"></label>
      <div class="grit-pop-actions">
        <button type="button" class="grit-pop-btn" data-adv-apply>Apply</button>
        <button type="button" class="grit-pop-btn is-ghost" data-adv-off>Turn Off</button>
      </div>
      <p class="grit-pop-note" data-adv-status>Sent as <code>ITSPECTRALANALYSIS …</code> over the live link.</p>
    `;

    const status = form.querySelector('[data-adv-status]');
    const readNumber = (name) => Number(form.querySelector(`[data-adv="${name}"]`).value);
    const readForm = () => {
      adv.mode = form.querySelector('[data-adv="mode"]').value;
      adv.frequency = form.querySelector('[data-adv="frequency"]').value;
      adv.resolution = Number(form.querySelector('[data-adv="resolution"]').value);
      adv.updateRate = readNumber('updateRate');
      adv.timeAverage = readNumber('timeAverage');
      adv.sensitivity = readNumber('sensitivity');
    };

    /** The manual's limits: 50…100000 ms, and the FFT size raises the floor (32K → 100, 64K → 200). */
    const validate = () => {
      if (!Number.isFinite(adv.updateRate) || adv.updateRate < 0.05 || adv.updateRate > 100) return 'Update Rate must be 0.05 – 100 s.';
      if (!Number.isFinite(adv.timeAverage) || adv.timeAverage < 0 || adv.timeAverage > 50) return 'Time Averaging must be 0 – 50 s.';
      if (!Number.isFinite(adv.sensitivity) || adv.sensitivity < 1 || adv.sensitivity > 30) return 'Detection Sensitivity must be 1 – 30 bins.';
      const period = Math.round(adv.updateRate * 1000);
      if (period < 50) return 'Update Rate must be at least 0.05 s (50 ms).';
      if (adv.resolution >= 32 && period < 100) return 'A 32K FFT needs an update period of at least 100 ms.';
      if (adv.resolution >= 64) {
        if (period < 200) return 'A 64K FFT needs an update period of at least 200 ms.';
        if (adv.mode === 'POSTDECIMATION' || adv.mode === 'POSTFILTER') return 'The 64K FFT is not available in post-decimation or post-filter mode.';
      }
      return '';
    };

    const send = async (line) => {
      if (!status) return;
      status.textContent = `Sending ${line} …`;
      try {
        const result = await api.post('/api/live/command', { line });
        const ok = Boolean(result.connected) && result.commands?.at(-1)?.ok !== false;
        status.textContent = ok
          ? `Sent: ${line}`
          : `Not sent — ${result.lastError || 'no live session'}. The command is logged and can be typed in Manage → Terminal.`;
      } catch (error) {
        status.textContent = `Failed: ${error.message}`;
      }
    };

    form.querySelector('[data-adv-apply]').addEventListener('click', () => {
      readForm();
      const problem = validate();
      if (problem) {
        status.textContent = problem;
        return;
      }
      const period = Math.round(adv.updateRate * 1000);
      void send(
        `ITSPECTRALANALYSIS ${adv.mode} ${adv.frequency} ${period} ${adv.resolution}K ${adv.timeAverage} ${adv.sensitivity}`,
      );
    });
    form.querySelector('[data-adv-off]').addEventListener('click', () => {
      void send('ITSPECTRALANALYSIS OFF');
    });
    return form;
  }

  function downloadCsv() {
    const frame = state.spectrum.latest;
    if (!frame) return 'No spectrum to export yet.';
    const rows = ['frequency_mhz,psd_dbm'];
    const span = (frame.samples.length * frame.stepSize) / 1e6;
    for (let index = 0; index < frame.samples.length; index += 1) {
      const mhz = frame.frequencyStart + (index * frame.stepSize) / 1e6;
      rows.push(`${mhz.toFixed(6)},${frame.samples[index].toFixed(3)}`);
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `grit-spectrum-${frame.log}-${frame.frequencyStart.toFixed(3)}MHz.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    return `Exported ${frame.samples.length} samples (${frame.frequencyStart.toFixed(3)}–${(frame.frequencyStart + span).toFixed(3)} MHz).`;
  }

  function popItem(label, act, hint) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'grit-pop-item';
    button.dataset.act = act;
    button.innerHTML = `<span>${esc(label)}</span>${hint ? `<span class="grit-pop-hint">${esc(hint)}</span>` : ''}`;
    return button;
  }

  const MENUS = {
    settings: () => [
      popItem('Spectrum Analysis…', 'spectrum-settings', 'ITSPECTRALANALYSIS'),
      popItem('Networking…', 'networking', 'not in this build'),
      popItem('Map…', 'map', 'not in this build'),
    ],
    tools: () => [
      popItem('Terminal', 'terminal', 'opens Manage'),
      popItem('Clear spectrum buffers', 'clear', `${state.spectrum.sweeps} sweeps held`),
      popItem('Export spectrum (CSV)', 'export', state.spectrum.latest ? `${state.spectrum.latest.samples.length} samples` : 'no data'),
    ],
    help: () => [
      popItem('About GRIT Monitor', 'about', 'build + decoder facts'),
      popItem('Help file', 'helpfile', 'not bundled'),
    ],
  };

  const PLACEHOLDER = {
    networking: 'Networking settings are the receiver’s IP configuration; this build has that page under Configuration, not inside GRIT — the menu entry keeps the original’s position.',
    map: 'Map settings configure the basemap layer (Luciad in the original). No basemap renderer ships here, so there is nothing to configure.',
    helpfile: 'The original opens its offline helpFile.html (680 KB of GRIT documentation). That file is not part of this reimplementation; the tile captions and the About panel carry what is known.',
  };

  /** Replace the popover body; `keepOpen` so clicking an item inside does not close it. */
  function showMenu(key) {
    menuPop.innerHTML = '';
    const items = MENUS[key] ? MENUS[key]() : [];
    const list = document.createElement('div');
    list.className = 'grit-pop-list';
    for (const item of items) list.appendChild(item);
    menuPop.appendChild(list);
    menuPop.dataset.for = key || '';
    menuPop.hidden = false;

    const note = document.createElement('p');
    note.className = 'grit-pop-note';
    note.hidden = true;
    menuPop.appendChild(note);
    menuPop.__note = note;
    clampPop();
  }

  async function runMenuAction(act) {
    const note = menuPop.__note;
    if (act === 'spectrum-settings') {
      const existing = menuPop.querySelector('.grit-pop-panel');
      if (existing) existing.remove();
      else menuPop.appendChild(settingsPanel());
      clampPop();
      return;
    }
    if (act === 'terminal') {
      const tab = document.querySelector('[data-tab="manage"]');
      if (tab) tab.click();
      if (note) {
        note.hidden = false;
        note.textContent = 'Switched to Manage — its Terminal drawer is where a connection is opened and commands are typed.';
      }
      return;
    }
    if (act === 'clear') {
      state.spectrum = emptySpectrumStore();
      /* Let the open capture (or the next live poll) refill the tile. */
      spectrumPage = '';
      renderSpectrum(root, state);
      void requestCaptureSpectrum();
      if (note) {
        note.hidden = false;
        note.textContent = 'Cleared the sweeps held in this page (the server’s 400-record ring buffer is untouched).';
      }
      showMenu('tools');
      return;
    }
    if (act === 'export') {
      if (note) {
        note.hidden = false;
        note.textContent = downloadCsv();
      }
      return;
    }
    if (act === 'about') {
      if (note) {
        note.hidden = false;
        let health = null;
        try {
          health = await api.get('/api/health');
        } catch {
          health = null;
        }
        note.textContent =
          `GRIT Monitor — NovAtel Application Suite reimplementation. ` +
          `Spectrum: ITPSDFINAL #1968 / ITPSDDETECT #2063, sample = raw/256 − 200 dBm, ` +
          `chunks grouped by the OEM7 header sequence word (0 = last chunk), read from the live ` +
          `session or from the open capture's records. ` +
          `Waterfall: newest ${WATERFALL_FRAMES} sweeps, −135 … −30 dBm. ` +
          (health ? `Server ${health.version ?? '--'} on Node ${health.node ?? '--'}.` : 'Server build info unavailable.');
      }
      return;
    }
    if (note && PLACEHOLDER[act]) {
      note.hidden = false;
      note.textContent = PLACEHOLDER[act];
    }
  }

  /** Put the popover under the control that opened it (`.grit-page` is the offset parent). */
  function anchorPop(element) {
    if (!element) return;
    const host = page.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    menuPop.style.left = `${Math.round(rect.left - host.left)}px`;
    menuPop.style.right = 'auto';
  }

  /** Keep the popover inside the page: a panel that overflows would scroll the layout sideways. */
  function clampPop() {
    const host = page.getBoundingClientRect();
    const width = menuPop.offsetWidth || 300;
    const left = Number.parseFloat(menuPop.style.left || '0') || 0;
    const max = host.width - width - 8;
    if (left > max) menuPop.style.left = `${Math.max(8, Math.round(max))}px`;
  }

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
    anchorPop(event.currentTarget);
    showMenu(key);
  };
  for (const button of menuButtons) button.addEventListener('click', onMenu);

  const onMenuClick = (event) => {
    const item = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!item || !menuPop.contains(item)) return;
    void runMenuAction(item.getAttribute('data-act'));
  };
  menuPop.addEventListener('click', onMenuClick);

  /* The gear inside the Spectrum tile opens the same settings form the Settings menu does. */
  const onGear = () => {
    anchorPop(specGear);
    showMenu('settings');
    menuPop.dataset.for = 'settings';
    for (const button of menuButtons) {
      const on = button.getAttribute('data-grit-menu') === 'settings';
      button.setAttribute('aria-expanded', on ? 'true' : 'false');
      button.classList.toggle('is-open', on);
    }
    void runMenuAction('spectrum-settings');
  };
  if (specGear) specGear.addEventListener('click', onGear);

  const onDocumentClick = (event) => {
    if (!menuPop || menuPop.hidden) return;
    if (menuPop.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-grit-menu]')) return;
    if (event.target instanceof Element && event.target.closest('[data-el="specGear"]')) return;
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
    stopLive();
    offCapture?.();
    document.removeEventListener('click', onDocumentClick);
    menuPop.removeEventListener('click', onMenuClick);
    if (specGear) specGear.removeEventListener('click', onGear);
    dockToggle.removeEventListener('click', onDock);
    for (const tab of tabs) tab.removeEventListener('click', onTab);
    for (const seg of segs) seg.removeEventListener('click', onSeg);
    for (const button of menuButtons) button.removeEventListener('click', onMenu);
  };

  renderSpectrum(root, state);
  startLive();
  load();
  return page;
}
