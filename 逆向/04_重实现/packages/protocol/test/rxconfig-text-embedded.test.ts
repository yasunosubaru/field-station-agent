/**
 * The **text** form of `RXCONFIG`: `#RXCONFIGA,<head>;#<INNER>,<innerHead>;<body>*<innerCrc>*<outerCrc>`.
 *
 * The binary record (#128) prints its `%R` payload by re-rendering an embedded *binary* frame
 * (`ascii-log.ts`); the text record does the same thing one level up — it parses the embedded
 * **ASCII** record and prints *that* again. b7-20261101 carries 269 of them, which is the only
 * oracle for the shape. What they force, measured on all 269:
 *
 *  - the embedded record is **not** copied. `INTERFACEMODE`'s `LCOM1` comes back `UNKNOWN`, because
 *    the name is not in this dictionary's `CommPort` table and the suite prints `UNKNOWN` for a
 *    value it cannot name;
 *  - a record whose embedded name the dictionary does **not** carry prints nothing at all and takes
 *    the outer record with it: 269 − 22 = 247 lines, in both formats;
 *  - the inner CRC is the **one's complement** of the NovAtel CRC over the re-rendered sentence
 *    `NAME,<head>;<body>`; the plain CRC (`a9cc0a2e` for sequence 265) is never what it writes, and
 *    the CRC the capture carried (`81750840`) is not even looked at;
 *  - the outer CRC is the plain NovAtel CRC over everything between `#` and the final `*` — that is,
 *    it **includes** the inner record and its CRC.
 *
 * Asserted against `golden-b7-20261101.ASCII` and `golden-b7-20261101.ABBREV_ASCII` byte for byte,
 * plus synthetic captures for the corners b7 does not reach (truncated body, extra token, empty
 * body), each measured through the suite's own Convert first — see
 * `逆向/tools/oracle-rxconfiga{3,4,5}.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer } from '../src/framing.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import { novatelCrc32 } from '../src/crc.ts';
import { latin1Bytes } from '../src/ascii-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const lines = (text: string): string[] => text.split('\r\n').filter((line) => line.length > 0);

const capture = new Uint8Array(readFileSync(join(samples, 'b7-20261101.sbf')));
const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(capture)];

const convert = (format: 'ASCII' | 'ABBREV_ASCII'): string =>
  asText(
    convertFrames(frames, {
      format,
      at: new Date('2026-11-01T00:00:00Z'),
      tables,
      name: 'b7-20261101.sbf',
    }).files[0].bytes,
  );

const ascii = convert('ASCII');
const abbrev = convert('ABBREV_ASCII');
const goldenAscii = asText(new Uint8Array(readFileSync(join(samples, 'golden-b7-20261101.ASCII'))));
const goldenAbbrev = asText(new Uint8Array(readFileSync(join(samples, 'golden-b7-20261101.ABBREV_ASCII'))));

const crcHex = (text: string): string => novatelCrc32(latin1Bytes(text)).toString(16).padStart(8, '0');

/** `#RXCONFIGA,…,;#INNER,…,;body*innerCrc*outerCrc` split into its four parts. */
function splitConfig(line: string): { outerHead: string; inner: string; innerCrc: string; outerCrc: string } {
  const outerCrc = line.slice(line.lastIndexOf('*') + 1);
  const beforeOuter = line.slice(0, line.lastIndexOf('*'));
  const innerCrc = beforeOuter.slice(beforeOuter.lastIndexOf('*') + 1);
  const record = beforeOuter.slice(0, beforeOuter.lastIndexOf('*'));
  const innerStart = record.indexOf('#', 1);
  return {
    outerHead: record.slice(1, record.indexOf(';')),
    inner: record.slice(innerStart + 1),
    innerCrc,
    outerCrc,
  };
}

const configs = (text: string): string[] => lines(text).filter((line) => line.startsWith('#RXCONFIGA'));

// ------------------------------------------------------------------ the two full files

test('b7 ASCII is byte-identical to the suite, config records included', () => {
  assert.equal(ascii.length, goldenAscii.length);
  assert.equal(ascii, goldenAscii);
});

test('b7 ABBREV_ASCII is byte-identical to the suite, config blocks included', () => {
  assert.equal(abbrev.length, goldenAbbrev.length);
  assert.equal(abbrev, goldenAbbrev);
});

// ------------------------------------------------------------------ the drop and the re-render

test('247 of the 269 config records are printed; the 22 unresolvable ones are dropped', () => {
  const raw = frames.filter(
    (frame) => frame.kind === 'text' && frame.text.startsWith('#RXCONFIG'),
  );
  assert.equal(raw.length, 269);
  assert.equal(configs(ascii).length, 247);
  assert.equal(configs(goldenAscii).length, 247);

  // The dropped names are the ones this dictionary has no layout for.
  const names = new Set(Object.values(tables.messages).map((message) => message.name));
  const innerNames = raw.map((frame) => {
    const line = frame.kind === 'text' ? frame.text.replace(/[\r\n]+$/, '') : '';
    const blob = line.slice(line.indexOf(';') + 1);
    return blob.slice(1, blob.indexOf(',')).replace(/[A-Z]$/, '');
  });
  assert.equal(innerNames.filter((name) => !names.has(name)).length, 22);
  assert.deepEqual(configs(ascii), configs(goldenAscii));
});

test('the embedded record is re-rendered, not copied: LCOM1 prints as UNKNOWN', () => {
  // Sequence 265 wraps `INTERFACEMODE`, whose `port` field carries a `CommPort` name this
  // dictionary's table does not list.
  const ours = configs(ascii).find((line) => line.split(',')[2] === '265');
  assert.ok(ours, 'missing the config record for sequence 265');
  const golden = configs(goldenAscii).find((line) => line.split(',')[2] === '265');
  assert.equal(ours, golden);
  assert.equal(
    ours,
    '#RXCONFIGA,USB2,265,76.5,SATTIME,0,0.000,03808800,f702,18278;'
    + '#INTERFACEMODEA,USB2,265,76.5,SATTIME,0,0.000,03808800,7a68,18278;'
    + 'UNKNOWN,NOVATEL,NOVATEL,ON*5633f5d1*b7ce43ba',
  );
  // …and the capture said `LCOM1`, with a CRC of its own.
  const frame = frames.find((candidate) => candidate.kind === 'text' && candidate.text.includes(',265,'));
  assert.ok(frame && frame.kind === 'text');
  assert.match(frame.text, /;LCOM1,NOVATEL,NOVATEL,ON\*[0-9a-f]{8}\*[0-9a-f]{8}\r?\n?$/);
});

// ------------------------------------------------------------------ the inner CRC

test('the inner CRC is the one\u2019s complement of the NovAtel CRC over the re-rendered sentence', () => {
  const printed = configs(ascii);
  assert.equal(printed.length, 247);
  for (const line of printed) {
    const { inner, innerCrc, outerCrc, outerHead } = splitConfig(line);
    const crc = novatelCrc32(latin1Bytes(inner));
    // The complement, never the plain CRC — `a9cc0a2e` for sequence 265.
    assert.equal(innerCrc, ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'), `inner CRC of ${inner.slice(0, 40)}`);
    assert.notEqual(innerCrc, crcHex(inner), 'a plain CRC never appears here');
    // The outer CRC covers the inner record **and** its CRC field.
    assert.equal(outerCrc, crcHex(`${outerHead};#${inner}*${innerCrc}`), `outer CRC of ${outerHead}`);
  }
});

test('the CRC a capture carries inside the blob is not validated', () => {
  // Sequence 265's own inner CRC is `81750840`; the printed `5633f5d1` is the complement of the
  // re-rendered sentence (`crc` `a9cc0a2e`). None of the three is the same number.
  const ours = configs(ascii).find((line) => line.split(',')[2] === '265');
  assert.ok(ours);
  const { inner, innerCrc } = splitConfig(ours);
  assert.equal(crcHex(inner), 'a9cc0a2e');
  assert.equal(innerCrc, '5633f5d1');
  assert.equal(((novatelCrc32(latin1Bytes(inner)) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'), '5633f5d1');
});

// ------------------------------------------------------------------ synthetic corners (oracle-measured)

/** Seal a `#NAME,…` sentence with the plain CRC (the receiver's convention). */
const seal = (sentence: string): string =>
  `#${sentence}*${crcHex(sentence)}`;

/** Wrap a whole `#INNER,…*crc` record in one `#RXCONFIGA` and seal the outer record. */
function configLine(inner: string): string {
  const outer = `RXCONFIGA,USB2,9,76.5,SATTIME,0,0.000,03808800,f702,18278;${inner}`;
  return `#${outer}*${crcHex(outer)}\r\n`;
}

const ECHO_HEAD = 'USB2,208,76.5,UNKNOWN,0,2.036,03809800,f3ea,18278';

/** Convert a synthetic ASCII capture and return the lines it produced. */
function synthetic(...records: string[]): string[] {
  const bytes = new Uint8Array(records.join('').length);
  const text = records.join('');
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  const parsed = [...new SbfDeframer({ crcMode: 'validate' }).push(bytes)];
  return lines(
    asText(
      convertFrames(parsed, {
        format: 'ASCII',
        at: new Date('2026-11-01T00:00:00Z'),
        tables,
        name: 'probe.sbf',
      }).files[0].bytes,
    ),
  );
}

test('an enum name the table does not carry prints UNKNOWN, and a number it lacks does too', () => {
  const out = synthetic(
    configLine(seal(`ECHOA,${ECHO_HEAD};COM2,OFF`)),
    configLine(seal(`ECHOA,${ECHO_HEAD};BOGUS,OFF`)),
    configLine(seal(`ECHOA,${ECHO_HEAD};8,OFF`)),
  );
  assert.equal(out.length, 3);
  assert.match(out[0], /;COM2,OFF\*/);
  assert.match(out[1], /;UNKNOWN,OFF\*/);
  assert.match(out[2], /;UNKNOWN,OFF\*/);
});

test('an extra body token is dropped; a truncated one keeps the fields it has', () => {
  const out = synthetic(
    configLine(seal(`ECHOA,${ECHO_HEAD};COM2,OFF,99`)),
    configLine(seal(`ECHOA,${ECHO_HEAD};COM2`)),
  );
  assert.equal(out.length, 2);
  assert.match(out[0], /;COM2,OFF\*/);
  assert.match(out[1], /;COM2\*/);
});

test('an empty body and an unresolvable embedded name both drop the whole record', () => {
  const out = synthetic(
    configLine(seal(`ECHOA,${ECHO_HEAD};`)),
    configLine(seal(`FOOBARA,${ECHO_HEAD};1,2`)),
    configLine(seal(`ECHOA,${ECHO_HEAD};COM2,OFF`)),
  );
  // Only the last one survives — and it re-rendered the value again, so the counters do not shift.
  assert.equal(out.length, 1);
  assert.match(out[0], /^#RXCONFIGA,.*;#ECHOA,.*;COM2,OFF\*[0-9a-f]{8}\*[0-9a-f]{8}$/);
});

test('ABBREV prints the embedded header at five spaces and its arrays at nine', () => {
  // `SETTIMESOURCE` is a counted array of enums: one data line and one line per element.
  const source = frames.find(
    (frame) => frame.kind === 'text' && frame.text.includes(';#SETTIMESOURCEA,') && frame.text.includes(',251,'),
  );
  assert.ok(source && source.kind === 'text');
  const block = lines(goldenAbbrev);
  const head = block.findIndex((line) => line === '<RXCONFIG USB2 251 76.5 SATTIME 0 0.000 03808800 f702 18278');
  assert.ok(head >= 0);
  assert.deepEqual(block.slice(head, head + 6), [
    '<RXCONFIG USB2 251 76.5 SATTIME 0 0.000 03808800 f702 18278',
    '<     SETTIMESOURCE USB2 251 76.5 SATTIME 0 0.000 03808800 8aba 18278 ',
    '<     3 ',
    '<          GPS ',
    '<          BEIDOU ',
    '<          GALILEO',
  ]);
  // …and ours is the same six lines.
  const ourLines = lines(abbrev);
  const at = ourLines.findIndex((line) => line === block[head]);
  assert.deepEqual(ourLines.slice(at, at + 6), block.slice(head, head + 6));
});
