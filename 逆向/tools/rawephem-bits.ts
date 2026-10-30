// Locate known ephemeris fields inside the RAWEPHEM subframe bit strings, to derive the bit origin.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const capture = new Uint8Array(readFileSync(process.argv[2]));

const targets = {
  // from the golden record for PRN 8 (first record): sqrtA, e, week, toc(×16), toe(×16)
  sqrtA: Math.round(5153.5749321 * 2 ** 19),
  e: Math.round(0.0121664177859 * 2 ** 33),
  toc16: 468000 / 16,
  toe16: 468000 / 16,
  week10: 2442 % 1024,
};

function toBits(hex: string): number[] {
  return hex.match(/../g)!.map((pair) => parseInt(pair, 16));
}
function bits(bytes: number[], offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    const bit = offset + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}

let frame = null;
for (const candidate of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
  if (candidate.kind === 'sbf' && candidate.header.messageId === 41) { frame = candidate; break; }
}
if (!frame) throw new Error('no RAWEPHEM');
const values = decodeEdie(frame.payload, tables.messages['41'], tables);
const get = (path: string) => String(values.find((value) => value.path === path)?.value);
console.log('satellite', get('satellite_id'), 'toe', get('toe'));

for (const [name, hex, width, target] of [
  ['subframe1', get('subframe1'), 16, targets.toc16],
  ['subframe1-week', get('subframe1'), 10, targets.week10],
  ['subframe2-sqrtA', get('subframe2'), 32, targets.sqrtA],
  ['subframe2-e', get('subframe2'), 32, targets.e],
  ['subframe3', get('subframe3'), 16, targets.toe16],
] as Array<[string, string, number, number]>) {
  const bytes = toBits(hex);
  const hits: number[] = [];
  for (let offset = 0; offset <= 240 - width; offset++) {
    if (bits(bytes, offset, width) === target) hits.push(offset);
  }
  console.log(`${name.padEnd(18)} width=${String(width).padStart(2)} target=${String(target).padStart(12)} hits at ${hits.join(', ') || '(none)'}`);
}
