/**
 * Graph page's data source: the CSVs Graph already exported, read straight off disk.
 *
 * `逆向/00_来源/samples/graph/export/csv/*.csv` is the ground truth for the Graph application, and
 * this module deliberately does **not** import `packages/graph` — that package is being rewritten
 * by a parallel task, and the UI only needs "what is in these files". The parser below therefore
 * reads the exported artefact, not the exporter:
 *
 * ```
 * <BOM>#Project Name:   …            six hand-padded comment lines
 * #Duration:            00:00:04
 * timestamp (GPS week sec),<col>,…   header
 * 2442  463098.000,<value>,…         rows
 * ```
 *
 * The timestamp cell is `"<week>  <seconds of week>"` (two spaces, not a comma), so the x values
 * come from the week/second pair and are converted to "seconds from the first sample". A file
 * without a timestamp column (`Receiver Status.csv`: `name,start,end,value`) falls back to the row
 * index on x.
 *
 * The y column is a UI choice: the first column whose cells all parse as finite numbers, overridable
 * with `?column=`. Files whose every column is an enum label (`Position Status.csv`,
 * `Position Type.csv`) get no series — the endpoint says so and the page shows the table only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { HttpError, SAMPLES_DIR } from './paths.ts';

/** `<repo>/逆向/00_来源/samples/graph/export/csv` */
export const GRAPH_CSV_DIR = resolve(SAMPLES_DIR, 'graph', 'export', 'csv');

const MAX_CACHED_FILES = 8;
const TABLE_ROWS = 20;

export interface GraphComments {
  projectName: string;
  projectDirectory: string;
  dataFileName: string;
  startTime: string;
  endTime: string;
  duration: string;
}

export interface GraphCsvData {
  text: string;
  comments: GraphComments;
  columns: string[];
  rows: string[][];
  timeColumnIndex: number;
}

interface CachedFile extends GraphCsvData {
  name: string;
  bytes: number;
  mtimeMs: number;
}

const cache = new Map<string, CachedFile>();

function readComment(comments: string[], label: string): string {
  const prefix = `#${label}:`;
  for (const line of comments) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
}

/** Split a CSV body into comments / header / rows. Quoted cells are not needed by these samples. */
function parseCsv(text: string): Omit<GraphCsvData, 'text' | 'comments'> & { comments: string[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const comments: string[] = [];
  let columns: string[] = [];
  const rows: string[][] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      comments.push(line.trimEnd());
      continue;
    }
    const cells = line.split(',').map((cell) => cell.trim());
    if (!columns.length) {
      columns = cells;
      continue;
    }
    // Pad/trim so a short or over-long row can never shift the table's columns.
    if (cells.length < columns.length) cells.push(...Array(columns.length - cells.length).fill(''));
    else if (cells.length > columns.length) cells.length = columns.length;
    rows.push(cells);
  }

  const timeColumnIndex = columns.findIndex((column) => /timestamp/i.test(column));
  return { comments, columns, rows, timeColumnIndex };
}

function assertSafeCsvName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, 'file 必须是字符串');
  const name = raw.trim();
  if (!name) throw new HttpError(400, '缺少 file 参数');
  if (name.length > 200) throw new HttpError(400, 'file 过长');
  if (name.includes('\0')) throw new HttpError(400, 'file 含非法字符');
  if (/^[a-zA-Z]:/.test(name) || isAbsolute(name)) throw new HttpError(400, 'file 不允许绝对路径');
  if (name.split(/[\\/]+/).some((part) => part === '..')) throw new HttpError(400, 'file 不允许包含 ..');
  if (name.includes('/') || name.includes('\\')) throw new HttpError(400, 'file 只接受 CSV 文件名');
  if (extname(name).toLowerCase() !== '.csv') throw new HttpError(400, 'file 必须是 .csv');
  return basename(name);
}

/** Parse (and cache) one CSV by bare file name. */
export function readGraphCsv(raw: unknown): CachedFile {
  const name = assertSafeCsvName(raw);
  const absolutePath = join(GRAPH_CSV_DIR, name);
  if (relative(GRAPH_CSV_DIR, absolutePath).startsWith('..')) throw new HttpError(400, 'file 不合法');

  let info;
  try {
    info = statSync(absolutePath);
  } catch {
    throw new HttpError(404, `未找到 CSV：${name}`);
  }
  if (!info.isFile()) throw new HttpError(404, 'CSV 不是文件');

  const key = `${absolutePath}::${info.size}::${Math.trunc(info.mtimeMs)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const text = readFileSync(absolutePath, 'utf8');
  const parsed = parseCsv(text);
  const comments: GraphComments = {
    projectName: readComment(parsed.comments, 'Project Name'),
    projectDirectory: readComment(parsed.comments, 'Project Directory'),
    dataFileName: readComment(parsed.comments, 'Data File Name'),
    startTime: readComment(parsed.comments, 'Start Time(GPS)'),
    endTime: readComment(parsed.comments, 'End Time(GPS)'),
    duration: readComment(parsed.comments, 'Duration'),
  };

  const file: CachedFile = {
    text,
    comments,
    columns: parsed.columns,
    rows: parsed.rows,
    timeColumnIndex: parsed.timeColumnIndex,
    name,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  };
  cache.set(key, file);
  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return file;
}

/** `"2442  463098.000"` → absolute GPS seconds (week * 604800 + seconds), or `null`. */
export function parseGpsCell(cell: string): number | null {
  const match = /^\s*(\d{3,5})\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(cell);
  if (!match) return null;
  const week = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  return week * 604_800 + seconds;
}

function isNumericColumn(rows: string[][], index: number): boolean {
  if (!rows.length) return false;
  let numeric = 0;
  for (const row of rows) {
    const cell = row[index] ?? '';
    if (cell === '') continue;
    if (!Number.isFinite(Number(cell))) return false;
    numeric += 1;
  }
  return numeric > 0;
}

export interface GraphNumericColumn {
  index: number;
  name: string;
}

export function numericColumns(data: GraphCsvData): GraphNumericColumn[] {
  const out: GraphNumericColumn[] = [];
  data.columns.forEach((column, index) => {
    if (index === data.timeColumnIndex) return;
    if (isNumericColumn(data.rows, index)) out.push({ index, name: column });
  });
  return out;
}

export interface GraphFileEntry {
  name: string;
  bytes: number;
  columns: number;
  rows: number;
  numericColumns: string[];
  hasTimeColumn: boolean;
}

/** Every CSV that actually exists in the export directory, sorted by name. */
export function listGraphCsv(): GraphFileEntry[] {
  let names: string[];
  try {
    names = readdirSync(GRAPH_CSV_DIR)
      .filter((name) => extname(name).toLowerCase() === '.csv')
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return [];
  }

  return names.map((name) => {
    const data = readGraphCsv(name);
    const numeric = numericColumns(data);
    return {
      name,
      bytes: data.bytes,
      columns: data.columns.length,
      rows: data.rows.length,
      numericColumns: numeric.map((column) => column.name),
      hasTimeColumn: data.timeColumnIndex >= 0 && parseGpsCell(data.rows[0]?.[data.timeColumnIndex] ?? '') !== null,
    };
  });
}

export interface GraphSeries {
  /** Column plotted on y (null when no column is numeric). */
  label: string | null;
  xLabel: string;
  xKind: 'time' | 'index';
  points: Array<[number, number]>;
  /** Human label of the first / last x sample. */
  xStartLabel: string;
  xEndLabel: string;
  /** Seconds covered by the x axis (time files only). */
  spanSeconds: number | null;
}

export interface GraphDataPayload {
  name: string;
  bytes: number;
  comments: GraphComments;
  columns: string[];
  rows: number;
  numericColumns: GraphNumericColumn[];
  column: string | null;
  series: GraphSeries;
  table: { columns: string[]; rows: string[][] };
  tableTruncated: boolean;
}

function formatGpsLabel(absoluteSeconds: number): string {
  const week = Math.floor(absoluteSeconds / 604_800);
  const seconds = absoluteSeconds - week * 604_800;
  return `W${week} ${seconds.toFixed(3)}`;
}

/** Everything the page needs for one file: metadata, one series, and the first 20 rows. */
export function graphData(raw: unknown, columnName?: string | null): GraphDataPayload {
  const data = readGraphCsv(raw);
  const numeric = numericColumns(data);

  let chosen = numeric.find((column) => column.name === columnName) ?? numeric[0] ?? null;
  if (!chosen && columnName) {
    throw new HttpError(400, `列 ${columnName} 不是数值列`);
  }

  const timed = data.timeColumnIndex >= 0
    ? data.rows
      .map((row) => parseGpsCell(row[data.timeColumnIndex] ?? ''))
      .filter((value): value is number => value !== null)
    : [];

  let series: GraphSeries = {
    label: null,
    xLabel: '',
    xKind: 'index',
    points: [],
    xStartLabel: '',
    xEndLabel: '',
    spanSeconds: null,
  };

  if (chosen) {
    const points: Array<[number, number]> = [];
    if (timed.length === data.rows.length && timed.length > 0) {
      const base = timed[0];
      data.rows.forEach((row, index) => {
        const y = Number(row[chosen!.index] ?? '');
        if (!Number.isFinite(y)) return;
        points.push([Math.round((timed[index] - base) * 1000) / 1000, y]);
      });
      series = {
        label: chosen.name,
        xLabel: '时间（相对首帧，s）',
        xKind: 'time',
        points,
        xStartLabel: formatGpsLabel(base),
        xEndLabel: formatGpsLabel(timed[timed.length - 1]),
        spanSeconds: Math.round((timed[timed.length - 1] - base) * 1000) / 1000,
      };
    } else {
      data.rows.forEach((row, index) => {
        const y = Number(row[chosen!.index] ?? '');
        if (!Number.isFinite(y)) return;
        points.push([index, y]);
      });
      series = {
        label: chosen.name,
        xLabel: '行序号',
        xKind: 'index',
        points,
        xStartLabel: '#1',
        xEndLabel: `#${data.rows.length}`,
        spanSeconds: null,
      };
    }
  }

  return {
    name: data.name,
    bytes: data.bytes,
    comments: data.comments,
    columns: data.columns,
    rows: data.rows.length,
    numericColumns: numeric,
    column: chosen?.name ?? null,
    series,
    table: { columns: data.columns, rows: data.rows.slice(0, TABLE_ROWS) },
    tableTruncated: data.rows.length > TABLE_ROWS,
  };
}
