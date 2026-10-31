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
 * Every line matches byte for byte, `APPROX POSITION XYZ` included: it is the ECEF of the **last**
 * BESTPOS of the capture, not the mean of the track (see `rinex21.test.ts`, which shows the mean is
 * ~8 mm off and the last record is exact).
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

/** 0-based index of `APPROX POSITION XYZ`, checked like every other line. */
const APPROX_POSITION = 9;

function goldenFile(entry: (typeof CASES)[number]): string {
  return join(
    samples,
    entry.folder,
    'clean-9600',
    'Converted_On_20261030_T1710',
    `RINEXv${entry.version.replace('.', '_')}`,
    'clean-9600.26O',
  );
}

function goldenLines(entry: (typeof CASES)[number]): string[] {
  return readFileSync(goldenFile(entry), 'utf8').split('\r\n');
}

function oursLines(entry: (typeof CASES)[number]): string[] {
  return buildRinex3Obs(frames(), tables, entry.version, { builtAt: new Date(entry.builtAt) }).split('\r\n');
}

for (const entry of CASES) {
  test(`RINEX ${entry.version} observations are byte-identical to the golden file`, () => {
    const expected = goldenLines(entry);
    const actual = oursLines(entry);

    assert.equal(expected[entry.headerLines - 1].includes('END OF HEADER'), true, 'header length sanity');

    const differences: number[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (expected[i] !== actual[i]) differences.push(i + 1);
    }
    assert.deepEqual(differences, [], 'no line differs');
    assert.equal(actual.length, expected.length, 'same line count');

    const ours = buildRinex3Obs(frames(), tables, entry.version, { builtAt: new Date(entry.builtAt) });
    assert.deepEqual(Buffer.from(ours, 'utf8'), readFileSync(goldenFile(entry)), 'same bytes, CRLF included');
    assert.match(actual[APPROX_POSITION], /APPROX POSITION XYZ\s*$/, '`APPROX POSITION XYZ` is present');
  });
}
