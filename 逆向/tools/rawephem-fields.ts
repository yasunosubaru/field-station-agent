// Locate every subframe-1 field by its golden value, to derive the real bit layout.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const capture = new Uint8Array(readFileSync(process.argv[2]));

let frame = null;
for (const candidate of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
  if (candidate.kind === 'sbf' && candidate.header.messageId === 41) { frame = candidate; break; }
}
const values = decodeEdie(frame!.payload, tables.messages['41'], tables);
const get = (path: string) => String(values.find((value) => value.path === path)?.value ?? '');

function toBits(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}
function ub(bytes: number[], offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    const bit = offset + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}

const sub1 = toBits(get('subframe1'));
const sub2 = toBits(get('subframe2'));
const sub3 = toBits(get('subframe3'));
console.log('sat', get('satellite_id'), 'first 6 bytes of sub1:', get('subframe1').slice(0, 12));

const wanted: Array<[string, number, number]> = [
  ['af0', 22, 650202],
  ['af1', 16, 65536 - 102],
  ['af2', 8, 0],
  ['toc/16', 16, 29250],
  ['ura', 4, 2],
  ['iodc', 10, 93],
  ['tgd', 8, 10],
  ['week', 10, 394],
];
for (const [name, width, target] of wanted) {
  const hits: number[] = [];
  for (let offset = 0; offset <= 240 - width; offset++) {
    if (ub(sub1, offset, width) === target) hits.push(offset);
  }
  console.log(`sub1 ${name.padEnd(8)} w=${String(width).padStart(2)} target=${String(target).padStart(6)} hits: ${hits.join(', ') || '-'}`);
}
for (const [name, width, target] of [
  ['iode', 8, 93],
  ['sqrtA', 32, 2701957494],
  ['e', 32, 104508733],
  ['toe/16', 16, 29250],
] as Array<[string, number, number]>) {
  const hits: number[] = [];
  for (let offset = 0; offset <= 240 - width; offset++) {
    if (ub(sub2, offset, width) === target) hits.push(offset);
  }
  console.log(`sub2 ${name.padEnd(8)} w=${String(width).padStart(2)} target=${String(target).padStart(10)} hits: ${hits.join(', ') || '-'}`);
}
