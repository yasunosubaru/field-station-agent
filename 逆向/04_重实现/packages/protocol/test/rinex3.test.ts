/**
 * RINEX 3.01 / 3.02 / 3.03 / 3.04 observation output against the suite's golden files.
 *
 * All four goldens come from the same capture (`clean-9600.gps`), so the only thing that varies
 * between them is what the version-specific part of the closed-source writer does:
 *
 *  - 3.01 is GPS-only (25 header lines, `G (GPS)`, label `SYS / PHASE SHIFTS`);
 *  - 3.02 adds QZSS and BeiDou (36 header lines, `M (MIXED)`), calls BeiDou B1I `C1I`, and terminates
 *    `GLONASS COD/PHS/BIS` with a bare LF;
 *  - 3.03 is 3.02 with `C2I` and a CRLF;
 *  - 3.04 adds the J07 records that 3.02/3.03 leave out.
 *
 * Every line matches byte for byte except the header's `APPROX POSITION XYZ`: the suite derives it
 * with a geoid model we do not have, so ours lands within 8 mm (last decimal of a `%14.4f` field).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildRinex3Obs, type Rinex3Version } from '../src/rinex3.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'clean-9600.gps'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

/** One case per golden: the 3.x `PGM / RUN BY / DATE` stamp is UTC (`... UTC`), unlike RINEX 2.1. */
const CASES: Array<{ version: Rinex3Version; folder: string; builtAt: string; headerLines: number }> = [
  { version: '3.01', folder: 'golden-rinex3_01', builtAt: '2026-10-30T09:10:09Z', headerLines: 25 },
  { version: '3.02', folder: 'golden-rinex3_02', builtAt: '2026-10-30T09:10:09Z', headerLines: 36 },
  { version: '3.03', folder: 'golden-rinex3_03', builtAt: '2026-10-30T09:10:10Z', headerLines: 37 },
  { version: '3.04', folder: 'golden-rinex3_04', builtAt: '2026-10-30T09:10:11Z', headerLines: 37 },
];

/** 0-based index of `APPROX POSITION XYZ`, the one line allowed to differ. */
const APPROX_POSITION = 9;

function goldenLines(entry: (typeof CASES)[number]): string[] {
  const file = join(
    samples,
    entry.folder,
    'clean-9600',
    'Converted_On_20261030_T1710',
    `RINEXv${entry.version.replace('.', '_')}`,
    'clean-9600.26O',
  );
  return readFileSync(file, 'utf8').split('\r\n');
}

function oursLines(entry: (typeof CASES)[number]): string[] {
  return buildRinex3Obs(frames(), tables, entry.version, { builtAt: new Date(entry.builtAt) }).split('\r\n');
}

for (const entry of CASES) {
  test(`RINEX ${entry.version} observations match the golden file except the geoid-dependent header line`, () => {
    const expected = goldenLines(entry);
    const actual = oursLines(entry);

    assert.equal(actual.length, expected.length, 'same line count');
    assert.equal(expected[entry.headerLines - 1].includes('END OF HEADER'), true, 'header length sanity');

    const differences: number[] = [];
    for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) differences.push(i + 1);
    assert.deepEqual(differences, [APPROX_POSITION + 1], 'only `APPROX POSITION XYZ` differs');

    // The differing line is still the same position to within a centimetre.
    const parse = (text: string) => text.slice(0, 42).trim().split(/\s+/).map(Number);
    const [gx, gy, gz] = parse(expected[APPROX_POSITION]);
    const [ax, ay, az] = parse(actual[APPROX_POSITION]);
    assert.ok(Math.hypot(gx - ax, gy - ay, gz - az) < 0.02, 'position within 2 cm');
  });
}

/** The header up to `END OF HEADER`, apart from that one line, must be exact. */
for (const entry of CASES) {
  test(`RINEX ${entry.version} header fields that do not depend on the geoid are exact`, () => {
    const expected = goldenLines(entry);
    const actual = oursLines(entry);
    for (let i = 0; i < entry.headerLines; i++) {
      if (i === APPROX_POSITION) continue;
      assert.equal(actual[i], expected[i], `header line ${i + 1}`);
    }
  });
}
