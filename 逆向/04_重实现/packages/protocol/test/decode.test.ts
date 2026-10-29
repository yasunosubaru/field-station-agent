import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeFields, readVariableString, findSpec, type ParserTables } from '../src/decode.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: ParserTables = JSON.parse(
  readFileSync(join(here, '..', 'data', 'parser-tables.json'), 'utf8'),
);

test('the extracted table set covers the main status logs', () => {
  for (const name of ['bestposJSON', 'bestvelJSON', 'versionJSON', 'hwMonitorJSON']) {
    assert.ok(tables.tables[name], 'missing table ' + name);
  }
  assert.ok(Object.keys(tables.tables).length >= 100);
});

test('BESTPOS fields decode at their documented payload offsets', () => {
  const spec = findSpec(tables, 'bestposJSON');
  const payload = new Uint8Array(104);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 0, true); // solutionStatus SOL_COMPUTED
  dv.setUint32(4, 16, true); // positionType SINGLE
  dv.setFloat64(8, 51.11678928753, true); // latitude
  dv.setFloat64(16, -114.03886216575, true); // longitude
  dv.setFloat64(24, 1064.347, true); // height
  dv.setFloat32(32, -16.2708, true); // undulation
  dv.setUint32(36, 61, true); // datumId WGS84
  dv.setUint8(64, 12); // satellitesTracked
  dv.setUint8(65, 9); // satellitesUsed
  payload.set([0x41, 0x42, 0x00, 0x00], 52); // stationId "AB"

  const out = decodeFields(payload, spec);
  assert.equal(out.solutionStatus, 0);
  assert.equal(out.positionType, 16);
  assert.ok(Math.abs((out.latitude as number) - 51.11678928753) < 1e-9);
  assert.ok(Math.abs((out.longitude as number) - -114.03886216575) < 1e-9);
  assert.ok(Math.abs((out.undulation as number) - -16.2708) < 1e-4);
  assert.equal(out.datumId, 61);
  assert.equal(out.stationId, 'AB');
  assert.equal(out.satellitesTracked, 12);
  assert.equal(out.satellitesUsed, 9);
});

test('SHORT decodes as unsigned, despite the name', () => {
  const payload = new Uint8Array([0xff, 0xff]);
  const out = decodeFields(payload, { prn: ['SHORT', 0] });
  assert.equal(out.prn, 65535);
});

test('INT_32 is signed', () => {
  const payload = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  assert.equal(decodeFields(payload, { v: ['INT_32', 0] }).v, -1);
  assert.equal(decodeFields(payload, { v: ['UINT_32', 0] }).v, 4294967295);
});

test('a field past the end of the buffer decodes as 0 instead of throwing', () => {
  const out = decodeFields(new Uint8Array(4), { tall: ['DOUBLE', 64] });
  assert.equal(out.tall, 0);
});

test('fixed strings drop NUL padding', () => {
  const payload = new Uint8Array(8);
  payload.set([0x41, 0x42, 0x43], 0);
  assert.equal(decodeFields(payload, { s: ['STRING_8', 0] }).s, 'ABC');
});

test('variable strings return the next field offset', () => {
  // Non-multiple-of-4 length: "ABC\0" already sits on a 4-byte boundary, so the next field
  // starts right after it (the original only advances a whole extra word when already aligned).
  const a = new DataView(Uint8Array.from([0x41, 0x42, 0x43, 0x00, 0x99, 0x99, 0x99, 0x99]).buffer);
  assert.deepEqual(readVariableString(a, 0), { value: 'ABC', offset: 4 });

  // Length already a multiple of 4: pad to the next boundary and then add one more word.
  const b = new DataView(Uint8Array.from([0x41, 0x42, 0x43, 0x44, 0x00, 0, 0, 0, 0x99]).buffer);
  assert.deepEqual(readVariableString(b, 0), { value: 'ABCD', offset: 8 });
});

test('ULONG64 becomes a decimal string', () => {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, 1234567890123456789n, true);
  assert.equal(decodeFields(payload, { big: ['ULONG64', 0] }).big, '1234567890123456789');
});

test('a transform hook can apply per-field scaling', () => {
  const payload = new Uint8Array([0x10, 0, 0, 0]);
  const out = decodeFields(payload, { v: ['ENUM', 0] }, {
    transform: (field, raw) => (field === 'v' ? (raw as number) * 0.0005 : raw),
  });
  assert.equal(out.v, 16 * 0.0005);
});
