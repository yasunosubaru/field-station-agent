/**
 * GRIT's spectrum from a **capture** — the sample lane in `/api/records` and the one merge rule.
 *
 * Fixture: `samples/live-20261031/b1-20261101.sbf` (2 758 111 B, 1322 binary records), the same
 * replay `live-itpsd.test.ts` uses. Measured composition: 127 × ITPSDFINAL (#1968, every one a
 * whole 1024-sample sweep, header sequence 0) and 50 × ITPSDDETECT (#2063) = 25 sweeps of
 * `sequence 1` (1024 samples) → `sequence 0` (341 samples), i.e. 1365 bins per sweep.
 *
 * What this file pins down:
 *
 *  1. a 1024-sample record is 1028 decoded fields, and the response keeps the *numbers* while
 *     dropping the per-element `{name, path}` boilerplate — `logs.ts` `projectFields` moves a long
 *     single-leaf numeric vector out of the 800-row field table into `arrays`;
 *  2. multi-leaf arrays (RANGE's `obs[i].*`) are untouched, because their readers address paths;
 *  3. the panel folds capture rows through the **same** `ingestSpectrum`/`mergeChunks` the live
 *     stream uses, so `sequence 1 → 0` yields 1365 bins here exactly as it does live.
 *
 * The assertion numbers (`22587`, `73242.1875`, `0x04021b22`, 1365) are the capture's own and are
 * cross-checked against `golden-b1-20261101.ASCII` in `live-itpsd.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCapture, tables } from '../src/capture.ts';
import { projectFields, readRecords, type DecodedRecord } from '../src/logs.ts';
import { resolveCapture } from '../src/paths.ts';
import type { EdieValue } from '../../protocol/src/edie.ts';
import {
  captureSpectrumEntry,
  emptySpectrumStore,
  ingestCaptureRecords,
  waterfallFrames,
} from '../src/web/panels/grit.js';

const here = dirname(fileURLToPath(import.meta.url));
const capturePath = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');

/** The capture, handed to `loadCapture` without going through the extension whitelist. */
const capture = resolveCapture('live-20261031/b1-20261101.sbf');
const data = loadCapture(capture);
const edie = tables();

const ITPSD_FINAL = 1968;
const ITPSD_DETECT = 2063;

function page(messageId: number, offset: number, limit: number): DecodedRecord[] {
  return readRecords(data, edie, messageId, offset, limit).records;
}

function paths(record: DecodedRecord): string[] {
  return record.fields.map((field) => field.path);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, ...(value as object) }));
}

/* ---------------- 1. the sample lane ---------------- */

test('ITPSDFINAL: 1024 samples travel as numbers, not as 1024 field rows', () => {
  const result = readRecords(data, edie, ITPSD_FINAL, 0, 1);
  const record = result.records[0];

  /* The wire geometry: 4 scalars + 1024 samples = 1028 decoded fields (ITPSDFINAL's payload is
     4 + 4 + 4 + 4 + 1024 × 2 = 2064 B, the header says so too). */
  assert.equal(record.header.payloadLength, 2064);
  assert.equal(record.fieldTotal, 1028);
  assert.equal(record.fields.length, 4);
  assert.deepEqual(paths(record), ['status_word', 'frequency_start_m_hz', 'step_size_hz', 'samples.count']);

  /* The table is short but the record is not: the flag still tells the whole truth. */
  assert.equal(record.fieldsTruncated, true);

  assert.equal(record.arrays.length, 1);
  const samples = record.arrays[0];
  assert.equal(samples.path, 'samples');
  assert.equal(samples.field, 'samples');
  assert.equal(samples.count, 1024);
  assert.equal(samples.omitted, 0);
  assert.equal(samples.values.length, 1024);
  /* The first two raw uint16 of the capture — the same the golden ASCII prints:
     `#ITPSDFINALA,…;04020920,1531.299,97656.250,1024,22587,22865,…` */
  assert.equal(samples.values[0], 22587);
  assert.equal(samples.values[1], 22865);

  /* The scalars are intact and readable by path (Manage probes them the way it always did). */
  const scalars = new Map(record.fields.map((field) => [field.path, field]));
  assert.equal(scalars.get('status_word')!.value, 0x04020920);
  assert.equal(scalars.get('status_word')!.text, '04020920');
  assert.ok(Math.abs(Number(scalars.get('frequency_start_m_hz')!.value) - 1531.298828125) < 1e-9);
  assert.equal(scalars.get('step_size_hz')!.value, 97656.25);
  assert.equal(scalars.get('samples.count')!.value, 1024);
});

test('the response body stays small: 7 KB a record, 172 KB for a page of 25', () => {
  /* Before the split this record was 800 field objects = 50 381 B (measured by serialising the
     same 800 rows); the numbers are the same, only the boilerplate went away. */
  const one = bytes(readRecords(data, edie, ITPSD_FINAL, 0, 1));
  const many = bytes(readRecords(data, edie, ITPSD_FINAL, 127 - 25, 25));

  assert.ok(one < 10_000, `one ITPSDFINAL record is ${one} B, expected under 10 KB`);
  assert.ok(many < 200_000, `25 ITPSDFINAL records are ${many} B, expected under 200 KB`);
  /* 1024 numbers cannot fit in less than ~5 KB, so the floor is a sanity check, not a target. */
  assert.ok(one > 5_000, `one record is ${one} B — 1024 numbers really are in there`);
});

test('ITPSDDETECT keeps its own sample counts: 1024 then 341 for one 1365-bin sweep', () => {
  const [head, tail] = page(ITPSD_DETECT, 0, 2);
  assert.equal(head.header.sequence, 1);
  assert.equal(tail.header.sequence, 0);
  assert.equal(head.arrays[0].count, 1024);
  assert.equal(tail.arrays[0].count, 341);
  assert.equal(head.header.milliseconds, tail.header.milliseconds);
  /* One sweep: the tail starts 1024 bins after the head. */
  const stepSize = Number(head.fields.find((field) => field.path === 'step_size_hz')!.value);
  const start = (record: DecodedRecord) => Number(record.fields.find((field) => field.path === 'frequency_start_m_hz')!.value);
  assert.equal(stepSize, 73242.1875);
  assert.ok(Math.abs(start(tail) - (start(head) + (1024 * stepSize) / 1e6)) < 1e-3);
});

/* ---------------- 2. what stays inline ---------------- */

test('multi-leaf arrays stay in the field table: RANGE is still 800 of 841 rows', () => {
  const range = page(43, 0, 1)[0];
  assert.equal(range.arrays.length, 0, 'obs[i].* has several leaves, so it is not a sample vector');
  assert.equal(range.fields.length, 800);
  assert.ok(range.fieldTotal > 800);
  assert.equal(range.fieldsTruncated, true);
  assert.ok(paths(range).includes('obs[0].sv_prn'), 'RANGE readers address obs[i].* by path');

  const bestpos = page(42, 0, 1)[0];
  assert.equal(bestpos.arrays.length, 0);
  assert.equal(bestpos.fields.length, bestpos.fieldTotal, 'a small log is not truncated at all');
  assert.equal(bestpos.fieldsTruncated, false);
});

test('the truncation rule: >16 elements of one leaf are lifted, 16 or fewer stay inline', () => {
  const vector = (count: number, value: (index: number) => number | string = (index) => 1000 + index): EdieValue[] => {
    const values: EdieValue[] = [{ name: 'samples', path: 'samples.count', value: count, isCount: true }];
    for (let index = 0; index < count; index += 1) {
      values.push({ name: 'samples', path: `samples[${index}].samples`, value: value(index) });
    }
    return values;
  };

  const inline = projectFields(vector(16));
  assert.equal(inline.arrays.length, 0);
  assert.equal(inline.fields.length, 17);
  assert.equal(inline.truncated, false);

  const lifted = projectFields(vector(17));
  assert.equal(lifted.arrays.length, 1);
  assert.equal(lifted.arrays[0].count, 17);
  assert.equal(lifted.fields.length, 1, 'the count prefix stays, the 17 elements do not');
  assert.equal(lifted.total, 18);
  assert.equal(lifted.truncated, true);

  /* Two leaves per element = a record of records, never a sample vector. */
  const structured: EdieValue[] = [];
  for (let index = 0; index < 40; index += 1) {
    structured.push({ name: 'status', path: `obs[${index}].status`, value: index });
    structured.push({ name: 'prn', path: `obs[${index}].prn`, value: index });
  }
  assert.equal(projectFields(structured).arrays.length, 0);

  /* A non-numeric element keeps the array in the table: `arrays` may only carry numbers. */
  const texty = vector(20, (index) => (index === 3 ? 'n/a' : index));
  assert.equal(projectFields(texty).arrays.length, 0);
  assert.equal(projectFields(texty).fields.length, 21);
});

/* ---------------- 3. the merge (one rule, two sources) ---------------- */

test('the panel opens the capture: 25 ITPSDFINAL records → 1024-point curve, 10 waterfall frames', () => {
  const records = page(ITPSD_FINAL, 127 - 25, 25);
  const store = emptySpectrumStore();
  const changed = ingestCaptureRecords(store, records, data.relPath);

  assert.equal(changed, 25, 'every record is an ITPSD chunk and every one changed the drawing');
  assert.equal(store.chunks, 25);
  assert.equal(store.sweeps, 25, 'each ITPSDFINAL is a whole sweep (header sequence 0)');
  assert.equal(store.latest.samples.length, 1024);
  assert.equal(store.frames.length, 10, 'the waterfall keeps the newest ten sweeps');
  assert.equal(waterfallFrames(store).length, 10, '… and all of them share one frequency grid');
  assert.equal(store.source, 'capture');
  assert.equal(store.capture, data.relPath);
  assert.equal(store.latest.parts.length, 1, 'a whole 1024-sample sweep is one log');

  /* dBm: raw / 256 − 200, applied to the last record's first sample. */
  const lastRecord = records[records.length - 1];
  const raw = lastRecord.arrays[0].values[0] as number;
  assert.ok(Math.abs(store.latest.samples[0] - (raw / 256 - 200)) < 1e-9);
  assert.equal(store.latest.stepSize, 97656.25);
  assert.ok(Math.abs(store.latest.frequencyStart - 1531.298828125) < 1e-9);
});

test('a DETECT sweep merges through the live rule: sequence 1 → 0 = 1365 points', () => {
  /* Exactly one sweep: the capture rotates through three bands, so the next two records belong to
     a different one and must not be merged into this grid. */
  const records = page(ITPSD_DETECT, 0, 2);
  const store = emptySpectrumStore();
  ingestCaptureRecords(store, records, data.relPath);

  assert.equal(store.chunks, 2);
  assert.equal(store.sweeps, 1);
  assert.equal(store.skipped, 0);
  assert.equal(store.latest.samples.length, 1365);
  assert.deepEqual(store.latest.parts, [
    { sequence: 1, samples: 1024 },
    { sequence: 0, samples: 341 },
  ]);
  /* The head's first sample is 24197/256 − 200, and the merged frame starts on the head's grid. */
  assert.ok(Math.abs(store.latest.samples[0] - (24197 / 256 - 200)) < 1e-9);
  const startOf = (record: DecodedRecord) => Number(record.fields.find((field) => field.path === 'frequency_start_m_hz')!.value);
  assert.ok(Math.abs(store.latest.frequencyStart - startOf(records[0])) < 1e-9);
  assert.equal(store.latest.stepSize, 73242.1875);
  /* The tail resumes exactly where the head's 1024 bins end, which is why the merge is contiguous. */
  assert.ok(Math.abs(startOf(records[1]) - (startOf(records[0]) + (1024 * 73242.1875) / 1e6)) < 1e-3);
  /* 1365 bins × 73 242.1875 Hz ≈ 99.97 MHz of span, which is what the caption prints. */
  const spanMhz = (store.latest.samples.length * store.latest.stepSize) / 1e6;
  assert.ok(Math.abs(spanMhz - 99.9755859375) < 1e-6, `span ${spanMhz} MHz`);
});

test('sequence comes from the OEM7 header, not the status word', () => {
  const [head, tail] = page(ITPSD_DETECT, 0, 2);
  const headEntry = captureSpectrumEntry(head)!;
  const tailEntry = captureSpectrumEntry(tail)!;

  assert.ok(headEntry && tailEntry);
  assert.equal(headEntry.data.sequence, head.header.sequence);
  assert.equal(tailEntry.data.sequence, 0);
  assert.equal(head.header.sequence, 1);

  /* Both chunks carry the same status word — a sequence inside it could not tell them apart. */
  assert.equal(headEntry.data.status.word, 0x04021b22);
  assert.equal(tailEntry.data.status.word, headEntry.data.status.word);
  assert.equal(headEntry.data.status.frequency, 2);
  assert.equal(headEntry.data.status.dataSource, 2);
  assert.equal(headEntry.data.status.fftSize, 3);
  assert.equal(headEntry.data.status.integrationWindow, 3);
  assert.equal(headEntry.data.status.timeAverage, 2);

  /* Other messages are not spectrum rows. */
  assert.equal(captureSpectrumEntry(page(42, 0, 1)[0]), null);
});

test('a repeated chunk is dropped by sequence, exactly as on the live stream', () => {
  const [head, closing] = page(ITPSD_DETECT, 0, 2);
  const store = emptySpectrumStore();
  /* sequence 1, the same sequence 1 again, then the closing 0: the duplicate must not land twice. */
  ingestCaptureRecords(store, [head, head, closing], data.relPath);
  assert.equal(store.duplicates, 1);
  assert.equal(store.sweeps, 1);
  assert.equal(store.latest.samples.length, 1365);
});

/* ---------------- 4. the capture is openable at all ---------------- */

test('the app accepts a .sbf recording — GRIT has no other source in this samples tree', () => {
  assert.equal(capture.name, 'b1-20261101.sbf');
  assert.equal(statSync(capturePath).size, capture.bytes);
  assert.ok(data.frames.length > 1000);
  /* `/api/captures` lists what `resolveCapture` accepts, so an unreachable extension means an
     unreachable spectrum tile. */
  assert.doesNotThrow(() => resolveCapture('live-20261031/remote-23types.sbf'));
});
