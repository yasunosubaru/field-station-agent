// Cross-validate RAWEPHEM field offsets against every available golden RINEX 2.1 nav file.
// Usage: node rawephem-scan2.ts <capture.gps> <golden.26N> [<capture2> <golden2> ...]
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

function toBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
function ub(bytes: number[], offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    const bit = offset + i;
    value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return value;
}

interface Frame {
  prn: number;
  week: number;
  toe: number;
  ms: number;
  subs: number[][];
}
interface Golden { prn: number; head: string; values: number[]; }

function readGolden(navPath: string): Golden[] {
  const nav = readFileSync(navPath, 'utf8').split(/\r?\n/);
  const end = nav.findIndex((line) => /END OF HEADER/.test(line));
  const out: Golden[] = [];
  for (let i = end + 1; i + 7 < nav.length; i += 8) {
    const head = nav[i];
    const values: number[] = [];
    const cut = (text: string) => {
      for (let at = 0; at + 19 <= text.length; at += 19) {
        const piece = text.slice(at, at + 19).trim();
        if (piece) values.push(Number(piece.replace('D', 'E')));
      }
    };
    cut(head.slice(22));
    for (let line = 1; line < 8; line++) cut(nav[i + line].slice(3));
    out.push({ prn: Number(head.slice(0, 2)), head: head.slice(0, 22), values });
  }
  return out;
}

function readFrames(capturePath: string): Frame[] {
  const out: Frame[] = [];
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))) {
    if (frame.kind !== 'sbf' || frame.header.messageId !== 41) continue;
    const values = decodeEdie(frame.payload, tables.messages['41'], tables);
    const get = (p: string) => String(values.find((v) => v.path === p)?.value ?? '');
    out.push({
      prn: Number(get('satellite_id')),
      week: Number(get('week')),
      toe: Number(get('toe')),
      ms: frame.header.milliseconds,
      subs: ['subframe1', 'subframe2', 'subframe3'].map((p) => toBytes(get(p))),
    });
  }
  return out;
}

function tocSeconds(head: string, week: number): number {
  const yy = Number(head.slice(2, 5));
  const t = Date.UTC(2000 + yy, Number(head.slice(5, 8)) - 1, Number(head.slice(8, 11)),
    Number(head.slice(11, 14)), Number(head.slice(14, 17)), Math.round(Number(head.slice(17, 22))));
  return Math.round((t - (Date.UTC(1980, 0, 6) + week * 7 * 86400000)) / 1000);
}

interface Sample { frame: Frame; golden: Golden; toc: number; }
const samples: Sample[] = [];
for (let i = 0; i + 1 < args.length; i += 2) {
  const frames = readFrames(args[i]);
  const goldens = readGolden(args[i + 1]);
  console.log(`${args[i].split(/[\\/]/).pop()}: ${frames.length} RAWEPHEM, ${goldens.length} golden records; frame prns=${frames.map((f) => f.prn).join(',')}`);
  const used = new Set<number>();
  for (const g of goldens) {
    const frame = frames.find((f, idx) => f.prn === g.prn && !used.has(idx));
    if (!frame) { console.log(`  !! no frame for prn ${g.prn}`); continue; }
    used.add(frames.indexOf(frame));
    samples.push({ frame, golden: g, toc: tocSeconds(g.head, frame.week) });
  }
  for (let idx = 0; idx < frames.length; idx++) {
    if (used.has(idx)) continue;
    console.log(`  unused frame prn ${frames[idx].prn} toe=${frames[idx].toe}`);
  }
}
console.log(`total samples: ${samples.length}`);

const IDX = { af0: 0, af1: 1, af2: 2, iode: 3, crs: 4, dn: 5, m0: 6, cuc: 7, e: 8, cus: 9, sqrtA: 10, toe: 11, cic: 12, omg0: 13, cis: 14, i0: 15, crc: 16, omg: 17, omgd: 18, idot: 19, codes: 20, week: 21, spare: 22, ura: 23, health: 24, tgd: 25, iodc: 26 } as const;

const SPECS: Array<{ name: string; sub: number; width: number; target: (s: Sample) => number }> = [
  { name: 'week%1024', sub: 0, width: 10, target: (s) => s.golden.values[IDX.week] },
  { name: 'ura', sub: 0, width: 4, target: (s) => s.golden.values[IDX.ura] },
  { name: 'health', sub: 0, width: 6, target: (s) => s.golden.values[IDX.health] },
  { name: 'codes', sub: 0, width: 1, target: (s) => s.golden.values[IDX.codes] },
  { name: 'tgd', sub: 0, width: 8, target: (s) => Math.round(s.golden.values[IDX.tgd] / 2 ** -31) },
  { name: 'toc/16', sub: 0, width: 16, target: (s) => s.toc / 16 },
  { name: 'af2', sub: 0, width: 8, target: (s) => Math.round(s.golden.values[IDX.af2] / 2 ** -55) },
  { name: 'af1', sub: 0, width: 16, target: (s) => Math.round(s.golden.values[IDX.af1] / 2 ** -43) },
  { name: 'af0', sub: 0, width: 22, target: (s) => Math.round(s.golden.values[IDX.af0] / 2 ** -31) },
  { name: 'iodcMSB', sub: 0, width: 2, target: (s) => s.golden.values[IDX.iodc] >> 8 },
  { name: 'iode', sub: 1, width: 8, target: (s) => s.golden.values[IDX.iode] },
  { name: 'crs', sub: 1, width: 16, target: (s) => Math.round(s.golden.values[IDX.crs] / 2 ** -5) },
  { name: 'dn', sub: 1, width: 16, target: (s) => Math.round(s.golden.values[IDX.dn] / Math.PI / 2 ** -43) },
  { name: 'm0', sub: 1, width: 32, target: (s) => Math.round(s.golden.values[IDX.m0] / Math.PI / 2 ** -31) },
  { name: 'cuc', sub: 1, width: 16, target: (s) => Math.round(s.golden.values[IDX.cuc] / 2 ** -29) },
  { name: 'e', sub: 1, width: 32, target: (s) => Math.round(s.golden.values[IDX.e] / 2 ** -33) },
  { name: 'cus', sub: 1, width: 16, target: (s) => Math.round(s.golden.values[IDX.cus] / 2 ** -29) },
  { name: 'sqrtA', sub: 1, width: 32, target: (s) => Math.round(s.golden.values[IDX.sqrtA] / 2 ** -19) },
  { name: 'toe/16', sub: 1, width: 16, target: (s) => Math.round(s.golden.values[IDX.toe] / 16) },
  { name: 'cic', sub: 2, width: 16, target: (s) => Math.round(s.golden.values[IDX.cic] / 2 ** -29) },
  { name: 'omg0', sub: 2, width: 32, target: (s) => Math.round(s.golden.values[IDX.omg0] / Math.PI / 2 ** -31) },
  { name: 'cis', sub: 2, width: 16, target: (s) => Math.round(s.golden.values[IDX.cis] / 2 ** -29) },
  { name: 'i0', sub: 2, width: 32, target: (s) => Math.round(s.golden.values[IDX.i0] / Math.PI / 2 ** -31) },
  { name: 'crc', sub: 2, width: 16, target: (s) => Math.round(s.golden.values[IDX.crc] / 2 ** -5) },
  { name: 'omg', sub: 2, width: 32, target: (s) => Math.round(s.golden.values[IDX.omg] / Math.PI / 2 ** -31) },
  { name: 'omgd', sub: 2, width: 24, target: (s) => Math.round(s.golden.values[IDX.omgd] / Math.PI / 2 ** -43) },
  { name: 'idot', sub: 2, width: 14, target: (s) => Math.round(s.golden.values[IDX.idot] / Math.PI / 2 ** -43) },
  { name: 'iode3', sub: 2, width: 8, target: (s) => s.golden.values[IDX.iode] },
];

for (const spec of SPECS) {
  const hits = new Map<number, number>();
  for (const s of samples) {
    const bytes = s.frame.subs[spec.sub];
    const width = 2 ** spec.width;
    const want = ((spec.target(s) % width) + width) % width;
    for (let offset = 0; offset <= 240 - spec.width; offset++) {
      if (ub(bytes, offset, spec.width) === want) hits.set(offset, (hits.get(offset) ?? 0) + 1);
    }
  }
  const full = [...hits.entries()].filter(([, n]) => n === samples.length).map(([o]) => o);
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o, n]) => `${o}x${n}`);
  console.log(`${spec.name.padEnd(10)} sf${spec.sub + 1} w=${String(spec.width).padStart(2)}  ALL=[${full.join(',')}]  top: ${full.length ? '' : top.join(' ')}`);
}

// raw URA nibble at 58 and the accuracy golden, per sample
console.log('\nprn  ura@58  ura@68  accuracy  health@62  codes@68?  iodc  iodcMSB@70');
for (const s of samples) {
  console.log(`${String(s.golden.prn).padStart(3)}  ${String(ub(s.frame.subs[0], 58, 4)).padStart(6)}  ${String(ub(s.frame.subs[0], 68, 4)).padStart(6)}  ${String(s.golden.values[IDX.ura]).padStart(8)}  ${String(ub(s.frame.subs[0], 62, 6)).padStart(8)}  ${String(ub(s.frame.subs[0], 70, 2)).padStart(8)}  ${String(s.golden.values[IDX.iodc]).padStart(5)}  ${ub(s.frame.subs[0], 70, 2)}`);
}
