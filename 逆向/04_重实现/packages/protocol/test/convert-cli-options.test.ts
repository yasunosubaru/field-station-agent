/**
 * Convert's newer command-line options (manual 4.5.3–4.5.6), against what the installed 2.11.0
 * writes. Every number below was measured by running the suite on the same capture and diffing the
 * bytes:
 *
 * ```
 * b2 --limit-output-size=1        -> 5 parts  1 051 261 / 1 055 491 / 1 051 236 / 1 054 714 / 719 271
 * b2 --abbrev --limit-output-size=1 -> 6 parts  1 050 148 / 1 053 039 / 1 054 247 / 1 054 335 / 1 052 900 / 459 144
 * b2 -b --limit-output-size=1     -> 3 parts  1 051 424 / 1 049 358 / 632 556
 * b2 --limit-output-duration=5    -> 8 parts  12 758 / 575 571 / 779 993 / 781 441 / 782 302 / 781 840 / 780 667 / 437 401
 * b2 --limit-output-duration=20   -> 3 parts  12 758 / 2 898 358 / 2 020 857
 * b2 --limit-output-duration=60   -> 2 parts  12 758 / 4 919 215
 * b2 --daily-utc                  -> 1 part  4 931 973 (`b2-20261101_Part0.ASCII`, 905 lines)
 * live-nav --daily-utc            -> 2 parts  5 139 / 2 793 168
 * b2 --decimate=5                 -> 157 396 B / 87 lines
 * b2 --decimate=7                 -> 96 315 B / 39 lines
 * b2 --decimate=13                -> 51 232 B / 20 lines
 * b1 --decimate=5                 -> 185 901 B / 228 lines
 * b2 -b                           -> 2 733 338 B (638 RANGE + 61 unpacked = 699 RANGE frames)
 * b2 -b --no-expand-cmp           -> 2 574 334 B (638 RANGE + 31 RANGECMP2 + 30 RANGECMP4)
 * b2 -a --no-expand-cmp           -> 4 667 920 B
 * ```
 *
 * The tests below use a synthetic capture where the rule itself (not just its output) is what is at
 * stake, and the real captures where the byte counts are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendCrcLe, novatelCrc32 } from '../src/crc.ts';
import { SbfDeframer, type Frame } from '../src/framing.ts';
import { buildLongHeader } from '../src/header.ts';
import { convertFrames, type ConvertOptions } from '../src/convert-pipeline.ts';
import { textLogLines } from '../src/text-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', 'cli', 'src', 'convert.ts');
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const capture = join(live, 'b2-20261101.sbf');

const latin1Bytes = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

const tables = JSON.parse(
  readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;
const AT = new Date('2026-11-01T00:00:00Z');

function framesOf(path: string): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(path)))];
}

function convertCapture(path: string, options: Partial<ConvertOptions> = {}) {
  return convertFrames(framesOf(path), {
    format: 'ASCII',
    at: AT,
    tables,
    name: path.split(/[\\/]/).pop() as string,
    ...options,
  });
}

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

/* -------------------------------------------------------------------------------------------
 * --limit-output-size
 * ---------------------------------------------------------------------------------------- */

const sizes = (outcome: ReturnType<typeof convertFrames>) => outcome.files.map((file) => file.bytes.length);

test('--limit-output-size cuts at 1 MiB *after* a record and never inside one', () => {
  const whole = convertCapture(capture);
  const parts = convertCapture(capture, { splitMode: 'size', splitSizeMb: 1 });
  assert.deepEqual(parts.files.map((file) => file.name), [
    'b2-20261101_Part0.ASCII',
    'b2-20261101_Part1.ASCII',
    'b2-20261101_Part2.ASCII',
    'b2-20261101_Part3.ASCII',
    'b2-20261101_Part4.ASCII',
  ]);
  // The suite's own five parts, byte for byte.
  assert.deepEqual(sizes(parts), [1_051_261, 1_055_491, 1_051_236, 1_054_714, 719_271]);
  assert.equal(sizes(parts).reduce((sum, size) => sum + size, 0), whole.files[0].bytes.length);
  // Each part is a prefix of the unsplit file: the parts are a partition of the same lines.
  let at = 0;
  for (const part of parts.files) {
    assert.equal(Buffer.compare(Buffer.from(part.bytes), Buffer.from(whole.files[0].bytes.subarray(at, at + part.bytes.length))), 0);
    at += part.bytes.length;
  }
  // 1 MiB, not 1 MB: a 1 000 000 B threshold would cut five *different* parts.
  const megabytes = convertCapture(capture, { splitMode: 'size', splitSizeMb: 1_000_000 / 1_048_576 });
  assert.deepEqual(sizes(megabytes), [1_002_402, 1_006_602, 1_006_857, 1_000_446, 915_666]);
});

test('--limit-output-size splits ABBREV_ASCII at record boundaries and BINARY at frames', () => {
  const abbrev = convertCapture(capture, { format: 'ABBREV_ASCII', splitMode: 'size', splitSizeMb: 1 });
  assert.deepEqual(sizes(abbrev), [1_050_148, 1_053_039, 1_054_247, 1_054_335, 1_052_900, 459_144]);
  for (const part of abbrev.files) {
    // A part never starts with a continuation row: the split runs on whole records.
    assert.match(latin1Bytes(part.bytes).split('\r\n')[0], /^<[A-Z]/);
  }
  const binary = convertCapture(capture, { format: 'BINARY', splitMode: 'size', splitSizeMb: 1 });
  assert.deepEqual(sizes(binary), [1_051_424, 1_049_358, 632_556]);
  assert.equal(sizes(binary).reduce((sum, size) => sum + size, 0), 2_733_338);
});

/* -------------------------------------------------------------------------------------------
 * --limit-output-duration
 * ---------------------------------------------------------------------------------------- */

test('--limit-output-duration runs each part from the time of its own first record', () => {
  const parts = convertCapture(capture, { splitMode: 'time', splitSeconds: 5 });
  assert.deepEqual(parts.files.map((file) => file.name),
    Array.from({ length: 8 }, (_, index) => `b2-20261101_Part${index}.ASCII`));
  assert.deepEqual(sizes(parts), [12_758, 575_571, 779_993, 781_441, 782_302, 781_840, 780_667, 437_401]);
  // Part0 holds the almanac (the file's first record, `577140.000`) and the first record after it;
  // every later part begins at the first record *past* the previous part's `start + 5 s`.
  const lines = (index: number) => latin1Bytes(parts.files[index].bytes).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines(0).length, 2);
  assert.match(lines(0)[1], /,2442,577758\.950,/);
  assert.match(lines(1)[0], /,2442,577759\.000,/);
  assert.match(lines(1)[lines(1).length - 1], /,2442,577764\.000,/);
  assert.match(lines(2)[0], /,2442,577764\.050,/);
  assert.match(lines(2)[lines(2).length - 1], /,2442,577769\.050,/);

  assert.deepEqual(sizes(convertCapture(capture, { splitMode: 'time', splitSeconds: 20 })), [12_758, 2_898_358, 2_020_857]);
  assert.deepEqual(sizes(convertCapture(capture, { splitMode: 'time', splitSeconds: 60 })), [12_758, 4_919_215]);
  assert.equal(sizes(convertCapture(capture, { splitMode: 'time', splitSeconds: 2 })).length, 17);
});

/** A capture of BESTPOS records at chosen GPS times, for the rules a real capture cannot isolate. */
function synthetic(times: Array<{ week: number; seconds: number; status?: number }>): Frame[] {
  const payload = framesOf(capture).find((frame) => frame.kind === 'sbf' && frame.header.messageId === 42);
  assert.ok(payload && payload.kind === 'sbf');
  const pieces = times.map(({ week, seconds, status }) => {
    const whole = Math.floor(seconds);
    const head = buildLongHeader({
      messageId: 42,
      payloadLength: payload.payload.length,
      portAddress: 32,
      sequence: 1,
      idleTimeRaw: 0,
      timeStatus: status ?? 180,
      week,
      milliseconds: whole * 1000 + Math.round((seconds - whole) * 1000),
      receiverStatus: 0x03800800,
      reserved: 0xcdba,
      softwareVersion: 18278,
    });
    const body = new Uint8Array(head.length + payload.payload.length);
    body.set(head, 0);
    body.set(payload.payload, head.length);
    return appendCrcLe(body);
  });
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) { bytes.set(piece, at); at += piece.length; }
  return [...new SbfDeframer({ crcMode: 'validate' }).push(bytes)];
}

function partStamps(frames: Frame[], splitSeconds: number): number[][] {
  const outcome = convertFrames(frames, {
    format: 'ASCII', at: AT, tables, name: 'probe.sbf', splitMode: 'time', splitSeconds,
  });
  return outcome.files.map((file) => latin1Bytes(file.bytes)
    .split('\r\n')
    .filter((line) => line.length > 0)
    .map((line) => Number(line.slice(1).split(/[,;]/)[6])));
}

test('--limit-output-duration closes a part on the record that reaches the window', () => {
  // Measured on the suite with exactly these times: the record at the window's end belongs to the
  // part it closes, the next record opens the next part.
  const stamps = partStamps(synthetic([
    { week: 2442, seconds: 577760 },
    { week: 2442, seconds: 577765 },
    { week: 2442, seconds: 577765.05 },
    { week: 2442, seconds: 577765.1 },
    { week: 2442, seconds: 577765.15 },
    { week: 2442, seconds: 577770 },
    { week: 2442, seconds: 577770.05 },
    { week: 2442, seconds: 577770.1 },
  ]), 5);
  assert.deepEqual(stamps, [
    [577760, 577765],
    [577765.05, 577765.1, 577765.15, 577770, 577770.05],
    [577770.1],
  ]);
  // A record that jumps far past the window is still written before the part closes (the part is
  // only marked full by it): `577790` stays in Part0 and `577790.05` opens Part1.
  assert.deepEqual(partStamps(synthetic([
    { week: 2442, seconds: 577760 },
    { week: 2442, seconds: 577790 },
    { week: 2442, seconds: 577790.05 },
  ]), 5), [[577760, 577790], [577790.05]]);
});

/* -------------------------------------------------------------------------------------------
 * --daily-utc
 * ---------------------------------------------------------------------------------------- */

test('--daily-utc leaves a one-day capture in one part and splits at the UTC day boundary', () => {
  const day = convertCapture(capture, { splitMode: 'daily' });
  assert.deepEqual(day.files.map((file) => file.name), ['b2-20261101_Part0.ASCII']);
  assert.equal(day.files[0].bytes.length, 4_931_973);
  assert.equal(latin1Bytes(day.files[0].bytes).split('\r\n').filter((line) => line.length > 0).length, 905);

  // live-nav opens with records stamped a fortnight earlier, which the suite also keeps in one
  // part until the day actually advances — no leap-second correction: the boundary is
  // seconds-of-week ≡ 0 (mod 86400), measured on synthetic captures either side of 518400/604800.
  const nav = convertCapture(join(live, 'live-nav.sbf'), { splitMode: 'daily' });
  assert.deepEqual(nav.files.map((file) => file.bytes.length), [5_139, 2_793_168]);

  // b1 opens with text banners and 24 `RXCONFIG` records stamped `week 0` whose status is `SATTIME`,
  // plus `id 1246` frames with `week 0` and status 20; none of them may start the day clock.
  const b1 = convertCapture(join(live, 'b1-20261101.sbf'), { splitMode: 'daily' });
  assert.deepEqual(b1.files.map((file) => file.name), ['b1-20261101_Part0.ASCII']);
  assert.equal(b1.files[0].bytes.length, 5_088_882);
});

test('--daily-utc only moves its day clock on an observation time status', () => {
  // `SATTIME` (200) marks an almanac reference epoch, not an observation time. b2 carries
  // `GLORAWALM` at week 2402 in the middle of a week-2442 capture; with the record counted the day
  // would jump backwards and then forwards, producing two parts instead of one.
  const partsOf = (frames: Frame[]) => convertFrames(frames, {
    format: 'ASCII', at: AT, tables, name: 'probe.sbf', splitMode: 'daily',
  }).files.map((file) => latin1Bytes(file.bytes).split('\r\n').filter((line) => line.length > 0).length);
  const withSattime = synthetic([
    { week: 2442, seconds: 577759 },
    { week: 2402, seconds: 93768, status: 200 },
    { week: 2442, seconds: 577760 },
  ]);
  assert.deepEqual(partsOf(withSattime), [3]);
  // The same record with an ordinary time status does move the clock, and the next record opens a
  // new part — which is what the suite writes.
  const withoutSattime = synthetic([
    { week: 2442, seconds: 577759 },
    { week: 2402, seconds: 93768 },
    { week: 2442, seconds: 577760 },
  ]);
  assert.deepEqual(partsOf(withoutSattime), [2, 1]);

  // Which statuses count: measured one status per run. `FINE` (80) and up to `FINESTEERING` (180)
  // move the clock; `UNKNOWN` (0), `APPROXIMATE` (20) and `COARSESTEERING` (60) do not.
  const clockMovedBy = (status: number) => partsOf(synthetic([
    { week: 2442, seconds: 577759 },
    { week: 0, seconds: 2.176, status },
    { week: 2442, seconds: 577760 },
  ]));
  for (const status of [0, 20, 60, 200]) assert.deepEqual(clockMovedBy(status), [3], `status ${status}`);
  for (const status of [80, 100, 120, 160, 180]) assert.deepEqual(clockMovedBy(status), [2, 1], `status ${status}`);
});

/** The body of b1's `#BESTPOSA` text records — a complete, canonical message the parser renders. */
const BESTPOS_BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,'
  + '1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';

/**
 * A `#BESTPOSA` text record with its own header time. The CRC covers the sentence after the leading
 * `#` (measured: a record whose trailer matches is echoed verbatim by the suite, everything else is
 * dropped before parsing), so the week/seconds/status can be set freely.
 */
function textBestpos(week: number, seconds: number, status: string): Frame {
  const sentence = `BESTPOSA,USB2,0,72.0,${status},${week},${seconds.toFixed(3)},03801800,cdba,18278;${BESTPOS_BODY}`;
  const body = new Uint8Array(sentence.length);
  for (let i = 0; i < sentence.length; i++) body[i] = sentence.charCodeAt(i) & 0xff;
  const crc = novatelCrc32(body).toString(16).padStart(8, '0');
  return { kind: 'text', prefix: '#', text: `#${sentence}*${crc}\r\n` };
}

const dailyLines = (frames: Frame[]): number[] => convertFrames(frames, {
  format: 'ASCII', at: AT, tables, name: 'probe.sbf', splitMode: 'daily',
}).files.map((file) => latin1Bytes(file.bytes).split('\r\n').filter((line) => line.length > 0).length);

/**
 * A **text** record's day clock is one status wider than a binary record's: `COARSESTEERING` (60)
 * participates, `UNKNOWN` (0), `APPROXIMATE` (20) and `SATTIME` (200) still do not. Measured on the
 * suite one status per run, the probe written as a `#BESTPOSA` text record:
 *
 * ```
 * 2442:577759 → 2443:1.000 → 2442:577760     60/80/100/120/160/180 → two parts (cut at the probe)
 *                                             0/20/200               → one part
 * 2442:577759 → week 0:2.176 → 2442:577760   60/80/100/120/160/180 → two parts (cut at the *last*)
 *                                             0/20/200               → one part
 * ```
 *
 * The identical `COARSESTEERING` stamp as a *binary* frame does not move the clock at all, which is
 * the whole reason the two sets exist: b7 carries `COARSESTEERING` text records, and the suite
 * splits it three ways because they count.
 */
test('--daily-utc moves a text record its own status, one status wider than a binary frame', () => {
  const advancing = (status: string) => dailyLines([
    textBestpos(2442, 577759, 'FINESTEERING'),
    textBestpos(2443, 1, status),
    textBestpos(2442, 577760, 'FINESTEERING'),
  ]);
  for (const status of ['COARSESTEERING', 'FINE', 'FINEADJUSTING', 'DEGRADED', 'ALIGNING', 'FINESTEERING']) {
    assert.deepEqual(advancing(status), [1, 2], status);
  }
  for (const status of ['UNKNOWN', 'APPROXIMATE', 'SATTIME']) {
    assert.deepEqual(advancing(status), [3], status);
  }

  // A week-0 text record pulls the clock back to day 0, and the next same-day record opens a part.
  const backwards = (status: string) => dailyLines([
    textBestpos(2442, 577759, 'FINESTEERING'),
    textBestpos(0, 2.176, status),
    textBestpos(2442, 577760, 'FINESTEERING'),
  ]);
  for (const status of ['COARSESTEERING', 'FINE', 'FINESTEERING']) {
    assert.deepEqual(backwards(status), [2, 1], status);
  }
  for (const status of ['UNKNOWN', 'APPROXIMATE', 'SATTIME']) {
    assert.deepEqual(backwards(status), [3], status);
  }

  // The same stamps as binary frames: COARSESTEERING does not move the clock there.
  const binary = (status: number) => dailyLines(synthetic([
    { week: 2442, seconds: 577759 },
    { week: 2443, seconds: 1, status },
    { week: 2442, seconds: 577760 },
  ]));
  assert.deepEqual(binary(60), [3]);
  assert.deepEqual(binary(120), [1, 2]);
});

/**
 * The day clock is **not monotone**: a late record rewinds it, so the next record that is later than
 * the rewound clock opens a new part. Measured on the suite with
 * `[2443:1.000:120, 2442:577760:120, 2443:2.000:120]` → two parts, the second holding only the last
 * record — and the same shape with text records at `COARSESTEERING`.
 *
 * This is the rule that writes b7's three parts: `2443/35948` (day 17101) opens Part1 after day
 * 17100, the late `2442/553834.993` (day 17100) rewinds it *inside* Part1, and `2443/23262.546`
 * (day 17101) opens Part2. b7's binary frames are status 120, its text records `COARSESTEERING` —
 * both participate.
 */
test('--daily-utc follows a late record backwards and splits again on the next jump forward', () => {
  assert.deepEqual(dailyLines(synthetic([
    { week: 2443, seconds: 1000, status: 120 },
    { week: 2442, seconds: 577760, status: 120 },
    { week: 2443, seconds: 2000, status: 120 },
  ])), [2, 1]);
  assert.deepEqual(dailyLines(synthetic([
    { week: 2443, seconds: 1000, status: 80 },
    { week: 2442, seconds: 577760, status: 80 },
    { week: 2443, seconds: 2000, status: 80 },
  ])), [2, 1]);
  assert.deepEqual(dailyLines([
    textBestpos(2443, 1, 'COARSESTEERING'),
    textBestpos(2442, 577760, 'COARSESTEERING'),
    textBestpos(2443, 2, 'COARSESTEERING'),
  ]), [2, 1]);
  // Same day, out of order: no part boundary either way.
  assert.deepEqual(dailyLines(synthetic([
    { week: 2442, seconds: 577760, status: 60 },
    { week: 2442, seconds: 577759, status: 60 },
    { week: 2442, seconds: 577761, status: 60 },
  ])), [3]);
});

/**
 * The clock starts at the first record that carries a stamp **at all**, whatever its status: a
 * week-0 `COARSESTEERING` frame starts it at day 0, and the first real day after that splits
 * (measured `[0:2.176:60, 2443:1.000:120, 2443:2.000:120]` → `1 + 2` lines). A record that cannot
 * move the clock can still start it; only moving it is gated.
 */
test('--daily-utc starts its clock at the first stamped record, whatever its status', () => {
  assert.deepEqual(dailyLines(synthetic([
    { week: 0, seconds: 2.176, status: 60 },
    { week: 2443, seconds: 1000, status: 120 },
    { week: 2443, seconds: 2000, status: 120 },
  ])), [1, 2]);
  assert.deepEqual(dailyLines([
    textBestpos(0, 2.176, 'UNKNOWN'),
    textBestpos(2443, 1, 'COARSESTEERING'),
    textBestpos(2443, 2, 'COARSESTEERING'),
  ]), [1, 2]);
});

/**
 * b7 is the capture that exposed the rule: 609 lines that the suite writes as
 * **233 + 24 + 352**. Every number below was measured from the suite's own `--daily-utc` run
 * (40 933 / 5 161 / 1 054 895 bytes), and the digests are of its three part files.
 */
test('b7: --daily-utc writes the suite\'s three parts, byte for byte', () => {
  const b7 = convertCapture(join(live, 'b7-20261101.sbf'), { splitMode: 'daily' });
  const SIZES = [40_933, 5_161, 1_054_895];
  const LINES = [233, 24, 352];
  const DIGESTS = [
    '12d89017487251b084d0ce4853ea428968b46a97be730900b0b134fbb18ede2c',
    'fd21de678a9d1b73d46d23eb700e5a221ddbe869d5c10b49315b93cb2b96fd6c',
    '7e1765f622287ba48dd710959b0051f6ce860c911d22a4a90158e6386a174eea',
  ];
  assert.deepEqual(b7.files.map((file) => file.name), [
    'b7-20261101_Part0.ASCII', 'b7-20261101_Part1.ASCII', 'b7-20261101_Part2.ASCII',
  ]);
  b7.files.forEach((file, index) => {
    assert.equal(file.bytes.length, SIZES[index], `Part${index} bytes`);
    assert.equal(latin1Bytes(file.bytes).split('\r\n').filter((line) => line.length > 0).length, LINES[index]);
    assert.equal(createHash('sha256').update(file.bytes).digest('hex'), DIGESTS[index], `Part${index} digest`);
  });
  // The cut is at the record that is a *later* day: Part1 opens on the `2443/35948.000` BESTPOS and
  // Part2 on the `2443/23262.546` RXCONFIG that follows the late `2442/553862.266` one.
  assert.match(latin1Bytes(b7.files[1].bytes).slice(0, 80), /^#BESTPOSA,[^,]+,0,[^,]+,COARSESTEERING,2443,35948\.000,/);
  assert.match(latin1Bytes(b7.files[2].bytes).slice(0, 80), /^#RXCONFIGA,[^,]+,2,[^,]+,COARSESTEERING,2443,23262\.546,/);
  // Part1 is the only part that holds two days: it *ends* on the late `2442/553862.266` record.
  const lastOfPart1 = latin1Bytes(b7.files[1].bytes).split('\r\n').filter((line) => line.length > 0).pop();
  assert.match(lastOfPart1 ?? '', /^#RXCONFIGA,.*,COARSESTEERING,2442,553862\.266,/);
});

/* -------------------------------------------------------------------------------------------
 * --decimate
 * ---------------------------------------------------------------------------------------- */

const stampsOf = (bytes: Uint8Array) => latin1Bytes(bytes)
  .split('\r\n')
  .filter((line) => line.length > 0)
  .map((line) => Number(line.slice(1).split(/[,;]/)[6]));

test('--decimate keeps the records aligned to the interval, not every Nth record', () => {
  const five = convertCapture(capture, { decimate: 5 });
  assert.equal(five.files[0].bytes.length, 157_396);
  const stamps = stampsOf(five.files[0].bytes);
  assert.equal(stamps.length, 87);
  for (const stamp of stamps) assert.equal(stamp % 5, 0, `${stamp} is not aligned to 5 s`);
  // A 1 Hz log collapses to once per 5 s and the 20 Hz observation stream keeps one epoch's rows.
  assert.equal(five.counts.get(42)?.source, 7); // BESTPOS
  assert.equal(five.counts.get(181)?.source, 6); // MARKPOS
  assert.equal(five.counts.get(43)?.source, 7); // the plain RANGE rows at an aligned epoch
  assert.equal(five.counts.get(43)?.output, 19); // … plus the 12 RANGECMP2/4 blocks that land on one
  assert.equal(five.counts.get(1543)?.source, 3); // PPPXYZ

  assert.equal(convertCapture(capture, { decimate: 7 }).files[0].bytes.length, 96_315);
  assert.equal(convertCapture(capture, { decimate: 13 }).files[0].bytes.length, 51_232);
});

test('--decimate aligns to the start of the GPS week, not to the file or to absolute GPS time', () => {
  // A divisor of 604 800 (7) cannot tell the two apart; 13 can. Absolute GPS seconds of week 2442
  // satisfy `t ≡ 2 (mod 13)`, seconds-of-week `t ≡ 0`; the suite keeps 577759 / 577772 / 577785.
  const thirteen = stampsOf(convertCapture(capture, { decimate: 13 }).files[0].bytes);
  assert.deepEqual([...new Set(thirteen.filter((stamp) => stamp > 577000))], [577759, 577772, 577785]);
  for (const stamp of thirteen) assert.equal(stamp % 13, 0);
});

test('--decimate applies a text record its own header time', () => {
  const b1 = convertCapture(join(live, 'b1-20261101.sbf'), { decimate: 5 });
  assert.equal(b1.files[0].bytes.length, 185_901);
  const lines = latin1Bytes(b1.files[0].bytes).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 228);
  // b1 carries 99 text records. Each survives exactly when its *own* header time is a whole 5 s —
  // a record at `570230` stays even though its predecessor is `570229.85`, one at `570231` goes.
  const frames = framesOf(join(live, 'b1-20261101.sbf'));
  const textLines = [...textLogLines(frames, tables).values()].map((value) => (Array.isArray(value) ? value[0] : value));
  assert.equal(textLines.length, 99);
  const printed = new Set(lines);
  let kept = 0;
  for (const line of textLines) {
    const stamp = Number(line.split(/[,;]/)[6]);
    const aligned = stamp % 5 === 0;
    assert.equal(printed.has(line), aligned, `text record stamped ${stamp}`);
    if (aligned) kept += 1;
  }
  assert.equal(kept, 46);
});

/* -------------------------------------------------------------------------------------------
 * --expand-cmp / --no-expand-cmp
 * ---------------------------------------------------------------------------------------- */

test('--expand-cmp is the default and unpacks RANGECMP* in BINARY as well as in ASCII', () => {
  const expanded = convertCapture(capture, { format: 'BINARY' });
  assert.equal(expanded.files[0].bytes.length, 2_733_338);
  const frames = [...new SbfDeframer({ crcMode: 'ignore' }).push(expanded.files[0].bytes)]
    .filter((frame) => frame.kind === 'sbf');
  const counts = new Map<number, number>();
  for (const frame of frames) counts.set(frame.header.messageId, (counts.get(frame.header.messageId) ?? 0) + 1);
  assert.equal(counts.get(43), 699, '638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 unpacked');
  assert.equal(counts.get(1273), undefined);
  assert.equal(counts.get(2050), undefined);
  // The expansion is a real frame: id 43, a 3 868-byte payload for 87 observations, sealed with its
  // own CRC (the suite's file is byte-identical to this one).
  assert.equal(expanded.counts.get(43)?.source, 638);
  assert.equal(expanded.counts.get(43)?.output, 699);
});

test('--no-expand-cmp copies the compressed records through', () => {
  const binary = convertCapture(capture, { format: 'BINARY', expandCmp: false });
  assert.equal(binary.files[0].bytes.length, 2_574_334);
  const frames = [...new SbfDeframer({ crcMode: 'ignore' }).push(binary.files[0].bytes)]
    .filter((frame) => frame.kind === 'sbf');
  const counts = new Map<number, number>();
  for (const frame of frames) counts.set(frame.header.messageId, (counts.get(frame.header.messageId) ?? 0) + 1);
  assert.equal(counts.get(43), 638);
  assert.equal(counts.get(1273), 31);
  assert.equal(counts.get(2050), 30);
  // The summary follows the output: 1:1 rows instead of `RANGE 638 → 699`.
  assert.equal(binary.counts.get(43)?.output, 638);
  assert.equal(binary.counts.get(1273)?.output, 31);

  const ascii = convertCapture(capture, { expandCmp: false });
  assert.equal(ascii.files[0].bytes.length, 4_667_920);
  assert.equal(latin1Bytes(ascii.files[0].bytes).split('\r\n').filter((line) => line.length > 0).length, 905);
});

test('a BINARY conversion drops a record that renders nothing, as the suite does', () => {
  // b4 carries 19 `RXCONFIGUSER` records whose embedded message the dictionary lacks; b1 carries 22
  // such `RXCONFIG` ones. The suite's own `-b` files hold 225 and 256 of them.
  const b4 = convertCapture(join(live, 'b4-20261101.sbf'), { format: 'BINARY' });
  assert.equal(b4.files[0].bytes.length, 4_138_280);
  const b1 = convertCapture(join(live, 'b1-20261101.sbf'), { format: 'BINARY' });
  const frames = [...new SbfDeframer({ crcMode: 'ignore' }).push(b1.files[0].bytes)]
    .filter((frame) => frame.kind === 'sbf');
  assert.equal(frames.filter((frame) => frame.header.messageId === 128).length, 256);
});
