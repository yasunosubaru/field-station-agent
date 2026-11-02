/**
 * Gap B/E7-1: what can **anchor** a `--limit-output-duration` part?
 *
 * `partitionPieces` starts a part's 5 s window at the first record it sees — but only when that
 * record is the part's *first piece* (no unknown bytes in front of it) or when the record's time
 * status is in the trusted set. b2 measured two data points (COARSESTEERING 120 anchors a part that
 * opens on junk; the almanac's SATTIME 200 anchors a part that opens on nothing). This probe fills
 * the rest: 80/100/160 as the first frame's status, and a **text** record as the anchor (the text
 * gate is one status wider — COARSESTEERING 60).
 *
 *   node 逆向/tools/probe-time-anchor.ts
 *
 * For every case it runs the installed suite (`-a --limit-output-duration=5
 * --unknown-bytes=interleave`) and our `convertFrames` on the same bytes, and prints per-part
 * sizes, digests and the record stamps, so a disagreement is visible field by field.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { appendCrcLe, novatelCrc32, crcHex } from '../04_重实现/packages/protocol/src/crc.ts';
import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import { buildLongHeader } from '../04_重实现/packages/protocol/src/header.ts';
import { SUITE, TEMP_ROOT, capture, frame } from './oracle.ts';

const tables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

/** Full digest for the comparison; `sha16` is only what the log prints. */
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha16 = (bytes: Uint8Array) => sha(bytes).slice(0, 16);
const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** b2's own BESTPOS payload, so the record prints the full line. */
const b2 = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '00_来源', 'samples', 'live-20261031', 'b2-20261101.sbf')));
const bestpos = [...new SbfDeframer({ crcMode: 'validate' }).push(b2)]
  .find((entry): entry is SbfFrame => entry.kind === 'sbf' && entry.header.messageId === 42);
if (!bestpos) throw new Error('b2 carries no BESTPOS');

/** A BESTPOS frame at `milliseconds` of week 2442 with a chosen time status. */
function record(milliseconds: number, timeStatus: number, week = 2442): Uint8Array {
  return frame(42, bestpos!.payload, { week, milliseconds, timeStatus });
}

/** b1's `#BESTPOSA` body — a canonical message the parser renders. */
const BESTPOS_BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,'
  + '1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';

/** A `#BESTPOSA` text record with its own header time (CRC over the sentence after the `#`). */
function textBestpos(week: number, milliseconds: number, status: string): Uint8Array {
  const seconds = (milliseconds / 1000).toFixed(3);
  const sentence = `BESTPOSA,USB2,0,72.0,${status},${week},${seconds},03801800,cdba,18278;${BESTPOS_BODY}`;
  const crc = crcHex(novatelCrc32(latin1(sentence)));
  return latin1(`#${sentence}*${crc}\r\n`);
}

/**
 * A text record that is **resolved by name but prints nothing**: an `#RXCONFIGA` whose embedded
 * message the dictionary does not carry (b7's 22 silent records). The outer CRC covers the sentence
 * after the leading `#`, so the suite takes the record; the inner name `BOGUS` is what makes the
 * writer drop it.
 */
function silentRxconfig(week: number, milliseconds: number, status = 'FINESTEERING'): Uint8Array {
  const seconds = (milliseconds / 1000).toFixed(3);
  const inner = `BOGUS,USB2,0,72.0,FINESTEERING,${week},${seconds},03801800,cdba,18278;ALPHA,BETA`;
  const sentence = `RXCONFIGA,USB2,0,72.0,${status},${week},${seconds},03801800,cdba,18278;#${inner}*00000000`;
  return latin1(`#${sentence}*${crcHex(novatelCrc32(latin1(sentence)))}\r\n`);
}

interface SuiteRun { name: string; bytes: Uint8Array }

/** Run the suite with arbitrary flags and return every file it wrote, by name. */
function suite(captureBytes: Uint8Array, label: string, flags: string[]): SuiteRun[] {
  const dir = mkdtempSync(join(TEMP_ROOT, `time-anchor-${label}-`));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, captureBytes);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, [...flags, '-o', out, input], { stdio: 'pipe', timeout: 180_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const root = join(out, stem, stamp);
    const files: SuiteRun[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push({ name: entry, bytes: new Uint8Array(readFileSync(full)) });
      }
    };
    walk(root);
    // The Summary is a separate writer (`summary.ts`), not part of the convert pipeline.
    return files
      .filter((file) => !file.name.startsWith('Summary_'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Our conversion of the same bytes with the same flags. */
function ours(captureBytes: Uint8Array, options: Record<string, unknown>, source: boolean) {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(captureBytes)];
  return convertFrames(frames, {
    format: 'ASCII', at: new Date('2026-11-01T00:00:00Z'), tables, name: 'probe.sbf',
    ...(source ? { source: captureBytes } : {}),
    ...options,
  } as Parameters<typeof convertFrames>[1]).files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The record stamps a part holds, in output order (`#NAME,…` lines only). */
function stampsOf(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('latin1');
  const out: string[] = [];
  const pattern = /#([A-Z][A-Z0-9_]*),/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const fields = text.slice(match.index + 1).split(/[,;]/);
    out.push(`${fields[5]}/${fields[6]}`);
  }
  return out;
}

const FLAGS = ['-a', '--limit-output-duration=5', '--unknown-bytes=interleave'];

function compare(label: string, captureBytes: Uint8Array): boolean {
  const theirs = suite(captureBytes, label, FLAGS);
  const mine = ours(captureBytes, { splitMode: 'time', splitSeconds: 5, unknownBytes: 'interleave' }, true);
  const same = theirs.length === mine.length
    && theirs.every((file, index) => file.bytes.length === mine[index].bytes.length
      && sha(file.bytes) === sha(mine[index].bytes));
  console.log(`\n=== ${label}  ${same ? 'SAME' : 'DIFF'}  ${theirs.length} suite / ${mine.length} ours`);
  theirs.forEach((file, index) => {
    const mineFile = mine[index];
    const mark = mineFile && file.bytes.length === mineFile.bytes.length && sha(file.bytes) === sha(mineFile.bytes) ? '  ' : '!!';
    console.log(` ${mark} ${file.name.padEnd(24)} suite ${String(file.bytes.length).padStart(6)} ${sha16(file.bytes)}`
      + `   ours ${mineFile ? `${String(mineFile.bytes.length).padStart(6)} ${sha16(mineFile.bytes)}` : '(missing)'}`);
    console.log(`     suite stamps ${JSON.stringify(stampsOf(file.bytes))}`);
    if (mineFile) console.log(`     ours  stamps ${JSON.stringify(stampsOf(mineFile.bytes))}`);
  });
  return same;
}

/**
 * The shape that decides the rule: a part that opens on unknown bytes, then a record at status
 * `status` stamped 577140, then ordinary FINESTEERING records. With 577140 as the anchor the cut is
 * `[577140 … 577150] [577152]`; anchored at 577145 it is `[577145 … 577152]` (one part).
 */
function anchored(status: number, label: string): boolean {
  const captureBytes = capture(
    '\r\n<OK\r\n[USB2]',
    record(577_140_000, status),
    record(577_145_000, 180), record(577_146_000, 180), record(577_147_000, 180),
    record(577_148_000, 180), record(577_150_000, 180), record(577_152_000, 180),
  );
  return compare(label, captureBytes);
}

/** The same records with a text record as the first piece after the junk. */
function textAnchored(status: string, label: string): boolean {
  const captureBytes = capture(
    '\r\n<OK\r\n[USB2]',
    textBestpos(2442, 577_140_000, status),
    record(577_145_000, 180), record(577_146_000, 180), record(577_147_000, 180),
    record(577_148_000, 180), record(577_150_000, 180), record(577_152_000, 180),
  );
  return compare(label, captureBytes);
}

let failures = 0;
const check = (ok: boolean) => { if (!ok) failures += 1; };

// 1. Binary first frame after junk: which statuses anchor.
for (const status of [80, 100, 160, 120, 180]) check(anchored(status, `junk+binary${status}`));
// Negative controls: a status the daily gate rejects must not anchor.
for (const status of [20, 60, 200]) check(anchored(status, `junk+binary${status}`));

// 0 is a *known, unrelated* difference: the suite prints the time status 0 as `UNKNOWN` while
// `ascii-log.ts` falls back to `String(0)` (`0`), six bytes shorter. Reported, not counted: this
// probe is about anchors, and `ascii-log.ts` is outside this task's edit boundary.
console.log('\n--- status 0 (known rendering difference, not an anchor question)');
compare('junk+binary0 (known DIFF)', capture(
  '\r\n<OK\r\n[USB2]',
  record(577_140_000, 0),
  record(577_145_000, 180), record(577_146_000, 180), record(577_147_000, 180),
  record(577_148_000, 180), record(577_150_000, 180), record(577_152_000, 180),
));

// 2. Text record as the anchor: the text gate is one status wider (COARSESTEERING counts).
for (const status of ['COARSESTEERING', 'FINE', 'FINESTEERING']) check(textAnchored(status, `junk+text-${status}`));
for (const status of ['UNKNOWN', 'APPROXIMATE', 'SATTIME']) check(textAnchored(status, `junk+text-${status}`));

// 3. A record with no junk in front of it anchors whatever its status (first piece of the part).
for (const status of [80, 100, 160, 200]) {
  check(compare(`no-junk+binary${status}`, capture(
    record(577_140_000, status),
    record(577_145_000, 180), record(577_146_000, 180), record(577_147_000, 180),
    record(577_148_000, 180), record(577_150_000, 180), record(577_152_000, 180),
  )));
}

// 4. The anchor is the first **trusted** record, whichever kind it is: an untrusted binary record
//    does not start the clock, a text record behind it (COARSESTEERING = 60, text-only) does.
check(compare('junk+binary200+text60+binary', capture(
  '\r\n<OK\r\n[USB2]',
  record(577_140_000, 200),
  textBestpos(2442, 577_143_000, 'COARSESTEERING'),
  record(577_145_000, 180), record(577_146_000, 180), record(577_147_000, 180),
  record(577_148_000, 180), record(577_150_000, 180), record(577_152_000, 180),
)));

// 5. No trusted record at all after the junk: the clock never starts, one part, everything stays.
check(compare('junk+all-untrusted', capture(
  '\r\n<OK\r\n[USB2]',
  record(577_140_000, 200), record(577_143_000, 60), record(577_150_000, 20),
)));

console.log(failures === 0 ? '\nall cases byte-identical' : `\n${failures} case(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
