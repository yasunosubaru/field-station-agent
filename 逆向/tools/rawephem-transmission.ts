// Check the remaining ambiguous fields: transmission time (HOW TOW), fit interval bit, and whether
// duplicated RAWEPHEM frames are byte-identical.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));

function ub(bytes: number[], offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    const bit = offset + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}
function toBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

for (const capture of process.argv.slice(2)) {
  console.log(`=== ${capture}`);
  const seen = new Map<string, number>();
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capture)))) {
    if (frame.kind !== 'sbf' || frame.header.messageId !== 41) continue;
    const values = decodeEdie(frame.payload, tables.messages['41'], tables);
    const get = (p: string) => String(values.find((v) => v.path === p)?.value ?? '');
    const hexes = ['subframe1', 'subframe2', 'subframe3'].map((p) => get(p));
    const s1 = toBytes(hexes[0]);
    const s2 = toBytes(hexes[1]);
    const tow = ub(s1, 24, 17);
    const key = hexes.join('|');
    const prev = seen.get(key);
    if (prev === undefined) seen.set(key, 1);
    else seen.set(key, prev + 1);
    console.log(
      `prn ${String(get('satellite_id')).padStart(2)} toe ${String(get('toe')).padStart(6)}`,
      `ms ${String(frame.header.milliseconds).padStart(9)}`,
      `tow ${String(tow).padStart(6)} tow*6 ${String(tow * 6).padStart(6)}`,
      `sfid1 ${ub(s1, 0, 240) >= 0 ? ub(s1, 40, 3) : 0} sfid2 ${ub(s2, 40, 3)}`,
      `fit@232 ${ub(s2, 232, 1)}`,
      `dup ${(seen.get(key) ?? 0) > 1 ? '#2' : ''}`,
      `s1 ${hexes[0].slice(0, 24)}…`,
    );
  }
}
