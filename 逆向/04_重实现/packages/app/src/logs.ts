/**
 * Manage's data model: per-message-id statistics plus the decoded field table behind one row.
 *
 * The statistics come from the same mirror-mode de-framing Convert uses, so the counts a user sees
 * here are the counts Convert will write (CRC-good records) next to how many were dropped.
 */

import { decodeEdie, type EdieTables, type EdieValue } from '../../protocol/src/edie.ts';
import { encodeAsciiLog, portName, TIME_STATUS_NAMES } from '../../protocol/src/ascii-log.ts';
import type { SbfFrame } from '../../protocol/src/framing.ts';
import { gpsAsUtc, type CaptureData } from './capture.ts';

const SAMPLE_LIMIT = 280;
const FIELD_LIMIT = 800;

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

export interface DecodedRecord {
  index: number;
  header: RecordHeader;
  fields: Array<{ name: string; path: string; value: number | string; text?: string; isCount?: boolean }>;
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
    const fields = values.slice(0, FIELD_LIMIT).map(toField);
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
      fields,
      fieldTotal: values.length,
      fieldsTruncated: values.length > FIELD_LIMIT,
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
