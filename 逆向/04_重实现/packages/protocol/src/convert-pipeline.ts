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
 *  - **`PASSTHROUGH` (1342) is an ordinary converted log**, rendered from the dictionary like any
 *    other: `#PASSTHROUGHA,…;COM3,80,_\x9f\xef…` — port name, byte count, then the payload escaped
 *    per `%P`. b5 carries the first real passthrough record this project has seen and its line is
 *    what corrected this rule (see §9.x.13 in `03_分析/09_EDIE消息字典与ASCII一致性.md`); the
 *    earlier "writes nothing" reading came from a synthetic record whose payload a `%P` count
 *    consumed differently;
 *  - **every RANGECMP variant is unpacked into `RANGE` rows** (b2: 638 RANGE in, 699 out; b5 adds
 *    versions 1, 3 and 5) with a per-signal lock-time carry per log id, so the printed lock times
 *    keep growing;
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
import { buildRangePayload, decodeRangeCmp1, decodeRangeCmp2, decodeRangeCmp4, decodeRangeCmp5, lockTimeCarry } from './rangecmp.ts';
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

/** `PASSTHROUGH`: the receiver's port-forwarding record. Converted like any other log. */
export const PASSTHROUGH_ID = 1342;

/**
 * Compressed observation logs Convert unpacks into ordinary `RANGE` rows.
 *
 * All five compression versions are in the capture now (b5), and Convert maps every one of them the
 * same way: the compressed record prints as the `RANGE` rows it unpacks into and the summary shows
 * its own row as `N in → --`. RANGECMP3 has no table in the OEM7 manual, and its payload is byte for
 * byte the RANGECMP4 payload (measured: 12/12 records in b5), so it decodes with the RANGECMP4
 * reader.
 */
const RANGECMP_IDS = [140, 1273, 1734, 2050, 2537];
/** The ordinary observation log those unpack into. */
const RANGE_ID = 43;

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
  /** The `PASSTHROUGH` records. They are converted like any other log — the field is bookkeeping. */
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
  return RANGECMP_IDS.includes(frame.header.messageId);
}

/** Per-log-id lock-time carry state: each compression version keeps its own. */
type RangeCarries = Map<number, ReturnType<typeof lockTimeCarry>>;

/** Unpack one compressed block into the observations a `RANGE` payload is rebuilt from. */
function unpackRangeCmp(frame: SbfFrame, carries: RangeCarries) {
  const id = frame.header.messageId;
  let carry = carries.get(id);
  if (!carry) {
    carry = lockTimeCarry();
    carries.set(id, carry);
  }
  const options = { epochMs: frame.header.milliseconds, lockCarry: carry };
  if (id === 140) return decodeRangeCmp1(frame.payload, options);
  if (id === 1273) return decodeRangeCmp2(frame.payload, options);
  // 1734 (RANGECMP3) and 2050 (RANGECMP4) are the same payload - see RANGECMP_IDS.
  if (id === 1734 || id === 2050) return decodeRangeCmp4(frame.payload, options);
  return decodeRangeCmp5(frame.payload, options);
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
  /** Per log id, how many output rows it produced (`summary.ts` reports the output, not the input). */
  rendered: Map<number, number> = new Map(),
): string[] {
  const rangeLayout = tables.messages['43'];
  const carries: RangeCarries = new Map();
  const lines: string[] = [];
  const bump = (id: number, count: number) => rendered.set(id, (rendered.get(id) ?? 0) + count);
  frames.forEach((frame, index) => {
    const text = textAt.get(index);
    if (text !== undefined) {
      // ASCII prints one line per text record; abbreviated ASCII one whole block per record.
      if (Array.isArray(text)) lines.push(...text);
      else lines.push(text);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    if (isRangeCmp(frame)) {
      if (!rangeLayout) return;
      // `Convert` unpacks the compressed block into ordinary RANGE rows and lets the normal writer
      // print them: b2's 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 become 699 RANGE lines.
      const observations = unpackRangeCmp(frame, carries);
      const unpacked = { ...frame, payload: buildRangePayload(observations) };
      lines.push(...render(unpacked, rangeLayout));
      // One `RANGE` record per compressed record — its observations are that record's array, not
      // separate rows (b2: 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 → 699 RANGE).
      bump(RANGE_ID, 1);
      return;
    }
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    const produced = render(frame, layout);
    lines.push(...produced);
    // A record that prints nothing (`RXCONFIG` with an embedded message the dictionary lacks) is
    // input but not output — that is why b1's summary reads `RXCONFIG 278 → 256`.
    if (produced.length) bump(frame.header.messageId, 1);
  });
  return lines;
}

/** `Summary_<name>.txt`'s table. Text records are added by `countTextRecords`; `PASSTHROUGH` counts like any other log. */
export function countLogs(
  converted: readonly SbfFrame[],
  tables: EdieTables,
  options: {
    expandRanges?: boolean;
    /** The frame list Convert walked, needed to count the text records that produced no line. */
    frames?: readonly Frame[];
    /** Frame index → the line(s) `text-log.ts` emitted for it. */
    textAt?: Map<number, string | string[]>;
    /** Per-log id row counts from the writer (`textLinesFor`), when the format has one. */
    rendered?: Map<number, number>;
  } = {},
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
  if (options.rendered) {
    // The suite reports what came out: a record that printed nothing (`RXCONFIG` with an embedded
    // message the dictionary lacks) counts as input only, and a `RANGECMP2/4` block counts as the
    // `RANGE` rows it unpacked into (`b1: RXCONFIG 278 → 256`; `b2: RANGE 638 → 699,
    // RANGECMP2 31 → 0, RANGECMP4 30 → 0`).
    for (const [id, entry] of counts) entry.output = options.rendered.get(id) ?? 0;
  } else if (options.expandRanges) {
    // The ASCII family unpacks `RANGECMP2/4` into ordinary `RANGE` rows, and the summary follows the
    // output, not the input: `golden-b2-20261101.ABBREV_Summary.txt` reads `RANGE 638 → 699`,
    // `RANGECMP2 31 → 0`, `RANGECMP4 30 → 0`. BINARY copies the compressed records verbatim, so it
    // keeps 1:1 and the flag stays off for every other format.
    let expanded = 0;
    for (const id of RANGECMP_IDS) {
      const entry = counts.get(id);
      if (!entry) continue;
      expanded += entry.source;
      entry.output = 0;
    }
    if (expanded) {
      const range = counts.get(RANGE_ID)
        ?? { name: tables.messages[String(RANGE_ID)]?.name ?? 'RANGE', source: 0, output: 0 };
      range.output += expanded;
      counts.set(RANGE_ID, range);
    }
  }
  if (options.frames && options.textAt) {
    countTextRecords(counts, options.frames, options.textAt, tables);
  }
  return counts;
}

/** Layout name (upper case, no version letter) → message id. */
function idsByName(tables: EdieTables): Map<string, number> {
  const map = new Map<string, number>();
  for (const [id, layout] of Object.entries(tables.messages)) {
    map.set(String(layout.name).toUpperCase(), Number(id));
  }
  return map;
}

/** `#BESTPOSA,…` / `<RANGEA …` → `BESTPOS` / `RANGE`: the version letter is not part of the name. */
function textRecordId(line: string, byName: Map<string, number>): { id: number; name: string } | undefined {
  const match = /^[<#]\s*([A-Za-z][A-Za-z0-9_]*)/.exec(line);
  if (!match) return undefined;
  const raw = match[1].toUpperCase();
  const direct = byName.get(raw);
  if (direct !== undefined) return { id: direct, name: raw };
  const stripped = raw.replace(/[A-Z]$/, '');
  const fallback = byName.get(stripped);
  return fallback === undefined ? undefined : { id: fallback, name: stripped };
}

/**
 * Add the text records to the table the way the suite counts them.
 *
 * A text record the parser resolves counts as one input and one output; one it resolves by name but
 * cannot render (an `RXCONFIG` whose embedded message the dictionary lacks) counts as input only.
 * `[text][USB2]` markers and `<OK` replies resolve to nothing and are not counted at all.
 */
function countTextRecords(
  counts: Map<number, { name: string; source: number; output: number }>,
  frames: readonly Frame[],
  textAt: Map<number, string | string[]>,
  tables: EdieTables,
): void {
  const byName = idsByName(tables);
  const bump = (id: number, name: string, output: boolean) => {
    const entry = counts.get(id) ?? { name, source: 0, output: 0 };
    entry.source += 1;
    if (output) entry.output += 1;
    counts.set(id, entry);
  };
  for (const [index, value] of textAt) {
    const line = Array.isArray(value) ? value[0] : value;
    // An empty block means the record was resolved by name but printed nothing (the `RXCONFIG`
    // case): it is input, not output.
    const emitted = Array.isArray(value) ? value.length > 0 : String(value ?? '').length > 0;
    const found = textRecordId(String(line ?? ''), byName);
    if (found) bump(found.id, found.name, emitted);
    void index;
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text' || textAt.has(index)) return;
    const found = textRecordId(`${frame.prefix}${frame.text}`, byName);
    if (found) bump(found.id, found.name, false);
  });
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
  // `PASSTHROUGH` is converted like every other log — b5's summary lists `1342 … 1 in / 1 out`.
  const passthrough = all.filter(isPassthrough);
  const converted = all;
  const accepted = converted.filter((frame) => frame.crcOk);

  const yy = String(at.getFullYear() % 100).padStart(2, '0');
  const files: ConvertFile[] = [];
  /** Row counts from the writer, and the text lines it placed (only the ASCII family has them). */
  let countsRendered: Map<number, number> | undefined;
  let countsText: Map<number, string | string[]> | undefined;

  if (format === 'ASCII') {
    const rendered = new Map<number, number>();
    const textMap = textLogLines(frames, tables);
    const lines = textLinesFor(frames, tables, textMap, (frame, layout) => {
      const line = encodeAsciiLog(frame, layout, tables);
      return line ? [line] : [];
    }, rendered);
    files.push(lineFile(`${base}.ASCII`, lines));
    countsRendered = rendered;
    countsText = textMap;
  } else if (format === 'ABBREV_ASCII') {
    const rendered = new Map<number, number>();
    const textMap = abbrevTextLogLines(frames, tables);
    const lines = textLinesFor(frames, tables, textMap, (frame, layout) => encodeAbbrevLines(frame, layout, tables), rendered);
    files.push(lineFile(`${base}.ABBREV_ASCII`, lines));
    countsRendered = rendered;
    countsText = textMap;
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

  const counts = countLogs(converted, tables, {
    rendered: countsRendered,
    ...(countsText ? { frames, textAt: countsText } : {}),
  });

  return {
    format,
    formatDirectory: formatDirectory(format),
    base,
    files,
    all,
    passthrough,
    converted,
    accepted,
    counts,
  };
}
