/**
 * Probe: which SBF port byte does the suite write for a text header's port name?
 *
 *   node 逆向/tools/probe-text-port.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

const BODY = 'SOL_COMPUTED,SINGLE,1.25,2.5,3.5,-14.4000,WGS84,1.0263,1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';
const ports = ['USB2', 'COM1', 'USB1', 'USB3', 'SPECIAL', 'THISPORT', 'FILE', 'NCOM1', 'USB2_29', 'BOGUS'];
const lines = ports.map((port, index) => {
  const text = `#BESTPOSA,${port},${index},72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY}`;
  return `${text}*${novatelCrc32(latin1Bytes(text.slice(1))).toString(16).padStart(8, '0')}\r\n`;
});
const capture = latin1Bytes(lines.join(''));

const dir = mkdtempSync(join(TEMP, 'oracle-port-'));
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
    console.log(ports[index], '->', frame.header.kind === 'long' ? frame.header.portAddress : '?', 'seq', frame.header.kind === 'long' ? frame.header.sequence : '?');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
