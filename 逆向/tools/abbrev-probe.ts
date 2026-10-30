// Probe the abbreviated-ASCII layout: header / count / block lines, and per-column widths.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/);

const messages = new Map<string, { headers: string[]; counts: string[]; blocks: string[] }>();
let current: { headers: string[]; counts: string[]; blocks: string[] } | null = null;
for (const line of lines) {
  if (!line.startsWith('<')) continue;
  const header = /^<([A-Z0-9]+) /.exec(line);
  if (header) {
    current = messages.get(header[1]) ?? { headers: [], counts: [], blocks: [] };
    messages.set(header[1], current);
    current.headers.push(line);
    continue;
  }
  if (!current) continue;
  const body = line.slice(1);
  if (/^\s+\d+\s*$/.test(body)) {
    current.counts.push(line);
    continue;
  }
  current.blocks.push(line);
}

for (const [name, info] of messages) {
  console.log(`${name.padEnd(14)} headers=${info.headers.length} counts=${info.counts.length} blocks=${info.blocks.length}`);
}

function tokens(line: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== ' ') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      out.push([i, j - 1, line.slice(i, j)]);
      i = j;
    } else i++;
  }
  return out;
}

for (const name of process.argv.slice(3)) {
  const info = messages.get(name);
  if (!info || info.blocks.length === 0) continue;
  console.log(`--- ${name}`);
  if (info.counts[0]) console.log(`  count   : ${JSON.stringify(info.counts[0])} (len ${info.counts[0].length})`);
  console.log(`  sample  : ${JSON.stringify(info.blocks[0])} (len ${info.blocks[0].length})`);
  const ends = new Map<number, Set<number>>();
  const widths = new Map<number, Set<number>>();
  for (const line of info.blocks) {
    for (const [index, [start, end, text]] of tokens(line).entries()) {
      if (!ends.has(index)) ends.set(index, new Set());
      ends.get(index)!.add(end);
      if (!widths.has(index)) widths.set(index, new Set());
      widths.get(index)!.add(end - start + 1);
    }
  }
  console.log(`  end cols: ${[...ends.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => `${i}:${[...s].sort((a, b) => a - b).join('/')}`).join('  ')}`);
  console.log(`  widths  : ${[...widths.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => `${i}:${[...s].sort((a, b) => a - b).join('/')}`).join('  ')}`);
}
