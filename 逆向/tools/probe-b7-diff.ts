/**
 * Probe: line-by-line diff of our b7 ASCII output against the suite's golden, with the `#RXCONFIGA`
 * lines either included or excluded.
 *
 *   node 逆向/tools/probe-b7-diff.ts <ours> <golden>
 */

import { readFileSync } from 'node:fs';

const readText = (path: string): string => {
  const bytes = readFileSync(path);
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};
const readLines = (path: string): string[] => readText(path).split('\r\n').filter((line) => line.length > 0);

const [oursPath, goldenPath] = process.argv.slice(2);
const ours = readLines(oursPath);
const golden = readLines(goldenPath);
console.log(`ours ${ours.length}, golden ${golden.length}`);

const filter = (lines: string[], skip: boolean): string[] =>
  skip ? lines.filter((line) => !line.startsWith('#RXCONFIG')) : lines;
for (const skip of [false, true]) {
  const a = filter(ours, skip);
  const b = filter(golden, skip);
  let same = true;
  let first = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { same = false; if (first < 0) first = i; }
  }
  console.log(`${skip ? 'without' : 'with   '} RXCONFIG: ${a.length} vs ${b.length}, ${same ? 'identical' : `first diff at ${first}`}`);
  if (!same && first >= 0) {
    console.log(`  ours  ${JSON.stringify(a[first])}`);
    console.log(`  gold  ${JSON.stringify(b[first])}`);
  }
}
