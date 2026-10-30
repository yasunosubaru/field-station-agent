/**
 * RINEX 2.1 navigation output against the suite's golden files.
 *
 * Both files are reproduced **byte for byte** from the 8 `RAWEPHEM` frames of `clean-9600.gps`:
 * `clean-9600.26N` (4 header lines + 8 records of 8 lines, 5 512 B) and `clean-9600.26G` (header
 * only, 328 B). The record fields come from the parity-stripped subframes at the offsets documented
 * in `src/rinex21-nav.ts`; the same offsets also reproduce a second, 60 s capture (18 `RAWEPHEM`
 * frames collapsing to 9 records) and a third 8-record capture bit for bit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildRinex21GloNav, buildRinex21Nav, rinexD } from '../src/rinex21-nav.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const golden = join(samples, 'golden-rinex2_1', 'clean-9600', 'Converted_On_20261030_T1710', 'RINEXv2_1');
const builtAt = new Date('2026-10-30T17:10:00');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'clean-9600.gps'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

test('RINEX 2.1 GPS navigation matches the golden file byte for byte', () => {
  const ours = buildRinex21Nav(frames(), tables, { builtAt });
  const expected = readFileSync(join(golden, 'clean-9600.26N'));
  assert.equal(Buffer.byteLength(ours, 'latin1'), expected.length, 'same file size');
  assert.deepEqual(Buffer.from(ours, 'latin1'), expected);
});

test('RINEX 2.1 GLONASS navigation is the bare header when no GLONASS ephemeris exists', () => {
  const ours = buildRinex21GloNav({ builtAt });
  const expected = readFileSync(join(golden, 'clean-9600.26G'));
  assert.equal(Buffer.byteLength(ours, 'latin1'), 328, 'four 80-column header lines plus CRLF');
  assert.deepEqual(Buffer.from(ours, 'latin1'), expected);
});

test('records use t_oc for the epoch line and the full week, not the subframe WN', () => {
  const lines = buildRinex21Nav(frames(), tables, { builtAt }).split('\r\n');
  // PRN 7 is the only satellite whose toc (467 984 s) differs from the others' 468 000 s.
  assert.equal(lines[60], ' 7 26 10 30 09 59 44.0 -.236967112869D-03 -.295585778076D-11  .000000000000D+00');
  // Week 2442, while the 10-bit WN field of subframe 1 only carries 2442 % 1024 = 394.
  assert.match(lines[60 + 5], /\.244200000000D\+04/, 'GPS week');
});

test('rinexD writes RINEX 2 D-notation, 12 digits, right aligned to 19 columns', () => {
  const cases: Array<[number, string]> = [
    [0, '.000000000000D+00'],
    [-0, '.000000000000D+00'],
    [-1.15960574476e-11, '-.115960574476D-10'],
    [468000, '.468000000000D+06'],
    [463086, '.463086000000D+06'],
    [5153.5749321, '.515357493210D+04'],
    [93, '.930000000000D+02'],
    [879, '.879000000000D+03'],
  ];
  for (const [value, text] of cases) {
    assert.equal(rinexD(value), text.padStart(19), `${value}`);
    assert.equal(rinexD(value).length, 19);
  }
});
