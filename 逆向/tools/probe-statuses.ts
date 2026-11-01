/**
 * Dump a capture's per-record header stamps and time statuses, grouped, so a split can be read
 * against the numbers in the headers rather than against the names printed in the ASCII output.
 *
 *   node 逆向/tools/probe-statuses.ts <capture.sbf> [--around <index>] [--radius 12]
 *
 * This is what explained b7: its ASCII lines read `COARSESTEERING` / `UNKNOWN` / `SATTIME`, but those
 * are the **text records' own headers**; the binary frames underneath all carry status **120**
 * (`DEGRADED`), which is why `--daily-utc` moves its clock at all.
 */

import { readFileSync } from 'node:fs';

import { SbfDeframer, type Frame, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';

const argv = process.argv.slice(2);
const path = argv.find((token) => (token.endsWith('.sbf') || token.endsWith('.gps')) && !argv[argv.indexOf(token) - 1]?.startsWith('--'));
const around = argv.includes('--around') ? Number(argv[argv.indexOf('--around') + 1]) : undefined;
const radius = argv.includes('--radius') ? Number(argv[argv.indexOf('--radius') + 1]) : 12;
if (!path) {
  console.error('usage: probe-statuses.ts <capture.sbf> [--around <index>] [--radius 12]');
  process.exit(2);
}

const NAME: Record<number, string> = {
  0: 'UNKNOWN', 20: 'APPROXIMATE', 60: 'COARSESTEERING', 80: 'FINE', 100: 'FINEADJUSTING',
  120: 'DEGRADED', 160: 'ALIGNING', 180: 'FINESTEERING', 200: 'SATTIME',
};

const bytes = new Uint8Array(readFileSync(path));
const deframer = new SbfDeframer({ crcMode: 'validate' });
const frames: Frame[] = [...deframer.push(bytes)];
deframer.end();

const rows: Array<{ index: number; kind: string; status: number; name: string; week: number; ms: number }> = [];
for (const [index, frame] of frames.entries()) {
  if (frame.kind === 'text') {
    rows.push({ index, kind: 'text', status: -1, name: '', week: 0, ms: 0 });
    continue;
  }
  const sbf = frame as SbfFrame;
  rows.push({
    index,
    kind: 'sbf',
    status: sbf.header.timeStatus,
    name: NAME[sbf.header.timeStatus] ?? String(sbf.header.timeStatus),
    week: sbf.header.week,
    ms: sbf.header.milliseconds,
  });
}

const counts = new Map<string, number>();
for (const row of rows) {
  if (row.kind !== 'sbf') continue;
  const key = `${String(row.status).padStart(4)} ${row.name}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`${path}: ${rows.length} frames, ${rows.filter((row) => row.kind === 'text').length} text`);
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${key}`);

if (around !== undefined) {
  for (let index = Math.max(0, around - radius); index <= Math.min(rows.length - 1, around + radius); index++) {
    const row = rows[index];
    const day = Math.floor((row.week * 604_800_000 + row.ms) / 86_400_000);
    console.log(`  ${String(index).padStart(4)} ${row.kind.padEnd(4)} ${String(row.status).padStart(4)} ${row.name.padEnd(15)} ${row.week}/${(row.ms / 1000).toFixed(3)} day ${day}`);
  }
}
