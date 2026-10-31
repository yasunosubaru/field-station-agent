/**
 * RINEX 2.1 observation writer, reproduced from
 * `samples/convert/golden-rinex2_1/clean-9600/.../RINEXv2_1/clean-9600.26O`.
 *
 * The suite writes RINEX with a closed-source native tool (`tosrec.exe`), so every rule here was
 * measured from the golden file (see `03_分析/10_RINEX输出规格.md`):
 *
 *  - header: 20 lines, content padded to column 60, label padded to 80;
 *  - `APPROX POSITION XYZ` is the **last** BESTPOS of the capture converted to ECEF (ellipsoidal
 *    height = `orthometric_height + undulation`) — not the mean of the track. See the comment in
 *    `header()`: the golden prints that record's ECEF to the last decimal;
 *  - epoch line `%3d%3d%3d%3d%3d%11.7f%3d%3d` + `G%02d` list, padded to 80, satellites in the order
 *    they first appear in the RANGE payload;
 *  - 8 observation types `C1 L1 D1 S1 P2 L2 D2 S2`, five per line, `%14.3f` + LLI + SNR;
 *  - LLI is the constant `4` on C1/P2/D1/D2 and blank elsewhere; the SNR digit is
 *    `clamp(floor((cnr - 29.93) / 2.2335) + 1, 1, 9)` on everything except S1/S2 (which are the
 *    C/N0 values themselves);
 *  - L1 is the RANGE entry whose `c_status >> 21 & 0x1f` is 0, L2 the one that is 9 (fallback 17).
 */

import type { SbfFrame } from './framing.ts';
import { exactFixed } from './ascii-log.ts';
import { decodeEdie, type EdieTables, type EdieValue } from './edie.ts';

export interface Rinex21Options {
  /** `PGM / RUN BY / DATE` timestamp, local time. */
  builtAt: Date;
}

interface Observation {
  prn: number;
  signal: number;
  psr: number;
  adr: number;
  dop: number;
  cnr: number;
}

interface Epoch {
  week: number;
  milliseconds: number;
  observations: Observation[];
}

const OBS_TYPES = ['C1', 'L1', 'D1', 'S1', 'P2', 'L2', 'D2', 'S2'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    seconds.toFixed(7).padStart(13),
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

function snrCode(cnr: number): number {
  // Boundaries measured from the golden (the smallest and largest C/N0 seen on each side of every
  // step); the suite switches about 2.23 dB apart, between 36.676 and 47.816 dBHz.
  const boundaries = [36.676, 38.9545, 41.087, 43.333, 45.5565, 47.816];
  let code = 3;
  for (const boundary of boundaries) {
    if (cnr >= boundary) code += 1;
  }
  return Math.min(9, Math.max(1, code));
}

function valueLength(values: EdieValue[], path: string): number {
  return Number(values.find((value) => value.path === path)?.value ?? 0);
}

/** L1 entry (`c_status >> 21 & 0x1f` = 0) and L2 entry (9, fallback 17); GPS PRNs only. */
function pairOf(entries: Observation[]): { l1: Observation; l2: Observation } | undefined {
  const l1 = entries.find((entry) => ((entry.signal >> 21) & 0x1f) === 0);
  const l2 = entries.find((entry) => ((entry.signal >> 21) & 0x1f) === 9)
    ?? entries.find((entry) => ((entry.signal >> 21) & 0x1f) === 17);
  if (!l1 || !l2) return undefined;
  if (l1.prn < 1 || l1.prn > 32) return undefined;
  return { l1, l2 };
}

function collectRanges(frames: SbfFrame[], tables: EdieTables): Epoch[] {
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
    const observations: Observation[] = [];
    for (const [, block] of blocks) {
      observations.push({
        prn: Number(block.get('sv_prn')?.value ?? 0),
        signal: Number(block.get('c_status')?.value ?? 0),
        psr: Number(block.get('psr')?.value ?? 0),
        adr: Number(block.get('adr')?.value ?? 0),
        dop: Number(block.get('dop')?.value ?? 0),
        cnr: Number(block.get('C_No')?.value ?? 0),
      });
    }
    epochs.push({ week: frame.header.week, milliseconds: frame.header.milliseconds, observations });
  }
  return epochs;
}

function header(epochs: Epoch[], frames: SbfFrame[], tables: EdieTables, options: Rinex21Options): string[] {
  const first = epochs[0];
  const last = epochs[epochs.length - 1];
  const built = options.builtAt;
  const date = `${String(built.getDate()).padStart(2, '0')}-${MONTHS[built.getMonth()]}-${String(built.getFullYear() % 100).padStart(2, '0')} ${String(built.getHours()).padStart(2, '0')}:${String(built.getMinutes()).padStart(2, '0')}`;

  // Approximate position: the **last** BESTPOS of the capture, ellipsoidal height.
  //
  // Earlier this averaged the whole BESTPOS track, which is what made the line differ from the
  // golden by up to 8 mm. It is not an average: `clean-9600.gps` carries five BESTPOS records
  // (463098000 … 463102000) whose mean ECEF is `-2267176.2601 5008923.9291 3222098.6458`, while the
  // golden header prints `-2267176.2633 5008923.9294 3222098.6385` — bit for bit the ECEF of the
  // *last* record (see `packages/protocol/test/rinex21.test.ts`). That is how a writer which embeds
  // the header after streaming the file ends up behaving: `TIME OF LAST OBS` has to be known first
  // anyway, so the position it keeps is simply the latest one it saw.
  let x = 0;
  let y = 0;
  let z = 0;
  for (const frame of frames) {
    if (frame.header.messageId !== 42) continue;
    const values = decodeEdie(frame.payload, tables.messages['42'], tables);
    const latitude = valueLength(values, 'latitude');
    const longitude = valueLength(values, 'longitude');
    // A BESTPOS with 0/0 coordinates carries no computed position (no fix). Skipping it is a safety
    // rule, not something measured from the golden: all five records of the sample are valid, so it
    // changes nothing there, and it keeps a fix-less capture from writing an ECEF near the geocentre.
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude === 0 && longitude === 0) continue;
    [x, y, z] = ecef(
      latitude,
      longitude,
      valueLength(values, 'orthometric_height') + valueLength(values, 'undulation'),
    );
  }

  const satellites = [...new Set(epochs.flatMap((epoch) => {
    const byPrn = new Map<number, Observation[]>();
    for (const observation of epoch.observations) {
      const list = byPrn.get(observation.prn) ?? [];
      list.push(observation);
      byPrn.set(observation.prn, list);
    }
    return [...byPrn.entries()].filter(([, entries]) => pairOf(entries)).map(([prn]) => prn);
  }))].sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(line('     2.10           OBSERVATION DATA    G (GPS)', 'RINEX VERSION / TYPE'));
  lines.push(line(`NAS Convert 2.11.0  NovAtel             ${date}`, 'PGM / RUN BY / DATE'));
  lines.push(line('Rinex Version 2.10 Observation File', 'COMMENT'));
  lines.push(line('Signal Strength values S1,S2 are in dBHz', 'COMMENT'));
  lines.push(line('', 'MARKER NAME'));
  lines.push(line('', 'MARKER NUMBER'));
  lines.push(line('', 'OBSERVER / AGENCY'));
  lines.push(line('                    NovAtel GPSCard', 'REC # / TYPE / VERS'));
  lines.push(line('', 'ANT # / TYPE'));
  lines.push(line(`${x.toFixed(4).padStart(14)}${y.toFixed(4).padStart(14)}${z.toFixed(4).padStart(14)}`, 'APPROX POSITION XYZ'));
  lines.push(line(`${'0.0000'.padStart(14)}${'0.0000'.padStart(14)}${'0.0000'.padStart(14)}`, 'ANTENNA: DELTA H/E/N'));
  lines.push(line('     1     1', 'WAVELENGTH FACT L1/2'));
  for (let at = 0; at < satellites.length; at += 7) {
    const group = satellites.slice(at, at + 7);
    const content = `     1     1${String(group.length).padStart(6)}${group.map((prn) => `   G${String(prn).padStart(2, '0')}`).join('')}`;
    lines.push(line(content, 'WAVELENGTH FACT L1/2'));
  }
  lines.push(line(`     8${OBS_TYPES.map((type) => type.padStart(6)).join('')}`, '# / TYPES OF OBSERV'));
  const interval = epochs.length > 1 ? (epochs[1].milliseconds - epochs[0].milliseconds) / 1000 : 0;
  lines.push(line(interval.toFixed(3).padStart(10), 'INTERVAL'));
  lines.push(line(`${gpsFields(first.week, first.milliseconds)}     GPS`, 'TIME OF FIRST OBS'));
  lines.push(line(`${gpsFields(last.week, last.milliseconds)}     GPS`, 'TIME OF LAST OBS'));
  lines.push(line('Leap Seconds Unknown', 'COMMENT'));
  lines.push(line('', 'END OF HEADER'));
  return lines;
}

function epochLine(epoch: Epoch, satellites: number[]): string[] {
  const date = gpsDate(epoch.week, epoch.milliseconds);
  const seconds = (epoch.milliseconds % 60000) / 1000;
  const head =
    String(date.getUTCFullYear() % 100).padStart(3) +
    String(date.getUTCMonth() + 1).padStart(3) +
    String(date.getUTCDate()).padStart(3) +
    String(date.getUTCHours()).padStart(2, '0').padStart(3) +
    String(date.getUTCMinutes()).padStart(2, '0').padStart(3) +
    seconds.toFixed(7).padStart(11) +
    String(0).padStart(3) +
    String(satellites.length).padStart(3);
  const chunks: string[] = [];
  for (let at = 0; at < satellites.length; at += 12) {
    const list = satellites.slice(at, at + 12).map((prn) => `G${String(prn).padStart(2, '0')}`).join('');
    chunks.push(at === 0 ? `${head}${list}`.padEnd(80) : `${' '.repeat(32)}${list}`.padEnd(80));
  }
  return chunks;
}

function observationLines(l1: Observation, l2: Observation): string[] {
  const snr = String(snrCode(l1.cnr));
  const snr2 = String(snrCode(l2.cnr));
  const values: Array<[number, string, string]> = [
    [l1.psr, '4', snr],
    [-l1.adr, ' ', snr],
    [l1.dop, '4', snr],
    [l1.cnr, ' ', ' '],
    [l2.psr, '4', snr2],
    [-l2.adr, ' ', snr2],
    [l2.dop, '4', snr2],
    [l2.cnr, ' ', ' '],
  ];

  const text = values.map(([value, lli, snrText]) => `${exactFixed(value, 3).padStart(14)}${lli}${snrText}`).join('');
  return [text.slice(0, 80), text.slice(80)];
}

export function buildRinex21Obs(frames: SbfFrame[], tables: EdieTables, options: Rinex21Options): string {
  const epochs = collectRanges(frames, tables);
  const lines = header(epochs, frames, tables, options);

  for (const epoch of epochs) {
    // Group by PRN, keeping first-appearance order.
    const order: number[] = [];
    const byPrn = new Map<number, Observation[]>();
    for (const observation of epoch.observations) {
      if (!byPrn.has(observation.prn)) {
        byPrn.set(observation.prn, []);
        order.push(observation.prn);
      }
      byPrn.get(observation.prn)!.push(observation);
    }
    const written = order.filter((prn) => pairOf(byPrn.get(prn)!));
    lines.push(...epochLine(epoch, written));
    for (const prn of written) {
      const { l1, l2 } = pairOf(byPrn.get(prn)!)!;
      lines.push(...observationLines(l1, l2));
    }
  }

  return `${lines.join('\r\n')}\r\n`;
}

