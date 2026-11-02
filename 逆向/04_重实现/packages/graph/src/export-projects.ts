/**
 * Export-project discovery: **"a project is one directory under `samples/graph/export/`"**.
 *
 * Graph's own model is a `.gpf` per project (`project.ts`), and its *Export → CSV* writes
 * `<project>/csv/<chart>.csv`. The shipped sample does not keep that nesting — the `clean` project's
 * twelve CSVs sit directly in `export/csv/` — so both shapes are recognised:
 *
 *   `export/csv/*.csv`      a directory that holds CSVs itself   → project key `csv`,  name `clean`
 *   `export/b1/csv/*.csv`   the nesting Graph writes             → project key `b1`
 *
 * Nothing is hardcoded per project: the display name is the `#Project Name:` comment inside the CSVs
 * (falling back to the directory name), the time range is the `#Start/#End Time(GPS)` comments, and
 * the directory is whatever `readdir()` returns. A new export directory therefore appears on the
 * Graph landing page without a code change.
 *
 * This module also reads one project's CSV into the same JSON payload `/api/graph/files` /
 * `/api/graph/data` already speak, because `packages/app/src/graphcsv.ts` is bound to the single
 * shipped directory and this task's boundary does not allow rewriting it. The two must agree — the
 * test `graph-projects.test.ts` compares them file by file for the default project.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

import { CSV_CHARTS } from './csv.ts';

const MAX_CACHED_FILES = 16;
const TABLE_ROWS = 20;

/** An error whose `status` maps straight onto an HTTP status (`HttpError` in the web shell). */
export class GraphCsvError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GraphCsvError';
    this.status = status;
  }
}

export interface GraphComments {
  projectName: string;
  projectDirectory: string;
  dataFileName: string;
  startTime: string;
  endTime: string;
  duration: string;
}

export interface ExportProject {
  /** Directory name under `export/`; the value `/api/graph/*?project=` accepts. */
  key: string;
  /** `#Project Name:` of the CSVs (`clean`, `b1` …). */
  name: string;
  /** Absolute path of the project directory. */
  directory: string;
  /** Absolute path of the directory the CSVs live in (the project itself or its `csv/`). */
  csvDirectory: string;
  csvCount: number;
  /** Sum of the CSV files' sizes. */
  bytes: number;
  /** `#Start Time(GPS):` / `#End Time(GPS):` / `#Duration:` — `''` when the CSVs carry none. */
  startTime: string;
  endTime: string;
  duration: string;
  /** `#Data File Name:` — the capture the project was built from. */
  dataFileName: string;
  /** mtime of the newest CSV, ISO 8601. */
  modified: string;
}

export interface GraphFileEntry {
  name: string;
  bytes: number;
  columns: number;
  rows: number;
  numericColumns: string[];
  hasTimeColumn: boolean;
}

export interface GraphNumericColumn {
  index: number;
  name: string;
}

export interface GraphSeries {
  label: string | null;
  xLabel: string;
  xKind: 'time' | 'index';
  points: Array<[number, number]>;
  xStartLabel: string;
  xEndLabel: string;
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
  /** The project this payload came from (extra field; the page uses it after a switch). */
  project: { key: string; name: string };
}

interface ParsedCsv {
  text: string;
  comments: string[];
  columns: string[];
  rows: string[][];
  timeColumnIndex: number;
  bytes: number;
  mtimeMs: number;
}

const cache = new Map<string, ParsedCsv>();

function csvNamesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => extname(name).toLowerCase() === '.csv')
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return [];
  }
}

/** `<project>/csv` when it holds CSVs, else `<project>` itself when it does. */
function csvDirectoryOf(dir: string): string | null {
  const nested = join(dir, 'csv');
  if (csvNamesIn(nested).length) return nested;
  if (csvNamesIn(dir).length) return dir;
  return null;
}

function readComment(comments: string[], label: string): string {
  const prefix = `#${label}:`;
  for (const line of comments) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
}

/** Parse (and cache) `<dir>/<name>`. `name` must already be a bare file name. */
function readCsv(dir: string, name: string): ParsedCsv {
  const absolutePath = join(dir, name);
  if (relative(dir, absolutePath).startsWith('..')) throw new GraphCsvError(400, 'file 不合法');

  let info;
  try {
    info = statSync(absolutePath);
  } catch {
    throw new GraphCsvError(404, `未找到 CSV：${name}`);
  }
  if (!info.isFile()) throw new GraphCsvError(404, 'CSV 不是文件');

  const key = `${absolutePath}::${info.size}::${Math.trunc(info.mtimeMs)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const text = readFileSync(absolutePath, 'utf8');
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
    if (cells.length < columns.length) cells.push(...Array(columns.length - cells.length).fill(''));
    else if (cells.length > columns.length) cells.length = columns.length;
    rows.push(cells);
  }

  const parsed: ParsedCsv = {
    text,
    comments,
    columns,
    rows,
    timeColumnIndex: columns.findIndex((column) => /timestamp/i.test(column)),
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  };
  cache.set(key, parsed);
  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return parsed;
}

function commentsOf(parsed: ParsedCsv): GraphComments {
  return {
    projectName: readComment(parsed.comments, 'Project Name'),
    projectDirectory: readComment(parsed.comments, 'Project Directory'),
    dataFileName: readComment(parsed.comments, 'Data File Name'),
    startTime: readComment(parsed.comments, 'Start Time(GPS)'),
    endTime: readComment(parsed.comments, 'End Time(GPS)'),
    duration: readComment(parsed.comments, 'Duration'),
  };
}

/**
 * Every project under `exportRoot`, newest first.
 *
 * A directory with no CSV anywhere (e.g. `export/scripts/`) is not a project and is skipped.
 */
export function listExportProjects(exportRoot: string): ExportProject[] {
  let entries;
  try {
    entries = readdirSync(exportRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects: ExportProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(exportRoot, entry.name);
    const csvDirectory = csvDirectoryOf(directory);
    if (!csvDirectory) continue;

    const names = csvNamesIn(csvDirectory);
    let bytes = 0;
    let modifiedMs = 0;
    for (const name of names) {
      const info = statSync(join(csvDirectory, name));
      bytes += info.size;
      if (info.mtimeMs > modifiedMs) modifiedMs = info.mtimeMs;
    }

    // Comments are identical in every export of a project (Graph writes the same six lines), so the
    // alphabetically first file is representative — `2D Trajectory.csv` in both shipped projects.
    const comments = commentsOf(readCsv(csvDirectory, names[0]));
    projects.push({
      key: entry.name,
      name: comments.projectName || entry.name,
      directory,
      csvDirectory,
      csvCount: names.length,
      bytes,
      startTime: comments.startTime,
      endTime: comments.endTime,
      duration: comments.duration,
      dataFileName: comments.dataFileName,
      modified: modifiedMs ? new Date(modifiedMs).toISOString() : '',
    });
  }

  projects.sort((a, b) => (b.modified || '').localeCompare(a.modified || '') || a.key.localeCompare(b.key, 'en'));
  return projects;
}

function normaliseWanted(raw: unknown): string {
  if (typeof raw !== 'string') throw new GraphCsvError(400, 'project 必须是字符串');
  const wanted = raw.trim();
  if (!wanted) throw new GraphCsvError(400, 'project 不能为空');
  if (wanted.length > 200) throw new GraphCsvError(400, 'project 过长');
  if (wanted.includes('\0')) throw new GraphCsvError(400, 'project 含非法字符');
  if (wanted.includes('/') || wanted.includes('\\') || /^[a-zA-Z]:/.test(wanted) || isAbsolute(wanted)) {
    throw new GraphCsvError(400, 'project 只接受工程名，不接受路径');
  }
  if (wanted.split(/[\\/]+/).includes('..')) throw new GraphCsvError(400, 'project 不合法');
  return wanted;
}

/**
 * Resolve `?project=` to one project.
 *
 * The value may be the export directory (`csv`, `b1`) **or** the CSV's `#Project Name:` (`clean`,
 * `b1`) — both are what a user reads off the screen. Matching is case-insensitive; `null` means "no
 * `?project=` given", which yields the default project (`fallbackKey`, else the first one).
 */
export function resolveExportProject(
  exportRoot: string,
  raw: string | null,
  fallbackKey = 'csv',
): { project: ExportProject | null; available: string[] } {
  const projects = listExportProjects(exportRoot);
  const available = projects.map((project) => (project.key === project.name ? project.key : `${project.key}（${project.name}）`));
  if (raw === null || raw === undefined) {
    const fallback = projects.find((project) => project.key === fallbackKey) ?? projects[0] ?? null;
    return { project: fallback, available };
  }
  const wanted = normaliseWanted(raw).toLowerCase();
  const project = projects.find((item) => item.key.toLowerCase() === wanted)
    ?? projects.find((item) => item.name.toLowerCase() === wanted)
    ?? null;
  return { project, available };
}

function assertSafeCsvName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GraphCsvError(400, 'file 必须是字符串');
  const name = raw.trim();
  if (!name) throw new GraphCsvError(400, '缺少 file 参数');
  if (name.length > 200) throw new GraphCsvError(400, 'file 过长');
  if (name.includes('\0')) throw new GraphCsvError(400, 'file 含非法字符');
  if (/^[a-zA-Z]:/.test(name) || isAbsolute(name)) throw new GraphCsvError(400, 'file 不允许绝对路径');
  if (name.split(/[\\/]+/).some((part) => part === '..')) throw new GraphCsvError(400, 'file 不允许包含 ..');
  if (name.includes('/') || name.includes('\\')) throw new GraphCsvError(400, 'file 只接受 CSV 文件名');
  if (extname(name).toLowerCase() !== '.csv') throw new GraphCsvError(400, 'file 必须是 .csv');
  return basename(name);
}

/** `"2442  463098.000"` → absolute GPS seconds, or `null`. */
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

function numericColumnsOf(columns: string[], rows: string[][], timeColumnIndex: number): GraphNumericColumn[] {
  const out: GraphNumericColumn[] = [];
  columns.forEach((column, index) => {
    if (index === timeColumnIndex) return;
    if (isNumericColumn(rows, index)) out.push({ index, name: column });
  });
  return out;
}

function formatGpsLabel(absoluteSeconds: number): string {
  const week = Math.floor(absoluteSeconds / 604_800);
  const seconds = absoluteSeconds - week * 604_800;
  return `W${week} ${seconds.toFixed(3)}`;
}

/** Every CSV of one project, sorted by name (same shape as `/api/graph/files`). */
export function listProjectCsv(project: ExportProject): GraphFileEntry[] {
  return csvNamesIn(project.csvDirectory).map((name) => {
    const parsed = readCsv(project.csvDirectory, name);
    return {
      name,
      bytes: parsed.bytes,
      columns: parsed.columns.length,
      rows: parsed.rows.length,
      numericColumns: numericColumnsOf(parsed.columns, parsed.rows, parsed.timeColumnIndex).map((column) => column.name),
      hasTimeColumn: parsed.timeColumnIndex >= 0 && parseGpsCell(parsed.rows[0]?.[parsed.timeColumnIndex] ?? '') !== null,
    };
  });
}

/** One CSV of one project: metadata, one series, first 20 rows — `/api/graph/data`'s payload. */
export function projectGraphData(project: ExportProject, rawName: unknown, columnName?: string | null): GraphDataPayload {
  const name = assertSafeCsvName(rawName);
  const parsed = readCsv(project.csvDirectory, name);
  const numeric = numericColumnsOf(parsed.columns, parsed.rows, parsed.timeColumnIndex);

  const chosen = numeric.find((column) => column.name === columnName) ?? numeric[0] ?? null;
  if (!chosen && columnName) throw new GraphCsvError(400, `列 ${columnName} 不是数值列`);

  const timed = parsed.timeColumnIndex >= 0
    ? parsed.rows
      .map((row) => parseGpsCell(row[parsed.timeColumnIndex] ?? ''))
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
    if (timed.length === parsed.rows.length && timed.length > 0) {
      const base = timed[0];
      parsed.rows.forEach((row, index) => {
        const y = Number(row[chosen.index] ?? '');
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
      parsed.rows.forEach((row, index) => {
        const y = Number(row[chosen.index] ?? '');
        if (!Number.isFinite(y)) return;
        points.push([index, y]);
      });
      series = {
        label: chosen.name,
        xLabel: '行序号',
        xKind: 'index',
        points,
        xStartLabel: '#1',
        xEndLabel: `#${parsed.rows.length}`,
        spanSeconds: null,
      };
    }
  }

  return {
    name,
    bytes: parsed.bytes,
    comments: commentsOf(parsed),
    columns: parsed.columns,
    rows: parsed.rows.length,
    numericColumns: numeric,
    column: chosen?.name ?? null,
    series,
    table: { columns: parsed.columns, rows: parsed.rows.slice(0, TABLE_ROWS) },
    tableTruncated: parsed.rows.length > TABLE_ROWS,
    project: { key: project.key, name: project.name },
  };
}

/** The six `#` comment lines + body of one CSV, as `/api/graph/pdf` needs them. */
export function projectCsvText(project: ExportProject, rawName: unknown): string {
  return readCsv(project.csvDirectory, assertSafeCsvName(rawName)).text;
}

/* ---------------- Flags in the project's `.gpf` (D5) ----------------
 *
 * Graph keeps the Pre-process timeline markers in the project file:
 *
 *   `FlagsInitialState: {allFlags, isFlagsPanelOpen}`   `index-B86bHcCD.js` @16246801, written on
 *                                                       close @16247254
 *
 * This build's panel (`packages/app/src/web/panels/graph.js`) has no `.gpf` writer of its own, so the
 * file-level half lives here: locate the project's `.gpf`, read `FlagsInitialState`, and write it back
 * **without touching anything else in the file** (key order, indentation, line endings, BOM and the
 * trailing newline are all preserved; `checksum` and every other key stay exactly as they were).
 *
 * A `.gpf` is user data. Nothing here rewrites a file it could not parse — a corrupt `.gpf` is
 * reported, never replaced — and writes go through a temporary file + rename so a crash mid-write
 * cannot leave a half-file behind.
 *
 * **Creating one (B/E1).** A project directory that never had a `.gpf` used to fall back to
 * `localStorage` forever. `writeProjectFlags(project, flags, {create: true})` now writes a **new**
 * `.gpf` instead, on the first save that actually carries a marker:
 *
 *   - the skeleton is the one a real project file has (every key and its order taken from the
 *     shipped `00_来源/samples/graph/project/clean.gpf`; see `buildProjectGpf`), filled only with
 *     values measured from **this** project (its CSVs' `#` comments, its `project.json` sidecar,
 *     the capture's size) — nothing is invented;
 *   - `checksum` is computed with Graph's own algorithm (`addChecksum`/`verifyChecksum` @549299:
 *     SHA-256 of `JSON.stringify(file without checksum) + "GAA170P4468F1218"`), so `validateGPF`
 *     accepts the file;
 *   - what it deliberately does **not** claim: a runnable Process page. There is no `GOS`/`GDS`
 *     database next to these exports, so the charts cannot be redrawn — see
 *     `03_分析/13_Graph分析页.md §11.4`.
 *
 * An empty marker list creates nothing (`no-gpf`): with nothing to store there is no reason to put
 * a file in the user's project directory, and "no flags" already means "empty store".
 */

/** `FlagsInitialState` — the only part of a `.gpf` this layer owns. */
export interface GpfFlagState {
  allFlags: unknown[];
  isFlagsPanelOpen: boolean;
}

/** What `readProjectFlags` found: the path, plus either the flags or why there are none. */
export interface ProjectGpfFlags {
  /** Absolute path of the `.gpf` that owns the flags. */
  path: string;
  /** `FlagsInitialState` as stored, or `null` when the file has none (or has a broken one). */
  flags: GpfFlagState | null;
  /** Set when the file exists but its `FlagsInitialState` could not be used. */
  error?: string;
}

/** Why a flag write did not happen. */
export type ProjectGpfWriteReason = 'no-gpf' | 'no-data' | 'invalid' | 'unreadable' | 'bad-json' | 'write-failed';

export interface ProjectGpfWrite {
  ok: boolean;
  /** Absolute path that was written (absent when there is no `.gpf` at all). */
  path?: string;
  reason?: ProjectGpfWriteReason;
  error?: string;
  /** The bytes that were written (for tests and for a caller that wants to serve them). */
  text?: string;
  /** `true` when this call created the file (it did not exist before). */
  created?: boolean;
}

/** Options for `writeProjectFlags`. Both default to off, i.e. D5's "only touch an existing file". */
export interface ProjectGpfWriteOptions {
  /**
   * Create `<projectDirectory>/<basename(projectDirectory)>.gpf` when the project has none.
   *
   * Refused (`no-gpf`) for an empty `allFlags` and when the directory already holds a `.gpf` this
   * layer could not attribute to the project — one file is never guessed into existence next to
   * another one.
   */
  create?: boolean;
  /**
   * Recompute `checksum` the way Graph's `addChecksum` does (`@549299`) after merging the flags.
   *
   * Off by default so a pure flag edit changes only `FlagsInitialState`; the HTTP route turns it on
   * because Graph refuses a file whose checksum no longer matches (`INVALID_GPF_FILE`).
   */
  resign?: boolean;
}

/**
 * The project's `.gpf`: `<dir>/<key>.gpf`, else `<dir>/<name>.gpf`, else the only `*.gpf` in it.
 *
 * A project directory with several `.gpf` files and none named after the project is ambiguous, so it
 * resolves to `null` rather than picking one at random.
 *
 * `project.name` comes from the CSV's `#Project Name:` comment, i.e. from file content, so it is only
 * used as a **bare file name**: anything with a separator, a drive letter or `.`/`..` is skipped. The
 * last fallback is a `readdir()` entry, which is always a bare name.
 */
export function projectGpfPath(project: ExportProject): string | null {
  const named = [...new Set([project.key, project.name])]
    .map((name) => String(name ?? '').trim())
    .filter((name) => name && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !/^[a-zA-Z]:/.test(name))
    .map((name) => join(project.directory, `${name}.gpf`));
  for (const path of named) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      /* keep looking */
    }
  }
  let entries: string[];
  try {
    entries = readdirSync(project.directory).filter((file) => extname(file).toLowerCase() === '.gpf');
  } catch {
    return null;
  }
  entries.sort((a, b) => a.localeCompare(b, 'en'));
  return entries.length === 1 ? join(project.directory, entries[0]) : null;
}

function isGpfFlagState(value: unknown): value is GpfFlagState {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as GpfFlagState).allFlags);
}

/** Parse a `.gpf`, or `null` when the text is not a JSON object. */
function parseGpf(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Replace `FlagsInitialState` in a `.gpf` **text**, keeping every other byte.
 *
 * `null` means "this is not a JSON object" — the caller must not write anything then. The indentation,
 * line endings, BOM and trailing newline are re-applied from the input, and key order is the parser's
 * (an existing `FlagsInitialState` keeps its position, a new one is appended last — which is also what
 * Graph's own writer does with a fresh key).
 *
 * `options.resign` also refreshes `checksum` (`gpfChecksum`), which is the only other byte that may
 * change then. Off by default: a plain D5 write touches that one block and nothing else.
 */
export function mergeGpfFlags(
  text: string,
  flags: GpfFlagState,
  options: { resign?: boolean } = {},
): string | null {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const data = parseGpf(body);
  if (!data) return null;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? '  ';
  const trailingNewline = /\r?\n$/.test(body);
  const merged: Record<string, unknown> = {
    ...data,
    FlagsInitialState: {
      allFlags: Array.isArray(flags?.allFlags) ? flags.allFlags : [],
      isFlagsPanelOpen: !!flags?.isFlagsPanelOpen,
    },
  };
  const next = options.resign ? withGpfChecksum(merged) : merged;
  let out = JSON.stringify(next, null, indent);
  if (newline === '\r\n') out = out.replace(/\n/g, '\r\n');
  return bom + out + (trailingNewline ? newline : '');
}

/**
 * `FlagsInitialState` of a project's `.gpf`, or `null` when the project has no `.gpf`.
 *
 * A `.gpf` that is present but unparsable comes back as `{path, flags: null, error}` instead of
 * throwing, because "no flags" and "broken project file" are both normal states in the UI.
 */
export function readProjectFlags(project: ExportProject): ProjectGpfFlags | null {
  const path = projectGpfPath(project);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { path, flags: null, error: error instanceof Error ? error.message : String(error) };
  }
  const data = parseGpf(text);
  if (!data) return { path, flags: null, error: `${path} 不是合法的 .gpf JSON` };
  const raw = data.FlagsInitialState;
  if (raw === undefined || raw === null) return { path, flags: null };
  if (!isGpfFlagState(raw)) {
    return { path, flags: null, error: `${path} 的 FlagsInitialState 缺少 allFlags 数组` };
  }
  return { path, flags: { allFlags: raw.allFlags, isFlagsPanelOpen: !!raw.isFlagsPanelOpen } };
}

/* ---------------- creating the project's `.gpf` (B/E1) ----------------
 *
 * Measured, not guessed (`index-B86bHcCD.js`):
 *
 *   file name   `getGpfFilePath()` @538881   `join(projectDirectory, basename(projectDirectory) + ".gpf")`
 *   checksum    `addChecksum` @549299        `JSON.stringify({...data, checksum: SHA-256(JSON.stringify(data) + "GAA170P4468F1218")}, null, 2)`
 *               `verifyChecksum` @549299     hashes everything except `checksum` and compares
 *   layout      @602242                      `PersistenceInfo` is optional: when absent Graph builds the
 *                                            chart layout itself from `PlotSummary` (`getSupportedChartsList`)
 *   markers     @554827 (`setStoreDefaults`) reads `FlagsInitialState` and rebuilds `newFlagId`
 *   window      @554827                      `DataInfo.StartTime` / `EndTime` drive the playhead
 *
 * So a new file takes the *skeleton of the shipped working project* (`clean.gpf`, every key and its
 * order) and fills only the fields this build can measure:
 *
 *   projectDirectory / fileTimeline / updatedProjSummary / TotalLogInstances / filename  ← this project
 *   updatedProjSummary.DataInfo    ← the CSVs' `#Start Time(GPS)` / `#End Time(GPS)` (GPS ms, the
 *                                    same scale `clean.gpf` uses: `(week*604800 + s) * 1000`), and
 *                                    `FileSize` from `stat(capture)` when `project.json` names one
 *   updatedProjSummary.Messages    ← `project.json` (the export tool's own decode counts)
 *   updatedProjSummary.PlotSummary ← one entry per **CSV that exists here**, grouped by the tab the
 *                                    chart sits under (`PLOT_GROUP`; `CPU Usage` plots `BESTPOS` but
 *                                    belongs to `Receiver_Status`), `{ [title]: { [msg]: 1 } }`
 *                                    (`1` is what every chart entry in `clean.gpf` holds — it says
 *                                    "this chart has a series", not "this many records")
 *   FlagsInitialState              ← the markers being saved
 *   checksum                       ← `addChecksum`'s algorithm, so `validateGPF` accepts it
 *
 * Dropped on purpose, because writing them would be a claim we cannot support:
 *
 *   `DataSummary` / `GOSMetaPath`  the files they point at (`DataSummary.json`, `GOS/*.db`) do not
 *                                  exist next to an export; `updatedProjSummary` makes Graph skip the
 *                                  first (`fetchDataSummary` @549299)
 *   `PersistenceInfo`              per-user tile layout; Graph rebuilds it from `PlotSummary` @602242
 *   `projectName` / `projectDescription`
 *                                  `clean.gpf` has neither — Graph names a project by the basename of
 *                                  `projectDirectory` (`updateGPFRecentActivity` @550800)
 *
 * **Not claimed**: that the original can *draw* the project. These export directories carry CSVs, not
 * the `GOS`/`GDS` databases the Process page reads, so the charts cannot be rebuilt — only the project
 * file, its timeline and its markers are correct. See `03_分析/13_Graph分析页.md §11.4`.
 */

/** `STATIC_KEY` @549299 — the literal Graph appends to the JSON before hashing. */
export const GPF_CHECKSUM_SALT = 'GAA170P4468F1218';

/**
 * Graph's `.gpf` checksum: SHA-256 of `JSON.stringify(everything except checksum) + salt`.
 *
 * Key **order** is part of the hash (it is `JSON.stringify` of the parsed object), which is why the
 * writer never reorders a file's keys. On the shipped `clean.gpf` this reproduces the stored
 * `checksum` byte for byte — the test `gpf-flags.test.ts` pins exactly that.
 */
export function gpfChecksum(data: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'checksum') continue;
    rest[key] = value;
  }
  return createHash('sha256').update(JSON.stringify(rest) + GPF_CHECKSUM_SALT, 'utf8').digest('hex');
}

/** `{...data, checksum}` with `checksum` where the file already had it (else appended last). */
function withGpfChecksum(data: Record<string, unknown>): Record<string, unknown> {
  const checksum = gpfChecksum(data);
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'checksum') {
      out.checksum = checksum;
      placed = true;
    } else {
      out[key] = value;
    }
  }
  if (!placed) out.checksum = checksum;
  return out;
}

/** The `project.json` sidecar `packages/graph/tools/export-sbf-project.ts` writes next to the CSVs. */
interface ProjectSidecar {
  dataFileName?: string;
  capture?: string;
  startTime?: string;
  endTime?: string;
  messages?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `<project>/project.json`, else `<project>/csv/project.json`; a corrupt one is **ignored**, never rewritten. */
function readProjectSidecar(project: ExportProject): ProjectSidecar | null {
  for (const path of [join(project.directory, 'project.json'), join(project.csvDirectory, 'project.json')]) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const pick = (raw: unknown) => (typeof raw === 'string' && raw.trim() ? raw.trim() : undefined);
    const messages: Record<string, number> = {};
    if (isRecord(parsed.messages)) {
      for (const [name, count] of Object.entries(parsed.messages)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) messages[name] = Math.trunc(count);
      }
    }
    return {
      dataFileName: pick(parsed.dataFileName),
      capture: pick(parsed.capture),
      startTime: pick(parsed.startTime),
      endTime: pick(parsed.endTime),
      messages,
    };
  }
  return null;
}

/** `"2442,463097.350"` / `"2442 463097.350"` → Graph's ms scale (`(week*604800 + s) * 1000`), or `null`. */
export function gpsCommentMs(cell: string): number | null {
  const normalised = String(cell ?? '').replace(/,/g, ' ').trim();
  if (!normalised) return null;
  const seconds = parseGpsCell(normalised);
  return seconds === null ? null : Math.round(seconds * 1000);
}

/**
 * Chart → the `PlotSummary` group it belongs to, i.e. **the tab it appears under** (not the message
 * that feeds it — `CPU Usage` plots `BESTPOS` but sits in Receiver Status). Taken from the shipped
 * `clean.gpf` (`PVT` / `Receiver_Status` / `Tracking_Measurements`) plus the three
 * `Heading & Attitude` charts, whose group name comes from `export-sbf-project.ts#plotSummaryOf`.
 */
const PLOT_GROUP: Record<string, 'PVT' | 'Heading_Attitude' | 'Tracking_Measurements' | 'Receiver_Status'> = {
  '2D Trajectory': 'PVT',
  Height: 'PVT',
  Velocity: 'PVT',
  'Position SD': 'PVT',
  'Position Status': 'PVT',
  'Position Type': 'PVT',
  'Solution Statistics': 'PVT',
  'CPU Usage': 'Receiver_Status',
  'HW Monitor Status': 'Receiver_Status',
  'Receiver Status': 'Receiver_Status',
  'Tracking Time': 'Tracking_Measurements',
  'GNSS Signal Strength': 'Tracking_Measurements',
  'Satellites and Signals': 'Tracking_Measurements',
  Azimuth: 'Heading_Attitude',
  'Roll and Pitch': 'Heading_Attitude',
  'SPAN Filter Updates': 'Heading_Attitude',
};

/**
 * `PlotSummary` for a project, built from the CSVs that are actually here: a chart exists iff its
 * export does. The value `1` is copied from `clean.gpf` (every chart entry there is `1`).
 */
export function plotSummaryOfCsvs(csvNames: string[]): Record<string, unknown> {
  const present = new Set(csvNames.map((name) => name.toLowerCase()));
  const summary: Record<string, unknown> = {};
  const tracking: Record<string, Record<string, number>> = {};
  for (const spec of CSV_CHARTS) {
    if (!present.has(`${spec.title}.csv`.toLowerCase())) continue;
    const section = PLOT_GROUP[spec.title] ?? 'PVT';
    const entry = { [spec.plot?.message ?? spec.message]: 1 };
    if (section === 'Tracking_Measurements') {
      tracking[spec.plot?.title ?? spec.title] = entry;
      continue;
    }
    const target = (summary[section] as Record<string, Record<string, number>> | undefined) ?? {};
    target[spec.plot?.title ?? spec.title] = entry;
    summary[section] = target;
  }
  if (Object.keys(tracking).length) summary.Tracking_Measurements = { Primary: tracking };
  return summary;
}

/**
 * Where a new `.gpf` would go: `<dir>/<basename(dir)>.gpf` (`getGpfFilePath` @538881).
 *
 * `null` when the directory already holds a `.gpf` that `projectGpfPath` could not attribute to this
 * project (two unrelated files) — a third one would only make the ambiguity worse.
 */
export function projectGpfCreatePath(project: ExportProject): string | null {
  let entries: string[];
  try {
    entries = readdirSync(project.directory).filter((file) => extname(file).toLowerCase() === '.gpf');
  } catch {
    return null;
  }
  if (entries.length) return null;
  const name = basename(project.directory);
  if (!name || name === '.' || name === '..') return null;
  return join(project.directory, `${name}.gpf`);
}

/**
 * A **new** `.gpf` for this project, or `null` when there is nothing honest to put in it.
 *
 * `null` means "one of the measurements is missing": no CSV at all, or no readable time window
 * (neither `#Start Time(GPS)`/`#End Time(GPS)` in the CSVs nor a timestamped row, nor a
 * `project.json`). Writing a file with a made-up window would make the playhead lie.
 */
export function buildProjectGpf(project: ExportProject, flags: GpfFlagState): string | null {
  const names = csvNamesIn(project.csvDirectory);
  if (!names.length) return null;
  let first: ParsedCsv;
  try {
    first = readCsv(project.csvDirectory, names[0]);
  } catch {
    // The CSV vanished between the directory listing and the read: nothing measured, nothing written.
    return null;
  }
  const comments = commentsOf(first);
  const sidecar = readProjectSidecar(project);

  let startMs = gpsCommentMs(comments.startTime) ?? gpsCommentMs(sidecar?.startTime ?? '');
  let endMs = gpsCommentMs(comments.endTime) ?? gpsCommentMs(sidecar?.endTime ?? '');
  if (startMs === null || endMs === null) {
    const stamped = first.timeColumnIndex >= 0
      ? first.rows
        .map((row) => parseGpsCell(row[first.timeColumnIndex] ?? ''))
        .filter((value): value is number => value !== null)
        .map((seconds) => Math.round(seconds * 1000))
      : [];
    if (stamped.length) {
      startMs = startMs ?? stamped[0];
      endMs = endMs ?? stamped[stamped.length - 1];
    }
  }
  if (startMs === null || endMs === null) return null;
  if (endMs < startMs) [startMs, endMs] = [endMs, startMs];
  // The CSV window is `[start, end)`, so a one-record project still has a non-zero duration.
  if (endMs === startMs) endMs = startMs + 1;

  const dataFileName = comments.dataFileName || sidecar?.dataFileName || '';
  const capturePath = sidecar?.capture && isAbsolute(sidecar.capture) ? sidecar.capture : '';
  let fileSize = 0;
  if (capturePath) {
    try {
      const info = statSync(capturePath);
      if (info.isFile()) fileSize = info.size;
    } catch {
      /* the capture has been moved/removed: FileSize stays 0 rather than a guess */
    }
  }

  const messages: Record<string, number> = {};
  const sidecarMessages = sidecar?.messages ?? {};
  for (const name of Object.keys(sidecarMessages).sort((a, b) => a.localeCompare(b, 'en'))) {
    messages[name] = sidecarMessages[name];
  }
  const totalLogInstances = Object.values(messages).reduce((sum, count) => sum + count, 0);

  const data: Record<string, unknown> = {
    PageRoute: '/process',
    projectDirectory: project.directory,
    filePath: capturePath,
    filename: dataFileName,
    fileTimeline: { StartTime: startMs, EndTime: endMs },
    updatedProjSummary: {
      DataInfo: {
        Duration: endMs - startMs,
        EndTime: endMs,
        FileSize: fileSize,
        StartTime: startMs,
      },
      ReceiverInfo: { signalinfo: null, version: null },
      Messages: messages,
      PlotSummary: plotSummaryOfCsvs(names),
    },
    InputValidation: 0,
    Percentage: 100,
    TotalLogInstances: totalLogInstances,
    ValidationCode: 0,
    api: 'FileValidation',
    currentTimeStamp: 0,
    isPlaying: false,
    editedStart: 0,
    editedEnd: 0,
    FlagsInitialState: {
      allFlags: Array.isArray(flags?.allFlags) ? flags.allFlags : [],
      isFlagsPanelOpen: !!flags?.isFlagsPanelOpen,
    },
  };
  return JSON.stringify(withGpfChecksum(data), null, 2);
}

/** temp file + rename: a crash cannot leave a truncated `.gpf` behind. */
function writeGpfFile(path: string, text: string): { ok: true } | { ok: false; error: string } {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file never existed */
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/**
 * Write `FlagsInitialState` into the project's `.gpf`, leaving every other field alone.
 *
 * Refuses (`ok: false` + `reason`) when the project has no `.gpf` (`no-gpf` — the caller falls back to
 * its own store; with `options.create` an empty marker list is refused for the same reason), when the
 * input is not `{allFlags: []}` (`invalid`), when the existing file cannot be read/parsed
 * (`unreadable` / `bad-json`) — a `.gpf` is user data and a broken one is never overwritten with a
 * shorter, lossy version — or when a new file could not be filled with measured values (`no-data`).
 */
export function writeProjectFlags(
  project: ExportProject,
  flags: GpfFlagState,
  options: ProjectGpfWriteOptions = {},
): ProjectGpfWrite {
  const existing = projectGpfPath(project);
  if (!existing) {
    if (!options.create) return { ok: false, reason: 'no-gpf' };
    if (!isGpfFlagState(flags)) return { ok: false, reason: 'invalid', error: 'flags 必须是 {allFlags: [...]}' };
    // Nothing to store yet: an empty marker list is the same thing an empty `localStorage` bucket is,
    // and creating a project file for it would put a file in the user's directory for no reason.
    if (!flags.allFlags.length) return { ok: false, reason: 'no-gpf' };
    const path = projectGpfCreatePath(project);
    if (!path) return { ok: false, reason: 'no-gpf' };
    const text = buildProjectGpf(project, flags);
    if (text === null) {
      return { ok: false, reason: 'no-data', error: '工程缺少可用的时间窗（CSV 里没有 GPS 时间），不凭空造 .gpf' };
    }
    // A `.gpf` that appeared between the probe and here is somebody else's file: leave it alone.
    if (existsSync(path)) return { ok: false, path, reason: 'unreadable', error: `${path} 在写入前已存在` };
    const written = writeGpfFile(path, text);
    if (!written.ok) return { ok: false, path, reason: 'write-failed', error: written.error };
    return { ok: true, path, text, created: true };
  }

  const path = existing;
  if (!isGpfFlagState(flags)) return { ok: false, path, reason: 'invalid', error: 'flags 必须是 {allFlags: [...]}' };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, path, reason: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
  const merged = mergeGpfFlags(text, flags, { resign: options.resign });
  if (merged === null) return { ok: false, path, reason: 'bad-json', error: `${path} 不是合法的 .gpf JSON` };
  if (merged === text) return { ok: true, path, text };

  const written = writeGpfFile(path, merged);
  if (!written.ok) return { ok: false, path, reason: 'write-failed', error: written.error };
  return { ok: true, path, text: merged };
}

