/**
 * `--unknown-bytes=[file|interleave|ignore]` and the two different numbers it is about.
 *
 * Measured against the suite's own Convert (2.11.0) on `b1`/`b2`/`b3`/`b5`:
 *
 *  - **the file** (`--unknown-bytes=file`, the CLI spelling of the GUI's `SEPARATEFILE`) is the
 *    capture minus every record whose payload renders minus every text record the parser resolves
 *    (a `<NAME …` header **and** its continuation rows). 5386 / 7056 / 364 / 565 bytes; ours is
 *    byte-identical, the `.UNKNOWN` goldens sit next to the captures.
 *  - **the Summary's `UNKNOWN` row** is the pre-scan's own count — 3695 / 6875 / 224 / 350 — which
 *    differs from the file on every capture. Same module, `unknownSpans`/`countUnknown`.
 *  - `ignore` (and no flag) write nothing and leave the count alone; `interleave` splices the bytes
 *    into the converted file at their capture position.
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

const CAPTURES = ['b1-20261101', 'b2-20261101', 'b3-20261101', 'b5-20261101'] as const;

/** The suite's `.UNKNOWN` sizes, one per capture. */
const SIZES: Record<(typeof CAPTURES)[number], number> = {
  'b1-20261101': 5386,
  'b2-20261101': 7056,
  'b3-20261101': 364,
  'b5-20261101': 565,
};

interface Run {
  /** Temporary output root, to delete when the test is done. */
  out: string;
  formatDir: string;
  files: string[];
  summary: string;
  converted: Uint8Array;
}

function convert(capture: string, extra: readonly string[] = []): Run {
  const out = mkdtempSync(join(tmpdir(), 'unknown-'));
  execFileSync(
    process.execPath,
    [cli, join(live, `${capture}.sbf`), '--to', 'ABBREV_ASCII', '--out', out, '--at', '2026-11-01T00:00:00', ...extra],
    { stdio: 'pipe' },
  );
  const root = join(out, capture);
  const stamp = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
  assert.ok(stamp, 'a Converted_On_<stamp> directory');
  const formatDir = join(root, stamp, 'ABBREV_ASCII');
  return {
    out,
    formatDir,
    files: readdirSync(formatDir),
    summary: readFileSync(join(root, stamp, `Summary_${capture}.txt`), 'utf8'),
    converted: new Uint8Array(readFileSync(join(formatDir, `${capture}.ABBREV_ASCII`))),
  };
}

function withRun<T>(capture: string, extra: readonly string[], body: (run: Run) => T): T {
  const run = convert(capture, extra);
  try {
    return body(run);
  } finally {
    rmSync(run.out, { recursive: true, force: true });
  }
}

for (const capture of CAPTURES) {
  test(`${capture}: --unknown-bytes=file writes the suite's own .UNKNOWN, byte for byte`, () => {
    withRun(capture, ['--unknown-bytes=file'], (run) => {
      assert.ok(run.files.includes(`${capture}.UNKNOWN`), `files: ${run.files.join(', ')}`);
      const ours = readFileSync(join(run.formatDir, `${capture}.UNKNOWN`));
      const golden = readFileSync(join(live, `golden-${capture}.UNKNOWN`));
      assert.equal(ours.length, SIZES[capture]);
      assert.equal(ours.length, golden.length);
      assert.ok(ours.equals(golden), 'the unknown stream is the same bytes');
    });
  });

  test(`${capture}: no flag and --unknown-bytes=ignore write no file, the count stays`, () => {
    for (const extra of [[], ['--unknown-bytes=ignore'], ['--unknown-bytes=SKIP']] as const) {
      withRun(capture, extra, (run) => {
        assert.equal(run.files.includes(`${capture}.UNKNOWN`), false, `${extra.join(' ') || 'no flag'} writes none`);
        assert.match(run.summary, /^\s+0 \| UNKNOWN\s*\|\s+\d+ \|/m);
      });
    }
  });
}

test('b2: file and ignore agree on the summary; only the sidecar differs', () => {
  const withFile = convert('b2-20261101', ['--unknown-bytes=file']);
  const withIgnore = convert('b2-20261101', ['--unknown-bytes=ignore']);
  try {
    const strip = (text: string) => text.split('\n').filter((_line, index) => index !== 1 && index !== 4 && index !== 7).join('\n');
    assert.equal(strip(withFile.summary), strip(withIgnore.summary));
    // The converted file itself is the same too: the unknown bytes only go to the sidecar.
    assert.equal(withFile.converted.length, withIgnore.converted.length);
    assert.ok(withFile.converted.every((byte, index) => byte === withIgnore.converted[index]));
  } finally {
    for (const run of [withFile, withIgnore]) rmSync(run.out, { recursive: true, force: true });
  }
});

/**
 * `--unknown-bytes=interleave` was measured on a synthetic capture through the suite: three
 * `BESTPOS` frames with `\r\n[USB2]\r\n<OK\r\n` between the first two and
 * `<ERROR:Message is invalid for this model\r\n[USB2]` between the last two, which comes back as
 * `#BESTPOSA…\r\n` + those bytes + `#BESTPOSA…\r\n` + those bytes + `#BESTPOSA…\r\n` — spliced
 * verbatim, in capture order. b1 opens with exactly such a run (`\r\n<OK\r\n[USB2]`), so the
 * spliced stream must open with those 13 bytes instead of the first rendered line.
 */
test('b1: interleave splices the unknown bytes into the converted stream at their position', () => {
  const interleaved = convert('b1-20261101', ['--unknown-bytes=interleave']);
  const plain = convert('b1-20261101');
  try {
    const file = interleaved.converted;
    const base = plain.converted;
    const unknown = readFileSync(join(live, 'golden-b1-20261101.UNKNOWN'));
    assert.equal(file.length, base.length + unknown.length);
    assert.equal(Buffer.from(file.subarray(0, 13)).toString('latin1'), '\r\n<OK\r\n[USB2]');
    // Right after those 13 bytes the converted stream continues, unchanged, from its first byte.
    assert.equal(file[13], base[0]);
    assert.equal(Buffer.from(file.subarray(13, 313)).toString('latin1'), Buffer.from(base.subarray(0, 300)).toString('latin1'));
  } finally {
    for (const run of [interleaved, plain]) rmSync(run.out, { recursive: true, force: true });
  }
});
