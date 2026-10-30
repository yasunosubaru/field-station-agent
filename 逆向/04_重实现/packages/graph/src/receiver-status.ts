/**
 * `Receiver Status.csv` — the one CSV chart that is not a timestamp series.
 *
 * Golden format (`00_来源/samples/graph/export/csv/Receiver Status.csv`):
 *
 * ```
 * name,start,end,value\r\n
 * Antenna 1 Gain Anomaly,1477384700900.000000,1477384700900.000000,1\r\n
 * …
 * ```
 *
 *  - **No** `timestamp (GPS week sec)` column and **no** leading time column: four columns only.
 *  - `start` / `end` are Graph's millisecond scale, six decimals, **trailing zeros kept**.
 *  - `value` is a plain integer `1` — a row exists only while the condition holds, so it is always 1.
 *  - Rows are sorted by `name` (byte order); the golden order is pure alphabetical, not table order
 *    and not first-appearance order.
 *  - A span starts at the first RXSTATUS record where the condition becomes true and ends at the
 *    **last record where it was still true** (not at `DataInfo.EndTime`): every golden span ends at
 *    `1477384700900`, which is the last RXSTATUS in the window. A condition that only appears on the
 *    final record therefore yields a zero-length span (`Antenna 1 Gain Anomaly`).
 *
 * Every (word, bit) ↔ name pair below was pinned against the golden, which triggers exactly five
 * names; see `03_分析/06_Graph应用.md §11.6`. Word indices are the `status_words[i]` order of the
 * RXSTATUS payload (`status_words[0]` = receiver status, `[1]` = AUX1 … `[4]` = AUX4), which the
 * manual's Tables 225 / 227 / 229 / 230 describe.
 */

import type { Capture, CaptureRecord } from './capture.ts';
import { field } from './capture.ts';
import type { GraphProject } from './project.ts';

/** One row-producing condition: a single bit, or a 2-bit state field compared to a value. */
interface StatusSeries {
  name: string;
  /** `0..4` → `status_words[i]`; `'error'` → the `rx_error` field. */
  word: 0 | 1 | 2 | 3 | 4 | 'error';
  /** Bit index inside that word (`0..31`). */
  bit?: number;
  /** `[shift, width]` + `equals`: a multi-bit field, e.g. antenna gain state = AUX3 bits 4-5. */
  fieldBits?: [number, number];
  equals?: number;
}

/**
 * The conditions Graph can name. Seven of the 22 strings in `graph-node-wrapper.node`
 * (`INS Not Converged`, `No INS Alignment`, `Poor ALIGN COM Link`, `Poor RTK COM Link`, the two
 * `Usable RTK Corrections Status` bits) are **not** here: their bits are not identifiable from the
 * sample (all candidate words are zero where they would appear), so they are left out rather than
 * guessed — they cannot fire on this capture either way.
 */
export const RECEIVER_STATUS_SERIES: StatusSeries[] = [
  // Receiver status word (Table 225).
  { name: 'Error Flag', word: 0, bit: 0 },
  { name: 'Primary Antenna Not Powered', word: 0, bit: 3 },
  { name: 'Link Overrun', word: 0, bit: 11 },
  // Bit 14 is documented as "antenna gain state out of range", but the golden forces this mapping:
  // the only unexplained set bit between 463100.896 and 463100.900 is word0 bit 14, and the only
  // span that starts there is `Antenna 1 Gain High`. (`Antenna 1 Gain Low` / `Anomaly` come from the
  // AUX3 gain-state field below, which is what bit 14 summarizes.)
  { name: 'Antenna 1 Gain High', word: 0, bit: 14 },
  { name: 'Jamming Detected', word: 0, bit: 15 },
  { name: 'GPS Almanac Invalid', word: 0, bit: 18 },
  { name: 'Position Solution Invalid', word: 0, bit: 19 },
  { name: 'Clock Model Invalid', word: 0, bit: 22 },

  // AUX1 status (Table 227).
  { name: 'USB Not Connected', word: 1, bit: 7 },
  { name: 'Ethernet Not Connected', word: 1, bit: 18 },

  // AUX3 status (Table 230): bit 31 "RF calibration data is present", bits 4-5 "antenna 1 gain
  // state" per Table 231 (01 = Low, 10 = High, 11 = Anomaly).
  { name: 'RF Calibration Data Present', word: 3, bit: 31 },
  { name: 'Antenna 1 Gain Low', word: 3, fieldBits: [4, 2], equals: 1 },
  { name: 'Antenna 1 Gain Anomaly', word: 3, fieldBits: [4, 2], equals: 3 },

  // AUX4 status (Table 233): bits 0/1 of "GNSS tracked status".
  { name: 'GNSS Tracking Status (Bit 0)', word: 4, bit: 0 },
  { name: 'GNSS Tracking Status (Bit 1)', word: 4, bit: 1 },

  // Receiver error word (Table 224).
  { name: 'Export Restriction Error', word: 'error', bit: 21 },
];

function wordOf(record: CaptureRecord, index: number): number {
  return field(record, `status_words[${index}].status_word`);
}

function isSet(record: CaptureRecord, series: StatusSeries): boolean {
  const word = series.word === 'error' ? field(record, 'rx_error') : wordOf(record, series.word);
  if (series.fieldBits) {
    const [shift, width] = series.fieldBits;
    return ((word >>> shift) & ((1 << width) - 1)) === series.equals;
  }
  return ((word >>> series.bit!) & 1) === 1;
}

interface Span {
  name: string;
  start: number;
  end: number;
}

/** Spans of `true` over the RXSTATUS records in the project window, in a stable lexical order. */
export function receiverStatusSpans(project: GraphProject, capture: Capture): Span[] {
  const { StartTime, EndTime } = project.dataInfo;
  const records = capture
    .byName('RXSTATUS')
    .filter((record) => record.gpsMs >= StartTime && record.gpsMs < EndTime)
    .sort((a, b) => a.gpsMs - b.gpsMs);

  const spans: Span[] = [];
  for (const series of RECEIVER_STATUS_SERIES) {
    let start: number | null = null;
    let lastSet = 0;
    for (const record of records) {
      if (isSet(record, series)) {
        if (start === null) start = record.gpsMs;
        lastSet = record.gpsMs;
      } else if (start !== null) {
        spans.push({ name: series.name, start, end: lastSet });
        start = null;
      }
    }
    if (start !== null) spans.push({ name: series.name, start, end: lastSet });
  }
  // Golden is sorted by name, not by start time or by table order.
  return spans.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The header + body of `Receiver Status.csv` (the six comment lines are added by `csv.ts`). */
export function renderReceiverStatus(project: GraphProject, capture: Capture): string {
  const rows = receiverStatusSpans(project, capture).map(
    (span) => `${span.name},${span.start.toFixed(6)},${span.end.toFixed(6)},1`,
  );
  return ['name,start,end,value', ...rows].map((line) => line + '\r\n').join('');
}
