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
 * Supported so far: ASCII (byte-identical to the suite), abbreviated ASCII (byte-identical for the
 * binary records below `abbrev-log.ts`'s known gaps, text records matching line for line) and
 * BINARY (verbatim copy of the accepted records).
 *
 * Two byte-level facts this file owns, both measured against the suite:
 *
 *  - the ASCII-family files are written **latin1**, not UTF-8. `%c` prints one raw byte — BESTUTM's
 *    `zone_letter` is written as the byte itself, and a value >= 0x80 would become two bytes under
 *    `writeFileSync(file, string)`'s default UTF-8, silently breaking the file;
 *  - `PASSTHROUGH` (1342) is a port-forwarding record the suite parses and then writes to no output
 *    at all, so it never reaches a converted file — not even BINARY, where every other accepted
 *    record is copied verbatim.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame, type SbfFrame } from '../../protocol/src/framing.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import { buildRangePayload, decodeRangeCmp2, decodeRangeCmp4, lockTimeCarry } from '../../protocol/src/rangecmp.ts';
import { abbrevTextLogLines, textLogLines } from '../../protocol/src/text-log.ts';
import { encodeAbbrevLines, encodeBinaryCapture } from '../../protocol/src/abbrev-log.ts';
import { buildKml, type KmlPoint } from '../../protocol/src/kml.ts';
import { buildRinex21Obs } from '../../protocol/src/rinex21.ts';
import { buildRinex21GloNav, buildRinex21Nav } from '../../protocol/src/rinex21-nav.ts';
import { buildRinex3Obs, type Rinex3Version } from '../../protocol/src/rinex3.ts';
import { buildRinex3EmptyNav, buildRinex3Nav, rinex3NavSystems, RINEX3_NAV_EXTENSIONS } from '../../protocol/src/rinex3-nav.ts';
import { buildSummary, formatDirectory, formatExtension } from '../../protocol/src/summary.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import { decodeEdie } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

const FORMATS = new Set(['ASCII', 'ABBREV_ASCII', 'BINARY', 'KML', 'RINEX21', 'RINEX301', 'RINEX302', 'RINEX303', 'RINEX304']);

/** `PASSTHROUGH`: the receiver's port-forwarding record. The suite parses it and writes nothing. */
const PASSTHROUGH_ID = 1342;

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Encode one output file. The suite's ASCII-family files are byte streams — `%c` puts one raw byte
 * on the wire — so `latin1` is the encoding that reproduces them, where `writeFileSync(file,
 * string)`'s UTF-8 would widen anything >= 0x80. A character above U+00FF cannot have come from
 * that byte stream, so it is an error rather than a silent truncation.
 */
function latin1Bytes(text: string, name: string): Buffer {
  const bytes = Buffer.from(text, 'latin1');
  if (bytes.length !== text.length) {
    const at = [...text].findIndex((char) => char.charCodeAt(0) > 0xff);
    throw new Error(`${name}: U+${text.charCodeAt(at).toString(16).toUpperCase()} at ${at} is not a latin1 byte`);
  }
  return bytes;
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
  const frames: Frame[] = [];
  for (const frame of new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(inputBytes))) {
    frames.push(frame);
    if (frame.kind === 'sbf') all.push(frame);
  }

  // `PASSTHROUGH` is not a log as far as Convert is concerned: it is parsed and dropped, so it must
  // not surface in any output (BINARY included) or in the summary's per-log counts.
  const isPassthrough = (frame: SbfFrame): boolean => frame.header.messageId === PASSTHROUGH_ID;
  const passthrough = all.filter(isPassthrough);
  const converted = all.filter((frame) => !isPassthrough(frame));

  const accepted = converted.filter((frame) => frame.crcOk);
  const outputRoot = outRoot ? resolve(outRoot) : join(dirname(inputPath), 'converted');
  const convertedDir = join(outputRoot, base, `Converted_On_${stamp(at)}`);
  const formatDir = join(convertedDir, formatDirectory(format));
  mkdirSync(formatDir, { recursive: true });

  const yy = String(at.getFullYear() % 100).padStart(2, '0');
  const outputs: Array<{ name: string; data: Uint8Array | string }> = [];
  if (format === 'ASCII') {
    // Text records (the receiver's own ASCII logs mixed into the capture) go out in capture order
    // too, so the frame list — not `accepted` — drives the loop. See `protocol/src/text-log.ts`.
    const textLines = textLogLines(frames, tables);
    const rangeCarry2 = lockTimeCarry();
    const rangeCarry4 = lockTimeCarry();
    const lines: string[] = [];
    frames.forEach((frame, index) => {
      const text = textLines.get(index);
      if (text !== undefined) {
        lines.push(text);
        return;
      }
      if (frame.kind !== 'sbf' || !frame.crcOk) return;
      if (isPassthrough(frame)) return;
      // Convert unpacks RANGECMP2/4 into ordinary RANGE rows (b2: 699 RANGEA = 638 + 31 + 30);
      // rebuild a RANGE payload and let the normal writer print it.
      if (frame.header.messageId === 1273 || frame.header.messageId === 2050) {
        const cmp2 = frame.header.messageId === 1273;
        const observations = cmp2
          ? decodeRangeCmp2(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: rangeCarry2 })
          : decodeRangeCmp4(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: rangeCarry4 });
        const rangeLayout = tables.messages['43'];
        if (!rangeLayout) return;
        const line = encodeAsciiLog(
          { ...frame, payload: buildRangePayload(observations) },
          rangeLayout,
          tables,
        );
        if (line) lines.push(line);
        return;
      }
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) return;
      const line = encodeAsciiLog(frame, layout, tables);
      if (line) lines.push(line);
    });
    outputs.push({ name: `${base}.ASCII`, data: `${lines.join('\r\n')}\r\n` });
  } else if (format === 'ABBREV_ASCII') {
    // Text records are records like any other: the suite re-renders them into abbreviated ASCII in
    // capture order, so `frames` — not `accepted` — drives this loop too, exactly as in the ASCII
    // branch (`protocol/src/text-log.ts#abbrevTextLogLines`). Measured on
    // `golden-b1-20261101.ABBREV_ASCII`: the capture's 99 text records add 39 BESTPOS, 26 RANGE,
    // 24 SATVIS2, 6 RXSTATUS, 2 TIMESYNC and 2 HWMONITOR records, one record per text header line.
    const textLines = abbrevTextLogLines(frames, tables);
    const rangeCarry2 = lockTimeCarry();
    const rangeCarry4 = lockTimeCarry();
    const lines: string[] = [];
    frames.forEach((frame, index) => {
      const text = textLines.get(index);
      if (text !== undefined) {
        lines.push(...text);
        return;
      }
      if (frame.kind !== 'sbf' || !frame.crcOk) return;
      if (isPassthrough(frame)) return;
      // RANGECMP2/4 expand into ordinary `<RANGE` records here too: `golden-b2-20261101.ABBREV_ASCII`
      // counts 638 RANGE in, 699 out, with RANGECMP2 (31) and RANGECMP4 (30) at zero — the same
      // unpacking the ASCII branch does.
      if (frame.header.messageId === 1273 || frame.header.messageId === 2050) {
        const observations = frame.header.messageId === 1273
          ? decodeRangeCmp2(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: rangeCarry2 })
          : decodeRangeCmp4(frame.payload, { epochMs: frame.header.milliseconds, lockCarry: rangeCarry4 });
        const rangeLayout = tables.messages['43'];
        if (!rangeLayout) return;
        lines.push(...encodeAbbrevLines({ ...frame, payload: buildRangePayload(observations) }, rangeLayout, tables));
        return;
      }
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) return;
      lines.push(...encodeAbbrevLines(frame, layout, tables));
    });
    outputs.push({ name: `${base}.ABBREV_ASCII`, data: `${lines.join('\r\n')}\r\n` });
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
    outputs.push({ name: `${base}_BESTPOS.KML`, data: buildKml(points, { name: `${base}_BESTPOS` }) });
  } else if (format === 'RINEX21') {
    outputs.push({ name: `${base}.${yy}O`, data: buildRinex21Obs(accepted, tables, { builtAt: at }) });
    outputs.push({ name: `${base}.${yy}N`, data: buildRinex21Nav(accepted, tables, { builtAt: at }) });
    outputs.push({ name: `${base}.${yy}G`, data: buildRinex21GloNav({ builtAt: at }) });
  } else if (format.startsWith('RINEX30')) {
    // `RINEX301` -> `3.01`. The offsets are 5 and 6 (the `3` of `RINEX3` is at index 5); slicing from
    // 6 would build `0.1`, which is not a version and used to slip through into the `.YYO` header.
    const version = `${format.slice(5, 6)}.${format.slice(6)}` as Rinex3Version;
    outputs.push({ name: `${base}.${yy}O`, data: buildRinex3Obs(accepted, tables, version, { builtAt: at }) });
    outputs.push({ name: `${base}.${yy}N`, data: buildRinex3Nav(accepted, tables, version, { builtAt: at }) });
    // One header-only nav file per constellation the version supports (the set grows from 3.01 to
    // 3.03); none of these captures carries a non-GPS ephemeris, so they are all bare headers.
    for (const system of rinex3NavSystems(version)) {
      outputs.push({ name: `${base}.${yy}${RINEX3_NAV_EXTENSIONS[system]}`, data: buildRinex3EmptyNav(system, version, { builtAt: at }) });
    }
  } else {
    outputs.push({ name: `${base}.BINARY`, data: encodeBinaryCapture(accepted).bytes });
  }

  const written: string[] = [];
  for (const output of outputs) {
    const file = join(formatDir, output.name);
    // `latin1`, not the `writeFileSync(file, string)` default of UTF-8: the ASCII-family formats
    // carry raw bytes (`%c` prints one byte), and UTF-8 would widen anything >= 0x80 to two bytes.
    writeFileSync(file, typeof output.data === 'string' ? latin1Bytes(output.data, output.name) : output.data);
    written.push(file);
  }

  // Per-log record counts for the summary table.
  const counts = new Map<number, { name: string; source: number; output: number }>();
  for (const frame of converted) {
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
  for (const file of written) console.log(`output    : ${file} (${statSync(file).size} bytes)`);
  console.log(`summary   : ${join(convertedDir, `Summary_${base}.txt`)}`);
  console.log(
    `dropped   : ${converted.length - accepted.length} (bad CRC)`
    + (passthrough.length ? `, ${passthrough.length} PASSTHROUGH (not a converted log)` : ''),
  );
}

main();
