/**
 * `--unknown-bytes=[file|interleave|ignore]` and the two different numbers it is about.
 *
 * Measured against the suite's own Convert (2.11.0) on `b1`/`b2`/`b3`/`b5`:
 *
 *  - **the file** (`--unknown-bytes=file`, the CLI spelling of the GUI's `SEPARATEFILE`) is the
 *    capture minus every record whose payload renders minus every text record the parser resolves
 *    (a `<NAME …` header **and** its continuation rows) minus every record the reader never reached
 *    (`--decimate` drops it, or a Time Interval leaves it outside the window — 2026-11-02).
 *    5386 / 7056 / 364 / 565 bytes; ours is byte-identical, the `.UNKNOWN` goldens sit next to the
 *    captures.
 *  - **the Summary's `UNKNOWN` row** is the pre-scan's own count — 3695 / 6875 / 224 / 350 — which
 *    differs from the file on every capture. Same module, `unknownSpans`/`countUnknown`.
 *  - `ignore` (and no flag) write nothing and leave the count alone; `interleave` splices the bytes
 *    into the converted file at their capture position.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendCrcLe } from '../src/crc.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import type { EdieTables } from '../src/edie.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { buildLongHeader } from '../src/header.ts';

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

test('b2: file adds only the unconverted-byte sentence; the converted stream is identical', () => {
  const withFile = convert('b2-20261101', ['--unknown-bytes=file']);
  const withIgnore = convert('b2-20261101', ['--unknown-bytes=ignore']);
  try {
    // The suite prints `7056 bytes could not be converted.` only for `file`/`interleave`; everything
    // else in the Summary is the same (path/timestamp lines excluded by content, not by index).
    const strip = (text: string) => text.split('\n')
      .filter((line) => !line.includes('bytes could not be converted.'))
      .filter((line) => !line.includes('The following conversion was completed at'))
      .filter((line) => !line.startsWith('Input File was '))
      .filter((line) => !line.startsWith('Converted files were output to '))
      .join('\n')
      .replace(/\n+$/, '');
    assert.equal(strip(withFile.summary), strip(withIgnore.summary));
    assert.match(withFile.summary, /^7056 bytes could not be converted\.$/m);
    assert.doesNotMatch(withIgnore.summary, /bytes could not be converted/);
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

/* -------------------------------------------------------------------------------------------
 * --decimate × --unknown-bytes=file
 * ---------------------------------------------------------------------------------------- */

const tables = JSON.parse(
  readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

const latin1Text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const latin1Bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** A sealed SBF frame with the header fields the probes vary. */
function sealed(
  messageId: number,
  payload: Uint8Array,
  header: { week: number; milliseconds: number; timeStatus: number },
): Uint8Array {
  const head = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    portAddress: 32,
    sequence: 1,
    idleTimeRaw: 0,
    receiverStatus: 0x03800800,
    reserved: 0xcdba,
    softwareVersion: 18278,
    ...header,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return appendCrcLe(body);
}

const framesFrom = (bytes: Uint8Array): Frame[] => [...new SbfDeframer({ crcMode: 'validate' }).push(bytes)];

/**
 * Measured through the suite on the synthetic captures built below: `--decimate` removes the bytes
 * of the records it drops from `.UNKNOWN` too — but only those, never the junk around them.
 *
 *  - a silent record (an `RXCONFIG` that renders nothing) **off** the 5 s grid: the suite writes
 *    84 B without the flag and **16 B** with `--decimate=5` — the two 8-byte junk runs survive, the
 *    68-byte record does not;
 *  - the same record **on** the grid: 84 B both ways.
 *
 * On b1 that is 5 386 B → **4 014 B**: all 1 372 bytes belong to 12 spans / 19 `RXCONFIG` records
 * that render nothing and sit off the grid (the first at capture offset 132 094, stamped
 * `0/1.985`, status 20). The Summary's `UNKNOWN` row is a different question and stays at 3 695.
 */
test('--decimate takes the records it drops out of .UNKNOWN, and only those', () => {
  const b1 = framesFrom(new Uint8Array(readFileSync(join(live, 'b1-20261101.sbf'))));
  const silent = b1.find(
    (frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 128 && frame.offset === 132094,
  );
  assert.ok(silent, 'b1 carries the silent RXCONFIG at 132094');
  const junk = '\r\n[USB2]';
  const good = () => sealed(42, new Uint8Array(32), { week: 2442, milliseconds: 580_000_000, timeStatus: 180 });
  const silentAt = (milliseconds: number) =>
    sealed(128, silent.payload, { week: 0, milliseconds, timeStatus: 20 });

  const unknownOf = (capture: Uint8Array, decimate?: number) => convertFrames(framesFrom(capture), {
    format: 'ASCII',
    at: new Date('2026-11-01T00:00:00Z'),
    tables,
    name: 'probe.sbf',
    source: capture,
    unknownBytes: 'file',
    ...(decimate === undefined ? {} : { decimate }),
  }).unknown;

  // 577 500 500 ms is off the 5 s grid, 580 000 000 ms is on it.
  const offGrid = concat(latin1Bytes(junk), silentAt(577_500_500), latin1Bytes(junk), good());
  assert.equal(unknownOf(offGrid).length, 84);
  assert.equal(unknownOf(offGrid, 5).length, 16);
  assert.equal(latin1Text(unknownOf(offGrid, 5)), `${junk}${junk}`);

  const onGrid = concat(latin1Bytes(junk), silentAt(580_000_000), latin1Bytes(junk), good());
  assert.equal(unknownOf(onGrid).length, 84);
  assert.equal(unknownOf(onGrid, 5).length, 84);
  assert.equal(
    latin1Text(unknownOf(onGrid, 5)),
    latin1Text(concat(latin1Bytes(junk), silentAt(580_000_000), latin1Bytes(junk))),
  );
});

test("b1: --decimate=5 --unknown-bytes=file writes the suite's 4 014-byte .UNKNOWN", () => {
  withRun('b1-20261101', ['--decimate=5', '--unknown-bytes=file'], (run) => {
    const ours = readFileSync(join(run.formatDir, 'b1-20261101.UNKNOWN'));
    assert.equal(ours.length, 4014);
    // SHA-256 of the file the suite itself wrote for the same capture and the same flags.
    assert.equal(
      createHash('sha256').update(ours).digest('hex'),
      '50f75de6db28abcf2f19287803455641238994617261937df14a84eb47fe8600',
    );
    // Not the 5 386-byte stream truncated: the 19 dropped records (12 spans) are absent from it.
    const full = readFileSync(join(live, 'golden-b1-20261101.UNKNOWN'));
    assert.equal(full.length - ours.length, 1372);
    // The Summary's UNKNOWN row is the pre-scan count and does not follow --decimate.
    assert.match(run.summary, /^\s+0 \| UNKNOWN\s*\|\s+3695 \|/m);
  });
});

/**
 * A Time Interval narrows `.UNKNOWN` the same way, and here the measurements really differ from the
 * old assumption: b1's windowed run writes **3 770 B** (5 386 − the 22 silent `RXCONFIG`s, 1 616),
 * b1 windowed *and* decimated the same 3 770 B (the window already covers all 22; decimation covers
 * 19 of them, 1 372 B), and b2's windowed run keeps its whole 7 056 B (b2 has no silent record
 * outside the window). The 3 770 bytes of banners, `[USB2]` markers and `<OK` replies survive the
 * window untouched — text records are not skipped by it.
 */
test('b1: a Time Interval takes the records it leaves out of .UNKNOWN as well', () => {
  const window = ['--start-time=2442,570250', '--finish-time=2442,570255', '--unknown-bytes=file'];
  withRun('b1-20261101', window, (run) => {
    const ours = readFileSync(join(run.formatDir, 'b1-20261101.UNKNOWN'));
    assert.equal(ours.length, 3770);
    // The 22 silent records are gone, the 3 770 bytes of text junk are not.
    assert.equal(Buffer.from(ours.subarray(0, 13)).toString('latin1'), '\r\n<OK\r\n[USB2]');
  });
  withRun('b1-20261101', [...window, '--decimate=5'], (run) => {
    assert.equal(readFileSync(join(run.formatDir, 'b1-20261101.UNKNOWN')).length, 3770);
  });
  withRun('b2-20261101', ['--start-time=2442,577760', '--finish-time=2442,577770', '--unknown-bytes=file'], (run) => {
    assert.equal(readFileSync(join(run.formatDir, 'b2-20261101.UNKNOWN')).length, 7056);
  });
});

test('Summary: the unconverted-byte sentence is the kept .UNKNOWN size, and only with file/interleave', () => {
  // b1 --decimate=5: the suite writes `4014 bytes could not be converted.` above the table.
  withRun('b1-20261101', ['--decimate=5', '--unknown-bytes=file'], (run) => {
    assert.match(run.summary, /^4014 bytes could not be converted\.$/m);
  });
  // The Text Interval narrows both the file and the sentence (3 770), and the range is the window.
  withRun(
    'b1-20261101',
    ['--start-time=2442,570250', '--finish-time=2442,570255', '--unknown-bytes=file'],
    (run) => {
      assert.match(run.summary, /^3770 bytes could not be converted\.$/m);
      assert.match(run.summary, /Start time : 2442, 570250\n/);
      assert.match(run.summary, /Finish time: 2442, 570255\n/);
    },
  );
  // No flag (and `ignore`) keeps the sentence out, exactly like the suite.
  withRun('b1-20261101', [], (run) => {
    assert.doesNotMatch(run.summary, /bytes could not be converted/);
  });
  withRun('b1-20261101', ['--unknown-bytes=ignore'], (run) => {
    assert.doesNotMatch(run.summary, /bytes could not be converted/);
  });
});

test('Summary: the time range follows the window, not --decimate', () => {
  // The suite reports the input's own span even when decimation drops the earliest 3 seconds.
  withRun('b1-20261101', ['--decimate=5'], (run) => {
    assert.match(run.summary, /Start time : 2442, 570227\.071\n/);
    assert.match(run.summary, /Finish time: 2442, 570255\.15\n/);
  });
  // b2 starts at 577758.950 (the first non-SATTIME record), not at its ALMANAC 577140.
  withRun('b2-20261101', ['--decimate=5'], (run) => {
    assert.match(run.summary, /Start time : 2442, 577758\.95\n/);
    assert.match(run.summary, /Finish time: 2442, 577792\.05\n/);
  });
});

test('b7: dropped RXCONFIG records stay in .UNKNOWN but not in the Summary UNKNOWN row', () => {
  // The suite's b7 run: `.UNKNOWN` 3 935 B (22 RXCONFIGs whose embedded message is not in the
  // dictionary are dropped from the converted file but keep their bytes in the sidecar), Summary
  // UNKNOWN row 206 (only the responses). Ours used to report 3 720 for the row.
  withRun('b7-20261101', ['--unknown-bytes=file'], (run) => {
    const sidecar = readFileSync(join(run.formatDir, 'b7-20261101.UNKNOWN'));
    assert.equal(sidecar.length, 3935);
    assert.match(run.summary, /^\s+0 \| UNKNOWN\s*\|\s+206 \|/m);
  });
});
