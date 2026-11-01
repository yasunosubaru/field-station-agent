/**
 * `make-heading-capture.ts` — write the synthetic capture the `Heading & Attitude` charts are tested
 * against.
 *
 * **No receiver was involved.** This machine has `ANTENNA=SINGLE`, no IMU and no ALIGN/INS
 * authorisation, so no capture with an INS solution exists here and no original `Azimuth.csv` /
 * `Roll and Pitch.csv` / `SPAN Filter Updates.csv` could be produced to compare against. What this
 * file writes is a hand-laid SBF stream whose payloads follow `packages/protocol/data/edie-layouts.json`
 * (the same dictionary `packages/protocol` decodes with), sealed with the real CRC via
 * `逆向/tools/oracle.ts`'s `frame()`. Every value is chosen to be recognisable, so a wrong column
 * mapping is visible at a glance instead of plausible:
 *
 *   INSPVAX  #1465  6 frames @1 Hz, week 2442 from 470000.000 s
 *                   roll     1.5, 2.5, 3.5, 4.5, 5.5, 6.5   (°)
 *                   pitch   -0.75, -1.75, … -5.75         (°)
 *                   azimuth 100.125, 101.125, … 105.125   (°)
 *                   extended_sol_stat: bit 0 on every frame (Position update),
 *                                      bit 4 on frames 2–3 (ALIGN (heading) update),
 *                                      bit 25 on frames 4–6 (Alignment direction verified)
 *   HEADING2 #1335  3 frames, heading 45.0 / 46.0 / 47.0  (°) — a decoy: Graph's per-chart log
 *                   priority table does not list 1335, so it must NOT reach the HA charts.
 *   DUALANTENNAALIGN #1761 (a text command) — the second decoy, same reasoning.
 *
 * Usage (from `逆向/04_重实现`):
 *
 *   node packages/graph/tools/make-heading-capture.ts --out ../00_来源/samples/graph/synthetic/heading.sbf
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Payload, capture, frame } from '../../../../tools/oracle.ts';

const WEEK = 2442;
const BASE_SECONDS = 470_000;

/** INSPVAX (`edie-layouts.json` #1465): roll @60, pitch @68, azimuth @76, extended_sol_stat @120. */
function inspvax(index: number, bits: number): Uint8Array {
  const payload = new Payload(128);
  payload.u32(0, 0); // ins_solution_status: INS_SOLUTION_GOOD
  payload.u32(4, 56); // position_type: INS_RTKFIXED (not charted here, just plausible)
  payload.f64(8, 30.539975); // latitude
  payload.f64(16, 114.352811); // longitude
  payload.f64(24, 65.93111); // orthometric height
  payload.f32(32, -8.5); // undulation
  payload.f64(36, 0.01 * index); // north velocity
  payload.f64(44, 0.02 * index); // east velocity
  payload.f64(52, 0); // up velocity
  payload.f64(60, 1.5 + index); // roll
  payload.f64(68, -0.75 - index); // pitch
  payload.f64(76, 100.125 + index); // azimuth
  payload.f32(84, 0.5);
  payload.f32(88, 0.5);
  payload.f32(92, 0.9);
  payload.f32(96, 0.01);
  payload.f32(100, 0.01);
  payload.f32(104, 0.02);
  payload.f32(108, 0.05);
  payload.f32(112, 0.05);
  payload.f32(116, 0.1);
  payload.u32(120, bits); // extended_sol_stat
  payload.u16(124, 100); // time_since_update
  return frame(1465, payload.bytes, {
    week: WEEK,
    milliseconds: (BASE_SECONDS + index) * 1000,
  });
}

/** HEADING2 (`#1335`) — the dual-antenna heading that Graph does not chart. Body is 48 bytes. */
function heading2(index: number): Uint8Array {
  const payload = new Payload(48);
  payload.u32(0, 0); // solution_status: SOL_COMPUTED
  payload.u32(4, 50); // position_type: NARROW_INT
  payload.f32(8, 1.234); // baseline length
  payload.f32(12, 45.0 + index); // heading (°)
  payload.f32(16, 0.5); // pitch
  payload.f32(20, 0); // reserved float
  payload.f32(24, 0.2); // heading std dev
  payload.f32(28, 0.2); // pitch std dev
  payload.ascii(32, 'R\0\0\0');
  payload.ascii(36, 'B\0\0\0');
  payload.u8(40, 12);
  payload.u8(41, 12);
  payload.u8(42, 10);
  payload.u8(43, 8);
  payload.u8(44, 0); // extended_solution_status2
  payload.u8(45, 0); // ext_sol_stat
  payload.u8(46, 0xff); // gal_and_bds_mask
  payload.u8(47, 0xff); // gps_and_glo_mask
  return frame(1335, payload.bytes, {
    week: WEEK,
    milliseconds: (BASE_SECONDS + index) * 1000,
  });
}

/** The capture, as one byte array: 6 INSPVAX, 3 HEADING2, the DUALANTENNAALIGN text command. */
export function headingCapture(): Uint8Array {
  const bits = [0x00000001, 0x00000001, 0x00000011, 0x00000011, 0x02000001, 0x02000001];
  const parts: Uint8Array[] = [];
  // Interleave so log order is the order a receiver would have written it.
  for (let i = 0; i < 6; i += 1) {
    parts.push(inspvax(i, bits[i]));
    if (i < 3) parts.push(heading2(i));
  }
  parts.push('DUALANTENNAALIGN ENABLE 10 10\r\n');
  return capture(...parts);
}

/**
 * The same decoys **without** any INS log: 3 HEADING2 frames and the `DUALANTENNAALIGN` command.
 *
 * This is the `ANTENNA=DUAL` case with no SPAN. Graph's per-chart priority table has no entry for
 * 1335 / 1761, so this capture must export **no** Heading & Attitude CSV — the test asserts that
 * rather than quietly falling back to the dual-antenna heading.
 */
export function headingOnlyCapture(): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 3; i += 1) parts.push(heading2(i));
  parts.push('DUALANTENNAALIGN ENABLE 10 10\r\n');
  return capture(...parts);
}

function main(): void {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : '';
  if (!out) throw new Error('用法：node packages/graph/tools/make-heading-capture.ts --out <文件.sbf>');
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = headingCapture();
  writeFileSync(path, bytes);
  console.log(`${path}: ${bytes.length} B（合成抓包，未实机验证）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
