/**
 * What does a text record's `*crc` cover, and will the suite convert a hand-built one?
 *
 *   node 逆向/tools/probe-text-crc.ts
 *
 * Copies a real `#BESTPOSA,…` text record out of b1, tries the two plausible CRC spans against the
 * trailer the record itself carries, then asks the suite to convert a copy whose week/seconds were
 * changed and whose CRC was recomputed with the winning span.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { crcHex, novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { SUITE, TEMP_ROOT, capture, frame } from './oracle.ts';

const B1 = join(import.meta.dirname, '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');
const bytes = new Uint8Array(readFileSync(B1));
const deframer = new SbfDeframer({ crcMode: 'validate' });
const frames = [...deframer.push(bytes)];
deframer.end();

const textFrame = frames.find((entry) => entry.kind === 'text' && entry.text.startsWith('#BESTPOSA'))!;
const line = textFrame.kind === 'text' ? textFrame.text : '';
console.log(`record (${line.length} chars):\n  ${JSON.stringify(line)}`);

const star = line.lastIndexOf('*');
const body = line.slice(0, star);
const trailer = line.slice(star + 1);
const latin1 = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
const crcOf = (text: string, skip = 0) => crcHex(novatelCrc32(latin1(text.slice(skip))));
console.log(`  trailer ${trailer}`);
for (const [label, text, skip] of [
  ['whole body', body, 0],
  ['body without leading #', body, 1],
  ['body without leading ##', body, 2],
] as const) {
  const crc = crcOf(text, skip);
  console.log(`  ${label.padEnd(24)} ${crc} ${crc === trailer ? '<-- match' : ''}`);
}

const rebuilt = (week: number, seconds: number): Uint8Array => {
  const fields = body.split(',');
  fields[5] = String(week);
  fields[6] = seconds.toFixed(3);
  const rebuiltBody = fields.join(',');
  // The trailer covers the record *after* its leading `#` (measured above).
  const crc = crcHex(novatelCrc32(latin1(rebuiltBody.slice(1))));
  return latin1(`${rebuiltBody}*${crc}\r\n`);
};

function convert(label: string, bytesIn: Uint8Array): void {
  const dir = mkdtempSync(join(TEMP_ROOT, 'text-crc-'));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, bytesIn);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, ['-a', '-o', out, input], { stdio: 'pipe', timeout: 300_000 });
    const stem = readdirSync(out)[0];
    if (!stem) { console.log(`\n${label}: suite wrote nothing`); return; }
    const stamp = readdirSync(join(out, stem))[0];
    const formatDir = join(out, stem, stamp, 'ASCII');
    for (const name of readdirSync(formatDir)) {
      const file = join(formatDir, name);
      const content = Buffer.from(readFileSync(file)).toString('latin1');
      copyFileSync(file, join(TEMP_ROOT, 'text-crc-last.txt'));
      console.log(`\n${label}: ${name} ${content.length} B\n  ${JSON.stringify(content.slice(0, 120))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const good = () => frame(42, new Uint8Array(32), { week: 2442, milliseconds: 577760, timeStatus: 180 });
convert('verbatim b1 record + frame', capture(latin1(`${line}\r\n`), good()));
convert('rebuilt week 2443/1.000 + frame', capture(rebuilt(2443, 1), good()));
