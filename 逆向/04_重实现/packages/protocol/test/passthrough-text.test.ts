/**
 * `%P` on the **text** side: a `#PASSCOM1A,…;4,\xed\xff\xf7\xb9*<crc>` record, and its `<` form.
 *
 * No receiver sample of any of the 29 `PASS*` logs exists — the pass-through ports carry data only
 * when something is wired into them — so the binary → text direction was measured earlier with a
 * synthetic frame holding all 256 byte values (`ascii-log.ts#escapePassThrough`). This file pins the
 * *other* direction: what Convert does with a pass-through record the receiver wrote as ASCII.
 *
 * Every literal below is the installed suite's own output, produced by
 * `逆向/tools/oracle-passthrough-text.ts` (same capture, three runs: `-a`, `--abbrev`, `-b`;
 * exit code 0 = all 27 cases byte-identical to ours). The rules it found:
 *
 *  - the payload is a **byte count**, not a token: `3,a,b` is the three bytes `a`, `,`, `b`, and a
 *    `<` data line's space counts the same way (`3,a b` → `61 20 62`);
 *  - it is re-escaped, never copied: `\xED` prints `\xed`, `\q` prints `\\q`;
 *  - it stops at `count` bytes (`2,abcd` → `2,ab`) and an empty count swallows the token behind it
 *    (`0,abc` → `0,`);
 *  - a count that overruns the body keeps reading the record's own text, CRC digits included
 *    (`8,abc*19fc1fdc` → `8,abc*19fc`), because the suite parses out of the line buffer;
 *  - a raw byte ≥ 0x80 anywhere in a `#` or `<` record drops that record whole — in all three
 *    formats, in the body, in an extra token and in the port name, while a good record next to it
 *    still converts;
 *  - `PASSTHROUGH` puts its port enum (and `NOPORT` for 0) in front of the same field.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { novatelCrc32 } from '../src/crc.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import { SbfDeframer, type Frame } from '../src/framing.ts';
import { abbrevTextLogLines, textLogLines } from '../src/text-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const HEAD = 'COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278';

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** A complete `#NAMEA,<head>;<body>*crc` record, CRLF terminated. */
function record(name: string, body: string, head = HEAD): Uint8Array {
  const sentence = `${name}A,${head};${body}`;
  const crc = (novatelCrc32(latin1(sentence)) >>> 0).toString(16).padStart(8, '0');
  return latin1(`#${sentence}*${crc}\r\n`);
}

function deframe(...parts: Uint8Array[]): Frame[] {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return [...new SbfDeframer({ crcMode: 'validate' }).push(all)];
}

const ascii = (frames: Frame[]): string[] => [...textLogLines(frames, tables).values()];
const abbrev = (frames: Frame[]): string[][] => [...abbrevTextLogLines(frames, tables).values()];
const binary = (frames: Frame[]): string => {
  const files = convertFrames(frames, {
    format: 'BINARY',
    at: new Date('2026-11-01T00:00:00Z'),
    tables,
    name: 'probe.sbf',
  }).files;
  return [...(files[0]?.bytes ?? [])].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
};

test('%P: one escaped token behind the count, re-escaped and lowercased', () => {
  const frames = deframe(record('PASSCOM1', '4,\\xed\\xff\\xf7\\xb9'));
  assert.deepEqual(ascii(frames), [
    `#PASSCOM1A,${HEAD};4,\\xed\\xff\\xf7\\xb9*a9bf31e7`,
  ]);
  assert.deepEqual(abbrev(frames), [
    [`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     4 \\xed\\xff\\xf7\\xb9'],
  ]);
  // `-b`: the count the suite writes is the decoded payload's length (4), the bytes are the escapes.
  assert.equal(
    binary(frames),
    'aa 44 12 1c e9 00 00 20 08 00 01 00 00 b4 62 09 18 e7 6f 22 00 08 80 03 ba cd 66 47 '
    + '04 00 00 00 ed ff f7 b9 f5 50 e2 7d',
  );
});

test('%P: uppercase `\\xNN` comes back lowercase, a bad escape comes back doubled', () => {
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '4,\\xED\\xFF\\xF7\\xB9'))), [
    `#PASSCOM1A,${HEAD};4,\\xed\\xff\\xf7\\xb9*a9bf31e7`,
  ]);
  // `\q` is not a known escape: it is a literal backslash and the letter, re-printed `\\q`.
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '2,\\q'))), [
    `#PASSCOM1A,${HEAD};2,\\\\q*cd831b8b`,
  ]);
  assert.deepEqual(abbrev(deframe(record('PASSCOM1', '2,\\q'))), [
    [`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     2 \\\\q'],
  ]);
});

test('%P: the payload is a byte count — commas, spaces and `*` are payload bytes', () => {
  // Three bytes: `a`, the comma, `b`.
  const comma = deframe(record('PASSCOM1', '3,a,b'));
  assert.deepEqual(ascii(comma), [`#PASSCOM1A,${HEAD};3,a,b*77d17cd0`]);
  assert.deepEqual(abbrev(comma), [[`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     3 a,b']]);
  assert.equal(
    binary(comma),
    'aa 44 12 1c e9 00 00 20 07 00 01 00 00 b4 62 09 18 e7 6f 22 00 08 80 03 ba cd 66 47 '
    + '03 00 00 00 61 2c 62 47 f9 61 f2',
  );
  // A `*` inside the payload is not the CRC marker either.
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '3,a*b'))), [
    `#PASSCOM1A,${HEAD};3,a*b*218bdb56`,
  ]);
});

test('%P: truncated to `count`; an empty count swallows the token behind it', () => {
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '2,abcd'))), [
    `#PASSCOM1A,${HEAD};2,ab*ff944d91`,
  ]);
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '0,abc'))), [
    `#PASSCOM1A,${HEAD};0,*71156923`,
  ]);
  assert.deepEqual(abbrev(deframe(record('PASSCOM1', '2,abcd'))), [
    [`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     2 ab'],
  ]);
});

test('%P: a count that overruns the body keeps reading the CRC trailer', () => {
  // The suite parses out of the whole record buffer, so `8` bytes starting at `abc` are
  // `abc*19fc` — its own CRC digits — and the line then carries a **recomputed** `*6ce17c80`.
  const frames = deframe(record('PASSCOM1', '8,abc'));
  assert.deepEqual(ascii(frames), [`#PASSCOM1A,${HEAD};8,abc*19fc*6ce17c80`]);
  assert.deepEqual(abbrev(frames), [[`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     8 abc*19fc']]);
});

test('%P: raw control bytes are re-escaped', () => {
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '1,\t'))), [
    `#PASSCOM1A,${HEAD};1,\\x09*7510b36d`,
  ]);
  assert.deepEqual(ascii(deframe(record('PASSCOM1', '1,\u007f'))), [
    `#PASSCOM1A,${HEAD};1,\\x7f*c18569cf`,
  ]);
});

test('%P: a raw byte >= 0x80 drops the whole record, in every format and every position', () => {
  for (const input of [
    record('PASSCOM1', '1,\u0080'),             // 0x80 in the payload
    record('PASSCOM1', '1,\u00e9'),             // latin-1 0xE9
    record('PASSCOM1', '2,\u00c3\u00a9'),       // the two UTF-8 bytes of é
    record('PASSCOM1', '1,a\u00e9'),            // an extra token behind the field
    record('PASSCOM1', '1,a', 'COM\u00e9,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278'),
  ]) {
    const frames = deframe(input);
    assert.deepEqual(ascii(frames), []);
    assert.deepEqual(abbrev(frames), []);
    assert.equal(binary(frames), '');
  }
  // The drop is per record: a good one in front still converts.
  const mixed = deframe(record('PASSCOM1', '3,abc'), record('PASSCOM1', '1,\u00e9'));
  assert.deepEqual(ascii(mixed), [`#PASSCOM1A,${HEAD};3,abc*6e2c2ecd`]);
});

test('%P in a `<` record: uppercase escapes, a space inside the payload, a truncated token', () => {
  const header = `<PASSCOM1 ${HEAD.replace(/,/g, ' ')}\r\n`;
  const one = deframe(latin1(`${header}<     4 \\xED\\xFF\\xF7\\xB9\r\n`));
  assert.deepEqual(ascii(one), [`#PASSCOM1A,${HEAD};4,\\xed\\xff\\xf7\\xb9*a9bf31e7`]);
  assert.deepEqual(abbrev(one), [
    [`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     4 \\xed\\xff\\xf7\\xb9'],
  ]);
  // `<` data lines split on spaces, and the count reads straight across them.
  const spaced = deframe(latin1(`${header}<     3 a b\r\n`));
  assert.deepEqual(ascii(spaced), [`#PASSCOM1A,${HEAD};3,a b*db6433dc`]);
  assert.deepEqual(abbrev(spaced), [[`<PASSCOM1 ${HEAD.replace(/,/g, ' ')}`, '<     3 a b']]);
  const short = deframe(latin1(`${header}<     2 abcd\r\n`));
  assert.deepEqual(ascii(short), [`#PASSCOM1A,${HEAD};2,ab*ff944d91`]);
});

test('PASSTHROUGH: the port enum in front of the same %P field', () => {
  assert.deepEqual(ascii(deframe(record('PASSTHROUGH', 'COM3,4,\\xde\\xad\\xbe\\xef'))), [
    `#PASSTHROUGHA,${HEAD};COM3,4,\\xde\\xad\\xbe\\xef*25957f6b`,
  ]);
  assert.deepEqual(abbrev(deframe(record('PASSTHROUGH', 'NOPORT,2,\\x01\\x02'))), [
    [`<PASSTHROUGH ${HEAD.replace(/,/g, ' ')}`, '<     NOPORT 2 \\x01\\x02'],
  ]);
});
