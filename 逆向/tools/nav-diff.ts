// Byte-diff our RINEX 2.1 nav writers against a golden file, line by line.
import { readFileSync } from 'node:fs';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { buildRinex21GloNav, buildRinex21Nav } from '../04_重实现/packages/protocol/src/rinex21-nav.ts';

const tables: EdieTables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const [capturePath, navPath, builtAt, gloPath] = process.argv.slice(2);

const frames: SbfFrame[] = [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))]
  .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);

const ours = buildRinex21Nav(frames, tables, { builtAt: new Date(builtAt) });
const expected = readFileSync(navPath);
const actual = Buffer.from(ours, 'latin1');
console.log(`our bytes ${actual.length}, golden ${expected.length}, equal=${actual.equals(expected)}`);

const expectedLines = expected.toString('latin1').split('\r\n');
const actualLines = ours.split('\r\n');
let diffs = 0;
for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
  if (expectedLines[i] === actualLines[i]) continue;
  diffs++;
  if (diffs <= 20) {
    console.log(`line ${i + 1}:`);
    console.log(`  golden ${JSON.stringify(expectedLines[i])}`);
    console.log(`  ours   ${JSON.stringify(actualLines[i])}`);
  }
}
console.log(`differing lines: ${diffs} of ${expectedLines.length}`);

if (gloPath) {
  const gloOurs = buildRinex21GloNav({ builtAt: new Date(builtAt) });
  const gloExpected = readFileSync(gloPath);
  console.log(`GLO equal=${Buffer.from(gloOurs, 'latin1').equals(gloExpected)} (${Buffer.byteLength(gloOurs, 'latin1')} vs ${gloExpected.length})`);
}
