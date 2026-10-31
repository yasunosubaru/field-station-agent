/**
 * The three ASCII conversion strings that had no implementation: `%T`, `%P` and `%c`.
 *
 * Every expectation below is an **oracle** line — the suite's own Convert
 * (`NovAtelApplicationSuite.exe -a`) run over a synthetic SBF capture carrying the boundary values.
 * Nothing here is taken from the manual.
 *
 *  - `%T` (11 uses) — CLOCKMODEL, RAWALM, GLOALMANAC, GLORAWALM, GLORAWFRAME, GLORAWEPHEM,
 *    GALALMANAC, GALFNAVRAWEPHEMERIS, GALINAVRAWEPHEMERIS, QZSSRAWALMANAC: a millisecond count
 *    printed as seconds with three decimals.
 *  - `%P` (58 uses across the 29 PASS* logs) — the declared byte count, then the payload escaped
 *    as one token.
 *  - `%c` (BESTUTM `zone_letter`) — one raw character, the number's low byte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildLongHeader } from '../src/header.ts';
import { novatelCrc32 } from '../src/crc.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { SbfDeframer } from '../src/framing.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const idOf = new Map<string, string>();
for (const [id, layout] of Object.entries(tables.messages)) idOf.set(layout.name, id);

/** One long-header SBF frame, carrying the same header every oracle probe used. */
function frameBytes(messageId: number, payload: Uint8Array, sequence: number): Uint8Array {
  const header = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    portAddress: 160,
    sequence,
    idleTimeRaw: 150,
    timeStatus: 180,
    week: 2402,
    milliseconds: 91818000,
    receiverStatus: 0x03801800,
    reserved: 0x8d29,
    softwareVersion: 18278,
  });
  const body = new Uint8Array(header.length + payload.length);
  body.set(header, 0);
  body.set(payload, header.length);
  const bytes = new Uint8Array(body.length + 4);
  bytes.set(body, 0);
  new DataView(bytes.buffer).setUint32(body.length, novatelCrc32(body), true);
  return bytes;
}

/** The ASCII line Convert writes for that frame. */
function lineOf(name: string, payload: Uint8Array, sequence: number): string {
  const id = idOf.get(name);
  assert.ok(id, `no layout for ${name}`);
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(frameBytes(Number(id), payload, sequence))];
  assert.equal(frames.length, 1, 'the probe frame must deframe cleanly');
  const frame = frames[0];
  assert.ok(frame.kind === 'sbf' && frame.crcOk);
  return encodeAsciiLog(frame, tables.messages[id], tables);
}

const bodyOf = (line: string): string[] => line.slice(line.indexOf(';') + 1, line.lastIndexOf('*')).split(',');
/** The whole body, commas included — a `%P` payload can carry its own commas. */
const bodyText = (line: string): string => line.slice(line.indexOf(';') + 1, line.lastIndexOf('*'));
const sequenceOf = (oracle: string): number => Number(/,SPECIAL,(\d+),/.exec(oracle)![1]);

// ------------------------------------------------------------------ %T

test('%T prints milliseconds as seconds with three decimals', () => {
  const expected: Array<[number, string]> = [
    [0, '0.000'],
    [1, '0.001'],
    [999, '0.999'],
    [1000, '1.000'],
    [59999, '59.999'],
    [60000, '60.000'],
    [91818000, '91818.000'],
    [86399999, '86399.999'],
    [4294967295, '4294967.295'],
    [123456789, '123456.789'],
  ];
  for (const [ms, printed] of expected) {
    const payload = new Uint8Array(132);
    const view = new DataView(payload.buffer);
    view.setUint32(4, 7, true);
    view.setUint32(8, ms, true);
    view.setUint32(12, ms, true);
    // CLOCKMODEL carries the same `%T` twice (`milliseconds` and `milliseconds_3`).
    assert.deepEqual(bodyOf(lineOf('CLOCKMODEL', payload, 0)).slice(2, 4), [printed, printed], `%T of ${ms}`);
  }
});

test('%T on RAWALM, whole line: the suite output for five timestamps', () => {
  const cases: Array<[number, number, string]> = [
    [2402, 91818000, '#RAWALMA,SPECIAL,16,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;2402,91818.000,0*a89b0778'],
    [0, 0, '#RAWALMA,SPECIAL,17,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;0,0.000,0*418ad6b0'],
    [2402, 4294967295, '#RAWALMA,SPECIAL,18,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;2402,4294967.295,0*a0715dc3'],
    [2402, 1000, '#RAWALMA,SPECIAL,19,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;2402,1.000,0*afc816bc'],
    [2000, 86400000, '#RAWALMA,SPECIAL,20,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;2000,86400.000,0*e0f3904a'],
  ];
  for (const [week, ms, oracle] of cases) {
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setUint32(0, week, true);
    view.setUint32(4, ms, true);
    assert.equal(lineOf('RAWALM', payload, sequenceOf(oracle)), oracle);
  }
});

test('%T with the array count outside the payload: no count is printed at all', () => {
  // These GLORAWEPHEM payloads stop right after `milliseconds`, so the `glo_raw_ephem` count is not
  // in the record: the suite writes `…,91818.000*…`, not `…,91818.000,0`. RAWALM above shows the
  // contrast — a count that is present but zero does print `0`.
  const cases: Array<[number, string]> = [
    [91818000, '#GLORAWEPHEMA,SPECIAL,21,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;3,7,12,2402,91818.000*3e9e3919'],
    [0, '#GLORAWEPHEMA,SPECIAL,22,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;3,7,12,2402,0.000*d9338b17'],
    [345600000, '#GLORAWEPHEMA,SPECIAL,23,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;3,7,12,2402,345600.000*9a71cbdb'],
  ];
  for (const [ms, oracle] of cases) {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 3, true);
    view.setUint16(2, 7, true);
    view.setUint32(4, 12, true);
    view.setUint32(8, 2402, true);
    view.setUint32(12, ms, true);
    assert.equal(lineOf('GLORAWEPHEM', payload, sequenceOf(oracle)), oracle);
  }
});

test('%T behind other fields: GALALMANAC', () => {
  const payload = new Uint8Array(100);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 5, true);
  view.setUint32(20, 2402, true);
  view.setUint32(24, 91818000, true);
  assert.match(lineOf('GALALMANAC', payload, 0), /;5,FALSE,FALSE,0,0,0,0,0,2402,91818\.000,0\.000/);
});

// ------------------------------------------------------------------ %P

const passPayload = (count: number, data: Uint8Array): Uint8Array => {
  const payload = new Uint8Array(4 + data.length);
  new DataView(payload.buffer).setUint32(0, count >>> 0, true);
  payload.set(data, 4);
  return payload;
};

/** The payloads the oracle probe squeezed through PASSCOM1, in probe order. */
const PASS_PAYLOADS: Uint8Array[] = [
  Uint8Array.from(Buffer.from('hello')),
  new Uint8Array(0),
  Uint8Array.from([0x41]),
  Uint8Array.from([0x00]),
  Uint8Array.from([0xff]),
  Uint8Array.from([0x01, 0x7f, 0x80, 0xfe]),
  Uint8Array.from(Buffer.from('a,b;c*d')),
  Uint8Array.from(Buffer.from('ab\r\ncd')),
  Uint8Array.from(Buffer.from('a"b')),
  Uint8Array.from(Buffer.from('a\\b')),
  Uint8Array.from(Buffer.from('#BESTPOSA,USB1,1,0.0,FINESTEERING,2402,91818.000,00000000,8d29,18278;x*deadbeef')),
  Uint8Array.from(Buffer.from('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47')),
  Uint8Array.from(Buffer.from('LOG BESTPOS ONCHANGED\r\n')),
  new Uint8Array(80).fill(0x41),
  new Uint8Array(8),
];

/** What the suite printed for each of them: bytes 0x20..0x7E verbatim (`\` doubled), the rest `\xNN`. */
const PASS_ESCAPED = [
  'hello',
  '',
  'A',
  '\\x00',
  '\\xff',
  '\\x01\\x7f\\x80\\xfe',
  'a,b;c*d',
  'ab\\x0d\\x0acd',
  'a"b',
  'a\\\\b',
  '#BESTPOSA,USB1,1,0.0,FINESTEERING,2402,91818.000,00000000,8d29,18278;x*deadbeef',
  '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47',
  'LOG BESTPOS ONCHANGED\\x0d\\x0a',
  'A'.repeat(80),
  '\\x00'.repeat(8),
];

test('%P: the count, then the whole payload as one escaped token', () => {
  PASS_PAYLOADS.forEach((data, index) => {
    assert.equal(bodyText(lineOf('PASSCOM1', passPayload(data.length, data), index)), `${data.length},${PASS_ESCAPED[index]}`, `case ${index}`);
  });
});

test('%P whole lines: the escaping is part of the CRC', () => {
  const cases: Array<[number, string, string]> = [
    [0, 'hello', '#PASSCOM1A,SPECIAL,0,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;5,hello*f381d64c'],
    [1, '', '#PASSCOM1A,SPECIAL,1,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;0,*84804504'],
    [7, 'ab\r\ncd', '#PASSCOM1A,SPECIAL,7,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;6,ab\\x0d\\x0acd*b41c0ae2'],
    [9, 'a\\b', '#PASSCOM1A,SPECIAL,9,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;3,a\\\\b*a5f74544'],
  ];
  for (const [sequence, text, oracle] of cases) {
    const data = Uint8Array.from(Buffer.from(text, 'latin1'));
    assert.equal(lineOf('PASSCOM1', passPayload(data.length, data), sequence), oracle);
  }
});

test('%P: all 256 byte values in one payload', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  let escaped = '';
  for (let i = 0; i < 256; i += 1) {
    if (i >= 0x20 && i <= 0x7e) escaped += i === 0x5c ? '\\\\' : String.fromCharCode(i);
    else escaped += `\\x${i.toString(16).padStart(2, '0')}`;
  }
  assert.equal(bodyText(lineOf('PASSCOM1', passPayload(256, all), 0)), `256,${escaped}`);
  assert.ok(escaped.startsWith('\\x00\\x01\\x02'));
  assert.ok(escaped.endsWith('\\xfc\\xfd\\xfe\\xff'));
});

test('%P: a count past the payload end stops at the payload', () => {
  // The suite reads exactly `count` bytes and runs off the end of the record (measured: 10 declared
  // and 3 present printed `abc` plus the frame's CRC bytes, and 0xffffffff crashed Convert). We
  // clamp, which is the same bytes for every record a receiver writes.
  assert.equal(bodyText(lineOf('PASSCOM1', passPayload(10, Uint8Array.from(Buffer.from('abc'))), 0)), '10,abc');
});

// ------------------------------------------------------------------ %c

test('%c prints the low byte as one raw character', () => {
  const cases: Array<[number, string]> = [
    [0, '\x00'],
    [1, '\x01'],
    [9, '\t'],
    [32, ' '],
    [65, 'A'],
    [77, 'M'],
    [90, 'Z'],
    [97, 'a'],
    [122, 'z'],
    [126, '~'],
    [127, '\x7f'],
    [128, '\x80'],
    [200, '\xc8'],
    [255, '\xff'],
    [256, '\x00'],
    [0xffffffff, '\xff'],
    [0x20ac, '\xac'],
    [0x1f600, '\x00'],
  ];
  for (const [letter, printed] of cases) {
    const payload = new Uint8Array(80);
    const view = new DataView(payload.buffer);
    view.setUint32(8, 32, true);
    view.setUint32(12, letter, true);
    view.setFloat64(16, 4000000.5, true);
    view.setFloat64(24, 500000.25, true);
    view.setFloat64(32, 100.125, true);
    assert.equal(bodyOf(lineOf('BESTUTM', payload, 0))[3], printed, `%c of ${letter}`);
  }
});

test('%c whole line', () => {
  const payload = new Uint8Array(80);
  const view = new DataView(payload.buffer);
  view.setUint32(8, 32, true);
  view.setUint32(12, 65, true);
  view.setUint32(44, 0, true);
  view.setFloat64(16, 4000000.5, true);
  view.setFloat64(24, 500000.25, true);
  view.setFloat64(32, 100.125, true);
  assert.equal(
    lineOf('BESTUTM', payload, 4),
    '#BESTUTMA,SPECIAL,4,75.0,FINESTEERING,2402,91818.000,03801800,8d29,18278;SOL_COMPUTED,NONE,32,A,4000000.5000,500000.2500,100.1250,0.0000,UNKNOWN,0.0000,0.0000,0.0000,"",0.000,0.000,0,0,0,0,0,00,00,00*bf5fbe8d',
  );
});

test('an out-of-table enum prints UNKNOWN, whether or not the enum declares a member', () => {
  // `Datum` starts at 1 and has no UNKNOWN member; the suite still writes `UNKNOWN` for 0, 999 and
  // 0xffffffff. SolutionStatus/PositionType (which do declare one) behave the same.
  for (const datum of [0, 999, 0xffffffff]) {
    const payload = new Uint8Array(80);
    new DataView(payload.buffer).setUint32(12, 65, true);
    new DataView(payload.buffer).setUint32(44, datum, true);
    assert.equal(bodyOf(lineOf('BESTUTM', payload, 0))[8], 'UNKNOWN', `datum ${datum}`);
  }
  const bestpos = new Uint8Array(72);
  new DataView(bestpos.buffer).setUint32(0, 99, true);
  new DataView(bestpos.buffer).setUint32(4, 99, true);
  assert.deepEqual(bodyOf(lineOf('BESTPOS', bestpos, 0)).slice(0, 2), ['UNKNOWN', 'UNKNOWN']);
});
