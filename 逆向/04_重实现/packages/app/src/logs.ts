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
