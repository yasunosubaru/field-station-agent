import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { frame, SUITE, TEMP_ROOT } from './oracle.ts';

const REPO = process.env.NAS_REPO ?? join(import.meta.dirname, '..', '..');
const live = join(REPO, '逆向', '00_来源', 'samples', 'live-20261031');
const { SbfDeframer } = await import('../04_重实现/packages/protocol/src/framing.ts');

const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(live, 'b1-20261101.sbf'))))] as any[];
const bestpos = frames.filter((item) => item.kind === 'sbf' && item.header.messageId === 42).slice(0, 2);
const first = Buffer.from(bestpos[0].bytes);
const second = Buffer.from(bestpos[1].bytes);
const capture = Buffer.from(frame(128, new Uint8Array(Buffer.concat([first, second]))));
const input = join(TEMP_ROOT, 'multir.sbf');
writeFileSync(input, capture);
const out = join(TEMP_ROOT, 'multir-out');
mkdirSync(out, { recursive: true });
execFileSync(SUITE, ['-a', '--unknown-bytes=file', '-o', out, input], { stdio: 'pipe', timeout: 120_000 });

const walk = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
};
const files = walk(out);
const unknown = files.find((file) => file.endsWith('.UNKNOWN'));
const ascii = files.find((file) => file.endsWith('.ASCII'));
console.log('ascii bytes', readFileSync(ascii).length);
if (!unknown) { console.log('no .UNKNOWN file'); } else {
  const bytes = readFileSync(unknown);
  console.log('unknown file', bytes.length, 'bytes');
  console.log('contains second BESTPOS header?', bytes.includes(second.subarray(0, 8)) ? 'yes' : 'no');
  console.log('first 40 bytes', JSON.stringify(bytes.subarray(0, 40).toString('latin1')));
}
