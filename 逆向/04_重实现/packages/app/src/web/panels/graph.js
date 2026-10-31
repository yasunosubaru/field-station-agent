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
 *   honest    PVT / Tracking & Measurements / Receiver Status / Project Information: this build only
 *             implements Overview, the tabs say so instead of inventing charts
 *             the map itself: there is no Luciad in this repo, the stage shows the chart and the
 *             control column is decoration (`aria-hidden`, no handlers)
 *
 * Contract with the shell (`src/web/index.html`): `mount(root, ctx)` / `unmount(root)`,
 * `ctx = { api: { get, post }, capture, onCaptureChange }`.
 */

const CSS_URL = new URL('./graph.css', import.meta.url).href;
const CSS_ID = 'nas-panel-graph-css';

/** The CSV the old in-shell page opened first, kept so the panel still lands on a useful series. */
const PREFERRED_CSV = 'GNSS Signal Strength.csv';

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

function fmtNum(value) {
  if (!isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-4)) return value.toExponential(2);
  return String(Math.round(value * 1000) / 1000);
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

  const panes = TABS.map((tab, index) => {
    if (tab.id === 'overview') {
      return '<div class="gp-pane" data-pane="overview" role="tabpanel" aria-labelledby="gp-tab-overview">'
        + '<div class="gp-chart"></div>'
        + '<div class="gp-playhead" hidden><span class="gp-playhead-dot"></span></div>'
        + '</div>';
    }
    return `<div class="gp-pane" data-pane="${tab.id}" role="tabpanel" aria-labelledby="gp-tab-${tab.id}" hidden>`
      + '<div class="gp-placeholder">'
      + `<h3>${esc(tab.label)}</h3>`
      + '<p>本构建仅实现 <strong>Overview</strong>。'
      + `${esc(tab.label)} 的解析器与图表没有移植，这个页签没有数据可画，也不拿别的列冒充。</p>`
      + '<p class="gp-placeholder-hint">数据仍来自 <code>/api/graph/*</code>；'
      + '切回 Overview 可以看折线、列选择与前 20 行。</p>'
      + '</div></div>';
  }).join('');

  return `
<div class="graph-panel" data-view="home">
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

      <div class="gp-mapcontrols" aria-hidden="true">
        <span class="gp-mapbtn gp-compass">${ICON_COMPASS}</span>
        <span class="gp-mapbtn gp-recenter">${ICON_RECENTER}</span>
        <span class="gp-mapbtn gp-zoomin">${ICON_ZOOM_IN}</span>
        <span class="gp-mapbtn gp-zoomout">${ICON_ZOOM_OUT}</span>
        <span class="gp-mapbtn gp-fit">${ICON_FIT}</span>
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
    fileSelect: $('fileSelect'),
    columnSelect: $('columnSelect'),
    meta: $('meta'),
    tableNote: $('tableNote'),
    tableHead: $('tableHead'),
    tableBody: $('tableBody'),
    notice: $('notice'),
    chart: root.querySelector('.gp-chart'),
    playhead: root.querySelector('.gp-playhead'),
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
  };

  /* ---- small UI helpers ---- */

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
    if (view === 'work') requestAnimationFrame(() => drawChart());
  }

  function setTab(id) {
    state.tab = id;
    for (const button of root.querySelectorAll('[data-worktab]')) {
      const active = button.dataset.worktab === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of root.querySelectorAll('.gp-pane')) {
      pane.hidden = pane.dataset.pane !== id;
    }
    if (id === 'overview') requestAnimationFrame(() => drawChart());
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

  function paneBox() {
    const pane = root.querySelector('.gp-pane[data-pane="overview"]');
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    return { width: Math.max(320, Math.round(rect.width)), height: Math.max(200, Math.round(rect.height)) };
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

    const parts = [
      `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(series.label || '折线图')}">`,
    ];
    for (let i = 0; i <= 4; i += 1) {
      const yValue = yMin + ((yMax - yMin) * i) / 4;
      const yPos = py(yValue);
      parts.push(
        `<line x1="${pad.left}" y1="${yPos.toFixed(1)}" x2="${width - pad.right}" y2="${yPos.toFixed(1)}" stroke="rgba(0,0,0,0.12)"/>`,
      );
      parts.push(
        `<text x="${pad.left - 10}" y="${(yPos + 3.5).toFixed(1)}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="end" font-family="Consolas, monospace">${esc(fmtNum(yValue))}</text>`,
      );
    }
    for (let k = 0; k <= 4; k += 1) {
      const xValue = xMin + ((xMax - xMin) * k) / 4;
      const xPos = px(xValue);
      parts.push(
        `<line x1="${xPos.toFixed(1)}" y1="${pad.top}" x2="${xPos.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(0,0,0,0.08)"/>`,
      );
      parts.push(
        `<text x="${xPos.toFixed(1)}" y="${pad.top + plotH + 18}" font-size="11" fill="rgba(0,0,0,0.6)" text-anchor="middle" font-family="Consolas, monospace">${esc(fmtNum(xValue))}</text>`,
      );
    }
    parts.push(
      `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
      `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9B9B9B"/>`,
      `<polyline fill="none" stroke="#00516F" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${points
        .map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`)
        .join(' ')}"/>`,
    );
    if (points.length <= 120) {
      parts.push(
        points
          .map((p) => `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="2.2" fill="#00ABC8"/>`)
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
    const box = paneBox();
    if (!box) return;
    const data = state.data;
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
    } catch (error) {
      renderCards();
      el.homeStatus.textContent = `读取 CSV 列表失败：${error.message}`;
      showNotice(`读取 CSV 列表失败：${error.message}`);
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
        ? `<span class="gp-swatch"></span><span class="gp-series-name">${esc(data.column)}</span>`
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
    if (state.view !== 'work' || state.tab !== 'overview') return;
    drawChart();
  }

  root.addEventListener('click', onRootClick);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
  if (el.fileSelect) el.fileSelect.addEventListener('change', onFileChange);
  if (el.columnSelect) el.columnSelect.addEventListener('change', onColumnChange);
  if (el.speed) el.speed.addEventListener('change', onSpeedChange);

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
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
    if (el.fileSelect) el.fileSelect.removeEventListener('change', onFileChange);
    if (el.columnSelect) el.columnSelect.removeEventListener('change', onColumnChange);
    if (el.speed) el.speed.removeEventListener('change', onSpeedChange);
  };

  setView('home');
  setTab('overview');
  setLegend(false);
  updateTimeline();
  void loadFiles();
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
