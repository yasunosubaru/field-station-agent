/**
 * Probe: run the suite's `-b` on a synthetic capture and dump the frames it writes, so the
 * text→binary encoding rule can be read off directly (a text-only capture has no binary frame to
 * copy from).
 *
 *   node 逆向/tools/oracle-binary-text.ts            # the built-in BESTPOSA probe
 *   node 逆向/tools/oracle-binary-text.ts --file <capture>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

function seal(line: string): string {
  return `${line}*${novatelCrc32(latin1Bytes(line.slice(1))).toString(16).padStart(8, '0')}`;
}

const CANONICAL = '#BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
  + 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,2.8355,'
  + '"",0.000,0.000,31,17,17,17,00,06,30,03';

const argv = process.argv.slice(2);
const fromFile = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : undefined;
const inputBytes = fromFile
  ? new Uint8Array(readFileSync(fromFile))
  : latin1Bytes(`${seal(CANONICAL)}\r\n`);

const dir = mkdtempSync(join(TEMP, 'oracle-bintext-'));
try {
  const input = join(dir, 'probe.sbf');
  writeFileSync(input, inputBytes);
  const out = join(dir, 'BINARY');
  mkdirSync(out, { recursive: true });
  execFileSync(SUITE, ['-b', '-o', out, input], { stdio: 'pipe', timeout: 120_000 });
  const stem = readdirSync(out)[0];
  const stamp = readdirSync(join(out, stem))[0];
  const binDir = join(out, stem, stamp, 'BINARY');
  const file = readdirSync(binDir)[0];
  const bytes = new Uint8Array(readFileSync(join(binDir, file)));
  console.log(`output ${bytes.length} B`);
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)].filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  for (const frame of frames) {
    const h = frame.header;
    console.log(`id ${h.kind === 'long' ? h.messageId : 'short'} len ${frame.bytes.length}`);
    if (h.kind === 'long') console.log(`  port ${h.portAddress} seq ${h.sequence} idle ${h.idleTimeRaw} ts ${h.timeStatus} week ${h.week} ms ${h.milliseconds} rx ${h.receiverStatus.toString(16)} defcrc ${h.reserved.toString(16)} ver ${h.softwareVersion} msgType ${h.messageTypeByte}`);
    console.log(`  payload ${Array.from(frame.payload, (b) => b.toString(16).padStart(2, '0')).join('')}`);
    if (h.kind === 'long' && h.messageId === 42) {
      const p = frame.payload;
      const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
      console.log(`  lat ${view.getFloat64(8, true)} ${view.getFloat64(8, true) === Number('30.53997306366') ? 'TEXT' : 'not-text'}`);
      console.log(`  lon ${view.getFloat64(16, true)}`);
      console.log(`  hgt ${view.getFloat64(24, true)}`);
      for (let at = 32; at <= 60; at += 4) console.log(`  f32@${at} ${view.getFloat32(at, true)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
