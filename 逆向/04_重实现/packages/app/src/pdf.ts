/**
 * A **hand-written PDF 1.4** for the Graph page's *Export → PDF* action.
 *
 * The page used to fall back to `window.print()` inside a hidden iframe: no PDF library exists in
 * this repository (the npm registry is unreachable), and printing is honest but it leaves the format
 * to the browser's print dialog. This module writes the document itself, so the button can download
 * a real `.pdf` byte-for-byte reproducible from the CSVs:
 *
 * ```
 * page 1      <project> Report
 *             Report Information   Generated Date / Charts / Pages
 *             Project Information  the six comment fields, same spellings as the CSVs
 *             Contents             one row per CSV: chart, rows, columns, series, min, max
 * page 2..13  one page per CSV
 *             title and caption, a plot with four gridlines and the series as one polyline,
 *             and the first rows of the file as a table
 * ```
 *
 * Everything is ASCII and uncompressed: the object table is written in a fixed order, every string
 * can be found with a plain text search, and the `xref` holds exact byte offsets — the test reads
 * them back and checks that each one really points at its `N 0 obj`. Fonts are the base-14
 * `Helvetica` / `Helvetica-Bold` referenced by name (`/WinAnsiEncoding`), never embedded; a
 * character outside printable ASCII is written as `?` because such a face cannot draw it.
 *
 * What this is *not*: a pixel copy of Graph's `clean.pdf` (348 419 B, printed through Chromium). The
 * layout is ours; the numbers are the same ones the CSV files and `packages/graph`'s HTML report
 * carry. `packages/graph/src/pdf.ts` is the other writer in this repo and is richer (it also draws
 * every column of a wide table); this one exists so the **app** can serve a download without
 * depending on that package, which is being rewritten in parallel.
 */

/** A4 landscape, in points — the page box the suite's own report was printed at. */
export const PDF_PAGE = { width: 842, height: 595 } as const;

/** Rows of a CSV printed under its chart. */
export const PDF_ROWS = 8;

/** Points drawn per series; longer files are decimated (every n-th row, last row kept). */
export const PDF_MAX_POINTS = 600;

export interface GraphPdfSource {
  /** Bare file name as exported by Graph, e.g. `Height.csv`. */
  name: string;
  /** The file's text, BOM and `#` comments included. */
  text: string;
}

export interface GraphPdfOptions {
  /**
   * *Generated Date*, spelled the way the CSVs spell theirs (`2026/10/30 21:00:00`). Also the
   * document's `CreationDate`; the only clock in this module, so a fixed value gives fixed bytes.
   */
  generatedAt?: string;
  /** Heading; default `<project> Report`. */
  title?: string;
  /** Rows printed under each chart (default {@link PDF_ROWS}). */
  rows?: number;
}

/* ------------------------------------------------------------------------------------------------
 * CSV: the same shape `graphcsv.ts` reads — six `#` comment lines, a header row, then data
 * ---------------------------------------------------------------------------------------------- */

interface CsvFile {
  name: string;
  chart: string;
  comments: Record<string, string>;
  columns: string[];
  rows: string[][];
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
  return { name: source.name, chart: source.name.replace(/\.csv$/i, ''), comments, columns, rows };
}

/** `"2442  463098.000"` → absolute GPS seconds, or `null`. */
function gpsSeconds(cell: string): number | null {
  const match = /^\s*(\d{3,5})\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(cell ?? '');
  return match ? Number(match[1]) * 604_800 + Number(match[2]) : null;
}

interface Series {
  label: string;
  /** `[x, y]` pairs; x is seconds (time files) or the row index. */
  points: Array<[number, number]>;
  xFrom: string;
  xTo: string;
  min: number;
  max: number;
  mean: number;
  first: number;
  last: number;
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

/** First numeric column that is not the timestamp, as a plottable series. */
function seriesOf(file: CsvFile): Series | null {
  const timeIndex = file.columns.findIndex((column) => /timestamp/i.test(column));
  // A condition table (`name,start,end,value`, `Receiver Status.csv`) has no timestamp; there the
  // `value` column is the measurement and the row index is the axis.
  const preferred = timeIndex < 0 ? file.columns.findIndex((column) => /^value$/i.test(column)) : -1;
  const index = preferred >= 0
    ? preferred
    : file.columns.findIndex((_column, at) => at !== timeIndex && isNumericColumn(file.rows, at));
  if (index < 0) return null;

  const times = timeIndex >= 0
    ? file.rows.map((row) => gpsSeconds(row[timeIndex] ?? '')).filter((value): value is number => value !== null)
    : [];
  const timed = timeIndex >= 0 && times.length === file.rows.length && times.length > 0;
  const base = timed ? times[0] : 0;

  const points: Array<[number, number]> = [];
  file.rows.forEach((row, at) => {
    const value = Number(row[index] ?? '');
    if (!Number.isFinite(value)) return;
    points.push([timed ? times[at] - base : at, value]);
  });
  if (!points.length) return null;

  const values = points.map(([, y]) => y);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const week = timed ? Math.floor(base / 604_800) : 0;
  const label = timed
    ? (seconds: number) => `W${week} ${seconds.toFixed(3)}`
    : (seconds: number) => `#${Math.round(seconds) + 1}`;
  return {
    label: file.columns[index] ?? '',
    points,
    xFrom: label(0),
    xTo: label(timed ? points[points.length - 1][0] : points.length - 1),
    min,
    max,
    mean: sum / values.length,
    first: values[0],
    last: values[values.length - 1],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Content-stream primitives
 * ---------------------------------------------------------------------------------------------- */

const INK = '0.12 0.13 0.15';
const MUTED = '0.42 0.46 0.5';
const GRID = '0.9 0.91 0.93';
const AXIS = '0.6 0.64 0.69';
const RULE = '0 0.32 0.44';

const MARGIN = 40;
const CONTENT = PDF_PAGE.width - 2 * MARGIN;

/** Top-origin y → the PDF's bottom-origin y. */
function top(y: number): number {
  return PDF_PAGE.height - y;
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

function text(x: number, y: number, size: number, bold: boolean, colour: string, value: string): string {
  return `BT ${colour} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${round(x)} ${round(top(y))} Td ${literal(value)} Tj ET`;
}

function rule(x1: number, y1: number, x2: number, y2: number, width: number, colour: string): string {
  return `${colour} RG ${width} w ${round(x1)} ${round(top(y1))} m ${round(x2)} ${round(top(y2))} l S`;
}

/** Helvetica's average advance is ~0.55 em; enough to cut a label before it leaves the page. */
function fit(value: string, width: number, size: number): string {
  const budget = Math.max(1, Math.floor(width / (size * 0.55)));
  return value.length <= budget ? value : `${value.slice(0, Math.max(1, budget - 3))}...`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/* ------------------------------------------------------------------------------------------------
 * Pages
 * ---------------------------------------------------------------------------------------------- */

interface InfoField {
  label: string;
  value: string;
}

function infoPage(files: CsvFile[], fields: InfoField[], generatedAt: string, title: string, pages: number): string {
  const out: string[] = [];
  let y = MARGIN + 6;

  out.push(text(MARGIN, y, 22, true, INK, fit(title, CONTENT, 22)));
  y += 18;
  out.push(text(MARGIN, y, 9.5, false, MUTED, `${files.length} charts - ${pages} pages - hand-written PDF 1.4`));
  y += 14;
  out.push(rule(MARGIN, y, PDF_PAGE.width - MARGIN, y, 1.2, RULE));

  y += 30;
  out.push(text(MARGIN, y, 12, true, RULE, 'Report Information'));
  y += 20;
  for (const [label, value] of [['Generated Date', generatedAt], ['Charts', String(files.length)], ['Pages', String(pages)]]) {
    out.push(text(MARGIN + 6, y, 9.5, true, INK, label));
    out.push(text(MARGIN + 180, y, 9.5, false, INK, value));
    y += 15;
  }

  y += 16;
  out.push(text(MARGIN, y, 12, true, RULE, 'Project Information'));
  y += 20;
  for (const field of fields) {
    out.push(text(MARGIN + 6, y, 9.5, true, INK, field.label));
    out.push(text(MARGIN + 180, y, 9.5, false, INK, fit(field.value || '--', CONTENT - 190, 9.5)));
    y += 15;
  }

  y += 16;
  out.push(text(MARGIN, y, 12, true, RULE, 'Contents'));
  y += 18;
  const columns: Array<[string, number]> = [
    ['Chart', MARGIN + 6],
    ['Rows', MARGIN + 320],
    ['Columns', MARGIN + 380],
    ['Series', MARGIN + 450],
    ['Min', MARGIN + 600],
    ['Max', MARGIN + 690],
  ];
  for (const [label, x] of columns) out.push(text(x, y, 8, true, MUTED, label));
  y += 12;
  out.push(rule(MARGIN, y, PDF_PAGE.width - MARGIN, y, 0.6, GRID));
  y += 11;
  for (const file of files) {
    if (y > PDF_PAGE.height - MARGIN - 24) break;
    const series = seriesOf(file);
    out.push(text(MARGIN + 6, y, 8.5, false, INK, fit(file.chart, 300, 8.5)));
    out.push(text(MARGIN + 320, y, 8.5, false, INK, String(file.rows.length)));
    out.push(text(MARGIN + 380, y, 8.5, false, INK, String(file.columns.length)));
    out.push(text(MARGIN + 450, y, 8.5, false, INK, fit(series?.label ?? '--', 140, 8.5)));
    out.push(text(MARGIN + 600, y, 8.5, false, INK, series ? precision(series.min) : '--'));
    out.push(text(MARGIN + 690, y, 8.5, false, INK, series ? precision(series.max) : '--'));
    y += 12;
  }

  out.push(text(
    MARGIN,
    PDF_PAGE.height - MARGIN + 8,
    7,
    false,
    MUTED,
    'Generated from the CSVs in samples/graph/export/csv - no embedded fonts - ASCII text only',
  ));
  out.push(text(PDF_PAGE.width / 2 - 14, PDF_PAGE.height - MARGIN + 8, 7, false, MUTED, `page 1 / ${pages}`));
  return out.join('\n');
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

function chartPage(file: CsvFile, series: Series | null, rowCount: number, page: number, pages: number): string {
  const out: string[] = [];
  let y = MARGIN + 6;

  out.push(text(MARGIN, y, 16, true, INK, fit(file.chart, CONTENT, 16)));
  y += 16;
  const caption = series
    ? `${file.rows.length} rows - ${file.columns.length} columns - series \`${series.label}\` x ${series.xFrom} .. ${series.xTo}`
    : `${file.rows.length} rows - ${file.columns.length} columns - no numeric column to plot`;
  out.push(text(MARGIN, y, 8.5, false, MUTED, fit(caption, CONTENT - 210, 8.5)));
  if (series) {
    out.push(text(PDF_PAGE.width - MARGIN - 186, y, 7.5, false, INK,
      `min ${precision(series.min)}  max ${precision(series.max)}  mean ${precision(series.mean)}`));
  }
  y += 8;
  out.push(rule(MARGIN, y, PDF_PAGE.width - MARGIN, y, 1, RULE));

  const plot = { left: MARGIN + 34, right: PDF_PAGE.width - MARGIN - 10, top: y + 24, bottom: y + 218 };
  out.push(...plotFrame(plot, series));

  // Table of the first rows: timestamp column plus the numeric columns, whole columns only.
  let tableTop = plot.bottom + 40;
  const timeIndex = file.columns.findIndex((column) => /timestamp/i.test(column));
  const numeric = file.columns
    .map((column, at) => ({ column, at }))
    .filter((entry) => entry.at !== timeIndex && isNumericColumn(file.rows, entry.at))
    .slice(0, 3);
  const shown = [
    ...(timeIndex >= 0 ? [{ column: file.columns[timeIndex], at: timeIndex }] : []),
    ...numeric,
  ];
  if (shown.length) {
    const width = CONTENT / shown.length;
    out.push(text(MARGIN, tableTop, 9, true, RULE, 'First rows'));
    tableTop += 14;
    shown.forEach((entry, at) => {
      out.push(text(MARGIN + at * width, tableTop, 7.5, true, MUTED, fit(entry.column, width - 6, 7.5)));
    });
    tableTop += 10;
    out.push(rule(MARGIN, tableTop, PDF_PAGE.width - MARGIN, tableTop, 0.6, GRID));
    tableTop += 10;
    for (const row of file.rows.slice(0, rowCount)) {
      shown.forEach((entry, at) => {
        out.push(text(MARGIN + at * width, tableTop, 7.5, false, INK, fit(row[entry.at] ?? '', width - 6, 7.5)));
      });
      tableTop += 10;
    }
    if (file.rows.length > rowCount) {
      out.push(text(MARGIN, tableTop + 2, 7, false, MUTED, `showing ${rowCount} of ${file.rows.length} rows`));
    }
  }

  out.push(text(
    MARGIN,
    PDF_PAGE.height - MARGIN + 8,
    7,
    false,
    MUTED,
    `source: ${file.name}`,
  ));
  out.push(text(PDF_PAGE.width / 2 - 14, PDF_PAGE.height - MARGIN + 8, 7, false, MUTED, `page ${page} / ${pages}`));
  return out.join('\n');
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Four gridlines with their values on the left, a frame, and one polyline for the series. */
function plotFrame(box: Box, series: Series | null): string[] {
  const out: string[] = [];
  const height = box.bottom - box.top;
  const flat = series !== null && series.max === series.min;
  const step = series ? (series.max - series.min) / 4 : 0;
  const decimals = series && step > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)))) : 0;

  for (let tick = 0; tick <= 4; tick++) {
    const lineTop = box.top + (height * tick) / 4;
    out.push(rule(box.left, lineTop, box.right, lineTop, 0.5, GRID));
    if (series && !flat) {
      const value = series.max - step * tick;
      out.push(text(box.left - 30, lineTop + 2.5, 6.5, false, MUTED, value.toFixed(decimals)));
    }
  }
  if (series && flat) {
    out.push(text(box.left + 12, box.top + height / 2 + 3, 7, false, MUTED,
      `${series.max.toFixed(6)} (constant - every sample is the same)`));
  }
  out.push(rule(box.left, box.top, box.left, box.bottom, 0.8, AXIS));
  out.push(rule(box.left, box.bottom, box.right, box.bottom, 0.8, AXIS));
  if (!series || series.points.length === 0) {
    out.push(text(box.left + 12, box.top + height / 2, 9, false, MUTED, 'no numeric series'));
    return out;
  }

  const span = series.points[series.points.length - 1][0] || 1;
  const x = (value: number) => box.left + ((box.right - box.left) * value) / (span || 1);
  const y = (value: number) => (flat
    ? box.top + height / 2
    : box.bottom - ((box.bottom - box.top) * (value - series.min)) / (series.max - series.min));

  const stride = Math.max(1, Math.ceil(series.points.length / PDF_MAX_POINTS));
  const drawn = series.points.filter((_, at) => at % stride === 0);
  const last = series.points[series.points.length - 1];
  if (drawn[drawn.length - 1][0] !== last[0]) drawn.push(last);

  const path = drawn
    .map(([px, py], at) => `${round(x(px))} ${round(top(y(py)))} ${at === 0 ? 'm' : 'l'}`)
    .join(' ');
  out.push(`0.122 0.467 0.706 RG 1.1 w ${path} S`);

  out.push(text(box.left, box.bottom + 13, 6.5, false, MUTED, series.xFrom));
  out.push(text(box.right - 42, box.bottom + 13, 6.5, false, MUTED, series.xTo));
  if (stride > 1) out.push(text(box.left, box.top - 6, 6.5, false, MUTED, `every ${stride}th row drawn`));
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------------------------------- */

function assemble(title: string, generatedAt: string, streams: string[]): Uint8Array {
  const pages: string[] = [];
  let next = 6; // 1 catalog, 2 page tree, 3 info, 4 F1, 5 F2
  const pageNumber: number[] = [];
  const contentsNumber: number[] = [];
  for (let index = 0; index < streams.length; index++) {
    pageNumber.push(next++);
    contentsNumber.push(next++);
  }

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageNumber.map((number) => `${number} 0 R`).join(' ')}] /Count ${streams.length} >>`;
  objects[3] = [
    '<< /Title ' + literal(title),
    '/Creator (packages/app pdf)',
    '/Producer (packages/app hand-written PDF 1.4)',
    `/CreationDate (${pdfDate(generatedAt)})`,
    '>>',
  ].join('\n');
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  streams.forEach((stream, index) => {
    objects[pageNumber[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] `
      + '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> /ProcSet [/PDF /Text] >> '
      + `/Contents ${contentsNumber[index]} 0 R >>`;
    objects[contentsNumber[index]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (value: string) => {
    const chunk = Buffer.from(value, 'latin1');
    chunks.push(chunk);
    length += chunk.length;
  };

  push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = length;
    push(`${number} 0 obj\n${objects[number]}\nendobj\n`);
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
  fileName: string;
}

/** Build the document once and report what it contains (used by the HTTP route's headers). */
export function graphPdfReport(sources: GraphPdfSource[], options: GraphPdfOptions = {}): GraphPdfReport {
  const generatedAt = options.generatedAt ?? stamp(new Date());
  const rowCount = options.rows ?? PDF_ROWS;
  const files = sources.map(parseCsvSource);
  const pages = 1 + files.length;

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
  const title = options.title ?? `${fields[0].value === '--' ? 'Graph' : fields[0].value} Report`;

  const streams = [infoPage(files, fields, generatedAt, title, pages)];
  files.forEach((file, index) => {
    streams.push(chartPage(file, seriesOf(file), rowCount, index + 2, pages));
  });
  return {
    bytes: assemble(title, generatedAt, streams),
    pages,
    charts: files.length,
    fileName: graphPdfFileName(project),
  };
}

/**
 * Build the document. One information page plus one page per CSV, in the order given. Pass
 * `options.generatedAt` to get the same bytes twice.
 */
export function buildGraphPdf(sources: GraphPdfSource[], options: GraphPdfOptions = {}): Uint8Array {
  return graphPdfReport(sources, options).bytes;
}

/** `<project>.pdf`, the name Graph's own export used (`clean.pdf`). */
export function graphPdfFileName(projectName: string): string {
  return `${String(projectName || 'graph').replace(/[\\/:*?"<>|]+/g, '_')}.pdf`;
}

