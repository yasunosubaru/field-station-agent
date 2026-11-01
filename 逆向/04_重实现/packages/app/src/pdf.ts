/**
 * A **hand-written PDF 1.4** for the Graph page's *Export → PDF* action.
 *
 * The page used to fall back to `window.print()` inside a hidden iframe: no PDF library exists in
 * this repository (the npm registry is unreachable), and printing is honest but it leaves the format
 * to the browser's print dialog. This module writes the document itself, so the button can download
 * a real `.pdf` byte-for-byte reproducible from the CSVs.
 *
 * The layout follows the report Graph itself exported — `逆向/00_来源/samples/graph/export/clean.pdf`
 * (8 pages, A4 landscape, printed through Chromium), measured field by field with `pdftotext -layout`:
 *
 * ```
 * every page   header  `Graph` left, `<project> · <generated> · GPS <start> – <end>` right
 *              footer  `source: <file>.csv` left, `<page>/<pages>` right
 * page 1       `<project> Report` centred
 *              Report Information   Generated Date
 *              Project Information  the six comment fields, same spellings as the CSVs
 *              Chart Summary        one row per CSV: chart, section, rows, series, min, max, mean, page
 * page 2..13   one page per CSV (the original groups two charts on a page; one per page here keeps
 *              every chart legible and the page count equal to 1 + the number of CSVs):
 *              section heading on the first page of a section (`PVT`, `Tracking & Measurements`,
 *              `Receiver Status` — the original's own tab names), chart title, the y-axis unit
 *              rotated beside the axis, five value ticks, GPS-week x ticks, the series as
 *              polylines and the legend the original prints under the axis
 * ```
 *
 * What is **not** copied, because the data is not here: the original's `Message Summary` table
 * (BESTPOS 5, RANGE 100 …) needs `DataSummary.json`, which no route serves, so inventing counts
 * would be dishonest; its legend chips (`All`, `GPS L1`) are interactive filters, and a static PDF
 * has nothing to filter. The charts are redrawn from the CSVs — nothing is a screenshot, and no
 * number is made up: a chart whose column cannot be read says so on the page.
 *
 * Everything is ASCII by default and uncompressed: the object table is written in a fixed order,
 * every string can be found with a plain text search, and the `xref` holds exact byte offsets — the
 * test reads them back and checks that each one really points at its `N 0 obj`. ASCII text uses the
 * base-14 `Helvetica` / `Helvetica-Bold` referenced by name (`/WinAnsiEncoding`), never embedded.
 *
 * A project whose name or `#Project Directory:` is not ASCII (a Windows path with a Chinese folder,
 * say) would otherwise print nothing but `?`. Such a run is drawn with **one TrueType face embedded
 * on demand** — the same face, parser and PDF objects as the graph package, from `pdf-font.ts`:
 * `simhei.ttf` from the system font directory by default, `/FontFile2` + `Type0`/`CIDFontType2`
 * with `/Identity-H` and a `ToUnicode` CMap, glyph ids measured with the face's own advances so
 * right-aligned cells still line up. A pure-ASCII document embeds nothing and keeps its exact
 * bytes; a machine without a usable face degrades to `?` and the footer says so.
 *
 * `packages/graph/src/pdf.ts` is the other writer in this repo and is richer (it also draws every
 * column of a wide table); this one exists so the **app** can serve a download with its own layout
 * (header/footer chrome, one chart per page, the chart summary table on the cover).
 */

import {
  CJK_FONT_OBJECTS,
  beginPdfFont,
  buildCjkFontObjects,
  cjkTextWidth,
  cjkUsedDegraded,
  cjkUsedEmbedded,
  embeddedFace,
  encodeCjkText,
  endPdfFont,
  hasNonAscii,
  markCjkDegraded,
  pdfUnicodeString,
  type CjkFontObject,
  type PdfFontOptions,
  type TrueTypeFace,
} from '../../graph/src/pdf-font.ts';

/** A4 landscape, in points — the page box the suite's own report was printed at. */
export const PDF_PAGE = { width: 842, height: 595 } as const;

/**
 * Points drawn per page. A wide CSV (`GNSS Signal Strength.csv` has 74 numeric columns) would need
 * ~7 300 vertices for 99 rows; above this budget every series is decimated by the same stride, so a
 * page stays a download and not a 300 KB blob.
 */
export const PDF_POINT_BUDGET = 2_400;

/** Legend entries per chart; the original's own legend prints twelve then wraps. */
export const PDF_LEGEND_MAX = 12;

export interface GraphPdfSource {
  /** Bare file name as exported by Graph, e.g. `Height.csv`. */
  name: string;
  /** The file's text, BOM and `#` comments included. */
  text: string;
}

export interface GraphPdfOptions extends PdfFontOptions {
  /**
   * *Generated Date*, spelled the way the CSVs spell theirs (`2026/10/30 21:00:00`). Also the
   * document's `CreationDate`; the only clock in this module, so a fixed value gives fixed bytes.
   */
  generatedAt?: string;
  /** Heading; default `<project> Report`. */
  title?: string;
  /**
   * TrueType face used for runs that contain non-ASCII text — see `pdf-font.ts`.
   *
   * `undefined` → `GRAPH_PDF_CJK_FONT`, else `%WINDIR%\Fonts\simhei.ttf` and a few fallbacks;
   * a path → that file only; `null` → never embed (forced old behaviour: non-ASCII becomes `?`).
   */
  cjkFontPath?: string | null;
}

/* ------------------------------------------------------------------------------------------------
 * Chart catalogue — the titles, tab names and y-axis units of `06_Graph应用-附录/C_图表目录.json`,
 * verbatim, keyed by the CSV the tile was exported as. `web/panels/graph.js` carries the same list
 * for the on-screen tiles; this copy keeps the server free of the browser bundle.
 * ---------------------------------------------------------------------------------------------- */

type ChartKind = 'line' | 'category' | 'geomap' | 'interval';

interface ChartSpec {
  file: string;
  title: string;
  /** The original's tab, printed as a heading above the first chart of the section. */
  section: string;
  kind: ChartKind;
  /** `yAxisUnits`, verbatim; empty when the catalog has none. */
  units?: string;
  /** `minYZero`, verbatim. */
  minYZero?: boolean;
  xColumn?: string;
  yColumn?: string;
}

const PVT = 'PVT';
const HEADING = 'Heading & Attitude';
const TRACKING = 'Tracking & Measurements';
const RECEIVER = 'Receiver Status';

export const CHART_SPECS: readonly ChartSpec[] = [
  { file: 'Position Type.csv', title: 'Position Type', section: PVT, kind: 'category' },
  { file: 'Position Status.csv', title: 'Position Status', section: PVT, kind: 'category' },
  { file: 'Position SD.csv', title: 'Position SD', section: PVT, kind: 'line', units: '(m)' },
  { file: 'Solution Statistics.csv', title: 'Solution Statistics', section: PVT, kind: 'line' },
  {
    file: '2D Trajectory.csv', title: '2D Trajectory', section: PVT, kind: 'geomap',
    xColumn: 'Longitude', yColumn: 'Latitude',
  },
  { file: 'Height.csv', title: 'Height', section: PVT, kind: 'line', units: '(m)' },
{ file: 'Velocity.csv', title: 'Velocity', section: PVT, kind: 'line', units: '(m/s)' },
{ file: 'Azimuth.csv', title: 'Azimuth', section: HEADING, kind: 'line', units: '(degrees)' },
{ file: 'Roll and Pitch.csv', title: 'Roll and Pitch', section: HEADING, kind: 'line', units: '(degrees)' },
{ file: 'SPAN Filter Updates.csv', title: 'SPAN Filter Updates', section: HEADING, kind: 'interval' },
  {
    file: 'GNSS Signal Strength.csv', title: 'GNSS Signal Strength', section: TRACKING, kind: 'line',
    units: 'C/No (dB-Hz)',
  },
  {
    file: 'Satellites and Signals.csv', title: 'Satellites and Signals', section: TRACKING, kind: 'line',
    minYZero: true,
  },
  { file: 'Tracking Time.csv', title: 'Tracking Time', section: TRACKING, kind: 'line', units: '(s)', minYZero: true },
  { file: 'Receiver Status.csv', title: 'Receiver Status', section: RECEIVER, kind: 'interval' },
  { file: 'CPU Usage.csv', title: 'CPU Usage', section: RECEIVER, kind: 'line', units: '(%)', minYZero: true },
  { file: 'HW Monitor Status.csv', title: 'HW Monitor Status', section: RECEIVER, kind: 'line', minYZero: true },
];

/** The catalogue entry for a CSV, or a plain line chart for a file the catalogue does not know. */
function specOf(name: string): ChartSpec {
  const hit = CHART_SPECS.find((entry) => entry.file === name);
  if (hit) return hit;
  return { file: name, title: name.replace(/\.csv$/i, ''), section: '', kind: 'line' };
}

/**
 * Document order: the catalogue's order (PVT, Tracking & Measurements, Receiver Status — the
 * original's tabs), then anything unknown, alphabetically. The server maps its directory listing
 * through this so page 2 is `Position Type` like the original's, not `2D Trajectory`.
 */
export function graphPdfOrder(names: readonly string[]): string[] {
  const rank = new Map<string, number>();
  CHART_SPECS.forEach((spec, at) => rank.set(spec.file, at));
  return [...names].sort((a, b) => {
    const left = rank.has(a) ? rank.get(a)! : Number.MAX_SAFE_INTEGER;
    const right = rank.has(b) ? rank.get(b)! : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.localeCompare(b, 'en');
  });
}

/* ------------------------------------------------------------------------------------------------
 * CSV: the same shape `graphcsv.ts` reads — six `#` comment lines, a header row, then data
 * ---------------------------------------------------------------------------------------------- */

interface CsvFile {
  name: string;
  title: string;
  comments: Record<string, string>;
  columns: string[];
  rows: string[][];
  timeIndex: number;
}

function parseCsvSource(source: GraphPdfSource): CsvFile {
  const comments: Record<string, string> = {};
  let columns: string[] = [];
  const rows: string[][] = [];
  for (const raw of source.text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (raw.startsWith('#')) {
      const body = raw.slice(1);
      const at = body.indexOf(':');
      if (at > 0) comments[body.slice(0, at).trim()] = body.slice(at + 1).trim();
      continue;
    }
    const cells = raw.split(',').map((cell) => cell.trim());
    if (!columns.length) columns = cells;
    else {
      if (cells.length < columns.length) cells.push(...Array(columns.length - cells.length).fill(''));
      else if (cells.length > columns.length) cells.length = columns.length;
      rows.push(cells);
    }
  }
  return {
    name: source.name,
    title: source.name.replace(/\.csv$/i, ''),
    comments,
    columns,
    rows,
    timeIndex: columns.findIndex((column) => /timestamp/i.test(column)),
  };
}

/** `"2442  463098.000"` → absolute GPS seconds, or `null`. */
function gpsSeconds(cell: string): number | null {
  const match = /^\s*(\d{3,5})\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(cell ?? '');
  return match ? Number(match[1]) * 604_800 + Number(match[2]) : null;
}

function isNumericColumn(rows: string[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[index] ?? '';
    if (cell === '') continue;
    if (!Number.isFinite(Number(cell))) return false;
    seen += 1;
  }
  return seen > 0;
}

/** `{ kind: 'time' }` when every row carries a GPS timestamp, else the row index. */
function xAxis(file: CsvFile): { kind: 'time' | 'index'; values: number[]; base: number } {
  if (file.timeIndex >= 0) {
    const times = file.rows.map((row) => gpsSeconds(row[file.timeIndex] ?? ''));
    if (times.length === file.rows.length && times.length > 0 && times.every((value) => value !== null)) {
      const absolute = times as number[];
      const base = absolute[0];
      return { kind: 'time', values: absolute.map((value) => value - base), base };
    }
  }
  return { kind: 'index', values: file.rows.map((_row, at) => at), base: 0 };
}

/* ------------------------------------------------------------------------------------------------
 * Content-stream primitives
 * ---------------------------------------------------------------------------------------------- */

const INK = '0.11 0.12 0.13';
const MUTED = '0.42 0.46 0.5';
const GRID = '0.9 0.91 0.93';
const AXIS = '0.6 0.64 0.69';
const RULE = '0 0.32 0.44';

/**
 * The ten colours `web/panels/graph.js` cycles through (`SERIES_COLOURS`), as PDF `rg` / `RG`
 * operands: the Overview chart's own stroke and marker first, the suite's flag red third.
 */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0.318, 0.435], [0, 0.671, 0.784], [0.816, 0.008, 0.106], [0.878, 0.608, 0],
  [0.18, 0.545, 0.341], [0.482, 0.31, 0.659], [0.761, 0.094, 0.357], [0.227, 0.431, 0.647],
  [0.553, 0.431, 0.388], [0.306, 0.478, 0.051],
];

function colourOf(index: number): string {
  const [r, g, b] = PALETTE[Math.abs(Math.trunc(index) || 0) % PALETTE.length];
  const channel = (value: number) => (Math.round(value * 1000) / 1000).toString();
  return `${channel(r)} ${channel(g)} ${channel(b)}`;
}

const MARGIN = 34;
const WIDTH = PDF_PAGE.width;
const HEIGHT = PDF_PAGE.height;

/** Top-origin y → the PDF's bottom-origin y. */
function top(y: number): number {
  return HEIGHT - y;
}

/** A PDF literal string: `(`, `)` and `\` escaped, anything undrawable becomes `?`. */
function literal(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (char === '(') out += '\\(';
    else if (char === ')') out += '\\)';
    else if (char === '\\') out += '\\\\';
    else if (code < 32 || code > 126) out += '?';
    else out += char;
  }
  return `(${out})`;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * Advance width of a string in points. Helvetica's own metrics are a table we do not ship; digits
 * are 0.556 em, capitals ~0.62, lowercase ~0.52 and spaces 0.278, which is close enough to
 * right-align a header and to pack legend chips without overlapping. A run that will be drawn with
 * the embedded face is measured with that face's own advances instead (see `pdf-font.ts`), so the
 * two metrics never disagree about where a string ends.
 */
function advance(value: string, size: number): number {
  const cjk = cjkTextWidth(value, size);
  if (cjk !== null) return cjk;
  let em = 0;
  for (const char of value) {
    if (char === ' ') em += 0.278;
    else if ('ijlt.,:;|!\''.includes(char)) em += 0.29;
    else if ('ABCDEFGHJKLMNOPQRSTUVWXYZ0123456789'.includes(char)) em += 0.64;
    else em += 0.53;
  }
  return em * size;
}

/** Cut a string so it fits `width` points, marking the cut with `...`. */
function fit(value: string, width: number, size: number): string {
  if (advance(value, size) <= width) return value;
  // By code point: slicing a surrogate pair in half would leave a lone half for the glyph encoder.
  const points = [...value];
  let out = points;
  while (out.length > 1 && advance(`${out.join('')}...`, size) > width) out = out.slice(0, -1);
  return `${out.join('')}...`;
}

/** `1 row` / `5 rows`; `series` is its own plural. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The composite face a run has to use, or `null` when it stays on the base-14 faces. A run with no
 * usable face is marked degraded here, so the cover can say `?` was substituted.
 */
function cjkFaceFor(value: string): TrueTypeFace | null {
  if (!hasNonAscii(value)) return null;
  const face = embeddedFace();
  if (!face) markCjkDegraded();
  return face;
}

/**
 * One text run. A run that contains anything outside ASCII is drawn with the embedded `F3` face as
 * UTF-16BE glyph ids; bold falls back to the same face (SimHei has one weight), and a document with
 * no usable face keeps the old `?`. Everything ASCII is written exactly as before.
 */
function text(x: number, y: number, size: number, bold: boolean, colour: string, value: string): string {
  const face = cjkFaceFor(value);
  const resource = face ? 'F3' : bold ? 'F2' : 'F1';
  const prefix = `${colour} rg /${resource} ${size} Tf ${round(x)} ${round(top(y))} Td`;
  return `BT ${prefix} ${face ? `<${encodeCjkText(value, face)}>` : literal(value)} Tj ET`;
}

/** Text whose right edge sits at `right` — headers and page numbers. */
function textRight(right: number, y: number, size: number, bold: boolean, colour: string, value: string): string {
  return text(right - advance(value, size), y, size, bold, colour, value);
}

/** Centred text. */
function textCentred(centre: number, y: number, size: number, bold: boolean, colour: string, value: string): string {
  return text(centre - advance(value, size) / 2, y, size, bold, colour, value);
}

/** Text rotated 90° counter-clockwise: the y-axis unit, as the original prints it. */
function textUp(x: number, y: number, size: number, colour: string, value: string): string {
  const face = cjkFaceFor(value);
  const prefix = `${colour} rg /${face ? 'F3' : 'F1'} ${size} Tf 0 1 -1 0 ${round(x)} ${round(top(y))} Tm`;
  return `BT ${prefix} ${face ? `<${encodeCjkText(value, face)}>` : literal(value)} Tj ET`;
}

function rule(x1: number, y1: number, x2: number, y2: number, width: number, colour: string): string {
  return `${colour} RG ${width} w ${round(x1)} ${round(top(y1))} m ${round(x2)} ${round(top(y2))} l S`;
}

function rect(x: number, y: number, width: number, height: number, colour: string): string {
  return `${colour} rg ${round(x)} ${round(top(y + height))} ${round(width)} ${round(height)} re f`;
}

/** `2026/10/30 21:00:00` (default: now, local). */
function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pdfDate(generatedAt: string): string {
  const digits = generatedAt.replace(/[^0-9]/g, '').slice(0, 14).padEnd(14, '0');
  return `D:${digits}`;
}

/** `0.000` for values a chart is likely to carry, scientific notation for huge ones. */
function precision(value: number): string {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1e5) return value.toExponential(3);
  if (abs >= 1000) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

/* ---------------- ticks ---------------- */

/** `count + 1` evenly spaced ticks across `[min, max]`, ends exactly on the axis ends. */
function ticks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    return Number.isFinite(min) ? [min] : [];
  }
  const step = (max - min) / count;
  const values: number[] = [];
  for (let at = 0; at <= count; at += 1) values.push(min + step * at);
  return values;
}

/** Decimals follow the step, so a 0.005 m span still prints three places and a 700 s span none. */
function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '--';
  const size = Math.abs(step);
  const decimals = size > 0 && Number.isFinite(size)
    ? Math.max(0, Math.min(6, Math.ceil(-Math.log10(size))))
    : 0;
  let out = value.toFixed(decimals);
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return out === '-0' ? '0' : out;
}

function stepOf(values: number[]): number {
  return values.length > 1 ? values[1] - values[0] : 0;
}

/**
 * The x tick labels the original prints: seconds of the GPS week, `463100` when the tick lands on a
 * whole second and `463097.350` when it does not. The week itself sits once above the axis.
 */
function gpsTick(absolute: number): string {
  const week = Math.floor(absolute / 604_800);
  const seconds = absolute - week * 604_800;
  const rounded = Math.round(seconds * 1000) / 1000;
  return Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(3);
}

/* ------------------------------------------------------------------------------------------------
 * Chart models — one per CSV, computed from the file alone
 * ---------------------------------------------------------------------------------------------- */

interface ChartSeries {
  name: string;
  colour: string;
  points: Array<[number, number]>;
}

interface LineModel {
  kind: 'line';
  series: ChartSeries[];
  xKind: 'time' | 'index';
  xBase: number;
  units: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** `min 1.198  max 2.640  mean 1.902`, printed beside the title. */
  stats: string;
  note: string;
}

interface CategoryModel {
  kind: 'category';
  samples: Array<{ x: number; colour: string }>;
  legend: Array<{ label: string; colour: string }>;
  xKind: 'time' | 'index';
  xBase: number;
  xMin: number;
  xMax: number;
  note: string;
}

interface GeomapModel {
  kind: 'geomap';
  points: Array<[number, number]>;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  xLabel: string;
  yLabel: string;
  note: string;
}

interface IntervalModel {
  kind: 'interval';
  rows: Array<{ name: string; start: number; end: number; value: number; colour: string }>;
  xMin: number;
  xMax: number;
  note: string;
}

type ChartModel = LineModel | CategoryModel | GeomapModel | IntervalModel;

/** Domain of a set of points, padded when every sample is the same (one row, or a flat line). */
function domainOf(series: ChartSeries[], axis: 0 | 1): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const point of item.points) {
      const value = point[axis];
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max > min) return [min, max];
  return [min - 1, max + 1];
}

/** One series per numeric column, on the shared x axis. */
function lineModel(file: CsvFile, spec: ChartSpec): LineModel {
  const axis = xAxis(file);
  const series: ChartSeries[] = [];
  file.columns.forEach((column, index) => {
    if (index === file.timeIndex) return;
    if (!isNumericColumn(file.rows, index)) return;
    const points: Array<[number, number]> = [];
    file.rows.forEach((row, at) => {
      const value = Number(row[index] ?? '');
      if (!Number.isFinite(value)) return;
      points.push([axis.values[at] ?? at, value]);
    });
    if (!points.length) return;
    series.push({ name: column, colour: colourOf(series.length), points });
  });

  if (!series.length) {
    // No numeric column at all (`Position Type.csv` is drawn as bands; a file with neither numbers
    // nor labels gets here) — say so instead of drawing an empty frame.
    return {
      kind: 'line', series: [], xKind: axis.kind, xBase: axis.base, units: spec.units ?? '',
      xMin: 0, xMax: 1, yMin: 0, yMax: 1, stats: '',
      note: 'no numeric column in this CSV - the table is below',
    };
  }

  let [yMin, yMax] = domainOf(series, 1);
  if (spec.minYZero) yMin = Math.min(0, yMin);
  const [xMin, xMax] = domainOf(series, 0);

  let low = Infinity;
  let high = -Infinity;
  let sum = 0;
  let count = 0;
  for (const item of series) {
    for (const [, value] of item.points) {
      if (value < low) low = value;
      if (value > high) high = value;
      sum += value;
      count += 1;
    }
  }
  const notes: string[] = [];
  if (file.rows.length === 1) notes.push('one sample in the CSV - each column is a single point');
  if (series.length > PDF_LEGEND_MAX) {
    notes.push(`${series.length} numeric columns; the legend names the first ${PDF_LEGEND_MAX}`);
  }

  return {
    kind: 'line',
    series,
    xKind: axis.kind,
    xBase: axis.base,
    units: spec.units ?? '',
    xMin,
    xMax,
    yMin,
    yMax,
    stats: `min ${precision(low)}  max ${precision(high)}  mean ${precision(sum / Math.max(1, count))}`,
    note: notes.join(' - '),
  };
}

/** Enum column → one band per sample, y axis hidden (the original's bar-plus-hidden-y reading). */
function categoryModel(file: CsvFile): CategoryModel {
  const axis = xAxis(file);
  const valueIndex = file.columns.findIndex((column, at) => at !== file.timeIndex);
  const index = valueIndex >= 0 ? valueIndex : 0;
  const labels = new Map<string, string>();
  const samples: Array<{ x: number; colour: string }> = [];
  file.rows.forEach((row, at) => {
    const label = (row[index] ?? '').trim() || '(empty)';
    if (!labels.has(label)) labels.set(label, colourOf(labels.size));
    samples.push({ x: axis.values[at] ?? at, colour: labels.get(label)! });
  });
  let min = Infinity;
  let max = -Infinity;
  for (const sample of samples) {
    if (sample.x < min) min = sample.x;
    if (sample.x > max) max = sample.x;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  } else if (!(max > min)) {
    min -= 1;
    max += 1;
  }
  return {
    kind: 'category',
    samples,
    legend: [...labels].map(([label, colour]) => ({ label, colour })),
    xKind: axis.kind,
    xBase: axis.base,
    xMin: min,
    xMax: max,
    note: `${samples.length} samples - ${labels.size} distinct ${file.columns[index] ?? 'value'} values`,
  };
}

/** Longitude on x, latitude on y — `GeoMapChart`'s reading of `2D Trajectory.csv`. */
function geomapModel(file: CsvFile, spec: ChartSpec): GeomapModel {
  const lon = file.columns.findIndex((column) => column === (spec.xColumn ?? 'Longitude'));
  const lat = file.columns.findIndex((column) => column === (spec.yColumn ?? 'Latitude'));
  const points: Array<[number, number]> = [];
  if (lon >= 0 && lat >= 0) {
    for (const row of file.rows) {
      const x = Number(row[lon] ?? '');
      const y = Number(row[lat] ?? '');
      if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
    }
  }
  const pad = (min: number, max: number): [number, number] => (max > min ? [min, max] : [min - 0.0001, max + 0.0001]);
  let lonMin = Infinity;
  let lonMax = -Infinity;
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const [x, y] of points) {
    if (x < lonMin) lonMin = x;
    if (x > lonMax) lonMax = x;
    if (y < latMin) latMin = y;
    if (y > latMax) latMax = y;
  }
  if (!points.length) {
    lonMin = 0; lonMax = 1; latMin = 0; latMax = 1;
  }
  const [x0, x1] = pad(lonMin, lonMax);
  const [y0, y1] = pad(latMin, latMax);
  const track = points.length > 1 && lonMax > lonMin;
  return {
    kind: 'geomap',
    points,
    lonMin: x0,
    lonMax: x1,
    latMin: y0,
    latMax: y1,
    xLabel: 'Longitude (degrees)',
    yLabel: 'Latitude (degrees)',
    note: points.length
      ? `${points.length} fixes${track ? '' : ' - all samples share one position, so this is a dot, not a track'}`
      : 'no Latitude / Longitude column in this CSV',
  };
}

/**
 * `Receiver Status.csv` is `name,start,end,value` — a list of conditions with an epoch-ms interval,
 * not a time series. The original draws one band per condition; so does this, on the interval's own
 * clock (seconds from the earliest start), and the page says the axis is not the GPS week.
 */
function intervalModel(file: CsvFile): IntervalModel {
  const nameIndex = file.columns.findIndex((column) => /^name$/i.test(column));
  const startIndex = file.columns.findIndex((column) => /^start$/i.test(column));
  const endIndex = file.columns.findIndex((column) => /^end$/i.test(column));
  const valueIndex = file.columns.findIndex((column) => /^value$/i.test(column));
  const rows: IntervalModel['rows'] = [];
  file.rows.forEach((row, at) => {
    const start = Number(row[startIndex] ?? '');
    const end = Number(row[endIndex] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    rows.push({
      name: (nameIndex >= 0 ? row[nameIndex] : `row ${at + 1}`) || `row ${at + 1}`,
      start,
      end,
      value: Number(row[valueIndex] ?? ''),
      colour: colourOf(at),
    });
  });
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    min = Math.min(min, row.start);
    max = Math.max(max, row.end);
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  } else if (!(max > min)) {
    max = min + 1;
  }
  return {
    kind: 'interval',
    rows,
    xMin: min,
    xMax: max,
    note: rows.length
      ? 'each bar is name/start/end from the CSV; x is seconds from the earliest start (epoch ms, not the GPS week)'
      : 'no name,start,end rows in this CSV',
  };
}

function modelOf(file: CsvFile, spec: ChartSpec): ChartModel {
  if (spec.kind === 'interval') return intervalModel(file);
  if (spec.kind === 'geomap') return geomapModel(file, spec);
  if (spec.kind === 'category') return categoryModel(file);
  return lineModel(file, spec);
}

/* ------------------------------------------------------------------------------------------------
 * Drawing
 * ---------------------------------------------------------------------------------------------- */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The x tick labels for a model: GPS seconds of week, `#row`, or seconds of the interval. */
function xTickLabels(model: ChartModel, values: number[]): string[] {
  const step = stepOf(values);
  if (model.kind === 'geomap') return values.map((value) => formatTick(value, step));
  if (model.kind === 'interval') return values.map((value) => formatTick((value - model.xMin) / 1000, step / 1000));
  if (model.xKind === 'time') return values.map((value) => gpsTick(model.xBase + value));
  return values.map((value) => `#${Math.round(value) + 1}`);
}

/** The caption under the x axis. */
function xCaption(model: ChartModel): string {
  if (model.kind === 'geomap') return 'Longitude (degrees)';
  if (model.kind === 'interval') return 'seconds from the earliest start';
  if (model.xKind === 'time') {
    const week = Math.floor(model.xBase / 604_800);
    const from = gpsTick(model.xBase);
    const to = gpsTick(model.xBase + Math.max(model.xMax, model.xMin));
    return `GPS week ${week} - seconds of week ${from} .. ${to}`;
  }
  return 'row';
}

/** Gridlines, axes, ticks and axis captions; shared by every chart kind. */
function frame(box: Box, model: ChartModel, options: { showY: boolean }): string[] {
  const out: string[] = [];
  const height = box.bottom - box.top;
  if (model.kind === 'geomap') {
    const yValues = ticks(model.latMin, model.latMax);
    const step = stepOf(yValues);
    for (const value of yValues) {
      const y = box.bottom - ((value - model.latMin) / (model.latMax - model.latMin)) * height;
      out.push(rule(box.left, y, box.right, y, 0.4, GRID));
      out.push(textRight(box.left - 6, y + 2.6, 6.8, false, MUTED, formatTick(value, step)));
    }
    out.push(textUp(box.left - 40, box.bottom - height / 2, 7.5, MUTED, model.yLabel));
  } else if (options.showY && model.kind === 'line') {
    const values = ticks(model.yMin, model.yMax);
    const step = stepOf(values);
    for (const value of values) {
      const y = box.bottom - ((value - model.yMin) / (model.yMax - model.yMin)) * height;
      out.push(rule(box.left, y, box.right, y, 0.4, GRID));
      out.push(textRight(box.left - 6, y + 2.6, 6.8, false, MUTED, formatTick(value, step)));
    }
    if (model.units) out.push(textUp(box.left - 40, box.bottom - height / 2, 7.5, MUTED, model.units));
  } else {
    // Bar / band / interval: the y axis carries no scale, exactly like the original's hidden axis.
    out.push(rule(box.left, box.bottom, box.right, box.bottom, 0.4, GRID));
  }

  out.push(rule(box.left, box.top, box.left, box.bottom, 0.8, AXIS));
  out.push(rule(box.left, box.bottom, box.right, box.bottom, 0.8, AXIS));

  const xValues = model.kind === 'geomap'
    ? ticks(model.lonMin, model.lonMax)
    : ticks(model.xMin, model.xMax);
  const labels = model.kind === 'geomap'
    ? xValues.map((value) => formatTick(value, stepOf(xValues)))
    : xTickLabels(model, xValues);
  const span = model.kind === 'geomap'
    ? model.lonMax - model.lonMin
    : model.xMax - model.xMin;
  xValues.forEach((value, at) => {
    const x = box.left + ((value - (model.kind === 'geomap' ? model.lonMin : model.xMin)) / (span || 1)) * (box.right - box.left);
    out.push(rule(x, box.top, x, box.bottom, 0.3, GRID));
    const label = labels[at] ?? '';
    // The first and last label hang inside the frame so they cannot leave the page.
    const anchor = at === 0 ? x : at === xValues.length - 1 ? x - advance(label, 6.8) : x - advance(label, 6.8) / 2;
    out.push(text(anchor, box.bottom + 11, 6.8, false, MUTED, label));
  });
  out.push(textCentred((box.left + box.right) / 2, box.bottom + 24, 7.5, false, MUTED, xCaption(model)));
  return out;
}

/** Polylines, one per series, decimated by a stride the whole page shares. */
function lines(box: Box, model: LineModel): string[] {
  const out: string[] = [];
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  let total = 0;
  for (const item of model.series) total += item.points.length;
  const stride = Math.max(1, Math.ceil(total / PDF_POINT_BUDGET));

  const px = (value: number) => box.left + ((value - model.xMin) / ((model.xMax - model.xMin) || 1)) * width;
  const py = (value: number) => box.bottom - ((value - model.yMin) / ((model.yMax - model.yMin) || 1)) * height;

  for (const item of model.series) {
    if (!item.points.length) continue;
    const drawn: Array<[number, number]> = item.points.filter((_point, at) => at % stride === 0);
    const last = item.points[item.points.length - 1];
    if (drawn[drawn.length - 1][0] !== last[0]) drawn.push(last);
    if (drawn.length === 1) {
      // One sample (`HW Monitor Status.csv` answers once): a square marker, because a polyline of
      // one vertex draws nothing at all.
      const [x, y] = drawn[0];
      out.push(rect(px(x) - 1.6, py(y) - 1.6, 3.2, 3.2, item.colour));
      continue;
    }
    const path = drawn
      .map(([x, y], at) => `${round(px(x))} ${round(top(py(y)))} ${at === 0 ? 'm' : 'l'}`)
      .join(' ');
    out.push(`1.1 w ${item.colour} RG ${path} S`);
  }
  return out;
}

/** Enum samples as full-height bands; the gaps between samples set the band width. */
function bands(box: Box, model: CategoryModel): string[] {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const px = (value: number) => box.left + ((value - model.xMin) / ((model.xMax - model.xMin) || 1)) * width;
  let band = Math.min(width, 40);
  if (model.samples.length > 1 && model.xMax > model.xMin) {
    const gaps: number[] = [];
    for (let at = 1; at < model.samples.length; at += 1) gaps.push(model.samples[at].x - model.samples[at - 1].x);
    gaps.sort((a, b) => a - b);
    band = Math.max(2, ((gaps[Math.floor(gaps.length / 2)] || 0) / (model.xMax - model.xMin)) * width * 0.8);
  }
  return model.samples.map((sample) => {
    const centre = px(sample.x);
    const left = Math.max(box.left, centre - band / 2);
    const right = Math.min(box.right, centre + band / 2);
    return rect(left, box.top, Math.max(1, right - left), height, sample.colour);
  });
}

/** Longitude / latitude fixes as small dots. */
function geomap(box: Box, model: GeomapModel): string[] {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const px = (value: number) => box.left + ((value - model.lonMin) / ((model.lonMax - model.lonMin) || 1)) * width;
  const py = (value: number) => box.bottom - ((value - model.latMin) / ((model.latMax - model.latMin) || 1)) * height;
  const colour = '0.329 0.392 0.973'; // `#5464f8`, the GeoMapChart marker the panel draws
  return model.points.map(([lon, lat]) => {
    const size = 3;
    return rect(px(lon) - size / 2, py(lat) - size / 2, size, size, colour);
  });
}

/** One band per condition, labelled at the left edge — the `name,start,end,value` table. */
function intervals(box: Box, model: IntervalModel): string[] {
  const out: string[] = [];
  const width = box.right - box.left;
  const rows = model.rows.length || 1;
  const rowHeight = Math.min(56, (box.bottom - box.top) / rows);
  const px = (value: number) => box.left + ((value - model.xMin) / ((model.xMax - model.xMin) || 1)) * width;
  model.rows.forEach((row, at) => {
    const y = box.top + rowHeight * at;
    // The condition name gets its own 160 pt gutter: `Antenna 1 Gain High` is 19 characters, and the
    // chart frame starts after it, so the bar never runs under a truncated label.
    out.push(textRight(box.left - 10, y + rowHeight / 2 + 2.4, 7, false, INK, fit(row.name, box.left - MARGIN - 16, 7)));
    const left = px(row.start);
    const right = Math.max(left + 1, px(row.end));
    out.push(rect(left, y + rowHeight / 2 - 5, right - left, 10, row.colour));
    out.push(text(Math.min(right + 4, box.right - 30), y + rowHeight / 2 + 2.4, 6.5, false, MUTED,
      Number.isFinite(row.value) ? String(row.value) : '--'));
  });
  return out;
}

/** Legend chips under the axis: a colour square and the column name, wrapped over at most 3 rows. */
function legend(entries: Array<{ label: string; colour: string }>, x: number, y: number, width: number, maxRows = 3): string[] {
  const out: string[] = [];
  let cursor = x;
  let row = 0;
  let drawn = 0;
  for (const entry of entries) {
    if (drawn >= PDF_LEGEND_MAX) break;
    const label = fit(entry.label, width / 2, 7);
    const span = 12 + advance(label, 7);
    if (cursor + span > x + width) {
      row += 1;
      if (row >= maxRows) break;
      cursor = x;
    }
    out.push(rect(cursor, y + row * 13 - 5, 5, 5, entry.colour));
    out.push(text(cursor + 9, y + row * 13 - 1, 7, false, INK, label));
    cursor += span;
    drawn += 1;
  }
  const hidden = entries.length - drawn;
  if (hidden > 0) {
    out.push(text(x, y + row * 13 + 10, 6.5, false, MUTED, `+ ${hidden} more`));
  }
  return out;
}

/* ---------------- pages ---------------- */

interface Chrome {
  project: string;
  generatedAt: string;
  range: string;
  pages: number;
}

/** Header and footer of every page — the original prints `Graph` and `N/8` the same way. */
function chrome(context: Chrome, page: number, source: string): string[] {
  return [
    text(MARGIN, 26, 8.5, true, INK, 'Graph'),
    textRight(WIDTH - MARGIN, 26, 7, false, MUTED, fit(`${context.project}  ${context.generatedAt}  GPS ${context.range}`, WIDTH - 2 * MARGIN - 40, 7)),
    rule(MARGIN, 33, WIDTH - MARGIN, 33, 0.6, GRID),
    rule(MARGIN, HEIGHT - 30, WIDTH - MARGIN, HEIGHT - 30, 0.6, GRID),
    text(MARGIN, HEIGHT - 18, 6.5, false, MUTED, fit(source, WIDTH * 0.6, 6.5)),
    textRight(WIDTH - MARGIN, HEIGHT - 18, 7, false, MUTED, `${page}/${context.pages}`),
  ];
}

interface InfoField {
  label: string;
  value: string;
}

/**
 * Footer of the cover. Kept verbatim from the ASCII-only writer, so a pure-ASCII document is
 * byte-for-byte what it always was; the other two sentences appear only when they apply.
 */
const FONT_NOTE_ASCII = 'base-14 Helvetica, no embedded fonts';

const FONT_NOTE_DEGRADED =
  'base-14 Helvetica, no usable CJK TrueType face found: non-ASCII text is drawn as ?';

function embeddedFontNote(face: TrueTypeFace): string {
  return `base-14 Helvetica for ASCII, embedded ${face.name} TrueType for non-ASCII text`;
}

/** Page 1: the original's title + Report Information + Project Information + a summary table. */
function infoPage(files: CsvFile[], fields: InfoField[], context: Chrome, fontNote: string = FONT_NOTE_ASCII): string {
  const out: string[] = [];
  out.push(...chrome(context, 1, `${files.length} charts - hand-written PDF 1.4 - ${fontNote}`));

  out.push(textCentred(WIDTH / 2, 62, 22, true, INK, fit(context.project ? `${context.project} Report` : 'Report', WIDTH - 2 * MARGIN, 22)));
  out.push(rule(MARGIN, 76, WIDTH - MARGIN, 76, 1.2, RULE));

  let y = 98;
  out.push(text(MARGIN, y, 11.5, true, RULE, 'Report Information'));
  y += 18;
  for (const [label, value] of [
    ['Generated Date', context.generatedAt],
    ['Charts', String(files.length)],
    ['Pages', String(context.pages)],
  ] as Array<[string, string]>) {
    out.push(text(MARGIN + 6, y, 9, true, INK, label));
    out.push(text(MARGIN + 130, y, 9, false, INK, value));
    y += 14;
  }

  y += 12;
  out.push(text(MARGIN, y, 11.5, true, RULE, 'Project Information'));
  y += 18;
  for (const field of fields) {
    out.push(text(MARGIN + 6, y, 9, true, INK, field.label));
    out.push(text(MARGIN + 130, y, 9, false, INK, fit(field.value || '--', WIDTH - MARGIN - 140, 9)));
    y += 14;
  }

  y += 12;
  out.push(text(MARGIN, y, 11.5, true, RULE, 'Chart Summary'));
  y += 16;

  const columns: Array<[string, number]> = [
    ['Chart', MARGIN + 6],
    ['Section', MARGIN + 170],
    ['Rows', MARGIN + 330],
    ['Series', MARGIN + 380],
    ['Min', MARGIN + 450],
    ['Max', MARGIN + 530],
    ['Mean', MARGIN + 610],
    ['Page', MARGIN + 720],
  ];
  for (const [label, x] of columns) out.push(text(x, y, 7.5, true, MUTED, label));
  y += 10;
  out.push(rule(MARGIN, y, WIDTH - MARGIN, y, 0.6, GRID));
  y += 11;

  files.forEach((file, at) => {
    if (y > HEIGHT - 46) return;
    const spec = specOf(file.name);
    const model = modelOf(file, spec);
    const series = model.kind === 'line'
      ? model.series.length
      : model.kind === 'category'
        ? model.legend.length
        : model.kind === 'interval'
          ? model.rows.length
          : 1;
    const values: number[] = [];
    if (model.kind === 'line') {
      for (const item of model.series) for (const [, value] of item.points) values.push(value);
    }
    let low = '--';
    let high = '--';
    let mean = '--';
    if (values.length) {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
        sum += value;
      }
      low = precision(min);
      high = precision(max);
      mean = precision(sum / values.length);
    }
    out.push(text(MARGIN + 6, y, 8, false, INK, fit(spec.title, 160, 8)));
    out.push(text(MARGIN + 170, y, 8, false, INK, fit(spec.section || '--', 155, 8)));
    out.push(text(MARGIN + 330, y, 8, false, INK, String(file.rows.length)));
    out.push(text(MARGIN + 380, y, 8, false, INK, String(series)));
    out.push(text(MARGIN + 450, y, 8, false, INK, low));
    out.push(text(MARGIN + 530, y, 8, false, INK, high));
    out.push(text(MARGIN + 610, y, 8, false, INK, mean));
    out.push(text(MARGIN + 720, y, 8, false, INK, String(at + 2)));
    y += 12;
  });
  return out.join('\n');
}

/** Pages 2..: one chart each, with the section heading the original prints when a tab starts. */
function chartPage(file: CsvFile, spec: ChartSpec, model: ChartModel, context: Chrome, previousSection: string, page: number): string {
  const out: string[] = [];
  out.push(...chrome(context, page, `source: ${file.name}`));

  let y = 50;
  if (spec.section && spec.section !== previousSection) {
    out.push(text(MARGIN, y, 8, true, RULE, spec.section));
    y += 17;
  }
  out.push(text(MARGIN, y + 10, 15, true, INK, fit(spec.title, WIDTH - 2 * MARGIN - 220, 15)));

  const facts: string[] = [plural(file.rows.length, 'row')];
  if (model.kind === 'line') {
    facts.push(plural(model.series.length, 'series', 'series'));
    if (model.stats) facts.push(model.stats);
  } else if (model.kind === 'category') {
    facts.push(plural(model.legend.length, 'value'));
  } else if (model.kind === 'geomap') {
    facts.push(plural(model.points.length, 'fix', 'fixes'));
  } else {
    facts.push(plural(model.rows.length, 'condition'));
  }
  out.push(textRight(WIDTH - MARGIN, y + 10, 7.5, false, MUTED, facts.join('  -  ')));
  y += 20;
  out.push(rule(MARGIN, y + 4, WIDTH - MARGIN, y + 4, 1, RULE));

  const boxArea: Box = {
    left: MARGIN + (model.kind === 'interval' ? 186 : 46),
    right: WIDTH - MARGIN - 6,
    top: y + 22,
    bottom: HEIGHT - 118,
  };
  out.push(...frame(boxArea, model, { showY: true }));
  if (model.kind === 'line') out.push(...lines(boxArea, model));
  else if (model.kind === 'category') out.push(...bands(boxArea, model));
  else if (model.kind === 'geomap') out.push(...geomap(boxArea, model));
  else out.push(...intervals(boxArea, model));

  let cursor = boxArea.bottom + 40;
  const entries = model.kind === 'line'
    ? model.series.map((item) => ({ label: item.name, colour: item.colour }))
    : model.kind === 'category'
      ? model.legend
      : [];
  if (entries.length) out.push(...legend(entries, MARGIN, cursor, WIDTH - 2 * MARGIN));

  const notes: string[] = [];
  if (model.note) notes.push(model.note);
  if (model.kind === 'line' && model.series.length && file.rows.length > 1) {
    const total = model.series.reduce((sum, item) => sum + item.points.length, 0);
    const stride = Math.max(1, Math.ceil(total / PDF_POINT_BUDGET));
    if (stride > 1) notes.push(`every ${stride}th sample drawn`);
  }
  if (notes.length) {
    cursor = Math.min(HEIGHT - 44, cursor + 42);
    out.push(text(MARGIN, cursor, 6.5, false, MUTED, fit(notes.join('  -  '), WIDTH - 2 * MARGIN, 6.5)));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------------------------------- */

/** Map one object from the shared font builder onto this writer's object table. */
function appendFontObject(objects: Array<string | { dictionary: string; data: Uint8Array }>, object: CjkFontObject): void {
  if ('data' in object) {
    objects[object.number] = { dictionary: object.dictionary, data: object.data };
    return;
  }
  objects[object.number] = object.body;
}

function assemble(title: string, generatedAt: string, streams: string[], face: TrueTypeFace | null): Uint8Array {
  const pages: string[] = [];
  let next = 6; // 1 catalog, 2 page tree, 3 info, 4 F1, 5 F2
  const pageNumber: number[] = [];
  const contentsNumber: number[] = [];
  for (let index = 0; index < streams.length; index++) {
    pageNumber.push(next++);
    contentsNumber.push(next++);
  }
  // The embedded face, if any, is parked after the pages: an ASCII-only document never gets here,
  // so it keeps its old object numbers — and its old bytes.
  const fontParts = face ? buildCjkFontObjects(face, next) : null;
  if (fontParts) next += CJK_FONT_OBJECTS;
  const fontResources = fontParts
    ? `/F1 4 0 R /F2 5 0 R /F3 ${fontParts.type0} 0 R`
    : '/F1 4 0 R /F2 5 0 R';

  const objects: Array<string | { dictionary: string; data: Uint8Array }> = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageNumber.map((number) => `${number} 0 R`).join(' ')}] /Count ${streams.length} >>`;
  objects[3] = [
    '<< /Title ' + (pdfUnicodeString(title) ?? literal(title)),
    '/Creator (packages/app pdf)',
    // The producer names the embedded face, exactly like the graph writer does.
    '/Producer ' + (fontParts && face
      ? `(packages/app hand-written PDF 1.4, embedded ${face.name} for non-ASCII text)` : '(packages/app hand-written PDF 1.4)'),
    `/CreationDate (${pdfDate(generatedAt)})`,
    '>>',
  ].join('\n');
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  streams.forEach((stream, index) => {
    objects[pageNumber[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] `
      + `/Resources << /Font << ${fontResources} >> /ProcSet [/PDF /Text] >> `
      + `/Contents ${contentsNumber[index]} 0 R >>`;
    objects[contentsNumber[index]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  if (fontParts) for (const object of fontParts.objects) appendFontObject(objects, object);

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (value: string) => {
    const chunk = Buffer.from(value, 'latin1');
    chunks.push(chunk);
    length += chunk.length;
  };
  const pushBytes = (data: Uint8Array) => {
    const chunk = Buffer.from(data);
    chunks.push(chunk);
    length += chunk.length;
  };

  push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = length;
    const entry = objects[number];
    if (typeof entry === 'string') {
      push(`${number} 0 obj\n${entry}\nendobj\n`);
      continue;
    }
    push(`${number} 0 obj\n${entry.dictionary}\nstream\n`);
    pushBytes(entry.data);
    push('\nendstream\nendobj\n');
  }

  const startxref = length;
  const size = objects.length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let number = 1; number < size; number++) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

export interface GraphPdfReport {
  bytes: Uint8Array;
  /** 1 information page + one per CSV. */
  pages: number;
  charts: number;
  /** `<project>.pdf`, the name Graph's own export used (`clean.pdf`), ASCII-escaped for the header. */
  fileName: string;
  /**
   * The project the document names, in its header-safe form (`%E9%87%8E…` when the CSV's
   * `#Project Name:` is not ASCII) — the route puts it straight into `X-PDF-Project`. The title on
   * the cover keeps the real spelling.
   */
  project: string;
}

/** Build the document once and report what it contains (used by the HTTP route's headers). */
export function graphPdfReport(sources: GraphPdfSource[], options: GraphPdfOptions = {}): GraphPdfReport {
  const generatedAt = options.generatedAt ?? stamp(new Date());
  const files = sources.map(parseCsvSource);
  const pages = 1 + files.length;
  const face = beginPdfFont(options);

  try {
    const first = files[0]?.comments ?? {};
    const fields: InfoField[] = [
      { label: 'Project Name', value: first['Project Name'] ?? '--' },
      { label: 'Project Directory', value: first['Project Directory'] ?? '--' },
      { label: 'Data File Name', value: first['Data File Name'] ?? '--' },
      { label: 'Start Time (GPS)', value: first['Start Time(GPS)'] ?? '--' },
      { label: 'End Time (GPS)', value: first['End Time(GPS)'] ?? '--' },
      { label: 'Duration', value: first.Duration ?? '--' },
    ];
    const project = fields[0].value === '--' ? 'graph' : fields[0].value;
    const start = fields[3].value === '--' ? '?' : fields[3].value;
    const end = fields[4].value === '--' ? '?' : fields[4].value;
    const title = options.title ?? `${project === 'graph' ? 'Graph' : project} Report`;
    const context: Chrome = { project, generatedAt, range: `${start} .. ${end}`, pages };

    // The cover can be the only page with non-ASCII text (project name, directory), so it is drawn
    // once to learn what the footer must say and once with that sentence. The probe only adds
    // glyphs to the same maps, so the second render is the one that is kept.
    const streams = [infoPage(files, fields, context, FONT_NOTE_ASCII)];
    let previous = '';
    files.forEach((file, index) => {
      const spec = specOf(file.name);
      streams.push(chartPage(file, spec, modelOf(file, spec), context, previous, index + 2));
      previous = spec.section;
    });

    const embedded = cjkUsedEmbedded();
    const fontNote = embedded && face
      ? embeddedFontNote(face)
      : cjkUsedDegraded() ? FONT_NOTE_DEGRADED : FONT_NOTE_ASCII;
    streams[0] = infoPage(files, fields, context, fontNote);

    return {
      bytes: assemble(title, generatedAt, streams, embedded ? face : null),
      pages,
      charts: files.length,
      fileName: graphPdfFileName(project),
      project: asciiHeaderValue(project),
    };
  } finally {
    endPdfFont();
  }
}

/**
 * Build the document. One information page plus one page per CSV, in the order given — pass
 * {@link graphPdfOrder} to get the catalogue's order (the original's tab order).
 */
export function buildGraphPdf(sources: GraphPdfSource[], options: GraphPdfOptions = {}): Uint8Array {
  return graphPdfReport(sources, options).bytes;
}

/**
 * Escape a value so it can go into an HTTP header. Node refuses a header value that is not ASCII
 * (`ERR_INVALID_CHAR`), and both `Content-Disposition` and `X-PDF-Project` are built from the
 * project name. Non-ASCII characters become their UTF-8 `%XX` form — reversible, deterministic,
 * and readable as a URL. The PDF's own `/Title` keeps the real name.
 */
function asciiHeaderValue(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code < 0x20 || code > 0x7e) {
      for (const byte of Buffer.from(char, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * `<project>.pdf`, the name Graph's own export used (`clean.pdf`).
 *
 * The name goes straight into `Content-Disposition: attachment; filename="…"`, so it is escaped
 * with {@link asciiHeaderValue}; `a/b:c` still becomes `a_b_c.pdf`.
 */
export function graphPdfFileName(projectName: string): string {
  return `${asciiHeaderValue(String(projectName || 'graph').replace(/[\\/:*?"<>|]+/g, '_'))}.pdf`;
}
