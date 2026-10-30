/**
 * `Summary_<input>.txt` — the report Convert writes next to its output directory.
 *
 * Reproduced from `golden-binary/clean-9600/…/Summary_clean-9600.txt` (LF only, 62-column table,
 * cells `padStart(8)+' '` / `' '+padEnd(29)+' '`, separator built from `-` and `+`). Only the
 * "completed at" timestamp is inherently different between runs.
 */

import type { SbfFrame } from './framing.ts';

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
}

const FORMAT_DIRECTORY: Record<string, string> = {
  ASCII: 'ASCII',
  'ABBREV_ASCII': 'ABBREV_ASCII',
  BINARY: 'BINARY',
  KML: 'KML',
};

const FORMAT_EXTENSION: Record<string, string> = {
  ASCII: 'ASCII',
  'ABBREV_ASCII': 'ABBREV_ASCII',
  BINARY: 'BINARY',
  KML: 'KML',
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
  const first = frames[0];
  const last = frames[frames.length - 1];
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
  lines.push(`    Total Duration: ${durationText(finishMs - startMs)}`);
  lines.push('      ');
  lines.push('');
  lines.push(`The following ${logNames.size} log(s) were converted successfully to ${input.formatName} `);
  lines.push('');
  lines.push('      ID | Name                          | Source #| Output #|');
  lines.push(`${'-'.repeat(9)}+${'-'.repeat(31)}+${'-'.repeat(9)}+${'-'.repeat(9)}+`);
  lines.push(...rows);
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
