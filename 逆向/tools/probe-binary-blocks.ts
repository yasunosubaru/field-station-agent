/**
 * Probe: per-output-frame comparison of a `BINARY` conversion, with the source text record named.
 *
 *   node 逆向/tools/probe-binary-blocks.ts <capture.sbf> <suite.BINARY> [--diff n]
 *
 * Prints, for each frame whose bytes differ, the frame's index, its log name, and — for a text
 * record — the record's nine header tokens and the first body tokens, so a rule can be read off
 * without guessing which record produced the frame.
 */

import { readFileSync } from 'node:fs';

import { SbfDeframer, type Frame, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { collectBinaryRecords } from '../04_重实现/packages/protocol/src/text-log.ts';
import { encodeRecord } from '../04_重实现/packages/protocol/src/binary-log.ts';
import { textLogLines } from '../04_重实现/packages/protocol/src/text-log.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(
  readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'),
) as EdieTables;

function framesOf(bytes: Uint8Array): Frame[] {
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)];
  deframer.end();
  return frames;
}

const [capturePath, oraclePath] = process.argv.slice(2);
const limit = process.argv.includes('--diff') ? Number(process.argv[process.argv.indexOf('--diff') + 1]) : 10;

const capture = new Uint8Array(readFileSync(capturePath));
const frames = framesOf(capture);
const ours = convertFrames(frames, { format: 'BINARY', at: new Date(), tables, name: 'x.sbf' }).files[0]!.bytes;
const oracle = new Uint8Array(readFileSync(oraclePath));
const ourFrames = framesOf(ours).filter((frame): frame is SbfFrame => frame.kind === 'sbf');
const oracleFrames = framesOf(oracle).filter((frame): frame is SbfFrame => frame.kind === 'sbf');
console.log(`ours ${ourFrames.length} frames, suite ${oracleFrames.length}`);
console.log(`ours ${ours.length} B, suite ${oracle.length} B`);

/** Text record emitted at each frame index, in output order. */
const lines = textLogLines(frames, tables);
const records = collectBinaryRecords(frames, tables);
const blocks: Array<{ kind: 'sbf'; frame: SbfFrame } | { kind: 'text'; record: ReturnType<typeof collectBinaryRecords> extends Map<number, infer R> ? R : never }> = [];
frames.forEach((frame, index) => {
  if (lines.has(index)) {
    const record = records.get(index);
    if (record) blocks.push({ kind: 'text', record });
    return;
  }
  if (frame.kind === 'sbf') blocks.push({ kind: 'sbf', frame });
});

let shown = 0;
for (let i = 0; i < Math.max(ourFrames.length, oracleFrames.length) && shown < limit; i++) {
  const a = ourFrames[i];
  const b = oracleFrames[i];
  if (!a || !b) { console.log(`frame ${i} missing on one side`); shown++; continue; }
  if (a.bytes.length === b.bytes.length && Buffer.from(a.bytes).equals(Buffer.from(b.bytes))) continue;
  shown++;
  const block = blocks[i];
  console.log(`\nframe ${i}: ours id=${a.header.kind === 'long' ? a.header.messageId : 'short'} len=${a.bytes.length}, suite len=${b.bytes.length}`);
  if (block?.kind === 'text') {
    console.log(`  text ${block.record.name} head=${JSON.stringify(block.record.head)}`);
    console.log(`  body ${JSON.stringify(block.record.body.slice(0, 24))}`);
    console.log(`  embedded ${block.record.embedded?.slice(0, 160) ?? '-'}`);
  } else if (block?.kind === 'sbf') {
    console.log(`  binary frame id ${block.frame.header.kind === 'long' ? block.frame.header.messageId : 'short'}`);
  }
  const n = Math.min(a.bytes.length, b.bytes.length);
  const diffs: number[] = [];
  for (let k = 0; k < n; k++) if (a.bytes[k] !== b.bytes[k]) diffs.push(k);
  console.log(`  byte diffs ${JSON.stringify(diffs.slice(0, 24))} (${diffs.length})`);
  const show = (buf: Uint8Array) => Array.from(buf.subarray(0, 100), (x) => x.toString(16).padStart(2, '0')).join(' ');
  console.log(`  ours  ${show(a.bytes)}`);
  console.log(`  suite ${show(b.bytes)}`);
}
