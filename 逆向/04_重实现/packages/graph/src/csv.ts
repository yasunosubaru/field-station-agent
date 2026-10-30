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
  formatFixedHalfEven,
  formatGpsColumn,
  formatGpsCommentTime,
  formatTrimmed,
} from './format.ts';
import type { GraphProject } from './project.ts';
import { chartMessages, chartTitles } from './project.ts';
import { renderReceiverStatus } from './receiver-status.ts';
import {
  gnssSignalStrengthColumns,
  renderSatellitesAndSignals,
  trackingTimeColumns,
} from './range-charts.ts';

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
  /**
   * Charts whose column *set* is data-dependent build their columns per export instead of at module
   * load (`HW Monitor Status` names one column per measurement the receiver actually reports).
   */
  buildColumns?: (project: GraphProject, capture: Capture) => CsvColumn[];
  /** Charts that are not a timestamp series at all (`Receiver Status`) render themselves. */
  render?: (project: GraphProject, capture: Capture) => Buffer;
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
      return formatFixedHalfEven(Number(value), 6);
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
  if (spec.render) {
    const body = spec.render(project, capture).toString('utf8');
    // A self-rendering chart still carries the same six comment lines and BOM.
    const text = csvHeader(project) + body;
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  }
  const columns = spec.buildColumns ? spec.buildColumns(project, capture) : spec.columns;
  const rows = chartRecords(project, capture, spec);
  const header = ['timestamp (GPS week sec)', ...columns.map((column) => column.header)].join(',');
  const body = rows.map((record) => {
    const cells = [formatGpsColumn(record.gpsMs)];
    for (const column of columns) cells.push(renderValue(column.format, column.value(record)));
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

/** `Position SD.csv` — three SD columns, six decimals **trimmed** (golden `1.19761`). */
const POSITION_SD_COLUMNS: CsvColumn[] = [
  { header: 'Latitude SD', format: 'trim6', value: (record) => field(record, 'latitude_std_dev') },
  { header: 'Longitude SD', format: 'trim6', value: (record) => field(record, 'longitude_std_dev') },
  { header: 'Height SD', format: 'trim6', value: (record) => field(record, 'height_std_dev') },
];

/**
 * `Solution Statistics.csv` — same BESTPOS record, **opposite** trailing-zero rule: both ages are
 * fixed six decimals (`0.000000` in the golden), the two counts are integers.
 */
const SOLUTION_STATISTICS_COLUMNS: CsvColumn[] = [
  { header: 'Differential Lag', format: 'fixed6', value: (record) => field(record, 'diff_age') },
  { header: 'Solution Age', format: 'fixed6', value: (record) => field(record, 'solution_age') },
  { header: 'Satellites Tracked', format: 'int', value: (record) => field(record, 'num_svs') },
  { header: 'Satellites Used In Solution', format: 'int', value: (record) => field(record, 'num_soln_svs') },
];

/**
 * `CPU Usage.csv` — `(200 - idleTimeRaw) / 2`, one decimal.
 *
 * `idleTimeRaw` is byte 12 of the 28-byte SBF header (`packages/protocol/src/header.ts`), not a
 * payload field. Golden: idle 142 → `29.0`, 144 → `28.0`, 141 → `29.5`.
 */
const CPU_USAGE_COLUMNS: CsvColumn[] = [
  {
    header: 'CPU Usage',
    format: 'fixed1',
    value: (record) => {
      const header = record.frame.header;
      if (header.kind !== 'long') throw new Error('CPU Usage needs a long SBF header');
      return (200 - header.idleTimeRaw) / 2;
    },
  },
];

/**
 * `HW Monitor Status` measurement id → column name, read out of the shipped
 * `graph-node-wrapper.node` (`status >> 8`). The **column set and order** are not this table's
 * order: Graph writes them in the order the measurements arrive in the record (golden is
 * 1, 2, 6, 7, 8, 15, 17, 21, 23, 22).
 */
const HWMONITOR_NAMES: Record<number, string> = {
  1: 'Temperature',
  2: 'Antenna Current',
  6: 'Internal Supply Voltage',
  7: 'Antenna Voltage',
  8: 'Digital Core Voltage',
  15: 'Supply Voltage',
  17: 'V 1.8',
  21: 'V 5.0',
  23: 'Peripheral Core Voltage',
  22: 'Secondary Temperature',
};

/** Columns of `HW Monitor Status`, built from the first record's measurements (data-dependent). */
function hwMonitorColumns(_project: GraphProject, capture: Capture): CsvColumn[] {
  const [record] = capture.byName('HWMONITOR');
  if (!record) return [];
  const count = field(record, 'measurements.count');
  const columns: CsvColumn[] = [];
  for (let i = 0; i < count; i++) {
    const status = field(record, `measurements[${i}].status`);
    const id = status >> 8;
    columns.push({
      header: HWMONITOR_NAMES[id] ?? `Unknown ${id}`,
      format: 'fixed6',
      value: (r) => field(r, `measurements[${i}].value`),
    });
  }
  return columns;
}

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
  { title: 'Position SD', message: 'BESTPOS', columns: POSITION_SD_COLUMNS },
  { title: 'Solution Statistics', message: 'BESTPOS', columns: SOLUTION_STATISTICS_COLUMNS },
  { title: 'CPU Usage', message: 'BESTPOS', columns: CPU_USAGE_COLUMNS },
  { title: 'HW Monitor Status', message: 'HWMONITOR', columns: [], buildColumns: hwMonitorColumns },
  { title: 'Receiver Status', message: 'RXSTATUS', columns: [], render: renderReceiverStatus },
  { title: 'Tracking Time', message: 'RANGE', columns: [], buildColumns: trackingTimeColumns },
  { title: 'GNSS Signal Strength', message: 'RANGE', columns: [], buildColumns: gnssSignalStrengthColumns },
  { title: 'Satellites and Signals', message: 'RANGE', columns: [], render: renderSatellitesAndSignals },
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
