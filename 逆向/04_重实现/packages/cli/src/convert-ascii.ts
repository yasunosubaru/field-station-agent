/**
 * Convert a binary SBF capture into the suite's ASCII log format.
 *
 *   node packages/cli/src/convert-ascii.ts <capture.bin> [-o <out.ASCII>]
 *
 * The output is the same text `NovAtelApplicationSuite.exe -a <capture>` produces: same header,
 * same field order and precision, same trailing CRC. Records with a mismatching CRC are dropped,
 * as Convert does (see the `ascii-log.ts` header for why that differs from the view parser).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame } from '../../protocol/src/framing.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import { textLogLines } from '../../protocol/src/text-log.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

function main(): void {
  const argv = process.argv.slice(2);
  let capture = '';
  let output = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') output = argv[++i];
    else if (!argv[i].startsWith('-')) capture = argv[i];
  }
  if (!capture) {
    console.error('usage: convert-ascii.ts <capture.bin> [-o <out.ASCII>]');
    process.exit(2);
  }

  const tables = JSON.parse(readFileSync(join(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;
  const bytes = new Uint8Array(readFileSync(capture));

  const frames: Frame[] = [];
  for (const frame of new SbfDeframer({ crcMode: 'validate' }).push(bytes)) frames.push(frame);

  // Text records (the receiver's own ASCII logs) are converted too, in capture order.
  const textLines = textLogLines(frames, tables);
  const lines: string[] = [];
  let skippedUnknown = 0;
  let skippedCrc = 0;
  for (const [index, frame] of frames.entries()) {
    const text = textLines.get(index);
    if (text !== undefined) {
      lines.push(text);
      continue;
    }
    if (frame.kind !== 'sbf') continue;
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) {
      skippedUnknown += 1;
      continue;
    }
    const line = encodeAsciiLog(frame, layout, tables);
    if (!line) {
      skippedCrc += 1;
      continue;
    }
    lines.push(line);
  }

  const text = `${lines.join('\r\n')}\r\n`;
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);

  console.error(`records: ${lines.length}   dropped (bad CRC): ${skippedCrc}   dropped (no layout): ${skippedUnknown}`);
}

main();
