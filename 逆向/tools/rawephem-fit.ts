// Fit the RAWEPHEM bit origin/stride by scoring candidate layouts against the golden RINEX record.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const capture = new Uint8Array(readFileSync(process.argv[2]));

let frame = null;
for (const candidate of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
  if (candidate.kind === 'sbf' && candidate.header.messageId === 41) { frame = candidate; break; }
}
if (!frame) throw new Error('no RAWEPHEM');
const values = decodeEdie(frame.payload, tables.messages['41'], tables);
const get = (path: string) => String(values.find((value) => value.path === path)?.value);

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
function sbits(bytes: number[], offset: number, length: number): number {
  const value = bits(bytes, offset, length);
  return value >= 2 ** (length - 1) ? value - 2 ** length : value;
}

const sub1 = toBits(get('subframe1'));
const sub2 = toBits(get('subframe2'));

// Expected raw values from the golden RINEX record for PRN 8.
const expect = {
  week: 2442 % 1024,
  toc16: 468000 / 16,
  af0: Math.round(0.00030277390033 * 2 ** 31),
  af1: Math.round(-1.15960574476e-11 * 2 ** 43),
  af2: 0,
  sqrtA: Math.round(5153.5749321 * 2 ** 19),
  e: Math.round(0.0121664177859 * 2 ** 33),
  toe16: 468000 / 16,
};
console.log('expected raw:', JSON.stringify(expect));

// Candidate: fields contiguous inside a "parity-stripped" subframe, starting at offset o.
// Layout of subframe 1 (after TLM+HOW data): WN10 L2(2) URA4 SVH6 TGD8 IODC2 toc16 af2(8) af1(16) af0(22)
for (let o = 0; o <= 60; o++) {
  const week = bits(sub1, o, 10);
  const toc = bits(sub1, o + 24, 16);
  const af2 = sbits(sub1, o + 48, 8);
  const af1 = sbits(sub1, o + 56, 16);
  const af0 = sbits(sub1, o + 72, 22);
  if (week !== expect.week) continue;
  console.log(`origin ${o}: week=${week} toc16=${toc} af2=${af2} af1=${af1} af0=${af0}`);
}
// Subframe 2: IODE8 crs16 dn16 m0(32) cuc16 e32 cus16 sqrtA32 toe16 (contiguous)
for (let o = 0; o <= 60; o++) {
  const sqrtA = bits(sub2, o + 32 + 16 + 32 + 16 + 16, 32);
  const e = bits(sub2, o + 32 + 16 + 32 + 16, 32);
  const toe = bits(sub2, o + 32 + 16 + 32 + 16 + 32 + 16 + 32, 16);
  if (Math.abs(sqrtA - expect.sqrtA) < 4 || Math.abs(e - expect.e) < 4) {
    console.log(`sub2 origin ${o}: e=${e} sqrtA=${sqrtA} toe16=${toe} (dE=${e - expect.e}, dA=${sqrtA - expect.sqrtA})`);
  }
}
