/**
 * Element `stride` for the four counted-array logs that no capture contains
 * (`SBAS17` 30→32, `ETHSTATUS` 26→28, `SAVEDSURVEYPOSITIONS` 29→32, `WIFINETLIST` 63→68).
 *
 * Every sample of these four the receiver ever produced had `count = 1` (ETHSTATUS: 15 of them, all
 * 32 bytes, byte-identical), and with one element the packed element size and "dense size + 2 spare
 * bytes" cannot be told apart. So: build a **count = 2** frame, put a different value in each element
 * at a **known** offset, and ask the suite's own Convert where it reads the second one.
 *
 * Two hypotheses are built and both are converted, so the answer is visible without trusting our own
 * reader:
 *
 *   packed   members at `pack(4)` offsets inside the element, elements `packedStructSize` apart
 *   dense    members at the dictionary's dense offsets, elements still one packed struct apart
 *
 * Values encode their own field (`1000 * element + 10 * member + 1`), so the line says which
 * hypothesis the suite used: a dense read of SBAS17's `x` lands two bytes early and prints a number
 * that is none of the injected ones.
 *
 *   node 逆向/tools/oracle-stride.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import {
  alignUp,
  packedStructSize,
  segmentAlignment,
  type EdieArray,
  type EdieLayout,
  type EdieSegment,
  type EdieTables,
} from '../04_重实现/packages/protocol/src/edie.ts';
import { Payload, frame, oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

const NAMES = ['SBAS17', 'ETHSTATUS', 'SAVEDSURVEYPOSITIONS', 'WIFINETLIST'] as const;

function layoutOf(name: string): { id: string; layout: EdieLayout } {
  for (const [id, layout] of Object.entries(tables.messages)) {
    if (layout.name === name) return { id, layout };
  }
  throw new Error(`no layout ${name}`);
}

function writeScalar(out: Payload, segment: EdieSegment, at: number, value: number): void {
  if (segment.kind !== 'scalar') throw new Error('not a scalar');
  switch (segment.type) {
    case 'u8': case 'char': case 'hexbyte': out.u8(at, value & 0xff); break;
    case 'u16': case 'ushort': out.u16(at, value & 0xffff); break;
    case 'short': out.u16(at, value & 0xffff); break;
    case 'f32': out.f32(at, value); break;
    case 'f64': out.f64(at, value); break;
    default: out.u32(at, value >>> 0); break;
  }
}

/** Short text per element so a content-driven walk and a fixed struct walk disagree. */
function textFor(element: number, index: number): string {
  return `${String.fromCharCode(0x61 + index)}${element}`;
}

/**
 * Lay one element out. `packed` puts members at `pack(4)` offsets, `dense` at the dictionary's.
 * Returns the bytes written, always `packedStructSize(elements)` long.
 */
function elementBytes(elements: readonly EdieSegment[], element: number, mode: 'packed' | 'dense'): Uint8Array {
  const stride = packedStructSize(elements);
  if (stride === null) throw new Error('variable element');
  const out = new Payload(stride);
  let cursor = 0;
  elements.forEach((segment, index) => {
    const at = mode === 'packed' ? (cursor = alignUp(cursor, segmentAlignment(segment))) : segment.offset;
    if (segment.kind === 'string') {
      const text = textFor(element, index);
      out.ascii(at, text);
      out.u8(at + text.length, 0);
    } else if (segment.kind === 'scalar') {
      writeScalar(out, segment, at, 1000 * (element + 1) + 10 * (index + 1) + 1);
    } else {
      throw new Error('nested array in element');
    }
    cursor = at + segment.size;
  });
  return out.bytes;
}

function payloadFor(layout: EdieLayout, count: number, mode: 'packed' | 'dense'): Uint8Array {
  const array = layout.fields.find((segment): segment is EdieArray => segment.kind === 'array');
  if (!array) throw new Error('no array');
  const stride = packedStructSize(array.elements);
  if (stride === null) throw new Error('variable element');
  const index = layout.fields.indexOf(array);
  const head = layout.fields.slice(0, index);
  const tail = layout.fields.slice(index + 1);
  let end = array.offset + array.countSize + count * stride;
  for (const segment of tail) end = alignUp(end, segmentAlignment(segment)) + segment.size;
  const out = new Payload(end);
  // The members in front of the array, packed like the rest.
  let cursor = 0;
  for (const segment of head) {
    cursor = alignUp(cursor, segmentAlignment(segment));
    if (segment.kind === 'scalar') writeScalar(out, segment, cursor, 0x51ab);
    cursor += segment.size;
  }
  out.u32(array.offset, count);
  for (let element = 0; element < count; element += 1) {
    out.bytes.set(elementBytes(array.elements, element, mode), array.offset + array.countSize + element * stride);
  }
  cursor = array.offset + array.countSize + count * stride;
  for (const segment of tail) {
    cursor = alignUp(cursor, segmentAlignment(segment));
    if (segment.kind === 'scalar') writeScalar(out, segment, cursor, 0x51ab);
    cursor += segment.size;
  }
  return out.bytes;
}

function ours(input: Uint8Array): { ascii: string[]; abbrev: string[] } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const one = (format: 'ASCII' | 'ABBREV_ASCII'): string[] => {
    const text = convertFrames(frames, { format, at, tables, name: 'probe.sbf' }).files[0]?.text ?? '';
    return text.split('\r\n').filter(Boolean);
  };
  return { ascii: one('ASCII'), abbrev: one('ABBREV_ASCII') };
}

for (const name of NAMES) {
  const { id, layout } = layoutOf(name);
  const array = layout.fields.find((segment): segment is EdieArray => segment.kind === 'array')!;
  const stride = packedStructSize(array.elements)!;
  const dense = array.stride;
  console.log(`\n=== ${name} id=${id} dense element=${dense} packed element=${stride}`);
  for (const mode of ['packed', 'dense'] as const) {
    const payload = payloadFor(layout, 2, mode);
    const input = frame(Number(id), payload);
    const result = oracle(input, `stride-${name}-${mode}`);
    const mine = ours(input);
    console.log(`  -- payload laid out ${mode} (${payload.length} B)`);
    console.log(`     suite  ${result.ascii.map((line) => JSON.stringify(line)).join('\n            ')}`);
    console.log(`     ours   ${mine.ascii.map((line) => JSON.stringify(line)).join('\n            ')}`);
    console.log(`     same   ${result.ascii.join('\r\n') === mine.ascii.join('\r\n') ? 'YES' : 'no'}`);
    console.log(`     suiteABBREV ${result.abbrev.map((line) => JSON.stringify(line)).join('\n                  ')}`);
    console.log(`     oursABBREV  ${mine.abbrev.map((line) => JSON.stringify(line)).join('\n                  ')}`);
  }
}
