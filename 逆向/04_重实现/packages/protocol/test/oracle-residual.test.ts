/**
 * The six `pack(4)` / `%Z` / 64-bit / text-record questions that no capture could answer, each pinned
 * to what the installed NovAtel Application Suite (2.11.0) prints for a **synthetic** record.
 *
 * None of these logs can be asked out of a receiver in this environment (no COM port; the firmware
 * refuses `FILESYSTEMCAPACITY` outright), but Convert converts any well-formed binary frame it is
 * handed, so the oracle is the suite itself. `逆向/tools/oracle-verify.ts` reproduces every number
 * below by running `NovAtelApplicationSuite.exe -a` / `--abbrev` on the same bytes; the literals here
 * are that run's output, copied.
 *
 *   1. `pack(4)` for a **counted array** — the ULONG count goes to 4, the elements follow it, and the
 *      fields behind the array are aligned again (USERI2CREAD, USERCANDATA);
 *   2. `%Z` on a variable-length array — one lowercase hex token, not one decimal per element;
 *   3. `ULONG64` / `LONGLONG` — 64 bits wide and printed exactly (`%llu`, `%lld`);
 *   4. `#…*crc` text records are **re-rendered** from the parsed fields, not copied;
 *   5. `$…$…` with no CRLF between them is one record that resolves to the **last** sentence;
 *   6. a `<` record with only its header prints nothing at all.
 *
 * Plus the width rule itself: all 15 fixed layouts whose dense size differs from the packed one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { appendCrcLe, novatelCrc32 } from '../src/crc.ts';
import { buildLongHeader } from '../src/header.ts';
import { encodeAsciiLog, latin1Bytes } from '../src/ascii-log.ts';
import { encodeAbbrevLines } from '../src/abbrev-log.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { abbrevTextLogLines, textLogLines } from '../src/text-log.ts';
import { packedStructSize, type EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

/** `#NAME,COM1,1,0.0,…` — the header every synthetic frame in this file carries. */
const HEAD = 'COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278';

function frameOf(messageId: number, payload: Uint8Array, sequence = 1): SbfFrame {
  const head = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    portAddress: 32, // COM1
    sequence,
    idleTimeRaw: 0,
    timeStatus: 180, // FINESTEERING
    week: 2402,
    milliseconds: 577759000,
    receiverStatus: 0x03800800,
    reserved: 0xcdba,
    softwareVersion: 18278,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  const bytes = appendCrcLe(body);
  const parsed = new SbfDeframer({ crcMode: 'validate' }).push(bytes);
  return parsed[0] as SbfFrame;
}

const ascii = (id: number, payload: Uint8Array, sequence = 1): string =>
  encodeAsciiLog(frameOf(id, payload, sequence), tables.messages[String(id)]!, tables);
const abbrev = (id: number, payload: Uint8Array, sequence = 1): string[] =>
  encodeAbbrevLines(frameOf(id, payload, sequence), tables.messages[String(id)]!, tables);

function words(size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

// ---------------------------------------------------------------------------------------------
// 1 + 2 — `pack(4)` behind a counted array, and `%Z` as one hex token
// ---------------------------------------------------------------------------------------------

test('a counted array: the ULONG count is at 4, the elements follow, and the next u32 is aligned', () => {
  // USERI2CREAD: `slave_device_address` u8 at 0, then the register array. Dense says the count is at
  // 1 and `request_length` at 5; the suite reads 4 and 12. The payload below proves which: 257
  // registers end at 265, so `request_length` is at 268 (aligned) and `transaction_id` at 272 —
  // the suite's line for this frame ends `…,7,4660*c119…`, a dense reader finds 0x07000000 instead.
  const registers = 257;
  const { bytes, view } = words(276);
  view.setUint8(0, 0x42);
  view.setUint32(4, registers, true);
  for (let i = 0; i < registers; i++) view.setUint8(8 + i, 0xa0 + (i & 0x0f));
  view.setUint32(268, 7, true);
  view.setUint32(272, 0x1234, true);

  const line = ascii(2232, bytes);
  // `7` and `4660` (0x1234) are the two u32s; the 514-character register token sits between them.
  assert.ok(line.endsWith(';42,257,' + `${'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf'.repeat(16)}a0`
    + ',7,4660*' + novatelCrc32(latin1Bytes(line.slice(1, line.lastIndexOf('*')))).toString(16).padStart(8, '0')), line.slice(0, 60));
  // The suite's own tail for this frame: `…,7,4660*2d992574`.
  assert.equal(line.slice(-16), ',7,4660*2d992574');
  assert.equal(line.split(';')[1].split(',')[2].length, 514, '257 registers, two hex digits each');
  // The 256-register frame the first probe used, whole line, as the suite writes it (`-a` locally):
  // the count is 256 there and the two u32s read 2 and 0x11223344.
  const wide = words(272);
  wide.view.setUint8(0, 0x42);
  wide.view.setUint32(4, 256, true);
  for (let i = 0; i < 256; i++) wide.view.setUint8(8 + i, i & 0xff);
  wide.view.setUint32(264, 2, true);
  wide.view.setUint32(268, 0x11223344, true);
  const suiteLine = '#USERI2CREADA,' + HEAD + ';42,256,'
    + Array.from({ length: 256 }, (_, i) => (i & 0xff).toString(16).padStart(2, '0')).join('')
    + ',2,287454020*c119ee8e';
  assert.equal(ascii(2232, wide.bytes), suiteLine);
});

test('USERCANDATA: 3 received bytes print as one `deadbe` token, and the tail fields are aligned', () => {
  // The array ends at 16 + 3 = 19, so `transaction_id` is at 20 (not 19) and `frame_index` at 24.
  // The suite's line for this frame is `…;UNKNOWN,UNKNOWN,00000123,3,deadbe,00000055,102*fad65d3b`.
  const { bytes, view } = words(28);
  view.setUint32(0, 3, true);      // port (past the end of the CommPort enum → UNKNOWN)
  view.setUint32(4, 0, true);      // message_type
  view.setUint32(8, 0x123, true);  // message_id, `%x`
  view.setUint32(12, 3, true);     // received_data count
  bytes.set([0xde, 0xad, 0xbe], 16);
  view.setUint32(20, 0x55, true);  // transaction_id
  view.setUint32(24, 0x66, true);  // frame_index

  assert.equal(ascii(2316, bytes, 2), '#USERCANDATAA,COM1,2,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;UNKNOWN,UNKNOWN,00000123,3,deadbe,00000055,102*fad65d3b');
  assert.deepEqual(abbrev(2316, bytes, 2), [
    '<USERCANDATA COM1 2 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278',
    '<     UNKNOWN UNKNOWN 00000123 3 deadbe 00000055 102',
  ]);
});

test('a zero-length `%Z` array prints an empty token, i.e. two commas in a row', () => {
  // Measured with the suite: `…;42,0,,7,4660*c47be5b5` — the count is 0, the token is empty, and the
  // two `u32`s behind it are still read at 8 and 12.
  const { bytes, view } = words(16);
  view.setUint8(0, 0x42);
  view.setUint32(4, 0, true);
  view.setUint32(8, 7, true);
  view.setUint32(12, 0x1234, true);
  assert.equal(ascii(2232, bytes, 3), '#USERI2CREADA,COM1,3,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;42,0,,7,4660*c47be5b5');
  assert.deepEqual(abbrev(2232, bytes, 3), [
    '<USERI2CREAD COM1 3 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278',
    '<     42 0  7 4660',
  ]);
});

// ---------------------------------------------------------------------------------------------
// 3 — 64-bit integers
// ---------------------------------------------------------------------------------------------

test('`%llu` prints all 64 bits: 2^32, 2^53 + 1 and 2^64 - 1 are exact', () => {
  // FILESYSTEMCAPACITY: count u32 at 0, then { enum, %llu, %llu } × n at stride 20 (pack(4) leaves
  // that stride alone: 4 + 8 + 8). Measured with the suite on a synthetic frame; 9007199254740993
  // and 18446744073709551615 are the two values a double cannot hold.
  const values = [0n, 1n, 4294967296n, 9007199254740993n, 18446744073709551615n];
  const { bytes, view } = words(4 + values.length * 20);
  view.setUint32(0, values.length, true);
  values.forEach((value, index) => {
    const at = 4 + index * 20;
    view.setUint32(at, index + 1, true);
    view.setBigUint64(at + 4, value, true);
    view.setBigUint64(at + 12, value + 1n, true);
  });
  assert.equal(ascii(2137, bytes), '#FILESYSTEMCAPACITYA,' + HEAD + ';5,USBSTICK,0,1,RAMDRIVE,1,2,'
    + 'DEFAULT_NO_STORAGE,4294967296,4294967297,INTERNAL_FLASH,9007199254740993,9007199254740994,'
    + 'UNKNOWN,18446744073709551615,0*f33c5611');
});

test('`%lld` prints all 64 bits, -2^63 included, and INSPVACMP is read with packed offsets', () => {
  // INSPVACMP: dense 44 → packed 48. `latitude` is a LONGLONG whose dense offset is 6; the suite
  // reads it at 8 (and `height` at 24, `milliseconds` at 44). Measured on synthetic frames.
  const inspect = (latitude: bigint, sequence: number): string => {
    const { bytes, view } = words(48);
    view.setBigInt64(8, latitude, true);
    view.setBigInt64(16, 1n, true);
    view.setUint32(24, 0xfffffffe, true); // height = -2
    view.setUint32(44, 1234, true);
    return ascii(1889, bytes, sequence);
  };
  assert.equal(inspect(0n, 2), '#INSPVACMPA,COM1,2,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;0,0,0,0,1,-2,0,0,0,0,0,0,0,1234*604b0731');
  assert.equal(inspect(-9007199254740993n, 4), '#INSPVACMPA,COM1,4,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;0,0,0,-9007199254740993,1,-2,0,0,0,0,0,0,0,1234*7fef7060');
  assert.equal(inspect(-9223372036854775808n, 5), '#INSPVACMPA,COM1,5,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;0,0,0,-9223372036854775808,1,-2,0,0,0,0,0,0,0,1234*4ff227fc');
});

// ---------------------------------------------------------------------------------------------
// the width rule itself: all 15 fixed layouts whose dense size differs from `pack(4)`
// ---------------------------------------------------------------------------------------------

test('every fixed layout whose dense size differs is read at its packed size', () => {
  // `packedStructSize` is the rule the writers apply to the stored offsets, and the payload length
  // the suite's Convert needs to read a record sensibly. Each pair below was checked against the
  // suite with a synthetic record of exactly the packed length (`逆向/tools/oracle-sweep.ts`), so the
  // length itself is the measured fact.
  const expected: Record<number, [string, number, number]> = {
    25: ['RAWGPSSUBFRAME', 46, 48],
    259: ['GPGGARTK', 53, 56],
    477: ['SOFTLOADSREC', 519, 520],
    719: ['GLOCLOCK', 57, 61],
    973: ['RAWSBASFRAME', 45, 48],
    977: ['SBAS1', 35, 36],
    981: ['SBAS18', 46, 48],
    1132: ['HEADINGEXT', 100, 102],
    1330: ['QZSSRAWSUBFRAME', 42, 44],
    1889: ['INSPVACMP', 44, 48],
    1890: ['INSPVASDCMP', 35, 40],
    1952: ['SURVEYPOSITION', 41, 44],
    2093: ['WIFIAPSETTINGS', 136, 138],
    2213: ['WIFINETCONFIG', 174, 176],
    2528: ['PROFILERESPONSE', 330, 333],
  };
  for (const [id, [name, dense, packed]] of Object.entries(expected)) {
    const layout = tables.messages[id]!;
    assert.equal(layout.name, name, `log ${id}`);
    const denseSize = layout.fields.reduce((sum, field) => sum + (field.kind === 'array'
      ? (field.countSize || 0) + (field.fixedCount ?? 0) * field.stride
      : field.size), 0);
    assert.equal(denseSize, dense, `${name} dense size`);
    assert.equal(packedStructSize(layout.fields), packed, `${name} pack(4) size`);
  }
});

test('three of them, byte for byte: SBAS1, QZSSRAWSUBFRAME, INSPVASDCMP', () => {
  // A deterministic byte pattern at the packed length (`(i * 37 + 11) & 0xff`), converted by the
  // suite. Each line is that run's output; a dense reader prints a different tail (`0` for the
  // `ULONG` that would fall past the end).
  const pattern = (length: number): Uint8Array => {
    const { bytes, view } = words(length);
    for (let i = 0; i < length; i++) view.setUint8(i, (i * 37 + 11) & 0xff);
    return bytes;
  };
  assert.equal(ascii(977, pattern(36)), '#SBAS1A,' + HEAD
    + ';2052403211,9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c61,452317355*cfbda259');
  assert.equal(ascii(1330, pattern(44)), '#QZSSRAWSUBFRAMEA,' + HEAD
    + ';2052403211,250201247,33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f64,1109260499*dd968916');
  assert.equal(ascii(1890, pattern(40)), '#INSPVASDCMPA,' + HEAD
    + ';12299,250201247,22579,41597,60615,13841,32859,51877,5359,24121,43139,205,242,86613c17,171,2928239679*aca3d894');
});

// ---------------------------------------------------------------------------------------------
// 4 — `#` text records are re-rendered
// ---------------------------------------------------------------------------------------------

const BESTPOS_BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,'
  + '1.0263,1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';
const BESTPOS_LINE = '#BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
  + `${BESTPOS_BODY}*8820f06a`;

/** A `#` frame with the CRC the receiver would write, so only the rendering is under test. */
function hashFrame(sentence: string): Frame {
  const crc = novatelCrc32(latin1Bytes(sentence)).toString(16).padStart(8, '0');
  return { kind: 'text', prefix: '#', text: `#${sentence}*${crc}\r\n` };
}

test('a `#BESTPOSA` written non-canonically comes back canonical, CRC and all', () => {
  // The suite parses the tokens into fields and prints them again: `72.00` → `72.0`,
  // `30.539973063660` → `30.53997306366`, `64.82390` → `64.8239`. Copied verbatim, the line would
  // keep the input's extra digits and its old CRC.
  const nonCanonical = 'BESTPOSA,USB2,0,72.00,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
    + 'SOL_COMPUTED,SINGLE,30.539973063660,114.352807860480,64.82390,-14.40000,WGS84,1.02630,1.12190,'
    + '2.83550,"",0.0000,0.0000,31,17,17,17,00,06,30,03';
  assert.equal(textLogLines([hashFrame(nonCanonical)], tables).get(0), BESTPOS_LINE);
  // The canonical line round-trips unchanged (13 such records in b1, 11 in live-nav, 10 in live-nav2).
  assert.equal(textLogLines([hashFrame(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BESTPOS_BODY}`)], tables).get(0), BESTPOS_LINE);
});

test('the nine header tokens are re-rendered too', () => {
  // `USB2,007,72.00,02442,570228.0,3800800,CDBA` → `USB2,7,72.0,2442,570228.000,03800800,cdba`.
  const odd = `BESTPOSA,USB2,007,72.00,COARSESTEERING,02442,570228.0,3800800,CDBA,18278;${BESTPOS_BODY}`;
  assert.equal(textLogLines([hashFrame(odd)], tables).get(0),
    '#BESTPOSA,USB2,7,72.0,COARSESTEERING,2442,570228.000,03800800,cdba,18278;' + `${BESTPOS_BODY}*eb08b1e3`);
  // The same record in abbreviated form carries the same re-rendered head.
  assert.deepEqual(abbrevTextLogLines([hashFrame(odd)], tables).get(0), [
    '<BESTPOS USB2 7 72.0 COARSESTEERING 2442 570228.000 03800800 cdba 18278',
    '<     SOL_COMPUTED SINGLE 30.53997306366 114.35280786048 64.8239 -14.4000 WGS84 1.0263 1.1219'
      + ' 2.8355 "" 0.000 0.000 31 17 17 17 00 06 30 03',
  ]);
});

test('a `#` record with extra body tokens drops them; one with too few is dropped whole', () => {
  assert.equal(
    textLogLines([hashFrame(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BESTPOS_BODY},99,88`)], tables).get(0),
    BESTPOS_LINE,
    'extra tokens are not printed',
  );
  // `…,00,06,30,03` cut to `…,00,06,3` — two tokens short. The suite writes no line at all, in ASCII
  // and in abbreviated form alike.
  const short = hashFrame(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BESTPOS_BODY.slice(0, -5)}`);
  assert.equal(textLogLines([short], tables).size, 0);
  assert.equal(abbrevTextLogLines([short], tables).size, 0);
});

// ---------------------------------------------------------------------------------------------
// 5 — `$` + `$` with no CRLF
// ---------------------------------------------------------------------------------------------

test('a merged NMEA record resolves to its last sentence, checksum and all', () => {
  const nmea = (body: string): string => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
  };
  const A = nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');   // *47
  const B = nmea('GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,1000.1,M,46.9,M,,');  // *7A
  const R = nmea('GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,003.1,W');   // *78
  const line = (text: string): string | undefined => textLogLines([{ kind: 'text', prefix: '$', text: `${text}\r\n` }], tables).get(0);

  assert.equal(line(`${A}${B}`), B, 'two sentences: the last one wins');
  assert.equal(line(`${A}${B}${R}`), R, 'three sentences: still the last');
  assert.equal(line(`${A}${B.slice(0, -2)}00`), undefined, 'the last sentence is validated; no fallback to the first');
  assert.equal(line(`${A}$GPGGA,1,2`), undefined, 'a tail without a checksum prints nothing');
  assert.equal(line(`${A}$GNZZZ,1*36`), undefined, 'the last sentence must be a known NMEA log');
  // Lowercase checksum: echoed exactly as it came, not re-rendered.
  assert.equal(line(`${A}${B.slice(0, -2)}7a`), `${B.slice(0, -2)}7a`);
  assert.equal(line(`${A}`), A, 'a lone sentence is unchanged');
});

// ---------------------------------------------------------------------------------------------
// 6 — `<` with only its header
// ---------------------------------------------------------------------------------------------

test('a `<` record with only its header prints nothing', () => {
  const headerOnly: Frame = { kind: 'text', prefix: '<', text: '<BESTPOS COM1 0 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n' };
  const second: Frame = { kind: 'text', prefix: '<', text: '<RANGE COM1 1 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n' };
  assert.equal(textLogLines([headerOnly], tables).size, 0);
  assert.equal(textLogLines([headerOnly, second], tables).size, 0);
  assert.equal(abbrevTextLogLines([headerOnly], tables).size, 0);
  // The same header **with** its data line still prints, so the rule is about the missing body.
  const withBody: Frame = { kind: 'text', prefix: '<', text: '<RAWALM USB 0 75.0 FINESTEERING 2402 91818.000 03801800 cdba 18278\r\n' };
  const data: Frame = { kind: 'text', prefix: '<', text: '<     2402 91818.000 0\r\n' };
  assert.equal(textLogLines([withBody, data], tables).size, 1);
});
