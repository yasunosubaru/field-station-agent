/**
 * The RINEX summaries, which report a second number: `N bytes could not be converted.`
 *
 * Measured on `clean-9600.gps` against the five `.RINEX` runs the suite left in the samples tree.
 * RINEX writes observations from `RANGE` (43), the epoch position from `BESTPOS` (42) and
 * navigation from `RAWEPHEM` (41); every other record is input the format cannot express, so its
 * row reads `N → 0` and its **frame bytes** are added up:
 *
 *   `HWMONITOR` 116 + `PORTSTATS` 1076 + 4 × `RXSTATUS` 480 = **1672**.
 *
 * KML follows the same rule with `BESTPOS` as its only expressible log (`270864 − 5 × 104 =
 * 270344`), which is what pins the "frame bytes, not payload bytes" reading: the count is the sum
 * of the whole records, CRC and header included.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', 'cli', 'src', 'convert.ts');
const convert = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');

const FORMATS = [
  { format: 'RINEX21', golden: join(convert, 'golden-rinex2_1') },
  { format: 'RINEX301', golden: join(convert, 'golden-rinex3_01') },
  { format: 'RINEX302', golden: join(convert, 'golden-rinex3_02') },
  { format: 'RINEX303', golden: join(convert, 'golden-rinex3_03') },
  { format: 'RINEX304', golden: join(convert, 'golden-rinex3_04') },
] as const;

function summaryOf(format: string): string {
  const out = mkdtempSync(join(tmpdir(), 'rinex-summary-'));
  try {
    execFileSync(
      process.execPath,
      [cli, join(convert, 'clean-9600.gps'), '--to', format, '--out', out, '--at', '2026-11-01T00:00:00'],
      { stdio: 'pipe' },
    );
    const root = join(out, 'clean-9600');
    const stamp = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
    assert.ok(stamp);
    return readFileSync(join(root, stamp, 'Summary_clean-9600.txt'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Everything that is per-run: the stamp and the two paths. */
function comparable(summary: string): string {
  return summary
    .split('\n')
    .filter((_line, index) => index !== 1 && index !== 4 && index !== 7)
    .join('\n');
}

for (const { format, golden } of FORMATS) {
  test(`${format}: clean-9600's summary is the suite's, line for line`, () => {
    const ours = summaryOf(format);
    const theirs = readFileSync(join(golden, 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt'), 'utf8');
    assert.equal(comparable(ours), comparable(theirs));
  });

  test(`${format}: HWMONITOR/PORTSTATS/RXSTATUS read 1 → 0 and 1672 bytes could not be converted`, () => {
    const summary = summaryOf(format);
    assert.match(summary, /^\s+963 \| HWMONITOR\s*\|\s+1 \|\s+0 \|$/m);
    assert.match(summary, /^\s+72 \| PORTSTATS\s*\|\s+1 \|\s+0 \|$/m);
    assert.match(summary, /^\s+93 \| RXSTATUS\s*\|\s+4 \|\s+0 \|$/m);
    assert.match(summary, /^\s+42 \| BESTPOS\s*\|\s+5 \|\s+5 \|$/m);
    assert.match(summary, /^\s+43 \| RANGE\s*\|\s+100 \|\s+100 \|$/m);
    assert.match(summary, /^\s+41 \| RAWEPHEM\s*\|\s+8 \|\s+8 \|$/m);
    assert.match(summary, /\n\n1672 bytes could not be converted\.\n\n$/);
    // RINEX prints no `UNKNOWN` row here: the capture has no unattributable bytes at all.
    assert.equal(/UNKNOWN/.test(summary), false);
  });
}

test('KML: only BESTPOS is expressible, so the other 270344 bytes are reported', () => {
  const out = mkdtempSync(join(tmpdir(), 'kml-summary-'));
  try {
    execFileSync(
      process.execPath,
      [cli, join(convert, 'clean-9600.gps'), '--to', 'KML', '--out', out, '--at', '2026-11-01T00:00:00'],
      { stdio: 'pipe' },
    );
    const root = join(out, 'clean-9600');
    const stamp = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
    const ours = readFileSync(join(root, stamp!, 'Summary_clean-9600.txt'), 'utf8');
    const theirs = readFileSync(join(convert, 'golden-kml', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt'), 'utf8');
    assert.equal(comparable(ours), comparable(theirs));
    assert.match(ours, /^\s+43 \| RANGE\s*\|\s+100 \|\s+0 \|$/m);
    assert.match(ours, /\n\n270344 bytes could not be converted\.\n\n$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
