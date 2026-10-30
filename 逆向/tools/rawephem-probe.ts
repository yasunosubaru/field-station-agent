// Probe RAWEPHEM decoding against the RINEX 2.1 navigation golden.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const [capturePath, navPath] = process.argv.slice(2);

const capture = new Uint8Array(readFileSync(capturePath));
const raw: Array<{ ms: number; satellite: number; week: number; toe: number; subs: string[] }> = [];
for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
  if (frame.kind !== 'sbf' || frame.header.messageId !== 41) continue;
  const values = decodeEdie(frame.payload, tables.messages['41'], tables);
  const get = (path: string) => values.find((value) => value.path === path)?.value;
  raw.push({
    ms: frame.header.milliseconds,
    satellite: Number(get('satellite_id')),
    week: Number(get('week')),
    toe: Number(get('toe')),
    subs: ['subframe1', 'subframe2', 'subframe3'].map((path) => String(get(path))),
  });
}
console.log('RAWEPHEM frames:', raw.length);
for (const entry of raw.slice(0, 4)) {
  console.log(`  ms=${entry.ms} sat=${entry.satellite} week=${entry.week} toe=${entry.toe} sub1=${entry.subs[0].slice(0, 16)}…`);
}

// Golden nav
const text = readFileSync(navPath, 'utf8').split(/\r?\n/);
const end = text.findIndex((line) => /END OF HEADER/.test(line));
console.log('nav header lines:', end + 1, 'records:', (text.length - end - 1) / 8);
for (let i = end + 1; i < Math.min(text.length, end + 1 + 8 * 2); i += 8) {
  console.log('  record head:', JSON.stringify(text[i]));
  console.log('  record tail:', JSON.stringify(text[i + 7]));
}

// Bit extraction helpers
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
  const sign = 2 ** (length - 1);
  return value >= sign ? value - 2 * sign : value;
}

const first = raw[0];
const sub1 = first.subs[0].match(/../g)!.map((pair) => parseInt(pair, 16));
const sub2 = first.subs[1].match(/../g)!.map((pair) => parseInt(pair, 16));
console.log('sub1 week(sat):', bits(sub1, 0, 10), 'sva:', bits(sub1, 12, 4), 'svh:', bits(sub1, 16, 6), 'tgd:', sbits(sub1, 22, 8), 'toc:', bits(sub1, 158, 16) * 16);
console.log('sub2 iode:', bits(sub2, 0, 8), 'e:', bits(sub2, 94, 32) * 2 ** -33, 'sqrtA:', bits(sub2, 142, 32) * 2 ** -19, 'toe:', bits(sub2, 174, 16) * 16);
