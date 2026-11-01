/**
 * Where does `--daily-utc` cut, and what moved the day clock at each cut?
 *
 *   node 逆向/tools/probe-daily.ts <capture-or-unsplit.ASCII> <suite part dir> [--format ASCII]
 *
 * The suite's parts are byte prefixes of its unsplit output, so the part sizes give the line index
 * of every cut. Each ASCII line carries its own header (`#NAME,port,seq,idle,status,week,ms,…`), so
 * the day, the time status and the header time are all in the line: the table printed here is the
 * "which status moves the clock, and which way" matrix, read off a real run.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [unsplitPath, partsDir, ...rest] = process.argv.slice(2);
const splitFlag = rest.includes('--no-index');

const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

const parts = readdirSync(partsDir)
  .filter((name) => name.includes('_Part'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const sizes = parts.map((name) => readFileSync(join(partsDir, name)).length);
const total = sizes.reduce((sum, size) => sum + size, 0);
const unsplit = latin1(new Uint8Array(readFileSync(unsplitPath)));
console.log(`unsplit ${unsplit.length} B, ${parts.length} parts, ${total} B total`);
if (total !== unsplit.length) console.log('  ! the parts do not add up to the unsplit file');

const cuts = new Set<number>();
{
  let at = 0;
  for (const size of sizes.slice(0, -1)) { at += size; cuts.add(at); }
}

const STATUS: Record<string, number> = {
  UNKNOWN: 0, APPROXIMATE: 20, COARSESTEERING: 60, FINE: 80, FINEADJUSTING: 100,
  DEGRADED: 120, ALIGNING: 160, FINESTEERING: 180, SATTIME: 200,
};

interface Row { index: number; byteAt: number; name: string; status: string; week: number; ms: number; day: number }

const rows: Row[] = [];
let byteAt = 0;
const lines = unsplit.split('\r\n');
let index = 0;
for (const line of lines) {
  if (line.length === 0) continue;
  const fields = line.slice(1).split(',');
  const name = fields[0] ?? '';
  const status = fields[4] ?? '';
  const week = Number(fields[5]);
  const ms = Math.round(Number(fields[6]) * 1000);
  const day = Number.isFinite(week) && Number.isFinite(ms) ? Math.floor((week * 604_800_000 + ms) / 86_400_000) : NaN;
  rows.push({ index, byteAt, name, status, week, ms, day });
  index += 1;
  byteAt += line.length + 2;
}

console.log(`lines ${rows.length}`);
let previous: Row | undefined;
for (const row of rows) {
  const cut = cuts.has(row.byteAt);
  const changed = !previous || previous.day !== row.day;
  if (cut || changed || previous?.status !== row.status) {
    const mark = cut ? 'CUT ' : '    ';
    const stamp = Number.isFinite(row.day) ? `${row.week}/${(row.ms / 1000).toFixed(3)}` : 'no-stamp';
    const delta = previous && Number.isFinite(row.day) ? row.day - (previous.day ?? NaN) : NaN;
    console.log(`${mark}line ${String(row.index).padStart(5)}  ${row.status.padEnd(15)} ${stamp.padEnd(20)} day ${String(row.day).padStart(6)}${Number.isFinite(delta) ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}  ${row.name}`);
  }
  previous = row;
}
if (!splitFlag) {
  console.log(`\npart sizes: ${parts.map((name, i) => `${name.replace(/^.*_/, '')}=${sizes[i]}`).join(' ')}`);
}
