/**
 * Probe A10c: take one **real** `#RXCONFIGA` line out of b7, mutate exactly one thing, and ask the
 * suite what it prints. This rules out every structural mistake a hand-built record could make: the
 * outer CRC is recomputed exactly the way b7's is, and only the inner bytes change.
 *
 *   node 逆向/tools/oracle-rxconfiga3.ts
 *
 * Measured (2026-11-01):
 *
 *  - the inner record's own CRC field is **ignored**: a verbatim line, one with the plain CRC, one
 *    with the complement and one with `00000000` all print the same recomputed value;
 *  - an enum token the table does not carry prints `UNKNOWN`, whether it is a name (`BOGUS`) or a
 *    number the table lacks (`8`);
 *  - a body **one token short** still prints the fields it has (`;COM2` alone);
 *  - an **extra** body token is dropped, and the canonical line comes back;
 *  - the inner head is re-rendered exactly like the outer one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { crcHex, novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { capture, oracle, show } from './oracle.ts';

const root = join(import.meta.dirname, '..');
const live = join(root, '00_来源', 'samples', 'live-20261031');
const bytes = new Uint8Array(readFileSync(join(live, 'b7-20261101.sbf')));
const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(bytes)];
const raw = frames
  .filter((frame) => frame.kind === 'text' && frame.text.startsWith('#RXCONFIG'))
  .map((frame) => frame.text.replace(/[\r\n]+$/, ''));

const plain = (text: string): string => crcHex(novatelCrc32(latin1Bytes(text)));
const complement = (text: string): string => crcHex((novatelCrc32(latin1Bytes(text)) ^ 0xffffffff) >>> 0);

/** The embedded record of a whole `#RXCONFIGA,…;#INNER,…*crc*outerCrc` line. */
function innerOf(line: string): string {
  const innerStart = line.indexOf('#', line.indexOf(';'));
  const outerStar = line.lastIndexOf('*');
  return line.slice(innerStart + 1, line.lastIndexOf('*', outerStar - 1));
}

/** `NAME,<head>;<body>` with no `#`/`*`. */
function outerHeadOf(line: string): string {
  return line.slice(1, line.indexOf(';'));
}

function seal(outerHead: string, innerSentence: string): string {
  const body = `${outerHead};#${innerSentence}*${complement(innerSentence)}`;
  return `#${body}*${plain(body)}`;
}

const echo = raw.find((line) => line.includes(';#ECHOA,') && line.includes(',208,'))!;
const log = raw.find((line) => line.includes(';#LOGA,') && innerOf(line).includes('USB1'))!;
const interfaceMode = raw.find((line) => line.includes(';#INTERFACEMODEA,'))!;

const echoHead = 'USB2,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,18278';
const logHead = innerOf(log).slice(innerOf(log).indexOf(',') + 1, innerOf(log).indexOf(';'));
const interfaceHead = innerOf(interfaceMode).slice(innerOf(interfaceMode).indexOf(',') + 1, innerOf(interfaceMode).indexOf(';'));

const cases: Array<[string, string]> = [
  ['verbatim', echo],
  ['echo, inner CRC zeroed', seal(outerHeadOf(echo), innerOf(echo)).replace(/\*[0-9a-f]{8}\*/, '*00000000*')],
  ['echo, unknown enum name', seal(outerHeadOf(echo), `ECHOA,${echoHead};BOGUS,OFF`)],
  ['echo, enum number 8', seal(outerHeadOf(echo), `ECHOA,${echoHead};8,OFF`)],
  ['echo, enum number 3', seal(outerHeadOf(echo), `ECHOA,${echoHead};3,OFF`)],
  ['echo, enum number 200', seal(outerHeadOf(echo), `ECHOA,${echoHead};200,OFF`)],
  ['echo, body one token short', seal(outerHeadOf(echo), `ECHOA,${echoHead};COM2`)],
  ['echo, body one token extra', seal(outerHeadOf(echo), `ECHOA,${echoHead};COM2,OFF,99`)],
  ['echo, empty body', seal(outerHeadOf(echo), `ECHOA,${echoHead};`)],
  ['echo, odd head', seal(outerHeadOf(echo), `ECHOA,COM1,208,72.00,20,02442,570228.0,3800800,CDBA,18278;COM2,OFF`)],
  ['echo, odd head, port spelled USB2', seal(outerHeadOf(echo), `ECHOA,USB2,8,72.0,SATTIME,2442,570228.000,03809800,f3ea,18278;COM2,OFF`)],
  ['log, unknown message name (%m)', seal(outerHeadOf(log), `LOGA,${logHead};USB1,NOTALOG,ONNEW,0.000000,0.000000,HOLD`)],
  ['log, verbatim', log],
  ['interfacemode, LCOM1', interfaceMode],
  ['interfacemode, LCOM1 with a fresh head', seal(outerHeadOf(interfaceMode), `INTERFACEMODEA,${interfaceHead};LCOM1,NOVATEL,NOVATEL,ON`)],
  ['interfacemode, numeric 1', seal(outerHeadOf(interfaceMode), `INTERFACEMODEA,${interfaceHead};1,NOVATEL,NOVATEL,ON`)],
];

for (const [label, line] of cases) {
  const result = oracle(capture(`${line}\r\n`), 'rxconfiga3');
  console.log(`\n--- ${label}`);
  console.log(`  in   ${line}`);
  show('  out', result.ascii);
}
