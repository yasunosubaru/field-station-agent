/**
 * RANGECMP2 / RANGECMP4 decompression against the suite's own Convert output.
 *
 * Fixture: `samples/live-20261031/b2-20261101.sbf` (2 581 390 B, 905 records) — 31 `RANGECMP2`
 * (id 1273) and 30 `RANGECMP4` (id 2050) records, next to 638 plain `RANGE` (id 43) ones.
 * Golden: `golden-b2-20261101.ASCII` (905 lines) from `NovAtelApplicationSuite.exe -a`. Convert
 * writes **one** `RANGEA` line per compressed record and never emits `RANGECMP2A`/`RANGECMP4A`
 * (0 lines of either), so the whole `RANGEA` line is the acceptance test: header, all ten fields of
 * every observation, and the trailing CRC.
 *
 * 699 = 638 + 31 + 30 `RANGEA` lines, and 905 lines for 905 records, which also fixes the order:
 * the i-th golden line is the i-th record, so each compressed record has exactly one oracle line.
 *
 * Measured coverage: RANGECMP2 31/31 records, 2 697 observations; RANGECMP4 30/30 records,
 * 2 610 observations — all byte-identical. Nothing in the capture had to be skipped: every
 * signal type that appears is in the tables, no record carries an unknown satellite system, and
 * no record is a differential block (all 30 RANGECMP4 records fall on whole seconds, which makes
 * them Reference logs by construction). The parts of the format the capture cannot pin down are
 * listed in the last test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { novatelCrc32 } from '../src/crc.ts';
import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { formatField, portName, TIME_STATUS_NAMES } from '../src/ascii-log.ts';
import type { EdieScalar, EdieTables } from '../src/edie.ts';
import { decodeRangeCmp2, decodeRangeCmp4, lockTimeCarry, type RangeObservation } from '../src/rangecmp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

/** The `RANGE` observation layout (message id 43): the ten fields a decompressed row must fill. */
const rangeFields = (tables.messages['43'].fields[0] as { elements: EdieScalar[] }).elements;

const frames: SbfFrame[] = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b2-20261101.sbf'))))]
  .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
const golden = readFileSync(join(dir, 'golden-b2-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));

const RANGECMP2 = 1273;
const RANGECMP4 = 2050;

/**
 * Render the observations as the body of the line: the element count, then the ten fields with the
 * `RANGE` layout's own conversion strings (`%9.3lk`, `%0.3f`, …).
 *
 * This prints the values the module returns, exactly as the suite's ASCII writer prints the values
 * its decoder produced — it is deliberately *not* a re-encode into a binary `RANGE` payload, which
 * would round every FLOAT field back to float32 and lose the `C_No` digit RANGECMP4 needs.
 */
function body(rows: RangeObservation[]): string {
  const out: string[] = [String(rows.length)];
  for (const row of rows) {
    for (const field of rangeFields) out.push(formatField(field, row[field.name as keyof RangeObservation], tables));
  }
  return out.join(',');
}

/** The complete `#RANGEA,…;fields*crc` line, header included (same ten header values `ascii-log` writes). */
function line(frame: SbfFrame, rows: RangeObservation[]): string {
  const header = frame.header;
  if (header.kind !== 'long') throw new Error('compressed range logs use the long header');
  const head = [
    'RANGEA',
    portName(header.portAddress),
    String(header.sequence),
    (header.idleTimeRaw / 2).toFixed(1),
    TIME_STATUS_NAMES[header.timeStatus] ?? String(header.timeStatus),
    String(header.week),
    `${Math.floor(header.milliseconds / 1000)}.${String(header.milliseconds % 1000).padStart(3, '0')}`,
    (header.receiverStatus >>> 0).toString(16).padStart(8, '0'),
    (header.reserved >>> 0).toString(16).padStart(4, '0'),
    String(header.softwareVersion),
  ].join(',');
  const sentence = `${head};${body(rows)}`;
  return `#${sentence}*${novatelCrc32(new TextEncoder().encode(sentence)).toString(16).padStart(8, '0')}`;
}

/**
 * One decode of the capture, shared by every test below.
 *
 * Each test file of this suite runs in its own process, and `packages/app/test/live.test.ts` is
 * timing-sensitive (it waits for 100 replayed records), so this file keeps its CPU cost to a single
 * pass: decode the 61 compressed records once, render each line once, assert on the result.
 */
interface CompressedRecord {
  frame: SbfFrame;
  /** Position in the capture, which is also the position in the golden file. */
  index: number;
  rows: RangeObservation[];
  line: string;
}

const compressed: CompressedRecord[] = (() => {
  const carry = lockTimeCarry();
  const out: CompressedRecord[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.header.messageId !== RANGECMP2 && frame.header.messageId !== RANGECMP4) continue;
    const options = { epochMs: frame.header.milliseconds, lockCarry: carry };
    const rows = frame.header.messageId === RANGECMP2 ? decodeRangeCmp2(frame.payload, options) : decodeRangeCmp4(frame.payload, options);
    out.push({ frame, index, rows, line: line(frame, rows) });
  }
  return out;
})();

const recordsOf = (messageId: number): CompressedRecord[] => compressed.filter((record) => record.frame.header.messageId === messageId);

test('the capture holds 31 RANGECMP2 and 30 RANGECMP4 records, one RANGEA line each', () => {
  assert.equal(recordsOf(RANGECMP2).length, 31);
  assert.equal(recordsOf(RANGECMP4).length, 30);
  assert.equal(golden.filter((line) => line.startsWith('#RANGEA,')).length, 699, '638 RANGE + 31 + 30');
  assert.equal(golden.filter((line) => line.startsWith('#RANGECMP2A,') || line.startsWith('#RANGECMP4A,')).length, 0);
  assert.equal(golden.length, frames.length, 'one line per record, in capture order');
});

test('RANGECMP2 → RANGEA: all 31 records byte for byte', () => {
  const records = recordsOf(RANGECMP2);
  assert.equal(records.length, 31);
  assert.equal(records.reduce((sum, record) => sum + record.rows.length, 0), 2697, '87 observations per record');
  assert.deepEqual(records.map((record) => record.line), records.map((record) => golden[record.index]), 'every line identical, header and CRC included');
});

test('RANGECMP4 → RANGEA: all 30 records byte for byte', () => {
  const records = recordsOf(RANGECMP4);
  assert.equal(records.length, 30);
  assert.equal(records.reduce((sum, record) => sum + record.rows.length, 0), 2610, '87 observations per record');
  assert.deepEqual(records.map((record) => record.line), records.map((record) => golden[record.index]), 'every line identical, header and CRC included');
});

test('the two decoders together cover the whole RANGEA set of the capture', () => {
  // A diff report rather than a bare assertion: it names the first mismatching byte of the first
  // mismatching line, which is what a regression needs to see.
  assert.equal(compressed.length, 61);
  const differences: string[] = [];
  for (let i = 0; i < compressed.length && differences.length < 3; i++) {
    const expected = golden[compressed[i].index];
    if (compressed[i].line === expected) continue;
    let at = 0;
    while (at < expected.length && expected[at] === compressed[i].line[at]) at += 1;
    differences.push(`#${i} at ${at}\n  golden: ${expected.slice(Math.max(0, at - 40), at + 60)}\n  ours  : ${compressed[i].line.slice(Math.max(0, at - 40), at + 60)}`);
  }
  assert.deepEqual(differences, []);
});

test('the appendix A worked example decodes to the page-1228 RANGE rows', () => {
  // `OEM7-Commands-and-Logs-Reference-Manual.txt` Appendix A: the RANGECMP4 record (295 bytes of
  // range data) that the manual takes apart bit by bit, next to the RANGE rows it belongs to. Only
  // the values the appendix states are asserted, so this test does not depend on the capture.
  const hex =
    '27010000' + // "# bytes" = 295
    '030000421204000000009200df7688831f611fd87ca0b03a00638bbdf7b82f49b080fd0ec0ff1f091f8214ff4d4d00a1009cbf1751f6911f5141f87fd9571a96dbd7040c8090f87f0080fcf722fe9bfa8a49a8ff4f299d7f96fb9afefc771800fcffd0063f02cde01f3c7dd3ffb75240886f5fa2b0ff91f57f00003edf8b78868c882878014065dbf7d3ed6b722680d5fc0f00a4c08730fe7fecf8bffa3f003008000000002001f03fa019f8136a11273649b8fcefab9c434c7b89e71560dbfe070030b2e04fd841f33125320b80b0ecefa5ee21243ac0bb03e0ffc36a813fb13bbe5791a0f5ff9e3bdbffbb87f0cb8064f03f0000e4b67dd15bc5f4a50a3a006ca72fdee53ec86405b2c0fffa3fa450f725d5bfed7c49b1fb0fb16b45a87a9adb0740cbfe0700';
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 295);

  const rows = decodeRangeCmp4(bytes, { epochMs: 507977000 });
  assert.equal(rows.length, 22, '5 GPS satellites (2-3 signals each) and 5 GLONASS ones (2 each)');
  // A.1.5: PRN 10 L1CA — C/No 52.60, lock time 15 → 262.144 s, PSR std 1, ADR std 1,
  // pseudorange 43080581622 × 0.0005 = 21540290.811 m, phaserange 21540290.811 + 7512 × 0.0001.
  const first = rows[0];
  assert.equal(first.sv_prn, 10);
  assert.equal(first.sv_freq, 0);
  assert.equal(formatField(rangeFields[2], first.psr, tables), '21540290.811');
  assert.equal(formatField(rangeFields[7], first.C_No, tables), '52.6');
  assert.equal(formatField(rangeFields[8], first.lock_time, tables), '262.144');
  assert.equal(formatField(rangeFields[3], first.sd_psr, tables), '0.030'); // bit field 1
  assert.equal(formatField(rangeFields[5], first.sd_adr, tables), '0.005'); // bit field 1
  // Table 12: RANGE numbers GLONASS 38-61 while the compressed log carries slots 1-24, and the
  // appendix's RANGE rows for this record are 61/55/38/39/54.
  assert.deepEqual([...new Set(rows.slice(12).map((row) => row.sv_prn))].sort(), [38, 39, 54, 55, 61]);
  assert.deepEqual([...new Set(rows.slice(12).map((row) => row.sv_freq))].sort((a, b) => a - b), [3, 4, 8, 9, 11]);
});

test('the lock time is carried forward: the field alone saturates or buckets', () => {
  const cmp2 = frames.filter((frame) => frame.header.messageId === RANGECMP2);
  const cmp4 = frames.filter((frame) => frame.header.messageId === RANGECMP4);

  // RANGECMP2 pins the 17-bit counter at 131 071 ms; 2 604 of the 2 697 observations are saturated,
  // and the golden file prints 131.071, 132.071, … 161.071 for them — +1 s per 1 s record.
  const lockOf = (row: RangeObservation): string => formatField(rangeFields[8], row.lock_time, tables);
  const plain2 = decodeRangeCmp2(cmp2[0].payload);
  const last2 = decodeRangeCmp2(cmp2[cmp2.length - 1].payload);
  assert.equal(Math.max(...plain2.map((row) => row.lock_time)), Math.fround(131.071), 'the field itself is saturated at 131 071 ms');
  assert.equal(Math.max(...last2.map((row) => row.lock_time)), Math.fround(131.071), 'without carry the value never grows');
  assert.ok([...new Set(plain2.map(lockOf))].includes('131.071'));
  assert.ok(![...new Set(last2.map(lockOf))].includes('161.071'));

  const carry = lockTimeCarry();
  const carried2 = cmp2.map((frame) => decodeRangeCmp2(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: carry }));
  assert.equal(lockOf(carried2[0][0]), '131.071', 'first record: the field value');
  assert.equal(lockOf(carried2[1][0]), '132.071', 'one second later');
  assert.equal(lockOf(carried2[30][0]), '161.071', 'thirty seconds later');

  // RANGECMP4 buckets the lock time (Table 202): the indicator names a minimum, and the golden file
  // prints the minimum plus the elapsed time. Satellite 4's L1CA moves from bucket 11 to 12 after
  // nine records, and the printed value restarts at the new bucket minimum (32.768 s).
  const plain4 = decodeRangeCmp4(cmp4[0].payload);
  assert.equal(lockOf(plain4[0]), '16.384', 'indicator 11 → 16 384 ms');
  const carry4 = lockTimeCarry();
  const series: string[] = [];
  for (const frame of cmp4.slice(0, 11)) {
    series.push(lockOf(decodeRangeCmp4(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: carry4 })[0]));
  }
  assert.deepEqual(series.slice(0, 9), ['16.384', '17.384', '18.384', '19.384', '20.384', '21.384', '22.384', '23.384', '24.384']);
  assert.deepEqual(series.slice(9), ['32.768', '33.768'], 'a new bucket restarts at its minimum');
});

test('the decoder is a pure function of the compressed block', () => {
  const frame = frames.find((candidate) => candidate.header.messageId === RANGECMP4);
  assert.ok(frame);
  const once = decodeRangeCmp4(frame.payload);
  const twice = decodeRangeCmp4(frame.payload);
  assert.deepEqual(once, twice);
  assert.equal(once.length, 87);
  for (const row of once) {
    assert.equal(typeof row.c_status, 'number');
    // c_status is a channel-tracking word: the system nibble is one of Table 182's, the grouping
    // bit is always set, and the tracking state is 4 (primary, PLL tracking) or 11 (aided).
    assert.equal((row.c_status >>> 20) & 1, 1, 'grouping');
    assert.ok([4, 11].includes(row.c_status & 0x1f), 'tracking state');
  }
  assert.deepEqual(decodeRangeCmp2(new Uint8Array(0)), []);
  assert.deepEqual(decodeRangeCmp4(new Uint8Array(2)), []);
});

test('what the capture cannot pin down', () => {
  // Everything below is implemented from the manual but has no oracle line, because this receiver
  // recorded none of it. Listed so the gap is explicit rather than implied.
  const cmp4 = frames.filter((frame) => frame.header.messageId === RANGECMP4);
  assert.equal(cmp4.filter((frame) => frame.header.milliseconds % 1000 !== 0).length, 0, 'no differential RANGECMP4 records');
  const systems = new Set<number>();
  for (const frame of frames) {
    if (frame.header.messageId !== RANGECMP2) continue;
    const payload = frame.payload;
    let bit = 32;
    const read = (count: number): number => {
      let value = 0;
      for (let i = 0; i < count; i++) value += ((payload[(bit + i) >> 3] >>> ((bit + i) & 7)) & 1) * 2 ** i;
      bit += count;
      return value;
    };
    while (bit + 80 <= payload.length * 8) {
      read(8); // SV channel
      read(8); // satellite identifier
      read(4); // GLONASS frequency
      systems.add(read(5)); // satellite system
      read(1); // reserved
      read(29); // pseudorange base
      read(21); // doppler base
      const signalBlocks = read(4);
      bit += signalBlocks * 96;
    }
  }
  assert.deepEqual([...systems].sort(), [0, 6, 7], 'only GPS, BeiDou and QZSS: no GLONASS, SBAS, Galileo or NavIC record');
});
