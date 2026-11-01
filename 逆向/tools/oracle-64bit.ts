/**
 * Probe 3: `ULONG64` / `LONGLONG` width and format.
 *
 * `FILESYSTEMCAPACITY` (2137) is a log a receiver refuses to send on request but Convert will
 * happily render (it is a plain dictionary entry), which makes it the cleanest `%llu` oracle:
 *
 *   count u32 | { file_system_type enum(4), capacity u64, used_capacity u64 } × n   (stride 20)
 *
 * `INSPVACMP` (1889) carries the signed counterpart `%lld`, plus a fixed `pack(4)` layout
 * (dense 44 → packed 48), so it answers both questions at once.
 */

import { Payload, capture, frame, oracle, show } from './oracle.ts';

const ULONGS: bigint[] = [
  0n,
  1n,
  4294967296n,          // 2^32 — past a u32
  9007199254740993n,    // 2^53 + 1 — the first value a double cannot hold
  18446744073709551615n, // 2^64 - 1
];

function fileSystemCapacity(): Uint8Array {
  const payload = new Payload(4 + ULONGS.length * 20);
  payload.u32(0, ULONGS.length);
  ULONGS.forEach((value, index) => {
    const at = 4 + index * 20;
    payload.u32(at, index + 1);          // file_system_type (enum)
    payload.u64(at + 4, value);          // capacity
    payload.u64(at + 12, value + 1n);    // used_capacity
  });
  return frame(2137, payload.bytes, { sequence: 1 });
}

const LONG_LATITUDES: bigint[] = [
  0n,
  -1n,
  -9007199254740993n,
  -9223372036854775808n, // -2^63
];

function inspvaCmp(latitude: bigint, sequence: number): Uint8Array {
  // packed offsets: 0 week_ms, 4 status, 5 gnss_type, 8 latitude (f64-align → 8), 16 longitude,
  // 24 height (i32), 28 north_vel, 30 east_vel, 32 up_vel, 34 roll, 36 pitch, 38 azimuth,
  // 40 azimuth_rate, 44 milliseconds.
  const payload = new Payload(48);
  payload.u32(0, 0);
  payload.u8(4, 0);
  payload.u8(5, 0);
  payload.i64(8, latitude);
  payload.i64(16, 1n);
  payload.u32(24, 0xfffffffe); // height = -2
  payload.u32(44, 1234);
  return frame(1889, payload.bytes, { sequence });
}

const result = oracle(
  capture(fileSystemCapacity(), ...LONG_LATITUDES.map((v, i) => inspvaCmp(v, i + 2))),
  'wide',
);
show('oracle ASCII', result.ascii);
show('oracle ABBREV', result.abbrev);
