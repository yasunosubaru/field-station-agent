/**
 * `--daily-utc`: which records move the day clock, and can they move it backwards?
 *
 *   node 逆向/tools/probe-daily-matrix.ts
 *
 * Every case is three synthetic `BESTPOS` records (payload 32 B, printed by the suite, so the parts
 * show exactly where the cut landed) plus, in the last row, the capture's own trailing bytes. The
 * shape is always `A → P → C`:
 *
 *   A  (2442, 577759)  day 17100 — the clock's anchor, status FINESTEERING
 *   P  the probe: a time status and a week
 *   C  (2442, 577760)  day 17100 — reveals a *backwards* pull by P (a forward pull cuts at P itself)
 *
 * "cut at P" = P moved the clock forward; "cut at C" = P pulled it back; "one part" = P did not
 * move it; "cut at A" would mean the anchor itself was dropped.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { capture, frame, SUITE, TEMP_ROOT } from './oracle.ts';
import { crcHex, novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';

const STATUS_NAME: Record<number, string> = {
  0: 'UNKNOWN', 20: 'APPROXIMATE', 60: 'COARSESTEERING', 80: 'FINE', 100: 'FINEADJUSTING',
  120: 'DEGRADED', 160: 'ALIGNING', 180: 'FINESTEERING', 200: 'SATTIME',
};

const bestpos = (week: number, milliseconds: number, timeStatus: number) =>
  frame(42, new Uint8Array(32), { week, milliseconds, timeStatus, portAddress: 32 });

function parts(bytes: Uint8Array): { names: string[]; lines: string[][] } {
  const dir = mkdtempSync(join(TEMP_ROOT, 'daily-matrix-'));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, bytes);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, ['-a', '-o', out, '--daily-utc', input], { stdio: 'pipe', timeout: 300_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const formatDir = join(out, stem, stamp, 'ASCII');
    const names = readdirSync(formatDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lines = names.map((name) => {
      const text = Buffer.from(readFileSync(join(formatDir, name))).toString('latin1');
      return text.split('\r\n').filter((line) => line.length > 0)
        .map((line) => line.split(',').slice(0, 7).join(','));
    });
    return { names, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const A = bestpos(2442, 577759, 180);
const C = bestpos(2442, 577760, 180);

/** A text record with its own header: `#BESTPOSA,port,seq,idle,STATUS,week,sec,…`. */
const latin1Bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/**
 * A hand-built `#BESTPOSA` text record. The suite echoes a text record verbatim when its `*crc`
 * matches: measured, the CRC covers the record **after** its leading `#` (see
 * `probe-text-crc.ts`), so the week/seconds/status can be set freely.
 */
const textBestpos = (week: number, seconds: number, timeStatus: string): string => {
  const body = `#BESTPOSA,USB2,0,72.0,${timeStatus},${week},${seconds.toFixed(3)},03801800,cdba,18278;`
    + 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,'
    + '2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';
  return `${body}*${crcHex(novatelCrc32(latin1Bytes(body.slice(1))))}\r\n`;
};

const cases: Array<[string, Uint8Array]> = [];
for (const status of [0, 20, 60, 80, 100, 120, 160, 180, 200]) {
  cases.push([`P = ${STATUS_NAME[status]} (${status}) advancing a day`, capture(A, bestpos(2443, 1000, status), C)]);
}
for (const status of [0, 20, 60, 80, 200]) {
  cases.push([`P = ${STATUS_NAME[status]} (${status}) week 0, day 0`, capture(A, bestpos(0, 2176, status), C)]);
}
// Late records: the clock sees 17101, then 17100, then 17101 again.
cases.push(['backwards then forwards again', capture(
  bestpos(2443, 1000, 60), bestpos(2442, 577760, 60), bestpos(2443, 2000, 60),
)]);
cases.push(['same day, out of order', capture(
  bestpos(2442, 577760, 60), bestpos(2442, 577759, 60), bestpos(2442, 577761, 60),
)]);
cases.push(['week 0 first, then real time', capture(
  bestpos(0, 2176, 60), bestpos(2443, 1000, 60), bestpos(2443, 2000, 60),
)]);
cases.push(['real time first, then week 0, then next day', capture(
  bestpos(2442, 577759, 60), bestpos(0, 2176, 60), bestpos(2443, 1000, 60),
)]);

// The same probes as *text* records — the suite's printed time status is the text's own field.
for (const status of ['UNKNOWN', 'APPROXIMATE', 'COARSESTEERING', 'FINE', 'FINEADJUSTING', 'DEGRADED', 'ALIGNING', 'FINESTEERING', 'SATTIME']) {
  cases.push([`text P = ${status} advancing a day`, capture(
    textBestpos(2442, 577759, 'FINESTEERING'), textBestpos(2443, 1, status), textBestpos(2442, 577760, 'FINESTEERING'),
  )]);
}
for (const status of ['UNKNOWN', 'APPROXIMATE', 'COARSESTEERING', 'SATTIME', 'FINESTEERING']) {
  cases.push([`text P = ${status} week 0, day 0`, capture(
    textBestpos(2442, 577759, 'FINESTEERING'), textBestpos(0, 2.176, status), textBestpos(2442, 577760, 'FINESTEERING'),
  )]);
}
cases.push(['text backwards then forwards again', capture(
  textBestpos(2443, 1, 'COARSESTEERING'), textBestpos(2442, 577760, 'COARSESTEERING'),
  textBestpos(2443, 2, 'COARSESTEERING'),
)]);
cases.push(['binary DEGRADED backwards then forwards', capture(
  bestpos(2443, 1000, 120), bestpos(2442, 577760, 120), bestpos(2443, 2000, 120),
)]);
cases.push(['binary FINE backwards then forwards', capture(
  bestpos(2443, 1000, 80), bestpos(2442, 577760, 80), bestpos(2443, 2000, 80),
)]);
cases.push(['mixed: binary DEGRADED, text COARSESTEERING, back, forward', capture(
  bestpos(2443, 1000, 120), textBestpos(2442, 577760, 'COARSESTEERING'), bestpos(2443, 2000, 120),
)]);

// Does a record that does *not* move the clock still *start* it?
cases.push(['init: binary week 0 COARSESTEERING, then a real day', capture(
  bestpos(0, 2176, 60), bestpos(2443, 1000, 120), bestpos(2443, 2000, 120),
)]);
cases.push(['init: binary week 0 UNKNOWN, then a real day', capture(
  bestpos(0, 2176, 0), bestpos(2443, 1000, 120), bestpos(2443, 2000, 120),
)]);
cases.push(['init: text week 0 UNKNOWN, then a real day', capture(
  textBestpos(0, 2.176, 'UNKNOWN'), textBestpos(2443, 1, 'COARSESTEERING'), textBestpos(2443, 2, 'COARSESTEERING'),
)]);
cases.push(['init: binary week 0 COARSESTEERING, then a late real day', capture(
  bestpos(0, 2176, 60), bestpos(2442, 577760, 120), bestpos(2443, 1000, 120),
)]);

for (const [label, bytes] of cases) {
  const { names, lines } = parts(bytes);
  const firsts = lines.map((list) => (list[0] ?? '').split(',').slice(5, 7).join('/'));
  console.log(`${label.padEnd(46)} ${String(names.length).padStart(2)} part(s)  first stamps: ${firsts.map((stamp) => stamp || '(empty)').join(' | ')}  lines ${lines.map((list) => list.length).join('+')}`);
}
