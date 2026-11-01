/**
 * Convert a capture to the suite's output layout.
 *
 *   node packages/cli/src/convert.ts <input> --to ASCII|ABBREV_ASCII|BINARY [--out <dir>] [--at ISO]
 *
 * Output layout, matching `samples/convert/golden-*` exactly:
 *
 *   <out>/<name>/Converted_On_<YYYYMMDD>_T<HHMM>/<FORMAT_DIR>/<name>.<EXT>
 *   <out>/<name>/Converted_On_<YYYYMMDD>_T<HHMM>/Summary_<name>.txt
 *
 * The conversion itself — frame filtering, `PASSTHROUGH`, the RANGECMP2/4 unpacking, text records,
 * the latin1 byte encoding — lives in `protocol/src/convert-pipeline.ts`, shared with the app's
 * Convert panel. This file only parses arguments, decides where the files go, and writes them.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame } from '../../protocol/src/framing.ts';
import { convertFrames, isConvertFormat, type ConvertFormat } from '../../protocol/src/convert-pipeline.ts';
import { buildSummary, formatDirectory } from '../../protocol/src/summary.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  let input = '';
  let format = 'ASCII';
  let outRoot = '';
  let at = new Date();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--to' || token === '-t') format = String(argv[++i]).toUpperCase();
    else if (token === '--out' || token === '-o') outRoot = argv[++i];
    else if (token === '--at') at = new Date(argv[++i]);
    else if (!token.startsWith('-')) input = token;
  }
  if (!input || !isConvertFormat(format)) {
    console.error('usage: convert.ts <input> --to ASCII|ABBREV_ASCII|BINARY [--out <dir>] [--at ISO]');
    process.exit(2);
  }

  const inputPath = resolve(input);
  const inputBytes = readFileSync(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const tables = JSON.parse(readFileSync(join(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;

  // `validate`, not the view's `mirror`: Convert drops a record whose CRC does not match and keeps
  // scanning inside it, so a damaged capture splits into a different frame list (b1: 1325 SBF frames
  // here, 1322 under `mirror`). Text records are frames too — they are converted, in capture order.
  const frames: Frame[] = [
    ...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(inputBytes)),
  ];
  const outcome = convertFrames(frames, { format: format as ConvertFormat, at, tables, name: basename(inputPath) });

  const outputRoot = outRoot ? resolve(outRoot) : join(dirname(inputPath), 'converted');
  const convertedDir = join(outputRoot, base, `Converted_On_${stamp(at)}`);
  const formatDir = join(convertedDir, formatDirectory(format));
  mkdirSync(formatDir, { recursive: true });

  const written: string[] = [];
  for (const output of outcome.files) {
    const file = join(formatDir, output.name);
    // `output.bytes` is already a byte stream (`latin1Bytes`): the ASCII-family formats carry raw
    // bytes (`%c` prints one byte), and UTF-8 would widen anything >= 0x80 to two.
    writeFileSync(file, output.bytes);
    written.push(file);
  }

  const summary = buildSummary(
    {
      fileName: basename(inputPath),
      bytes: statSync(inputPath).size,
      inputDirectory: dirname(inputPath),
      outputDirectory: join(outputRoot, base),
      formatName: formatDirectory(format),
      frames: outcome.accepted,
      completedAt: at,
    },
    outcome.counts,
  );
  writeFileSync(join(convertedDir, `Summary_${base}.txt`), summary);

  console.log(`input     : ${inputPath} (${inputBytes.byteLength} bytes, ${outcome.all.length} records)`);
  console.log(`format    : ${format}`);
  for (const file of written) console.log(`output    : ${file} (${statSync(file).size} bytes)`);
  console.log(`summary   : ${join(convertedDir, `Summary_${base}.txt`)}`);
  console.log(
    `dropped   : ${outcome.converted.length - outcome.accepted.length} (bad CRC)`
    + (outcome.passthrough.length ? `, ${outcome.passthrough.length} PASSTHROUGH (converted like any other log)` : ''),
  );
}

main();
