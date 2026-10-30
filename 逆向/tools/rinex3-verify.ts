// Verify the RINEX 3.x writer against all four goldens, printing the differing line numbers.
import { readFileSync } from 'node:fs';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { buildRinex3Obs, type Rinex3Version } from '../04_重实现/packages/protocol/src/rinex3.ts';

const tables = JSON.parse(readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'));
const capture = new Uint8Array(readFileSync(process.argv[2]));
const frames = [...new SbfDeframer({ crcMode: 'mirror' }).push(capture)].filter((frame) => frame.kind === 'sbf' && frame.crcOk);

const root = process.argv[3];
const versions: Array<[Rinex3Version, string, string]> = [
  ['3.01', 'golden-rinex3_01', 'RINEXv3_01'],
  ['3.02', 'golden-rinex3_02', 'RINEXv3_02'],
  ['3.03', 'golden-rinex3_03', 'RINEXv3_03'],
  ['3.04', 'golden-rinex3_04', 'RINEXv3_04'],
];

for (const [version, goldenDir, outDir] of versions) {
  const ours = buildRinex3Obs(frames, tables, version, { builtAt: new Date('2026-10-30T17:10:09') });
  const golden = readFileSync(`${root}/${goldenDir}/clean-9600/Converted_On_20261030_T1710/${outDir}/clean-9600.26O`, 'utf8');
  const a = golden.split('\r\n');
  const b = ours.split('\r\n');
  const diffs: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffs.push(i + 1);
  console.log(`${version}  lines ${a.length}/${b.length}  bytes ${golden.length}/${ours.length}  differing lines: ${diffs.join(',') || '(none)'}`);
}

