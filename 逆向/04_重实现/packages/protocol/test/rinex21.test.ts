/**
 * RINEX 2.1 observation output against the suite's golden file — **byte for byte**.
 *
 * `clean-9600.26O` is 1 921 lines and ours reproduces all of them, the header's
 * `APPROX POSITION XYZ` included. That line used to be the one difference (≤ 8 mm), which had been
 * explained as "the suite uses a geoid model we lack". It is not a geoid: the capture carries five
 * BESTPOS records and the golden header is the ECEF of the **last** one, not the mean of the track.
 * The second test below pins that down by computing both and showing that only the last record
 * reproduces the golden digits.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildRinex21Obs } from '../src/rinex21.ts';
import { decodeEdie, type EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const GOLDEN = join(samples, 'golden-rinex2_1', 'clean-9600', 'Converted_On_20261030_T1710', 'RINEXv2_1', 'clean-9600.26O');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'clean-9600.gps'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

const BUILT_AT = new Date('2026-10-30T17:10:00');
/** 0-based index of `APPROX POSITION XYZ`; it is no longer allowed to differ. */
const APPROX_POSITION = 9;

test('RINEX 2.1 observations are byte-identical to the golden file', () => {
  const golden = readFileSync(GOLDEN, 'utf8');
  const ours = buildRinex21Obs(frames(), tables, { builtAt: BUILT_AT });
  const expected = golden.split('\r\n');
  const actual = ours.split('\r\n');

  const differences: number[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) differences.push(i + 1);
  }
  assert.deepEqual(differences, [], 'no line differs');
  assert.equal(actual.length, expected.length, 'same line count');
  assert.deepEqual(Buffer.from(ours, 'utf8'), readFileSync(GOLDEN), 'same bytes, CRLF included');
});

test('`APPROX POSITION XYZ` is the last BESTPOS, not the mean of the track', () => {
  // Reconstruct both candidates straight from the capture, then read back what the header printed.
  const ecef = (lat: number, lon: number, height: number): number[] => {
    const a = 6378137;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const phi = (lat * Math.PI) / 180;
    const lambda = (lon * Math.PI) / 180;
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return [
      (n + height) * Math.cos(phi) * Math.cos(lambda),
      (n + height) * Math.cos(phi) * Math.sin(lambda),
      (n * (1 - e2) + height) * Math.sin(phi),
    ];
  };
  const positions: number[][] = [];
  for (const frame of frames()) {
    if (frame.header.messageId !== 42) continue;
    const values = decodeEdie(frame.payload, tables.messages['42'], tables);
    const get = (path: string) => Number(values.find((value) => value.path === path)?.value ?? 0);
    positions.push(ecef(get('latitude'), get('longitude'), get('orthometric_height') + get('undulation')));
  }
  assert.equal(positions.length, 5, 'the capture carries five BESTPOS records');

  const mean = [0, 1, 2].map((axis) => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length);
  const last = positions[positions.length - 1];
  const header = buildRinex21Obs(frames(), tables, { builtAt: BUILT_AT }).split('\r\n')[APPROX_POSITION];
  const printed = header.slice(0, 42).trim().split(/\s+/).map(Number);
  const golden = readFileSync(GOLDEN, 'utf8').split('\r\n')[APPROX_POSITION].slice(0, 42).trim().split(/\s+/).map(Number);

  const distance = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  assert.deepEqual(printed, golden, 'the header prints the golden digits exactly');
  assert.ok(distance(last, golden) < 1e-4, 'the last BESTPOS is the golden position (≤ 0.1 mm)');
  assert.ok(distance(mean, golden) > 0.005, 'the mean of the track is not (it is ~8 mm away)');
});
