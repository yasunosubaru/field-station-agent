/**
 * Does `--decimate` change what the suite calls unknown bytes? A record that **renders nothing**
 * (an `RXCONFIG` whose embedded message the dictionary lacks) is unknown bytes when it is written
 * — and, measured here, simply gone when decimation drops it.
 *
 *   node 逆向/tools/probe-decimate-unknown-synth.ts
 *
 * The `RXCONFIG` payload is copied out of b1 (offset 132094, one of its 22 silent records) so the
 * only thing that varies between cases is the header's time and the junk around it.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { capture, frame, SUITE, TEMP_ROOT } from './oracle.ts';

const B1 = join(import.meta.dirname, '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');
const tables = JSON.parse(readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));

/** The payload of a b1 `RXCONFIG` that prints nothing. */
function silentRxconfigPayload(): Uint8Array {
  const bytes = new Uint8Array(readFileSync(B1));
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)];
  deframer.end();
  for (const entry of frames) {
    if (entry.kind !== 'sbf' || entry.header.messageId !== 128) continue;
    const layout = tables.messages['128'];
    if (!layout) continue;
    if (entry.offset === 132094) return entry.payload;
  }
  throw new Error('the b1 silent RXCONFIG at 132094 is not there any more');
}

const payload = silentRxconfigPayload();
const silent = (milliseconds: number) => frame(128, payload, { milliseconds, timeStatus: 20, week: 0 });
const good = (milliseconds: number) => frame(42, new Uint8Array(32), { milliseconds, timeStatus: 180, week: 2442 });
const junk = '\r\n[USB2]';

function measure(bytes: Uint8Array, flags: string): { unknown: Uint8Array; ascii: Uint8Array; files: string[] } {
  const dir = mkdtempSync(join(TEMP_ROOT, 'synth-dec-'));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, bytes);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, ['-a', '-o', out, ...flags.split(/\s+/).filter(Boolean), input], { stdio: 'pipe', timeout: 300_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const formatDir = join(out, stem, stamp, 'ASCII');
    const files = readdirSync(formatDir);
    const unknownName = files.find((name) => name.toUpperCase().endsWith('.UNKNOWN'));
    const asciiName = files.find((name) => name.toUpperCase().endsWith('.ASCII'));
    copyFileSync(join(formatDir, unknownName!), join(TEMP_ROOT, 'synth-dec-unknown.bin'));
    return {
      unknown: unknownName ? new Uint8Array(readFileSync(join(formatDir, unknownName))) : new Uint8Array(0),
      ascii: asciiName ? new Uint8Array(readFileSync(join(formatDir, asciiName))) : new Uint8Array(0),
      files,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
  return out;
};

// 575000 and 580000 are whole multiples of 5 s; 577500 is not.
const cases: Array<[string, Uint8Array]> = [
  ['silent on-grid', capture(junk, silent(575000), junk, good(580000))],
  ['silent off-grid', capture(junk, silent(577500), junk, good(580000))],
  ['both, off last', capture(junk, silent(575000), junk, silent(577500), junk, good(580000))],
];

for (const [label, bytes] of cases) {
  const plain = measure(bytes, '--unknown-bytes=file');
  const dec = measure(bytes, '--decimate=5 --unknown-bytes=file');
  console.log(`\n${label}  capture ${bytes.length} B`);
  console.log(`  no decimate  UNKNOWN ${String(plain.unknown.length).padStart(5)} B  ${JSON.stringify(text(plain.unknown).slice(0, 60))}`);
  console.log(`  decimate=5   UNKNOWN ${String(dec.unknown.length).padStart(5)} B  ${JSON.stringify(text(dec.unknown).slice(0, 60))}`);
  console.log(`  ascii lines  plain ${plain.ascii.length} B / dec ${dec.ascii.length} B`);
}
