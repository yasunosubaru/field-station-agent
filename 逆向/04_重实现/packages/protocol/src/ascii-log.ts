/**
 * ASCII log writer: rebuild the exact line the suite prints for one binary log.
 *
 *   #<NAME><ver>,<port>,<seq>,<idle>,<timeStatus>,<week>,<ms>,<rxStatus>,<msgDefCrc>,<swVersion>;<fields>*<crc>
 *
 * Every piece is already in the data:
 *  - header fields come straight from the SBF long header (`header.ts`); the ASCII port is the
 *    name the dictionary's `PortAddress` enum gives that address (see `portName`);
 *  - the body is the EDIE field list, rendered with the dictionary's conversion strings;
 *  - the trailing CRC is the NovAtel CRC-32 (poly 0xEDB88320, init 0, xorout 0) over the sentence
 *    **without** the leading `#` and without `*crc` — verified against the golden file.
 *
 * Acceptance: `packages/protocol/test/ascii-log.test.ts` re-encodes a whole capture and demands the
 * golden file byte for byte.
 */

import { novatelCrc32 } from './crc.ts';
import type { EdieArray, EdieLayout, EdieScalar, EdieSegment, EdieString, EdieTables } from './edie.ts';
import { SbfDeframer, type SbfFrame } from './framing.ts';

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

/**
 * Port names, from the dictionary's `PortAddress` enum (`messages_public.json`, 1552 entries).
 *
 * It is a regular table, not an offset from 0xA0: every port group owns a block of 32 addresses,
 * `base + 0` is the group itself (`COM1`, `USB`, `SPECIAL`, `FILE`, `USB2`, …) and `base + n` is
 * `GROUP_n` (`SPECIAL_28` for 188, `SPECIAL_29` for 189). Addresses 0..31 are the sparse `*_ALL`
 * aggregates, which do not follow the block rule. Everything else the suite prints as the number.
 *
 * Note the boundary: 160 (`0xA0`) is plain `SPECIAL`, **not** `SPECIAL_0`; `SPECIAL_n` starts at
 * 161, i.e. the old `address - 0xA0` formula was off by one at exactly 0xA0.
 */
const PORT_GROUPS: Record<number, string> = {
  32: 'COM1', 64: 'COM2', 96: 'COM3', 128: 'USB', 160: 'SPECIAL', 192: 'THISPORT', 224: 'FILE',
  416: 'XCOM1', 672: 'XCOM2', 1440: 'USB1', 1696: 'USB2', 1952: 'USB3', 2208: 'AUX', 2464: 'XCOM3',
  2976: 'COM4', 3232: 'ETH1', 3488: 'IMU', 4000: 'ICOM1', 4256: 'ICOM2', 4512: 'ICOM3',
  4768: 'NCOM1', 5024: 'NCOM2', 5280: 'NCOM3', 5536: 'ICOM4', 5792: 'WCOM1',
  6048: 'COM5', 6304: 'COM6', 6560: 'BT1', 6816: 'COM7', 7072: 'COM8', 7328: 'COM9', 7584: 'COM10',
  7840: 'CCOM1', 8096: 'CCOM2', 8352: 'CCOM3', 8608: 'CCOM4', 8864: 'CCOM5', 9120: 'CCOM6',
  9376: 'CCOM7', 9632: 'CCOM8', 9888: 'ICOM5', 10144: 'ICOM6', 10400: 'ICOM7',
  10656: 'SCOM1', 10912: 'SCOM2', 11168: 'SCOM3', 11424: 'SCOM4',
};

/**
 * Named single addresses that do not follow the block rule: the sparse `*_ALL` aggregates.
 *
 * 0..31 holds the first generation (COM1_ALL … WCOM1_ALL); the ports that were added later put
 * their aggregates in a separate band, 5824..5845 (COM5_ALL … SCOM4_ALL).
 */
const PORT_EXACT_NAMES: Record<number, string> = {
  0: 'NO_PORTS',
  1: 'COM1_ALL', 2: 'COM2_ALL', 3: 'COM3_ALL', 4: 'USB_ALL', 6: 'THISPORT_ALL', 7: 'FILE_ALL',
  8: 'ALL_PORTS', 9: 'XCOM1_ALL', 10: 'XCOM2_ALL', 13: 'USB1_ALL', 14: 'USB2_ALL', 15: 'USB3_ALL',
  16: 'AUX_ALL', 17: 'XCOM3_ALL', 19: 'COM4_ALL', 20: 'ETH1_ALL', 21: 'IMU_ALL',
  23: 'ICOM1_ALL', 24: 'ICOM2_ALL', 25: 'ICOM3_ALL', 26: 'NCOM1_ALL', 27: 'NCOM2_ALL',
  28: 'NCOM3_ALL', 29: 'ICOM4_ALL', 30: 'WCOM1_ALL',
  5824: 'COM5_ALL', 5825: 'COM6_ALL', 5826: 'BT1_ALL', 5827: 'COM7_ALL', 5828: 'COM8_ALL',
  5829: 'COM9_ALL', 5830: 'COM10_ALL', 5831: 'CCOM1_ALL', 5832: 'CCOM2_ALL', 5833: 'CCOM3_ALL',
  5834: 'CCOM4_ALL', 5835: 'CCOM5_ALL', 5836: 'CCOM6_ALL', 5837: 'CCOM7_ALL', 5838: 'CCOM8_ALL',
  5839: 'ICOM5_ALL', 5840: 'ICOM6_ALL', 5841: 'ICOM7_ALL', 5842: 'SCOM1_ALL', 5843: 'SCOM2_ALL',
  5844: 'SCOM3_ALL', 5845: 'SCOM4_ALL',
};

export function portName(address: number): string {
  const exact = PORT_EXACT_NAMES[address];
  if (exact !== undefined) return exact;
  const base = address - (address % 32);
  const group = PORT_GROUPS[base];
  if (group === undefined) return String(address);
  const index = address % 32;
  return index === 0 ? group : `${group}_${index}`;
}

interface FormatSpec {
  width: number;
  /** False for `%.17lk` (no width token at all) — the `k` rule distinguishes that from `%0.2lk`. */
  hasWidth: boolean;
  precision?: number;
  length: string;
  spec: string;
}

function parseFormat(format: string | null | undefined): FormatSpec | undefined {
  const match = /^%(\d*)(?:\.(\d+))?(l{0,2})([A-Za-z]{1,2})$/.exec(format ?? '');
  if (!match) return undefined;
  return {
    width: match[1] ? Number(match[1]) : 0,
    hasWidth: match[1].length > 0,
    precision: match[2] === undefined ? undefined : Number(match[2]),
    length: match[3],
    spec: match[4],
  };
}

function hex(value: number, width: number): string {
  return (value >>> 0).toString(16).padStart(width, '0');
}

/**
 * `%m` — a log id printed as a name: the dictionary's name plus a version suffix, chosen by the
 * id's own flag bits.
 *
 * Measured on `golden-remote-23types.ASCII` (`LOGLISTA` lists 97 logs):
 *
 * | id                 | printed             |
 * |--------------------|---------------------|
 * | `41`               | `RAWEPHEMB`         |
 * | `2097246` = 1<<21+94 | `RXSTATUSEVENTA`  |
 * | `4194796` = 1<<22+492 | `TIMESYNC`       |
 *
 * So `1<<21` selects the ASCII flavour (`A`), `1<<22` selects the flavour that carries no suffix at
 * all (`TIMESYNC`, `BESTPOS`, `RANGE`, `RXSTATUS`, `SATVIS2`, `HWMONITOR`, `GLOEPHEMERIS`), and a
 * plain id is the binary log (`B`). Ids the dictionary does not know print `UNKNOWN<letter>`
 * (`LOGLISTA` lists 2075, which is not a message).
 */
const ID_ASCII = 0x200000;
const ID_PLAIN = 0x400000;

function messageName(id: number, tables: EdieTables): string {
  const base = id & ~(ID_ASCII | ID_PLAIN);
  const suffix = id & ID_PLAIN ? '' : id & ID_ASCII ? 'A' : 'B';
  return `${tables.messages[String(base)]?.name ?? 'UNKNOWN'}${suffix}`;
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

/**
 * `printf("%.<digits>e", value)` on the exact binary value.
 *
 * Same decomposition as `exactFixed`: a double is `mantissa × 2^exp`, so its decimal expansion is
 * finite and can be rounded exactly, half to even. `Number.toExponential` is not usable here — it
 * drops the sign of `-0.0`, and the suite prints `-0.00000000000000000e+00` for a negative zero
 * (GLO `gamma`), which costs nothing but is a byte.
 *
 * The exponent is always printed with an explicit sign and at least two digits (`e+07`, `e-09`),
 * as C's `%e` does; `toExponential` would give `e+7` / `e-9`.
 */
export function exactExponential(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value);
  const { negative, mantissa, exp } = decompose(value);
  const sign = negative ? '-' : '';

  // Exact decimal form: whole part plus the fraction digits (trailing zeros trimmed — they carry
  // no information and would only lengthen the significant-digit scan below).
  let whole: bigint;
  let fraction = '';
  if (exp >= 0) {
    whole = mantissa << BigInt(exp);
  } else {
    const k = -exp;
    whole = mantissa >> BigInt(k);
    const frac = mantissa - (whole << BigInt(k));
    fraction = (frac * pow5(k)).toString().padStart(k, '0').replace(/0+$/, '');
  }
  const wholeText = whole.toString();

  let exponent: number;
  let significant: string;
  if (whole > 0n) {
    exponent = wholeText.length - 1;
    significant = wholeText + fraction;
  } else {
    const first = fraction.search(/[1-9]/);
    if (first < 0) return `${sign}0.${'0'.repeat(digits)}e+00`;
    exponent = -(first + 1);
    significant = fraction.slice(first);
  }

  let kept = roundHalfEven(significant, digits + 1);
  if (kept.length > digits + 1) {
    // All nines carried: 9.99 → 10.0, one more digit in the exponent.
    exponent += 1;
    kept = kept.slice(0, digits + 1);
  }
  const expSign = exponent < 0 ? '-' : '+';
  const expDigits = String(Math.abs(exponent)).padStart(2, '0');
  return `${sign}${kept.slice(0, 1)}${digits ? `.${kept.slice(1)}` : ''}e${expSign}${expDigits}`;
}

/**
 * The `k` conversion, measured against the suite's own Convert (synthetic SBF captures swept
 * through `NovAtelApplicationSuite.exe -a`, one value per frame):
 *
 *  - `%W.Nlk` with a width `W > 0` prints fixed while `10^-W <= |v| <= 10^W`, else `%e`: the value
 *    is written out as long as it stays inside the field's declared magnitude window.
 *    `%9.1lk` (GPSEPHEM `toe`): 1e9 → `1000000000.0`, 1e10 → `1.0e+10`; `%7.9lk` (GLO
 *    `delta_tau`): 1e7 fixed, 1e8 exponent; `%2.11lk` (TIME `utc_offset`): 0.01 fixed, 0.001
 *    exponent.
 *  - `%0.Nlk` (flag form, `W` = 0 — every ephemeris field) collapses that window onto the single
 *    value `|v| == 1`: only 0 and ±1 print fixed, everything else is `%e`. Confirmed with
 *    `%0.2lk`, `%0.8lk`, `%0.9lk`, `%0.10lk` and `%0.16lk` over 0, ±1, 1.5, 2, 10, 0.5, 0.001,
 *    1e-6 … 1e11.
 *  - a conversion with no width at all (`%.17lk`, GLO position/velocity) is always `%e`, zero
 *    included — the suite prints `0.00000000000000000e+00` there and `-0.00000000000000000e+00`
 *    for a negative zero (GLO `gamma`).
 *  - with a width, `|v| == 0` always prints fixed, so an empty field reads `0.00`, not `0.00e+00`.
 *
 * The previous rule here ("exponent below 1e-4, like `%g`") only fitted values far from 1 and
 * printed the GLO ephemerides as fixed where the suite prints `-1.71685703125000000e+07`.
 *
 * Caveat, stated rather than papered over: the suite compares against its C library's
 * `pow(10, -W)`, which lands one ulp away from the exact power for a few exponents (a literal
 * `1e-7` and `1e-9` fall just outside its `%7` / `%9` window and print as exponents, while `1e-2`
 * is just inside `%2`). `Math.pow` is correctly rounded, so a value sitting exactly on a boundary
 * may differ in that single decision.
 */
function formatK(number: number, width: number, hasWidth: boolean, digits: number): string {
  if (!Number.isFinite(number)) return String(number);
  const magnitude = Math.abs(number);
  let fixed: boolean;
  if (!hasWidth) fixed = false;
  else if (magnitude === 0) fixed = true;
  else if (width === 0) fixed = magnitude === 1;
  else fixed = magnitude >= 10 ** -width && magnitude <= 10 ** width;
  return fixed ? exactFixed(number, digits) : exactExponential(number, digits);
}

/** Render one scalar the way the suite's ASCII encoder does. */
export function formatField(segment: EdieScalar, value: number | string, tables: EdieTables): string {
  const format = parseFormat(segment.format);
  if (format?.spec === 'm') return messageName(Number(value), tables);
  if (segment.enum) {
    const table = tables.enums[segment.enum];
    if (table && typeof value === 'number') {
      const name = table.values[String(value)];
      if (name !== undefined) return name;
      // Out-of-table values print as the dictionary's `UNKNOWN` member when the enum has one
      // (PORTSTATS lists ports 53/65..68, past the end of `CommPort`, and the suite writes
      // `UNKNOWN` for every one of them).
      if (Object.values(table.values).includes('UNKNOWN')) return 'UNKNOWN';
    }
  }
  if (segment.type === 'bool') return value ? 'TRUE' : 'FALSE';
  const number = Number(value);
  if (!format) return String(value);
  const { width, hasWidth, precision, spec } = format;
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
    // Hex prints lowercase whichever case the conversion string asks for: the dictionary spells
    // ITDETECTSTATUS's three severity words `%08X`, and the suite writes `00000000,00000000,0000000f`
    // (`golden-remote-23types.ASCII`) where uppercase would give `0000000F`. The two other `%08X`
    // fields (RADARSTATUS) and the `%02XB`/`%XB` ones have only ever been seen carrying digits, so
    // this rule is measured on ITDETECTSTATUS alone.
    case 'x':
    case 'X':
      return hex(number, width || 8);
    case 'XB':
      return hex(number & 0xff, width || 2);
    case 'B':
      return hex(number & 0xff, width || 2);
    case 'UB':
      return String(Math.trunc(number) & 0xff);
    case 'f':
    case 'lf':
      return exactFixed(number, precision ?? 6);
    case 'e':
      return exactExponential(number, precision ?? 6);
    case 'k':
    case 'lk':
    case 'llk':
      return formatK(number, width, hasWidth, precision ?? 3);
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

/** Element-count prefix: u8/u16/u32, as `arrayLengthFieldSize` declares it. */
function readCount(bytes: Uint8Array, at: number, size: number): number {
  if (size === 1) return bytes[at] ?? 0;
  if (size === 2) return readScalar(bytes, 'u16', at);
  return readScalar(bytes, 'u32', at);
}

function renderSegments(
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  tables: EdieTables,
  out: string[],
  depth: number,
  options: AsciiLogOptions,
): void {
  for (const segment of segments) {
    const at = base + segment.offset;
    // `%R` — an embedded binary message, printed as its own finished ASCII line (`RXCONFIGA` wraps
    // `#LOGA,…*<embedded crc>` and the outer CRC follows after it). Measured on
    // `golden-remote-23types.ASCII`: the RXCONFIG payload is a complete SBF frame whose payload is
    // `USB1,BESTPOSB,ONTIME,1.000000,0.000000,NOHOLD`.
    //
    // The embedded frame's own CRC field does not match (all four RXCONFIG frames in the capture
    // fail the check) and the suite prints a CRC it computes itself, one's-complemented — see
    // `AsciiLogOptions.invertCrc`. Hence `requireValidCrc: false, invertCrc: true` for it alone.
    if (String(segment.format ?? '') === '%R') {
      const start = segment.kind === 'array' ? at + (segment as EdieArray).countSize : at;
      if (depth >= 4) continue;
      for (const inner of new SbfDeframer({ crcMode: 'mirror' }).push(bytes.subarray(start))) {
        if (inner.kind !== 'sbf') continue;
        const layout = tables.messages[String(inner.header.messageId)];
        if (layout) out.push(render(inner, layout, tables, { ...options, requireValidCrc: false, invertCrc: true }, depth + 1));
      }
      continue;
    }
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
    const first = at + array.countSize;
    const capacity = Math.floor(Math.max(0, bytes.byteLength - first) / stride);
    // Three shapes: a fixed array prints no count; a counted array (`FIELD_ARRAY`, and
    // `VARIABLE_LENGTH_ARRAY` with an `arrayLengthFieldSize`) prints its count first; a
    // prefix-less variable array (RXCONFIG's `%R`, handled above) runs to the end of the payload.
    const declared = array.fixedCount !== undefined
      ? array.fixedCount
      : array.countSize
        ? readCount(bytes, at, array.countSize)
        : capacity;
    if (array.countSize) out.push(String(declared));
    const count = Math.max(0, Math.min(declared, capacity));
    for (let i = 0; i < count; i++) renderSegments(bytes, array.elements, first + i * stride, tables, out, depth, options);
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
  /**
   * Write `~crc` instead of `crc`. Only `%R`'s embedded line does this: all eight lines measured
   * (4 from `golden-remote-23types.ASCII`, 4 from a synthetic capture fed to the suite's own CLI)
   * carry the complement of the NovAtel CRC over their sentence, i.e. CRC-32/POSIX.
   */
  invertCrc?: boolean;
}

/** Encode one decoded frame as the suite's ASCII log line (without line ending unless asked). */
export function encodeAsciiLog(
  frame: SbfFrame,
  layout: EdieLayout,
  tables: EdieTables,
  options: AsciiLogOptions = {},
): string {
  return render(frame, layout, tables, options, 0);
}

function render(
  frame: SbfFrame,
  layout: EdieLayout,
  tables: EdieTables,
  options: AsciiLogOptions,
  depth: number,
): string {
  if (frame.kind !== 'sbf') return '';
  if ((options.requireValidCrc ?? true) && !frame.crcOk) return '';
  const { header, payload } = frame;
  const body: string[] = [];
  renderSegments(payload, layout.fields, 0, tables, body, depth, options);

  const head = [
    `${layout.name}${options.versionLetter ?? 'A'}`,
    portName(header.portAddress),
    String(header.sequence),
    (header.idleTimeRaw / 2).toFixed(1),
    TIME_STATUS_NAMES[header.timeStatus] ?? String(header.timeStatus),
    String(header.week),
    `${Math.floor(header.milliseconds / 1000)}.${String(header.milliseconds % 1000).padStart(3, '0')}`,
    hex(header.receiverStatus, 8),
    hex(header.reserved, 4),
    String(header.softwareVersion),
  ].join(',');

  const sentence = `${head};${body.join(',')}`;
  const value = novatelCrc32(new TextEncoder().encode(sentence));
  const crc = hex(options.invertCrc ? (value ^ 0xffffffff) >>> 0 : value, 8);
  return `#${sentence}*${crc}`;
}
