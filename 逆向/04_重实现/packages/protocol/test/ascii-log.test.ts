/**
 * The ASCII writer: `ascii-log.ts` must reproduce the suite's Convert output **byte for byte** —
 * header, every repeated block, every conversion string, and the trailing NovAtel CRC-32.
 *
 * Golden: `samples/convert/golden-broad-ascii/…/broad-clean.ASCII`, produced by
 * `NovAtelApplicationSuite.exe -a` from `samples/convert/broad-clean.gps`.
 *
 * One nuance the golden pins down: the capture contains 1722 frames but the ASCII file has 1721
 * lines. The missing one is the only frame whose CRC field does not match (`RANGE` at 467920.650):
 * Convert validates the CRC and drops the record, while the view's `genericparser.js` only drops
 * records whose CRC field is zero. The writer follows Convert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog, exactFixed, portName, TIME_STATUS_NAMES } from '../src/ascii-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const capturePath = join(samples, 'broad-clean.gps');
const goldenPath = join(samples, 'golden-broad-ascii', 'broad-clean', 'Converted_On_20261030_T1800', 'ASCII', 'broad-clean.ASCII');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
}

test('the header maps onto the SBF long header', () => {
  assert.equal(portName(188), 'SPECIAL_28', 'the two virtual log groups in this capture');
  assert.equal(portName(189), 'SPECIAL_29');
  assert.equal(TIME_STATUS_NAMES[180], 'FINESTEERING');
  assert.equal(TIME_STATUS_NAMES[120], 'COARSESTEERING');
});

test('printf rounding: exact ties round to even, like the suite', () => {
  // `toFixed` would give -2491.563 / 3298.563 / 2478.313; the golden file has the even neighbours.
  assert.equal(exactFixed(-2491.5625, 3), '-2491.562');
  assert.equal(exactFixed(3298.5625, 3), '3298.562');
  assert.equal(exactFixed(2478.3125, 3), '2478.312');
  assert.equal(exactFixed(9.9999, 3), '10.000', 'carry into the integer part');
  assert.equal(exactFixed(-0.0004, 3), '-0.000');
  assert.equal(exactFixed(0, 3), '0.000');
});

test('a bad-CRC record is dropped, as Convert does', () => {
  const all = frames();
  const bad = all.filter((frame) => !frame.crcOk);
  assert.equal(bad.length, 1, 'exactly one frame in the capture has a mismatching CRC');
  assert.equal(bad[0].header.messageId, 43);
  assert.equal(bad[0].header.milliseconds, 467920650);
  const layout = tables.messages['43'];
  assert.equal(encodeAsciiLog(bad[0], layout, tables), '', 'dropped by default');
  assert.notEqual(encodeAsciiLog(bad[0], layout, tables, { requireValidCrc: false }), '', 'but it can still be encoded');
});

test('every line of the golden ASCII file is reproduced byte for byte', () => {
  const golden = readFileSync(goldenPath, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced: string[] = [];
  for (const frame of frames()) {
    const layout = tables.messages[String(frame.header.messageId)];
    assert.ok(layout, `layout for message ${frame.header.messageId}`);
    const line = encodeAsciiLog(frame, layout, tables);
    if (line) produced.push(line);
  }
  assert.equal(produced.length, golden.length, 'one line per valid record');
  const differences: string[] = [];
  for (let i = 0; i < golden.length && differences.length < 5; i++) {
    if (produced[i] === golden[i]) continue;
    let at = 0;
    while (at < golden[i].length && golden[i][at] === produced[i][at]) at += 1;
    differences.push(`#${i} at ${at}\n  golden: ${golden[i].slice(Math.max(0, at - 30), at + 40)}\n  ours  : ${produced[i].slice(Math.max(0, at - 30), at + 40)}`);
  }
  assert.deepEqual(differences, [], 'byte-identical');
  assert.equal(golden.length, 1721);
});
