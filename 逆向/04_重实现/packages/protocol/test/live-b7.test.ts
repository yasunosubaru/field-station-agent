/**
 * `b7-20261101.sbf` — the capture this project made for the three "no sample yet" gaps:
 * interference (ITK), the receiver's event channel, and multi-frequency RANGE.
 *
 * The capture is 943 486 B over 69 s of receiver time, taken on COM10 (receiver port USB2) on
 * 2026-11-01 with `逆向/tools/remote/b7-capture.ps1`. Golden files:
 *
 *   golden-b7-20261101.ASCII          the suite's `-a` conversion
 *   golden-b7-20261101.ABBREV_ASCII   the suite's `--abbrev` conversion
 *   golden-b7-20261101.Summary.txt    the suite's own table for the same run
 *
 * What the capture proves, and what these tests pin:
 *
 *  - **ITK**: this receiver really does detect interference. 47 `ITDETECTSTATUSA` records, 38 of
 *    them carrying a detection on **L2** (25 `STATISTICANALYSIS`, 13 `SPECTRUMANALYSIS`), next to
 *    47 `ITPSDFINALA` and 90 `ITPSDDETECTA` spectra. Every one of those lines is byte-identical to
 *    the suite's.
 *  - **events**: `RXSTATUSEVENTA` was open for the whole run (invalid commands, a config write, a
 *    refused INTERFACEMODE, a spectral-analysis change) and the receiver emitted **no**
 *    `RXSTATUSEVENT` at all — see `03_分析/01_Manage界面与数据流.md` §实测.
 *  - **bands**: 47 `RANGEA` records, 3 290 observations, `sv_freq` = 0 for 3 243 of them and 203 for
 *    47 (one L-band channel per record). No observation carries 5 (L2) or 9 (L5), so the Signal
 *    Matrix has no L2/L5 cell to draw — the receiver tracks one band per satellite indoors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer } from '../src/framing.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import { abbrevTextLogLines } from '../src/text-log.ts';
import { novatelCrc32 } from '../src/crc.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const capture = new Uint8Array(readFileSync(join(samples, 'b7-20261101.sbf')));
const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(capture)];

const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const convert = (format: 'ASCII' | 'ABBREV_ASCII'): string =>
  asText(
    convertFrames(frames, {
      format,
      at: new Date('2026-11-01T00:00:00Z'),
      tables,
      name: 'b7-20261101.sbf',
    }).files[0].bytes,
  );

const lines = (text: string): string[] => text.split('\r\n').filter(Boolean);
const typeOf = (line: string): string => /^[#<]\s*([A-Z][A-Z0-9_]*)/.exec(line)?.[1] ?? '(other)';

const ascii = convert('ASCII');
const abbrev = convert('ABBREV_ASCII');
const goldenAscii = readFileSync(join(samples, 'golden-b7-20261101.ASCII'), 'latin1');
const goldenAbbrev = readFileSync(join(samples, 'golden-b7-20261101.ABBREV_ASCII'), 'latin1');

const ofType = (text: string, name: string): string[] => lines(text).filter((line) => typeOf(line) === name);

// ------------------------------------------------------------------ ITK

test('the ITK records are byte-identical to the suite, record for record', () => {
  for (const name of [
    'ITDETECTSTATUSA',
    'ITDETECTSTATUSB',
    'ITPSDFINALA',
    'ITPSDDETECTA',
    'ITSPECTRALANALYSISA',
    'ITDETECTCONFIGA',
    'ITWARNINGCONFIGA',
    'CHANCONFIGLISTA',
  ]) {
    const ours = ofType(ascii, name);
    const suite = ofType(goldenAscii, name);
    assert.deepEqual(ours, suite, `${name} lines differ`);
  }
});

test('the capture carries real interference: 38 of 47 detection records name L2', () => {
  const records = ofType(ascii, 'ITDETECTSTATUSA');
  assert.equal(records.length, 47);
  let withDetection = 0;
  const methods = new Set<string>();
  const bands = new Set<string>();
  for (const record of records) {
    const body = record.slice(record.indexOf(';') + 1).replace(/\*[0-9a-f]+$/i, '').split(',');
    const count = Number(body[0]);
    if (count > 0) withDetection += 1;
    for (let i = 0; i < count; i += 1) {
      bands.add(body[1 + i * 9]);
      methods.add(body[2 + i * 9]);
    }
  }
  assert.equal(withDetection, 38);
  assert.deepEqual([...bands], ['L2']);
  assert.deepEqual([...methods].sort(), ['SPECTRUMANALYSIS', 'STATISTICANALYSIS']);
});

test('a detection record keeps its full field list: band, method, four parameters, two masks', () => {
  const record = ofType(ascii, 'ITDETECTSTATUSA').find((line) => /;1,L2,/.test(line));
  assert.ok(record, 'no record with a detection');
  const body = record!.slice(record!.indexOf(';') + 1).replace(/\*[0-9a-f]+$/i, '').split(',');
  assert.equal(body.length, 1 + 9);
  assert.equal(body[0], '1');
  assert.equal(body[1], 'L2');
  assert.match(body[2], /^(STATISTICANALYSIS|SPECTRUMANALYSIS)$/);
  for (const index of [3, 4, 5, 6]) assert.match(body[index], /^-?\d+\.\d{3}$/);
  assert.match(body[7], /^[0-9a-f]{8}$/);
  assert.match(body[8], /^[0-9a-f]{8}$/);
});

test('the spectra are 1024 samples: 47 ITPSDFINAL and 90 ITPSDDETECT records', () => {
  const final = ofType(ascii, 'ITPSDFINALA');
  const detect = ofType(ascii, 'ITPSDDETECTA');
  assert.equal(final.length, 47);
  assert.equal(detect.length, 90);
  const counts = new Map<string, number>();
  for (const line of [...final, ...detect]) {
    const fields = line.slice(line.indexOf(';') + 1).replace(/\*[0-9a-f]+$/i, '').split(',');
    counts.set(fields[3], (counts.get(fields[3]) ?? 0) + 1);
  }
  // 1024-point spectra dominate; the short 341/512 ones are sub-bands of the same sweep.
  assert.deepEqual([...counts.keys()].sort(), ['1024', '341', '512']);
  assert.equal(counts.get('1024'), 43 + 45);
});

// ------------------------------------------------------------------ bands

test('sv_freq: one band per satellite (3 243 samples at 0) plus one L-band channel at 203', () => {
  const ranges = ofType(ascii, 'RANGEA');
  assert.equal(ranges.length, 47);
  const histogram = new Map<number, number>();
  for (const line of ranges) {
    const fields = line.slice(line.indexOf(';') + 1).replace(/\*[0-9a-f]+$/i, '').split(',');
    const count = Number(fields[0]);
    assert.equal(count, 70, 'every RANGE record of this capture carries 70 observations');
    for (let i = 0; i < count; i += 1) {
      const freq = Number(fields[2 + i * 10]);
      histogram.set(freq, (histogram.get(freq) ?? 0) + 1);
    }
  }
  assert.deepEqual([...histogram.entries()].sort((a, b) => a[0] - b[0]), [
    [0, 3243],
    [203, 47],
  ]);
  // No L2 (5) and no L5 (9): the Signal Matrix has nothing to draw in those columns.
  assert.equal(histogram.get(5), undefined);
  assert.equal(histogram.get(9), undefined);
});

test('TRACKSTAT shows the L2/L5 channels that RANGE cannot label', () => {
  const trackstats = ofType(ascii, 'TRACKSTATA');
  assert.equal(trackstats.length, 9);
  for (const line of trackstats) {
    const fields = line.slice(line.indexOf(';') + 1).split(',');
    assert.equal(fields[0], 'SOL_COMPUTED');
    assert.ok(fields.includes('OBSL2'), 'no L2 channel in this TRACKSTAT');
    assert.ok(fields.includes('OBSL5'), 'no L5 channel in this TRACKSTAT');
  }
});

// ------------------------------------------------------------------ events

test('the event channel stayed open and stayed silent: no RXSTATUSEVENT in 69 s', () => {
  assert.equal(ofType(goldenAscii, 'RXSTATUSEVENTA').length, 0);
  assert.equal(ofType(ascii, 'RXSTATUSEVENTA').length, 0);
});

// ------------------------------------------------------------------ ABBREV shape

test('an ITPSD record is one data line in ABBREV, 1024 samples and all', () => {
  const block = abbrev.split('\r\n');
  const head = block.findIndex((line) => line.startsWith('<ITPSDFINAL '));
  assert.ok(head >= 0, 'no ITPSDFINAL block');
  assert.match(block[head + 1], /^<     04020920 \d+\.\d{3} \d+\.\d{3} 1024( \d+)+$/);
  assert.match(block[head + 2] ?? '', /^<ITPSD/, 'the block must be header + one data line');
});

test('the same ITPSD blocks come out of the golden ABBREV file in the same shape', () => {
  const ours = lines(abbrev).filter((line) => line.startsWith('<ITPSDFINAL ') || /^<     04020920 /.test(line));
  const suite = lines(goldenAbbrev).filter((line) => line.startsWith('<ITPSDFINAL ') || /^<     04020920 /.test(line));
  assert.deepEqual(ours, suite);
});

// ------------------------------------------------------------------ RXCONFIG, the measured gap

test('a config dump line survives the deframer even though it quotes another record', () => {
  const configs = frames.filter(
    (frame) => frame.kind === 'text' && frame.prefix === '#' && frame.text.startsWith('#RXCONFIG'),
  );
  // 269 lines came off the wire; the suite keeps 247 of them (see the next test).
  assert.equal(configs.length, 269);
  for (const frame of configs) {
    assert.match(frame.text, /^#RXCONFIGA,[^;]*;#(?:[A-Z0-9_]+),[^;]*;[^*]*\*[0-9a-f]{8}\*[0-9a-f]{8}\r?\n?$/);
  }
});

test('we print the 247 config records the suite resolves, and drop the same 22', () => {
  const ours = ofType(ascii, 'RXCONFIGA');
  const suiteSet = new Set(lines(goldenAscii));
  // 269 lines came off the wire. The suite re-renders the embedded message of each one and writes
  // nothing when the dictionary cannot resolve it — 22 of the 269 embed a name this dictionary does
  // not carry (`AGCMODEA`, `SETIONOMODELA`, …), which leaves 247 in both outputs.
  assert.equal(ours.length, 247);
  assert.equal(ofType(goldenAscii, 'RXCONFIGA').length, 247);
  assert.deepEqual(ours, lines(goldenAscii).filter((line) => line.startsWith('#RXCONFIGA')));
  assert.equal(ours.filter((line) => suiteSet.has(line)).length, 247);
});

test('the suite prints the embedded config message as an indented block of its own', () => {
  const suiteBlock = lines(goldenAbbrev);
  const head = suiteBlock.findIndex((line) => line === '<RXCONFIG USB2 10 76.5 COARSESTEERING 2442 553862.246 03809800 f702 18278');
  assert.ok(head >= 0, 'missing the RXCONFIG block for sequence 10');
  assert.match(suiteBlock[head + 1], /^<     LOG USB2 10 76\.5 COARSESTEERING 2442 553862\.246 03809800 92b2 18278 $/);
  assert.equal(suiteBlock[head + 2], '<     USB1_30 ITPSDDETECTB ONNEW 0.000000 0.000000 HOLD');

  // Ours is the same three lines, byte for byte — the embedded record is re-rendered, not copied,
  // so no CRC stays glued to the last value.
  const ourBlock = lines(abbrev);
  const at = ourBlock.findIndex((line) => line === suiteBlock[head]);
  assert.ok(at >= 0);
  assert.equal(ourBlock[at + 1], suiteBlock[head + 1]);
  assert.equal(ourBlock[at + 2], suiteBlock[head + 2]);
});

// ------------------------------------------------------------------ framing regression guard

test('a truncated text record that only looks like a record is still cut at the inner `#`', () => {
  // The rule the new "keep a complete line" branch must not weaken: a line whose CRC does not check
  // out is a fragment, and the suite starts a new record at the `#` inside it.
  const broken =
    '#RXCONFIGA,USB2,268,76.5,SATTIME,0,0.000,03808800,f702,18278;' +
    '#ELEVATIONCUTOFFA,USB2,268,76.5,SATTIME,0,0.000,03808800,50e0,18278;GLONASS,5.0,0*00000000*00000000\r\n';
  const inner = [...new SbfDeframer({ crcMode: 'validate' }).push(new TextEncoder().encode(broken))];
  assert.equal(inner.length, 1);
  assert.equal(inner[0].kind === 'text' && inner[0].text.startsWith('#ELEVATIONCUTOFFA'), true);
});

test('a complete line is kept whole when its CRC is right', () => {
  const sentence =
    'RXCONFIGA,USB2,268,76.5,SATTIME,0,0.000,03808800,f702,18278;' +
    '#ELEVATIONCUTOFFA,USB2,268,76.5,SATTIME,0,0.000,03808800,50e0,18278;GLONASS,5.0,0*866b1c79';
  const crc = novatelCrc32(new TextEncoder().encode(sentence)).toString(16).padStart(8, '0');
  const good = `${'#'}${sentence}*${crc}\r\n`;
  const parsed = [...new SbfDeframer({ crcMode: 'validate' }).push(new TextEncoder().encode(good))];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind === 'text' && parsed[0].text.startsWith('#RXCONFIGA'), true);
});

// ------------------------------------------------------------------ ABBREV text arrays

test('a counted scalar array stays on the data line in ABBREV (text path)', () => {
  const head = 'USB2,0,77.0,COARSESTEERING,2443,35956.000,03808800,b79a,18278';
  const samples = Array.from({ length: 6 }, (_, i) => String(24000 + i));
  const sentence = `ITPSDFINALA,${head};04020920,1531.299,97656.250,6,${samples.join(',')}`;
  const crc = novatelCrc32(new TextEncoder().encode(sentence)).toString(16).padStart(8, '0');
  const record = `#${sentence}*${crc}\r\n`;
  const parsed = [...new SbfDeframer({ crcMode: 'validate' }).push(new TextEncoder().encode(record))];
  const block = abbrevTextLogLines(parsed, tables).get(0);
  assert.deepEqual(block, [
    '<ITPSDFINAL USB2 0 77.0 COARSESTEERING 2443 35956.000 03808800 b79a 18278',
    '<     04020920 1531.299 97656.250 6 24000 24001 24002 24003 24004 24005',
  ]);
});
