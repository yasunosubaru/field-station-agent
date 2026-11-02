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

import { appendCrcLe } from './crc.ts';
import { decodeEdie, type EdieTables } from './edie.ts';
import type { Frame, SbfFrame } from './framing.ts';
import { encodeAbbrevLines } from './abbrev-log.ts';
import { encodeAsciiLog, latin1Bytes } from './ascii-log.ts';
import { buildKml, type KmlPoint } from './kml.ts';
import { buildRangePayload, decodeRangeCmp1, decodeRangeCmp2, decodeRangeCmp4, decodeRangeCmp5, lockTimeCarry } from './rangecmp.ts';
import { buildRinex21Obs } from './rinex21.ts';
import { buildRinex21GloNav, buildRinex21Nav } from './rinex21-nav.ts';
import { buildRinex3Obs, type Rinex3Version } from './rinex3.ts';
import { RINEX3_NAV_EXTENSIONS, buildRinex3EmptyNav, buildRinex3Nav, rinex3NavSystems } from './rinex3-nav.ts';
import { formatDirectory } from './summary.ts';
import { abbrevTextLogLines, collectBinaryRecords, collectTextLogs, textLogLines } from './text-log.ts';
import { encodeRecord, type TextEncodeFailure } from './binary-log.ts';
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
   * `--limit-output-size` / `--limit-output-duration` / `--split` / `--daily-utc`, the suite's
   * `splitBy` (`01_解包/app/view/convert/cli.js`: `SIZE` > `TIME` > `LOGS` > `DAILY`). Every mode
   * writes `<base>_Part<N>.<ext>` except `'logs'`, which is the per-log writer above.
   */
  splitMode?: ConvertSplitMode;
  /** `--limit-output-size=<MB>`: one **mebibyte** (1 048 576 B), measured on b2 — see `partitionPieces`. */
  splitSizeMb?: number;
  /** `--limit-output-duration=<SECONDS>`. */
  splitSeconds?: number;
  /**
   * `--unknown-bytes` (`cli.js:161-164`): what to do with the bytes Convert cannot attribute to a
   * log. `'file'` writes them next to the output as `<base>.UNKNOWN`, `'interleave'` splices them
   * into the converted file at the position they came from, `'ignore'` (the default, the suite's
   * `SKIP`) drops them — the summary still counts them either way.
   *
   * The split modes change both: under `--split` (LOGS) neither splices and both write
   * `<base>_UNKNOWN.<ext>`; under `--limit-output-size` / `--limit-output-duration` / `--daily-utc`
   * both splice and no sidecar is written. See `convertFrames`' `spliced`.
   */
  unknownBytes?: UnknownBytesMode;
  /**
   * `--decimate=<SECONDS>`: keep only the records whose own GPS time is a whole multiple of the
   * interval. Measured on the suite — see `decimateFrames`.
   */
  decimate?: number;
  /**
   * `--expand-cmp` / `--no-expand-cmp`: unpack `RANGECMP*` into `RANGE` (the suite's default) or
   * copy the compressed record through, in whichever format this run writes.
   */
  expandCmp?: boolean;
  /**
   * `--start-time=<WEEK>,<SECONDS>` / `--finish-time=<WEEK>,<SECONDS>` / `--limit-duration=<S>`:
   * the window Convert keeps. The suite's GUI calls the same thing **Time Interval** and fills the
   * identical `fileList[<name>].timeInterval` object (`convert.js:1889-1893`, `cli.js:276-289`), so
   * one implementation serves both — see `applyTimeWindow`.
   */
  startTime?: ConvertTimePoint;
  finishTime?: ConvertTimePoint;
  limitDuration?: number;
  /**
   * Prefix/Suffix — the native's `outputFileName: {valid, name, type}`, which the GUI fills from
   * the Prefix/Suffix box (`convert.js:1937-1941`). It renames the **output base**, i.e. the input
   * name without its last extension: `abc` + `clean-9600` → `abcclean-9600.ASCII`, and `SUFFIX`
   * gives `clean-9600abc.ASCII` (measured on the 2.11.0 native, which puts the affix before the
   * extension, never after it). Per-log (`_RANGE`) and `_Part<N>` names keep it in front of the
   * base, so `--split` writes `abcb2-20261101_RANGE.ASCII`; `.UNKNOWN` gets it too.
   */
  affix?: ConvertOutputAffix;
  /**
   * The raw capture. Only needed for the unknown-byte accounting: those bytes are, by definition,
   * in no frame, so they cannot be recovered from the frame list.
   */
  source?: Uint8Array;
}

/** A point in GPS time, as `--start-time` spells it: `{week}, {seconds of week}`. */
export interface ConvertTimePoint {
  week: number;
  seconds: number;
}

/** The suite's `outputFileName`: `valid` is false when the UI's text box is empty. */
export interface ConvertOutputAffix {
  valid?: boolean;
  name: string;
  type: 'PREFIX' | 'SUFFIX';
}

export type UnknownBytesMode = 'file' | 'interleave' | 'ignore';

export type ConvertSplitMode = 'logs' | 'size' | 'time' | 'daily';

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
  /** The name every output file starts from: `base` with the Prefix/Suffix applied. */
  outputBase: string;
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
  /**
   * The records the Summary's time range is measured over: the input **after the Time Interval but
   * before `--decimate`**. The suite reports `2442, 570227.071 → 570255.15` for b1 both with and
   * without `--decimate=5`, while the written stream starts at 570230; a window, on the other hand,
   * does narrow it (b1 `570250 → 570255`). Passing `accepted` here would report the decimated span.
   */
  summaryFrames: SbfFrame[];
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
  /**
   * Text records a `BINARY` conversion could not re-encode, with the reason. Empty for every other
   * format and for every capture this project has (`b1`–`b7`); the field exists so a record can
   * never be lost without a trace.
   */
  unencodedText: TextEncodeFailure[];
}

/**
 * `<base>` as the suite and the CLI define it: the last `.extension` removed, but only when there
 * is a stem in front of it (`basename('.hidden', '')` stays `.hidden`).
 */
export function captureBase(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * `base` with the GUI's Prefix/Suffix applied.
 *
 * Measured on the 2.11.0 native (`Edie/edie-node-wrappers.node`, run through `Convert` with
 * `outputFileName` set, no CLI flag exists for this): `{valid:true, name:'abc', type:'PREFIX'}`
 * writes `abcclean-9600.ASCII`, `type:'SUFFIX'` writes `clean-9600abc.ASCII` — the affix joins the
 * **stem**, before the extension — and `{valid:false, name:'abc'}` is ignored (plain
 * `clean-9600.ASCII`). Under `--split`/LOGS every per-log file carries it too
 * (`abcb2-20261101_RANGE.ASCII`), and so does `.UNKNOWN`.
 */
export function affixedBase(base: string, affix: ConvertOutputAffix | undefined): string {
  if (!affix || affix.valid === false || affix.name === '') return base;
  return affix.type === 'SUFFIX' ? `${base}${affix.name}` : `${affix.name}${base}`;
}

function textFile(name: string, text: string): ConvertFile {
  return { name, text, bytes: latin1Bytes(text) };
}

/**
 * One record's contribution to the output: the lines an ASCII-family writer prints, or the bytes a
 * `BINARY` writer copies, together with the two things the split modes need — the log's name
 * (`--split`) and the record's own GPS stamp (`--limit-output-duration`, `--daily-utc`).
 *
 * Everything below builds an output file by concatenating blocks, so a part written by one of the
 * splitting modes is a byte prefix of the unsplit file: the suite never cuts a record in half
 * (measured: `--limit-output-size=1` on b2, and every `ABBREV_ASCII` part starts on a `<NAME` line).
 */
interface ConvertBlock {
  /** `ASCII` / `ABBREV_ASCII`: the printed lines, `\r\n`-terminated in `bytes`. */
  lines: readonly string[];
  /** Exactly what this record adds to the output file. */
  bytes: Uint8Array;
  /** The dictionary name of the log (`RANGE`, `BESTPOS`, …), for `--split`'s file names. */
  name: string;
  /** The record's own GPS stamp — the *week* is kept as well: `--daily-utc` counts whole days. */
  stamp?: RecordStamp;
  /**
   * The record's time status. `--daily-utc` only moves its day clock on certain statuses, and a
   * **text** record's set is one step wider than a binary record's — see `partitionPieces`.
   */
  timeStatus?: number;
  /** True when the block came from a text record (`#NAME …` / `<NAME …`), false for an SBF frame. */
  text?: boolean;
  /** Capture offset of the record, for `--unknown-bytes=interleave`. */
  offset?: number;
}

/** A record's GPS time as the header carries it: week plus milliseconds **into that week**. */
interface RecordStamp {
  week: number;
  milliseconds: number;
}

/**
 * The stamp a binary record carries, in milliseconds **of its GPS week**.
 *
 * Decimation is measured to use this field directly (`--decimate=13` keeps b2's `577759`, `577772`,
 * `577785` — multiples of 13 *within the week*; the absolute GPS second of those three is not).
 */
function stampOf(frame: SbfFrame): RecordStamp {
  return { week: frame.header.week, milliseconds: frame.header.milliseconds };
}

/** The same instant as one comparable number, for the splits that measure elapsed time. */
function absoluteMilliseconds(stamp: RecordStamp): number {
  return stamp.week * 604_800_000 + stamp.milliseconds;
}

/** Whole GPS days since the GPS epoch — `--daily-utc`'s unit (no leap-second correction, measured). */
function gpsDay(stamp: RecordStamp): number {
  return Math.floor(absoluteMilliseconds(stamp) / 86_400_000);
}

/**
 * The stamp a **text** record carries.
 *
 * A text record prints its own header, and the suite decimates and splits it by that header, not by
 * its neighbours: in b1 the 99 text records survive `--decimate=5` exactly when their own
 * `week, ms` is a whole multiple of 5 s (46 of 99, and every one of the 46 carries `570230`,
 * `570235`, … while every dropped one carries `570231`, `570232`, …). In live-nav the eleven
 * complete `#BESTPOSA` records — the ones `textLogLines` echoes rather than re-renders — follow the
 * same rule, so the stamp is read back from the line the writer emits:
 *
 *   `#NAMEA,port,seq,idle,timeStatus,week,ms,…`     → fields 5 and 6
 *   `<NAME port seq idle timeStatus week ms …`       → the same fields after the name
 *
 * `$GPGGA,…` carries a UTC time of day, not GPS week/seconds, so it has no stamp: it is never
 * decimated away and never forces a time split.
 */
function textRecordStamps(textAt: Map<number, string | string[]>): Map<number, RecordStamp> {
  const stamps = new Map<number, RecordStamp>();
  for (const [index, value] of textAt) {
    const line = Array.isArray(value) ? (value[0] ?? '') : value;
    const stamp = stampOfTextLine(line);
    if (stamp) stamps.set(index, stamp);
  }
  return stamps;
}

function stampOfTextLine(line: string): RecordStamp | undefined {
  if (!line.startsWith('#') && !line.startsWith('<')) return undefined;
  // `#` separates with commas (the trailing `;…*crc` is the body); `<` with spaces. Both start with
  // the log name, so the week and the milliseconds are fields 5 and 6 either way.
  const fields = line.slice(1).split(line.startsWith('#') ? /[,;]/ : /\s+/);
  const week = Number(fields[5]);
  const seconds = Number(fields[6]);
  if (!Number.isFinite(week) || !Number.isFinite(seconds) || fields[5] === undefined) return undefined;
  return { week, milliseconds: Math.round(seconds * 1000) };
}

/** The ASCII names a text record prints for the SBF time status, back to the numeric code. */
function textTimeStatus(line: string): number | undefined {
  if (!line.startsWith('#') && !line.startsWith('<')) return undefined;
  const fields = line.slice(1).split(line.startsWith('#') ? /[,;]/ : /\s+/);
  const name = (fields[4] ?? '').toUpperCase();
  const code = TEXT_TIME_STATUS[name];
  return code;
}

/** The ASCII names a text header prints for the SBF time status (`03_分析/09_…` §时间状态). */
const TEXT_TIME_STATUS: Record<string, number> = {
  UNKNOWN: 0,
  APPROXIMATE: 20,
  COARSESTEERING: 60,
  FINESTEERING: 180,
  FINE: 80,
  FINEADJUSTING: 100,
  DEGRADED: 120,
  ALIGNING: 160,
  SATTIME: 200,
};

/** Every record's stamp, text records included; `undefined` for a record that carries no time. */
function stampsFor(frames: readonly Frame[], textAt: Map<number, RecordStamp>): Array<RecordStamp | undefined> {
  return frames.map((frame, index) => {
    if (frame.kind === 'text') return textAt.get(index);
    return stampOf(frame);
  });
}

/**
 * `--decimate=<SECONDS>` (manual 4.5.3): keep only the records whose own time is a whole multiple
 * of the interval, i.e. `millisecondsOfWeek % (interval * 1000) === 0`.
 *
 * This is **epoch alignment, not "every Nth record"**: b2 at `--decimate=5` keeps exactly the
 * records stamped `577760`, `577765`, `577770`, … , so a log logged at 20 Hz collapses to its
 * once-a-second instance while a log logged at 1 Hz survives unchanged. Measured on b2:
 *
 * ```
 * BESTPOS 32 → 7   BESTGNSSVEL 30 → 6   MARKPOS 30 → 6   PSRPOS 30 → 6   PPPDOP 30 → 3
 * RANGE  638 → 7 (plus the 12 expanded compressed blocks that land on an aligned epoch)
 * ```
 *
 * The alignment is relative to the **start of the GPS week**, not to the file: `--decimate=13`
 * keeps `577759`, `577772`, `577785` in b2 (multiples of 13 s-of-week), and a record at
 * `570228.000` keeps its own stamp even when its predecessor is `570229.85` (b1's text records).
 * A record that has no time at all (an NMEA sentence, `<<OK`) is not decimated away: it has no
 * epoch to align to, so it stays.
 */
function decimateFrames(
  frames: readonly Frame[],
  stamps: ReadonlyArray<RecordStamp | undefined>,
  interval: number,
): Frame[] {
  const step = interval * 1000;
  return frames.filter((frame, index) => {
    const stamp = stamps[index];
    if (!stamp) return true;
    return stamp.milliseconds % step === 0;
  });
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
 *
 * `expand` is `--expand-cmp` (the suite's default): with it off the compressed record prints as
 * itself, through its own dictionary layout, and the summary counts it 1:1 (`--no-expand-cmp` on
 * b2 writes 638 `RANGE` + 31 `RANGECMP2` + 30 `RANGECMP4` lines, 4 667 920 B).
 */
function renderBlocks(
  frames: readonly Frame[],
  tables: EdieTables,
  textAt: Map<number, string | string[]>,
  render: (frame: SbfFrame, layout: EdieTables['messages'][string]) => readonly string[],
  stamps: ReadonlyArray<RecordStamp | undefined>,
  expand: boolean,
  /** Per log id, how many output rows it produced (`summary.ts` reports the output, not the input). */
  rendered: Map<number, number> = new Map(),
): ConvertBlock[] {
  const rangeLayout = tables.messages['43'];
  const carries: RangeCarries = new Map();
  const blocks: ConvertBlock[] = [];
  const bump = (id: number, count: number) => rendered.set(id, (rendered.get(id) ?? 0) + count);
  const push = (index: number, name: string, lines: readonly string[]) => {
    if (lines.length === 0) return;
    const text = frames[index].kind === 'text';
    const timeStatus = text
      ? textTimeStatus(lines[0] ?? '')
      : (frames[index] as SbfFrame).header.timeStatus;
    blocks.push({
      lines,
      bytes: latin1Bytes(`${lines.join('\r\n')}\r\n`),
      name,
      ...(stamps[index] ? { stamp: stamps[index] } : {}),
      ...(timeStatus !== undefined ? { timeStatus } : {}),
      text,
      ...(frames[index].offset !== undefined ? { offset: frames[index].offset } : {}),
    });
  };
  frames.forEach((frame, index) => {
    const text = textAt.get(index);
    if (text !== undefined) {
      // ASCII prints one line per text record; abbreviated ASCII one whole block per record.
      const produced = Array.isArray(text) ? text : [text];
      // `--split` names the file after the log the record carries (`#BESTPOSA…` → `BESTPOS`).
      const name = /^[<#]\s*([A-Za-z][A-Za-z0-9_]*)/.exec(produced[0] ?? '')?.[1]?.toUpperCase() ?? '';
      push(index, name.replace(/[AB]$/, ''), produced);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    if (expand && isRangeCmp(frame)) {
      if (!rangeLayout) return;
      // `Convert` unpacks the compressed block into ordinary RANGE rows and lets the normal writer
      // print them: b2's 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 become 699 RANGE lines.
      const observations = unpackRangeCmp(frame, carries);
      const unpacked = { ...frame, payload: buildRangePayload(observations) };
      push(index, rangeLayout.name, render(unpacked, rangeLayout));
      // One `RANGE` record per compressed record — its observations are that record's array, not
      // separate rows (b2: 638 RANGE + 31 RANGECMP2 + 30 RANGECMP4 → 699 RANGE).
      bump(RANGE_ID, 1);
      return;
    }
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    const produced = render(frame, layout);
    push(index, layout.name, produced);
    // A record that prints nothing (`RXCONFIG` with an embedded message the dictionary lacks) is
    // input but not output — that is why b1's summary reads `RXCONFIG 278 → 256`.
    if (produced.length) bump(frame.header.messageId, 1);
  });
  return blocks;
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
    // `TextFrame.text` already carries its leading `#`/`<`/`$`; prepending the prefix again (as this
    // once did) made the name regex fail on `##RXCONFIGA…`, so a text record that rendered nothing
    // was missing from the Summary instead of counting as input-only (`b7`: 269 → 247).
    const found = textRecordId(String(frame.text), byName);
    if (found) bump(found.id, found.name, false);
  });
}

/**
 * The bytes Convert cannot attribute to a log, split into the two questions the suite answers with
 * two different numbers. Measured on `b1`–`b5` (2026-11-01):
 *
 *  1. **`<base>.UNKNOWN`** (`--unknown-bytes=file`) is the capture minus every record whose payload
 *     renders, minus every text record the parser resolves (a `<NAME …` header **and** its
 *     continuation rows), and minus every record the reader never reached — the ones `--decimate`
 *     dropped and the SBF records a Time Interval left out (their bytes are neither output nor
 *     unknown: b1 `--decimate=5` writes 4 014 B, not 5 386; its windowed run 3 770 B). It is
 *     format-independent: `b1` gives the same 5386 bytes under `-a`, `--abbrev` and `-b`. A record
 *     that is a log but renders nothing — an `RXCONFIG` (128) whose embedded message the dictionary
 *     lacks, 22 of them in `b1`, 1616 bytes — is *in* the file: the writer had nothing to put in the
 *     output, so the record's bytes are unconverted.
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
export interface UnknownSpans {
  /** Complement of the records the **pre-scan** parses — what the `UNKNOWN` row counts. */
  parseRuns: Span[];
  /** Complement of the records that **produce output** — what `.UNKNOWN` holds. */
  fileRuns: Span[];
}

export interface Span { start: number; end: number }

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

export function unknownSpans(
  frames: readonly Frame[],
  tables: EdieTables,
  length: number,
  /**
   * Records the reader never reaches — `--decimate` drops them, a Time Interval leaves SBF records
   * outside its window out. Their bytes are **neither written nor unknown**: measured on b1
   * (`--decimate=5`: 5 386 → 4 014 B, the 1 372 B all belonging to off-grid records that render
   * nothing) and on a synthetic capture (a silent `RXCONFIG` on the grid stays in `.UNKNOWN`, the
   * same record off the grid disappears from it). The junk *around* such a record stays: what goes
   * away is the record's own span, not a buffer of pending bytes.
   *
   * This only moves the `.UNKNOWN` side. The Summary's `UNKNOWN` row keeps counting the full
   * capture (`parseRuns`, b1 3 695 both ways).
   */
  skipped: readonly Frame[] = [],
): UnknownSpans {
  const resolved = resolvedTextFrames(frames, tables);
  const layoutNames = new Set(Object.values(tables.messages).map((message) => message.name));
  const parsed: Span[] = [];
  const written: Span[] = [];
  const dropped: Span[] = [];
  for (const frame of skipped) {
    if (frame.offset === undefined) continue;
    const size = frame.kind === 'sbf' ? frame.bytes.length : frame.text.length;
    dropped.push({ start: frame.offset, end: frame.offset + size });
  }
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
    if (!resolved.has(index)) {
      /**
       * A text record whose **outer** name the dictionary knows is not "unknown bytes" even when
       * the record produces no output: b7's 22 `RXCONFIG`s whose embedded message is absent from
       * the dictionary are dropped from the converted file, but the suite's Summary UNKNOWN row
       * still counts only the 206 bytes of responses (`b7`: `.UNKNOWN` 3 935 B, row 206). The
       * outer span stays out of `.UNKNOWN`'s *input* list here; `written` below still leaves those
       * 22 records in the file.
       */
      const match = /^#([A-Z][A-Z0-9_]*),/.exec(frame.text);
      if (frame.prefix === '#' && match) {
        const name = match[1];
        if (layoutNames.has(name) || layoutNames.has(name.slice(0, -1))) {
          parsed.push({ start: frame.offset, end: frame.offset + frame.text.length });
        }
      }
      return;
    }
    const end = frame.offset + frame.text.length;
    parsed.push({ start: frame.offset, end });
    written.push({ start: frame.offset, end });
  });
  return {
    parseRuns: complement(parsed, length),
    fileRuns: complement(
      [...written, ...dropped].sort((a, b) => a.start - b.start),
      length,
    ),
  };
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
 * `--limit-output-size=<MB>`: the suite's "MB" is a **mebibyte**, and the check runs **after** a
 * record is added — "close the part once it has reached the limit", not "stop before it".
 *
 * Measured on b2 with `--limit-output-size=1`: five parts of 1 051 261 / 1 055 491 / 1 051 236 /
 * 1 054 714 / 719 271 B. They are exactly the prefixes a 1 048 576 B post-add test produces; a
 * 1 000 000 B threshold gives five different cuts (1 002 402 / 1 006 602 / …), and a 1 MiB
 * pre-add test gives four parts. The last part is short because the capture ends.
 */
const MEBIBYTE = 1_048_576;

/**
 * The time statuses that move `--daily-utc`'s day clock on a **binary** record: `FINE` (80),
 * `FINEADJUSTING` (100), `DEGRADED` (120), `ALIGNING` (160) and `FINESTEERING` (180).
 *
 * Measured with one probe record between two same-day ones,
 * `[2442:577759:180, <week:ms>:<status>, 2442:577760:180]`, one status per run: 0, 20, 60 and 200
 * leave the capture at one part; 80/100/120/160/180 split it at the probe record. A week-0 probe
 * gives the mirror image — status 80 splits *at the following record* (the probe pulled the clock
 * back to day 0), statuses 0/20/60/200 do not split at all.
 */
const DAILY_CLOCK_TIME_STATUS = new Set([80, 100, 120, 160, 180]);

/**
 * The same set for a **text** record, and it is one step wider: `COARSESTEERING` (60) participates.
 *
 * Measured with the same shape, the probe written as a `#BESTPOSA,…` text record (its CRC covers
 * the record after the leading `#`, so the suite echoes it verbatim): statuses 0, 20 and 200 leave
 * one part while 60/80/100/120/160/180 split both forward (`2442:577759` → `2443:1.000`) and
 * backward (a week-0 probe pulls the clock to day 0 and the next same-day record splits). The two
 * gates really differ: the *identical* `COARSESTEERING` stamp splits as a text record and does not
 * as a binary frame.
 */
const DAILY_CLOCK_TEXT_STATUS = new Set([60, 80, 100, 120, 160, 180]);

/**
 * One piece of an output file: a converted record's bytes, or a run of bytes Convert could not
 * attribute to a log spliced back where the capture had it (`--unknown-bytes=interleave`).
 *
 * The split modes all cut this **one** stream, so a part is a slice of the interleaved file rather
 * than "its records, with the unknown bytes appended somewhere". Measured on b2 (2026-11-02): the
 * suite's five `--limit-output-size=1` parts and its seven `--limit-output-duration=5` parts both
 * concatenate to exactly the unsplit `--unknown-bytes=interleave` file (4 939 029 B).
 */
interface OutputPiece {
  bytes: Uint8Array;
  /** The record this piece prints; `undefined` for a run of unknown bytes. */
  block?: ConvertBlock;
  /** Capture offset — the record's own, or the start of the unknown run. */
  offset: number;
}

/** Does this record's time status mean "this time is worth trusting"? The `--daily-utc` gates. */
function timeStatusTrusted(block: ConvertBlock): boolean {
  return (block.text ? DAILY_CLOCK_TEXT_STATUS : DAILY_CLOCK_TIME_STATUS).has(block.timeStatus ?? -1);
}

/**
 * The output stream in capture order: the converted records and, when the caller asked for
 * `--unknown-bytes=interleave`, the runs of unattributable bytes spliced back at their offsets.
 *
 * Ordering both by the one capture offset is the whole rule; a Time Interval needs no special case
 * either (the runs are the windowed account and the blocks carry the offsets of the records the
 * window kept).
 */
function mergePieces(
  blocks: readonly ConvertBlock[],
  runs: readonly Span[],
  source: Uint8Array,
): OutputPiece[] {
  return [
    ...blocks.filter((block) => block.bytes.length > 0)
      .map((block) => ({ bytes: block.bytes, block, offset: block.offset ?? 0 })),
    ...runs.map((run) => ({ bytes: source.subarray(run.start, run.end), offset: run.start })),
  ].sort((a, b) => a.offset - b.offset);
}

/**
 * Split `pieces` into the parts one of the three file-splitting modes writes.
 *
 * `'size'` — see `MEBIBYTE` above. The counter is over **everything written**, unknown bytes
 * included, and it is tested after every piece: measured on a synthetic capture (13 BESTPOS records
 * of 214 B, a 13-byte run at the top and an 8-byte one at the end, `--limit-output-size=0.001025` =
 * 1 074.8 B), the plain run closes Part0 after six records (1 284 B) while the interleaved run
 * closes it after five records **plus** that leading junk (1 083 B). A junk run can therefore close
 * a part on its own — 3 000 bytes of junk after the first record closed Part0 before the next record
 * arrived. That is also why b2's five
 * 1 MiB parts under `--unknown-bytes=interleave` are 1 051 452 / 1 055 374 / 1 051 235 / 1 054 714 /
 * 726 254 B instead of the plain 1 051 261 / 1 055 491 / 1 051 236 / 1 054 714 / 719 271: the junk
 * in each part counts towards its limit.
 *
 * `'time'` — `--limit-output-duration=<SECONDS>`: a part runs from the time of **its own first
 * record** for that many seconds, both ends inclusive, and the record that *reaches* the window's
 * end is still written to the part (it is what marks the part as full). The next part begins at the
 * first record whose time is **past** the window; records that arrive after the part filled up but
 * are not past the window — a late burst, or the almanac's own reference epoch — stay in it.
 *
 * That is why b2 at `--limit-output-duration=5` splits into
 * `577759.0…577764.0`, `577764.05…577769.05`, … (each part exactly 5.0 s wide, ending on a record
 * that is 5.0 s after its first) and why Part0 holds just two lines: the `ALMANAC` at `577140.000`
 * (the file's first record, so it anchors Part0) and `577758.95`, the first record after it. It is
 * also why `577789.25` closes Part6 while the two late `RAWEPHEM`s stamped `577770` still land in
 * it: their time is behind the window, not past it. Verified on synthetic captures as well: with
 * records at `577760.00` and `577765.00` and nothing between, both stay in Part0.
 *
 * **A part that opens on unknown bytes has no anchor** (measured 2026-11-02, and the reason b2's
 * interleaved `--limit-output-duration=5` writes seven parts instead of eight). b2's capture starts
 * with `\r\n<OK\r\n[USB2]`, then the `ALMANAC` (`577140.000`, `SATTIME` = 200) — and the interleaved
 * run anchors Part0 on `577758.950` (COARSESTEERING = 120), not on the almanac: the part runs
 * `577758.95 … 577763.95` and `577764.000` opens Part1. The same shape on synthetic captures:
 * `[*junk, 577140:200, 577145:180 …]` anchors at 577145, and `[*junk, 577140:200, 577143:200,
 * 577150:60 …]` never starts the clock at all (one part). So when a part's first piece is not a
 * record, the clock waits for the first record whose status is in the same trusted set the day clock
 * uses; a part that *starts* with a record takes it whatever its status (that is how the plain run
 * anchors on the almanac).
 *
 * Measured on synthetic captures as well (2026-11-02, `逆向/tools/probe-time-anchor.ts`, 20 cases,
 * every part byte-identical): behind junk, a **binary** record anchors on 80 / 100 / 160 / 180 and
 * not on 20 / 60 / 200; a **text** record uses the text gate, so `COARSESTEERING` (60) and `FINE`
 * anchor while `UNKNOWN`, `APPROXIMATE` and `SATTIME` do not — the identical `COARSESTEERING` stamp
 * as a frame does not anchor. The clock starts at the first *trusted* record of either kind, so a
 * text record can anchor behind an untrusted frame, and a capture with no trusted record stays one
 * part. A record that is the part's first piece anchors whatever its status, junk or no junk.
 *
 * `'daily'` — `--daily-utc`: a new part whenever a record's GPS day (whole days since the GPS
 * epoch, **no leap-second correction** — the boundary is seconds-of-week ≡ 0 mod 86400, measured
 * either side of 518400 and 604800) is *later* than the day clock, and the clock **follows every
 * record that moves it, backwards included**:
 *
 *  - the clock starts at the first block that carries a stamp at all, whatever its status (a week-0
 *    `COARSESTEERING` frame starts it at day 0, and the first real day after that splits) — unknown
 *    bytes do not take part, so the interleaved run anchors exactly like the plain one;
 *  - a binary frame moves it when its header status is in `DAILY_CLOCK_TIME_STATUS`, a text record
 *    when its printed status is in `DAILY_CLOCK_TEXT_STATUS` (one status wider);
 *  - a late record therefore *rewinds* the clock, so the next jump forward splits again — exactly
 *    what b7 does: `2443/35948` (day 17101) opens Part1 after day 17100, the late
 *    `2442/553834.993` (day 17100) rewinds it inside Part1, and `2443/23262.546` (day 17101) opens
 *    Part2. A monotone clock instead writes b7 as one 609-line part.
 *
 * b2 spans one UTC day, hence one part of the whole file (905 lines / 4 931 973 B, named
 * `b2-20261101_Part0.ASCII`); b5 and live-nav split into two.
 *
 * Unknown bytes belong to the part of the record **before** them: the junk between the record that
 * closes a part and the record that opens the next one stays at the end of the earlier part
 * (measured on synthetics for both `time` and `daily`: Part0 ends with its junk, Part1 opens on a
 * record). Because the close is decided when the *next* record arrives, the iterator below has
 * already pushed that junk into `current` when `close()` runs.
 */
function partitionPieces(
  pieces: readonly OutputPiece[],
  splitMode: ConvertSplitMode | undefined,
  options: ConvertOptions,
): OutputPiece[][] {
  if (splitMode === undefined || splitMode === 'logs') return [pieces.slice()];
  const parts: OutputPiece[][] = [];
  let current: OutputPiece[] = [];
  const close = () => { parts.push(current); current = []; };
  if (splitMode === 'size') {
    const limit = (options.splitSizeMb ?? 0) * MEBIBYTE;
    let bytes = 0;
    for (const piece of pieces) {
      current.push(piece);
      bytes += piece.bytes.length;
      if (limit > 0 && bytes >= limit) { close(); bytes = 0; }
    }
  } else if (splitMode === 'time') {
    const duration = (options.splitSeconds ?? 0) * 1000;
    let start: number | undefined;
    let expired = false;
    /** True only for the very first piece of a part: a record there anchors whatever its status. */
    let first = true;
    for (const piece of pieces) {
      const block = piece.block;
      const stamp = block?.stamp ? absoluteMilliseconds(block.stamp) : undefined;
      if (stamp !== undefined && duration > 0) {
        if (start === undefined) {
          if (first || timeStatusTrusted(block!)) start = stamp;
        } else if (expired && stamp > start + duration) {
          close(); start = stamp; expired = false; first = true;
        }
      }
      current.push(piece);
      first = false;
      if (stamp !== undefined && start !== undefined && !expired && duration > 0 && stamp - start >= duration) {
        expired = true;
      }
    }
  } else {
    let clockDay: number | undefined;
    for (const piece of pieces) {
      const block = piece.block;
      const day = block?.stamp ? gpsDay(block.stamp) : undefined;
      // The clock starts at the first record that carries a stamp at all, whatever its status, and
      // from then on only records whose status means "this time is worth trusting" move it.
      // b2's `ALMANAC` (200) and `GLORAWALM` (200, week 2402 of a 2026-11 capture) leave it at one
      // part; b1's 24 `RXCONFIG` records stamped 0 with status 200 and its `id 1246` frames with
      // status 20 and week 0 leave it at one part too — while a status-180 record stamped 0 does
      // start the clock at day 0 and splits the capture at the first real record.
      if (day !== undefined && block) {
        if (clockDay === undefined) clockDay = day;
        else if (timeStatusTrusted(block)) {
          // Measured: the clock is *not* monotone — a late record rewinds it, so the next record
          // that is later than the rewound clock opens a new part (b7's Part1 → Part2 boundary).
          if (day > clockDay) close();
          clockDay = day;
        }
      }
      current.push(piece);
    }
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [[]];
}

function concatPieces(pieces: readonly OutputPiece[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.bytes.length, 0));
  let at = 0;
  for (const piece of pieces) { out.set(piece.bytes, at); at += piece.bytes.length; }
  return out;
}

function concatBlocks(blocks: readonly ConvertBlock[]): Uint8Array {
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.bytes.length, 0));
  let at = 0;
  for (const block of blocks) { out.set(block.bytes, at); at += block.bytes.length; }
  return out;
}

/**
 * Turn one format's blocks into the files the suite writes: `<base>.<ext>` when nothing splits,
 * `<base>_<LOGNAME>.<ext>` for `--split` (which only the ASCII family honours — the suite writes
 * per-log files for it and single files for BINARY/RINEX/KML), and `<base>_Part<N>.<ext>` for the
 * three other modes.
 *
 * `spliced` is `--unknown-bytes=interleave`: the runs go back at their capture offsets, and the
 * three splitting modes cut the resulting stream (see `partitionPieces`). `--split` never splices —
 * the suite writes the whole unknown stream to `<base>_UNKNOWN.<ext>` instead (see `convertFrames`).
 */
function assembleFiles(
  base: string,
  extension: string,
  text: boolean,
  blocks: readonly ConvertBlock[],
  splitMode: ConvertSplitMode | undefined,
  options: ConvertOptions,
  spliced?: { runs: readonly Span[]; source: Uint8Array },
): ConvertFile[] {
  if (splitMode === 'logs') {
    const perLog = new Map<string, ConvertBlock[]>();
    for (const block of blocks) {
      if (!block.name) continue;
      const list = perLog.get(block.name) ?? [];
      list.push(block);
      perLog.set(block.name, list);
    }
    // `--split`: one file per log type, no combined file (`b2_BESTPOS.ASCII`, `b2_RANGE.ASCII`, …).
    return [...perLog].sort((a, b) => a[0].localeCompare(b[0])).map(([logName, list]) => {
      const bytes = concatBlocks(list);
      return { name: `${base}_${logName}.${extension}`, text: text ? latin1(bytes) : null, bytes };
    });
  }
  let pieces: OutputPiece[] = spliced
    ? mergePieces(blocks, spliced.runs, spliced.source)
    : blocks.map((block) => ({ bytes: block.bytes, block, offset: block.offset ?? 0 }));
  /**
   * `--daily-utc` drops the unknown run(s) that come *before the first record*: b1's interleaved
   * daily run writes 5 094 255 B = 5 088 882 (the plain part) + 5 386 (`.UNKNOWN`) − 13, and those
   * 13 bytes are the capture's opening `\r\n<OK\r\n[USB2]` — the same run `size` and `time` keep
   * (measured 2026-11-02). It is the one place the suite loses unknown bytes, and it is reproduced
   * rather than silently "fixed" so the bytes match.
   *
   * "Before the first record" means the first piece that **writes bytes**, not the first record the
   * pre-scan parses (measured 2026-11-02 with `逆向/tools/probe-daily-leading-junk.ts`): a silent
   * `#RXCONFIGA` (a name the dictionary knows, an embedded message it does not) at offset 0, with
   * junk behind it, is dropped as well — a rule that kept it would write 606 B where the suite writes
   * 428. Several runs with silent records in between go the same way, and the same bytes under
   * `--limit-output-duration` keep the whole prefix. `mergePieces` already folds the junk and the
   * silent record into one run, so slicing at `firstRecord` is exactly the suite's behaviour; the
   * `unknown` report still counts every run (191 B in that synthetic capture).
   */
  if (splitMode === 'daily') {
    const firstRecord = pieces.findIndex((piece) => piece.block !== undefined);
    if (firstRecord > 0) pieces = pieces.slice(firstRecord);
  }
  const parts = partitionPieces(pieces, splitMode, options);
  return parts.map((part, index) => {
    const bytes = concatPieces(part);
    const fileName = splitMode === undefined ? `${base}.${extension}` : `${base}_Part${index}.${extension}`;
    return { name: fileName, text: text ? latin1(bytes) : null, bytes };
  });
}

/**
 * The native's RANGECMP5 `sd_adr` table, 32 entries, **measured** rather than derived.
 *
 * Our decoder computes the manual's formula, `(1/256)·exp(x/(3.65·√3))`; that agrees with the
 * native to three decimals — which is why every ASCII golden is exact — but the *stored float32*
 * differs in the fifth digit for all 32 indices (`0.00390625` vs `0.00391`, `0.016219` vs
 * `0.01621`). The values below were read out of the suite itself: one synthetic RANGECMP5 record
 * per index (a single GPS satellite on one signal, `adrStd = x`), converted with `-b`, and the
 * `sd_adr` field of the expanded RANGE frame decoded. Index 30 and 31 both store 0.4494 — the
 * manual's open-ended "`> 0.44940`" bound, so the table saturates exactly where the documentation
 * says it does.
 */
const ADR_STD_CMP5_STORED = [
  0.00391, 0.00458, 0.00536, 0.00628, 0.00735, 0.00861, 0.01001, 0.01182, 0.01385, 0.01621,
  0.019, 0.02223, 0.02607, 0.03054, 0.03577, 0.0419, 0.04908, 0.05749, 0.06734, 0.07889,
  0.0924, 0.10824, 0.12679, 0.14851, 0.17396, 0.20378, 0.2387, 0.27961, 0.32753, 0.38366,
  0.4494, 0.4494,
];

/** The stored table entry closest to the decoded value — the index is monotonic and distinct. */
function storedCmp5AdrStd(value: number): number {
  let best = ADR_STD_CMP5_STORED[0];
  let distance = Infinity;
  for (const candidate of ADR_STD_CMP5_STORED) {
    const delta = Math.abs(candidate - value);
    if (delta < distance) { distance = delta; best = candidate; }
  }
  return best;
}

/**
 * The `RANGE` payload the suite writes into a **binary** file when it unpacks a compressed block.
 *
 * The ASCII writer reproduces the *printed* digits (`rangecmp.ts#buildRangePayload`); a binary file
 * carries the stored FLOAT32 values, and three of them are not simply `Math.fround` of the decoded
 * number. Measured by diffing the suite's own `-b` output for b2 and b5, field by field, over every
 * observation of all five compression versions (2 697 CMP2 + 2 610 CMP4 in b2, 897 CMP1 + 897 CMP2
 * + 828 CMP3 + 828 CMP4 + 828 CMP5 in b5):
 *
 *  - `sd_psr` (CMP5) and `sd_adr` (CMP3/CMP4) are stored as the **3-decimal** value the native's
 *    table holds (`0.09906… → 0.099`, `0.02208… → 0.022`), while CMP1/CMP2 keep theirs;
 *  - `sd_adr` in CMP5 is the native's own table — see `ADR_STD_CMP5_STORED`;
 *  - `C_No` in CMP3/CMP4/CMP5 is `raw * 0.05f` — the multiply by the *float32* `0.05` moves the
 *    result one float32 step up for 553 of b2's 2 610 CMP4 observations (`46.1 → 46.100002…`),
 *    which `fround(raw / 20)` does not reproduce;
 *  - `dop`, `lock_time`, `sd_psr` (CMP1–CMP4) and `C_No` (CMP1/CMP2) are plain `Math.fround`.
 *
 * With those rules b5's 3 478 252-byte `-b` file is byte-identical; before the CMP5 table it differed
 * in the `sd_adr` bytes of all 828 observations.
 */
function buildRangeBinaryPayload(
  observations: ReturnType<typeof decodeRangeCmp2>,
  version: number,
): Uint8Array {
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  const float32Fifth = Math.fround(0.05);
  const cmp4 = version === 1734 || version === 2050;
  const cmp5 = version === 2537;
  const out = new Uint8Array(4 + observations.length * 44);
  const view = new DataView(out.buffer);
  view.setUint32(0, observations.length, true);
  observations.forEach((obs, index) => {
    const at = 4 + index * 44;
    view.setUint16(at, obs.sv_prn & 0xffff, true);
    view.setUint16(at + 2, obs.sv_freq & 0xffff, true);
    view.setFloat64(at + 4, obs.psr, true);
    view.setFloat32(at + 12, Math.fround(cmp5 ? round3(obs.sd_psr) : obs.sd_psr), true);
    view.setFloat64(at + 16, obs.adr, true);
    view.setFloat32(
      at + 24,
      cmp5
        ? Math.fround(obs.sd_adr === 0 ? 0 : storedCmp5AdrStd(obs.sd_adr))
        : Math.fround(cmp4 ? round3(obs.sd_adr) : obs.sd_adr),
      true,
    );
    view.setFloat32(at + 28, Math.fround(obs.dop), true);
    view.setFloat32(
      at + 32,
      cmp4 || cmp5 ? Math.fround(Math.round(obs.C_No * 20) * float32Fifth) : Math.fround(obs.C_No),
      true,
    );
    view.setFloat32(at + 36, Math.fround(obs.lock_time), true);
    view.setUint32(at + 40, obs.c_status >>> 0, true);
  });
  return out;
}

/**
 * The frame the suite writes for a compressed record in `BINARY`: the same header (port, sequence,
 * idle time, time status, week, milliseconds, receiver status, software version) with the message
 * id and payload length replaced, the unpacked `RANGE` payload, and a fresh CRC. Verified frame by
 * frame against `-b` on b2 and b5 — 699 `RANGE` records out of 638 + 31 + 30, and the header bytes
 * differ only in id and length.
 */
function expandedRangeFrame(frame: SbfFrame, observations: ReturnType<typeof decodeRangeCmp2>): Uint8Array {
  const payload = buildRangeBinaryPayload(observations, frame.header.messageId);
  const head = frame.bytes.slice(0, frame.header.headerLength);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  view.setUint16(4, RANGE_ID, true);
  if (frame.header.kind === 'long') view.setUint16(8, payload.length, true);
  else view.setUint8(3, payload.length);
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return appendCrcLe(body);
}

/**
 * `BINARY`'s blocks: one accepted record's bytes each, one re-encoded frame per **text** record, or
 * the unpacked `RANGE` frame that replaces a `RANGECMP*` record under the suite's default
 * `--expand-cmp`. `--no-expand-cmp` copies the compressed record verbatim: b2 writes 2 574 334 B
 * (the capture minus its 7 056 unknown bytes, the same bytes the ASCII family calls
 * `RANGECMP2`/`RANGECMP4` lines) instead of 2 733 338 B.
 *
 * A record that **renders nothing** is not written at all: the suite's binary output follows the
 * same rule as its text output, so b1 writes 256 of its 278 `RXCONFIG` records (22 carry an embedded
 * message the dictionary lacks) and b4 writes 225 of its 244 `RXCONFIGUSER` ones — measured by
 * counting the ids in the suite's own `-b` files.
 *
 * A **text** record is encoded back into a binary frame at its own position (`binary-log.ts`): the
 * suite re-serializes the fields it just parsed, so `b1`'s `-b` file holds 39 more `BESTPOS`, 26
 * more `RANGE`, 24 more `SATVIS2`, 6 `RXSTATUS`, 2 `TIMESYNC` and 2 `HWMONITOR` frames than it has
 * SBF records — exactly its 99 rendered text records — and `b7`'s holds 247 `RXCONFIG`, 90
 * `ITPSDDETECT`, 47 `ITDETECTSTATUS` and 47 `ITPSDFINAL`. A record that cannot be encoded is
 * collected into `failures` (and surfaced as `ConvertOutcome.unencodedText`), never dropped in
 * silence.
 */
function binaryBlocks(
  frames: readonly Frame[],
  tables: EdieTables,
  stamps: ReadonlyArray<RecordStamp | undefined>,
  expand: boolean,
  textAt: Map<number, string | string[]> | undefined,
  failures: TextEncodeFailure[],
  /** Per log id, how many frames the writer emitted (the Summary reports output, not input). */
  rendered: Map<number, number> = new Map(),
): ConvertBlock[] {
  const carries: RangeCarries = new Map();
  const textRecords = textAt ? collectBinaryRecords(frames, tables) : new Map();
  const blocks: ConvertBlock[] = [];
  const bump = (id: number, count: number) => rendered.set(id, (rendered.get(id) ?? 0) + count);
  frames.forEach((frame, index) => {
    // A rendered text record: the suite writes its re-encoded frame here, in capture order.
    if (textAt?.has(index)) {
      const stamp = stamps[index];
      const line = textAt.get(index);
      const first = Array.isArray(line) ? (line[0] ?? '') : String(line ?? '');
      const source = textRecords.get(index);
      if (!source) {
        failures.push({ index, name: textName(first), reason: 'no dictionary layout for this text record' });
        return;
      }
      const encoded = encodeRecord(source, tables);
      if (!encoded.bytes) {
        failures.push({ index, name: source.name, reason: encoded.error ?? 'encoding failed' });
        return;
      }
      const timeStatus = textTimeStatus(first);
      blocks.push({
        lines: [],
        bytes: encoded.bytes,
        name: source.name,
        ...(stamp ? { stamp } : {}),
        ...(timeStatus !== undefined ? { timeStatus } : {}),
        text: true,
        ...(frame.offset !== undefined ? { offset: frame.offset } : {}),
      });
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    const layout = tables.messages[String(frame.header.messageId)];
    const stamp = stamps[index];
    const common = {
      name: layout?.name ?? '',
      ...(stamp ? { stamp } : {}),
      timeStatus: frame.header.timeStatus,
      ...(frame.offset !== undefined ? { offset: frame.offset } : {}),
    };
    if (!expand || !isRangeCmp(frame)) {
      if (!layout) return;
      if (!encodeAsciiLog(frame, layout, tables)) return;
    }
    if (expand && isRangeCmp(frame)) {
      const observations = unpackRangeCmp(frame, carries);
      blocks.push({ lines: [], bytes: expandedRangeFrame(frame, observations), ...common, name: 'RANGE' });
      bump(RANGE_ID, 1);
      return;
    }
    blocks.push({ lines: [], bytes: frame.bytes, ...common });
    bump(frame.header.messageId, 1);
  });
  return blocks;
}

/** `#BESTPOSA,…` / `<BESTPOS …` → `BESTPOS`, for the failure report. */
function textName(line: string): string {
  return /^[<#]\s*([A-Za-z][A-Za-z0-9_]*)/.exec(line)?.[1]?.replace(/[AB]$/, '') ?? '';
}

/**
 * `--start-time` / `--finish-time` / `--limit-duration` (manual 4.5.4), and the GUI's Time
 * Interval, which is the same object.
 *
 * The window is applied to the SBF records by their own GPS stamp. A **text** record has a stamp
 * too — the header line prints `…,<week>,<seconds of week>,…` — and the suite filters it by that
 * stamp, not by capture order: b1 `--start-time=2442,570250 --finish-time=2442,570255` writes the
 * `<RXSTATUS USB2 … 570250.000` + four `<SATVIS2 USB2 … 570250.000` records whose bytes sit *before*
 * the first kept SBF record (3 787 B, measured 2026-11-02). Text records that do not carry a stamp
 * (`$GPGGA`, the `<OK` replies, `[USB2]` markers) still survive on position alone: they stay when
 * they sit between the first and the last kept record, which is what the suite does with the
 * continuation rows of a record that straddles the boundary.
 *
 * WEEK `0` means "the week of the first log", as the manual says. Measured against the suite: b2
 * `--start-time=2442,577760 --finish-time=2442,577770` writes 1 362 914 B / 262 lines, exactly what
 * this returns.
 *
 * `textStamps` is the header-frame index → its own GPS time in absolute milliseconds (the same
 * number `from`/`to` are in), from `textRecordStamps(textLogLines(…))`; only the caller has the
 * dictionary needed to render those headers. Without it the text side falls back to capture order.
 */
export function applyTimeWindow(
  frames: readonly Frame[],
  startTime: ConvertTimePoint | undefined,
  finishTime: ConvertTimePoint | undefined,
  limitDuration: number | undefined,
  textStamps?: ReadonlyMap<number, number>,
): readonly Frame[] {
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

  /**
   * The text side: a record whose header carries a stamp is kept by that stamp; its continuation
   * rows (`<     …`) follow it, and a `<OK`/`<ERROR` reply closes it (that is the same little state
   * machine `resolvedTextFrames` replays). A frame that is not part of a text record at all
   * (`[USB2]`, `#BESTPOSA…` without rows) never opens one.
   */
  let openText = false;
  const keepText = frames.map((frame, index) => {
    if (frame.kind !== 'text' || !textStamps) return false;
    const stamp = textStamps.get(index);
    if (stamp !== undefined) {
      openText = stamp >= from && stamp <= to;
      return openText;
    }
    if (frame.prefix !== '<') return false;
    const tokens = frame.text.slice(1).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return openText;
    if (RESPONSE_WORDS.has(tokens[0]) || tokens[0].startsWith('?')) {
      openText = false;
      return false;
    }
    return openText;
  });

  return frames.filter((frame, index) =>
    keep[index]
    || keepText[index]
    || (frame.kind !== 'sbf' && index > firstIndex && index < lastIndex));
}

/**
 * Build every file Convert writes for one capture.
 *
 * `frames` must be the frames **Convert** sees: `SbfDeframer({crcMode: 'validate'})`, text records
 * included. The app's view parser uses `mirror` mode, which keeps a nonzero-CRC record whatever its
 * CRC and therefore splits a damaged capture differently (b1: 1322 binary frames there, 1325 here),
 * so it passes a separate frame list — see `app/src/capture.ts#CaptureData.allFrames`.
 */
export function convertFrames(captureFrames: readonly Frame[], options: ConvertOptions): ConvertOutcome {
  const { format, at, tables, name } = options;
  const base = captureBase(name);
  const outputBase = affixedBase(base, options.affix);
  const expand = options.expandCmp !== false;
  const splitMode: ConvertSplitMode | undefined = options.splitMode ?? (options.split ? 'logs' : undefined);

  // The GUI's Time Interval and the CLI's `--start-time`/`--finish-time`/`--limit-duration` are one
  // rule, so the window is applied here rather than in the CLI.
  //
  // Text records are windowed by their own header stamp, which means the header has to be rendered
  // first — that needs the dictionary, so the caller (`convertFrames`) supplies the map. Only a run
  // that actually asks for a window pays for it.
  const writesText = format === 'ASCII' || format === 'ABBREV_ASCII';
  // `BINARY` needs the text records too: it writes one re-encoded frame for each, decimates by the
  // record's own header and counts it in the summary (`b1` BESTPOS 90 = 51 binary + 39 text).
  const consumesText = writesText || format === 'BINARY';
  const textLinesOf = (list: readonly Frame[]) =>
    format === 'ABBREV_ASCII' ? abbrevTextLogLines(list, tables) : textLogLines(list, tables);
  const wantsWindow = Boolean(options.startTime || options.finishTime || Number.isFinite(options.limitDuration));
  const captureText = wantsWindow && consumesText ? textLinesOf(captureFrames) : undefined;
  const windowTextStamps = captureText
    ? new Map<number, number>(
      [...textRecordStamps(captureText)].map(([index, stamp]) => [index, absoluteMilliseconds(stamp)]),
    )
    : undefined;
  const inputFrames = applyTimeWindow(
    captureFrames,
    options.startTime,
    options.finishTime,
    options.limitDuration,
    windowTextStamps,
  );
  const windowed = inputFrames !== captureFrames;
  /* The Summary's time range follows this stream (post-window, pre-decimation), not `accepted`. */
  const summaryFrames = inputFrames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');

  // `--decimate` filters the record stream itself, so the summary's Source # column follows it:
  // the suite's b1 run at `--decimate=5` lists `BESTPOS 17 → 17` where the full capture has 32.
  const inputText = consumesText ? textLinesOf(inputFrames) : undefined;
  const inputStamps: Array<RecordStamp | undefined> = stampsFor(
    inputFrames,
    inputText ? textRecordStamps(inputText) : new Map<number, RecordStamp>(),
  );
  const interval = Number.isFinite(options.decimate) && (options.decimate as number) > 0
    ? (options.decimate as number)
    : undefined;
  const frames = interval ? decimateFrames(inputFrames, inputStamps, interval) : inputFrames;
  const textMap = frames === inputFrames ? inputText : (consumesText ? textLinesOf(frames) : undefined);
  const stamps = frames === inputFrames
    ? inputStamps
    : stampsFor(frames, textMap ? textRecordStamps(textMap) : new Map<number, RecordStamp>());

  /**
   * The records the reader never reaches: the ones `--decimate` drops, and the SBF records a Time
   * Interval leaves out. Their own bytes are neither written nor "unknown" — measured on b1:
   * `--decimate=5` writes a 4 014 B `.UNKNOWN` instead of 5 386, `--start-time=2442,570250
   * --finish-time=2442,570255` 3 770 B, and both together 3 770 B as well (the window already covers
   * all 22 silent `RXCONFIG`s, 1 616 B; decimation covers 19 of them, 1 372 B).
   *
   * Text records are **not** narrowed by the window in this account: b1's 3 770 bytes of banners,
   * `[USB2]` markers and `<OK` replies survive the window intact, so only SBF records are skipped
   * here. The decimation is decided over the **whole capture** — a window narrows which records are
   * written, not which ones the decimator throws away.
   */
  const skipped: Frame[] = [];
  if (windowed) {
    const keptByWindow = new Set<Frame>(inputFrames);
    for (const frame of captureFrames) {
      if (frame.kind === 'sbf' && !keptByWindow.has(frame)) skipped.push(frame);
    }
  }
  if (interval) {
    const captureStamps = stampsFor(
      captureFrames,
      textRecordStamps(captureText ?? (consumesText ? textLinesOf(captureFrames) : new Map<number, RecordStamp>())),
    );
    const keptByDecimation = new Set<Frame>(decimateFrames(captureFrames, captureStamps, interval));
    for (const frame of captureFrames) if (!keptByDecimation.has(frame)) skipped.push(frame);
  }

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
  /** `BINARY` only: text records whose re-encoding failed (never silently dropped). */
  let unencodedText: TextEncodeFailure[] = [];

  // Unknown bytes, when the caller handed us the capture itself (they are in no frame). The account
  // is over the **whole** capture and the Summary's UNKNOWN row never moves: the suite's b1 run at
  // `--decimate=5` still reports 3 695. What moves is `.UNKNOWN` itself — the bytes of the records
  // the reader never reached are in neither file (5 386 → 4 014 B on b1 with `--decimate=5`, →
  // 3 770 B with a Time Interval). `skipped` above carries exactly those records.
  const mode: UnknownBytesMode = options.unknownBytes ?? 'ignore';
  const source = options.source;
  const spans = source && source.length > 0 && captureFrames.every((frame) => frame.offset !== undefined)
    ? unknownSpans(captureFrames, tables, source.length, skipped)
    : undefined;
  const textFamily = format === 'ASCII' || format === 'ABBREV_ASCII' || format === 'BINARY';
  /**
   * `--unknown-bytes` under a split mode, all measured on the 2.11.0 suite (2026-11-02):
   *
   *  - **no split**: `file` writes `<base>.UNKNOWN`, `interleave` splices into `<base>.<ext>`;
   *  - **`--split` (LOGS)**: neither splices — both write the whole unknown stream to
   *    `<base>_UNKNOWN.<ext>`, byte-identical for `file` and `interleave` (b1, all three formats:
   *    5 386 B / `d3855e28…`). There is no combined file to splice into, and the suite does not
   *    repeat the junk inside every per-log file;
   *  - **`--limit-output-size` / `--limit-output-duration` / `--daily-utc`**: **both** splice. The
   *    sidecar is not written at all — `--unknown-bytes=file` is ignored and behaves exactly like
   *    `interleave` (b2 `--limit-output-size=1`: the same five parts, sizes and digests, with no
   *    `.UNKNOWN`; b7 `--daily-utc`: the same three parts as the interleaved run). The parts are a
   *    partition of the *interleaved* stream (see `partitionPieces`).
   *
   * A **Time Interval does not stop it**: measured on b1 `--start-time=2442,570250
   * --finish-time=2442,570255 --unknown-bytes=interleave` (2026-11-02) the suite writes 985 626 B =
   * the windowed stream (981 856 B) + exactly the windowed `.UNKNOWN` (3 770 B) spliced back at its
   * capture offsets. So the runs are `spans.fileRuns` — the windowed account, which already drops
   * the bytes of the records the window skipped — and no window-relative re-basing happens: the
   * bytes keep their capture offsets and the first block is simply the first record the window kept.
   */
  const splitSplices = mode !== 'ignore' && splitMode !== undefined && splitMode !== 'logs';
  const spliced = spans && source && textFamily && splitMode !== 'logs'
    && (mode === 'interleave' || splitSplices)
    ? { runs: spans.fileRuns, source }
    : undefined;

  if (format === 'ASCII') {
    const rendered = new Map<number, number>();
    const textAt = textMap ?? new Map<number, string | string[]>();
    const blocks = renderBlocks(frames, tables, textAt, (frame, layout) => {
      const line = encodeAsciiLog(frame, layout, tables);
      return line ? [line] : [];
    }, stamps, expand, rendered);
    files.push(...assembleFiles(outputBase, 'ASCII', true, blocks, splitMode, options, spliced));
    countsRendered = rendered;
    countsText = textAt;
  } else if (format === 'ABBREV_ASCII') {
    const rendered = new Map<number, number>();
    const textAt = textMap ?? new Map<number, string | string[]>();
    const blocks = renderBlocks(
      frames, tables, textAt,
      (frame, layout) => encodeAbbrevLines(frame, layout, tables),
      stamps, expand, rendered,
    );
    files.push(...assembleFiles(outputBase, 'ABBREV_ASCII', true, blocks, splitMode, options, spliced));
    countsRendered = rendered;
    countsText = textAt;
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
    files.push(textFile(`${outputBase}_BESTPOS.KML`, buildKml(points, { name: `${outputBase}_BESTPOS` })));
  } else if (format === 'RINEX21') {
    files.push(textFile(`${outputBase}.${yy}O`, buildRinex21Obs(accepted, tables, { builtAt: at })));
    files.push(textFile(`${outputBase}.${yy}N`, buildRinex21Nav(accepted, tables, { builtAt: at })));
    files.push(textFile(`${outputBase}.${yy}G`, buildRinex21GloNav({ builtAt: at })));
  } else if (format.startsWith('RINEX30')) {
    // `RINEX301` -> `3.01`. The offsets are 5 and 6 (the `3` of `RINEX3` is at index 5); slicing from
    // 6 would build `0.1`, which is not a version and used to slip through into the `.YYO` header.
    const version = `${format.slice(5, 6)}.${format.slice(6)}` as Rinex3Version;
    files.push(textFile(`${outputBase}.${yy}O`, buildRinex3Obs(accepted, tables, version, { builtAt: at })));
    files.push(textFile(`${outputBase}.${yy}N`, buildRinex3Nav(accepted, tables, version, { builtAt: at })));
    // One header-only nav file per constellation the version supports (the set grows from 3.01 to
    // 3.03); none of these captures carries a non-GPS ephemeris, so they are all bare headers.
    for (const system of rinex3NavSystems(version)) {
      files.push(textFile(
        `${outputBase}.${yy}${RINEX3_NAV_EXTENSIONS[system]}`,
        buildRinex3EmptyNav(system, version, { builtAt: at }),
      ));
    }
  } else {
    const failures: TextEncodeFailure[] = [];
    const rendered = new Map<number, number>();
    const blocks = binaryBlocks(frames, tables, stamps, expand, textMap, failures, rendered);
    unencodedText = failures;
    files.push(...assembleFiles(outputBase, 'BINARY', false, blocks, splitMode, options, spliced));
    // The Summary's OUTPUT column: a record that renders nothing is not written (`RXCONFIG
    // 278 → 256`), and an expanded `RANGECMP*` counts as the `RANGE` frame it becomes. Text records
    // are added by `countTextRecords`, so they are not in this map.
    countsRendered = rendered;
    countsText = textMap;
  }

  const counts = countLogs(converted, tables, {
    rendered: countsRendered,
    // A `BINARY` file is the only other place a `RANGECMP*` becomes a `RANGE` record: with the
    // suite's default expansion the summary reads `RANGE 638 → 699`, `RANGECMP2 31 → 0`; under
    // `--no-expand-cmp` it keeps 1:1 (measured on b2 both ways).
    ...(countsRendered === undefined && expand ? { expandRanges: true } : {}),
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
    /**
     * `--split` (LOGS) is the one split mode that writes a sidecar instead of splicing, and it names
     * it after the split pattern: `<base>_UNKNOWN.<ext>` — for `file` **and** `interleave` alike
     * (measured on b1 in ASCII, ABBREV_ASCII and BINARY: all three sidecars are the same 5 386 bytes,
     * `d3855e28…`). Every other mode either writes `<base>.UNKNOWN` (no split) or splices the runs
     * into the parts and writes nothing (size/time/daily) — see `spliced` above.
     */
    if (mode !== 'ignore' && textFamily && spliced === undefined) {
      const name = splitMode === 'logs' ? `${outputBase}_UNKNOWN.${format}` : `${outputBase}.UNKNOWN`;
      files.push({ name, text: null, bytes: unknownBytes });
    }
  }

  /**
   * `N bytes could not be converted.` on the ASCII family is the **unknown bytes the run kept**,
   * and the suite prints it only when they are preserved (`--unknown-bytes=file` or `interleave`);
   * with `ignore` / no flag the sentence is absent (measured on b1: 5 386 with `file`, 5 386 with
   * `interleave`, no sentence with `ignore`). The number follows decimation and the Time Interval
   * through `unknownBytes` (b1: 4 014 with `--decimate=5`, 3 770 with the window).
   */
  if (textFamily && (mode === 'file' || mode === 'interleave')) {
    unConvertedBytes = unknownBytes.length;
  }

  return {
    format,
    formatDirectory: formatDirectory(format),
    base,
    outputBase,
    files,
    all,
    passthrough,
    converted,
    accepted,
    summaryFrames: summaryFrames.length > 0 ? summaryFrames : accepted,
    counts,
    unknownCount,
    unknown: unknownBytes,
    unConvertedBytes,
    unencodedText,
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
