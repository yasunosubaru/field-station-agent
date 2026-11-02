/**
 * `--unknown-bytes` × the four split modes (`--split` / `--limit-output-size` /
 * `--limit-output-duration` / `--daily-utc`), measured against the installed 2.11.0 suite on
 * 2026-11-02.
 *
 * The matrix (every number below is the suite's own output, and every digest is pinned):
 *
 * ```
 * capture  flags                                              files            what interleave does
 * b1       -a --split --unknown-bytes=interleave               27 (26 + side)  sidecar b1-…_UNKNOWN.ASCII, 5 386 B
 * b1       --abbrev --split --unknown-bytes=interleave         27              sidecar …_UNKNOWN.ABBREV_ASCII, same bytes
 * b1       -b --split --unknown-bytes=interleave               27              sidecar …_UNKNOWN.BINARY, same bytes
 * b2       -a --limit-output-size=1 --unknown-bytes=interleave  5 parts        1 051 452 / 1 055 374 / 1 051 235 / 1 054 714 / 726 254
 * b2       -a --limit-output-duration=5 --unknown-bytes=interleave  7 parts    573 318 / 795 078 / 781 441 / 782 301 / 781 840 / 780 106 / 444 945
 * b5       -a --daily-utc --unknown-bytes=interleave            2 parts        1 439 624 / 4 915 874
 * b7       -a --daily-utc --unknown-bytes=interleave            3 parts        44 518 / 5 161 / 1 055 245
 * b1       -a --daily-utc --unknown-bytes=interleave            1 part         5 094 255  (= 5 088 882 + 5 386 − 13)
 * b2       --abbrev --limit-output-size=1 --unknown-bytes=interleave  6 parts 1 048 595 / 1 053 322 / 1 054 462 / 1 054 335 / 1 052 900 / 467 255
 * b2       -b --limit-output-duration=5 --unknown-bytes=interleave    7 parts 321 188 / 440 324 / 433 416 / 432 992 / 433 550 / 431 920 / 247 004
 * ```
 *
 * Four rules fall out of it, and each has a test below:
 *
 *  1. **`--split` never splices.** There is no combined file to splice into and the suite does not
 *     repeat the junk inside every per-log file: `file` and `interleave` both write the whole
 *     unknown stream to `<base>_UNKNOWN.<ext>` (the same bytes as `<base>.UNKNOWN`), and `ignore`
 *     writes nothing at all;
 *  2. **`size` / `time` / `daily` always splice**, and `--unknown-bytes=file` there behaves exactly
 *     like `interleave` — no sidecar is written. The parts are a **partition of the interleaved
 *     stream**: b2's five size parts and its seven duration parts each concatenate to exactly the
 *     unsplit interleaved file (4 939 029 B);
 *  3. **`size` counts the spliced bytes** (and a junk run can close a part on its own); `time` and
 *     `daily` decide their parts from the records alone, and the junk between the record that closes
 *     a part and the one that opens the next stays at the end of the earlier part;
 *  4. **a `time` part that opens on unknown bytes has no anchor**: b2's interleaved duration run
 *     anchors Part0 on `577758.950` instead of the `ALMANAC` at `577140.000` (seven parts instead of
 *     the plain eight), and `--daily-utc` additionally *drops* the unknown run before the first
 *     record (b1: 13 bytes, the capture's opening `\r\n<OK\r\n[USB2]`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendCrcLe } from '../src/crc.ts';
import { convertFrames, type ConvertOptions, type ConvertOutcome } from '../src/convert-pipeline.ts';
import type { EdieTables } from '../src/edie.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { buildLongHeader } from '../src/header.ts';

const here = dirname(fileURLToPath(import.meta.url));
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

const tables = JSON.parse(
  readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;
const AT = new Date('2026-11-01T00:00:00Z');

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const latin1Text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const sizes = (outcome: ConvertOutcome): number[] => outcome.files.map((file) => file.bytes.length);

function captureOf(name: string): { source: Uint8Array; frames: Frame[] } {
  const source = new Uint8Array(readFileSync(join(live, `${name}.sbf`)));
  return { source, frames: [...new SbfDeframer({ crcMode: 'validate' }).push(source)] };
}

/** Convert one of the real captures with the CLI's own option object. */
function run(name: string, options: Partial<ConvertOptions> = {}): ConvertOutcome {
  const { source, frames } = captureOf(name);
  return convertFrames(frames, {
    format: 'ASCII',
    at: AT,
    tables,
    name: `${name}.sbf`,
    source,
    ...options,
  });
}

/* ---------------------------------------------------------------------------------------------
 * 1. --split (LOGS): a sidecar, never a splice
 * ------------------------------------------------------------------------------------------ */

test('b1: --split + interleave writes the suite\'s per-log files and one _UNKNOWN.ASCII', () => {
  const outcome = run('b1-20261101', { splitMode: 'logs', unknownBytes: 'interleave' });
  const names = outcome.files.map((file) => file.name);
  assert.equal(names.length, 27, '26 log files plus the unknown sidecar');
  assert.ok(names.includes('b1-20261101_UNKNOWN.ASCII'), 'the sidecar is named after the split pattern');
  assert.equal(names.includes('b1-20261101.ASCII'), false, 'no combined file');

  const byName = new Map(outcome.files.map((file) => [file.name, file.bytes]));
  // The suite's own bytes for the same run (kept from `NovAtelApplicationSuite.exe -a --split
  // --unknown-bytes=interleave b1-20261101.sbf`).
  assert.equal(byName.get('b1-20261101_UNKNOWN.ASCII')!.length, 5_386);
  assert.equal(sha(byName.get('b1-20261101_UNKNOWN.ASCII')!), 'd3855e28fee465e59f68e4b18e32167c761cb892ff7e920cbf5aed5ea76e44a8');
  assert.equal(byName.get('b1-20261101_RANGE.ASCII')!.length, 3_757_001);
  assert.equal(sha(byName.get('b1-20261101_RANGE.ASCII')!), 'a6322d33558891c3c3ff39b84d0622cfb0aa973a569d1b6bed68c7e83003dae7');
  assert.equal(sha(byName.get('b1-20261101_BESTPOS.ASCII')!), '2dc1edc686ea9fae5195e38b7a193648d18d384250b50d8a15e17f87f21bc628');
  assert.equal(sha(byName.get('b1-20261101_TRACKSTAT.ASCII')!), 'd3866510c3a5085b75bf8256a99d1b7697996235660641f97b73a9203b6e4ad8');

  // The per-log files never carry the junk: they are byte-identical to the plain `--split` run, and
  // so are the same files under `--unknown-bytes=file` / `ignore`.
  const plain = run('b1-20261101', { splitMode: 'logs' });
  const file = run('b1-20261101', { splitMode: 'logs', unknownBytes: 'file' });
  const ignore = run('b1-20261101', { splitMode: 'logs', unknownBytes: 'ignore' });
  const logs = (outcome2: ConvertOutcome) => outcome2.files.filter((entry) => entry.name !== 'b1-20261101_UNKNOWN.ASCII');
  for (const other of [file, ignore]) {
    assert.deepEqual(logs(other).map((entry) => entry.name), logs(plain).map((entry) => entry.name));
    logs(other).forEach((entry, index) => {
      assert.equal(sha(entry.bytes), sha(logs(plain)[index].bytes), `${entry.name} under ${other === file ? 'file' : 'ignore'}`);
    });
  }
  // `file` writes the same sidecar under the split name; `ignore` writes none at all.
  assert.equal(file.files.some((entry) => entry.name === 'b1-20261101_UNKNOWN.ASCII'), true);
  assert.equal(sha(file.files.find((entry) => entry.name === 'b1-20261101_UNKNOWN.ASCII')!.bytes),
    'd3855e28fee465e59f68e4b18e32167c761cb892ff7e920cbf5aed5ea76e44a8');
  assert.equal(ignore.files.length, 26, '`ignore` (SKIP) adds nothing');
  assert.equal(plain.files.length, 26);
});

test('b1: --abbrev and -b under --split name the sidecar after the format', () => {
  const abbrev = run('b1-20261101', { format: 'ABBREV_ASCII', splitMode: 'logs', unknownBytes: 'interleave' });
  const binary = run('b1-20261101', { format: 'BINARY', splitMode: 'logs', unknownBytes: 'interleave' });
  for (const [outcome, suffix] of [[abbrev, 'ABBREV_ASCII'], [binary, 'BINARY']] as const) {
    assert.equal(outcome.files.length, 27);
    const sidecar = outcome.files.find((file) => file.name === `b1-20261101_UNKNOWN.${suffix}`);
    assert.ok(sidecar, `_UNKNOWN.${suffix}`);
    // The sidecar is the raw unknown stream in every format — the same 5 386 bytes as `.UNKNOWN`.
    assert.equal(sidecar.bytes.length, 5_386);
    assert.equal(sha(sidecar.bytes), 'd3855e28fee465e59f68e4b18e32167c761cb892ff7e920cbf5aed5ea76e44a8');
  }
  // …and the per-log ABBREV/BINARY files are the plain split's, untouched by the mode.
  const plain = run('b1-20261101', { format: 'ABBREV_ASCII', splitMode: 'logs' });
  const logs = abbrev.files.filter((file) => !file.name.includes('_UNKNOWN.'));
  assert.deepEqual(logs.map((file) => file.name), plain.files.map((file) => file.name));
  logs.forEach((file, index) => assert.equal(sha(file.bytes), sha(plain.files[index].bytes), file.name));
});

/* ---------------------------------------------------------------------------------------------
 * 2. --limit-output-size: the counter includes the spliced bytes
 * ------------------------------------------------------------------------------------------ */

test('b2: --limit-output-size=1 + interleave is the suite\'s five parts, byte for byte', () => {
  const outcome = run('b2-20261101', { splitMode: 'size', splitSizeMb: 1, unknownBytes: 'interleave' });
  assert.deepEqual(outcome.files.map((file) => file.name), Array.from({ length: 5 }, (_, index) => `b2-20261101_Part${index}.ASCII`));
  assert.deepEqual(sizes(outcome), [1_051_452, 1_055_374, 1_051_235, 1_054_714, 726_254]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    'a8d23b24bea03a66e6fb14839491752bba8f6c76a89a5de181e8372aa5cd41f7',
    '93a3ac082c897e20485f3a9c8ae1460c2d43363b9e6ca2b98324722c5f1815b5',
    '758dd2ff6b603553f5680f48875b2b5ec4ab8e6a49e032ef5aaa40fc250db13c',
    '572cc59ef50d0cc75eaba708f9aae51507ca5d9808dc2503f68a108b148907ce',
    '756b36c32b4ee97d1c06dfc9286e297a9f77527672e81c2940c1f4a327c5d742',
  ]);
  // The plain run's five parts are a different cut: the junk inside each part counts towards its
  // 1 MiB, so every part closes at a different record (1 051 261 / 1 055 491 / 1 051 236 /
  // 1 054 714 / 719 271 — the four parts that differ all moved).
  const plain = run('b2-20261101', { splitMode: 'size', splitSizeMb: 1 });
  assert.deepEqual(sizes(plain), [1_051_261, 1_055_491, 1_051_236, 1_054_714, 719_271]);
  // The parts are a partition of the interleaved stream: their concatenation is the unsplit file,
  // and the total is the plain total plus the capture's 7 056 unknown bytes.
  const spliced = run('b2-20261101', { unknownBytes: 'interleave' });
  const joined = Buffer.concat(outcome.files.map((file) => Buffer.from(file.bytes)));
  assert.equal(joined.length, spliced.files[0].bytes.length);
  assert.equal(Buffer.compare(joined, Buffer.from(spliced.files[0].bytes)), 0);
  assert.equal(sizes(outcome).reduce((sum, size) => sum + size, 0), 4_939_029);
});

test('b2: under a split, --unknown-bytes=file splices exactly like interleave (no sidecar)', () => {
  // Measured: `--limit-output-size=1 --unknown-bytes=file` writes the very same five parts and no
  // `.UNKNOWN`. The suite ignores SEPARATEFILE whenever a Part split is in play.
  const file = run('b2-20261101', { splitMode: 'size', splitSizeMb: 1, unknownBytes: 'file' });
  const interleaved = run('b2-20261101', { splitMode: 'size', splitSizeMb: 1, unknownBytes: 'interleave' });
  assert.deepEqual(file.files.map((entry) => entry.name), interleaved.files.map((entry) => entry.name));
  file.files.forEach((entry, index) => assert.equal(sha(entry.bytes), sha(interleaved.files[index].bytes)));
  assert.equal(file.files.some((entry) => entry.name.endsWith('.UNKNOWN')), false, 'no sidecar');
});

/* ---------------------------------------------------------------------------------------------
 * 3. --limit-output-duration: parts from the records, junk at the end of the earlier part
 * ------------------------------------------------------------------------------------------ */

test('b2: --limit-output-duration=5 + interleave is the suite\'s seven parts, byte for byte', () => {
  const outcome = run('b2-20261101', { splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave' });
  assert.deepEqual(outcome.files.map((file) => file.name), Array.from({ length: 7 }, (_, index) => `b2-20261101_Part${index}.ASCII`));
  assert.deepEqual(sizes(outcome), [573_318, 795_078, 781_441, 782_301, 781_840, 780_106, 444_945]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    '980e925da0ec44b67097992e50311026ec4ee4a5b0e3cc1bd60244ed5a7ec33f',
    '3939d0b777824da7f3821bda4688152db05c91f1eda01898aed67d3605024fd7',
    '43c2bc436a3a0030891018de0af157078835ba03f1272483db53528f6e3ff4f2',
    '8a20b05c1b1496c131202f318638a41ff3e5c1f51480831c0b6ad259492b52a5',
    'f8adbfaf1de215ce4eeee5f57c8c16f233ae5b10ab8c8403b2e3d451d8ffb6ce',
    '7bdd24688f4f5adfc48e681fa5eb6194302da723a6165f9e26da16fc69b496a3',
    '2fc0e6945092f7330be2336ac8313f28a908d53403bc1d18706b6d0fd660ea6b',
  ]);
  // Seven parts, not the plain run's eight: Part0 opens with the capture's leading junk, so it has
  // no anchor and starts its 5 s window at `577758.950` (the first record whose status is trusted),
  // not at the `ALMANAC`'s `577140.000`. Part0 therefore runs 577758.95 … 577763.95.
  const stampsOf = (bytes: Uint8Array) => latin1Text(bytes).split('\r\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => line.slice(1).split(/[,;]/)[6]);
  const part0 = stampsOf(outcome.files[0].bytes).filter((stamp) => Number(stamp) > 100);
  assert.equal(part0[0], '577758.950');
  assert.equal(part0[part0.length - 1], '577763.950');
  const plain = run('b2-20261101', { splitMode: 'time', splitSeconds: 5 });
  assert.equal(plain.files.length, 8, 'the plain run anchors on the almanac and splits into eight');
  assert.equal(plain.files[0].bytes.length, 12_758);
  // The parts still concatenate to the unsplit interleaved file.
  const spliced = run('b2-20261101', { unknownBytes: 'interleave' });
  const joined = Buffer.concat(outcome.files.map((file) => Buffer.from(file.bytes)));
  assert.equal(Buffer.compare(joined, Buffer.from(spliced.files[0].bytes)), 0);
});

test('a time part that opens on unknown bytes waits for a trusted status to anchor', () => {
  // Measured on the suite with synthetic captures: `[junk, 577140:SATTIME, 577145..577150:FINESTEERING]`
  // anchors at 577145 (so 577150 closes Part0), while the same capture without the leading junk
  // anchors at 577140 (so 577145 closes Part0).
  const b2Frames = captureOf('b2-20261101').frames;
  const bestpos = b2Frames.find((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 42);
  assert.ok(bestpos, 'b2 carries a BESTPOS payload');
  const record = (milliseconds: number, timeStatus: number) => {
    const head = buildLongHeader({
      messageId: 42,
      payloadLength: bestpos.payload.length,
      portAddress: 32,
      sequence: 1,
      idleTimeRaw: 0,
      timeStatus,
      week: 2442,
      milliseconds,
      receiverStatus: 0x03800800,
      reserved: 0xcdba,
      softwareVersion: 18278,
    });
    const body = new Uint8Array(head.length + bestpos.payload.length);
    body.set(bestpos.payload, head.length);
    body.set(head, 0);
    return appendCrcLe(body);
  };
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };
  const times: Array<[number, number]> = [
    [577_140_000, 200], [577_145_000, 180], [577_146_000, 180],
    [577_147_000, 180], [577_148_000, 180], [577_150_000, 180], [577_152_000, 180],
  ];
  const body = concat(...times.map(([milliseconds, status]) => record(milliseconds, status)));
  const junk = latin1('\r\n<OK\r\n[USB2]');
  const capture = concat(junk, body);
  /** Every record's seconds-of-week, wherever the record starts (junk can end mid-line). */
  const stamps = (bytes: Uint8Array) => {
    const text = latin1Text(bytes);
    const out: number[] = [];
    const pattern = /#([A-Z][A-Z0-9_]*),/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) out.push(Number(text.slice(match.index + 1).split(/[,;]/)[6]));
    return out;
  };

  const partsOf = (captureBytes: Uint8Array, unknownBytes: 'interleave' | 'ignore') => convertFrames(
    [...new SbfDeframer({ crcMode: 'validate' }).push(captureBytes)],
    {
      format: 'ASCII', at: AT, tables, name: 'probe.sbf', source: captureBytes,
      splitMode: 'time', splitSeconds: 5, unknownBytes,
    },
  ).files.map((file) => stamps(file.bytes));

  assert.deepEqual(partsOf(capture, 'interleave'), [
    [577_140, 577_145, 577_146, 577_147, 577_148, 577_150],
    [577_152],
  ]);
  // Without the leading junk the very same records anchor at 577140.
  assert.deepEqual(partsOf(body, 'ignore'), [
    [577_140, 577_145],
    [577_146, 577_147, 577_148, 577_150, 577_152],
  ]);
});

test('--limit-output-size counts the spliced bytes, so a junk run can close a part', () => {
  // The suite, on a synthetic capture of 13 BESTPOS records (214 B each) with a 13-byte run at the
  // top and an 8-byte run at the end, `--limit-output-size=0.001025` (1 074.8 B):
  //   plain       1 284 (6 records) / 1 284 (6) / 214 (1)
  //   interleave  1 083 (13 + 5 records) / 1 284 (6) / 436 (2 records + 8)
  const b2Frames = captureOf('b2-20261101').frames;
  const bestpos = b2Frames.find((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 42);
  assert.ok(bestpos);
  const record = (milliseconds: number) => {
    const head = buildLongHeader({
      messageId: 42, payloadLength: bestpos.payload.length, portAddress: 32, sequence: 1,
      idleTimeRaw: 0, timeStatus: 180, week: 2442, milliseconds,
      receiverStatus: 0x03800800, reserved: 0xcdba, softwareVersion: 18278,
    });
    const body = new Uint8Array(head.length + bestpos.payload.length);
    body.set(bestpos.payload, head.length);
    body.set(head, 0);
    return appendCrcLe(body);
  };
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };
  const records = Array.from({ length: 13 }, (_, index) => record(577_760_000 + index * 200));
  const body = concat(...records);
  const capture = concat(latin1('\r\n<OK\r\n[USB2]'), body, latin1('\r\n[USB2]'));
  const sizesOf = (captureBytes: Uint8Array, unknownBytes: 'interleave' | 'ignore') => convertFrames(
    [...new SbfDeframer({ crcMode: 'validate' }).push(captureBytes)],
    {
      format: 'ASCII', at: AT, tables, name: 'probe.sbf', source: captureBytes,
      splitMode: 'size', splitSizeMb: 0.001025, unknownBytes,
    },
  ).files.map((file) => file.bytes.length);

  assert.deepEqual(sizesOf(body, 'ignore'), [1_284, 1_284, 214]);
  assert.deepEqual(sizesOf(capture, 'interleave'), [1_083, 1_284, 436]);
});

/* ---------------------------------------------------------------------------------------------
 * 4. --daily-utc: the parts are the plain run's, with the junk spliced into them
 * ------------------------------------------------------------------------------------------ */

test('b7: --daily-utc + interleave is the suite\'s three parts, byte for byte', () => {
  const outcome = run('b7-20261101', { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(outcome.files.map((file) => file.name), [
    'b7-20261101_Part0.ASCII', 'b7-20261101_Part1.ASCII', 'b7-20261101_Part2.ASCII',
  ]);
  assert.deepEqual(sizes(outcome), [44_518, 5_161, 1_055_245]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    '3e669a68dc2c7f1b0f56094d740f37c032b0a3fef203b17ff199d153736a6781',
    'fd21de678a9d1b73d46d23eb700e5a221ddbe869d5c10b49315b93cb2b96fd6c',
    '51d0ba04e13056882cfaa5deca5ea6df3d751dfa91cb410238a8d5666b94715d',
  ]);
  // Same three parts as the plain run (40 933 / 5 161 / 1 054 895): the day clock reads records, so
  // the junk never moves a boundary — it is only spliced, and b7's 3 935 unknown bytes are spread
  // over Part0 (+3 585) and Part2 (+350); Part1 has none.
  const plain = run('b7-20261101', { splitMode: 'daily' });
  assert.deepEqual(sizes(plain), [40_933, 5_161, 1_054_895]);
  outcome.files.forEach((file, index) => {
    assert.ok(file.bytes.length >= plain.files[index].bytes.length);
  });
  assert.equal(sizes(outcome).reduce((sum, size) => sum + size, 0), 1_104_924);
});

test('b5: --daily-utc + interleave is the suite\'s two parts', () => {
  const outcome = run('b5-20261101', { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(sizes(outcome), [1_439_624, 4_915_874]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    'a73e4872eb4046f731e0591f9bbb8854ef087be0b0309c081f73fdf7ff9f1de8',
    '25a41e3c10535190a7db0fc358aec0aafad1d10db85d3c070be4783b3a6bb48f',
  ]);
  const plain = run('b5-20261101', { splitMode: 'daily' });
  assert.equal(sizes(outcome).reduce((sum, size) => sum + size, 0) - sizes(plain).reduce((sum, size) => sum + size, 0), 565);
});

test('b1: --daily-utc drops the unknown run before the first record (13 bytes)', () => {
  // The one place the suite *loses* unknown bytes, and it is reproduced rather than "fixed":
  // 5 094 255 = 5 088 882 (the plain part) + 5 386 (`.UNKNOWN`) − 13, the capture's opening
  // `\r\n<OK\r\n[USB2]`. `size` and `time` keep exactly those 13 bytes (they start their file with
  // them), `daily` does not.
  const outcome = run('b1-20261101', { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(outcome.files.map((file) => file.name), ['b1-20261101_Part0.ASCII']);
  assert.equal(outcome.files[0].bytes.length, 5_094_255);
  assert.equal(sha(outcome.files[0].bytes), 'bbf5cb116e0067272d25ad0cac0e6f72a39ccf99fa8a6c5f1d348b6f3958c273');
  assert.equal(outcome.unknown.length, 5_386);
  const plain = run('b1-20261101', { splitMode: 'daily' });
  assert.equal(plain.files[0].bytes.length, 5_088_882);
  assert.equal(outcome.files[0].bytes.length - plain.files[0].bytes.length, 5_373);
  // …and the part now opens with a record, not with the capture's junk.
  assert.equal(latin1Text(outcome.files[0].bytes).startsWith('\r\n<OK'), false);
});

test('--daily-utc with --unknown-bytes=file splices as well and writes no sidecar', () => {
  const file = run('b7-20261101', { splitMode: 'daily', unknownBytes: 'file' });
  const interleaved = run('b7-20261101', { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(sizes(file), sizes(interleaved));
  file.files.forEach((entry, index) => assert.equal(sha(entry.bytes), sha(interleaved.files[index].bytes)));
  assert.equal(file.files.some((entry) => entry.name.endsWith('.UNKNOWN')), false);
});

/* ---------------------------------------------------------------------------------------------
 * 5. The other two formats, under a Part split
 * ------------------------------------------------------------------------------------------ */

test('b2: --abbrev --limit-output-size=1 + interleave is the suite\'s six parts', () => {
  const outcome = run('b2-20261101', {
    format: 'ABBREV_ASCII', splitMode: 'size', splitSizeMb: 1, unknownBytes: 'interleave',
  });
  assert.deepEqual(sizes(outcome), [1_048_595, 1_053_322, 1_054_462, 1_054_335, 1_052_900, 467_255]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    '290eeadf6329e4e0d1c695d1bfaa2b379a8f40f9be105b2ee1cf4d8e6fbc5fbf',
    '6004b0ac08b8de2b9dc7a6813e639a21bc9ef4c53323037c3222d120ff352942',
    '02c70defc1adc5af55e579e1e355f5dac0380ff9860a7ab351d81ae55f7f1845',
    '6d4ad21c0e8703acbada2d6b4ead3fc0794d7b1549a1846462df6b45c39f0efd',
    'cb38747ecfc24a7eb28f40ffd6e87ee266e621e38b40e37a26c6eae6fc260681',
    '89ce214684fbb64e67a8d745336b7738a036ba669a554f058d4fd2378be18c9a',
  ]);
});

test('b2: -b --limit-output-duration=5 + interleave is the suite\'s seven parts', () => {
  const outcome = run('b2-20261101', {
    format: 'BINARY', splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave',
  });
  assert.deepEqual(sizes(outcome), [321_188, 440_324, 433_416, 432_992, 433_550, 431_920, 247_004]);
  assert.deepEqual(outcome.files.map((file) => sha(file.bytes)), [
    '8245f3e8f7ef97392c15e9f2a793dbdabb4b0428cf58e99a7b889907d6ac7995',
    '7fdc419edd25271d9dd094dd4f0e30a74f1613618d9b8f45c61225bfb4512aac',
    '9dda9a82c6b360cdf91862257f2623643729d788d6489ff0de3a268f1d8a1d1d',
    '2abe3ebb00698c83f107b48e1beed2aa7aee128010a2d60ad152738eb142c49c',
    '760fc846cefddd29cc0d619ba7c60abcd50d28810e60ab6aa02c1e80b37f935a',
    '88ae10f921466e4dd38ba2fa85ec359e83b4a72f5dd10b0b48791233915220c2',
    '784c4c378a1093ebeb793219f4c242d6509c600229c00ca9c32566ea49eb9a81',
  ]);
  // BINARY splices the raw bytes too: the seven parts total the plain `-b` file plus b2's 7 056.
  const plain = run('b2-20261101', { format: 'BINARY', splitMode: 'time', splitSeconds: 5 });
  assert.equal(sizes(outcome).reduce((sum, size) => sum + size, 0),
    sizes(plain).reduce((sum, size) => sum + size, 0) + 7_056);
});
