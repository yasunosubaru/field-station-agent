/**
 * Text → binary: the other half of `Convert`'s record model.
 *
 * `--to BINARY` is not a pure copy. Convert parses every record it accepts and **writes it back
 * out**; a record that arrived as ASCII (the receiver's own `#BESTPOSA,…` line or an abbreviated
 * `<BESTPOS …` block) therefore comes out of a `-b` run as an SBF frame with a 28-byte header, a
 * `pack(4)` payload and a fresh CRC, in the same position in the capture. `abbrev-log.ts` only
 * copied the frames that were already binary, which is why `b1` was 124 880 B short (99 records) and
 * `b7` 245 402 B short (431 records).
 *
 * Everything here is measured against the suite's own `-b` output (`b1-20261101.sbf` 2 623 374 B,
 * `b7-20261101.sbf` 473 262 B, both byte-identical) and against synthetic text-only captures, so
 * that no rule depends on a binary frame happening to sit next to the text record:
 *
 *  - **Header**: the nine printed tokens map straight onto the long header. The port token goes
 *    through the suite's own address table and is truncated to the header's one byte (`USB2` =
 *    1696 → 160, which prints back as `SPECIAL`; measured, and the reason the b1 golden carries 51
 *    `#BESTPOSA,SPECIAL` lines next to the 39 `#BESTPOSA,USB2` ones). `idle` is printed as
 *    `raw/2`, so it is doubled back; `week` and `ms` are decimal; the receiver status and the
 *    message-definition CRC are the printed hex; the version is decimal. `messageType` is 0 — the
 *    suite stamps every re-encoded record as an ordinary binary log.
 *  - **Body**: the printed tokens are read back with the layout's own types and written at the
 *    `pack(4)` offsets the writers already use (`wireFields` / `wireElementSegments`). An `f64`
 *    field is the double nearest the printed decimal, an `f32` field is that double rounded to
 *    single precision first (`Math.fround`) — measured on a text-only `#BESTPOSA` capture:
 *    latitude `30.53997306366` → `…3b8a3e40`, exactly `Number('30.53997306366')`, while the same
 *    value read from the receiver's binary frame carries more low bits and is a different double.
 *  - **`%R`**: `RXCONFIG`'s payload is a whole binary record. The suite encodes the embedded ASCII
 *    message (`#ELEVATIONCUTOFFA,…`) into an SBF frame and uses **those bytes** as the payload,
 *    header, CRC and all (measured: the outer payload is 44 B and starts `aa44121c`).
 *
 * A record this module cannot encode is reported, never dropped silently: `encodeBinaryText`
 * returns a `reason` and the pipeline counts it. The measurements above cover every text record in
 * b1–b7; the failure path exists for records no capture has produced.
 */

import { appendCrcLe } from './crc.ts';
import {
  alignUp,
  packedStructSize,
  segmentAlignment,
  segmentsVariable,
  wireElementSegments,
  type EdieArray,
  type EdieScalar,
  type EdieSegment,
  type EdieString,
  type EdieTables,
} from './edie.ts';
import { wireFields } from './ascii-log.ts';
import { buildLongHeader } from './header.ts';
import type { BinaryTextRecord } from './text-log.ts';

/* -------------------------------------------------------------------------------------------- */
/* Header                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Port names whose address is a plain block base: `NAME_n` is `base + n`.
 *
 * Same set as `ascii-log.ts#PORT_GROUPS`, plus `SPECIAL` (the address the USB ports truncate to).
 */
const PORT_GROUPS: Record<string, number> = {
  COM1: 32, COM2: 64, COM3: 96, USB: 128, SPECIAL: 160, THISPORT: 192, FILE: 224,
  XCOM1: 416, XCOM2: 672, USB1: 1440, USB2: 1696, USB3: 1952, AUX: 2208, XCOM3: 2464,
  COM4: 2976, ETH1: 3232, IMU: 3488, ICOM1: 4000, ICOM2: 4256, ICOM3: 4512,
  NCOM1: 4768, NCOM2: 5024, NCOM3: 5280, ICOM4: 5536, WCOM1: 5792,
  COM5: 6048, COM6: 6304, BT1: 6560, COM7: 6816, COM8: 7072, COM9: 7328, COM10: 7584,
  CCOM1: 7840, CCOM2: 8096, CCOM3: 8352, CCOM4: 8608, CCOM5: 8864, CCOM6: 9120,
  CCOM7: 9376, CCOM8: 9632, ICOM5: 9888, ICOM6: 10144, ICOM7: 10400,
  SCOM1: 10656, SCOM2: 10912, SCOM3: 11168, SCOM4: 11424,
};

/**
 * The suite's own `nameToAddressForLog` table (`data/portaddresses.json`), whose entries are not
 * all plain group bases (`SPECIAL_29` = 189, `THISPORT_30` = 222, `BT1_30` = 6590).
 */
const PORT_ADDRESSES: Record<string, number> = {
  COM1: 32, COM2: 64, COM3: 96, FILE: 224,
  COM4: 2976, COM5: 6048, COM6: 6304, COM7: 6816, COM8: 7072, COM9: 7328, COM10: 7584,
  NCOM1: 4768, NCOM2: 5024, NCOM3: 5280,
  USB1: 1440, USB2: 1696, USB3: 1952,
  ICOM1: 4000, ICOM2: 4256, ICOM3: 4512, ICOM4: 5536, ICOM5: 9888, ICOM6: 10144, ICOM7: 10400,
  THISPORT: 192, THISPORT_29: 221, THISPORT_30: 222,
  SPECIAL: 160, SPECIAL_29: 189,
  COM1_29: 61, COM2_29: 93, COM3_29: 125,
  USB1_29: 1469, USB2_29: 1725, USB3_29: 1981,
  ICOM1_29: 4029, ICOM2_29: 4285, ICOM3_29: 4541, ICOM4_29: 5565,
  ICOM5_29: 9917, ICOM6_29: 10173, ICOM7_29: 10429,
  BT1: 6560, BT1_29: 6589, BT1_30: 6590,
};

/**
 * The SBF header's `portAddress`: one byte of the port's full address.
 *
 * Measured through the suite with a synthetic text-only capture:
 * `USB2 → 160`, `USB1 → 160`, `USB3 → 160`, `NCOM1 → 160` (all 0x…A0), `COM1 → 32`,
 * `THISPORT → 192`, `FILE → 224`, `USB2_29 → 189`, and a name the table does not carry (`BOGUS`)
 * → **192** (`THISPORT`), which is the suite's fallback.
 */
export function textPortAddress(token: string): number {
  const name = token.trim().toUpperCase();
  const exact = PORT_ADDRESSES[name];
  if (exact !== undefined) return exact & 0xff;
  const match = /^([A-Z0-9]+)_(\d+)$/.exec(name);
  if (match) {
    const base = PORT_GROUPS[match[1] as string];
    if (base !== undefined) return (base + Number(match[2])) & 0xff;
  }
  const group = PORT_GROUPS[name];
  if (group !== undefined) return group & 0xff;
  return 192;
}

/** The suite's `GPSTimeStatus` enum, reversed: `COARSESTEERING` → 120. */
const TIME_STATUS = new WeakMap<EdieTables, Map<string, number>>();

function timeStatusTable(tables: EdieTables): Map<string, number> {
  const cached = TIME_STATUS.get(tables);
  if (cached) return cached;
  const byName = new Map<string, number>();
  for (const entry of Object.values(tables.enums)) {
    if (entry.name !== 'GPSTimeStatus') continue;
    for (const [value, name] of Object.entries(entry.values)) byName.set(name, Number(value));
  }
  TIME_STATUS.set(tables, byName);
  return byName;
}

/** `RANGE`/`BESTPOS` → the dictionary's message id, cached per table. */
const MESSAGE_IDS = new WeakMap<EdieTables, Map<string, number>>();

function messageIds(tables: EdieTables): Map<string, number> {
  const cached = MESSAGE_IDS.get(tables);
  if (cached) return cached;
  const byName = new Map<string, number>();
  for (const [id, layout] of Object.entries(tables.messages)) byName.set(layout.name.toUpperCase(), Number(id));
  MESSAGE_IDS.set(tables, byName);
  return byName;
}

function messageIdOf(token: string, tables: EdieTables): number | undefined {
  const letter = /[AB]$/.test(token) ? token.slice(-1) : '';
  const name = letter ? token.slice(0, -1) : token;
  const base = messageIds(tables).get(name.toUpperCase());
  if (base === undefined) return undefined;
  if (letter === 'A') return base | 0x200000;
  if (letter === 'B') return base;
  return base | 0x400000;
}

/* -------------------------------------------------------------------------------------------- */
/* Payload                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** A growable payload buffer; members are written at absolute offsets, so gaps stay zero. */
class PayloadWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private need(at: number, count: number): void {
    const size = at + count;
    if (size <= this.buffer.length) return;
    let next = this.buffer.length * 2;
    while (next < size) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(at: number, value: number): void { this.need(at, 1); this.view.setUint8(at, value & 0xff); this.touch(at + 1); }
  u16(at: number, value: number): void { this.need(at, 2); this.view.setUint16(at, value & 0xffff, true); this.touch(at + 2); }
  u32(at: number, value: number): void { this.need(at, 4); this.view.setUint32(at, value >>> 0, true); this.touch(at + 4); }
  i8(at: number, value: number): void { this.need(at, 1); this.view.setInt8(at, value); this.touch(at + 1); }
  i16(at: number, value: number): void { this.need(at, 2); this.view.setInt16(at, value, true); this.touch(at + 2); }
  i32(at: number, value: number): void { this.need(at, 4); this.view.setInt32(at, value | 0, true); this.touch(at + 4); }
  i64(at: number, value: bigint): void { this.need(at, 8); this.view.setBigInt64(at, BigInt.asIntN(64, value), true); this.touch(at + 8); }
  u64(at: number, value: bigint): void { this.need(at, 8); this.view.setBigUint64(at, BigInt.asUintN(64, value), true); this.touch(at + 8); }
  f32(at: number, value: number): void { this.need(at, 4); this.view.setFloat32(at, value, true); this.touch(at + 4); }
  f64(at: number, value: number): void { this.need(at, 8); this.view.setFloat64(at, value, true); this.touch(at + 8); }

  bytes(at: number, value: Uint8Array): void {
    this.need(at, value.length);
    this.buffer.set(value, at);
    this.touch(at + value.length);
  }

  zeros(at: number, count: number): void {
    this.need(at, count);
    this.buffer.fill(0, at, at + count);
    this.touch(at + count);
  }

  private touch(end: number): void {
    if (end > this.length) this.length = end;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

interface Cursor {
  at: number;
}

interface EncodeState {
  tokens: string[];
  index: number;
  tables: EdieTables;
  /** The raw `#NAME,…*crc` blob of a whole-body `%R` record (`RXCONFIG`). */
  embedded?: string;
  /** Nesting depth of `%R`; the suite only converts the first embedded record. */
  depth: number;
  /** The first reason the record cannot be encoded (`string does not fit`, …). */
  error?: string;
}

function nextToken(state: EncodeState): string | undefined {
  if (state.index >= state.tokens.length) {
    state.error ??= 'body ran out of tokens';
    return undefined;
  }
  return state.tokens[state.index++];
}

/** `%x` / `%X` / `%XB` / `%B` print hex; every other numeric conversion prints decimal. */
function hexSpec(spec: string | undefined): boolean {
  return spec === 'x' || spec === 'X' || spec === 'XB' || spec === 'B';
}

function specOf(format: string | null | undefined): string | undefined {
  return /^%\d*(?:\.\d+)?l{0,2}([A-Za-z]{1,2})$/.exec(format ?? '')?.[1];
}

function unquote(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function numericToken(token: string, segment: EdieScalar): number | bigint | string {
  const spec = specOf(segment.format);
  if (segment.enum) {
    return token;
  }
  if (segment.type === 'bool') return /^true$/i.test(token) ? 1 : 0;
  if (spec === 'm') return token;
  if (spec === 'T') return Math.round(Number(token) * 1000);
  if (spec === 'c') return token.length ? token.charCodeAt(0) : 0;
  if (hexSpec(spec)) {
    const value = parseInt(token, 16);
    if (!Number.isNaN(value)) return value;
  }
  if (/%l{2}[ud]$/.test(String(segment.format ?? ''))) {
    try { return BigInt(token); } catch { return 0n; }
  }
  const value = Number(token);
  return Number.isFinite(value) ? value : 0;
}

function scalarValue(segment: EdieScalar, token: string, state: EncodeState): number | bigint {
  if (segment.enum) {
    const table = state.tables.enums[segment.enum];
    if (table) {
      for (const [value, name] of Object.entries(table.values)) {
        if (name === token) return Number(value);
      }
      // An unknown enum **name** is written as `max + 1` — the table's invalid sentinel. Measured
      // through a text-only capture: `CommPort`'s unknown `LCOM1`/`LCOM4`/`BOGUSNAME` all become 53
      // (its largest value is 52) and `InterfaceMode`'s unknown `BOGUSMODE` becomes 69 (largest 68),
      // while the real names keep their ids (`COM5` → 31, `UNKNOWN` → 5).
      let max = -1;
      for (const value of Object.keys(table.values)) max = Math.max(max, Number(value));
      return max + 1;
    }
    return 0;
  }
  const value = numericToken(token, segment);
  if (typeof value === 'string') {
    if (specOf(segment.format) === 'm') return messageIdOf(value, state.tables) ?? 0;
    return 0;
  }
  return value;
}

function writeScalar(writer: PayloadWriter, at: number, segment: EdieScalar, token: string, state: EncodeState): void {
  const type = segment.type;
  const value = scalarValue(segment, token, state);
  switch (type) {
    case 'u8': case 'char': case 'hexbyte':
      writer.u8(at, Number(value));
      return;
    case 'u16': case 'ushort':
      writer.u16(at, Number(value));
      return;
    case 'short':
      writer.i16(at, Number(value));
      return;
    case 'u32': case 'enum': case 'satid': case 'bool': case 'uint': case 'ulong':
      writer.u32(at, Number(value));
      return;
    case 'i32': case 'int': case 'long':
      writer.i32(at, Number(value));
      return;
    case 'f32':
      writer.f32(at, Math.fround(Number(value)));
      return;
    case 'f64':
      writer.f64(at, Number(value));
      return;
    case 'longlong':
      writer.i64(at, typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))));
      return;
    case 'ulonglong':
      writer.u64(at, typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))));
      return;
    default:
      writer.u8(at, Number(value));
  }
}

/** A `STRING` member: NUL-terminated, zero padded. A `variable` one is padded to 4 bytes. */
function writeString(writer: PayloadWriter, at: number, segment: EdieString, token: string, state: EncodeState): number {
  // `%Z` — the field is a hex blob, printed as lowercase hex, not as text.
  if (String(segment.format ?? '').endsWith('Z')) {
    writer.zeros(at, segment.size);
    writer.bytes(at, hexBytes(unquote(token), segment.size));
    return segment.size;
  }
  const text = latin1(unquote(token));
  if (segment.variable) {
    const size = Math.max(4, Math.ceil((text.length + 1) / 4) * 4);
    writer.zeros(at, size);
    writer.bytes(at, text);
    return size;
  }
  // A fixed `STRING` that does not fit makes the suite drop the whole record (measured: a
  // `#BESTPOSA` whose 4-byte `base_id` reads `"ABCDEF"` produces no frame at all, while `"AB"`
  // becomes `41 42 00 00` and `"ABCD"` stays `41 42 43 44`).
  if (text.length > segment.size) {
    state.error = `string "${unquote(token)}" does not fit a ${segment.size}-byte field`;
    return -1;
  }
  writer.zeros(at, segment.size);
  writer.bytes(at, text);
  return segment.size;
}

/** `\xNN` escapes and `\\` back to bytes — the inverse of `ascii-log.ts#escapePassThrough`. */
function unescapePassThrough(token: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < token.length; i++) {
    const char = token[i] as string;
    if (char === '\\') {
      const next = token[i + 1];
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(token.slice(i + 2, i + 4))) {
        out.push(parseInt(token.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
      if (next === '\\') { out.push(0x5c); i += 1; continue; }
      out.push(0x5c);
      continue;
    }
    out.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function hexBytes(token: string, count: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, count));
  for (let i = 0; i < out.length; i++) {
    const pair = token.slice(i * 2, i * 2 + 2);
    out[i] = pair.length === 2 && /^[0-9a-fA-F]{2}$/.test(pair) ? parseInt(pair, 16) : 0;
  }
  return out;
}

function writeCount(writer: PayloadWriter, at: number, size: number, count: number): void {
  if (size === 1) writer.u8(at, count);
  else if (size === 2) writer.u16(at, count);
  else writer.u32(at, count);
}

/**
 * Encode a member list at `base`, returning where it ends.
 *
 * Members are laid out exactly as the binary writer's readers expect them (`pack(4)`, no tail
 * padding), which is also how their offsets were generated: `segment.offset` is the dense sum, and
 * `alignUp(cursor, alignment)` reproduces the wire struct. Array elements follow their count prefix
 * without extra padding (that is `walkArray`'s `first = at + countSize`).
 */
function encodeSegments(writer: PayloadWriter, segments: EdieSegment[], base: number, state: EncodeState): number {
  let cursor = 0;
  for (const segment of segments) {
    const at = base + alignUp(cursor, segmentAlignment(segment));

    if (segment.kind === 'string') {
      const token = nextToken(state);
      if (token === undefined) return -1;
      const size = writeString(writer, at, segment, token, state);
      if (size < 0) return -1;
      cursor = at + size - base;
      continue;
    }
    if (segment.kind === 'scalar') {
      const token = nextToken(state);
      if (token === undefined) return -1;
      writeScalar(writer, at, segment, token, state);
      cursor = at + segment.size - base;
      continue;
    }

    const array = segment as EdieArray;
    const format = String(array.format ?? '');

    // `%R` — one embedded record. The suite converts it (header, payload, CRC) and uses the frame's
    // bytes as this record's payload; measured on RXCONFIG, whose payload starts `aa44121c`.
    if (format === '%R') {
      const framed = state.embedded !== undefined && state.depth < 4
        ? encodeEmbeddedFrame(state.embedded, state.tables, state.depth + 1)
        : undefined;
      if (!framed) {
        state.error = 'embedded record did not resolve';
        return -1;
      }
      writer.bytes(at, framed);
      cursor = at + framed.length - base;
      continue;
    }

    // `%P` — a pass-through payload: the count prefix (when the layout has one), one escaped token.
    if (format === '%P') {
      const countToken = array.countSize ? nextToken(state) : undefined;
      if (array.countSize && countToken === undefined) return -1;
      const token = nextToken(state);
      if (token === undefined) return -1;
      const payload = unescapePassThrough(token);
      if (array.countSize) writeCount(writer, at, array.countSize, payload.length);
      writer.bytes(at + (array.countSize || 0), payload);
      cursor = at + (array.countSize || 0) + payload.length - base;
      continue;
    }

    // `%Z` — a byte array printed as one lowercase hex token behind its element count.
    if (format === '%Z') {
      const countToken = array.countSize ? nextToken(state) : undefined;
      if (array.countSize && countToken === undefined) return -1;
      const declared = array.countSize ? Number(countToken) : (array.fixedCount ?? 0);
      const token = nextToken(state);
      if (token === undefined) return -1;
      if (array.countSize) writeCount(writer, at, array.countSize, declared);
      const bytes = hexBytes(token, declared);
      writer.bytes(at + (array.countSize || 0), bytes);
      cursor = at + (array.countSize || 0) + bytes.length - base;
      continue;
    }

    // A counted array prints its element count first; a fixed one prints none.
    const countToken = array.countSize ? nextToken(state) : undefined;
    if (array.countSize && countToken === undefined) return -1;
    const count = array.countSize ? Number(countToken) : (array.fixedCount ?? 0);
    if (array.countSize) writeCount(writer, at, array.countSize, count);
    const first = at + (array.countSize || 0);
    if (count <= 0) {
      cursor = first - base;
      continue;
    }

    const elements = array.elements;
    const stride = segmentsVariable(elements)
      ? 0
      : (packedStructSize(wireElementSegments(elements)) ?? array.stride ?? 1);
    let position = first;
    for (let i = 0; i < count; i++) {
      const end = encodeSegments(writer, elements, position, state);
      if (end < 0) return -1;
      position = end;
      if (stride > 0) position = first + (i + 1) * stride;
    }
    cursor = position - base;
  }
  return base + cursor;
}

/**
 * Payload of one text record. `undefined` means the record ran out of tokens or held a `%R` blob
 * that would not resolve — the two cases the suite drops too.
 */
function encodePayload(source: BinaryTextRecord, state: EncodeState): Uint8Array | undefined {
  const writer = new PayloadWriter();
  state.tokens = source.body;
  state.index = 0;
  state.embedded = source.embedded;
  const fields = wireFields(source.layout);
  // A whole-body `%R` record has no count prefix; `encodeSegments` writes the embedded frame.
  const end = encodeSegments(writer, fields, 0, state);
  if (end < 0) return undefined;
  return writer.finish();
}

/* -------------------------------------------------------------------------------------------- */
/* Frames                                                                                         */
/* -------------------------------------------------------------------------------------------- */

function encodeEmbeddedFrame(blob: string, tables: EdieTables, depth: number): Uint8Array | undefined {
  // `#NAME,<head>;<body>*<crc>` — the trailing CRC is re-derived by the binary framing.
  const star = blob.lastIndexOf('*');
  const text = blob.slice(1, star > 0 ? star : undefined);
  const semicolon = text.indexOf(';');
  if (semicolon < 0) return undefined;
  const tokens = text.slice(0, semicolon).split(',');
  const rawName = tokens.shift() ?? '';
  if (tokens.length < 9) return undefined;
  const base = rawName.slice(0, -1);
  const name = /[A-Z]$/.test(rawName) ? base : rawName;
  const layout = Object.values(tables.messages).find((entry) => entry.name === name);
  if (!layout) return undefined;
  const body = text.slice(semicolon + 1);
  const result = encodeRecord(
    {
      index: 0,
      name,
      layout,
      head: tokens.slice(0, 9),
      body: body === '' ? [] : body.split(','),
    },
    tables,
    depth,
  );
  if (!result.bytes) return undefined;
  // An **embedded** record's CRC field is the one's complement of the NovAtel CRC, the same rule the
  // ASCII writer applies to the `#…;…*<inner crc>` line (`embeddedCrc` in `text-log.ts`). Measured:
  // the plain CRC of b7's first inner `ELEVATIONCUTOFF` frame is `b916e5b3` and the suite writes
  // `46e91a4c`, while the **outer** `RXCONFIG` frame keeps the plain CRC.
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  const at = result.bytes.length - 4;
  view.setUint32(at, (view.getUint32(at, true) ^ 0xffffffff) >>> 0, true);
  return result.bytes;
}

export interface TextEncodeFailure {
  index: number;
  name: string;
  reason: string;
}

export interface TextEncodeResult {
  bytes?: Uint8Array;
  error?: string;
}

/**
 * Encode one assembled text record as an SBF frame: long header, `pack(4)` payload, CRC.
 *
 * The header is written from the record's own nine tokens, so the frame keeps the port, sequence,
 * idle time and receiver status the receiver printed rather than inheriting them from a neighbour.
 */
export function encodeRecord(source: BinaryTextRecord, tables: EdieTables, depth = 0): TextEncodeResult {
  const ids = messageIds(tables);
  const id = ids.get(source.name.toUpperCase());
  if (id === undefined) return { error: `no dictionary id for ${source.name}` };
  const head = source.head;
  if (head.length < 9) return { error: 'header has fewer than nine tokens' };

  const portAddress = textPortAddress(head[0] as string);
  const sequence = Number(head[1]);
  const idleRaw = Math.round(Number(head[2]) * 2);
  const timeStatus = timeStatusTable(tables).get(String(head[3]).toUpperCase());
  const week = Number(head[4]);
  // The suite **truncates** `seconds × 1000`: `2.018` becomes `2017`, not `2018`, because the double
  // for 2.018 is 2017.9999999999998. Measured on b7's 25 `UNKNOWN`-status RXCONFIG records, whose
  // `2.018`, `2.022` stamps come out 2017 and 2021 (`03_分析/09_…` §binary).
  const milliseconds = Math.trunc(Number(head[5]) * 1000);
  const receiverStatus = parseInt(String(head[6]), 16);
  const reserved = parseInt(String(head[7]), 16);
  const softwareVersion = Number(head[8]);
  if (![sequence, idleRaw, week, milliseconds, receiverStatus, reserved, softwareVersion].every(Number.isFinite)) {
    return { error: 'header token is not numeric' };
  }
  if (timeStatus === undefined) return { error: `unknown time status ${head[3]}` };

  const state: EncodeState = { tokens: source.body, index: 0, tables, embedded: source.embedded, depth };
  const payload = encodePayload(source, state);
  if (!payload) {
    return {
      error: state.error
        ?? (source.embedded !== undefined ? 'embedded record did not resolve' : 'body ran out of tokens'),
    };
  }

  const header = buildLongHeader({
    messageId: id,
    payloadLength: payload.length,
    messageType: 0,
    portAddress,
    sequence,
    idleTimeRaw: idleRaw,
    timeStatus,
    week,
    milliseconds,
    receiverStatus,
    reserved,
    softwareVersion,
  });
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return { bytes: appendCrcLe(frame) };
}
