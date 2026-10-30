/**
 * RINEX 3.01 / 3.02 / 3.03 / 3.04 observation writer, reproduced from
 * `00_来源/samples/convert/golden-rinex3_0{1,2,3,4}/.../RINEXv3_0x/clean-9600.26O`.
 *
 * The suite writes RINEX with a closed-source native tool, so every rule below was measured from
 * the four golden files of the same capture (`clean-9600.gps`); nothing is taken from the RINEX
 * standard on faith. What the goldens say:
 *
 *  - **Header** (25 lines for 3.01, 36 for 3.02, 37 for 3.03/3.04), every line padded to 80:
 *    content to column 60, label to 80 (`line()`). `SYS / # / OBS TYPES` puts the system letter in
 *    column 1, a 5-wide count in columns 2-6 and the 4-character codes (`C1C`, then four per signal)
 *    from column 8, 13 codes per line, continuations indented 6.
 *  - **Observation codes** are `C/L/D/S` + a two-character carrier (`1C`, `2W`, `2S`, `5Q`, `1L`)
 *    per (version, system, NovAtel signal type). The carrier order in the header is the tool's own
 *    table order, filtered to the carriers the capture actually has (see `carriersOf`). The only
 *    version dependency is BeiDou's B1I: 3.02 calls it `1I`, 3.03/3.04 call it `2I` (renumbered band).
 *  - **`SYS / PHASE SHIFT`** (label `SYS / PHASE SHIFTS` in 3.01) carries one line per carrier with
 *    the shift the writer applies to the carrier phase: `<sys> <carrier><%9.5f><count:2>< sats>`,
 *    ten satellites per line. The shift is 0 for L1 C/A, L2 P and everything BeiDou, -0.25 for
 *    L2C/L5 and +0.25 for L1C — per system, so QZSS `L2S` carries none. The same number is **added
 *    to the negated `adr`** when the observation is written, which is why `L = -adr + shift`.
 *  - **Observation line** = 3-character satellite id + 4 × 16-character fields per carrier
 *    (`%14.3f` + LLI + SNR). Absent signals are 16 blanks, the line is never trimmed. The LLI digit
 *    is blank in this format; the SNR digit is `clamp(floor(C/N0 / 6), 1, 9)` (measured steps:
 *    36.0055-41.9999 → 6, 42.0004-47.9238 → 7, 48.0495-53.9991 → 8) on C and L only, blank on D and S.
 *  - **Epoch line** is 56 characters and carries **no satellite list**: `> yyyy mm dd hh mm ss.sssssss`
 *    + 3-wide epoch flag + 3-wide satellite count + `      -0.000000000000` (a receiver clock offset
 *    of minus zero, constant in all 400 epochs of the four goldens). Satellites follow in the order
 *    they first appear in the RANGE payload.
 *  - **`APPROX POSITION XYZ`** is the mean of the BESTPOS track converted to ECEF, exactly as in
 *    `rinex21.ts`; the suite uses a geoid model we do not have, so this is the one line allowed to
 *    differ (measured 8 mm, i.e. the last decimal of a `%14.4f` field only).
 *
 * Three quirks that only a byte comparison would reveal, all reproduced as measured:
 *
 *  - 3.02 ends the `GLONASS COD/PHS/BIS` line with a bare `\n` instead of `\r\n` (the only non-CRLF
 *    line in the whole golden set, and the reason that file is 1 byte smaller than 3.03);
 *  - the `LEAP SECONDS` line carries a trailing `GPS` from 3.03 on, but not in 3.01/3.02;
 *  - 3.02/3.03 write no `J07` observation although the capture has that satellite (and 3.04 does
 *    write it). See `OMITTED_SATELLITES`.
 *
 * Acceptance: `packages/protocol/test/rinex3.test.ts` demands byte identity line by line against all
 * four goldens, everywhere except `APPROX POSITION XYZ`.
 */

import type { SbfFrame } from './framing.ts';
import { exactFixed } from './ascii-log.ts';
import { decodeEdie, type EdieTables, type EdieValue } from './edie.ts';

export type Rinex3Version = '3.01' | '3.02' | '3.03' | '3.04';

export interface Rinex3Options {
  /**
   * `PGM / RUN BY / DATE` timestamp. Formatted `YYYYMMDD HHMMSS UTC` — 3.x stamps UTC time, where
   * the 2.1 writer (`rinex21.ts`) stamps local time.
   */
  builtAt: Date;
}

/** One `obs[i]` block of a RANGE payload, reduced to what the RINEX writer needs. */
interface Entry {
  /** RINEX system letter (`G`, `J`, `C`). */
  system: string;
  /** RINEX satellite number (QZSS 193-202 → 01-10, everything else is the receiver's PRN). */
  number: number;
  /** NovAtel signal type: `c_status` bits 21-25. */
  signal: number;
  psr: number;
  adr: number;
  dop: number;
  cnr: number;
}

interface Epoch {
  week: number;
  milliseconds: number;
  entries: Entry[];
}

/** A carrier as the writer sees it: `C/L/D/S` + `code`, a phase shift, and the signals feeding it. */
interface Carrier {
  code: string;
  shift: number;
  signals: number[];
}

interface SystemPlan {
  letter: string;
  /** Carriers in the order the `SYS / # / OBS TYPES` line lists them (filtered to those present). */
  carriers: Carrier[];
  /** Satellites of this system, in the order they first appear in the capture. */
  satellites: Array<{ id: string; number: number }>;
}

/** `c_status` bits 16-18: 0 GPS, 4 BeiDou, 5 QZSS (the only systems this capture carries). */
const SYSTEMS_BY_ID: Record<number, string> = { 0: 'G', 4: 'C', 5: 'J' };

/**
 * Per-system observation-code tables, in the writer's own order, with the phase shift it applies to
 * the carrier phase (`SYS / PHASE SHIFT`) and the NovAtel signal types that feed each carrier.
 * Everything here is read off the goldens' `SYS / # / OBS TYPES` and `SYS / PHASE SHIFT` lines and
 * cross-checked against which `obs[i].psr` fills which field.
 */
const GPS_CARRIERS: Carrier[] = [
  { code: '1C', shift: 0, signals: [0] },
  { code: '2W', shift: 0, signals: [9] },
  { code: '2S', shift: -0.25, signals: [17] },
  { code: '5Q', shift: -0.25, signals: [14] },
  { code: '1L', shift: 0.25, signals: [16] },
];

/** QZSS L2C is written as `C2S` but, unlike GPS, without a phase shift. */
const QZSS_CARRIERS: Carrier[] = [
  { code: '1C', shift: 0, signals: [0] },
  { code: '2S', shift: 0, signals: [17] },
  { code: '5Q', shift: -0.25, signals: [14] },
  { code: '1L', shift: 0.25, signals: [16] },
];

/** BeiDou: signals 0 and 4 both carry B1I, 2 and 6 both carry B3I; no phase shift anywhere. */
function beidouCarriers(version: Rinex3Version): Carrier[] {
  const b1 = version === '3.02' ? '1I' : '2I';
  return [
    { code: b1, shift: 0, signals: [0, 4] },
    { code: '7I', shift: 0, signals: [1] },
    { code: '6I', shift: 0, signals: [2, 6] },
  ];
}

/** System order in the header: GPS, then QZSS, then BeiDou (order of first appearance in RANGE too). */
const SYSTEM_ORDER = ['G', 'J', 'C'];

/**
 * Systems each version writes at all. 3.01 is GPS-only (`OBSERVATION DATA    G (GPS)`); from 3.02 on
 * every constellation present in the capture is written (`M (MIXED)`).
 */
function acceptedSystems(version: Rinex3Version): string[] {
  return version === '3.01' ? ['G'] : SYSTEM_ORDER;
}

/**
 * Measured, unexplained: 3.02 and 3.03 write no `J07` record although the capture carries QZSS 7 in
 * every epoch and 3.04 does write it (the two files differ by exactly those 100 lines plus the
 * satellite count). Only the observation file is affected — the nav files and `.26Q` are identical.
 */
const OMITTED_SATELLITES: Partial<Record<Rinex3Version, string[]>> = {
  '3.02': ['J07'],
  '3.03': ['J07'],
};

/** NovAtel GLONASS `COD/PHS/BIS` line: three fixed entries, in all versions from 3.02 on. */
const GLONASS_COD_PHS_BIS: Array<[string, number]> = [
  ['C1C', -71.95],
  ['C2C', -71.95],
  ['C2P', -71.95],
];

function line(content: string, label: string): string {
  return `${content.padEnd(60)}${label.padEnd(20)}`;
}

function gpsDate(week: number, milliseconds: number): Date {
  return new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + milliseconds);
}

function gpsFields(week: number, milliseconds: number): string {
  const date = gpsDate(week, milliseconds);
  const seconds = (milliseconds % 60000) / 1000;
  return [
    String(date.getUTCFullYear()).padStart(6),
    String(date.getUTCMonth() + 1).padStart(6),
    String(date.getUTCDate()).padStart(6),
    String(date.getUTCHours()).padStart(2, '0').padStart(6),
    String(date.getUTCMinutes()).padStart(2, '0').padStart(6),
    exactFixed(seconds, 7).padStart(13),
  ].join('');
}

function ecef(latitude: number, longitude: number, height: number): [number, number, number] {
  const a = 6378137;
  const flattening = 1 / 298.257223563;
  const e2 = flattening * (2 - flattening);
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + height) * Math.sin(lat),
  ];
}

function valueLength(values: EdieValue[], path: string): number {
  return Number(values.find((value) => value.path === path)?.value ?? 0);
}

/**
 * RINEX signal-to-noise digit: `floor(C/N0 / 6)` clamped to 1..9, i.e. 6 dB per step with 36, 42, 48
 * and 54 dBHz on the steps. Measured over all four goldens — the highest digit-6 field is 41.9999 and
 * the lowest digit-7 field is 42.0004, highest digit-7 47.9238 vs lowest digit-8 48.0495, highest
 * digit-8 53.9991 vs lowest digit-9 54.0026. The 2.1 writer uses a different 2.2335 dB ladder.
 */
function snrDigit(cnr: number): number {
  return Math.min(9, Math.max(1, Math.floor(cnr / 6)));
}

function satelliteId(system: string, number: number): string {
  return `${system}${String(number).padStart(2, '0')}`;
}

/** `c_status` bits 16-18 → system letter, and the RINEX satellite number for it. */
function classify(status: number, prn: number): { system: string; number: number } | undefined {
  const system = SYSTEMS_BY_ID[(status >> 16) & 0x07];
  if (!system) return undefined;
  if (system === 'J') {
    if (prn < 193 || prn > 202) return undefined;
    return { system, number: prn - 192 };
  }
  if (system === 'G' && (prn < 1 || prn > 32)) return undefined;
  return { system, number: prn };
}

function collectEpochs(frames: SbfFrame[], tables: EdieTables, version: Rinex3Version): Epoch[] {
  const accepted = new Set(acceptedSystems(version));
  const omitted = new Set(OMITTED_SATELLITES[version] ?? []);
  const epochs: Epoch[] = [];
  for (const frame of frames) {
    if (frame.header.messageId !== 43) continue;
    const values = decodeEdie(frame.payload, tables.messages['43'], tables);
    const blocks = new Map<number, Map<string, EdieValue>>();
    for (const value of values) {
      const match = /^obs\[(\d+)\]\.(.+)$/.exec(value.path);
      if (!match) continue;
      const index = Number(match[1]);
      if (!blocks.has(index)) blocks.set(index, new Map());
      blocks.get(index)!.set(match[2], value);
    }
    const entries: Entry[] = [];
    for (const [, block] of blocks) {
      const status = Number(block.get('c_status')?.value ?? 0);
      const prn = Number(block.get('sv_prn')?.value ?? 0);
      const satellite = classify(status, prn);
      if (!satellite) continue;
      if (!accepted.has(satellite.system)) continue;
      if (omitted.has(satelliteId(satellite.system, satellite.number))) continue;
      entries.push({
        system: satellite.system,
        number: satellite.number,
        signal: (status >> 21) & 0x1f,
        psr: Number(block.get('psr')?.value ?? 0),
        adr: Number(block.get('adr')?.value ?? 0),
        dop: Number(block.get('dop')?.value ?? 0),
        cnr: Number(block.get('C_No')?.value ?? 0),
      });
    }
    epochs.push({ week: frame.header.week, milliseconds: frame.header.milliseconds, entries });
  }
  return epochs;
}

/** The writer's carrier table for one system (see `planOf` for the filtering to present carriers). */
function carriersOf(version: Rinex3Version, letter: string): Carrier[] {
  if (letter === 'G') return GPS_CARRIERS;
  if (letter === 'J') return QZSS_CARRIERS;
  if (letter === 'C') return beidouCarriers(version);
  return [];
}

function carrierFor(version: Rinex3Version, system: string, signal: number): Carrier | undefined {
  return carriersOf(version, system).find((carrier) => carrier.signals.includes(signal));
}

/**
 * Which carriers each system actually has (in table order, so the header layout is stable) and which
 * satellites appear, in first-appearance order — the order the phase-shift lines list them in.
 */
function planOf(epochs: Epoch[], version: Rinex3Version): SystemPlan[] {
  const present = new Map<string, Set<string>>();
  const satellites = new Map<string, { id: string; number: number }[]>();
  for (const epoch of epochs) {
    for (const entry of epoch.entries) {
      const carrier = carrierFor(version, entry.system, entry.signal);
      if (!carrier) continue;
      if (!present.has(entry.system)) present.set(entry.system, new Set());
      present.get(entry.system)!.add(carrier.code);
      const list = satellites.get(entry.system) ?? [];
      const id = satelliteId(entry.system, entry.number);
      if (!list.some((known) => known.id === id)) list.push({ id, number: entry.number });
      satellites.set(entry.system, list);
    }
  }
  const plans: SystemPlan[] = [];
  for (const letter of acceptedSystems(version)) {
    const codes = present.get(letter);
    if (!codes || codes.size === 0) continue;
    plans.push({
      letter,
      carriers: carriersOf(version, letter).filter((carrier) => codes.has(carrier.code)),
      satellites: satellites.get(letter) ?? [],
    });
  }
  return plans;
}

function observationCodeNames(carrier: Carrier): string[] {
  return ['C', 'L', 'D', 'S'].map((prefix) => `${prefix}${carrier.code}`);
}

/**
 * `SYS / # / OBS TYPES`: system letter in column 1, count in columns 2-6, then 4-character codes from
 * column 8, thirteen to a line, continuations indented by six (all measured, not the standard's A1,I3).
 */
function obsTypeLines(plan: SystemPlan): string[] {
  const codes = plan.carriers.flatMap(observationCodeNames);
  const lines: string[] = [];
  for (let at = 0; at < codes.length; at += 13) {
    const group = codes.slice(at, at + 13);
    const head = at === 0 ? `${plan.letter}${String(codes.length).padStart(5)}` : ' '.repeat(6);
    lines.push(line(`${head}${group.map((code) => ` ${code}`).join('')}`, 'SYS / # / OBS TYPES'));
  }
  return lines;
}

/**
 * `SYS / PHASE SHIFT`: `<sys> <carrier><%9.5f shift><2-digit count>` then ` XXX` per satellite, ten per
 * line (satellite ids in columns 20-58), continuations indented by eighteen.
 */
function phaseShiftLines(plan: SystemPlan, epochs: Epoch[], version: Rinex3Version, label: string): string[] {
  const lines: string[] = [];
  for (const carrier of plan.carriers) {
    // Satellites that carry this signal, in first-appearance order.
    const numbers: number[] = [];
    for (const satellite of plan.satellites) {
      const has = epochs.some((epoch) => epoch.entries.some((entry) =>
        entry.system === plan.letter
        && entry.number === satellite.number
        && carrierFor(version, entry.system, entry.signal)?.code === carrier.code));
      if (has) numbers.push(satellite.number);
    }
    if (numbers.length === 0) continue;
    const carrierCode = `L${carrier.code}`;
    const head = `${plan.letter} ${carrierCode}${exactFixed(carrier.shift, 5).padStart(9)}  ${String(numbers.length).padStart(2, '0')}`;
    for (let at = 0; at < numbers.length; at += 10) {
      const group = numbers.slice(at, at + 10);
      const content = at === 0 ? head : ' '.repeat(18);
      lines.push(line(`${content}${group.map((number) => ` ${satelliteId(plan.letter, number)}`).join('')}`, label));
    }
  }
  return lines;
}

function headerOf(
  epochs: Epoch[],
  plans: SystemPlan[],
  frames: SbfFrame[],
  tables: EdieTables,
  version: Rinex3Version,
  options: Rinex3Options,
): string[] {
  const first = epochs[0];
  const last = epochs[epochs.length - 1];
  const built = options.builtAt;
  const date = [
    String(built.getUTCFullYear()).padStart(4, '0'),
    String(built.getUTCMonth() + 1).padStart(2, '0'),
    String(built.getUTCDate()).padStart(2, '0'),
  ].join('') + ' ' + [
    String(built.getUTCHours()).padStart(2, '0'),
    String(built.getUTCMinutes()).padStart(2, '0'),
    String(built.getUTCSeconds()).padStart(2, '0'),
  ].join('') + ' UTC';

  // Approximate position: mean of the BESTPOS track, ellipsoidal height (as in `rinex21.ts`).
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  for (const frame of frames) {
    if (frame.header.messageId !== 42) continue;
    const values = decodeEdie(frame.payload, tables.messages['42'], tables);
    const [px, py, pz] = ecef(
      valueLength(values, 'latitude'),
      valueLength(values, 'longitude'),
      valueLength(values, 'orthometric_height') + valueLength(values, 'undulation'),
    );
    x += px;
    y += py;
    z += pz;
    count += 1;
  }
  if (count) {
    x /= count;
    y /= count;
    z /= count;
  }

  const mixed = plans.some((plan) => plan.letter !== 'G');
  const lines: string[] = [];
  lines.push(line(
    `${version.padStart(9)}${' '.repeat(11)}${'OBSERVATION DATA'.padEnd(20)}${mixed ? 'M (MIXED)' : 'G (GPS)'}`,
    'RINEX VERSION / TYPE',
  ));
  lines.push(line(`${'NAS Convert 2.11.0'.padEnd(20)}${'NovAtel'.padEnd(20)}${date}`, 'PGM / RUN BY / DATE'));
  lines.push(line(`Rinex Version ${version} Observation File`, 'COMMENT'));
  lines.push(line('', 'MARKER NAME'));
  lines.push(line('', 'MARKER NUMBER'));
  lines.push(line('', 'MARKER TYPE'));
  lines.push(line('', 'OBSERVER / AGENCY'));
  lines.push(line(`${' '.repeat(20)}NovAtel GPSCard`, 'REC # / TYPE / VERS'));
  lines.push(line('', 'ANT # / TYPE'));
  lines.push(line(
    `${exactFixed(x, 4).padStart(14)}${exactFixed(y, 4).padStart(14)}${exactFixed(z, 4).padStart(14)}`,
    'APPROX POSITION XYZ',
  ));
  lines.push(line(`${exactFixed(0, 4).padStart(14)}${exactFixed(0, 4).padStart(14)}${exactFixed(0, 4).padStart(14)}`, 'ANTENNA: DELTA H/E/N'));
  for (const plan of plans) lines.push(...obsTypeLines(plan));
  lines.push(line('DBHZ', 'SIGNAL STRENGTH UNIT'));
  const interval = epochs.length > 1 ? (epochs[1].milliseconds - epochs[0].milliseconds) / 1000 : 0;
  lines.push(line(exactFixed(interval, 3).padStart(10), 'INTERVAL'));
  lines.push(line(`${gpsFields(first.week, first.milliseconds)}     GPS`, 'TIME OF FIRST OBS'));
  lines.push(line(`${gpsFields(last.week, last.milliseconds)}     GPS`, 'TIME OF LAST OBS'));
  const shiftLabel = version === '3.01' ? 'SYS / PHASE SHIFTS' : 'SYS / PHASE SHIFT';
  for (const plan of plans) lines.push(...phaseShiftLines(plan, epochs, version, shiftLabel));
  lines.push(line('', 'GLONASS SLOT / FRQ #'));
  if (version !== '3.01') {
    lines.push(line(
      GLONASS_COD_PHS_BIS.map(([code, value]) => ` ${code}${exactFixed(value, 3).padStart(9)}`).join(''),
      'GLONASS COD/PHS/BIS',
    ));
  }
  const leapSeconds = '     0     0     0     0';
  lines.push(line(version === '3.01' || version === '3.02' ? leapSeconds : `${leapSeconds}GPS`, 'LEAP SECONDS'));
  lines.push(line('', 'END OF HEADER'));
  return lines;
}

/**
 * Epoch line: 56 characters, no satellite list. The trailing `      -0.000000000000` is the receiver
 * clock offset the writer reports — minus zero, identically in every epoch of every version.
 */
function epochLine(epoch: Epoch, satellites: number): string {
  const date = gpsDate(epoch.week, epoch.milliseconds);
  const seconds = (epoch.milliseconds % 60000) / 1000;
  const head =
    `> ${String(date.getUTCFullYear()).padStart(4)}`
    + String(date.getUTCMonth() + 1).padStart(3)
    + String(date.getUTCDate()).padStart(3)
    + String(date.getUTCHours()).padStart(2, '0').padStart(3)
    + String(date.getUTCMinutes()).padStart(2, '0').padStart(3)
    + exactFixed(seconds, 7).padStart(11)
    + '  0'
    + String(satellites).padStart(3);
  return `${head}      -0.000000000000`;
}

/** Four 16-character fields (`%14.3f` + LLI + SNR) for one carrier, or sixteen blanks. */
function observationFields(carrier: Carrier, entries: Entry[]): string {
  const entry = entries.find((candidate) => carrier.signals.includes(candidate.signal));
  if (!entry) return ' '.repeat(16 * 4);
  const digit = String(snrDigit(entry.cnr));
  const field = (value: number, lli: string, snr: string) => `${exactFixed(value, 3).padStart(14)}${lli}${snr}`;
  return (
    field(entry.psr, ' ', digit)
    + field(-entry.adr + carrier.shift, ' ', digit)
    + field(entry.dop, ' ', ' ')
    + field(entry.cnr, ' ', ' ')
  );
}

export function buildRinex3Obs(
  frames: SbfFrame[],
  tables: EdieTables,
  version: Rinex3Version,
  options: Rinex3Options,
): string {
  const epochs = collectEpochs(frames, tables, version);
  const plans = planOf(epochs, version);
  const byLetter = new Map(plans.map((plan) => [plan.letter, plan]));

  // The 3.02 writer terminates `GLONASS COD/PHS/BIS` with a bare LF; every other line is CRLF.
  const lines: string[] = [];
  for (const text of headerOf(epochs, plans, frames, tables, version, options)) {
    const terminator = version === '3.02' && text.includes('GLONASS COD/PHS/BIS') ? '\n' : '\r\n';
    lines.push(`${text}${terminator}`);
  }

  for (const epoch of epochs) {
    // Satellites in first-appearance order, grouped by system, each system's carriers in table order.
    const order: Array<{ letter: string; number: number; entries: Entry[] }> = [];
    for (const entry of epoch.entries) {
      let record = order.find((known) => known.letter === entry.system && known.number === entry.number);
      if (!record) {
        record = { letter: entry.system, number: entry.number, entries: [] };
        order.push(record);
      }
      record.entries.push(entry);
    }
    const written = order.filter((record) => byLetter.has(record.letter));
    lines.push(`${epochLine(epoch, written.length)}\r\n`);
    for (const record of written) {
      const plan = byLetter.get(record.letter)!;
      const fields = plan.carriers.map((carrier) => observationFields(carrier, record.entries)).join('');
      lines.push(`${satelliteId(record.letter, record.number)}${fields}\r\n`);
    }
  }

  return lines.join('');
}
