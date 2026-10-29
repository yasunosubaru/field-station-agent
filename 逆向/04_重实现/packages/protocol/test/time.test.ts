import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gpsToUtcDate,
  utcDateToGps,
  leapSecondsForWeek,
  gpsToDateMirroring,
  formatUtcTime,
  GPS_EPOCH_UTC_MS,
} from '../src/time.ts';

test('GPS epoch converts to 1980-01-06T00:00:00Z', () => {
  assert.equal(gpsToUtcDate(0, 0).toISOString(), '1980-01-06T00:00:00.000Z');
  assert.equal(GPS_EPOCH_UTC_MS, Date.parse('1980-01-06T00:00:00Z'));
});

test('leap seconds follow the published table', () => {
  assert.equal(leapSecondsForWeek(0), 0);
  assert.equal(leapSecondsForWeek(100), 1); // 1981-12
  assert.equal(leapSecondsForWeek(1929), 17);
  assert.equal(leapSecondsForWeek(1930), 18); // 2017-01-01
  assert.equal(leapSecondsForWeek(2440), 18); // 2026
});

test('week/second round-trip is stable for a 2026 instant', () => {
  const d = new Date('2026-10-28T12:34:56.789Z');
  const { week, milliseconds } = utcDateToGps(d);
  assert.equal(gpsToUtcDate(week, milliseconds).toISOString(), d.toISOString());
});

test('18 s offset is applied at the 2017 boundary', () => {
  // 2017-01-01T00:00:00Z is GPS 1930/0 minus 18 s of leap offset
  const { week, milliseconds } = utcDateToGps(new Date('2017-01-01T00:00:00Z'));
  assert.equal(week, 1930);
  assert.equal(milliseconds, 18000);
});

test('the mirroring helper reproduces the original arithmetic', () => {
  const mirrored = gpsToDateMirroring(2200, 1000);
  // 2200 weeks * 7 days from local 1980-01-06 00:00, then +1000 ms -18 s rolled over.
  const expectedLocal = new Date('January 6, 1980 00:00:00');
  expectedLocal.setHours(2200 * 7 * 24);
  expectedLocal.setMilliseconds(1000 - 18000);
  assert.equal(mirrored.getTime(), expectedLocal.getTime());
});

test('formatUtcTime pads to two digits', () => {
  assert.equal(formatUtcTime(new Date('2026-01-02T03:04:05Z')), '03:04:05 UTC');
});
