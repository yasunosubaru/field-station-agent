// Probe indentation and trailing-space rules of abbreviated ASCII records.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
const stats = new Map<string, { indent: Set<number>; trailing: Set<boolean>; total: number }>();

let record: string[] = [];
let name = '';
const flush = () => {
  if (!record.length) return;
  const rows = record;
  record = [];
  rows.forEach((line, index) => {
    if (index === 0) return; // header
    const indent = line.length - line.replace(/^</, '').trimStart().length;
    const key = `${name}#${index === 1 ? 'first' : 'block'}${index === rows.length - 1 ? '/last' : ''}`;
    const entry = stats.get(key) ?? { indent: new Set(), trailing: new Set(), total: 0 };
    entry.indent.add(indent);
    entry.trailing.add(line.endsWith(' '));
    entry.total += 1;
    stats.set(key, entry);
  });
};

for (const line of lines) {
  if (!line.startsWith('<')) continue;
  if (/^<[A-Z0-9]+ /.test(line)) {
    flush();
    name = /^<([A-Z0-9]+) /.exec(line)![1];
    record = [line];
    continue;
  }
  record.push(line);
}
flush();

for (const key of [...stats.keys()].sort()) {
  const entry = stats.get(key)!;
  console.log(`${key.padEnd(28)} n=${String(entry.total).padStart(5)} indent=${[...entry.indent].sort((a, b) => a - b).join('/')} trailingSpace=${[...entry.trailing].join('/')}`);
}
