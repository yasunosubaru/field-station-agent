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

export interface EdieScalar {
  name: string;
  kind: 'scalar';
  offset: number;
  size: number;
  type: EdieType | string;
  format?: string | null;
  enum?: string;
}

export interface EdieString {
  name: string;
  kind: 'string';
  offset: number;
  size: number;
  format?: string | null;
  /**
   * `size` is a maximum, not the wire size: the text is NUL-terminated and zero-padded to a
   * 4-byte boundary (the dictionary's `STRING` fields, e.g. ICOMCONFIG's `endpoint`).
   */
  variable?: boolean;
}

export interface EdieArray {
  name: string;
  kind: 'array';
  offset: number;
  /** Bytes of the element-count prefix (0 for fixed-length arrays). */
  countSize: number;
  fixedCount?: number;
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
      return dv.getUint8(at);
    case 'u16':
      return dv.getUint16(at, true);
    case 'u32':
    case 'enum':
    case 'satid':
      return at + 4 > dv.byteLength ? 0 : dv.getUint32(at, true);
    case 'i32':
      return at + 4 > dv.byteLength ? 0 : dv.getInt32(at, true);
    case 'f32':
      return at + 4 > dv.byteLength ? 0 : dv.getFloat32(at, true);
    case 'f64':
      return at + 8 > dv.byteLength ? 0 : dv.getFloat64(at, true);
    case 'bool':
      return at + 4 > dv.byteLength ? 0 : dv.getUint32(at, true);
    default:
      return dv.getUint8(at);
  }
}

function readString(dv: DataView, at: number, size: number): string {
  let out = '';
  for (let i = 0; i < size; i++) {
    const byte = at + i;
    if (byte >= dv.byteLength) break;
    const value = dv.getUint8(byte);
    if (value === 0) break;
    out += String.fromCharCode(value);
  }
  return out;
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
  segments: EdieSegment[],
  base: number,
  prefix: string,
  out: EdieValue[],
  tables: EdieTables,
): void {
  for (const segment of segments) {
    const at = base + segment.offset;
    if (segment.kind === 'string') {
      const hex = String(segment.format ?? '').endsWith('Z');
      const text = hex ? readHexBytes(dv, at, segment.size) : readString(dv, at, segment.size);
      out.push({ name: segment.name, path: `${prefix}${segment.name}`, value: text, text });
      continue;
    }
    if (segment.kind === 'scalar') {
      const value = readScalar(dv, segment.type, at);
      const text = renderScalar(segment, value, tables);
      out.push({ name: segment.name, path: `${prefix}${segment.name}`, value, ...(text === undefined ? {} : { text }) });
      continue;
    }
    // array
    const declared = segment.fixedCount !== undefined
      ? segment.fixedCount
      : segment.countSize
        ? Number(readScalar(dv, 'u32', at))
        : 0;
    const first = at + segment.countSize;
    const capacity = segment.stride > 0 ? Math.floor(Math.max(0, dv.byteLength - first) / segment.stride) : 0;
    const count = Math.max(0, Math.min(declared, capacity));
    if (segment.countSize) out.push({ name: `${segment.name}.count`, path: `${prefix}${segment.name}.count`, value: declared, text: String(declared), isCount: true });
    for (let i = 0; i < count; i++) {
      decodeSegments(dv, segment.elements, first + i * segment.stride, `${prefix}${segment.name}[${i}].`, out, tables);
    }
  }
}

/** Decode one payload into the field sequence the ASCII encoder prints. */
export function decodeEdie(payload: Uint8Array, layout: EdieLayout, tables: EdieTables): EdieValue[] {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: EdieValue[] = [];
  decodeSegments(dv, layout.fields, 0, '', out, tables);
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
