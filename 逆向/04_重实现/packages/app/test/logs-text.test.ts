/**
 * A capture's **text** records, which is the only way `ITDETECTSTATUS` reaches the app on this
 * receiver: it is logged as `ITDETECTSTATUSA`, so `b7-20261101.sbf` holds 47 `#ITDETECTSTATUSA`
 * lines and no binary #2065 payload at all.
 *
 * Before this, `/api/logs` reported `textRecords: 504` and grouped nothing, and `/api/records`
 * answered 0 rows for `msgId=2065` — the Signal Matrix and Events page therefore said
 * "Not detected" with 38 detections in the file (measured 2026-11-01).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCapture, tables } from '../src/capture.ts';
import { readTextRecords, summarizeLogs } from '../src/logs.ts';
import { resolveCapture } from '../src/paths.ts';

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = join(here, '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const CAPTURE = 'live-20261031/b7-20261101.sbf';

function capture() {
  return loadCapture(resolveCapture(CAPTURE));
}

test('the summary lists the capture text records by name', () => {
  const summary = summarizeLogs(capture(), tables());
  const itk = summary.textGroups.find((group) => group.name === 'ITDETECTSTATUS');
  assert.ok(itk, 'ITDETECTSTATUS appears among the text groups');
  assert.equal(itk.count, 47);
  assert.match(itk.sample, /^#ITDETECTSTATUSA/);
  // The names the receiver also wrote as text, in this capture.
  const names = summary.textGroups.map((group) => group.name).sort();
  assert.deepEqual(names, ['ITDETECTSTATUS', 'ITPSDDETECT', 'ITPSDFINAL', 'RXCONFIG'].sort());
});

test('readTextRecords decodes a text record into the dictionary field paths', () => {
  const result = readTextRecords(capture(), tables(), 'ITDETECTSTATUS', 0, 5);
  assert.equal(result.total, 47);
  assert.equal(result.records.length, 5);
  const fields = new Map(result.records[0].fields.map((field) => [field.path, field.value]));
  // Body: `1,L2,STATISTICANALYSIS,6.826,…` — the band and method arrive as their names, and the
  // centre frequency of a spectrum detection lives in `parameter1` (not in `frequency`).
  assert.equal(fields.get('interference_statuses[0].frequency'), 'L2');
  assert.equal(fields.get('interference_statuses[0].int_detect_method'), 'STATISTICANALYSIS');
  assert.equal(fields.get('interference_statuses[0].parameter1'), 6.826);
  assert.equal(result.records[0].header.name, 'ITDETECTSTATUS');
});
