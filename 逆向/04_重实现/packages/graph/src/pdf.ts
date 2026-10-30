/**
 * `ExportPDFReport` — a **hand-written PDF 1.4** report, one page per chart.
 *
 * The original Graph prints `clean.pdf` (348 419 B) through Chromium/Skia: same information as
 * `clean.html` (project information + one chart per page + a first-rows table), vectorised by the
 * browser. There is no PDF library to link against here — the npm registry is unreachable — so this
 * file writes the container itself: a 31-object table, an `xref` with exact byte offsets and a
 * `trailer`. Nothing is compressed, so every string in the document can be found by a plain text
 * search and the tests can check the offsets rather than trusting them.
 *
 * Layout (A4 landscape, 842 × 595 pt, the same page box Chromium used):
 *
 * ```
 * page 1   <project> Report
 *          Report Information   Generated Date / Charts / Pages
 *          Project Information  the six CSV comment fields (same spellings)
 *          Message Summary      message → count
 * page 2+  one chart page:  title / caption
 *                           legend (colour swatch + column + last value [+ "constant"])
 *                           plot: shared Y axis, 5 ticks, one `m`/`l`/`S` path per column
 *                           table: the first 20 CSV rows
 * ```
 *
 * Design decisions worth knowing:
 *
 *  - **Fonts are the base-14 `Helvetica` / `Helvetica-Bold`**, referenced by name and not embedded
 *    (`/Encoding /WinAnsiEncoding`). Text is therefore ASCII here; anything outside printable ASCII
 *    is written as `?` because a non-embedded Latin-1 face cannot draw it anyway.
 *  - **One shared Y axis per page**, as asked for this report: min/max over the columns first, then
 *    one projection. A column whose values are all equal cannot be scaled, so it is drawn as a
 *    horizontal line at its own value and its legend entry says `constant` — nothing disappears
 *    silently the way a shared axis would make it.
 *  - **The table is truncated by columns, never by rows**: `Tracking Time` has 61 columns and
 *    `GNSS Signal Strength` 75, which cannot fit 762 pt at a readable size. Column 0 (the timestamp)
 *    plus as many whole columns as fit are printed, and the caption states `showing X of Y columns`.
 *  - Coordinates and labels are rounded with `toFixed`, the object table is built in a fixed order
 *    and the only clock is `options.generatedAt`, so the same input gives the same bytes.
 *
 * What this is *not*: a pixel copy of `clean.pdf`. The rasterised map, Chromium's font subsets and
 * its own object ordering are gone; the structure (information page, then one page per chart) and
 * the extracted text are what we reproduce. `03_分析/06_Graph应用.md §13` records that difference.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GraphProject } from './project.ts';
import { chartMessages } from './project.ts';
import { formatDuration, formatGpsCommentTime } from './format.ts';
import { parseReportCsv, type ParsedReportCsv } from './html.ts';

/** One chart's CSV, exactly the shape `buildHtmlReport` takes. */
export interface PdfChartSource {
  /** Chart title — also the CSV file name without `.csv`. */
  title: string;
  /** CSV bytes or already-decoded text. */
  csv: string | Uint8Array;
}

export interface PdfReportOptions {
  /** Data rows tabulated under each chart (default {@link PDF_TABLE_ROWS}). */
  tableRows?: number;
  /**
   * *Generated Date* value, and the source of the document `CreationDate`. Fixed value ⇒ reproducible
   * bytes; the default is the current local time, spelled the original's way.
   */
  generatedAt?: string;
  /** Keep only these chart titles (Graph's `selectedPlots`). */
  selectedPlots?: string[];
  /** Document heading; default `<projectName> Report`. */
  title?: string;
}

/** Rows of the per-chart data table. The CSV itself is never embedded in full. */
export const PDF_TABLE_ROWS = 20;

/**
 * Points drawn per series. `GNSS Signal Strength` on a full-day capture is hundreds of thousands of
 * rows; a vector path that long is both unreadable and megabytes of content stream, so beyond this
 * count every n-th row is drawn (the last row always included) and the caption says so.
 */
export const PDF_MAX_POINTS = 1200;

/** A4 landscape, in points — the page box `clean.pdf` was printed at. */
export const PDF_PAGE = { width: 842, height: 595 } as const;

/** Series colours (the same palette `html.ts` uses, as 0–1 RGB for the content stream). */
const PALETTE: [number, number, number][] = [
  [0.122, 0.467, 0.706],
  [0.839, 0.153, 0.157],
  [0.173, 0.627, 0.173],
  [0.58, 0.404, 0.741],
  [1, 0.498, 0.055],
  [0.549, 0.337, 0.294],
  [0.89, 0.467, 0.761],
  [0.09, 0.745, 0.812],
  [0.737, 0.741, 0.133],
  [0.498, 0.498, 0.498],
];

const INK = [0.12, 0.13, 0.15] as const;
const MUTED = [0.42, 0.46, 0.5] as const;
const GRID = [0.9, 0.91, 0.93] as const;
const AXIS = [0.6, 0.64, 0.69] as const;
const RULE = [0.0, 0.32, 0.44] as const;

const MARGIN = 40;
const CONTENT_WIDTH = PDF_PAGE.width - 2 * MARGIN;
const TABLE_SIZE = 6.4;
const TABLE_ROW = 9.2;
const TABLE_HEAD = 11;
const LEGEND_SIZE = 7;

/* ------------------------------------------------------------------------------------------------
 * Text metrics — Helvetica AFM advance widths (1/1000 em) for ASCII, so right-aligned table cells
 * and legend wrapping land where they should without a font file.
 * ---------------------------------------------------------------------------------------------- */

const HELVETICA_WIDTHS = new Map<number, number>([
  [32, 278], [33, 278], [34, 355], [35, 556], [36, 556], [37, 889], [38, 667], [39, 191],
  [40, 333], [41, 333], [42, 389], [43, 584], [44, 278], [45, 333], [46, 278], [47, 278],
  [48, 556], [49, 556], [50, 556], [51, 556], [52, 556], [53, 556], [54, 556], [55, 556],
  [56, 556], [57, 556], [58, 278], [59, 278], [60, 584], [61, 584], [62, 584], [63, 556],
  [64, 1015], [65, 667], [66, 667], [67, 722], [68, 722], [69, 667], [70, 611], [71, 778],
  [72, 722], [73, 278], [74, 500], [75, 667], [76, 556], [77, 833], [78, 722], [79, 778],
  [80, 667], [81, 778], [82, 722], [83, 667], [84, 611], [85, 722], [86, 667], [87, 944],
  [88, 667], [89, 667], [90, 611], [91, 278], [92, 278], [93, 278], [94, 469], [95, 556],
  [96, 333], [97, 556], [98, 556], [99, 500], [100, 556], [101, 556], [102, 278], [103, 556],
  [104, 556], [105, 222], [106, 222], [107, 500], [108, 222], [109, 833], [110, 556], [111, 556],
  [112, 556], [113, 556], [114, 333], [115, 500], [116, 278], [117, 556], [118, 500], [119, 722],
  [120, 500], [121, 500], [122, 500], [123, 334], [124, 260], [125, 334], [126, 584],
]);

/** Rendered width of `text` in points at `size`. Unknown/wide characters count as `?`. */
function textWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    units += HELVETICA_WIDTHS.get(code) ?? (code < 32 || code > 126 ? 556 : 556);
  }
  return (units / 1000) * size;
}

/** Cut `text` so it fits `width`, ending in `...` when anything was dropped. */
function fitText(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}...`, size) > width) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/* ------------------------------------------------------------------------------------------------
 * Content stream primitives
 * ---------------------------------------------------------------------------------------------- */

/**
 * A PDF literal string. Everything outside printable ASCII becomes `?`: the base-14 faces are not
 * embedded and are used with `/WinAnsiEncoding`, so a CJK path could not be drawn anyway — better a
 * visible `?` than an escaped byte the reader renders as mojibake.
 */
function pdfString(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code === 0x5c) out += '\\\\';
    else if (code < 32 || code > 126) out += '?';
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/** `0.122 0.467 0.706` — a colour operator body. */
function rgb(colour: readonly [number, number, number]): string {
  return colour.map((value) => round(value, 3).toString()).join(' ');
}

/** Fixed-point number with at most `digits` decimals and no trailing zeros (`40`, `2442.5`). */
function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function moveTo(x: number, y: number): string {
  return `${round(x)} ${round(y)} m`;
}

function lineTo(x: number, y: number): string {
  return `${round(x)} ${round(y)} l`;
}

function rect(x: number, y: number, width: number, height: number, fill: readonly [number, number, number]): string {
  return `${rgb(fill)} rg ${round(x)} ${round(y)} ${round(width)} ${round(height)} re f`;
}

function stroke(colour: readonly [number, number, number], width: number): string {
  return `${rgb(colour)} RG ${round(width, 2)} w`;
}

function rule(x1: number, y1: number, x2: number, y2: number, colour: readonly [number, number, number], width = 0.5): string {
  return `${stroke(colour, width)} ${moveTo(x1, y1)} ${lineTo(x2, y2)} S`;
}

type FontName = 'F1' | 'F2';
type Align = 'start' | 'middle' | 'end';

/** One text run, absolutely positioned (`Tm`), so no graphics state leaks between runs. */
function text(
  value: string,
  x: number,
  y: number,
  size: number,
  font: FontName = 'F1',
  colour: readonly [number, number, number] = INK,
  align: Align = 'start',
): string {
  const width = textWidth(value, size);
  const left = align === 'start' ? x : align === 'end' ? x - width : x - width / 2;
  return `BT /${font} ${round(size, 2)} Tf ${rgb(colour)} rg 1 0 0 1 ${round(left)} ${round(y)} Tm ${pdfString(value)} Tj ET`;
}

/** `1.19761` stays `1.19761`; axis ticks share the precision the tick step calls for. */
function axisLabel(value: number, step: number): string {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(step);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : magnitude >= 0.1 ? 3 : 4;
  if (Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < 1e-4)) return value.toExponential(2);
  return value.toFixed(decimals);
}

function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------------------------------------
 * Chart data → series
 * ---------------------------------------------------------------------------------------------- */

interface Series {
  name: string;
  values: number[];
  /** Set when the column is not numeric: ordinals back to their names (`Position Status`). */
  categories?: string[];
  /** Last cell exactly as the CSV prints it. */
  last: string;
}

function seriesOf(header: string[], rows: string[][], column: number): Series {
  const cells = rows.map((row) => row[column] ?? '');
  const numeric = cells.length > 0 && cells.every((cell) => cell !== '' && Number.isFinite(Number(cell)));
  if (numeric) {
    return { name: header[column] ?? '', values: cells.map(Number), last: cells[cells.length - 1] ?? '' };
  }
  const categories: string[] = [];
  const values = cells.map((cell) => {
    let index = categories.indexOf(cell);
    if (index === -1) index = categories.push(cell) - 1;
    return index;
  });
  return { name: header[column] ?? '', values, categories, last: cells[cells.length - 1] ?? '' };
}

function isConstant(series: Series): boolean {
  return series.values.length > 0 && series.values.every((value) => value === series.values[0]);
}

/* ------------------------------------------------------------------------------------------------
 * Page layout
 * ---------------------------------------------------------------------------------------------- */

interface PageGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Legend above the plot, wrapped to the content width. Returns the stream lines and the `y` the plot
 * may start below. Items past `maxLines` are dropped with an `+N more` marker rather than overflowing.
 */
function legend(lines: string[], series: Series[], top: number): { lines: string[]; bottom: number } {
  const maxLines = 8;
  const lineHeight = 9;
  let x = MARGIN;
  let y = top;
  let row = 0;
  let shown = 0;

  for (let index = 0; index < series.length; index++) {
    const entry = series[index];
    const label = isConstant(entry) ? `${entry.name} = ${entry.last} (constant)` : `${entry.name} ${entry.last}`;
    const labelText = fitText(label, CONTENT_WIDTH * 0.45, LEGEND_SIZE);
    const itemWidth = 7 + 3 + textWidth(labelText, LEGEND_SIZE) + 14;
    if (row >= maxLines) break;
    if (x + itemWidth > PDF_PAGE.width - MARGIN && x > MARGIN) {
      row += 1;
      if (row >= maxLines) break;
      x = MARGIN;
      y -= lineHeight;
    }
    const colour = PALETTE[index % PALETTE.length];
    lines.push(rect(x, y - 1.5, 6, 6, colour));
    lines.push(text(labelText, x + 9, y, LEGEND_SIZE, 'F1', MUTED));
    x += itemWidth;
    shown += 1;
  }
  if (shown < series.length) {
    if (x + textWidth(`+${series.length - shown} more`, LEGEND_SIZE) + 20 > PDF_PAGE.width - MARGIN) {
      row += 1;
      y -= lineHeight;
      x = MARGIN;
    }
    lines.push(text(`+${series.length - shown} more`, x, y, LEGEND_SIZE, 'F1', MUTED));
  }
  return { lines, bottom: y };
}

/** Column selection + the first `tableRows` rows, drawn from `tableTop` downwards. */
function renderTable(chart: ParsedReportCsv, tableRows: number, tableTop: number, lines: string[]): number {
  if (chart.header.length === 0) return 0;
  const shown = chart.rows.slice(0, tableRows);
  const rows = shown.length;

  // Column widths from the content that will actually be printed, then a greedy fit.
  const widths = chart.header.map((name, column) => {
    const cells = shown.map((row) => row[column] ?? '');
    const widest = Math.max(textWidth(name, TABLE_SIZE), ...cells.map((cell) => textWidth(cell, TABLE_SIZE)));
    return Math.min(112, Math.max(18, widest + 7));
  });

  const chosen: number[] = [];
  let used = 0;
  for (let column = 0; column < chart.header.length; column++) {
    const next = used + widths[column];
    if (chosen.length > 0 && next > CONTENT_WIDTH) break;
    chosen.push(column);
    used = next;
  }

  const headerTop = tableTop;
  const headerBottom = headerTop - TABLE_HEAD;
  lines.push(rect(MARGIN, headerBottom, used, TABLE_HEAD, [0.93, 0.95, 0.97]));
  let x = MARGIN;
  for (const column of chosen) {
    const width = widths[column];
    const label = fitText(chart.header[column] ?? '', width - 6, TABLE_SIZE);
    lines.push(text(label, column === 0 ? x + 3 : x + width - 3, headerBottom + 3.2, TABLE_SIZE, 'F2', RULE, column === 0 ? 'start' : 'end'));
    x += width;
  }

  let y = headerBottom;
  for (let index = 0; index < rows; index++) {
    y -= TABLE_ROW;
    if (index % 2 === 1) lines.push(rect(MARGIN, y, used, TABLE_ROW, [0.975, 0.98, 0.985]));
    let cellX = MARGIN;
    for (const column of chosen) {
      const width = widths[column];
      const raw = shown[index][column] ?? '';
      const cell = fitText(raw, width - 6, TABLE_SIZE);
      lines.push(text(cell, column === 0 ? cellX + 3 : cellX + width - 3, y + 2.4, TABLE_SIZE, 'F1', INK, column === 0 ? 'start' : 'end'));
      cellX += width;
    }
  }

  const note =
    rows < chart.rows.length
      ? `first ${rows} of ${chart.rows.length} rows (full data in the matching CSV)`
      : `${rows} row${rows === 1 ? '' : 's'}`;
  const columns = chosen.length < chart.header.length ? ` - showing ${chosen.length} of ${chart.header.length} columns` : '';
  lines.push(text(`${note}${columns}`, MARGIN, y - 9, 6.5, 'F1', MUTED));

  // Grid around the table, so a truncated row of cells still reads as a table.
  lines.push(rule(MARGIN, headerTop, MARGIN + used, headerTop, AXIS, 0.4));
  lines.push(rule(MARGIN, headerBottom, MARGIN + used, headerBottom, AXIS, 0.4));
  lines.push(rule(MARGIN, y, MARGIN + used, y, AXIS, 0.4));
  lines.push(rule(MARGIN, headerTop, MARGIN, y, AXIS, 0.4));
  lines.push(rule(MARGIN + used, headerTop, MARGIN + used, y, AXIS, 0.4));

  return headerTop - y;
}

/** One chart page: title, caption, legend, plot, table, footer. */
function chartPage(chart: ParsedReportCsv, title: string, tableRows: number, page: number, pages: number): string[] {
  const lines: string[] = [];
  const rows = chart.rows;
  const rowCount = rows.length;
  // Hard bounds: a page never holds more than PDF_TABLE_ROWS table rows, and a series never more
  // than PDF_MAX_POINTS vertices.
  const shownRows = Math.max(1, Math.min(tableRows, rowCount, PDF_TABLE_ROWS));
  const step = decimationStep(rowCount);

  lines.push(text(title, MARGIN, PDF_PAGE.height - 46, 15, 'F2', INK));
  lines.push(rule(MARGIN, PDF_PAGE.height - 52, PDF_PAGE.width - MARGIN, PDF_PAGE.height - 52, RULE, 1));

  const allSeries = chart.header.slice(1).map((_, index) => seriesOf(chart.header, rows, index + 1));
  // Subsample once, before layout: the hard bound applies to what is drawn, not only to the path.
  const plotted = step > 1 ? allSeries.map((entry) => decimate(entry, step)) : allSeries;
  const fitted = allSeries.filter((entry) => isConstant(entry));
  const caption =
    `${rowCount} row${rowCount === 1 ? '' : 's'} - ${allSeries.length} column${allSeries.length === 1 ? '' : 's'}` +
    (step > 1 ? ` - decimated (1/${step} points)` : '') +
    (fitted.length > 0 ? ` - ${fitted.length} constant (drawn flat, labelled constant)` : '') +
    ' - shared Y axis';
  lines.push(text(caption, MARGIN, PDF_PAGE.height - 64, 7.5, 'F1', MUTED));

  const box = legend(lines, plotted, PDF_PAGE.height - 78);

  // The table band is sized by the rows it will actually print (at most PDF_TABLE_ROWS), so a short
  // chart gets a taller plot instead of leaving half the page empty. The plot takes what is left
  // between the band and the legend, never less than 90 pt.
  const tableTop = MARGIN + TABLE_HEAD + shownRows * TABLE_ROW + 30;
  const geometry: PageGeometry = {
    left: MARGIN + 34,
    right: PDF_PAGE.width - MARGIN - 6,
    bottom: tableTop + 24,
    top: Math.max(tableTop + 24 + 90, box.bottom - 14),
  };
  if (geometry.top > PDF_PAGE.height - 90) geometry.top = PDF_PAGE.height - 90;

  if (rowCount === 0 || allSeries.length === 0) {
    lines.push(text('no rows in this chart', (MARGIN + PDF_PAGE.width - MARGIN) / 2, (geometry.top + geometry.bottom) / 2, 9, 'F1', MUTED, 'middle'));
  } else {
    renderPlot(lines, chart, plotted, geometry, step);
  }

  renderTable(chart, shownRows, tableTop, lines);
  lines.push(footer(page, pages));
  return lines;
}

/** 1 unless the chart has more rows than {@link PDF_MAX_POINTS}, then the stride that fits them. */
function decimationStep(rowCount: number): number {
  return rowCount <= PDF_MAX_POINTS ? 1 : Math.ceil(rowCount / PDF_MAX_POINTS);
}

/** Every `step`-th row, last row included, so the drawn series still ends at the final value. */
function decimate(series: Series, step: number): Series {
  const indices: number[] = [];
  for (let row = 0; row < series.values.length; row += step) indices.push(row);
  if (indices.length === 0 || indices[indices.length - 1] !== series.values.length - 1) {
    indices.push(Math.max(0, series.values.length - 1));
  }
  return { ...series, values: indices.map((row) => series.values[row]) };
}

/** Shared-axis plot: grid, ticks, one path per column, x labels from column 0. */
function renderPlot(lines: string[], chart: ParsedReportCsv, series: Series[], geometry: PageGeometry, step: number): void {
  const rowCount = chart.rows.length;
  const width = geometry.right - geometry.left;
  const height = geometry.top - geometry.bottom;
  // No spread: a full-day capture is far past the argument-list limit. Series are already decimated.
  let lo = Infinity;
  let hi = -Infinity;
  for (const entry of series) {
    for (const value of entry.values) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.01 : 1;
    lo -= pad;
    hi += pad;
  }

  const xOf = (index: number) =>
    rowCount === 1 ? geometry.left + width / 2 : geometry.left + (width * index) / (rowCount - 1);
  // PDF y grows upwards: the minimum sits on the bottom axis, the maximum at the top of the plot.
  const yOf = (value: number) => geometry.bottom + height * ((value - lo) / (hi - lo));

  const ticks = 5;
  const tickStep = (hi - lo) / (ticks - 1);
  for (let index = 0; index < ticks; index++) {
    const value = lo + tickStep * index;
    const y = yOf(value);
    lines.push(rule(geometry.left, y, geometry.right, y, GRID, 0.4));
    lines.push(text(axisLabel(value, tickStep), geometry.left - 6, y - 2.2, 7, 'F1', MUTED, 'end'));
  }
  lines.push(rule(geometry.left, geometry.top, geometry.left, geometry.bottom, AXIS, 0.6));
  lines.push(rule(geometry.left, geometry.bottom, geometry.right, geometry.bottom, AXIS, 0.6));

  series.forEach((entry, index) => {
    const colour = PALETTE[index % PALETTE.length];
    if (isConstant(entry)) {
      const y = yOf(entry.values[0] ?? 0);
      lines.push(rule(geometry.left, y, geometry.right, y, colour, 0.8));
      return;
    }
    const path: string[] = [stroke(colour, rowCount > 40 ? 0.7 : 0.9)];
    entry.values.forEach((value, position) => {
      // `position` counts decimated points; map it back to the row index the x axis is laid out on.
      const row = Math.min(rowCount - 1, position * step);
      path.push(position === 0 ? moveTo(xOf(row), yOf(value)) : lineTo(xOf(row), yOf(value)));
    });
    if (rowCount === 1) {
      lines.push(rect(xOf(0) - 1.4, yOf(entry.values[0]) - 1.4, 2.8, 2.8, colour));
      return;
    }
    path.push('S');
    lines.push(path.join(' '));
  });

  // X labels: the CSV's first column (GPS time, or the condition name for `Receiver Status`).
  const labelCount = rowCount <= 6 ? rowCount : 5;
  const labelRows =
    rowCount <= 6
      ? chart.rows.map((_, index) => index)
      : [...new Set([0, Math.floor((rowCount - 1) / 4), Math.floor((rowCount - 1) / 2), Math.floor((3 * (rowCount - 1)) / 4), rowCount - 1])];
  const labelMax = labelCount <= 6 ? 22 : 18;
  for (const index of labelRows) {
    const anchor: Align = index === 0 ? 'start' : index === rowCount - 1 ? 'end' : 'middle';
    const label = fitText(chart.rows[index]?.[0] ?? '', textWidth('0'.repeat(labelMax), 7), 7);
    lines.push(text(label, xOf(index), geometry.bottom - 10, 7, 'F1', MUTED, anchor));
  }
}

function footer(page: number, pages: number): string {
  return text(`page ${page} / ${pages}`, PDF_PAGE.width / 2, MARGIN - 18, 7, 'F1', MUTED, 'middle');
}

/* ------------------------------------------------------------------------------------------------
 * The information page
 * ---------------------------------------------------------------------------------------------- */

interface InfoField {
  label: string;
  value: string;
}

function infoPage(
  project: GraphProject,
  fields: InfoField[],
  charts: { title: string }[],
  generated: string,
  pages: number,
): string[] {
  const lines: string[] = [];
  const title = `${project.projectName} Report`;
  lines.push(text(title, MARGIN, PDF_PAGE.height - 72, 22, 'F2', INK));
  lines.push(rule(MARGIN, PDF_PAGE.height - 82, PDF_PAGE.width - MARGIN, PDF_PAGE.height - 82, RULE, 1.2));

  let y = PDF_PAGE.height - 110;
  lines.push(text('Report Information', MARGIN, y, 12, 'F2', RULE));
  y -= 20;
  for (const field of [
    { label: 'Generated Date', value: generated },
    { label: 'Charts', value: String(charts.length) },
    { label: 'Pages', value: String(pages) },
  ]) {
    lines.push(text(field.label, MARGIN + 6, y, 9.5, 'F2', INK));
    lines.push(text(field.value, MARGIN + 180, y, 9.5, 'F1', INK));
    y -= 15;
  }

  y -= 14;
  lines.push(text('Project Information', MARGIN, y, 12, 'F2', RULE));
  y -= 20;
  for (const field of fields) {
    lines.push(text(field.label, MARGIN + 6, y, 9.5, 'F2', INK));
    lines.push(text(field.value, MARGIN + 180, y, 9.5, 'F1', INK));
    y -= 15;
  }

  const summary = messageSummary(project, charts.map((chart) => chart.title));
  if (summary.length > 0) {
    y -= 14;
    lines.push(text('Message Summary', MARGIN, y, 12, 'F2', RULE));
    y -= 18;
    lines.push(text('Message Name', MARGIN + 6, y, 8, 'F2', MUTED));
    lines.push(text('Message Count', MARGIN + 180, y, 8, 'F2', MUTED));
    y -= 12;
    for (const entry of summary) {
      if (y < MARGIN + 40) break;
      lines.push(text(entry.name, MARGIN + 6, y, 9, 'F1', INK));
      lines.push(text(String(entry.count), MARGIN + 180, y, 9, 'F1', INK));
      y -= 13;
    }
  }

  lines.push(
    text(
      'Hand-written PDF 1.4 - base-14 Helvetica, no embedded fonts - charts read from the exported CSV data',
      MARGIN,
      MARGIN + 4,
      7.5,
      'F1',
      MUTED,
    ),
  );
  lines.push(text(`page 1 / ${pages}`, PDF_PAGE.width / 2, MARGIN - 18, 7, 'F1', MUTED, 'middle'));
  return lines;
}

/* ------------------------------------------------------------------------------------------------
 * Info fields — the six CSV comment lines, same spellings as the HTML report
 * ---------------------------------------------------------------------------------------------- */

function reportFields(project: GraphProject, charts: PdfChartSource[]): InfoField[] {
  const fromCsv = charts.length > 0 ? parseReportCsv(charts[0].csv).meta : {};
  const fallback = {
    'Project Name': project.projectName,
    'Project Directory': project.projectDirectory,
    'Data File Name': project.dataFileName,
    'Start Time(GPS)': formatGpsCommentTime(project.dataInfo.StartTime),
    'End Time(GPS)': formatGpsCommentTime(project.dataInfo.EndTime),
    Duration: formatDuration(project.dataInfo.Duration),
  };
  return [
    { label: 'Project Name', value: fromCsv['Project Name'] ?? fallback['Project Name'] },
    { label: 'Project Directory', value: fromCsv['Project Directory'] ?? fallback['Project Directory'] },
    { label: 'Data File Name', value: fromCsv['Data File Name'] ?? fallback['Data File Name'] },
    { label: 'Start Time (GPS)', value: fromCsv['Start Time(GPS)'] ?? fallback['Start Time(GPS)'] },
    { label: 'End Time (GPS)', value: fromCsv['End Time(GPS)'] ?? fallback['End Time(GPS)'] },
    { label: 'Duration', value: fromCsv['Duration'] ?? fallback.Duration },
  ];
}

function messageSummary(project: GraphProject, titles: string[]): { name: string; count: number | string }[] {
  const names: string[] = [];
  for (const title of titles) {
    for (const name of Object.keys(chartMessages(project.plotSummary, title))) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.map((name) => ({ name, count: project.messages[name] ?? '' }));
}

/* ------------------------------------------------------------------------------------------------
 * PDF object graph
 * ---------------------------------------------------------------------------------------------- */

interface PdfObject {
  /** Object number, 1-based, in the order they are written. */
  number: number;
  body: string;
}

/** Build the byte array: header, objects, xref table (exact offsets), trailer, `%%EOF`. */
function assemble(infoDictionary: string, pages: string[]): Uint8Array {
  const objects: PdfObject[] = [];
  const pageNumbers: number[] = [];
  const contentNumbers: number[] = [];

  // 1 catalog, 2 page tree, 3 info, 4/5 fonts — fixed so every build has the same numbering.
  let next = 6;
  for (let index = 0; index < pages.length; index++) {
    pageNumbers.push(next++);
    contentNumbers.push(next++);
  }

  objects.push({
    number: 1,
    body: '<< /Type /Catalog /Pages 2 0 R >>',
  });
  objects.push({
    number: 2,
    body: `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  });
  objects.push({ number: 3, body: infoDictionary });
  objects.push({
    number: 4,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  objects.push({
    number: 5,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  });

  pages.forEach((content, index) => {
    objects.push({
      number: pageNumbers[index],
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] ` +
        `/Resources << /Font << /F1 4 0 R /F2 5 0 R >> /ProcSet [/PDF /Text] >> ` +
        `/Contents ${contentNumbers[index]} 0 R >>`,
    });
    objects.push({
      number: contentNumbers[index],
      body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    });
  });

  const header = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (textValue: string) => {
    const buffer = Buffer.from(textValue, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };

  push(header);
  for (const object of objects) {
    offsets[object.number] = length;
    push(`${object.number} 0 obj\n${object.body}\nendobj\n`);
  }

  const xrefOffset = length;
  const size = objects.length + 1;
  push(`xref\n0 ${size}\n`);
  push('0000000000 65535 f \n');
  for (let number = 1; number < size; number++) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Uint8Array(Buffer.concat(chunks));
}

/* ------------------------------------------------------------------------------------------------
 * Entry points
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the whole PDF. Pure apart from the clock: pass `options.generatedAt` for byte-reproducible
 * output. Page 1 is the information page, then one page per chart, in the caller's order.
 */
export function buildPdfReport(project: GraphProject, charts: PdfChartSource[], options: PdfReportOptions = {}): Uint8Array {
  const tableRows = options.tableRows ?? PDF_TABLE_ROWS;
  const selected = options.selectedPlots ? charts.filter((chart) => options.selectedPlots!.includes(chart.title)) : charts;
  const generated = options.generatedAt ?? localTimestamp(new Date());
  const pages = 1 + selected.length;

  const streams: string[] = [];
  streams.push(
    infoPage(project, reportFields(project, selected), selected, generated, pages).join('\n'),
  );
  selected.forEach((chart, index) => {
    streams.push(chartPage(parseReportCsv(chart.csv), chart.title, tableRows, index + 2, pages).join('\n'));
  });

  const title = options.title ?? `${project.projectName} Report`;
  const info = [
    `<< /Title ${pdfString(title)}`,
    '/Creator (packages/graph)',
    '/Producer (packages/graph hand-written PDF 1.4)',
    `/CreationDate ${pdfString(pdfDate(generated))}`,
    '>>',
  ].join('\n');

  return assemble(info, streams);
}

/** `2026/10/30 21:00:00` → `D:20261030210000`; anything unparseable is passed through as text. */
function pdfDate(generatedAt: string): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(generatedAt);
  if (!match) return `D:${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const [, year, month, day, hour, minute, second] = match;
  return `D:${year}${month}${day}${hour}${minute}${second}`;
}

/** Write `<outDir>/<projectName>.pdf` (Graph's destination for `clean.pdf`) and return its size. */
export function writePdfReport(
  project: GraphProject,
  charts: PdfChartSource[],
  outDir: string,
  options: PdfReportOptions = {},
): { path: string; bytes: number } {
  mkdirSync(outDir, { recursive: true });
  const bytes = buildPdfReport(project, charts, options);
  const path = join(outDir, `${project.projectName}.pdf`);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length };
}
