/**
 * `Summary_<name>.txt`'s numbers, against the suite's own summaries.
 *
 * The suite writes one of these next to every conversion, and its **counts follow the output**, not
 * the input. Four rules were measured here (2026-11-01) and are what this file pins down:
 *
 * 1. **Text records are logs too.** b1's 99 text records add `+39 BESTPOS`, `+26 RANGE`,
 *    `+24 SATVIS2`, `+6 RXSTATUS`, `+2 TIMESYNC`, `+2 HWMONITOR`.
 * 2. **A record that printed nothing is input but not output.** `RXCONFIG` reads `278 → 256` in b1
 *    (the 22 whose embedded message the dictionary lacks), and `RANGECMP2/4` read `31 → 0` /
 *    `30 → 0` in b2 while `RANGE` reads `638 → 699`.
 * 3. **The time range ignores reference epochs.** `SATTIME` (200) records carry the almanac's
 *    reference epoch; b2's Summary starts at `577758.950`, not at the first record's `577140.000`.
 *    The duration is `floor(finish) - floor(start)`: b1 28 s, b2 34 s, b3 45 s.
 * 4. **The `UNKNOWN` row is a byte count from the pre-scan**, and it is not the size of the
 *    `.UNKNOWN` file: b1 3695 / b2 6875 / b3 224 / b5 350 against files of 5386 / 7056 / 364 / 565.
 *    The rule is in `convert-pipeline.ts#unknownSpans`; `unknown-bytes.test.ts` pins both numbers.
 *
 * With those in place the whole document matches, so nothing is filtered out here except the three
 * inherently per-run lines (the completion stamp and the two absolute paths).
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

/** The captures whose Summary the suite left in the samples tree (`--abbrev` runs). */
const CAPTURES = ['b1-20261101', 'b2-20261101', 'b3-20261101', 'b5-20261101'] as const;

/** What each golden prints on its `UNKNOWN` row. */
const UNKNOWN: Record<(typeof CAPTURES)[number], string> = {
  'b1-20261101': '3695',
  'b2-20261101': '6875',
  'b3-20261101': '224',
  'b5-20261101': '350',
};

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

/** Everything that is inherently per-run: the completion stamp, the input path, the output path. */
function comparable(summary: string): string {
  return summary
    .split('\n')
    .filter((_line, index) => index !== 1 && index !== 4 && index !== 7)
    .join('\n');
}

for (const capture of CAPTURES) {
  test(`${capture}: the summary is the suite's, line for line, UNKNOWN row included`, () => {
    const ours = summaryOf(capture);
    const golden = readFileSync(join(live, `golden-${capture}.ABBREV_Summary.txt`), 'utf8');
    assert.equal(comparable(ours), comparable(golden));
  });

  test(`${capture}: the UNKNOWN row carries the suite's byte count and counts as a log`, () => {
    const ours = summaryOf(capture);
    const row = /^\s+0 \| UNKNOWN\s*\|\s+(\d+) \|\s+(\d+) \|$/m.exec(ours);
    assert.ok(row, 'we print the row now');
    assert.equal(row[1], UNKNOWN[capture]);
    assert.equal(row[2], '0', 'and no output');
    // The row is the last one, whatever its name would sort to (`b3` has `UPTIME` above it).
    const table = ours.slice(ours.indexOf('      ID |'));
    const rows = table.split('\n').filter((line) => /^\s+\d+ \|/.test(line));
    assert.match(rows[rows.length - 1], /UNKNOWN/);
    // It is also counted in the sentence above the table.
    const golden = readFileSync(join(live, `golden-${capture}.ABBREV_Summary.txt`), 'utf8');
    const counted = (text: string) => Number(/following (\d+) log\(s\)/.exec(text)?.[1] ?? 0);
    assert.equal(counted(ours), counted(golden));
  });
}

test('clean-9600 has nothing unknown, so its summary prints no UNKNOWN row', () => {
  const convert = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
  const out = mkdtempSync(join(tmpdir(), 'summary-'));
  try {
    execFileSync(
      process.execPath,
      [cli, join(convert, 'clean-9600.gps'), '--to', 'ASCII', '--out', out, '--at', '2026-11-01T00:00:00'],
      { stdio: 'pipe' },
    );
    const root = join(out, 'clean-9600');
    const converted = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
    const summary = readFileSync(join(root, converted!, 'Summary_clean-9600.txt'), 'utf8');
    assert.equal(/UNKNOWN/.test(summary), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
