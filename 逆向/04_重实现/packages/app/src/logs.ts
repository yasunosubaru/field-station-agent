/**
 * Manage's data model: per-message-id statistics plus the decoded field table behind one row.
 *
 * The statistics come from the same mirror-mode de-framing Convert uses, so the counts a user sees
 * here are the counts Convert will write (CRC-good records) next to how many were dropped.
 *
 * One record's projection splits in two, because a 1024-sample spectrum log would otherwise be 1028
 * flat rows: `fields` keeps the scalar row table (capped at `FIELD_LIMIT`), and a long single-leaf
 * numeric vector — ITPSDFINAL/ITPSDDETECT `samples[i].samples` is the one the UI reads — travels in
 * `arrays` as plain numbers. `fieldTotal`/`fieldsTruncated` still describe the whole record, so no
 * reader can mistake a split table for a short payload.
 */

import { decodeEdie, type EdieTables, type EdieValue } from '../../protocol/src/edie.ts';
import { encodeAsciiLog, portName, TIME_STATUS_NAMES } from '../../protocol/src/ascii-log.ts';
import { textRecordFields } from '../../protocol/src/text-log.ts';
import type { SbfFrame } from '../../protocol/src/framing.ts';
import { gpsAsUtc, type CaptureData } from './capture.ts';

const SAMPLE_LIMIT = 280;
/** Rows the field table of one record may carry. Nothing is lost: see `projectFields`. */
const FIELD_LIMIT = 800;
/**
 * A repeated array is lifted out of the field table when it has more elements than this.
 *
 * Below the threshold the rows stay inline, because that is what the readers walk:
 * RANGE's 65 `obs[i].*` entries (7 leaves each) and HWMONITOR's `measurements[i].*` are multi-leaf
 * and never qualify. A *single-leaf* numeric vector does: `ITPSDFINAL.samples[0..1023].samples`
 * is 1024 field objects, `{"name":"samples","path":"samples[7].samples","value":22587}` ≈ 55 B
 * each (56 KB for one record), against 1024 plain numbers ≈ 6 KB. The values are identical; only
 * the per-element `name`/`path` boilerplate goes away.
 */
const ARRAY_INLINE_LIMIT = 16;
/** Hard cap on the numbers one `arrays` entry may carry (one ITPSD log is 1024; 64K FFT is 65536). */
const ARRAY_VALUE_LIMIT = 65536;

/** `samples[7].samples` → prefix `samples`, index 7, leaf `samples`. */
const ELEMENT_PATH = /^(.*)\[(\d+)\]\.([^.[\]]+)$/;

export interface LogGroup {
  id: number;
  name: string;
  known: boolean;
  /** Records present in the capture for this id. */
  count: number;
  crcFailed: number;
  firstWeek: number;
  firstMilliseconds: number;
  firstUtc: string;
  lastWeek: number;
  lastMilliseconds: number;
  lastUtc: string;
  /** One ASCII line (or header summary when no layout exists), clipped. */
  sample: string;
}

export interface LogsSummary {
  capture: string;
  bytes: number;
  totalRecords: number;
  accepted: number;
  dropped: number;
  textRecords: number;
  types: number;
  span: { week: number; milliseconds: number; utc: string } | null;
  groups: LogGroup[];
  /**
   * The capture's **text** records, grouped by dictionary name.
   *
   * Some records only ever arrive as ASCII on this receiver — `ITDETECTSTATUS` is configured as
   * `ITDETECTSTATUSA`, so b7 holds 48 `#ITDETECTSTATUSA` lines and no binary #2065 payload. Without
   * this list the Signal Matrix and the Events page cannot see the interference data at all.
   */
  textGroups: TextGroup[];
}

export interface TextGroup {
  name: string;
  count: number;
  firstWeek: number;
  firstMilliseconds: number;
  firstUtc: string;
  lastWeek: number;
  lastMilliseconds: number;
  lastUtc: string;
  sample: string;
}

function clip(text: string, limit: number): string {
  const single = text.replace(/[\r\n]+/g, ' ');
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

function headerSummary(frame: SbfFrame): string {
  const header = frame.header;
  const parts = [
    `${frame.header.messageId}`,
    `port ${portName((header as { portAddress?: number }).portAddress ?? 0)}`,
    `seq ${(header as { sequence?: number }).sequence ?? 0}`,
    `W${header.week}`,
    `${(header.milliseconds / 1000).toFixed(3)}`,
  ];
  return parts.join(', ');
}

/** Every `#NAME,…` record of a capture, decoded back into dictionary field paths. */
interface TextRecordLine {
  name: string;
  line: string;
  /** OEM7 header sequence word — the chunk index of a multi-log sweep (`0` = last chunk). */
  sequence: number;
  week: number;
  milliseconds: number;
  fields: Array<{ path: string; token: string; value: number | string }>;
}

/**
 * The nine tokens `textRecordFields` hands back as `head`, in the order a `#NAME` line writes them:
 *
 *   `port, sequence, idleTime, timeStatus, week, milliseconds, receiverStatus, msgDefCrc, version`
 *
 * `head[5]` is the time of week in **seconds** (`35956.000`), printed by the `%T` spec; the binary
 * frame's `milliseconds` is the same instant ×1000.
 */
const HEAD_SEQUENCE = 1;
const HEAD_WEEK = 4;
const HEAD_SECONDS = 5;

function textRecordLines(data: CaptureData, tables: EdieTables): TextRecordLine[] {
  const out: TextRecordLine[] = [];
  for (const frame of data.allFrames) {
    if (frame.kind !== 'text') continue;
    // `TextFrame.text` already starts with the record's prefix character (`#`/`<`/`$`), so
    // concatenating `prefix` again would make `##RXCONFIGA` — measured on b7.
    const line = String(frame.text).replace(/[\r\n]+$/, '');
    if (!line.startsWith('#')) continue;
    const parsed = textRecordFields(line, tables);
    if (!parsed) continue;
    /* `head` is the nine header tokens **by name**, not by byte: week is the fifth token and the
       time of week (seconds) the sixth. Reading `head[5]`/`head[6]` here used to take the seconds
       as the week and the receiver-status word as the seconds, which put every b7 text record in
       year 2669 (`week 35956, ms 3 808 800 000`) — see `HEAD_*` above. */
    const week = Number(parsed.head[HEAD_WEEK] ?? 0);
    const seconds = Number(parsed.head[HEAD_SECONDS] ?? 0);
    const sequence = Number(parsed.head[HEAD_SEQUENCE] ?? 0);
    out.push({
      name: parsed.name,
      line,
      sequence: Number.isFinite(sequence) ? sequence : 0,
      week: Number.isFinite(week) ? week : 0,
      milliseconds: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
      fields: parsed.fields,
    });
  }
  return out;
}

export function summarizeLogs(data: CaptureData, tables: EdieTables): LogsSummary {
  const groups = new Map<number, SbfFrame[]>();
  for (const frame of data.frames) {
    const id = frame.header.messageId;
    const list = groups.get(id);
    if (list) list.push(frame);
    else groups.set(id, [frame]);
  }

  const rows: LogGroup[] = [];
  for (const [id, frames] of groups) {
    const layout = tables.messages[String(id)];
    const good = frames.filter((frame) => frame.crcOk);
    const first = good[0] ?? frames[0];
    const last = good[good.length - 1] ?? frames[frames.length - 1];
    const sample = good.length && layout
      ? clip(encodeAsciiLog(good[0], layout, tables), SAMPLE_LIMIT)
      : clip(headerSummary(first), SAMPLE_LIMIT);
    rows.push({
      id,
      name: layout?.name ?? `未知消息 ${id}`,
      known: Boolean(layout),
      count: frames.length,
      crcFailed: frames.length - good.length,
      firstWeek: first.header.week,
      firstMilliseconds: first.header.milliseconds,
      firstUtc: gpsAsUtc(first.header.week, first.header.milliseconds),
      lastWeek: last.header.week,
      lastMilliseconds: last.header.milliseconds,
      lastUtc: gpsAsUtc(last.header.week, last.header.milliseconds),
      sample,
    });
  }

  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Text records by name — the only way a `#ITDETECTSTATUSA`-style record is visible to the app.
  const textGroups: TextGroup[] = [];
  const textByName = new Map<string, TextRecordLine[]>();
  for (const record of textRecordLines(data, tables)) {
    const list = textByName.get(record.name);
    if (list) list.push(record);
    else textByName.set(record.name, [record]);
  }
  for (const [name, list] of textByName) {
    const first = list[0];
    const last = list[list.length - 1];
    textGroups.push({
      name,
      count: list.length,
      firstWeek: first.week,
      firstMilliseconds: first.milliseconds,
      firstUtc: gpsAsUtc(first.week, first.milliseconds),
      lastWeek: last.week,
      lastMilliseconds: last.milliseconds,
      lastUtc: gpsAsUtc(last.week, last.milliseconds),
      sample: clip(first.line, SAMPLE_LIMIT),
    });
  }
  textGroups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const all = data.frames;
  const first = all[0];
  const last = all[all.length - 1];
  return {
    capture: data.relPath,
    bytes: data.bytes,
    totalRecords: data.totalRecords,
    accepted: data.accepted,
    dropped: data.dropped,
    textRecords: data.textRecords,
    types: rows.length,
    span: first && last
      ? { week: first.header.week, milliseconds: first.header.milliseconds, utc: gpsAsUtc(first.header.week, first.header.milliseconds) }
      : null,
    groups: rows,
    textGroups,
  };
}

export interface RecordHeader {
  messageId: number;
  name: string;
  sequence: number;
  portAddress: number;
  portName: string;
  week: number;
  milliseconds: number;
  utc: string;
  timeStatus: string;
  receiverStatus: string;
  payloadLength: number;
  frameBytes: number;
  crcOk: boolean;
}

export interface DecodedArray {
  /** Array prefix as the layout spells it: `samples` covers `samples[0].samples` … `samples[n-1].samples`. */
  path: string;
  /** The one leaf field inside each element. */
  field: string;
  /** Elements carried in `values`. */
  count: number;
  /** Elements the payload declared beyond `ARRAY_VALUE_LIMIT` — 0 for every ITPSD in a capture. */
  omitted: number;
  /** Element values in wire order, exactly as decoded (no dBm conversion here). */
  values: Array<number | string>;
}

export interface DecodedRecord {
  index: number;
  header: RecordHeader;
  fields: Array<{ name: string; path: string; value: number | string; text?: string; isCount?: boolean }>;
  /** Repeated arrays lifted out of `fields` (payload order); empty for a scalar-only log. */
  arrays: DecodedArray[];
  fieldTotal: number;
  fieldsTruncated: boolean;
}

export interface RecordsResult {
  capture: string;
  messageId: number;
  name: string;
  total: number;
  offset: number;
  limit: number;
  layoutKnown: boolean;
  records: DecodedRecord[];
}

function toField(value: EdieValue) {
  return {
    name: value.name,
    path: value.path,
    value: typeof value.value === 'number' && !Number.isFinite(value.value) ? String(value.value) : value.value,
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.isCount ? { isCount: true } : {}),
  };
}

export interface FieldProjection {
  fields: ReturnType<typeof toField>[];
  arrays: DecodedArray[];
  total: number;
  truncated: boolean;
}

/**
 * Split one record's decoded values into the row table and the long numeric vectors.
 *
 * A vector is lifted only when every element of the same prefix carries *one* leaf and every value
 * is a number — i.e. a plain array of numbers, which is what a spectrum log is. Structures such as
 * `obs[i].sv_prn/c_status/C_No` (RANGE) or `measurements[i].status/value` (HWMONITOR) have several
 * leaves per element and stay in `fields`, because their readers address `obs[3].c_status` by path.
 *
 * `truncated` is true whenever the table does not hold every decoded value (lifted or clipped by
 * `FIELD_LIMIT`), so `fieldTotal` vs `fields.length` always explains the difference.
 */
export function projectFields(values: EdieValue[]): FieldProjection {
  const groups = new Map<string, { leaves: Set<string>; numeric: boolean; entries: Array<{ index: number; value: EdieValue }> }>();
  for (const value of values) {
    const match = ELEMENT_PATH.exec(value.path);
    if (!match) continue;
    const [, prefix, index, leaf] = match;
    let group = groups.get(prefix);
    if (!group) {
      group = { leaves: new Set(), numeric: true, entries: [] };
      groups.set(prefix, group);
    }
    group.leaves.add(leaf);
    if (typeof value.value !== 'number') group.numeric = false;
    group.entries.push({ index: Number(index), value });
  }

  const arrays: DecodedArray[] = [];
  const lifted = new Set<EdieValue>();
  for (const [prefix, group] of groups) {
    if (group.leaves.size !== 1 || !group.numeric || group.entries.length <= ARRAY_INLINE_LIMIT) continue;
    const ordered = group.entries.slice().sort((a, b) => a.index - b.index);
    const kept = ordered.slice(0, ARRAY_VALUE_LIMIT);
    for (const entry of kept) lifted.add(entry.value);
    arrays.push({
      path: prefix,
      field: [...group.leaves][0],
      count: kept.length,
      omitted: ordered.length - kept.length,
      values: kept.map((entry) => entry.value.value),
    });
  }

  const fields = values.filter((value) => !lifted.has(value)).slice(0, FIELD_LIMIT).map(toField);
  return { fields, arrays, total: values.length, truncated: fields.length < values.length };
}

export function readRecords(
  data: CaptureData,
  tables: EdieTables,
  messageId: number,
  offset: number,
  limit: number,
): RecordsResult {
  const layout = tables.messages[String(messageId)];
  const frames = data.frames.filter((frame) => frame.header.messageId === messageId);
  const start = Math.max(0, Math.min(offset, frames.length));
  const window = frames.slice(start, start + limit);

  const records: DecodedRecord[] = window.map((frame, index) => {
    const header = frame.header as SbfFrame['header'] & { sequence?: number; portAddress?: number; receiverStatus?: number; timeStatus?: number };
    const values = layout ? decodeEdie(frame.payload, layout, tables) : [];
    const projected = projectFields(values);
    return {
      index: start + index,
      header: {
        messageId: frame.header.messageId,
        name: layout?.name ?? `未知消息 ${messageId}`,
        sequence: header.sequence ?? 0,
        portAddress: header.portAddress ?? 0,
        portName: portName(header.portAddress ?? 0),
        week: frame.header.week,
        milliseconds: frame.header.milliseconds,
        utc: gpsAsUtc(frame.header.week, frame.header.milliseconds),
        timeStatus: TIME_STATUS_NAMES[header.timeStatus ?? 0] ?? String(header.timeStatus ?? ''),
        receiverStatus: (header.receiverStatus ?? 0).toString(16).padStart(8, '0'),
        payloadLength: frame.payload.byteLength,
        frameBytes: frame.bytes.byteLength,
        crcOk: frame.crcOk,
      },
      fields: projected.fields,
      arrays: projected.arrays,
      fieldTotal: projected.total,
      fieldsTruncated: projected.truncated,
    };
  });

  return {
    capture: data.relPath,
    messageId,
    name: layout?.name ?? `未知消息 ${messageId}`,
    total: frames.length,
    offset: start,
    limit,
    layoutKnown: Boolean(layout),
    records,
  };
}

/**
 * The capture's **text** records of one name, shaped like `readRecords` so the panels can read
 * either kind through the same code path.
 *
 * `ITDETECTSTATUS` is the reason: on this receiver it is logged as `ITDETECTSTATUSA`, so a capture
 * has 48 `#ITDETECTSTATUSA` lines and zero binary #2065 payloads. `messageId` is -1 and the header's
 * message id is 0 — a text record genuinely has neither; the name is the identity.
 *
 * `sequence` is the head's own token, not zero: `ITPSDDETECT` splits one sweep over two logs
 * (`sequence 1` = 1024 samples, `sequence 0` = the remaining 341), and the GRIT spectrum viewer
 * groups text chunks by exactly that word (`grit.js` `ingestSpectrum`).
 */
export function readTextRecords(
  data: CaptureData,
  tables: EdieTables,
  name: string,
  offset: number,
  limit: number,
): RecordsResult {
  const wanted = name.toUpperCase();
  const lines = textRecordLines(data, tables).filter((record) => record.name.toUpperCase() === wanted);
  const start = Math.max(0, Math.min(offset, lines.length));
  const window = lines.slice(start, start + limit);
  const records: DecodedRecord[] = window.map((record, index) => ({
    index: start + index,
    header: {
      messageId: 0,
      name: record.name,
      sequence: record.sequence,
      portAddress: 0,
      portName: '',
      week: record.week,
      milliseconds: record.milliseconds,
      utc: gpsAsUtc(record.week, record.milliseconds),
      timeStatus: '',
      receiverStatus: '',
      payloadLength: record.line.length,
      frameBytes: record.line.length,
      crcOk: true,
    },
    fields: record.fields.map((field) => {
      // A text record carries the **printed** token, so an enum arrives as its name (`L2`,
      // `SPECTRUMANALYSIS`) rather than a number. Numeric tokens stay numeric; everything else is
      // handed over as the token itself, which is what the panels display.
      const numeric = Number(field.token);
      const value = field.token !== '' && Number.isFinite(numeric) && /^[-+0-9.]/.test(field.token)
        ? numeric
        : field.token;
      return {
        name: field.path.split(/[.[\]]/).pop() ?? field.path,
        path: field.path,
        value,
        ...(typeof value === 'string' ? { text: value } : {}),
      };
    }),
    arrays: [],
    fieldTotal: record.fields.length,
    fieldsTruncated: false,
  }));

  return {
    capture: data.relPath,
    messageId: -1,
    name: wanted,
    total: lines.length,
    offset: start,
    limit,
    layoutKnown: records.length > 0,
    records,
  };
}
