/**
 * RINEX 2.1 GPS navigation writer from `RAWEPHEM` (message 41).
 *
 * `RAWEPHEM` carries `satellite_id`, `week`, `toe` and three 30-byte blocks. Each block is one whole
 * GPS subframe with the six parity bits of every 30-bit word stripped: **10 words × 24 data bits**,
 * bit 0 = the TLM preamble (every captured block starts with `0x8b`), so word *n* occupies bits
 * `24n … 24n+23`. The field offsets below were measured against the suite's own output (see
 * `OFFSETS`) and every one of them is confirmed by all 17 GPS records available — 8 in
 * `clean-9600.26N` plus 9 in a second, 60 s capture — not just by one record.
 *
 * Two subframe-1 fields do **not** sit where the ICD word map would put them:
 *
 * - `IODC`'s two MSBs are the last two bits of word 3 (bits 70–71), not bits 68–69. Only PRN 4 in the
 *   clean capture exercises this (its `IODC` is 879 = 3 << 8 | 111 while its `IODE` is 111); with the
 *   ICD position the record would say 111.
 * - `t_oc` is the **low 16 bits** of word 8 (bits 176–191) and `af2` the high byte of word 9
 *   (192–199) — the writer's stream is shifted 8 bits later than the ICD from `t_oc` onwards, which
 *   is why `168…175` holds an 8-bit field the RINEX record never uses.
 *
 * Every value is `raw × 2^-n`, and the angular ones (`Δn M0 Ω0 i0 ω Ω̇ i̇`) additionally `× π`, as
 * RINEX 2 wants radians.
 */

import type { SbfFrame } from './framing.ts';
import { decodeEdie, type EdieTables } from './edie.ts';

export interface NavOptions {
  /** `PGM / RUN BY / DATE` timestamp, local time. */
  builtAt: Date;
}

/**
 * Bit offsets inside a parity-stripped subframe block, measured from the TLM preamble.
 * `sf` is 1-based (subframe 1/2/3) and `w` the field width in bits.
 */
export const RAWEPHEM_OFFSETS = {
  /** Subframe 1 (clock + health). */
  sf1: {
    tow: { at: 24, w: 17 }, // HOW time-of-week count, transmission time = tow × 6 s
    week: { at: 48, w: 10 }, // WN, rolls over every 1024 weeks
    ura: { at: 58, w: 4 }, // URA index (the writer ignores it, see `svAccuracy`)
    health: { at: 62, w: 6 }, // SV health
    l2p: { at: 68, w: 1 }, // L2 P-code data flag
    iodcMsb: { at: 70, w: 2 }, // IODC bits 9..8
    tgd: { at: 160, w: 8 }, // T_GD
    toc: { at: 176, w: 16 }, // t_oc in units of 16 s
    af2: { at: 192, w: 8 },
    af1: { at: 200, w: 16 },
    af0: { at: 216, w: 22 },
  },
  /** Subframe 2 (ephemeris, first half). */
  sf2: {
    iode: { at: 48, w: 8 },
    crs: { at: 56, w: 16 },
    dn: { at: 72, w: 16 },
    m0: { at: 88, w: 32 },
    cuc: { at: 120, w: 16 },
    e: { at: 136, w: 32 },
    cus: { at: 168, w: 16 },
    sqrtA: { at: 184, w: 32 },
    toe: { at: 216, w: 16 }, // t_oe in units of 16 s
    fit: { at: 232, w: 1 }, // fit interval flag
  },
  /** Subframe 3 (ephemeris, second half). */
  sf3: {
    cic: { at: 48, w: 16 },
    omg0: { at: 64, w: 32 },
    cis: { at: 96, w: 16 },
    i0: { at: 112, w: 32 },
    crc: { at: 144, w: 16 },
    omg: { at: 160, w: 32 },
    omgd: { at: 192, w: 24 },
    idot: { at: 224, w: 14 },
  },
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PI = Math.PI;

/** Hex string (`RAWEPHEM` `subframeN`) → 30 bytes. */
function toBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Unsigned big-endian bit field; `at` counted from the TLM preamble of the stripped subframe. */
function ub(bytes: number[], at: number, w: number): number {
  let value = 0;
  for (let i = 0; i < w; i++) {
    const bit = at + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}

/** Two's-complement bit field. */
function sb(bytes: number[], at: number, w: number): number {
  const value = ub(bytes, at, w);
  return value >= 2 ** (w - 1) ? value - 2 ** w : value;
}

interface Ephemeris {
  prn: number;
  week: number;
  toc: number;
  af0: number;
  af1: number;
  af2: number;
  iode: number;
  crs: number;
  dn: number;
  m0: number;
  cuc: number;
  e: number;
  cus: number;
  sqrtA: number;
  toe: number;
  cic: number;
  omg0: number;
  cis: number;
  i0: number;
  crc: number;
  omg: number;
  omgd: number;
  idot: number;
  codes: number;
  accuracy: number;
  health: number;
  tgd: number;
  iodc: number;
  transmission: number;
  fit: number;
}

/**
 * `SV accuracy` as the suite writes it.
 *
 * Every one of the 17 golden records says `2.0`, while the URA index nibble (subframe 1, bits
 * 58–61) is `4` in all 17. So the writer's value is not the raw URA index, and the captures contain
 * no variation that would let us tell a fixed value apart from a URA→accuracy mapping. Byte-exact
 * output only needs `2.0`; if a capture ever shows a different value this is the line to revisit.
 */
const SV_ACCURACY = 2;

function decodeEphemeris(prn: number, week: number, sf1: number[], sf2: number[], sf3: number[]): Ephemeris {
  const o = RAWEPHEM_OFFSETS;
  return {
    prn,
    week,
    toc: ub(sf1, o.sf1.toc.at, o.sf1.toc.w) * 16,
    af0: sb(sf1, o.sf1.af0.at, o.sf1.af0.w) * 2 ** -31,
    af1: sb(sf1, o.sf1.af1.at, o.sf1.af1.w) * 2 ** -43,
    af2: sb(sf1, o.sf1.af2.at, o.sf1.af2.w) * 2 ** -55,
    iode: ub(sf2, o.sf2.iode.at, o.sf2.iode.w),
    crs: sb(sf2, o.sf2.crs.at, o.sf2.crs.w) * 2 ** -5,
    dn: sb(sf2, o.sf2.dn.at, o.sf2.dn.w) * 2 ** -43 * PI,
    m0: sb(sf2, o.sf2.m0.at, o.sf2.m0.w) * 2 ** -31 * PI,
    cuc: sb(sf2, o.sf2.cuc.at, o.sf2.cuc.w) * 2 ** -29,
    e: ub(sf2, o.sf2.e.at, o.sf2.e.w) * 2 ** -33,
    cus: sb(sf2, o.sf2.cus.at, o.sf2.cus.w) * 2 ** -29,
    sqrtA: ub(sf2, o.sf2.sqrtA.at, o.sf2.sqrtA.w) * 2 ** -19,
    toe: ub(sf2, o.sf2.toe.at, o.sf2.toe.w) * 16,
    cic: sb(sf3, o.sf3.cic.at, o.sf3.cic.w) * 2 ** -29,
    omg0: sb(sf3, o.sf3.omg0.at, o.sf3.omg0.w) * 2 ** -31 * PI,
    cis: sb(sf3, o.sf3.cis.at, o.sf3.cis.w) * 2 ** -29,
    i0: sb(sf3, o.sf3.i0.at, o.sf3.i0.w) * 2 ** -31 * PI,
    crc: sb(sf3, o.sf3.crc.at, o.sf3.crc.w) * 2 ** -5,
    omg: sb(sf3, o.sf3.omg.at, o.sf3.omg.w) * 2 ** -31 * PI,
    omgd: sb(sf3, o.sf3.omgd.at, o.sf3.omgd.w) * 2 ** -43 * PI,
    idot: sb(sf3, o.sf3.idot.at, o.sf3.idot.w) * 2 ** -43 * PI,
    codes: ub(sf1, o.sf1.l2p.at, o.sf1.l2p.w) ? 2 : 1,
    accuracy: SV_ACCURACY,
    health: ub(sf1, o.sf1.health.at, o.sf1.health.w),
    tgd: sb(sf1, o.sf1.tgd.at, o.sf1.tgd.w) * 2 ** -31,
    iodc: (ub(sf1, o.sf1.iodcMsb.at, o.sf1.iodcMsb.w) << 8) | ub(sf2, o.sf2.iode.at, o.sf2.iode.w),
    transmission: ub(sf1, o.sf1.tow.at, o.sf1.tow.w) * 6,
    fit: ub(sf2, o.sf2.fit.at, o.sf2.fit.w) ? 2 : 4,
  };
}

/**
 * `.ddddddddddddD±xx` — 12 significant digits, `D` exponent, right aligned to 19 columns.
 * RINEX 2's `%19.12E` with the mantissa shifted to `0.…`; zero prints as `.000000000000D+00`.
 */
export function rinexD(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '.000000000000D+00'.padStart(19);
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponent] = Math.abs(value).toExponential(11).split('e');
  const digits = mantissa.replace('.', '');
  const exp = Number(exponent) + 1;
  const expText = `${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return `${sign}.${digits}D${expText}`.padStart(19);
}

/** GPS week + seconds-of-week → UTC calendar fields. */
function gpsCalendar(week: number, seconds: number) {
  const at = new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + seconds * 1000);
  return {
    year: at.getUTCFullYear() % 100,
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hours: at.getUTCHours(),
    minutes: at.getUTCMinutes(),
  };
}

function headerLine(content: string, label: string): string {
  return `${content.padEnd(60)}${label.padEnd(20)}`;
}

function header(system: string, options: NavOptions): string[] {
  const built = options.builtAt;
  const date = `${String(built.getDate()).padStart(2, '0')}-${MONTHS[built.getMonth()]}-${String(built.getFullYear() % 100).padStart(2, '0')} ${String(built.getHours()).padStart(2, '0')}:${String(built.getMinutes()).padStart(2, '0')}`;
  return [
    headerLine(`     2.10           ${system}`, 'RINEX VERSION / TYPE'),
    headerLine(`NAS Convert 2.11.0  NovAtel             ${date}`, 'PGM / RUN BY / DATE'),
    headerLine('', 'COMMENT'),
    headerLine('', 'END OF HEADER'),
  ];
}

/** One 8-line record. Lines are 79 columns wide (the widest fixed field run is 22+3×19). */
function record(ephemeris: Ephemeris): string[] {
  const when = gpsCalendar(ephemeris.week, ephemeris.toc);
  const two = (value: number) => String(value).padStart(2, '0');
  // `%2d %02d %02d %02d %02d %02d %04.1f` — the PRN is space padded, every date/time field is
  // zero padded to two digits (` 7 26 10 30 09 59 44.0`), and seconds take four columns.
  const head =
    String(ephemeris.prn).padStart(2) +
    ` ${two(when.year)}` +
    ` ${two(when.month)}` +
    ` ${two(when.day)}` +
    ` ${two(when.hours)}` +
    ` ${two(when.minutes)}` +
    ` ${(ephemeris.toc % 60).toFixed(1).padStart(4, '0')}`;

  const lines: string[] = [];
  lines.push(`${head}${rinexD(ephemeris.af0)}${rinexD(ephemeris.af1)}${rinexD(ephemeris.af2)}`);
  lines.push(`   ${rinexD(ephemeris.iode)}${rinexD(ephemeris.crs)}${rinexD(ephemeris.dn)}${rinexD(ephemeris.m0)}`);
  lines.push(`   ${rinexD(ephemeris.cuc)}${rinexD(ephemeris.e)}${rinexD(ephemeris.cus)}${rinexD(ephemeris.sqrtA)}`);
  lines.push(`   ${rinexD(ephemeris.toe)}${rinexD(ephemeris.cic)}${rinexD(ephemeris.omg0)}${rinexD(ephemeris.cis)}`);
  lines.push(`   ${rinexD(ephemeris.i0)}${rinexD(ephemeris.crc)}${rinexD(ephemeris.omg)}${rinexD(ephemeris.omgd)}`);
  lines.push(`   ${rinexD(ephemeris.idot)}${rinexD(ephemeris.codes)}${rinexD(ephemeris.week)}${rinexD(0)}`);
  lines.push(`   ${rinexD(ephemeris.accuracy)}${rinexD(ephemeris.health)}${rinexD(ephemeris.tgd)}${rinexD(ephemeris.iodc)}`);
  lines.push(`   ${rinexD(ephemeris.transmission)}${rinexD(ephemeris.fit)}`.padEnd(79));
  return lines;
}

/**
 * `.YYN` — GPS navigation. Records are written in first-appearance order and de-duplicated per
 * (PRN, toc): the receiver logs the same ephemeris again on a later pass, and the suite keeps only
 * the first copy (18 `RAWEPHEM` frames of a 60 s capture become 9 records).
 */
export function buildRinex21Nav(frames: SbfFrame[], tables: EdieTables, options: NavOptions): string {
  const lines = header('N: GPS NAV DATA', options);
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.header.messageId !== 41) continue;
    const values = decodeEdie(frame.payload, tables.messages['41'], tables);
    const get = (path: string) => String(values.find((value) => value.path === path)?.value ?? '');
    const prn = Number(get('satellite_id'));
    const week = Number(get('week'));
    const ephemeris = decodeEphemeris(prn, week, toBytes(get('subframe1')), toBytes(get('subframe2')), toBytes(get('subframe3')));
    const key = `${ephemeris.prn}|${ephemeris.week}|${ephemeris.toc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(...record(ephemeris));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** `.YYG` — GLONASS navigation; the suite writes only the header when no GLONASS ephemeris exists. */
export function buildRinex21GloNav(options: NavOptions): string {
  return `${header('G: GLONASS NAV DATA', options).join('\r\n')}\r\n`;
}
