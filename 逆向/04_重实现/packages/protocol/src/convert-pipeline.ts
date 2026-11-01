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
import { abbrevTextLogLines, collectTextLogs, textLogLines } from './text-log.ts';

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
  /**
   * `--split`: one output file per log type (`<base>_<LOGNAME>.<ext>`), as the suite writes it.
   * Only the ASCII family has a per-log writer, so every other format ignores it.
   */
  split?: boolean;
  /**
   * `--unknown-bytes` (`cli.js:161-164`): what to do with the bytes Convert cannot attribute to a
   * log. `'file'` writes them next to the output as `<base>.UNKNOWN`, `'interleave'` splices them
   * into the converted file at the position they came from, `'ignore'` (the default, the suite's
   * `SKIP`) drops them — the summary still counts them either way.
   */
  unknownBytes?: UnknownBytesMode;
  /**
   * The raw capture. Only needed for the unknown-byte accounting: those bytes are, by definition,
   * in no frame, so they cannot be recovered from the frame list.
   */
  source?: Uint8Array;
}

export type UnknownBytesMode = 'file' | 'interleave' | 'ignore';

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
  /**
   * The Summary's `UNKNOWN` row: how many bytes the suite's pre-scan could not turn into a log.
   * Not the same number as `unknown.length` — see `unknownSpanLengths`.
   */
  unknownCount: number;
  /**
   * The bytes Convert cannot attribute to a log, in capture order. `--unknown-bytes=file` writes
   * exactly these to `<base>.UNKNOWN`; the suite's own file is byte-identical (`b1`–`b5`).
   */
  unknown: Uint8Array;
  /** `N bytes could not be converted.` — records of a type this format cannot represent. */
  unConvertedBytes: number;
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
  /** `--split`: the same lines, bucketed by log name so each one can go to its own file. */
  perLog?: Map<string, string[]>,
  /** Per yielded output line: its record's capture offset, for `--unknown-bytes=interleave`. */
  placed?: Array<{ offset: number; lines: readonly string[] }>,
): string[] {
  const rangeLayout = tables.messages['43'];
  const carries: RangeCarries = new Map();
  const lines: string[] = [];
  const bump = (id: number, count: number) => rendered.set(id, (rendered.get(id) ?? 0) + count);
  const place = (index: number, produced: readonly string[]) => {
    if (!placed) return;
    const offset = frames[index].offset;
    if (offset !== undefined) placed.push({ offset, lines: produced });
  };
  const bucket = (name: string, produced: readonly string[]) => {
    if (!perLog || produced.length === 0) return;
    const list = perLog.get(name) ?? [];
    list.push(...produced);
    perLog.set(name, list);
  };
  frames.forEach((frame, index) => {
    const text = textAt.get(index);
    if (text !== undefined) {
      // ASCII prints one line per text record; abbreviated ASCII one whole block per record.
      const produced = Array.isArray(text) ? text : [text];
      lines.push(...produced);
      place(index, produced);
      // `--split` names the file after the log the record carries (`#BESTPOSA…` → `BESTPOS`).
      const name = /^[<#]\s*([A-Za-z][A-Za-z0-9_]*)/.exec(produced[0] ?? '')?.[1]?.toUpperCase() ?? '';
      if (name) bucket(name.replace(/[AB]$/, ''), produced);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    if (isRangeCmp(frame)) {
      if (!rangeLayout) return;
      // `Convert` unpacks the compressed block into ordinary RANGE rows and lets the normal writer
      // print them: b2's 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 become 699 RANGE lines.
      const observations = unpackRangeCmp(frame, carries);
      const unpacked = { ...frame, payload: buildRangePayload(observations) };
      const produced = render(unpacked, rangeLayout);
      lines.push(...produced);
      place(index, produced);
      bucket(rangeLayout.name, produced);
      // One `RANGE` record per compressed record — its observations are that record's array, not
      // separate rows (b2: 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 → 699 RANGE).
      bump(RANGE_ID, 1);
      return;
    }
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    const produced = render(frame, layout);
    lines.push(...produced);
    place(index, produced);
    // A record that prints nothing (`RXCONFIG` with an embedded message the dictionary lacks) is
    // input but not output — that is why b1's summary reads `RXCONFIG 278 → 256`.
    if (produced.length) bump(frame.header.messageId, 1);
    bucket(layout.name, produced);
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
 * The bytes Convert cannot attribute to a log, split into the two questions the suite answers with
 * two different numbers. Measured on `b1`–`b5` (2026-11-01):
 *
 *  1. **`<base>.UNKNOWN`** (`--unknown-bytes=file`) is the capture minus every record whose payload
 *     renders, minus every text record the parser resolves (a `<NAME …` header **and** its
 *     continuation rows). It is format-independent: `b1` gives the same 5386 bytes under `-a`,
 *     `--abbrev` and `-b`. A record that is a log but renders nothing — an `RXCONFIG` (128) whose
 *     embedded message the dictionary lacks, 22 of them in `b1`, 1616 bytes — is *in* the file:
 *     the writer had nothing to put in the output, so the record's bytes are unconverted.
 *
 *  2. **The Summary's `UNKNOWN` row** comes from the pre-scan (`readmessage`), which *does* parse
 *     those silent records (they show up as `RXCONFIG 278`), so their bytes are **not** in it.
 *     What is left is counted by a rule of its own:
 *       - a run of unattributable bytes counts as its length,
 *       - except that `<OK…\r\n` / `<ERROR…\r\n` lines are command responses: a run that holds
 *         nothing but responses counts **one per response** (`<OK\r\n` alone → 1), and a run that
 *         holds any other byte counts only those other bytes (`<OK\r\n[USB2]` → 8),
 *       - the run that starts the file is counted whole (`\r\n<OK\r\n[USB2]` at offset 0 → 13):
 *         the parser has not synced on a record yet, so it reads the leading text as garbage.
 *     Numbers: b1 3695 / b2 6875 / b3 224 / b5 350 — every one of them exact.
 */
interface UnknownSpans {
  /** Complement of the records the **pre-scan** parses — what the `UNKNOWN` row counts. */
  parseRuns: Span[];
  /** Complement of the records that **produce output** — what `.UNKNOWN` holds. */
  fileRuns: Span[];
}

interface Span { start: number; end: number }

/** `<OK`/`<ERROR` up to CRLF. `IGNORED`/`INVALID` are not responses: `<IGNORED\r\n` counts as 10 B. */
const RESPONSE_LINE = /<(OK|ERROR)[^\r\n]*\r\n/y;
const RESPONSE_WORDS = new Set(['OK', 'ERROR', 'IGNORED', 'INVALID']);

/**
 * Text frames the parser resolves into a log: the `#`/`$`/`<` records `text-log.ts` renders, plus
 * every `<` continuation row (`<     10 `, `<    `) that belongs to one of them.
 *
 * The continuation rows are not in `textLogLines`' map — only the header frame is — so the same
 * little state machine `collectTextLogs` runs is replayed here: a header opens a record, a
 * `<OK`/`<ERROR` response closes it, and any other `<` line is part of the open record.
 */
function resolvedTextFrames(frames: readonly Frame[], tables: EdieTables): Set<number> {
  const headers = new Set(collectTextLogs(frames, tables).keys());
  const rendered = textLogLines(frames, tables);
  const resolved = new Set<number>();
  let open = false;
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text') return;
    if (frame.prefix !== '<') {
      if ((frame.prefix === '#' || frame.prefix === '$') && rendered.has(index)) resolved.add(index);
      return;
    }
    const tokens = frame.text.slice(1).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      // A bare `<` / `<    ` data line: part of the open record, otherwise stray bytes.
      if (open) resolved.add(index);
      return;
    }
    if (headers.has(index)) { resolved.add(index); open = true; return; }
    if (RESPONSE_WORDS.has(tokens[0]) || tokens[0].startsWith('?')) { open = false; return; }
    if (open) resolved.add(index);
  });
  return resolved;
}

/** Complement of `spans` inside `[0, length)`. */
function complement(spans: readonly Span[], length: number): Span[] {
  const runs: Span[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) runs.push({ start: at, end: span.start });
    at = Math.max(at, span.end);
  }
  if (at < length) runs.push({ start: at, end: length });
  return runs;
}

function unknownSpans(
  frames: readonly Frame[],
  tables: EdieTables,
  length: number,
): UnknownSpans {
  const resolved = resolvedTextFrames(frames, tables);
  const parsed: Span[] = [];
  const written: Span[] = [];
  frames.forEach((frame, index) => {
    if (frame.offset === undefined) return;
    if (frame.kind === 'sbf') {
      if (!frame.crcOk) return;
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) return;
      const span = { start: frame.offset, end: frame.offset + frame.bytes.length };
      // A record the pre-scan recognises is not unknown bytes even when the dictionary cannot
      // render it; that only keeps it out of `.UNKNOWN`'s *input* list, not out of the file.
      parsed.push(span);
      if (encodeAsciiLog(frame, layout, tables)) written.push(span);
      return;
    }
    if (!resolved.has(index)) return;
    const end = frame.offset + frame.text.length;
    parsed.push({ start: frame.offset, end });
    written.push({ start: frame.offset, end });
  });
  return { parseRuns: complement(parsed, length), fileRuns: complement(written, length) };
}

/**
 * The `UNKNOWN` row's number, from the runs `unknownSpans` produced — see the block comment there
 * for the rule and the four captures it was measured on.
 */
function countUnknown(capture: Uint8Array, runs: readonly Span[]): number {
  let total = 0;
  runs.forEach((run, index) => {
    if (index === 0 && run.start === 0) { total += run.end - run.start; return; }
    const text = latin1(capture.subarray(run.start, run.end));
    let cursor = 0;
    let bytes = 0;
    let responses = 0;
    while (cursor < text.length) {
      RESPONSE_LINE.lastIndex = cursor;
      const match = RESPONSE_LINE.exec(text);
      if (match) { responses += 1; cursor += match[0].length; continue; }
      bytes += 1;
      cursor += 1;
    }
    total += bytes > 0 ? bytes : responses;
  });
  return total;
}

/** Latin-1 view: the capture is a byte stream, and every byte below 0x100 is one character. */
function latin1(bytes: Uint8Array): string {
  let text = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    text += String.fromCharCode(...bytes.subarray(at, Math.min(at + chunk, bytes.length)));
  }
  return text;
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

  // Unknown bytes, when the caller handed us the capture itself (they are in no frame).
  const mode: UnknownBytesMode = options.unknownBytes ?? 'ignore';
  const source = options.source;
  const spans = source && source.length > 0 && frames.every((frame) => frame.offset !== undefined)
    ? unknownSpans(frames, tables, source.length)
    : undefined;
  const textFamily = format === 'ASCII' || format === 'ABBREV_ASCII' || format === 'BINARY';
  // The suite only offers the option for the ASCII/BINARY family (`03_Convert组件.md §5.6`).
  const interleaving = mode === 'interleave' && textFamily && !options.split && spans !== undefined && source !== undefined;

  if (format === 'ASCII') {
    const rendered = new Map<number, number>();
    const textMap = textLogLines(frames, tables);
    const perLog = options.split ? new Map<string, string[]>() : undefined;
    const placed: Array<{ offset: number; lines: readonly string[] }> = [];
    const lines = textLinesFor(frames, tables, textMap, (frame, layout) => {
      const line = encodeAsciiLog(frame, layout, tables);
      return line ? [line] : [];
    }, rendered, perLog, placed);
    if (perLog) {
      // `--split`: the suite writes one file per log type and no combined file
      // (`b2_ALMANAC.ASCII`, `b2_BESTPOS.ASCII`, `b2_RANGE.ASCII`, …).
      for (const [name, list] of [...perLog].sort((a, b) => a[0].localeCompare(b[0]))) {
        files.push(lineFile(`${base}_${name}.ASCII`, list));
      }
    } else if (interleaving) {
      files.push(interleave(`${base}.ASCII`, blockPieces(placed), spans!.fileRuns, source!));
    } else {
      files.push(lineFile(`${base}.ASCII`, lines));
    }
    countsRendered = rendered;
    countsText = textMap;
  } else if (format === 'ABBREV_ASCII') {
    const rendered = new Map<number, number>();
    const textMap = abbrevTextLogLines(frames, tables);
    const perLog = options.split ? new Map<string, string[]>() : undefined;
    const placed: Array<{ offset: number; lines: readonly string[] }> = [];
    const lines = textLinesFor(frames, tables, textMap, (frame, layout) => encodeAbbrevLines(frame, layout, tables), rendered, perLog, placed);
    if (perLog) {
      for (const [name, list] of [...perLog].sort((a, b) => a[0].localeCompare(b[0]))) {
        files.push(lineFile(`${base}_${name}.ABBREV_ASCII`, list));
      }
    } else if (interleaving) {
      files.push(interleave(`${base}.ABBREV_ASCII`, blockPieces(placed), spans!.fileRuns, source!));
    } else {
      files.push(lineFile(`${base}.ABBREV_ASCII`, lines));
    }
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
    const binary = encodeBinaryCapture(accepted).bytes;
    if (interleaving) {
      files.push(interleave(`${base}.BINARY`, accepted.map((frame) => ({ offset: frame.offset ?? 0, bytes: frame.bytes })), spans!.fileRuns, source!));
    } else {
      files.push({ name: `${base}.BINARY`, text: null, bytes: binary });
    }
  }

  const counts = countLogs(converted, tables, {
    rendered: countsRendered,
    ...(countsText ? { frames, textAt: countsText } : {}),
  });

  // A format only "represents" some log types: KML writes `BESTPOS` (42) and nothing else, RINEX
  // writes observations from `RANGE` (43), the epoch position from `BESTPOS` (42) and navigation
  // from `RAWEPHEM` (41). Every other record is input the format cannot express — its row reads
  // `N → 0` and its bytes are the summary's `N bytes could not be converted.`
  // (`clean-9600.gps`: RINEX `116 + 1076 + 4×480 = 1672`, KML `270864 − 5×104 = 270344`).
  const representable = REPRESENTABLE_IDS[format];
  let unConvertedBytes = 0;
  if (representable) {
    for (const frame of accepted) {
      if (representable.has(frame.header.messageId)) continue;
      unConvertedBytes += frame.bytes.length;
      const entry = counts.get(frame.header.messageId);
      if (entry) entry.output = 0;
    }
  }

  // The unknown-byte accounting, when the caller handed us the capture itself.
  let unknownCount = 0;
  let unknownBytes = new Uint8Array(0);
  if (spans && source) {
    unknownCount = countUnknown(source, spans.parseRuns);
    unknownBytes = concatBytes(spans.fileRuns.map((run) => source.subarray(run.start, run.end)));
    if (mode === 'file' && textFamily) {
      files.push({ name: `${base}.UNKNOWN`, text: null, bytes: unknownBytes });
    }
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
    counts,
    unknownCount,
    unknown: unknownBytes,
    unConvertedBytes,
  };
}

/**
 * Which log ids each format is able to express; a format absent from this table represents
 * everything it is given (the ASCII family writes every record, BINARY copies them).
 */
const REPRESENTABLE_IDS: Partial<Record<ConvertFormat, ReadonlySet<number>>> = {
  KML: new Set([42]),
  RINEX21: new Set([41, 42, 43]),
  RINEX301: new Set([41, 42, 43]),
  RINEX302: new Set([41, 42, 43]),
  RINEX303: new Set([41, 42, 43]),
  RINEX304: new Set([41, 42, 43]),
};

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** One record's rendered lines as the byte block the suite writes, `\r\n`-terminated. */
function blockPieces(placed: ReadonlyArray<{ offset: number; lines: readonly string[] }>): Array<{ offset: number; bytes: Uint8Array }> {
  return placed
    .filter((piece) => piece.lines.length > 0)
    .map((piece) => ({ offset: piece.offset, bytes: latin1Bytes(`${piece.lines.join('\r\n')}\r\n`) }));
}

/**
 * `--unknown-bytes=interleave`: put the unknown bytes back where the capture had them, ordered by
 * capture offset. Measured on a synthetic capture through `-a` / `--abbrev` / `-b`: the bytes are
 * spliced verbatim between the records, so the file is no longer line-oriented.
 */
function interleave(
  name: string,
  placed: ReadonlyArray<{ offset: number; bytes: Uint8Array }>,
  runs: readonly Span[],
  source: Uint8Array,
): ConvertFile {
  const pieces = [
    ...placed.filter((piece) => piece.bytes.length > 0),
    ...runs.map((run) => ({ offset: run.start, bytes: source.subarray(run.start, run.end) })),
  ].sort((a, b) => a.offset - b.offset);
  const bytes = concatBytes(pieces.map((piece) => piece.bytes));
  return { name, text: latin1(bytes), bytes };
}
