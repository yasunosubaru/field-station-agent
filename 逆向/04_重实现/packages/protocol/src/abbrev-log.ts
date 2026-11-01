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
 * Line shape, measured against `golden-abbrev/clean-9600` (6294 lines, 6 log types) and against the
 * suite's own output for `b1` / `remote-23types` / `live-nav2` (`--abbrev` on the same captures):
 *
 *  - header line: `<NAME port seq idle timeStatus week ms rxStatus msgDefCrc swVersion`, no version
 *    letter after the name (unlike `#RANGEA` in full ASCII) and no trailing space;
 *  - first data line: `<` + **four** spaces, then one space **only when a value follows**, so a line
 *    with no values at all is `<    `;
 *  - one element line per array element of a `FIELD_ARRAY`: `<` + **nine** spaces, the separator
 *    space, the values — an element line with no values is `<         ` (nine spaces), which is what
 *    a zero-element array leaves behind (`SATVIS2 … SBAS TRUE FALSE 0` in `b1`);
 *  - a `FIXED_LENGTH_ARRAY` prints no count and no line break (`CLOCKMODEL`'s `par`/`data` stay on
 *    the data line), and so does a `VARIABLE_LENGTH_ARRAY` **with** its count in front
 *    (`ITPSDFINAL`'s 1024 samples are one very long data line, not 1024 lines);
 *  - every body line ends with a space **except the last line of the record**; the header line never
 *    carries one.
 *
 * `%R` is not a value at all: an embedded binary record (`RXCONFIG`) is printed as its own
 * abbreviated record whose **header becomes a value on the data line** and whose body lines follow:
 *
 *   <RXCONFIG SPECIAL 283 68.5 SATTIME 0 0.000 03801800 f702 18278
 *   <     ELEVATIONCUTOFF SPECIAL 283 68.5 SATTIME 0 0.000 03801800 50e0 18278 
 *   <     GLONASS 5.0 0
 *
 * (and an embedded record with an array keeps its element lines: `<     SETTIMESOURCE …` then
 * `<     3 ` then `<          GPS `, measured on `b1`). A record whose embedded message the
 * dictionary cannot resolve is dropped whole, exactly as in ASCII output — both captures keep 256 of
 * their RXCONFIG records and both outputs agree on which 256.
 *
 * Binary output is not a re-encoding: Convert copies the records it accepts and drops the rest, so
 * `clean-9600.gps` → `clean-9600.BINARY` is byte-identical (270 864 B in, 270 864 B out).
 */

import { novatelCrc32 } from './crc.ts';
import { escapePassThrough, formatField, portName, wireFields } from './ascii-log.ts';
import {
  denseSegmentSize,
  readCountAt,
  segmentWireSize,
  walkArray,
  type EdieArray,
  type EdieLayout,
  type EdieScalar,
  type EdieSegment,
  type EdieString,
  type EdieTables,
} from './edie.ts';
import { SbfDeframer, type SbfFrame } from './framing.ts';

/** Indent of the record's first data line. */
const DATA_INDENT = 4;
/** Indent of one array-element line. */
const ELEMENT_INDENT = 9;

function readScalar(bytes: Uint8Array, type: string, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The dictionary spells integers eight ways (a generated C struct), not four: the width decides
  // the read, not the spelling. Reading a `ULONG`/`USHORT` as one byte still lands on the right
  // offset (offsets are absolute) but prints the low byte only — `GLOCLOCK`'s `toe` came out `192`
  // instead of `81600`. Same table as `edie.ts#readScalar`.
  const need = LONG_TYPES.has(type) ? 8 : type === 'f64' ? 8 : type === 'u8' || type === 'char' || type === 'hexbyte' ? 1 : type === 'u16' || type === 'ushort' || type === 'short' ? 2 : 4;
  if (at < 0 || at + need > view.byteLength) return 0;
  switch (type) {
    case 'u8':
    case 'char':
    case 'hexbyte':
      return view.getUint8(at);
    case 'u16':
    case 'ushort':
      return view.getUint16(at, true);
    case 'short':
      return view.getInt16(at, true);
    case 'u32':
    case 'enum':
    case 'satid':
    case 'bool':
    case 'uint':
    case 'ulong':
      return view.getUint32(at, true);
    case 'i32':
    case 'int':
    case 'long':
      return view.getInt32(at, true);
    case 'longlong':
      return Number(view.getBigInt64(at, true));
    case 'ulonglong':
      return Number(view.getBigUint64(at, true));
    case 'f32':
      return view.getFloat32(at, true);
    case 'f64':
      return view.getFloat64(at, true);
    default:
      return view.getUint8(at);
  }
}

const LONG_TYPES = new Set(['longlong', 'ulonglong']);

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

/** One printed line, before the indents and the trailing-space rule are applied. */
export interface AbbrevLine {
  /** Spaces after the `<`: four for the data line, nine for an array-element line. */
  indent: number;
  values: string[];
}

export interface AbbrevRecord {
  /** Header text without the leading `<`. */
  header: string;
  /** At least the data line; array-element lines and embedded records follow in print order. */
  lines: AbbrevLine[];
}

/** The record being built: one data line, then whatever the fields push behind it. */
class Body {
  readonly lines: AbbrevLine[] = [{ indent: DATA_INDENT, values: [] }];

  get current(): AbbrevLine {
    return this.lines[this.lines.length - 1] as AbbrevLine;
  }

  /** Number of printed values, used to tell whether an embedded record resolved. */
  get size(): number {
    return this.lines.reduce((total, line) => total + line.values.length, 0);
  }

  value(text: string): void {
    this.current.values.push(text);
  }

  newLine(indent: number = ELEMENT_INDENT): void {
    this.lines.push({ indent, values: [] });
  }
}

/** Render one frame as the abbreviated-ASCII record (header + body lines, no line endings). */
export function encodeAbbrevRecord(
  frame: SbfFrame,
  layout: EdieLayout,
  tables: EdieTables,
  depth = 0,
): AbbrevRecord | undefined {
  // An embedded `%R` record keeps the CRC field its sender wrote, which does not have to match (all
  // four RXCONFIG frames of `remote-23types` fail the check and the suite still prints them), so the
  // check only applies to the record the caller handed us.
  if (frame.kind !== 'sbf') return undefined;
  if (depth === 0 && !frame.crcOk) return undefined;
  const { header, payload } = frame;
  const head = [
    layout.name,
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

  const body = new Body();
  const state: RenderState = { unresolvedEmbedded: false };
  // The same `pack(4)` correction the ASCII writer applies: a record whose payload is exactly the
  // aligned size of a dense layout is read with aligned offsets (GLOCLOCK, RAWGPSSUBFRAME).
  renderSegments(payload, wireFields(layout, payload.length), 0, tables, body, depth, state);
  if (state.unresolvedEmbedded) return undefined;
  return { header: head, lines: body.lines };
}

/**
 * The record as the suite writes it: `<` + indents + space-separated values, one trailing space per
 * body line but the last.
 */
export function formatAbbrevRecord(record: AbbrevRecord): string[] {
  const lines = [`<${record.header}`];
  record.lines.forEach((line, index) => {
    const text = `<${' '.repeat(line.indent)}${line.values.length ? ` ${line.values.join(' ')}` : ''}`;
    lines.push(index === record.lines.length - 1 ? text : `${text} `);
  });
  return lines;
}

export function encodeAbbrevLines(frame: SbfFrame, layout: EdieLayout, tables: EdieTables): string[] {
  const record = encodeAbbrevRecord(frame, layout, tables);
  return record ? formatAbbrevRecord(record) : [];
}

/** Per-record bookkeeping: an `%R` message the dictionary does not have drops the record. */
interface RenderState {
  unresolvedEmbedded: boolean;
}

function renderSegments(
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  tables: EdieTables,
  body: Body,
  depth: number,
  state: RenderState,
): void {
  // Same placement rule as the ASCII writer: a segment the table cannot place (`dynamicOffset`,
  // i.e. anything behind a counted array) starts where the previous one ended; the rest start at
  // their stored offset plus the drift a variable-width segment introduced.
  let shift = 0;
  let cursor = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as EdieSegment;
    const at = base + (segment.dynamicOffset ? cursor : segment.offset + shift);
    if (segment.kind === 'string') {
      const text = readStringValue(bytes, segment, at);
      body.value(String(segment.format ?? '').endsWith('Z') ? text : `"${text}"`);
      const size = segmentWireSize(bytes, segment, at);
      cursor = at + size - base;
      if (segment.variable) shift += size - segment.size;
      continue;
    }
    if (segment.kind === 'scalar') {
      body.value(formatField(segment as EdieScalar, readScalar(bytes, segment.type, at), tables));
      cursor = at + segment.size - base;
      continue;
    }

    const array = segment as EdieArray;
    const format = String(array.format ?? '');

    // `%R` — one embedded SBF record, printed as its own abbreviated record: its header becomes a
    // value on this line and its body lines are appended behind it (see the file comment).
    if (format === '%R') {
      const before = body.size;
      if (depth < 4) {
        for (const inner of new SbfDeframer({ crcMode: 'mirror' }).push(bytes.subarray(at + array.countSize))) {
          if (inner.kind !== 'sbf') continue;
          const layout = tables.messages[String(inner.header.messageId)];
          if (!layout) continue;
          const nested = encodeAbbrevRecord(inner, layout, tables, depth + 1);
          if (!nested) continue;
          body.value(nested.header);
          for (const line of nested.lines) body.lines.push(line);
        }
      }
      // Like ASCII, an embedded record we cannot resolve drops the whole record (the suite prints
      // nothing at all for it, not a record with an empty body).
      if (body.size === before) state.unresolvedEmbedded = true;
      cursor = bytes.byteLength - base;
      continue;
    }

    // `%P` — a pass-through payload, one escaped token behind its element count, exactly as in
    // ASCII. Not measured for ABBREV (no PASS* log reaches any of the captures we have); kept on
    // one line so it at least cannot break the record's shape.
    if (format === '%P') {
      if (at + array.countSize <= bytes.byteLength) {
        const count = array.countSize ? readCountAt(bytes, at, array.countSize) : 0;
        body.value(String(count));
        const start = at + array.countSize;
        const available = Math.max(0, bytes.byteLength - start);
        body.value(escapePassThrough(bytes, start, Math.min(Math.max(0, count), available)));
      }
      cursor = bytes.byteLength - base;
      continue;
    }

    const walk = walkArray(bytes, array, at);
    if (array.countSize) {
      // A count prefix outside the payload prints nothing at all (see `ascii-log.ts`).
      if (!walk.inPayload) {
        cursor = at + walk.size - base;
        shift += walk.size - denseSegmentSize(segment);
        continue;
      }
      body.value(String(walk.declared));
    }
    // `FIELD_ARRAY` breaks after its count, one line per element, and a zero-element array still
    // leaves one (empty) line behind. `FIXED_LENGTH_ARRAY` and `VARIABLE_LENGTH_ARRAY` keep every
    // element on the line they started on.
    const kind = array.arrayKind ?? (array.countSize ? 'field' : 'fixed');
    if (kind === 'field') {
      for (let i = 0; i < Math.max(1, walk.count); i++) {
        body.newLine(ELEMENT_INDENT);
        if (i < walk.count) renderSegments(bytes, array.elements, walk.starts[i] as number, tables, body, depth, state);
      }
      // What follows the elements starts a **new data line**, not the last element's line:
      // `IPSTATUS` prints `<     1 ` (its `ip_status` count), one element line, then `<     1 `
      // for `dns_server` and its element (measured on the b2 frame through the suite).
      if (index < segments.length - 1) body.newLine(DATA_INDENT);
    } else {
      for (let i = 0; i < walk.count; i++) {
        renderSegments(bytes, array.elements, walk.starts[i] as number, tables, body, depth, state);
      }
    }
    cursor = at + walk.size - base;
    shift += walk.size - denseSegmentSize(segment);
  }
}

function hexWord(value: number, width: number): string {
  return (value >>> 0).toString(16).padStart(width, '0');
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
