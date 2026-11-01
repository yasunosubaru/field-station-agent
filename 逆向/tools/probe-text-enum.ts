/**
 * Probe: what does the suite write for an enum **name** its table does not carry?
 *
 * `b7`'s `INTERFACEMODE` records print `LCOM1`…`LCOM4` for their `port` (an unknown `CommPort`
 * name) and the suite's binary frame holds `53`, not `0`. This probe feeds several unknown names and
 * one out-of-range numeric token to a text-only capture so the rule can be read off directly.
 *
 *   node 逆向/tools/probe-text-enum.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

const ports = ['LCOM1', 'LCOM4', 'BOGUSNAME', 'COM5', 'UNKNOWN', 'COM1'];
const lines = ports.map((port, index) => {
  const mode = index === 0 ? 'BOGUSMODE' : 'NOVATEL';
  const text = `#INTERFACEMODEA,USB2,${index},72.0,COARSESTEERING,2442,570228.000,03801800,7a68,18278;${port},${mode},${mode},ON`;
  return `${text}*${novatelCrc32(latin1Bytes(text.slice(1))).toString(16).padStart(8, '0')}\r\n`;
});
const capture = latin1Bytes(lines.join(''));

const dir = mkdtempSync(join(TEMP, 'oracle-enum-'));
try {
  const input = join(dir, 'probe.sbf');
  writeFileSync(input, capture);
  const out = join(dir, 'BINARY');
  mkdirSync(out, { recursive: true });
  execFileSync(SUITE, ['-b', '-o', out, input], { stdio: 'pipe', timeout: 120_000 });
  const stem = readdirSync(out)[0];
  const stamp = readdirSync(join(out, stem))[0];
  const binDir = join(out, stem, stamp, 'BINARY');
  const bytes = new Uint8Array(readFileSync(join(binDir, readdirSync(binDir)[0])));
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)].filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  console.log('frames', frames.length);
  frames.forEach((frame, index) => {
    const p = frame.payload;
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    console.log(ports[index], '-> port', view.getUint32(0, true), 'rxtx', view.getUint32(4, true), view.getUint32(8, true), 'resp', view.getUint32(12, true));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
