/**
 * `Summary_<name>.txt`'s numbers, against the suite's own summaries.
 *
 * The suite writes one of these next to every conversion, and its **counts follow the output**, not
 * the input. Three rules were measured here (2026-11-01) and are what this file pins down:
 *
 * 1. **Text records are logs too.** b1's 99 text records add `+39 BESTPOS`, `+26 RANGE`,
 *    `+24 SATVIS2`, `+6 RXSTATUS`, `+2 TIMESYNC`, `+2 HWMONITOR`.
 * 2. **A record that printed nothing is input but not output.** `RXCONFIG` reads `278 → 256` in b1
 *    (the 22 whose embedded message the dictionary lacks), and `RANGECMP2/4` read `31 → 0` /
 *    `30 → 0` in b2 while `RANGE` reads `638 → 699`.
 * 3. **The time range ignores reference epochs.** `SATTIME` (200) records carry the almanac's
 *    reference epoch; b2's Summary starts at `577758.950`, not at the first record's `577140.000`.
 *    The duration is `floor(finish) - floor(start)`: b1 28 s, b2 34 s, b3 45 s.
 *
 * One line still differs: the suite also prints an `UNKNOWN` row whose Source column is a byte count
 * we have not reproduced (b1 3695 / b2 6875 / b3 224). It is dropped from both sides here, and its
 * absence is asserted, so the day it is added this test says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', 'cli', 'src', 'convert.ts');
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

/** The three captures whose `--abbrev` Summary the suite left in the samples tree. */
const CAPTURES = ['b1-20261101', 'b2-20261101', 'b3-20261101'] as const;

function summaryOf(capture: string): string {
  const out = mkdtempSync(join(tmpdir(), 'summary-'));
  try {
    execFileSync(
      process.execPath,
      [cli, join(live, `${capture}.sbf`), '--to', 'ABBREV_ASCII', '--out', out, '--at', '2026-11-01T00:00:00'],
      { stdio: 'pipe' },
    );
    const root = join(out, capture);
    const converted = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
    assert.ok(converted, 'a Converted_On_<stamp> directory');
    return readFileSync(join(root, converted, `Summary_${capture}.txt`), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Everything that is inherently per-run, plus the `UNKNOWN` row we do not print yet. */
function comparable(summary: string): string {
  return summary
    .split('\n')
    .filter((_line, index) => index !== 1 && index !== 4 && index !== 7) // completed-at, input path, output path
    .filter((line) => !/^\s+0 \| UNKNOWN\s*\|/.test(line))
    // The sentence above the table counts that row too, so it moves by one with it.
    .filter((line) => !/following \d+ log\(s\)/.test(line))
    .join('\n');
}

for (const capture of CAPTURES) {
  test(`${capture}: the summary's time range, duration and per-log counts are the suite's`, () => {
    const ours = summaryOf(capture);
    const golden = readFileSync(join(live, `golden-${capture}.ABBREV_Summary.txt`), 'utf8');
    assert.equal(comparable(ours), comparable(golden));
  });

  test(`${capture}: the only table row we still lack is the suite's UNKNOWN row`, () => {
    const ours = summaryOf(capture);
    const golden = readFileSync(join(live, `golden-${capture}.ABBREV_Summary.txt`), 'utf8');
    assert.equal(/^\s+0 \| UNKNOWN\s*\|/m.test(ours), false, 'we print no UNKNOWN row');
    const unknown = /^\s+0 \| UNKNOWN\s*\|\s+(\d+) \|\s+(\d+) \|$/m.exec(golden);
    assert.ok(unknown, 'the golden has one');
    assert.ok(Number(unknown[1]) > 0, 'with a byte-ish source count');
    assert.equal(Number(unknown[2]), 0, 'and no output');
    // That row is also the one extra line in the suite's "N log(s)" sentence.
    const counted = (text: string) => Number(/following (\d+) log\(s\)/.exec(text)?.[1] ?? 0);
    assert.equal(counted(golden) - counted(ours), 1);
  });
}
