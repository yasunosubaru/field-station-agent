// Ad-hoc: compare our ASCII encoder against the golden file, keyed by (message, time).
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { encodeAsciiLog } from '../04_重实现/packages/protocol/src/ascii-log.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const [capturePath, goldenPath] = process.argv.slice(2);

const ours = new Map<string, string[]>();
for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))) {
  if (frame.kind !== 'sbf') continue;
  const layout = tables.messages[String(frame.header.messageId)];
  if (!layout) continue;
  const line = encodeAsciiLog(frame, layout, tables);
  if (!line) continue;
  const key = `${layout.name}@${frame.header.milliseconds}`;
  const list = ours.get(key) ?? [];
  list.push(line);
  ours.set(key, list);
}

const golden = new Map<string, string[]>();
for (const line of readFileSync(goldenPath, 'utf8').split(/\r?\n/)) {
  if (!line.startsWith('#')) continue;
  const head = line.slice(1, line.indexOf(';')).split(',');
  const name = head[0].replace(/A$/, '');
  const ms = Math.round(Number(head[6]) * 1000);
  const key = `${name}@${ms}`;
  const list = golden.get(key) ?? [];
  list.push(line);
  golden.set(key, list);
}

let same = 0;
let diff = 0;
let missing = 0;
const samples: Array<[string, number, string, string]> = [];
for (const [key, lines] of golden) {
  const mine = ours.get(key);
  if (!mine) { missing += lines.length; continue; }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === mine[i]) same++;
    else {
      diff++;
      if (samples.length < 6) samples.push([key, i, lines[i], mine[i] ?? '<none>']);
    }
  }
}
const extras = [...ours.keys()].filter((key) => !golden.has(key));
console.log(`identical ${same}   different ${diff}   missing ${missing}   extra keys ${extras.length}`);
for (const key of extras.slice(0, 5)) console.log(`  extra: ${key} ×${ours.get(key)?.length}`);
for (const [key, i, a, b] of samples) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  console.log(`--- ${key} #${i} first diff at ${p}`);
  console.log(`  G ...${a.slice(Math.max(0, p - 40), p + 60)}`);
  console.log(`  O ...${b.slice(Math.max(0, p - 40), p + 60)}`);
}
