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
import { convertFrames, isConvertFormat, type ConvertFormat, type UnknownBytesMode } from '../../protocol/src/convert-pipeline.ts';
import { buildSummary, formatDirectory } from '../../protocol/src/summary.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

/**
 * `--start-time` / `--finish-time` / `--limit-duration` (user manual 4.5.4).
 *
 * The window is applied to the SBF records by their own GPS stamp. A text record carries no stamp,
 * so it survives only when its position in the capture sits between the first and the last kept
 * record — capture order is the only time information it has. WEEK `0` means "the week of the first
 * log", as the manual says.
 */
function applyTimeWindow(
  frames: Frame[],
  startTime: { week: number; seconds: number } | undefined,
  finishTime: { week: number; seconds: number } | undefined,
  limitDuration: number | undefined,
): Frame[] {
  if (!startTime && !finishTime && !Number.isFinite(limitDuration)) return frames;
  const sbf = frames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  if (!sbf.length) return frames;
  const firstWeek = sbf[0].header.week;
  const absolute = (week: number, seconds: number) => week * 604_800_000 + seconds * 1000;
  // The anchor is the first record that carries an **observation** time: `SATTIME` records hold an
  // almanac's reference epoch (b2's first record is `ALMANAC 577140.000`, while the file really
  // starts at 577758.950 — the same rule the suite's own Summary uses).
  const anchor = sbf.find((frame) => frame.header.timeStatus !== 200) ?? sbf[0];
  const firstStamp = absolute(anchor.header.week, anchor.header.milliseconds / 1000);
  const from = startTime
    ? absolute(startTime.week || firstWeek, startTime.seconds)
    : Number.isFinite(limitDuration)
      ? firstStamp
      : -Infinity;
  let to = finishTime ? absolute(finishTime.week || firstWeek, finishTime.seconds) : Infinity;
  if (Number.isFinite(limitDuration)) to = Math.min(to, from + (limitDuration as number) * 1000);

  let firstIndex = -1;
  let lastIndex = -1;
  const keep = frames.map((frame, index) => {
    if (frame.kind !== 'sbf') return false;
    const stamp = absolute(frame.header.week, frame.header.milliseconds / 1000);
    const inside = stamp >= from && stamp <= to;
    if (inside) {
      if (firstIndex < 0) firstIndex = index;
      lastIndex = index;
    }
    return inside;
  });
  if (firstIndex < 0) return [];
  return frames.filter((frame, index) =>
    keep[index] || (frame.kind !== 'sbf' && index > firstIndex && index < lastIndex));
}

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
  let split = false;
  /** `--start-time=<WEEK>,<SECONDS>` / `--finish-time=` / `--limit-duration=<SECONDS>`. */
  let startTime: { week: number; seconds: number } | undefined;
  let finishTime: { week: number; seconds: number } | undefined;
  let limitDuration: number | undefined;
  /** `--unknown-bytes=[file|interleave|ignore]`; anything else is the suite's `SKIP`. */
  let unknownBytes: UnknownBytesMode = 'ignore';
  const unknownMode = (value: string | undefined): UnknownBytesMode => {
    const text = (value ?? '').toLowerCase();
    return text === 'file' ? 'file' : text === 'interleave' ? 'interleave' : 'ignore';
  };
  const weekSeconds = (value: string | undefined): { week: number; seconds: number } | undefined => {
    if (!value) return undefined;
    const [weekText, secondsText] = value.split(',');
    const week = Number(weekText);
    const seconds = Number(secondsText);
    if (!Number.isFinite(week) || !Number.isFinite(seconds)) {
      console.error(`--start-time/--finish-time expects <WEEK>,<SECONDS>, got "${value}"`);
      process.exit(2);
    }
    return { week, seconds };
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--to' || token === '-t') format = String(argv[++i]).toUpperCase();
    else if (token === '--out' || token === '-o') outRoot = argv[++i];
    else if (token === '--at') at = new Date(argv[++i]);
    else if (token === '--split') split = true;
    else if (token.startsWith('--start-time=')) startTime = weekSeconds(token.slice('--start-time='.length));
    else if (token === '--start-time') startTime = weekSeconds(argv[++i]);
    else if (token.startsWith('--finish-time=')) finishTime = weekSeconds(token.slice('--finish-time='.length));
    else if (token === '--finish-time') finishTime = weekSeconds(argv[++i]);
    else if (token.startsWith('--limit-duration=')) limitDuration = Number(token.slice('--limit-duration='.length));
    else if (token === '--limit-duration') limitDuration = Number(argv[++i]);
    else if (token.startsWith('--unknown-bytes=')) unknownBytes = unknownMode(token.slice('--unknown-bytes='.length));
    else if (token === '--unknown-bytes') unknownBytes = unknownMode(argv[++i]);
    else if (!token.startsWith('-')) input = token;
  }
  if (!input || !isConvertFormat(format)) {
    console.error('usage: convert.ts <input> --to ASCII|ABBREV_ASCII|BINARY [--out <dir>] [--at ISO] [--split]'
      + ' [--unknown-bytes=file|interleave|ignore]'
      + ' [--start-time=<WEEK>,<SECONDS>] [--finish-time=<WEEK>,<SECONDS>] [--limit-duration=<SECONDS>]');
    process.exit(2);
  }

  const inputPath = resolve(input);
  const inputBytes = readFileSync(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const tables = JSON.parse(readFileSync(join(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;

  // `validate`, not the view's `mirror`: Convert drops a record whose CRC does not match and keeps
  // scanning inside it, so a damaged capture splits into a different frame list (b1: 1325 SBF frames
  // here, 1322 under `mirror`). Text records are frames too — they are converted, in capture order.
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const capture = new Uint8Array(inputBytes);
  const frames: Frame[] = [...deframer.push(capture)];
  // Trailing bytes that never completed a record are dropped like any other unknown byte.
  deframer.end();
  const windowed = applyTimeWindow(frames, startTime, finishTime, limitDuration);
  // Unknown bytes are measured over the whole capture, so a windowed conversion reports none: the
  // records outside the window are not "unknown", and the suite's own accounting for that
  // combination is unmeasured. Every unwindowed run reports the suite's exact number.
  const source = windowed.length === frames.length ? capture : undefined;
  const outcome = convertFrames(windowed, {
    format: format as ConvertFormat,
    at,
    tables,
    name: basename(inputPath),
    split,
    unknownBytes,
    ...(source ? { source } : {}),
  });

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
      unknownBytes: outcome.unknownCount,
      unConvertedBytes: outcome.unConvertedBytes,
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
