/**
 * Convert's command-line options, against the numbers the suite itself produces.
 *
 * Measured with the installed 2.11.0 on `b2-20261101.sbf` (2026-11-01):
 *
 * ```
 * --split                     -> 20 files, `b2_<LOGNAME>.ASCII`; `b2-20261101_BESTPOS.ASCII` 7 136 B / 32 lines,
 *                                `b2-20261101_RANGE.ASCII` 699 lines (RANGECMP2/4 unpacked into it), no combined file
 * --limit-duration=10         -> 1 329 348 B / 236 lines  (window 577758.950 .. 577768.950)
 * --start-time=2442,577760 --finish-time=2442,577770
 *                             -> 1 362 914 B / 262 lines  (window 577760.000 .. 577770.000)
 * ```
 *
 * Each of those is asserted byte for byte here, so a change in the writer or in the window arithmetic
 * shows up as a size/length change rather than as "looks fine".
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
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const capture = join(live, 'b2-20261101.sbf');

function convert(args: string[]): string {
  const out = mkdtempSync(join(tmpdir(), 'cli-options-'));
  execFileSync(process.execPath, [cli, capture, '--out', out, '--at', '2026-11-01T00:00:00', ...args], { stdio: 'pipe' });
  const root = join(out, 'b2-20261101');
  const converted = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
  assert.ok(converted, 'a Converted_On_<stamp> directory');
  // The caller removes `out`; its parent is kept so the returned path stays readable.
  return join(root, converted, 'ASCII');
}

test('--split writes one file per log type, named like the suite', () => {
  const dir = convert(['--to', 'ASCII', '--split']);
  try {
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 20, 'twenty log files, no combined one');
    assert.equal(files.includes('b2-20261101.ASCII'), false, 'the combined file is not written');
    assert.ok(files.includes('b2-20261101_BESTPOS.ASCII'));
    assert.ok(files.includes('b2-20261101_RANGE.ASCII'));
    const lines = (name: string) => readFileSync(join(dir, name), 'latin1').split('\r\n').filter((line) => line.length > 0);
    assert.equal(lines('b2-20261101_BESTPOS.ASCII').length, 32);
    // RANGECMP2 (31) + RANGECMP4 (30) are unpacked into the RANGE file, as in the combined output.
    assert.equal(lines('b2-20261101_RANGE.ASCII').length, 699);
    assert.equal(readFileSync(join(dir, 'b2-20261101_BESTPOS.ASCII')).length, 7136);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--limit-duration starts at the first observation, not at an almanac reference epoch', () => {
  const dir = convert(['--to', 'ASCII', '--limit-duration=10']);
  try {
    const bytes = readFileSync(join(dir, 'b2-20261101.ASCII'));
    // The suite's own run gives exactly this file; b2's first record is `ALMANAC 577140.000`, and
    // anchoring there would have produced 2 lines instead of 236.
    assert.equal(bytes.length, 1_329_348);
    assert.equal(bytes.toString('latin1').split('\r\n').filter((line) => line.length > 0).length, 236);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--start-time / --finish-time select the same window as the suite', () => {
  const dir = convert(['--to', 'ASCII', '--start-time=2442,577760', '--finish-time=2442,577770']);
  try {
    const bytes = readFileSync(join(dir, 'b2-20261101.ASCII'));
    assert.equal(bytes.length, 1_362_914);
    assert.equal(bytes.toString('latin1').split('\r\n').filter((line) => line.length > 0).length, 262);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
