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

import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

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
export type ProjectGpfWriteReason = 'no-gpf' | 'invalid' | 'unreadable' | 'bad-json' | 'write-failed';

export interface ProjectGpfWrite {
  ok: boolean;
  /** Absolute path that was written (absent when there is no `.gpf` at all). */
  path?: string;
  reason?: ProjectGpfWriteReason;
  error?: string;
  /** The bytes that were written (for tests and for a caller that wants to serve them). */
  text?: string;
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
 */
export function mergeGpfFlags(text: string, flags: GpfFlagState): string | null {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const data = parseGpf(body);
  if (!data) return null;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? '  ';
  const trailingNewline = /\r?\n$/.test(body);
  const next = {
    ...data,
    FlagsInitialState: {
      allFlags: Array.isArray(flags?.allFlags) ? flags.allFlags : [],
      isFlagsPanelOpen: !!flags?.isFlagsPanelOpen,
    },
  };
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

/**
 * Write `FlagsInitialState` into the project's `.gpf`, leaving every other field alone.
 *
 * Refuses (`ok: false` + `reason`) when the project has no `.gpf` (`no-gpf` — the caller falls back to
 * its own store), when the input is not `{allFlags: []}` (`invalid`), or when the existing file cannot
 * be read/parsed (`unreadable` / `bad-json`) — a `.gpf` is user data and a broken one is never
 * overwritten with a shorter, lossy version.
 */
export function writeProjectFlags(project: ExportProject, flags: GpfFlagState): ProjectGpfWrite {
  const path = projectGpfPath(project);
  if (!path) return { ok: false, reason: 'no-gpf' };
  if (!isGpfFlagState(flags)) return { ok: false, path, reason: 'invalid', error: 'flags 必须是 {allFlags: [...]}' };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, path, reason: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
  const merged = mergeGpfFlags(text, flags);
  if (merged === null) return { ok: false, path, reason: 'bad-json', error: `${path} 不是合法的 .gpf JSON` };
  if (merged === text) return { ok: true, path, text };

  // temp file + rename: a crash cannot leave a truncated `.gpf` behind.
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, merged, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file never existed */
    }
    return { ok: false, path, reason: 'write-failed', error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path, text: merged };
}
