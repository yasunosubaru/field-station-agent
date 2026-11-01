/**
 * The Output Settings that live **below** the page: how `convertFrames` applies the Time Interval
 * and the Prefix/Suffix, and what `decimate` does at the two fractional intervals the GUI produces.
 *
 * Everything here is measured against the installed 2.11.0 suite:
 *
 * ```
 * b2 -a --decimate=0.5                916 189 B / 327 lines
 * b2 -a --decimate=2.5                199 291 B
 * b2 native decimationFilter=2        364 859 B / 171 lines      (Sample Rate 0.5 Hz)
 * b2 -a --start-time=2442,577760 --finish-time=2442,577770
 *                                     1 362 914 B / 262 lines
 * native, outputFileName {abc, PREFIX}   abcclean-9600.ASCII
 * native, outputFileName {abc, SUFFIX}   clean-9600abc.ASCII
 * native, {valid:false, name:'abc'}      clean-9600.ASCII
 * native, PREFIX + splitBy LOGS          abcb2-20261101_RANGE.ASCII, …_UNKNOWN.ASCII
 * ```
 *
 * The native runs are `Convert` called directly on `Edie/edie-node-wrappers.node` with the GUI's own
 * `fileList_obj` — the CLI has no flag for Prefix/Suffix, so that is the only oracle for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame } from '../src/framing.ts';
import { convertFrames, type ConvertOptions } from '../src/convert-pipeline.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const convertSamples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const B2 = join(live, 'b2-20261101.sbf');
const CLEAN = join(convertSamples, 'clean-9600.gps');
const AT = new Date('2026-11-01T00:00:00Z');

const tables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8')) as EdieTables;

function framesOf(path: string): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(path)))];
}

function run(path: string, options: Partial<ConvertOptions> = {}) {
  return convertFrames(framesOf(path), {
    format: 'ASCII',
    at: AT,
    tables,
    name: path.split(/[\\/]/).pop() as string,
    source: new Uint8Array(readFileSync(path)),
    ...options,
  });
}

const lineCount = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').split('\r\n').filter((line) => line.length > 0).length;

/* ---------------------------------------------------------------------------------------------
 * Prefix / Suffix
 * ------------------------------------------------------------------------------------------ */

test('a prefix joins the output base, before the extension', () => {
  const outcome = run(CLEAN, { affix: { name: 'abc', type: 'PREFIX' } });
  assert.equal(outcome.files[0].name, 'abcclean-9600.ASCII');
  // The summary's name and the summary file itself keep the **input** name (`Summary_clean-9600.txt`
  // in the suite), so `base` stays untouched and only the output names move.
  assert.equal(outcome.base, 'clean-9600');
  assert.equal(outcome.outputBase, 'abcclean-9600');
});

test('a suffix joins the output base, before the extension', () => {
  const outcome = run(CLEAN, { affix: { name: 'abc', type: 'SUFFIX' } });
  assert.equal(outcome.files[0].name, 'clean-9600abc.ASCII');
});

test('`valid: false` and an empty name leave the output name alone', () => {
  // The GUI sends `valid: (prefixSuffixName != "")` (`convert.js:1938`); the native ignores the name
  // when it is false — measured with `abc` still in the object.
  assert.equal(run(CLEAN, { affix: { valid: false, name: 'abc', type: 'PREFIX' } }).files[0].name, 'clean-9600.ASCII');
  assert.equal(run(CLEAN, { affix: { name: '', type: 'SUFFIX' } }).files[0].name, 'clean-9600.ASCII');
});

test('the affix is in every file name: UNKNOWN, BINARY, KML, RINEX and the split names', () => {
  const unknown = run(CLEAN, { affix: { name: 'abc', type: 'PREFIX' }, unknownBytes: 'file' });
  assert.deepEqual(unknown.files.map((file) => file.name), ['abcclean-9600.ASCII', 'abcclean-9600.UNKNOWN']);

  const binary = run(CLEAN, { format: 'BINARY', affix: { name: 'abc', type: 'SUFFIX' } });
  assert.equal(binary.files[0].name, 'clean-9600abc.BINARY');

  const kml = run(CLEAN, { format: 'KML', affix: { name: 'abc', type: 'PREFIX' } });
  assert.equal(kml.files[0].name, 'abcclean-9600_BESTPOS.KML');

  const rinex = run(CLEAN, { format: 'RINEX21', affix: { name: 'abc', type: 'SUFFIX' } });
  assert.deepEqual(rinex.files.map((file) => file.name), [
    'clean-9600abc.26O',
    'clean-9600abc.26N',
    'clean-9600abc.26G',
  ]);

  // `--split` / splitBy LOGS: `<affix><base>_<LOGNAME>.<ext>`, exactly what the native writes.
  const split = run(CLEAN, { affix: { name: 'abc', type: 'PREFIX' }, splitMode: 'logs' });
  for (const file of split.files) assert.match(file.name, /^abcclean-9600_[A-Z0-9_]+\.ASCII$/);

  const parts = run(CLEAN, { affix: { name: 'abc', type: 'PREFIX' }, splitMode: 'size', splitSizeMb: 0.05 });
  assert.ok(parts.files.length > 1);
  for (const file of parts.files) assert.match(file.name, /^abcclean-9600_Part\d+\.ASCII$/);
});

/* ---------------------------------------------------------------------------------------------
 * Time Interval
 * ------------------------------------------------------------------------------------------ */

/** The GPS seconds-of-week printed in the header of each ASCII line. */
function stampsOf(bytes: Uint8Array): number[] {
  return Buffer.from(bytes).toString('latin1')
    .split('\r\n')
    .filter((line) => line.length > 0)
    .map((line) => Number(line.slice(1).split(/[,;]/)[6]));
}

test('start and finish are one closed window, and it is the suite\'s', () => {
  const outcome = run(B2, {
    startTime: { week: 2442, seconds: 577760 },
    finishTime: { week: 2442, seconds: 577770 },
  });
  assert.equal(outcome.files[0].bytes.length, 1_362_914);
  assert.equal(lineCount(outcome.files[0].bytes), 262);
  const stamps = stampsOf(outcome.files[0].bytes).filter((stamp) => stamp > 577000);
  assert.ok(stamps.every((stamp) => stamp >= 577760 && stamp <= 577770));
  assert.equal(Math.min(...stamps), 577760);
  assert.equal(Math.max(...stamps), 577770);
});

test('one end alone is a half-open window', () => {
  const startOnly = run(B2, { startTime: { week: 2442, seconds: 577790 } });
  const after = stampsOf(startOnly.files[0].bytes).filter((stamp) => stamp > 577000);
  assert.ok(after.length > 0);
  assert.ok(after.every((stamp) => stamp >= 577790), `${Math.min(...after)} >= 577790`);

  const finishOnly = run(B2, { finishTime: { week: 2442, seconds: 577760 } });
  const before = stampsOf(finishOnly.files[0].bytes).filter((stamp) => stamp > 577000);
  assert.ok(before.length > 0);
  assert.ok(before.every((stamp) => stamp <= 577760), `${Math.max(...before)} <= 577760`);
});

test('`limitDuration` anchors at the first observation and keeps its own 1 329 348-byte window', () => {
  // The suite's `--limit-duration=10` on b2 — the same run the CLI test pins.
  const outcome = run(B2, { limitDuration: 10 });
  assert.equal(outcome.files[0].bytes.length, 1_329_348);
  assert.equal(lineCount(outcome.files[0].bytes), 236);
});

test('a window narrows the output but not the unknown-byte account', () => {
  // Measured on the suite: `-a --decimate=2 --unknown-bytes=file --start-time=2442,577760
  // --finish-time=2442,577770` still writes the **full** 7 056-byte `.UNKNOWN` next to the
  // 109 239-byte windowed file.
  const outcome = run(B2, {
    decimate: 2,
    unknownBytes: 'file',
    startTime: { week: 2442, seconds: 577760 },
    finishTime: { week: 2442, seconds: 577770 },
  });
  assert.equal(outcome.files[0].bytes.length, 109_239);
  assert.deepEqual(outcome.files.map((file) => file.name), ['b2-20261101.ASCII', 'b2-20261101.UNKNOWN']);
  assert.equal(outcome.unknown.length, 7_056);
  // The summary's UNKNOWN row is the whole-capture number as well (the suite prints 6 875).
  assert.equal(outcome.unknownCount, 6_875);
  // …and the unwindowed run writes the same `.UNKNOWN`, so the account really is window-independent.
  const whole = run(B2, { unknownBytes: 'file' });
  assert.equal(whole.unknown.length, 7_056);
  assert.equal(whole.files[1].name, 'b2-20261101.UNKNOWN');
});

/* ---------------------------------------------------------------------------------------------
 * Sample Rate (a fractional `--decimate`)
 * ------------------------------------------------------------------------------------------ */

test('fractional intervals keep the records aligned to the interval', () => {
  const half = run(B2, { decimate: 0.5 });
  assert.equal(half.files[0].bytes.length, 916_189);
  assert.equal(lineCount(half.files[0].bytes), 327);
  for (const stamp of stampsOf(half.files[0].bytes)) {
    // The rule is `millisecondsOfWeek % (interval * 1000) === 0` (`decimateFrames`), so a 0.5 s
    // interval keeps every half second.
    assert.equal(Math.round(stamp * 1000) % 500, 0, `${stamp} is not on a half second`);
  }

  const twoAndAHalf = run(B2, { decimate: 2.5 });
  assert.equal(twoAndAHalf.files[0].bytes.length, 199_291);

  // Sample Rate 0.5 Hz.
  const two = run(B2, { decimate: 2 });
  assert.equal(two.files[0].bytes.length, 364_859);
  assert.equal(lineCount(two.files[0].bytes), 171);
});
