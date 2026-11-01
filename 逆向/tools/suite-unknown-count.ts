/**
 * Sweep: what does the suite count as `UNKNOWN` (the pre-scan number the Summary prints) versus
 * what does `--unknown-bytes=file` write, for one shape at a time?
 *
 *   node 逆向/tools/suite-unknown-count.ts [--only <substring>]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { frame, SUITE, TEMP_ROOT } from './oracle.ts';

const ascii = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const fill = (byte: number, count: number): Uint8Array => new Uint8Array(count).fill(byte);
const rep = (text: string, count: number): Uint8Array => ascii(text.repeat(count));

const good = frame(42, new Uint8Array(32));

/** Measure one capture: the pre-scan count and the `.UNKNOWN` size. */
function measure(bytes: Uint8Array): { count: number; size: number; text: string } {
  const dir = mkdtempSync(join(TEMP_ROOT, 'unc-'));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, bytes);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    const stdout = execFileSync(SUITE, ['-a', '-o', out, '--unknown-bytes=file', input], { encoding: 'latin1', timeout: 120_000 });
    const count = Number(/UNKNOWN\s*\|\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    const stem = readdirSync(out)[0];
    const stamp = stem ? readdirSync(join(out, stem))[0] : undefined;
    const formatDir = stamp ? join(out, stem, stamp, 'ASCII') : undefined;
    const files = formatDir ? readdirSync(formatDir) : [];
    const unknown = files.find((name) => name.toUpperCase().endsWith('.UNKNOWN'));
    const data = unknown && formatDir ? readFileSync(join(formatDir, unknown)) : Buffer.alloc(0);
    return { count, size: data.length, text: Buffer.from(data).toString('latin1') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases: Array<[string, Uint8Array]> = [
  ['junk 100', cat(good, fill(0x11, 100))],
  ['crlf x1', cat(good, ascii('\r\n'))],
  ['crlf x2', cat(good, ascii('\r\n\r\n'))],
  ['crlf x3', cat(good, ascii('\r\n\r\n\r\n'))],
  ['<OK x1 mid', cat(good, ascii('<OK\r\n'), good)],
  ['<OK x2 mid', cat(good, ascii('<OK\r\n<OK\r\n'), good)],
  ['bare < x1', cat(good, ascii('<\r\n'), good)],
  ['<IGNORED x1', cat(good, ascii('<IGNORED\r\n'), good)],
  ['<OK no crlf then frame', cat(good, ascii('<OK'), good)],
  ['[USB2] x1 mid', cat(good, ascii('[USB2]'), good)],
  ['[COM1] x1 mid', cat(good, ascii('[COM1]'), good)],
  ['[X] x1 mid', cat(good, ascii('[X]'), good)],
  ['#BOGUS crc ok', cat(good, ascii('#BOGUSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;1,2*00000000\r\n'), good)],
  ['$GPGGA good', cat(good, ascii('$GPGGA,1,2,3*00\r\n'), good)],
  ['%BESTPOS', cat(good, ascii('%BESTPOS,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;1\r\n'), good)],
  ['<OK + junk 10', cat(good, ascii('<OK\r\n'), fill(0x11, 10))],
  ['junk 10 + <OK', cat(good, fill(0x11, 10), ascii('<OK\r\n'))],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
for (const [label, bytes] of cases) {
  if (only && !label.includes(only)) continue;
  const { count, size, text } = measure(bytes);
  console.log(`${label.padEnd(24)} count=${String(count).padStart(6)}  file=${String(size).padStart(6)}  delta=${String(size - count).padStart(6)}  ${JSON.stringify(text).slice(0, 90)}`);
}
