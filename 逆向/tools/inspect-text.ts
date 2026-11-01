import { loadCapture } from '../04_重实现/packages/app/src/capture.ts';
import { resolveCapture } from '../04_重实现/packages/app/src/paths.ts';
import { textRecordFields } from '../04_重实现/packages/protocol/src/text-log.ts';
import { readFileSync } from 'node:fs';

const tables = JSON.parse(readFileSync('H:/Archive/文件夹 老版/personal content/课程资料/其他/大创项目/野外台站智能体/逆向/04_重实现/packages/protocol/data/edie-layouts.json', 'utf8'));
const data = loadCapture(resolveCapture('live-20261031/b7-20261101.sbf'));
console.log('frames', data.frames.length, 'allFrames', data.allFrames.length, 'textRecords', data.textRecords);
const texts = data.allFrames.filter((frame: any) => frame.kind === 'text') as any[];
console.log('text frames in allFrames', texts.length);
const hashes = texts.filter((frame) => `${frame.prefix}${frame.text}`.trim().startsWith('#'));
console.log('hash text frames', hashes.length);
for (const frame of hashes.slice(0, 2)) {
  const line = `${frame.prefix}${frame.text}`.replace(/[\r\n]+$/, '');
  console.log('line:', JSON.stringify(line.slice(0, 100)));
  const parsed = textRecordFields(line, tables);
  console.log('  parsed:', parsed ? parsed.name + ' fields=' + parsed.fields.length : 'undefined');
}
