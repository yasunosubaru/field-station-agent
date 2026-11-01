/**
 * Convert, as a pipeline: capture frames in, the files the suite writes out.
 *
 * There is exactly **one** implementation. `packages/cli/src/convert.ts` writes the files and the
 * summary to disk, `packages/app/src/convert.ts` previews and downloads the first one; neither knows
 * how a `RANGECMP2` becomes a `#RANGE` line. Before this file existed both had their own copy and
 * the GUI's had drifted: it wrote UTF-8 instead of latin1 (every `%c` byte >= 0x80 gained a byte),
 * it kept `PASSTHROUGH` (1342), and it dropped text records and the RANGECMP expansion entirely.
 *
 * The four byte-level rules the suite imposes, all measured against it and all owned here:
 *
 *  - **only CRC-good records are written** (`accepted`); Convert validates where the view's
 *    `genericparser.js` only drops zero-CRC fields;
 *  - **`PASSTHROUGH` (1342) reaches no output at all** — not ASCII, not abbreviated ASCII, not
 *    BINARY, and not the summary's per-log counts. The suite parses the port-forwarding record and
 *    writes nothing for it;
 *  - **`RANGECMP2/4` are unpacked into `RANGE` rows** (b2: 638 RANGE in, 699 out) with the per-signal
 *    lock-time carry shared across consecutive blocks, so the printed lock times keep growing;
 *  - **text records are records**: the receiver's own ASCII logs mixed into the capture are
 *    re-rendered in capture order, one line per record in ASCII and one block per record in
 *    abbreviated ASCII — so the frame list, not `accepted`, drives both text branches.
 *
 * Text output is a byte stream: `%c` prints one raw byte (BESTUTM's `zone_letter`), so the files
 * are encoded with `ascii-log.ts#latin1Bytes` — one byte per character below U+0100 — and never
 * UTF-8, which would widen 0xC8 to `C3 88`. BINARY is the verbatim accepted records, in order.
 */

import { decodeEdie, type EdieTables } from './edie.ts';
import type { Frame, SbfFrame } from './framing.ts';
import { encodeAbbrevLines, encodeBinaryCapture } from './abbrev-log.ts';
import { encodeAsciiLog, latin1Bytes } from './ascii-log.ts';
import { buildKml, type KmlPoint } from './kml.ts';
import { buildRangePayload, decodeRangeCmp2, decodeRangeCmp4, lockTimeCarry } from './rangecmp.ts';
import { buildRinex21Obs } from './rinex21.ts';
import { buildRinex21GloNav, buildRinex21Nav } from './rinex21-nav.ts';
import { buildRinex3Obs, type Rinex3Version } from './rinex3.ts';
import { RINEX3_NAV_EXTENSIONS, buildRinex3EmptyNav, buildRinex3Nav, rinex3NavSystems } from './rinex3-nav.ts';
import { formatDirectory } from './summary.ts';
import { abbrevTextLogLines, textLogLines } from './text-log.ts';

export const CONVERT_FORMATS = [
  'ASCII',
  'ABBREV_ASCII',
  'BINARY',
  'KML',
  'RINEX21',
  'RINEX301',
  'RINEX302',
  'RINEX303',
  'RINEX304',
] as const;

export type ConvertFormat = (typeof CONVERT_FORMATS)[number];

export function isConvertFormat(value: unknown): value is ConvertFormat {
  return typeof value === 'string' && (CONVERT_FORMATS as readonly string[]).includes(value.toUpperCase());
}

/** `PASSTHROUGH`: the receiver's port-forwarding record. The suite parses it and writes nothing. */
export const PASSTHROUGH_ID = 1342;

/** Compressed observation logs Convert unpacks into ordinary `RANGE` rows. */
const RANGECMP2_ID = 1273;
const RANGECMP4_ID = 2050;

export interface ConvertOptions {
  format: ConvertFormat;
  /** Conversion timestamp: the `Converted_On_…` stamp and the RINEX header date. */
  at: Date;
  tables: EdieTables;
  /**
   * Input file name as the user sees it (`b1-20261101.sbf`). Output names use `<base>` — the name
   * with its last extension removed — exactly as `basename(path, extname(path))` does in the CLI.
   */
  name: string;
}

/** One output file. `text` is null for BINARY; `bytes` is always what goes on disk. */
export interface ConvertFile {
  name: string;
  text: string | null;
  bytes: Uint8Array;
}

export interface ConvertOutcome {
  format: ConvertFormat;
  /** The suite's directory for this format, e.g. `RINEXv2_1`. */
  formatDirectory: string;
  /** `<input name>` with its last extension removed. */
  base: string;
  /** In the order the CLI writes them; the first one is the log the GUI previews. */
  files: ConvertFile[];
  /** Every SBF record in capture order, `PASSTHROUGH` included, text records excluded. */
  all: SbfFrame[];
  /** The `PASSTHROUGH` records, which no output and no summary count carries. */
  passthrough: SbfFrame[];
  /** `all` without the passthrough records. */
  converted: SbfFrame[];
  /** `converted` with a matching CRC — the records that are actually written. */
  accepted: SbfFrame[];
  /** Source/output per log id, for the summary table (`summary.ts#buildSummary`). */
  counts: Map<number, { name: string; source: number; output: number }>;
}

/**
 * `<base>` as the suite and the CLI define it: the last `.extension` removed, but only when there
 * is a stem in front of it (`basename('.hidden', '')` stays `.hidden`).
 */
export function captureBase(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function textFile(name: string, text: string): ConvertFile {
  return { name, text, bytes: latin1Bytes(text) };
}

/** One `\r\n`-terminated document from a list of lines (`ASCII`, `ABBREV_ASCII`). */
function lineFile(name: string, lines: readonly string[]): ConvertFile {
  return textFile(name, `${lines.join('\r\n')}\r\n`);
}

function isPassthrough(frame: SbfFrame): boolean {
  return frame.header.messageId === PASSTHROUGH_ID;
}

function isRangeCmp(frame: SbfFrame): boolean {
  return frame.header.messageId === RANGECMP2_ID || frame.header.messageId === RANGECMP4_ID;
}

/** Unpack one RANGECMP2/4 block into the observations a `RANGE` payload is rebuilt from. */
function unpackRangeCmp(
  frame: SbfFrame,
  carry: { cmp2: ReturnType<typeof lockTimeCarry>; cmp4: ReturnType<typeof lockTimeCarry> },
) {
  const epochMs = frame.header.milliseconds;
  return frame.header.messageId === RANGECMP2_ID
    ? decodeRangeCmp2(frame.payload, { epochMs, lockCarry: carry.cmp2 })
    : decodeRangeCmp4(frame.payload, { epochMs, lockCarry: carry.cmp4 });
}

/**
 * ASCII and abbreviated ASCII walk the **frame list**, not `accepted`: a text record sits at its own
 * index and is printed there, and a `RANGECMP2/4` record prints as the `RANGE` rows it unpacks to.
 */
function textLinesFor(
  frames: readonly Frame[],
  tables: EdieTables,
  textAt: Map<number, string | string[]>,
  render: (frame: SbfFrame, layout: EdieTables['messages'][string]) => readonly string[],
): string[] {
  const rangeLayout = tables.messages['43'];
  const carry = { cmp2: lockTimeCarry(), cmp4: lockTimeCarry() };
  const lines: string[] = [];
  frames.forEach((frame, index) => {
    const text = textAt.get(index);
    if (text !== undefined) {
      // ASCII prints one line per text record; abbreviated ASCII one whole block per record.
      if (Array.isArray(text)) lines.push(...text);
      else lines.push(text);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    if (isPassthrough(frame)) return;
    if (isRangeCmp(frame)) {
      if (!rangeLayout) return;
      // `Convert` unpacks the compressed block into ordinary RANGE rows and lets the normal writer
      // print them: b2's 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 become 699 RANGE lines.
      const unpacked = { ...frame, payload: buildRangePayload(unpackRangeCmp(frame, carry)) };
      lines.push(...render(unpacked, rangeLayout));
      return;
    }
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    lines.push(...render(frame, layout));
  });
  return lines;
}

/** `Summary_<name>.txt`'s table, restricted to records Convert maps (no text, no passthrough). */
export function countLogs(
  converted: readonly SbfFrame[],
  tables: EdieTables,
): Map<number, { name: string; source: number; output: number }> {
  const counts = new Map<number, { name: string; source: number; output: number }>();
  for (const frame of converted) {
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) continue;
    const entry = counts.get(frame.header.messageId) ?? { name: layout.name, source: 0, output: 0 };
    entry.source += 1;
    if (frame.crcOk) entry.output += 1;
    counts.set(frame.header.messageId, entry);
  }
  return counts;
}

/**
 * Build every file Convert writes for one capture.
 *
 * `frames` must be the frames **Convert** sees: `SbfDeframer({crcMode: 'validate'})`, text records
 * included. The app's view parser uses `mirror` mode, which keeps a nonzero-CRC record whatever its
 * CRC and therefore splits a damaged capture differently (b1: 1322 binary frames there, 1325 here),
 * so it passes a separate frame list — see `app/src/capture.ts#CaptureData.allFrames`.
 */
export function convertFrames(frames: readonly Frame[], options: ConvertOptions): ConvertOutcome {
  const { format, at, tables, name } = options;
  const base = captureBase(name);

  const all = frames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const passthrough = all.filter(isPassthrough);
  const converted = all.filter((frame) => !isPassthrough(frame));
  const accepted = converted.filter((frame) => frame.crcOk);

  const yy = String(at.getFullYear() % 100).padStart(2, '0');
  const files: ConvertFile[] = [];

  if (format === 'ASCII') {
    const lines = textLinesFor(frames, tables, textLogLines(frames, tables), (frame, layout) => {
      const line = encodeAsciiLog(frame, layout, tables);
      return line ? [line] : [];
    });
    files.push(lineFile(`${base}.ASCII`, lines));
  } else if (format === 'ABBREV_ASCII') {
    const lines = textLinesFor(frames, tables, abbrevTextLogLines(frames, tables), (frame, layout) => encodeAbbrevLines(frame, layout, tables));
    files.push(lineFile(`${base}.ABBREV_ASCII`, lines));
  } else if (format === 'KML') {
    const points: KmlPoint[] = [];
    for (const frame of accepted) {
      if (frame.header.messageId !== 42) continue; // BESTPOS is the only position log Convert maps
      const layout = tables.messages['42'];
      if (!layout) continue;
      const values = decodeEdie(frame.payload, layout, tables);
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
    files.push(textFile(`${base}_BESTPOS.KML`, buildKml(points, { name: `${base}_BESTPOS` })));
  } else if (format === 'RINEX21') {
    files.push(textFile(`${base}.${yy}O`, buildRinex21Obs(accepted, tables, { builtAt: at })));
    files.push(textFile(`${base}.${yy}N`, buildRinex21Nav(accepted, tables, { builtAt: at })));
    files.push(textFile(`${base}.${yy}G`, buildRinex21GloNav({ builtAt: at })));
  } else if (format.startsWith('RINEX30')) {
    // `RINEX301` -> `3.01`. The offsets are 5 and 6 (the `3` of `RINEX3` is at index 5); slicing from
    // 6 would build `0.1`, which is not a version and used to slip through into the `.YYO` header.
    const version = `${format.slice(5, 6)}.${format.slice(6)}` as Rinex3Version;
    files.push(textFile(`${base}.${yy}O`, buildRinex3Obs(accepted, tables, version, { builtAt: at })));
    files.push(textFile(`${base}.${yy}N`, buildRinex3Nav(accepted, tables, version, { builtAt: at })));
    // One header-only nav file per constellation the version supports (the set grows from 3.01 to
    // 3.03); none of these captures carries a non-GPS ephemeris, so they are all bare headers.
    for (const system of rinex3NavSystems(version)) {
      files.push(textFile(
        `${base}.${yy}${RINEX3_NAV_EXTENSIONS[system]}`,
        buildRinex3EmptyNav(system, version, { builtAt: at }),
      ));
    }
  } else {
    files.push({ name: `${base}.BINARY`, text: null, bytes: encodeBinaryCapture(accepted).bytes });
  }

  return {
    format,
    formatDirectory: formatDirectory(format),
    base,
    files,
    all,
    passthrough,
    converted,
    accepted,
    counts: countLogs(converted, tables),
  };
}
