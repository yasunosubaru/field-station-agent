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
 *
 * Sections 6–8 (2026-11-02) close the three evidence gaps this file left open: which records can
 * anchor a `time` part (80/100/160 and text records), what `--daily-utc` does with *several* junk
 * runs before the first record that prints, and `--split` + interleave on b2/b5/b7 rather than b1
 * alone. They were measured with `逆向/tools/probe-time-anchor.ts`,
 * `probe-daily-leading-junk.ts` and `probe-split-interleave.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendCrcLe, crcHex, novatelCrc32 } from '../src/crc.ts';
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

/* ---------------------------------------------------------------------------------------------
 * 6. --limit-output-duration: which records can anchor a part (gap E7-1)
 *
 * `partitionPieces` starts a part's window at a record in two situations only: the record is the
 * part's **first piece** (nothing spliced in front of it), or its time status is "trusted". b2
 * measured one of each (COARSESTEERING 120 after the leading junk; the almanac's SATTIME 200 as the
 * very first piece). The rest was unmeasured, so `逆向/tools/probe-time-anchor.ts` ran the suite on
 * every capture below (`-a --limit-output-duration=5 --unknown-bytes=interleave`, 21 cases) and
 * diffed each part byte for byte — all identical, which is what these tests pin:
 *
 *   junk + record@577140:<status> + 577145…577152:FINESTEERING     --limit-output-duration=5
 *     80 / 100 / 160 / 180 → anchors on 577140   → [577140, 577145] [577146 … 577152]
 *     20 / 60 / 200        → no anchor, waits    → [577140 … 577150] [577152]
 *
 *   junk + #BESTPOSA@577140:<status> (a text record) + the same records
 *     COARSESTEERING (60) / FINE / FINESTEERING → anchors (the text gate is one status wider)
 *     UNKNOWN / APPROXIMATE / SATTIME           → no anchor
 *
 *   junk + binary 200 + a COARSESTEERING *text* record at 577143 + the same records
 *     → the clock waits past the untrusted frame and anchors on the text record (577143)
 * ------------------------------------------------------------------------------------------ */

/** Concatenate capture pieces into one capture buffer. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** b2's own BESTPOS payload: a record whose line always renders, whatever the header says. */
let bestposPayloadCache: Uint8Array | undefined;
function bestposPayload(): Uint8Array {
  if (bestposPayloadCache === undefined) {
    const found = captureOf('b2-20261101').frames.find(
      (entry): entry is SbfFrame => entry.kind === 'sbf' && entry.header.messageId === 42);
    assert.ok(found, 'b2 carries a BESTPOS payload');
    bestposPayloadCache = found.payload;
  }
  return bestposPayloadCache;
}

/** A BESTPOS frame at `milliseconds` of week 2442 with a chosen time status. */
function binaryRecord(milliseconds: number, timeStatus: number): Uint8Array {
  const payload = bestposPayload();
  const head = buildLongHeader({
    messageId: 42, payloadLength: payload.length, portAddress: 32, sequence: 1, idleTimeRaw: 0,
    timeStatus, week: 2442, milliseconds,
    receiverStatus: 0x03800800, reserved: 0xcdba, softwareVersion: 18278,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return appendCrcLe(body);
}

const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** b1's `#BESTPOSA` body — a canonical message the parser renders. */
const BESTPOS_BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,'
  + '1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';

/** A `#BESTPOSA` text record with its own header time (its CRC covers the sentence after `#`). */
function textRecord(milliseconds: number, status: string): Uint8Array {
  const sentence = `BESTPOSA,USB2,0,72.0,${status},2442,${(milliseconds / 1000).toFixed(3)},`
    + `03801800,cdba,18278;${BESTPOS_BODY}`;
  return bytesOf(`#${sentence}*${crcHex(novatelCrc32(bytesOf(sentence)))}\r\n`);
}

/**
 * A text record the suite **parses by name but writes nothing for**: an `#RXCONFIGA` whose embedded
 * message (`BOGUS`) is not in the dictionary — b7's 22 silent records. Its bytes end up in the
 * unknown stream, not in the converted output.
 */
function silentRecord(milliseconds: number): Uint8Array {
  const inner = `BOGUS,USB2,0,72.0,FINESTEERING,2442,${(milliseconds / 1000).toFixed(3)},`
    + '03801800,cdba,18278;ALPHA,BETA';
  const sentence = `RXCONFIGA,USB2,0,72.0,FINESTEERING,2442,${(milliseconds / 1000).toFixed(3)},`
    + `03801800,cdba,18278;#${inner}*00000000`;
  return bytesOf(`#${sentence}*${crcHex(novatelCrc32(bytesOf(sentence)))}\r\n`);
}

function convertBytes(source: Uint8Array, options: Partial<ConvertOptions> = {}): ConvertOutcome {
  return convertFrames([...new SbfDeframer({ crcMode: 'validate' }).push(source)], {
    format: 'ASCII', at: AT, tables, name: 'probe.sbf', source, ...options,
  });
}

/**
 * The seconds-of-week of every record a part holds, in order. A part that opens on unknown bytes has
 * the junk glued to the first record's line, so the records are found by their `#NAME,` marker, not
 * by line starts (the same way `probe-time-anchor.ts` does it).
 */
const partStamps = (bytes: Uint8Array): number[] => {
  const text = latin1Text(bytes);
  const out: number[] = [];
  const pattern = /#([A-Z][A-Z0-9_]*),/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) out.push(Number(text.slice(match.index + 1).split(/[,;]/)[6]));
  return out;
};

const TAIL = [577_145, 577_146, 577_147, 577_148, 577_150, 577_152];

test('a time part that opens on junk anchors on 80 / 100 / 160, and not on 20 / 60 / 200', () => {
  const captureFor = (status: number) => concatBytes(
    bytesOf('\r\n<OK\r\n[USB2]'),
    binaryRecord(577_140_000, status),
    ...TAIL.map((seconds) => binaryRecord(seconds * 1000, 180)),
  );
  const partsOf = (status: number) => convertBytes(captureFor(status), {
    splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave',
  });

  // The suite's own parts, digest for digest (`probe-time-anchor.ts`, 2026-11-02).
  const TRUSTED: Array<[number, number[], string[]]> = [
    [80, [444, 1_070], [
      'e85db8bcddbf435b89d4496e76873892d61d768aaef972b333269eca72992f31',
      'dee32ab0273a4baf7441589c89d4b980566fa1323e9ad46a0b1d49fa45199a44',
    ]],
    [100, [435, 1_070], [
      'd79bb8b2b788d76afe18c0a28f5567afea97637fcfc3b8aceb72885ee5c2205e',
      'dee32ab0273a4baf7441589c89d4b980566fa1323e9ad46a0b1d49fa45199a44',
    ]],
    [160, [433, 1_070], [
      '4fbcd7eac90f9198645bbcb0cdaddf96c79b39afac1e30a68cca4707a43828d5',
      'dee32ab0273a4baf7441589c89d4b980566fa1323e9ad46a0b1d49fa45199a44',
    ]],
  ];
  for (const [status, expectedSizes, digests] of TRUSTED) {
    const parts = partsOf(status);
    assert.deepEqual(sizes(parts), expectedSizes, `status ${status}`);
    assert.deepEqual(parts.files.map((file) => sha(file.bytes)), digests, `status ${status}`);
    // The anchor is 577140: the record at the window's end (577145) closes Part0.
    assert.deepEqual(parts.files.map((file) => partStamps(file.bytes)),
      [[577_140, 577_145], [577_146, 577_147, 577_148, 577_150, 577_152]], `status ${status}`);
  }

  // Untrusted statuses do not start the clock; it waits for the first FINESTEERING record.
  const UNTRUSTED: Array<[number, number[], string[]]> = [
    [20, [1_292, 214], [
      '9d6db30da8770522119685c52aee37215470f6419b458b9b4f9fff7cf1f81292',
      '88a9d69236f1813fdf9c31d1811c843ddf4da23e57bbd509566a9f4e2da28418',
    ]],
    [60, [1_296, 214], [
      'b0965743fd6f23906284e6e281ebc1099a879ca51c2c590193bbc07693551575',
      '88a9d69236f1813fdf9c31d1811c843ddf4da23e57bbd509566a9f4e2da28418',
    ]],
    [200, [1_292, 214], [
      'a26ffeb9bce355fdbd5fc83a76c491d609e2086fdc81ec54810c42299a6cc9b0',
      '88a9d69236f1813fdf9c31d1811c843ddf4da23e57bbd509566a9f4e2da28418',
    ]],
  ];
  for (const [status, expectedSizes, digests] of UNTRUSTED) {
    const parts = partsOf(status);
    assert.deepEqual(sizes(parts), expectedSizes, `status ${status}`);
    assert.deepEqual(parts.files.map((file) => sha(file.bytes)), digests, `status ${status}`);
    assert.deepEqual(partStamps(parts.files[1].bytes), [577_152], `status ${status}`);
  }

  // A record with no junk in front of it anchors whatever its status: the very same 80/100/160
  // captures without the leading run lose the junk (and one 13-byte part) but keep the same cut.
  const BARE: Array<[number, number]> = [[80, 431], [100, 422], [160, 420]];
  for (const [status, firstPart] of BARE) {
    const bare = convertBytes(concatBytes(
      binaryRecord(577_140_000, status),
      ...TAIL.map((seconds) => binaryRecord(seconds * 1000, 180)),
    ), { splitMode: 'time', splitSeconds: 5 });
    assert.deepEqual(sizes(bare), [firstPart, 1_070], `status ${status}`);
    assert.deepEqual(partStamps(bare.files[0].bytes), [577_140, 577_145], `status ${status}`);
  }
});

test('a time part that opens on junk anchors on a text record by its own (wider) status set', () => {
  // The identical `COARSESTEERING` stamp as a *binary* frame does not anchor (see above); as a text
  // record it does. `FINE` (80 in the text table) anchors too; `UNKNOWN` and `SATTIME` never do.
  const captureFor = (status: string) => concatBytes(
    bytesOf('\r\n<OK\r\n[USB2]'),
    textRecord(577_140_000, status),
    ...TAIL.map((seconds) => binaryRecord(seconds * 1000, 180)),
  );
  const partsOf = (status: string) => convertBytes(captureFor(status), {
    splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave',
  });

  const ANCHORED: Array<[string, number[], string[]]> = [
    ['COARSESTEERING', [444, 1_070], [
      '288025ce7e8876779fd32bd459d47e056fd065fbeef665fd37d281a0e9aaf417',
      'dee32ab0273a4baf7441589c89d4b980566fa1323e9ad46a0b1d49fa45199a44',
    ]],
    ['FINE', [434, 1_070], [
      '4994dc410f877b158797d55f7c19b021eba3a245d5cfa502db33c6f06d926be7',
      'dee32ab0273a4baf7441589c89d4b980566fa1323e9ad46a0b1d49fa45199a44',
    ]],
  ];
  for (const [status, expectedSizes, digests] of ANCHORED) {
    const parts = partsOf(status);
    assert.deepEqual(sizes(parts), expectedSizes, status);
    assert.deepEqual(parts.files.map((file) => sha(file.bytes)), digests, status);
    assert.deepEqual(partStamps(parts.files[0].bytes), [577_140, 577_145], status);
  }

  // The text gate rejects these three: the equal-length `UNKNOWN` and `SATTIME` names both make a
  // 1 293-byte part, `APPROXIMATE` four bytes longer, and the second part always opens on 577152.
  const UNTRUSTED_TEXT: Array<[string, number, string]> = [
    ['UNKNOWN', 1_293, 'a67c87256c5133b1114e8d0d1ca8139bf3874fc5583d1b7215f0fa60b9a8c3fa'],
    ['APPROXIMATE', 1_297, 'c3c25e05ff2fd4899bc1d9e63fab04b90d97303e9dffceaa9c766f9a5d1b664d'],
    ['SATTIME', 1_293, '9e2183a783fffee78dd639ca7ab46c9e376bc3620551bcf0f7d30b98f1b5f465'],
  ];
  for (const [status, firstPart, digest] of UNTRUSTED_TEXT) {
    const parts = partsOf(status);
    assert.deepEqual(sizes(parts), [firstPart, 214], status);
    assert.equal(sha(parts.files[0].bytes), digest, status);
    assert.deepEqual(partStamps(parts.files[1].bytes), [577_152], status);
  }

  // Untrusted records in between: the clock skips the frame at 577140 (SATTIME) and anchors on the
  // COARSESTEERING text record at 577143, so the cut moves with it.
  const mixed = convertBytes(concatBytes(
    bytesOf('\r\n<OK\r\n[USB2]'),
    binaryRecord(577_140_000, 200),
    textRecord(577_143_000, 'COARSESTEERING'),
    ...TAIL.map((seconds) => binaryRecord(seconds * 1000, 180)),
  ), { splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave' });
  assert.deepEqual(sizes(mixed), [1_295, 428]);
  assert.deepEqual(mixed.files.map((file) => sha(file.bytes)), [
    '92d8c5263ac25a0764537aea36cb4f86d85e8db16a5d69e5bdce9a3ffabd3597',
    '7eb26e7b5468b22bd7cca50b6be1941c88d9a775951ec4163427fade6849899c',
  ]);
  assert.deepEqual(partStamps(mixed.files[0].bytes), [577_140, 577_143, 577_145, 577_146, 577_147, 577_148]);
  assert.deepEqual(partStamps(mixed.files[1].bytes), [577_150, 577_152]);

  // No trusted record at all: the clock never starts, so the whole capture is one part.
  const never = convertBytes(concatBytes(
    bytesOf('\r\n<OK\r\n[USB2]'),
    binaryRecord(577_140_000, 200), binaryRecord(577_143_000, 60), binaryRecord(577_150_000, 20),
  ), { splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave' });
  assert.deepEqual(sizes(never), [644]);
  assert.equal(sha(never.files[0].bytes), '64545719b4428768332fa56e9e238662ae26cbec3422e8c3dfdfeffb39c75db9');
});

/* ---------------------------------------------------------------------------------------------
 * 7. --daily-utc and the unknown runs **before the first record** (gap E7-2)
 *
 * b1 measured one shape: a single 13-byte run (`\r\n<OK\r\n[USB2]`) before the first record, which
 * `--daily-utc` drops (5 094 255 = 5 088 882 + 5 386 − 13). "Several runs with a record that prints
 * nothing in between" was an inference, and two rules fit it equally well:
 *
 *   A. drop **every piece before the first block that writes bytes** (what `assembleFiles` does);
 *   B. drop only what precedes the first record the **pre-scan** parses (then a silent record and
 *      the junk behind it would stay).
 *
 * `逆向/tools/probe-daily-leading-junk.ts` separates them: with the silent `#RXCONFIGA` at offset 0
 * (no leading junk at all) rule B keeps 191 bytes and rule A keeps none. The suite writes 428 bytes
 * = the two BESTPOS lines, so **A** is the rule, and the *merged* run (junk + silent record + junk)
 * goes in one piece. The same bytes under `--limit-output-duration` keep the run: the loss is
 * `--daily-utc`-only.
 * ------------------------------------------------------------------------------------------ */

test('--daily-utc drops every unknown run before the first record that prints, not just the first', () => {
  const junkA = '\r\n<OK\r\n[USB2]'; // b1's own 13-byte opening run
  const junkB = '\r\n[USB2]'; // 8 bytes
  const records = [binaryRecord(577_759_000, 180), binaryRecord(577_760_000, 180)];
  const DAILY = 'd8185f2a9116a1f41fb33d4bf18695aadc8385c0278ee8ca76cc38e69efeb506';

  const daily = (source: Uint8Array) => convertBytes(source, { splitMode: 'daily', unknownBytes: 'interleave' });

  // junk + silent record + junk: everything in front of 577759 goes.
  const oneSilent = daily(concatBytes(bytesOf(junkA), silentRecord(577_700_000), bytesOf(junkB), ...records));
  assert.deepEqual(sizes(oneSilent), [428]);
  assert.equal(sha(oneSilent.files[0].bytes), DAILY);
  assert.equal(latin1Text(oneSilent.files[0].bytes).startsWith('#BESTPOSA,COM1'), true);
  assert.equal(latin1Text(oneSilent.files[0].bytes).includes('RXCONFIGA'), false, 'the silent record is gone');

  // No leading junk: the silent record *is* the first bytes of the file — still dropped.
  const silentAtZero = daily(concatBytes(silentRecord(577_700_000), bytesOf(junkB), ...records));
  assert.deepEqual(sizes(silentAtZero), [428]);
  assert.equal(sha(silentAtZero.files[0].bytes), DAILY);

  // A longer chain — junk, silent, junk, silent, junk — loses all of it, not just the first run.
  const twoSilent = daily(concatBytes(
    bytesOf(junkA), silentRecord(577_700_000), bytesOf(junkB), silentRecord(577_701_000), bytesOf('\r\n<OK\r\n[USB2]\r\n'),
    ...records,
  ));
  assert.deepEqual(sizes(twoSilent), [428]);
  assert.equal(sha(twoSilent.files[0].bytes), DAILY);

  // The reported unknown stream is untouched by the drop (191 B here: 13 + 170 + 8): the rule
  // loses bytes from the *file*, not from the count.
  assert.equal(oneSilent.unknown.length, 191);
  assert.equal(sha(oneSilent.unknown), '5b6b7c536d2fc6db2d1777c27baaeaaf7dfefbc07947e86ce1a52a6a553fabc8');

  // The contrast: the very same bytes under `--limit-output-duration=5` keep the run, so this is a
  // `--daily-utc` rule and not "unknown bytes are never written before a record".
  const asTime = convertBytes(
    concatBytes(silentRecord(577_700_000), bytesOf(junkB), ...records),
    { splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave' },
  );
  assert.deepEqual(sizes(asTime), [606]);
  assert.equal(sha(asTime.files[0].bytes), '0f7631a8b6ca0c8aa3894c84b0d4fd30560deacc3d38624747d8a9d736463a8c');
  assert.equal(latin1Text(asTime.files[0].bytes).startsWith('#RXCONFIGA'), true, 'the record is spliced raw');
});

test('--daily-utc keeps the junk that comes after the first record, silent records included', () => {
  // Control: with a record in front, the junk and the silent record in the middle are untouched
  // (both candidate rules agree here, and the suite's 613-byte part proves it).
  const middle = convertBytes(concatBytes(
    binaryRecord(577_759_000, 180),
    bytesOf('\r\n[USB2]'), silentRecord(577_761_000), bytesOf('\r\n<OK\r\n'),
    binaryRecord(577_762_000, 180),
  ), { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(sizes(middle), [613]);
  assert.equal(sha(middle.files[0].bytes), '88429eb193f5d06e8c27fc04f5501cf10e1c442376385f3c7ee09c89eec52faa');
  assert.equal(latin1Text(middle.files[0].bytes).includes('RXCONFIGA'), true);

  // b1's own shape, reproduced on synthetic bytes: 13 bytes of junk before the first (text) record.
  const text = bytesOf((() => {
    const sentence = `BESTPOSA,USB2,0,72.0,FINESTEERING,2442,577759.000,03801800,cdba,18278;${BESTPOS_BODY}`;
    return `#${sentence}*${crcHex(novatelCrc32(bytesOf(sentence)))}\r\n`;
  })());
  const beforeText = convertBytes(concatBytes(
    bytesOf('\r\n<OK\r\n[USB2]'), text, binaryRecord(577_760_000, 180),
  ), { splitMode: 'daily', unknownBytes: 'interleave' });
  assert.deepEqual(sizes(beforeText), [429]);
  assert.equal(sha(beforeText.files[0].bytes), '6505f4f4224982a2f17a07825b5d1d41579e189cdd5b3b50e8ba554e5551906d');
  assert.equal(latin1Text(beforeText.files[0].bytes).startsWith('#BESTPOSA,USB2'), true);
});

/* ---------------------------------------------------------------------------------------------
 * 8. --split + interleave on b2 / b5 / b7 (gap E7-3)
 *
 * The "`--split` never splices, the junk goes to one sidecar" rule was measured on b1 only. These
 * are the other three captures — 7 056 / 565 / 3 935 unknown bytes — every file the suite writes,
 * with its size and SHA-256 (`逆向/tools/probe-split-interleave.ts`, ASCII/ABBREV/BINARY, all 64
 * files identical to ours; the tables below are the ASCII run).
 * ------------------------------------------------------------------------------------------ */

/** [log name (`UNKNOWN` for the sidecar), bytes, sha256] for every file of the ASCII split run. */
const SPLIT_INTERLEAVE_FILES: Record<string, Array<[string, number, string]>> = {
  'b2-20261101': [
    ['ALMANAC', 5_776, 'd7cce305809f6f640b16ea25fca06877c6b68e377edcee58861bfea14562c19f'],
    ['BESTGNSSPOS', 224, 'ee6af3c6d44327a95023c2d44dfb2058933f6f70d3e0194c5b3a04e83e3674ea'],
    ['BESTGNSSVEL', 4_836, '41199a257df103e90d74a9e07ef9772b84934b84c75aa1ce9325043bbb8e1091'],
    ['BESTPOS', 7_136, '9729db3e661240ebc8bd19de05cc3b5bc1b483095f70583f324d82226a374033'],
    ['BESTUTM', 218, '15ad01ac5776edccdb5f6ab2a75d83abb42215c2d92190bed4a352bea38d23ff'],
    ['CLOCKMODEL', 323, 'f6e8d9ef6940e7ec0e4023eca8240d721f59e99dd3ada8bbc4d5199b24d5fcb2'],
    ['ETHSTATUS', 126, '1948f4e45cae7c3c0b23725cb0186684570c8fd9bcec3726c3caf674e06abfb3'],
    ['GLORAWALM', 1_448, '10a02dcefc3d1837180c864d8a3b0f6dffaf310b3dae168b5a5b1d7cb1776bcd'],
    ['HWMONITOR', 1_224, '3b9eb5edd977a11fbae06266167296a672b4d12984231d535407292daba4222a'],
    ['IPSTATUS', 155, 'a0ea746e0087649b5eaa43cd6bd586c05950a7a7d5e3b45529dcab0b394b9539'],
    ['MARKPOS', 6_789, '1b6187166cd081211df99f686dfb65c5ae4f23c0418b8058b2117da8d647c165'],
    ['PORTSTATS', 3_588, 'f1594f76ce822024174b8d613f86304de281bd2303189211ae2cde9c3ea5d046'],
    ['PPPXYZ', 3_795, '3102db6737c32cb6fc99fb5928e9d66925f3e3bc854d20c78aa5ff13564ee5c0'],
    ['PSRPOS', 6_510, '2af44aba94b114d19326d3535bdcdb91fc063d2081554f73d9eb6546ffbc2f55'],
    ['PSRXYZ', 8_444, '988ee9b57f43b1ea0ffb88f68d74afc480f77847c9ec55519806ee3c065c507b'],
    ['RAIMSTATUS', 864, 'efa948b7088bc6c4c5945d7510d19240b4d16f4165dd4a2d62205a441f94f2bc'],
    ['RANGE', 4_873_633, '48a2c739c72e29b4106c8e3e83e84ba1c4929b5a8e7b02898a34963d39486b62'],
    ['RAWALM', 2_392, '9c148178ea46e699de33e1e6c0d7e817fee0eced8426d692c8a1f0ec4eded7b2'],
    ['RAWEPHEM', 3_649, '3bb6fbf421e45fe0d36352b44b519b2516c1bfc440d0376ba58307e74a6150dc'],
    ['RXSTATUS', 843, '520bca2d560fc2af3f142574176c89711f9ee45217a92cca29e8a6fed15ba183'],
    ['UNKNOWN', 7_056, '6765898e250251bd223ee65617c17b0d1f76bc3af670ae33b638054c3fc6ae38'],
  ],
  'b5-20261101': [
    ['BDSBCNAV3RAWMESSAGE2', 1_948, '5e2e970691411857aab7abd11ec40ff15b3be373ec459c0733c100b483e2a2f7'],
    ['BESTDATUMINFO', 114, '1f1039da4aee731c80ab110d52b8f92711a7486d6cde79fadc7a7fb368a7cdc3'],
    ['BESTGNSSDATUMINFO', 118, 'dfa0ac14542ed8ecddbbd076e244e5077cbb8cc032abb3e678f351913263a8f0'],
    ['BESTPOS', 11_544, '5286319be0de098a8474cb753cb8117b3cf803f971b873506dcd57ed447d511f'],
    ['CHANCONFIGLIST', 450, '69dcf07e623e2bed794f5b5ac83be65e597e512a7d76adeaa349b970bc10e451'],
    ['CLOCKSTEERING', 176, '5a2f8f57f2c14e3de3e30f4a265e25b753d0be39e954f95f0d8b33557623b926'],
    ['COMCONFIG', 223, '402df975b1645aeaf66c76f0db39758189e6c0f01d3dd519d546b9448f90a5b4'],
    ['DATUMTRANSFORMATIONS', 3_699, '9958a2e2b3cebbb10bb3f97ec4d2b9d958d29cf9877e4dd258ffd7e566bbee9c'],
    ['GALINAVRAWEPHEMERIS', 68_072, 'ee7be1777d1e36ef76f7d1b2022ad079e2267050df103465e5deeb6adb6efe71'],
    ['GEODETICDATUMS', 955, '4087410fcfd651c0252a1ff36e237aafb616d8c1fc840e7c0d15fb40f6193404'],
    ['HWMONITOR', 1_525, '9abda33239557afdc269dd468fe0e84f39f5bec2a05aa254104abc75aee7cb8e'],
    ['PASSTHROUGH', 364, 'ec8c65a2bb711d15f1182af925c07f381680a6af7a740c69b3debe13d1d7ca17'],
    ['PDPPOS', 1_899, 'f440841c222706ed6b5bc94b455f2e240a42637914f62e9dd6d8692c62e14536'],
    ['PDPSATS', 6_768, '13963001af4869a4bc62900daefd43be5f9b42c85935302c65077a3c48baa5f5'],
    ['PDPVEL', 1_287, 'f42e8e9b5442b0f0ccf6160bf5f3e23b66e4a69aeb2845137226bb1e6fd25ec8'],
    ['PDPXYZ', 2_277, '415433086a273a84b91dbd53f514f48bbc4fd75bb80c87b0b9c6fa61593d93eb'],
    ['PORTSTATS', 4_500, 'ec27a59023aa1646ac2a89bd9dd6968634beace8c200efe4d7770b3056fad7aa'],
    ['PSRDATUMINFO', 113, 'd1259b790849a8cbeb298d6bbe5bdc99c0f89fb34a0bb6fe8db67a7f913e6af5'],
    ['RANGE', 6_233_639, '40ab4eeb2f5adec8d0b354f8faefbf80843b1525ec700a613281760542d95bbd'],
    ['RANGEGPSL1', 9_672, '06ecf317636cfb52e90fbc5046778e0c3a501891ce1c48a8c160b3b131e3380a'],
    ['RAWEPHEM', 4_462, '3d1aa9bbdce27294d27512f592376f5c05935ecb5bfd14fa2616b4c8bc88a2f5'],
    ['RXSTATUS', 560, '821c5e68686004b5ec07d790602503bde2e42d2823a8cac73d578afa90984ae9'],
    ['RXSTATUSEVENT', 274, '0fe433dd4f73399a32dee2da298ba277341eafd38892ccf40ec16faa4920606b'],
    ['SOFTLOADSTATUS', 90, '573cc17bde93a9f50d97552936e995f7efcd5365740cb02e988f6eb183582b2d'],
    ['VALIDMODELS', 95, 'a633a2ca2193d18cb6af9f93be5145524c5abe3571788f423769de1b22b604c8'],
    ['VERIPOSSTATUS', 109, '0cc47235249a9e8f5b50aba96983d27f44de73ca9153af577e455450a33ecaf8'],
    ['UNKNOWN', 565, 'f2e0f6507ce71e4ef4bd8b8ce03da17bdd0e5f846988e147942c8cfdb66bc3e8'],
  ],
  'b7-20261101': [
    ['BESTPOS', 13_764, '49cf4d9dd6fe7fd9e17c36fdb9c6e6640a32bf65c27847c01b1489414181bfce'],
    ['CHANCONFIGLIST', 450, 'a7c673cb835c51379ea31ff91278d51da074e7d879b5f361893cbba46df30c66'],
    ['HWMONITOR', 1_830, '581fcd2bf9434628a8f211181bfca03000056454808714cfe5bace7fdb659442'],
    ['ITDETECTCONFIG', 102, 'b1d921181abebd5e6fb779c9be7a2d7f9de9dbfb645283936b3da9a67e188825'],
    ['ITDETECTSTATUS', 7_091, 'daedd036b4b57824e58a7916e30e2d9db22baca7b75b36e56fefce2e41c5dfe9'],
    ['ITPSDDETECT', 379_215, '2cf7c3cc30c72dda0e41d7f8bf91995d5da2ef349b378ee652beb0528cde19fe'],
    ['ITPSDFINAL', 282_026, 'fa37e04f62bbcb464992be1fe3d8679b377808ef573950e233ce4b9cabf78041'],
    ['ITSPECTRALANALYSIS', 113, '8250f32d9c6a7d8f4a762a288311308792b6146376afb81c99973eb11d1d719d'],
    ['ITWARNINGCONFIG', 97, '07e75195e424838316a1a06fdbb10b8758cd6847fdedf79bb902034a783faa96'],
    ['PORTSTATS', 5_418, 'ecf42d8d4e339ffbd8119f98f58b39556d9e4629493d010092f1f1d6a929974b'],
    ['RANGE', 263_956, 'f4e02b7d3b9a850de74291037f27eedf974282673b21b1bc3b842055c4934e99'],
    ['RAWEPHEM', 5_010, 'f34f051fce657353affb6d060da8a719dd7fd8414101f494249cb956f99adcca'],
    ['RXCONFIG', 43_349, '6bb1b4115f3cdfc03722f9d502eb2843a97ea7752dea0430ea2d5da17a8ce5b0'],
    ['RXSTATUS', 7_280, 'ff1b672097bbec1aef17e4c5d4922120ba43118d1925a2f1b68d78764712b2c4'],
    ['TRACKSTAT', 91_288, '1aba806b5eaaf8f6c9555d708d43c1e4f0400d0427973cffdf6800da7e75f7aa'],
    ['UNKNOWN', 3_935, '4ce1e637bb4d695d8cac655ca937d81a7dff451e505c557d99a0cc0a52d1d511'],
  ],
};

for (const [captureName, expected] of Object.entries(SPLIT_INTERLEAVE_FILES)) {
  test(`${captureName}: --split + interleave is the suite's ${expected.length} files, byte for byte`, () => {
    const outcome = run(captureName, { splitMode: 'logs', unknownBytes: 'interleave' });
    assert.deepEqual(outcome.files.map((file) => file.name),
      expected.map(([log]) => `${captureName}_${log}.ASCII`));
    outcome.files.forEach((file, index) => {
      const [log, bytes, digest] = expected[index];
      assert.equal(file.bytes.length, bytes, `${log} bytes`);
      assert.equal(sha(file.bytes), digest, `${log} digest`);
    });
    // No combined file, and the sidecar is the unknown stream itself.
    assert.equal(outcome.files.some((file) => file.name === `${captureName}.ASCII`), false);
    const sidecar = expected.find(([log]) => log === 'UNKNOWN')!;
    assert.equal(outcome.unknown.length, sidecar[1]);

    // `file` writes the same sidecar, `ignore` writes none, and neither touches the per-log files.
    const file = run(captureName, { splitMode: 'logs', unknownBytes: 'file' });
    const ignore = run(captureName, { splitMode: 'logs', unknownBytes: 'ignore' });
    const plain = run(captureName, { splitMode: 'logs' });
    const logs = (result: ConvertOutcome) => result.files.filter((entry) => !entry.name.includes('_UNKNOWN.'));
    for (const other of [file, ignore]) {
      assert.deepEqual(logs(other).map((entry) => entry.name), logs(plain).map((entry) => entry.name));
      logs(other).forEach((entry, index) => {
        assert.equal(sha(entry.bytes), sha(logs(plain)[index].bytes), `${entry.name}`);
      });
    }
    const fileSidecar = file.files.find((entry) => entry.name === `${captureName}_UNKNOWN.ASCII`);
    assert.ok(fileSidecar, '`file` writes the sidecar under the split name');
    assert.equal(sha(fileSidecar.bytes), sidecar[2]);
    assert.equal(ignore.files.length, expected.length - 1, '`ignore` adds no sidecar');
  });
}
