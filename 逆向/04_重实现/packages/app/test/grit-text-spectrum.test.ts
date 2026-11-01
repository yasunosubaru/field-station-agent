/**
 * GRIT's spectrum from a capture whose ITPSD logs are **text** — and the timestamp bug that came
 * with reading them.
 *
 * Fixture: `samples/live-20261031/b7-20261101.sbf`, the ITK capture of 2026-11-01. This receiver
 * writes `ITPSDFINAL` / `ITPSDDETECT` only as ASCII (`#ITPSDFINALA` / `#ITPSDDETECTA`, §13.3 of
 * `03_分析/05_GRIT-Monitor.md`), so the capture holds 47 + 90 text lines and **zero** #1968/#2063
 * payloads — `/api/logs` `groups` has neither id, only `textGroups` has the names. Until this was
 * wired up the Spectrum tile stayed on its placeholder frame for the one capture that has ITPSD.
 *
 * Measured composition (do not infer it, re-read the file):
 *
 *   `#ITPSDFINALA`  47 lines — 43 × 1024 samples @ 1531.299 MHz / 97 656.25 Hz (status `04020920`),
 *                    4 × 512 samples @ 1202.598 MHz / 195 312.5 Hz (status `0c020821`, the receiver
 *                    was reconfigured for GPSL2 at 10:00 UTC);
 *   `#ITPSDDETECTA` 90 lines — 45 sweeps of `sequence 1` (1024) → `sequence 0` (341) @ 73 242.188 Hz,
 *                    rotating through three bands (1531.287 / 1202.537 / 1141.287 MHz).
 *
 * The header bug is pinned here too: `textRecordFields()` returns the nine header tokens **by name**
 * (`port, sequence, idle, timeStatus, week, ms, rxStatus, defCrc, version`), so week is `head[4]` and
 * the time of week in seconds is `head[5]`. Reading `head[5]`/`head[6]` gave every text record
 * `week 35956, ms 3 808 800 000` (year 2669) and `textGroups.firstWeek = 0`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gpsAsUtc, loadCapture, tables } from '../src/capture.ts';
import { readTextRecords, summarizeLogs, type DecodedRecord } from '../src/logs.ts';
import { resolveCapture } from '../src/paths.ts';
import {
  captureSpectrumEntry,
  captureSpectrumRequest,
  emptySpectrumStore,
  ingestCaptureRecords,
  spectrumSourceNote,
  waterfallFrames,
} from '../src/web/panels/grit.js';

const here = dirname(fileURLToPath(import.meta.url));
const capturePath = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031', 'b7-20261101.sbf');
const CAPTURE = 'live-20261031/b7-20261101.sbf';

const capture = resolveCapture(CAPTURE);
const data = loadCapture(capture);
const edie = tables();

const ITPSD_FINAL = 1968;
const ITPSD_DETECT = 2063;

function text(name: string, offset: number, limit: number): DecodedRecord[] {
  return readTextRecords(data, edie, name, offset, limit).records;
}

function valueOf(record: DecodedRecord, path: string): unknown {
  return record.fields.find((field) => field.path === path)?.value;
}

/* ---------------- 1. the header bug ---------------- */

test('a text record takes week and milliseconds from the header tokens by name, not by offset', () => {
  /* `#ITPSDFINALA,USB2,0,77.0,COARSESTEERING,2443,35956.000,03808800,b79a,18278;…` — the first
     ITPSD line of the capture. */
  const first = text('ITPSDFINAL', 0, 1)[0];
  assert.equal(first.header.week, 2443);
  assert.equal(first.header.milliseconds, 35_956_000);
  assert.equal(first.header.utc, gpsAsUtc(2443, 35_956_000));
  assert.equal(first.header.utc, '2026-11-01T09:59:16.000Z');
  /* The old indices produced these two values — the guard keeps them out. */
  assert.notEqual(first.header.week, 35_956);
  assert.notEqual(first.header.milliseconds, 3_808_800_000);
});

test('the text groups carry the capture\u2019s own first and last line, not year 2669', () => {
  const summary = summarizeLogs(data, edie);
  const group = (name: string) => {
    const found = summary.textGroups.find((item) => item.name === name);
    assert.ok(found, `${name} is among the text groups`);
    return found;
  };
  for (const name of ['ITPSDFINAL', 'ITPSDDETECT']) {
    const item = group(name);
    assert.equal(item.firstWeek, 2443, `${name} first week`);
    assert.equal(item.firstMilliseconds, 35_956_000, `${name} first time of week`);
    assert.equal(item.firstUtc, '2026-11-01T09:59:16.000Z');
    assert.equal(item.lastWeek, 2443, `${name} last week`);
    assert.equal(item.lastMilliseconds, 36_002_000, `${name} last time of week`);
    assert.equal(item.lastUtc, '2026-11-01T10:00:02.000Z');
    /* The bug is visible as a week the capture never carries. */
    assert.ok(item.lastWeek < 3000, `${name} week ${item.lastWeek} is not a GPS week`);
  }
  assert.equal(group('ITPSDFINAL').count, 47);
  assert.equal(group('ITPSDDETECT').count, 90);
});

test('the header sequence word survives the text path: DETECT is sequence 1 → 0', () => {
  const [head, tail] = text('ITPSDDETECT', 0, 2);
  assert.equal(head.header.sequence, 1);
  assert.equal(tail.header.sequence, 0);
  assert.equal(head.header.milliseconds, tail.header.milliseconds);
});

/* ---------------- 2. `/api/records` text rows → one spectrum chunk ---------------- */

test('a text ITPSDFINAL row becomes a 1024-sample chunk with the fields\u2019 own geometry', () => {
  const record = text('ITPSDFINAL', 0, 1)[0];
  /* A text row has no `arrays` at all — that is the binary lane's shape. */
  assert.equal(record.arrays.length, 0);
  assert.equal(record.fieldTotal, 1027);

  const entry = captureSpectrumEntry(record);
  assert.ok(entry);
  assert.equal(entry.data.log, 'final');
  assert.equal(entry.data.sequence, 0);
  assert.equal(entry.data.samples.length, 1024);
  assert.equal(entry.data.stepSize, 97_656.25);
  assert.ok(Math.abs(entry.data.frequencyStart - 1531.299) < 1e-6);
  assert.equal(entry.name, 'ITPSDFINAL');

  /* dBm = raw / 256 − 200, the same numbers the binary lane draws. The first raw sample of this
     line is 24301. */
  assert.equal(Number(valueOf(record, 'samples[0].samples')), 24301);
  assert.ok(Math.abs(entry.data.samples[0] - (24301 / 256 - 200)) < 1e-9);
  assert.ok(Math.abs(entry.data.samples[0] - -105.07421875) < 1e-9);

  /* The status word is printed as hex, so `0c020821`-style tokens must decode as hex; the all-digit
     token `04020920` must too (the text projection hands it back as the number 4020920). */
  assert.equal(entry.data.status.word, 0x04020920);
  assert.equal(entry.data.status.frequency, 0);
});

test('a text ITPSDDETECT tail keeps its 341 samples and its hex status word', () => {
  const [head, tail] = text('ITPSDDETECT', 0, 2);
  const headEntry = captureSpectrumEntry(head)!;
  const tailEntry = captureSpectrumEntry(tail)!;
  assert.equal(headEntry.data.samples.length, 1024);
  assert.equal(tailEntry.data.samples.length, 341);
  assert.equal(tailEntry.data.sequence, 0);
  assert.equal(tailEntry.data.status.word, 0x04021b22);
  /* The ASCII line prints the step with three decimals (`73242.188`), the binary payload carries
     `73242.1875`; the drawing uses the printed value the receiver actually wrote. */
  assert.ok(Math.abs(headEntry.data.stepSize - 73_242.1875) < 1e-3);
  assert.ok(Math.abs(headEntry.data.frequencyStart - 1531.287) < 1e-6);
  assert.ok(Math.abs(tailEntry.data.frequencyStart - 1606.287) < 1e-6);
});

test('the FINAL/DETECT decision: by message id when binary, by header name when text', () => {
  const finalRow = text('ITPSDFINAL', 0, 1)[0];
  const detectRow = text('ITPSDDETECT', 0, 1)[0];

  assert.equal(captureSpectrumEntry(finalRow)!.data.log, 'final');
  assert.equal(captureSpectrumEntry(detectRow)!.data.log, 'detect');
  /* The version letter is what a capture may spell; the dictionary name has none. */
  assert.equal(captureSpectrumEntry({ ...finalRow, header: { ...finalRow.header, name: 'ITPSDFINALA' } })!.data.log, 'final');

  /* Binary ids keep working — b1's lane is unchanged. */
  const binary = {
    header: { messageId: ITPSD_FINAL, name: 'ITPSDFINAL', sequence: 0, utc: '', milliseconds: 1 },
    fields: [
      { path: 'status_word', value: 0x04020920 },
      { path: 'frequency_start_m_hz', value: 1531.298828125 },
      { path: 'step_size_hz', value: 97656.25 },
    ],
    arrays: [{ path: 'samples', values: [22587, 22865] }],
  };
  const binaryEntry = captureSpectrumEntry(binary)!;
  assert.equal(binaryEntry.data.log, 'final');
  assert.equal(binaryEntry.data.samples.length, 2);
  assert.ok(Math.abs(binaryEntry.data.samples[0] - (22587 / 256 - 200)) < 1e-9);

  /* Everything else is not a spectrum row. */
  assert.equal(captureSpectrumEntry({ header: { messageId: 42, name: 'BESTPOS' }, fields: [] }), null);
  assert.equal(captureSpectrumEntry(text('ITDETECTSTATUS', 0, 1)[0]), null);
  assert.equal(captureSpectrumEntry(null), null);
});

/* ---------------- 3. which page is asked for ---------------- */

test('no binary ITPSD in the capture → the text records are asked for by name, FINAL first', () => {
  const totals = { final: 0, detect: 0, textFinal: 47, textDetect: 90 };
  const request = captureSpectrumRequest(totals, CAPTURE)!;
  assert.equal(request.kind, 'text');
  assert.equal(request.log, 'final');
  assert.equal(request.name, 'ITPSDFINAL');
  assert.equal(request.msgId, undefined);
  assert.equal(request.count, 47);
  assert.equal(request.limit, 25);
  assert.equal(request.offset, 22, 'the last page: 47 − 25');
  assert.equal(request.key, `${CAPTURE}|text|final|22`);

  /* DETECT only: its sweep is two chunks (1 → 0), so the page is even. */
  const detect = captureSpectrumRequest({ final: 0, detect: 0, textFinal: 0, textDetect: 90 }, CAPTURE)!;
  assert.equal(detect.log, 'detect');
  assert.equal(detect.name, 'ITPSDDETECT');
  assert.equal(detect.limit, 24);
  assert.equal(detect.offset, 66, '90 − 24 is even, so the page starts on a sweep head');
  assert.equal(detect.offset % 2, 0);

  /* Binary wins when the capture has it — b1's 127 FINAL + 50 DETECT. */
  const binary = captureSpectrumRequest({ final: 127, detect: 50 }, 'live-20261031/b1-20261101.sbf')!;
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.msgId, ITPSD_FINAL);
  assert.equal(binary.limit, 25);
  assert.equal(binary.offset, 102);
  const binaryDetect = captureSpectrumRequest({ final: 0, detect: 50 }, 'x.sbf')!;
  assert.equal(binaryDetect.msgId, ITPSD_DETECT);
  assert.equal(binaryDetect.limit, 24);

  /* Nothing to read: b1 with no counts, a capture name-less page, a zero-count text capture. */
  assert.equal(captureSpectrumRequest({ final: 0, detect: 0, textFinal: 0, textDetect: 0 }, CAPTURE), null);
  assert.equal(captureSpectrumRequest({ final: 0, detect: 0, textFinal: 47, textDetect: 90 }, ''), null);
  assert.equal(captureSpectrumRequest(null, CAPTURE), null);
});

/* ---------------- 4. the merge, from the page the request names ---------------- */

test('the text FINAL page draws the newest sweep: 512 points over 100 MHz', () => {
  const request = captureSpectrumRequest({ final: 0, detect: 0, textFinal: 47, textDetect: 90 }, CAPTURE)!;
  const rows = text(request.name, request.offset, request.limit);
  assert.equal(rows.length, 25);

  const store = emptySpectrumStore();
  const changed = ingestCaptureRecords(store, rows, CAPTURE);
  assert.equal(changed, 25);
  assert.equal(store.chunks, 25);
  assert.equal(store.sweeps, 25, 'every text ITPSDFINAL is a whole sweep (header sequence 0)');
  assert.equal(store.source, 'capture');
  assert.equal(store.capture, CAPTURE);

  /* The capture switches to GPSL2/195.3125 kHz/512 bins in its last four seconds; the curve is the
     newest sweep, so that is what it draws. */
  assert.equal(store.latest!.samples.length, 512);
  assert.equal(store.latest!.stepSize, 195_312.5);
  assert.ok(Math.abs(store.latest!.frequencyStart - 1202.598) < 1e-6);
  assert.ok(Math.abs((store.latest!.samples.length * store.latest!.stepSize) / 1e6 - 100) < 1e-6);
  assert.equal(waterfallFrames(store).length, 4, 'the four sweeps on the newest frequency grid');
});

test('a text DETECT page merges 12 sweeps through the live rule: sequence 1 → 0 = 1365 points', () => {
  const request = captureSpectrumRequest({ final: 0, detect: 0, textFinal: 47, textDetect: 90 }, CAPTURE)!;
  const detect = captureSpectrumRequest({ final: 0, detect: 0, textFinal: 0, textDetect: 90 }, CAPTURE)!;
  assert.equal(request.log, 'final', 'FINAL is preferred when the capture has both');
  const rows = text(detect.name, detect.offset, detect.limit);
  assert.equal(rows.length, 24);

  const store = emptySpectrumStore();
  const changed = ingestCaptureRecords(store, rows, CAPTURE);
  assert.equal(changed, 24);
  assert.equal(store.sweeps, 12, '24 chunks = 12 sweeps');
  assert.equal(store.latest!.samples.length, 1365);
  assert.deepEqual(store.latest!.parts, [
    { sequence: 1, samples: 1024 },
    { sequence: 0, samples: 341 },
  ]);
  /* `73242.188` — the three decimals the ASCII line printed (the binary payload's value is
     `73242.1875`; nothing in a text record carries the fourth decimal). */
  assert.ok(Math.abs(store.latest!.stepSize - 73_242.1875) < 1e-3);
  assert.ok(Math.abs(store.latest!.frequencyStart - 1141.287) < 1e-6);
  /* 1365 × 73 242.188 Hz ≈ 99.98 MHz — the caption's span. */
  assert.ok(Math.abs((store.latest!.samples.length * store.latest!.stepSize) / 1e6 - 99.9755859375) < 1e-3);
  /* Only the sweeps on the newest grid stack in the waterfall. */
  assert.equal(waterfallFrames(store).length, 4);
});

/* ---------------- 5. the note says where the sweeps came from ---------------- */

test('a text replay says so in words — it is never described as live', () => {
  const store = emptySpectrumStore();
  store.source = 'capture';
  store.capture = CAPTURE;
  store.textSource = { name: 'ITPSDFINAL', count: 47 };
  const note = spectrumSourceNote(store);
  assert.match(note, /capture b7-20261101\.sbf/);
  assert.match(note, /replayed from 47 text ITPSDFINAL records/);
  assert.ok(!/live/i.test(note), `a replay must not read as live: ${note}`);

  const one = { ...store, textSource: { name: 'ITPSDDETECT', count: 1 } };
  assert.match(spectrumSourceNote(one), /replayed from 1 text ITPSDDETECT record$/);

  /* A binary capture has the plain origin; a live store says nothing here (the band already does). */
  assert.equal(spectrumSourceNote({ ...store, textSource: null }), ' · capture b7-20261101.sbf');
  assert.equal(spectrumSourceNote({ ...store, source: 'live', capture: '' }), '');
  assert.equal(spectrumSourceNote(emptySpectrumStore()), '');
});
