/**
 * Graph project files (`.gpf` + `DataSummary.json`).
 *
 * The `.gpf` is plain JSON (`03_分析/06_Graph应用-附录/E_GPF项目文件结构.md`). Graph merges the
 * side-car `DataSummary.json` into it on open — R15 of `03_分析/06_Graph应用.md §8`: a key from
 * `DataSummary.json` only fills a slot the `.gpf` does not already have, and `updatedProjSummary`
 * (the copy Graph itself wrote last time it ran) wins over both.
 *
 * Only what the data/export layer needs is modelled; nothing here reads `GOS/*.db` (SQLCipher,
 * key unknown — U1 in the analysis).
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type PlotMessages = Record<string, number>;

export interface PlotSummaryGroup {
  /** Chart title → `{ messageName: occurrences }`. */
  [titleOrSection: string]: unknown;
}

export interface PlotSummary {
  PVT?: Record<string, unknown>;
  'Position View'?: Record<string, unknown>;
  Heading_Attitude?: Record<string, unknown>;
  Tracking_Measurements?: Record<string, unknown>;
  Receiver_Status?: Record<string, unknown>;
  Receiver_Info?: Record<string, unknown>;
  [group: string]: unknown;
}

export interface DataInfo {
  Duration: number;
  EndTime: number;
  FileSize: number;
  StartTime: number;
}

export interface ProjectSummary {
  DataInfo?: DataInfo;
  PlotSummary?: PlotSummary;
  ReceiverInfo?: Record<string, unknown>;
  Messages?: Record<string, number>;
}

export interface GpfFile {
  PageRoute?: string;
  DataSummary?: string;
  projectDirectory?: string;
  filePath?: string;
  fileTimeline?: { StartTime: number; EndTime: number };
  updatedProjSummary?: ProjectSummary;
  GOSMetaPath?: string;
  filename?: string;
  ValidationCode?: number;
  TotalLogInstances?: number;
  PersistenceInfo?: Record<string, unknown>;
  checksum?: string;
  [key: string]: unknown;
}

export interface GraphProject {
  /** Path the `.gpf` was read from. */
  gpfPath: string;
  /** Parsed `.gpf` exactly as stored (including `checksum`). */
  gpf: GpfFile;
  /** `DataSummary.json` next to the `.gpf`, when present. */
  dataSummaryFile: ProjectSummary | null;
  /** `.gpf` with `DataSummary.json` flattened in (Graph's `fetchDataSummary`, R15). */
  merged: GpfFile;
  /** `<projectDirectory>` — the folder Graph created, also the CSV `#Project Directory:` value. */
  projectDirectory: string;
  /** `clean` — CSV `#Project Name:` / KML `<name>`; the basename of `projectDirectory`. */
  projectName: string;
  /** `clean.gps` — CSV `#Data File Name:` / KML `<!--Data File Name   : …-->`. */
  dataFileName: string;
  /** Absolute path of the capture the project was built from. */
  capturePath: string;
  /** `StartTime`/`EndTime` (Graph's ms scale) of the **projected** data. */
  dataInfo: DataInfo;
  /** The plot summary that decides which charts exist (R17). */
  plotSummary: PlotSummary;
  messages: Record<string, number>;
}

/** Flatten `DataSummary.json` into the `.gpf`, never overwriting a key the `.gpf` already has. */
export function mergeDataSummary(gpf: GpfFile, summary: ProjectSummary | null): GpfFile {
  if (!summary) return gpf;
  const merged: GpfFile = { ...gpf };
  for (const [key, value] of Object.entries(summary)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

/** `updatedProjSummary` (what Graph wrote) beats a stale `DataSummary.json`. */
export function projectSummary(merged: GpfFile): ProjectSummary {
  return (merged.updatedProjSummary as ProjectSummary | undefined) ?? {
    DataInfo: merged.DataInfo as DataInfo | undefined,
    PlotSummary: merged.PlotSummary as PlotSummary | undefined,
    ReceiverInfo: merged.ReceiverInfo as Record<string, unknown> | undefined,
    Messages: merged.Messages as Record<string, number> | undefined,
  };
}

/** True when `value` looks like a chart entry (`{ BESTPOS: 1 }`): every leaf is a number. */
function isMessageMap(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length > 0 && entries.every((entry) => typeof entry === 'number');
}

/**
 * Chart titles present in the project, in `PlotSummary` order.
 *
 * A chart exists iff its title is a key of a plot section — this is the string-equality test R17
 * describes, so the list is derived, never hardcoded to "16 charts". Sections nest one level
 * deeper in two places (`PVT.GNSS`/`PVT.INS` and `Tracking_Measurements.Primary`), so the walk
 * recurses and stops at the first level that looks like `{ message: count }`.
 */
export function chartTitles(plotSummary: PlotSummary): string[] {
  const titles: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'count' || key === 'version' || key === 'signalinfo') continue;
      if (isMessageMap(child)) {
        if (!titles.includes(key)) titles.push(key);
      } else {
        walk(child);
      }
    }
  };
  walk(plotSummary);
  return titles;
}

/** Which messages feed a named chart, straight from `PlotSummary` (empty when absent). */
export function chartMessages(plotSummary: PlotSummary, title: string): PlotMessages {
  let found: PlotMessages | null = null;
  const walk = (value: unknown) => {
    if (found || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === title && isMessageMap(child)) {
        found = child as PlotMessages;
        return;
      }
      if (child && typeof child === 'object' && !isMessageMap(child)) walk(child);
    }
  };
  walk(plotSummary);
  return found ?? {};
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Load `<name>.gpf` plus its sibling `DataSummary.json`. */
export function loadProject(gpfPath: string): GraphProject {
  const gpf = readJson<GpfFile>(gpfPath);
  const projectDirectory = gpf.projectDirectory ?? dirname(gpfPath);
  const summaryPath = gpf.DataSummary ?? join(projectDirectory, 'DataSummary.json');
  const dataSummaryFile = existsSync(summaryPath) ? readJson<ProjectSummary>(summaryPath) : null;
  const merged = mergeDataSummary(gpf, dataSummaryFile);
  const summary = projectSummary(merged);

  const capturePath = gpf.filePath ?? join(projectDirectory, gpf.filename ?? '');
  const dataFileName = gpf.filename ?? basename(capturePath);
  const timeline = gpf.fileTimeline;
  const dataInfo: DataInfo = summary.DataInfo ?? {
    Duration: (timeline?.EndTime ?? 0) - (timeline?.StartTime ?? 0),
    EndTime: timeline?.EndTime ?? 0,
    FileSize: gpf.TotalLogInstances ?? 0,
    StartTime: timeline?.StartTime ?? 0,
  };

  return {
    gpfPath,
    gpf,
    dataSummaryFile,
    merged,
    projectDirectory,
    projectName: basename(projectDirectory),
    dataFileName,
    capturePath,
    dataInfo,
    plotSummary: summary.PlotSummary ?? {},
    messages: summary.Messages ?? {},
  };
}
