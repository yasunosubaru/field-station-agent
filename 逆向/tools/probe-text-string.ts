/**
 * Probe: how a text `STRING` field becomes binary — fixed width, NUL padding, truncation.
 *
 * b1's `#BESTPOSA` records all carry an empty `base_id`, so the four zero bytes could mean anything.
 * This probe feeds two text-only captures (a 2-character and a 4-character id) to the suite and
 * prints the payload, so the padding rule is measured rather than inferred.
 *
 *   node 逆向/tools/probe-text-string.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import { collectBinaryRecords } from '../04_重实现/packages/protocol/src/text-log.ts';
import { encodeRecord } from '../04_重实现/packages/protocol/src/binary-log.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';
const tables = JSON.parse(
  readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'),
) as EdieTables;

const ids = ['""', '"AB"', '"ABCD"', '"ABCDEF"'];
const BODY = (base: string) => `SOL_COMPUTED,SINGLE,1.25,2.5,3.5,-14.4000,WGS84,1.0263,1.1219,2.8355,${base},0.000,0.000,31,17,17,17,00,06,30,03`;
const lines = ids.map((base, index) => {
  const text = `#BESTPOSA,USB2,${index},72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY(base)}`;
  return `${text}*${novatelCrc32(latin1Bytes(text.slice(1))).toString(16).padStart(8, '0')}\r\n`;
});
const capture = latin1Bytes(lines.join(''));

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const dir = mkdtempSync(join(TEMP, 'oracle-string-'));
try {
  const input = join(dir, 'probe.sbf');
  writeFileSync(input, capture);
  const out = join(dir, 'BINARY');
  mkdirSync(out, { recursive: true });
  execFileSync(SUITE, ['-b', '-o', out, input], { stdio: 'pipe', timeout: 120_000 });
  const stem = readdirSync(out)[0];
  const stamp = readdirSync(join(out, stem))[0];
  const binDir = join(out, stem, stamp, 'BINARY');
  const suiteBytes = new Uint8Array(readFileSync(join(binDir, readdirSync(binDir)[0])));

  const d = new SbfDeframer({ crcMode: 'validate' });
  const suite = [...d.push(suiteBytes)].filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ours = [...collectBinaryRecords([...new SbfDeframer({ crcMode: 'validate' }).push(capture)], tables).values()]
    .map((record) => encodeRecord(record, tables).bytes!);

  ids.forEach((base, index) => {
    const a = suite[index];
    const b = ours[index];
    console.log(`${base.padEnd(8)} suite flag=${a ? 'frame' : 'none'} payload[52..56]=${a ? hex(a.payload.subarray(52, 56)) : '-'} ours=${b ? hex(b.subarray(28 + 52, 28 + 56)) : '-'} equal=${a && b ? hex(a.bytes) === hex(b) : false}`);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
