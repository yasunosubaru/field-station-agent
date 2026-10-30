/**
 * `ExportCSV` — byte-for-byte reproduction of Graph's `CSV (original data only)` output.
 *
 * Ground truth: `00_来源/samples/graph/export/csv/*.csv` (Graph 2.11.0, driven 2026-10-31).
 * Everything below was read off those files, not guessed:
 *
 * ```
 * <BOM>#Project Name:          clean\r\n
 * #Project Directory:    C:\\…\\gs\\clean\r\n
 * #Data File Name:      clean.gps\r\n
 * #Start Time(GPS):      2442,463097.350\r\n
 * #End Time(GPS):        2442,463102.300\r\n
 * #Duration:                   00:00:04\r\n
 * timestamp (GPS week sec),<col>,…\r\n
 * <row>\r\n …
 * ```
 *
 *  - UTF-8 BOM, CRLF, trailing CRLF after the last row.
 *  - The six `#` lines carry **hand-padded** literals (the value column is at 24 / 24 / 22 / 23 /
 *    22 / 29 characters respectively), so they are reproduced as literal prefixes.
 *  - Rows are the messages with `StartTime <= t < EndTime` (the last RANGE of the sample sits
 *    exactly on `EndTime` and is absent from CSV, while the last BESTPOS is 300 ms earlier and
 *    is present).
 *
 * Formatting per column is **not** uniform in the original and is recorded per column here:
 * `Height`, `Latitude`, `Longitude` and the SD columns print six decimals with trailing zeros
 * trimmed (`1.19761`), while e.g. `Solution Statistics` prints `0.000000`. See `format.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capture, CaptureRecord } from './capture.ts';
import { field } from './capture.ts';
import {
  POSITION_TYPE,
  SOLUTION_STATUS,
  formatDuration,
  formatGpsColumn,
  formatGpsCommentTime,
  formatTrimmed,
} from './format.ts';
import type { GraphProject } from './project.ts';
import { chartMessages, chartTitles } from './project.ts';

/** How one CSV column is rendered. */
export type ColumnFormat = 'trim6' | 'fixed6' | 'fixed1' | 'int' | 'text';

export interface CsvColumn {
  header: string;
  format: ColumnFormat;
  /** Value of the column for a record. */
  value(record: CaptureRecord): string | number;
}

export interface ChartCsvSpec {
  /** Chart title; also the file name (`<title>.csv`). */
  title: string;
  /** Message that feeds the chart (`PlotSummary` guarantees it is present). */
  message: string;
  columns: CsvColumn[];
}

/** The literal comment lines, with the value column exactly where the original puts it. */
const COMMENT_PREFIX = {
  projectName: '#Project Name:          ',
  projectDirectory: '#Project Directory:    ',
  dataFileName: '#Data File Name:      ',
  startTime: '#Start Time(GPS):      ',
  endTime: '#End Time(GPS):       ',
  duration: '#Duration:                   ',
} as const;

function renderValue(format: ColumnFormat, value: string | number): string {
  switch (format) {
    case 'trim6':
      return formatTrimmed(Number(value), 6);
    case 'fixed6':
      return Number(value).toFixed(6);
    case 'fixed1':
      return Number(value).toFixed(1);
    case 'int':
      return String(Math.trunc(Number(value)));
    case 'text':
    default:
      return String(value);
  }
}

function csvHeader(project: GraphProject): string {
  const { dataInfo } = project;
  const lines = [
    COMMENT_PREFIX.projectName + project.projectName,
    COMMENT_PREFIX.projectDirectory + project.projectDirectory,
    COMMENT_PREFIX.dataFileName + project.dataFileName,
    COMMENT_PREFIX.startTime + formatGpsCommentTime(dataInfo.StartTime),
    COMMENT_PREFIX.endTime + formatGpsCommentTime(dataInfo.EndTime),
    COMMENT_PREFIX.duration + formatDuration(dataInfo.Duration),
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Records of the chart's message inside the project window, in log order. */
export function chartRecords(project: GraphProject, capture: Capture, spec: ChartCsvSpec): CaptureRecord[] {
  const { StartTime, EndTime } = project.dataInfo;
  return capture
    .byName(spec.message)
    .filter((record) => record.gpsMs >= StartTime && record.gpsMs < EndTime);
}

/** Render one chart to the exact bytes Graph writes. */
export function renderChartCsv(project: GraphProject, capture: Capture, spec: ChartCsvSpec): Buffer {
  const rows = chartRecords(project, capture, spec);
  const header = ['timestamp (GPS week sec)', ...spec.columns.map((column) => column.header)].join(',');
  const body = rows.map((record) => {
    const cells = [formatGpsColumn(record.gpsMs)];
    for (const column of spec.columns) cells.push(renderValue(column.format, column.value(record)));
    return cells.join(',');
  });
  const text = csvHeader(project) + header + '\r\n' + body.map((line) => line + '\r\n').join('');
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

const bestposSolutionType: CsvColumn = {
  header: 'Solution_Type',
  format: 'text',
  value: (record) => SOLUTION_STATUS[field(record, 'solution_status')] ?? String(field(record, 'solution_status')),
};

const bestposPositionType: CsvColumn = {
  header: 'Position_Type',
  format: 'text',
  value: (record) => POSITION_TYPE[field(record, 'position_type')] ?? String(field(record, 'position_type')),
};

const bestposLatitude: CsvColumn = {
  header: 'Latitude',
  format: 'trim6',
  value: (record) => field(record, 'latitude'),
};

const bestposLongitude: CsvColumn = {
  header: 'Longitude',
  format: 'trim6',
  value: (record) => field(record, 'longitude'),
};

const bestposHeight: CsvColumn = {
  header: 'Height',
  format: 'trim6',
  value: (record) => field(record, 'orthometric_height'),
};

/**
 * The charts the CSV exporter can reproduce **byte-for-byte today**. Charts that exist in
 * `PlotSummary` but are missing here are silently skipped, exactly like Graph skips charts with no
 * data; see the "未完成" list in `03_分析/06_Graph应用.md`.
 */
export const CSV_CHARTS: ChartCsvSpec[] = [
  { title: '2D Trajectory', message: 'BESTPOS', columns: [bestposLatitude, bestposLongitude] },
  { title: 'Height', message: 'BESTPOS', columns: [bestposHeight] },
  { title: 'Position Status', message: 'BESTPOS', columns: [bestposSolutionType] },
  { title: 'Position Type', message: 'BESTPOS', columns: [bestposPositionType] },
];

export function csvChartSpec(title: string): ChartCsvSpec | undefined {
  return CSV_CHARTS.find((spec) => spec.title === title);
}

/**
 * Charts this project should export: the implemented specs that `PlotSummary` says have data.
 * `PlotSummary` decides — never a fixed list of 13 (R17 of the analysis).
 */
export function availableCsvCharts(project: GraphProject): ChartCsvSpec[] {
  const titles = chartTitles(project.plotSummary);
  return CSV_CHARTS.filter((spec) => titles.includes(spec.title) && Object.keys(chartMessages(project.plotSummary, spec.title)).length > 0);
}

export interface CsvExportResult {
  fileName: string;
  bytes: number;
  buffer: Buffer;
}

/** Render every available chart; `selectedPlots` mirrors `ExportCSV`'s parameter. */
export function exportCsv(
  project: GraphProject,
  capture: Capture,
  options: { selectedPlots?: string[] } = {},
): CsvExportResult[] {
  const charts = availableCsvCharts(project).filter(
    (spec) => !options.selectedPlots || options.selectedPlots.includes(spec.title),
  );
  return charts.map((spec) => {
    const buffer = renderChartCsv(project, capture, spec);
    return { fileName: `${spec.title}.csv`, bytes: buffer.length, buffer };
  });
}

/** Write the rendered charts into `<outDir>/csv/` (Graph's destination rule) and return the paths. */
export function writeCsv(project: GraphProject, capture: Capture, outDir: string, options: { selectedPlots?: string[] } = {}): string[] {
  const dir = join(outDir, 'csv');
  mkdirSync(dir, { recursive: true });
  const results = exportCsv(project, capture, options);
  for (const result of results) writeFileSync(join(dir, result.fileName), result.buffer);
  return results.map((result) => join(dir, result.fileName));
}
