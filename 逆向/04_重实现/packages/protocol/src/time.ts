/**
 * GPS ↔ wall-clock conversion.
 *
 * The original (`01_解包/app/jarvisInterface.js:3569-3577`) does:
 *
 *   const gpsDate = new Date('January 6, 1980 00:00:00');   // parsed in the LOCAL time zone
 *   gpsDate.setHours(week * 7 * 24);
 *   gpsDate.setMilliseconds(msInWeek - 18000);              // 18 s = GPS-UTC leap offset
 *   return gpsDate;
 *
 * Two defects are reproduced by `gpsToDateMirroring` and corrected by `gpsToUtcDate`:
 *  1. The epoch string carries no time zone, so the result shifts by the machine's UTC offset.
 *  2. The leap-second offset is hard-coded to 18 s for every week (only correct from 2017-01-01 on).
 *
 * The seconds-of-week value is applied with `setMilliseconds`, which rolls over into the hour and
 * day fields; keep that when mirroring, do not "fix" it silently.
 */

export const GPS_EPOCH_UTC_MS = Date.UTC(1980, 0, 6, 0, 0, 0);
export const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** UTC instants at which the GPS-UTC offset became the given number of seconds. */
const LEAP_TABLE: ReadonlyArray<readonly [utcIso: string, seconds: number]> = [
  ['1981-07-01T00:00:00Z', 1],
  ['1982-07-01T00:00:00Z', 2],
  ['1983-07-01T00:00:00Z', 3],
  ['1985-07-01T00:00:00Z', 4],
  ['1988-01-01T00:00:00Z', 5],
  ['1990-01-01T00:00:00Z', 6],
  ['1991-01-01T00:00:00Z', 7],
  ['1992-07-01T00:00:00Z', 8],
  ['1993-07-01T00:00:00Z', 9],
  ['1994-07-01T00:00:00Z', 10],
  ['1996-01-01T00:00:00Z', 11],
  ['1997-07-01T00:00:00Z', 12],
  ['1999-01-01T00:00:00Z', 13],
  ['2006-01-01T00:00:00Z', 14],
  ['2009-01-01T00:00:00Z', 15],
  ['2012-07-01T00:00:00Z', 16],
  ['2015-07-01T00:00:00Z', 17],
  ['2017-01-01T00:00:00Z', 18],
];

const LEAP_TABLE_MS = LEAP_TABLE.map(([iso, s]) => [Date.parse(iso), s] as const);

/** GPS-UTC offset in seconds at a UTC instant (0 before 1981-07-01). */
export function leapSecondsAtUtc(utcMs: number): number {
  let seconds = 0;
  for (const [from, s] of LEAP_TABLE_MS) if (utcMs >= from) seconds = s;
  return seconds;
}

/** Correct conversion: GPS week + milliseconds-of-week to a UTC instant. */
export function gpsToUtcDate(week: number, msOfWeek: number): Date {
  const naive = GPS_EPOCH_UTC_MS + week * MS_PER_WEEK + msOfWeek;
  // One correction pass is enough because a leap step is 1 s and the error is <= 18 s.
  let seconds = leapSecondsAtUtc(naive);
  let utc = naive - seconds * 1000;
  const recomputed = leapSecondsAtUtc(utc);
  if (recomputed !== seconds) {
    seconds = recomputed;
    utc = naive - seconds * 1000;
  }
  return new Date(utc);
}

/** GPS-UTC offset in seconds for a GPS week (accurate version). */
export function leapSecondsForWeek(week: number): number {
  return leapSecondsAtUtc(GPS_EPOCH_UTC_MS + week * MS_PER_WEEK);
}

/** Inverse of `gpsToUtcDate`. */
export function utcDateToGps(date: Date): { week: number; milliseconds: number } {
  const seconds = leapSecondsAtUtc(date.getTime());
  const gpsMs = date.getTime() + seconds * 1000 - GPS_EPOCH_UTC_MS;
  const week = Math.floor(gpsMs / MS_PER_WEEK);
  return { week, milliseconds: gpsMs - week * MS_PER_WEEK };
}

/** Bit-exact reproduction of the original, including the local-time-zone defect. */
export function gpsToDateMirroring(week: number, msOfWeek: number, hardCodedLeapSeconds = 18): Date {
  const d = new Date('January 6, 1980 00:00:00');
  d.setHours(week * 7 * 24);
  d.setMilliseconds(msOfWeek - hardCodedLeapSeconds * 1000);
  return d;
}

/** `HH:MM:SS UTC` as built by the status bar (`jarvisInterface.js:3515-3519`). */
export function formatUtcTime(d: Date): string {
  const p = (n: number) => ('0' + n).slice(-2);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}
