/**
 * Probe A10d: the two corners the b7 golden does not reach — a truncated embedded body, and which
 * header token makes an otherwise canonical `#RXCONFIGA` record disappear.
 *
 *   node 逆向/tools/oracle-rxconfiga4.ts
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

function seal(sentence: string, invert = false): string {
  const value = novatelCrc32(latin1Bytes(sentence));
  return `#${sentence}*${crcHex(invert ? (value ^ 0xffffffff) >>> 0 : value)}`;
}
function wrap(outerHead: string, inner: string): string {
  return `${seal(`${outerHead};${inner}`, false)}\r\n`;
}
function innerOf(line: string): string {
  const innerStart = line.indexOf('#', line.indexOf(';'));
  const outerStar = line.lastIndexOf('*');
  return line.slice(innerStart + 1, line.lastIndexOf('*', outerStar - 1));
}
const outerHeadOf = (line: string): string => line.slice(1, line.indexOf(';'));

const echo = raw.find((line) => line.includes(';#ECHOA,') && line.includes(',208,'))!;
const log = raw.find((line) => line.includes(';#LOGA,') && innerOf(line).includes('USB1'))!;
const echoOuter = outerHeadOf(echo);
const echoHead = innerOf(echo).slice(6, innerOf(echo).indexOf(';'));
const logOuter = outerHeadOf(log);
const logHead = innerOf(log).slice(5, innerOf(log).indexOf(';'));

const cases: Array<[string, string]> = [
  // truncated bodies, top level vs embedded
  ['ECHO truncated to one token (embedded)', wrap(echoOuter, seal(`ECHOA,${echoHead};COM2`, true))],
  ['ECHO truncated to one token (top level)', seal(`ECHOA,${echoHead};COM2`)],
  ['ECHO empty body (top level)', seal(`ECHOA,${echoHead};`)],
  ['LOGA truncated to one token (embedded)', wrap(logOuter, seal(`LOGA,${logHead};USB1`, true))],
  ['BESTPOS truncated by two tokens (top level)', seal(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,2.8355,"",0.000,0.000,31,17`)],
  // the odd inner header, one token at a time
  ['head: port COM1', wrap(echoOuter, seal(`ECHOA,COM1,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,18278;COM2,OFF`, true))],
  ['head: idle 72.00', wrap(echoOuter, seal(`ECHOA,USB2,208,72.00,UNKNOWN,0,2.036,03809800,f3ea,18278;COM2,OFF`, true))],
  ['head: time status 20', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,20,0,2.036,03809800,f3ea,18278;COM2,OFF`, true))],
  ['head: week 02442', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,18278;COM2,OFF`, true))],
  ['head: milliseconds 570228.0', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,UNKNOWN,0,570228.0,03809800,f3ea,18278;COM2,OFF`, true))],
  ['head: receiver status 3800800', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,UNKNOWN,0,2.036,3800800,f3ea,18278;COM2,OFF`, true))],
  ['head: def crc CDBA', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,UNKNOWN,0,2.036,03809800,CDBA,18278;COM2,OFF`, true))],
  ['head: version 018278', wrap(echoOuter, seal(`ECHOA,USB2,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,018278;COM2,OFF`, true))],
];

for (const [label, line] of cases) {
  const result = oracle(capture(line), 'rxconfiga4');
  console.log(`\n--- ${label}`);
  show('  out', result.ascii);
}
