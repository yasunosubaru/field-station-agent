/**
 * RINEX 3.01 / 3.02 / 3.03 / 3.04 navigation output against the suite's golden files.
 *
 * All four goldens come from the same capture (`clean-9600.gps`, 8 `RAWEPHEM` frames), so the `.26N`
 * bodies are byte-identical across versions except for the version number in column 9 and the UTC
 * seconds of the `PGM / RUN BY / DATE` stamp: 5 576 bytes each, 4 header lines + 8 records of 8 lines
 * of 80 columns. The empty per-constellation files (328 bytes, header only) are **not** the same set in
 * every version: 3.01 writes `.26G .26L`, 3.02 adds `.26F .26H .26Q`, 3.03/3.04 add `.26I` — so the
 * test reads the golden directory and demands exactly those names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildRinex3EmptyNav, buildRinex3Nav, rinex3NavSystems, RINEX3_NAV_EXTENSIONS } from '../src/rinex3-nav.ts';
import type { Rinex3Version } from '../src/rinex3.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'clean-9600.gps'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

/** One case per golden; the 3.x stamp is UTC, and each version's run lands a second or two apart. */
const CASES: Array<{ version: Rinex3Version; folder: string; builtAt: string }> = [
  { version: '3.01', folder: 'golden-rinex3_01', builtAt: '2026-10-30T09:10:09Z' },
  { version: '3.02', folder: 'golden-rinex3_02', builtAt: '2026-10-30T09:10:09Z' },
  { version: '3.03', folder: 'golden-rinex3_03', builtAt: '2026-10-30T09:10:10Z' },
  { version: '3.04', folder: 'golden-rinex3_04', builtAt: '2026-10-30T09:10:11Z' },
];

function goldenDir(entry: (typeof CASES)[number]): string {
  return join(
    samples,
    entry.folder,
    'clean-9600',
    'Converted_On_20261030_T1710',
    `RINEXv${entry.version.replace('.', '_')}`,
  );
}

for (const entry of CASES) {
  test(`RINEX ${entry.version} GPS navigation matches the golden file byte for byte`, () => {
    const ours = buildRinex3Nav(frames(), tables, entry.version, { builtAt: new Date(entry.builtAt) });
    const expected = readFileSync(join(goldenDir(entry), 'clean-9600.26N'));
    assert.equal(Buffer.byteLength(ours, 'latin1'), expected.length, 'same file size');
    assert.equal(expected.length, 5576, '4 header lines + 8 records of 8 lines, 80 columns each');
    assert.deepEqual(Buffer.from(ours, 'latin1'), expected);
  });
}

for (const entry of CASES) {
  test(`RINEX ${entry.version} empty constellation headers match the goldens, 328 bytes each`, () => {
    // The set of `.26X` files the suite writes is the version's supported systems, not the capture's
    // contents: it changes between 3.01, 3.02 and 3.03. Take the names from the golden directory.
    const present = readdirSync(goldenDir(entry))
      .filter((name) => /^clean-9600\.26[A-Z]$/.test(name))
      .map((name) => name.slice(-1))
      .filter((letter) => letter !== 'N' && letter !== 'O')
      .sort();
    const ours = rinex3NavSystems(entry.version).map((system) => RINEX3_NAV_EXTENSIONS[system]).sort();
    assert.deepEqual(ours, present, 'the version writes exactly the golden set of nav files');

    for (const system of rinex3NavSystems(entry.version)) {
      const letter = RINEX3_NAV_EXTENSIONS[system];
      const text = buildRinex3EmptyNav(system, entry.version, { builtAt: new Date(entry.builtAt) });
      assert.equal(Buffer.byteLength(text, 'latin1'), 328, `.26${letter} is four 80-column lines plus CRLF`);
      assert.deepEqual(Buffer.from(text, 'latin1'), readFileSync(join(goldenDir(entry), `clean-9600.26${letter}`)), `.26${letter}`);
    }
  });
}

test('the 3.x record is the 2.1 field list at 80 columns, with no ADOT', () => {
  const lines = buildRinex3Nav(frames(), tables, '3.01', { builtAt: new Date(CASES[0].builtAt) }).split('\r\n');
  // 4 header lines, 8 records of 8 lines, then the trailing empty element of the final CRLF.
  assert.equal(lines.length, 4 + 64 + 1);
  for (let at = 4; at < lines.length - 1; at++) assert.equal(lines[at].length, 80, `line ${at + 1} is 80 columns`);

  // Line 1 of a record: satellite id + epoch (23 columns) then three 19-column fields.
  assert.equal(lines[4], 'G08 2026 10 30 10 00 00  .302773900330D-03 -.115960574476D-10  .000000000000D+00');
  // PRN 7's t_oc (467 984 s) is the one record whose seconds are not zero.
  assert.equal(lines[60], 'G07 2026 10 30 09 59 44 -.236967112869D-03 -.295585778076D-11  .000000000000D+00');
  // Sixth line: idot, codes on L2, GPS week, and the 2.1 writer's trailing constant — not an ADOT.
  assert.equal(lines[9], '     -.232152527227D-09  .100000000000D+01  .244200000000D+04  .000000000000D+00');
});

test('the 3.x nav header puts the file type in column 21 and the system letter in column 41', () => {
  const gps = buildRinex3Nav([], tables, '3.02', { builtAt: new Date(CASES[0].builtAt) }).split('\r\n');
  assert.equal(gps[0], '     3.02           N                   G                   RINEX VERSION / TYPE');
  assert.equal(gps[1], 'NAS Convert 2.11.0  NovAtel             20261030 091009 UTC PGM / RUN BY / DATE ');
  assert.equal(gps[2], ' '.repeat(60) + 'COMMENT'.padEnd(20));
  assert.equal(gps[3], ' '.repeat(60) + 'END OF HEADER'.padEnd(20));
  // GLONASS is `R` in 3.x, not the 2.1 writer's `G`.
  const glonass = buildRinex3EmptyNav('R', '3.01', { builtAt: new Date(CASES[0].builtAt) }).split('\r\n');
  assert.equal(glonass[0], '     3.01           N                   R                   RINEX VERSION / TYPE');
});
