/**
 * Probe 4/5/6: what Convert does with a **text** record that is not already in canonical form.
 *
 *  4. `#NAME,…;…*crc` — Convert parses the fields and prints them again through the dictionary's
 *     conversion strings. A hand-written `#BESTPOSA` whose idle time reads `72.00` and whose height
 *     reads `64.82390` is the cheapest way to see the re-render: the receiver always writes `72.0`
 *     and `64.8239`, so no golden can tell the two behaviours apart.
 *  5. `$…*hh$…*hh\r\n` — two NMEA sentences with no CRLF between them arrive as one text record.
 *     Which `*` the checksum covers, and what ends up in the file, is only visible from the suite.
 *  6. `<NAME` + the nine header tokens and nothing else — a header with no body.
 */

import { capture, frame, oracle, show } from './oracle.ts';

/** NMEA 0183 XOR checksum over the bytes between `$` and `*`. */
function nmea(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

// A canonical BESTPOSA line from `golden-b1-20261101.ASCII`, then the same record with two fields
// written in a non-canonical but numerically equal way.
const CANONICAL = '#BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
  + 'SOL_COMPUTED,SINGLE,30.53997306366,114.35280786048,64.8239,-14.4000,WGS84,1.0263,1.1219,2.8355,'
  + '"",0.000,0.000,31,17,17,17,00,06,30,03';
const NON_CANONICAL = '#BESTPOSA,USB2,0,72.00,COARSESTEERING,2442,570228.000,03801800,cdba,18278;'
  + 'SOL_COMPUTED,SINGLE,30.539973063660,114.352807860480,64.82390,-14.40000,WGS84,1.02630,1.12190,'
  + '2.83550,"",0.0000,0.0000,31,17,17,17,00,06,30,03';

// The CRC the receiver would write for each form, so the suite's own gate is satisfied.
import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';

function seal(line: string): string {
  return `${line}*${novatelCrc32(latin1Bytes(line.slice(1))).toString(16).padStart(8, '0')}`;
}

const ggaA = nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
const ggaB = nmea('GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,1000.1,M,46.9,M,,');

const result = oracle(
  capture(
    `${seal(CANONICAL)}\r\n`,
    `${seal(NON_CANONICAL)}\r\n`,
    `${ggaA}${ggaB}\r\n`,
    `${ggaB}\r\n`,
    // 6: a header with no body at all, and one followed by another header.
    '<BESTPOS COM1 0 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n',
    '<RANGE COM1 1 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n',
    frame(42, new Uint8Array(72), { sequence: 9 }),
  ),
  'text',
);
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
console.log(`ggaA=${ggaA}`);
console.log(`ggaB=${ggaB}`);
