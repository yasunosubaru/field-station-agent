/**
 * Playback panel — the suite's status dashboard in **playback mode**.
 *
 * The original screen (screenshot: `ref-ui/playback-loaded.png`) is not a timeline page: it is the
 * Manage dashboard (`statusBar.html` + `positionStatus.html` + `deviceInfo.html` + `satelliteView.html`)
 * fed from a capture instead of a live receiver, with the transport collapsed into a floating
 * `Timeline ▲` bar at the bottom right (`view/playbackcontrol/playbackcontrol.html`).
 *
 * Rebuilt blocks, in the order the original stacks them (manual ch. 3):
 *
 *   0. Recent Playback Activity (§3.1)  empty state = `Recent Activity` + `Open Playback File` +
 *                            one tile per recently opened capture (`app/view/html/playback.html`
 *                            `#recent-activity` + `getPlaybackDeviceTilehtml()` in
 *                            `deviceManagement.js:1208-1260`: name · Start · End · Duration ·
 *                            `Last Viewed`, icon `.recent-pb-img` top-right, whole tile clickable)
 *   1. Files bar (§3.2.1)    `#tabs-list` gains one tab per open capture (`clean-9600.gps ✕`);
 *                            the tab of the capture being viewed is the bright one, clicking a tab
 *                            switches the dashboard to it, ✕ closes just that file
 *   2. Summary bar (§3.2.2)  `.status-bar` (#E4E4E4, 112 px): Positioning [Good] | Device [Error]
 *   3. tab strip             the single `Positioning` page tab, 3 px #00516F underline (S:14554)
 *   4. two tiles (§3.2.3)    Positioning (8 fields) · Device (4 fields, one badge per row)
 *   5. Satellite View tile   legend + 8 constellation rows + polar sky plot
 *   6. Playback controls     `Timeline ▲`, expands into the transport (scrub, play/pause/replay,
 *                            speed, current record, snippet export) — §3.2.4
 *
 * Where the numbers come from (all from the local JSON API, nothing invented):
 *   BESTPOS #42   first record  → Positioning card + left half of the band
 *   HWMONITOR #963 measurements → Device card + right half of the band (`(status >> 8) & 0xff`
 *                   is `HwMonitorStatusReadingType`, see `06_Graph应用.md` §… and
 *                   `01_Manage主界面与视图层.md`; 1 Temperature · 2 Antenna Current ·
 *                   6/8/15/17/21/23 supply rails · 7 Antenna Voltage · 22 Secondary Temperature)
 *   RANGE #43     `sv_prn` + `c_status >> 16 & 7` → constellation counts (`range-charts.ts`
 *                   uses the same three bits: 0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC)
 *   VERSION #37   `versions[0].hardware_version` → band `Model` (the original's
 *                   `#statusBarhardwareVersion = logData.hardwareVersion`, `statusbar.js:141`)
 *   ITDETECTSTATUS #2065 `interference_statuses[i].severity1/2` → band `Interference`
 *                   (`statusbar.js:144-173`: any non-zero severity = Detected)
 *
 * Deliberate differences from the original screen are listed in `逆向/03_分析/11_UI壳.md` §20 and
 * the field-by-field table in `逆向/03_分析/04_Playback组件.md` §11.5.
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange, storage }.
 */

const CSS_URL = new URL('./playback.css', import.meta.url).href;
const CSS_ID = 'nas-panel-playback-css';

/** Message ids this page reads (SBF / EDIE). */
const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;
const VERSION = 37;
const ITDETECTSTATUS = 2065;

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

/* ============================ parity constants ============================ */

/**
 * Playback multipliers. The original's Speed menu is literally `1x · 2x · 5x · 10x · 20x`
 * (`view/playbackcontrol/playbackcontrol.html:79-83`) and `playbackview.js:116` hands the label
 * straight to `playbackControl.setSpeedRatio(parseInt(text))`. `/api/playback/info` still
 * advertises the engine's own list (`packages/playback/src/playback.ts` `PLAYBACK_SPEEDS =
 * [0.5, 1, 2, 4, 8]`); this page deliberately does not read it — the transport is driven in the
 * browser, so the menu has to match the original.
 */
export const PLAYBACK_SPEEDS = [1, 2, 5, 10, 20];

/** Recent files kept on the landing screen (the original keeps the whole list; we cap it). */
export const RECENT_LIMIT = 12;

/** localStorage key for §3.1 (the original keeps recents in `userSettings.json`, `userStore.js:27`). */
export const RECENT_KEY = 'nas.playback.recent';

/** `playbackview.js:435` — `playbackControl.rewind(30*1000, tab)`. */
export const REWIND_SECONDS = 30;

/** `NovatelIdConstants.HwMonitorStatusBoundaryLimitStatus` (`NovatelIdConstants.js:429`). */
export const HW_LIMIT = { acceptable: 0, lowerWarning: 1, lowerError: 2, upperWarning: 3, upperError: 4 };

/** `NovatelIdConstants.CpuStorageUsageBoundaryLimitStatus` (`NovatelIdConstants.js:421`): 80 / 90. */
export const USAGE_LIMITS = { lower: 80, upper: 90 };

/** `positionStatus.js:297-300` — solution statuses that turn the Positioning bar red. */
export const BAD_SOLUTIONS = ['INSUFFICIENT_OBS', 'NO_CONVERGENCE', 'INVALID_FIX', 'INTEGRITY_WARNING'];

/** `positionStatus.js:7` — accuracy order the original walks when picking the configured mode. */
export const CONFIG_MODE_ORDER = ['RTK', 'PPP', 'PSRDIFF', 'SBAS'];

/** localStorage key for the strip's `Show Events` switch (`deviceManagement.getPlaybackShowEvents`). */
export const SHOW_EVENTS_KEY = 'nas.playback.showEvents';

const TONE_RANK = { off: 0, good: 1, warn: 2, bad: 3 };

/* ================================ helpers ================================= */

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

/** localStorage behind the panel's own seam, so a private-mode browser cannot break the page. */
function defaultStorage() {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* quota / private mode: recents are a convenience, losing them is not an error */
      }
    },
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

/* ------------------------- tone (RAG) arithmetic ------------------------- */

/** Boundary limit of a HWMONITOR measurement → the badge its row carries. */
export function limitTone(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return 'off';
  if (value === HW_LIMIT.acceptable) return 'good';
  if (value === HW_LIMIT.lowerWarning || value === HW_LIMIT.upperWarning) return 'warn';
  if (value === HW_LIMIT.lowerError || value === HW_LIMIT.upperError) return 'bad';
  return 'off';
}

/** CPU / Storage usage percentage → green ≤ 80, amber ≤ 90, red above (`deviceInfo.js:22-57`). */
export function usageTone(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 'off';
  if (value < 0) return 'off';
  if (value <= USAGE_LIMITS.lower) return 'good';
  if (value <= USAGE_LIMITS.upper) return 'warn';
  return 'bad';
}

/** The most severe of a set of tones; `off` only wins when nothing else is known. */
export function worstTone(tones) {
  let worst = 'off';
  for (const tone of tones) {
    const key = TONE_RANK[tone] === undefined ? 'off' : tone;
    if (TONE_RANK[key] > TONE_RANK[worst]) worst = key;
  }
  return worst;
}

/** `RTK ROVER` → `RTK`, `NTRIP CLIENT` → `RTK` (`positionStatus.js:370-376`). */
export function configuredModeKey(mode) {
  const text = String(mode ?? '').trim();
  if (!text) return '';
  if (text === 'NTRIP CLIENT' || text === 'NTRIP SERVER') return 'RTK';
  return text.replace(/BASE|ROVER/gi, '').trim();
}

/**
 * Positioning status indicator — a transcription of `positionStatus.js:294-397`
 * (`updateRAGIndicator`): red for the four "no solution" statuses, amber when the highest
 * configured accuracy mode is not the active one, green otherwise.
 *
 * The configured modes of the original come from config logs (`SBASCONTROL`, `INTERFACEMODE`,
 * `GENERATERTK`, `NTRIPCONFIG`, `LOGLIST`, `AVEPOS` — `positionModes.js:42-86`). None of the 18
 * captures in `samples/` carries one, so this page always passes `configuredModes: []`; the
 * function still implements the branches so the rule is testable and a future capture that does
 * carry the config gets the original colours.
 */
export function positionTone({ solutionStatus, positionType, configuredModes = [], activeMode = '' } = {}) {
  const status = String(solutionStatus ?? '').toUpperCase();
  const type = String(positionType ?? '').toUpperCase();
  if (!status && !type) return 'off';
  if (BAD_SOLUTIONS.includes(status)) return 'bad';

  const configured = (Array.isArray(configuredModes) ? configuredModes : [])
    .map(configuredModeKey)
    .filter(Boolean);
  if (!configured.length) return 'good';

  const active = String(activeMode ?? '').toLowerCase();
  if (configured.includes('PSRDIFF') && active === 'single') return 'warn';
  if (configured.includes('PSRDIFF') && active === 'dgnss' && configured.includes('RTK')) return 'warn';
  if (configured.includes('PSRDIFF')) return 'good';

  for (const mode of CONFIG_MODE_ORDER) {
    if (!configured.includes(mode)) continue;
    const activeKey = configuredModeKey(active);
    if (!activeKey || activeKey.toUpperCase() !== mode) return 'warn';
    if (mode === 'RTK' && (type === 'WIDE_INT' || type === 'PSRDIFF' || type === 'NARROW_FLOAT')) return 'warn';
    return 'good';
  }
  return 'good';
}

/**
 * Device status indicator — `deviceInfo.js:376-407` plus `statusbar.js:281-296`:
 * red if any channel is over an error limit, amber if any channel is in a warning band,
 * amber too when part of the Summary bar's device picture is simply not in the capture
 * (we will not paint a channel we never saw as "Good"), off when nothing at all is known.
 *
 * `rows` is a list of `{ limit }` readings (or ready-made tones); `unknown` counts the summary
 * fields with no value for this file (Model · CPU Usage · Logging · Storage Usage ·
 * Interference · SPAN).
 */
export function deviceTone({ rows = [], unknown = 0 } = {}) {
  const tones = rows.map((row) => (typeof row === 'string' ? row : limitTone(row && row.limit)));
  const known = tones.filter((tone) => tone !== 'off');
  if (!known.length) return 'off';
  const worst = worstTone(known);
  if (worst === 'bad' || worst === 'warn') return worst;
  return unknown > 0 ? 'warn' : 'good';
}

/* ------------------------------ recent list ------------------------------ */

/** Trim a `/api/playback/info` payload down to what a recent tile shows. */
export function recentFromInfo(info, viewedAt = Date.now()) {
  const path = String(info?.capture ?? '');
  return {
    path,
    name: baseName(path),
    bytes: Number(info?.bytes) || 0,
    frameCount: Number(info?.frameCount) || 0,
    durationMs: Number(info?.durationMs) || 0,
    startUtc: String(info?.startUtc ?? ''),
    endUtc: String(info?.finishUtc ?? ''),
    viewedAt: Number(viewedAt) || Date.now(),
  };
}

/** Newest first, one entry per file (`validateRecentActivity` in the original drops duplicates). */
export function pushRecent(list, entry, limit = RECENT_LIMIT) {
  const previous = Array.isArray(list) ? list : [];
  if (!entry || !String(entry.path ?? '')) return previous.slice();
  const rest = previous.filter((item) => item && item.path !== entry.path);
  const keep = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : RECENT_LIMIT;
  return [entry, ...rest].slice(0, keep);
}

export function forgetRecent(list, path) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.path !== path);
}

/** `msToTimeString(ms, true)` (`playback.js:236-251`) — "0mins 4secs", "1hrs 2mins 3secs". */
export function durationText(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60000) % 60;
  const hours = Math.floor(total / 3600000);
  return hours ? `${hours}hrs ${minutes}mins ${seconds}secs` : `${minutes}mins ${seconds}secs`;
}

/** `Last Viewed 2026-11-01 09:30` — the original prints `getUTCTimeFormat(lastViewedMsec)`. */
export function viewedText(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time) || time <= 0) return '--';
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}

/* --------------------------- event strip (§11.5 / D1) --------------------------- */

/**
 * The markers of the strip: one per event, at `time / duration` percent.
 *
 * Geometry is the original's (`controller/playback.js:1024-1029`):
 * `per = (eventStart - captureStart) / total`, `left = calc(per% - 17px)` on a 16.67 px dot — i.e.
 * **the marker is centred on the event's own time**. `#btn-event` carries one class per severity
 * (`PoorEvent` red `#D0021B`, `ModerateEvent` amber, `GoodEvent` white) and `playback.js` only ever
 * appends the non-`Good` ones, so a `Good` entry would be a marker the original never draws.
 *
 * @param {Array<object>} events the `/api/playback/events` list
 * @param {number} duration capture length in seconds (the timeline's `durationMs / 1000`)
 */
export function eventMarkers(events, duration) {
  const span = Number(duration);
  if (!Number.isFinite(span) || span <= 0) return [];
  const markers = [];
  for (const event of Array.isArray(events) ? events : []) {
    const time = Number(event?.time);
    if (!Number.isFinite(time)) continue;
    const frequency = Number(event?.frequency);
    markers.push({
      event,
      time,
      left: Math.min(Math.max(time / span, 0), 1) * 100,
      severity: event?.severity === 'Poor' ? 'Poor' : 'Moderate',
      frequency: Number.isFinite(frequency) ? frequency : null,
    });
  }
  markers.sort((a, b) => a.left - b.left);
  return markers;
}

/**
 * The tooltip line, exactly as `playbackview.js:244-245` assembles it:
 * `eventTime.replace("UTC", "") + __(description).replace("%1", freqValue)` →
 * `"09:59:21 Interference is being detected at 1270Mhz."` (the clock has no `UTC` suffix left to
 * remove because `getUTCTimeFormatOnly` is `HH:MM:SS UTC`, `controller/playback.js:608-613`).
 */
export function eventTooltipText(event) {
  if (!event) return '';
  const clock = utcClock(event.utc);
  const sentence = String(event.detail ?? event.description ?? '');
  return clock === '--:--:--' ? sentence : `${clock} ${sentence}`;
}

/**
 * The line an empty strip shows. "No events" alone would read as "still loading", so the sentence
 * names what the capture *did* offer — and when nothing was read at all, which three logs the strip
 * would have used (`ITDETECTSTATUS` #2065, `RXSTATUS` #93, `RXSTATUSEVENT` #94).
 */
export function eventsEmptyNote(sources) {
  const read = [sources?.itk, sources?.spoofing, sources?.rxstatusevent]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const total = read.reduce((sum, value) => sum + value, 0);
  return total > 0
    ? `No events in this capture — ${total} event record${total === 1 ? '' : 's'} read, none above Good.`
    : 'No events in this capture — no ITDETECTSTATUS (#2065), RXSTATUS (#93) spoofing or RXSTATUSEVENT (#94) record.';
}

/**
 * The `data-event-count` toggle of `playbackview.js:198-203,268-271`: clicking the marker that is
 * already open closes it (`-1`), clicking any other one opens that one. Nothing here moves the play
 * head — the original's handler never calls `onProgressbarSeek` / `updateTimeOnMove`.
 */
export function nextEventSelection(current, clicked) {
  const index = Number(clicked);
  if (!Number.isInteger(index) || index < 0) return -1;
  return Number(current) === index ? -1 : index;
}

/** `deviceManagement.getPlaybackShowEvents` — `true` unless the capture's own setting says otherwise. */
export function showEventsFromStore(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'false' || text === '0' || text === 'off') return false;
  return true;
}

/** The original's Speed <select> — `1x · 2x · 5x · 10x · 20x`. */
export function speedOptionsHtml(selected = PLAYBACK_SPEEDS[0]) {
  const value = Number(selected);
  const chosen = PLAYBACK_SPEEDS.includes(value) ? value : PLAYBACK_SPEEDS[0];
  return PLAYBACK_SPEEDS.map(
    (speed) => `<option value="${speed}"${speed === chosen ? ' selected' : ''}>${speed}x</option>`,
  ).join('');
}

/** The Files bar's markup: one tab per open file, the viewed one bright, then the "+" to open more. */
export function fileTabsHtml(files, active) {
  const list = Array.isArray(files) ? files : [];
  return (
    '<span class="pb-filetabs-bar" role="tablist" aria-label="Open playback files">' +
    list
      .map((file, index) => {
        const isActive = index === active;
        return (
          '<span class="pb-filetab' + (isActive ? ' is-active' : '') + '" role="tab" ' +
          `aria-selected="${isActive}" data-role="activate-file" data-index="${index}" ` +
          `tabindex="${isActive ? '0' : '-1'}" title="${esc(file.path)}">` +
          `<span class="pb-filetab-name">${esc(file.name)}</span>` +
          `<button type="button" class="pb-filetab-close" data-role="close-file" ` +
          `data-index="${index}" aria-label="Close ${esc(file.name)}" tabindex="-1">&times;</button>` +
          '</span>'
        );
      })
      .join('') +
    /* 原版要回落地页才能再开一个文件（点九宫格里的 Playback）；这里在文件栏尾部放一个「+」，
     * 否则「多文件并载」只能靠先关掉所有文件。见 11_UI壳.md §20 刻意差异。 */
    '<button type="button" class="pb-filetab-add" data-el="openMore" tabindex="0" ' +
    'title="Open Playback File" aria-label="Open Playback File">+</button>' +
    '</span>'
  );
}

/**
 * Which tab is viewed after `closing` is removed: the neighbour on its right, else the one on its
 * left (the original's jQuery-UI tabs do the same), `-1` when nothing is left.
 */
export function nextActiveAfterClose(count, active, closing) {
  if (count <= 0) return -1;
  if (closing !== active) return closing < active ? active - 1 : active;
  return Math.min(closing, count - 2);
}

function recentRow(label, value) {
  return (
    '<span class="pb-recent-row">' +
    `<span class="pb-recent-label">${esc(label)}</span>` +
    `<span class="pb-recent-value">${esc(value)}</span>` +
    '</span>'
  );
}

/** One tile of §3.1 — `deviceManagement.js:1208-1260` markup, one class per part. */
export function recentTileHtml(entry) {
  const name = entry && (entry.name || baseName(entry.path));
  if (!name) return '';
  return (
    '<div class="pb-recent-tile" role="button" tabindex="0" data-role="open-recent" ' +
    `data-path="${esc(entry.path)}" title="${esc(entry.path)}">` +
    '<span class="pb-recent-img" aria-hidden="true"></span>' +
    '<span class="pb-recent-body">' +
    `<span class="pb-recent-name">${esc(name)}</span>` +
    recentRow('Start', utcClock(entry.startUtc)) +
    recentRow('End', utcClock(entry.endUtc)) +
    recentRow('Duration', durationText(entry.durationMs)) +
    '</span>' +
    `<span class="pb-recent-foot">Last Viewed ${esc(viewedText(entry.viewedAt))}</span>` +
    '<button type="button" class="pb-recent-forget" data-role="forget-recent" ' +
    `data-path="${esc(entry.path)}" aria-label="Remove ${esc(name)} from Recent Activity" ` +
    'tabindex="-1">&times;</button>' +
    '</div>'
  );
}

/* -------------------------------- markup --------------------------------- */

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

function bandRow(label, target, area, title, className) {
  return (
    `<div class="pb-band-row ${area}">` +
    `<span class="pb-band-label">${esc(label)}</span>` +
    `<span class="pb-band-value ${className || ''}" data-el="${target}"${title ? ` title="${esc(title)}"` : ''}>--</span>` +
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
    `<div class="bad-health" data-sat="${item.key}-missing" title="Missing — needs SATVIS2 (#1043) to say which satellites should be visible">0</div>` +
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

<!-- §3.1 landing: Recent Playback Activity (playback.html .playback-device-tiles-data) -->
<div class="pb-empty-state" data-el="empty" hidden>
  <div class="pb-empty-head">
    <span class="pb-empty-title">Recent Activity</span>
    <button type="button" class="pb-open-btn" data-el="open">Open Playback File</button>
  </div>
  <div class="pb-recent" data-el="recent" role="list"></div>
  <p class="pb-empty-note" data-el="emptyNote">No recent activity.</p>
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
          <button type="button" class="pb-badge pb-badge-good pb-band-link" data-el="posBadge"
                  title="Jump to the Positioning tile">Good</button>
        </div>
        <div class="pb-band-fields">
          ${bandRow('Position', 'bandPosition', 'pb-band-r1c1', 'Positioning type currently in use (boxed)', 'pb-boxed')}
          ${bandRow('Latitude', 'bandLat', 'pb-band-r2c1')}
          ${bandRow('Longitude', 'bandLon', 'pb-band-r3c1')}
          ${bandRow('Height (MSL)', 'bandHeight', 'pb-band-r2c2')}
          ${bandRow('SPAN', 'bandSpan', 'pb-band-r3c2', 'SPAN needs INSPVAX (#1465) / INSSPDSTATUS in the capture; none of the shipped captures has one')}
        </div>
      </div>

      <div class="pb-band-split" aria-hidden="true"></div>

      <div class="pb-band-half">
        <div class="pb-band-head">
          <span class="pb-band-title">Device</span>
          <button type="button" class="pb-badge pb-badge-bad pb-band-link" data-el="devBadge"
                  title="Jump to the Device tile">Error</button>
        </div>
        <div class="pb-band-fields pb-band-fields-device">
          ${bandRow('Model', 'devModel', 'pb-band-r1c1', 'Model comes from VERSION (#37) hardware_version')}
          ${bandRow('CPU Usage', 'devCpu', 'pb-band-r2c1', 'CPU Usage is HWMONITOR idleTime, which the binary HWMONITOR of this build does not carry')}
          ${bandRow('Logging', 'devLogging', 'pb-band-r3c1', 'Logging needs LOGSTATUS / LOGLIST (#5); absent from every shipped capture')}
          ${bandRow('Time (UTC)', 'devTime', 'pb-band-r1c2')}
          ${bandRow('Interference', 'devInterference', 'pb-band-r2c2', 'Interference comes from ITDETECTSTATUS (#2065) severity')}
          ${bandRow('Storage Usage', 'devStorage', 'pb-band-r3c2', 'Storage Usage needs FILESYSTEMCAPACITY (#2137); absent from every shipped capture')}
        </div>
      </div>
    </div>
  </div>

  <div class="pb-page">
    <div class="pb-tabstrip" role="tablist" aria-label="Status pages">
      <button type="button" class="pb-tab active-tab" role="tab" aria-selected="true">Positioning</button>
    </div>

    <div class="pb-cards">
      <section class="tile pb-card" data-tile="positioning">
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

      <section class="tile pb-card" data-tile="device">
        <div class="pb-card-head">
          <h2 class="heading">Device</h2>
          <span class="pb-badge pb-badge-unknown" data-el="cardDevBadge">--</span>
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

    <section class="tile pb-card pb-sat" id="SatelliteViewPanel" data-tile="satellite">
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
      <div class="pb-events" data-el="events" role="group" aria-label="Receiver events"></div>
    </div>

    <div class="pb-event-pop" data-el="eventPop" role="dialog" aria-label="Event" hidden>
      <div class="pb-event-pop-arrow" aria-hidden="true"></div>
      <p class="pb-event-pop-text" data-el="eventPopText"></p>
      <p class="pb-event-pop-source" data-el="eventPopSource"></p>
      <button class="pb-event-pop-close" type="button" data-el="eventPopClose" aria-label="Close">&times;</button>
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
        <label class="pb-events-switch">
          <input type="checkbox" data-el="showEvents" checked>
          <span class="pb-label">Show Events</span>
        </label>
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
  const storage = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage : defaultStorage();

  root.classList.add('playback-panel');
  root.innerHTML = template(speedOptionsHtml(1));
  const el = collect(root);

  /** `gps-use` / `gps-idle` / `gps-missing` → the three count boxes of every constellation row. */
  const satCount = {};
  for (const node of root.querySelectorAll('[data-sat]')) {
    satCount[node.dataset.sat] = node;
  }

  /* The Files bar lives in the shell's app bar (`index.html #tabs-list`). Injecting it from here
   * keeps the bar exactly as the original has it — "Playback" then the open files — without
   * editing the shell. One wrapper `<li>` holds one tab per open capture; it is removed again in
   * the cleanup below, and CSS hides it on every other page. */
  const appBar = document.getElementById('tabs-list');
  const fileTabs = appBar ? document.createElement('li') : null;
  if (fileTabs) {
    fileTabs.className = 'pb-filetabs';
    fileTabs.setAttribute('role', 'presentation');
    appBar.appendChild(fileTabs);
  }

  const state = {
    alive: true,
    captures: [],
    /** One record per open capture — the Files bar is exactly this list. */
    files: [],
    active: -1,
    recent: [],
    speed: PLAYBACK_SPEEDS[0],
    playing: false,
    raf: 0,
    last: 0,
    /** `Show Events` (§3.2.4) — `true` unless the switch was turned off (`SHOW_EVENTS_KEY`). */
    showEvents: showEventsFromStore(storage.get(SHOW_EVENTS_KEY)),
    /** Index of the marker whose tooltip is pinned, `-1` when none (the original's `data-event-count`). */
    selectedEvent: -1,
    preferPath: typeof ctx.capture === 'string' ? ctx.capture : '',
  };

  const current = () => (state.active >= 0 ? state.files[state.active] ?? null : null);

  function makeFile(path) {
    return {
      path,
      name: baseName(path),
      info: null,
      frames: [],
      duration: 0,
      time: 0,
      from: 0,
      to: 0,
      ready: false,
      /** `/api/playback/events` — the event strip's markers (never invented: empty when none). */
      events: [],
      /** Records each event source offered, so the empty strip can say what was read. */
      eventSources: null,
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
      position: null,
      device: null,
      extras: null,
    };
  }

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

  /* ---- Files bar (§3.2.1) + landing (§3.1) ---- */

  function renderFileTabs() {
    if (!fileTabs) return;
    if (!state.files.length) {
      fileTabs.innerHTML = '';
      fileTabs.hidden = true;
      return;
    }
    fileTabs.hidden = false;
    fileTabs.innerHTML = fileTabsHtml(state.files, state.active);
  }

  function renderRecent() {
    const tiles = state.recent.map(recentTileHtml).join('');
    el.recent.innerHTML = tiles;
    el.recent.hidden = !tiles;
    el.emptyNote.hidden = Boolean(tiles);
  }

  function renderShell() {
    const file = current();
    el.loaded.hidden = !file;
    el.empty.hidden = Boolean(file);
    el.dock.hidden = !file;
    renderFileTabs();
    renderRecent();
  }

  function readRecent() {
    try {
      const raw = storage.get(RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const files = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.files) ? parsed.files : [];
      return files.filter((item) => item && typeof item.path === 'string' && item.path);
    } catch {
      return [];
    }
  }

  function writeRecent(list) {
    state.recent = Array.isArray(list) ? list : [];
    try {
      storage.set(RECENT_KEY, JSON.stringify({ version: 1, files: state.recent }));
    } catch {
      /* see defaultStorage() */
    }
    renderRecent();
  }

  function rememberRecent(info) {
    if (!info || !info.capture) return;
    writeRecent(pushRecent(state.recent, recentFromInfo(info), RECENT_LIMIT));
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

  /** Keeps the shell's capture picker (and every other panel) in step with the active file. */
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
      solutionStatus: String(get('solution_status')?.value ?? ''),
      positionType: String(get('position_type')?.value ?? ''),
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

  function renderPosition(file) {
    const p = file?.position;
    const band = (node, text) => {
      if (node) node.textContent = text;
    };
    if (!p) {
      for (const node of [
        el.bandPosition, el.bandLat, el.bandLon, el.bandHeight, el.bandSpan,
        el.posMode, el.posPosition, el.posLat, el.posLon, el.posHeight,
        el.posHeightAcc, el.pos2d, el.posDatum,
      ]) {
        band(node, '--');
      }
      setBadge(el.posBadge, 'off');
      setBadge(el.cardPosBadge, 'off');
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

    const tone = positionTone({ solutionStatus: p.solutionStatus, positionType: p.positionType });
    setBadge(el.posBadge, tone);
    setBadge(el.cardPosBadge, tone);
  }

  /* ---- Device (HWMONITOR #963 · VERSION #37 · ITDETECTSTATUS #2065) ---- */

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

  /** `VERSION #37` → the receiver's hardware version; `ITDETECTSTATUS #2065` → interference. */
  function readExtras(version, itDetect) {
    let model = '';
    if (version) {
      const card = version.fields.find((field) => field.path === 'versions[0].hardware_version');
      const name = version.fields.find((field) => field.path === 'versions[0].model_name');
      model = shown(card) || shown(name) || '';
    }
    let interference = '';
    let interferenceLevel = null;
    if (itDetect) {
      const severities = [];
      for (const field of itDetect.fields) {
        const match = /^interference_statuses\[(\d+)\]\.severity(\d)$/.exec(field.path);
        if (match) severities.push(Number(field.value) || 0);
      }
      if (severities.length) {
        interferenceLevel = Math.max(...severities);
        interference = interferenceLevel > 0 ? 'Detected' : 'Not detected';
      }
    }
    return { model, interference, interferenceLevel };
  }

  function setBadge(node, tone, text) {
    if (!node) return;
    const labels = { good: 'Good', warn: 'Warning', bad: 'Error', off: 'Off', unknown: '--' };
    node.className = `pb-badge pb-badge-${tone}${node.classList.contains('pb-band-link') ? ' pb-band-link' : ''}`;
    node.textContent = text ?? labels[tone] ?? '--';
    node.dataset.tone = tone;
  }

  /** Sensor row badge: the receiver's own boundary limit wins when it flagged something. */
  function sensorTone(reading) {
    if (!reading) return 'unknown';
    return limitTone(reading.limit);
  }

  function renderDevice(file) {
    const d = file?.device;
    const extras = file?.extras ?? null;
    const set = (node, text, title) => {
      if (!node) return;
      node.textContent = text;
      if (title !== undefined) node.title = title;
    };
    const temp = d?.temperature ? `${fixed(d.temperature.value, 2)} °C` : '--';
    const volt = d?.antennaVoltage ? `${fixed(d.antennaVoltage.value, 2)} V` : '--';
    const amp = d?.antennaCurrent ? `${fixed(d.antennaCurrent.value, 2)} A` : '--';
    const cpu = d?.cpuUsage ? `${fixed(d.cpuUsage.value, 0)} %` : '--';

    set(el.devTemp, temp);
    set(el.devVoltage, volt);
    set(el.devCurrent, amp);
    set(el.devCpuRow, cpu, d?.cpuUsage ? undefined : 'HWMONITOR of this build carries no idleTime field');

    setBadge(el.devTempBadge, sensorTone(d?.temperature));
    setBadge(el.devVoltageBadge, sensorTone(d?.antennaVoltage));
    setBadge(el.devCurrentBadge, sensorTone(d?.antennaCurrent));
    setBadge(el.devCpuRowBadge, d?.cpuUsage ? sensorTone(d.cpuUsage) : 'unknown');

    // Summary bar, right half.
    set(el.devModel, extras?.model || '--', extras?.model ? undefined : 'Model needs VERSION (#37); this capture has none');
    set(el.devCpu, cpu, d?.cpuUsage ? undefined : 'CPU Usage is HWMONITOR idleTime — not in the binary HWMONITOR of this build');
    set(el.devLogging, '--', 'Logging needs LOGSTATUS / LOGLIST (#5); absent from every shipped capture');
    set(el.devStorage, '--', 'Storage Usage needs FILESYSTEMCAPACITY (#2137); absent from every shipped capture');
    set(el.devSpan, '--', 'SPAN needs INSPVAX (#1465); absent from every shipped capture');
    set(
      el.devInterference,
      extras?.interference || '--',
      extras?.interference
        ? `ITDETECTSTATUS (#2065) · highest severity ${extras.interferenceLevel}`
        : 'Interference needs ITDETECTSTATUS (#2065); this capture has none',
    );

    const rows = [d?.temperature, d?.antennaVoltage, d?.antennaCurrent, d?.cpuUsage].filter(Boolean);
    const unknown = [
      Boolean(extras?.model),
      Boolean(d?.cpuUsage),
      false, // Logging: no capture has it
      false, // Storage Usage: no capture has it
      Boolean(extras?.interference),
      false, // SPAN: no capture has it
    ].filter((known) => !known).length;
    const tone = deviceTone({ rows, unknown });
    setBadge(el.devBadge, tone);
    setBadge(el.cardDevBadge, tone);
    el.devBadge.title = deviceReason({ device: d, extras, tone });
  }

  /** Why the Device bar is amber/red — printed as the badge tooltip, `statusbar.js` dialog text. */
  function deviceReason({ device, extras, tone }) {
    const missing = [];
    if (!extras?.model) missing.push('Model (VERSION #37)');
    if (!device?.cpuUsage) missing.push('CPU Usage (HWMONITOR idleTime)');
    missing.push('Logging (LOGSTATUS / LOGLIST #5)');
    missing.push('Storage Usage (FILESYSTEMCAPACITY #2137)');
    if (!extras?.interference) missing.push('Interference (ITDETECTSTATUS #2065)');
    missing.push('SPAN (INSPVAX #1465)');
    if (tone === 'bad') return 'A device channel is over an error limit — see the Device tile.';
    if (tone === 'warn') return `Not everything could be checked; not in this capture: ${missing.join(' · ')}`;
    return 'Every device channel present in this capture is inside its accepted bounds.';
  }

  /* ---- Satellite View (RANGE #43) ---- */

  function buildRangeMap(file) {
    const map = new Array(file.frames.length).fill(-1);
    let ordinal = 0;
    for (let i = 0; i < file.frames.length; i++) {
      if (file.frames[i].messageId === RANGE) {
        map[i] = ordinal;
        ordinal += 1;
      }
    }
    file.rangeOrdinal = map;
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

  function renderSatellite(file) {
    const epoch = file && file.epochOrdinal >= 0 ? file.epochs.get(file.epochOrdinal) ?? null : null;
    let total = 0;
    for (const item of CONSTELLATIONS) {
      const inUse = item.system === null ? 0 : epoch ? (epoch.counts.get(item.system)?.size ?? 0) : 0;
      const seen = item.system === null || !file ? 0 : (file.seen.get(item.system)?.size ?? 0);
      const notUsed = Math.max(0, seen - inUse);
      total += inUse;
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (useNode) useNode.textContent = String(inUse);
      if (idleNode) idleNode.textContent = String(notUsed);
      if (missNode) missNode.textContent = '0';
    }

    const hasRange = Boolean(file && file.rangeOrdinal.some((ordinal) => ordinal >= 0));
    if (!file || !file.info) setBadge(el.satBadge, 'off');
    else if (epoch) setBadge(el.satBadge, total > 0 ? 'good' : 'warn');
    else setBadge(el.satBadge, hasRange ? 'warn' : 'off');

    const when = epoch && epoch.utc ? utcClock(epoch.utc) : '--:--:--';
    const satvisCount = fileCount(file, 1043);
    el.satNote.textContent = file && file.info
      ? `RANGE (#43) epoch ${when} UTC · ${total} tracked PRNs · ` +
        `${epoch ? 'In Use = PRNs in this epoch, Not Used = seen earlier in this capture' : 'no RANGE record yet'}` +
        (satvisCount > 0
          ? ` · SATVIS2 (#1043) is in this capture (${satvisCount}) but Missing is still not derived from it`
          : ' · Missing needs SATVIS2 (absent in this capture)')
      : 'Counting RANGE (#43) observations at the play head.';
  }

  /** How many records of a message id the capture holds (`/api/playback/info.messageCounts`). */
  function fileCount(file, messageId) {
    const list = file?.info?.messageCounts ?? [];
    for (const item of list) if (Number(item.id) === messageId) return Number(item.count) || 0;
    return 0;
  }

  function requestEpoch(file, ordinal) {
    if (!file) return;
    if (ordinal < 0) {
      file.epochOrdinal = -2;
      if (file === current()) renderSatellite(file);
      return;
    }
    if (file.epochs.has(ordinal)) {
      file.epochOrdinal = ordinal;
      if (file === current()) renderSatellite(file);
      return;
    }
    if (file.epochPending) {
      file.epochWanted = ordinal;
      return;
    }
    file.epochPending = true;
    const wanted = file.path;
    api
      .get('/api/records', { capture: file.path, msgId: RANGE, offset: ordinal, limit: 1 })
      .then((data) => {
        if (!state.alive || file.path !== wanted) return;
        const record = data.records && data.records[0];
        if (record) {
          const parsed = parseEpoch(record);
          file.epochs.set(ordinal, parsed);
          for (const [system, prns] of parsed.counts) {
            if (!file.seen.has(system)) file.seen.set(system, new Set());
            for (const prn of prns) file.seen.get(system).add(prn);
          }
          while (file.epochs.size > 40) {
            const oldest = file.epochs.keys().next().value;
            if (oldest === undefined) break;
            file.epochs.delete(oldest);
          }
        }
        file.epochOrdinal = ordinal;
        if (file === current()) renderSatellite(file);
      })
      .catch(() => {
        /* a missing RANGE record only empties the counters — never worth a banner */
      })
      .finally(() => {
        file.epochPending = false;
        const next = file.epochWanted;
        file.epochWanted = -2;
        if (state.alive && next >= 0 && next !== ordinal) requestEpoch(file, next);
      });
  }

  function syncSatellite(file) {
    if (!file || !file.frames.length) return;
    const index = frameIndexAt(file, file.time);
    const ordinal = file.rangeOrdinal[index] ?? -1;
    if (ordinal === file.epochOrdinal) return;
    requestEpoch(file, ordinal);
  }

  /* ---- transport (§3.2.4) ---- */

  function frameIndexAt(file, seconds) {
    const frames = file?.frames ?? [];
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

  /**
   * Record ticks under the scrub bar — one tick per captured record, coloured by message id.
   *
   * The **event** strip is the sibling `renderEvents()` below: the original paints receiver events
   * there instead (red = error, amber = warning, `playbackcontrol.html:23` `.playback-events`),
   * which the D1 work now feeds from the capture's own `ITDETECTSTATUS` / `RXSTATUS` /
   * `RXSTATUSEVENT` records. Ticks stay because the record density is still worth seeing.
   */
  function renderTicks(file) {
    if (!file || !file.frames.length || !file.duration) {
      el.ticks.innerHTML = '';
      return;
    }
    const colors = {};
    const parts = [];
    for (const frame of file.frames) {
      const key = String(frame.messageId);
      if (!colors[key]) colors[key] = TICK_COLORS[Object.keys(colors).length % TICK_COLORS.length];
      const left = (frame.offsetMs / (file.duration * 1000)) * 100;
      parts.push(
        `<span class="pb-tick" title="${esc(`${frame.name} #${frame.index + 1} · ${(frame.offsetMs / 1000).toFixed(3)} s`)}" ` +
          `style="left:${left.toFixed(3)}%;background:${colors[key]}"></span>`,
      );
    }
    el.ticks.innerHTML = parts.join('');
  }

  /**
   * The event strip of one capture (`/api/playback/events`).
   *
   * Markers are `<button>`s: the original's are `<div id="btn-event">` with a click handler
   * (`playbackview.js:194-253`), and a keyboard-reachable element keeps that usable. Clicking one
   * opens the tooltip and **does not move the play head** — measured on the original: the handler
   * never calls `onProgressbarSeek` / `updateTimeOnMove`, it only shows `.pb-events`. Hover shows the
   * same text without pinning it (the original has click-only; the hover is this page's addition,
   * the manual's "Show Events" tooltip has to be discoverable).
   */
  function renderEvents(file) {
    el.events.innerHTML = '';
    el.events.hidden = !file || !state.showEvents;
    el.showEvents.checked = state.showEvents;
    if (!file || !state.showEvents) {
      hideEventPop();
      return;
    }
    if (!file.ready) {
      el.events.innerHTML = '<span class="pb-events-note">Reading events…</span>';
      return;
    }
    const markers = eventMarkers(file.events, file.duration);
    if (!markers.length) {
      // An empty strip says *why* it is empty; a blank row would read as "still loading".
      el.events.innerHTML = `<span class="pb-events-note">${esc(eventsEmptyNote(file.eventSources))}</span>`;
      return;
    }
    if (state.selectedEvent >= markers.length) state.selectedEvent = -1;
    el.events.innerHTML = markers
      .map((marker, index) => {
        const event = marker.event;
        const label = eventTooltipText(event);
        const selected = state.selectedEvent === index;
        return (
          `<button type="button" class="pb-event pb-event-${esc(marker.severity.toLowerCase())}` +
          `${selected ? ' is-selected' : ''}" data-role="event-marker" data-index="${index}" ` +
          `style="left:${marker.left.toFixed(3)}%" ` +
          `title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${selected}"></button>`
        );
      })
      .join('');
  }

  /** The pinned tooltip. Its text is the original's line plus the record it came from. */
  function showEventPop(index) {
    const file = current();
    if (!file) return;
    const markers = eventMarkers(file.events, file.duration);
    const marker = markers[index];
    const node = el.events.querySelector(`[data-index="${index}"]`);
    if (!marker || !node) {
      hideEventPop();
      return;
    }
    el.eventPopText.textContent = eventTooltipText(marker.event);
    const ended = marker.event.endTime === null || marker.event.endTime === undefined;
    el.eventPopSource.textContent =
      `${marker.event.source} · ${clockText(marker.time)} → ` +
      (ended ? 'still reported at the end' : clockText(marker.event.endTime));
    el.eventPop.hidden = false;
    const rect = node.getBoundingClientRect();
    const width = el.eventPop.offsetWidth;
    const height = el.eventPop.offsetHeight;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
    const top = Math.max(rect.top - height - 10, 8);
    el.eventPop.style.left = `${left}px`;
    el.eventPop.style.top = `${top}px`;
  }

  function hideEventPop() {
    el.eventPop.hidden = true;
    for (const node of el.events.querySelectorAll('.pb-event')) {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    }
  }

  /** Which marker a click selects — the original's `data-event-count` toggle, nothing else. */
  function selectEvent(index) {
    state.selectedEvent = nextEventSelection(state.selectedEvent, index);
    // Repaint in place instead of rebuilding the strip: replacing the node under the cursor would
    // fire a fresh `mouseover` and immediately re-open the tooltip the click just closed.
    for (const node of el.events.querySelectorAll('[data-role="event-marker"]')) {
      const active = Number(node.dataset.index) === state.selectedEvent;
      node.classList.toggle('is-selected', active);
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (state.selectedEvent >= 0) showEventPop(state.selectedEvent);
    else hideEventPop();
  }

  function renderSnippet(file) {
    if (!file || !file.duration) {
      el.snippet.hidden = true;
      return;
    }
    const from = Math.min(Math.max(file.from, 0), file.duration);
    const to = Math.min(Math.max(file.to, 0), file.duration);
    if (to <= from) {
      el.snippet.hidden = true;
      return;
    }
    el.snippet.hidden = false;
    el.snippet.style.left = `${((from / file.duration) * 100).toFixed(3)}%`;
    el.snippet.style.width = `${(((to - from) / file.duration) * 100).toFixed(3)}%`;
  }

  function renderClock(file) {
    const duration = file?.duration ?? 0;
    const time = file?.time ?? 0;
    const ratio = duration ? time / duration : 0;
    el.fill.style.width = `${(ratio * 100).toFixed(4)}%`;
    el.clock.textContent = clockText(time);
    el.duration.textContent = clockText(duration);
    el.bar.setAttribute('aria-valuenow', time.toFixed(3));
    el.bar.setAttribute('aria-valuemax', duration.toFixed(3));
    el.bar.setAttribute('aria-valuetext', `${clockText(time)} of ${clockText(duration)}`);
  }

  /** UTC of the record under the play head, computed from the capture's first UTC + the offset. */
  function frameUtc(file) {
    if (!file || !file.info || !file.info.startUtc) return '--:--:--';
    const base = Date.parse(file.info.startUtc);
    if (Number.isNaN(base)) return '--:--:--';
    return utcClock(new Date(base + file.time * 1000).toISOString());
  }

  function atEnd(file) {
    return Boolean(file && file.duration > 0 && file.time >= file.duration - 1e-9);
  }

  function setPlayButton() {
    const file = current();
    const ended = !state.playing && atEnd(file);
    el.play.classList.toggle('is-playing', state.playing);
    el.play.classList.toggle('is-ended', ended);
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : ended ? 'Replay' : 'Play');
    el.play.disabled = !file;
  }

  function renderRecord(file) {
    if (!file) {
      el.frameName.textContent = '--';
      el.frameNote.textContent = '';
      return;
    }
    const index = frameIndexAt(file, file.time);
    if (index < 0) {
      el.frameName.textContent = '--';
      el.frameNote.textContent = '';
      return;
    }
    const frame = file.frames[index];
    el.frameName.textContent = `${frame.name} · #${frame.index + 1} / ${file.frames.length}`;
    el.frameNote.textContent = `offset ${clockText(frame.time)} · ${frame.bytes} B record`;

    if (index === file.detailIndex) return;
    file.detailIndex = index;
    if (!el.frameBody.hidden) {
      el.frameBody.innerHTML = '<p class="pb-empty">Decoding…</p>';
      fetchFrameDetail(file, index);
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

  function fetchFrameDetail(file, index) {
    if (file.detailPending) {
      file.pendingDetail = index;
      return;
    }
    file.detailPending = true;
    const wanted = file.path;
    api
      .get('/api/playback/frame', { capture: file.path, index })
      .then((data) => {
        if (!state.alive || file.path !== wanted || file.detailIndex !== index) return;
        if (file === current()) renderFrameFields(data);
      })
      .catch(() => {
        /* a frame that scrolled out while the request was in flight is not worth a banner */
      })
      .finally(() => {
        file.detailPending = false;
        const next = file.pendingDetail;
        file.pendingDetail = null;
        if (state.alive && next !== null && next !== index) fetchFrameDetail(file, next);
      });
  }

  function updateDashboard(file) {
    el.devTime.textContent = frameUtc(file);
    renderRecord(file);
    syncSatellite(file);
  }

  function setTime(seconds) {
    const file = current();
    if (!file) return;
    file.time = Math.min(Math.max(seconds, 0), file.duration);
    renderClock(file);
    updateDashboard(file);
    setPlayButton();
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
    const file = current();
    if (!state.playing || !file) return;
    if (!state.last) state.last = now;
    let delta = now - state.last;
    state.last = now;
    if (delta > 250) delta = 250; // tab was hidden: never jump the whole capture
    setTime(file.time + (delta * state.speed) / 1000);
    if (file.time >= file.duration - 1e-9) {
      stop();
      setTime(file.duration);
      el.frameNote.textContent = `end of capture · ${clockText(file.duration)}`;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    const file = current();
    if (!file || state.playing) return;
    if (atEnd(file)) setTime(0);
    state.playing = true;
    state.last = 0;
    setPlayButton();
    state.raf = requestAnimationFrame(tick);
  }

  /* ---- snippet / export ---- */

  function exportUrl(file, from, to) {
    return withQuery('/api/playback/export', { capture: file.path, from: from.toFixed(3), to: to.toFixed(3) });
  }

  function syncSnippet(file) {
    if (!file) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Load a timeline first.';
      return;
    }
    const from = Number(el.from.value);
    const to = Number(el.to.value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from > to) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Invalid range: need 0 ≤ from ≤ to.';
      return;
    }
    file.from = from;
    file.to = Math.min(to, file.duration);
    renderSnippet(file);
    el.download.disabled = false;
    el.snippetBtn.disabled = false;
    el.snippetNote.textContent =
      `[ ${from.toFixed(3)} s , ${file.to.toFixed(3)} s ] of ${clockText(file.duration)}` +
      ` · ${(((file.to - from) / (file.duration || 1)) * 100).toFixed(1)}% of the capture`;
  }

  function download(file, from, to) {
    if (!file) return;
    const anchor = document.createElement('a');
    anchor.href = exportUrl(file, from, to);
    const stem = (file.path.split('/').pop() || 'capture').replace(/\.[^.]+$/, '');
    anchor.download = `${stem}_${from.toFixed(3)}-${to.toFixed(3)}.sbf`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  /* ---- open / activate / close ---- */

  /** Repaint every block from one file record — used on load, on tab switch and after a probe. */
  function applyFile(file) {
    el.ticks.innerHTML = '';
    el.snippet.hidden = true;
    el.frameBody.hidden = true;
    el.frameToggle.setAttribute('aria-expanded', 'false');
    el.frameBody.innerHTML = '';
    file.detailIndex = -1;
    state.selectedEvent = -1;
    hideEventPop();
    renderShell();
    renderPosition(file);
    renderDevice(file);
    renderSatellite(file);
    renderTicks(file);
    renderEvents(file);
    el.start.textContent = utcClock(file.info?.startUtc);
    el.end.textContent = utcClock(file.info?.finishUtc);
    el.from.value = String(file.from ?? 0);
    el.to.value = file.duration ? file.duration.toFixed(3) : '0';
    syncSnippet(file);
    setPlayButton();
    renderClock(file);
    updateDashboard(file);
    syncShellCapture(file.path);
    if (file.frames.length) syncSatellite(file);
  }

  function activate(index) {
    if (index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    if (state.active !== index) {
      stop();
      state.active = index;
    }
    applyFile(file);
  }

  async function load(path) {
    const existing = state.files.findIndex((file) => file.path === path);
    if (existing >= 0) {
      activate(existing);
      return;
    }
    alert('');
    const probe = async (msgId) => {
      try {
        const data = await api.get('/api/records', { capture: path, msgId, offset: 0, limit: 1 });
        return data.records && data.records[0] ? data.records[0] : null;
      } catch {
        return null;
      }
    };

    const file = makeFile(path);
    state.files.push(file);
    state.active = state.files.length - 1;
    stop();
    renderShell();
    applyFile(file);
    closeDialog();

    try {
      const [info, frames, events] = await Promise.all([
        api.get('/api/playback/info', { capture: path }),
        api.post('/api/playback/frames', { capture: path }),
        // A capture with no event log answers `count: 0`; the page then shows its empty state.
        api.get('/api/playback/events', { capture: path }).catch(() => null),
      ]);
      if (!state.alive) return;
      file.info = info;
      file.frames = frames.frames ?? [];
      file.events = Array.isArray(events?.events) ? events.events : [];
      file.eventSources = events?.sources ?? null;
      file.duration = (info.durationMs || 0) / 1000;
      file.time = 0;
      file.from = 0;
      file.to = file.duration;
      buildRangeMap(file);
      rememberRecent(info);

      // The dashboard fails soft: a capture without BESTPOS / HWMONITOR still shows the bar.
      const [bestpos, hw, version, itDetect] = await Promise.all([
        probe(BESTPOS),
        probe(HWMONITOR),
        probe(VERSION),
        probe(ITDETECTSTATUS),
      ]);
      if (!state.alive) return;
      file.position = readPosition(bestpos);
      file.device = readDevice(hw);
      file.extras = readExtras(version, itDetect);
      file.ready = true;
      if (file === current()) applyFile(file);
      else renderFileTabs();
    } catch (error) {
      if (!state.alive) return;
      alert(`Timeline failed: ${error.message}`);
      closeFile(state.files.indexOf(file));
    }
  }

  function closeFile(index) {
    if (index < 0 || index >= state.files.length) return;
    const wasActive = index === state.active;
    const nextActive = nextActiveAfterClose(state.files.length, state.active, index);
    state.files.splice(index, 1);
    if (!state.files.length) {
      stop();
      state.active = -1;
      el.ticks.innerHTML = '';
      renderEvents(null);
      el.frameBody.hidden = true;
      el.snippet.hidden = true;
      alert('');
      renderShell();
      return;
    }
    if (wasActive) {
      stop();
      state.active = nextActive;
      applyFile(current());
    } else {
      state.active = nextActive;
      renderFileTabs();
    }
  }

  /* ---- pointer + keyboard on the scrub strip ---- */

  function seekFromEvent(event) {
    const file = current();
    if (!file) return;
    const rect = el.bar.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    setTime(ratio * file.duration);
  }

  let dragging = false;
  const onBarDown = (event) => {
    if (!current()) return;
    // A marker sits on the bar: pressing it must not seek. Clicking one only opens its tooltip
    // (``playbackview.js``:194-253 — the original's handler never calls `onProgressbarSeek`).
    if (event.target.closest('[data-role="event-marker"]')) return;
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
    const file = current();
    if (!file) return;
    // The marker buttons live inside the bar; their own Enter/Space has to reach them, not the
    // transport's play/pause.
    if (event.target.closest('[data-role="event-marker"]')) return;
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stop();
      setTime(file.time + step);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stop();
      setTime(file.time - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setTime(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setTime(file.duration);
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
    const file = current();
    if (!file) return;
    stop();
    setTime(file.time - REWIND_SECONDS);
  };
  const onSpeed = () => {
    const value = Number(el.speed.value);
    state.speed = PLAYBACK_SPEEDS.includes(value) ? value : PLAYBACK_SPEEDS[0];
    state.last = 0;
  };
  const onRange = () => syncSnippet(current());
  const onDownload = () => {
    const file = current();
    if (file) download(file, file.from, file.to);
  };
  const onSnippet = () => {
    const file = current();
    if (file) download(file, file.from, file.to);
  };

  /* ---- event strip: hover preview, click pins (never seeks), Show Events switch ---- */

  const onEventOver = (event) => {
    const marker = event.target.closest('[data-role="event-marker"]');
    if (!marker || state.selectedEvent >= 0) return;
    showEventPop(Number(marker.dataset.index));
  };
  const onEventOut = (event) => {
    if (!event.target.closest('[data-role="event-marker"]')) return;
    if (state.selectedEvent >= 0) return; // a pinned tooltip stays until it is closed
    el.eventPop.hidden = true;
  };
  const onEventClick = (event) => {
    const marker = event.target.closest('[data-role="event-marker"]');
    if (!marker) return;
    // No `setTime` here on purpose: the original only opens the popup (`playbackview.js:194-253`).
    event.preventDefault();
    event.stopPropagation();
    selectEvent(Number(marker.dataset.index));
  };
  const onEventFocus = (event) => {
    const marker = event.target.closest('[data-role="event-marker"]');
    if (marker && state.selectedEvent < 0) showEventPop(Number(marker.dataset.index));
  };
  const onEventBlur = (event) => {
    if (event.target.closest('[data-role="event-marker"]') && state.selectedEvent < 0) {
      el.eventPop.hidden = true;
    }
  };
  const onEventPopClose = () => {
    state.selectedEvent = -1;
    hideEventPop();
  };
  const onShowEvents = () => {
    state.showEvents = el.showEvents.checked;
    state.selectedEvent = -1;
    try {
      storage.set(SHOW_EVENTS_KEY, state.showEvents ? 'true' : 'false');
    } catch {
      /* see defaultStorage() */
    }
    renderEvents(current());
  };

  function toggleDock() {
    const open = el.drawer.hidden;
    el.drawer.hidden = !open;
    el.dockToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.dock.classList.toggle('is-open', open);
    if (open && current()) setTime(current().time);
  }

  const onDock = () => toggleDock();
  const onFrameToggle = () => {
    const file = current();
    const open = el.frameBody.hidden;
    el.frameBody.hidden = !open;
    el.frameToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && file) {
      file.detailIndex = -1;
      renderRecord(file);
    }
  };

  const onOpen = () => openDialog();
  const onDialogClose = () => closeDialog();
  const onDialogBackdrop = (event) => {
    if (event.target === el.dialog) closeDialog();
  };
  const onDialogKey = (event) => {
    if (event.key !== 'Escape') return;
    if (!el.dialog.hidden) closeDialog();
    else if (!el.eventPop.hidden) onEventPopClose();
  };
  const onDialogClick = (event) => {
    const item = event.target.closest('[data-role="open-capture"]');
    if (!item) return;
    load(item.dataset.path);
  };

  /* Files bar: activate / close one tab, or open another file with the trailing "+". */
  const onFileTabClick = (event) => {
    if (event.target.closest('[data-el="openMore"]')) {
      openDialog();
      return;
    }
    const close = event.target.closest('[data-role="close-file"]');
    if (close) {
      event.stopPropagation();
      closeFile(Number(close.dataset.index));
      return;
    }
    const tab = event.target.closest('[data-role="activate-file"]');
    if (tab) activate(Number(tab.dataset.index));
  };
  const onFileTabKey = (event) => {
    if (event.target.closest('[data-el="openMore"]') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openDialog();
      return;
    }
    const tab = event.target.closest('[data-role="activate-file"]');
    if (!tab) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(Number(tab.dataset.index));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      closeFile(Number(tab.dataset.index));
    }
  };

  /* Recent Activity: click a tile to open it, ✕ to forget it. */
  const onRecentClick = (event) => {
    const forget = event.target.closest('[data-role="forget-recent"]');
    if (forget) {
      event.stopPropagation();
      writeRecent(forgetRecent(state.recent, forget.dataset.path));
      return;
    }
    const tile = event.target.closest('[data-role="open-recent"]');
    if (tile) load(tile.dataset.path);
  };
  const onRecentKey = (event) => {
    const tile = event.target.closest('[data-role="open-recent"]');
    if (!tile) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      load(tile.dataset.path);
    }
  };

  /* Summary bar → tile (manual §3.2.2: "check the status tiles … an amber or red bar appears on the
   * status tile where more information can be found"). Clicking the bar scrolls to that tile and
   * pulses it. */
  const onBandBadge = (event) => {
    const which = event.currentTarget === el.devBadge ? 'device' : 'positioning';
    const tile = root.querySelector(`[data-tile="${which}"]`);
    if (!tile) return;
    tile.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tile.classList.remove('is-flash');
    // reflow so the animation restarts on a second click
    void tile.offsetWidth;
    tile.classList.add('is-flash');
  };

  const onHelp = (event) => {
    const which = event.currentTarget.dataset.el;
    event.preventDefault();
    const notes = {
      helpPosition:
        'Positioning comes from the first BESTPOS (#42) record of the capture: Position / Latitude / ' +
        'Longitude / Height (MSL) / Datum are its own fields, Height Accuracy is height_std_dev and ' +
        '2d-SD is sqrt(latitude_std_dev² + longitude_std_dev²). The Position box is the type currently ' +
        'in use; the configured types the manual lists come from config logs (SBASCONTROL / INTERFACEMODE / ' +
        'NTRIPCONFIG …), none of which is in these captures. The bar is red for INSUFFICIENT_OBS / ' +
        'NO_CONVERGENCE / INVALID_FIX / INTEGRITY_WARNING, amber when the highest configured accuracy ' +
        'mode is not the active one, green otherwise.',
      helpDevice:
        'Device rows come from HWMONITOR (#963) measurements, keyed by (status >> 8) & 0xff: ' +
        '1 Temperature · 2 Antenna Current · 7 Antenna Voltage. Each badge repeats the receiver’s own ' +
        'boundary limit (status & 0xff): 1/3 warning, 2/4 error. CPU Usage is idleTime (100 − raw/2) in ' +
        'GRIT, and the binary HWMONITOR of this capture does not carry that field, so it reads --. ' +
        'The bar is amber while part of the picture (Model · CPU · Logging · Storage · Interference · SPAN) ' +
        'is not in the capture, and red as soon as a channel is over an error limit.',
      helpSatellite:
        'The original tile counts SATVIS2 (#1043) — the visible-satellite list with azimuth/elevation. ' +
        'This page counts the RANGE (#43) observations of the epoch at the play head instead: In Use = ' +
        'distinct sv_prn per constellation (system = (c_status >> 16) & 7), Not Used = PRNs already seen ' +
        'earlier in the capture but missing now. Missing is left at 0 because deriving it needs a rule for ' +
        '“should be visible” that SATVIS2 alone does not state. RANGE has no azimuth/elevation, so the sky ' +
        'plot stays an empty grid even when the capture carries SATVIS2.',
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
  el.recent.addEventListener('click', onRecentClick);
  el.recent.addEventListener('keydown', onRecentKey);
  el.posBadge.addEventListener('click', onBandBadge);
  el.devBadge.addEventListener('click', onBandBadge);
  el.helpPosition.addEventListener('click', onHelp);
  el.helpDevice.addEventListener('click', onHelp);
  el.helpSatellite.addEventListener('click', onHelp);
  el.events.addEventListener('mouseover', onEventOver);
  el.events.addEventListener('mouseout', onEventOut);
  el.events.addEventListener('click', onEventClick);
  el.events.addEventListener('focusin', onEventFocus);
  el.events.addEventListener('focusout', onEventBlur);
  el.eventPopClose.addEventListener('click', onEventPopClose);
  el.showEvents.addEventListener('change', onShowEvents);
  document.addEventListener('keydown', onDialogKey);
  if (fileTabs) {
    fileTabs.addEventListener('click', onFileTabClick);
    fileTabs.addEventListener('keydown', onFileTabKey);
  }

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name) return;
      if (state.files.some((file) => file.path === name)) return;
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
    el.recent.removeEventListener('click', onRecentClick);
    el.recent.removeEventListener('keydown', onRecentKey);
    el.posBadge.removeEventListener('click', onBandBadge);
    el.devBadge.removeEventListener('click', onBandBadge);
    el.helpPosition.removeEventListener('click', onHelp);
    el.helpDevice.removeEventListener('click', onHelp);
    el.helpSatellite.removeEventListener('click', onHelp);
    el.events.removeEventListener('mouseover', onEventOver);
    el.events.removeEventListener('mouseout', onEventOut);
    el.events.removeEventListener('click', onEventClick);
    el.events.removeEventListener('focusin', onEventFocus);
    el.events.removeEventListener('focusout', onEventBlur);
    el.eventPopClose.removeEventListener('click', onEventPopClose);
    el.showEvents.removeEventListener('change', onShowEvents);
    document.removeEventListener('keydown', onDialogKey);
    if (fileTabs) {
      fileTabs.removeEventListener('click', onFileTabClick);
      fileTabs.removeEventListener('keydown', onFileTabKey);
      fileTabs.remove();
    }
    if (offCapture) offCapture();
  };

  state.recent = readRecent();
  setPlayButton();
  renderShell();
  renderPosition(null);
  renderDevice(null);
  renderSatellite(null);
  renderEvents(null);

  /* Boot: read the capture list, then either show Recent Activity (§3.1) or open the capture the
   * shell has selected when there is nothing recent to show. */
  api
    .get('/api/captures')
    .then(async (data) => {
      if (!state.alive) return;
      state.captures = data.captures ?? [];
      fillCaptures();
      const known = new Set(state.captures.map((item) => item.path));
      const kept = state.recent.filter((item) => known.has(item.path));
      if (kept.length !== state.recent.length) writeRecent(kept);
      else renderRecent();

      const preferred =
        state.captures.find((item) => item.path === state.preferPath) ||
        state.captures.find((item) => item.path === 'convert/clean-9600.gps') ||
        state.captures.find((item) => item.name === 'clean-9600.gps') ||
        state.captures[0];
      if (state.recent.length) {
        // Landing screen: the manual's §3.1 opening state.
        renderShell();
      } else if (preferred) {
        await load(preferred.path);
      } else {
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
