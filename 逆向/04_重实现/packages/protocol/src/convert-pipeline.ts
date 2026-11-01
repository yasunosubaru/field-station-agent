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
   * `--limit-output-size` / `--limit-output-duration` / `--split` / `--daily-utc`, the suite's
   * `splitBy` (`01_解包/app/view/convert/cli.js`: `SIZE` > `TIME` > `LOGS` > `DAILY`). Every mode
   * writes `<base>_Part<N>.<ext>` except `'logs'`, which is the per-log writer above.
   */
  splitMode?: ConvertSplitMode;
  /** `--limit-output-size=<MB>`: one **mebibyte** (1 048 576 B), measured on b2 — see `partition`. */
  splitSizeMb?: number;
  /** `--limit-output-duration=<SECONDS>`. */
  splitSeconds?: number;
  /**
   * `--unknown-bytes` (`cli.js:161-164`): what to do with the bytes Convert cannot attribute to a
   * log. `'file'` writes them next to the output as `<base>.UNKNOWN`, `'interleave'` splices them
   * into the converted file at the position they came from, `'ignore'` (the default, the suite's
   * `SKIP`) drops them — the summary still counts them either way.
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
   * The raw capture. Only needed for the unknown-byte accounting: those bytes are, by definition,
   * in no frame, so they cannot be recovered from the frame list.
   */
  source?: Uint8Array;
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
   * The record's time status. `--daily-utc` only moves its day clock on an *observation* time:
   * `FINE`…`FINESTEERING`, not `COARSESTEERING`/`APPROXIMATE`/`UNKNOWN`/`SATTIME` — see
   * `partitionBlocks`.
   */
  timeStatus?: number;
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
    const timeStatus = frames[index].kind === 'sbf'
      ? (frames[index] as SbfFrame).header.timeStatus
      : textTimeStatus(lines[0] ?? '');
    blocks.push({
      lines,
      bytes: latin1Bytes(`${lines.join('\r\n')}\r\n`),
      name,
      ...(stamps[index] ? { stamp: stamps[index] } : {}),
      ...(timeStatus !== undefined ? { timeStatus } : {}),
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
 * The time statuses that carry an **observation** time as far as `--daily-utc` is concerned:
 * `FINE` (80), `FINEADJUSTING` (100), `DEGRADED` (120), `ALIGNING` (160) and `FINESTEERING` (180).
 *
 * Measured with one synthetic record per status, `[2442:577759:180, 0:2.176:<status>, 2442:577760:180]`:
 * statuses 0, 20, 60 and 200 leave the capture at one part, 80/100/120/160/180 split it — i.e.
 * `COARSESTEERING` (60) does **not** move the day clock, and `SATTIME` (200) is out as well.
 */
const DAILY_CLOCK_TIME_STATUS = new Set([80, 100, 120, 160, 180]);

/**
 * Split `blocks` into the parts one of the three file-splitting modes writes.
 *
 * `'size'` — see `MEBIBYTE` above.
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
 * `'daily'` — `--daily-utc`: a new part whenever a record's GPS day (whole days since the GPS
 * epoch, **no leap-second correction** — the boundary is seconds-of-week ≡ 0 mod 86400, measured
 * either side of 518400 and 604800) is *later* than the previous record's day. Late records never
 * move back, and a jump inside one day never splits. b2 spans one UTC day, hence one part of the
 * whole file (905 lines / 4 931 973 B, named `b2-20261101_Part0.ASCII`).
 */
function partitionBlocks(
  blocks: readonly ConvertBlock[],
  splitMode: ConvertSplitMode | undefined,
  options: ConvertOptions,
): ConvertBlock[][] {
  if (splitMode === undefined || splitMode === 'logs') return [blocks.slice()];
  const parts: ConvertBlock[][] = [];
  let current: ConvertBlock[] = [];
  const close = () => { parts.push(current); current = []; };
  if (splitMode === 'size') {
    const limit = (options.splitSizeMb ?? 0) * MEBIBYTE;
    let bytes = 0;
    for (const block of blocks) {
      current.push(block);
      bytes += block.bytes.length;
      if (limit > 0 && bytes >= limit) { close(); bytes = 0; }
    }
  } else if (splitMode === 'time') {
    const duration = (options.splitSeconds ?? 0) * 1000;
    let start: number | undefined;
    let expired = false;
    for (const block of blocks) {
      const stamp = block.stamp ? absoluteMilliseconds(block.stamp) : undefined;
      if (stamp !== undefined && duration > 0) {
        if (start === undefined) start = stamp;
        else if (expired && stamp > start + duration) { close(); start = stamp; expired = false; }
      }
      current.push(block);
      if (stamp !== undefined && start !== undefined && !expired && duration > 0 && stamp - start >= duration) {
        expired = true;
      }
    }
  } else {
    let clockDay: number | undefined;
    for (const block of blocks) {
      const day = block.stamp ? gpsDay(block.stamp) : undefined;
      // The clock starts at the first record that carries a stamp at all, whatever its status, and
      // from then on only records whose status means "this is an observation time" can move it.
      // b2's `ALMANAC` (200) and `GLORAWALM` (200, week 2402 of a 2026-11 capture) leave it at one
      // part; b1's 24 `RXCONFIG` records stamped 0 with status 200 and its `id 1246` frames with
      // status 20 and week 0 leave it at one part too — while a status-180 record stamped 0 does
      // start the clock at day 0 and splits the capture at the first real record.
      if (day !== undefined) {
        if (clockDay === undefined) clockDay = day;
        else if (DAILY_CLOCK_TIME_STATUS.has(block.timeStatus ?? -1)) {
          if (day > clockDay) close();
          clockDay = day;
        }
      }
      current.push(block);
    }
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [[]];
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
 */
function assembleFiles(
  base: string,
  extension: string,
  text: boolean,
  blocks: readonly ConvertBlock[],
  splitMode: ConvertSplitMode | undefined,
  options: ConvertOptions,
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
  const parts = partitionBlocks(blocks, splitMode, options);
  return parts.map((part, index) => {
    const bytes = concatBlocks(part);
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
 * `BINARY`'s blocks: one accepted record's bytes each, or the unpacked `RANGE` frame that replaces a
 * `RANGECMP*` record under the suite's default `--expand-cmp`. `--no-expand-cmp` copies the
 * compressed record verbatim: b2 writes 2 574 334 B (the capture minus its 7 056 unknown bytes,
 * the same bytes the ASCII family calls `RANGECMP2`/`RANGECMP4` lines) instead of 2 733 338 B.
 *
 * A record that **renders nothing** is not written at all: the suite's binary output follows the
 * same rule as its text output, so b1 writes 256 of its 278 `RXCONFIG` records (22 carry an embedded
 * message the dictionary lacks) and b4 writes 225 of its 244 `RXCONFIGUSER` ones — measured by
 * counting the ids in the suite's own `-b` files.
 *
 * Not reproduced: a **text** record in a `BINARY` conversion. The suite encodes it back into a
 * binary frame (b1's `-b` file holds 39 more `BESTPOS` and 26 more `RANGE` frames than it has SBF
 * records — exactly its 99 rendered text records), and rebuilding that payload needs a full
 * field-serialiser, which this package does not have. See `03_Convert简介.md`.
 */
function binaryBlocks(
  frames: readonly Frame[],
  tables: EdieTables,
  stamps: ReadonlyArray<RecordStamp | undefined>,
  expand: boolean,
): ConvertBlock[] {
  const carries: RangeCarries = new Map();
  const blocks: ConvertBlock[] = [];
  frames.forEach((frame, index) => {
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
      return;
    }
    blocks.push({ lines: [], bytes: frame.bytes, ...common });
  });
  return blocks;
}

/**
 * Build every file Convert writes for one capture.
 *
 * `frames` must be the frames **Convert** sees: `SbfDeframer({crcMode: 'validate'})`, text records
 * included. The app's view parser uses `mirror` mode, which keeps a nonzero-CRC record whatever its
 * CRC and therefore splits a damaged capture differently (b1: 1322 binary frames there, 1325 here),
 * so it passes a separate frame list — see `app/src/capture.ts#CaptureData.allFrames`.
 */
export function convertFrames(inputFrames: readonly Frame[], options: ConvertOptions): ConvertOutcome {
  const { format, at, tables, name } = options;
  const base = captureBase(name);
  const expand = options.expandCmp !== false;
  const splitMode: ConvertSplitMode | undefined = options.splitMode ?? (options.split ? 'logs' : undefined);

  // `--decimate` filters the record stream itself, so the summary's Source # column follows it:
  // the suite's b1 run at `--decimate=5` lists `BESTPOS 17 → 17` where the full capture has 32.
  const writesText = format === 'ASCII' || format === 'ABBREV_ASCII';
  const textLinesOf = (list: readonly Frame[]) =>
    format === 'ABBREV_ASCII' ? abbrevTextLogLines(list, tables) : textLogLines(list, tables);
  const inputText = writesText ? textLinesOf(inputFrames) : undefined;
  const inputStamps: Array<RecordStamp | undefined> = stampsFor(
    inputFrames,
    inputText ? textRecordStamps(inputText) : new Map<number, RecordStamp>(),
  );
  const interval = Number.isFinite(options.decimate) && (options.decimate as number) > 0
    ? (options.decimate as number)
    : undefined;
  const frames = interval ? decimateFrames(inputFrames, inputStamps, interval) : inputFrames;
  const textMap = frames === inputFrames ? inputText : (writesText ? textLinesOf(frames) : undefined);
  const stamps = frames === inputFrames
    ? inputStamps
    : stampsFor(frames, textMap ? textRecordStamps(textMap) : new Map<number, RecordStamp>());

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

  // Unknown bytes, when the caller handed us the capture itself (they are in no frame). Measured
  // over the **whole** capture, before `--decimate` drops anything: the suite's b1 run at
  // `--decimate=5` still reports the full 3 695 in the summary's UNKNOWN row.
  const mode: UnknownBytesMode = options.unknownBytes ?? 'ignore';
  const source = options.source;
  const spans = source && source.length > 0 && inputFrames.every((frame) => frame.offset !== undefined)
    ? unknownSpans(inputFrames, tables, source.length)
    : undefined;
  const textFamily = format === 'ASCII' || format === 'ABBREV_ASCII' || format === 'BINARY';
  // The suite only offers the option for the ASCII/BINARY family (`03_Convert组件.md §5.6`).
  const interleaving = mode === 'interleave' && textFamily && splitMode === undefined && spans !== undefined && source !== undefined;

  if (format === 'ASCII') {
    const rendered = new Map<number, number>();
    const textAt = textMap ?? new Map<number, string | string[]>();
    const blocks = renderBlocks(frames, tables, textAt, (frame, layout) => {
      const line = encodeAsciiLog(frame, layout, tables);
      return line ? [line] : [];
    }, stamps, expand, rendered);
    if (interleaving) {
      files.push(interleave(`${base}.ASCII`, blocks, spans!.fileRuns, source!));
    } else {
      files.push(...assembleFiles(base, 'ASCII', true, blocks, splitMode, options));
    }
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
    if (interleaving) {
      files.push(interleave(`${base}.ABBREV_ASCII`, blocks, spans!.fileRuns, source!));
    } else {
      files.push(...assembleFiles(base, 'ABBREV_ASCII', true, blocks, splitMode, options));
    }
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
    const blocks = binaryBlocks(frames, tables, stamps, expand);
    if (interleaving) {
      files.push(interleave(`${base}.BINARY`, blocks, spans!.fileRuns, source!));
    } else {
      files.push(...assembleFiles(base, 'BINARY', false, blocks, splitMode, options));
    }
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

/**
 * `--unknown-bytes=interleave`: put the unknown bytes back where the capture had them, ordered by
 * capture offset. Measured on a synthetic capture through `-a` / `--abbrev` / `-b`: the bytes are
 * spliced verbatim between the records, so the file is no longer line-oriented.
 */
function interleave(
  name: string,
  blocks: readonly ConvertBlock[],
  runs: readonly Span[],
  source: Uint8Array,
): ConvertFile {
  const pieces = [
    ...blocks.filter((block) => block.bytes.length > 0)
      .map((block) => ({ offset: block.offset ?? 0, bytes: block.bytes })),
    ...runs.map((run) => ({ offset: run.start, bytes: source.subarray(run.start, run.end) })),
  ].sort((a, b) => a.offset - b.offset);
  const bytes = concatBytes(pieces.map((piece) => piece.bytes));
  return { name, text: latin1(bytes), bytes };
}
