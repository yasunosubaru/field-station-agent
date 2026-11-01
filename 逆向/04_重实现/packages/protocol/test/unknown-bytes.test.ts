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

/* -------------------------------------------------------------------------------------------
 * Time Interval × --unknown-bytes=interleave
 *
 * Measured on the 2.11.0 suite, 2026-11-02. The two numbers the suite reports for the same window
 * (b1 `--start-time=2442,570250 --finish-time=2442,570255`) settle the rule:
 *
 *   981 856 B   the windowed stream on its own (no unknown flag; `file` gives the same ASCII)
 *   985 626 B   the same run with `--unknown-bytes=interleave`
 *     3 770 B   the windowed `.UNKNOWN` (`b1` 5 386 − the 22 silent `RXCONFIG`s, 1 616)
 *
 * and 981 856 + 3 770 = 985 626, byte for byte. So a window does **not** switch interleaving off,
 * and the runs are the *windowed* account — the bytes of the records the window skipped are in
 * neither the stream nor the splice. No re-basing happens either: blocks and runs are ordered by
 * their capture offsets, so the first block is simply the first record the window kept and all the
 * junk before it lands at the top of the file (b1: 3 662 B of it, 3 770 − the eighteen `[USB2]`
 * runs that sit between kept records, which are spliced at their own offsets).
 *
 * The same holds for `--abbrev` (1 115 767 = 1 111 997 + 3 770), `-b` (514 764 = 510 994 + 3 770)
 * and b2 (3 057 948 = 3 050 892 + 7 056, b2 skipping no record in that window). `--decimate=5` on
 * the same window is 64 787 B, also exact.
 * ---------------------------------------------------------------------------------------- */

/** The suite's own SHA-256 for the files below — the digest is the assertion, not the length. */
const WINDOW_SHA = {
  /** b1 `-a --start-time=2442,570250 --finish-time=2442,570255` */
  b1Plain: '74780fa897297d4a2d7f6b47d506fb8e9de737fa60618a8fc9e6aa025435e5e9',
  /** the same, `--unknown-bytes=interleave` */
  b1Interleaved: '5da0389120022758b012361268dde6422b83f0b5069146ead542e0c271b8cb48',
  /** the same, `--abbrev … --unknown-bytes=interleave` */
  b1Abbrev: '2e8c7f55b943bb59c5bc0106bc7db9c9ece09d944ed230fc5d43f93898560862',
  /** the same, `-b … --unknown-bytes=interleave` */
  b1Binary: '9c8f55c3fcada6e4cdf8dd3ca987dc5bd5cc23b9b755b3b54a0ad747b21db608',
  /** b2 `-a --start-time=2442,577759 --finish-time=2442,577780 --unknown-bytes=interleave` */
  b2Interleaved: 'e3c5909d2c8f5da9665fef3fa0546ba3d44df30f18956479ee9a5f9ec55593ae',
  /** b1 `-a --start-time=2442,570249.5 --finish-time=2442,570254.5 --unknown-bytes=interleave` */
  b1Fractional: 'f6ebf66330a7651fcf8035257d8050176e7e9fce5b0cb052b247f7c0581124e8',
  /** b1 `-a --start-time=2442,570251 --finish-time=2442,570253.75 --unknown-bytes=interleave` */
  b1FractionalNarrow: '36aaf1f61a766092b71bdaf8eaf9ed92998297841f4adb85e97dbe02bfe50cf3',
  /** b1 `-a --decimate=5 --unknown-bytes=interleave` (no window) */
  b1Decimated: '1df4308d1ceff24e3402f8424f323e123c7974f7e3575f8c65f522f49e25e708',
  /** b1 `-a --decimate=5 --start-time=…570250 --finish-time=…570255 --unknown-bytes=interleave` */
  b1WindowDecimated: '33ec9e7a14c1542b137ecd4b5091806d5ce37d8cf1ba95fb3ea6da21c7243549',
} as const;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface FormatRun {
  out: string;
  bytes: Uint8Array;
  unknown: Uint8Array | undefined;
  summary: string;
}

/** One CLI run in a format of its choosing (`convert()` above is fixed to `ABBREV_ASCII`). */
function runFormat(
  capture: (typeof CAPTURES)[number],
  format: 'ASCII' | 'ABBREV_ASCII' | 'BINARY',
  extra: readonly string[],
): FormatRun {
  const out = mkdtempSync(join(tmpdir(), 'window-interleave-'));
  execFileSync(
    process.execPath,
    [cli, join(live, `${capture}.sbf`), '--to', format, '--out', out, '--at', '2026-11-01T00:00:00', ...extra],
    { stdio: 'pipe' },
  );
  const root = join(out, capture);
  const stamp = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
  assert.ok(stamp, 'a Converted_On_<stamp> directory');
  const formatDir = join(root, stamp, format);
  const name = `${capture}.${format}`;
  assert.ok(readdirSync(formatDir).includes(name), `${name} written`);
  const unknownName = `${capture}.UNKNOWN`;
  return {
    out,
    bytes: new Uint8Array(readFileSync(join(formatDir, name))),
    unknown: readdirSync(formatDir).includes(unknownName)
      ? new Uint8Array(readFileSync(join(formatDir, unknownName)))
      : undefined,
    summary: readFileSync(join(root, stamp, `Summary_${capture}.txt`), 'utf8'),
  };
}

const WINDOW = ['--start-time=2442,570250', '--finish-time=2442,570255'] as const;

test('b1: a Time Interval plus interleave is the suite file, byte for byte', () => {
  const plain = runFormat('b1-20261101', 'ASCII', WINDOW);
  const spliced = runFormat('b1-20261101', 'ASCII', [...WINDOW, '--unknown-bytes=interleave']);
  const sidecar = runFormat('b1-20261101', 'ASCII', [...WINDOW, '--unknown-bytes=file']);
  try {
    assert.equal(plain.bytes.length, 981856);
    assert.equal(sha256(plain.bytes), WINDOW_SHA.b1Plain);
    assert.equal(spliced.bytes.length, 985626);
    assert.equal(sha256(spliced.bytes), WINDOW_SHA.b1Interleaved);
    // The splice is exactly the windowed `.UNKNOWN`, and nothing else moves.
    assert.ok(sidecar.unknown, 'the windowed run writes a sidecar');
    assert.equal(sidecar.unknown.length, 3770);
    assert.equal(plain.bytes.length + sidecar.unknown.length, spliced.bytes.length);
    // The file opens with the capture's own first junk bytes, not with a `#` line.
    assert.equal(latin1Text(spliced.bytes.subarray(0, 13)), '\r\n<OK\r\n[USB2]');
    // …then 3 662 B of junk (the rest of 3 770 − eighteen `[USB2]` runs spliced between the kept
    // records), and only then the first kept record's line. That record's bytes sit *before* the
    // first kept SBF record and are kept by the record's own stamp, not by capture order — see
    // `applyTimeWindow`.
    const firstLine = plain.bytes.subarray(0, 22);
    assert.equal(latin1Text(firstLine), '#RXSTATUSA,USB2,0,69.0');
    assert.equal(
      Buffer.from(spliced.bytes).indexOf(Buffer.from(firstLine)),
      3662,
    );
    // The Summary's sentence is the kept unknown size, as with any `file`/`interleave` run.
    assert.match(spliced.summary, /^3770 bytes could not be converted\.$/m);
    assert.match(spliced.summary, /^\s+0 \| UNKNOWN\s*\|\s+3695 \|/m);
    assert.match(spliced.summary, /Start time : 2442, 570250\n/);
  } finally {
    for (const run of [plain, spliced, sidecar]) rmSync(run.out, { recursive: true, force: true });
  }
});

test('b1: --abbrev and -b interleave the same 3 770 bytes on a window', () => {
  const abbrev = runFormat('b1-20261101', 'ABBREV_ASCII', [...WINDOW, '--unknown-bytes=interleave']);
  const binary = runFormat('b1-20261101', 'BINARY', [...WINDOW, '--unknown-bytes=interleave']);
  try {
    assert.equal(abbrev.bytes.length, 1115767);
    assert.equal(sha256(abbrev.bytes), WINDOW_SHA.b1Abbrev);
    assert.equal(binary.bytes.length, 514764);
    assert.equal(sha256(binary.bytes), WINDOW_SHA.b1Binary);
    // Both are the plain windowed stream + the same 3 770 unknown bytes.
    assert.equal(abbrev.bytes.length, 1111997 + 3770);
    assert.equal(binary.bytes.length, 510994 + 3770);
  } finally {
    for (const run of [abbrev, binary]) rmSync(run.out, { recursive: true, force: true });
  }
});

test('b2: a Time Interval plus interleave adds its whole .UNKNOWN (7 056 B)', () => {
  const window = ['--start-time=2442,577759', '--finish-time=2442,577780'];
  const plain = runFormat('b2-20261101', 'ASCII', window);
  const spliced = runFormat('b2-20261101', 'ASCII', [...window, '--unknown-bytes=interleave']);
  try {
    assert.equal(plain.bytes.length, 3050892);
    assert.equal(spliced.bytes.length, 3057948);
    assert.equal(sha256(spliced.bytes), WINDOW_SHA.b2Interleaved);
    assert.equal(spliced.bytes.length - plain.bytes.length, 7056);
  } finally {
    for (const run of [plain, spliced]) rmSync(run.out, { recursive: true, force: true });
  }
});

test('b1: a window boundary between two records (fractional seconds) still matches', () => {
  const wide = runFormat('b1-20261101', 'ASCII', [
    '--start-time=2442,570249.5', '--finish-time=2442,570254.5', '--unknown-bytes=interleave',
  ]);
  const narrow = runFormat('b1-20261101', 'ASCII', [
    '--start-time=2442,570251', '--finish-time=2442,570253.75', '--unknown-bytes=interleave',
  ]);
  try {
    assert.equal(wide.bytes.length, 968073);
    assert.equal(sha256(wide.bytes), WINDOW_SHA.b1Fractional);
    assert.equal(narrow.bytes.length, 521134);
    assert.equal(sha256(narrow.bytes), WINDOW_SHA.b1FractionalNarrow);
  } finally {
    for (const run of [wide, narrow]) rmSync(run.out, { recursive: true, force: true });
  }
});

test('b1: --decimate and a Time Interval both keep interleaving', () => {
  const decimated = runFormat('b1-20261101', 'ASCII', ['--decimate=5', '--unknown-bytes=interleave']);
  const both = runFormat('b1-20261101', 'ASCII', [
    '--decimate=5', ...WINDOW, '--unknown-bytes=interleave',
  ]);
  try {
    assert.equal(decimated.bytes.length, 189915);
    assert.equal(sha256(decimated.bytes), WINDOW_SHA.b1Decimated);
    assert.equal(both.bytes.length, 64787);
    assert.equal(sha256(both.bytes), WINDOW_SHA.b1WindowDecimated);
  } finally {
    for (const run of [decimated, both]) rmSync(run.out, { recursive: true, force: true });
  }
});

/**
 * The boundary rule, on a capture small enough to state: a junk run has **no time**, so a Time
 * Interval never cuts one. What a window does is drop the *records* it leaves out, and the bytes of
 * a dropped record leave the account with it — the junk on either side of it stays whole and simply
 * becomes adjacent. Measured on b1 the same way: the windowed `.UNKNOWN` is 3 770 B rather than
 * 5 386 B because the 22 silent `RXCONFIG`s (1 616 B) are off-window, and every byte of the
 * remaining junk — the file's opening `\r\n<OK\r\n[USB2]` included — is still there.
 */
test('a window keeps every junk run whole and drops only the skipped records’ own bytes', () => {
  const junk = '\r\n[USB2]\r\n';
  const payload = new Uint8Array(32);
  const early = sealed(42, payload, { week: 2442, milliseconds: 570_000_000, timeStatus: 180 });
  const late = sealed(42, payload, { week: 2442, milliseconds: 580_000_000, timeStatus: 180 });
  const capture = concat(latin1Bytes(junk), early, latin1Bytes(junk), late, latin1Bytes(junk));
  const frames = framesFrom(capture);
  const window = { startTime: { week: 2442, seconds: 570100 }, finishTime: { week: 2442, seconds: 580100 } };
  const base = { format: 'ASCII' as const, at: new Date('2026-11-01T00:00:00Z'), tables, name: 'probe.sbf', source: capture };

  const plain = convertFrames(frames, { ...base, ...window });
  const sidecar = convertFrames(frames, { ...base, ...window, unknownBytes: 'file' });
  const spliced = convertFrames(frames, { ...base, ...window, unknownBytes: 'interleave' });

  // The early record's bytes are gone; the three junk runs are whole.
  assert.equal(latin1Text(sidecar.unknown), `${junk}${junk}${junk}`);
  // Ordering is by capture offset: both leading runs, then the kept record, then the trailing run.
  const record = plain.files[0].bytes;
  assert.ok(record.length > 0, 'the kept record renders');
  assert.equal(
    latin1Text(spliced.files[0].bytes),
    `${junk}${junk}${latin1Text(record)}${junk}`,
  );
});

