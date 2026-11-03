/**
 * What the decoders actually hand the panels for the two records this round is about:
 * `ITDETECTSTATUS` (#2065, the interference list) and `RANGE` (#43, whose signal type lives in
 * `c_status` bits 21..25). Prints the exact field paths, so the view/app code can read them by name
 * instead of guessing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const REPO = process.env.NAS_REPO ?? join(import.meta.dirname, '..', '..');
const tables = JSON.parse(readFileSync(join(REPO, '逆向', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));
const capture = join(REPO, '逆向', '00_来源', 'samples', 'live-20261031', 'b7-20261101.sbf');
const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(capture)))] as any[];
const sbf = frames.filter((frame) => frame.kind === 'sbf');

const itk = sbf.filter((frame) => frame.header.messageId === 2065);
console.log(`ITDETECTSTATUS records: ${itk.length}`);
for (const frame of itk.slice(0, 2)) {
  const values = decodeEdie(frame.payload, tables.messages['2065'], tables);
  console.log('  ' + values.map((value: any) => `${value.path}=${value.text ?? value.value}`).join(' | ').slice(0, 420));
}

const range = sbf.filter((frame) => frame.header.messageId === 43).slice(0, 2);
console.log(`\nRANGE records: ${sbf.filter((frame) => frame.header.messageId === 43).length}`);
for (const frame of range) {
  const values = decodeEdie(frame.payload, tables.messages['43'], tables);
  const first = values.filter((value: any) => /^obs\[0\]\./.test(value.path));
  console.log('  ' + first.map((value: any) => `${value.path}=${value.text ?? value.value}`).join(' | ').slice(0, 420));
}

// Signal type distribution per system, from c_status bits 21..25 and system bits 16..18.
const systems = ['GPS', 'GLONASS', 'SBAS', 'Galileo', 'BeiDou', 'QZSS', 'NavIC', 'Other'];
const seen = new Map<string, number>();
for (const frame of sbf.filter((item) => item.header.messageId === 43)) {
  const values = decodeEdie(frame.payload, tables.messages['43'], tables);
  for (const value of values as any[]) {
    const match = /^obs\[\d+\]\.c_status$/.exec(value.path);
    if (!match) continue;
    const status = Number(value.value) >>> 0;
    const system = systems[(status >>> 16) & 0x7] ?? '?';
    const type = (status >>> 21) & 0x1f;
    const key = `${system}/${type}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
}
console.log('\nsignal type histogram (system/type → count):');
for (const [key, count] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${key} → ${count}`);
