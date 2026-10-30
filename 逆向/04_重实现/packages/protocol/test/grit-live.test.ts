/**
 * GRIT on real hardware: the values the dashboard shows must come out of our decoder unchanged.
 *
 * Fixture `samples/grit/live-20261031/com11-live-8s.bin` is 8 s of USB2 traffic captured while the
 * suite's GRIT Monitor was running against the same receiver (OEM729, firmware `OM7MR1002RN0000`,
 * 2026-10-31 12:05 UTC). The screenshot taken at the same moment reports:
 *
 *   Satellite Tracked 25   Satellite Used 15   Position Single / Good
 *   latitude 30.5399718°   longitude 114.3528004°
 *
 * See `samples/grit/live-20261031/README.md` for the full dashboard reading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer } from '../src/framing.ts';
import { decodeEdie, type EdieTables, type EdieValue } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const capture = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'grit', 'live-20261031', 'com11-live-8s.bin');

function lastFrame(id: number): EdieValue[] {
  let values: EdieValue[] | undefined;
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capture)))) {
    if (frame.kind !== 'sbf' || frame.header.messageId !== id) continue;
    values = decodeEdie(frame.payload, tables.messages[String(id)], tables);
  }
  assert.ok(values, `capture contains message ${id}`);
  return values;
}

test('the live capture carries exactly the logs the GRIT status bar needs', () => {
  const counts = new Map<number, number>();
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capture)))) {
    if (frame.kind !== 'sbf') continue;
    counts.set(frame.header.messageId, (counts.get(frame.header.messageId) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort((a, b) => a - b), [42, 43, 93], 'BESTPOS / RANGE / RXSTATUS');
  assert.ok((counts.get(43) ?? 0) > 100, 'RANGE stream');
});

test('BESTPOS reproduces the dashboard: Single/Good, 25 tracked, 15 used', () => {
  const values = lastFrame(42);
  const get = (path: string) => values.find((value) => value.path === path);
  assert.equal(get('solution_status')?.text, 'SOL_COMPUTED');
  assert.equal(get('position_type')?.text, 'SINGLE');
  assert.equal(get('num_svs')?.text, '25', 'Satellite Tracked');
  assert.equal(get('num_soln_svs')?.text, '15', 'Satellite Used');
  const latitude = Number(get('latitude')?.value);
  const longitude = Number(get('longitude')?.value);
  assert.ok(Math.abs(latitude - 30.5399718) < 2e-5, `latitude ${latitude}`);
  assert.ok(Math.abs(longitude - 114.3528004) < 2e-5, `longitude ${longitude}`);
});

test('RXSTATUS shows no receiver error, which is what makes the Device tile "Good"', () => {
  const values = lastFrame(93);
  const error = values.find((value) => value.path === 'rx_error');
  assert.equal(error?.text, '00000000');
  const count = values.find((value) => value.path === 'status_words.count');
  assert.equal(count?.text, '5', 'receiver + aux1..aux4 status words');
});
