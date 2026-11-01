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
import {
  alignUp,
  denseSegmentSize,
  packedSegmentSize,
  readStringField,
  segmentAlignment,
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

function integer(value: number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(Math.trunc(value));
}

/**
 * A 64-bit integer from whatever the reader (or a parsed text token) handed us.
 *
 * A `bigint` is exact. A decimal **string** is parsed as a bigint so `18446744073709551615` from a
 * `#` record survives; anything else (a `number`, already lossy, or a form `BigInt` rejects) falls
 * back through `Number`.
 */
export function toBigInt(value: number | string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim());
    } catch {
      const number = Math.trunc(Number(value));
      return BigInt(Number.isFinite(number) ? number : 0);
    }
  }
  return BigInt(Math.trunc(Number.isFinite(value) ? value : 0));
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
export function formatField(segment: EdieScalar, value: number | string | bigint, tables: EdieTables): string {
  const format = parseFormat(segment.format);
  if (format?.spec === 'm') return messageName(Number(value), tables);
  if (segment.enum) {
    const table = tables.enums[segment.enum];
    if (table && (typeof value === 'number' || typeof value === 'bigint')) {
      const name = table.values[String(value)];
      if (name !== undefined) return name;
      // A value outside the table always prints `UNKNOWN` — not the number, and not only when the
      // enum happens to declare an `UNKNOWN` member: `PORTSTATS` lists ports 53/65..68 past the end
      // of `CommPort` and the suite writes `UNKNOWN` for every one of them, and BESTUTM's
      // `datum_id` (the `Datum` table starts at 1 and has no `UNKNOWN` member) prints `UNKNOWN`
      // for 0, 999 and 0xffffffff, measured through Convert.
      return 'UNKNOWN';
    }
  }
  if (segment.type === 'bool') return value ? 'TRUE' : 'FALSE';
  // `%llu` / `%lld` are the only conversions wider than a double's integer range, and the suite
  // prints them **exactly**: a synthetic `FILESYSTEMCAPACITY` carrying 9007199254740993 (2^53 + 1)
  // and 18446744073709551615 prints both digit for digit, and `INSPVACMP` prints
  // `-9223372036854775808` for -2^63. A JS `number` cannot hold either, so these two stay `bigint`
  // end to end (`readScalar` returns one, `BigInt()` recovers one from a text token).
  if (format && format.length === 'll' && (format.spec === 'u' || format.spec === 'd')) {
    return integer(toBigInt(value));
  }
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
    //
    // The declared width is a *minimum*: `%02X` on a ULONG still fills the four bytes
    // (J1939CONFIG's `preferred_address` prints `0000001c`, not `1c`).
    case 'x':
    case 'X':
      return hex(number, Math.max(width, (segment.size || 4) * 2));
    case 'XB':
      return hex(number & 0xff, Math.max(width, 2));
    // `%B` — a CHAR printed as a number in hex with **no** zero padding: BESTXYZ's
    // `char_as_int` is `0` in the golden, and our `width || 2` used to make it `00`
    // (25 BESTXYZ lines in `b1-20261101.sbf`). `%02XB` keeps its padding, so only the
    // bare `%B` changes.
    case 'B':
      return hex(number & 0xff, width);
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
    // `%T` — a millisecond counter printed as **seconds with three decimals**. Measured on a
    // synthetic CLOCKMODEL/RAWALM/GLOALMANAC/GLORAWEPHEM/GALALMANAC capture fed to the suite's own
    // Convert: 0 → `0.000`, 1 → `0.001`, 999 → `0.999`, 91818000 → `91818.000`, 4294967295 →
    // `4294967.295`, 123456789 → `123456.789`. No week is involved and no exponent form exists, so
    // it is a plain `%.3f` of `ms / 1000` — `exactFixed` keeps the half-even rounding `printf` uses.
    case 'T':
      return exactFixed(number / 1000, 3);
    // `%c` — the low byte printed as one **raw character**, unquoted and unescaped: BESTUTM's
    // `zone_letter` (a ULONG) prints `A` for 65, `z` for 122, a literal 0x00 byte for 0 and 256,
    // 0x7f for 127, 0xc8 for 200, 0xff for 255 and 0xff for 0xffffffff. Nothing is added around it,
    // so the line may carry a non-printable byte (`golden` files never do: a zone letter is A..Z).
    case 'c':
      return String.fromCharCode(number & 0xff);
    default:
      return String(value);
  }
}

/**
 * A rendered token string as the wire holds it: **one byte per character** below U+0100.
 *
 * Every `#…*crc` checksum in this package is taken over the record's own bytes, and those bytes are
 * latin-1, not UTF-8: `%c` prints `String.fromCharCode(byte)`, so a zone letter of 0xC8 is the
 * single byte `C8`. Hashing the JS string with `TextEncoder` would hash `C3 88` instead — the line
 * bytes then match the suite while the checksum does not (measured: suite `a59003d5` for 0xC8,
 * `TextEncoder` `4d302fbb`). Characters at or above U+0100 cannot come out of a byte-oriented
 * writer; they fall back to their UTF-8 bytes so the hash is at least defined.
 */
export function latin1Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x100) out.push(code);
    else for (const byte of new TextEncoder().encode(char)) out.push(byte);
  }
  return Uint8Array.from(out);
}

/**
 * `%P` — a pass-through payload copied out **escaped**, as one token: bytes 0x20..0x7E print
 * verbatim except `\` (0x5C) which doubles, and everything else becomes `\xNN` in lowercase hex.
 *
 * Measured on a synthetic PASSCOM1 capture (all 256 byte values in one frame, fed to the suite):
 * 0x00-0x1F become `\xnn`, then 0x20-0x7E print verbatim (with `\` doubled), then 0x7F-0xFF become
 * `\xnn` again. So a payload's own commas and `*` are **not** escaped (`a,b;c*d` stays `a,b;c*d`) —
 * the element count in front of it is what delimits the field — but a CR/LF is (`ab\r\ncd` →
 * `ab\x0d\x0acd`), which is why a payload can never break the line.
 */
export function escapePassThrough(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[at + i] ?? 0;
    if (byte >= 0x20 && byte <= 0x7e) out += byte === 0x5c ? '\\\\' : String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * The field list with the offsets the wire actually uses: `pack(4)`.
 *
 * The offsets in `edie-layouts.json` are **dense** — the generator summed the declared field widths
 * — while an SBF payload is a C struct compiled with `#pragma pack(4)`. `edie.ts#segmentAlignment`
 * owns the geometry (`STRING`/`%Z` is a char array and aligns to 1, an array aligns like its count
 * prefix or its first element, nothing is tail-padded), and this function applies it to the stored
 * offsets.
 *
 * It used to apply the correction only when the record's payload length happened to equal the
 * aligned size, i.e. only for the two layouts (`GLOCLOCK`, `RAWGPSSUBFRAME`) where a capture proved
 * it. That was a guess dressed as a rule: Convert reads a payload at **fixed** offsets and cannot
 * vary them by length, and the suite's own Convert reproduces `pack(4)` offsets for every layout we
 * can synthesise a record for (see §9.x.14 of `03_分析/09_EDIE消息字典与ASCII一致性.md`: all 15
 * fixed layouts whose dense size differs from the packed one, plus `USERI2CREAD`, `USERCANDATA` and
 * `FILESYSTEMCAPACITY` for counted arrays). So it is applied unconditionally now.
 *
 * A segment whose width the table cannot know stops the rewrite: that is a counted array (whose
 * count is on the wire) or a `variable` `STRING` (whose `arrayLength` is only a maximum). The
 * segment itself still gets its aligned offset — that is what moves `USERI2CREAD`'s register array
 * from 1 to 4 — but everything behind it keeps the stored dense offset, because there the reader
 * places fields from the running cursor plus the measured drift (`shift` in the two writers), and
 * that arithmetic is defined against the dense offsets:
 *
 *   SURVEYPOSITION  option@0, id(variable, declared 5)@4, latitude declared@9
 *   `"abc\0"` takes 4 bytes → the suite prints latitude from 4 + 4 + (9 - 5 - 4) … = **8**
 *
 * Mixing an aligned offset with a dense-relative shift is what made this wrong: rewriting `9 → 12`
 * and then shifting by `-1` reads 11, one byte into the double.
 */
const WIRE_FIELDS = new WeakMap<EdieLayout, { raw: readonly EdieSegment[]; fields: EdieSegment[] }>();

export function wireFields(layout: EdieLayout): EdieSegment[] {
  const cached = WIRE_FIELDS.get(layout);
  if (cached && cached.raw === layout.fields) return cached.fields;
  const fields: EdieSegment[] = [];
  let cursor = 0;
  let changed = false;
  for (let index = 0; index < layout.fields.length; index++) {
    const segment = layout.fields[index] as EdieSegment;
    cursor = alignUp(cursor, segmentAlignment(segment));
    if (cursor !== segment.offset) changed = true;
    fields.push(cursor === segment.offset ? segment : { ...segment, offset: cursor });
    const size = packedSegmentSize(segment);
    if (size === null || (segment.kind === 'string' && segment.variable)) {
      for (let rest = index + 1; rest < layout.fields.length; rest++) fields.push(layout.fields[rest] as EdieSegment);
      break;
    }
    cursor += size;
  }
  const result = changed ? fields : layout.fields;
  WIRE_FIELDS.set(layout, { raw: layout.fields, fields: result });
  return result;
}


function readScalar(bytes: Uint8Array, type: string, at: number, size: number): number | bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = view.byteLength;
  const need = size > 0 ? size : type === 'f64' ? 8 : type === 'u8' ? 1 : type === 'u16' ? 2 : 4;
  if (at < 0 || at + need > available) return 0;
  switch (type) {
    // The dictionary spells its integers several ways and the extracted table kept the spelling:
    // `UCHAR`/`HEXBYTE` are 1 byte, `USHORT`/`SHORT` 2, `ULONG`/`LONG`/`INT`/`UINT` 4,
    // `ULONG64`/`LONGLONG` 8. Reading an unknown one as a byte is what made GALINAVEPHEMERIS print
    // `192` where the suite prints `81600` (the low byte of `toe`), so the widths are explicit here
    // rather than falling through to `getUint8`.
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
    case 'f32':
      return view.getFloat32(at, true);
    case 'f64':
      return view.getFloat64(at, true);
    case 'longlong':
      return view.getBigInt64(at, true);
    case 'ulonglong':
      return view.getBigUint64(at, true);
    default:
      return view.getUint8(at);
  }
}

/** Element-count prefix: u8/u16/u32, as `arrayLengthFieldSize` declares it. */
function readCount(bytes: Uint8Array, at: number, size: number): number {
  if (size === 1) return bytes[at] ?? 0;
  if (size === 2) return Number(readScalar(bytes, 'u16', at, 2));
  return Number(readScalar(bytes, 'u32', at, 4));
}

/** Per-record bookkeeping for the `%R` rule above. */
interface RenderState {
  /** Set when an embedded message could not be resolved; the record is then dropped. */
  unresolvedEmbedded: boolean;
}

function renderSegments(
  bytes: Uint8Array,
  segments: EdieSegment[],
  base: number,
  tables: EdieTables,
  out: string[],
  depth: number,
  options: AsciiLogOptions,
  state: RenderState,
): void {
  // A segment the table cannot place (`dynamicOffset`) starts where the previous one ended, rounded
  // up to its own `pack(4)` alignment; every other one starts at its stored offset plus the drift
  // the variable-width segments introduced. `shift` reproduces the offsets exactly for the layouts
  // the goldens already agree on (`SETNAV`, `ICOMCONFIG`, `DNSCONFIG`), `cursor` is what IPSTATUS'
  // `dns_server` needs — and the rounding is what puts `USERI2CREAD`'s `request_length` at 12 behind
  // a one-byte register (8 + 1 = 9 → 12, measured against the suite).
  let shift = 0;
  let cursor = 0;
  for (const segment of segments) {
    const at = base + (segment.dynamicOffset ? alignUp(cursor, segmentAlignment(segment)) : segment.offset + shift);
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
      const before = out.length;
      // **Only the first embedded record is converted.** Measured 2026-11-01: a #128 payload holding
      // two BESTPOS frames makes the suite print one line (301 chars, the first record); ours printed
      // both (523). The extra record is not even counted as unknown bytes — the `.UNKNOWN` file stays
      // empty — so the suite simply stops after the first embedded SBF record.
      const embedded = [...new SbfDeframer({ crcMode: 'mirror' }).push(bytes.subarray(start))]
        .find((inner) => inner.kind === 'sbf');
      if (embedded && embedded.kind === 'sbf') {
        const layout = tables.messages[String(embedded.header.messageId)];
        if (layout) out.push(render(embedded, layout, tables, { ...options, requireValidCrc: false, invertCrc: true }, depth + 1));
      }
      // An `%R` we cannot resolve drops the **whole record**: 22 of the 278 RXCONFIG frames in
      // `b1-20261101.sbf` embed a message the dictionary does not have (ids 229, 817, 1436, 1464,
      // 1471, 1524, 1525, 1552, 1555, 1606, 1790, 1799, 1856, 1857, 1860, 1870, 1871, 2036, 2636),
      // and the suite writes no line for them at all — not a line with an empty body. The same rule
      // gives 256 RXCONFIG records in both ASCII and ABBREV output.
      if (out.length === before) state.unresolvedEmbedded = true;
      continue;
    }
    if (segment.kind === 'string') {
      const raw = segment as EdieString;
      if (String(raw.format ?? '').endsWith('Z')) {
        // `%Z`: raw bytes as lowercase hex, never quoted (RAWEPHEM subframes).
        out.push(Array.from({ length: raw.size }, (_, i) => (bytes[at + i] ?? 0).toString(16).padStart(2, '0')).join(''));
        cursor = at + raw.size - base;
        continue;
      }
      out.push(`"${readStringField(bytes, at, raw)}"`);
      // A `STRING` field runs to a NUL and is zero-padded to a 4-byte boundary; `arrayLength` is
      // only a maximum, and the padding wins even when it exceeds it: SETNAV declares
      // `from_point` as 6 bytes but the wire spends 8 on `"FROM"`, so `to_point` starts at 48.
      const size = segmentWireSize(bytes, segment, at);
      cursor = at + size - base;
      if (raw.variable) shift += size - raw.size;
      continue;
    }
    if (segment.kind === 'scalar') {
      out.push(formatField(segment, readScalar(bytes, segment.type, at, segment.size), tables));
      cursor = at + segment.size - base;
      continue;
    }
    const array = segment as EdieArray;
    // `%P` — the whole payload is one pass-through token, not one number per byte (all 29 PASS*
    // logs). The declared element count is printed first, then the escaped bytes.
    //
    // The suite reads exactly `count` bytes whatever the payload holds — a frame declaring 10 bytes
    // and carrying 3 prints `abc` plus the frame's CRC bytes and then zeros past the end of the
    // allocation (measured), and a count of 0xffffffff makes Convert crash outright. We stop at the
    // end of the payload instead of reading past it: for a well-formed record (`count` inside the
    // payload, which is every record a receiver writes) the two agree byte for byte.
    if (String(array.format ?? '') === '%P') {
      if (at + array.countSize > bytes.byteLength) continue;
      const count = array.countSize ? readCount(bytes, at, array.countSize) : 0;
      out.push(String(count));
      const start = at + array.countSize;
      const available = Math.max(0, bytes.byteLength - start);
      out.push(escapePassThrough(bytes, start, Math.min(Math.max(0, count), available)));
      continue;
    }
    // `%Z` — a counted array of bytes is **one** lowercase hex token, not one decimal number per
    // element. `USERI2CREAD`'s three registers `de ad be` print as `deadbe`, and a zero count prints
    // an empty token, i.e. two commas in a row (`…,42,0,,7,4660`). Measured on synthetic
    // `USERI2CREAD` / `USERCANDATA` frames through the suite's own Convert: 257 registers of
    // `a0 a1 …` come out as one 514-character token, and `USERCANDATA`'s `de ad be` as `deadbe`.
    if (String(array.format ?? '') === '%Z') {
      if (array.countSize && at + array.countSize > bytes.byteLength) continue;
      const declared = array.countSize
        ? readCount(bytes, at, array.countSize)
        : (array.fixedCount ?? 0);
      if (array.countSize) out.push(String(declared));
      const start = at + (array.countSize || 0);
      const count = Math.max(0, Math.min(declared, Math.max(0, bytes.byteLength - start)));
      out.push(Array.from({ length: count }, (_, i) => (bytes[start + i] ?? 0).toString(16).padStart(2, '0')).join(''));
      cursor = start + count - base;
      shift += (array.countSize || 0) + count - denseSegmentSize(segment);
      continue;
    }
    // A count field that is not inside the payload prints nothing at all — GLORAWEPHEM synthesised
    // without its `glo_raw_ephem` array (payload ending right after `milliseconds`) comes out as
    // `…,2402,91818.000*…`, while a count that is present but zero (RAWALM with no pages) prints
    // `…,91818.000,0`. Measured with the suite's Convert on both shapes.
    const walk = walkArray(bytes, array, at);
    if (array.countSize) {
      if (!walk.inPayload) continue;
      out.push(String(walk.declared));
    }
    // Element positions come from `walkArray`: for a plain array that is `first + i * stride`, and
    // for one whose elements carry a variable string it is where the previous element really
    // ended (DNSCONFIG's one address is 12 bytes, not the declared 16).
    for (let i = 0; i < walk.count; i++) renderSegments(bytes, array.elements, walk.starts[i], tables, out, depth, options, state);
    // Everything behind a counted array moves by as much as the array differs from what the stored
    // offsets assumed; that is how `IPSTATUS`' `dns_server` lands on 52 instead of 4.
    cursor = at + walk.size - base;
    shift += walk.size - denseSegmentSize(segment);
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
  const state: RenderState = { unresolvedEmbedded: false };
  renderSegments(payload, wireFields(layout), 0, tables, body, depth, options, state);
  // `%R` with nothing to print drops the record (see the note in `renderSegments`).
  if (state.unresolvedEmbedded) return '';

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
  const value = novatelCrc32(latin1Bytes(sentence));
  const crc = hex(options.invertCrc ? (value ^ 0xffffffff) >>> 0 : value, 8);
  return `#${sentence}*${crc}`;
}
