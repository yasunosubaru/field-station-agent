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
 * Formatting per column is **not** uniform in the original and is recorded per column here: the SD
 * columns print six decimals with trailing zeros trimmed (`1.19761`), `Solution Statistics` prints
 * `0.000000`, and `Height` keeps its trailing zeros too (`65.931110`, oracle `broad`). See
 * `format.ts`.
 *
 * `Latitude` / `Longitude` are printed trimmed (`trim6`) because that is what both oracles were read
 * with; no cell of either capture happens to end in `0`, so `fixed6` would have produced the same
 * bytes — the ambiguity is recorded rather than guessed away.
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
  /** Value of the column for a record; `null` renders an empty cell (a satellite not tracked yet). */
  value(record: CaptureRecord): string | number | null;
}

export interface ChartCsvSpec {
  /** Chart title; also the file name (`<title>.csv`). */
  title: string;
  /** Message that feeds the chart (`PlotSummary` guarantees it is present). */
  message: string;
  /**
   * Every message that can feed this chart, **best first**.
   *
   * The `Heading & Attitude` plots are the reason this exists: the shipped native module
   * (`resources/native_modules/<platform>/graph-node-wrapper.node`) carries one table that ranks
   * each log by chart, e.g. `"1465": {"Priority": { … "Roll and Pitch":1, "Azimuth":1, "SPAN Filter Updates":1 }}`,
   * `507` → 2, `508` → 3, `1457` → 4, `263` → 5, `1889` → 6. A chart therefore reads whichever of
   * those logs is present, the best rank winning at any timestamp it occurs on.
   * Defaults to `[message]`, which is what every pre-existing chart does.
   */
  sourceMessages?: string[];
  /**
   * The `PlotSummary` entry that stands for this chart, when Graph names it differently from the
   * CSV title. The native HA parser writes `Heading_Attitude: {"INS Orientation Pitch": …,
   * "INS Orientation Azimuth": …, "SPAN Filter Updates": …}` while the CSV files are
   * `Roll and Pitch.csv` / `Azimuth.csv` / `SPAN Filter Updates.csv` (see `DbToCsvConverter`'s
   * `kDbBaseNames`).
   */
  plot?: { title: string; message: string };
  columns: CsvColumn[];
  /**
   * Charts whose column *set* is data-dependent build their columns per export instead of at module
   * load (`HW Monitor Status` names one column per measurement the receiver actually reports).
   */
  buildColumns?: (project: GraphProject, capture: Capture) => CsvColumn[];
  /** Charts that are not a timestamp series at all (`Receiver Status`) render themselves. */
  render?: (project: GraphProject, capture: Capture) => Buffer;
  /**
   * Keep one row per timestamp, the first record in log order winning.
   *
   * Graph writes every chart into its own SQLite table, and the table's primary key is the
   * timestamp: `graph-node-wrapper.node` carries the literal
   * `CREATE TABLE IF NOT EXISTS navigation (timestamp INTEGER PRIMARY KEY,…)` together with
   * `INSERT OR IGNORE INTO "`. A receiver configured to log the same message on two ports therefore
   * delivers two frames with the same timestamp and the same payload, and the second one is
   * `OR IGNORE`d — the row count is the number of *timestamps*, not of frames.
   *
   * `HWMONITOR` is where the shipped captures prove it: `broad-clean.gps` holds 65 frames but only
   * 59 timestamps (6 cross-port pairs at the 10 s boundaries) and the oracle
   * `export-broad/csv/HW Monitor Status.csv` has exactly 59 rows. In that capture no other chart's
   * message repeats a timestamp, and no oracle demonstrates a collapse for the others, so the flag
   * is set only here and the rest keep their previous behaviour.
   */
  oneRowPerTimestamp?: boolean;
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

function renderValue(format: ColumnFormat, value: string | number | null): string {
  if (value === null || value === undefined) return '';
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

/** Every `PlotSummary` title that stands for a chart (its own title unless the spec renames it). */
export function plotTitlesOf(spec: ChartCsvSpec): string[] {
  return spec.plot ? [spec.plot.title] : [spec.title];
}

/**
 * Records of the chart's message(s) inside the project window, one row per timestamp.
 *
 * `oneRowPerTimestamp` collapses frames that share a timestamp (see `ChartCsvSpec`); the first
 * record in log order is the one Graph's `INSERT OR IGNORE` would have kept.
 *
 * A chart with several `sourceMessages` (the `Heading & Attitude` plots) reads them **best rank
 * first**: at a timestamp that several of them share, the highest-priority log wins. Nothing is
 * substituted — a chart still only ever reads the fields of the log that fed it.
 */
export function chartRecords(project: GraphProject, capture: Capture, spec: ChartCsvSpec): CaptureRecord[] {
  const { StartTime, EndTime } = project.dataInfo;
  const inWindow = (record: CaptureRecord) => record.gpsMs >= StartTime && record.gpsMs < EndTime;
  const sources = spec.sourceMessages ?? [spec.message];

  if (sources.length > 1) {
    const byTime = new Map<number, CaptureRecord>();
    for (const name of sources) {
      for (const record of capture.byName(name)) {
        if (!inWindow(record) || byTime.has(record.gpsMs)) continue;
        byTime.set(record.gpsMs, record);
      }
    }
    return [...byTime.values()].sort((a, b) => a.gpsMs - b.gpsMs);
  }

  const records = capture.byName(sources[0]).filter(inWindow);
  if (!spec.oneRowPerTimestamp) return records;
  const seen = new Set<number>();
  return records.filter((record) => {
    if (seen.has(record.gpsMs)) return false;
    seen.add(record.gpsMs);
    return true;
  });
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
  // Six decimals with the zeros **kept**. The `broad` oracle prints `65.931110` / `65.922480`; the
  // same column used to be trimmed here and lost 12 of its 60 trailing zeros.
  format: 'fixed6',
  value: (record) => field(record, 'orthometric_height'),
};

/**
 * `Velocity.csv` — one **BESTVEL** record → five derived columns.
 *
 * Ground truth: `00_来源/samples/graph/export-broad/csv/Velocity.csv` (project `broad`, 60 rows,
 * 2442 467950.000 – 2442 468009.000). Graph does not plot BESTVEL's fields directly: it turns
 * `horizontal_speed` + `ground_track` into a north/east pair. `ground_track` is the SBF field in
 * **degrees** (`0…360`, clockwise from north), so the components are
 *
 * ```
 * North      = horizontal_speed · cos(ground_track°)
 * East       = horizontal_speed · sin(ground_track°)
 * Up         = z                     (BESTVEL's own vertical speed, m/s)
 * Horizontal = hypot(North, East)    (recomputed; equals horizontal_speed)
 * 3D         = hypot(Horizontal, Up)
 * ```
 *
 * These five agree with the golden cell for cell (all 300 numeric cells), and every cell is
 * printed `%.6f` with its zeros kept — no column here is trailing-zero trimmed.
 */
function velocityComponents(record: CaptureRecord): { north: number; east: number; up: number } {
  const speed = field(record, 'horizontal_speed');
  const track = (field(record, 'ground_track') * Math.PI) / 180;
  return { north: speed * Math.cos(track), east: speed * Math.sin(track), up: field(record, 'z') };
}

const VELOCITY_COLUMNS: CsvColumn[] = [
  { header: 'North Vel', format: 'fixed6', value: (record) => velocityComponents(record).north },
  { header: 'East Vel', format: 'fixed6', value: (record) => velocityComponents(record).east },
  { header: 'Up Vel', format: 'fixed6', value: (record) => field(record, 'z') },
  {
    header: 'Horizontal Speed',
    format: 'fixed6',
    value: (record) => {
      const { north, east } = velocityComponents(record);
      return Math.hypot(north, east);
    },
  },
  {
    header: '3D Speed',
    format: 'fixed6',
    value: (record) => {
      const { north, east, up } = velocityComponents(record);
      return Math.hypot(Math.hypot(north, east), up);
    },
  },
];

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

/** Columns of `HW Monitor Status`, built from the first in-window record's measurements (data-dependent). */
function hwMonitorColumns(project: GraphProject, capture: Capture): CsvColumn[] {
  const [record] = chartRecords(project, capture, { title: 'HW Monitor Status', message: 'HWMONITOR', columns: [] });
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
 * `Heading & Attitude` — the three plots this build used to omit (catalog group `HEADING_ATTITUDE`).
 *
 * There is **no original CSV** for any of them on this machine (`ANTENNA=SINGLE`, IMU/INS
 * `UNAUTHORIZED`), so nothing below is a byte-for-byte comparison. What *is* evidence, read out of
 * `resources/native_modules/{windows,linux}/graph-node-wrapper.node`:
 *
 *  - `INSATTITUDE`'s constructor builds two tables with
 *    `createTable({timestamp,TEXT},{[INS Azimuth],REAL})` and
 *    `createTable({timestamp,TEXT},{[INS Pitch],REAL},{[INS Roll],REAL})` — that is the column set
 *    **and order** (`INS Pitch` before `INS Roll`), verified in the Linux symbol table at
 *    `INSATTITUDE::INSATTITUDE` (`objdump -d 0x30ea60`, literals `0x6d617473656d6974` = "timestamp",
 *    `0x54584554` = "TEXT", `0x4c414552` = "REAL", `[INS Azimuth]`, `[INS Pitch]`, `[INS Roll]`).
 *  - `INSATTITUDE::addPoint` maps them to message fields: struct `+0x60` → `INS Roll`, `+0x70` →
 *    `INS Pitch`, `+0x80` → `INS Azimuth`, and `INSLogDecoder::SetData` fills those three from
 *    INSPVA/INSPVAX payload offsets `0x3c` / `0x44` / `0x4c`, i.e. `roll` / `pitch` / `azimuth`.
 *    Each is written through `printf("%f")`, hence six decimals below.
 *  - The same native table ranks the logs per chart: INSPVAX 1465 → 1, INSPVA 507 → 2,
 *    INSPVAS 508 → 3, INSATTX 1457 → 4, INSATT 263 → 5, INSPVACMP 1889 → 6.
 *    `HEADING2` (1335) and `DUALANTENNAALIGN` (1761) are **not** in that table, so a dual-antenna
 *    heading does not feed any Graph chart — a synthetic capture with only those two exports no
 *    Heading & Attitude CSV at all, exactly like the original.
 */
const INS_ATTITUDE_SOURCES = ['INSPVAX', 'INSPVA', 'INSPVAS', 'INSATTX', 'INSATT', 'INSPVACMP'];

/** `Azimuth.csv` — one column, `INS Azimuth`, straight from the log's `azimuth` (degrees). */
const AZIMUTH_COLUMNS: CsvColumn[] = [
  { header: 'INS Azimuth', format: 'fixed6', value: (record) => field(record, 'azimuth') },
];

/** `Roll and Pitch.csv` — `INS Pitch` **before** `INS Roll`, the order `createTable` receives. */
const ROLL_AND_PITCH_COLUMNS: CsvColumn[] = [
  { header: 'INS Pitch', format: 'fixed6', value: (record) => field(record, 'pitch') },
  { header: 'INS Roll', format: 'fixed6', value: (record) => field(record, 'roll') },
];

/**
 * `SPAN Filter Updates.csv` — the other span table (`INSUPDATE`, `FILENAMEDB`), built by
 * `createTable({name,TEXT},{start,TEXT},{end,TEXT},{value,TEXT},{min_diff,TEXT})`.
 *
 * The 33 names are the 33 literals in the same module, in bit order (`Position update` …
 * `NVM Seed Indication 3`, then a catch-all `Reserved`). `min_diff` is **seconds** — the renderer
 * multiplies it by 1000 before stepping the drawing (`transformFloatingBarData` @575248).
 *
 * The *span* rule is inferred, not measured: no original export exists here, so the code reuses the
 * one rule that is proven for the sibling span table `Receiver Status.csv` (a span opens on the
 * first record where the bit is set and closes on the record that clears it, or on the last record
 * of the window). `value` is the literal `1`, the same constant the golden `Receiver Status.csv`
 * writes. Marked as such in `03_分析/13_Graph分析页.md`; not claimed to be byte-identical.
 */
const INS_UPDATE_NAMES = [
  'Position update', 'Phase update', 'Zero velocity update', 'Wheel sensor update',
  'ALIGN (heading) update', 'External position update', 'INS solution convergence flag',
  'Doppler update', 'Pseudorange update', 'Velocity update', 'Reserved_10',
  'Dead reckoning update', 'Phase wind up update', 'Course over ground update',
  'External velocity update', 'External attitude update', 'External heading update',
  'External height update', 'Reserved_18', 'Reserved_19', 'Reserved_20', 'Reserved_21',
  'Secondary INS solution', 'Reserved_23', 'Turn on biases estimated',
  'Alignment direction verified', 'Alignment Indication 1', 'Alignment Indication 2',
  'Alignment Indication 3', 'NVM Seed Indication 1', 'NVM Seed Indication 2',
  'NVM Seed Indication 3', 'Reserved',
];

/** The status word the update bits live in: `extended_sol_stat` on the X messages, else the basic one. */
function insStatusWord(record: CaptureRecord): number {
  const path = record.byPath.has('extended_sol_stat') ? 'extended_sol_stat' : 'ins_solution_status';
  return record.byPath.has(path) ? field(record, path) >>> 0 : 0;
}

interface UpdateSpan {
  name: string;
  start: number;
  end: number;
  /** Smallest gap between two consecutive records of the span, in seconds (`%f` in the table). */
  minDiff: number;
}

/** Spans of each INS-update bit over the window, sorted by name (the golden span-table order). */
export function spanFilterUpdateSpans(project: GraphProject, capture: Capture): UpdateSpan[] {
  const records = chartRecords(project, capture, {
    title: 'SPAN Filter Updates', message: 'INSPVAX', columns: [], sourceMessages: INS_ATTITUDE_SOURCES,
  });

  const spans: UpdateSpan[] = [];
  // `extended_sol_stat` / `ins_solution_status` are 32-bit words: bits 0..31. The 33rd name
  // (`Reserved`) is the module's catch-all, not a bit of its own.
  for (let bit = 0; bit < INS_UPDATE_NAMES.length - 1; bit += 1) {
    let start: number | null = null;
    let lastSet = 0;
    let previousSet: number | null = null;
    let minDiff = Infinity;
    for (const record of records) {
      if (((insStatusWord(record) >>> bit) & 1) === 1) {
        if (start === null) start = record.gpsMs;
        if (previousSet !== null) minDiff = Math.min(minDiff, (record.gpsMs - previousSet) / 1000);
        previousSet = record.gpsMs;
        lastSet = record.gpsMs;
      } else if (start !== null) {
        spans.push({ name: INS_UPDATE_NAMES[bit], start, end: record.gpsMs, minDiff: minDiff === Infinity ? 0 : minDiff });
        start = null;
        previousSet = null;
        minDiff = Infinity;
      }
    }
    if (start !== null) {
      spans.push({ name: INS_UPDATE_NAMES[bit], start, end: lastSet, minDiff: minDiff === Infinity ? 0 : minDiff });
    }
  }
  return spans.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The header + body of `SPAN Filter Updates.csv` (the six comment lines are added by `csv.ts`). */
export function renderSpanFilterUpdates(project: GraphProject, capture: Capture): string {
  const rows = spanFilterUpdateSpans(project, capture).map(
    (span) => `${span.name},${span.start.toFixed(6)},${span.end.toFixed(6)},1,${span.minDiff.toFixed(6)}`,
  );
  return ['name,start,end,value,min_diff', ...rows].map((line) => line + '\r\n').join('');
}

/**
 * The charts the CSV exporter can reproduce. Twelve of them are byte-identical to a shipped golden
 * (`clean`: 12 files; `broad` adds `Velocity`); the three `Heading & Attitude` ones are implemented
 * from the shipped native module's table/column/field evidence and have **no golden to compare
 * against** — see the block above and `03_分析/13_Graph分析页.md`. Charts that exist in
 * `PlotSummary` but are missing here are silently skipped, exactly like Graph skips charts with no
 * data.
 */
export const CSV_CHARTS: ChartCsvSpec[] = [
  { title: '2D Trajectory', message: 'BESTPOS', columns: [bestposLatitude, bestposLongitude] },
  { title: 'Height', message: 'BESTPOS', columns: [bestposHeight] },
  { title: 'Velocity', message: 'BESTVEL', columns: VELOCITY_COLUMNS },
  { title: 'Position Status', message: 'BESTPOS', columns: [bestposSolutionType] },
  { title: 'Position Type', message: 'BESTPOS', columns: [bestposPositionType] },
  { title: 'Position SD', message: 'BESTPOS', columns: POSITION_SD_COLUMNS },
  { title: 'Solution Statistics', message: 'BESTPOS', columns: SOLUTION_STATISTICS_COLUMNS },
  { title: 'CPU Usage', message: 'BESTPOS', columns: CPU_USAGE_COLUMNS },
  { title: 'HW Monitor Status', message: 'HWMONITOR', columns: [], buildColumns: hwMonitorColumns, oneRowPerTimestamp: true },
  { title: 'Receiver Status', message: 'RXSTATUS', columns: [], render: renderReceiverStatus },
  {
    title: 'Azimuth', message: 'INSPVAX', columns: AZIMUTH_COLUMNS, sourceMessages: INS_ATTITUDE_SOURCES,
    plot: { title: 'INS Orientation Azimuth', message: 'insattitude_azimuth' },
  },
  {
    title: 'Roll and Pitch', message: 'INSPVAX', columns: ROLL_AND_PITCH_COLUMNS, sourceMessages: INS_ATTITUDE_SOURCES,
    plot: { title: 'INS Orientation Pitch', message: 'insattitude_pitch' },
  },
  {
    title: 'SPAN Filter Updates', message: 'INSPVAX', columns: [], sourceMessages: INS_ATTITUDE_SOURCES,
    render: renderSpanFilterUpdates, plot: { title: 'SPAN Filter Updates', message: 'insUpdatestatus' },
  },
  { title: 'Tracking Time', message: 'RANGE', columns: [], buildColumns: trackingTimeColumns },
  { title: 'GNSS Signal Strength', message: 'RANGE', columns: [], buildColumns: gnssSignalStrengthColumns },
  { title: 'Satellites and Signals', message: 'RANGE', columns: [], render: renderSatellitesAndSignals },
];

export function csvChartSpec(title: string): ChartCsvSpec | undefined {
  return CSV_CHARTS.find((spec) => spec.title === title);
}

/**
 * Charts this project should export: the implemented specs that `PlotSummary` says have data.
 * `PlotSummary` decides — never a fixed list (R17 of the analysis). A chart whose `PlotSummary`
 * title differs from its CSV title (`Heading & Attitude`) is matched by `plotTitlesOf`.
 */
export function availableCsvCharts(project: GraphProject): ChartCsvSpec[] {
  const titles = chartTitles(project.plotSummary);
  return CSV_CHARTS.filter((spec) => {
    const plotTitle = plotTitlesOf(spec).find((title) => titles.includes(title));
    return !!plotTitle && Object.keys(chartMessages(project.plotSummary, plotTitle)).length > 0;
  });
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
