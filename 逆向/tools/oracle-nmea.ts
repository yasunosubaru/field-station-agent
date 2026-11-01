/**
 * Probe 5: which `$` / which `*` a merged, unterminated NMEA record resolves to.
 *
 * `framing.ts` already knows that `$…$…\r\n` arrives as **one** text record (a `$` does not start a
 * new record inside a text span). What that record prints is decided here: last `$` or first `$`,
 * and whose checksum is validated.
 */

import { capture, oracle, show } from './oracle.ts';

function nmea(body: string): { line: string; sum: number } {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
  return { line: `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`, sum };
}

const A = nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
const B = nmea('GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,1000.1,M,46.9,M,,');
const R = nmea('GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,003.1,W');
const wrong = (line: string): string => `${line.slice(0, -2)}00`;
console.log(`A=${A.line}\nB=${B.line}\nR=${R.line}`);

const result = oracle(
  capture(
    // 1: both good → which one comes out?
    `${A.line}${B.line}\r\n`,
    // 2: first good, second broken
    `${A.line}${wrong(B.line)}\r\n`,
    // 3: first broken, second good
    `${wrong(A.line)}${B.line}\r\n`,
    // 4: both good, different sentence types
    `${A.line}${R.line}\r\n`,
    // 5: same, but the second sentence has no comma after the id
    `${A.line}$GPGGA\r\n`,
  ),
  'nmea',
);
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
