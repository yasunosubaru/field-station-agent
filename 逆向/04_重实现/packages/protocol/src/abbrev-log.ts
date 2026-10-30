/**
 * Abbreviated-ASCII writer, and the binary pass-through Convert actually performs.
 *
 * Abbreviated ASCII (manual §"Abbreviated ASCII", page 37) is the same field list as ASCII with
 * spaces instead of commas and one record per array element:
 *
 *   <RANGE SPECIAL_29 0 72.0 FINESTEERING 2442 463097.350 02808000 5103 14695
 *   <     60 
 *   <          7 0 24393197.164 0.078 -128187146.798946 0.019 2910.335 43.3 1739.905 18109c04 
 *
 * Rules measured against `golden-abbrev/clean-9600` (6294 lines, 6 log types):
 *  - header line: `<NAME port seq idle timeStatus week ms rxStatus msgDefCrc swVersion`, no version
 *    letter after the name (unlike `#RANGEA` in full ASCII) and no trailing space;
 *  - first data line: `<` + five spaces, then every scalar field before the array plus the array
 *    element count (`RXSTATUS` → `00000000 5`);
 *  - one line per array element: `<` + ten spaces, then the element's fields;
 *  - every line ends with a space **except the last line of the record**.
 *
 * Binary output is not a re-encoding: Convert copies the records it accepts and drops the rest, so
 * `clean-9600.gps` → `clean-9600.BINARY` is byte-identical (270 864 B in, 270 864 B out).
 */

import { novatelCrc32 } from './crc.ts';
import { formatField } from './ascii-log.ts';
import type { EdieArray, EdieLayout, EdieScalar, EdieSegment, EdieString, EdieTables } from './edie.ts';
import type { SbfFrame } from './framing.ts';

function readScalar(bytes: Uint8Array, type: string, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = type === 'f64' ? 8 : type === 'u8' ? 1 : type === 'u16' ? 2 : 4;
  if (at < 0 || at + need > view.byteLength) return 0;
  switch (type) {
    case 'u8':
      return view.getUint8(at);
    case 'u16':
      return view.getUint16(at, true);
    case 'u32':
    case 'enum':
    case 'satid':
    case 'bool':
      return view.getUint32(at, true);
    case 'i32':
      return view.getInt32(at, true);
    case 'f32':
      return view.getFloat32(at, true);
    case 'f64':
      return view.getFloat64(at, true);
    default:
      return view.getUint8(at);
  }
}

function readStringValue(bytes: Uint8Array, segment: EdieString, at: number): string {
  if (String(segment.format ?? '').endsWith('Z')) {
    return Array.from({ length: segment.size }, (_, i) => (bytes[at + i] ?? 0).toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < segment.size; i++) {
    const byte = bytes[at + i];
    if (byte === undefined || byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function renderSegments(
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  tables: EdieTables,
  out: string[],
): EdieArray | undefined {
  let array: EdieArray | undefined;
  for (const segment of segments) {
    const at = base + segment.offset;
    if (segment.kind === 'string') {
      const text = readStringValue(bytes, segment, at);
      out.push(String(segment.format ?? '').endsWith('Z') ? text : `"${text}"`);
      continue;
    }
    if (segment.kind === 'scalar') {
      out.push(formatField(segment as EdieScalar, readScalar(bytes, segment.type, at), tables));
      continue;
    }
    array = segment;
    break;
  }
  return array;
}

export interface AbbrevRecord {
  header: string;
  /** Scalars before the array, plus the element count when there is an array. */
  first: string[];
  blocks: string[][];
}

/** Render one frame as the abbreviated-ASCII record (header + data lines, no line endings). */
export function encodeAbbrevRecord(frame: SbfFrame, layout: EdieLayout, tables: EdieTables): AbbrevRecord | undefined {
  if (frame.kind !== 'sbf' || !frame.crcOk) return undefined;
  const { header, payload } = frame;
  const head = [
    `<${layout.name}`,
    portName(header.portAddress),
    String(header.sequence),
    (header.idleTimeRaw / 2).toFixed(1),
    timeStatusName(header.timeStatus),
    String(header.week),
    `${Math.floor(header.milliseconds / 1000)}.${String(header.milliseconds % 1000).padStart(3, '0')}`,
    hexWord(header.receiverStatus, 8),
    hexWord(header.reserved, 4),
    String(header.softwareVersion),
  ].join(' ');

  const first: string[] = [];
  const array = renderSegments(payload, layout.fields, 0, tables, first);
  const blocks: string[][] = [];
  if (array) {
    const stride = array.stride || 1;
    const declared = array.fixedCount !== undefined ? array.fixedCount : readScalar(payload, 'u32', array.offset);
    first.push(String(declared));
    const start = array.offset + array.countSize;
    const capacity = Math.floor(Math.max(0, payload.byteLength - start) / stride);
    const count = Math.max(0, Math.min(declared, capacity));
    for (let i = 0; i < count; i++) {
      const fields: string[] = [];
      renderSegments(payload, array.elements, start + i * stride, tables, fields);
      blocks.push(fields);
    }
  }
  return { header: head, first, blocks };
}

/** The record as the suite writes it: `<` + indents + space-separated values, one trailing space per line but the last. */
export function formatAbbrevRecord(record: AbbrevRecord): string[] {
  const lines: string[] = [];
  const data: string[] = [];
  data.push(`<     ${record.first.join(' ')}`);
  for (const block of record.blocks) data.push(`<          ${block.join(' ')}`);
  // The header line never carries a trailing space; the data lines do, except the record's last one.
  lines.push(record.header);
  data.forEach((line, index) => lines.push(index === data.length - 1 ? line : `${line} `));
  return lines;
}

export function encodeAbbrevLines(frame: SbfFrame, layout: EdieLayout, tables: EdieTables): string[] {
  const record = encodeAbbrevRecord(frame, layout, tables);
  return record ? formatAbbrevRecord(record) : [];
}

function hexWord(value: number, width: number): string {
  return (value >>> 0).toString(16).padStart(width, '0');
}

function portName(address: number): string {
  return address >= 0xa0 ? `SPECIAL_${address - 0xa0}` : String(address);
}

function timeStatusName(value: number): string {
  const names: Record<number, string> = {
    20: 'UNKNOWN',
    60: 'APPROXIMATE',
    80: 'COARSEADJUSTING',
    100: 'COARSE',
    120: 'COARSESTEERING',
    130: 'FREEWHEELING',
    140: 'FINEADJUSTING',
    160: 'FINE',
    170: 'FINEBACKUPSTEERING',
    180: 'FINESTEERING',
    200: 'SATTIME',
  };
  return names[value] ?? String(value);
}

/** Binary output: the records Convert accepts, verbatim (header + payload + CRC). */
export function encodeBinaryCapture(
  frames: Iterable<SbfFrame>,
): { bytes: Uint8Array; accepted: SbfFrame[]; dropped: number } {
  const chunks: Uint8Array[] = [];
  const accepted: SbfFrame[] = [];
  let dropped = 0;
  for (const frame of frames) {
    if (frame.kind !== 'sbf') continue;
    if (!frame.crcOk) {
      dropped += 1;
      continue;
    }
    chunks.push(frame.bytes);
    accepted.push(frame);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, accepted, dropped };
}

export { novatelCrc32 };
