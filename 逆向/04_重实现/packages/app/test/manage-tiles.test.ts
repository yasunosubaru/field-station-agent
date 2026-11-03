/**
 * The §2.3.4 … §2.3.12 tiles: **data mapping from real capture fields**, and the exact `--` words.
 *
 * The samples are the b1/b4 recordings under `逆向/00_来源/samples/live-20261031/`, opened through
 * the same `loadCapture` + `readRecords` pair `/api/records` uses, so the field paths the readers
 * are handed here are byte-for-byte what the panel gets back from the API.
 *
 * What is pinned, and why:
 *
 *   b1 (`b1-20261101.sbf`, 2026-10-31 14:23 UTC, model PFNLYNTBN)
 *     PORTSTATS #72      30 entries; COM3 is the one port with framing errors (393838)
 *     SERIALCONFIG #1246 COM1 9600 8N1, COM2/COM3 38400 8N1
 *     MODELFEATURES      PPP / IMU / INS unauthorized, ALIGN authorized, antenna SINGLE
 *     LOGLIST #5         absent → the Logs column must be `--`, not 0
 *     INTERFACEMODE #3   absent → Input/Output must be `--`
 *     FILESTATUS #2127   absent → Logging is the "no file log on this model" state
 *     SATVIS2 #1043      24 records → real elevation/azimuth for the tracking rows
 *
 *   b4 (`b4-20261101.sbf`, 2026-11-01 03:44 UTC)
 *     LOGLIST #5, PPPPOS #1538 / PPPDOP #1997 / TERRASTARINFO #1719 present, no SATVIS2
 *
 * Every number below is quoted from those records; nothing is a placeholder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCapture } from '../src/paths.ts';
import { loadCapture, tables } from '../src/capture.ts';
import { readRecords } from '../src/logs.ts';
import {
  agcEntryTone,
  agcReasonText,
  alignReasonText,
  loggingReasonText,
  portLogsText,
  portRateText,
  portsReasonText,
  pppReasonText,
  radioReasonText,
  readAgc,
  readAlign,
  readFeatures,
  readLogging,
  readPorts,
  readPpp,
  readRadio,
  readSpan,
  readSatTracking,
  spanReasonText,
  trackingReasonText,
} from '../src/web/panels/manage.js';

const RANGE = 43;
const SATVIS2 = 1043;

const caches = new Map<string, ReturnType<typeof loadCapture>>();

function captureOf(name: string) {
  const hit = caches.get(name);
  if (hit) return hit;
  const data = loadCapture(resolveCapture(name));
  caches.set(name, data);
  return data;
}

function grab(name: string, msgId: number, limit = 1, offset = 0) {
  return readRecords(captureOf(name), tables(), msgId, offset, limit).records ?? [];
}

function total(name: string, msgId: number) {
  return readRecords(captureOf(name), tables(), msgId, 0, 1).total ?? 0;
}

const B1 = 'live-20261031/b1-20261101.sbf';
const B4 = 'live-20261031/b4-20261101.sbf';

/* ---------------------------------------------------------------- 2.3.4 Ports */

test('Ports: the rate column is SERIALCONFIG, the error state is PORTSTATS, the log count is LOGLIST', () => {
  const ports = readPorts({
    stats: grab(B1, 72)[0],
    serial: grab(B1, 1246, 8),
    logs: grab(B1, 5)[0],
    iface: grab(B1, 3, 8),
  });
  const byName = new Map(ports.rows.map((row) => [row.name, row]));

  // SERIALCONFIG (#1246) record 0 says `port = COM1, baud_rate = 9600, 8N1`.
  assert.equal(byName.get('COM1')?.baud, 9600);
  assert.equal(byName.get('COM1')?.framing, '8N1');
  assert.equal(portRateText(byName.get('COM1')), '9600 8N1');
  assert.equal(byName.get('COM2')?.baud, 38400);
  assert.equal(byName.get('COM3')?.baud, 38400);

  // PORTSTATS (#72): COM3 is the port whose framing counter moved (393 838 at this epoch).
  assert.equal(byName.get('COM3')?.framingErrors, 393838);
  assert.equal(byName.get('COM3')?.rx, 1719462);
  assert.equal(byName.get('COM3')?.tone, 'bad', 'an error counter turns the row red');
  assert.equal(byName.get('COM1')?.framingErrors, 0);

  // USB1 carries traffic but has no SERIALCONFIG record: active, no rate, no invented baud.
  assert.equal(byName.get('USB1')?.baud, NaN);
  assert.equal(portRateText(byName.get('USB1')), '--');
  assert.equal(byName.get('USB1')?.tone, 'good');

  // LOGLIST (#5) is not in b1: every Logs cell is `--`, never `0`.
  assert.equal(byName.get('COM1')?.logsKnown, false);
  assert.equal(portLogsText(byName.get('COM1')), '--');

  // INTERFACEMODE (#3) is not in b1 either: no Input/Output column values.
  assert.equal(byName.get('COM1')?.input, null);

  const reason = portsReasonText(ports);
  assert.match(reason, /SERIALCONFIG \(#1246\) \+ PORTSTATS \(#72\)/);
  assert.match(reason, /缺 LOGLIST \(#5\) \/ INTERFACEMODE \(#3\)/);
  assert.match(reason, /Input\/Output 两列要 INTERFACEMODE \(#3\)/);
});

test('Ports: b4 has LOGLIST, so the same tile prints log counts and drops the missing-id note', () => {
  const ports = readPorts({
    stats: grab(B4, 72)[0],
    serial: grab(B4, 1246, 8),
    logs: grab(B4, 5)[0],
    iface: grab(B4, 3, 8),
  });
  const byName = new Map(ports.rows.map((row) => [row.name, row]));
  assert.equal(byName.get('USB1_30')?.logs, 34, 'LOGLIST (#5) lists 34 logs on USB1_30');
  assert.equal(portLogsText(byName.get('USB1_30')), '34');
  assert.equal(byName.get('COM1')?.logs, 1);
  assert.equal(byName.get('COM1')?.baud, NaN, 'b4 carries no SERIALCONFIG → no rate');
  assert.equal(portRateText(byName.get('COM1')), '--');
  assert.doesNotMatch(portsReasonText(ports), /缺 LOGLIST/);
  assert.match(portsReasonText(ports), /LOGLIST \(#5\)/);
});

/* -------------------------------------------------------------- 2.3.5 Logging */

test('Logging: FILESTATUS is not produced by this model, so the tile is an unsupported state, not a zero', () => {
  const logging = readLogging({ filestatus: grab(B1, 2127), logs: grab(B1, 5)[0] });
  assert.equal(logging.supported, false);
  assert.equal(logging.status, null);
  assert.equal(logging.fileName, null);
  assert.equal(Number.isNaN(logging.fileSize), true);

  const reason = loggingReasonText(logging, 'b1-20261101.sbf');
  assert.match(reason, /FILESTATUS \(#2127\) 不在 b1-20261101\.sbf 里/);
  assert.match(reason, /ERROR:Message is invalid for this model/);
  assert.match(reason, /LOGLIST \(#5\) 也不在这个抓包里/);
});

test('Logging: b4 has LOGLIST but no FILESTATUS — and no FILE-port log on it', () => {
  const logging = readLogging({ filestatus: grab(B4, 2127), logs: grab(B4, 5)[0] });
  assert.equal(logging.supported, false);
  assert.equal(logging.logsKnown, true);
  assert.equal(logging.fileLogs, 0, 'LOGLIST (#5) names no FILE port in b4');
  assert.match(loggingReasonText(logging, 'b4-20261101.sbf'), /0 条落在 FILE 端口上/);
});

/* --------------------------------------------------------- 2.3.10 PPP Corrections */

test('PPP Corrections: b1 has PPP unauthorized, so the tile is Off and every source id is named', () => {
  const features = readFeatures(grab(B1, 1329)[0]);
  assert.equal(features?.ppp, 'UNAUTHORIZED');
  const ppp = readPpp({
    features,
    ppppos: grab(B1, 1538),
    pppdop: grab(B1, 1997),
    pppdop2: grab(B1, 1546),
    terrastar: grab(B1, 1719),
  });
  assert.equal(ppp.pppOff, true);
  assert.equal(ppp.tone, 'off');
  assert.equal(ppp.subscription, null);
  assert.equal(ppp.position, null);
  const reason = pppReasonText(ppp);
  assert.match(reason, /PPP 未授权（MODELFEATURES #1329 里 PPP = UNAUTHORIZED）/);
  assert.match(reason, /缺 TERRASTARINFO \(#1719\)/);
  assert.match(reason, /PPPPOS \(#1538\)/);
});

test('PPP Corrections: b4 carries TerraStar + PPPPOS + PPPDOP verbatim', () => {
  const ppp = readPpp({
    features: readFeatures(null),
    ppppos: grab(B4, 1538),
    pppdop: grab(B4, 1997),
    pppdop2: grab(B4, 1546),
    terrastar: grab(B4, 1719),
    oceanix: grab(B4, 2159),
    veripos: grab(B4, 1728),
    terrastarstatus: grab(B4, 1729),
    ntrip: grab(B4, 1249, 4),
  });
  assert.equal(ppp.subscription?.service, 'TerraStar');
  assert.equal(ppp.subscription?.mode, 'UNASSIGNED');
  assert.equal(ppp.subscription?.detailsHex, '0x00000000');
  assert.equal(ppp.subscription?.subscribed, false);
  assert.equal(ppp.tone, 'warn', 'reported but unsubscribed');
  assert.equal(ppp.position?.solution, 'INSUFFICIENT_OBS');
  assert.equal(ppp.position?.type, 'NONE');
  assert.equal(ppp.dop?.gdop, 9999);
  assert.equal(ppp.dop?.messageId, 1997);
  assert.equal(ppp.lockRecord, false);
  const reason = pppReasonText(ppp);
  assert.match(reason, /TerraStar：operating_mode = UNASSIGNED，subscription_details = 0x00000000/);
  assert.match(reason, /PPPPOS \(#1538\) 03:44:40 UTC = INSUFFICIENT_OBS/);
});

/* ------------------------------------------------------------- 2.3.11 Radio */

test('Radio: no SATEL record in any capture — the tile keeps the manual’s Off state', () => {
  const radio = readRadio({ satelstatus: grab(B1, 2205), sateldetect: grab(B1, 2204) });
  assert.equal(radio.present, false);
  assert.equal(radio.tone, 'off');
  const reason = radioReasonText(radio, 'b1-20261101.sbf');
  assert.match(reason, /无电台：b1-20261101\.sbf 里没有 SATELSTATUS \(#2205\) \/ SATELDETECT \(#2204\)/);
  assert.match(reason, /保持 Off（灰）而不是编一个 Good/);
});

/* ------------------------------------------------------ 2.3.8 ALIGN / 2.3.9 SPAN */

test('ALIGN: authorized by MODELFEATURES, but single-antenna and no HEADING2 record', () => {
  const features = readFeatures(grab(B1, 1329)[0]);
  const align = readAlign({ features, heading2: grab(B1, 1335), dualantenna: grab(B1, 1761) });
  assert.equal(align.supported, true);
  assert.equal(align.messageId, null);
  assert.equal(Number.isNaN(align.heading), true);
  const reason = alignReasonText(align, features);
  assert.match(reason, /ALIGN_HEADING 是 AUTHORIZED、ANTENNA = SINGLE/);
  assert.match(reason, /HEADING2 \(#1335\) \/ DUALANTENNAALIGN \(#1761\)/);
});

test('SPAN: IMU and INS unauthorized, so the tile says the model has no SPAN', () => {
  const features = readFeatures(grab(B1, 1329)[0]);
  assert.equal(features?.imu, 'UNAUTHORIZED');
  assert.equal(features?.ins, 'UNAUTHORIZED');
  const span = readSpan({ features, inspvax: grab(B1, 1465) });
  assert.equal(span.supported, false);
  assert.equal(span.values, null);
  assert.match(spanReasonText(span), /IMU \/ INS 都是 UNAUTHORIZED（该机型没有 SPAN）/);
  assert.match(spanReasonText(span), /INSPVAX \(#1465\)/);
});

/* ------------------------------------------------- 2.3.12 Satellite Tracking */

test('Satellite Tracking: the newest RANGE epoch with real C/No, lock time and SATVIS2 angles', () => {
  const rangeTotal = total(B1, RANGE);
  assert.ok(rangeTotal > 0);
  const newest = grab(B1, RANGE, 1, rangeTotal - 1);
  const tracking = readSatTracking({ range: newest, satvis: grab(B1, SATVIS2, 8) });

  assert.equal(tracking.epoch, newest[0].header.utc, 'the table is the last epoch, not the first');
  assert.ok(tracking.rows.length > 10, 'dozens of PRNs in one epoch');
  assert.deepEqual(
    [...new Set(tracking.rows.map((row) => row.rowKey))].sort(),
    tracking.systems.slice().sort(),
    'the constellation buttons are exactly the constellations present',
  );

  const gps1 = tracking.rows.find((row) => row.systemLabel === 'GPS' && row.prn === 1);
  assert.ok(gps1, 'GPS PRN 1 is in the last epoch');
  assert.ok(gps1.signals.length >= 1);
  assert.ok(
    gps1.signals.some((signal) => signal.name === 'GPS_L1_CA'),
    'the signal name comes from (c_status >> 21) & 0x1f',
  );
  for (const signal of gps1.signals) {
    assert.ok(Number.isFinite(signal.cno) && signal.cno > 0, 'C_No is a real dB-Hz value');
    assert.ok(Number.isFinite(signal.lock) && signal.lock >= 0, 'lock_time is seconds');
  }
  assert.ok(Number.isFinite(gps1.elevation) && Number.isFinite(gps1.azimuth), 'SATVIS2 gives el/az');

  const reason = trackingReasonText(tracking, 'cno');
  assert.match(reason, /RANGE \(#43\)/);
  assert.match(reason, /El\/Az 来自 SATVIS2 \(#1043\)/);
  assert.match(reason, /Carrier-to-Noise/);
  assert.match(trackingReasonText(tracking, 'lock'), /Lock Time/);
});

test('Satellite Tracking: without SATVIS2 every El/Az is --, and the note says why', () => {
  const rangeTotal = total(B4, RANGE);
  const newest = grab(B4, RANGE, 1, rangeTotal - 1);
  const tracking = readSatTracking({ range: newest, satvis: grab(B4, SATVIS2, 8) });
  assert.ok(tracking.rows.length > 0);
  assert.equal(tracking.skyEpoch, '');
  for (const row of tracking.rows) {
    assert.equal(Number.isNaN(row.elevation), true, 'no elevation is invented');
    assert.equal(Number.isNaN(row.azimuth), true, 'no azimuth is invented');
  }
  assert.match(trackingReasonText(tracking, 'cno'), /（该抓包没有 SATVIS2 → --）/);
});

test('Satellite Tracking: an empty RANGE keeps the table empty and names the id', () => {
  const tracking = readSatTracking({ range: [], satvis: [] });
  assert.deepEqual(tracking.rows, []);
  assert.match(trackingReasonText(tracking, 'cno'), /这个抓包里没有 RANGE \(#43\)/);
});

/* ---------------------------------------------------------------- 2.3.8 AGC Status */

function agcRecord(entries: Record<string, number>) {
  return { fields: Object.entries(entries).map(([path, value]) => ({ path, value })) };
}

test('AGC: a capture without AGCINFO (#4096) keeps the original Off state', () => {
  const agc = readAgc({ records: [] });
  assert.equal(agc.count, 0);
  assert.equal(agc.tone, 'off');
  assert.match(agcReasonText(agc, 'b1-20261101.sbf'), /无 AGCINFO \(#4096\)/);
});

test('AGC: card and RF come from statusWord, bins/pulseWidth from the record', () => {
  const word = ((3 << 28) | (1 << 25)) >>> 0;   // DSPC1, L2
  const agc = readAgc({
    records: [
      agcRecord({
        statusWord: word,
        pulseWidth: 500,
        modulus: 1024,
        bin1: 1,
        bin2: 2,
        bin3: 3,
        bin4: 4,
        bin5: 5,
        bin6: 6,
      }),
    ],
  });
  assert.equal(agc.count, 1);
  assert.equal(agc.tone, 'good');
  assert.deepEqual(agc.cards, ['DSPC1']);
  const [row] = agc.rows;
  assert.equal(row.rf, 'L2');
  assert.equal(row.pulseWidth, 500);
  assert.equal(row.modulus, 1024);
  assert.deepEqual(row.bins, [1, 2, 3, 4, 5, 6]);
  assert.equal(agcEntryTone(row), 'good');
});

test('AGC: pulseWidth 0 / 1000 or VGA railed is bad, >900 or bin skew is warn', () => {
  const base = { modulus: 1024, bin1: 1, bin2: 1, bin3: 1, bin4: 1, bin5: 1, bin6: 1 };
  const badZero = readAgc({ records: [agcRecord({ ...base, pulseWidth: 0 })] });
  assert.equal(badZero.tone, 'bad');
  assert.equal(badZero.rows[0].tone, 'bad');

  const badFull = readAgc({ records: [agcRecord({ ...base, pulseWidth: 1000 })] });
  assert.equal(badFull.tone, 'bad');

  const railed = ((3 << 28) | (1 << 25) | (1 << 13)) >>> 0;
  const railedAgc = readAgc({
    records: [agcRecord({ ...base, statusWord: railed, pulseWidth: 500 })],
  });
  assert.equal(railedAgc.rows[0].railGain, true);
  assert.equal(railedAgc.rows[0].tone, 'bad');

  const high = readAgc({ records: [agcRecord({ ...base, pulseWidth: 950 })] });
  assert.equal(high.tone, 'warn');

  const skewWord = ((3 << 28) | (1 << 25) | (1 << 23)) >>> 0;
  const skew = readAgc({
    records: [agcRecord({ ...base, statusWord: skewWord, pulseWidth: 500 })],
  });
  assert.equal(skew.rows[0].binSkew, true);
  assert.equal(skew.tone, 'warn');
});

test('AGC: bad wins over warn when several cards are present', () => {
  const base = { modulus: 1024, bin1: 1, bin2: 1, bin3: 1, bin4: 1, bin5: 1, bin6: 1 };
  const dspc1 = ((3 << 28) | (1 << 25)) >>> 0;
  const dspc2 = ((4 << 28) | (2 << 25)) >>> 0;
  const agc = readAgc({
    records: [
      agcRecord({ ...base, statusWord: dspc1, pulseWidth: 950 }),  // warn
      agcRecord({ ...base, statusWord: dspc2, pulseWidth: 0 }),    // bad
    ],
  });
  assert.deepEqual(agc.cards, ['DSPC1', 'DSPC2']);
  assert.equal(agc.tone, 'bad');
  assert.match(agcReasonText(agc, 'capture.sbf'), /bad 1、warn 1/);
});

