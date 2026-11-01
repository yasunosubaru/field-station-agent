/**
 * `%R` with **two** embedded records in one payload (every sample so far carries one).
 *
 * `RXCONFIG` (#128) / `RXCONFIGUSER` (#2474) embed whole SBF records in their payload. The ASCII
 * writer prints each embedded record as its own `#…` line and abbreviated ASCII as its own block;
 * what was never observed is the "more than one embedded record" case — does the second one start on
 * a new line, is the outer CRC computed over both, is the outer record dropped when one of them is
 * unknown. This probe builds one #128 frame holding two real BESTPOS frames and asks the suite,
 * then converts the same capture with our pipeline and prints both sides next to each other.
 */

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
const payload = Buffer.concat(bestpos.map((item) => Buffer.from(item.bytes)));
const capture = Buffer.from(frame(128, new Uint8Array(payload)));
console.log(`embedded BESTPOS: ${bestpos.map((item) => item.bytes.length).join(' + ')} bytes; capture ${capture.length} bytes`);

const result = oracle(capture, 'multir');
for (const [label, lines] of [['ASCII', result.ascii], ['ABBREV', result.abbrev]] as const) {
  console.log(`--- suite ${label} (${lines.length} lines)`);
  for (const line of lines.slice(0, 14)) console.log('  ' + line.slice(0, 150));
}

const ours = convertFrames([...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(capture))], {
  format: 'ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'probe.sbf',
});
const oursLines = Buffer.from(ours.files[0].bytes).toString('latin1').split('\r\n').filter(Boolean);
console.log(`--- ours ASCII (${oursLines.length} lines)`);
for (const line of oursLines.slice(0, 14)) console.log('  ' + line.slice(0, 150));

const oursAbbrev = convertFrames([...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(capture))], {
  format: 'ABBREV_ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'probe.sbf',
});
const oursAbbrevLines = Buffer.from(oursAbbrev.files[0].bytes).toString('latin1').split('\r\n').filter(Boolean);
console.log(`--- ours ABBREV (${oursAbbrevLines.length} lines)`);
for (const line of oursAbbrevLines.slice(0, 14)) console.log('  ' + line.slice(0, 150));
