/**
 * `pc_cs` — the counted array at the end of `ANTENNATYPE` (#2281) and `USERANTENNA` (#2282).
 *
 * Both layouts end with `pc_cs[] { frequency (enum), pco[3] (f32), pcv[19] (f32) }`:
 *
 *   frequency  off 0   4 B
 *   pco        off 4  12 B  (ends 16)
 *   pcv        off 16 76 B  (ends 92)
 *
 * The dictionary's own `stride` for this array is **16** (its `arrayLength` metadata), while summing
 * the members gives **92**. No capture carries either log (they only report a configured antenna),
 * so the dictionary stride was the only evidence there was, and §9.x.18 called the 92-byte reading
 * an unbacked guess. `逆向/tools/oracle-pc-cs.ts` settles it with synthetic `count = 1` and `count = 2`
 * frames whose members read `1000 * (element + 1) + 10 * member`:
 *
 *  - element 1 starts at `28 + 92` (ANTENNATYPE) / `24 + 92` (USERANTENNA), not at `+16`;
 *  - `pco` is read at +4 and `pcv` at +16, so the last `pcv` (member 22) sits at +88;
 *  - four sentinel bytes behind the last element change nothing — `pc_cs` is the final field.
 *
 * Every literal below is that probe's suite output (exit code 0 = all six cases byte-identical to
 * ours), including the ABBREV blocks: the two fixed arrays stay on the element's line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { appendCrcLe } from '../src/crc.ts';
import { buildLongHeader } from '../src/header.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { encodeAbbrevLines } from '../src/abbrev-log.ts';
import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import {
  packedStructSize,
  walkArray,
  wireElementSegments,
  type EdieArray,
  type EdieTables,
} from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const HEADER = 'COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278';

function frameOf(messageId: number, payload: Uint8Array): SbfFrame {
  const head = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    portAddress: 32, // COM1
    sequence: 1,
    idleTimeRaw: 0,
    timeStatus: 180, // FINESTEERING
    week: 2402,
    milliseconds: 577759000,
    receiverStatus: 0x03800800,
    reserved: 0xcdba,
    softwareVersion: 18278,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return new SbfDeframer({ crcMode: 'validate' }).push(appendCrcLe(body))[0] as SbfFrame;
}

const ascii = (id: number, payload: Uint8Array): string =>
  encodeAsciiLog(frameOf(id, payload), tables.messages[String(id)]!, tables);
const abbrev = (id: number, payload: Uint8Array): string[] =>
  encodeAbbrevLines(frameOf(id, payload), tables.messages[String(id)]!, tables);

class Words {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u32(at: number, value: number): this { this.view.setUint32(at, value, true); return this; }
  f32(at: number, value: number): this { this.view.setFloat32(at, value, true); return this; }
  ascii(at: number, text: string): this {
    for (let i = 0; i < text.length; i += 1) this.view.setUint8(at + i, text.charCodeAt(i) & 0xff);
    return this;
  }
}

/** `pack(4)` struct size of one `pc_cs` element: 4 + 3 * 4 + 19 * 4. */
const ELEMENT = 92;

/** The members of one element, `1000 * (element + 1) + 10 * member`. */
function members(element: number): number[] {
  return Array.from({ length: 22 }, (_, index) => 1000 * (element + 1) + 10 * (index + 1));
}

function pcCs(base: number, count: number, tail: boolean): Words {
  const out = new Words(base + 4 + count * ELEMENT + (tail ? 4 : 0));
  out.u32(base, count);
  for (let element = 0; element < count; element += 1) {
    const at = base + 4 + element * ELEMENT;
    const value = members(element);
    out.u32(at, element); // Frequency: 0 = GPSL1, 1 = GPSL2
    for (let member = 0; member < 3; member += 1) out.f32(at + 4 + member * 4, value[member]!);
    for (let member = 3; member < 22; member += 1) out.f32(at + 16 + (member - 3) * 4, value[member]!);
  }
  if (tail) out.u32(base + 4 + count * ELEMENT, 0x51ab);
  return out;
}

/** ANTENNATYPE: manage_user_defined_antenna, antenna, antenna_name(16), pc_cs[]. */
function antennaType(count: number, tail = false): Uint8Array {
  const out = pcCs(24, count, tail);
  out.u32(0, 0); // ManageUserDefinedAntenna: ADD
  out.u32(4, 1); // AntennaModel: USER
  out.ascii(8, 'ANTENNA-ONE');
  return out.bytes;
}

/** USERANTENNA: antenna, antenna_name(16), pc_cs[]. */
function userAntenna(count: number, tail = false): Uint8Array {
  const out = pcCs(20, count, tail);
  out.u32(0, 1); // AntennaModel: USER
  out.ascii(4, 'USER-ANT-ONE');
  return out.bytes;
}

const arrayOf = (id: number): EdieArray =>
  tables.messages[String(id)]!.fields.find((segment): segment is EdieArray => segment.kind === 'array')!;

test('pc_cs: the dictionary says 16, the member sizes say 92', () => {
  for (const id of [2281, 2282]) {
    const array = arrayOf(id);
    assert.equal(array.stride, 16, 'the table still carries its `arrayLength` stride');
    assert.equal(packedStructSize(array.elements), 92);
    assert.deepEqual(
      wireElementSegments(array.elements).map((segment) => [segment.name, segment.offset]),
      [['frequency', 0], ['pco', 4], ['pcv', 16]],
    );
  }
});

test('pc_cs: elements are 92 bytes apart, the first one behind the count', () => {
  assert.deepEqual(walkArray(antennaType(1), arrayOf(2281), 24).starts, [28]);
  assert.deepEqual(walkArray(antennaType(2), arrayOf(2281), 24).starts, [28, 120]);
  assert.deepEqual(walkArray(userAntenna(1), arrayOf(2282), 20).starts, [24]);
  assert.deepEqual(walkArray(userAntenna(2), arrayOf(2282), 20).starts, [24, 116]);
});

test('ANTENNATYPE: one and two pc_cs elements, as the suite prints them', () => {
  assert.equal(
    ascii(2281, antennaType(1)),
    `#ANTENNATYPEA,${HEADER};ADD,USER,"ANTENNA-ONE",1,GPSL1,1010.00,1020.00,1030.00,1040.00,`
    + '1050.00,1060.00,1070.00,1080.00,1090.00,1100.00,1110.00,1120.00,1130.00,1140.00,1150.00,'
    + '1160.00,1170.00,1180.00,1190.00,1200.00,1210.00,1220.00*3b98918c',
  );
  assert.equal(
    ascii(2281, antennaType(2)),
    `#ANTENNATYPEA,${HEADER};ADD,USER,"ANTENNA-ONE",2,GPSL1,1010.00,1020.00,1030.00,1040.00,`
    + '1050.00,1060.00,1070.00,1080.00,1090.00,1100.00,1110.00,1120.00,1130.00,1140.00,1150.00,'
    + '1160.00,1170.00,1180.00,1190.00,1200.00,1210.00,1220.00,GPSL2,2010.00,2020.00,2030.00,'
    + '2040.00,2050.00,2060.00,2070.00,2080.00,2090.00,2100.00,2110.00,2120.00,2130.00,2140.00,'
    + '2150.00,2160.00,2170.00,2180.00,2190.00,2200.00,2210.00,2220.00*4a613aef',
  );
});

test('ANTENNATYPE: the ABBREV block keeps both fixed arrays on the element line', () => {
  assert.deepEqual(abbrev(2281, antennaType(2)), [
    `<ANTENNATYPE ${HEADER.replace(/,/g, ' ')}`,
    '<     ADD USER "ANTENNA-ONE" 2 ',
    '<          GPSL1 1010.00 1020.00 1030.00 1040.00 1050.00 1060.00 1070.00 1080.00 1090.00 '
    + '1100.00 1110.00 1120.00 1130.00 1140.00 1150.00 1160.00 1170.00 1180.00 1190.00 1200.00 '
    + '1210.00 1220.00 ',
    '<          GPSL2 2010.00 2020.00 2030.00 2040.00 2050.00 2060.00 2070.00 2080.00 2090.00 '
    + '2100.00 2110.00 2120.00 2130.00 2140.00 2150.00 2160.00 2170.00 2180.00 2190.00 2200.00 '
    + '2210.00 2220.00',
  ]);
});

test('USERANTENNA: one and two pc_cs elements, as the suite prints them', () => {
  assert.equal(
    ascii(2282, userAntenna(1)),
    `#USERANTENNAA,${HEADER};USER,"USER-ANT-ONE",1,GPSL1,1010.00,1020.00,1030.00,1040.00,`
    + '1050.00,1060.00,1070.00,1080.00,1090.00,1100.00,1110.00,1120.00,1130.00,1140.00,1150.00,'
    + '1160.00,1170.00,1180.00,1190.00,1200.00,1210.00,1220.00*409aa1b3',
  );
  assert.equal(
    ascii(2282, userAntenna(2)),
    `#USERANTENNAA,${HEADER};USER,"USER-ANT-ONE",2,GPSL1,1010.00,1020.00,1030.00,1040.00,`
    + '1050.00,1060.00,1070.00,1080.00,1090.00,1100.00,1110.00,1120.00,1130.00,1140.00,1150.00,'
    + '1160.00,1170.00,1180.00,1190.00,1200.00,1210.00,1220.00,GPSL2,2010.00,2020.00,2030.00,'
    + '2040.00,2050.00,2060.00,2070.00,2080.00,2090.00,2100.00,2110.00,2120.00,2130.00,2140.00,'
    + '2150.00,2160.00,2170.00,2180.00,2190.00,2200.00,2210.00,2220.00*c83da631',
  );
});

test('pc_cs: four bytes behind the last element change nothing', () => {
  for (const [id, build] of [[2281, antennaType], [2282, userAntenna]] as const) {
    assert.equal(ascii(id, build(2, true)), ascii(id, build(2, false)));
    assert.deepEqual(abbrev(id, build(2, true)), abbrev(id, build(2, false)));
  }
});
