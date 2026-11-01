/**
 * `ExportHTMLReport` — one **self-contained** HTML report built from the CSV chart data.
 *
 * The original Graph writes `clean.html` (331 KB) as an ECharts page: an `h1`, a *Report Information*
 * block, a *Project Information* block (project name / directory / data file / start / end /
 * duration + a message summary) and then one section per chart family, each holding a container with
 * a chart title, the ECharts canvas and a legend
 * (`00_来源/samples/graph/export/clean.html` — read for structure only).
 *
 * We reproduce that **information structure**, not its pixels:
 *
 * ```
 * <h1>clean Report</h1>
 * Report Information   → Generated Date
 * Project Information  → the six fields the CSV comment header carries (same spellings)
 *                        + Message Summary (the messages the reported charts are fed by)
 * <h2>PVT | Tracking & Measurements | Receiver Status</h2>   ← clean.html's section names
 *   <article>  <h3>chart title</h3>  <svg>…polylines…</svg>  <legend>  <table>first N rows</table>
 * ```
 *
 * Input is the **CSV text itself** (the six `#` comment lines + the data table), so this file does
 * not re-derive anything: every number in the report comes from the bytes Graph would have written.
 * Consequences worth knowing:
 *
 *  - The header times/duration are read out of the `#` lines, so they are *by construction* the same
 *    strings as `csv/…csv` (`2442,463097.350`, `00:00:04`). The project object is the fallback for
 *    a report built without charts.
 *  - Table cells are printed **verbatim** (per-column decimals stay per-column: `1.19761` next to
 *    `0.000000`), only the chart geometry parses them to `number`.
 *  - No external resource of any kind: no `<script>`, no font, no `xmlns` URL — the SVG namespace is
 *    implied for inline SVG in HTML5. A test asserts the document contains no `http://`/`https://`.
 *  - Each chart section holds exactly one `<svg>` with **one `<polyline>` per plotted column** and
 *    one point per CSV row, plus a table of the first {@link DEFAULT_TABLE_ROWS} rows (never the
 *    whole CSV — `Tracking Time` alone is 74 KB of cells).
 *  - Up to {@link MAX_PANELS} columns get one panel each with its own Y range; wider charts share one
 *    Y axis. See {@link renderPlot} for why the split is drawn there.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GraphProject } from './project.ts';
import { chartMessages } from './project.ts';
import { formatDuration, formatGpsCommentTime } from './format.ts';

/** One chart's CSV, as Graph writes it (UTF-8 BOM tolerated, `#` comments + data table). */
export interface HtmlChartSource {
  /** Chart title — also the CSV file name without `.csv`. */
  title: string;
  /** CSV bytes or already-decoded text. */
  csv: string | Uint8Array;
}

export interface HtmlReportOptions {
  /** Data rows shown under each chart (default {@link DEFAULT_TABLE_ROWS}). */
  tableRows?: number;
  /**
   * Value of the *Generated Date* row. Pass a fixed string to make the output reproducible; the
   * default is the current local time (`YYYY/MM/DD HH:mm:ss`, the original's spelling).
   */
  generatedAt?: string;
  /** Keep only these chart titles (Graph's `selectedPlots`). */
  selectedPlots?: string[];
  /** Document heading; default `<projectName> Report`. */
  title?: string;
}

/** Rows of the per-chart data table. The CSV itself is never embedded in full. */
export const DEFAULT_TABLE_ROWS = 20;

/**
 * Section names and membership, as `clean.html` groups them (`chart-container-title`). `2D Trajectory`
 * sits in PVT there too; the *Trajectory Plot* section of the original holds a map image, which is
 * not rendered here (see `03_分析/06_Graph应用.md §12`).
 */
const SECTIONS: { name: string; titles: string[] }[] = [
  {
    name: 'PVT',
    titles: ['2D Trajectory', 'Height', 'Position SD', 'Position Status', 'Position Type', 'Solution Statistics',
      'Velocity'],
  },
  { name: 'Tracking & Measurements', titles: ['Tracking Time', 'GNSS Signal Strength', 'Satellites and Signals'] },
  { name: 'Receiver Status', titles: ['CPU Usage', 'HW Monitor Status', 'Receiver Status'] },
];

const SECTION_OF = new Map<string, string>(
  SECTIONS.flatMap((section) => section.titles.map((title) => [title, section.name] as const)),
);

/**
 * Display order of a chart inside its section. Charts the table does not know keep the caller's order
 * after the known ones, so the document is reproducible no matter how the caller orders the CSVs.
 */
const RANK_OF = new Map<string, number>(
  SECTIONS.flatMap((section) => section.titles.map((title, index) => [title, index] as const)),
);
const UNRANKED = SECTIONS.reduce((max, section) => Math.max(max, section.titles.length), 0);

/** Series colours; the original lets ECharts pick, we just need them distinguishable. */
const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f'];

/** Geometry of one `<svg>`: a 960 px wide viewBox, scaled by CSS to the card width. */
const PLOT = { width: 960, height: 320, left: 78, right: 18, top: 16, bottom: 44 } as const;

/**
 * Up to this many columns the plot is drawn as **small multiples** (one panel per column, own Y
 * range); above it a single shared Y axis. The shipped charts fall cleanly on either side of it: the
 * widest per-column chart is `HW Monitor Status` (10 columns of different units) and the narrowest
 * shared-axis chart is `Satellites and Signals` (19 count columns of one unit).
 */
const MAX_PANELS = 12;

export interface ParsedReportCsv {
  /** The six `#` comment lines, `label → value` (labels as written, e.g. `Start Time(GPS)`). */
  meta: Record<string, string>;
  header: string[];
  rows: string[][];
}

/**
 * Split a Graph CSV into comments + header + rows.
 *
 * No field in these files is quoted (checked against all 12 goldens: no `"` at all), so a plain
 * comma split is exact — and it keeps the cells byte-identical to the CSV.
 */
export function parseReportCsv(input: string | Uint8Array): ParsedReportCsv {
  const text = (typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input)).replace(/^\uFEFF/, '');
  const meta: Record<string, string> = {};
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (line.startsWith('#')) {
      const body = line.slice(1);
      const colon = body.indexOf(':');
      if (colon !== -1) meta[body.slice(0, colon).trim()] = body.slice(colon + 1).trim();
      continue;
    }
    lines.push(line);
  }
  const [headerLine = '', ...rowLines] = lines;
  return {
    meta,
    header: headerLine === '' ? [] : headerLine.split(','),
    rows: rowLines.map((line) => line.split(',')),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `1.19761` stays `1.19761`; used for axis ticks only (table cells are printed verbatim). */
function tickLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude >= 1e7 || magnitude < 1e-4) return value.toExponential(2);
  const decimals = magnitude >= 1000 ? 0 : magnitude >= 10 ? 2 : 4;
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface Series {
  name: string;
  values: number[];
  /** Category names when the column is not numeric (e.g. `Position_Type`). */
  categories?: string[];
  /** Last cell exactly as the CSV prints it. */
  last: string;
}

/** One data column of a CSV → a plot series. A text column becomes ordinal codes + category labels. */
function seriesOf(header: string[], rows: string[][], column: number): Series {
  const cells = rows.map((row) => row[column] ?? '');
  const numeric = cells.length > 0 && cells.every((cell) => cell !== '' && Number.isFinite(Number(cell)));
  if (numeric) {
    return { name: header[column], values: cells.map(Number), last: cells[cells.length - 1] ?? '' };
  }
  const categories: string[] = [];
  const values = cells.map((cell) => {
    let index = categories.indexOf(cell);
    if (index === -1) index = categories.push(cell) - 1;
    return index;
  });
  return { name: header[column], values, categories, last: cells[cells.length - 1] ?? '' };
}

function isConstant(series: Series): boolean {
  return series.values.every((value) => value === series.values[0]);
}

/** Human summary of a constant column that is not drawn (so nothing silently disappears). */
function constantNote(series: Series[]): string {
  const names = series.slice(0, 6).map((entry) => `${escapeHtml(entry.name)} (= ${escapeHtml(entry.last)})`);
  const more = series.length > 6 ? `, +${series.length - 6} more` : '';
  return `constant column${series.length === 1 ? '' : 's'} not plotted: ${names.join(', ')}${more}`;
}

interface PlotGeometry {
  svg: string;
  legend: string;
}

/**
 * Render one chart's `<svg>`. X is always the row index, labelled with the CSV's first column (GPS
 * time for a time series, the condition name for `Receiver Status`).
 *
 * Two Y layouts, split at {@link MAX_PANELS} columns:
 *
 *  - **few columns** (`2D Trajectory`, `Position SD`, `HW Monitor Status`, `Receiver Status`, …):
 *    one panel per column, each scaled to its own range. These columns are different quantities
 *    (latitude vs longitude, temperature vs a 1.8 V rail), so a single axis would flatten them into
 *    straight lines and hide the very wobble the chart exists to show.
 *  - **many columns** (`Tracking Time` 60, `GNSS Signal Strength` 74, `Satellites and Signals` 19):
 *    one shared axis. Those are all the same quantity in the same unit, so sharing keeps them
 *    comparable — which is what the original ECharts report does.
 */
function renderPlot(chart: ParsedReportCsv, title: string): PlotGeometry {
  const rows = chart.rows;
  const rowCount = rows.length;
  const xLabels = rows.map((row) => row[0] ?? '');

  const allSeries = chart.header.slice(1).map((_, index) => seriesOf(chart.header, rows, index + 1));
  const panels = allSeries.length <= MAX_PANELS;
  // A constant column draws nothing inside a shared axis, so it is dropped there and reported; in the
  // panel layout every column keeps its own panel, and a flat panel is itself the answer.
  const constant = allSeries.filter((entry) => isConstant(entry));
  const dropped = !panels && rowCount > 1 && constant.length < allSeries.length ? constant : [];
  const series = allSeries.filter((entry) => !dropped.includes(entry));

  const plotWidth = PLOT.width - PLOT.left - PLOT.right;
  // Panels need vertical room each; the shared-axis layout keeps the base height.
  const height = panels ? Math.max(PLOT.height, PLOT.top + PLOT.bottom + series.length * 34) : PLOT.height;
  const plotHeight = height - PLOT.top - PLOT.bottom;

  if (rowCount === 0 || series.length === 0) {
    const svg = `<svg class="plot" viewBox="0 0 ${PLOT.width} ${PLOT.height}" role="img" aria-label="${escapeHtml(
      title,
    )}: no data"><text x="${PLOT.width / 2}" y="${PLOT.height / 2}" text-anchor="middle" fill="#8a8a8a">no rows in this chart</text></svg>`;
    return { svg, legend: '' };
  }

  const caption =
    `${rowCount} row${rowCount === 1 ? '' : 's'} · ${series.length} of ${allSeries.length} column${
      allSeries.length === 1 ? '' : 's'
    } plotted · ` + (panels ? '每个面板按该列自身区间缩放' : '同一纵轴，列间可直接比较');

  const xOf = (index: number) => (rowCount === 1 ? PLOT.left + plotWidth / 2 : PLOT.left + (plotWidth * index) / (rowCount - 1));
  const parts: string[] = [];

  /** `value` → y inside `[top, top + height]` for the given range. */
  const projector = (top: number, height: number, lo: number, hi: number) => (value: number) =>
    top + height * (1 - (value - lo) / (hi - lo));

  const legend: string[] = [];

  if (panels) {
    const cell = plotHeight / series.length;
    const gap = Math.min(12, cell * 0.32);
    series.forEach((entry, index) => {
      const colour = PALETTE[index % PALETTE.length];
      const top = PLOT.top + index * cell + gap / 2;
      const panelHeight = Math.max(4, cell - gap);
      let lo = Math.min(...entry.values);
      let hi = Math.max(...entry.values);
      if (lo === hi) {
        const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.01 : 1;
        lo -= pad;
        hi += pad;
      }
      const yOf = projector(top, panelHeight, lo, hi);
      parts.push(
        `<rect class="panel" x="${PLOT.left}" y="${top.toFixed(1)}" width="${plotWidth}" height="${panelHeight.toFixed(1)}"/>`,
        `<text class="panel-title" x="${PLOT.left + 4}" y="${(top + 11).toFixed(1)}" fill="${colour}">${escapeHtml(
          truncate(entry.name, 34),
        )}</text>`,
        `<text class="panel-value" x="${PLOT.left + plotWidth - 4}" y="${(top + 11).toFixed(1)}" text-anchor="end">${escapeHtml(
          entry.last,
        )}</text>`,
      );
      const points = entry.values.map((value, row) => `${xOf(row).toFixed(1)},${yOf(value).toFixed(1)}`).join(' ');
      parts.push(
        `<polyline class="series" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linejoin="round" points="${points}"/>`,
      );
      if (rowCount <= 2) {
        entry.values.forEach((value, row) => {
          parts.push(`<circle class="point" cx="${xOf(row).toFixed(1)}" cy="${yOf(value).toFixed(1)}" r="3" fill="${colour}"/>`);
        });
      }
      // A categorical column (`Position Status`) reads better with its names than with ordinals.
      const categories = entry.categories;
      if (categories && categories.length <= 6 && panelHeight >= categories.length * 14) {
        categories.forEach((name, ordinal) => {
          parts.push(
            `<text class="panel-cat" x="${PLOT.left + plotWidth - 4}" y="${(yOf(ordinal) - 3).toFixed(
              1,
            )}" text-anchor="end">${escapeHtml(truncate(name, 28))}</text>`,
          );
        });
      }
      legend.push(
        `<li><span class="swatch" style="background:${colour}"></span><span class="name">${escapeHtml(
          entry.name,
        )}</span><span class="value">${escapeHtml(entry.last)}</span></li>`,
      );
    });
  } else {
    const values = series.flatMap((entry) => entry.values);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.01 : 1;
      min -= pad;
      max += pad;
    }
    const yOf = projector(PLOT.top, plotHeight, min, max);
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      const value = min + ((max - min) * i) / (ticks - 1);
      const y = yOf(value).toFixed(1);
      parts.push(
        `<line class="grid" x1="${PLOT.left}" y1="${y}" x2="${PLOT.left + plotWidth}" y2="${y}"/>`,
        `<text class="ytick" x="${PLOT.left - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(
          tickLabel(value),
        )}</text>`,
      );
    }
    parts.push(
      `<line class="axis" x1="${PLOT.left}" y1="${PLOT.top}" x2="${PLOT.left}" y2="${PLOT.top + plotHeight}"/>`,
      `<line class="axis" x1="${PLOT.left}" y1="${PLOT.top + plotHeight}" x2="${PLOT.left + plotWidth}" y2="${
        PLOT.top + plotHeight
      }"/>`,
    );
    series.forEach((entry, index) => {
      const colour = PALETTE[index % PALETTE.length];
      const points = entry.values.map((value, row) => `${xOf(row).toFixed(1)},${yOf(value).toFixed(1)}`).join(' ');
      parts.push(
        `<polyline class="series" fill="none" stroke="${colour}" stroke-width="1.2" stroke-linejoin="round" points="${points}"/>`,
      );
      if (rowCount <= 2) {
        entry.values.forEach((value, row) => {
          parts.push(`<circle class="point" cx="${xOf(row).toFixed(1)}" cy="${yOf(value).toFixed(1)}" r="3" fill="${colour}"/>`);
        });
      }
      legend.push(
        `<li><span class="swatch" style="background:${colour}"></span><span class="name">${escapeHtml(
          entry.name,
        )}</span><span class="value">${escapeHtml(entry.last)}</span></li>`,
      );
    });
  }

  // The X axis is shared by both layouts, labelled from column 0 (GPS time, or the condition name).
  // Few rows get every label; many rows only the first / middle / last, which is all that fits.
  const labelMax = rowCount <= 8 ? 40 : 22;
  const labelRows = rowCount <= 8 ? rows.map((_, index) => index) : [0, Math.floor((rowCount - 1) / 2), rowCount - 1];
  for (const index of labelRows) {
    const anchor = index === 0 ? 'start' : index === rowCount - 1 ? 'end' : 'middle';
    parts.push(
      `<text class="xtick" x="${xOf(index).toFixed(1)}" y="${PLOT.top + plotHeight + 18}" text-anchor="${anchor}">${escapeHtml(
        truncate(xLabels[index] ?? '', labelMax),
      )}</text>`,
    );
  }

  const svg =
    `<svg class="plot" viewBox="0 0 ${PLOT.width} ${height}" role="img" aria-label="${escapeHtml(title)}">` +
    parts.join('') +
    '</svg>';
  const legendHtml = `<ul class="legend">${legend.join('')}</ul>${
    dropped.length > 0 ? `<p class="note">${constantNote(dropped)}</p>` : ''
  }`;
  return { svg, legend: `${legendHtml}<p class="note">${escapeHtml(caption)}</p>` };
}

function renderTable(chart: ParsedReportCsv, tableRows: number): string {
  if (chart.header.length === 0) return '';
  const shown = chart.rows.slice(0, tableRows);
  const head = `<tr>${chart.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr>`;
  const body = shown
    .map((row) => `<tr>${chart.header.map((_, column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  const note =
    chart.rows.length > shown.length
      ? `前 ${shown.length} 行 / 共 ${chart.rows.length} 行（完整数据见同名 CSV）`
      : `${chart.rows.length} 行`;
  return `<div class="table-wrap"><table>${head}${body}</table></div><p class="note">${note}</p>`;
}

/** The six project fields, taken from the CSV comment block when there is one. */
function reportMeta(project: GraphProject, charts: HtmlChartSource[]): Record<string, string> {
  const fromCsv = charts.length > 0 ? parseReportCsv(charts[0].csv).meta : {};
  const fallback = {
    'Project Name': project.projectName,
    'Project Directory': project.projectDirectory,
    'Data File Name': project.dataFileName,
    'Start Time(GPS)': formatGpsCommentTime(project.dataInfo.StartTime),
    'End Time(GPS)': formatGpsCommentTime(project.dataInfo.EndTime),
    'Duration': formatDuration(project.dataInfo.Duration),
  };
  const merged: Record<string, string> = {};
  for (const [label, value] of Object.entries(fallback)) merged[label] = fromCsv[label] ?? value;
  return merged;
}

/** Message summary rows: the messages the reported charts are fed by, in chart order. */
function messageSummary(project: GraphProject, titles: string[]): { name: string; count: number | string }[] {
  const names: string[] = [];
  for (const title of titles) {
    for (const name of Object.keys(chartMessages(project.plotSummary, title))) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.map((name) => ({ name, count: project.messages[name] ?? '' }));
}

function infoRow(label: string, value: string): string {
  return `<div class="info-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 20px 60px; background: #f4f5f7; color: rgba(0,0,0,.87);
  font-family: "Segoe UI", Arial, "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.5; }
main { max-width: 1120px; margin: 0 auto; }
h1 { text-align: center; font-size: 26px; margin: 8px 0 28px; }
h2 { font-size: 20px; color: #00516F; margin: 34px 0 12px; border-bottom: 2px solid #00516F; padding-bottom: 4px; }
h3 { font-size: 16px; margin: 0 0 2px; }
.card { background: #fff; border: 1.5px solid #00516F; border-radius: 2px; padding: 16px 18px 12px; margin: 14px 0; }
.info { background: #fff; border: 1.5px solid #00516F; padding: 14px 18px; margin: 12px 0; }
.info-title { font-weight: 700; font-size: 16px; color: #00516F; margin: 0 0 10px; }
.info-row { display: flex; gap: 12px; padding: 3px 0; }
.info-row .label { flex: 0 0 190px; font-weight: 600; }
.info-row .value { flex: 1 1 auto; word-break: break-all; font-variant-numeric: tabular-nums; }
.plot { width: 100%; height: auto; display: block; margin: 6px 0 2px; }
.plot .grid { stroke: #e3e6ea; stroke-width: 1; }
.plot .axis { stroke: #9aa4ad; stroke-width: 1; }
.plot .panel { fill: #fafbfc; stroke: #e3e6ea; stroke-width: 1; }
.plot .panel-title { font-size: 11px; font-weight: 600; }
.plot .panel-value { font-size: 11px; fill: #5c6670; font-variant-numeric: tabular-nums; }
.plot .panel-cat { font-size: 10px; fill: #8a939b; }
.plot .ytick { font-size: 11px; fill: #5c6670; }
.plot .xtick { font-size: 11px; fill: #5c6670; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; padding: 0; font-size: 12px; }
.legend li { display: flex; align-items: center; gap: 6px; }
.legend .swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
.legend .value { color: #5c6670; font-variant-numeric: tabular-nums; }
.note { color: #5c6670; font-size: 12px; margin: 8px 0 0; }
.table-wrap { overflow-x: auto; margin-top: 10px; }
table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
th, td { border: 1px solid #dfe3e8; padding: 3px 8px; text-align: right; font-variant-numeric: tabular-nums; }
th { background: #eef2f5; color: #00516F; font-weight: 600; }
td:first-child, th:first-child { text-align: left; }
footer { color: #7b858e; font-size: 12px; text-align: center; margin-top: 40px; }
@media print { body { background: #fff; padding: 0; } .card, .info { break-inside: avoid; } }
`.trim();

/**
 * Build the whole report. Pure apart from the clock: pass `options.generatedAt` for byte-reproducible
 * output.
 */
export function buildHtmlReport(project: GraphProject, charts: HtmlChartSource[], options: HtmlReportOptions = {}): string {
  const tableRows = options.tableRows ?? DEFAULT_TABLE_ROWS;
  const selected = options.selectedPlots ? charts.filter((chart) => options.selectedPlots!.includes(chart.title)) : charts;
  const meta = reportMeta(project, selected);
  const title = options.title ?? `${project.projectName} Report`;
  const generated = options.generatedAt ?? localTimestamp(new Date());

  const parsed = selected.map((chart) => ({ chart, parsed: parseReportCsv(chart.csv) }));
  const grouped = new Map<string, typeof parsed>();
  for (const entry of parsed) {
    const section = SECTION_OF.get(entry.chart.title) ?? 'Charts';
    const bucket = grouped.get(section) ?? [];
    bucket.push(entry);
    bucket.sort((a, b) => (RANK_OF.get(a.chart.title) ?? UNRANKED) - (RANK_OF.get(b.chart.title) ?? UNRANKED));
    grouped.set(section, bucket);
  }

  const sectionNames = [
    ...SECTIONS.map((section) => section.name).filter((name) => grouped.has(name)),
    ...(grouped.has('Charts') ? ['Charts'] : []),
  ];

  const sectionsHtml = sectionNames
    .map((name) => {
      const cards = (grouped.get(name) ?? [])
        .map(({ chart, parsed: csv }) => {
          const plot = renderPlot(csv, chart.title);
          return `<article class="card"><h3>${escapeHtml(chart.title)}</h3>${plot.svg}${plot.legend}${renderTable(
            csv,
            tableRows,
          )}</article>`;
        })
        .join('\n');
      return `<section><h2>${escapeHtml(name)}</h2>\n${cards}\n</section>`;
    })
    .join('\n');

  const info = [
    '<section class="info"><p class="info-title">Report Information</p>',
    infoRow('Generated Date', generated),
    infoRow('Charts', String(parsed.length)),
    '</section>',
    '<section class="info"><p class="info-title">Project Information</p>',
    infoRow('Project Name', meta['Project Name'] ?? ''),
    infoRow('Project Directory', meta['Project Directory'] ?? ''),
    infoRow('Data File Name', meta['Data File Name'] ?? ''),
    infoRow('Start Time (GPS)', meta['Start Time(GPS)'] ?? ''),
    infoRow('End Time (GPS)', meta['End Time(GPS)'] ?? ''),
    infoRow('Duration', meta['Duration'] ?? ''),
    '</section>',
  ].join('\n');

  const summary = messageSummary(
    project,
    parsed.map((entry) => entry.chart.title),
  );
  const summaryHtml =
    summary.length === 0
      ? ''
      : [
          '<section class="info"><p class="info-title">Message Summary</p>',
          '<div class="info-row"><span class="label">Message Name</span><span class="value">Message Count</span></div>',
          ...summary.map((entry) => infoRow(entry.name, String(entry.count))),
          '</section>',
        ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    STYLE,
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    info,
    summaryHtml,
    sectionsHtml,
    '<footer>由 packages/graph 从 CSV 图表数据重新生成 · 单文件、无外部依赖 · 表格为每个图表的前 ' +
      `${tableRows} 行，完整数据见同名 CSV</footer>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Write `<outDir>/<projectName>.html` (Graph's destination for `clean.html`) and return the path. */
export function writeHtmlReport(
  project: GraphProject,
  charts: HtmlChartSource[],
  outDir: string,
  options: HtmlReportOptions = {},
): { path: string; bytes: number } {
  mkdirSync(outDir, { recursive: true });
  const html = buildHtmlReport(project, charts, options);
  const path = join(outDir, `${project.projectName}.html`);
  writeFileSync(path, html, 'utf8');
  return { path, bytes: Buffer.byteLength(html, 'utf8') };
}
