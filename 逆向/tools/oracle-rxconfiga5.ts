/**
 * Probe A10e: is "an enum token is a *name*, never a number" a rule of the ASCII reader in general,
 * or only of the record embedded in `#RXCONFIGA`?
 *
 * Same three bodies, once as a top-level `#ECHOA` line and once as the embedded record.
 *
 *   node 逆向/tools/oracle-rxconfiga5.ts
 */

import { crcHex, novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { capture, oracle, show } from './oracle.ts';

const crc = (text: string): string => crcHex(novatelCrc32(latin1Bytes(text)));
const seal = (sentence: string): string => `#${sentence}*${crc(sentence)}`;

const HEAD = 'USB2,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,18278';
const BODIES = ['COM2,OFF', '8,OFF', '3,OFF', 'BOGUS,OFF', 'USB1,OFF'];

const lines: string[] = [];
for (const body of BODIES) {
  lines.push(`${seal(`ECHOA,${HEAD};${body}`)}\r\n`);
  const inner = seal(`ECHOA,${HEAD};${body}`);
  const outer = `RXCONFIGA,USB2,9,76.5,SATTIME,0,0.000,03808800,f702,18278;${inner}`;
  lines.push(`${seal(outer)}\r\n`);
}

const result = oracle(capture(lines.join('')), 'rxconfiga5');
show('suite ASCII', result.ascii);
