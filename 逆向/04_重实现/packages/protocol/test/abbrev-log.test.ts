/**
 * The abbreviated-ASCII line shape, one rule per test.
 *
 * Every expectation here was read off the suite's own output (`NovAtelApplicationSuite.exe
 * --abbrev`) for a capture built to exercise the rule, not off our own encoder:
 *
 *  - the `clean-9600` / `b1` ABBREV goldens for the header, the indents and the trailing spaces;
 *  - a synthetic `PASSCOM1` for `%P` — `<     8 a,b*\\\x0d\x0a\x9c`;
 *  - a synthetic `IPSTATUS`-shaped record for "a second array starts a new data line"
 *    (b2's own IPSTATUS frame prints `<     1 ` / `<          ETHA …` / `<     1 ` / `<          …`);
 *  - a synthetic `CLOCKMODEL` for the fixed-length arrays (all twelve values on the data line);
 *  - b1's own `RXCONFIG` frames for the `%R` nesting (`<     ELEVATIONCUTOFF …` and its body).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { buildLongHeader } from '../src/header.ts';
import { appendCrcLe } from '../src/crc.ts';
import { encodeAbbrevLines } from '../src/abbrev-log.ts';
import { abbrevTextLogLines } from '../src/text-log.ts';
import type { EdieLayout, EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** A frame with a readable header, so the first line is predictable. */
function frame(messageId: number, payload: number[] | Uint8Array): SbfFrame {
  const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const header = buildLongHeader({
    messageId,
    payloadLength: bytes.length,
    portAddress: 128,
    sequence: 3,
    idleTimeRaw: 150,
    timeStatus: 180,
    week: 2442,
    milliseconds: 463098000,
    receiverStatus: 0x03801800,
    reserved: 0xb1f6,
    softwareVersion: 14695,
  });
  const body = new Uint8Array(header.length + bytes.length);
  body.set(header, 0);
  body.set(bytes, header.length);
  const all = appendCrcLe(body);
  const [decoded] = new SbfDeframer({ crcMode: 'validate' }).push(all);
  if (!decoded || decoded.kind !== 'sbf') throw new Error('frame did not de-frame');
  return decoded;
}

/** A table holding the one layout under test. */
function table(layout: EdieLayout): EdieTables {
  return { enums: {}, messages: { 1: layout } };
}

const HEADER = '<TESTLOG USB 3 75.0 FINESTEERING 2442 463098.000 03801800 b1f6 14695';

const counted = (payload: number[]): EdieLayout => ({
  name: 'TESTLOG',
  style: 'OEM4_MESSAGE_STYLE',
  type: 'LOG',
  fields: [
    { name: 'first', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' },
    {
      name: 'items',
      kind: 'array',
      offset: 4,
      countSize: 4,
      arrayKind: 'field',
      stride: 4,
      elements: [{ name: 'value', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' }],
    },
  ],
});

function u32(...values: number[]): number[] {
  const bytes: number[] = [];
  for (const value of values) bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  return bytes;
}

test('a counted FIELD_ARRAY prints its count on the data line, one element per line', () => {
  const layout = counted([]);
  const lines = encodeAbbrevLines(frame(1, u32(7, 2, 11, 12)), layout, table(layout));
  assert.deepEqual(lines, [`${HEADER}`, '<     7 2 ', '<          11 ', '<          12']);
});

test('a zero-element array still leaves one empty element line (nine spaces)', () => {
  // `SATVIS2 … SBAS TRUE FALSE 0` in `b1`: the element line is `<` + nine spaces and, being the last
  // line of the record, carries no trailing space.
  const layout = counted([]);
  const lines = encodeAbbrevLines(frame(1, u32(7, 0)), layout, table(layout));
  assert.deepEqual(lines, [`${HEADER}`, '<     7 0 ', '<         ']);
  assert.equal(lines[2], `<${' '.repeat(9)}`, 'nine spaces, no value and no separator');
});

test('a FIXED_LENGTH_ARRAY keeps every element on the data line and prints no count', () => {
  const layout: EdieLayout = {
    name: 'TESTLOG',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      { name: 'a', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' },
      {
        name: 'fixed',
        kind: 'array',
        offset: 4,
        countSize: 0,
        fixedCount: 3,
        arrayKind: 'fixed',
        stride: 4,
        elements: [{ name: 'value', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' }],
      },
    ],
  };
  const lines = encodeAbbrevLines(frame(1, u32(1, 2, 3, 4)), layout, table(layout));
  assert.deepEqual(lines, [`${HEADER}`, '<     1 2 3 4']);
});

test('a VARIABLE_LENGTH_ARRAY prints its count and every element on the data line', () => {
  // `ITPSDFINAL`'s 1024 samples: one line, not 1024.
  const layout: EdieLayout = {
    name: 'TESTLOG',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      {
        name: 'samples',
        kind: 'array',
        offset: 0,
        countSize: 4,
        arrayKind: 'variable',
        stride: 4,
        elements: [{ name: 'sample', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' }],
      },
    ],
  };
  const lines = encodeAbbrevLines(frame(1, u32(3, 90, 91, 92)), layout, table(layout));
  assert.deepEqual(lines, [`${HEADER}`, '<     3 90 91 92']);
});

test('a second counted array starts a new data line, it does not join the last element line', () => {
  // `IPSTATUS` in b2, measured through the suite: `<     1 ` / `<          ETHA …` / `<     1 ` /
  // `<          "192.168.5.1"`.
  const layout: EdieLayout = {
    name: 'TESTLOG',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      {
        name: 'ips',
        kind: 'array',
        offset: 0,
        countSize: 4,
        arrayKind: 'field',
        stride: 4,
        elements: [{ name: 'ip', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' }],
      },
      {
        name: 'dns',
        kind: 'array',
        offset: 4,
        dynamicOffset: true,
        countSize: 4,
        arrayKind: 'field',
        stride: 4,
        elements: [{ name: 'ip', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' }],
      },
    ],
  };
  const lines = encodeAbbrevLines(frame(1, u32(1, 10, 2, 20, 21)), layout, table(layout));
  assert.deepEqual(lines, [`${HEADER}`, '<     1 ', '<          10 ', '<     2 ', '<          20 ', '<          21']);
});

test('%R prints the embedded record: its header as a value, its body behind it', () => {
  // `RXCONFIG` in b1: `<RXCONFIG …` / `<     ELEVATIONCUTOFF … ` / `<     GLONASS 5.0 0`.
  const inner: EdieLayout = {
    name: 'INNERLOG',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      { name: 'system', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' },
      { name: 'value', kind: 'scalar', offset: 4, size: 4, type: 'u32', format: '%u' },
    ],
  };
  const outer: EdieLayout = {
    name: 'TESTLOG',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      {
        name: 'embedded',
        kind: 'array',
        offset: 0,
        countSize: 0,
        arrayKind: 'variable',
        stride: 1,
        format: '%R',
        elements: [{ name: 'byte', kind: 'scalar', offset: 0, size: 1, type: 'u8', format: '%02x' }],
      },
    ],
  };
  // The inner record rides inside the outer payload as a complete SBF frame.
  const innerFrame = frame(1, u32(4, 5));
  const payload: number[] = [];
  for (const byte of innerFrame.bytes) payload.push(byte);
  const outerFrame = frame(2, payload);
  const lines = encodeAbbrevLines(outerFrame, outer, { enums: {}, messages: { 1: inner } });
  assert.equal(lines[0], '<TESTLOG USB 3 75.0 FINESTEERING 2442 463098.000 03801800 b1f6 14695');
  assert.equal(lines[1], '<     INNERLOG USB 3 75.0 FINESTEERING 2442 463098.000 03801800 b1f6 14695 ');
  assert.equal(lines[2], '<     4 5');
});

test('%P prints its count and one escaped token, as the suite does', () => {
  // A synthetic `PASSCOM1` through the suite: `<     8 a,b*\\\x0d\x0a\x9c`.
  const layout: EdieLayout = {
    name: 'PASSCOM1',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      {
        name: 'buffer',
        kind: 'array',
        offset: 0,
        countSize: 4,
        arrayKind: 'variable',
        stride: 1,
        format: '%P',
        elements: [{ name: 'buffer', kind: 'scalar', offset: 0, size: 1, type: 'char', format: '%P' }],
      },
    ],
  };
  const payload = [...u32(8), 0x61, 0x2c, 0x62, 0x2a, 0x5c, 0x0d, 0x0a, 0x9c];
  const lines = encodeAbbrevLines(frame(1, payload), layout, table(layout));
  assert.deepEqual(lines, [HEADER.replace('TESTLOG', 'PASSCOM1'), '<     8 a,b*\\\\\\x0d\\x0a\\x9c']);
});

test('the whole b1 ABBREV output is byte-identical to the suite\'s file', () => {
  // The strongest guard: everything at once — 1325 binary records (of which 22 RXCONFIG are dropped
  // for an unresolvable embedded message), 99 text records re-printed in the abbreviated shape, the
  // `%R` nesting, `ITPSDFINAL`'s 1024 samples, the zero-element SATVIS2 arrays.
  const tables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8')) as EdieTables;
  const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
  const golden = readFileSync(join(dir, 'golden-b1-20261101.ABBREV_ASCII'));
  const frames = new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b1-20261101.sbf'))));
  const text = abbrevTextLogLines(frames, tables);
  const lines: string[] = [];
  frames.forEach((f, index) => {
    const block = text.get(index);
    if (block !== undefined) {
      lines.push(...block);
      return;
    }
    if (f.kind !== 'sbf' || !f.crcOk) return;
    const layout = tables.messages[String(f.header.messageId)];
    if (!layout) return;
    lines.push(...encodeAbbrevLines(f, layout, tables));
  });
  const produced = Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1');
  assert.equal(produced.length, golden.length, 'byte count');
  assert.deepEqual(produced, golden, 'byte-identical');
});
