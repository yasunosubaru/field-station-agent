/**
 * Probe 1/2: `pack(4)` alignment for a counted array, and the `%Z` variable-length array token.
 *
 * `USERI2CREAD` (2232) is the smallest layout where both questions meet:
 *
 *   dense (what `edie-layouts.json` stores)   wire (what the suite reads)
 *   0  slave_device_address  u8   1 B          0  slave_device_address   u8  1 B
 *   1  slave_register_address:                 (1..3 pad)
 *        count  u32  4 B                       4  count                 u32 4 B
 *        elem   u8   n B                       8  elements              n B
 *   5  request_length  u32  5..8              align(n)  request_length  u32 4 B
 *   9  transaction_id  u32  9..12             +4        transaction_id  u32 4 B
 *
 * The two models cannot both be fed the same bytes, so the payload is chosen to make each model
 * print a *different, self-evident* number:
 *
 *  - the count byte at offset 4 is the LSB of the packed count and the MSB of the dense one, so a
 *    layout that puts the count at 1 can only ever read 0 there when the packed count is nonzero.
 *    We therefore use a packed count of **256** (`00 01 00 00` at 4..7 → 256, and dense `00 00 00 00`
 *    at 1..4 → 0) and a payload where 256 one-byte elements really exist;
 *  - `request_length` and `transaction_id` then land at 264 and 268 under the packed model, and at
 *    5 and 9 under the dense one.
 */

import { Payload, capture, frame, oracle, show } from './oracle.ts';

const COUNT = 256;

function userI2cRead(): Uint8Array {
  const payload = new Payload(8 + COUNT + 4 + 4);
  payload.u8(0, 0x42);          // slave_device_address
  // 1..3 padding, and byte 4 must be 0 so the *dense* count reads 0 (see the note above).
  payload.u32(4, COUNT);        // count: 00 01 00 00 → 256 packed, 0 dense
  for (let i = 0; i < COUNT; i++) payload.u8(8 + i, i & 0xff); // 00 01 02 … ff 00 01 …
  payload.u32(8 + COUNT, 2);            // request_length   (264 packed / 1 dense)
  payload.u32(12 + COUNT, 0x11223344);  // transaction_id   (268 packed)
  return frame(2232, payload.bytes);
}

const result = oracle(capture(userI2cRead()), 'pack4');
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
console.log(`ascii bytes ${result.asciiBytes.length}, abbrev bytes ${result.abbrevBytes.length}`);
