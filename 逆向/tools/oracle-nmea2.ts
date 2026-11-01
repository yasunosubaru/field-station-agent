/**
 * Probe 5b: the boundaries of the "last `$` wins" rule found by `oracle-nmea.ts`.
 *
 * Each record is one capture line; the output line order tells which of them produced anything.
 */

import { capture, oracle, show } from './oracle.ts';

function nmea(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

const A = nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
const B = nmea('GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,1000.1,M,46.9,M,,');
const R = nmea('GNRMC,123519,A,4807.038,N,01131.000,E,0.0,0.0,230394,003.1,W');

const result = oracle(
  capture(
    `$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47` + '\r\n', // 1 alone
    `${A}${B}${R}\r\n`,            // 2 three sentences
    `${A}$GPGGA,1,2\r\n`,          // 3 tail without a `*`
    `${A}${B}*00\r\n`,             // 4 second good, then a stray `*00`
    `${A}${B.slice(0, -3)}*7a\r\n`, // 5 lowercase checksum on the last sentence
    `${A}$GNZZZ,1*36\r\n`,         // 6 last sentence is not a known id
  ),
  'nmea2',
);
show('oracle ASCII', result.ascii);
