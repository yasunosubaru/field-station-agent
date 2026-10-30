/**
 * RINEX 3.01 / 3.02 / 3.03 / 3.04 navigation writer, reproduced from
 * `00_来源/samples/convert/golden-rinex3_0{1,2,3,4}/.../RINEXv3_0x/clean-9600.26N` and the five to
 * seven empty headers that sit beside it.
 *
 * What the goldens say, all of it measured and none of it taken from the standard on faith:
 *
 *  - **Header is the same four lines as the 2.1 file** (`RINEX VERSION / TYPE`, `PGM / RUN BY / DATE`,
 *    an empty `COMMENT`, `END OF HEADER`), every line 80 columns. The version line is *not*
 *    `N: GNSS NAV DATA` / `G: GPS`: the type letter `N` sits in column 21 and the system letter in
 *    column 41, exactly as RINEX 3 lays it out — `     3.01           N                   G`, and the
 *    GLONASS file says `R`, not the 2.1 `G`.
 *  - **`PGM / RUN BY / DATE` stamps UTC** (`20261030 091009 UTC`), like the 3.x observation writer and
 *    unlike the 2.1 nav writer, which stamps local time. The stamp is shared with the `.YYO` of the
 *    same run, so `options.builtAt` is the same `Date` for both.
 *  - **The body is the 2.1 body with one more column.** Same field order, same values, same
 *    first-appearance order, same (PRN, week, t_oc) de-duplication — all 64 record lines of the four
 *    nav goldens are byte-identical to the 2.1 file except for the two changes below. The capture's
 *    8 `RAWEPHEM` frames produce 8 records in both formats.
 *  - **Line 1 of a record** is `A3,1X,I4,4(1X,I2),1X,I2` of satellite id + epoch (23 columns) followed
 *    by the three clock fields at 19 columns each. The seconds field is the integer second of the
 *    minute, **not** `%5.1f`: the goldens show `... 10 00 00` + `  .302773900330D-03`, and a `F5.1`
 *    field would not fit (23 + 57 columns is exactly 80). `t_oc` is a multiple of 16 s, so the value is
 *    always integral and the two forms are indistinguishable on this capture; the narrower reading is
 *    the one the column count requires.
 *  - **No `ADOT`.** RINEX 4 adds it; these files do not. The fourth field of the sixth record line is
 *    `.000000000000D+00` in all 8 records, the same column the 2.1 writer fills, so the record keeps
 *    the 2.1 field list verbatim.
 *  - **Continuation lines are `4 blanks + 4 × 19`** (the 2.1 writer uses 3 blanks, i.e. 79 columns);
 *    the last line is space-padded to 80.
 *
 * Empty per-constellation files (`.YYG` GLONASS, `.YYL` Galileo, `.YYF` BeiDou, `.YYH` SBAS,
 * `.YYI` NavIC, `.YYQ` QZSS) are the bare 328-byte header. **Which of them exist depends on the
 * version**, as measured: 3.01 writes only GLONASS and Galileo; 3.02 adds BeiDou, SBAS and QZSS;
 * 3.03/3.04 add NavIC. The extension is the RINEX 2 letter, the letter inside the file the RINEX 3
 * one (`.26G` holds `R`, `.26Q` holds `J`, `.26I` holds `I`).
 *
 * Acceptance: `packages/protocol/test/rinex3-nav.test.ts` demands byte identity against all four
 * `.26N` goldens and against every empty header.
 */

import type { SbfFrame } from './framing.ts';
import { decodeEdie, type EdieTables } from './edie.ts';
import { RAWEPHEM_OFFSETS, rinexD } from './rinex21-nav.ts';
import type { Rinex3Options, Rinex3Version } from './rinex3.ts';

/** RINEX 3 navigation system letters the suite can write an (empty) file for. */
export type Rinex3NavSystem = 'R' | 'E' | 'C' | 'S' | 'I' | 'J';

/**
 * Extension letter of each system. RINEX 2 named the nav files after its own letter set (`G` GLONASS,
 * `L` Galileo, ...) and the suite keeps those names for its 3.x output, while the letter *inside* the
 * file is the RINEX 3 one.
 */
export const RINEX3_NAV_EXTENSIONS: Record<Rinex3NavSystem, string> = {
  R: 'G',
  E: 'L',
  C: 'F',
  S: 'H',
  I: 'I',
  J: 'Q',
};

/**
 * Systems each version creates a nav file for, in extension order. Measured from the golden
 * directories: 3.01 has `.26G` and `.26L`; 3.02 has `.26F G H L Q`; 3.03/3.04 have `.26F G H I L Q`.
 * No file is written for a constellation that has no ephemeris — the header is empty either way — so
 * this list is the version's supported set, not the capture's contents.
 */
const NAV_SYSTEMS: Record<Rinex3Version, Rinex3NavSystem[]> = {
  '3.01': ['R', 'E'],
  '3.02': ['C', 'R', 'S', 'E', 'J'],
  '3.03': ['C', 'R', 'S', 'I', 'E', 'J'],
  '3.04': ['C', 'R', 'S', 'I', 'E', 'J'],
};

/** Systems that get a nav file in this version, in extension order (`.YYG` before `.YYL` before ...). */
export function rinex3NavSystems(version: Rinex3Version): Rinex3NavSystem[] {
  return [...NAV_SYSTEMS[version]];
}

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

const PI = Math.PI;

/** The fields the RINEX record needs, in the order the record prints them. */
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
 * `SV accuracy` as the suite writes it: `2.0`, and the same constant the 2.1 writer uses
 * (`SV_ACCURACY` in `rinex21-nav.ts`; the URA nibble is 4 in every record of both captures, so the
 * mapping is not observable and byte identity only needs `2.0`).
 */
const SV_ACCURACY = 2;

/**
 * `RAWEPHEM` subframes → one ephemeris. This is the decoder of `rinex21-nav.ts` verbatim (that file
 * is not ours to extend, so the mapping lives here too); the four 3.x goldens confirm every field
 * lands on the same column as in the 2.1 file.
 */
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

/** 60 columns of content, 20 columns of label. */
function line(content: string, label: string): string {
  return `${content.padEnd(60)}${label.padEnd(20)}`;
}

/** GPS week + seconds-of-week → UTC calendar fields. */
function gpsCalendar(week: number, seconds: number) {
  const at = new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + seconds * 1000);
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hours: at.getUTCHours(),
    minutes: at.getUTCMinutes(),
  };
}

/**
 * `PGM / RUN BY / DATE` value: `YYYYMMDD HHMMSS UTC`, UTC (the 3.x observation writer formats the
 * same `Date` the same way, so a run's `.YYO` and `.YYN` carry the same stamp).
 */
function stamp(builtAt: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${String(builtAt.getUTCFullYear()).padStart(4, '0')}${two(builtAt.getUTCMonth() + 1)}${two(builtAt.getUTCDate())} ${two(builtAt.getUTCHours())}${two(builtAt.getUTCMinutes())}${two(builtAt.getUTCSeconds())} UTC`;
}

/**
 * Four 80-column header lines. `system` is the RINEX 3 letter in column 41 (`G` GPS, `R` GLONASS,
 * ...); the file type letter `N` in column 21 is the same in all of them.
 */
function header(system: Rinex3NavSystem | 'G', version: Rinex3Version, options: Rinex3Options): string[] {
  return [
    line(`${version.padStart(9)}${' '.repeat(11)}N${' '.repeat(19)}${system}${' '.repeat(19)}`, 'RINEX VERSION / TYPE'),
    line(`${'NAS Convert 2.11.0'.padEnd(20)}${'NovAtel'.padEnd(20)}${stamp(options.builtAt)}`, 'PGM / RUN BY / DATE'),
    line('', 'COMMENT'),
    line('', 'END OF HEADER'),
  ];
}

/** One 8-line record, every line exactly 80 columns. */
function record(ephemeris: Ephemeris): string[] {
  const when = gpsCalendar(ephemeris.week, ephemeris.toc);
  const two = (value: number) => String(value).padStart(2, '0');
  // `A3,1X,I4,4(1X,I2),1X,I2` — 23 columns, e.g. `G07 2026 10 30 09 59 44`. `t_oc` is a multiple
  // of 16 s, so the seconds are always whole.
  const head =
    `G${two(ephemeris.prn)}`
    + ` ${String(when.year).padStart(4)}`
    + ` ${two(when.month)}`
    + ` ${two(when.day)}`
    + ` ${two(when.hours)}`
    + ` ${two(when.minutes)}`
    + ` ${String(Math.floor(ephemeris.toc % 60)).padStart(2, '0')}`;

  const lines: string[] = [];
  lines.push(`${head}${rinexD(ephemeris.af0)}${rinexD(ephemeris.af1)}${rinexD(ephemeris.af2)}`);
  lines.push(`    ${rinexD(ephemeris.iode)}${rinexD(ephemeris.crs)}${rinexD(ephemeris.dn)}${rinexD(ephemeris.m0)}`);
  lines.push(`    ${rinexD(ephemeris.cuc)}${rinexD(ephemeris.e)}${rinexD(ephemeris.cus)}${rinexD(ephemeris.sqrtA)}`);
  lines.push(`    ${rinexD(ephemeris.toe)}${rinexD(ephemeris.cic)}${rinexD(ephemeris.omg0)}${rinexD(ephemeris.cis)}`);
  lines.push(`    ${rinexD(ephemeris.i0)}${rinexD(ephemeris.crc)}${rinexD(ephemeris.omg)}${rinexD(ephemeris.omgd)}`);
  lines.push(`    ${rinexD(ephemeris.idot)}${rinexD(ephemeris.codes)}${rinexD(ephemeris.week)}${rinexD(0)}`);
  lines.push(`    ${rinexD(ephemeris.accuracy)}${rinexD(ephemeris.health)}${rinexD(ephemeris.tgd)}${rinexD(ephemeris.iodc)}`);
  lines.push(`    ${rinexD(ephemeris.transmission)}${rinexD(ephemeris.fit)}`.padEnd(80));
  return lines;
}

/**
 * `.YYN` — GPS navigation. Records are written in first-appearance order and de-duplicated per
 * (PRN, t_oc), the same rule and the same order as the 2.1 writer: the receiver logs the same
 * ephemeris again on a later pass and the suite keeps only the first copy.
 */
export function buildRinex3Nav(
  frames: SbfFrame[],
  tables: EdieTables,
  version: Rinex3Version,
  options: Rinex3Options,
): string {
  const lines = header('G', version, options);
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

/**
 * `.YYG` / `.YYL` / `.YYF` / `.YYH` / `.YYI` / `.YYQ` for one constellation. The suite writes only
 * the header when the capture has no ephemeris for that system, which is the case for every
 * non-GPS system here: 4 lines, 328 bytes, all versions and all systems identical apart from the
 * version and the system letter.
 */
export function buildRinex3EmptyNav(
  system: Rinex3NavSystem,
  version: Rinex3Version,
  options: Rinex3Options,
): string {
  return `${header(system, version, options).join('\r\n')}\r\n`;
}
