/**
 * ASCII log writer: rebuild the exact line the suite prints for one binary log.
 *
 *   #<NAME><ver>,<port>,<seq>,<idle>,<timeStatus>,<week>,<ms>,<rxStatus>,<msgDefCrc>,<swVersion>;<fields>*<crc>
 *
 * Every piece is already in the data:
 *  - header fields come straight from the SBF long header (`header.ts`); the ASCII port is
 *    `SPECIAL_<n>` with `n = portAddress - 160` (188 → `SPECIAL_28`, 189 → `SPECIAL_29`, the two
 *    virtual log groups this capture used);
 *  - the body is the EDIE field list, rendered with the dictionary's conversion strings;
 *  - the trailing CRC is the NovAtel CRC-32 (poly 0xEDB88320, init 0, xorout 0) over the sentence
 *    **without** the leading `#` and without `*crc` — verified against the golden file.
 *
 * Acceptance: `packages/protocol/test/ascii-log.test.ts` re-encodes a whole capture and demands the
 * golden file byte for byte.
 */

import { novatelCrc32 } from './crc.ts';
import type { EdieArray, EdieLayout, EdieScalar, EdieSegment, EdieString, EdieTables } from './edie.ts';
import type { SbfFrame } from './framing.ts';

/** `20`→`UNKNOWN`, `180`→`FINESTEERING` — `01_解包/app/model/bestpos.js` (`timeStatusJSON`). */
export const TIME_STATUS_NAMES: Record<number, string> = {
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

export function portName(address: number): string {
  // 0xA0 + n: the receiver's virtual ports, which is what the suite labels SPECIAL_28 / SPECIAL_29.
  return address >= 0xa0 ? `SPECIAL_${address - 0xa0}` : String(address);
}

interface FormatSpec {
  width: number;
  precision?: number;
  length: string;
  spec: string;
}

function parseFormat(format: string | null | undefined): FormatSpec | undefined {
  const match = /^%(\d*)(?:\.(\d+))?(l{0,2})([A-Za-z]{1,2})$/.exec(format ?? '');
  if (!match) return undefined;
  return {
    width: match[1] ? Number(match[1]) : 0,
    precision: match[2] === undefined ? undefined : Number(match[2]),
    length: match[3],
    spec: match[4],
  };
}

function hex(value: number, width: number, upper: boolean): string {
  const text = (value >>> 0).toString(16);
  const padded = text.padStart(width, '0');
  return upper ? padded.toUpperCase() : padded;
}

/**
 * `printf("%.Nf")` rounding, not `Number.toFixed`: the suite rounds the *exact* binary value with
 * round-half-even (a value of -2491.5625 prints as `-2491.562`), whereas `toFixed` rounds ties away
 * from zero and `Intl.NumberFormat` rounds the shortest decimal form (which drifts by one in the last
 * printed digit for values like -188869500.7499495).
 *
 * The double is decomposed into `mantissa × 2^exp` and the fraction is expanded exactly in decimal
 * (`frac × 5^k` over `k` digits), then rounded. That is what `printf` does.
 */
function decompose(value: number): { negative: boolean; mantissa: bigint; exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = (high >>> 31) === 1;
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (biased === 0) return { negative, mantissa, exp: -1074 };
  mantissa |= 1n << 52n;
  return { negative, mantissa, exp: biased - 1075 };
}

const POW5: bigint[] = [];
function pow5(n: number): bigint {
  if (POW5[n] === undefined) POW5[n] = 5n ** BigInt(n);
  return POW5[n];
}

function roundHalfEven(digits: string, keep: number): string {
  if (keep >= digits.length) return digits.padEnd(keep, '0');
  let kept = digits.slice(0, keep);
  const rest = digits.slice(keep);
  const first = rest[0];
  const tail = rest.slice(1);
  let roundUp = false;
  if (first > '5') roundUp = true;
  else if (first === '5') {
    if (/[1-9]/.test(tail)) roundUp = true;
    else {
      const last = kept.length ? kept[kept.length - 1] : '0';
      roundUp = Number(last) % 2 === 1;
    }
  }
  if (!roundUp) return kept;
  let i = kept.length - 1;
  const out = kept.split('');
  while (i >= 0) {
    if (out[i] === '9') {
      out[i] = '0';
      i -= 1;
    } else {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
  }
  return `1${out.join('')}`;
}

/** `printf("%.<digits>f", value)` on the exact binary value. */
export function exactFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value);
  const { negative, mantissa, exp } = decompose(value);
  const sign = negative ? '-' : '';
  if (exp >= 0) {
    const whole = (mantissa << BigInt(exp)).toString();
    return `${sign}${whole}${digits ? `.${'0'.repeat(digits)}` : ''}`;
  }
  const k = -exp;
  const whole = mantissa >> BigInt(k);
  const frac = mantissa - (whole << BigInt(k));
  const fraction = roundHalfEven((frac * pow5(k)).toString().padStart(k, '0'), digits);
  // Rounding can carry into the integer part (`9.999…` → `10.000`).
  if (fraction.length > digits) {
    const carried = (whole + 1n).toString();
    return `${sign}${carried}${digits ? `.${'0'.repeat(digits)}` : ''}`;
  }
  return `${sign}${whole.toString()}${digits ? `.${fraction}` : ''}`;
}

function integer(value: number): string {
  return String(Math.trunc(value));
}

/** Render one scalar the way the suite's ASCII encoder does. */
export function formatField(segment: EdieScalar, value: number | string, tables: EdieTables): string {
  if (segment.enum) {
    const table = tables.enums[segment.enum];
    if (table && typeof value === 'number') {
      const name = table.values[String(value)];
      if (name !== undefined) return name;
    }
  }
  if (segment.type === 'bool') return value ? 'TRUE' : 'FALSE';
  const format = parseFormat(segment.format);
  const number = Number(value);
  if (!format) return String(value);
  const { width, precision, spec } = format;
  switch (spec) {
    case 's':
      return `"${String(value)}"`;
    case 'u':
    case 'hu':
    case 'lu':
    case 'llu':
      return integer(number);
    case 'd':
    case 'hd':
    case 'ld':
    case 'lld':
    case 'id':
      return integer(number);
    case 'x':
      return hex(number, width || 8, false);
    case 'X':
      return hex(number, width || 8, true);
    case 'XB':
      return hex(number & 0xff, width || 2, true);
    case 'B':
      return hex(number & 0xff, width || 2, false);
    case 'UB':
      return String(Math.trunc(number) & 0xff);
    case 'f':
    case 'lf':
      return exactFixed(number, precision ?? 6);
    case 'e':
      return number.toExponential(precision ?? 6);
    case 'k':
    case 'lk':
    case 'llk': {
      // `%7.4lk` prints 0.0124 in fixed notation; below 1e-4 it switches to `5.221136984e-10`
      // (the `%g` exponent rule). It does *not* depend on the decimal count: 5.26e-4 at 3 decimals
      // still prints 0.001, not an exponent form.
      const decimals = precision ?? 3;
      if (number !== 0 && Math.abs(number) < 1e-4) return number.toExponential(decimals);
      return exactFixed(number, decimals);
    }
    default:
      return String(value);
  }
}

function decodeString(bytes: Uint8Array, at: number, size: number): string {
  let out = '';
  for (let i = 0; i < size; i++) {
    const byte = bytes[at + i];
    if (byte === undefined || byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function readScalar(bytes: Uint8Array, type: string, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = view.byteLength;
  const need = type === 'f64' ? 8 : type === 'u8' ? 1 : type === 'u16' ? 2 : 4;
  if (at < 0 || at + need > available) return 0;
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

function renderSegments(
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  tables: EdieTables,
  out: string[],
): void {
  for (const segment of segments) {
    const at = base + segment.offset;
    if (segment.kind === 'string') {
      const raw = segment as EdieString;
      if (String(raw.format ?? '').endsWith('Z')) {
        // `%Z`: raw bytes as lowercase hex, never quoted (RAWEPHEM subframes).
        out.push(Array.from({ length: raw.size }, (_, i) => (bytes[at + i] ?? 0).toString(16).padStart(2, '0')).join(''));
      } else {
        out.push(`"${decodeString(bytes, at, raw.size)}"`);
      }
      continue;
    }
    if (segment.kind === 'scalar') {
      out.push(formatField(segment, readScalar(bytes, segment.type, at), tables));
      continue;
    }
    const array = segment as EdieArray;
    const stride = array.stride || 1;
    const declared = array.fixedCount !== undefined
      ? array.fixedCount
      : array.countSize
        ? readScalar(bytes, 'u32', at)
        : 0;
    if (array.countSize) out.push(String(declared));
    const first = at + array.countSize;
    const capacity = Math.floor(Math.max(0, bytes.byteLength - first) / stride);
    const count = Math.max(0, Math.min(declared, capacity));
    for (let i = 0; i < count; i++) renderSegments(bytes, array.elements, first + i * stride, tables, out);
  }
}

export interface AsciiLogOptions {
  /** Appended to the message name (`TIMEA`); all OEM7 logs in the captures use `A`. */
  versionLetter?: string;
  /**
   * Skip records whose CRC field does not match (default true). Convert validates the CRC and drops
   * the record; the view parser (`genericparser.js`) only drops records whose CRC field is zero, so
   * the two subsystems differ on exactly this point (one RANGE frame in `broad-clean.gps`).
   */
  requireValidCrc?: boolean;
}

/** Encode one decoded frame as the suite's ASCII log line (without line ending unless asked). */
export function encodeAsciiLog(
  frame: SbfFrame,
  layout: EdieLayout,
  tables: EdieTables,
  options: AsciiLogOptions = {},
): string {
  if (frame.kind !== 'sbf') return '';
  if ((options.requireValidCrc ?? true) && !frame.crcOk) return '';
  const { header, payload } = frame;
  const body: string[] = [];
  renderSegments(payload, layout.fields, 0, tables, body);

  const head = [
    `${layout.name}${options.versionLetter ?? 'A'}`,
    portName(header.portAddress),
    String(header.sequence),
    (header.idleTimeRaw / 2).toFixed(1),
    TIME_STATUS_NAMES[header.timeStatus] ?? String(header.timeStatus),
    String(header.week),
    `${Math.floor(header.milliseconds / 1000)}.${String(header.milliseconds % 1000).padStart(3, '0')}`,
    hex(header.receiverStatus, 8, false),
    hex(header.reserved, 4, false),
    String(header.softwareVersion),
  ].join(',');

  const sentence = `${head};${body.join(',')}`;
  const crc = hex(novatelCrc32(new TextEncoder().encode(sentence)), 8, false);
  return `#${sentence}*${crc}`;
}
