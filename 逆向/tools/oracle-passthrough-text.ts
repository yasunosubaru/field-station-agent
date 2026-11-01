/**
 * `%P` on the **text** side: a `#PASSCOM1A,…;4,\xed\xff\xf7\xb9*<crc>` record.
 *
 * The binary → text direction already has an oracle (`ascii-log.ts#escapePassThrough` was measured
 * with all 256 byte values in one synthetic `PASSCOM1` frame). What no capture has ever carried is
 * the reverse: a pass-through record the *receiver itself* wrote as ASCII. Convert parses those
 * records and prints them again instead of copying them, so the question is whether it re-escapes
 * the token — and what it does with a count that disagrees with the token, with an uppercase
 * `\xNN`, a raw high byte, a payload comma or an empty payload.
 *
 * Each case is a hand-built `#…*crc` record (CRC over the bytes after `#`, the rule `probe-text-crc`
 * measured) fed to the installed suite three times (`-a`, `--abbrev`, `-b`). Our own pipeline runs
 * over the same bytes, so every line here is a byte comparison, not a reading of the spec.
 *
 *   node 逆向/tools/oracle-passthrough-text.ts      # exit code 0 = every case byte-identical
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { SUITE, TEMP_ROOT } from './oracle.ts';

const tables: EdieTables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

const HEAD = 'COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278';

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** A complete `#NAMEA,<head>;<body>*crc` record, CRLF terminated. */
function record(name: string, body: string, head: string = HEAD): Uint8Array {
  const sentence = `${name}A,${head};${body}`;
  const crc = (novatelCrc32(latin1(sentence)) >>> 0).toString(16).padStart(8, '0');
  return latin1(`#${sentence}*${crc}\r\n`);
}

function suiteRun(input: Uint8Array, label: string): { ascii: string[]; abbrev: string[]; binary: Uint8Array } {
  const dir = mkdtempSync(join(TEMP_ROOT, `passthrough-${label}-`));
  try {
    const file = join(dir, 'probe.sbf');
    writeFileSync(file, input);
    const read = (flag: string, format: string): Uint8Array => {
      const out = join(dir, format);
      mkdirSync(out, { recursive: true });
      execFileSync(SUITE, [flag, '-o', out, file], { stdio: 'pipe', timeout: 180_000 });
      const stem = readdirSync(out)[0];
      const stamp = readdirSync(join(out, stem))[0];
      const formatDir = join(out, stem, stamp, format);
      const name = readdirSync(formatDir)[0];
      return new Uint8Array(readFileSync(join(formatDir, name)));
    };
    const lines = (bytes: Uint8Array): string[] => {
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return text.split('\r\n').filter(Boolean);
    };
    return { ascii: lines(read('-a', 'ASCII')), abbrev: lines(read('--abbrev', 'ABBREV_ASCII')), binary: read('-b', 'BINARY') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ours(input: Uint8Array): { ascii: string[]; abbrev: string[]; binary: Uint8Array } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const one = (format: 'ASCII' | 'ABBREV_ASCII' | 'BINARY'): { text: string | null; bytes: Uint8Array } => {
    const files = convertFrames(frames, { format, at, tables, name: 'probe.sbf' }).files;
    return files[0] ?? { text: '', bytes: new Uint8Array() };
  };
  const lines = (text: string | null): string[] => (text ?? '').split('\r\n').filter(Boolean);
  return { ascii: lines(one('ASCII').text), abbrev: lines(one('ABBREV_ASCII').text), binary: one('BINARY').bytes };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

interface Case {
  label: string;
  input: Uint8Array;
  note: string;
}

const cases: Case[] = [
  { label: 'lowercase', input: record('PASSCOM1', '4,\\xed\\xff\\xf7\\xb9'), note: 'the shape the suite itself writes' },
  { label: 'uppercase', input: record('PASSCOM1', '4,\\xED\\xFF\\xF7\\xB9'), note: 'is \\xNN case-normalised?' },
  { label: 'controls', input: record('PASSCOM1', '6,ab\\x0d\\x0acd'), note: 'CR/LF inside the payload' },
  { label: 'backslash', input: record('PASSCOM1', '2,\\\\A'), note: 'payload = 5C 41, printed `\\\\A`' },
  { label: 'raw-high', input: record('PASSCOM1', '1,\u0080'), note: 'a bare 0x80 byte, no escape' },
  { label: 'comma', input: record('PASSCOM1', '3,a,b'), note: 'an unescaped comma: two tokens for one field' },
  { label: 'star', input: record('PASSCOM1', '3,a*b'), note: 'a payload `*` could look like the CRC marker' },
  { label: 'count-long', input: record('PASSCOM1', '8,abc'), note: 'count 8 but the token holds 3 bytes' },
  { label: 'count-zero', input: record('PASSCOM1', '0,'), note: 'empty payload' },
  { label: 'bad-escape', input: record('PASSCOM1', '2,\\q'), note: '`\\q` is neither \\xNN nor a doubled backslash' },
  { label: 'passthrough', input: record('PASSTHROUGH', 'COM3,4,\\xde\\xad\\xbe\\xef'), note: 'port enum + count + %P' },
  { label: 'passthrough-noport', input: record('PASSTHROUGH', 'NOPORT,2,\\x01\\x02'), note: 'port 0 prints NOPORT' },
  { label: 'count-short', input: record('PASSCOM1', '2,abcd'), note: 'count 2, token holds 4 bytes: the rest is ignored?' },
  { label: 'count-zero-nonempty', input: record('PASSCOM1', '0,abc'), note: 'count 0 with a token behind it' },
  { label: 'raw-e9', input: record('PASSCOM1', '1,\u00e9'), note: 'a bare latin-1 0xE9 byte' },
  { label: 'raw-utf8', input: record('PASSCOM1', '2,\u00c3\u00a9'), note: 'the two UTF-8 bytes of é' },
  { label: 'raw-utf8-count1', input: record('PASSCOM1', '1,\u00c3\u00a9'), note: 'valid UTF-8 é, but count 1' },
  {
    label: 'mixed-high',
    input: (() => {
      const a = record('PASSCOM1', '3,abc');
      const b = record('PASSCOM1', '1,\u00e9');
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    })(),
    note: 'one good record in front of a high-byte one: is the drop per record?',
  },
  { label: 'raw-tab', input: record('PASSCOM1', '1,\t'), note: 'a bare 0x09' },
  { label: 'raw-del', input: record('PASSCOM1', '1,\u007f'), note: 'a bare 0x7F' },
  { label: 'space', input: record('PASSCOM1', '3,a b'), note: 'a payload space stays a space' },
  {
    label: 'abbrev-record',
    input: latin1(
      '<PASSCOM1 COM1 1 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n'
      + '<     4 \\xED\\xFF\\xF7\\xB9\r\n',
    ),
    note: 'the `<` form: header line + one data line',
  },
  { label: 'raw-high-extra', input: record('PASSCOM1', '1,a\u00e9'), note: 'high byte outside the %P payload' },
  { label: 'raw-high-port', input: record('PASSCOM1', '1,a', `COM\u00e9,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278`), note: 'high byte in the port token' },
  {
    label: 'abbrev-high',
    input: latin1(
      '<PASSCOM1 COM1 1 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n'
      + '<     1 \u00e9\r\n',
    ),
    note: '`<` data line carrying a raw 0xE9',
  },
  {
    label: 'abbrev-space',
    input: latin1(
      '<PASSCOM1 COM1 1 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n'
      + '<     3 a b\r\n',
    ),
    note: '`<` data line: does the count read across the space?',
  },
  {
    label: 'abbrev-count-short',
    input: latin1(
      '<PASSCOM1 COM1 1 0.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n'
      + '<     2 abcd\r\n',
    ),
    note: '`<` data line: count 2, four bytes tokenized as one word',
  },
];

let failures = 0;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
for (const one of cases) {
  if (only && !one.label.includes(only)) continue;
  const suite = suiteRun(one.input, one.label);
  const mine = ours(one.input);
  const same = (a: string[], b: string[]): boolean => a.join('\r\n') === b.join('\r\n');
  const ok = same(suite.ascii, mine.ascii) && same(suite.abbrev, mine.abbrev)
    && suite.binary.length === mine.binary.length && hex(suite.binary) === hex(mine.binary);
  if (!ok) failures += 1;
  console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${one.label} — ${one.note}`);
  console.log(`  input       ${JSON.stringify(String.fromCharCode(...one.input).replace(/\r\n$/, ''))}`);
  for (const line of suite.ascii) console.log(`  suite       ${JSON.stringify(line)}`);
  for (const line of mine.ascii) console.log(`  ours        ${JSON.stringify(line)}`);
  for (const line of suite.abbrev) console.log(`  suiteABBREV ${JSON.stringify(line)}`);
  for (const line of mine.abbrev) console.log(`  oursABBREV  ${JSON.stringify(line)}`);
  console.log(`  suiteBINARY ${hex(suite.binary) || '(none)'}`);
  if (hex(suite.binary) !== hex(mine.binary)) console.log(`  oursBINARY  ${hex(mine.binary) || '(none)'}`);
}

console.log(failures === 0 ? '\nevery case is byte-identical to the suite' : `\n${failures} mismatch(es)`);
process.exitCode = failures === 0 ? 0 : 1;
