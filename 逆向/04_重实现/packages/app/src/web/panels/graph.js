/**
 * Graph panel — the Graph suite application rebuilt as a page inside the shell.
 *
 * The original Graph is a **separate process** (its own Electron window, `逆向/01_解包/Graph`), so the
 * reference screenshots `ref-ui/graph-app.png` (home) and `ref-ui/graph-project.png` (workspace) carry
 * their own app bar. Inside the shell that app bar is the shell's own banner, so what this panel
 * rebuilds is everything **below** it, in two views:
 *
 *   home       logo · blurb · "Graph" · New Project / Open Project · Recent Projects
 *   workspace  black menu bar (Overview / PVT / Tracking & Measurements / Receiver Status /
 *              Project Information + Export) · map stage (Legend, map controls, the chart) ·
 *              bottom timeline (Flags, Start/End GPS, transport, clock, Speed, Show Events)
 *
 * Every number in `graph.css` is either measured off those two screenshots (÷1.5 — the capture is
 * 2560×1600 at 150 % DPI = 1706.67×1066.67 CSS) or quoted from the shipped Graph stylesheet
 * `逆向/01_解包/Graph/out/renderer/assets/index-wcmwkRqN.css` (`._mapControls_jjbts_*` for the map
 * control column). Where the two disagree the screenshot wins, because that is what is being
 * compared.
 *
 * What is real here and what is not:
 *   real      `/api/graph/files` + `/api/graph/data` (the CSVs Graph already exported), the CSV /
 *             column pickers, the 20-row table, the line chart, the timeline playhead (rAF, Speed
 *             multiplier), the Export menu (CSV · HTML · KML · PDF — see `exportAs()`)
 *   real      the four tabs under Overview — PVT / Tracking & Measurements / Receiver Status /
 *             Project Information. Every tile is one plot of `06_Graph应用-附录/C_图表目录.json`
 *             whose CSV this project actually exported (12 of the catalog's 16), and every series
 *             is one column of one CSV read through `/api/graph/data?file=&column=`. Titles, plot
 *             kinds and y-axis units are the catalog's, verbatim; `chartSvgFor()` draws the same
 *             axes/grid/typography as the Overview chart, only repeated per tile.
 *   real      the Overview map, in **two renderers**. The default is the original engine —
 *             LuciadRIA 2026.0 taken out of the shipped Graph bundle (`/geo/luciad-engine.js`) and
 *             run in a same-origin iframe (`web/geo/luciad-stage.html`, because the shell's CSP
 *             forbids wasm) — drawing `2D Trajectory.csv`, the `Position SD.csv` 1σ ring, a
 *             graticule and the timeline cursor as Luciad features. When the engine cannot start
 *             (no `/geo` route, no WebGPU, 16 MB module blocked) or `?map=canvas` asks for it,
 *             `mapSvg()` draws the same picture as SVG. The stage never claims to be Luciad unless
 *             the stage itself reported `ready`; the failure path prints the reason on the stage.
 *   honest    a tile whose CSV is missing, whose column cannot be read, or whose rows
 *             `/api/graph/data` truncates prints `--` plus the reason instead of a curve;
 *             `Project Information` shows no message counts because `DataSummary.json` is not behind
 *             `/api/graph/*`, and the catalog's Heading & Attitude / Velocity plots have no tab or
 *             tile because this project (`clean`) exported no INS data
 *
 * Contract with the shell (`src/web/index.html`): `mount(root, ctx)` / `unmount(root)`,
 * `ctx = { api: { get, post }, capture, onCaptureChange }`.
 */

const CSS_URL = new URL('./graph.css', import.meta.url).href;
const CSS_ID = 'nas-panel-graph-css';

/** The CSV the old in-shell page opened first, kept so the panel still lands on a useful series. */
const PREFERRED_CSV = 'GNSS Signal Strength.csv';

/* ---------------- map engine ---------------- */

/**
 * Which renderer draws the Overview map.
 *
 *   luciad  the **original engine** — LuciadRIA 2026.0 out of the shipped Graph bundle, in an iframe
 *           (`web/geo/luciad-stage.html`) because the shell's CSP forbids wasm. This is the default.
 *   canvas  this file's own SVG graticule (`mapSvg()`), used when the engine cannot start and when
 *           `?map=canvas` asks for it.
 *
 * `luciad` is only ever "ready" after the stage has answered `postMessage` — until then, and forever
 * after a failure, the stage says so on screen and the SVG map stays up. Nothing claims to be Luciad
 * unless Luciad is what painted the pixels.
 */
export const MAP_ENGINES = ['luciad', 'canvas'];

/** `?map=canvas` → the self-drawn basemap; anything else (including nothing) → Luciad. */
export function mapEngineFromSearch(search) {
  const raw = String(search == null ? '' : search);
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  let value = '';
  try {
    value = (new URLSearchParams(query).get('map') || '').trim().toLowerCase();
  } catch {
    value = '';
  }
  return value === 'canvas' || value === 'svg' ? 'canvas' : 'luciad';
}

/** The stage document, resolved next to this panel (`/panels/graph.js` → `/geo/luciad-stage.html`). */
export const LUCIAD_STAGE_URL = new URL('../geo/luciad-stage.html', import.meta.url).href;

/** A 16 MB module plus a wasm boot on a cold cache; past this the panel stops waiting and says so. */
export const LUCIAD_READY_TIMEOUT_MS = 30_000;

/** `Speed` dropdown choices — the original ships 1× / 2× / 5× / 10×. */
const SPEEDS = [1, 2, 5, 10];

/** `Flags (0/10)`: no flag store exists in this build, so the counter is honest zeros. */
const FLAG_LIMIT = 10;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pvt', label: 'PVT' },
  { id: 'tracking', label: 'Tracking & Measurements' },
  { id: 'receiver', label: 'Receiver Status' },
  { id: 'project', label: 'Project Information' },
];

/** Export formats; `csv` / `html` / `pdf` are built from the loaded CSV, `kml` reuses Convert. */
const EXPORTS = [
  { id: 'csv', label: 'CSV', hint: '绘图数据（时间 + 数值列）' },
  { id: 'html', label: 'HTML', hint: '独立报表（折线图 + 前 20 行）' },
  { id: 'kml', label: 'KML', hint: '轨迹（复用 /api/convert 的 KML 导出）' },
  { id: 'pdf', label: 'PDF', hint: '浏览器打印为 PDF' },
];

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

function bytesText(n) {
  const value = Number(n) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1048576) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB';
  return (value / 1048576).toFixed(2) + ' MB';
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

/** Fallback API for a standalone panel import (the shell always passes its own `ctx.api`). */
function defaultApi() {
  const request = async (path, init) => {
    const response = await fetch(path, init);
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  };
  return {
    get: (path, params) => request(withQuery(path.startsWith('/api') ? path : `/api${path}`, params)),
    post: (path, body) =>
      request(path.startsWith('/api') ? path : `/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

function pad2(value) {
  return String(Math.abs(Math.trunc(value))).padStart(2, '0');
}

/** `218.4` → `00:03:38` — the clock under the transport (`current|total`). */
function hhmmss(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${pad2(total / 3600)}:${pad2((total % 3600) / 60)}:${pad2(total % 60)}`;
}

/* `00:00:04` (the CSV's `#Duration`) → 4 seconds. */
function parseDuration(text) {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `#Start Time(GPS): 2442,463097.350` → `October 30, 2026`.
 *
 * GPS week 2442 / 463 097.35 s really is 2026-10-30T08:37:59Z (18 leap seconds since 2017), which is
 * the date the original home page prints on the `clean` card — so the card date is derived, not made up.
 */
function gpsDateLabel(comment) {
  const match = /^\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(String(comment ?? ''));
  if (!match) return '';
  const gpsSeconds = Number(match[1]) * 604800 + Number(match[2]);
  if (!Number.isFinite(gpsSeconds)) return '';
  const date = new Date(Date.UTC(1980, 0, 6) + (gpsSeconds - 18) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `2026-10-30T08:37:59Z` for the report header. */
function gpsIsoLabel(comment) {
  const match = /^\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(String(comment ?? ''));
  if (!match) return '';
  const gpsSeconds = Number(match[1]) * 604800 + Number(match[2]);
  if (!Number.isFinite(gpsSeconds)) return '';
  const date = new Date(Date.UTC(1980, 0, 6) + (gpsSeconds - 18) * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function projectNameOf(data, directory) {
  const name = (data && data.comments && data.comments.projectName) || '';
  if (name) return name;
  const tail = String(directory || '').replace(/[\\/]+$/, '');
  const base = tail.slice(tail.lastIndexOf('/') + 1);
  return base.replace(/^export-?/, '') || 'Graph project';
}

/* ---------------- series colours ---------------- */

/**
 * Ten colours, cycled by column index. The first two are the Overview chart's own stroke and marker
 * (`#00516F` / `#00ABC8`), `#D0021B` is the suite's flag / playhead red, the rest are the muted hues
 * Convert and Playback already use. This is the **default** palette; the original's own
 * `stringToColor` is one checkbox away (`originalSeriesColor`, below).
 */
const SERIES_COLOURS = [
  '#00516f', '#00abc8', '#d0021b', '#e09b00', '#2e8b57',
  '#7b4fa8', '#c2185b', '#3a6ea5', '#8d6e63', '#4e7a0d',
];

/** Constellation order the original uses (`CONSTELLATION_ORDER` in the shipped bundle). */
const CONSTELLATIONS = ['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'LBAND', 'SBAS', 'NAVIC'];

/** Cycled palette entry for a column index. */
export function seriesColor(index) {
  const at = Math.abs(Math.trunc(Number(index) || 0)) % SERIES_COLOURS.length;
  return SERIES_COLOURS[at];
}

/* ---- the original's own palette (`stringToColor`) ---- */

/**
 * `MSL_HEIGHT_COLOUR` (`index-B86bHcCD.js @556224`): the original pins a column literally named
 * `height` to red instead of hashing it — `computeDefaultColour` @568822.
 */
export const MSL_HEIGHT_COLOUR = '#FF0000';

/** 11 hue anchors `getBaseHue` cycles through, verbatim from the bundle. */
export const ORIGINAL_BASE_HUES = [0, 140, 240, 30, 270, 160, 310, 15, 210, 200, 285];

/** The decorative run `augmentString` splices into the middle of a column name. */
export const ORIGINAL_AUGMENT = '§Ω∆Φ☀★☾✦¿¡¶†αβγδ';

/**
 * `hash$3` @556396: FNV-1a with a splitmix-style avalanche every fourth code unit, then a final
 * mix. `Math.imul` keeps every step in 32-bit; the `>>> 0` at the end makes it unsigned.
 */
export function mixHash(input, seed = 0) {
  const text = String(input == null ? '' : input);
  let h = (2166136261 ^ (Number(seed) || 0)) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
    if (i % 4 === 3) {
      h ^= h >>> 13;
      h = Math.imul(h, 2246822507);
      h ^= h >>> 16;
    }
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** `augmentString` @556300 — the name is split in half and the glyph run dropped in the middle. */
export function augmentString(text) {
  const value = String(text == null ? '' : text);
  const midpoint = Math.floor(value.length / 2);
  return value.slice(0, midpoint) + ORIGINAL_AUGMENT + value.slice(midpoint);
}

/** `createInputString` @556405 — `augmented_<index>_<index*7919>_<length*6577>`. */
export function originalInputString(name, index) {
  const text = String(name == null ? '' : name);
  const at = Math.trunc(Number(index) || 0);
  return `${augmentString(text)}_${at}_${at * 7919}_${text.length * 6577}`;
}

/** `calculatePositionWeight` @556525 — every code unit weighted by its 1-based position. */
export function positionWeight(text) {
  const value = String(text == null ? '' : text);
  let weight = 0;
  for (let i = 0; i < value.length; i += 1) weight += value.charCodeAt(i) * (i + 1);
  return weight;
}

/** `combineHashes` @556868 — four seeded hashes plus the index and length offsets. */
export function combineHashes(hashes, weight, index, length) {
  const [h1, h2, h3, h4] = hashes;
  const at = Math.trunc(Number(index) || 0);
  const indexOffset = (at * 97 + at * at * 13) >>> 0;
  const lengthOffset = ((length * length * 41 + length * 53) >>> 0);
  const indexWeight = Number.isFinite(index) ? 50 : 1;
  return (h1 * 11 + h2 * 7 + h3 * 5 + h4 * 3 + weight + indexOffset * indexWeight + lengthOffset) >>> 0;
}

/** `hslToHex` @568066 — same HSL→RGB conversion the CSS spec documents. */
export function hslToHex(hue, saturation, lightness) {
  const s = Number(saturation) / 100;
  const l = Number(lightness) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + Number(hue) / 30) % 12;
    const colour = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * colour).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * `stringToColor(str, index, theme)` @568030, reconstructed from the shipped bundle:
 *
 *   input   `augmentString(name) + "_" + index + "_" + index*7919 + "_" + len*6577`
 *   hashes  mixHash(input, 0) · mixHash(reversed, 1) · mixHash(upper, 2) · mixHash(input+len, 3)
 *   hue     baseHue[index % 11] + (combined >>> 20) % 17 − 8
 *   s/l     light: 75 + (combined >>> 16) % 15 / 45 + (combined >>> 8) % 10
 *           dark:  55 + (combined >>> 16) % 15 / 65 + (combined >>> 8) % 10
 *
 * `theme` is the bundle's `Theme` enum value (`'light'` / `'dark'`), and anything that is not
 * `'light'` takes the dark branch — which is what the original's `theme2 === Theme.Light` test does.
 */
export function originalSeriesColor(name, index, theme = 'light') {
  const text = String(name == null ? '' : name);
  const at = Math.trunc(Number(index) || 0);
  const input = originalInputString(text, at);
  const hashes = [
    mixHash(input, 0),
    mixHash(input.split('').reverse().join(''), 1),
    mixHash(input.toUpperCase(), 2),
    mixHash(input + String(input.length), 3),
  ];
  const weight = positionWeight(input);
  const combined = combineHashes(hashes, weight, at, text.length);
  const baseHue = ORIGINAL_BASE_HUES[((at % ORIGINAL_BASE_HUES.length) + ORIGINAL_BASE_HUES.length)
    % ORIGINAL_BASE_HUES.length];
  const hue = (baseHue + ((combined >>> 20) % 17 - 8) + 360) % 360;
  const saturation = (theme === 'light' ? 75 : 55) + ((combined >>> 16) % 15);
  const lightness = (theme === 'light' ? 45 : 65) + ((combined >>> 8) % 10);
  return hslToHex(hue, saturation, lightness);
}

/**
 * `computeDefaultColour(name, index, theme)` @568822: the original's actual entry point — a column
 * literally named `Height` is pinned to `MSL_HEIGHT_COLOUR`, everything else goes through the hash
 * on its **lowercased** name.
 */
export function originalDefaultColour(name, index, theme = 'light') {
  const text = String(name == null ? '' : name);
  return text.toLowerCase() === 'height'
    ? MSL_HEIGHT_COLOUR
    : originalSeriesColor(text.toLowerCase(), index, theme);
}

/** The two palettes the 图例 switch picks between. */
export const COLOUR_MODES = ['readable', 'original'];

/**
 * `?colors=original` (or `readable`, or nothing) → the palette the panel opens with. Anything else
 * falls back to the readable default rather than guessing.
 */
export function colourModeFromSearch(search) {
  const raw = String(search == null ? '' : search);
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  let value = '';
  try {
    value = (new URLSearchParams(query).get('colors') || '').trim().toLowerCase();
  } catch {
    value = '';
  }
  return value === 'original' ? 'original' : 'readable';
}

/** Palette entry for `(name, index)` under one of `COLOUR_MODES`. */
export function seriesColour(mode, name, index, theme = 'light') {
  return mode === 'original' ? originalDefaultColour(name, index, theme) : seriesColor(index);
}

/** `BEIDOU_B1I_D2_1` → `BEIDOU`, `Signals_GPS_L2_PY` → `GPS`, `Height` → ``. */
export function constellationOf(name) {
  for (const token of String(name == null ? '' : name).split(/[_\s]+/)) {
    if (CONSTELLATIONS.includes(token)) return token;
  }
  return '';
}

/* ---------------- chart catalog (附录 C) ---------------- */

/**
 * One entry per tab, holding the plots of `C_图表目录.json` that this project exported a CSV for.
 * `catalog` is the tab's **full** catalog list — the plots with no CSV are named in the tab footer
 * instead of being drawn as empty tiles, which is what the original does (`PlotSummary` decides
 * whether a `ChartControls` exists at all).
 *
 *   kind  line      numeric series, one polyline per column
 *         bar       numeric series drawn as bars, y axis hidden (`show: chartType !== "bar"`)
 *         category  the value column is an enum label, drawn as one band per sample
 *         geomap    longitude on x, latitude on y (`GeoMapChart` @15713064)
 *   units   the plot's `yAxisUnits`, verbatim from the catalog
 *   minYZero the catalog's `minYZero`, verbatim
 */
export const CHART_GROUPS = [
  {
    id: 'pvt',
    label: 'PVT',
    catalog: ['Position Type', 'Position Status', 'Position SD', 'Solution Statistics',
      '2D Trajectory', 'Height', 'Velocity'],
    charts: [
      { id: 'position-type', title: 'Position Type', file: 'Position Type.csv', kind: 'category' },
      { id: 'position-status', title: 'Position Status', file: 'Position Status.csv', kind: 'category' },
      { id: 'position-sd', title: 'Position SD', file: 'Position SD.csv', kind: 'line', units: '(m)' },
      { id: 'solution-statistics', title: 'Solution Statistics', file: 'Solution Statistics.csv', kind: 'line' },
      { id: 'trajectory', title: '2D Trajectory', file: '2D Trajectory.csv', kind: 'geomap',
        xColumn: 'Longitude', yColumn: 'Latitude' },
      { id: 'height', title: 'Height', file: 'Height.csv', kind: 'line', units: '(m)' },
    ],
  },
  {
    id: 'tracking',
    label: 'Tracking & Measurements',
    catalog: ['GNSS Signal Strength', 'Satellites and Signals', 'Tracking Time'],
    charts: [
      { id: 'signal-strength', title: 'GNSS Signal Strength', file: 'GNSS Signal Strength.csv',
        kind: 'line', units: 'C/No (dB-Hz)' },
      { id: 'satellites', title: 'Satellites and Signals', file: 'Satellites and Signals.csv',
        kind: 'line', minYZero: true },
      { id: 'tracking-time', title: 'Tracking Time', file: 'Tracking Time.csv',
        kind: 'line', units: '(s)', minYZero: true },
    ],
  },
  {
    id: 'receiver',
    label: 'Receiver Status',
    catalog: ['Receiver Status', 'CPU Usage', 'HW Monitor Status'],
    charts: [
      { id: 'receiver-status', title: 'Receiver Status', file: 'Receiver Status.csv',
        kind: 'bar', rowsAsSeries: true, intervalTable: true },
      { id: 'cpu-usage', title: 'CPU Usage', file: 'CPU Usage.csv',
        kind: 'line', units: '(%)', minYZero: true },
      { id: 'hw-monitor', title: 'HW Monitor Status', file: 'HW Monitor Status.csv',
        kind: 'line', minYZero: true },
    ],
  },
];

/** Chart tiles per tab id, for the panes that are not Overview / Project Information. */
export function chartsOf(tabId) {
  const group = CHART_GROUPS.find((item) => item.id === tabId);
  return group ? group.charts : [];
}

/* ---------------- axis helpers ---------------- */

const PAD = { left: 72, right: 26, top: 34, bottom: 48 };

/** `"2442  463098.000"` → absolute GPS seconds. Mirrors `parseGpsCell` in `graphcsv.ts`. */
export function parseGpsCell(cell) {
  const match = /^\s*(\d{3,5})\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(String(cell == null ? '' : cell));
  if (!match) return null;
  const week = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  return week * 604_800 + seconds;
}

/** `W2442 463098.000` — the same label `graphcsv.ts` puts on a series' first / last sample. */
export function gpsWeekLabel(absoluteSeconds) {
  if (!Number.isFinite(absoluteSeconds)) return '';
  const week = Math.floor(absoluteSeconds / 604_800);
  return `W${week} ${(absoluteSeconds - week * 604_800).toFixed(3)}`;
}

/**
 * `count + 1` evenly spaced ticks across `[min, max]`, first and last exactly on the axis ends —
 * the reading rule the Overview chart already draws (`i / 4`), kept so the tiles look like it.
 */
export function chartTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    return { step: 0, values: Number.isFinite(min) ? [min] : [] };
  }
  const step = (max - min) / count;
  const values = [];
  for (let i = 0; i <= count; i += 1) values.push(min + step * i);
  return { step, values };
}

/** Decimals follow the step, so a 0.02 m span still prints five places and a 700 s span prints none. */
export function formatTick(value, step) {
  if (!Number.isFinite(value)) return '—';
  const size = Math.abs(step);
  const decimals = size > 0 && Number.isFinite(size)
    ? Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(size))))
    : 0;
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

function plotFrame(width, height) {
  return {
    pad: PAD,
    plotW: Math.max(20, width - PAD.left - PAD.right),
    plotH: Math.max(20, height - PAD.top - PAD.bottom),
  };
}

function xDomain(series) {
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const point of item.points) {
      if (point[0] < min) min = point[0];
      if (point[0] > max) max = point[0];
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  // One sample (HWMONITOR answers once) has no width; give the axis one second to the right rather
  // than inventing negative time.
  if (max === min) return [min, min + 1];
  return [min, max];
}

/** Integer ticks only: an `index` x axis has no meaning between two rows. */
function indexTicks(min, max) {
  const values = [];
  for (let value = Math.ceil(min); value <= Math.floor(max) + 1e-9; value += 1) values.push(value);
  if (!values.length) values.push(Math.round(min));
  return { step: 1, values };
}

function yDomain(series) {
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const point of item.points) {
      if (point[1] < min) min = point[1];
      if (point[1] > max) max = point[1];
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  return [min, max];
}

function rangeLabel(model) {
  const base = String(model.xLabel || '');
  if (!model.xStartLabel && !model.xEndLabel) return base;
  return `${base} · ${model.xStartLabel || '?'} → ${model.xEndLabel || '?'}`;
}

/* ---------------- chart renderers (pure: model + size → SVG string) ---------------- */

/**
 * Line / bar tile. Markup, padding, grid colours, tick fonts and stroke widths are the Overview
 * chart's (`chartSvg`), so a tile and the Overview chart are visually the same instrument.
 */
function seriesSvg(model, series, width, height) {
  const [xMinRaw, xMaxRaw] = xDomain(series);
  let [yMin, yMax] = yDomain(series);
  const xMin = xMinRaw;
  const xMax = xMaxRaw;
  if (model.minYZero) yMin = Math.min(0, yMin);
  if (yMax === yMin) {
    yMax = yMin + 1;
    yMin -= 1;
  }
  const { pad, plotW, plotH } = plotFrame(width, height);
  const px = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const py = (y) => pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;
  const yTicks = chartTicks(yMin, yMax, 4);
  const xIsIndex = model.xKind === 'index';
  const xTicks = xIsIndex ? indexTicks(xMin, xMax) : chartTicks(xMin, xMax, 4);
  const xLabel = (value) => (xIsIndex ? `#${Math.round(value) + 1}` : formatTick(value, xTicks.step));
  const bars = model.kind === 'bar';
  const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(model.title || '图表')}">`];

  if (!bars) {
    for (const value of yTicks.values) {
      const pos = py(value);
      parts.push(
        `<line x1="${pad.left}" y1="${pos.toFixed(1)}" x2="${width - pad.right}" y2="${pos.toFixed(1)}" stroke="rgba(0,0,0,0.12)"/>`,
        `<text x="${pad.left - 10}" y="${(pos + 3.5).toFixed(1)}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="end" font-family="Consolas, monospace">${esc(formatTick(value, yTicks.step))}</text>`,
      );
    }
  } else {
    const base = py(Math.max(yMin, Math.min(0, yMax)));
    parts.push(
      `<line x1="${pad.left}" y1="${base.toFixed(1)}" x2="${width - pad.right}" y2="${base.toFixed(1)}" stroke="rgba(0,0,0,0.12)"/>`,
    );
  }

  for (const value of xTicks.values) {
    const pos = px(value);
    parts.push(
      `<line x1="${pos.toFixed(1)}" y1="${pad.top}" x2="${pos.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(0,0,0,0.08)"/>`,
      `<text x="${pos.toFixed(1)}" y="${pad.top + plotH + 18}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="middle" font-family="Consolas, monospace">${esc(xLabel(value))}</text>`,
    );
  }

  parts.push(
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
  );

  let total = 0;
  for (const item of series) total += item.points.length;

  if (bars) {
    const barW = Math.max(1.5, Math.min(20, (plotW / Math.max(1, total)) * 0.6));
    const base = py(Math.max(yMin, Math.min(0, yMax)));
    for (const item of series) {
      for (const point of item.points) {
        const top = py(point[1]);
        const x = px(point[0]) - barW / 2;
        const y = Math.min(top, base);
        const h = Math.max(1, Math.abs(base - top));
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${esc(item.color)}"/>`,
        );
      }
    }
  } else {
    for (const item of series) {
      parts.push(
        `<polyline fill="none" stroke="${esc(item.color)}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${item.points
          .map((point) => `${px(point[0]).toFixed(1)},${py(point[1]).toFixed(1)}`)
          .join(' ')}"/>`,
      );
    }
    if (total <= 120) {
      for (const item of series) {
        parts.push(
          item.points
            .map((point) => `<circle cx="${px(point[0]).toFixed(1)}" cy="${py(point[1]).toFixed(1)}" r="2.2" fill="${esc(item.color)}"/>`)
            .join(''),
        );
      }
    }
  }

  parts.push(
    `<text x="${pad.left}" y="${height - 10}" font-size="11" fill="rgba(0,0,0,0.6)">${esc(rangeLabel(model))}</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}

/** Enum column → one band per sample, y axis hidden (the original's bar-plus-hidden-y reading). */
function categorySvg(model, series, width, height) {
  const [xMin, xMax] = xDomain(series);
  const { pad, plotW, plotH } = plotFrame(width, height);
  const px = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const xTicks = chartTicks(xMin, xMax, 4);
  const samples = [];
  for (const item of series) for (const point of item.points) samples.push({ x: point[0], color: item.color });
  samples.sort((a, b) => a.x - b.x);
  // Band width is a **pixel** measurement: the median gap between samples, scaled by the axis.
  let band = Math.min(plotW, 40);
  if (samples.length > 1 && xMax > xMin) {
    const gaps = [];
    for (let i = 1; i < samples.length; i += 1) gaps.push(samples[i].x - samples[i - 1].x);
    gaps.sort((a, b) => a - b);
    band = Math.max(2, ((gaps[Math.floor(gaps.length / 2)] || 0) / (xMax - xMin)) * plotW * 0.8);
  }
  const top = pad.top + 6;
  const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(model.title || '图表')}">`];
  for (const value of xTicks.values) {
    const pos = px(value);
    parts.push(
      `<line x1="${pos.toFixed(1)}" y1="${pad.top}" x2="${pos.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(0,0,0,0.08)"/>`,
      `<text x="${pos.toFixed(1)}" y="${pad.top + plotH + 18}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="middle" font-family="Consolas, monospace">${esc(formatTick(value, xTicks.step))}</text>`,
    );
  }
  for (const sample of samples) {
    const left = Math.max(pad.left, px(sample.x) - band / 2);
    const right = Math.min(pad.left + plotW, px(sample.x) + band / 2);
    parts.push(
      `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, right - left).toFixed(1)}" height="${(pad.top + plotH - top).toFixed(1)}" fill="${esc(sample.color)}" fill-opacity="0.85"/>`,
    );
  }
  parts.push(
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
    `<text x="${pad.left}" y="${height - 10}" font-size="11" fill="rgba(0,0,0,0.6)">${esc(rangeLabel(model))}</text>`,
    '</svg>',
  );
  return parts.join('');
}

/** `GeoMapChart` @15713064: longitude on x, latitude on y, transparent line, 5 px points `#5464f8`. */
function geomapSvg(model, series, width, height) {
  const [xMin, xMax] = xDomain(series);
  const [yMin, yMax] = yDomain(series);
  const padX = xMax === xMin ? 0.0001 : 0;
  const padY = yMax === yMin ? 0.0001 : 0;
  const { pad, plotW, plotH } = plotFrame(width, height);
  const px = (x) => pad.left + ((x - (xMin - padX)) / ((xMax + padX) - (xMin - padX))) * plotW;
  const py = (y) => pad.top + plotH - ((y - (yMin - padY)) / ((yMax + padY) - (yMin - padY))) * plotH;
  const xTicks = chartTicks(xMin - padX, xMax + padX, 4);
  const yTicks = chartTicks(yMin - padY, yMax + padY, 4);
  const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(model.title || '图表')}">`];
  for (const value of yTicks.values) {
    const pos = py(value);
    parts.push(
      `<line x1="${pad.left}" y1="${pos.toFixed(1)}" x2="${width - pad.right}" y2="${pos.toFixed(1)}" stroke="rgba(0,0,0,0.12)"/>`,
      `<text x="${pad.left - 10}" y="${(pos + 3.5).toFixed(1)}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="end" font-family="Consolas, monospace">${esc(formatTick(value, yTicks.step))}</text>`,
    );
  }
  for (const value of xTicks.values) {
    const pos = px(value);
    parts.push(
      `<line x1="${pos.toFixed(1)}" y1="${pad.top}" x2="${pos.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(0,0,0,0.08)"/>`,
      `<text x="${pos.toFixed(1)}" y="${pad.top + plotH + 18}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="middle" font-family="Consolas, monospace">${esc(formatTick(value, xTicks.step))}</text>`,
    );
  }
  parts.push(
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
  );
  for (const item of series) {
    parts.push(
      item.points
        .map((point) => `<circle cx="${px(point[0]).toFixed(1)}" cy="${py(point[1]).toFixed(1)}" r="4" fill="${esc(item.color)}"/>`)
        .join(''),
    );
  }
  parts.push(
    `<text x="${pad.left}" y="${height - 10}" font-size="11" fill="rgba(0,0,0,0.6)">${esc(rangeLabel(model))}</text>`,
    '</svg>',
  );
  return parts.join('');
}

/** Any tile model → SVG markup (or an honest `--` block). Exported so the tests can read it. */
export function chartSvgFor(model, width, height) {
  if (!model || !Array.isArray(model.series)) return '';
  const visible = model.series.filter((item) => !item.hidden && item.points && item.points.length);
  const empty = `<div class="gp-chart-empty">${esc((model && model.emptyText) || '没有可绘制的数据点。')}</div>`;
  if (!visible.length) return empty;
  const boxW = Math.max(160, Math.round(Number(width) || 0));
  const boxH = Math.max(120, Math.round(Number(height) || 0));
  if (model.kind === 'geomap') return geomapSvg(model, visible, boxW, boxH);
  if (model.kind === 'category') return categorySvg(model, visible, boxW, boxH);
  return seriesSvg(model, visible, boxW, boxH);
}

/* ---------------- map: a self-drawn offline basemap + the exported track ---------------- */

/**
 * The **fallback** basemap: a graticule drawn here, for when the original engine cannot start or
 * `?map=canvas` asks for it. The real thing is `web/geo/luciad-stage.js`, which runs LuciadRIA out of
 * the shipped Graph bundle; both draw the same five facts — the track, the 1σ ring, a graticule, a
 * scale bar and a north arrow — so switching engines does not change what the picture means.
 *
 * This one draws no imagery and no invented geography: no coastline, no roads, no tiles. One visible
 * line says which engine is on screen (`.gp-map-note`), not a tooltip.
 *
 * Projection: equirectangular about the view's centre latitude — x ∝ (lon − lon₀)·cos φ,
 * y ∝ −(lat − lat₀) — with **one metre scale for both axes**, so the scale bar and the 1σ circle are
 * true and the aspect ratio is the real one. Over the ~24 m box this track needs that is
 * indistinguishable from Web Mercator, and it never needs a tile server.
 */

/** The trajectory CSV (and the two columns) the map draws — the same file `clean.kml` was exported from. */
export const MAP_FILE = '2D Trajectory.csv';
export const MAP_LON_COLUMN = 'Longitude';
export const MAP_LAT_COLUMN = 'Latitude';
/** `Position SD.csv` gives the per-epoch 1σ in metres: circle around the first fix. */
export const MAP_SD_FILE = 'Position SD.csv';
export const MAP_SD_LAT_COLUMN = 'Latitude SD';
export const MAP_SD_LON_COLUMN = 'Longitude SD';
/** `Height.csv` supplies the ellipsoidal height the cursor chip prints. */
export const MAP_HEIGHT_FILE = 'Height.csv';

/** `clean.kml` `<Style id="PathSINGLE">` is `ffe74a3c` (AABBGGRR) → `#3c4ae7`. */
export const MAP_TRACK_COLOR = '#3c4ae7';

export const MAP_MIN_SPAN_M = 0.4;
export const MAP_MAX_SPAN_M = 20_000_000;
/** A stationary track still needs a readable box; fit lands on this when every fix coincides. */
export const MAP_MIN_FIT_SPAN_M = 24;

const DEGREE = Math.PI / 180;

/** Metres per degree at a latitude (WGS84 mean radius); longitude shrinks with cos φ. */
export function metersPerDegree(lat) {
  const phi = Math.max(-89.5, Math.min(89.5, Number(lat) || 0)) * DEGREE;
  return { lat: 111132.9, lon: Math.max(1, 111320.3 * Math.cos(phi)) };
}

/** Round a raw step **up** to the 1-2-5 ladder (grid spacing, tick spacing). */
export function niceStep(raw) {
  const value = Math.abs(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = value / 10 ** exponent;
  const ladder = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return ladder * 10 ** exponent;
}

/** Round a raw value **down** to the 1-2-5 ladder (scale bar length). */
export function niceFloor(raw) {
  const value = Math.abs(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = value / 10 ** exponent;
  const ladder = base >= 5 ? 5 : base >= 2 ? 2 : 1;
  return ladder * 10 ** exponent;
}

/** Graticule step for a degree span: about `target` lines across, on the 1-2-5 ladder. */
export function degreeStep(spanDeg, target = 6) {
  const span = Math.abs(Number(spanDeg));
  if (!Number.isFinite(span) || span <= 0) return 0.001;
  return niceStep(span / Math.max(1, target));
}

/** Every multiple of `step` inside `[min, max]`. */
export function tickValues(min, max, step) {
  const values = [];
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(step > 0)) return values;
  const first = Math.ceil(min / step - 1e-9) * step;
  const count = Math.floor((max - first) / step + 1e-6);
  for (let index = 0; index <= count; index += 1) values.push(first + index * step);
  return values;
}

/** Decimals that make a step readable: 2° → 0, 0.02° → 2, 0.0002° → 4. */
export function stepDecimals(step) {
  const size = Math.abs(Number(step));
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.max(0, Math.min(7, Math.ceil(-Math.log10(size))));
}

export function formatDegrees(value, step) {
  const decimals = stepDecimals(step);
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const text = number.toFixed(decimals);
  return Number(text) === 0 ? (0).toFixed(decimals) : text;
}

/** `30.539975` → `30.539975°N`. */
export function latLabel(lat, decimals = 6) {
  const value = Number(lat) || 0;
  return `${Math.abs(value).toFixed(decimals)}°${value >= 0 ? 'N' : 'S'}`;
}

/** `114.352811` → `114.352811°E`. */
export function lonLabel(lon, decimals = 6) {
  const value = Number(lon) || 0;
  return `${Math.abs(value).toFixed(decimals)}°${value >= 0 ? 'E' : 'W'}`;
}

export function formatDistance(meters) {
  const value = Math.abs(Number(meters) || 0);
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} km`;
  if (value >= 100) return `${value.toFixed(0)} m`;
  if (value >= 10) return `${value.toFixed(1)} m`;
  if (value >= 1) return `${value.toFixed(2)} m`;
  if (value >= 0.01) return `${(value * 100).toFixed(0)} cm`;
  return '0 m';
}

function scaleLabel(meters) {
  if (meters >= 1000) return `${Math.round(meters / 1000)} km`;
  if (meters >= 1) return `${Math.round(meters * 10) / 10} m`;
  return `${Math.round(meters * 100)} cm`;
}

/** A round distance no wider than `maxPx` on screen. */
export function scaleBar(pxPerMeter, maxPx = 132) {
  const pxPerM = Number(pxPerMeter);
  if (!Number.isFinite(pxPerM) || pxPerM <= 0) return { meters: 0, px: 0, label: '0 m' };
  const meters = niceFloor(Math.max(1e-6, Number(maxPx) || 0) / pxPerM);
  return { meters, px: meters * pxPerM, label: scaleLabel(meters) };
}

/**
 * View → pixel/degree maths. `spanM` is the **width** of the view in metres; one metre is one
 * `width / spanM` pixels on both axes, which is what makes the scale bar and the 1σ circle true.
 */
export function mapProjection(view, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const centerLon = Number.isFinite(view && view.centerLon) ? Number(view.centerLon) : 0;
  const centerLat = Number.isFinite(view && view.centerLat) ? Number(view.centerLat) : 0;
  const spanM = Math.max(MAP_MIN_SPAN_M,
    Math.min(MAP_MAX_SPAN_M, Number.isFinite(view && view.spanM) ? Number(view.spanM) : 100));
  const per = metersPerDegree(centerLat);
  const pxPerM = w / spanM;
  const cosScale = per.lon * pxPerM;
  const latScale = per.lat * pxPerM;
  return {
    width: w,
    height: h,
    centerLon,
    centerLat,
    spanM,
    pxPerM,
    metersPerDegree: per,
    x: (lon) => w / 2 + (Number(lon) - centerLon) * cosScale,
    y: (lat) => h / 2 - (Number(lat) - centerLat) * latScale,
    lonAt: (px) => centerLon + (Number(px) - w / 2) / cosScale,
    latAt: (py) => centerLat - (Number(py) - h / 2) / latScale,
    degreesPerPixel: { lon: 1 / cosScale, lat: 1 / latScale },
  };
}

/** Two `/api/graph/data` payloads (longitude column, latitude column) → `[{ t, lon, lat }]`. */
export function trajectoryPoints(lonPayload, latPayload) {
  const lon = (lonPayload && lonPayload.series && lonPayload.series.points) || [];
  const lat = (latPayload && latPayload.series && latPayload.series.points) || [];
  const count = Math.min(lon.length, lat.length);
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const longitude = Number(lon[index][1]);
    const latitude = Number(lat[index][1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    points.push({ t: Number(lon[index][0]) || 0, lon: longitude, lat: latitude });
  }
  return points;
}

/** Flat-earth distance in metres — these tracks are metres, not flight paths. */
export function pointDistance(a, b) {
  if (!a || !b) return 0;
  const per = metersPerDegree((Number(a.lat) + Number(b.lat)) / 2);
  const east = (Number(b.lon) - Number(a.lon)) * per.lon;
  const north = (Number(b.lat) - Number(a.lat)) * per.lat;
  return Math.hypot(east, north);
}

/** Sum of the segment lengths, metres. A stationary track is honestly 0. */
export function trackLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += pointDistance(points[index - 1], points[index]);
  }
  return total;
}

export function trackExtent(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
  }
  const centerLat = (minLat + maxLat) / 2;
  const per = metersPerDegree(centerLat);
  return {
    minLon,
    maxLon,
    minLat,
    maxLat,
    centerLon: (minLon + maxLon) / 2,
    centerLat,
    eastM: (maxLon - minLon) * per.lon,
    northM: (maxLat - minLat) * per.lat,
  };
}

/** View that holds every fix with 15 % margin; coincident fixes land on `MAP_MIN_FIT_SPAN_M`. */
export function mapFit(points, width, height) {
  const w = Math.max(1, Number(width) || 0);
  const h = Math.max(1, Number(height) || 0);
  const extent = trackExtent(points);
  if (!extent) return { centerLon: 0, centerLat: 0, spanM: MAP_MIN_FIT_SPAN_M };
  const aspect = w / h;
  const spanM = Math.max(MAP_MIN_FIT_SPAN_M, extent.eastM * 1.15, extent.northM * aspect * 1.15);
  return {
    centerLon: extent.centerLon,
    centerLat: extent.centerLat,
    spanM: Math.min(MAP_MAX_SPAN_M, spanM),
  };
}

/** Index of the fix at `ratio` (0…1) of the track's time axis — the timeline cursor's map position. */
export function indexForRatio(points, ratio) {
  if (!Array.isArray(points) || !points.length) return -1;
  const value = Math.min(1, Math.max(0, Number(ratio) || 0));
  const first = Number(points[0].t) || 0;
  const last = Number(points[points.length - 1].t) || 0;
  if (!(last > first)) return Math.min(points.length - 1, Math.round(value * (points.length - 1)));
  const target = first + (last - first) * value;
  let picked = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((Number(points[index].t) || 0) <= target + 1e-9) picked = index;
    else break;
  }
  return picked;
}

/** `2442,463098.000` — the comment lines' form (`2442  463098.000` cells go through `parseGpsCell`). */
export function parseGpsStamp(text) {
  const match = /^\s*(\d{3,5})\s*[,\s]\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  const week = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  return week * 604_800 + seconds;
}

/** Every `<coordinates>` triple of a KML document, in document order (points and paths). */
export function parseKmlCoordinates(kml) {
  const out = [];
  const pattern = /<coordinates>([\s\S]*?)<\/coordinates>/g;
  let match = pattern.exec(String(kml == null ? '' : kml));
  while (match) {
    for (const chunk of match[1].trim().split(/\s+/)) {
      if (!chunk) continue;
      const [lon, lat, alt] = chunk.split(',').map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.push({ lon, lat, alt: Number.isFinite(alt) ? alt : null });
    }
    match = pattern.exec(String(kml == null ? '' : kml));
  }
  return out;
}

/**
 * The basemap + track, as SVG. Pure: view + points in, markup out — the tests read the coordinates
 * straight back out of it and compare them with the CSV. `data-*` attributes carry the same facts
 * for the browser check: `data-points`, `data-span-m`, per-vertex `data-lon` / `data-lat`.
 */
export function mapSvg(model, width, height) {
  const w = Math.max(200, Math.round(Number(width) || 0));
  const h = Math.max(140, Math.round(Number(height) || 0));
  const data = model || {};
  const points = Array.isArray(data.points) ? data.points : [];
  const view = data.view || { centerLon: 0, centerLat: 0, spanM: 100 };
  const proj = mapProjection(view, w, h);
  const sigmaM = Number.isFinite(data.sigmaM) ? Math.max(0, Number(data.sigmaM)) : 0;
  const font = 'font-family="Consolas, monospace"';

  const parts = [
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="离线经纬网底图与轨迹（自绘，不是 Luciad）"`
      + ` data-basemap="graticule" data-points="${points.length}"`
      + ` data-span-m="${proj.spanM.toFixed(3)}"`
      + ` data-center-lon="${proj.centerLon.toFixed(8)}"`
      + ` data-center-lat="${proj.centerLat.toFixed(8)}">`,
  ];

  // Paper + vignette: the basemap has no imagery, so it must at least read as a drawing, not a hole.
  parts.push(
    '<defs><radialGradient id="gp-map-paper" cx="48%" cy="42%" r="78%">'
      + '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>'
      + '<stop offset="100%" stop-color="#dfe4d8" stop-opacity="0.75"/>'
      + '</radialGradient></defs>',
    `<rect width="${w}" height="${h}" fill="#eef1ea"/>`,
    `<rect width="${w}" height="${h}" fill="url(#gp-map-paper)"/>`,
  );

  // Graticule: the only "geography" on the basemap, and it is exact.
  const lonMin = Math.min(proj.lonAt(0), proj.lonAt(w));
  const lonMax = Math.max(proj.lonAt(0), proj.lonAt(w));
  const latMin = Math.min(proj.latAt(0), proj.latAt(h));
  const latMax = Math.max(proj.latAt(0), proj.latAt(h));
  const stepLon = degreeStep(lonMax - lonMin);
  const stepLat = degreeStep(latMax - latMin);
  const lonTicks = tickValues(lonMin, lonMax, stepLon);
  const latTicks = tickValues(latMin, latMax, stepLat);

  for (const lon of lonTicks) {
    const x = proj.x(lon);
    if (x < 1 || x > w - 1) continue;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="20" x2="${x.toFixed(1)}" y2="${h}" stroke="rgba(0,0,0,0.10)"/>`,
      `<text x="${x.toFixed(1)}" y="14" font-size="10" fill="rgba(0,0,0,0.5)" text-anchor="middle" ${font}>`
        + `${esc(formatDegrees(lon, stepLon))}°${lon >= 0 ? 'E' : 'W'}</text>`,
    );
  }
  for (const lat of latTicks) {
    const y = proj.y(lat);
    if (y < 22 || y > h - 1) continue;
    parts.push(
      `<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="rgba(0,0,0,0.10)"/>`,
    );
    // The scale bar owns the bottom-left corner: keep the last latitude label out of its way.
    if (y < h - 42) {
      parts.push(
        `<text x="6" y="${(y - 4).toFixed(1)}" font-size="10" fill="rgba(0,0,0,0.5)" ${font}>`
          + `${esc(formatDegrees(lat, stepLat))}°${lat >= 0 ? 'N' : 'S'}</text>`,
      );
    }
  }
  parts.push(`<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="rgba(0,0,0,0.14)"/>`);

  /* Metric grid, 1-2-5 metres relative to the first fix. This is the "site plan" layer that makes
   * the interior of a 24 m box legible; it only appears while its spacing stays readable (36…200 px),
   * and it is derived from the projection, not from any imagery. */
  const origin = points.length ? points[0] : { lon: proj.centerLon, lat: proj.centerLat };
  const meterStep = niceStep(72 / proj.pxPerM);
  if (meterStep * proj.pxPerM >= 36 && meterStep * proj.pxPerM <= 200) {
    const per = proj.metersPerDegree;
    const eastMin = Math.min((proj.lonAt(0) - origin.lon) * per.lon, (proj.lonAt(w) - origin.lon) * per.lon);
    const eastMax = Math.max((proj.lonAt(0) - origin.lon) * per.lon, (proj.lonAt(w) - origin.lon) * per.lon);
    const northMin = Math.min((proj.latAt(0) - origin.lat) * per.lat, (proj.latAt(h) - origin.lat) * per.lat);
    const northMax = Math.max((proj.latAt(0) - origin.lat) * per.lat, (proj.latAt(h) - origin.lat) * per.lat);
    for (const east of tickValues(eastMin, eastMax, meterStep)) {
      const x = proj.x(origin.lon + east / per.lon);
      parts.push(`<line x1="${x.toFixed(1)}" y1="20" x2="${x.toFixed(1)}" y2="${h}"`
        + ' stroke="rgba(0,0,0,0.075)" stroke-dasharray="1 3"/>');
    }
    for (const north of tickValues(northMin, northMax, meterStep)) {
      const y = proj.y(origin.lat + north / per.lat);
      if (y < 22) continue;
      parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}"`
        + ' stroke="rgba(0,0,0,0.075)" stroke-dasharray="1 3"/>');
    }
  }

  // 1σ circle from Position SD.csv, around the first fix.
  if (points.length && sigmaM > 0) {
    const radius = sigmaM * proj.pxPerM;
    if (radius >= 4 && radius <= Math.max(w, h) * 1.5) {
      const cx = proj.x(points[0].lon);
      const cy = proj.y(points[0].lat);
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}"`
          + ` fill="rgba(0,81,111,0.06)" stroke="rgba(0,81,111,0.5)" stroke-width="1"`
          + ` stroke-dasharray="4 3" data-sigma-m="${sigmaM.toFixed(3)}"/>`,
        `<text x="${(cx + radius + 5).toFixed(1)}" y="${(cy - radius + 2).toFixed(1)}" font-size="10"`
          + ` fill="rgba(0,81,111,0.8)" ${font} paint-order="stroke" stroke="#ffffff" stroke-width="3">`
          + `1σ ${sigmaM.toFixed(2)} m</text>`,
      );
    }
  }

  // Track: the exported path, in the colour `clean.kml` gives it.
  if (points.length > 1) {
    const coords = points
      .map((point) => `${proj.x(point.lon).toFixed(1)},${proj.y(point.lat).toFixed(1)}`)
      .join(' ');
    parts.push(
      `<polyline points="${coords}" fill="none" stroke="${MAP_TRACK_COLOR}" stroke-width="2.4"`
        + ' stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>',
    );
  }

  // Vertices. `data-i` / `data-lon` / `data-lat` let the browser check compare against the CSV.
  const radius = points.length > 400 ? 2 : 3.2;
  points.forEach((point, index) => {
    parts.push(
      `<circle cx="${proj.x(point.lon).toFixed(1)}" cy="${proj.y(point.lat).toFixed(1)}" r="${radius}"`
        + ` fill="#ffffff" fill-opacity="0.92" stroke="${MAP_TRACK_COLOR}" stroke-width="1.6"`
        + ` data-i="${index}" data-lon="${point.lon}" data-lat="${point.lat}"/>`,
    );
  });

  const distinct = new Set(points.map((point) => `${point.lon.toFixed(8)},${point.lat.toFixed(8)}`)).size;
  if (points.length > 1 && distinct === 1) {
    // A stationary solution: 5 fixes on one pixel. Say it on the map instead of faking a track.
    const cx = proj.x(points[0].lon);
    const cy = proj.y(points[0].lat);
    parts.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="none"`
        + ` stroke="${MAP_TRACK_COLOR}" stroke-width="1" stroke-dasharray="2 2"/>`,
      `<text x="${(cx - 12).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-size="10" fill="rgba(0,0,0,0.65)"`
        + ` text-anchor="end" ${font} paint-order="stroke" stroke="#ffffff" stroke-width="3">${points.length} 点重合</text>`,
    );
  } else if (points.length) {
    const start = points[0];
    const end = points[points.length - 1];
    const sx = proj.x(start.lon);
    const sy = proj.y(start.lat);
    const ex = proj.x(end.lon);
    const ey = proj.y(end.lat);
    parts.push(
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="#ffffff" stroke="#2e8b57" stroke-width="2"/>`,
      `<path d="M${ex.toFixed(1)} ${(ey - 5).toFixed(1)} l5 5 -5 5 -5 -5 z" fill="#d0021b"/>`,
      `<text x="${(sx + 9).toFixed(1)}" y="${(sy + 4).toFixed(1)}" font-size="10" fill="rgba(0,0,0,0.7)" ${font}`
        + ' paint-order="stroke" stroke="#ffffff" stroke-width="3">起点</text>',
      `<text x="${(ex + 9).toFixed(1)}" y="${(ey + 4).toFixed(1)}" font-size="10" fill="rgba(0,0,0,0.7)" ${font}`
        + ' paint-order="stroke" stroke="#ffffff" stroke-width="3">终点</text>',
    );
  }

  // Scale bar, bottom-left: two-tone, its length is a round number of metres by construction.
  const bar = scaleBar(proj.pxPerM, Math.min(150, Math.max(48, w * 0.26)));
  if (bar.px > 4) {
    const barY = h - 24;
    const half = bar.px / 2;
    parts.push(
      `<g data-scale-m="${bar.meters}">`,
      `<rect x="16" y="${barY}" width="${half.toFixed(1)}" height="6" fill="rgba(0,0,0,0.78)"/>`,
      `<rect x="${(16 + half).toFixed(1)}" y="${barY}" width="${half.toFixed(1)}" height="6"`
        + ' fill="#ffffff" stroke="rgba(0,0,0,0.78)"/>',
      `<text x="16" y="${barY + 17}" font-size="10" fill="rgba(0,0,0,0.65)" ${font}>0</text>`,
      `<text x="${(16 + bar.px).toFixed(1)}" y="${barY + 17}" font-size="10" fill="rgba(0,0,0,0.65)"`
        + ` text-anchor="end" ${font}>${esc(bar.label)}</text>`,
      '</g>',
    );
  }

  // North arrow, bottom-right (the round compass in the control column is the orientation chip).
  const nx = w - 26;
  const ny = h - 30;
  parts.push(
    '<g data-north="up">',
    `<path d="M${nx} ${ny - 16} l6.5 15 -6.5 -4.4 -6.5 4.4 z" fill="rgba(0,0,0,0.72)"/>`,
    `<text x="${nx}" y="${ny + 12}" font-size="10" font-weight="700" fill="rgba(0,0,0,0.7)"`
      + ` text-anchor="middle" ${font}>N</text>`,
    '</g>',
  );

  parts.push('</svg>');
  return parts.join('');
}

/* ---------------- markup ---------------- */

const ICON_FLAG = '<svg class="gp-flag-icon" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M5 3h2v18H5z" fill="currentColor"/><path d="M8 4h11l-2.4 4.2L19 12.4H8z" fill="currentColor"/></svg>';

const ICON_CHEVRON = '<svg class="gp-chevron" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M6 9.5 12 15l6-5.5" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_INFO = '<span class="gp-info" aria-hidden="true">i</span>';

const ICON_REWIND = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round"/><path d="M12 2.4 8.7 5.6 12 8.8" fill="none" stroke="currentColor" '
  + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_FORWARD = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 5a7 7 0 1 0 6.6 4.7" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round"/><path d="M12 2.4 15.3 5.6 12 8.8" fill="none" stroke="currentColor" '
  + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2 19 12 8 18.8z" '
  + 'fill="currentColor"/></svg>';

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" '
  + 'height="14" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" fill="currentColor"/></svg>';

/* Map controls: the four icons below are the shipped Graph SVGs (`._reCenter_`, `._zoomIn_`,
 * `._zoomOut_`, `._fitScreen_`), the compass is the same white/red needle. Decoration only. */
const ICON_RECENTER = '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" '
  + 'clip-rule="evenodd" d="M9.99967 6.66683C8.15801 6.66683 6.66634 8.1585 6.66634 10.0002C6.66634 '
  + '11.8418 8.15801 13.3335 9.99967 13.3335C11.8413 13.3335 13.333 11.8418 13.333 10.0002C13.333 '
  + '8.1585 11.8413 6.66683 9.99967 6.66683ZM17.4497 9.16683C17.0663 5.69183 14.308 2.9335 10.833 '
  + '2.55016V0.833496H9.16634V2.55016C5.69134 2.9335 2.93301 5.69183 2.54967 9.16683H0.833008V10.8335H2.54967C2.93301 '
  + '14.3085 5.69134 17.0668 9.16634 17.4502V19.1668H10.833V17.4502C14.308 17.0668 17.0663 '
  + '14.3085 17.4497 10.8335H19.1663V9.16683H17.4497ZM9.99967 15.8335C6.77467 15.8335 4.16634 '
  + '13.2252 4.16634 10.0002C4.16634 6.77516 6.77467 4.16683 9.99967 4.16683C13.2247 4.16683 '
  + '15.833 6.77516 15.833 10.0002C15.833 13.2252 13.2247 15.8335 9.99967 15.8335Z" '
  + 'fill="currentColor" fill-opacity="0.6"/></svg>';

const ICON_ZOOM_IN = '<svg viewBox="0 0 12 12" aria-hidden="true">'
  + '<rect y="4.36377" width="12" height="3.27273" fill="currentColor"/>'
  + '<rect x="4.36328" width="3.27273" height="12" fill="currentColor"/></svg>';

const ICON_ZOOM_OUT = '<svg viewBox="0 0 10 3" aria-hidden="true">'
  + '<rect width="10" height="3" fill="currentColor"/></svg>';

const ICON_FIT = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path fill="currentColor" '
  + 'fill-opacity="0.6" d="M800-600v-120H680v-80h120q33 0 56.5 23.5T880-720v120h-80Zm-720 0v-120q0-33 '
  + '23.5-56.5T160-800h120v80H160v120H80Zm600 440v-80h120v-120h80v120q0 33-23.5 56.5T800-160H680Zm-520 '
  + '0q-33 0-56.5-23.5T80-240v-120h80v120h120v80H160Zm80-160v-320h480v320H240Zm80-80h320v-160H320v160Zm0 '
  + '0v-160 160Z"/></svg>';

const ICON_COMPASS = '<svg viewBox="0 0 30 46" aria-hidden="true">'
  + '<path fill-rule="evenodd" clip-rule="evenodd" d="M15 34.667L20 22.4737L19.5267 22.0003L15 '
  + '24.0003L10.4733 22.0003L10 22.4737L15 34.667Z" fill="#ffffff"/>'
  + '<path fill-rule="evenodd" clip-rule="evenodd" d="M15 9.33301L10 21.5263L10.4733 21.9997L15 '
  + '19.9997L19.5267 21.9997L20 21.5263L15 9.33301Z" fill="#D0021B"/></svg>';

/** The stacked-layers app icon, drawn at 112 px just like `GraphingLogo.png` (144 px asset, 16 px pad). */
const ICON_LAYERS = '<svg viewBox="0 0 112 112" aria-hidden="true">'
  + '<path d="M56 26 24 40l32 14 32-14-32-14Z" fill="#12242e"/>'
  + '<path d="M24 48.6 56 62.6l32-14v7.6L56 70.2 24 56.2v-7.6Z" fill="#12242e"/>'
  + '<path d="M24 64.4 56 78.4l32-14v7.6L56 86 24 72v-7.6Z" fill="#12242e"/>'
  + '<path d="M56 33.6 41.6 40 56 46.4 70.4 40 56 33.6Z" fill="#68b9dc"/></svg>';

/**
 * Pane markup. Overview is the map stage — the self-drawn basemap fills the stage, the chart sits in
 * a docked strip along its bottom edge (collapsible, `[data-act="dock"]`) and the playhead rides on
 * the docked chart. The three chart tabs get one tile per catalog plot; Project Information gets a
 * single text card. Tiles start empty and are filled by `paintCard()` once their CSV has been read.
 */
export function paneBody(tabId) {
  if (tabId === 'overview') {
    return '<div class="gp-map" data-ref="map">'
      + '<div class="gp-map-svg" data-ref="mapSvg"></div>'
      + '<iframe class="gp-map-frame" data-ref="mapFrame" title="LuciadRIA 地图（原版 Graph 引擎）"'
      + ' src="about:blank" hidden></iframe>'
      + '<span class="gp-map-marker" data-ref="mapMarker" hidden></span>'
      + '<span class="gp-map-marker-label" data-ref="mapMarkerLabel" hidden></span>'
      + '<span class="gp-map-hover" data-ref="mapHover" hidden></span>'
      + '<p class="gp-map-readout" data-ref="mapReadout" hidden></p>'
      + '<p class="gp-map-note" data-ref="mapNote">正在启动 LuciadRIA 引擎（原版 Graph 包，WebGPU）…</p>'
      + '</div>'
      + '<div class="gp-dock" data-ref="dock">'
      + '<div class="gp-dock-head">'
      + '<span class="gp-dock-title" data-ref="dockTitle">折线图</span>'
      + '<button type="button" class="gp-dock-toggle" data-act="dock" aria-expanded="true"'
      + ' aria-label="收起 / 展开折线图">' + ICON_CHEVRON + '</button>'
      + '</div>'
      + '<div class="gp-dock-body">'
      + '<div class="gp-chart"></div>'
      + '<div class="gp-playhead" hidden><span class="gp-playhead-dot"></span></div>'
      + '</div></div>';
  }
  if (tabId === 'project') {
    return '<div class="gp-report" data-report="project">'
      + '<div class="gp-chart-card gp-info-card" data-chart="project/info"></div>'
      + '</div>';
  }
  const cards = chartsOf(tabId)
    .map((spec) => `<div class="gp-chart-card" data-chart="${tabId}/${spec.id}"></div>`)
    .join('');
  return `<div class="gp-report" data-report="${tabId}">${cards}`
    + `<p class="gp-report-foot" data-foot="${tabId}"></p></div>`;
}

function template() {
  const tabs = TABS.map(
    (tab, index) =>
      `<button type="button" class="gp-tab${index === 0 ? ' is-active' : ''}" role="tab" `
      + `id="gp-tab-${tab.id}" data-worktab="${tab.id}" aria-selected="${index === 0}">${esc(tab.label)}</button>`,
  ).join('');

  const exports = EXPORTS.map(
    (item) =>
      `<button type="button" class="gp-export-item" role="menuitem" data-export="${item.id}">`
      + `<span class="gp-export-name">${esc(item.label)}</span>`
      + `<span class="gp-export-hint">${esc(item.hint)}</span></button>`,
  ).join('');

  const speeds = SPEEDS.map((value) => `<option value="${value}">X${value}</option>`).join('');

  const panes = TABS.map((tab, index) => `<div class="gp-pane" data-pane="${tab.id}" `
    + `role="tabpanel" aria-labelledby="gp-tab-${tab.id}"${index === 0 ? '' : ' hidden'}>`
    + `${paneBody(tab.id)}</div>`).join('');

  return `
<div class="graph-panel" data-view="home" data-dock="open">
  <section class="gp-home" aria-label="Graph 首页">
    <div class="gp-home-head">
      <div class="gp-home-left">
        <div class="gp-home-logo">${ICON_LAYERS}</div>
        <h1 class="gp-home-title">Graph</h1>
        <div class="gp-home-actions">
          <button type="button" class="gp-btn gp-btn-light" data-act="new">New Project</button>
          <button type="button" class="gp-btn gp-btn-dark" data-act="open">Open Project</button>
        </div>
      </div>
      <p class="gp-home-blurb">Transform your NovAtel receiver data into dynamic, interactive
        visualizations to simplify data analysis, gain valuable insights, and reduce the time and
        effort required for diagnostics and troubleshooting.</p>
    </div>

    <h2 class="gp-home-recent">Recent Projects</h2>
    <div class="gp-cards" data-ref="cards" role="list"></div>
    <p class="gp-home-status" data-ref="homeStatus"></p>

    <div class="gp-picker" data-ref="picker" hidden>
      <div class="gp-picker-head">
        <h3 data-ref="pickerTitle">Open Project</h3>
        <button type="button" class="gp-picker-close" data-act="picker-close" aria-label="关闭">×</button>
      </div>
      <p class="gp-picker-hint" data-ref="pickerHint"></p>
      <div class="gp-picker-list" data-ref="pickerList" role="list"></div>
    </div>
  </section>

  <section class="gp-work" hidden aria-label="Graph 工程工作区">
    <div class="gp-menubar">
      <div class="gp-tabs" role="tablist" aria-label="Graph 页签">${tabs}</div>
      <div class="gp-export">
        <button type="button" class="gp-export-btn" data-act="export" aria-haspopup="true"
          aria-expanded="false">Export</button>
        <div class="gp-export-menu" data-ref="exportMenu" role="menu" hidden>${exports}</div>
      </div>
    </div>

    <div class="gp-stage">
      <div class="gp-legend" data-ref="legend">
        <button type="button" class="gp-legend-toggle" data-act="legend" aria-expanded="false">
          <span>Legend</span>${ICON_CHEVRON}
        </button>
        <div class="gp-legend-body" data-ref="legendBody" hidden>
          <div class="gp-legend-section">
            <h4>图例</h4>
            <p class="gp-legend-series" data-ref="legendSeries"></p>
            <label class="gp-check">
              <input type="checkbox" data-ref="colourOriginal" data-act="colours">
              <span>Original colours</span>
            </label>
            <p class="gp-legend-meta" data-ref="colourNote">默认：10 色轮换，相邻列一定不同色。</p>
          </div>
          <div class="gp-legend-section">
            <h4>数据源</h4>
            <label class="gp-field"><span>CSV 文件</span>
              <select data-ref="fileSelect"></select></label>
            <label class="gp-field"><span>绘图列（y）</span>
              <select data-ref="columnSelect"></select></label>
            <button type="button" class="gp-btn gp-btn-light gp-btn-small" data-act="refresh">重新读取</button>
            <p class="gp-legend-meta" data-ref="meta"></p>
          </div>
          <div class="gp-legend-section">
            <h4>地图</h4>
            <p class="gp-legend-meta" data-ref="mapLegend">正在读取 2D Trajectory.csv…</p>
            <p class="gp-legend-meta" data-ref="mapEngine">引擎：正在启动 LuciadRIA…</p>
          </div>
          <div class="gp-legend-section">
            <h4>前 20 行</h4>
            <p class="gp-legend-meta" data-ref="tableNote"></p>
            <div class="gp-legend-table">
              <table>
                <thead><tr data-ref="tableHead"></tr></thead>
                <tbody data-ref="tableBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="gp-mapcontrols" role="group" aria-label="地图控件">
        <span class="gp-mapbtn gp-compass" title="正北向上（本构建不旋转地图）">${ICON_COMPASS}</span>
        <button type="button" class="gp-mapbtn gp-recenter" data-act="map-recenter"
          title="回到轨迹中心" aria-label="回到轨迹中心">${ICON_RECENTER}</button>
        <button type="button" class="gp-mapbtn gp-zoomin" data-act="map-zoomin"
          title="放大" aria-label="放大">${ICON_ZOOM_IN}</button>
        <button type="button" class="gp-mapbtn gp-zoomout" data-act="map-zoomout"
          title="缩小" aria-label="缩小">${ICON_ZOOM_OUT}</button>
        <button type="button" class="gp-mapbtn gp-fit" data-act="map-fit"
          title="缩放到轨迹范围" aria-label="缩放到轨迹范围">${ICON_FIT}</button>
      </div>

      <div class="gp-notice" data-ref="notice" hidden></div>
      ${panes}
    </div>

    <div class="gp-timeline">
      <div class="gp-tl-track"><span class="gp-tl-marker" data-ref="marker"></span></div>

      <div class="gp-tl-row">
        <div class="gp-tl-flags">
          <span class="gp-tl-flagbox">${ICON_FLAG}</span>
          <span class="gp-tl-flags-text">
            <span class="gp-tl-flags-label">Flags ${ICON_INFO}</span>
            <span class="gp-tl-flags-count">(0/${FLAG_LIMIT})</span>
          </span>
        </div>

        <div class="gp-tl-times">
          <span class="gp-tl-fact"><span class="gp-tl-label">Start Time (GPS)</span>
            <span class="gp-tl-value" data-ref="startTime">—</span></span>
          <span class="gp-tl-fact"><span class="gp-tl-label">End Time (GPS)</span>
            <span class="gp-tl-value" data-ref="endTime">—</span></span>
        </div>

        <div class="gp-tl-transport">
          <button type="button" class="gp-tl-btn" data-act="rewind" aria-label="回到起点">${ICON_REWIND}</button>
          <button type="button" class="gp-tl-btn gp-tl-play" data-act="play" aria-label="播放 / 暂停" aria-pressed="false">${ICON_PLAY}</button>
          <button type="button" class="gp-tl-btn" data-act="forward" aria-label="跳到终点">${ICON_FORWARD}</button>
          <span class="gp-tl-clock" data-ref="clock">00:00:00|00:00:00</span>
        </div>

        <div class="gp-tl-speed">
          <span class="gp-tl-label">Speed</span>
          <select class="gp-tl-select" data-ref="speed" aria-label="播放倍速">${speeds}</select>
        </div>

        <div class="gp-tl-events">
          <span class="gp-tl-label">Show Events</span>
          <button type="button" class="gp-tl-switch" data-act="events" role="switch" aria-checked="false"
            aria-label="显示事件"><span class="gp-tl-knob"></span></button>
        </div>
      </div>
    </div>
  </section>
</div>`;
}

/* ---------------- panel ---------------- */

export function mount(root, ctx) {
  ensureCss();

  const api = (ctx && ctx.api) || defaultApi();
  const panel = ctx || {};

  root.innerHTML = template();
  const host = root.querySelector('.graph-panel');

  const $ = (ref) => root.querySelector(`[data-ref="${ref}"]`);
  const el = {
    home: root.querySelector('.gp-home'),
    work: root.querySelector('.gp-work'),
    cards: $('cards'),
    homeStatus: $('homeStatus'),
    picker: $('picker'),
    pickerTitle: $('pickerTitle'),
    pickerHint: $('pickerHint'),
    pickerList: $('pickerList'),
    legend: $('legend'),
    legendBody: $('legendBody'),
    legendSeries: $('legendSeries'),
    colourOriginal: $('colourOriginal'),
    colourNote: $('colourNote'),
    fileSelect: $('fileSelect'),
    columnSelect: $('columnSelect'),
    meta: $('meta'),
    tableNote: $('tableNote'),
    tableHead: $('tableHead'),
    tableBody: $('tableBody'),
    notice: $('notice'),
    chart: root.querySelector('.gp-chart'),
    playhead: root.querySelector('.gp-playhead'),
    dock: $('dock'),
    dockTitle: $('dockTitle'),
    map: $('map'),
    mapSvg: $('mapSvg'),
    mapFrame: $('mapFrame'),
    mapNote: $('mapNote'),
    mapEngine: $('mapEngine'),
    mapMarker: $('mapMarker'),
    mapMarkerLabel: $('mapMarkerLabel'),
    mapHover: $('mapHover'),
    mapReadout: $('mapReadout'),
    mapLegend: $('mapLegend'),
    exportMenu: $('exportMenu'),
    startTime: $('startTime'),
    endTime: $('endTime'),
    clock: $('clock'),
    speed: $('speed'),
    marker: $('marker'),
    playButton: root.querySelector('[data-act="play"]'),
  };

  const state = {
    alive: true,
    view: 'home',
    tab: 'overview',
    files: [],
    directory: '',
    project: '',
    date: '',
    data: null,
    file: '',
    column: '',
    playing: false,
    speed: 1,
    current: 0,
    span: 0,
    duration: 0,
    raf: 0,
    last: 0,
    geometry: null,
    legendOpen: false,
    showEvents: false,
    /* 图例 → Original colours: the readable 10-colour wheel, or the original's `stringToColor` */
    colourMode: typeof window === 'undefined'
      ? 'readable'
      : colourModeFromSearch(window.location.search),
    /* overview: the map + the docked chart */
    dock: 'open',
    /* overview map renderer: 'luciad' until the stage says otherwise */
    mapEngine: typeof window === 'undefined'
      ? 'luciad'
      : mapEngineFromSearch(window.location.search),
    luciad: 'idle', // idle | booting | ready | failed
    luciadError: '',
    /* chart tabs */
    payloads: new Map(),
    models: new Map(),
    started: new Set(),
    chipOff: new Set(),
    filesLoaded: false,
    deferredTab: '',
  };

  /* ---- small UI helpers ---- */

  /** Palette entry under the current 图例 switch (`readable` by default, `original` on demand). */
  function colourFor(name, index) {
    return seriesColour(state.colourMode, name, index, 'light');
  }

  /**
   * Re-colour every already-built tile from the cached models and repaint — no re-fetch, because a
   * colour is a property of `(name, index)` and both are already on the series. `columnIndex` keeps
   * the original's `index` meaning (the CSV column number) even when a column failed to load and the
   * array position shifted.
   */
  function recolourModels() {
    for (const entry of state.models.values()) {
      if (!entry || !entry.model || !Array.isArray(entry.model.series)) continue;
      entry.model = {
        ...entry.model,
        series: entry.model.series.map((item, position) => ({
          ...item,
          color: colourFor(item.name, Number.isInteger(item.columnIndex) ? item.columnIndex : position),
        })),
      };
    }
  }

  /** 图例 checkbox / `?colors=` → repaint with the other palette. */
  function applyColourMode(mode) {
    state.colourMode = mode === 'original' ? 'original' : 'readable';
    if (el.colourOriginal) el.colourOriginal.checked = state.colourMode === 'original';
    if (el.colourNote) {
      el.colourNote.textContent = state.colourMode === 'original'
        ? '原版算法：stringToColor（FNV-1a → HSL，hue = [0,140,240,…][i%11] ± 8）。'
          + '与 Graph 导出图逐列同色，代价是相邻列容易撞色。'
        : '默认：10 色轮换，相邻列一定不同色。勾选 Original colours 换成原版 stringToColor。';
    }
    recolourModels();
    if (state.view !== 'work') return;
    if (state.tab === 'overview') {
      drawChart();
      return;
    }
    paintTab(state.tab);
  }

  function showNotice(text) {
    if (!el.notice) return;
    el.notice.hidden = !text;
    el.notice.textContent = text || '';
  }

  function setView(view) {
    state.view = view;
    host.dataset.view = view;
    el.home.hidden = view !== 'home';
    el.work.hidden = view !== 'work';
    if (view === 'work') {
      requestAnimationFrame(() => {
        renderMap();
        if (state.tab === 'overview') drawChart();
        else paintTab(state.tab);
      });
    }
  }

  function setTab(id) {
    state.tab = id;
    host.dataset.tab = id;
    for (const button of root.querySelectorAll('[data-worktab]')) {
      const active = button.dataset.worktab === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of root.querySelectorAll('.gp-pane')) {
      pane.hidden = pane.dataset.pane !== id;
    }
    if (id === 'overview') {
      requestAnimationFrame(() => {
        renderMap();
        drawChart();
        updatePlayhead();
      });
      return;
    }
    ensureTab(id);
    requestAnimationFrame(() => paintTab(id));
  }

  function closeExport() {
    el.exportMenu.hidden = true;
    const button = root.querySelector('[data-act="export"]');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function openExport() {
    el.exportMenu.hidden = false;
    const button = root.querySelector('[data-act="export"]');
    if (button) button.setAttribute('aria-expanded', 'true');
  }

  function setLegend(open) {
    state.legendOpen = open;
    el.legendBody.hidden = !open;
    const toggle = root.querySelector('[data-act="legend"]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.legend.classList.toggle('is-open', open);
    }
  }

  /* ---- chart ---- */

  /** The docked chart's own box: the Overview chart no longer owns the whole stage (the map does). */
  function paneBox() {
    const node = el.chart;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    return { width: Math.max(320, Math.round(rect.width)), height: Math.max(120, Math.round(rect.height)) };
  }

  /**
   * Line chart, same drawing as the old in-shell page (`chartSvg`), only the canvas is now the size
   * of the stage instead of a fixed 860×300 viewBox.
   */
  function chartSvg(series, width, height) {
    const points = series.points;
    const pad = {
      left: 72,
      right: 26,
      top: 34,
      bottom: 48,
    };
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) {
      yMax = yMin + 1;
      yMin -= 1;
    }
    const plotW = Math.max(20, width - pad.left - pad.right);
    const plotH = Math.max(20, height - pad.top - pad.bottom);
    const px = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
    const py = (y) => pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

    state.geometry = { pad, plotW, plotH, xMin, xMax, width, height };

    /* One series, so colour carries no information: the default is the measured pair from the
     * reference screenshot, `Original colours` swaps in the column's hashed hue instead. */
    const stroke = state.colourMode === 'original'
      ? colourFor((state.data && state.data.column) || '', 0)
      : '#00516F';
    const dot = state.colourMode === 'original' ? stroke : '#00ABC8';

    const parts = [
      `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(series.label || '折线图')}">`,
    ];
    const yStep = (yMax - yMin) / 4;
    const xStep = (xMax - xMin) / 4;
    for (let i = 0; i <= 4; i += 1) {
      const yValue = yMin + yStep * i;
      const yPos = py(yValue);
      parts.push(
        `<line x1="${pad.left}" y1="${yPos.toFixed(1)}" x2="${width - pad.right}" y2="${yPos.toFixed(1)}" stroke="rgba(0,0,0,0.12)"/>`,
      );
      parts.push(
        `<text x="${pad.left - 10}" y="${(yPos + 3.5).toFixed(1)}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="end" font-family="Consolas, monospace">${esc(formatTick(yValue, yStep))}</text>`,
      );
    }
    for (let k = 0; k <= 4; k += 1) {
      const xValue = xMin + xStep * k;
      const xPos = px(xValue);
      parts.push(
        `<line x1="${xPos.toFixed(1)}" y1="${pad.top}" x2="${xPos.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(0,0,0,0.08)"/>`,
      );
      parts.push(
        `<text x="${xPos.toFixed(1)}" y="${pad.top + plotH + 18}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="middle" font-family="Consolas, monospace">${esc(formatTick(xValue, xStep))}</text>`,
      );
    }
    parts.push(
      `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
      `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
      `<polyline fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${points
        .map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`)
        .join(' ')}"/>`,
    );
    if (points.length <= 120) {
      parts.push(
        points
          .map((p) => `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="2.2" fill="${dot}"/>`)
          .join(''),
      );
    }
    parts.push(
      `<text x="${pad.left}" y="${height - 10}" font-size="11" fill="rgba(0,0,0,0.6)">${esc(series.xLabel)} · ${esc(series.xStartLabel)} → ${esc(series.xEndLabel)}</text>`,
      '</svg>',
    );
    return parts.join('');
  }

  function drawChart() {
    if (!el.chart || !state.alive) return;
    if (state.dock !== 'open') return;
    const box = paneBox();
    if (!box) return;
    const data = state.data;
    if (el.dockTitle) {
      el.dockTitle.textContent = data
        ? `${data.name}${data.column ? ` · ${data.column}` : ' · （无数值列）'}`
        : '折线图';
    }
    if (!data) {
      el.chart.innerHTML = '<div class="gp-chart-empty">正在读取 CSV…</div>';
      return;
    }
    const points = data.series.points || [];
    if (!points.length) {
      el.chart.innerHTML = '<div class="gp-chart-empty">该 CSV 没有数值列，只能查看表格（Legend → 前 20 行）。</div>';
      state.geometry = null;
      el.playhead.hidden = true;
      return;
    }
    el.chart.innerHTML = chartSvg(data.series, box.width, box.height);
    updatePlayhead();
  }

  function updatePlayhead() {
    const geometry = state.geometry;
    if (!geometry || !state.span) {
      if (el.playhead) el.playhead.hidden = true;
      if (el.marker) el.marker.hidden = true;
      updateMapCursor();
      return;
    }
    const ratio = Math.min(1, Math.max(0, state.current / state.span));
    if (el.playhead) {
      el.playhead.hidden = false;
      el.playhead.style.left = `${geometry.pad.left + ratio * geometry.plotW}px`;
      el.playhead.style.top = `${geometry.pad.top}px`;
      el.playhead.style.height = `${geometry.plotH}px`;
    }
    if (el.marker) {
      // the scrub track runs from 158 px to 19 px off the right edge (`graph.css .gp-tl-track`)
      el.marker.hidden = false;
      el.marker.style.left = `calc(158px + (100% - 177px) * ${ratio.toFixed(4)})`;
    }
    updateMapCursor();
  }

  /* ---- map: self-drawn offline basemap + track / cursor layers ---- */

  /**
   * Everything the map needs is already behind `/api/graph/*`: the fixes of `2D Trajectory.csv`, the
   * per-epoch 1σ of `Position SD.csv`, the ellipsoidal height of `Height.csv`. The view is
   * `{ centerLon, centerLat, spanM }` and lives here rather than in the SVG, so a wheel/pointer
   * gesture is one state change plus one re-render of a few-dozen-element drawing. The cursor chip
   * is a DOM element, not part of the SVG, because the timeline repaints it every animation frame.
   */
  const mapState = {
    status: 'idle', // idle | loading | ready | error
    error: '',
    points: [],
    sigmaM: 0,
    heights: [],
    view: null,
    hover: null,
    payload: null,
  };

  let mapDrag = null;

  /* ---- the LuciadRIA stage (原版引擎，跑在同源 iframe 里) ---- */

  /**
   * The stage is a separate document, so everything here is `postMessage`. It is only started once
   * the trajectory is loaded, and the panel only claims Luciad once the stage has answered `ready`;
   * `failLuciad()` drops back to `mapSvg()` and prints the reason in the note and in the legend.
   */
  const luciad = {
    frame: el.mapFrame,
    status: 'idle', // idle | booting | ready | failed
    error: '',
    timer: 0,
    cursorIndex: -1,
    view: null,
  };

  function postToStage(message) {
    const frame = luciad.frame;
    if (!frame || !frame.contentWindow) return;
    if (luciad.status !== 'ready') return;
    frame.contentWindow.postMessage(message, new URL(LUCIAD_STAGE_URL).origin);
  }

  function engineNote() {
    if (luciad.status === 'ready') {
      return 'LuciadRIA 2026.0 渲染中 · 原版 Graph 引擎包 · 底图是自绘经纬网（离线，无商业瓦片）';
    }
    if (luciad.status === 'failed') {
      return `Luciad 不可用（${luciad.error}）· 已退回自绘经纬网，数据相同`;
    }
    if (state.mapEngine === 'canvas') {
      return '自绘经纬网（?map=canvas）· 离线，无商业瓦片';
    }
    return '正在启动 LuciadRIA 引擎（原版 Graph 包，WebGPU）…';
  }

  function updateMapEngineUi() {
    if (el.mapNote) el.mapNote.textContent = engineNote();
    if (!el.mapEngine) return;
    if (luciad.status === 'ready') {
      el.mapEngine.textContent = `引擎：LuciadRIA 2026.0（原版 Graph 包）· 参考系 `
        + `${luciad.view && luciad.view.reference ? luciad.view.reference : 'EPSG:32662'} · WebGPU`
        + ' · 轨迹来自 2D Trajectory.csv';
      return;
    }
    if (luciad.status === 'failed') {
      el.mapEngine.textContent = `引擎：自绘 SVG（Luciad 不可用：${luciad.error}）`;
      return;
    }
    if (state.mapEngine === 'canvas') {
      el.mapEngine.textContent = '引擎：自绘 SVG（?map=canvas）· LuciadRIA 未启用';
      return;
    }
    el.mapEngine.textContent = '引擎：正在启动 LuciadRIA（/geo/luciad-engine.js）…';
  }

  function failLuciad(reason) {
    if (luciad.status === 'failed') return;
    luciad.status = 'failed';
    luciad.error = String(reason || '未知原因').slice(0, 200);
    if (luciad.timer) window.clearTimeout(luciad.timer);
    luciad.timer = 0;
    if (luciad.frame) luciad.frame.hidden = true;
    updateMapEngineUi();
    renderMap();
  }

  function onLuciadMessage(event) {
    const frame = luciad.frame;
    if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.type === 'ready') {
      if (luciad.timer) window.clearTimeout(luciad.timer);
      luciad.timer = 0;
      luciad.status = 'ready';
      luciad.view = { reference: data.reference, webgpu: data.webgpu };
      updateMapEngineUi();
      sendTrackToStage();
      renderMap();
      return;
    }
    if (data.type === 'error') {
      failLuciad(data.message || '引擎启动失败');
      return;
    }
    if (data.type === 'view') {
      luciad.view = { ...luciad.view, ...data };
      updateMapHud();
      return;
    }
    if (data.type === 'hover') {
      mapState.hover = Number.isFinite(data.lon) && Number.isFinite(data.lat)
        ? { lon: data.lon, lat: data.lat }
        : null;
      if (el.mapHover) {
        el.mapHover.hidden = !mapState.hover;
        if (mapState.hover && Number.isFinite(data.x) && Number.isFinite(data.y)) {
          el.mapHover.style.left = `${Number(data.x).toFixed(1)}px`;
          el.mapHover.style.top = `${Number(data.y).toFixed(1)}px`;
        }
      }
      updateMapHud();
      return;
    }
    if (data.type === 'cursor') {
      luciad.cursorPoint = { x: Number(data.x) || 0, y: Number(data.y) || 0 };
      const point = mapState.points[luciad.cursorIndex];
      const visible = Boolean(data.visible) && luciad.cursorIndex >= 0 && Boolean(point);
      if (el.mapMarker) {
        el.mapMarker.hidden = !visible;
        if (visible) {
          el.mapMarker.style.left = `${luciad.cursorPoint.x.toFixed(1)}px`;
          el.mapMarker.style.top = `${luciad.cursorPoint.y.toFixed(1)}px`;
        }
      }
      if (el.mapMarkerLabel) {
        el.mapMarkerLabel.hidden = !visible;
        if (visible) {
          el.mapMarkerLabel.style.left = `${luciad.cursorPoint.x.toFixed(1)}px`;
          el.mapMarkerLabel.style.top = `${luciad.cursorPoint.y.toFixed(1)}px`;
          el.mapMarkerLabel.textContent = mapCursorLabel(luciad.cursorIndex, point);
        }
      }
    }
  }

  function sendTrackToStage() {
    if (luciad.status !== 'ready' || mapState.status !== 'ready') return;
    postToStage({
      type: 'track',
      points: mapState.points.map((point) => [point.lon, point.lat]),
      sigmaM: mapState.sigmaM,
      trackColor: MAP_TRACK_COLOR,
      fit: true,
    });
  }

  function startLuciad() {
    if (luciad.status !== 'idle' || state.mapEngine !== 'luciad' || !luciad.frame) return;
    luciad.status = 'booting';
    updateMapEngineUi();
    /* A cold 16 MB module plus a wasm boot; past this the panel stops waiting and says so on the
     * stage instead of leaving "正在启动…" on screen forever. */
    luciad.timer = window.setTimeout(() => {
      failLuciad(`引擎 ${Math.round(LUCIAD_READY_TIMEOUT_MS / 1000)} 秒内没有就绪`);
    }, LUCIAD_READY_TIMEOUT_MS);
    luciad.frame.src = LUCIAD_STAGE_URL;
  }

  function mapBox() {
    const node = el.map;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function updateMapLegend() {
    if (!el.mapLegend) return;
    if (mapState.status === 'error') {
      el.mapLegend.textContent = `轨迹读取失败：${mapState.error}`;
      return;
    }
    if (mapState.status !== 'ready') {
      el.mapLegend.textContent = `正在读取 ${MAP_FILE}…`;
      return;
    }
    const extent = trackExtent(mapState.points);
    el.mapLegend.textContent = `轨迹 ${mapState.points.length} 点`
      + ` · 长度 ${formatDistance(trackLength(mapState.points))}`
      + (extent ? ` · 跨度 ${formatDistance(Math.max(extent.eastM, extent.northM))}` : '')
      + ' · 数据源 2D Trajectory.csv / Position SD.csv';
  }

  function renderMap() {
    if (!el.mapSvg || !state.alive) return;
    if (luciad.status === 'ready') {
      /* Luciad owns the stage: hide the SVG, show the frame. The engine keeps its own view, so a
       * re-render here must not touch its camera — only the HUD is ours. */
      el.mapSvg.style.display = 'none';
      if (luciad.frame) luciad.frame.hidden = false;
      updateMapHud();
      return;
    }
    el.mapSvg.style.display = '';
    if (luciad.frame) luciad.frame.hidden = true;
    if (mapState.status === 'idle' || mapState.status === 'loading') {
      el.mapSvg.innerHTML = `<p class="gp-map-empty">正在读取 ${esc(MAP_FILE)}…</p>`;
      if (el.mapReadout) el.mapReadout.hidden = true;
      return;
    }
    if (mapState.status === 'error') {
      el.mapSvg.innerHTML = `<p class="gp-map-empty">读不到轨迹：${esc(mapState.error)}</p>`;
      if (el.mapReadout) el.mapReadout.hidden = true;
      return;
    }
    const box = mapBox();
    if (!box) return;
    if (!mapState.view) mapState.view = mapFit(mapState.points, box.width, box.height);
    el.mapSvg.innerHTML = mapSvg(
      { points: mapState.points, view: mapState.view, sigmaM: mapState.sigmaM },
      box.width,
      box.height,
    );
    updateMapHud();
    updateMapCursor();
  }

  function updateMapHud() {
    if (!el.mapReadout) return;
    if (mapState.status !== 'ready') {
      el.mapReadout.hidden = true;
      return;
    }
    if (mapState.hover) {
      el.mapReadout.hidden = false;
      const origin = mapState.points[0];
      const distance = origin ? pointDistance(origin, mapState.hover) : 0;
      el.mapReadout.textContent = `${latLabel(mapState.hover.lat)}  ${lonLabel(mapState.hover.lon)}`
        + ` · 距首点 ${formatDistance(distance)}`;
      return;
    }
    if (luciad.status === 'ready') {
      // The engine reports its own view; print that instead of a view the panel no longer owns.
      if (luciad.view && luciad.view.label) {
        el.mapReadout.hidden = false;
        el.mapReadout.textContent = luciad.view.label;
      } else {
        el.mapReadout.hidden = true;
      }
      return;
    }
    if (!mapState.view) {
      el.mapReadout.hidden = true;
      return;
    }
    el.mapReadout.hidden = false;
    const extent = trackExtent(mapState.points);
    const degenerate = extent ? Math.max(extent.eastM, extent.northM) < 1e-6 : false;
    el.mapReadout.textContent = `${latLabel(mapState.view.centerLat)}  ${lonLabel(mapState.view.centerLon)}`
      + ` · 视野 ${formatDistance(mapState.view.spanM)}`
      + (degenerate ? ' · 轨迹退化为 1 点' : '');
  }

  function mapCursorLabel(index, point) {
    const parts = [`#${index + 1}`];
    const base = mapState.payload ? parseGpsStamp(mapState.payload.comments && mapState.payload.comments.startTime) : null;
    if (base !== null && Number.isFinite(point.t)) parts.push(gpsWeekLabel(base + point.t));
    else parts.push(`+${(Number(point.t) || 0).toFixed(1)} s`);
    const height = mapState.heights[index];
    if (Number.isFinite(height)) parts.push(`${height.toFixed(3)} m`);
    return parts.join(' · ');
  }

  /** Timeline cursor → one fix on the map. Cheap enough to run every animation frame. */
  function updateMapCursor() {
    const marker = el.mapMarker;
    const label = el.mapMarkerLabel;
    const hide = () => {
      if (marker) marker.hidden = true;
      if (label) label.hidden = true;
    };
    if (!marker || !label || mapState.status !== 'ready' || !mapState.points.length) {
      hide();
      return;
    }
    const ratio = state.span > 0 ? Math.min(1, Math.max(0, state.current / state.span)) : 0;
    const index = indexForRatio(mapState.points, ratio);

    if (luciad.status === 'ready') {
      /* The stage owns the projection: ask it to move its own feature, then place the chip from the
       * pixel it reports back. Only the index is sent — the chip's text stays in this file. */
      if (index !== luciad.cursorIndex) {
        luciad.cursorIndex = index;
        postToStage({ type: 'cursor', index });
      }
      return;
    }
    if (!mapState.view) {
      hide();
      return;
    }
    const box = mapBox();
    if (!box) {
      hide();
      return;
    }
    if (index < 0) {
      hide();
      return;
    }
    const point = mapState.points[index];
    const projection = mapProjection(mapState.view, box.width, box.height);
    const px = projection.x(point.lon);
    const py = projection.y(point.lat);
    const visible = px > -24 && px < box.width + 24 && py > -24 && py < box.height + 24;
    marker.hidden = !visible;
    label.hidden = !visible;
    if (!visible) return;
    marker.style.left = `${px.toFixed(1)}px`;
    marker.style.top = `${py.toFixed(1)}px`;
    label.style.left = `${px.toFixed(1)}px`;
    label.style.top = `${py.toFixed(1)}px`;
    label.textContent = mapCursorLabel(index, point);
  }

  function setMapView(view) {
    mapState.view = {
      centerLon: Math.max(-180, Math.min(180, view.centerLon)),
      centerLat: Math.max(-85, Math.min(85, view.centerLat)),
      spanM: Math.max(MAP_MIN_SPAN_M, Math.min(MAP_MAX_SPAN_M, view.spanM)),
    };
    renderMap();
  }

  /** Zoom by `factor` while keeping the geography under `(anchorX, anchorY)` pinned there. */
  function zoomMap(factor, anchorX, anchorY) {
    if (luciad.status === 'ready') {
      // `factor` > 1 widens the view; Luciad's `zoom({factor})` > 1 narrows it — invert.
      postToStage({ type: 'zoom', factor: 1 / (Number(factor) || 1) });
      return;
    }
    const box = mapBox();
    if (!box || !mapState.view) return;
    const ax = Number.isFinite(anchorX) ? anchorX : box.width / 2;
    const ay = Number.isFinite(anchorY) ? anchorY : box.height / 2;
    const before = mapProjection(mapState.view, box.width, box.height);
    const lon = before.lonAt(ax);
    const lat = before.latAt(ay);
    const spanM = Math.max(MAP_MIN_SPAN_M, Math.min(MAP_MAX_SPAN_M, mapState.view.spanM * factor));
    const after = mapProjection({ ...mapState.view, spanM }, box.width, box.height);
    setMapView({
      spanM,
      centerLon: mapState.view.centerLon + (lon - after.lonAt(ax)),
      centerLat: mapState.view.centerLat + (lat - after.latAt(ay)),
    });
  }

  function panMap(dxPx, dyPx) {
    if (luciad.status === 'ready') return; // the engine's own controller pans
    const box = mapBox();
    if (!box || !mapState.view) return;
    const projection = mapProjection(mapState.view, box.width, box.height);
    setMapView({
      spanM: mapState.view.spanM,
      centerLon: mapState.view.centerLon - dxPx * projection.degreesPerPixel.lon,
      centerLat: mapState.view.centerLat + dyPx * projection.degreesPerPixel.lat,
    });
  }

  function fitMap() {
    if (luciad.status === 'ready') {
      postToStage({ type: 'fit' });
      return;
    }
    const box = mapBox();
    if (!box || !mapState.points.length) return;
    mapState.view = mapFit(mapState.points, box.width, box.height);
    renderMap();
  }

  function updateMapHover(px, py) {
    if (!el.map || el.map.hidden) return;
    if (luciad.status === 'ready') return; // the stage reports hover coordinates itself
    const box = mapBox();
    if (!box || !mapState.view || mapState.status !== 'ready') {
      mapState.hover = null;
      if (el.mapHover) el.mapHover.hidden = true;
      updateMapHud();
      return;
    }
    const projection = mapProjection(mapState.view, box.width, box.height);
    mapState.hover = { lon: projection.lonAt(px), lat: projection.latAt(py) };
    if (el.mapHover) {
      el.mapHover.hidden = false;
      el.mapHover.style.left = `${px.toFixed(1)}px`;
      el.mapHover.style.top = `${py.toFixed(1)}px`;
    }
    updateMapHud();
  }

  function clearMapHover() {
    mapState.hover = null;
    if (el.mapHover) el.mapHover.hidden = true;
    updateMapHud();
  }

  async function loadMap() {
    mapState.status = 'loading';
    updateMapLegend();
    renderMap();
    try {
      const [lonPayload, latPayload] = await Promise.all([
        fetchData(MAP_FILE, MAP_LON_COLUMN),
        fetchData(MAP_FILE, MAP_LAT_COLUMN),
      ]);
      const points = trajectoryPoints(lonPayload, latPayload);
      if (!points.length) throw new Error(`${MAP_FILE} 里没有可配对的经纬度列`);
      mapState.points = points;
      mapState.payload = latPayload;

      // 1σ circle: Position SD.csv, first epoch, largest of the two horizontal axes.
      const [sdLat, sdLon] = await Promise.all([
        fetchData(MAP_SD_FILE, MAP_SD_LAT_COLUMN).catch(() => null),
        fetchData(MAP_SD_FILE, MAP_SD_LON_COLUMN).catch(() => null),
      ]);
      const sdLatValue = sdLat && sdLat.series.points[0] ? Number(sdLat.series.points[0][1]) : 0;
      const sdLonValue = sdLon && sdLon.series.points[0] ? Number(sdLon.series.points[0][1]) : 0;
      mapState.sigmaM = Math.max(sdLatValue || 0, sdLonValue || 0);

      const height = await fetchData(MAP_HEIGHT_FILE).catch(() => null);
      mapState.heights = height && height.series && height.series.points
        ? height.series.points.map((point) => Number(point[1]))
        : [];

      const box = mapBox();
      mapState.view = mapFit(points, box ? box.width : 800, box ? box.height : 360);
      mapState.status = 'ready';
      updateMapLegend();
      renderMap();
      if (state.mapEngine === 'luciad') startLuciad();
      sendTrackToStage();
    } catch (error) {
      mapState.status = 'error';
      mapState.error = error.message;
      updateMapLegend();
      renderMap();
    }
  }

  function setDock(open) {
    state.dock = open ? 'open' : 'closed';
    host.dataset.dock = state.dock;
    if (el.dock) el.dock.classList.toggle('is-collapsed', !open);
    const toggle = root.querySelector('[data-act="dock"]');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    requestAnimationFrame(() => {
      renderMap();
      if (open) drawChart();
      updatePlayhead();
    });
  }

  /* ---- map gestures ---- */

  function onMapPointerDown(event) {
    if (event.button !== 0 || mapState.status !== 'ready' || !el.map) return;
    el.map.classList.add('is-dragging');
    mapDrag = { x: event.clientX, y: event.clientY, moved: false };
    try {
      el.map.setPointerCapture(event.pointerId);
    } catch {
      /* older engines: dragging still works, it just loses the pointer outside the box */
    }
  }

  function onMapPointerMove(event) {
    if (!el.map) return;
    const rect = el.map.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (mapDrag) {
      const dx = event.clientX - mapDrag.x;
      const dy = event.clientY - mapDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        mapDrag.moved = true;
        panMap(dx, dy);
        mapDrag.x = event.clientX;
        mapDrag.y = event.clientY;
      }
    }
    updateMapHover(px, py);
  }

  function onMapPointerUp(event) {
    mapDrag = null;
    if (el.map) {
      el.map.classList.remove('is-dragging');
      try {
        el.map.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer capture was never taken */
      }
    }
  }

  function onMapWheel(event) {
    if (!el.map || mapState.status !== 'ready') return;
    event.preventDefault();
    const rect = el.map.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    zoomMap(event.deltaY > 0 ? 1 / 1.25 : 1.25, px, py);
    updateMapHover(px, py);
  }

  function onMapDoubleClick(event) {
    if (!el.map || mapState.status !== 'ready') return;
    const rect = el.map.getBoundingClientRect();
    zoomMap(1 / 1.8, event.clientX - rect.left, event.clientY - rect.top);
  }

  /* ---- chart tabs: PVT / Tracking & Measurements / Receiver Status / Project Information ---- */

  /**
   * `/api/graph/data` returns **one** numeric column per call (`?column=`), so a tile with N series
   * is N calls against the same file. The server parses each CSV once (its own file cache), so every
   * call after the first is just JSON. Results are memoised per `file` and per `file#column`, and the
   * probe call (no `column`) is reused as the payload of the column it defaulted to.
   */
  const pending = new Map();

  function fetchData(file, column) {
    const key = column ? `${file}#${column}` : file;
    if (state.payloads.has(key)) return Promise.resolve(state.payloads.get(key));
    if (pending.has(key)) return pending.get(key);
    const promise = api
      .get('/graph/data', column ? { file, column } : { file })
      .then((body) => {
        state.payloads.set(key, body);
        pending.delete(key);
        return body;
      })
      .catch((error) => {
        pending.delete(key);
        throw error;
      });
    pending.set(key, promise);
    return promise;
  }

  /** The Tracking tab needs ~175 column fetches; cap the fan-out so the pane stays responsive. */
  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const runners = [];
    const width = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < width; i += 1) {
      runners.push((async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          out[index] = await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
    return out;
  }

  function categoryModel(spec, probe) {
    const timeIndex = probe.columns.findIndex((column) => /timestamp/i.test(column));
    const valueIndex = probe.columns.findIndex((_, index) => index !== timeIndex);
    const rows = (probe.table && probe.table.rows) || [];
    if (!rows.length) return { status: 'empty', reason: `${probe.name} 没有数据行` };
    if (probe.rows > rows.length) {
      return {
        status: 'empty',
        reason: `这张图要逐行读分类列，但 /api/graph/data 只给前 ${rows.length} 行（共 ${probe.rows} 行），画出来会缺样本`,
      };
    }
    const base = timeIndex >= 0 ? parseGpsCell(rows[0][timeIndex]) : null;
    const samples = rows.map((row, index) => {
      const absolute = timeIndex >= 0 ? parseGpsCell(row[timeIndex]) : null;
      return {
        x: absolute !== null && base !== null ? Math.round((absolute - base) * 1000) / 1000 : index,
        label: row[valueIndex] || '—',
      };
    });
    const names = [];
    for (const sample of samples) if (!names.includes(sample.label)) names.push(sample.label);
    const series = names.map((name, index) => ({
      name,
      color: colourFor(name, index),
      columnIndex: index,
      points: samples.filter((sample) => sample.label === name).map((sample) => [sample.x, 1]),
    }));
    const lastAbsolute = timeIndex >= 0 ? parseGpsCell(rows[rows.length - 1][timeIndex]) : null;
    return {
      status: 'ready',
      kind: 'category',
      title: spec.title,
      units: '',
      series,
      xLabel: timeIndex >= 0 ? '时间（相对首帧，s）' : '行序号',
      xKind: timeIndex >= 0 ? 'time' : 'index',
      xStartLabel: timeIndex >= 0 && base !== null ? gpsWeekLabel(base) : '#1',
      xEndLabel: timeIndex >= 0 && lastAbsolute !== null ? gpsWeekLabel(lastAbsolute) : `#${rows.length}`,
      rows: probe.rows,
      columns: 1,
      file: probe.name,
    };
  }

  async function geomapModel(spec, probe) {
    const numeric = probe.numericColumns.map((column) => column.name);
    const lonName = numeric.includes(spec.xColumn) ? spec.xColumn : numeric[1];
    const latName = numeric.includes(spec.yColumn) ? spec.yColumn : numeric[0];
    if (!lonName || !latName) {
      return { status: 'empty', reason: `${probe.name} 里没有经度 / 纬度两列` };
    }
    const [lon, lat] = await Promise.all([
      fetchData(spec.file, lonName).catch(() => null),
      fetchData(spec.file, latName).catch(() => null),
    ]);
    if (!lon || !lat) {
      return { status: 'empty', reason: `读不到 ${probe.name} 的 ${lonName} / ${latName} 列` };
    }
    const east = lon.series.points;
    const north = lat.series.points;
    if (east.length !== north.length) {
      return {
        status: 'empty',
        reason: `经度与纬度行数不一致（${east.length} / ${north.length}），无法配成点`,
      };
    }
    const points = east.map((point, index) => [point[1], north[index][1]]);
    if (!points.length) return { status: 'empty', reason: `${probe.name} 没有可配对的经纬度点` };
    let xMin = Infinity;
    let xMax = -Infinity;
    for (const point of points) {
      if (point[0] < xMin) xMin = point[0];
      if (point[0] > xMax) xMax = point[0];
    }
    return {
      status: 'ready',
      kind: 'geomap',
      title: spec.title,
      units: '',
      series: [{ name: `${lonName} / ${latName}`, color: '#5464f8', points }],
      xLabel: 'Longitude (degrees) · Latitude (degrees)',
      xStartLabel: xMin.toFixed(5),
      xEndLabel: xMax.toFixed(5),
      rows: probe.rows,
      columns: 2,
      file: probe.name,
      note: points.length < 2
        ? `只有 ${points.length} 个点（所有样本经纬度相同），所以画面是一个点、不是一条轨迹。`
        : '',
    };
  }

  async function buildChart(spec) {
    if (!state.files.some((file) => file.name === spec.file)) {
      return { status: 'empty', reason: `导出目录里没有 ${spec.file}` };
    }
    const probe = await fetchData(spec.file);
    if (spec.kind === 'category') return categoryModel(spec, probe);
    if (spec.kind === 'geomap') return geomapModel(spec, probe);

    // One series per row, named by the row's first cell — what `Receiver Status` needs, because its
    // CSV is a list of conditions rather than a time series.
    if (spec.rowsAsSeries) {
      const rows = (probe.table && probe.table.rows) || [];
      if (!rows.length) return { status: 'empty', reason: `${probe.name} 没有数据行` };
      if (probe.rows > rows.length) {
        return {
          status: 'empty',
          reason: `这张图要逐行取条件名，但 /api/graph/data 只给前 ${rows.length} 行（共 ${probe.rows} 行）`,
        };
      }
      const series = [];
      rows.forEach((row, index) => {
        const value = Number(row[row.length - 1]);
        if (!Number.isFinite(value)) return;
        series.push({
          name: row[0],
          color: colourFor(row[0], index),
          columnIndex: index,
          points: [[index, value]],
        });
      });
      if (!series.length) return { status: 'empty', reason: `${probe.name} 的 value 列读不出数字` };
      return {
        status: 'ready',
        kind: spec.kind || 'bar',
        title: spec.title,
        units: spec.units || '',
        series,
        xLabel: '行序号',
        xKind: 'index',
        xStartLabel: '#1',
        xEndLabel: `#${rows.length}`,
        rows: probe.rows,
        columns: 1,
        file: probe.name,
        table: spec.intervalTable && probe.table ? probe.table : null,
        note: '这张 CSV 的表结构是「条件 → 区间」（name,start,end,value），没有时间列，'
          + '所以横轴是行序号、纵轴是 value；每个条件的 start/end 见下表。',
      };
    }

    const names = spec.columns && spec.columns.length
      ? spec.columns.slice()
      : probe.numericColumns.map((column) => column.name);
    if (!names.length) {
      return {
        status: 'empty',
        reason: `${spec.file} 没有数值列，只能看表格（Legend → 前 20 行）`,
      };
    }
    const payloads = await mapLimit(names, 10, (name) => fetchData(spec.file, name).catch(() => null));
    const series = [];
    for (let index = 0; index < names.length; index += 1) {
      const payload = payloads[index];
      if (!payload || !payload.series || !payload.series.points.length) continue;
      series.push({
        name: names[index],
        color: colourFor(names[index], index),
        columnIndex: index,
        points: payload.series.points,
      });
    }
    if (!series.length) return { status: 'empty', reason: `${spec.file} 的数值列都读不到` };
    const first = payloads.find((payload) => payload && payload.series);
    const notes = [];
    if (spec.intervalTable) notes.push('这张 CSV 的表结构是「条件 → 区间」（name,start,end,value），没有时间列。');
    if (probe.rows < 2) {
      notes.push(`只有 1 行样本（这份 CSV 只回了一次报文），每列只有一个点，连不成线，但数是真的。`);
    }
    return {
      status: 'ready',
      kind: spec.kind,
      title: spec.title,
      units: spec.units || '',
      minYZero: Boolean(spec.minYZero),
      series,
      xLabel: first.series.xLabel,
      xKind: first.series.xKind,
      xStartLabel: first.series.xStartLabel,
      xEndLabel: first.series.xEndLabel,
      rows: probe.rows,
      columns: names.length,
      file: probe.name,
      table: spec.intervalTable && probe.table ? probe.table : null,
      note: notes.join(' '),
    };
  }

  /* ---- tiles ---- */

  function tileHead(model) {
    const units = model.units ? `<span class="gp-chart-units">${esc(model.units)}</span>` : '';
    const facts = [model.file];
    if (model.columns > 1) facts.push(`${model.columns} 列`);
    facts.push(`${model.rows} 行`);
    return '<div class="gp-chart-card-head">'
      + `<h3 class="gp-chart-title">${esc(model.title)}${units}</h3>`
      + `<p class="gp-chart-meta">${esc(facts.join(' · '))}</p>`
      + '</div>';
  }

  /** >8 series get constellation sub-heads, the way the original's legend groups them. */
  function groupChips(series) {
    if (series.length <= 8) return [{ label: '', items: series }];
    const order = [];
    const buckets = new Map();
    for (const item of series) {
      const key = constellationOf(item.name);
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key).push(item);
    }
    order.sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
    return order.map((key) => ({ label: key, items: buckets.get(key) }));
  }

  function chipRow(key, model, hiddenNames) {
    const parts = [];
    for (const group of groupChips(model.series)) {
      if (group.label) parts.push(`<span class="gp-chip-group">${esc(group.label)}</span>`);
      for (const item of group.items) {
        const off = hiddenNames.has(item.name);
        parts.push(
          `<button type="button" class="gp-chip" data-chip="${esc(key)}" data-chip-name="${esc(item.name)}" `
          + `aria-pressed="${off ? 'false' : 'true'}" style="--gp-chip-color:${esc(item.color)}">`
          + '<span class="gp-chip-box"></span>'
          + `<span class="gp-chip-text">${esc(item.name)}</span></button>`,
        );
      }
    }
    return `<div class="gp-chips">${parts.join('')}</div>`;
  }

  function intervalTableMarkup(model) {
    const columns = (model.table && model.table.columns) || [];
    const rows = (model.table && model.table.rows) || [];
    if (!rows.length) return '';
    return '<div class="gp-chart-table"><table><thead><tr>'
      + columns.map((column) => `<th>${esc(column)}</th>`).join('')
      + '</tr></thead><tbody>'
      + rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')
      + '</tbody></table></div>';
  }

  function paintCard(key) {
    const card = root.querySelector(`[data-chart="${key}"]`);
    if (!card) return;
    const entry = state.models.get(key);
    if (!entry) return;

    if (entry.status === 'loading') {
      card.innerHTML = `<div class="gp-chart-card-head"><h3 class="gp-chart-title">${esc(entry.spec.title)}</h3>`
        + `<p class="gp-chart-meta">${esc(entry.spec.file)}</p></div>`
        + '<div class="gp-chart-empty">正在通过 /api/graph/data 读取…</div>';
      return;
    }
    if (entry.status !== 'ready' || !entry.model) {
      card.innerHTML = `<div class="gp-chart-card-head"><h3 class="gp-chart-title">${esc(entry.spec.title)}</h3>`
        + `<p class="gp-chart-meta">${esc(entry.spec.file)}</p></div>`
        + `<div class="gp-chart-empty"><strong>--</strong> ${esc(entry.reason || '没有数据')}</div>`;
      return;
    }

    const model = entry.model;
    const hiddenNames = new Set();
    for (const item of model.series) if (state.chipOff.has(`${key}##${item.name}`)) hiddenNames.add(item.name);
    const view = { ...model, series: model.series.map((item) => ({ ...item, hidden: hiddenNames.has(item.name) })) };

    card.innerHTML = tileHead(model)
      + '<div class="gp-chart-box"></div>'
      + chipRow(key, model, hiddenNames)
      + (model.note ? `<p class="gp-chart-note">${esc(model.note)}</p>` : '')
      + (model.table ? intervalTableMarkup(model) : '');

    const box = card.querySelector('.gp-chart-box');
    if (!box) return;
    const width = Math.round(box.getBoundingClientRect().width);
    if (width < 120) {
      box.innerHTML = '<div class="gp-chart-empty">等待布局…</div>';
      return;
    }
    const height = Math.round(box.getBoundingClientRect().height) || 240;
    box.innerHTML = chartSvgFor(view, width, height);
  }

  function paintFoot(tabId) {
    const foot = root.querySelector(`[data-foot="${tabId}"]`);
    if (!foot) return;
    const group = CHART_GROUPS.find((item) => item.id === tabId);
    if (!group) {
      foot.textContent = '';
      return;
    }
    if (!state.files.length) {
      foot.textContent = '没有读到 /api/graph/files，无法确认哪些 CSV 存在。';
      return;
    }
    const drawn = new Set(group.charts.map((chart) => chart.title));
    const missing = group.catalog.filter((title) => !drawn.has(title));
    foot.textContent = missing.length
      ? `附录 C 的图表目录里 ${group.label} 有 ${group.catalog.length} 张图，`
        + `${state.directory || '导出目录'} 里只有 ${group.charts.length} 张的 CSV；`
        + `${missing.join(' / ')} 没有对应文件，所以这里不画（也不拿别的列顶替）。`
      : `附录 C 的图表目录里 ${group.label} 的 ${group.catalog.length} 张图都有 CSV，全部画出来了。`;
  }

  function paintTab(tabId) {
    if (!state.alive || tabId === 'overview') return;
    if (tabId === 'project') {
      renderProject();
      return;
    }
    for (const spec of chartsOf(tabId)) paintCard(`${tabId}/${spec.id}`);
  }

  function ensureTab(tabId) {
    if (tabId === 'overview') return;
    if (state.started.has(tabId)) {
      if (tabId === 'project') renderProject();
      return;
    }
    if (!state.files.length && !state.filesLoaded) {
      state.deferredTab = tabId;
      return;
    }
    state.started.add(tabId);
    if (tabId === 'project') {
      renderProject();
      return;
    }
    for (const spec of chartsOf(tabId)) {
      const key = `${tabId}/${spec.id}`;
      state.models.set(key, { status: 'loading', spec, key });
      paintCard(key);
      void (async () => {
        try {
          const result = await buildChart(spec);
          if (!state.alive) return;
          state.models.set(key, {
            spec,
            key,
            status: result.status,
            model: result.status === 'ready' ? result : null,
            reason: result.reason || '',
          });
        } catch (error) {
          state.models.set(key, { spec, key, status: 'empty', reason: `读取失败：${error.message}` });
        }
        paintCard(key);
      })();
    }
    paintFoot(tabId);
  }

  function renderProject() {
    const card = root.querySelector('[data-chart="project/info"]');
    if (!card) return;
    const data = state.data;
    const comments = (data && data.comments) || {};
    const rows = [
      ['Project Name', comments.projectName],
      ['Project Directory', comments.projectDirectory],
      ['Data File Name', comments.dataFileName],
      ['Start Time (GPS)', comments.startTime],
      ['End Time (GPS)', comments.endTime],
      ['Duration', comments.duration],
      ['Start Time (UTC)', gpsIsoLabel(comments.startTime)],
    ];
    const facts = rows
      .map(([label, value]) => '<div class="gp-info-row">'
        + `<span class="gp-info-label">${esc(label)}</span>`
        + `<span class="gp-info-value">${esc(value || '--')}</span></div>`)
      .join('');

    const files = state.files.length
      ? '<div class="gp-chart-table"><table><thead><tr><th>CSV</th><th>行</th><th>列</th><th>大小</th></tr></thead><tbody>'
        + state.files.map((file) => '<tr>'
          + `<td>${esc(file.name)}</td><td>${file.rows}</td><td>${file.columns}</td>`
          + `<td>${esc(bytesText(file.bytes))}</td></tr>`).join('')
        + '</tbody></table></div>'
      : '<p class="gp-chart-note">-- 没有读到 /api/graph/files。</p>';

    card.innerHTML = '<h3 class="gp-chart-title">Project Information</h3>'
      + '<p class="gp-chart-meta">六项取自当前 CSV 的注释头（每个工程的所有导出都带同一份）</p>'
      + `<div class="gp-info-list">${facts}</div>`
      + '<h4 class="gp-info-sub">Message Summary</h4>'
      + '<p class="gp-chart-note"><strong>--</strong> 数据层只暴露 CSV；报文名与条数在工程的 '
      + 'DataSummary.json 里，不在 /api/graph/* 的返回里，所以这里不填数字。</p>'
      + `<h4 class="gp-info-sub">数据源（/api/graph/files，${esc(state.directory || '导出目录')}）</h4>`
      + files;
  }

  /* ---- data ---- */

  function renderCards() {
    if (!el.cards) return;
    if (!state.project) {
      el.cards.innerHTML = '';
      el.homeStatus.textContent = '正在读取 /api/graph/files…';
      return;
    }
    const rows = state.files.length;
    el.cards.innerHTML = `
      <button type="button" class="gp-card" role="listitem" data-project="${esc(state.project)}">
        <span class="gp-card-logo">${ICON_LAYERS}</span>
        <span class="gp-card-text">
          <span class="gp-card-date">${esc(state.date || '—')}</span>
          <span class="gp-card-name">${esc(state.project)}</span>
        </span>
      </button>`;
    el.homeStatus.textContent = `${state.project} · ${rows} 份 CSV · ${state.directory}`;
  }

  function fillFileSelect() {
    if (!el.fileSelect) return;
    if (!state.files.length) {
      el.fileSelect.innerHTML = '<option value="">（没有 CSV）</option>';
      return;
    }
    el.fileSelect.innerHTML = state.files
      .map(
        (file) =>
          `<option value="${esc(file.name)}">${esc(file.name)} · ${file.rows} 行 / ${file.columns} 列 · ${bytesText(file.bytes)}</option>`,
      )
      .join('');
    el.fileSelect.value = state.file || state.files[0].name;
  }

  function fillPicker() {
    if (!el.pickerList) return;
    if (!state.files.length) {
      el.pickerList.innerHTML = '<p class="gp-picker-empty">没有可用的 CSV。</p>';
      return;
    }
    el.pickerList.innerHTML = state.files
      .map(
        (file) =>
          `<button type="button" class="gp-picker-row" role="listitem" data-file="${esc(file.name)}">`
          + `<span class="gp-picker-name">${esc(file.name)}</span>`
          + `<span class="gp-picker-meta">${file.rows} 行 · ${file.columns} 列 · ${bytesText(file.bytes)}</span>`
          + '<span class="gp-picker-open">打开</span></button>',
      )
      .join('');
  }

  function showPicker(which) {
    if (!el.picker) return;
    el.picker.hidden = false;
    el.pickerTitle.textContent = which === 'new' ? 'New Project' : 'Open Project';
    el.pickerHint.textContent = which === 'new'
      ? '本构建没有 Graph 的工程引擎（.gpf 解析与录制）。新建工程的落地方式就是挑一份 Graph 导出的 CSV。'
      : '列出 /api/graph/files 里的 CSV（samples/graph/ 下的导出批次），选一份进入工作区。';
    fillPicker();
  }

  /** Files are what tell a tile whether its CSV exists, so a tab opened before this returns waits here. */
  function resumeDeferred() {
    state.filesLoaded = true;
    const tab = state.deferredTab;
    state.deferredTab = '';
    if (tab) ensureTab(tab);
  }

  async function loadFiles() {
    try {
      const body = await api.get('/graph/files');
      state.files = body.files || [];
      state.directory = body.directory || '';
      fillFileSelect();
      const preferred = state.files.find((file) => file.name === PREFERRED_CSV) || state.files[0];
      if (preferred) {
        await loadFile(preferred.name);
      } else {
        renderCards();
        el.homeStatus.textContent = `未在 ${state.directory || 'samples/graph'} 下找到 CSV。`;
      }
      resumeDeferred();
    } catch (error) {
      renderCards();
      el.homeStatus.textContent = `读取 CSV 列表失败：${error.message}`;
      showNotice(`读取 CSV 列表失败：${error.message}`);
      resumeDeferred();
    }
  }

  async function loadFile(name, column) {
    if (!name) return;
    showNotice('');
    try {
      const data = await api.get('/graph/data', column ? { file: name, column } : { file: name });
      state.data = data;
      state.file = data.name;
      state.column = data.column || '';
      state.project = projectNameOf(data, state.directory);
      state.date = gpsDateLabel(data.comments && data.comments.startTime);
      state.span = Number(data.series && data.series.spanSeconds) || 0;
      if (!state.span && data.series && data.series.points.length > 1) {
        state.span = data.series.points[data.series.points.length - 1][0];
      }
      state.duration = parseDuration(data.comments && data.comments.duration) || state.span;
      state.current = Math.min(state.current, state.span);
      renderCards();
      renderData();
      drawChart();
      updateTimeline();
    } catch (error) {
      showNotice(`读取 CSV 失败：${error.message}`);
    }
  }

  function renderData() {
    const data = state.data;
    if (!data) return;
    const comments = data.comments || {};
    const facts = [
      comments.projectName ? `工程 ${comments.projectName}` : '',
      comments.dataFileName ? `数据 ${comments.dataFileName}` : '',
      comments.startTime ? `GPS ${comments.startTime} – ${comments.endTime || '?'}` : '',
      comments.duration ? `时长 ${comments.duration}` : '',
      `${data.rows} 行 · ${data.columns.length} 列`,
    ].filter(Boolean);
    if (el.meta) el.meta.textContent = facts.join(' · ');

    if (el.fileSelect) el.fileSelect.value = data.name;
    if (el.columnSelect) {
      if (data.numericColumns.length) {
        el.columnSelect.innerHTML = data.numericColumns
          .map((column) => `<option value="${esc(column.name)}">${esc(column.name)}</option>`)
          .join('');
        el.columnSelect.value = data.column;
        el.columnSelect.disabled = false;
      } else {
        el.columnSelect.innerHTML = '<option value="">（无数值列）</option>';
        el.columnSelect.disabled = true;
      }
    }

    if (el.legendSeries) {
      el.legendSeries.innerHTML = data.series.points.length
        ? `<span class="gp-swatch" style="background:${esc(colourFor(data.column, 0))}"></span>`
          + `<span class="gp-series-name">${esc(data.column)}</span>`
          + `<span class="gp-series-count">${data.series.points.length} 点</span>`
        : '<span class="gp-series-name">（无数值列）</span>';
    }

    if (el.tableHead) {
      el.tableHead.innerHTML = data.table.columns.map((column) => `<th>${esc(column)}</th>`).join('');
    }
    if (el.tableBody) {
      el.tableBody.innerHTML = data.table.rows.length
        ? data.table.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
          .join('')
        : `<tr class="gp-empty-row"><td colspan="${Math.max(data.table.columns.length, 1)}">没有数据行</td></tr>`;
    }
    if (el.tableNote) {
      el.tableNote.textContent = `显示前 ${data.table.rows.length} / ${data.rows} 行`
        + (data.tableTruncated ? '（其余请在 CSV 中查看）' : '（全部）');
    }
  }

  /* ---- timeline ---- */

  function updateTimeline() {
    const data = state.data;
    const comments = (data && data.comments) || {};
    if (el.startTime) el.startTime.textContent = comments.startTime || (data ? data.series.xStartLabel : '—') || '—';
    if (el.endTime) el.endTime.textContent = comments.endTime || (data ? data.series.xEndLabel : '—') || '—';
    if (el.clock) el.clock.textContent = `${hhmmss(state.current)}|${hhmmss(state.duration || state.span)}`;
    if (el.playButton) {
      el.playButton.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
      el.playButton.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    }
    updatePlayhead();
  }

  function stopPlayback() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.last = 0;
    updateTimeline();
  }

  function tick(now) {
    if (!state.playing || !state.alive) return;
    if (!state.last) state.last = now;
    const delta = (now - state.last) / 1000;
    state.last = now;
    state.current = Math.min(state.span, state.current + delta * state.speed);
    updateTimeline();
    if (state.current >= state.span) {
      stopPlayback();
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function togglePlayback() {
    if (!state.span) return;
    if (state.playing) {
      stopPlayback();
      return;
    }
    if (state.current >= state.span) state.current = 0;
    state.playing = true;
    state.last = 0;
    updateTimeline();
    state.raf = requestAnimationFrame(tick);
  }

  function seek(seconds) {
    state.current = Math.min(state.span, Math.max(0, seconds));
    updateTimeline();
  }

  /* ---- export ---- */

  function downloadBlob(text, fileName, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stemOf(name) {
    return String(name || 'graph').replace(/\.csv$/i, '');
  }

  function csvReport() {
    const data = state.data;
    if (!data) return '';
    const comments = data.comments || {};
    const lines = [
      `#Project Name:          ${data.comments.projectName || state.project}`,
      `#Data File Name:      ${data.name}`,
      `#Start Time(GPS):      ${comments.startTime || ''}`,
      `#End Time(GPS):        ${comments.endTime || ''}`,
      `#Duration:                   ${comments.duration || hhmmss(state.span)}`,
      `#Column:              ${data.column || ''}`,
      'elapsed seconds,value',
    ];
    for (const [x, y] of data.series.points) lines.push(`${x.toFixed(3)},${y}`);
    return lines.join('\r\n');
  }

  function htmlReport() {
    const data = state.data;
    if (!data) return '';
    const comments = data.comments || {};
    const svg = el.chart ? el.chart.querySelector('svg') : null;
    const svgMarkup = svg ? svg.outerHTML : '<p>（没有可绘制的数值列）</p>';
    const head = data.table.columns.map((column) => `<th>${esc(column)}</th>`).join('');
    const body = data.table.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
      .join('');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Graph · ${esc(data.name)}</title>
<style>
body{font-family:"Open Sans","Segoe UI",sans-serif;color:rgba(0,0,0,.87);margin:32px 40px}
h1{font-size:22px;color:#00516f;margin:0 0 6px}
p.meta{font-size:12px;color:rgba(0,0,0,.6);margin:0 0 18px}
svg{width:100%;height:auto;border:1px solid rgba(0,0,0,.12)}
table{border-collapse:collapse;font-size:12px;margin-top:18px}
th,td{border:1px solid rgba(0,0,0,.12);padding:4px 8px;text-align:left;font-family:Consolas,monospace}
th{background:#f4f8fa;color:#00516f}
</style></head><body>
<h1>Graph · ${esc(data.name)}</h1>
<p class="meta">${esc([
      comments.projectName ? `工程 ${comments.projectName}` : '',
      comments.dataFileName ? `数据 ${comments.dataFileName}` : '',
      comments.startTime ? `GPS ${comments.startTime} – ${comments.endTime || '?'}` : '',
      comments.duration ? `时长 ${comments.duration}` : '',
      `${data.rows} 行 · ${data.columns.length} 列`,
      `绘图列 ${data.column || '—'}`,
      gpsIsoLabel(comments.startTime),
    ].filter(Boolean).join(' · '))}</p>
${svgMarkup}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
  }

  /** PDF via the browser's print engine — no PDF library in this repo, and this keeps it honest. */
  function printReport() {
    const html = htmlReport();
    if (!html) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'Graph PDF');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = html;
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (error) {
        showNotice(`PDF 打印失败：${error.message}`);
      }
    });
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 60000);
  }

  /** KML is the suite's trajectory export; here it is the existing Convert KML endpoint. */
  async function exportKml() {
    const capture = typeof panel.getCapture === 'function' ? panel.getCapture() : panel.capture;
    if (!capture) {
      showNotice('导出 KML 需要先在上方「抓包」下拉里选一个抓包。');
      return;
    }
    try {
      const body = await api.post('/convert', { capture, format: 'KML' });
      const url = body.downloadUrl || '';
      if (!url) throw new Error('服务端没有返回下载链接');
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = body.fileName || 'graph.kml';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      showNotice('');
    } catch (error) {
      showNotice(`导出 KML 失败：${error.message}`);
    }
  }

  function exportAs(kind) {
    closeExport();
    if (!state.data) {
      showNotice('还没有载入 CSV，无法导出。');
      return;
    }
    const stem = stemOf(state.data.name);
    if (kind === 'csv') downloadBlob(csvReport(), `${stem}.csv`, 'text/csv;charset=utf-8');
    else if (kind === 'html') downloadBlob(htmlReport(), `${stem}.html`, 'text/html;charset=utf-8');
    else if (kind === 'pdf') printReport();
    else if (kind === 'kml') void exportKml();
  }

  /* ---- wiring ---- */

  function onRootClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const worktab = target.closest('[data-worktab]');
    if (worktab) {
      setTab(worktab.dataset.worktab);
      return;
    }

    const chip = target.closest('[data-chip]');
    if (chip) {
      const key = chip.dataset.chip;
      const id = `${key}##${chip.dataset.chipName || ''}`;
      if (state.chipOff.has(id)) state.chipOff.delete(id);
      else state.chipOff.add(id);
      paintCard(key);
      return;
    }

    const exportItem = target.closest('[data-export]');
    if (exportItem) {
      exportAs(exportItem.dataset.export);
      return;
    }

    const card = target.closest('[data-project]');
    if (card) {
      setView('work');
      setTab('overview');
      return;
    }

    const pick = target.closest('[data-file]');
    if (pick) {
      el.picker.hidden = true;
      setView('work');
      setTab('overview');
      void loadFile(pick.dataset.file);
      return;
    }

    const action = target.closest('[data-act]');
    if (action) {
      const act = action.dataset.act;
      if (act === 'new' || act === 'open') showPicker(act);
      else if (act === 'picker-close') el.picker.hidden = true;
      else if (act === 'legend') setLegend(!state.legendOpen);
      else if (act === 'export') {
        if (el.exportMenu.hidden) openExport();
        else closeExport();
      } else if (act === 'refresh') void loadFiles();
      else if (act === 'play') togglePlayback();
      else if (act === 'rewind') {
        stopPlayback();
        seek(0);
      } else if (act === 'forward') {
        stopPlayback();
        seek(state.span);
      } else if (act === 'events') {
        state.showEvents = !state.showEvents;
        action.setAttribute('aria-checked', state.showEvents ? 'true' : 'false');
      } else if (act === 'dock') {
        setDock(state.dock !== 'open');
      } else if (act === 'map-fit' || act === 'map-recenter') {
        fitMap();
      } else if (act === 'map-zoomin') {
        zoomMap(1 / 1.6);
      } else if (act === 'map-zoomout') {
        zoomMap(1.6);
      }
      return;
    }

    if (!el.exportMenu.hidden && !target.closest('.gp-export')) closeExport();
  }

  function onFileChange() {
    void loadFile(el.fileSelect.value);
  }

  function onColumnChange() {
    void loadFile(state.file || el.fileSelect.value, el.columnSelect.value);
  }

  function onSpeedChange() {
    state.speed = Number(el.speed.value) || 1;
  }

  function onColourToggle() {
    applyColourMode(el.colourOriginal && el.colourOriginal.checked ? 'original' : 'readable');
  }

  function onDocumentClick(event) {
    if (el.exportMenu.hidden) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.gp-export')) return;
    closeExport();
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && !el.exportMenu.hidden) closeExport();
  }

  function onResize() {
    if (state.view !== 'work') return;
    renderMap();
    if (state.tab === 'overview') drawChart();
    else paintTab(state.tab);
  }

  root.addEventListener('click', onRootClick);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('message', onLuciadMessage);
  updateMapEngineUi();
  if (el.fileSelect) el.fileSelect.addEventListener('change', onFileChange);
  if (el.columnSelect) el.columnSelect.addEventListener('change', onColumnChange);
  if (el.speed) el.speed.addEventListener('change', onSpeedChange);
  if (el.colourOriginal) el.colourOriginal.addEventListener('change', onColourToggle);
  if (el.colourOriginal) el.colourOriginal.checked = state.colourMode === 'original';
  applyColourMode(state.colourMode);
  if (el.map) {
    el.map.addEventListener('pointerdown', onMapPointerDown);
    el.map.addEventListener('pointermove', onMapPointerMove);
    el.map.addEventListener('pointerup', onMapPointerUp);
    el.map.addEventListener('pointercancel', onMapPointerUp);
    el.map.addEventListener('pointerleave', clearMapHover);
    el.map.addEventListener('wheel', onMapWheel, { passive: false });
    el.map.addEventListener('dblclick', onMapDoubleClick);
  }

  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => onResize());
    observer.observe(root);
  } else {
    window.addEventListener('resize', onResize);
  }

  root.__graphCleanup = () => {
    state.alive = false;
    stopPlayback();
    root.removeEventListener('click', onRootClick);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('message', onLuciadMessage);
    if (luciad.timer) window.clearTimeout(luciad.timer);
    luciad.timer = 0;
    luciad.status = 'idle';
    if (luciad.frame) {
      try {
        luciad.frame.src = 'about:blank';
      } catch {
        /* the frame is already gone */
      }
    }
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
    if (el.fileSelect) el.fileSelect.removeEventListener('change', onFileChange);
    if (el.columnSelect) el.columnSelect.removeEventListener('change', onColumnChange);
    if (el.speed) el.speed.removeEventListener('change', onSpeedChange);
    if (el.colourOriginal) el.colourOriginal.removeEventListener('change', onColourToggle);
    if (el.map) {
      el.map.removeEventListener('pointerdown', onMapPointerDown);
      el.map.removeEventListener('pointermove', onMapPointerMove);
      el.map.removeEventListener('pointerup', onMapPointerUp);
      el.map.removeEventListener('pointercancel', onMapPointerUp);
      el.map.removeEventListener('pointerleave', clearMapHover);
      el.map.removeEventListener('wheel', onMapWheel);
      el.map.removeEventListener('dblclick', onMapDoubleClick);
    }
  };

  setView('home');
  setTab('overview');
  setLegend(false);
  setDock(true);
  updateTimeline();
  void loadFiles();
  void loadMap();
}

export function unmount(root) {
  const cleanup = root && root.__graphCleanup;
  if (typeof cleanup === 'function') cleanup();
  if (root) {
    delete root.__graphCleanup;
    root.innerHTML = '';
  }
}

export default { mount, unmount };
