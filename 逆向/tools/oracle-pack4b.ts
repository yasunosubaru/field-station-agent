/**
 * Probe 1b/2b: where the bytes after a counted array start when the array is **not** a multiple of
 * four, and what a `%Z` array prints for 0, 1 and 3 elements.
 *
 * Three records, each chosen so the packed and dense models print different numbers:
 *
 *  - `USERI2CREAD` with **257** one-byte registers: the array is 8..264, so the next `u32` is at 268
 *    when it is aligned (`pack(4)`) and at 265 when it is not. Both u32s carry values that cannot be
 *    confused (`7` at 268, `0x1234` at 272); the dense model reads `0x07000000` / `0x12340000`;
 *  - `USERCANDATA` with **3** received bytes: array 16..18, then `transaction_id` at 20 (packed) or
 *    19 (dense), `frame_index` four bytes later;
 *  - `USERI2CREAD` with **0** registers: the post-array fields are then already 4-aligned, and the
 *    only question is what a zero-length `%Z` array prints.
 */

import { Payload, capture, frame, oracle, show } from './oracle.ts';

/** `USERI2CREAD`: count at 4, `registers` bytes at 8, then two u32 at `post`/`post + 4`. */
function userI2cRead(registers: Uint8Array, post: number, sequence: number): Uint8Array {
  const payload = new Payload(post + 8);
  payload.u8(0, 0x42);
  payload.u32(4, registers.length);
  payload.bytes.set(registers, 8);
  payload.u32(post, 0x00000007);
  payload.u32(post + 4, 0x00001234);
  return frame(2232, payload.bytes, { sequence });
}

/** `USERCANDATA`: count at 12, `data` bytes at 16, then two u32 at `post`/`post + 4`. */
function userCanData(data: Uint8Array, post: number): Uint8Array {
  const payload = new Payload(post + 8);
  payload.u32(0, 3);      // port
  payload.u32(4, 0);      // message_type
  payload.u32(8, 0x123);  // message_id
  payload.u32(12, data.length);
  payload.bytes.set(data, 16);
  payload.u32(post, 0x00000055);     // transaction_id
  payload.u32(post + 4, 0x00000066); // frame_index
  return frame(2316, payload.bytes, { sequence: 2 });
}

const registers = Uint8Array.from({ length: 257 }, (_, i) => 0xa0 + (i & 0x0f));
const canData = Uint8Array.from([0xde, 0xad, 0xbe]);

const result = oracle(
  capture(
    userI2cRead(registers, 268, 1),   // 8 + 257 = 265 → aligned 268
    userI2cRead(new Uint8Array(0), 8, 3),
    userCanData(canData, 20),         // 16 + 3 = 19 → aligned 20
  ),
  'pack4b',
);
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
