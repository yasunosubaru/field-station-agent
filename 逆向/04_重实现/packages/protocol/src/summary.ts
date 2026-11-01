/**
 * `Summary_<input>.txt` — the report Convert writes next to its output directory.
 *
 * Reproduced from `golden-binary/clean-9600/…/Summary_clean-9600.txt` (LF only, 62-column table,
 * cells `padStart(8)+' '` / `' '+padEnd(29)+' '`, separator built from `-` and `+`). Only the
 * "completed at" timestamp is inherently different between runs.
 */

import type { SbfFrame } from './framing.ts';

/**
 * Time status whose stamp is a **reference** epoch, not the observation time (`SATTIME`, 200).
 *
 * An `ALMANAC` / `RAWALM` / `GLOALM` record carries the almanac's reference epoch in its
 * `milliseconds`, minutes or hours away from the file's real span. Measured on
 * `b2-20261101.sbf`: the first records are `ALMANAC 577140.000` and `RANGE 577758.950`, and the
 * suite's Summary starts at **577758.950** — the first record whose status is not SATTIME. Records
 * of other statuses that sit inside the span change nothing (b1 has 172 SATTIME records, all
 * interior), and `clean-9600.gps` (FINESTEERING 180 / SATTIME 200 only) gives the same numbers as
 * first-of-all / last-of-all.
 */
const REFERENCE_TIME_STATUS = 200;

/**
 * Convert prints the GPS seconds-of-week as if they were UTC — the known "no leap seconds" defect of
 * the original (`00A §8 D10`). Verified against `Summary_clean-9600.txt`: week 2442 / 463097.35 →
 * `2026-10-30T08:38:17.350Z`, i.e. no 18 s correction.
 */
function gpsAsUtc(week: number, milliseconds: number): Date {
  return new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + milliseconds);
}

export interface SummaryInput {
  /** e.g. `clean-9600.gps` */
  fileName: string;
  /** Byte length of the input file. */
  bytes: number;
  /** Absolute directory the input came from. */
  inputDirectory: string;
  /** Absolute `Converted_On_…` directory the output went to. */
  outputDirectory: string;
  formatName: string;
  frames: SbfFrame[];
  completedAt: Date;
  /**
   * The `UNKNOWN` row's Source column: the pre-scan's byte count for everything it could not turn
   * into a log (`convert-pipeline.ts#unknownByteCount`). `0` prints no row at all.
   */
  unknownBytes?: number;
  /** `N bytes could not be converted.` — records this format cannot represent. `0` prints nothing. */
  unConvertedBytes?: number;
}

const FORMAT_DIRECTORY: Record<string, string> = {
  ASCII: 'ASCII',
  'ABBREV_ASCII': 'ABBREV_ASCII',
  BINARY: 'BINARY',
  KML: 'KML',
  RINEX21: 'RINEXv2_1',
  RINEX301: 'RINEXv3_01',
  RINEX302: 'RINEXv3_02',
  RINEX303: 'RINEXv3_03',
  RINEX304: 'RINEXv3_04',
};

const FORMAT_EXTENSION: Record<string, string> = {
  ASCII: 'ASCII',
  'ABBREV_ASCII': 'ABBREV_ASCII',
  BINARY: 'BINARY',
  KML: 'KML',
  RINEX21: '26O',
  RINEX301: '26O',
  RINEX302: '26O',
  RINEX303: '26O',
  RINEX304: '26O',
};

export function formatDirectory(formatName: string): string {
  return FORMAT_DIRECTORY[formatName] ?? formatName;
}

export function formatExtension(formatName: string): string {
  return FORMAT_EXTENSION[formatName] ?? formatName;
}

function pad(value: string | number, width: number, side: 'start' | 'end'): string {
  const text = String(value);
  return side === 'start' ? text.padStart(width) : text.padEnd(width);
}

/**
 * Whole seconds between the two stamps, computed the way the suite does it: each endpoint is
 * truncated to its second **before** subtracting.
 *
 * Measured on three goldens — b1 `570227.071 → 570255.15` = 28 (round would give 28, ceil 29),
 * b2 `577758.95 → 577792.05` = 34 (round would give 33), b3 `583814.15 → 583859.7` = 45
 * (round would give 46). Only `floor(finish) - floor(start)` fits all three.
 */
function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

function isoSeconds(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/\.(\d{3})Z$/, '.$1Z');
}

export function buildSummary(input: SummaryInput, logNames: Map<number, { name: string; source: number; output: number }>): string {
  const frames = input.frames;
  // The span is the first .. last record that carries an observation time; reference epochs
  // (SATTIME) are skipped when there is anything else to measure from.
  const timed = frames.filter((frame) => frame.header.timeStatus !== REFERENCE_TIME_STATUS);
  const window = timed.length ? timed : frames;
  const first = window[0];
  const last = window[window.length - 1];
  const startMs = first.header.milliseconds / 1000;
  const finishMs = last.header.milliseconds / 1000;
  const startUtc = gpsAsUtc(first.header.week, first.header.milliseconds);
  const finishUtc = gpsAsUtc(last.header.week, last.header.milliseconds);

  const rows = [...logNames.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([id, info]) =>
      [
        `${pad(id, 8, 'start')} `,
        ` ${pad(info.name, 29, 'end')} `,
        `${pad(info.source, 8, 'start')} `,
        `${pad(info.output, 8, 'start')} `,
      ].join('|') + '|',
    );

  // The suite prints the `UNKNOWN` row **last**, whatever its name would sort to (`b3` shows it
  // after `UPTIME`, which sorts before it), and counts it in the sentence above the table
  // (`cli.js:838-852`: the row is appended to `logEntry` before `logEntry.split('\n')` is counted).
  const unknownBytes = input.unknownBytes ?? 0;
  if (unknownBytes > 0) {
    rows.push([`${pad(0, 8, 'start')} `, ` ${pad('UNKNOWN', 29, 'end')} `, `${pad(unknownBytes, 8, 'start')} `, `${pad(0, 8, 'start')} `].join('|') + '|');
  }
  const logCount = logNames.size + (unknownBytes > 0 ? 1 : 0);

  const lines: string[] = [];
  lines.push('');
  lines.push(`The following conversion was completed at ${isoSeconds(input.completedAt)}`);
  lines.push('');
  lines.push('');
  lines.push(`Input File was ${input.fileName}, ${input.bytes} bytes from ${input.inputDirectory}`);
  lines.push('');
  lines.push('');
  lines.push(`Converted files were output to ${input.outputDirectory}`);
  lines.push('');
  lines.push('');
  lines.push('Logs were converted within the following time range from the input file ');
  lines.push('');
  lines.push('    GNSS Time:');
  lines.push(`      Start time : ${first.header.week}, ${startMs}`);
  lines.push(`      Finish time: ${last.header.week}, ${finishMs}`);
  lines.push('');
  lines.push('    UTC Time:');
  lines.push(`      Start time : ${isoSeconds(startUtc)}`);
  lines.push(`      Finish time: ${isoSeconds(finishUtc)}`);
  lines.push('');
  lines.push(`    Total Duration: ${durationText(Math.floor(finishMs) - Math.floor(startMs))}`);
  lines.push('      ');
  lines.push('');
  lines.push(`The following ${logCount} log(s) were converted successfully to ${input.formatName} `);
  lines.push('');
  lines.push('      ID | Name                          | Source #| Output #|');
  lines.push(`${'-'.repeat(9)}+${'-'.repeat(31)}+${'-'.repeat(9)}+${'-'.repeat(9)}+`);
  lines.push(...rows);
  // `cli.js:854`: the sentence goes above the last two newlines, so the tail is
  // `row\n\n\n\n<msg>\n\n` when a message is printed and `row\n\n\n\n\n\n` when it is not.
  const unConverted = input.unConvertedBytes ?? 0;
  if (unConverted > 0) lines.push('', '', '', `${unConverted} bytes could not be converted.`, '');
  else lines.push('', '', '', '', '');
  return `${lines.join('\n')}\n`;
}
