// Derive the RAWEPHEM field layout empirically: for all 8 records, locate each RINEX field's raw
// value inside the corresponding subframe bit string and keep the offsets that are stable.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const [capturePath, navPath] = process.argv.slice(2);

// --- golden records: PRN -> values (parsed from fixed columns)
const nav = readFileSync(navPath, 'utf8').split(/\r?\n/);
const end = nav.findIndex((line) => /END OF HEADER/.test(line));
const records: Array<{ prn: number; values: number[] }> = [];
for (let i = end + 1; i + 7 < nav.length; i += 8) {
  const head = nav[i];
  const prn = Number(head.slice(0, 2));
  const values: number[] = [];
  const cut = (text: string) => {
    for (let at = 0; at + 19 <= text.length; at += 19) {
      const piece = text.slice(at, at + 19).trim();
      if (!piece) continue;
      values.push(Number(piece.replace('D', 'E')));
    }
  };
  cut(head.slice(22));
  for (let line = 1; line < 8; line++) cut(nav[i + line].slice(3));
  records.push({ prn, values });
}
console.log('golden records:', records.length);

// --- RAWEPHEM per PRN
function toBits(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}
const subframes = new Map<number, number[][]>();
for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))) {
  if (frame.kind !== 'sbf' || frame.header.messageId !== 41) continue;
  const values = decodeEdie(frame.payload, tables.messages['41'], tables);
  const get = (path: string) => String(values.find((value) => value.path === path)?.value ?? '');
  subframes.set(Number(get('satellite_id')), ['subframe1', 'subframe2', 'subframe3'].map((path) => toBits(get(path))));
}
console.log('rawephem satellites:', [...subframes.keys()].join(','));

function ub(bytes: number[], offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    const bit = offset + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}

// field name -> [subframe index, bit width, raw value from the RINEX value]
const FIELDS: Array<[string, number, number, (v: number) => number]> = [
  ['af0', 0, 22, (v) => Math.round(v / 2 ** -31)],
  ['af1', 0, 16, (v) => Math.round(v / 2 ** -43)],
  ['af2', 0, 8, (v) => Math.round(v / 2 ** -55)],
  ['toc/16', 0, 16, (v) => Math.round(v / 16)],
  ['week', 0, 10, (v) => Math.round(v) % 1024],
  ['ura', 0, 4, (v) => Math.round(v)],
  ['health', 0, 6, (v) => Math.round(v)],
  ['tgd', 0, 8, (v) => Math.round(v / 2 ** -31)],
  ['iodc', 0, 10, (v) => Math.round(v)],
  ['iode', 1, 8, (v) => Math.round(v)],
  ['crs', 1, 16, (v) => Math.round(v / 2 ** -5)],
  ['dn', 1, 16, (v) => Math.round(v / Math.PI / 2 ** -43)],
  ['m0', 1, 32, (v) => Math.round(v / Math.PI / 2 ** -31)],
  ['cuc', 1, 16, (v) => Math.round(v / 2 ** -29)],
  ['e', 1, 32, (v) => Math.round(v / 2 ** -33)],
  ['cus', 1, 16, (v) => Math.round(v / 2 ** -29)],
  ['sqrtA', 1, 32, (v) => Math.round(v / 2 ** -19)],
  ['toe/16', 1, 16, (v) => Math.round(v / 16)],
  ['cic', 2, 16, (v) => Math.round(v / 2 ** -29)],
  ['omg0', 2, 32, (v) => Math.round(v / Math.PI / 2 ** -31)],
  ['cis', 2, 16, (v) => Math.round(v / 2 ** -29)],
  ['i0', 2, 32, (v) => Math.round(v / Math.PI / 2 ** -31)],
  ['crc', 2, 16, (v) => Math.round(v / 2 ** -5)],
  ['omg', 2, 32, (v) => Math.round(v / Math.PI / 2 ** -31)],
  ['omgd', 2, 24, (v) => Math.round(v / Math.PI / 2 ** -43)],
  ['idot', 2, 14, (v) => Math.round(v / Math.PI / 2 ** -43)],
];

// RINEX value order inside `values`: 0 af0, 1 af1, 2 af2, 3 iode, 4 crs, 5 dn, 6 m0, 7 cuc, 8 e,
// 9 cus, 10 sqrtA, 11 toe, 12 cic, 13 omg0, 14 cis, 15 i0, 16 crc, 17 omg, 18 omgd, 19 idot,
// 20 codes, 21 week, 22 spare, 23 accuracy, 24 health, 25 tgd, 26 iodc
const ORDER = ['af0', 'af1', 'af2', 'iode', 'crs', 'dn', 'm0', 'cuc', 'e', 'cus', 'sqrtA', 'toe/16', 'cic', 'omg0', 'cis', 'i0', 'crc', 'omg', 'omgd', 'idot', 'codes', 'week', 'spare', 'ura', 'health', 'tgd', 'iodc'];

for (const [name, subframeIndex, width, toRaw] of FIELDS) {
  const orderIndex = ORDER.indexOf(name);
  const offsets = new Map<number, number>();
  for (const record of records) {
    const subs = subframes.get(record.prn);
    if (!subs) continue;
    const bytes = subs[subframeIndex];
    const raw = ((toRaw(record.values[orderIndex]) % 2 ** width) + 2 ** width) % 2 ** width;
    const hits: number[] = [];
    for (let offset = 0; offset <= 240 - width; offset++) if (ub(bytes, offset, width) === raw) hits.push(offset);
    for (const offset of hits) offsets.set(offset, (offsets.get(offset) ?? 0) + 1);
  }
  const best = [...offsets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`${name.padEnd(8)} sub${subframeIndex + 1} w=${String(width).padStart(2)}  ${best.map(([offset, n]) => `${offset}×${n}`).join('  ')}`);
}
