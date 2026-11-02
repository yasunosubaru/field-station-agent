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
 *
 * Map Settings (manual 5.7) — Settings ▸ Map opens a sheet with the original's three sections
 * (`mapSettings.js` `.map-settings-tabs` + three `.totaldata` pages):
 *
 *   Points of Interest  a **local** list, `localStorage` key `nas.grit.map.poi.v1` — there is no
 *                       receiver-side store to read (the original keeps it in Electron's userStore)
 *                       and no `/api` route is introduced for it, so the sheet says in its own words
 *                       that the points are local. They are drawn on the same Luciad stage through
 *                       `{type:'pois'}` (marker + radius circle + name), so Show / Active / Delete
 *                       really change the map; coordinates are prefilled from the current fix.
 *   Triggers            no event source: this build does not subscribe to MARKxPOS and no receiver
 *                       is attached, so nothing can fire. The list stays empty and the tab reports
 *                       what it actually found — the MARKxPOS groups of the open capture, or that
 *                       there are none (`/api/logs`).
 *   Display             five switches → the shared stage's `chrome` flags (graticule, labels,
 *                       metric grid, scale bar, north arrow), persisted in `nas.grit.map.display.v1`
 *                       and pushed as `{type:'chrome'}` — the map repaints on every change.
 *
 * Terminal (manual 5.8) — Tools ▸ Terminal opens a drawer **inside this panel**; it no longer hands
 * off to Manage. It speaks to the same server-side live session and the same `POST /api/live/command`,
 * with its own transcript fed by the `/api/live/logs` poll this panel already runs. With no session
 * the server refuses the line and the drawer prints that refusal — never a fabricated echo.
 *
 * Mitigation Assistant (manual 5.2.5) — the value stays `Not detected`; what is added is the
 * interaction the manual documents: expand/collapse, both states described, the Interference
 * details operations, and the plain statement that entries need ITK traffic.
 *
 * Position Overview — the whole stage is the **shared LuciadRIA stage** (`web/geo/luciad-stage.html`,
 * the same iframe Graph's Overview boots; `/geo/luciad-engine.js` is the shipped Graph renderer
 * bundle). This panel only says *what to draw* and never loads the engine itself:
 *
 *   - capture    the fixes of `2D Trajectory.csv` and the 1σ of `Position SD.csv`, read through the
 *                same `/api/graph/data` the Graph panel uses; the track, its vertices, the start/end
 *                markers and the ring are drawn by Luciad, the degree labels are switched off with
 *                the stage's `profile: 'grit'` (GRIT has no Graph legend to feed them);
 *   - live       BESTPOS #42 out of `/api/live/logs`, accumulated while the link is up — the last
 *                fix is the cursor marker, the 1σ ring is the last fix's lat/lon deviation;
 *   - fallback   when the engine cannot start (no WebGPU adapter, missing `01_解包`, timeout) the
 *                stage is dropped exactly like Graph's `failLuciad()` and the tile paints
 *                `mapSvg()` — the same track as SVG — with the reason printed on the stage. No
 *                blank canvas, and nothing claims to be Luciad unless the stage said `ready`.
 *   - satellite  the **Satellite** tab is imagery, which no capture carries: it is drawn by an XYZ
 *                tile layer (Web Mercator, `/api/grit/tiles` proxy + disk cache) whose default is a
 *                public source, because the original's Google Maps key is not in this repo. Every
 *                frame of it is labelled a substitute; if the tiles cannot be had, the same `mapSvg()`
 *                graticule paints and the note says why (see `gritTileNote`).
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
 *   - **capture, text only**: this receiver writes `ITPSDFINAL`/`ITPSDDETECT` **only as ASCII**
 *     (`#ITPSDFINALA`/`#ITPSDDETECTA`, §13.3 of `03_分析/05_GRIT-Monitor.md`), so `b7-20261101.sbf`
 *     has 47 + 90 text lines and zero #1968/#2063 payloads. Such a capture is read by `name=`
 *     (the same `/api/records` endpoint, served by `readTextRecords`) and the samples are rebuilt
 *     from the `samples[i].samples` fields; the note then says `replayed from N text … record(s)`,
 *     because a recording read back is not a live sweep;
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

/* Position Overview shares Graph's map: the same engine document, the same CSV columns, the same
 * pure helpers (`mapSvg` is the fallback picture, `trajectoryPoints` pairs the two CSV columns). */
import {
  LUCIAD_READY_TIMEOUT_MS,
  LUCIAD_STAGE_URL,
  MAP_FILE,
  MAP_LAT_COLUMN,
  MAP_LON_COLUMN,
  MAP_SD_FILE,
  MAP_SD_LAT_COLUMN,
  MAP_SD_LON_COLUMN,
  MAP_TRACK_COLOR,
  formatDistance,
  mapFit,
  mapSvg,
  trackLength,
  trajectoryPoints,
} from './graph.js';
import { createStageClient, stageChrome } from '../geo/luciad-panel.js';

const CSS_URL = new URL('./grit.css', import.meta.url).href;
const CSS_ID = 'nas-panel-grit-css';

/** BESTPOS fixes the live track keeps — ten minutes at the default 1 Hz. */
const TRACK_POINTS = 600;

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

/* ---- Map Settings (manual 5.7) ----
 *
 * The POI list and the Display switches are **this panel's own state**: they are written to
 * `localStorage` under one key each, because there is no receiver-side store to write (the original
 * keeps `userStore.userStoreJSON.app.poi[tabid]`, an Electron main-process file) and no server route
 * is introduced for it. Triggers have no store at all: nothing in this build subscribes to an event
 * stream, so the tab reports the source it looked for and why the list is empty.
 */
const POI_STORE_KEY = 'nas.grit.map.poi.v1';
const DISPLAY_STORE_KEY = 'nas.grit.map.display.v1';
/** The original's Add-POI dialog caps the name at 16 characters (`addPOIDialog.js` maxlength). */
const POI_NAME_MAX = 16;
/** A local list, not a database: the sheet stays responsive and localStorage stays small. */
const POI_LIMIT = 200;
/** Entries the GRIT Terminal asks for when it opens (same slice `manage.js` uses). */
const TERMINAL_BACKFILL = 150;
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
 * Signal type → band. `c_status` bits 21..25 carry the signal type (OEM7 Commands & Logs, Table 182),
 * and bits 16..18 the constellation. `sv_freq` cannot be used for this: the manual says that field is
 * zero "for all signals except for GLONASS signals and QZSS L1C/B", which is exactly what b7 shows
 * (3 243 observations with `sv_freq` 0 and 47 with 203 — QZSS L1C/B).
 *
 * Only types listed here get a cell; an unknown type is left out rather than guessed into L1.
 */
const SIGNAL_BANDS = {
  0: { 0: 'L1', 5: 'L2', 9: 'L2', 14: 'L5', 16: 'L1', 17: 'L2' }, // GPS
  1: { 0: 'L1', 1: 'L2', 5: 'L2', 6: 'L3' }, // GLONASS
  2: { 0: 'L1', 6: 'L5' }, // SBAS
  3: { 2: 'L1', 6: 'L6', 7: 'L6', 12: 'L5', 17: 'L2', 20: 'L5' }, // Galileo
  4: { 0: 'L1', 1: 'L2', 2: 'L3', 4: 'L1', 5: 'L2', 6: 'L3', 7: 'L1', 9: 'L5', 11: 'L2' }, // BeiDou
  5: { 0: 'L1', 14: 'L5', 16: 'L1', 17: 'L2', 24: 'L1', 27: 'L6', 28: 'L6' }, // QZSS
  6: { 0: 'L5' }, // NavIC
  7: { 19: 'LBAND' }, // Other (L-band)
};

/** Signal Matrix rows, in the original's DOM order (`signalMatrix.js:4`). */
const MATRIX_ROWS = [
  { key: 'gps', label: 'GPS', system: 0 },
  { key: 'glo', label: 'GLO', system: 1 },
  { key: 'gal', label: 'GAL', system: 3 },
  { key: 'bds', label: 'BDS', system: 4 },
  { key: 'qzss', label: 'QZSS', system: 5 },
  { key: 'navic', label: 'NAVIC', system: 6 },
  { key: 'lband', label: 'LBAND', system: 7 },
];

/** Band columns in the original's order (`signalMatrix.js:4`). Only the ones present are drawn. */
const MATRIX_BAND_ORDER = ['L5', 'L2', 'L3', 'L6', 'L1', 'LBAND'];

/** Constellation bits → the row that owns them (SBAS has no row of its own in the original). */
const SYSTEM_ROW = { 0: 'gps', 1: 'glo', 3: 'gal', 4: 'bds', 5: 'qzss', 6: 'navic', 7: 'lband' };

/** The band a RANGE observation belongs to, or `undefined` when its signal type is not in the table. */
function observationBand(status) {
  const system = (Number(status) >>> 16) & 7;
  const type = (Number(status) >>> 21) & 0x1f;
  return { system, band: SIGNAL_BANDS[system]?.[type] };
}

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

function matrixCells(bands) {
  return bands.map(
    (band) => `<span class="grit-cell" data-cell="${band}"></span>`,
  ).join('');
}

function matrixTiles() {
  return MATRIX_ROWS.map(
    (row) =>
      `<div class="grit-matrix-row" data-row="${row.key}">` +
      `<span class="grit-matrix-name">${esc(row.label)}</span>` +
      `<span class="grit-matrix-cells">${matrixCells(['L5', 'L2', 'L1'])}</span>` +
      '</div>',
  ).join('');
}

/** Bands that carry at least one signal in this capture, in the original's column order. */
function visibleBands(state) {
  const counts = state.matrix?.counts;
  if (!counts) return [];
  const present = new Set();
  for (const row of counts.values()) {
    for (const [band, signals] of Object.entries(row)) {
      if (signals.size) present.add(band);
    }
  }
  return MATRIX_BAND_ORDER.filter((band) => present.has(band));
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

/** The panel's markup. Exported so a test can call it: a stray backtick in this literal is a
 * ReferenceError at mount time, which no unit test would otherwise see until the browser. */
export function template() {
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
          <button type="button" class="grit-mitigation-toggle" data-el="mitToggle"
                  aria-expanded="false" aria-controls="gritMitDetails">
            <span class="grit-mitigation-caret">${ICON.caret}</span><span data-el="mitToggleLabel">Details</span>
          </button>
          <!-- Manual 5.2.5: the window is a list of detected interference signals; with none detected
               it shows Not detected. Both states are described here instead of printing a number
               this build has no source for. -->
          <div class="grit-mitigation-details" id="gritMitDetails" data-el="mitDetails" hidden>
            <p class="grit-mitigation-line"><strong>Not detected</strong> — 抓包里没有 ITK 报文（干扰判定），
              也没有实时接收机，因此这里不显示任何干扰条目或数值。</p>
            <p class="grit-mitigation-line">手册 5.2.5：检测到干扰（干扰 / 压制 / 欺骗）时，本窗口列出
              每一项及简要说明；点击某一项进入 Interference details —— 查看详情、<em>Add filter</em>
              添加滤波器、上一条 / 下一条、返回列表。</p>
            <p class="grit-mitigation-line grit-mitigation-when">需要 ITK 报文：接收机的干扰监测通道上报
              ITK（或重放带 ITK 的 GRIT 录制文件）后，才可能在这里出现条目。</p>
            <p class="grit-mitigation-line grit-mitigation-off">Add filter — 不可用：需要先有干扰条目。</p>
          </div>
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
          <div class="grit-pos-map" data-el="posMap" hidden></div>
          <div class="grit-pos-tiles" data-el="posTiles" hidden></div>
          <div class="grit-pos-overlay" data-el="posOverlay" hidden></div>
          <iframe class="grit-pos-frame" data-el="posFrame" title="LuciadRIA 地图（原版 Graph 引擎）"
                  src="about:blank" hidden></iframe>
          <p class="grit-pos-credit" data-el="posCredit" hidden></p>
          <p class="grit-pos-note" data-el="posNote" hidden></p>
          <p class="grit-pos-foot" data-el="posFoot" hidden></p>
        </div>
      </section>
    </div>
  </div>

  <!-- ============================================================================================
       Map Settings （手册 5.7）：Points of Interest / Triggers / Display。
       原版是一个带三个 page tab 的设置窗（mapSettings.js 的 .map-settings-tabs + .totaldata），
       这里保留同样的三段与字段；数据来源在每一段里写明。
       ============================================================================================ -->
  <div class="grit-sheet" data-el="mapSheet" hidden>
    <div class="grit-sheet-card" role="dialog" aria-label="Map Settings">
      <div class="grit-sheet-head">
        <span class="grit-sheet-title">Map Settings</span>
        <span class="grit-sheet-sub">Settings ▸ Map · 手册 5.7</span>
        <button type="button" class="grit-sheet-close" data-el="mapClose" aria-label="Close Map Settings">×</button>
      </div>
      <div class="grit-sheet-tabs" role="tablist" aria-label="Map settings sections">
        <button type="button" class="grit-sheet-tab is-active" role="tab" aria-selected="true"
                data-map-tab="poi">Points of Interest</button>
        <button type="button" class="grit-sheet-tab" role="tab" aria-selected="false"
                data-map-tab="triggers">Triggers</button>
        <button type="button" class="grit-sheet-tab" role="tab" aria-selected="false"
                data-map-tab="display">Display</button>
      </div>

      <!-- ---- 5.7.1 Points of Interest ---- -->
      <section class="grit-sheet-body" data-map-panel="poi" role="tabpanel">
        <p class="grit-sheet-note" data-el="poiSource">POI 为本地列表，不来自接收机：保存在本机浏览器
          localStorage（<code>nas.grit.map.poi.v1</code>）。本 build 没有接收机侧的 POI 存储（原版写在
          Electron 的 userStore 里），也没有 /api 路由可用。</p>
        <form class="grit-poi-form" data-el="poiForm">
          <label class="grit-poi-field"><span>Name</span>
            <input class="grit-poi-input" data-poi-field="name" maxlength="16" placeholder="Gate 3" spellcheck="false"></label>
          <label class="grit-poi-field"><span>Latitude</span>
            <input class="grit-poi-input" data-poi-field="lat" type="number" step="0.000001" placeholder="30.539975"></label>
          <label class="grit-poi-field"><span>Longitude</span>
            <input class="grit-poi-input" data-poi-field="lon" type="number" step="0.000001" placeholder="114.352811"></label>
          <label class="grit-poi-field"><span>Radius (m)</span>
            <input class="grit-poi-input" data-poi-field="radius" type="number" min="0" step="1" value="0"></label>
          <label class="grit-poi-field"><span>Notification</span>
            <select class="grit-poi-input" data-poi-field="notification">
              ${POI_NOTIFICATIONS.map((item) => `<option value="${item.key}">${item.label}</option>`).join('')}
            </select></label>
          <button type="submit" class="grit-pop-btn">Add point</button>
        </form>
        <p class="grit-sheet-msg" data-el="poiMsg" hidden></p>
        <div class="grit-poi-table">
          <div class="grit-poi-row is-head">
            <span class="grit-poi-cell grit-poi-cell-name">Name</span>
            <span class="grit-poi-cell grit-poi-cell-sym">Symbol</span>
            <span class="grit-poi-cell">Radius</span>
            <span class="grit-poi-cell">Latitude</span>
            <span class="grit-poi-cell">Longitude</span>
            <span class="grit-poi-cell">Notification</span>
            <span class="grit-poi-cell">Visibility</span>
            <span class="grit-poi-cell">Status</span>
            <span class="grit-poi-cell">Triggered by</span>
            <span class="grit-cell grit-poi-cell-act"></span>
          </div>
          <div class="grit-poi-rows" data-el="poiRows"></div>
        </div>
        <p class="grit-sheet-note">Visibility / Status 直接改共享地图舞台上的 POI 图层（显示或隐藏、激活或灰色），
          Radius 不为 0 时按手册画成圆；勾选与删除只影响本机列表。</p>
      </section>

      <!-- ---- 5.7.2 Triggers ---- -->
      <section class="grit-sheet-body" data-map-panel="triggers" role="tabpanel" hidden>
        <div class="grit-poi-row is-head is-trig">
          <span class="grit-poi-cell grit-poi-cell-name">Event</span>
          <span class="grit-poi-cell grit-poi-cell-name">Point Name</span>
          <span class="grit-poi-cell">Active</span>
        </div>
        <div class="grit-poi-rows" data-el="trigRows"></div>
        <p class="grit-sheet-msg" data-el="trigSource"></p>
        <p class="grit-sheet-note">手册 5.7.2：触发器在接收机收到 EVENT 输入时，往 Position Overview 地图上
          加一个图标（先决条件是接收机上配好 MARKxPOS）。本 build 不订阅事件流、也不写接收机，所以这里既没有
          Add、也没有 Apply —— 列表如实为空，只报告本抓包里的事件日志。</p>
      </section>

      <!-- ---- 5.7.3 Display ---- -->
      <section class="grit-sheet-body" data-map-panel="display" role="tabpanel" hidden>
        <p class="grit-sheet-note">Display 开关改的是共享地图舞台的 <code>chrome</code> 参数
          （<code>/geo/luciad-stage.js</code>，<code>{type:'chrome'}</code> 消息），所以开关一改，Position
          Overview 的地图会立刻重画；GRAPH 面板用的是同一个舞台，不受这里影响。</p>
        <div class="grit-disp" data-el="displayRows"></div>
        <p class="grit-sheet-note grit-disp-state" data-el="dispState"></p>
        <div class="grit-sheet-actions">
          <button type="button" class="grit-pop-btn is-ghost" data-el="dispReset">Reset to GRIT defaults</button>
        </div>

        <div class="grit-tile-settings">
          <p class="grit-sheet-note"><strong>Base Map · 影像瓦片</strong> —— Satellite 页签的底图。原版
            GRIT 的地图是 <strong>Google Maps</strong>（<code>setUpMonitor.html</code> 注入
            <code>maps.googleapis.com/maps/api/js?key=…</code>，key 来自安装目录的
            <code>configurationfile.node</code>，见 <code>03_分析/05_GRIT-Monitor.md</code> §2.3）。
            本构建没有那把 key，也不该复用别人的瓦片，所以这里用<strong>可配置的 XYZ 公开源替代</strong>：
            默认 Esri World Imagery，署名印在地图右上角，<strong>不是原版同源</strong>。瓦片经
            <code>/api/grit/tiles/{z}/{x}/{y}</code> 代理并缓存在本机磁盘；断网时先吃缓存，缓存没有
            就回退矢量网格。key 只放服务端 <code>GRIT_TILE_URL</code> / <code>GRIT_TILE_KEY</code>，
            不写进仓库。</p>
          <div class="grit-tile-form">
            <label class="grit-poi-field grit-tile-field"><span>Tile URL</span>
              <input class="grit-poi-input" data-el="tileInput" spellcheck="false"
                     placeholder="留空 = 服务端 GRIT_TILE_URL / 默认公开源；off = 关闭影像"></label>
            <button type="button" class="grit-pop-btn" data-el="tileApply">Apply</button>
            <button type="button" class="grit-pop-btn is-ghost" data-el="tileReset">Server default</button>
          </div>
          <p class="grit-sheet-msg" data-el="tileMsg" hidden></p>
          <p class="grit-sheet-note grit-disp-state" data-el="tileState"></p>
        </div>
      </section>
    </div>
  </div>

  <!-- ============================================================================================
       Terminal （手册 5.8）—— 在 GRIT 面板内打开，作用域是这个 tab。
       命令走的是与 Manage ▸ Terminal 同一个服务端会话与同一个端点（POST /api/live/command），
       这里只是第二个前台：自己的回显缓冲、自己的连接状态。Manage 的终端没有可导入的组件
       （manage.js 只导出 mount/unmount），所以按同一套 DOM/行为契约在这里重画。
       ============================================================================================ -->
  <div class="grit-term" data-el="term" role="dialog" aria-label="Terminal — GRIT tab" hidden>
    <div class="grit-term-head">
      <span class="grit-term-title">Terminal</span>
      <span class="grit-term-scope">GRIT · <span data-el="termScope">--</span></span>
      <span class="grit-term-status" data-el="termStatus">Not connected</span>
      <button type="button" class="grit-term-close" data-el="termClose" aria-label="Close Terminal">×</button>
    </div>
    <div class="grit-term-fields">
      <label class="grit-term-field"><span>Serial</span>
        <input type="text" data-el="termPath" placeholder="COM8" spellcheck="false"></label>
      <label class="grit-term-field"><span>Baud</span>
        <input type="text" data-el="termBaud" value="115200" spellcheck="false"></label>
      <label class="grit-term-field"><span>or TCP</span>
        <input type="text" data-el="termHost" placeholder="127.0.0.1" spellcheck="false"></label>
      <label class="grit-term-field"><span>Port</span>
        <input type="text" data-el="termPort" placeholder="3001" spellcheck="false"></label>
      <button type="button" class="grit-term-btn" data-el="termConnect">Connect</button>
      <button type="button" class="grit-term-btn" data-el="termDisconnect">Disconnect</button>
    </div>
    <div class="grit-term-out" data-el="termOut" tabindex="0"></div>
    <form class="grit-term-send" data-el="termForm">
      <span class="grit-term-prompt" aria-hidden="true">&gt;</span>
      <input type="text" data-el="termLine" placeholder="LOG COM1 BESTPOSB ONTIME 1" autocomplete="off" spellcheck="false">
      <button type="submit" class="grit-term-btn">Send</button>
    </form>
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

/* ---------------- Position Overview: the track (pure part) ---------------- */

/**
 * `2D Trajectory.csv` + `Position SD.csv`, as `/api/graph/data` returns them → the track the stage
 * draws. Longitude and latitude are paired row by row by `trajectoryPoints` (Graph's own rule, so
 * both panels show the same fixes); the 1σ ring is the largest of the two horizontal deviations of
 * the first epoch — exactly what Graph's Overview does with the same two files.
 *
 * Pure, so the data path is testable without a browser or a server.
 */
export function gritTrackFromCsv(lonPayload, latPayload, sdLatPayload, sdLonPayload) {
  const points = trajectoryPoints(lonPayload, latPayload);
  const firstValue = (payload) => {
    const point = payload && payload.series && payload.series.points && payload.series.points[0];
    const value = point ? Number(point[1]) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  const sigmaM = Math.max(firstValue(sdLatPayload), firstValue(sdLonPayload));
  return { points, sigmaM: Math.max(0, sigmaM) };
}

/**
 * `null` / `undefined` / `''` are *missing*, not zero — `Number(null)` is `0`, which would plant a
 * BESTPOS fix on the equator whenever the receiver has no solution yet.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * BESTPOS #42 entries (`LiveEntry.data.kind === 'bestpos'`, see `src/live.ts`) → the same track
 * shape. A fix without a finite lat/lon is skipped rather than drawn at 0°/0°; the 1σ is the last
 * accepted fix's deviation, in metres. `limit` keeps the newest N fixes.
 */
export function gritTrackFromBestpos(entries, limit = TRACK_POINTS) {
  const points = [];
  let sigmaM = 0;
  let lastTime = '';
  for (const entry of Array.isArray(entries) ? entries : []) {
    const data = entry && entry.data;
    if (!data || data.kind !== 'bestpos') continue;
    const lon = finiteNumber(data.longitude);
    const lat = finiteNumber(data.latitude);
    if (lon === null || lat === null) continue;
    points.push({ t: Number(entry.seq) || points.length, lon, lat });
    lastTime = entry.time || lastTime;
    const latSd = finiteNumber(data.latitudeDeviation);
    const lonSd = finiteNumber(data.longitudeDeviation);
    sigmaM = Math.max(latSd === null ? 0 : latSd, lonSd === null ? 0 : lonSd);
  }
  const keep = Math.max(1, Number(limit) || TRACK_POINTS);
  return { points: points.slice(-keep), sigmaM: Math.max(0, sigmaM), lastTime };
}

/** Points / metres / 1σ of a track, for the footer line (`gritTrackSummary`). */
export function gritTrackSummary(track) {
  const points = track && Array.isArray(track.points) ? track.points : [];
  return {
    points: points.length,
    lengthM: trackLength(points),
    sigmaM: Number(track && track.sigmaM) || 0,
  };
}

/* ---------------- Position Overview · Satellite imagery (Web Mercator tiles) ----------------
 *
 * The Map tab is LuciadRIA (or `mapSvg()`); the Satellite tab needs *imagery*, and no capture in
 * this repo carries any. What this adds is therefore an **honest substitute**, not the original
 * layer. The original's map is Google Maps — `setUpMonitor.html` injects
 * `maps.googleapis.com/maps/api/js?key=<key>` with the key read from the installed app's
 * `configurationfile.node`, and the LuCIAD route wraps that same session
 * (`03_分析/05_GRIT-Monitor.md` §2.3). This build has neither that key nor a licence to reuse the
 * tiles, so the default here is a public source and every screen says so.
 *
 *   source    `GRIT_TILE_URL` (server env) → server default; `?tiles=` (page) or the Map Settings
 *             field (localStorage `nas.grit.map.tiles.v1`) → override. `off` disables.
 *   transport every tile goes through `/api/grit/tiles/{z}/{x}/{y}` (`?src=` carries an override),
 *             so the server can cache bytes on disk and keep a key in `GRIT_TILE_KEY` — the browser
 *             never sees it.
 *   geometry  Web Mercator (EPSG:3857) at integer tile zooms; the track, the graticule, the 1σ ring
 *             and the POIs are drawn by `gritTileOverlaySvg()` through the **same** transform as the
 *             tiles, which is the one property that cannot be right by accident.
 *
 * Pure from top to bottom (template, maths, layout, SVG), so the whole path is testable without a
 * browser; `renderTiles()` in `mount()` only fetches bytes and hands them to these functions.
 */

/** 256 px is the only tile size any of these sources serves. */
export const GRIT_TILE_SIZE = 256;
/** Public imagery. `{z}/{y}/{x}` is Esri's order — the row comes before the column. */
export const GRIT_TILE_DEFAULT_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** What the map corner prints. "公开源替代" is not decoration — it is the provenance. */
export const GRIT_TILE_ATTRIBUTION =
  'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community · 公开源替代（非原版同源）';
export const GRIT_TILE_PROXY = '/api/grit/tiles';
export const GRIT_TILE_STORE_KEY = 'nas.grit.map.tiles.v1';
/** Web Mercator's valid latitude range; beyond it the projection runs to infinity. */
export const GRIT_TILE_MAX_LAT = 85.05112877980659;
export const GRIT_TILE_ZOOM_MIN = 1;
export const GRIT_TILE_ZOOM_MAX = 19;
/** One batch is one fit of the track: any more than this and the layer stops being a basemap. */
export const GRIT_TILE_LIMIT = 64;

const TILE_EARTH_CIRCUMFERENCE_M = 40_075_016.686;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A tile template → the template this build will use, `'off'` when imagery is switched off, or
 * `''` when the string is not a usable template. Anything without `{z}`, `{x}` and `{y}` is
 * refused rather than half-substituted: a template missing a placeholder would silently serve the
 * same tile for every coordinate.
 */
export function gritTileTemplate(raw) {
  if (raw === null || raw === undefined) return '';
  const text = String(raw).trim();
  if (!text) return '';
  const word = text.toLowerCase();
  if (['off', 'none', 'vector', 'false', '0', 'disabled'].includes(word)) return 'off';
  if (['on', 'default', '1', 'true', 'satellite'].includes(word)) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  /* `{-y}` is the TMS spelling of the row: a template that has it does have a row placeholder. */
  if (!text.includes('{z}') || !text.includes('{x}') || !(text.includes('{y}') || text.includes('{-y}'))) {
    return '';
  }
  return text;
}

/** `{z}/{x}/{y}`, `{-y}` (TMS), `{s}` (a·b·c) and `{key}` → one tile's URL, or null if unusable. */
export function gritTileUrl(template, tile, options) {
  const source = gritTileTemplate(template);
  if (!source || source === 'off') return null;
  const z = Number(tile && tile.z);
  const x = Number(tile && tile.x);
  const y = Number(tile && tile.y);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (z < 0 || z > 22) return null;
  const span = 2 ** z;
  if (x < 0 || y < 0 || x >= span || y >= span) return null;
  const key = options && typeof options.key === 'string' ? options.key : '';
  const url = source
    .replace(/\{z\}/g, String(z))
    .replace(/\{-y\}/g, String(span - 1 - y))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, 'abc'[(x + y) % 3])
    /* Only a configured key fills `{key}`; without one the placeholder stays and the URL is
     * refused below — a template with `?key=` and nothing after it requests a tile that cannot
     * exist and would be reported as "upstream is broken". */
    .replace(/\{key\}/g, key || '{key}');
  /* A leftover placeholder means a hole in the address (`{key}` with no key configured, a typo):
   * refuse it instead of asking the upstream for a tile that cannot exist. */
  return /\{[a-z-]+\}/i.test(url) ? null : url;
}

/**
 * The request the browser makes. Default source = the server's own (env) template, which is also
 * the only path that gets the disk cache keyed to `GRIT_TILE_URL`; an override travels as `src=`.
 */
export function gritTileRequest(tile, source) {
  const z = Number(tile && tile.z);
  const x = Number(tile && tile.x);
  const y = Number(tile && tile.y);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  const base = `${GRIT_TILE_PROXY}/${z}/${x}/${y}`;
  const template = gritTileTemplate(source);
  if (!template || template === 'off') return base;
  return `${base}?src=${encodeURIComponent(template)}`;
}

/** The host of a template (placeholders replaced by `0`) — labels, and the key/loopback guard. */
export function gritTileHost(template) {
  const source = gritTileTemplate(template);
  if (!source || source === 'off') return '';
  try {
    return new URL(source.replace(/\{[^}]*\}/g, '0')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** What the map corner prints: the server's attribution, or the host of an operator's template. */
export function gritTileAttribution(tiles) {
  const state = tiles || {};
  if (state.source) {
    const host = gritTileHost(state.source);
    return `自定义 XYZ 瓦片源（${host || '未知主机'}）· 公开源替代（非原版同源）`;
  }
  return state.attribution || GRIT_TILE_ATTRIBUTION;
}

/**
 * The same route with `?probe=1`: the server answers **200 JSON** (`{ok, source, error}`) instead of
 * image bytes. The panel asks once per view before the batch, so a build with no network never
 * issues a failed subresource — Chromium logs every one of those to the console, even when the JS
 * catches it, and "0 console errors" is part of the contract.
 */
export function gritTileProbeRequest(tile, source) {
  const request = gritTileRequest(tile, source);
  if (!request) return null;
  return `${request}${request.includes('?') ? '&' : '?'}probe=1`;
}

/** lon/lat → normalised Web Mercator (`0…1` from the west/north edge of the world). */
export function gritMercator(lon, lat) {
  const lng = clampNumber(Number(lon) || 0, -180, 180);
  const latitude = clampNumber(Number(lat) || 0, -GRIT_TILE_MAX_LAT, GRIT_TILE_MAX_LAT);
  const rad = (latitude * Math.PI) / 180;
  return {
    u: (lng + 180) / 360,
    v: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2,
  };
}

/** The inverse of `gritMercator` — `v` is the *north-down* fraction, as tiles index it. */
export function gritLonLat(u, v) {
  const x = clampNumber(Number(u) || 0, 0, 1);
  const y = clampNumber(Number(v) || 0, 0, 1);
  const n = Math.PI * (1 - 2 * y);
  return {
    lon: x * 360 - 180,
    lat: (Math.atan((Math.exp(n) - Math.exp(-n)) / 2) * 180) / Math.PI,
  };
}

/** The `{z}/{x}/{y}` a fix falls in (clamped at the edges of the world, like every slippy map). */
export function gritTileIndex(lon, lat, z) {
  const zoom = clampNumber(Math.round(Number(z) || 0), 0, 22);
  const span = 2 ** zoom;
  const { u, v } = gritMercator(lon, lat);
  return {
    z: zoom,
    x: clampNumber(Math.floor(u * span), 0, span - 1),
    y: clampNumber(Math.floor(v * span), 0, span - 1),
  };
}

/** A tile's geographic bounds — the check that index ↔ degree conversion really is a pair. */
export function gritTileExtent(z, x, y) {
  const zoom = clampNumber(Math.round(Number(z) || 0), 0, 22);
  const span = 2 ** zoom;
  const west = (x / span) * 360 - 180;
  const east = ((x + 1) / span) * 360 - 180;
  return {
    west,
    east,
    north: gritLonLat(0, y / span).lat,
    south: gritLonLat(0, (y + 1) / span).lat,
  };
}

/**
 * A viewport that holds every fix, in the units the tiles are laid out in:
 *
 *   `k`      pixels per whole-world unit — the single scale everything shares;
 *   `z`      the integer tile zoom requested from the source;
 *   `size`   how large one 256 px tile is drawn (`k / 2^z`), 256…512 px normally;
 *   `u0/v0`  world-unit corner of the viewport.
 *
 * A degenerate bbox (one fix, or five fixes on one pixel) is held open at `minSpan` so the picture
 * never zooms to an absurd z where every tile is one blurry pixel. Pure.
 */
export function gritTileView(points, width, height, options) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const opts = options || {};
  const minZoom = clampNumber(Number.isFinite(opts.minZoom) ? opts.minZoom : GRIT_TILE_ZOOM_MIN, 0, 22);
  const maxZoom = clampNumber(Number.isFinite(opts.maxZoom) ? opts.maxZoom : GRIT_TILE_ZOOM_MAX, minZoom, 22);
  const margin = Number.isFinite(opts.margin) && opts.margin > 0 ? opts.margin : 1.15;
  /* ≈ 306 m of equator: five coincident fixes still show a neighbourhood, not a single pixel. */
  const minSpan = Number.isFinite(opts.minSpan) && opts.minSpan > 0 ? opts.minSpan : 1 / 2 ** 17;

  const fixes = (Array.isArray(points) ? points : [])
    .filter((point) => point && Number.isFinite(point.lon) && Number.isFinite(point.lat));
  if (!fixes.length) {
    const z = 2;
    const k = GRIT_TILE_SIZE * 2 ** z;
    return {
      z, size: GRIT_TILE_SIZE, k, width: w, height: h,
      u0: 0.5 - w / k / 2, v0: 0.5 - h / k / 2,
      centerLon: 0, centerLat: 0,
    };
  }

  let uMin = 1;
  let uMax = 0;
  let vMin = 1;
  let vMax = 0;
  for (const point of fixes) {
    const { u, v } = gritMercator(point.lon, point.lat);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const du = Math.max((uMax - uMin) * margin, minSpan);
  const dv = Math.max((vMax - vMin) * margin, minSpan);
  const k = Math.min(w / du, h / dv);
  const z = clampNumber(Math.floor(Math.log2(k / GRIT_TILE_SIZE)), minZoom, maxZoom);
  const size = k / 2 ** z;
  const cu = (uMin + uMax) / 2;
  const cv = (vMin + vMax) / 2;
  const u0 = cu - w / k / 2;
  const v0 = cv - h / k / 2;
  const center = gritLonLat(cu, cv);
  return {
    z, size, k, width: w, height: h, u0, v0,
    centerLon: center.lon, centerLat: center.lat,
  };
}

/** Every tile the viewport touches, with its on-screen box. Off-world indices are dropped. */
export function gritTileLayout(view, limit = GRIT_TILE_LIMIT) {
  const box = view || {};
  const z = clampNumber(Math.round(Number(box.z) || 0), 0, 22);
  const k = Number(box.k);
  const w = Math.max(1, Number(box.width) || 0);
  const h = Math.max(1, Number(box.height) || 0);
  if (!(k > 0) || !Number.isFinite(box.u0) || !Number.isFinite(box.v0)) return [];
  const span = 2 ** z;
  const size = k / span;
  const x0 = Math.max(0, Math.floor(box.u0 * span));
  const x1 = Math.min(span - 1, Math.floor((box.u0 + w / k) * span));
  const y0 = Math.max(0, Math.floor(box.v0 * span));
  const y1 = Math.min(span - 1, Math.floor((box.v0 + h / k) * span));
  const tiles = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      tiles.push({
        z,
        x,
        y,
        left: Math.round((x / span - box.u0) * k),
        top: Math.round((y / span - box.v0) * k),
        size: Math.round(size),
      });
      if (tiles.length >= Math.max(1, Number(limit) || GRIT_TILE_LIMIT)) return tiles;
    }
  }
  return tiles;
}

/** lon/lat → viewport pixels, through the same `k`/`u0`/`v0` the tiles were laid out with. */
export function gritProjectPoint(view, lon, lat) {
  const box = view || {};
  const k = Number(box.k) || 0;
  const { u, v } = gritMercator(lon, lat);
  return { x: (u - (Number(box.u0) || 0)) * k, y: (v - (Number(box.v0) || 0)) * k };
}

/** Metres per screen pixel at a latitude — the scale bar's only input. */
export function gritMetresPerPixel(view, lat) {
  const k = Number(view && view.k) || 0;
  if (!(k > 0)) return 0;
  return (TILE_EARTH_CIRCUMFERENCE_M * Math.cos(((Number(lat) || 0) * Math.PI) / 180)) / k;
}

/** 1·2·5·10 degrees, sized so about five of them fit across `spanDeg`. */
function degreeTicks(spanDeg) {
  const raw = Math.max(1e-9, Number(spanDeg) || 0) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= raw) ?? power * 10;
  return step;
}

function tickRange(min, max, step) {
  const out = [];
  if (!(step > 0) || !Number.isFinite(min) || !Number.isFinite(max)) return out;
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) {
    out.push(Number(value.toFixed(10)));
    if (out.length > 64) break;
  }
  return out;
}

/** Metres → degrees at a latitude, for the 1σ ring and the POI radii. */
function metresToDegrees(metres, lat) {
  const north = metres / 111_320;
  const cos = Math.max(0.01, Math.cos(((Number(lat) || 0) * Math.PI) / 180));
  return { dLat: north, dLon: north / cos };
}

/**
 * The vector layer drawn **above** the imagery: graticule, track, 1σ ring, POIs, scale bar and
 * north arrow, all through `gritProjectPoint`. Its viewBox is the viewport, so the pixel its
 * `data-lon`/`data-lat` vertices land on is the same pixel the track sits on in `mapSvg()` — that
 * is the invariant the tests read back.
 *
 * Transparent by construction: the imagery underneath must not be covered by a "paper" tint.
 */
export function gritTileOverlaySvg(view, model) {
  const box = view || {};
  const w = Math.max(1, Math.round(Number(box.width) || 0));
  const h = Math.max(1, Math.round(Number(box.height) || 0));
  const data = model || {};
  const points = (Array.isArray(data.points) ? data.points : [])
    .filter((point) => point && Number.isFinite(point.lon) && Number.isFinite(point.lat));
  const sigmaM = Number.isFinite(data.sigmaM) ? Math.max(0, Number(data.sigmaM)) : 0;
  const pois = Array.isArray(data.pois) ? data.pois : [];
  const display = data.display || {};
  const font = 'font-family="Consolas, monospace"';
  const project = (lon, lat) => gritProjectPoint(box, lon, lat);
  const parts = [
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="影像底图上的轨迹与网格（Web Mercator）"`
      + ` data-basemap="tiles" data-tile-z="${Number(box.z) || 0}"`
      + ` data-center-lon="${(Number(box.centerLon) || 0).toFixed(8)}"`
      + ` data-center-lat="${(Number(box.centerLat) || 0).toFixed(8)}">`,
  ];

  /* Graticule: the degrees of the four corners, in whole degrees that stay readable. */
  if (display.graticule !== false) {
    const nw = gritLonLat(box.u0, box.v0);
    const se = gritLonLat(box.u0 + w / box.k, box.v0 + h / box.k);
    const stepLon = degreeTicks(se.lon - nw.lon);
    const stepLat = degreeTicks(nw.lat - se.lat);
    for (const lon of tickRange(nw.lon, se.lon, stepLon)) {
      const x = project(lon, nw.lat).x;
      if (x < 1 || x > w - 1) continue;
      parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}"`
        + ' stroke="rgba(255,255,255,0.45)" stroke-width="1" stroke-dasharray="4 4"/>');
      if (display.labels) {
        parts.push(`<text x="${x.toFixed(1)}" y="14" font-size="10" fill="rgba(255,255,255,0.95)"`
          + ` text-anchor="middle" paint-order="stroke" stroke="rgba(0,0,0,0.55)" stroke-width="3" ${font}>`
          + `${lon.toFixed(4)}°${lon >= 0 ? 'E' : 'W'}</text>`);
      }
    }
    for (const lat of tickRange(se.lat, nw.lat, stepLat)) {
      const y = project(nw.lon, lat).y;
      if (y < 1 || y > h - 1) continue;
      parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}"`
        + ' stroke="rgba(255,255,255,0.45)" stroke-width="1" stroke-dasharray="4 4"/>');
      if (display.labels) {
        parts.push(`<text x="6" y="${(y - 4).toFixed(1)}" font-size="10" fill="rgba(255,255,255,0.95)"`
          + ` paint-order="stroke" stroke="rgba(0,0,0,0.55)" stroke-width="3" ${font}>`
          + `${lat.toFixed(4)}°${lat >= 0 ? 'N' : 'S'}</text>`);
      }
    }
  }

  /* 1σ ring: Position SD.csv's first epoch, drawn as a 32-gon in degrees (mapSvg's rule). */
  if (points.length && sigmaM > 0) {
    const centre = project(points[0].lon, points[0].lat);
    const per = metresToDegrees(sigmaM, points[0].lat);
    const radiusPx = Math.abs(project(points[0].lon + per.dLon, points[0].lat).x - centre.x);
    if (radiusPx >= 3 && radiusPx <= Math.max(w, h) * 1.5) {
      const ring = [];
      for (let i = 0; i < 32; i += 1) {
        const angle = (i / 32) * Math.PI * 2;
        const point = project(
          points[0].lon + Math.cos(angle) * per.dLon,
          points[0].lat + Math.sin(angle) * per.dLat,
        );
        ring.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`);
      }
      parts.push(`<polygon points="${ring.join(' ')}" fill="rgba(0,81,111,0.08)"`
        + ' stroke="rgba(255,255,255,0.9)" stroke-width="1.2" stroke-dasharray="4 3"'
        + ` data-sigma-m="${sigmaM.toFixed(3)}"/>`);
    }
  }

  /* POIs: the same list Map Settings edits, ring + pin + name (the Luciad stage draws them too). */
  for (const poi of pois) {
    if (!poi || poi.visible === false) continue;
    if (!Number.isFinite(Number(poi.lon)) || !Number.isFinite(Number(poi.lat))) continue;
    const point = project(Number(poi.lon), Number(poi.lat));
    if (point.x < -50 || point.x > w + 50 || point.y < -50 || point.y > h + 50) continue;
    const colour = poi.active === false ? 'rgba(160,160,160,0.95)' : '#005170';
    const radius = Number(poi.radius) || 0;
    if (radius > 0) {
      const per = metresToDegrees(radius, Number(poi.lat));
      const ring = [];
      for (let i = 0; i < 32; i += 1) {
        const angle = (i / 32) * Math.PI * 2;
        const edge = project(
          Number(poi.lon) + Math.cos(angle) * per.dLon,
          Number(poi.lat) + Math.sin(angle) * per.dLat,
        );
        ring.push(`${edge.x.toFixed(1)},${edge.y.toFixed(1)}`);
      }
      parts.push(`<polygon points="${ring.join(' ')}" fill="rgba(0,81,111,0.10)"`
        + ` stroke="${colour}" stroke-width="1.2" stroke-dasharray="3 3" data-poi-radius="${radius}"/>`);
    }
    parts.push(
      `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5" fill="${colour}"`
        + ' stroke="#ffffff" stroke-width="1.6"/>',
      `<text x="${(point.x + 8).toFixed(1)}" y="${(point.y + 4).toFixed(1)}" font-size="10"`
        + ` fill="#ffffff" paint-order="stroke" stroke="rgba(0,0,0,0.6)" stroke-width="3" ${font}>`
        + `${esc(poi.name || 'POI')}</text>`,
    );
  }

  if (points.length > 1) {
    const coords = points
      .map((point) => `${project(point.lon, point.lat).x.toFixed(1)},${project(point.lon, point.lat).y.toFixed(1)}`)
      .join(' ');
    parts.push(`<polyline points="${coords}" fill="none" stroke="${MAP_TRACK_COLOR}" stroke-width="2.6"`
      + ' stroke-opacity="0.9" stroke-linejoin="round" stroke-linecap="round"/>');
  }
  const radius = points.length > 400 ? 2 : 3.2;
  points.forEach((point, index) => {
    const at = project(point.lon, point.lat);
    parts.push(`<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="${radius}" fill="#ffffff"`
      + ` fill-opacity="0.94" stroke="${MAP_TRACK_COLOR}" stroke-width="1.6"`
      + ` data-i="${index}" data-lon="${point.lon}" data-lat="${point.lat}"/>`);
  });

  const cursor = Number.isInteger(data.cursor) ? data.cursor : -1;
  if (cursor >= 0 && cursor < points.length) {
    const at = project(points[cursor].lon, points[cursor].lat);
    parts.push(`<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="7" fill="none"`
      + ' stroke="#ffd400" stroke-width="2" data-cursor="1"/>');
  }
  if (points.length) {
    const start = project(points[0].lon, points[0].lat);
    const end = project(points[points.length - 1].lon, points[points.length - 1].lat);
    parts.push(
      `<circle cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="5" fill="#ffffff"`
        + ' stroke="#2e8b57" stroke-width="2"/>',
      `<path d="M${end.x.toFixed(1)} ${(end.y - 5).toFixed(1)} l5 5 -5 5 -5 -5 z" fill="#d0021b"/>`,
    );
  }

  /* Scale bar, bottom-left: the only thing here whose length is a *measurement*. */
  const mpp = gritMetresPerPixel(box, Number(box.centerLat) || 0);
  if (mpp > 0) {
    const target = Math.min(150, Math.max(48, w * 0.26));
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((value) => value / mpp >= target * 0.6)
      ?? 10_000;
    const px = Math.min(w - 40, nice / mpp);
    if (px > 8) {
      /* Above the footer line (`grit-pos-foot` is 16–18 px tall), or the bar measures nothing but
       * its own top edge. */
      const barY = h - 46;
      parts.push(
        `<g data-scale-m="${nice}">`,
        `<rect x="16" y="${barY}" width="${(px / 2).toFixed(1)}" height="6" fill="rgba(0,0,0,0.8)"/>`,
        `<rect x="${(16 + px / 2).toFixed(1)}" y="${barY}" width="${(px / 2).toFixed(1)}" height="6"`
          + ' fill="#ffffff" stroke="rgba(0,0,0,0.8)"/>',
        `<text x="16" y="${barY + 17}" font-size="10" fill="#ffffff" paint-order="stroke"`
          + ` stroke="rgba(0,0,0,0.6)" stroke-width="3" ${font}>0</text>`,
        `<text x="${(16 + px).toFixed(1)}" y="${barY + 17}" font-size="10" fill="#ffffff"`
          + ` text-anchor="end" paint-order="stroke" stroke="rgba(0,0,0,0.6)" stroke-width="3" ${font}>`
          + `${nice >= 1000 ? `${nice / 1000} km` : `${nice} m`}</text>`,
        '</g>',
      );
    }
  }
  if (display.north !== false) {
    parts.push(`<g data-north="1"><path d="M${w - 26} ${h - 58} l6 14 -6 -4 -6 4 z" fill="#ffffff"`
      + ' stroke="rgba(0,0,0,0.65)" stroke-width="1"/>'
      + `<text x="${w - 26}" y="${h - 36}" font-size="10" fill="#ffffff" text-anchor="middle"`
      + ` paint-order="stroke" stroke="rgba(0,0,0,0.6)" stroke-width="3" ${font}>N</text></g>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * The sentence the Satellite tab prints for every state that is not "imagery is on screen". A
 * silent fallback is the bug this function exists to prevent: an offline build must say that the
 * picture is the vector graticule, not imagery.
 */
export function gritTileNote(tiles) {
  const state = tiles || {};
  if (state.enabled === false) {
    return 'Satellite 影像已关闭（瓦片源设为 off 或 GRIT_TILE_URL 为空）· 当前是矢量网格：'
      + '同一份轨迹、同一套坐标，没有影像。';
  }
  const status = state.status || 'idle';
  if (status === 'ready') return '';
  if (status === 'loading') {
    return `正在加载影像瓦片（z=${Number(state.zoom) || 0}，${Number(state.count) || 0} 块，`
      + '经 /api/grit/tiles 代理 + 本地缓存）…';
  }
  if (status === 'offline') {
    return `影像瓦片不可用（${state.error || '未知原因'}）· 已回退矢量网格：`
      + '轨迹、POI、比例尺都不依赖底图，离线照常显示。';
  }
  return 'Satellite 视图：影像瓦片将在轨迹就绪后按当前视野加载。';
}

/** `localStorage` → `{ source }`; `source` '' means "the server's own default". */
export function gritTilesParse(text) {
  const fallback = { source: '' };
  if (typeof text !== 'string' || !text.trim()) return fallback;
  let store;
  try {
    store = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!store || typeof store !== 'object') return fallback;
  const template = gritTileTemplate(store.source);
  if (template === 'off') return { source: 'off' };
  return { source: template };
}

/**
 * `?tiles=` → `{ source }` or null when the page carries no override. `on`/`default` mean "use the
 * server's source", a template means "use this one", `off`/`vector` means "no imagery".
 */
export function gritTilesFromSearch(search) {
  const text = String(search === null || search === undefined ? '' : search);
  if (!text) return null;
  const params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
  if (!params.has('tiles')) return null;
  const raw = params.get('tiles') || '';
  const template = gritTileTemplate(raw);
  if (template === 'off') return { source: 'off' };
  if (template) return { source: template };
  const word = raw.trim().toLowerCase();
  if (!word || ['on', 'default', '1', 'true', 'satellite'].includes(word)) return { source: '' };
  return { source: '', invalid: raw.trim() };
}

/**
 * The one sentence the tile prints when the picture is not self-explanatory — and `''` only when
 * Luciad really is painting the track. This is the GRIT equivalent of Graph's `failLuciad()`
 * reason: a missing engine, a missing CSV or an empty column set always says *why*, so the tile
 * can never be a blank canvas that pretends everything is fine. Pure, for the tests.
 *
 * The Satellite tab is deliberately *not* covered here: its picture is the tile layer, so its note
 * comes from `gritTileNote()` — otherwise a failed Luciad boot would be blamed on a view that does
 * not use Luciad at all.
 */
export function gritPositionReason(view) {
  const state = view || {};
  const points = Number(state.points) || 0;
  const lengthM = Number(state.lengthM) || 0;
  if (state.status === 'error') {
    return `读不到轨迹：${state.error || '未知错误'}（Position Overview 需要 Graph 导出的 ${MAP_FILE}）`;
  }
  if (state.status === 'empty') return `${MAP_FILE} 里没有可配对的经纬度列，画不出轨迹。`;
  if (state.status !== 'ready') return `正在通过 /api/graph/data 读取 ${MAP_FILE}…`;
  /* Satellite does not touch Luciad: its own state is `gritTileNote()`'s business. */
  if ((state.tab || 'map') === 'satellite') return '';
  if (state.engine === 'failed') {
    return `LuciadRIA 不可用（${state.engineError || '未知原因'}）· 已退回自绘经纬网：`
      + `同一份轨迹 ${points} 点 / ${formatDistance(lengthM)}，坐标系与配色都不变。`;
  }
  if (state.engine !== 'ready') return '正在启动 LuciadRIA（原版 Graph 引擎包，WebGPU）…';
  return '';
}

/* ---------------- Map Settings · Display (manual 5.7.3) ---------------- */

/**
 * The decorations the Positions Overview map can show, in the manual's order (5.7.3 "Display"
 * groups them under *Position* and *Overlays*; the stage carries the five that are drawable here).
 *
 * `scale` / `north` are the two HUD instruments, `graticule` the degree grid, `labels` its degree
 * text and `metric` the 1-2-5 m grid — exactly the five flags `/geo/luciad-stage.js` reads from
 * `chrome`. Nothing new is invented: the switches drive that existing table.
 */
export const GRIT_DISPLAY_FLAGS = [
  { key: 'graticule', label: 'Graticule', zh: '经纬网', hint: '经线 / 纬线' },
  { key: 'labels', label: 'Labels', zh: '标注', hint: '经纬度刻度文字' },
  { key: 'metric', label: 'Metric Grid', zh: '米制网格', hint: '1-2-5 m 网格' },
  { key: 'scale', label: 'Scale Bar', zh: '比例尺', hint: '左下角比例尺' },
  { key: 'north', label: 'North Arrow', zh: '指北针', hint: '右上角 N' },
];

/** What GRIT asks the shared stage for before the operator changes anything (`profile: 'grit'`). */
export function gritDisplayDefaults() {
  return stageChrome('grit');
}

/**
 * A stored Display object → the five booleans, merged over the `grit` profile. Anything that is not
 * a boolean (a hand-edited localStorage, a future flag) is dropped instead of propagated, so a
 * broken store cannot make the stage draw something the panel cannot describe.
 */
export function gritDisplayFromStored(stored) {
  const display = gritDisplayDefaults();
  if (!stored || typeof stored !== 'object') return display;
  for (const flag of GRIT_DISPLAY_FLAGS) {
    if (typeof stored[flag.key] === 'boolean') display[flag.key] = stored[flag.key];
  }
  return display;
}

/** Flip one flag; an unknown key returns the incoming set unchanged (a typo draws nothing). */
export function gritDisplayToggle(display, key) {
  const next = gritDisplayFromStored(display);
  if (!GRIT_DISPLAY_FLAGS.some((flag) => flag.key === key)) return next;
  next[key] = !next[key];
  return next;
}

/**
 * `{type:'chrome', chrome}` — the message `luciad-stage.js` applies with `setProfile('', chrome)`:
 * the profile (and therefore everything not listed) stays as it was, only these five flags move.
 * Pure, so the switch → `chrome` mapping is pinned without a browser.
 */
export function gritChromeMessage(display) {
  return { type: 'chrome', chrome: gritDisplayFromStored(display) };
}

/** A stored Display object as text → the five booleans (`localStorage` is user-editable). */
export function gritDisplayParse(text) {
  if (typeof text !== 'string' || !text.trim()) return gritDisplayDefaults();
  try {
    return gritDisplayFromStored(JSON.parse(text));
  } catch {
    return gritDisplayDefaults();
  }
}

/* ---------------- Map Settings · Points of Interest (manual 5.7.1) ---------------- */

/** Notification options, in the manual's wording (5.7.1 "Notification"). */
export const POI_NOTIFICATIONS = [
  { key: 'none', label: 'None' },
  { key: 'entry', label: 'On entry' },
  { key: 'exit', label: 'On exit' },
];

/**
 * One POI as this panel stores it. The fields are the manual's List View columns: name, radius,
 * latitude, longitude, notification, visibility, status, triggered-by. `triggeredBy` is always
 * `Manual` here — every point in this list was added in the interface, which is exactly what the
 * manual says that column shows for a manual point.
 *
 * @param {object} input  { name, lat, lon, radius, notification }
 * @returns {{ok:true, poi:object}|{ok:false, error:string}}
 */
export function gritPoiForm(input) {
  const source = input || {};
  const name = String(source.name ?? '').trim();
  if (!name) return { ok: false, error: 'Name 不能为空。' };
  if (name.length > POI_NAME_MAX) {
    return { ok: false, error: `Name 最多 ${POI_NAME_MAX} 个字符（原版输入框 maxlength=16）。` };
  }
  const lat = Number(source.lat);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: 'Latitude 必须是 -90…90 之间的数字（度）。' };
  }
  const lon = Number(source.lon);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { ok: false, error: 'Longitude 必须是 -180…180 之间的数字（度）。' };
  }
  const rawRadius = source.radius;
  const radius = rawRadius === '' || rawRadius === undefined || rawRadius === null ? 0 : Number(rawRadius);
  if (!Number.isFinite(radius) || radius < 0 || radius > 1e6) {
    return { ok: false, error: 'Radius 必须是 0…1000000 之间的数字（米，0 = 只画点不画圈）。' };
  }
  const notification = POI_NOTIFICATIONS.some((item) => item.key === source.notification)
    ? source.notification
    : 'none';
  return {
    ok: true,
    poi: {
      name,
      lat,
      lon,
      radius,
      notification,
      /** Manual 5.7.1: Show / Active both default on for a point added in the interface. */
      visible: true,
      active: true,
      triggeredBy: 'Manual',
    },
  };
}

/** Append one POI; `id` is injectable so a test gets a stable row. */
export function gritPoiAdd(list, poi, id) {
  const items = Array.isArray(list) ? list : [];
  if (items.length >= POI_LIMIT) return items;
  const entry = { ...poi, id: id || `poi-${Date.now().toString(36)}-${items.length + 1}` };
  return [...items, entry];
}

export function gritPoiRemove(list, id) {
  return (Array.isArray(list) ? list : []).filter((poi) => poi.id !== id);
}

/** Toggle Show / Active on one row; only those two booleans are writable. */
export function gritPoiSetFlag(list, id, field) {
  if (field !== 'visible' && field !== 'active') return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).map(
    /* A missing flag counts as on (see `gritPoiMessage`), so the first click hides it. */
    (poi) => (poi.id === id ? { ...poi, [field]: poi[field] === false } : poi),
  );
}

function gritPoiNormalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name ?? '').trim();
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const radius = Number(entry.radius);
  return {
    id: String(entry.id || poiFallbackId(entry)),
    name: name.slice(0, POI_NAME_MAX),
    lat,
    lon,
    radius: Number.isFinite(radius) && radius >= 0 ? radius : 0,
    notification: POI_NOTIFICATIONS.some((item) => item.key === entry.notification) ? entry.notification : 'none',
    visible: entry.visible !== false,
    active: entry.active !== false,
    triggeredBy: entry.triggeredBy === 'Manual' || !entry.triggeredBy ? 'Manual' : String(entry.triggeredBy),
  };
}

/** A deterministic id for a stored row that lost its own (`localStorage` is user-editable). */
function poiFallbackId(entry) {
  return `poi-${String(entry.name ?? '').length}-${Number(entry.lat) || 0}-${Number(entry.lon) || 0}`
    .replace(/[^0-9a-z-]/gi, '');
}

/**
 * Stored JSON → the POI list. Never throws: a corrupt store (or a different build's key) yields an
 * empty list rather than a page that cannot mount.
 */
export function gritPoiParse(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const entry of parsed) {
    const poi = gritPoiNormalize(entry);
    if (poi) out.push(poi);
    if (out.length >= POI_LIMIT) break;
  }
  return out;
}

/**
 * `{type:'pois', pois:[…]}` — what the stage draws: a marker per point and, when the radius is not
 * zero, the circle the manual describes ("the area defined by this radius is shown as a circle").
 * Hidden points travel along with `visible:false` so the stage decides, and a screenshot can prove
 * the switch reached it.
 */
export function gritPoiMessage(list) {
  return {
    type: 'pois',
    pois: (Array.isArray(list) ? list : []).map((poi) => ({
      id: poi.id,
      name: poi.name,
      lon: poi.lon,
      lat: poi.lat,
      radiusM: poi.radius,
      /* Show / Active default to on: the stage reads `!== false`, so an entry written before those
         flags existed still draws. */
      visible: poi.visible !== false,
      active: poi.active !== false,
    })),
  };
}

/* ---------------- Map Settings · Triggers (manual 5.7.2) ---------------- */

/**
 * The event logs a capture actually contains: `MARKPOS`, `MARK1POS` … and their `MARKxTIME`
 * companions — the logs the manual says must be configured on the receiver before a trigger can use
 * them ("The MARKxPOS logs must be configured on the receiver before they are used as Event
 * Triggers"). Read from `/api/logs` `groups`, so the Triggers tab can say whether this recording has
 * an event source at all instead of asserting one. Pure: `groups` is `[{id, name, count}]`.
 *
 * Measured on the 2026-10-31 samples: `b2` carries `MARKPOS` ×31, `b4` carries `MARK1TIME` ×1 and
 * `MARKTIME` ×1, and the other fourteen carry none — so "no event source" is a per-capture fact,
 * not a guess.
 */
export function gritEventLogs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => /^MARK\d*(POS|TIME)$/i.test(String(group?.name ?? '')))
    .map((group) => ({
      name: String(group.name).toUpperCase(),
      count: Number(group.count) || 0,
      firstUtc: group.firstUtc || null,
      lastUtc: group.lastUtc || null,
    }));
}

/**
 * What the Triggers tab says under an empty list. Three honest states, no invented trigger:
 * a live session has no event subscription in this build, a capture may carry MARKxPOS rows, and
 * a capture may carry none at all.
 */
export function gritTriggerSourceNote({ eventLogs = [], live = false, capture = '' } = {}) {
  const marks = Array.isArray(eventLogs) ? eventLogs : [];
  if (live) {
    return '实时会话里没有事件订阅：本 build 不订阅 MARKxPOS，接收机的 EVENT 输入也不会变成触发器。'
      + '触发器列表为空。';
  }
  if (marks.length) {
    const list = marks.map((log) => `${log.name} ×${log.count}`).join('、');
    return `${capture || '当前抓包'} 里有 ${list}，但触发器需要接收机侧先配置好 MARKxPOS 才会产生事件`
      + '（手册 5.7.2），而且本 build 不保存触发器配置、不在图上打事件点 —— 列表为空，只报告数据源。';
  }
  return `没有事件源：${capture || '当前抓包'} 不含 MARKxPOS 事件日志，也没有实时会话`
    + '（触发器由接收机的 EVENT 输入产生，见手册 5.7.2）—— 触发器列表为空。';
}

/* ---------------- Terminal (manual 5.8) ---------------- */

/**
 * The lines one `Send` writes into the transcript. The command goes to the **same** endpoint and
 * the same server-side live session `manage.js` uses (`POST /api/live/command`); only the transcript
 * is this panel's own. A command that could not be written says so — "sent" is never printed when
 * the server answered `connected: false`.
 *
 * @param {string} line                       what the operator typed
 * @param {object} status                     the `/api/live/command` body (`LiveStatus`)
 * @returns {string[]}                        transcript lines, oldest first
 */
export function gritTerminalEcho(line, status) {
  const text = String(line ?? '').trim();
  const body = status || {};
  const out = [`> ${text}`];
  if (body.connected !== true) {
    out.push(`! 未发送（没有实时会话）：${body.lastError || 'not connected'}`
      + ' — 在 Manage ▸ Terminal 或本抽屉的 Connect 建立会话后重发。');
    return out;
  }
  const last = Array.isArray(body.commands) ? body.commands[body.commands.length - 1] : null;
  if (body.lastError) out.push(`! 发送失败：${body.lastError}`);
  else if (last && last.status === 'send-failed') out.push('! 发送失败：接收机连接已断开。');
  else out.push('  已发送 — 接收机的 <OK/<ERR 应答从 /api/live/logs 回显到本窗口。');
  return out;
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
    /** MARKxPOS rows of this capture — the Triggers tab's only possible event source. */
    eventLogs: [],
    /** Interference toolkit: `ITDETECTSTATUS` only ever arrives as text on this receiver. */
    itk: null,
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

  /* ---- ITK: `ITDETECTSTATUS` arrives as **text** records on this receiver ---- */
  const textGroups = logs.status === 'fulfilled' ? logs.value.textGroups ?? [] : [];
  const itkGroup = textGroups.find((group) => /^ITDETECTSTATUS$/i.test(String(group.name)));
  if (itkGroup && Number(itkGroup.count) > 0) {
    try {
      const data = await ctx.api.get('/api/records', {
        capture: capture || undefined,
        name: 'ITDETECTSTATUS',
        offset: 0,
        limit: 25,
      });
      const rows = (data?.records ?? []).map((record) => fieldMap(record));
      const bands = new Set();
      const frequencies = new Set();
      let spectrum = 0;
      let statistical = 0;
      for (const row of rows) {
        const field = (name) => row[`interference_statuses[0].${name}`];
        const method = String(field('int_detect_method') ?? '').toUpperCase();
        const band = String(field('frequency') ?? '');
        if (band) bands.add(band);
        if (method === 'SPECTRUMANALYSIS') {
          spectrum += 1;
          const centre = Number(field('parameter1'));
          if (Number.isFinite(centre)) frequencies.add(Math.round(centre));
        } else if (method === 'STATISTICANALYSIS') {
          statistical += 1;
        }
      }
      out.itk = {
        total: Number(itkGroup.count),
        sampled: rows.length,
        spectrum,
        statistical,
        bands: [...bands],
        frequencies: [...frequencies].sort((a, b) => a - b),
      };
    } catch {
      out.itk = { total: Number(itkGroup.count), sampled: 0, spectrum: 0, statistical: 0, bands: [], frequencies: [] };
    }
  }

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
         *signals* — one square per satellite per band, not one per observation. The band comes from
         the **signal type** in `c_status` (bits 21..25), not from `sv_freq`: that field is zero for
         every signal except GLONASS and QZSS L1C/B (measured on b7: 3 243 zeros, 47 × 203). */
      const matrix = new Map();
      for (const row of MATRIX_ROWS) {
        const cells = {};
        for (const band of MATRIX_BAND_ORDER) cells[band] = new Set();
        matrix.set(row.key, cells);
      }
      let lband = 0;
      for (const observation of observations) {
        const status = Number(observation.c_status);
        const { system, band } = observationBand(status);
        const prn = Number(observation.sv_prn);
        if (!band || !Number.isFinite(prn)) continue;
        const key = SYSTEM_ROW[system];
        if (!key) continue;
        if (band === 'LBAND') {
          lband += 1;
        } else {
          prns.add(`${system}:${prn}`);
        }
        matrix.get(key)?.[band]?.add(`${system}:${prn}`);
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
  const textCount = (wanted) => {
    const group = textGroups.find((item) => String(item.name).toUpperCase() === wanted);
    return group ? Number(group.count) || 0 : 0;
  };
  out.spectrumTotals = {
    final: counts.get(ITPSD_FINAL) ?? 0,
    detect: counts.get(ITPSD_DETECT) ?? 0,
    /* This receiver writes ITPSDFINAL/ITPSDDETECT only as ASCII (§13.3): b7 has 47 + 90 text
       lines and no #1968/#2063 payload. The counts are what the page is asked for by `name=`. */
    textFinal: textCount('ITPSDFINAL'),
    textDetect: textCount('ITPSDDETECT'),
  };
  /* The one event source a recording can have: MARKxPOS. `/api/logs` already answered. */
  out.eventLogs = gritEventLogs(types);
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
    /**
     * `{ name, count }` when the sweeps were replayed from a capture's **text** records
     * (`#ITPSDFINALA` / `#ITPSDDETECTA`), `null` for binary records and for a live session.
     * The note prints it, so a replay is never described as a live sweep.
     */
    textSource: null,
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

/** `ITPSDFINAL` / `ITPSDDETECT` with an optional ASCII version letter (`ITPSDFINALA`). */
function spectrumLogOf(name) {
  const upper = String(name ?? '').toUpperCase();
  if (/^ITPSDFINAL[A-Z]?$/.test(upper)) return 'final';
  if (/^ITPSDDETECT[A-Z]?$/.test(upper)) return 'detect';
  return '';
}

/**
 * The 1024 (or 341, or 512) samples of one record, in bin order.
 *
 * Binary rows carry them in `record.arrays` — `logs.ts` `projectFields` lifts the single-leaf
 * numeric vector out of the 800-row field table and ships plain numbers. A **text** row has no
 * `arrays` at all (`readTextRecords` never lifts anything), so the same numbers are read back from
 * the `samples[i].samples` rows and sorted by their own index: the ASCII line prints them in order,
 * but nothing in the row object promises that the field table is ordered.
 */
function captureSamples(record) {
  const array = (record?.arrays ?? []).find((item) => item?.path === 'samples');
  if (array && Array.isArray(array.values) && array.values.length) return array.values.map(Number);
  const collected = [];
  for (const field of record?.fields ?? []) {
    const match = /^samples\[(\d+)\]\.samples$/.exec(String(field?.path ?? ''));
    if (!match) continue;
    const value = Number(field.value);
    if (!Number.isFinite(value)) return [];
    collected.push({ index: Number(match[1]), value });
  }
  if (!collected.length) return [];
  collected.sort((a, b) => a.index - b.index);
  return collected.map((entry) => entry.value);
}

/**
 * `status_word` of a **text** ITPSD record.
 *
 * The ASCII line prints the word with `%x` (`04020920`, `0c020821`), while the app's text
 * projection hands a token back as a number whenever it reads as one (`04020920` → 4020920) and as
 * the string otherwise (`0c020821`). Neither form alone is the word, but the eight printed
 * characters are recoverable from both: a decimal reading of at most eight digits, zero-padded.
 */
function textStatusWord(record) {
  const raw = rawField(record, 'status_word');
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const digits = String(Math.trunc(raw)).padStart(8, '0');
    return /^[0-9a-fA-F]{8}$/.test(digits) ? parseInt(digits, 16) : raw;
  }
  if (typeof raw === 'string' && /^[0-9a-fA-F]{8}$/.test(raw)) return parseInt(raw, 16);
  return 0;
}

/**
 * One `/api/records` row → the shape `/api/live/logs` gives a sweep chunk, so `ingestSpectrum`
 * cannot tell the two apart. `null` when the row is not an ITPSD log or carries no sample array.
 *
 * Two shapes reach this function, and both are the **same** record:
 *
 *  - a binary row (`header.messageId` 1968 / 2063) whose samples travel in `record.arrays`;
 *  - a text row (`header.messageId` 0, `header.name` `ITPSDFINAL` / `ITPSDDETECT`) whose samples
 *    are the `samples[i].samples` fields — on this receiver `ITPSDFINAL`/`ITPSDDETECT` have no
 *    binary form at all (§13.3 of `03_分析/05_GRIT-Monitor.md`), so b7 carries 47 + 90 text lines
 *    and zero #1968/#2063 payloads. The name is the identity; the id is 0 for every text log.
 *
 * Samples are the wire's `uint16` either way, so the manual's `raw / 256 − 200` dBm conversion
 * happens exactly here — the same two steps `live.ts` applies to the same bytes, and the only
 * place in this file that scales a sample.
 */
export function captureSpectrumEntry(record) {
  const messageId = Number(record?.messageId ?? record?.header?.messageId);
  const text = messageId === 0;
  const log = messageId === ITPSD_FINAL
    ? 'final'
    : messageId === ITPSD_DETECT
      ? 'detect'
      : text
        ? spectrumLogOf(record?.header?.name)
        : '';
  if (!log) return null;

  const raw = captureSamples(record);
  if (!raw.length) return null;

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
      status: spectrumStatus(text ? textStatusWord(record) : rawField(record, 'status_word')),
      frequencyStart,
      stepSize,
      samples: raw.map((value) => value / SAMPLE_SCALE - SAMPLE_OFFSET),
    },
  };
}

/**
 * Which `/api/records` page draws the open capture's spectrum — `null` when it carries none.
 *
 * Binary first, and FINAL before DETECT: `ITPSDFINAL` is the processed PSD the original's plot tab
 * is built on, `ITPSDDETECT` the detection view of the same sweep. A capture with **no** binary
 * payload of either (b7: 47 `#ITPSDFINALA` + 90 `#ITPSDDETECTA`, nothing at 1968/2063) is read by
 * `name=` instead — the same endpoint, served by `logs.ts` `readTextRecords`.
 *
 * `offset` is the **last** page: `limit` 25 is the server's cap and more than the ten sweeps the
 * waterfall keeps. A DETECT sweep is two 1024/341 chunks, so its page is one shorter and therefore
 * even — a page starting on a tail (`sequence 0`) would draw a 341-bin sweep of its own.
 */
export function captureSpectrumRequest(totals, capture = '') {
  if (!capture || !totals) return null;
  const binary = [
    { log: 'final', count: Number(totals.final) || 0, msgId: ITPSD_FINAL, name: '' },
    { log: 'detect', count: Number(totals.detect) || 0, msgId: ITPSD_DETECT, name: '' },
  ];
  for (const entry of binary) {
    if (entry.count <= 0) continue;
    const limit = entry.log === 'detect' ? CAPTURE_SPECTRUM_PAGE - 1 : CAPTURE_SPECTRUM_PAGE;
    const offset = Math.max(0, entry.count - limit);
    return {
      kind: 'binary',
      log: entry.log,
      msgId: entry.msgId,
      name: entry.name,
      count: entry.count,
      offset,
      limit,
      key: `${capture}|binary|${entry.log}|${offset}`,
    };
  }
  const textRows = [
    { log: 'final', count: Number(totals.textFinal) || 0, name: 'ITPSDFINAL' },
    { log: 'detect', count: Number(totals.textDetect) || 0, name: 'ITPSDDETECT' },
  ];
  for (const entry of textRows) {
    if (entry.count <= 0) continue;
    const limit = entry.log === 'detect' ? CAPTURE_SPECTRUM_PAGE - 1 : CAPTURE_SPECTRUM_PAGE;
    const offset = Math.max(0, entry.count - limit);
    return {
      kind: 'text',
      log: entry.log,
      msgId: undefined,
      name: entry.name,
      count: entry.count,
      offset,
      limit,
      key: `${capture}|text|${entry.log}|${offset}`,
    };
  }
  return null;
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
 * Where the sweeps on screen came from. A live session says nothing extra (the band above already
 * says `Connected to …`); a capture names the file, and a **text** replay says so in words, because
 * `#ITPSDFINALA` lines are a recording read back — not a live sweep.
 */
export function spectrumSourceNote(store) {
  if (!store || store.source !== 'capture' || !store.capture) return '';
  const origin = ` · capture ${baseName(store.capture)}`;
  const text = store.textSource;
  if (!text || !text.name) return origin;
  const count = Number(text.count) || 0;
  return `${origin} · replayed from ${count} text ${text.name} record${count === 1 ? '' : 's'}`;
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

/** Every ITPSD chunk the open capture holds — binary first, then the ASCII form. */
function spectrumTotal(totals) {
  if (!totals) return 0;
  return (Number(totals.final) || 0) + (Number(totals.detect) || 0)
    + (Number(totals.textFinal) || 0) + (Number(totals.textDetect) || 0);
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
  if (name && totals && spectrumTotal(totals) === 0) {
    return (
      `No spectrum data — ${name} carries no ITPSDFINAL / ITPSDDETECT record (binary #1968 / #2063 ` +
      'or ASCII), and no live session is open. The receiver only logs a PSD while ' +
      'ITSPECTRALANALYSIS runs (Settings → Spectrum Analysis).'
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
  const bands = visibleBands(state);
  const columns = bands.length ? bands : ['L5', 'L2', 'L1'];
  // The head and every row are rebuilt from the bands this capture actually carries: the original
  // draws only the bands the receiver is configured for (`allfrequency_values` filtered by
  // CHANCONFIGLIST), not a fixed six.
  const head = root.querySelector('.grit-matrix-head .grit-matrix-cells');
  if (head) {
    head.innerHTML = columns.map((band) => `<span class="grit-matrix-band">${band} Band</span>`).join('');
  }
  for (const row of MATRIX_ROWS) {
    const rowEl = root.querySelector(`.grit-matrix-row[data-row="${row.key}"]`);
    if (!rowEl) continue;
    const host = rowEl.querySelector('.grit-matrix-cells');
    if (host) host.innerHTML = matrixCells(columns);
    const rowCounts = counts?.get(row.key);
    for (const band of columns) {
      const cell = rowEl.querySelector(`[data-cell="${band}"]`);
      if (!cell) continue;
      const count = rowCounts?.[band]?.size ?? 0;
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
  /* Interference / Jamming / Mitigation Assistant read the capture's `ITDETECTSTATUS` list when it
     has one. On this receiver that record only ever arrives as text (`#ITDETECTSTATUSA`), so until
     2026-11-01 the panels said `Not detected` even with 38 detections in the file. */
  const itk = state.itk;
  if (itk && itk.total > 0) {
    setText(root, 'devInterference', 'Detected');
    setText(root, 'mitigation', itk.spectrum > 0 ? 'Detected' : 'Not detected');
    const summary = `${itk.total} ITDETECTSTATUS record${itk.total === 1 ? '' : 's'}`
      + (itk.bands.length ? ` on ${itk.bands.join('/')}` : '')
      + ` (spectrum ${itk.spectrum}${itk.spectrum && itk.frequencies.length ? ` @ ${itk.frequencies.join(', ')} MHz` : ''}, statistical ${itk.statistical})`
      + (itk.sampled < itk.total ? `; ${itk.sampled} decoded` : '');
    for (const el of ['devInterference', 'mitigation']) {
      const node = root.querySelector(`[data-el="${el}"]`);
      if (node) node.setAttribute('title', summary);
    }
  } else {
    setText(root, 'devInterference', 'Not detected');
    setText(root, 'mitigation', 'Not detected');
  }
  setText(root, 'devJamming', 'Not detected');

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
    const origin = spectrumSourceNote(store);
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
    /** MARKxPOS groups of the open capture — the Triggers tab's only possible event source. */
    eventLogs: [],
    /** `spectrum` | `waterfall` — which renderer the tile draws. */
    view: 'spectrum',
    /** ITPSD sweeps from whichever source owns the tile, see `ingestSpectrum`. */
    spectrum: emptySpectrumStore(),
    /** ITPSDFINAL / ITPSDDETECT chunk counts of the open capture (`/api/logs`). */
    spectrumTotals: null,
    /** True while the capture's spectrum page is in flight — the note says so instead of "none". */
    spectrumLoading: false,
    /**
     * Position Overview: the track plus the engine drawing it. `status` is about the *data*
     * (idle|loading|ready|empty|error), `engine` about LuciadRIA (idle|booting|ready|failed) —
     * keeping them apart is what lets the tile say "data is fine, the engine fell back".
     * (Named `track`, not `position`: `readStatus()` owns `state.position` for the BESTPOS band.)
     */
    track: {
      tab: 'map',
      status: 'idle',
      error: '',
      source: '',
      points: [],
      sigmaM: 0,
      engine: 'idle',
      engineError: '',
    },
    /** BESTPOS entries of the current live session; empty while no receiver is connected. */
    liveFixes: [],
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
      /* The Triggers tab's "does this capture have MARKxPOS" sentence comes from this read. */
      renderTriggers();
      /* Only now that the dashboard has painted: the spectrum and the position track are two
         second, optional reads. */
      void requestCaptureSpectrum();
      void loadPosition();
    } catch (error) {
      if (disposed || mine !== token) return;
      console.error('[grit] 读取抓包失败：', error);
    }
  };

  /* ---------------- capture spectrum: one `/api/records` page into the same store ---------------- */

  /**
   * Read the newest ITPSD page of the open capture, once, after the first paint.
   *
   * `captureSpectrumRequest` picks the page: binary #1968/#2063 first, otherwise the capture's
   * **text** records by `name=` (b7 has no binary ITPSD at all). `limit` is capped at 25 by
   * `/api/records`, and 25 chunks are more than the ten sweeps the waterfall keeps, so one request
   * covers curve + waterfall. Measured on `b1-20261101.sbf`: 25 ITPSDFINAL records = 172 395 B
   * (7 043 B each — the 1024 samples as numbers, not as 1024 field rows, which cost 50 381 B per
   * record). Nothing is fetched while a live session owns the tile, and nothing is fetched twice
   * for the same capture and page.
   */
  async function requestCaptureSpectrum() {
    if (disposed || state.live.connected) return;
    const capture = state.capture;
    const request = captureSpectrumRequest(state.spectrumTotals, capture);
    if (!request) return;
    if (request.key === spectrumPage) return;

    spectrumPage = request.key;
    state.spectrumLoading = true;
    renderSpectrum(root, state);
    try {
      const query = { capture, offset: request.offset, limit: request.limit };
      if (request.kind === 'text') query.name = request.name;
      else query.msgId = request.msgId;
      const data = await api.get('/api/records', query);
      if (disposed) return;
      state.spectrumLoading = false;
      const changed = ingestCaptureRecords(state.spectrum, data?.records ?? [], capture);
      /* A text replay is named in the note as a replay, with the capture's own count — never as a
         live sweep. Binary rows keep the plain `capture …` origin. */
      if (request.kind === 'text' && changed > 0) {
        state.spectrum.textSource = { name: request.name, count: request.count };
      }
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
        state.liveFixes = [];
        state.spectrum = emptySpectrumStore();
        renderSpectrum(root, state);
      }
      try {
        const page = await api.get('/api/live/logs', { after: state.live.cursor });
        if (disposed) return;
        state.live.cursor = Number(page.cursor) || state.live.cursor;
        let changed = false;
        let moved = false;
        for (const entry of page.entries ?? []) {
          state.live.records += 1;
          if (entry.time) state.live.lastRecordAt = entry.time;
          /* BESTPOS #42 feeds the Position Overview track; ITPSD feeds the spectrum store. */
          if (ingestPositionFix(entry)) moved = true;
          if (ingestSpectrum(state.spectrum, entry)) {
            changed = true;
            /* The live stream owns the tile from now on; a capture page must not blend into it. */
            state.spectrum.source = 'live';
            state.spectrum.capture = '';
            state.spectrum.textSource = null;
          }
        }
        if (changed) renderSpectrum(root, state);
        if (moved) applyLiveTrack();
        if (state.live.lastRecordAt) setText(root, 'devTime', hhmmss(state.live.lastRecordAt));
        /* The GRIT Terminal's transcript is this tab's: the same poll's entries, appended as the
           receiver's own ASCII lines. Nothing is fetched twice and no second session is opened. */
        if (term.open) {
          for (const entry of page.entries ?? []) {
            termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
          }
        }
      } catch (error) {
        if (disposed) return;
        state.live.lastError = error.message;
      }
    }

    const wasConnected = state.live.connected;
    state.live.connected = connected;
    if (term.open) renderTermStatus();
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
        /* Same for the track: BESTPOS fixes belong to the closed session. */
        state.liveFixes = [];
        if (state.track.source === 'live') {
          state.track.source = '';
          state.track.points = [];
          state.track.sigmaM = 0;
          state.track.status = 'idle';
          void loadPosition();
        }
      }
      renderSpectrum(root, state);
      /* The Triggers tab's sentence depends on whether a live session exists. */
      renderTriggers();
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

  /* ---------------- Position Overview: the shared LuciadRIA stage ----------------
   *
   * The tile is Graph's map, not a second implementation of it: the same stage document in an
   * iframe (`/geo/luciad-stage.html` → `/geo/luciad-engine.js`, the shipped Graph bundle), the
   * same `2D Trajectory.csv` / `Position SD.csv` columns through `/api/graph/data`, the same
   * `mapSvg()` as the fallback picture. This panel only picks the data and the decorations
   * (`profile: 'grit'` — track and grid, no degree labels), and prints the reason whenever the
   * engine or the data is missing.
   * ------------------------------------------------------------------------------------------ */

  const posCanvas = root.querySelector('[data-el="posCanvas"]');
  const posMap = root.querySelector('[data-el="posMap"]');
  const posTiles = root.querySelector('[data-el="posTiles"]');
  const posOverlay = root.querySelector('[data-el="posOverlay"]');
  const posCredit = root.querySelector('[data-el="posCredit"]');
  const posFrame = root.querySelector('[data-el="posFrame"]');
  const posNote = root.querySelector('[data-el="posNote"]');
  const posFoot = root.querySelector('[data-el="posFoot"]');

  const stage = createStageClient({
    frame: posFrame,
    url: LUCIAD_STAGE_URL,
    profile: 'grit',
    timeoutMs: LUCIAD_READY_TIMEOUT_MS,
    onReady: () => {
      state.track.engine = 'ready';
      state.track.engineError = '';
      /* Map Settings is this panel's addition to the shared stage: the Display switches and the POI
       * layer go down as soon as the stage says it can take messages, so a sheet opened before the
       * engine booted is not lost. */
      applyDisplay();
      pushPois();
      pushTrack(false);
      renderPosition();
      renderDisplay();
    },
    onError: (reason) => {
      /* Graph's `failLuciad()`: drop the frame, keep the data, say why on the tile. */
      state.track.engine = 'failed';
      state.track.engineError = reason;
      renderPosition();
      renderDisplay();
    },
    /* Hover/view/cursor are the stage's own HUD for Graph; GRIT's tile has no readout to fill, so
     * nothing is written back — the messages are still handled (and filtered by source). */
  });

  /** The picture box, or null while the tile has no layout yet (a fit from 0×0 is silently wrong). */
  function positionBox() {
    if (!posCanvas) return null;
    const rect = posCanvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  /* ---------------- Satellite imagery (XYZ tiles, Web Mercator) ----------------
   *
   * The Map tab is the shared LuciadRIA stage (or `mapSvg()`). The Satellite tab has no imagery in
   * any capture, so what it draws is the honest substitute described above the pure helpers: a
   * configurable XYZ source (default: Esri World Imagery, a **public** source — the suite never
   * names the original's provider), requested box by box through `/api/grit/tiles/{z}/{x}/{y}`.
   *
   * Why the proxy and not `<img src>`:
   *   - the server caches the bytes on disk (`GRIT_TILE_DIR`), so a second look — or an offline
   *     session — still paints the same imagery;
   *   - a key stays in `GRIT_TILE_URL`/`GRIT_TILE_KEY` and never reaches the browser or the repo;
   *   - a failed tile is an error this code can *report*, instead of a console error from a broken
   *     `<img>` (the browser check asserts 0 console errors in both states).
   *
   * Failure is contained: `tiles.status` goes offline, the vector graticule paints instead and the
   * note says why. The track, the POIs and the triggers never wait on a tile.
   * ---------------------------------------------------------------------------------------------- */

  const tiles = {
    enabled: true,
    source: '',
    label: 'Esri World Imagery',
    serverLabel: 'Esri World Imagery',
    attribution: GRIT_TILE_ATTRIBUTION,
    status: 'idle',
    error: '',
    zoom: 0,
    count: 0,
    view: null,
    layout: [],
    signature: '',
    seq: 0,
    cache: new Map(),
  };

  const searchedTiles = gritTilesFromSearch(typeof window === 'undefined' ? '' : window.location.search);
  const storedTiles = readStore(GRIT_TILE_STORE_KEY, gritTilesParse, () => ({ source: '' }));
  tiles.source = searchedTiles ? searchedTiles.source : storedTiles.source;
  tiles.enabled = tiles.source !== 'off';

  let tileConfigPromise = null;

  /** `/api/grit/tiles/config` once per mount: is imagery on, and whose pixels are they. */
  function tileConfig() {
    if (!tileConfigPromise) {
      tileConfigPromise = fetch(`${GRIT_TILE_PROXY}/config`, { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => (body && body.ok ? body : null))
        .catch(() => null);
    }
    return tileConfigPromise;
  }

  const tileKey = (tile) => `${tiles.source}|${tile.z}/${tile.x}/${tile.y}`;

  function blobDataUrl(blob) {
    return new Promise((resolveUrl, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolveUrl(String(reader.result));
      reader.onerror = () => reject(new Error('瓦片解码失败'));
      reader.readAsDataURL(blob);
    });
  }

  /** One tile's bytes as a `data:` URL. `data:` is what the page CSP already allows for images
   * (`img-src 'self' data:`), so the layer needs no CSP change and still never touches a remote
   * host from the browser. Fetched tiles are kept in `tiles.cache` (keyed by source + z/x/y) so a
   * re-render — resize, tab flip — does not re-request them.
   */
  async function loadTile(tile) {
    const key = tileKey(tile);
    const hit = tiles.cache.get(key);
    if (hit) return hit;
    const url = gritTileRequest(tile, tiles.source);
    if (!url) throw new Error('瓦片 URL 无法构造');
    const response = await fetch(url, { headers: { Accept: 'image/*' } });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.error) detail = `${detail} ${body.error}`;
      } catch {
        /* not JSON (an upstream HTML error page): the status number is the message */
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    if (!String(blob.type || '').startsWith('image/')) {
      throw new Error(`不是图片（${blob.type || 'unknown'}）`);
    }
    const dataUrl = await blobDataUrl(blob);
    tiles.cache.set(key, dataUrl);
    while (tiles.cache.size > 240) tiles.cache.delete(tiles.cache.keys().next().value);
    return dataUrl;
  }

  /**
   * "Would a tile come back?" — one 200 JSON request before the batch. A negative answer becomes the
   * fallback's reason; nothing else is requested, so an offline page logs no failed subresource.
   */
  async function probeTiles(tile) {
    const url = gritTileProbeRequest(tile, tiles.source);
    if (!url) return { ok: false, error: '瓦片 URL 无法构造' };
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const body = await response.json();
      if (!body || typeof body.ok !== 'boolean') return { ok: false, error: '探测返回无法解析' };
      if (body.ok) return { ok: true, source: body.source };
      return { ok: false, error: body.error || '影像瓦片不可用' };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  /** The imagery + overlay is on screen only when the bytes really arrived. */
  function tileLayerActive() {
    return state.track.tab === 'satellite'
      && state.track.status === 'ready'
      && tiles.status === 'ready'
      && Boolean(tiles.view)
      && tiles.layout.length > 0
      && tiles.layout.every((tile) => tiles.cache.has(tileKey(tile)));
  }

  function paintTiles() {
    const live = tileLayerActive();
    if (posTiles) {
      posTiles.hidden = !live;
      posTiles.innerHTML = live
        ? tiles.layout.map((tile) => {
          const src = tiles.cache.get(tileKey(tile));
          return `<img class="grit-maptile" alt="" width="${tile.size}" height="${tile.size}"`
            + ` style="left:${tile.left}px;top:${tile.top}px;width:${tile.size}px;height:${tile.size}px"`
            + ` src="${src}" data-tile="${tile.z}/${tile.x}/${tile.y}">`;
        }).join('')
        : '';
    }
    if (posOverlay) {
      posOverlay.hidden = !live;
      posOverlay.innerHTML = live
        ? gritTileOverlaySvg(tiles.view, {
          points: state.track.points,
          sigmaM: state.track.sigmaM,
          pois: poiList,
          cursor: state.track.source === 'live' ? state.track.points.length - 1 : -1,
          display,
        })
        : '';
    }
    if (posCredit) {
      posCredit.hidden = !live;
      posCredit.textContent = live
        ? `${gritTileAttribution(tiles)} · z${tiles.zoom} · ${tiles.layout.length} 块 · /api/grit/tiles`
        : '';
    }
  }

  /** One batch = one view. Requests are dropped when the view moved on (sequence guard). */
  async function loadTiles(layout) {
    const seq = ++tiles.seq;
    tiles.status = 'loading';
    tiles.error = '';
    tiles.count = 0;
    renderPosition();
    const config = await tileConfig();
    if (disposed || seq !== tiles.seq) return;
    if (config) {
      tiles.serverLabel = config.label || tiles.serverLabel;
      /* The server's label/attribution describe the server's own template; an operator override
       * is labelled by its host, never as someone else's imagery. */
      if (!tiles.source) {
        tiles.label = tiles.serverLabel;
        if (config.attribution) tiles.attribution = config.attribution;
      }
      if (config.enabled === false && !tiles.source) {
        tiles.enabled = false;
        tiles.status = 'offline';
        tiles.error = config.reason || '服务端未配置瓦片源';
        renderPosition();
        return;
      }
    }
    /* One probe before the batch: an unreachable source is reported, not hammered. */
    const probe = await probeTiles(layout[Math.floor(layout.length / 2)]);
    if (disposed || seq !== tiles.seq) return;
    if (!probe.ok) {
      tiles.status = 'offline';
      tiles.error = probe.error;
      renderPosition();
      return;
    }
    const results = await Promise.all(layout.map((tile) => loadTile(tile)
      .then(() => null)
      .catch((error) => (error && error.message) || String(error))));
    if (disposed || seq !== tiles.seq) return;
    const failures = results.filter(Boolean);
    if (failures.length === results.length) {
      tiles.enabled = tiles.enabled && tiles.source !== 'off';
      tiles.status = 'offline';
      tiles.error = failures[0];
      renderPosition();
      return;
    }
    tiles.status = 'ready';
    tiles.error = failures.length ? `${failures.length} 块缺失：${failures[0]}` : '';
    tiles.count = results.length - failures.length;
    renderPosition();
  }

  /**
   * Decide whether this view needs tiles. The signature pins zoom + corner + size + source, so a
   * resize or a tab flip refetches, and a render for any other reason does not.
   */
  function ensureTiles(box) {
    if (!box || !state.track.points.length) return;
    if (tiles.source === 'off') {
      tiles.enabled = false;
      if (tiles.status !== 'offline') {
        tiles.status = 'offline';
        tiles.error = '瓦片源设为 off';
      }
      return;
    }
    const view = gritTileView(state.track.points, box.width, box.height);
    const layout = gritTileLayout(view);
    const signature = `${view.z}|${view.u0.toFixed(9)}|${view.v0.toFixed(9)}|${view.k.toFixed(3)}`
      + `|${view.width}x${view.height}|${tiles.source}`;
    /* One batch per view, whatever it returned. A retry is explicit: re-entering the tab or
     * changing the source calls `resetTiles()`. Without this an offline view would re-probe on
     * every render — `loadTiles()` renders as it fails, and the render asks for tiles again. */
    if (signature === tiles.signature) return;
    tiles.signature = signature;
    tiles.view = view;
    tiles.layout = layout;
    tiles.zoom = view.z;
    if (!layout.length) {
      tiles.status = 'offline';
      tiles.error = '当前视野没有可用瓦片';
      return;
    }
    void loadTiles(layout);
  }

  /** Back to "nothing loaded yet": used when the tab is re-opened or the source changes. */
  function resetTiles() {
    tiles.seq += 1;
    tiles.status = 'idle';
    tiles.error = '';
    tiles.count = 0;
    tiles.signature = '';
    tiles.enabled = tiles.source !== 'off';
  }

  function pushTrack(fit) {
    const position = state.track;
    if (position.status !== 'ready' || position.engine !== 'ready') return;
    stage.sendTrack(position.points, {
      sigmaM: position.sigmaM,
      trackColor: MAP_TRACK_COLOR,
      fit,
    });
    /* Live: the newest fix is the "you are here" marker. A capture track has no clock of its own,
     * so it is drawn start-to-end with no cursor (start/end markers already say the rest). */
    stage.sendCursor(position.source === 'live' ? position.points.length - 1 : -1);
  }

  function positionFooter() {
    const position = state.track;
    const summary = gritTrackSummary(position);
    const source = position.source === 'live'
      ? '数据源 BESTPOS #42（实时）'
      : `数据源 ${MAP_FILE} / ${MAP_SD_FILE}`;
    if (position.tab === 'satellite') {
      /* The satellite line says what the base map *is*: imagery (with its zoom and provenance,
       * "public substitute, not the original's source") or the vector fallback and why. */
      const basemap = tiles.status === 'ready'
        ? `底图：Web Mercator 影像 z${tiles.zoom} · ${tiles.layout.length} 块 · ${tiles.label}（公开源替代，非原版同源）`
        : `底图：矢量网格（${tiles.status === 'loading' ? '影像加载中' : `影像不可用${tiles.error ? `：${tiles.error}` : ''}`}）`;
      return `${basemap} · ${source} · ${summary.points} 点 · 长度 ${formatDistance(summary.lengthM)}`
        + (summary.sigmaM > 0 ? ` · 1σ ${summary.sigmaM.toFixed(2)} m` : '');
    }
    const engine = position.engine === 'ready'
      ? `引擎：LuciadRIA 2026.0（原版 Graph 包）· ${(stage.state.view && stage.state.view.reference) || 'EPSG:32662'} · WebGPU`
      : position.engine === 'failed'
        ? `引擎：自绘 SVG（Luciad 不可用：${position.engineError}）`
        : '引擎：正在启动 LuciadRIA（/geo/luciad-engine.js）…';
    return `${engine} · ${source} · ${summary.points} 点 · 长度 ${formatDistance(summary.lengthM)}`
      + (summary.sigmaM > 0 ? ` · 1σ ${summary.sigmaM.toFixed(2)} m` : '');
  }

  /** Draw whichever state is true: engine frame, tiles, SVG graticule, or the sentence saying why. */
  function renderPosition() {
    const position = state.track;
    const summary = gritTrackSummary(position);
    const baseReason = gritPositionReason({
      tab: position.tab,
      status: position.status,
      error: position.error,
      engine: position.engine,
      engineError: position.engineError,
      points: summary.points,
      lengthM: summary.lengthM,
    });
    const onMap = position.tab === 'map';
    const onSatellite = position.tab === 'satellite';
    const engineLive = onMap && position.status === 'ready' && position.engine === 'ready';
    /* The tile note is the Satellite tab's own honesty line: imagery z17 on screen, or the vector
     * graticule plus the reason it is not imagery (offline, disabled, upstream refused). */
    const reason = baseReason || (onSatellite && position.status === 'ready' ? gritTileNote(tiles) : '');

    if (posFrame) posFrame.hidden = !engineLive;

    const box = onSatellite && position.status === 'ready' ? positionBox() : null;
    if (box) ensureTiles(box);
    const tilesLive = tileLayerActive();

    if ((onMap || onSatellite) && position.status === 'ready' && !engineLive && !tilesLive && box && posMap) {
      posMap.hidden = false;
      posMap.innerHTML = mapSvg({
        points: position.points,
        view: mapFit(position.points, box.width, box.height),
        sigmaM: position.sigmaM,
      }, box.width, box.height);
    } else if (posMap) {
      posMap.hidden = true;
      posMap.innerHTML = '';
    }
    paintTiles();

    if (posNote) {
      posNote.hidden = !reason;
      posNote.textContent = reason;
    }
    if (posFoot) {
      posFoot.hidden = !((onMap || onSatellite) && position.status === 'ready');
      posFoot.textContent = posFoot.hidden ? '' : positionFooter();
    }
  }

  /** Boot the engine once the data is there. A failure is final, exactly like Graph's. */
  function ensureStage() {
    const position = state.track;
    if (position.status !== 'ready') return;
    if (position.engine === 'booting' || position.engine === 'ready' || position.engine === 'failed') return;
    position.engine = 'booting';
    renderPosition();
    stage.start();
  }

  /** Capture mode: the two trajectory columns and the 1σ column, through the Graph endpoint. */
  async function loadPosition() {
    if (disposed) return;
    const position = state.track;
    /* A live session owns the picture: the CSV belongs to a different recording. */
    if (state.live.connected && state.liveFixes.length) return;
    position.status = 'loading';
    position.error = '';
    renderPosition();
    try {
      const [lon, lat] = await Promise.all([
        api.get('/graph/data', { file: MAP_FILE, column: MAP_LON_COLUMN }),
        api.get('/graph/data', { file: MAP_FILE, column: MAP_LAT_COLUMN }),
      ]);
      if (disposed) return;
      const [sdLat, sdLon] = await Promise.all([
        api.get('/graph/data', { file: MAP_SD_FILE, column: MAP_SD_LAT_COLUMN }).catch(() => null),
        api.get('/graph/data', { file: MAP_SD_FILE, column: MAP_SD_LON_COLUMN }).catch(() => null),
      ]);
      if (disposed) return;
      const track = gritTrackFromCsv(lon, lat, sdLat, sdLon);
      if (!track.points.length) {
        position.status = 'empty';
        position.error = '';
        renderPosition();
        return;
      }
      position.points = track.points;
      position.sigmaM = track.sigmaM;
      position.source = 'capture';
      position.error = '';
      position.status = 'ready';
      renderPosition();
      ensureStage();
    } catch (error) {
      if (disposed) return;
      position.status = 'error';
      position.error = (error && error.message) || String(error);
      renderPosition();
    }
  }

  /**
   * One BESTPOS entry → the live track. The entries are kept (last `TRACK_POINTS`) rather than
   * appended to the drawing, so a reconnect starts a clean track and a shrinking buffer is the
   * only thing that ever changes the picture.
   */
  function ingestPositionFix(entry) {
    const data = entry && entry.data;
    if (!data || data.kind !== 'bestpos') return false;
    if (finiteNumber(data.longitude) === null || finiteNumber(data.latitude) === null) return false;
    state.liveFixes.push(entry);
    if (state.liveFixes.length > TRACK_POINTS) state.liveFixes.splice(0, state.liveFixes.length - TRACK_POINTS);
    return true;
  }

  function applyLiveTrack() {
    const position = state.track;
    const track = gritTrackFromBestpos(state.liveFixes, TRACK_POINTS);
    if (!track.points.length) return;
    const first = position.source !== 'live';
    position.points = track.points;
    position.sigmaM = track.sigmaM;
    position.source = 'live';
    position.status = 'ready';
    position.error = '';
    renderPosition();
    /* Fit once, on the first live fix; after that the camera belongs to the operator. */
    pushTrack(first);
    ensureStage();
  }

  /* ---- Map / Satellite tabs. Map is LuciadRIA (or its SVG fallback); Satellite is the XYZ tile
   * layer described above, and falls back to the same SVG when the tiles cannot be had. ---- */
  const tabs = Array.from(root.querySelectorAll('[data-view]'));
  const onTab = (event) => {
    const view = event.currentTarget.getAttribute('data-view') === 'satellite' ? 'satellite' : 'map';
    for (const tab of tabs) {
      const on = tab === event.currentTarget;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const changed = state.track.tab !== view;
    state.track.tab = view;
    /* Re-entering Satellite is a retry: the operator may have plugged the network back in. */
    if (view === 'satellite' && changed) resetTiles();
    renderPosition();
  };
  for (const tab of tabs) tab.addEventListener('click', onTab);

  /* The SVG fallback is sized from the canvas box, so a resize needs one repaint. The engine keeps
   * its own view (the stage listens to its own `resize`). */
  const onResize = () => renderPosition();
  window.addEventListener('resize', onResize);

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
      popItem('Map…', 'map', '5.7 · POI / Triggers / Display'),
    ],
    tools: () => [
      popItem('Terminal', 'terminal', 'this tab · /api/live/command'),
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

  /** Close the popover and drop every `aria-expanded`/`is-open` it set on the menu buttons. */
  function closeMenu() {
    menuPop.hidden = true;
    menuPop.dataset.for = '';
    for (const button of menuButtons) {
      button.setAttribute('aria-expanded', 'false');
      button.classList.remove('is-open');
    }
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
    /* Manual 5.7: Settings ▸ Map opens the three-section Map Settings window. */
    if (act === 'map') {
      openMapSheet('poi');
      return;
    }
    /* Manual 5.8: the Terminal opens inside this panel; it is not a hand-off to Manage. */
    if (act === 'terminal') {
      openTerminal();
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
          `Spectrum: ITPSDFINAL #1968 / ITPSDDETECT #2063 (or the ASCII #ITPSDFINALA/#ITPSDDETECTA ` +
          `records when a capture has no binary form), sample = raw/256 − 200 dBm, ` +
          `chunks grouped by the OEM7 header sequence word (0 = last chunk), read from the live ` +
          `session or from the open capture's records — a capture replay is labelled as a replay. ` +
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
    closeMenu();
  };
  document.addEventListener('click', onDocumentClick);

  /* ============================================================================================
   * Map Settings （手册 5.7）—— Points of Interest / Triggers / Display
   *
   * 每一块的数据来源都写在界面里，不猜：
   *   POI       本机列表（localStorage `nas.grit.map.poi.v1`），不来自接收机；坐标由操作者填，
   *             首次打开时从当前定位预填（轨迹最后一点 / BESTPOS），并标注来源；
   *   Triggers  没有事件源：本 build 不订阅 MARKxPOS、也没有实时接收机，所以列表为空，
   *             只报告本抓包里到底有没有事件日志（/api/logs 的 groups）；
   *   Display   五个装饰开关 → 共享舞台的 `chrome` 参数，改完地图立刻重画。
   * ============================================================================================ */

  const mapSheet = root.querySelector('[data-el="mapSheet"]');
  const mapTabs = Array.from(root.querySelectorAll('[data-map-tab]'));
  const mapPanels = Array.from(root.querySelectorAll('[data-map-panel]'));
  const poiRowsEl = root.querySelector('[data-el="poiRows"]');
  const poiForm = root.querySelector('[data-el="poiForm"]');
  const poiMsg = root.querySelector('[data-el="poiMsg"]');
  const trigRowsEl = root.querySelector('[data-el="trigRows"]');
  const trigSource = root.querySelector('[data-el="trigSource"]');
  const displayRows = root.querySelector('[data-el="displayRows"]');
  const dispReset = root.querySelector('[data-el="dispReset"]');
  const tileInput = root.querySelector('[data-el="tileInput"]');
  const tileApply = root.querySelector('[data-el="tileApply"]');
  const tileReset = root.querySelector('[data-el="tileReset"]');
  const tileMsg = root.querySelector('[data-el="tileMsg"]');
  const tileState = root.querySelector('[data-el="tileState"]');
  const mapClose = root.querySelector('[data-el="mapClose"]');
  const posGear = root.querySelector('[data-el="posGear"]');
  const addPoiBtn = root.querySelector('[data-el="addPoi"]');

  /** `localStorage` is a convenience here, not a dependency: a blocked store keeps the list in RAM. */
  function readStore(key, parse, fallback) {
    try {
      const text = window.localStorage.getItem(key);
      return text === null ? fallback() : parse(text);
    } catch {
      return fallback();
    }
  }
  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota: the list still works for the lifetime of this page */
    }
  }

  let poiList = readStore(POI_STORE_KEY, gritPoiParse, () => []);
  let display = readStore(DISPLAY_STORE_KEY, gritDisplayParse, gritDisplayDefaults);
  let mapTab = 'poi';

  function savePoi() {
    writeStore(POI_STORE_KEY, poiList);
  }
  function saveDisplay() {
    writeStore(DISPLAY_STORE_KEY, display);
  }

  /** Display → the shared stage. A no-op before `ready`; `onReady` sends the same set again. */
  function applyDisplay() {
    stage.send(gritChromeMessage(display));
  }
  /** POI layer → the shared stage. Same deal: it is re-sent when the engine reports `ready`. */
  function pushPois() {
    stage.send(gritPoiMessage(poiList));
  }

  function poiMessageText(text, bad) {
    if (!poiMsg) return;
    poiMsg.hidden = !text;
    poiMsg.textContent = text || '';
    poiMsg.classList.toggle('is-bad', Boolean(bad));
  }

  function poiRow(poi) {
    const notification = POI_NOTIFICATIONS.find((item) => item.key === poi.notification)?.label ?? 'None';
    return `
      <div class="grit-poi-row" data-poi-id="${esc(poi.id)}">
        <span class="grit-poi-cell grit-poi-cell-name" title="${esc(poi.name)}">${esc(poi.name)}</span>
        <span class="grit-poi-cell grit-poi-cell-sym">${ICON.pin}</span>
        <span class="grit-poi-cell">${poi.radius > 0 ? `${esc(poi.radius)} m` : '—'}</span>
        <span class="grit-poi-cell">${poi.lat.toFixed(7)}</span>
        <span class="grit-poi-cell">${poi.lon.toFixed(7)}</span>
        <span class="grit-poi-cell">${esc(notification)}</span>
        <span class="grit-poi-cell"><button type="button" class="grit-mini-btn${poi.visible ? ' is-on' : ''}"
          data-poi-flag="visible" aria-pressed="${poi.visible ? 'true' : 'false'}">${poi.visible ? 'Show' : 'Hidden'}</button></span>
        <span class="grit-poi-cell"><button type="button" class="grit-mini-btn${poi.active ? ' is-on' : ''}"
          data-poi-flag="active" aria-pressed="${poi.active ? 'true' : 'false'}">${poi.active ? 'Active' : 'Inactive'}</button></span>
        <span class="grit-poi-cell">${esc(poi.triggeredBy)}</span>
        <span class="grit-poi-cell grit-poi-cell-act"><button type="button" class="grit-mini-btn is-danger"
          data-poi-delete aria-label="Delete ${esc(poi.name)}">Delete</button></span>
      </div>`;
  }

  function renderPoi() {
    if (poiRowsEl) {
      poiRowsEl.innerHTML = poiList.length
        ? poiList.map(poiRow).join('')
        : '<p class="grit-sheet-empty">还没有本地点：用上面的表单加一个（Name + Latitude + Longitude，Radius 0 = 只画点）。'
          + '这份列表存在本机浏览器里，不来自接收机。</p>';
    }
    pushPois();
  }

  function renderTriggers() {
    if (trigRowsEl) {
      trigRowsEl.innerHTML = '<p class="grit-sheet-empty">No triggers configured — 本 build 没有事件源。</p>';
    }
    if (trigSource) {
      trigSource.textContent = gritTriggerSourceNote({
        eventLogs: state.eventLogs,
        live: state.live.connected,
        capture: state.capture ? baseName(state.capture) : '',
      });
    }
  }

  function renderDisplay() {
    if (!displayRows) return;
    displayRows.innerHTML = GRIT_DISPLAY_FLAGS.map((flag) => `
      <div class="grit-disp-row" data-display-row="${flag.key}">
        <span class="grit-disp-name">${esc(flag.label)} <em>${esc(flag.zh)}</em></span>
        <span class="grit-disp-hint">${esc(flag.hint)}</span>
        <button type="button" class="grit-disp-toggle${display[flag.key] ? ' is-on' : ''}"
                data-display-toggle="${flag.key}" role="switch"
                aria-checked="${display[flag.key] ? 'true' : 'false'}"
                aria-label="${esc(flag.label)}">${display[flag.key] ? 'On' : 'Off'}</button>
      </div>`).join('');
    const dispState = root.querySelector('[data-el="dispState"]');
    if (dispState) {
      /* Only the engine reads `chrome`; the self-drawn fallback is honest about not doing so. */
      dispState.textContent = state.track.engine === 'ready'
        ? 'LuciadRIA 舞台已就绪：开关即时生效。'
        : state.track.engine === 'failed'
          ? 'LuciadRIA 不可用，当前是自绘回退图：开关只写进舞台参数（回退图不随之变化）。'
          : 'LuciadRIA 正在启动：开关先存下来，舞台就绪时一并应用。';
    }
    renderTileSettings();
  }

  function tileMessageText(text, bad) {
    if (!tileMsg) return;
    tileMsg.hidden = !text;
    tileMsg.textContent = text || '';
    tileMsg.classList.toggle('is-bad', Boolean(bad));
  }

  /**
   * The imagery row: which template is in force and what the last batch did. `''` means "the
   * server's `GRIT_TILE_URL`", `off` means "no imagery at all" — never an empty field pretending
   * to be a source.
   */
  function renderTileSettings() {
    if (tileInput && document.activeElement !== tileInput) tileInput.value = tiles.source;
    if (!tileState) return;
    const where = tiles.source === 'off'
      ? '影像已关闭（本机设置）'
      : tiles.source
        ? '本机模板（localStorage nas.grit.map.tiles.v1）'
        : `服务端默认（GRIT_TILE_URL / 内置公开源 ${tiles.label}）`;
    const status = tiles.status === 'ready'
      ? `已加载 z${tiles.zoom}，${tiles.layout.length} 块`
      : tiles.status === 'loading'
        ? `正在加载 z${tiles.zoom}（${tiles.layout.length} 块）`
        : tiles.status === 'offline'
          ? `不可用：${tiles.error || '未知原因'} —— Satellite 页签已回退矢量网格`
          : '切到 Satellite 页签后按当前视野加载';
    tileState.textContent = `来源：${where} · ${status}`;
  }

  /** A template from the field → `tiles.source`. Returns false when the field cannot be used. */
  function applyTileSource(raw) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    const template = gritTileTemplate(text);
    if (!template && text) {
      tileMessageText(`「${text}」不是可用的 XYZ 模板：需要 http(s) 与 {z}/{x}/{y}（TMS 用 {-y}）。`, true);
      return false;
    }
    tiles.source = template; // '' = server default, 'off' = no imagery, else the template
    tiles.enabled = tiles.source !== 'off';
    /* A custom template is labelled by its own host; the server's label only describes its own. */
    tiles.label = tiles.source
      ? (gritTileHost(tiles.source) || '自定义源')
      : (tiles.serverLabel || 'Esri World Imagery');
    writeStore(GRIT_TILE_STORE_KEY, { source: tiles.source });
    resetTiles();
    renderTileSettings();
    renderPosition();
    return true;
  }

  const onTileApply = () => {
    if (!tileInput) return;
    if (!applyTileSource(tileInput.value)) return;
    tileMessageText(
      tiles.source === 'off'
        ? '影像已关闭：Satellite 页签显示矢量网格（轨迹、POI、比例尺照旧）。'
        : tiles.source
          ? '已保存本机模板：瓦片经 /api/grit/tiles 代理请求并在服务端缓存。'
          : `已清空：改用服务端 GRIT_TILE_URL（未设置时是公开源 ${tiles.label}）。`,
      false,
    );
  };
  const onTileReset = () => {
    if (tileInput) tileInput.value = '';
    if (!applyTileSource('')) return;
    tileMessageText('已回到服务端默认源。', false);
  };
  if (tileApply) tileApply.addEventListener('click', onTileApply);
  if (tileReset) tileReset.addEventListener('click', onTileReset);

  function setMapTab(tab) {
    mapTab = ['poi', 'triggers', 'display'].includes(tab) ? tab : 'poi';
    for (const button of mapTabs) {
      const on = button.getAttribute('data-map-tab') === mapTab;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const panel of mapPanels) {
      panel.hidden = panel.getAttribute('data-map-panel') !== mapTab;
    }
  }

  /** Fill the empty coordinate fields from the position the receiver already gave us. */
  function prefillPoi() {
    if (!poiForm) return;
    const latEl = poiForm.querySelector('[data-poi-field="lat"]');
    const lonEl = poiForm.querySelector('[data-poi-field="lon"]');
    if (!latEl || !lonEl || latEl.value || lonEl.value) return;
    const last = state.track.points[state.track.points.length - 1];
    const lat = last && Number.isFinite(last.lat) ? last.lat : finiteNumber(state.position?.lat);
    const lon = last && Number.isFinite(last.lon) ? last.lon : finiteNumber(state.position?.lon);
    if (lat === null || lon === null) return;
    latEl.value = lat.toFixed(6);
    lonEl.value = lon.toFixed(6);
  }

  function openMapSheet(tab) {
    if (!mapSheet) return;
    closeTerminal();
    closeMenu();
    prefillPoi();
    renderPoi();
    renderTriggers();
    renderDisplay();
    setMapTab(tab || mapTab);
    if (searchedTiles && searchedTiles.invalid) {
      tileMessageText(`?tiles=${searchedTiles.invalid} 不是有效模板（需要 http(s) 与 {z}/{x}/{y}），已按默认源。`, true);
    }
    mapSheet.hidden = false;
  }
  function closeMapSheet() {
    if (mapSheet) mapSheet.hidden = true;
  }

  const onMapTabClick = (event) => {
    const button = event.currentTarget;
    setMapTab(button.getAttribute('data-map-tab'));
  };
  for (const button of mapTabs) button.addEventListener('click', onMapTabClick);

  const onPoiSubmit = (event) => {
    event.preventDefault();
    const read = (name) => poiForm.querySelector(`[data-poi-field="${name}"]`).value;
    const result = gritPoiForm({
      name: read('name'),
      lat: read('lat'),
      lon: read('lon'),
      radius: read('radius'),
      notification: read('notification'),
    });
    if (!result.ok) {
      poiMessageText(result.error, true);
      return;
    }
    poiList = gritPoiAdd(poiList, result.poi);
    savePoi();
    renderPoi();
    poiForm.querySelector('[data-poi-field="name"]').value = '';
    poiMessageText(`已添加「${result.poi.name}」：本地列表 ${poiList.length} 项，已推到 Position Overview 的地图舞台。`, false);
  };
  if (poiForm) poiForm.addEventListener('submit', onPoiSubmit);

  const onPoiRowsClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const row = target.closest('[data-poi-id]');
    if (!row) return;
    const id = row.getAttribute('data-poi-id');
    const flag = target.closest('[data-poi-flag]');
    if (flag) {
      poiList = gritPoiSetFlag(poiList, id, flag.getAttribute('data-poi-flag'));
      savePoi();
      renderPoi();
      return;
    }
    if (target.closest('[data-poi-delete]')) {
      const removed = poiList.find((poi) => poi.id === id);
      poiList = gritPoiRemove(poiList, id);
      savePoi();
      renderPoi();
      poiMessageText(removed ? `已删除「${removed.name}」：本地列表 ${poiList.length} 项。` : '', false);
    }
  };
  if (poiRowsEl) poiRowsEl.addEventListener('click', onPoiRowsClick);

  const onDisplayClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest('[data-display-toggle]') : null;
    if (!button) return;
    display = gritDisplayToggle(display, button.getAttribute('data-display-toggle'));
    saveDisplay();
    renderDisplay();
    applyDisplay();
  };
  if (displayRows) displayRows.addEventListener('click', onDisplayClick);

  const onDisplayReset = () => {
    display = gritDisplayDefaults();
    saveDisplay();
    renderDisplay();
    applyDisplay();
  };
  if (dispReset) dispReset.addEventListener('click', onDisplayReset);

  const onMapClose = () => closeMapSheet();
  if (mapClose) mapClose.addEventListener('click', onMapClose);
  const onSheetBackdrop = (event) => {
    if (event.target === mapSheet) closeMapSheet();
  };
  if (mapSheet) mapSheet.addEventListener('click', onSheetBackdrop);

  /* The tile's own two buttons open the same sheet (manual: the gear is "Map settings", the pin
   * button is Add Point of Interest). */
  const onPosGear = () => openMapSheet('display');
  const onAddPoi = () => openMapSheet('poi');
  if (posGear) posGear.addEventListener('click', onPosGear);
  if (addPoiBtn) addPoiBtn.addEventListener('click', onAddPoi);

  /* ============================================================================================
   * Terminal （手册 5.8）—— 在 GRIT 面板内打开，作用域是这个 tab。
   *
   * 同一个服务端会话、同一个端点：POST /api/live/command（工作台 Manage ▸ Terminal 用的也是它），
   * 回显来自 /api/live/logs —— 本面板已经在轮询同一个游标，所以终端把那些条目照原样追加进来，不另开
   * 一条连接。transcript 只属于这个 tab。
   *
   * `manage.js` 没有导出终端组件（只有 mount/unmount），所以这里是同一套 DOM/行为契约的第二个前台：
   * 同样的 Serial / Baud / TCP / Port 连接行、同样的 `> line` 回显、同样的连接状态。
   * ============================================================================================ */

  const termEl = root.querySelector('[data-el="term"]');
  const termOut = root.querySelector('[data-el="termOut"]');
  const termStatusEl = root.querySelector('[data-el="termStatus"]');
  const termForm = root.querySelector('[data-el="termForm"]');
  const termLine = root.querySelector('[data-el="termLine"]');
  const termScope = root.querySelector('[data-el="termScope"]');
  const termCloseBtn = root.querySelector('[data-el="termClose"]');
  const termConnectBtn = root.querySelector('[data-el="termConnect"]');
  const termDisconnectBtn = root.querySelector('[data-el="termDisconnect"]');
  const term = { open: false, lines: [], backfilled: false };

  function termAppend(text) {
    const line = String(text);
    term.lines.push(line);
    if (term.lines.length > 400) term.lines.splice(0, term.lines.length - 400);
    if (!termOut) return;
    const node = document.createElement('div');
    node.className = 'grit-term-line';
    node.textContent = line;
    termOut.appendChild(node);
    while (termOut.childElementCount > 400) termOut.firstElementChild.remove();
    termOut.scrollTop = termOut.scrollHeight;
  }

  function renderTermStatus() {
    if (termScope) termScope.textContent = state.capture ? baseName(state.capture) : 'no capture';
    if (!termStatusEl) return;
    termStatusEl.textContent = state.live.connected
      ? `Connected — ${state.live.target || 'live session'}`
      : state.live.lastError
        ? `Not connected — ${state.live.lastError}`
        : 'Not connected';
    termStatusEl.classList.toggle('is-live', Boolean(state.live.connected));
  }

  /** The newest slice of the server's ring buffer, exactly like Manage's Terminal does. */
  async function termBackfill() {
    if (term.backfilled) return;
    term.backfilled = true;
    try {
      const page = await api.get('/api/live/logs', { after: 0, limit: TERMINAL_BACKFILL });
      for (const entry of page.entries ?? []) {
        termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
      }
    } catch (error) {
      termAppend(`API error: ${error.message}`);
    }
  }

  function openTerminal() {
    if (!termEl) return;
    closeMapSheet();
    closeMenu();
    term.open = true;
    termEl.hidden = false;
    renderTermStatus();
    void termBackfill();
    termLine?.focus();
  }
  function closeTerminal() {
    if (!termEl) return;
    termEl.hidden = true;
    term.open = false;
  }

  const onTermSubmit = async (event) => {
    event.preventDefault();
    const line = (termLine?.value ?? '').trim();
    if (!line) return;
    if (termLine) termLine.value = '';
    let status = null;
    try {
      status = await api.post('/api/live/command', { line });
    } catch (error) {
      termAppend(`> ${line}`);
      termAppend(`! 请求失败：${error.message}`);
      return;
    }
    for (const text of gritTerminalEcho(line, status)) termAppend(text);
    if (status?.connected) state.live.lastError = status.lastError || '';
    renderTermStatus();
    /* The reply (`<OK` / `<ERR…`) is a log line: the poller picks it up and appends it here. */
    void pollLive();
  };
  if (termForm) termForm.addEventListener('submit', onTermSubmit);

  const onTermConnect = async () => {
    const path = (root.querySelector('[data-el="termPath"]')?.value ?? '').trim();
    const body = path
      ? {
        kind: 'serial',
        path,
        baud: Number(root.querySelector('[data-el="termBaud"]')?.value) || 115200,
      }
      : {
        kind: 'tcp',
        host: (root.querySelector('[data-el="termHost"]')?.value ?? '').trim() || '127.0.0.1',
        port: Number(root.querySelector('[data-el="termPort"]')?.value) || 3001,
      };
    termAppend(`Connecting ${body.kind === 'serial' ? `serial ${body.path}` : `tcp ${body.host}:${body.port}`} …`);
    try {
      const status = await api.post('/api/live/connect', body);
      term.lines = [];
      if (termOut) termOut.innerHTML = '';
      term.backfilled = true;
      termAppend(`Connected to ${status.target}`);
      await pollLive();
    } catch (error) {
      termAppend(`Connect failed: ${error.message}`);
    }
    renderTermStatus();
  };
  const onTermDisconnect = async () => {
    try {
      await api.post('/api/live/disconnect', {});
      termAppend('Disconnected');
    } catch (error) {
      termAppend(`Disconnect failed: ${error.message}`);
    }
    await pollLive();
    renderTermStatus();
  };
  const onTermClose = () => closeTerminal();
  if (termConnectBtn) termConnectBtn.addEventListener('click', onTermConnect);
  if (termDisconnectBtn) termDisconnectBtn.addEventListener('click', onTermDisconnect);
  if (termCloseBtn) termCloseBtn.addEventListener('click', onTermClose);

  /* ============================================================================================
   * Mitigation Assistant （手册 5.2.5）
   *
   * 数值上没有可编的东西：没有 ITK 报文就没有干扰条目 —— 原版这时也只打印 `Not detected`。补的是
   * **交互**：展开 / 收起、手册描述的两个状态、以及数据什么时候才会出现。
   * ============================================================================================ */

  const mitToggle = root.querySelector('[data-el="mitToggle"]');
  const mitDetails = root.querySelector('[data-el="mitDetails"]');
  const mitToggleLabel = root.querySelector('[data-el="mitToggleLabel"]');

  const onMitToggle = () => {
    if (!mitDetails) return;
    const open = mitDetails.hidden;
    mitDetails.hidden = !open;
    mitToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    mitToggle?.classList.toggle('is-open', open);
    mitToggle?.closest('.grit-mitigation')?.classList.toggle('is-open', open);
    if (mitToggleLabel) mitToggleLabel.textContent = open ? 'Hide' : 'Details';
  };
  if (mitToggle) mitToggle.addEventListener('click', onMitToggle);

  /* Escape closes whichever of the two panels is open (the map sheet first, it sits on top). */
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    if (mapSheet && !mapSheet.hidden) {
      closeMapSheet();
      return;
    }
    if (term.open) closeTerminal();
  };
  document.addEventListener('keydown', onKey);

  const offCapture = typeof ctx.onCaptureChange === 'function' ? ctx.onCaptureChange(load) : () => {};

  /**
   * Self-report for the browser check — the stage's own `__luciadStage.status()` is read through
   * the iframe (same origin), so a screenshot run can prove *which* engine painted the tile
   * instead of trusting the footer. Read-only; the panel never calls it.
   */
  const positionHook = {
    status() {
      const position = state.track;
      let stageStatus = null;
      try {
        stageStatus = posFrame && posFrame.contentWindow && posFrame.contentWindow.__luciadStage
          ? posFrame.contentWindow.__luciadStage.status()
          : null;
      } catch {
        stageStatus = null;
      }
      return {
        tab: position.tab,
        dataStatus: position.status,
        dataError: position.error,
        engine: position.engine,
        engineError: position.engineError,
        source: position.source,
        points: position.points.length,
        sigmaM: position.sigmaM,
        note: posNote && !posNote.hidden ? posNote.textContent : '',
        frameHidden: Boolean(posFrame && posFrame.hidden),
        stage: stageStatus,
        /* Satellite: which base map is on screen and what the last tile batch did. A screenshot run
           asserts `tiles.status === 'ready'` (imagery) against `'offline'` (vector fallback) here
           instead of guessing from pixels. */
        tiles: {
          enabled: tiles.enabled,
          source: tiles.source,
          label: tiles.label,
          attribution: gritTileAttribution(tiles),
          status: tiles.status,
          error: tiles.error,
          zoom: tiles.zoom,
          count: tiles.status === 'ready' ? tiles.layout.length : 0,
          painted: Boolean(posTiles && !posTiles.hidden),
          overlay: Boolean(posOverlay && !posOverlay.hidden),
          credit: posCredit && !posCredit.hidden ? posCredit.textContent : '',
        },
        /* Map Settings: the local POI list and the Display set the panel believes it sent. A check
           can compare these with `stage.chrome` (the echo) instead of reading booleans off a PNG. */
        poi: { count: poiList.length, stored: true },
        chrome: { ...display },
      };
    },
  };
  window.__gritPos = positionHook;

  root.__gritCleanup = () => {
    disposed = true;
    token += 1;
    tiles.seq += 1;
    tiles.cache.clear();
    stopLive();
    stage.stop();
    window.removeEventListener('resize', onResize);
    /* Only drop the hook if it is still ours — a newer mount may already have replaced it. */
    if (window.__gritPos === positionHook) delete window.__gritPos;
    offCapture?.();
    document.removeEventListener('click', onDocumentClick);
    menuPop.removeEventListener('click', onMenuClick);
    if (specGear) specGear.removeEventListener('click', onGear);
    dockToggle.removeEventListener('click', onDock);
    for (const tab of tabs) tab.removeEventListener('click', onTab);
    for (const seg of segs) seg.removeEventListener('click', onSeg);
    for (const button of menuButtons) button.removeEventListener('click', onMenu);
    /* Map Settings + Terminal + Mitigation Assistant */
    document.removeEventListener('keydown', onKey);
    for (const button of mapTabs) button.removeEventListener('click', onMapTabClick);
    if (poiForm) poiForm.removeEventListener('submit', onPoiSubmit);
    if (poiRowsEl) poiRowsEl.removeEventListener('click', onPoiRowsClick);
    if (displayRows) displayRows.removeEventListener('click', onDisplayClick);
    if (dispReset) dispReset.removeEventListener('click', onDisplayReset);
    if (tileApply) tileApply.removeEventListener('click', onTileApply);
    if (tileReset) tileReset.removeEventListener('click', onTileReset);
    if (mapClose) mapClose.removeEventListener('click', onMapClose);
    if (mapSheet) mapSheet.removeEventListener('click', onSheetBackdrop);
    if (posGear) posGear.removeEventListener('click', onPosGear);
    if (addPoiBtn) addPoiBtn.removeEventListener('click', onAddPoi);
    if (termForm) termForm.removeEventListener('submit', onTermSubmit);
    if (termConnectBtn) termConnectBtn.removeEventListener('click', onTermConnect);
    if (termDisconnectBtn) termDisconnectBtn.removeEventListener('click', onTermDisconnect);
    if (termCloseBtn) termCloseBtn.removeEventListener('click', onTermClose);
    if (mitToggle) mitToggle.removeEventListener('click', onMitToggle);
  };

  renderSpectrum(root, state);
  renderPosition();
  startLive();
  load();
  return page;
}
