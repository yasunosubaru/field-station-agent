/**
 * Which of the bytes **we** call unknown does the suite still call unknown once `--decimate` drops
 * records? Both sides are concatenations of capture bytes in capture order, so the suite's file can
 * be walked against our run list: a run either survives whole, partially, or is gone.
 *
 *   node 逆向/tools/probe-decimate-unknown.ts <capture> <suite.UNKNOWN> [--decimate 5] [--show 8]
 *
 * Prints every run with its capture offsets, what is inside it (bad-CRC record / record that renders
 * nothing / plain text garbage), and whether the record inside it survives the decimation grid.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  convertFrames,
  unknownSpans,
} from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const tables: EdieTables = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'),
  'utf8',
));

const argv = process.argv.slice(2);
const positional = argv.filter((token, index) => !token.startsWith('--') && !argv[index - 1]?.startsWith('--decimate'));
const decimate = argv.includes('--decimate') ? Number(argv[argv.indexOf('--decimate') + 1]) : undefined;
const [capturePath, suitePath] = positional;

const capture = new Uint8Array(readFileSync(capturePath));
const deframer = new SbfDeframer({ crcMode: 'validate' });
const frames = [...deframer.push(capture)];
deframer.end();
const suite = new Uint8Array(readFileSync(suitePath));

const { fileRuns } = unknownSpans(frames, tables, capture.length);
const ours = new Uint8Array(fileRuns.reduce((sum, run) => sum + run.end - run.start, 0));
{
  let at = 0;
  for (const run of fileRuns) { ours.set(capture.subarray(run.start, run.end), at); at += run.end - run.start; }
}
console.log(`capture ${capture.length} B, ours ${ours.length} B in ${fileRuns.length} runs, suite ${suite.length} B`);

const ends: number[] = [];
let at0 = 0;
for (const run of fileRuns) { at0 += run.end - run.start; ends.push(at0); }

const describe = (frame: Frame, index: number): string => {
  if (frame.kind === 'text') return `text[${index}] ${JSON.stringify(frame.prefix + frame.text).slice(0, 40)}`;
  const sbf = frame as SbfFrame;
  const layout = tables.messages[String(sbf.header.messageId)];
  const stamp = `${sbf.header.week}/${(sbf.header.milliseconds / 1000).toFixed(3)}`;
  const alias = (name: string) => ({ FINE: 80, FINEADJUSTING: 100, DEGRADED: 120, ALIGNING: 160, FINESTEERING: 180, COARSESTEERING: 60, SATTIME: 200, UNKNOWN: 0, APPROXIMATE: 20 } as Record<string, number>)[name] ?? -1;
  void alias;
  const grid = decimate ? (sbf.header.milliseconds % (decimate * 1000) === 0 ? 'on-grid' : 'off-grid') : '';
  return `sbf[${index}] id=${sbf.header.messageId} ${layout?.name ?? '?'} ${stamp} ts=${sbf.header.timeStatus} crc=${sbf.crcOk ? 'ok' : 'BAD'} ${grid}`;
};

// Walk the suite's file against our runs, in order.
let pointer = 0;
let kept = 0;
let dropped = 0;
let partialBytes = 0;
const rows: string[] = [];
for (const run of fileRuns) {
  const length = run.end - run.start;
  const mine = capture.subarray(run.start, run.end);
  let matched = 0;
  while (matched < length && pointer + matched < suite.length && suite[pointer + matched] === mine[matched]) matched += 1;
  const inside = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame.offset !== undefined && frame.offset < run.end && frame.offset + (frame.kind === 'sbf' ? frame.bytes.length : frame.text.length) > run.start)
    .map(({ frame, index }) => describe(frame, index));
  const verdict = matched === length ? 'KEPT' : matched === 0 ? 'DROPPED' : `PARTIAL ${matched}/${length}`;
  if (matched === length) kept += length;
  else if (matched === 0) dropped += length;
  else partialBytes += length;
  pointer += matched;
  rows.push(`@${String(run.start).padStart(8)} +${String(length).padStart(6)} ${verdict.padEnd(14)} ${inside.join(' ; ') || '(text only)'}`);
}
for (const row of rows) if (!row.includes('KEPT') || argv.includes('--all')) console.log(row);
console.log(`\nkept ${kept} B, dropped ${dropped} B, partial runs ${partialBytes} B, consumed ${pointer}/${suite.length}`);
console.log(`suite tail after walk: ${suite.length - pointer} B`);

// The summary count and the two totals, for the record.
const outcome = convertFrames(frames, {
  format: 'ASCII', at: new Date('2026-11-01T00:00:00Z'), tables, name: capturePath.split(/[\\/]/).pop()!,
  ...(decimate ? { decimate } : {}), source: capture, unknownBytes: 'file',
});
console.log(`our .UNKNOWN ${outcome.unknown.length} B, summary UNKNOWN row ${outcome.unknownCount}`);
