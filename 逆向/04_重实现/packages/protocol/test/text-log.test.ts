/**
 * Text records (`<…` / `#…`) inside a capture: the suite's Convert converts them too.
 *
 * Fixtures: `samples/live-20261031/live-nav.sbf` (1 643 003 B) with `golden-live-nav.ASCII`
 * (617 lines) and `live-nav2.sbf` (1 563 194 B) with `golden-live-nav2.ASCII` (593 lines) — the two
 * captures where the receiver was streaming abbreviated ASCII on USB2 while the same data went out
 * as binary on SPECIAL_29. Before this module existed the 79 / 74 text lines were simply missing.
 *
 * See `03_分析/09_EDIE消息字典与ASCII一致性.md` §9.x.4.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame } from '../src/framing.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { encodeTextLog, textLogLines, type TextLogRecord } from '../src/text-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function framesOf(file: string): Frame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(dir, file))))];
}

/** Exactly what `convert.ts --to ASCII` writes: binary and text records interleaved in frame order. */
function wholeFile(frames: Frame[]): string[] {
  const text = textLogLines(frames, tables);
  const out: string[] = [];
  frames.forEach((frame, index) => {
    const line = text.get(index);
    if (line !== undefined) {
      out.push(line);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    const encoded = encodeAsciiLog(frame, layout, tables);
    if (encoded) out.push(encoded);
  });
  return out;
}

function layoutOf(name: string) {
  return Object.values(tables.messages).find((layout) => layout.name === name);
}

/** The nine header tokens every abbreviated log carries after its name. */
const HEADER = ['USB2', '0', '75.5', 'COARSESTEERING', '2442', '555611.000', '03801800', '5103', '18278'];

test('live-nav: every line of the golden, text records included, byte for byte', () => {
  const frames = framesOf('live-nav.sbf');
  const golden = readFileSync(join(dir, 'golden-live-nav.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 617);
  assert.equal(produced.length, 617, '538 binary + 79 text lines');
  assert.deepEqual(produced, golden);
});

test('live-nav2: same, 519 binary + 74 text lines', () => {
  const frames = framesOf('live-nav2.sbf');
  const golden = readFileSync(join(dir, 'golden-live-nav2.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 593);
  assert.equal(produced.length, 593);
  assert.deepEqual(produced, golden);
});

test('the text half of live-nav is 79 lines: 7 record kinds plus 11 verbatim `#` logs', () => {
  const frames = framesOf('live-nav.sbf');
  const counts = new Map<string, number>();
  const text = textLogLines(frames, tables);
  for (const index of text.keys()) {
    const frame = frames[index];
    const name = frame.kind === 'text' && frame.prefix === '#' ? '#passthrough' : /^#([A-Z0-9]+)/.exec(text.get(index)!)?.[1] ?? '?';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  assert.deepEqual([...counts.entries()].sort(), [
    ['#passthrough', 11], ['BESTPOSA', 22], ['HWMONITORA', 2], ['RANGEA', 22],
    ['RXSTATUSA', 4], ['SATVIS2A', 16], ['TIMESYNCA', 2],
  ]);
});

test('a `#` record is copied out verbatim, CRC and all', () => {
  const frames = framesOf('live-nav.sbf');
  const index = frames.findIndex((frame) => frame.kind === 'text' && frame.prefix === '#');
  const frame = frames[index];
  assert.ok(frame.kind === 'text');
  const line = textLogLines(frames, tables).get(index);
  assert.equal(line, frame.text.replace(/[\r\n]+$/, ''));
  assert.ok(line?.endsWith('*9aa75286'), 'the capture\'s own CRC survives');
});

test('a `<` body goes through the layout: hex and float32 are re-printed, not copied', () => {
  const record: TextLogRecord = {
    index: 0,
    name: 'RANGE',
    tokens: [...HEADER, '1', '4', '0', '20229880.713', '0.188', '-106308738.293962', '0.025', '-3196.615', '39.2', '75947.813', '1810bc04'],
  };
  const line = encodeTextLog(record, layoutOf('RANGE'), tables);
  const body = line.slice(line.indexOf(';') + 1, line.lastIndexOf('*')).split(',');
  assert.equal(body[0], '1', 'the element count stays first');
  assert.equal(body[5], '-106308738.293962', 'a `%9.6lk` double round-trips exactly');
  assert.equal(body[9], '75947.812', '`75947.813` read back as float32 is 75947.8125 → half-even');
  assert.equal(body[10], '1810bc04', '`%08x` stays lowercase hex');
});

test('HWMONITOR status is hex in the text and zero-padded on the way out', () => {
  const record: TextLogRecord = {
    index: 0,
    name: 'HWMONITOR',
    tokens: ['USB2', '0', '72.5', 'COARSESTEERING', '2442', '555620.000', '03801800', '52db', '18278', '2', '39.377292633', '100', '0.052625157', 'f00'],
  };
  const line = encodeTextLog(record, layoutOf('HWMONITOR'), tables);
  const body = line.slice(line.indexOf(';') + 1, line.lastIndexOf('*')).split(',');
  assert.deepEqual(body, ['2', '39.377292633', '00000100', '0.052625157', '00000f00']);
});

test('`<OK` is a response, not the start of a body', () => {
  const frames: Frame[] = [
    { kind: 'text', prefix: '<', text: '<HWMONITOR USB2 0 72.5 COARSESTEERING 2442 555620.000 03801800 52db 18278\r\n' },
    { kind: 'text', prefix: '<', text: '<     10 \r\n' },
    { kind: 'text', prefix: '<', text: '<          39.377292633 100 \r\n' },
    { kind: 'text', prefix: '<', text: '<OK\r\n' },
  ];
  const lines = textLogLines(frames, tables);
  assert.equal(lines.size, 1);
  const line = lines.get(0)!;
  assert.ok(line.endsWith('*' + line.slice(line.lastIndexOf('*') + 1)), 'well formed');
  assert.ok(line.includes(';10,39.377292633,00000100*'), 'the response added no tokens');
});
