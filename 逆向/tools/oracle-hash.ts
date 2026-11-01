/**
 * Probe 4b: how much of a `#NAMEA,…;…*crc` header Convert re-renders, and what it does when the body
 * token count does not match the layout.
 *
 * The head of an ASCII record is ten typed fields (`name`, port, sequence, idle, timeStatus, week,
 * milliseconds, receiver status, message-definition CRC, software version). A receiver always writes
 * them canonically, so only a synthetic record can show whether Convert formats them again.
 */

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { capture, oracle, show } from './oracle.ts';

/** `sentence` is everything after the `#`; the CRC covers exactly those bytes. */
function seal(sentence: string): string {
  const crc = novatelCrc32(latin1Bytes(sentence));
  return `#${sentence}*${crc.toString(16).padStart(8, '0')}`;
}

const BODY = 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,'
  + '1.1219,2.8355,"",0.000,0.000,31,17,17,17,00,06,30,03';

// Every header token written in a non-canonical but numerically equal way.
const ODD_HEAD = 'BESTPOSA,USB2,007,72.00,COARSESTEERING,02442,570228.0,3800800,CDBA,18278';

const result = oracle(
  capture(
    `${seal(`${ODD_HEAD};${BODY}`)}\r\n`,
    // two extra tokens at the end
    `${seal(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY},99,88`)}\r\n`,
    // two tokens missing at the end
    `${seal(`BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY.slice(0, -5)}`)}\r\n`,
    // the idle time alone, far from any plausible value
    `${seal(`BESTPOSA,USB2,0,0.00,COARSESTEERING,2442,570228.000,03801800,cdba,18278;${BODY}`)}\r\n`,
  ),
  'hashHead',
);
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
