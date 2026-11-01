/**
 * Convert a binary SBF capture into the suite's ASCII log format, on stdout or into one file.
 *
 *   node packages/cli/src/convert-ascii.ts <capture.bin> [-o <out.ASCII>]
 *
 * The output is the same bytes `NovAtelApplicationSuite.exe -a <capture>` and
 * `convert.ts --to ASCII` produce: same header, same field order and precision, same trailing CRC,
 * text records in capture order, RANGECMP2/4 unpacked, bad-CRC records dropped. The conversion is
 * `protocol/src/convert-pipeline.ts` — this file only handles the command line and the sink.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame } from '../../protocol/src/framing.ts';
import { convertFrames } from '../../protocol/src/convert-pipeline.ts';
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
  const frames: Frame[] = [
    ...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(capture))),
  ];
  const outcome = convertFrames(frames, { format: 'ASCII', at: new Date(), tables, name: basename(capture) });
  const file = outcome.files[0];
  const bytes = Buffer.from(file.bytes);

  if (output) writeFileSync(output, bytes);
  else process.stdout.write(bytes);

  const lines = file.text ? file.text.split('\r\n').length - 1 : 0;
  const skippedCrc = outcome.converted.length - outcome.accepted.length;
  // Records whose layout the dictionary does not carry reach no output either; `PASSTHROUGH` is
  // dropped before that lookup, as in `convert.ts`.
  const skippedUnknown = outcome.converted.filter((frame) => !tables.messages[String(frame.header.messageId)]).length;
  console.error(`records: ${lines}   dropped (bad CRC): ${skippedCrc}   dropped (no layout): ${skippedUnknown}`);
}

main();
