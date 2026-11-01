/**
 * Text → binary: the encoding rule `--to BINARY` needs for the receiver's ASCII logs.
 *
 * `Convert -b` re-serializes every record it accepts; a text record becomes an SBF frame with a
 * 28-byte header, a `pack(4)` payload and a fresh CRC, at its own position in the capture. This file
 * pins that against the suite's own `-b` files for the two captures that carry text records:
 *
 *   b1-20261101.sbf → 2 623 374 B, sha256 b40f1027…  (99 text records: 26 RANGE, 39 BESTPOS,
 *                      24 SATVIS2, 6 RXSTATUS, 2 TIMESYNC, 2 HWMONITOR)
 *   b7-20261101.sbf → 473 262 B,   sha256 55074c97…  (431 text records: 247 RXCONFIG,
 *                      90 ITPSDDETECT, 47 ITDETECTSTATUS, 47 ITPSDFINAL)
 *
 * The per-field expectations come from those files, and the rules they encode were measured with
 * text-only synthetic captures (`逆向/tools/probe-text-*.ts`), so nothing here depends on a binary
 * frame happening to sit next to the text record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import { collectBinaryRecords, textLogLines } from '../src/text-log.ts';
import { encodeRecord, textPortAddress } from '../src/binary-log.ts';
import { novatelCrc32 } from '../src/crc.ts';
import { latin1Bytes } from '../src/ascii-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes: Uint8Array, from = 0, to = bytes.length): string =>
  Array.from(bytes.subarray(from, to), (byte) => byte.toString(16).padStart(2, '0')).join('');

function framesOf(bytes: Uint8Array): Frame[] {
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)];
  deframer.end();
  return frames;
}

function readCapture(name: string): Frame[] {
  return framesOf(new Uint8Array(readFileSync(join(samples, name))));
}

function binary(name: string, frames: readonly Frame[]) {
  return convertFrames(frames, {
    format: 'BINARY',
    at: new Date('2026-11-01T00:00:00Z'),
    tables,
    name,
  });
}

function firstRecord(frames: readonly Frame[], name: string) {
  const records = [...collectBinaryRecords(frames, tables)].sort((a, b) => a[0] - b[0]);
  const found = records.find(([, record]) => record.name === name);
  assert.ok(found, `no text record named ${name}`);
  const encoded = encodeRecord(found[1], tables);
  assert.ok(encoded.bytes, `${name}: ${encoded.error}`);
  return { bytes: encoded.bytes, record: found[1] };
}

function headerOf(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    sync: hex(frame, 0, 3),
    messageId: view.getUint16(4, true),
    messageType: view.getUint8(6),
    portAddress: view.getUint8(7),
    payloadLength: view.getUint16(8, true),
    sequence: view.getUint16(10, true),
    idleTimeRaw: view.getUint8(12),
    timeStatus: view.getUint8(13),
    week: view.getUint16(14, true),
    milliseconds: view.getUint32(16, true),
    receiverStatus: view.getUint32(20, true),
    reserved: view.getUint16(24, true),
    softwareVersion: view.getUint16(26, true),
  };
}

const b1Frames = readCapture('b1-20261101.sbf');
const b7Frames = readCapture('b7-20261101.sbf');
const b1 = binary('b1-20261101.sbf', b1Frames);
const b7 = binary('b7-20261101.sbf', b7Frames);
const b1Bytes = b1.files[0]!.bytes;
const b7Bytes = b7.files[0]!.bytes;

test('b1 -b is the suite’s file byte for byte (99 text records encoded)', () => {
  assert.equal(b1Bytes.length, 2_623_374);
  assert.equal(sha256(b1Bytes), 'b40f10277c72403d8bb314b0ac5f41776a4054a881d0f1444f190573e6c7c1e2');
  assert.deepEqual(b1.unencodedText, []);
  assert.equal(collectBinaryRecords(b1Frames, tables).size, 99);
  // The suite's own summary for this run: BESTPOS 90 = 51 binary + 39 text.
  assert.deepEqual(b1.counts.get(42), { name: 'BESTPOS', source: 90, output: 90 });
});

test('b7 -b is the suite’s file byte for byte (431 text records encoded)', () => {
  assert.equal(b7Bytes.length, 473_262);
  assert.equal(sha256(b7Bytes), '55074c977f67bd6ccc750f909ff49fe53370f2cfbc24b5c45cb3b9c69bc32b1c');
  assert.deepEqual(b7.unencodedText, []);
  assert.equal(collectBinaryRecords(b7Frames, tables).size, 431);
  // 269 text RXCONFIG records in, 247 encoded: the 22 whose embedded message the dictionary lacks
  // are dropped by the same gate the ASCII writer applies (and counted input-only).
  assert.deepEqual(b7.counts.get(128), { name: 'RXCONFIG', source: 269, output: 247 });
});

test('b1 -b --decimate=5: a text record is decimated by its own header, like the suite', () => {
  // 46 of b1's 99 text records carry a whole 5-second stamp and survive; the suite's file is
  // 130 048 B and this run reproduces it byte for byte.
  const out = convertFrames(b1Frames, {
    format: 'BINARY',
    at: new Date('2026-11-01T00:00:00Z'),
    tables,
    name: 'b1-20261101.sbf',
    decimate: 5,
  });
  assert.equal(out.files[0]!.bytes.length, 130_048);
  assert.equal(sha256(out.files[0]!.bytes), '82a9537233a90e91a17461908cda461ba7f4451b423b5daa89ca16fc2256a6cf');
});

test('the text records encoded are exactly the ones the ASCII writer renders', () => {  for (const frames of [b1Frames, b7Frames]) {
    const rendered = [...textLogLines(frames, tables).keys()].sort((a, b) => a - b);
    const encoded = [...collectBinaryRecords(frames, tables).keys()].sort((a, b) => a - b);
    assert.deepEqual(encoded, rendered);
  }
});

test('every text record type maps onto its long header, field by field', () => {
  // (port USB2 = 1696 → header byte 160; idle = printed × 2; time status name → enum; the two hex
  // words are the receiver status and the message-definition CRC.)
  const expected = [
    {
      frames: b1Frames, name: 'RANGE',
      header: {
        sync: 'aa4412', messageId: 43, messageType: 0, portAddress: 160, payloadLength: 3700,
        sequence: 0, idleTimeRaw: 144, timeStatus: 120, week: 2442, milliseconds: 570_228_000,
        receiverStatus: 0x03801800, reserved: 0x5103, softwareVersion: 18278,
      },
      headerHex: 'aa44121c2b0000a0740e000090788a0920fdfc210018800303516647',
    },
    {
      frames: b1Frames, name: 'BESTPOS',
      header: {
        sync: 'aa4412', messageId: 42, messageType: 0, portAddress: 160, payloadLength: 72,
        sequence: 0, idleTimeRaw: 144, timeStatus: 120, week: 2442, milliseconds: 570_228_000,
        receiverStatus: 0x03801800, reserved: 0xcdba, softwareVersion: 18278,
      },
      headerHex: 'aa44121c2a0000a04800000090788a0920fdfc2100188003bacd6647',
    },
    {
      frames: b1Frames, name: 'RXSTATUS',
      header: {
        sync: 'aa4412', messageId: 93, messageType: 0, portAddress: 160, payloadLength: 88,
        sequence: 0, idleTimeRaw: 137, timeStatus: 120, week: 2442, milliseconds: 570_230_000,
        receiverStatus: 0x03801800, reserved: 0x2ae1, softwareVersion: 18278,
      },
      headerHex: 'aa44121c5d0000a05800000089788a09f004fd2100188003e12a6647',
    },
    {
      frames: b1Frames, name: 'SATVIS2',
      header: {
        sync: 'aa4412', messageId: 1043, messageType: 0, portAddress: 160, payloadLength: 1296,
        sequence: 3, idleTimeRaw: 137, timeStatus: 120, week: 2442, milliseconds: 570_230_000,
        receiverStatus: 0x03801800, reserved: 0xa867, softwareVersion: 18278,
      },
      headerHex: 'aa44121c130400a01005030089788a09f004fd210018800367a86647',
    },
    {
      frames: b1Frames, name: 'TIMESYNC',
      header: {
        sync: 'aa4412', messageId: 492, messageType: 0, portAddress: 160, payloadLength: 12,
        sequence: 0, idleTimeRaw: 135, timeStatus: 120, week: 2442, milliseconds: 570_240_000,
        receiverStatus: 0x03801800, reserved: 0xbd3f, softwareVersion: 18278,
      },
      headerHex: 'aa44121cec0100a00c00000087788a09002cfd21001880033fbd6647',
    },
    {
      frames: b1Frames, name: 'HWMONITOR',
      header: {
        sync: 'aa4412', messageId: 963, messageType: 0, portAddress: 160, payloadLength: 84,
        sequence: 0, idleTimeRaw: 135, timeStatus: 120, week: 2442, milliseconds: 570_240_000,
        receiverStatus: 0x03801800, reserved: 0x52db, softwareVersion: 18278,
      },
      headerHex: 'aa44121cc30300a05400000087788a09002cfd2100188003db526647',
    },
    {
      // b7's first RXCONFIG: `SATTIME` → 200, week 0, ms 0, receiver status 03808800.
      frames: b7Frames, name: 'RXCONFIG',
      header: {
        sync: 'aa4412', messageId: 128, messageType: 0, portAddress: 160, payloadLength: 44,
        sequence: 268, idleTimeRaw: 153, timeStatus: 200, week: 0, milliseconds: 0,
        receiverStatus: 0x03808800, reserved: 0xf702, softwareVersion: 18278,
      },
      headerHex: 'aa44121c800000a02c000c0199c80000000000000088800302f76647',
    },
  ];

  for (const entry of expected) {
    const { bytes } = firstRecord(entry.frames, entry.name);
    assert.deepEqual(headerOf(bytes), entry.header, `${entry.name} header`);
    assert.equal(hex(bytes, 0, 28), entry.headerHex, `${entry.name} header bytes`);
  }
});

test('the port token goes through the suite’s address table, truncated to one byte', () => {
  // Measured through the suite with a text-only capture (`probe-text-port.ts`): all USB ports land
  // on 0xA0 (which prints back as `SPECIAL`), and an unknown name falls back to THISPORT.
  assert.equal(textPortAddress('USB2'), 160);
  assert.equal(textPortAddress('USB1'), 160);
  assert.equal(textPortAddress('NCOM1'), 160);
  assert.equal(textPortAddress('COM1'), 32);
  assert.equal(textPortAddress('THISPORT'), 192);
  assert.equal(textPortAddress('FILE'), 224);
  assert.equal(textPortAddress('USB2_29'), 189);
  assert.equal(textPortAddress('BOGUS'), 192);
});

test('BESTPOS: f64/f32 rounding, enums, a fixed string and the u8 tail', () => {
  const { bytes } = firstRecord(b1Frames, 'BESTPOS');
  assert.equal(
    hex(bytes, 28, 100),
    '00000000100000000024b9ac3b8a3e4022a26b6794965c4029cb10c7ba345040'
      + '666666c13d000000cc5d833f6b9a8f3fd57835400000000000000000000000001f11111100063003',
  );
  const payload = new DataView(bytes.buffer, bytes.byteOffset + 28, 72);
  // f64 = the double nearest the printed decimal. The receiver's own binary frame carries
  // `cc20b9ac3b8a3e40` (…063657087), so this also proves the payload is re-serialized, not copied.
  assert.equal(payload.getFloat64(8, true), Number('30.53997306366'));
  assert.equal(hex(bytes, 28 + 8, 28 + 16), '0024b9ac3b8a3e40');
  assert.equal(payload.getFloat64(16, true), Number('114.35280786048'));
  assert.equal(payload.getFloat64(24, true), Number('64.8239'));
  // f32 = that double rounded to single precision first.
  assert.equal(payload.getFloat32(32, true), Math.fround(-14.4));
  assert.equal(hex(bytes, 28 + 32, 28 + 36), '666666c1');
  // Enums: SOL_COMPUTED = 0, SINGLE = 16, WGS84 = 61.
  assert.equal(payload.getUint32(0, true), 0);
  assert.equal(payload.getUint32(4, true), 16);
  assert.equal(payload.getUint32(36, true), 61);
  // The empty `base_id` is four zero bytes, not skipped.
  assert.equal(hex(bytes, 28 + 52, 28 + 56), '00000000');
  assert.deepEqual(Array.from(bytes.subarray(28 + 64, 28 + 72)), [31, 17, 17, 17, 0x00, 0x06, 0x30, 0x03]);
});

test('RANGE: a FIELD_ARRAY count prefix and 44-byte elements', () => {
  const { bytes } = firstRecord(b1Frames, 'RANGE');
  const payload = new DataView(bytes.buffer, bytes.byteOffset + 28, 3700);
  assert.equal(payload.getUint32(0, true), 84);
  assert.equal(payload.getUint16(4, true), 17); // sv_prn
  assert.equal(payload.getUint16(6, true), 0); // sv_freq
  assert.equal(payload.getFloat64(8, true), Number('17268485.782')); // psr (%9.3lk)
  assert.equal(payload.getFloat32(16, true), Math.fround(0.043)); // sd_psr
  assert.equal(payload.getFloat64(20, true), Number('-90746505.673996')); // adr (%9.6lk)
  assert.equal(payload.getUint32(44, true), 0x0810bc04); // c_status from `0810bc04`
  // 4 + 84 × 44 = 3700: no tail padding, elements on their own stride.
  assert.equal(payload.byteLength, 4 + 84 * 44);
  assert.equal(payload.getUint16(4 + 44, true), 17); // second element's sv_prn
});

test('SATVIS2 / RXSTATUS / TIMESYNC / HWMONITOR bodies', () => {
  const satvis = firstRecord(b1Frames, 'SATVIS2').bytes;
  const sat = new DataView(satvis.buffer, satvis.byteOffset + 28, 1296);
  assert.equal(sat.getUint32(0, true), 0); // system_type GPS
  assert.equal(sat.getUint32(4, true), 1); // is_sat_vis_valid TRUE
  assert.equal(sat.getUint32(8, true), 1); // was_gnss_almanac_used TRUE
  assert.equal(sat.getUint32(12, true), 32); // element count
  assert.equal(sat.getUint32(16, true), 22); // first id
  assert.equal(sat.getFloat64(24, true), Number('80.5'));
  assert.equal(sat.getFloat64(32, true), Number('295.1'));
  assert.equal(sat.byteLength, 16 + 32 * 40);

  const rxstatus = firstRecord(b1Frames, 'RXSTATUS').bytes;
  assert.equal(
    hex(rxstatus, 28, 116),
    '00000000050000000008800300000000000000000000000000030400081000000000000000000000000000000000000000000080000000000002008000002000080000100000000000c0300000000000ffffffff00000000',
  );

  const timesync = firstRecord(b1Frames, 'TIMESYNC').bytes;
  assert.equal(hex(timesync, 28, 40), '8a090000002cfd2178000000');
  const ts = new DataView(timesync.buffer, timesync.byteOffset + 28, 12);
  assert.equal(ts.getUint32(0, true), 2442);
  assert.equal(ts.getUint32(4, true), 570_240_000);
  assert.equal(ts.getUint32(8, true), 120); // COARSESTEERING

  const hw = firstRecord(b1Frames, 'HWMONITOR').bytes;
  assert.equal(
    hex(hw, 28, 112),
    '0a00000078761f4200010000820d583d0002000004415040000600003feaa340000700009dc9993f000800000ba55040000f00009106e93f001100004cbaa44000150000776cc73f001700005214254200160000',
  );
  assert.equal(new DataView(hw.buffer, hw.byteOffset + 28, 84).getUint32(0, true), 10);
});

test('%R: RXCONFIG’s payload is the embedded record, encoded, with an inverted CRC', () => {
  const { bytes, record } = firstRecord(b7Frames, 'RXCONFIG');
  const payload = bytes.subarray(28, bytes.length - 4);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(payload.length, 44);
  assert.equal(hex(payload), 'aa44121cc70600a00c000c0199c800000000000000888003e0506647010000000000a040000000004c1ae946');
  // The inner frame: ELEVATIONCUTOFF (1735), the outer header’s port/sequence/time, system GLONASS
  // (enum 1) and a 5.0° cutoff.
  assert.equal(view.getUint16(4, true), 1735);
  assert.equal(payload[7], 160);
  assert.equal(view.getUint16(10, true), 268);
  assert.equal(view.getUint32(28, true), 1);
  assert.equal(view.getFloat32(32, true), 5);
  // Its CRC is the one’s complement of the NovAtel CRC, like the ASCII writer’s embedded `*crc`.
  const core = payload.subarray(0, payload.length - 4);
  const field = view.getUint32(payload.length - 4, true);
  assert.equal(field, ((novatelCrc32(core) ^ 0xffffffff) >>> 0));
  assert.equal(record.embedded?.startsWith('#ELEVATIONCUTOFFA,USB2,268,'), true);
});

test('fixed and variable strings: NUL padding, 4-byte alignment, and a too-long field drops the record', () => {
  // Measured through the suite with text-only captures (`probe-text-string.ts` / `probe-text-layouts.ts`):
  //   BESTPOS `base_id` "AB" → 41 42 00 00, "ABCD" → 41 42 43 44, "ABCDEF" → no frame at all;
  //   SETNAV’s two `variable` strings "FROM"/"TO" occupy 8 bytes each (40..47, 48..55).
  const seal = (text: string): string =>
    `#${text}*${novatelCrc32(latin1Bytes(text)).toString(16).padStart(8, '0')}`;
  const bestpos = (base: string, sequence: number): string =>
    seal(`BESTPOSA,USB2,${sequence},72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;`
      + `SOL_COMPUTED,SINGLE,1.25,2.5,3.5,-14.4,WGS84,1.0263,1.1219,2.8355,${base},0.000,0.000,31,17,17,17,00,06,30,03`);
  const setnav = seal('SETNAVA,USB2,9,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
    + '1.1,2.2,3.3,4.4,5.5,"FROM","TO"');
  const capture = latin1Bytes(`${bestpos('"AB"', 1)}\r\n${bestpos('"ABCD"', 2)}\r\n${setnav}\r\n`);

  const outcome = binary('strings.sbf', framesOf(capture));
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(outcome.files[0]!.bytes)]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  assert.equal(frames.length, 3);
  assert.equal(hex(frames[0]!.bytes, 28 + 52, 28 + 56), '41420000');
  assert.equal(hex(frames[1]!.bytes, 28 + 52, 28 + 56), '41424344');
  // SETNAV payload: five f64 (40 B), then `FROM\0` padded to 8 and `TO\0` padded to 4 = 52 B.
  assert.equal(hex(frames[2]!.bytes, 28 + 40, 28 + 52), hex(latin1Bytes('FROM\0\0\0\0TO\0\0')));
  assert.equal(frames[2]!.bytes.length, 28 + 52 + 4);

  // A record the suite drops is reported, not silently written with a truncated string.
  const tooLong = binary('toolong.sbf', framesOf(latin1Bytes(`${bestpos('"ABCDEF"', 3)}\r\n`)));
  assert.equal(tooLong.files[0]!.bytes.length, 0);
  assert.equal(tooLong.unencodedText.length, 1);
  assert.equal(tooLong.unencodedText[0]!.name, 'BESTPOS');
  assert.match(tooLong.unencodedText[0]!.reason, /does not fit a 4-byte field/);
});

test('a text record that cannot be encoded is listed with its reason, never dropped in silence', () => {
  const seal = (text: string): string =>
    `#${text}*${novatelCrc32(latin1Bytes(text)).toString(16).padStart(8, '0')}`;
  const goodBody = 'SOL_COMPUTED,SINGLE,1.25,2.5,3.5,-14.4,WGS84,1.0263,1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';
  // 1: a time-status name the SBF enum does not carry (the ASCII writer prints it verbatim).
  const badStatus = seal(`BESTPOSA,USB2,1,72.0,WOBBLE,2442,570228.000,03801800,cdba,18278;${goodBody}`);
  // 2: a `<` block whose data line stops before the layout does.
  const truncated =
    '<BESTPOS USB2 2 72.0 COARSESTEERING 2442 570228.000 03801800 cdba 18278\r\n'
    + '<     SOL_COMPUTED SINGLE\r\n';
  const capture = latin1Bytes(`${badStatus}\r\n${truncated}`);

  assert.equal(textLogLines(framesOf(capture), tables).size, 2, 'both records render as ASCII');

  const outcome = binary('failures.sbf', framesOf(capture));
  assert.equal(outcome.files[0]!.bytes.length, 0, 'neither record produced a frame');
  assert.equal(outcome.unencodedText.length, 2);
  assert.deepEqual(
    outcome.unencodedText.map((failure) => failure.reason).sort(),
    ['body ran out of tokens', 'unknown time status WOBBLE'],
  );
  assert.deepEqual(
    outcome.unencodedText.map((failure) => failure.name),
    ['BESTPOS', 'BESTPOS'],
  );
});
