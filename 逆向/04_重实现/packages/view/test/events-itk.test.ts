/**
 * The Events page's interference input, checked against the receiver's own bytes.
 *
 * `b7-20261101.sbf` is the first capture with the interference toolkit running: 47
 * `#ITDETECTSTATUSA` records, 38 of them carrying a detection (STATISTICANALYSIS 25 /
 * SPECTRUMANALYSIS 13, all on L2). The two lines below are copied verbatim from
 * `golden-b7-20261101.ASCII`; the test turns each into the flat field map the page receives and
 * asserts what `itkDetections()` makes of it.
 *
 * Two things this pins down, both measured (2026-11-01):
 *  - the method comes from `int_detect_method`, which in a **text** record is the printed token
 *    (`SPECTRUMANALYSIS`), not a number;
 *  - the centre frequency is `parameter1` — the field the layout calls `frequency` is the band enum
 *    (`L2`), so reading it as a frequency gives `3`, not `1270`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { itkDetections } from '../src/config/events.ts';

/** `#ITDETECTSTATUSA,<9 header fields>;count,band,method,p1,p2,p3,p4,sev1,sev2,sev3*2 crc`. */
function fieldsOf(line: string): Record<string, unknown> {
  const body = line.slice(line.lastIndexOf(';') + 1).replace(/\*[0-9a-f]+(\*[0-9a-f]+)?$/, '');
  const [count, band, method, p1, p2, p3, p4, sev1, sev2, sev3] = body.split(',');
  const numeric = (token: string) => (/^[-+0-9.]/.test(token) ? Number(token) : token);
  return {
    interference_statuses_count: Number(count),
    // The same token/number split `readTextRecords()` produces: an enum arrives as its name.
    'interference_statuses[0].frequency': numeric(band),
    'interference_statuses[0].int_detect_method': numeric(method),
    'interference_statuses[0].parameter1': numeric(p1),
    'interference_statuses[0].parameter2': numeric(p2),
    'interference_statuses[0].parameter3': numeric(p3),
    'interference_statuses[0].parameter4': numeric(p4),
    'interference_statuses[0].severity1': parseInt(sev1, 16),
    'interference_statuses[0].severity2': parseInt(sev2, 16),
    'interference_statuses[0].severity3': parseInt(sev3, 16),
  };
}

const SPECTRUM = '#ITDETECTSTATUSA,USB2,0,78.0,COARSESTEERING,2443,35958.000,03809800,7fdb,18278;1,L2,SPECTRUMANALYSIS,1270.176,2.051,-38.877,-95.668,00000400,00000000,00000003*deadbeef';
const STATISTIC = '#ITDETECTSTATUSA,USB2,0,77.0,COARSESTEERING,2443,35956.000,03808800,7fdb,18278;1,L2,STATISTICANALYSIS,6.826,0.448,1.040,0.333,00000000,00000000,00000004*deadbeef';

test('a spectrum detection from the real b7 line becomes an event frequency', () => {
  assert.deepEqual([...itkDetections(fieldsOf(SPECTRUM))], [1270]);
});

test('a statistical detection does not (the original only raises on the spectrum detector)', () => {
  assert.deepEqual([...itkDetections(fieldsOf(STATISTIC))], []);
});

test('the live projection shape works too, with the layout field names', () => {
  const data = { data: [{ int_detect_method: 'SPECTRUMANALYSIS', parameter1: 1575.42 }] };
  assert.deepEqual([...itkDetections(data)], [1575]);
});

test('NONE and rows without a method are ignored', () => {
  assert.deepEqual([...itkDetections({ data: [{ int_detect_method: 'NONE', parameter1: 1270 }] })], []);
  assert.deepEqual([...itkDetections({ data: [{ parameter1: 1270 }] })], []);
});
