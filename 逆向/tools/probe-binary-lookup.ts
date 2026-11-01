/**
 * Decisive probe: does the suite encode a text record from its **text**, or copy the payload of a
 * binary record that carries the same time?
 *
 * The capture holds one binary BESTPOS (latitude 1.25) and one `#BESTPOSA` text record with a very
 * different latitude, same week/milliseconds. `-b` then shows which value the encoded frame holds.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer, type SbfFrame } from '../04_重实现/packages/protocol/src/framing.ts';
import { buildLongHeader } from '../04_重实现/packages/protocol/src/header.ts';
import { appendCrcLe } from '../04_重实现/packages/protocol/src/crc.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

const payload = new Uint8Array(72);
const view = new DataView(payload.buffer);
view.setUint32(0, 0, true); // SOL_COMPUTED
view.setUint32(4, 16, true); // SINGLE
view.setFloat64(8, 1.25, true);
view.setFloat64(16, 2.5, true);
view.setFloat64(24, 3.5, true);

const head = buildLongHeader({
  messageId: 42,
  payloadLength: payload.length,
  portAddress: 189,
  sequence: 0,
  idleTimeRaw: 144,
  timeStatus: 120,
  week: 2442,
  milliseconds: 570228000,
  receiverStatus: 0x03801800,
  reserved: 0xcdba,
  softwareVersion: 18278,
});
const body = new Uint8Array(head.length + payload.length);
body.set(head, 0);
body.set(payload, head.length);
const binaryFrame = appendCrcLe(body);

const TEXT = '#BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
  + 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,2.8355,'
  + '"",0.000,0.000,31,17,17,17,00,06,30,03';
const line = `${TEXT}*${novatelCrc32(latin1Bytes(TEXT.slice(1))).toString(16).padStart(8, '0')}\r\n`;

const parts = [binaryFrame, latin1Bytes(line)];
const total = parts.reduce((sum, part) => sum + part.length, 0);
const capture = new Uint8Array(total);
let at = 0;
for (const part of parts) { capture.set(part, at); at += part.length; }

const dir = mkdtempSync(join(TEMP, 'oracle-lookup-'));
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
  console.log(`output ${bytes.length} B`);
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  for (const frame of deframer.push(bytes) as SbfFrame[]) {
    const p = frame.payload;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    console.log(`id ${frame.header.messageId} port ${frame.header.portAddress} len ${frame.bytes.length} lat ${v.getFloat64(8, true)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
