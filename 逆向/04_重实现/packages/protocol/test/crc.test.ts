import test from 'node:test';
import assert from 'node:assert/strict';

import { novatelCrc32, crcHex, appendCrcLe, readCrcLe } from '../src/crc.ts';

// Both vectors are printed in the OEM7 Commands and Logs Reference Manual, section 1.10.
const ASCII_VECTOR =
  'BESTPOSA,COM1,0,78.0,FINESTEERING,1427,325298.000,00000000,6145,2748;SOL_COMPUTED,SINGLE,' +
  '51.11678928753,-114.03886216575,1064.3470,-16.2708,WGS84,2.3434,1.3043,4.7300,"",0.000,0.000,7,7,0,0,0,06,0,03';

const BINARY_VECTOR = Uint8Array.from([
  0xaa, 0x44, 0x12, 0x1c, 0x2a, 0x00, 0x02, 0x20, 0x48, 0x00, 0x00, 0x00, 0x90, 0xb4, 0x93, 0x05,
  0xb0, 0xab, 0xb9, 0x12, 0x00, 0x00, 0x00, 0x00, 0x45, 0x61, 0xbc, 0x0a, 0x00, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00, 0x1b, 0x04, 0x50, 0xb3, 0xf2, 0x8e, 0x49, 0x40, 0x16, 0xfa, 0x6b, 0xbe,
  0x7c, 0x82, 0x5c, 0xc0, 0x00, 0x60, 0x76, 0x9f, 0x44, 0x9f, 0x90, 0x40, 0xa6, 0x2a, 0x82, 0xc1,
  0x3d, 0x00, 0x00, 0x00, 0x12, 0x5a, 0xcb, 0x3f, 0xcd, 0x9e, 0x98, 0x3f, 0xdb, 0x66, 0x40, 0x40,
  0x00, 0x30, 0x30, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0x0b, 0x00, 0x00,
  0x00, 0x06, 0x00, 0x03,
]);

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

test('ASCII vector from the reference manual', () => {
  assert.equal(ASCII_VECTOR.length, 199);
  assert.equal(crcHex(novatelCrc32(latin1(ASCII_VECTOR))), '9c9a92bb');
});

test('binary vector from the reference manual (bytes 42 DC 4C 48)', () => {
  assert.equal(BINARY_VECTOR.length, 100);
  const crc = novatelCrc32(BINARY_VECTOR);
  // The manual prints the byte order, so the numeric u32 value is the byte-reversed form.
  assert.equal(crc, 0x484cdc42);
  assert.deepEqual([...appendCrcLe(BINARY_VECTOR).subarray(-4)], [0x42, 0xdc, 0x4c, 0x48]);
});

test('crcHex left-pads to eight digits', () => {
  assert.equal(crcHex(0), '00000000');
  assert.equal(crcHex(0x0abc), '00000abc');
  assert.equal(crcHex(0xdeadbeef), 'deadbeef');
});

test('appendCrcLe round-trips through readCrcLe', () => {
  const body = latin1('LOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;thisport,bestposb,ontime,1');
  const framed = appendCrcLe(body);
  assert.equal(framed.length, body.length + 4);
  assert.equal(readCrcLe(framed, body.length), novatelCrc32(body));
});
