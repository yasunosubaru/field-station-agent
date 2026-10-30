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
 * Supported so far: ASCII (byte-identical to the suite), abbreviated ASCII (byte-identical) and
 * BINARY (verbatim copy of the accepted records).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type SbfFrame } from '../../protocol/src/framing.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import { encodeAbbrevLines, encodeBinaryCapture } from '../../protocol/src/abbrev-log.ts';
import { buildKml, type KmlPoint } from '../../protocol/src/kml.ts';
import { buildRinex21Obs } from '../../protocol/src/rinex21.ts';
import { buildSummary, formatDirectory, formatExtension } from '../../protocol/src/summary.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import { decodeEdie } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

const FORMATS = new Set(['ASCII', 'ABBREV_ASCII', 'BINARY', 'KML', 'RINEX21']);

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
  if (!input || !FORMATS.has(format)) {
    console.error('usage: convert.ts <input> --to ASCII|ABBREV_ASCII|BINARY [--out <dir>] [--at ISO]');
    process.exit(2);
  }

  const inputPath = resolve(input);
  const inputBytes = readFileSync(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const tables = JSON.parse(readFileSync(join(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;

  const all: SbfFrame[] = [];
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(inputBytes))) {
    if (frame.kind === 'sbf') all.push(frame);
  }

  const accepted = all.filter((frame) => frame.crcOk);
  const outputRoot = outRoot ? resolve(outRoot) : join(dirname(inputPath), 'converted');
  const convertedDir = join(outputRoot, base, `Converted_On_${stamp(at)}`);
  const formatDir = join(convertedDir, formatDirectory(format));
  mkdirSync(formatDir, { recursive: true });

  let payload: Uint8Array | string;
  if (format === 'ASCII') {
    const lines: string[] = [];
    for (const frame of accepted) {
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) continue;
      const line = encodeAsciiLog(frame, layout, tables);
      if (line) lines.push(line);
    }
    payload = `${lines.join('\r\n')}\r\n`;
  } else if (format === 'ABBREV_ASCII') {
    const lines: string[] = [];
    for (const frame of accepted) {
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) continue;
      lines.push(...encodeAbbrevLines(frame, layout, tables));
    }
    payload = `${lines.join('\r\n')}\r\n`;
  } else if (format === 'KML') {
    const points: KmlPoint[] = [];
    for (const frame of accepted) {
      if (frame.header.messageId !== 42) continue; // BESTPOS is the only position log Convert maps
      const values = decodeEdie(frame.payload, tables.messages['42'], tables);
      const get = (path: string) => values.find((value) => value.path === path);
      points.push({
        week: frame.header.week,
        milliseconds: frame.header.milliseconds,
        latitude: Number(get('latitude')?.value),
        longitude: Number(get('longitude')?.value),
        height: Number(get('orthometric_height')?.value),
        latitudeDeviation: Number(get('latitude_std_dev')?.value),
        longitudeDeviation: Number(get('longitude_std_dev')?.value),
        heightDeviation: Number(get('height_std_dev')?.value),
        positionType: String(get('position_type')?.text),
      });
    }
    payload = buildKml(points, { name: `${base}_BESTPOS` });
  } else if (format === 'RINEX21') {
    payload = buildRinex21Obs(accepted, tables, { builtAt: at });
  } else {
    payload = encodeBinaryCapture(accepted).bytes;
  }

  // KML names the file after the message it maps (`<base>_BESTPOS.KML`); RINEX uses `<base>.<yy>O`;
  // everything else is named after the input file.
  const outputBase = format === 'KML' ? `${base}_BESTPOS` : base;
  const extension = format === 'RINEX21' ? `${String(at.getFullYear() % 100).padStart(2, '0')}O` : formatExtension(format);
  const outputFile = join(formatDir, `${outputBase}.${extension}`);
  writeFileSync(outputFile, payload);

  // Per-log record counts for the summary table.
  const counts = new Map<number, { name: string; source: number; output: number }>();
  for (const frame of all) {
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) continue;
    const entry = counts.get(frame.header.messageId) ?? { name: layout.name, source: 0, output: 0 };
    entry.source += 1;
    if (frame.crcOk) entry.output += 1;
    counts.set(frame.header.messageId, entry);
  }
  const summary = buildSummary(
    {
      fileName: basename(inputPath),
      bytes: statSync(inputPath).size,
      inputDirectory: dirname(inputPath),
      outputDirectory: join(outputRoot, base),
      formatName: formatDirectory(format),
      frames: accepted,
      completedAt: at,
    },
    counts,
  );
  writeFileSync(join(convertedDir, `Summary_${base}.txt`), summary);

  console.log(`input     : ${inputPath} (${inputBytes.byteLength} bytes, ${all.length} records)`);
  console.log(`format    : ${format}`);
  console.log(`output    : ${outputFile} (${statSync(outputFile).size} bytes)`);
  console.log(`summary   : ${join(convertedDir, `Summary_${base}.txt`)}`);
  console.log(`dropped   : ${all.length - accepted.length} (bad CRC)`);
}

main();
