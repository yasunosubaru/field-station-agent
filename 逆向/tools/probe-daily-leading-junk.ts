/**
 * Gap B/E7-2: `--daily-utc` and the unknown bytes **before the first record**.
 *
 * b1 measured one shape: a single 13-byte run (`\r\n<OK\r\n[USB2]`) in front of the first record,
 * and `--daily-utc` drops it (5 094 255 = 5 088 882 + 5 386 − 13). "Several runs, with a record that
 * prints nothing in between" was an inference, and the two plausible rules disagree:
 *
 *   A. drop **every piece before the first block that writes bytes** (what `assembleFiles` does:
 *      the merged unknown run — leading junk, the silent record and the junk behind it — goes);
 *   B. drop only what comes before the first record the **pre-scan** parses (the silent record is a
 *      record, so only the leading junk goes and the silent record + later junk stay).
 *
 * The capture shape that separates them:
 *
 *   junkA + silent #RXCONFIGA + junkB + BESTPOS + BESTPOS
 *
 *   node 逆向/tools/probe-daily-leading-junk.ts
 *
 * Runs the installed suite (`-a --daily-utc --unknown-bytes=interleave`) and our `convertFrames` on
 * the same bytes and prints sizes, digests and the head/tail of the part.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { appendCrcLe, crcHex, novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { SbfDeframer, type Frame, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import { SUITE, TEMP_ROOT, capture, frame } from './oracle.ts';

const tables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

/** Full digest for the comparison; `sha16` is only what the log prints. */
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha16 = (bytes: Uint8Array) => sha(bytes).slice(0, 16);
const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

const b2 = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '00_来源', 'samples', 'live-20261031', 'b2-20261101.sbf')));
const bestpos = [...new SbfDeframer({ crcMode: 'validate' }).push(b2)]
  .find((entry): entry is SbfFrame => entry.kind === 'sbf' && entry.header.messageId === 42);
if (!bestpos) throw new Error('b2 carries no BESTPOS');

function record(milliseconds: number, timeStatus = 180): Uint8Array {
  return frame(42, bestpos!.payload, { week: 2442, milliseconds, timeStatus });
}

/** `#RXCONFIGA` around an embedded name the dictionary lacks: parsed by name, prints nothing. */
function silent(week: number, milliseconds: number): Uint8Array {
  const seconds = (milliseconds / 1000).toFixed(3);
  const inner = `BOGUS,USB2,0,72.0,FINESTEERING,${week},${seconds},03801800,cdba,18278;ALPHA,BETA`;
  const sentence = `RXCONFIGA,USB2,0,72.0,FINESTEERING,${week},${seconds},03801800,cdba,18278;#${inner}*00000000`;
  return latin1(`#${sentence}*${crcHex(novatelCrc32(latin1(sentence)))}\r\n`);
}

interface SuiteRun { name: string; bytes: Uint8Array }

function suite(captureBytes: Uint8Array, label: string, flags: string[]): SuiteRun[] {
  const dir = mkdtempSync(join(TEMP_ROOT, `daily-junk-${label}-`));
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
    return files
      .filter((file) => !file.name.startsWith('Summary_'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ours(captureBytes: Uint8Array, mode: 'daily' | 'time' = 'daily') {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(captureBytes)];
  return convertFrames(frames, {
    format: 'ASCII', at: new Date('2026-11-01T00:00:00Z'), tables, name: 'probe.sbf',
    source: captureBytes, unknownBytes: 'interleave',
    ...(mode === 'daily' ? { splitMode: 'daily' as const } : { splitMode: 'time' as const, splitSeconds: 5 }),
  }).files;
}

const head = (bytes: Uint8Array, count = 70) => JSON.stringify(text(bytes).slice(0, count));

let failures = 0;
function compare(label: string, captureBytes: Uint8Array, note: string, mode: 'daily' | 'time' = 'daily', unknownBytes = 'interleave') {
  const flags = mode === 'daily'
    ? ['-a', '--daily-utc', `--unknown-bytes=${unknownBytes}`]
    : ['-a', '--limit-output-duration=5', `--unknown-bytes=${unknownBytes}`];
  const theirs = suite(captureBytes, `${label}-${mode}`, flags);
  const mine = mode === 'daily'
    ? ours(captureBytes, mode).map((file) => ({ name: file.name, bytes: file.bytes }))
    : ours(captureBytes, mode);
  const same = theirs.length === mine.length
    && theirs.every((file, index) => file.bytes.length === mine[index].bytes.length
      && sha(file.bytes) === sha(mine[index].bytes));
  if (!same) failures += 1;
  console.log(`\n=== ${label} [${mode}, ${unknownBytes}]  ${same ? 'SAME' : 'DIFF'}  ${note}`);
  theirs.forEach((file, index) => {
    const mineFile = mine[index];
    const ok = mineFile && file.bytes.length === mineFile.bytes.length && sha(file.bytes) === sha(mineFile.bytes);
    console.log(` ${ok ? '  ' : '!!'} ${file.name.padEnd(22)} suite ${String(file.bytes.length).padStart(5)} ${sha16(file.bytes)}`
      + `   ours ${mineFile ? `${String(mineFile.bytes.length).padStart(5)} ${sha16(mineFile.bytes)}` : '(missing)'}`);
    console.log(`     suite head ${head(file.bytes)}`);
    if (mineFile) console.log(`     ours  head ${head(mineFile.bytes)}`);
  });
}

// D1 — the discriminator: junk, a silent record, junk, then the first record that prints.
const junkA = '\r\n<OK\r\n[USB2]'; // b1's own 13-byte opening run
const junkB = '\r\n[USB2]'; // 8 bytes

compare('D1 junk+silent+junk+records', capture(
  junkA, silent(2442, 577_700_000), junkB,
  record(577_759_000), record(577_760_000),
), 'drop-all-before-first-print (A) vs drop-before-first-parsed-record (B)');

// D2 — no leading junk at all: the run that opens the file holds the silent record and the junk.
compare('D2 silent+junk+records', capture(
  silent(2442, 577_700_000), junkB,
  record(577_759_000), record(577_760_000),
), 'with rule A the silent record disappears too; with B it and junkB stay');

// D3 — control: junk *after* the first record is never dropped (both rules agree).
compare('D3 record+junk+silent+junk+record', capture(
  record(577_759_000), junkB, silent(2442, 577_761_000), '\r\n<OK\r\n',
  record(577_762_000),
), 'middle junk and the silent record stay, whatever the rule');

// D4 — a longer chain before the first printed record: junk, silent, junk, silent, junk.
compare('D4 two silent records', capture(
  junkA, silent(2442, 577_700_000), junkB, silent(2442, 577_701_000), '\r\n<OK\r\n[USB2]\r\n',
  record(577_759_000), record(577_760_000),
), 'is every run before the first record dropped, or only the first?');

// D5 — the first record is a *text* record that prints; junk before it (b1's own shape).
const bestposSentence = 'BESTPOSA,USB2,0,72.0,FINESTEERING,2442,577759.000,03801800,cdba,18278;'
  + 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,2.8355,'
  + '"",0.000,0.000,31,17,17,17,00,06,30,03';
compare('D5 junk+text-record', capture(
  junkA, latin1(`#${bestposSentence}*${crcHex(novatelCrc32(latin1(bestposSentence)))}\r\n`),
  record(577_760_000),
), 'the control b1 measured, reproduced on synthetic bytes');

// D6 — the contrast: the *same* bytes under `--limit-output-duration` keep the leading run. The
// drop is `--daily-utc`-only, not "the pipeline never writes junk before a record".
const d2 = capture(
  silent(2442, 577_700_000), junkB,
  record(577_759_000), record(577_760_000),
);
compare('D6 same bytes, --limit-output-duration=5', d2,
  'time keeps the opening run (junk + silent record + junk), daily drops it', 'time');

// D7 — `--unknown-bytes=file` under `--daily-utc` behaves like `interleave` here too (no sidecar).
compare('D7 D1 bytes, --unknown-bytes=file', capture(
  junkA, silent(2442, 577_700_000), junkB,
  record(577_759_000), record(577_760_000),
), 'SEPARATEFILE is ignored under a daily split', 'daily', 'file');

console.log(failures === 0 ? '\nall cases byte-identical' : `\n${failures} case(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
