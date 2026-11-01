/**
 * The one Convert pipeline, against the suite's own files.
 *
 * `protocol/src/convert-pipeline.ts` is what `packages/cli/src/convert.ts` writes and what the
 * app's Convert panel previews, so these are the acceptance numbers for both: the eight goldens the
 * suite produced for the ASCII family, the three abbreviated ones, and one file of each of the other
 * formats. Everything is compared as **bytes** — a UTF-8 string of the same text is not the same
 * file, because `%c` prints one raw byte and RANGECMP expansion and text records change the record
 * set, not just its formatting.
 *
 * Goldens (all from the installed suite 2.11.0; `samples/`):
 *
 *   broad-clean        5 567 000   clean-9600      489 205   live-nav   2 798 307
 *   live-nav2          2 657 890   remote-23types  3 845 232
 *   b1                 5 088 882   b2              4 931 973   b3         6 137 463
 *   b1/b2/b3 abbreviated 5 738 549 / 5 723 813 / 7 116 268
 *
 * The two abbreviated goldens that are not in the tree (`live-nav`, `live-nav2`, 3 248 102 and
 * 3 084 110 bytes) were produced by the same suite run and are compared by the CLI test's numbers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame } from '../src/framing.ts';
import { captureBase, convertFrames, isConvertFormat, type ConvertFormat } from '../src/convert-pipeline.ts';
import { novatelCrc32 } from '../src/crc.ts';
import { textLogLines } from '../src/text-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples');
const convert = join(samples, 'convert');
const live = join(samples, 'live-20261031');

function framesOf(path: string): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(path)))];
}

function run(path: string, format: ConvertFormat, at: Date) {
  return convertFrames(framesOf(path), { format, at, tables, name: path.split(/[\\/]/).pop() ?? '' });
}

interface Case {
  format: ConvertFormat;
  capture: string;
  golden: string;
  bytes: number;
}

const GOLDEN_DIR = (folder: string, name: string, stamp: string) => join(convert, folder, name, stamp);

/** The suite's ASCII files, one per capture. `at` only matters to RINEX. */
const ASCII: Case[] = [
  { format: 'ASCII', capture: join(convert, 'broad-clean.gps'), golden: join(GOLDEN_DIR('golden-broad-ascii', 'broad-clean', 'Converted_On_20261030_T1800'), 'ASCII', 'broad-clean.ASCII'), bytes: 5_567_000 },
  { format: 'ASCII', capture: join(convert, 'clean-9600.gps'), golden: join(GOLDEN_DIR('golden-ascii', 'clean-9600', 'Converted_On_20261030_T1710'), 'ASCII', 'clean-9600.ASCII'), bytes: 489_205 },
  { format: 'ASCII', capture: join(live, 'live-nav.sbf'), golden: join(live, 'golden-live-nav.ASCII'), bytes: 2_798_307 },
  { format: 'ASCII', capture: join(live, 'live-nav2.sbf'), golden: join(live, 'golden-live-nav2.ASCII'), bytes: 2_657_890 },
  { format: 'ASCII', capture: join(live, 'remote-23types.sbf'), golden: join(live, 'golden-remote-23types.ASCII'), bytes: 3_845_232 },
  { format: 'ASCII', capture: join(live, 'b1-20261101.sbf'), golden: join(live, 'golden-b1-20261101.ASCII'), bytes: 5_088_882 },
  { format: 'ASCII', capture: join(live, 'b2-20261101.sbf'), golden: join(live, 'golden-b2-20261101.ASCII'), bytes: 4_931_973 },
  { format: 'ASCII', capture: join(live, 'b3-20261101.sbf'), golden: join(live, 'golden-b3-20261101.ASCII'), bytes: 6_137_463 },
];

const ABBREV: Case[] = [
  { format: 'ABBREV_ASCII', capture: join(live, 'b1-20261101.sbf'), golden: join(live, 'golden-b1-20261101.ABBREV_ASCII'), bytes: 5_738_549 },
  { format: 'ABBREV_ASCII', capture: join(live, 'b2-20261101.sbf'), golden: join(live, 'golden-b2-20261101.ABBREV_ASCII'), bytes: 5_723_813 },
  { format: 'ABBREV_ASCII', capture: join(live, 'b3-20261101.sbf'), golden: join(live, 'golden-b3-20261101.ABBREV_ASCII'), bytes: 7_116_268 },
];

const AT = new Date('2026-11-01T00:00:00');

for (const test_ of ASCII) {
  test(`ASCII: ${test_.capture.split(/[\\/]/).pop()} is the suite's file, byte for byte`, () => {
    const file = run(test_.capture, 'ASCII', AT).files[0];
    const golden = readFileSync(test_.golden);
    assert.equal(file.bytes.length, test_.bytes);
    assert.equal(golden.length, test_.bytes, 'the golden on disk is the file this number came from');
    assert.deepEqual(Buffer.from(file.bytes), golden);
    assert.equal(file.name, test_.capture.split(/[\\/]/).pop()!.replace(/\.(sbf|gps)$/, '.ASCII'));
  });
}

for (const test_ of ABBREV) {
  test(`ABBREV_ASCII: ${test_.capture.split(/[\\/]/).pop()} is the suite's --abbrev file`, () => {
    const file = run(test_.capture, 'ABBREV_ASCII', AT).files[0];
    const golden = readFileSync(test_.golden);
    assert.equal(file.bytes.length, test_.bytes);
    assert.deepEqual(Buffer.from(file.bytes), golden);
  });
}

test('the other three format families still reproduce their goldens', () => {
  const clean = join(convert, 'clean-9600.gps');
  const stamp = 'Converted_On_20261030_T1710';

  const kml = run(clean, 'KML', AT).files[0];
  assert.equal(kml.name, 'clean-9600_BESTPOS.KML');
  assert.deepEqual(Buffer.from(kml.bytes), readFileSync(join(GOLDEN_DIR('golden-kml', 'clean-9600', stamp), 'KML', 'clean-9600_BESTPOS.KML')));

  const binary = run(clean, 'BINARY', AT).files[0];
  assert.equal(binary.text, null, 'BINARY has no text form');
  assert.deepEqual(Buffer.from(binary.bytes), readFileSync(join(GOLDEN_DIR('golden-binary', 'clean-9600', stamp), 'BINARY', 'clean-9600.BINARY')));

  // RINEX 2.1 stamps the `PGM / RUN BY / DATE` line in local time (the 3.x files use UTC), so the
  // golden's 17:10 is 09:10Z on this machine; the builders' own tests pin that difference.
  const rinex21 = run(clean, 'RINEX21', new Date('2026-10-30T17:10:00'));
  assert.deepEqual(rinex21.files.map((file) => file.name), ['clean-9600.26O', 'clean-9600.26N', 'clean-9600.26G']);
  assert.deepEqual(Buffer.from(rinex21.files[0].bytes), readFileSync(join(GOLDEN_DIR('golden-rinex2_1', 'clean-9600', stamp), 'RINEXv2_1', 'clean-9600.26O')));

  const versions: Array<[ConvertFormat, string, string, string]> = [
    ['RINEX301', 'golden-rinex3_01', 'RINEXv3_01', '2026-10-30T09:10:09Z'],
    ['RINEX302', 'golden-rinex3_02', 'RINEXv3_02', '2026-10-30T09:10:09Z'],
    ['RINEX303', 'golden-rinex3_03', 'RINEXv3_03', '2026-10-30T09:10:10Z'],
    ['RINEX304', 'golden-rinex3_04', 'RINEXv3_04', '2026-10-30T09:10:11Z'],
  ];
  for (const [format, folder, directory, builtAt] of versions) {
    const out = run(clean, format, new Date(builtAt));
    const obs = out.files[0];
    assert.equal(obs.name, 'clean-9600.26O', `${format} writes the observation file first`);
    assert.deepEqual(
      Buffer.from(obs.bytes),
      readFileSync(join(GOLDEN_DIR(folder, 'clean-9600', stamp), directory, 'clean-9600.26O')),
      `${format} observations`,
    );
  }
});

test('PASSTHROUGH is dropped before every format and from the summary counts', () => {
  const b2 = framesOf(join(live, 'b2-20261101.sbf'));
  const bestpos = b2.find((frame) => frame.kind === 'sbf' && frame.header.messageId === 42);
  assert.ok(bestpos && bestpos.kind === 'sbf');
  const passthrough = Buffer.from(bestpos.bytes);
  passthrough.writeUInt16LE(1342, 4); // messageId is the u16 at offset 4 of the long header
  passthrough.writeUInt32LE(novatelCrc32(new Uint8Array(passthrough.subarray(0, passthrough.length - 4))), passthrough.length - 4);

  const frames: Frame[] = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(Buffer.concat([Buffer.from(bestpos.bytes), passthrough])))];
  const ascii = convertFrames(frames, { format: 'ASCII', at: AT, tables, name: 'pass.sbf' });
  assert.equal(ascii.all.length, 2);
  assert.equal(ascii.passthrough.length, 1);
  assert.equal(ascii.accepted.length, 1);
  assert.equal(ascii.files[0].text, `${ascii.files[0].text!.split('\r\n')[0]}\r\n`, 'one line, the BESTPOS record');
  assert.equal(ascii.counts.has(1342), false, 'not in the summary table');

  const binary = convertFrames(frames, { format: 'BINARY', at: AT, tables, name: 'pass.sbf' });
  assert.deepEqual(Buffer.from(binary.files[0].bytes), Buffer.from(bestpos.bytes), 'BINARY copies the BESTPOS record only');
});

test('RANGECMP2/4 are unpacked into RANGE rows (638 in, 699 out)', () => {
  const b2 = run(join(live, 'b2-20261101.sbf'), 'ASCII', AT);
  const range = b2.counts.get(43);
  assert.ok(range);
  assert.equal(range.source, 638, 'the capture carries 638 RANGE records of its own');
  assert.equal(b2.counts.get(1273)?.source, 31);
  assert.equal(b2.counts.get(2050)?.source, 30);
  // The file is the oracle: 638 + 31 + 30 lines, and no `#RANGECMP` line anywhere.
  const lines = b2.files[0].text!.split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.filter((line) => line.startsWith('#RANGEA,')).length, 699);
  assert.equal(lines.filter((line) => line.startsWith('#RANGECMP')).length, 0);
  assert.equal(lines.length, readFileSync(join(live, 'golden-b2-20261101.ASCII'), 'latin1').split('\r\n').filter((line) => line.length > 0).length);
});

test('text records are converted in capture order, one line each in ASCII', () => {
  const b1 = run(join(live, 'b1-20261101.sbf'), 'ASCII', AT);
  const lines = b1.files[0].text!.split('\r\n').filter((line) => line.length > 0);
  const golden = readFileSync(join(live, 'golden-b1-20261101.ASCII'), 'latin1').split('\r\n').filter((line) => line.length > 0);
  // 1325 binary frames, minus the 22 RXCONFIG records whose embedded message the dictionary cannot
  // resolve (`ascii-log.ts` drops `%R` with nothing to print, as the suite does), plus the 99 text
  // records: 1402 lines.
  assert.equal(lines.length, 1325 - 22 + 99);
  assert.equal(lines.length, golden.length, "the same line count as the suite's file");
  // ... printed where they sit in the capture, not appended: a text frame may carry several ASCII
  // records (the de-framer ends one at the next record start), so every line of every text entry
  // must appear in order, each after the previous one.
  const textAt = textLogLines(framesOf(join(live, 'b1-20261101.sbf')), tables);
  assert.equal(textAt.size, 99, 'the text records the suite converts too');
  const textLines = [...textAt.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, text]) => text.split('\r\n'))
    .filter((line) => line.length > 0);
  assert.ok(textLines.length >= 99, `${textLines.length} text lines from 99 records`);
  let cursor = 0;
  for (const line of textLines) {
    const at = lines.indexOf(line, cursor);
    assert.ok(at >= 0, `text line in capture order: ${line.slice(0, 60)}`);
    cursor = at + 1;
  }
  assert.ok(cursor < lines.length, 'the text records are interleaved, not appended at the end');

  const abbrev = run(join(live, 'b1-20261101.sbf'), 'ABBREV_ASCII', AT);
  const headers = abbrev.files[0].text!.split('\r\n').filter((line) => /^<[A-Z][A-Z0-9_]* /.test(line));
  assert.equal(headers.length, 1325 + 99 - 22, 'the 22 RXCONFIG records whose embedded message the dictionary lacks');
});

test('captureBase strips the last extension only when there is a stem', () => {
  assert.equal(captureBase('b1-20261101.sbf'), 'b1-20261101');
  assert.equal(captureBase('a.b.gps'), 'a.b');
  assert.equal(captureBase('noext'), 'noext');
  assert.equal(captureBase('.hidden'), '.hidden');
  assert.equal(isConvertFormat('abbrev_ascii'), true);
  assert.equal(isConvertFormat('csv'), false);
});
