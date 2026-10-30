/**
 * Convert output parity for the other two formats and the summary report.
 *
 * Goldens: `samples/convert/golden-binary` and `golden-abbrev` (same input `clean-9600.gps`,
 * produced by the suite on 2026-10-30T17:10Z). Binary output is a verbatim copy of the accepted
 * records; abbreviated ASCII is the same field values as full ASCII with different framing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { encodeAbbrevLines, encodeBinaryCapture } from '../src/abbrev-log.ts';
import { buildSummary } from '../src/summary.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const capturePath = join(samples, 'clean-9600.gps');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
}

test('abbreviated ASCII matches the suite byte for byte', () => {
  const golden = readFileSync(join(samples, 'golden-abbrev', 'clean-9600', 'Converted_On_20261030_T1710', 'ABBREV_ASCII', 'clean-9600.ABBREV_ASCII'));
  const lines: string[] = [];
  for (const frame of frames()) {
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) continue;
    lines.push(...encodeAbbrevLines(frame, layout, tables));
  }
  const text = `${lines.join('\r\n')}\r\n`;
  assert.equal(lines.length, 6294, 'line count');
  assert.deepEqual(Buffer.from(text, 'utf8'), golden, 'byte-identical');
});

test('binary output is the accepted records verbatim', () => {
  const golden = readFileSync(join(samples, 'golden-binary', 'clean-9600', 'Converted_On_20261030_T1710', 'BINARY', 'clean-9600.BINARY'));
  const { bytes, accepted, dropped } = encodeBinaryCapture(frames());
  assert.equal(accepted.length, 119);
  assert.equal(dropped, 0);
  assert.deepEqual(Buffer.from(bytes), golden, 'byte-identical');
});

test('the summary report matches, including its 62-column table', () => {
  const golden = readFileSync(join(samples, 'golden-binary', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt'), 'utf8');
  const all = frames();
  const accepted = all.filter((frame) => frame.crcOk);
  const counts = new Map<number, { name: string; source: number; output: number }>();
  for (const frame of all) {
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) continue;
    const entry = counts.get(frame.header.messageId) ?? { name: layout.name, source: 0, output: 0 };
    entry.source += 1;
    if (frame.crcOk) entry.output += 1;
    counts.set(frame.header.messageId, entry);
  }
  const text = buildSummary(
    {
      fileName: 'clean-9600.gps',
      bytes: statSync(capturePath).size,
      inputDirectory: samples,
      outputDirectory: join(samples, 'golden-binary', 'clean-9600'),
      formatName: 'BINARY',
      frames: accepted,
      completedAt: new Date('2026-10-30T17:10:07.358Z'),
    },
    counts,
  );
  assert.equal(text, golden, 'byte-identical summary');
});
