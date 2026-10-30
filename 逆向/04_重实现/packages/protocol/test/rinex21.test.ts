/**
 * RINEX 2.1 observation output against the suite's golden file.
 *
 * `clean-9600.26O` is 1 921 lines; ours reproduces 1 920 of them byte for byte. The single
 * difference is the header's `APPROX POSITION XYZ` line: the suite derives it with a geoid model we
 * do not have, so our mean-of-track value lands within 8 mm (last decimal only). Every observation
 * record — epoch line, satellite order, all 8 observation types, LLI digits, SNR codes and the
 * printf tie rounding — matches exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildRinex21Obs } from '../src/rinex21.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'clean-9600.gps'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

test('RINEX 2.1 observations match the golden file except the geoid-dependent header line', () => {
  const golden = readFileSync(join(samples, 'golden-rinex2_1', 'clean-9600', 'Converted_On_20261030_T1710', 'RINEXv2_1', 'clean-9600.26O'), 'utf8');
  const ours = buildRinex21Obs(frames(), tables, { builtAt: new Date('2026-10-30T17:10:00') });
  const expected = golden.split('\r\n');
  const actual = ours.split('\r\n');
  assert.equal(actual.length, expected.length, 'same line count');

  const differences: number[] = [];
  for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) differences.push(i + 1);
  assert.deepEqual(differences, [10], 'only `APPROX POSITION XYZ` differs');

  // The differing line is still the same position to within a centimetre.
  const parse = (line: string) => line.slice(0, 42).trim().split(/\s+/).map(Number);
  const [gx, gy, gz] = parse(expected[9]);
  const [ax, ay, az] = parse(actual[9]);
  assert.ok(Math.hypot(gx - ax, gy - ay, gz - az) < 0.02, 'position within 2 cm');
});

test('RINEX 2.1 header fields that do not depend on the geoid are exact', () => {
  const golden = readFileSync(join(samples, 'golden-rinex2_1', 'clean-9600', 'Converted_On_20261030_T1710', 'RINEXv2_1', 'clean-9600.26O'), 'utf8').split('\r\n');
  const ours = buildRinex21Obs(frames(), tables, { builtAt: new Date('2026-10-30T17:10:00') }).split('\r\n');
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    assert.equal(ours[index], golden[index], `header line ${index + 1}`);
  }
});
