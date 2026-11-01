/**
 * The Events page's interference input, checked against the receiver's own bytes.
 *
 * `b7-20261101.sbf` is the first capture with the interference toolkit running: 48
 * `#ITDETECTSTATUSA` records, 38 of them carrying a detection (STATISTICANALYSIS 25 /
 * SPECTRUMANALYSIS 13, all on L2). The two lines below are copied verbatim from
 * `golden-b7-20261101.ASCII`; the test turns each into the flat field map the page receives and
 * asserts what `itkDetections()` makes of it.
 *
 * This is the check that the field names are right: the earlier transcription read
 * `centerFrequency`/`detectionType`, while the layout (and therefore the decoder) says
 * `frequency`/`int_detect_method`, so every real record was silently ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { itkDetections } from '../src/config/events.ts';

/** `#ITDETECTSTATUSA,<9 header fields>;count,band,method,p1,p2,p3,p4,sev1,sev2,sev3*2 crc`. */
function fieldsOf(line: string): Record<string, unknown> {
  const body = line.slice(line.lastIndexOf(';') + 1).replace(/\*[0-9a-f]+(\*[0-9a-f]+)?$/, '');
  const [count, , method, p1, p2, p3, p4, sev1, sev2, sev3] = body.split(',');
  const out: Record<string, unknown> = { interference_statuses_count: Number(count) };
  // A real `ITDETECTSTATUSA` line carries one status; the page's field map is flat, path-keyed.
  out['interference_statuses[0].int_detect_method'] = method;
  out['interference_statuses[0].frequency'] = Number(p1);
  out['interference_statuses[0].parameter2'] = Number(p2);
  out['interference_statuses[0].parameter3'] = Number(p3);
  out['interference_statuses[0].parameter4'] = Number(p4);
  out['interference_statuses[0].severity1'] = parseInt(sev1, 16);
  out['interference_statuses[0].severity2'] = parseInt(sev2, 16);
  out['interference_statuses[0].severity3'] = parseInt(sev3, 16);
  return out;
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
  const data = { data: [{ frequency: 1575.42, int_detect_method: 'SPECTRUMANALYSIS' }] };
  assert.deepEqual([...itkDetections(data)], [1575]);
});

test('NONE and rows without a method are ignored', () => {
  assert.deepEqual([...itkDetections({ data: [{ frequency: 0, int_detect_method: 'NONE' }] })], []);
  assert.deepEqual([...itkDetections({ data: [{ frequency: 1270 }] })], []);
});
