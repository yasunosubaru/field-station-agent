/**
 * Show the text records a capture carries, verbatim, so a synthetic probe can copy a shape the
 * suite really accepts.
 *
 *   node 逆向/tools/probe-text-records.ts <capture.sbf> [--limit 8] [--prefix #] [--len 160]
 */

import { readFileSync } from 'node:fs';

import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';

const argv = process.argv.slice(2);
const path = argv.find((token) => token.endsWith('.sbf') || token.endsWith('.gps'))!;
const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 8;
const prefix = argv.includes('--prefix') ? argv[argv.indexOf('--prefix') + 1] : undefined;
const maxLength = argv.includes('--len') ? Number(argv[argv.indexOf('--len') + 1]) : 160;

const bytes = new Uint8Array(readFileSync(path));
const deframer = new SbfDeframer({ crcMode: 'validate' });
const frames = [...deframer.push(bytes)];
deframer.end();

let shown = 0;
for (const [index, frame] of frames.entries()) {
  if (frame.kind !== 'text') continue;
  const text = frame.prefix + frame.text;
  if (prefix && !text.startsWith(prefix)) continue;
  console.log(`frame ${index} @${frame.offset} len ${text.length}: ${JSON.stringify(text.slice(0, maxLength))}`);
  shown += 1;
  if (shown >= limit) break;
}
