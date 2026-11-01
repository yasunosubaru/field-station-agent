/**
 * Decoder driven by the suite's own message dictionary (`data/edie-layouts.json`, generated from
 * `01_解包/app/Edie/messages_public.json` by `tools/gen_edie_layouts.js`).
 *
 * Why a second decoder exists: `decode.ts` mirrors `logparsers.js`, which is the *view* model and
 * only declares the fields a panel displays (BESTVEL there is 2 fields, the log has 8). Convert
 * reads the binary with the EDIE dictionary instead — full field list, exact widths, the array
 * count prefixes and the ASCII conversion strings. This module is that reader, so the differential
 * test and (later) the ASCII writer share one authoritative layout.
 *
 * Print order matches the ASCII encoder: a repeated segment prints its element count first, then
 * every element; a CHAR array prints as one string; enums print their ASCII name.
 */

export type EdieType = 'u8' | 'u16' | 'u32' | 'i32' | 'f32' | 'f64' | 'bool' | 'satid' | 'enum' | 'char';

/**
 * Where a segment starts.
 *
 * `offset` is the generator's static guess: it sums the *declared* widths, so everything after an
 * array with a count prefix — or after a `variable` string — cannot be known from the dictionary.
 * `dynamicOffset` marks a segment that follows an array of unknown length: its `offset` is
 * meaningless and a reader must continue right after the bytes the previous segment actually used.
 * (A `variable` string is not marked this way; its length is still derivable from the stored offset
 * plus the shifted cursor, and `SETNAV`/`ICOMCONFIG` have been read that way from their goldens.)
 */
export interface EdieSegmentPlacement {
  offset: number;
  dynamicOffset?: boolean;
}

export interface EdieScalar extends EdieSegmentPlacement {
  name: string;
  kind: 'scalar';
  size: number;
  type: EdieType | string;
  format?: string | null;
  enum?: string;
}

export interface EdieString extends EdieSegmentPlacement {
  name: string;
  kind: 'string';
  size: number;
  format?: string | null;
  /**
   * `size` is a maximum, not the wire size: the text is NUL-terminated and zero-padded to a
   * 4-byte boundary (the dictionary's `STRING` fields, e.g. ICOMCONFIG's `endpoint`).
   */
  variable?: boolean;
}

export interface EdieArray extends EdieSegmentPlacement {
  name: string;
  kind: 'array';
  /** Bytes of the element-count prefix (0 for fixed-length arrays). */
  countSize: number;
  fixedCount?: number;
  /**
   * Which dictionary array this is. `field` is `FIELD_ARRAY` (count prefix, one ABBREV line per
   * element), `fixed` is `FIXED_LENGTH_ARRAY` (no count, values stay on the data line) and
   * `variable` is `VARIABLE_LENGTH_ARRAY` (count prefix, values stay on the data line).
   * Absent in older tables; treat it as `field` when a count prefix exists.
   */
  arrayKind?: 'field' | 'fixed' | 'variable';
  stride: number;
  elements: EdieSegment[];
}

export type EdieSegment = EdieScalar | EdieString | EdieArray;

export interface EdieLayout {
  name: string;
  style: string;
  type: string;
  fields: EdieSegment[];
}

export interface EdieTables {
  enums: Record<string, { name: string; values: Record<string, string> }>;
  messages: Record<string, EdieLayout>;
}

export interface EdieValue {
  name: string;
  /** Path through nested arrays, e.g. `obs[3].psr`. */
  path: string;
  value: number | string;
  /** ASCII rendering when the conversion string is textual (enum, hex, integer, bool, string). */
  text?: string;
  isCount?: boolean;
}

function readScalar(dv: DataView, type: string, at: number): number | string {
  if (at < 0 || at >= dv.byteLength) return 0;
  switch (type) {
    case 'u8':
    // `CHAR`, `HEXBYTE`: one byte. `%B` prints its hex, so the unsigned read is what the ASCII
    // writer needs (a negative CHAR and its low byte are the same hex digits).
    case 'char':
    case 'hexbyte':
      return dv.getUint8(at);
    case 'u16':
    case 'ushort':
      return at + 2 > dv.byteLength ? 0 : dv.getUint16(at, true);
    case 'short':
      return at + 2 > dv.byteLength ? 0 : dv.getInt16(at, true);
    case 'u32':
    case 'enum':
    case 'satid':
    case 'uint':
    case 'ulong':
      return at + 4 > dv.byteLength ? 0 : dv.getUint32(at, true);
    case 'i32':
    case 'int':
    case 'long':
      return at + 4 > dv.byteLength ? 0 : dv.getInt32(at, true);
    case 'f32':
      return at + 4 > dv.byteLength ? 0 : dv.getFloat32(at, true);
    case 'f64':
      return at + 8 > dv.byteLength ? 0 : dv.getFloat64(at, true);
    case 'longlong':
      return at + 8 > dv.byteLength ? 0 : Number(dv.getBigInt64(at, true));
    case 'ulonglong':
      return at + 8 > dv.byteLength ? 0 : Number(dv.getBigUint64(at, true));
    case 'bool':
      return at + 4 > dv.byteLength ? 0 : dv.getUint32(at, true);
    default:
      return dv.getUint8(at);
  }
}

/** `%Z` — the whole fixed-size field as a lowercase hex string (RAWEPHEM subframes). */
function readHexBytes(dv: DataView, at: number, size: number): string {
  let out = '';
  for (let i = 0; i < size; i++) {
    const byte = at + i;
    out += byte >= dv.byteLength ? '00' : dv.getUint8(byte).toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Wire geometry
//
// `edie-layouts.json` stores *dense* offsets: the generator adds up the declared widths. Two things
// break that: a `variable` string (`arrayLength` is a maximum — the text runs to a NUL and is padded
// to 4 bytes) and any array with a count prefix (the count is on the wire, so nothing after it can
// be placed when the table is built). Both writers below therefore walk the segments in order and
// keep two numbers: `shift` (how far the wire has drifted from the stored offsets) and `cursor`
// (where the previous segment actually ended). A segment marked `dynamicOffset` starts at `cursor`.

/** Element-count prefix: u8/u16/u32, as `arrayLengthFieldSize` declares it. */
export function readCountAt(bytes: Uint8Array, at: number, size: number): number {
  if (at < 0 || at + Math.max(1, size) > bytes.byteLength) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 1) return view.getUint8(at);
  if (size === 2) return view.getUint16(at, true);
  return view.getUint32(at, true);
}

/**
 * Bytes a `variable` STRING occupies: the text up to its NUL, then the NUL, zero padded to a
 * 4-byte boundary; at least four bytes.
 *
 * Measured through the suite: ICOMCONFIG's 80-byte `endpoint` holding `":3002"` takes 8 bytes,
 * SETNAV's 6-byte `from_point` holding `"FROM"` takes 8, DNSCONFIG's 16-byte address
 * `"192.168.5.1"` takes 12.
 *
 * `arrayLength` is **not** enforced: a `SURVEYPOSITION` whose 5-byte `id` holds `abcdefghij\0` is
 * printed as `"abcdefghij"` and its `latitude` is read at 4 + 12 = 16, i.e. the suite stops at the
 * NUL and pads from there. Real records NUL-terminate inside the field, so the declared width and
 * the NUL give the same answer on every capture we have.
 */
export function stringWireSize(bytes: Uint8Array, at: number, size: number): number {
  void size;
  let length = 0;
  while (at + length < bytes.byteLength && (bytes[at + length] ?? 0) !== 0) length += 1;
  return Math.max(4, Math.ceil((length + 1) / 4) * 4);
}

/**
 * Text of one `STRING` field, printed the way the suite prints it: every byte up to the NUL.
 *
 * A **fixed** `STRING` stays inside its declared width (`HEADINGEXT`'s four-byte `master_id`); a
 * **variable** one is not capped at `arrayLength`, for the reason `stringWireSize` records.
 */
export function readStringField(bytes: Uint8Array, at: number, segment: EdieString): string {
  const limit = segment.variable ? bytes.byteLength - at : segment.size;
  let out = '';
  for (let i = 0; i < limit; i++) {
    const byte = bytes[at + i];
    if (byte === undefined || byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** True when the list contains a segment whose width the table cannot know: a variable string or a counted array. */
export function segmentsVariable(segments: readonly EdieSegment[]): boolean {
  return segments.some((segment) => {
    if (segment.kind === 'string') return segment.variable === true;
    if (segment.kind === 'array') {
      return segment.fixedCount === undefined || segmentsVariable(segment.elements);
    }
    return segment.dynamicOffset === true;
  });
}

/** Width the stored offsets assume for one segment. */
export function denseSegmentSize(segment: EdieSegment): number {
  if (segment.kind !== 'array') return segment.size;
  return (segment.countSize || 0) + (segment.fixedCount ?? 0) * (segment.stride || 1);
}

// ---------------------------------------------------------------------------------------------
// `pack(4)`
//
// The offsets in `edie-layouts.json` are **dense**: the generator summed the declared field widths.
// The wire is not dense — SBF payloads are C structs compiled with `#pragma pack(4)`, so a member
// starts on a `min(4, sizeof)` boundary. Two consequences, both measured against the suite's own
// Convert on synthetic frames (see `06_…`/§9.x.14 of `03_分析/09_EDIE消息字典与ASCII一致性.md`):
//
//  - inside a struct, a member moves up to the next 4-byte (2-byte for a `USHORT`) boundary;
//  - a `STRING`/`%Z` member is a **char array**, so its own alignment is 1 and it never moves —
//    which is why `RAWEPHEM` stays exactly 102 bytes (`4+4+4+30+30+30`) and the table's dense
//    offsets are already right for it, while `RAWGPSSUBFRAME`'s `ULONG` behind the same 30-byte
//    blob does move (42 → 44, payload 46 → 48);
//  - an array aligns like its first member: its `ULONG` count prefix when it has one, otherwise its
//    element type. `USERI2CREAD`'s register array therefore starts at 4, not at 1;
//  - there is **no tail padding**: a struct's size is where its last member ends. `GLOCLOCK`'s
//    payload is 61 bytes, not the 64 a `sizeof` with tail padding would give.
// ---------------------------------------------------------------------------------------------

/** `pack(4)` alignment of one member. */
export function segmentAlignment(segment: EdieSegment): number {
  if (segment.kind === 'string') return 1;
  if (segment.kind === 'array') {
    if (segment.countSize) return 4;
    const first = segment.elements[0];
    return first ? segmentAlignment(first) : 1;
  }
  const size = segment.size || 1;
  return size >= 4 ? 4 : size === 2 ? 2 : 1;
}

/** `value` rounded up to the next multiple of `align`. */
export function alignUp(value: number, align: number): number {
  const remainder = value % align;
  return remainder === 0 ? value : value + align - remainder;
}

/** Bytes one element of an array occupies, or null when the element list is variable. */
export function packedStructSize(segments: readonly EdieSegment[]): number | null {
  let cursor = 0;
  for (const segment of segments) {
    cursor = alignUp(cursor, segmentAlignment(segment));
    const size = packedSegmentSize(segment);
    if (size === null) return null;
    cursor += size;
  }
  return cursor;
}

/** Bytes a segment occupies once its element count is known; null when it is variable. */
export function packedSegmentSize(segment: EdieSegment): number | null {
  if (segment.kind !== 'array') return segment.size;
  if (segment.fixedCount === undefined) return null;
  const inner = packedStructSize(segment.elements);
  if (inner === null) return null;
  return (segment.countSize || 0) + segment.fixedCount * inner;
}

export interface ArrayWalk {
  /** The count the record carries (fixed arrays: their definition). */
  declared: number;
  /** `declared` clamped to what the payload can hold. */
  count: number;
  /** Absolute start of each element, `count` entries. */
  starts: number[];
  /** Bytes from the array's own start to the end of its last element. */
  size: number;
  /** False when the count prefix itself lies past the end of the payload. */
  inPayload: boolean;
}

/**
 * Walk one array: read its count, place its elements, and report how many bytes it consumed.
 *
 * A counted array's element count is trusted even past the declared stride when the elements carry
 * a variable string (DNSCONFIG's address is 12 bytes, not the declared 16), because only the
 * content says where the next element starts.
 */
export function walkArray(bytes: Uint8Array, array: EdieArray, at: number): ArrayWalk {
  const stride = array.stride || 1;
  const first = at + array.countSize;
  const available = Math.max(0, bytes.byteLength - first);
  const variable = segmentsVariable(array.elements);
  const capacity = variable ? Number.POSITIVE_INFINITY : Math.floor(available / stride);
  const declared = array.fixedCount !== undefined
    ? array.fixedCount
    : array.countSize
      ? readCountAt(bytes, at, array.countSize)
      : capacity;
  const count = Math.max(0, Math.min(declared, capacity));
  const starts: number[] = [];
  let position = first;
  for (let i = 0; i < count; i++) {
    starts.push(position);
    position += variable ? segmentsWireSize(bytes, array.elements, position) : stride;
  }
  return {
    declared,
    count,
    starts,
    size: position - at,
    inPayload: array.countSize === 0 || at + array.countSize <= bytes.byteLength,
  };
}

/** Bytes one segment occupies on the wire, walking any array it holds. */
export function segmentWireSize(bytes: Uint8Array, segment: EdieSegment, at: number): number {
  if (segment.kind === 'scalar') return segment.size;
  if (segment.kind === 'string') {
    return segment.variable === true ? stringWireSize(bytes, at, segment.size) : segment.size;
  }
  // `%R`/`%P` swallow the whole payload; nothing can follow them in a layout that has one.
  const format = String(segment.format ?? '');
  if (format === '%R' || format === '%P') return Math.max(0, bytes.byteLength - at);
  return walkArray(bytes, segment, at).size;
}

/** Bytes a segment list occupies on the wire when it starts at `base`. */
export function segmentsWireSize(bytes: Uint8Array, segments: readonly EdieSegment[], base: number): number {
  let shift = 0;
  let end = base;
  for (const segment of segments) {
    const at = base + (segment.dynamicOffset ? end - base : segment.offset + shift);
    const size = segmentWireSize(bytes, segment, at);
    end = Math.max(end, at + size);
    shift += at + size - (base + segment.offset + denseSegmentSize(segment));
  }
  return end - base;
}

/** `%7.3lk` / `%08x` / `%UB` / `%02XB` / `%id` / `%hu` — only the textual ones are rendered here. */
function renderScalar(segment: EdieScalar, value: number | string, tables: EdieTables): string | undefined {
  if (segment.enum) {
    const table = tables.enums[segment.enum];
    if (table && typeof value === 'number') return table.values[String(value)] ?? String(value);
  }
  if (segment.type === 'bool') return value ? 'TRUE' : 'FALSE';
  const format = segment.format ?? '';
  const match = /^%(\d*)(?:\.(\d+))?(l{0,2})([A-Za-z]{1,2})$/.exec(format);
  if (!match) return undefined;
  const width = match[1] ? Number(match[1]) : 0;
  const spec = match[4];
  if (spec === 's') return String(value);
  if (spec === 'x') return (Number(value) >>> 0).toString(16).padStart(width || 8, '0');
  if (spec === 'X') return (Number(value) >>> 0).toString(16).toUpperCase().padStart(width || 8, '0');
  if (spec === 'XB') return (Number(value) & 0xff).toString(16).toUpperCase().padStart(width || 2, '0');
  if (spec === 'u' || spec === 'hu' || spec === 'lu') return String(Math.trunc(Number(value)) >>> 0);
  if (spec === 'd' || spec === 'ld' || spec === 'id') return String(Math.trunc(Number(value)));
  if (spec === 'UB') return String(Math.trunc(Number(value)) & 0xff);
  // f / lf / k / lk / llk: floating point, compared numerically (see verify-ascii.ts).
  return undefined;
}

function decodeSegments(
  dv: DataView,
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  prefix: string,
  out: EdieValue[],
  tables: EdieTables,
): void {
  let shift = 0;
  let cursor = 0;
  for (const segment of segments) {
    const at = base + (segment.dynamicOffset ? cursor : segment.offset + shift);
    if (segment.kind === 'string') {
      const hex = String(segment.format ?? '').endsWith('Z');
      const text = hex ? readHexBytes(dv, at, segment.size) : readStringField(bytes, at, segment);
      out.push({ name: segment.name, path: `${prefix}${segment.name}`, value: text, text });
      const size = segmentWireSize(bytes, segment, at);
      cursor = at + size - base;
      if (segment.variable) shift += size - segment.size;
      continue;
    }
    if (segment.kind === 'scalar') {
      const value = readScalar(dv, segment.type, at);
      const text = renderScalar(segment, value, tables);
      out.push({ name: segment.name, path: `${prefix}${segment.name}`, value, ...(text === undefined ? {} : { text }) });
      cursor = at + segment.size - base;
      continue;
    }
    // array
    const format = String(segment.format ?? '');
    // `%R` (an embedded record) and `%P` (a pass-through payload) are one token each, and only the
    // ASCII writer interprets them; the field decoders keep skipping them.
    if (format === '%R' || format === '%P') {
      cursor = at + segmentWireSize(bytes, segment, at) - base;
      continue;
    }
    // `%Z` — a counted array of bytes printed as **one** lowercase hex token, not one decimal number
    // per element: `USERI2CREAD`'s registers `de ad be` come out `deadbe`, and a zero count comes out
    // as an empty token (`…,42,0,,7,…`). Measured with the suite's Convert on synthetic frames.
    if (format === '%Z') {
      if (segment.countSize && at + segment.countSize > bytes.byteLength) continue;
      const declared = segment.countSize
        ? readCountAt(bytes, at, segment.countSize)
        : (segment.fixedCount ?? 0);
      const start = at + (segment.countSize || 0);
      const count = Math.max(0, Math.min(declared, Math.max(0, bytes.byteLength - start)));
      let text = '';
      for (let i = 0; i < count; i++) text += (bytes[start + i] ?? 0).toString(16).padStart(2, '0');
      if (segment.countSize) {
        out.push({ name: `${segment.name}.count`, path: `${prefix}${segment.name}.count`, value: declared, text: String(declared), isCount: true });
      }
      out.push({ name: segment.name, path: `${prefix}${segment.name}`, value: text, text });
      cursor = start + count - base;
      shift += (segment.countSize || 0) + count - denseSegmentSize(segment);
      continue;
    }
    const walk = walkArray(bytes, segment, at);
    if (segment.countSize) {
      out.push({ name: `${segment.name}.count`, path: `${prefix}${segment.name}.count`, value: walk.declared, text: String(walk.declared), isCount: true });
    }
    for (let i = 0; i < walk.count; i++) {
      decodeSegments(dv, bytes, segment.elements, walk.starts[i], `${prefix}${segment.name}[${i}].`, out, tables);
    }
    cursor = at + walk.size - base;
    shift += walk.size - denseSegmentSize(segment);
  }
}

/** Decode one payload into the field sequence the ASCII encoder prints. */
export function decodeEdie(payload: Uint8Array, layout: EdieLayout, tables: EdieTables): EdieValue[] {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: EdieValue[] = [];
  decodeSegments(dv, payload, layout.fields, 0, '', out, tables);
  return out;
}

/** Fixed payload size of a layout (null when it contains a variable-length array). */
export function edieFixedSize(layout: EdieLayout): number | null {
  let total = 0;
  for (const segment of layout.fields) {
    if (segment.kind === 'scalar' || segment.kind === 'string') total += segment.size;
    else if (segment.fixedCount !== undefined) total += segment.countSize + segment.fixedCount * segment.stride;
    else return null;
  }
  return total;
}
