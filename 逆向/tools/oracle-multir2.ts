import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frame, oracle } from './oracle.ts';

const REPO = 'H:\\Archive\\文件夹 老版\\personal content\\课程资料\\其他\\大创项目\\野外台站智能体';
const live = join(REPO, '逆向', '00_来源', 'samples', 'live-20261031');
const { SbfDeframer } = await import('../04_重实现/packages/protocol/src/framing.ts');
const { convertFrames } = await import('../04_重实现/packages/protocol/src/convert-pipeline.ts');
const tables = JSON.parse(readFileSync(join(REPO, '逆向', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));

const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(live, 'b1-20261101.sbf'))))] as any[];
const bestpos = frames.filter((item) => item.kind === 'sbf' && item.header.messageId === 42).slice(0, 2);
const capture = Buffer.from(frame(128, new Uint8Array(Buffer.concat(bestpos.map((item) => Buffer.from(item.bytes))))));
const result = oracle(capture, 'multir2');
console.log(`suite ASCII ${result.ascii.length} lines:`);
result.ascii.forEach((line, index) => console.log(`  [${index}] len=${line.length} ${line.slice(0, 90)}`));
console.log(`suite ABBREV ${result.abbrev.length} lines:`);
result.abbrev.forEach((line, index) => console.log(`  [${index}] len=${line.length} ${line.slice(0, 90)}`));
for (const format of ['ASCII', 'ABBREV_ASCII'] as const) {
  const ours = convertFrames([...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(capture))], {
    format, at: new Date('2026-11-01T00:00:00'), tables, name: 'probe.sbf',
  });
  const lines = Buffer.from(ours.files[0].bytes).toString('latin1').split('\r\n').filter(Boolean);
  console.log(`ours ${format} ${lines.length} lines:`);
  lines.forEach((line, index) => console.log(`  [${index}] len=${line.length} ${line.slice(0, 90)}`));
}
