/**
 * `pack(4)` for every layout the table cannot otherwise place, verified one synthetic record at a
 * time: 15 fixed-size layouts whose dense size differs from the packed one, plus the counted-array
 * layouts where the element geometry is the question.
 *
 * The payload is a deterministic byte pattern (`(i * 37 + 11) & 0xff`) at the **packed** length, so
 * a reader that uses dense offsets prints different numbers — and a comparison against the suite's
 * own Convert is then a yes/no answer.
 *
 * The dense length is deliberately **not** swept: at that length the packed offsets point past the
 * end of the payload, and Convert reads whatever its heap holds there (it printed `3515780199` for a
 * field that does not exist). There is nothing to agree with — a receiver writes the packed length —
 * and reading past the payload is one behaviour we must not copy. `live-b3.test.ts` pins the part
 * that *is* defined: such a field reads 0.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { alignUp, packedStructSize, segmentAlignment, type EdieLayout, type EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { Payload, capture, frame, oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));

/** Dense size and `pack(4)` size of a layout, and where each member lands under both. */
function geometry(fields: readonly any[]): { dense: number; packed: number } | null {
  let dense = 0;
  let packed = 0;
  for (const segment of fields) {
    dense += segment.kind === 'array'
      ? (segment.countSize || 0) + (segment.fixedCount ?? 0) * segment.stride
      : segment.size;
    packed = alignUp(packed, segmentAlignment(segment));
    if (segment.kind === 'array') {
      if (segment.fixedCount === undefined) return null;
      const inner = packedStructSize(segment.elements);
      if (inner === null) return null;
      packed += (segment.countSize || 0) + segment.fixedCount * inner;
    } else packed += segment.size;
  }
  return { dense, packed };
}

const differing: number[] = [];
for (const [id, layout] of Object.entries(tables.messages)) {
  const sizes = geometry(layout.fields);
  if (sizes && sizes.packed !== sizes.dense) differing.push(Number(id));
}
console.log(`fixed layouts whose packed size differs from the dense one: ${differing.length} → ${differing.join(', ')}`);

function pattern(length: number, layout: EdieLayout): Uint8Array {
  const out = new Payload(length);
  for (let i = 0; i < length; i++) out.u8(i, (i * 37 + 11) & 0xff);
  // A patterned payload has no NUL anywhere, and a `variable` string then runs to the end of the
  // buffer — which Convert reads past, into the frame's four CRC bytes. That is not a record any
  // receiver writes, so each variable string gets a three-character text: the shift rule is still
  // exercised (`a string of 3 chars takes 4 bytes, not `arrayLength`), and the string terminates.
  let cursor = 0;
  for (const segment of layout.fields) {
    cursor = alignUp(cursor, segmentAlignment(segment));
    if (segment.kind === 'string' && segment.variable) {
      for (let i = 0; i < 4 && cursor + i < length; i++) out.u8(cursor + i, i === 3 ? 0 : 0x61 + i);
    }
    const size = segment.kind === 'array'
      ? (segment.countSize || 0) + (segment.fixedCount ?? 0) * packedStructSize(segment.elements)!
      : segment.size;
    cursor += size;
  }
  return out.bytes;
}

function ours(input: Uint8Array): { ascii: string; abbrev: string } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const one = (format: 'ASCII' | 'ABBREV_ASCII'): string =>
    convertFrames(frames, { format, at, tables, name: 'probe.sbf' }).files[0]?.text ?? '';
  return { ascii: one('ASCII'), abbrev: one('ABBREV_ASCII') };
}

let failures = 0;
for (const id of differing) {
  const layout = tables.messages[String(id)] as EdieLayout;
  const sizes = geometry(layout.fields)!;
  const input = capture(frame(id, pattern(sizes.packed, layout), { sequence: 1 }));
  const expected = oracle(input, `sweep${id}`);
  const expectedAscii = `${expected.ascii.join('\r\n')}${expected.ascii.length ? '\r\n' : ''}`;
  const expectedAbbrev = `${expected.abbrev.join('\r\n')}${expected.abbrev.length ? '\r\n' : ''}`;
  const actual = ours(input);
  const okAscii = expectedAscii === actual.ascii;
  const okAbbrev = expectedAbbrev === actual.abbrev;
  console.log(`${okAscii && okAbbrev ? 'OK  ' : 'FAIL'} ${String(layout.name).padEnd(18)} packed len=${String(sizes.packed).padEnd(4)} (dense ${sizes.dense})`);
  if (!okAscii) {
    failures += 1;
    console.log(`     oracle ${JSON.stringify(expectedAscii.slice(0, 500))}`);
    console.log(`     ours   ${JSON.stringify(actual.ascii.slice(0, 500))}`);
  }
  if (!okAbbrev) {
    failures += 1;
    console.log(`     oracle ${JSON.stringify(expectedAbbrev.slice(0, 500))}`);
    console.log(`     ours   ${JSON.stringify(actual.abbrev.slice(0, 500))}`);
  }
}
console.log(failures === 0 ? '\nevery differing layout reads as pack(4), byte for byte' : `\n${failures} mismatch(es)`);
process.exitCode = failures === 0 ? 0 : 1;

