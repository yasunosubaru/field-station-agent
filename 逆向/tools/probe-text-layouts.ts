/**
 * Probe: text → binary for the layouts no capture carries as text, compared byte for byte with the
 * suite's own `-b` output.
 *
 * Each case is a text-only record, so the encoded frame cannot be a copy of anything:
 *
 *  - `SETNAV` — two `variable` strings (padding to 4 bytes, and the member behind them moving);
 *  - `LOGLIST` — a `FIELD_ARRAY` of six-field elements with a `%m` message id;
 *  - `SENDHEX` — a `%Z` byte array printed as one hex token;
 *  - `PASSCOM1` — a `%P` payload printed escaped (`\\xNN`, `\\\\`);
 *  - `BESTPOS` — a fixed 4-byte string, empty and full.
 *
 *   node 逆向/tools/probe-text-layouts.ts
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

const BESTPOS_BODY = (base: string) => `SOL_COMPUTED,SINGLE,1.25,2.5,3.5,-14.4000,WGS84,1.0263,1.1219,2.8355,${base},0.000,0.000,31,17,17,17,00,06,30,03`;
const CASES: Array<{ name: string; body: string }> = [
  { name: 'SETNAV', body: '1.1,2.2,3.3,4.4,5.5,"FROM","TO"' },
  { name: 'LOGLIST', body: '2,COM1,RXSTATUSEVENTA,ONNEW,1.5,2.5,HOLD,USB2,BESTPOSA,ONTIME,0.0,0.0,NOHOLD' },
  { name: 'SENDHEX', body: 'COM1,3,aabbcc' },
  { name: 'PASSCOM1', body: '5,hello' },
  { name: 'BESTPOS', body: BESTPOS_BODY('""') },
  { name: 'BESTPOS', body: BESTPOS_BODY('"ABCD"') },
];
const lines = CASES.map((entry, index) => {
  const text = `#${entry.name}A,USB2,${index},72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${entry.body}`;
  return `${text}*${novatelCrc32(latin1Bytes(text.slice(1))).toString(16).padStart(8, '0')}\r\n`;
});
const capture = latin1Bytes(lines.join(''));

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const dir = mkdtempSync(join(TEMP, 'oracle-layouts-'));
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
    .map((record) => encodeRecord(record, tables));

  console.log(`suite ${suite.length} frames, ours ${ours.length}`);
  CASES.forEach((entry, index) => {
    const a = suite[index];
    const b = ours[index]?.bytes;
    const same = a && b ? hex(a.bytes) === hex(b) : false;
    console.log(`\n${index} ${entry.name} equal=${same}`);
    console.log(`  suite ${a ? hex(a.bytes).slice(0, 200) : '(none)'}`);
    console.log(`  ours  ${b ? hex(b).slice(0, 200) : `(${ours[index]?.error ?? 'none'})`}`);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
