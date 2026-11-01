/**
 * The six residual items, checked end to end: our Convert against the installed suite's own Convert,
 * on the same synthetic capture, byte for byte.
 *
 * Every capture here is synthesised from `data/edie-layouts.json` and sealed with the real NovAtel
 * CRC, because none of these records can be asked out of a receiver (no COM port in this session, and
 * `FILESYSTEMCAPACITY` is refused by the firmware anyway). The suite converts a binary frame it has
 * never seen just as happily as a recorded one, which makes it the oracle.
 *
 *   node --experimental-strip-types 逆向/tools/oracle-verify.ts     (or plain `node`, Node 24)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { Payload, capture, frame, oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));

/** The two files our Convert writes for a capture, as line lists. */
function ours(input: Uint8Array): { ascii: string[]; abbrev: string[] } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const lines = (format: 'ASCII' | 'ABBREV_ASCII'): string[] => {
    const outcome = convertFrames(frames, { format, at, tables, name: 'probe.sbf' });
    return (outcome.files[0]?.text ?? '').split('\r\n').filter((line) => line.length > 0);
  };
  return { ascii: lines('ASCII'), abbrev: lines('ABBREV_ASCII') };
}

interface Case { label: string; input: Uint8Array; }

const cases: Case[] = [];

// ── 1/2 ─────────────────────────────────────────────────────────────────────────────────────────
// `pack(4)` for a counted array, and the `%Z` byte-array token (USERI2CREAD).
{
  const count = 256;
  const payload = new Payload(8 + count + 8);
  payload.u8(0, 0x42);
  payload.u32(4, count);                       // count at 4, not at 1
  for (let i = 0; i < count; i++) payload.u8(8 + i, i & 0xff);
  payload.u32(8 + count, 2);                   // request_length
  payload.u32(12 + count, 0x11223344);         // transaction_id
  cases.push({ label: 'pack4/useri2cread-256', input: capture(frame(2232, payload.bytes, { sequence: 1 })) });
}
{
  const registers = Uint8Array.from({ length: 257 }, (_, i) => 0xa0 + (i & 0x0f));
  const payload = new Payload(276);
  payload.u8(0, 0x42);
  payload.u32(4, 257);
  payload.bytes.set(registers, 8);
  payload.u32(268, 7);                         // 8 + 257 = 265 → 268
  payload.u32(272, 0x1234);
  const empty = new Payload(16);
  empty.u8(0, 0x42);
  empty.u32(4, 0);
  empty.u32(8, 7);
  empty.u32(12, 0x1234);
  const can = new Payload(28);
  can.u32(0, 3);
  can.u32(4, 0);
  can.u32(8, 0x123);
  can.u32(12, 3);
  can.bytes.set([0xde, 0xad, 0xbe], 16);
  can.u32(20, 0x55);                           // 16 + 3 = 19 → 20
  can.u32(24, 0x66);
  cases.push({
    label: 'pack4/un-aligned-array-end',
    input: capture(
      frame(2232, payload.bytes, { sequence: 1 }),
      frame(2232, empty.bytes, { sequence: 3 }),
      frame(2316, can.bytes, { sequence: 2 }),
    ),
  });
}

// ── 3 ──────────────────────────────────────────────────────────────────────────────────────────
// `%llu` / `%lld`, 64 bits wide (FILESYSTEMCAPACITY, INSPVACMP).
{
  const values = [0n, 1n, 4294967296n, 9007199254740993n, 18446744073709551615n];
  const payload = new Payload(4 + values.length * 20);
  payload.u32(0, values.length);
  values.forEach((value, index) => {
    const at = 4 + index * 20;
    payload.u32(at, index + 1);
    payload.u64(at + 4, value);
    payload.u64(at + 12, value + 1n);
  });
  const signed = [0n, -1n, -9007199254740993n, -9223372036854775808n].map((latitude, index) => {
    const inspva = new Payload(48);
    inspva.i64(8, latitude);
    inspva.i64(16, 1n);
    inspva.u32(24, 0xfffffffe);                // height = -2
    inspva.u32(44, 1234);
    return frame(1889, inspva.bytes, { sequence: index + 2 });
  });
  cases.push({ label: 'wide/llu-lld', input: capture(frame(2137, payload.bytes, { sequence: 1 }), ...signed) });
}

// ── 4 ──────────────────────────────────────────────────────────────────────────────────────────
// `#` text records are re-rendered, not copied (head and body).
{
  const seal = (sentence: string): string => `#${sentence}*${novatelCrc32(latin1Bytes(sentence)).toString(16).padStart(8, '0')}`;
  const BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,'
    + '2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';
  const lines = [
    // idle time and two body floats written non-canonically
    `BESTPOSA,USB2,0,72.00,COARSESTEERING,2442,570228.000,03801800,cdba,18278;SOL_COMPUTED,SINGLE,`
      + '30.539973063660,114.352807860480,64.82390,-14.40000,WGS84,1.02630,1.12190,2.83550,"",0.0000,'
      + '0.0000,31,17,17,17,00,06,30,03',
    // every header number written non-canonically
    `BESTPOSA,USB2,007,72.00,COARSESTEERING,02442,570228.0,3800800,CDBA,18278;${BODY}`,
    // two extra body tokens: dropped
    `BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY},99,88`,
    // two body tokens short: the whole record is dropped
    `BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY.slice(0, -5)}`,
  ];
  cases.push({ label: 'hash/re-render', input: capture(...lines.map((line) => `${seal(line)}\r\n`)) });
}

// ── 5 ──────────────────────────────────────────────────────────────────────────────────────────
// `$` + `$` with no CRLF: one record, resolved to the last sentence.
{
  const nmea = (body: string): string => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
  };
  const A = nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
  const B = nmea('GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,1000.1,M,46.9,M,,');
  const R = nmea('GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,003.1,W');
  const wrong = (line: string): string => `${line.slice(0, -2)}00`;
  cases.push({
    label: 'nmea/merged',
    input: capture(
      `${A}${B}\r\n`,                 // last wins
      `${A}${wrong(B)}\r\n`,          // last sentence broken → nothing
      `${wrong(A)}${B}\r\n`,          // first broken → still the last
      `${A}${B}${R}\r\n`,             // three sentences
      `${A}$GPGGA\r\n`,               // tail without a checksum → nothing
      `${A}${B.slice(0, -3)}*7a\r\n`, // lowercase checksum echoed verbatim
      `${A}$GNZZZ,1*36\r\n`,          // last is not a known NMEA log → nothing
    ),
  });
}

// ── 6 ──────────────────────────────────────────────────────────────────────────────────────────
// `<` with only its header prints nothing.
{
  const bestpos = new Payload(72);
  cases.push({
    label: 'text/header-only',
    input: capture(
      '<BESTPOS COM1 0 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n',
      '<RANGE COM1 1 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n',
      frame(42, bestpos.bytes, { sequence: 9 }),
    ),
  });
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
for (const test of cases) {
  const expected = oracle(test.input, test.label.replace(/[^A-Za-z0-9]/g, ''));
  const actual = ours(test.input);
  for (const format of ['ascii', 'abbrev'] as const) {
    const want = expected[format];
    const got = actual[format];
    const same = want.length === got.length && want.every((line, index) => line === got[index]);
    console.log(`${same ? 'OK  ' : 'FAIL'} ${test.label.padEnd(28)} ${format.padEnd(6)} oracle ${want.length} line(s), ours ${got.length}`);
    if (!same) {
      failures += 1;
      for (let index = 0; index < Math.max(want.length, got.length); index++) {
        if (want[index] === got[index]) continue;
        console.log(`     [${index}] oracle ${JSON.stringify(want[index])}`);
        console.log(`     [${index}] ours   ${JSON.stringify(got[index])}`);
      }
    }
  }
}
console.log(failures === 0 ? '\nall six items agree with the suite, line for line' : `\n${failures} comparison(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
