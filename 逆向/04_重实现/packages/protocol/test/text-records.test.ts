/**
 * The text records a capture can carry besides `<…`: `$` NMEA, `%` short ASCII, and the ABBREV
 * form of every text record.
 *
 * All of it is oracle work — synthetic captures fed to `NovAtelApplicationSuite.exe`, plus the
 * suite's own ABBREV output for `samples/live-20261031/live-nav.sbf`:
 *
 *  - `$` — a sentence is copied out verbatim, but only if its 5-letter id is one of the 29 NMEA
 *    logs Convert knows, its NMEA XOR checksum matches, and the line ends with CRLF.
 *  - `%` — short ASCII is not read at all: six shapes all land in Convert's "UNKNOWN" bucket.
 *  - `#` — copied out for ASCII, but only with a valid NovAtel CRC and a name the dictionary has;
 *    for ABBREV it is parsed and printed again in the abbreviated shape, like a `<` record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { abbrevTextLogLines, passThroughNmea, textLogLines } from '../src/text-log.ts';
import { SbfDeframer, type Frame } from '../src/framing.ts';
import { novatelCrc32 } from '../src/crc.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

const textFrame = (prefix: '#' | '%' | '<' | '$' | '[text]', text: string): Frame => ({ kind: 'text', prefix, text });

function nmea(id: string, tail: string): string {
  let sum = 0;
  for (const ch of `${id}${tail}`) sum ^= ch.charCodeAt(0);
  return `$${id}${tail}*${(sum & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

// ------------------------------------------------------------------ NMEA

test('a `$` sentence with a known id, a good checksum and CRLF is copied out verbatim', () => {
  const cases = [
    '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47',
    '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A',
    '$GPGLL,4916.45,N,12311.12,W,225444,A,*1D',
    '$GPGST,123519.00*58',
    '$GPHDT,*63',
    '$GLGLL,4916.45,N,12311.12,W,225444,A,*01',
    '$GNVTG,054.7,T,034.4,M,005.5,N,010.2,K,*7A',
  ];
  for (const line of cases) assert.equal(passThroughNmea(`${line}\r\n`), line);
});

test('the checksum hex may be lowercase and the line is echoed exactly as it came', () => {
  assert.equal(passThroughNmea('$GPGLL,4916.45,N,12311.12,W,225444,A,*1d\r\n'), '$GPGLL,4916.45,N,12311.12,W,225444,A,*1d');
});

test('what the suite drops: bad checksum, unknown id, another talker, lowercase id, no CRLF', () => {
  const ggaBody = 'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,';
  const cases = [
    'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*00', // checksum mismatch
    'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,', // no checksum at all
    'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47garbage', // trailing bytes
    nmea('GNGGA', ',123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'), // GNGGA is not in the table
    nmea('GPXYZ', ',1,2,3'),
    nmea('GP', ',1,2'),
    nmea('BESTPOSA', ',USB2,0,72.0,FINESTEERING,2442,570228.000'),
    nmea('GPGGA', ',123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,').toLowerCase(),
    '$hello world*00',
    '',
  ];
  for (const text of cases) assert.equal(passThroughNmea(`${text}\r\n`), undefined, JSON.stringify(text));
  // A lone LF and a lone CR are both refused, and so is a final sentence with no terminator.
  assert.equal(passThroughNmea(`${nmea('GPGGA', ggaBody.slice(6))}\n`), undefined);
  assert.equal(passThroughNmea(`${nmea('GPGGA', ggaBody.slice(6))}\r`), undefined);
  assert.equal(passThroughNmea(nmea('GPGGA', ggaBody.slice(6))), undefined);
});

test('a `$` frame contributes exactly one line, in capture order', () => {
  const frames: Frame[] = [
    textFrame('$', '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n'),
    textFrame('$', '$GNGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*59\r\n'),
  ];
  const lines = textLogLines(frames, tables);
  assert.deepEqual([...lines.entries()], [[0, '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47']]);
});

// ------------------------------------------------------------------ `%` and noise

test('`%` short ASCII, `[port]` banners, `<OK` and stray text produce nothing', () => {
  const frames: Frame[] = [
    textFrame('$', '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n'),
    textFrame('%', '%BESTPOSA,USB2,0,72.0,COARSESTEERING,2442,570228.000,03801800,cdba,18278;SOL_COMPUTED\r\n'),
    textFrame('%', '%\r\n'),
    textFrame('[text]', '[USB2]'),
    textFrame('[text]', '[USB1]\r\n'),
    textFrame('<', '<OK\r\n'),
    textFrame('<', '<ERROR\r\n'),
    textFrame('<', '<\r\n'),
    textFrame('<', 'garbage line without a prefix\r\n'),
  ];
  const lines = textLogLines(frames, tables);
  assert.deepEqual([...lines.keys()], [0], 'only the `$` line survives');
  assert.equal(abbrevTextLogLines(frames, tables).size, 1);
});

// ------------------------------------------------------------------ `#` gates

const hashOf = (sentence: string): string => `#${sentence}*${novatelCrc32(new TextEncoder().encode(sentence)).toString(16).padStart(8, '0')}`;
const HASH_BODY = 'RAWALMA,USB,0,75.0,FINESTEERING,2402,91818.000,03801800,cdba,18278;2402,91818.000,0';

test('a `#` record needs a valid CRC and a name the dictionary knows', () => {
  const good = hashOf(HASH_BODY);
  assert.equal(textLogLines([textFrame('#', `${good}\r\n`)], tables).get(0), good);
  // `*00000000` instead of the real CRC: dropped.
  const badCrc = `${good.slice(0, good.lastIndexOf('*') + 1)}00000000`;
  assert.equal(textLogLines([textFrame('#', `${badCrc}\r\n`)], tables).size, 0);
  // A name the dictionary does not have: dropped even with a perfect CRC.
  const unknown = hashOf(HASH_BODY.replace('RAWALMA', 'FOOBARA'));
  assert.equal(textLogLines([textFrame('#', `${unknown}\r\n`)], tables).size, 0);
});

// ------------------------------------------------------------------ ABBREV

test('ABBREV: a `#RAWALMA` record is re-printed as an abbreviated record, one line per element', () => {
  const page1 = '00112233445566778899aabbccddeeff00112233445566778899aabbccdd';
  const page2 = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322';
  const body = `RAWALMA,USB,0,75.0,FINESTEERING,2402,91818.000,03801800,cdba,18278;2402,91818.000,2,1,${page1},2,${page2}`;
  const lines = abbrevTextLogLines([textFrame('#', `${hashOf(body)}\r\n`)], tables).get(0);
  assert.deepEqual(lines, [
    '<RAWALM USB 0 75.0 FINESTEERING 2402 91818.000 03801800 cdba 18278',
    '<     2402 91818.000 2 ',
    `<          1 ${page1} `,
    `<          2 ${page2}`,
  ]);
});

test('ABBREV: a zero-element array still leaves one (empty) element line', () => {
  const body = 'SATVIS2A,USB,0,75.0,FINESTEERING,2402,91818.000,03801800,cdba,18278;SBAS,TRUE,FALSE,0';
  assert.deepEqual(abbrevTextLogLines([textFrame('#', `${hashOf(body)}\r\n`)], tables).get(0), [
    '<SATVIS2 USB 0 75.0 FINESTEERING 2402 91818.000 03801800 cdba 18278',
    '<     SBAS TRUE FALSE 0 ',
    '<         ',
  ]);
});

test('ABBREV: a `$` sentence is copied out verbatim', () => {
  const sentence = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
  assert.deepEqual(abbrevTextLogLines([textFrame('$', `${sentence}\r\n`)], tables).get(0), [sentence]);
});

test('ABBREV: every text record of live-nav, as the suite prints it', () => {
  const frames: Frame[] = [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(join(samples, 'live-nav.sbf'))))];
  const records = abbrevTextLogLines(frames, tables);
  assert.equal(records.size, 79, '79 text records (the same count the ASCII side sees)');

  const range = [...records.values()].find((lines) => lines[0].startsWith('<RANGE '));
  assert.ok(range);
  assert.equal(range.length, 75, 'header + count line + 73 elements');
  assert.equal(range[0], '<RANGE USB2 0 75.5 COARSESTEERING 2442 555611.000 03801800 5103 18278');
  assert.equal(range[1], '<     73 ');
  assert.equal(range[2], '<          4 0 20229880.713 0.188 -106308738.293962 0.025 -3196.615 39.2 13.932 1810bc04 ');
  assert.equal(range[74], '<          29 0 18627069.605 0.072 -75003764.836262 0.006 -1401.061 49.7 13740.886 01743d84');
});
