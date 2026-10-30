// Which RANGE entries does the RINEX writer pick for L1 and P2? Match by pseudorange value.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { decodeEdie } from '../04_重实现/packages/protocol/src/edie.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const [capturePath, obsPath] = process.argv.slice(2);

// --- golden observation file: epoch -> prn -> values
const lines = readFileSync(obsPath, 'utf8').split(/\r?\n/);
const end = lines.findIndex((line) => /END OF HEADER/.test(line));
const golden = new Map<string, Map<number, number[]>>();
let index = end + 1;
while (index < lines.length) {
  const epoch = lines[index];
  if (!epoch || epoch.length < 32) { index += 1; continue; }
  const y = 2000 + Number(epoch.slice(0, 3));
  const mo = epoch.slice(3, 6).trim();
  const d = epoch.slice(6, 9).trim();
  const h = epoch.slice(9, 12).trim();
  const mi = epoch.slice(12, 15).trim();
  const s = epoch.slice(15, 26).trim();
  const key = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${Number(s).toFixed(3)}`;
  const count = Number(epoch.slice(29, 32));
  const sats: string[] = [];
  for (let k = 0; k < count; k++) sats.push(epoch.slice(32 + k * 3, 35 + k * 3));
  const byPrn = new Map<number, number[]>();
  let cursor = index + 1;
  for (let s2 = 0; s2 < count; s2++) {
    const values: number[] = [];
    for (let line = 0; line < 2 && cursor < lines.length; line++) {
      const text = lines[cursor++];
      for (let f = 0; f < 5; f++) {
        const at = f * 16;
        if (at + 14 > text.length) break;
        values.push(Number(text.slice(at, at + 14)));
      }
    }
    byPrn.set(Number(sats[s2].slice(1)), values);
  }
  golden.set(key, byPrn);
  index = cursor;
}
console.log('golden epochs:', golden.size);

// --- capture: RANGE per epoch
const week0 = 2442;
function gpsKey(week: number, ms: number): string {
  const date = new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + ms);
  return date.toISOString().slice(0, 19) + '.' + String(ms % 1000).padStart(3, '0');
}
const byEpoch = new Map<string, Array<{ prn: number; status: number; psr: number; adr: number; dop: number; cnr: number }>>();
for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))) {
  if (frame.kind !== 'sbf' || frame.header.messageId !== 43) continue;
  const values = decodeEdie(frame.payload, tables.messages['43'], tables);
  const key = gpsKey(frame.header.week, frame.header.milliseconds);
  const list = byEpoch.get(key) ?? [];
  const count = values.find((value) => value.isCount);
  const blocks = new Map<number, Map<string, number | string>>();
  let current = -1;
  for (const value of values) {
    if (value.isCount) continue;
    const match = /^obs\[(\d+)\]\.(.+)$/.exec(value.path);
    if (match) {
      const index2 = Number(match[1]);
      if (!blocks.has(index2)) blocks.set(index2, new Map());
      blocks.get(index2)!.set(match[2], value.value);
    }
  }
  void current; void count;
  for (const [, block] of blocks) {
    list.push({
      prn: Number(block.get('sv_prn')),
      status: Number(block.get('c_status')),
      psr: Number(block.get('psr')),
      adr: Number(block.get('adr')),
      dop: Number(block.get('dop')),
      cnr: Number(block.get('C_No')),
    });
  }
  byEpoch.set(key, list);
}
console.log('capture epochs:', byEpoch.size, ' weeks:', week0);

// --- match
const pairs = new Map<string, number>();
let matched = 0;
for (const [key, byPrn] of golden) {
  const range = byEpoch.get(key);
  if (!range) continue;
  for (const [prn, values] of byPrn) {
    const c1 = values[0];
    const p2 = values[4];
    const entries = range.filter((entry) => entry.prn === prn);
    const l1 = entries.find((entry) => Math.abs(entry.psr - c1) < 0.002);
    const l2 = entries.find((entry) => Math.abs(entry.psr - p2) < 0.002);
    if (l1 && l2) {
      matched += 1;
      const tag = `L1=${l1.status.toString(16)} L2=${l2.status.toString(16)}`;
      pairs.set(tag, (pairs.get(tag) ?? 0) + 1);
    }
  }
}
console.log('matched satellite-epochs:', matched);
for (const [tag, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${tag}  ×${n}`);

