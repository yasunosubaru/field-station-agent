/**
 * The configuration pages read a per-port dictionary, and `config-feed.ts` is the only thing that
 * turns the receiver's own records into it. These tests use lines copied verbatim from the desk
 * OEM729 (2026-11-01, `LOG INTERFACEMODEB/LOGLISTB/SERIALCONFIGB/ICOMCONFIGB/NTRIPCONFIGB/
 * SOURCETABLEB ONCE` on COM10 = receiver USB2), so a change in the parser has to explain itself
 * against bytes a receiver actually sent.
 *
 * The port names are the receiver's own and look odd on purpose: `CCOM1`-`CCOM6` are real
 * `INTERFACEMODE` ports on this model (`NOVATELMINBINARY`/`AUTO`), not a stray letter — the page
 * renders exactly what the record says.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_MESSAGE_IDS, CONFIG_MESSAGE_ID_SET, configBodyTokens, configSliceOf, createAccumulator } from '../src/config-feed.ts';
import { CONFIG_SUBSCRIPTIONS } from '../../view/src/config/index.ts';

const INTERFACE = '#INTERFACEMODEA,SPECIAL,26,73.5,UNKNOWN,0,2.180,03801800,7a68,18278;COM1,NOVATEL,NOVATEL,ON*4af43302';
const CCOM = '#INTERFACEMODEA,SPECIAL,20,73.5,UNKNOWN,0,2.078,03801800,7a68,18278;CCOM1,NOVATELMINBINARY,NOVATELMINBINARY,ON*00000000';
const SERIAL = '#SERIALCONFIGA,SPECIAL,2,73.5,UNKNOWN,0,2.177,03801800,6be8,18278;COM1,9600,N,8,1,N,ON*ce240d0e';
const ICOM = '#ICOMCONFIGA,SPECIAL,6,73.5,UNKNOWN,0,2.322,03801800,1faa,18278;ICOM1,TCP,":2000",ALL*0b82fead';
const NTRIP = '#NTRIPCONFIGA,SPECIAL,2,73.5,UNKNOWN,0,2.119,03801800,4f72,18278;NCOM1,DISABLED,V1,"","","","",ALL*8b535eb2';
const SOURCE = '#SOURCETABLEA,SPECIAL,0,76.0,COARSESTEERING,2443,8199.000,03801800,71dd,18278;"",0,0,""*4cb149b8';
const LOGLIST = '#LOGLISTA,SPECIAL,0,76.5,COARSESTEERING,2443,7847.000,03801800,c00c,18278;2,COM1,RXSTATUSEVENTA,ONNEW,0.000000,0.000000,HOLD,USB1,RAWEPHEMB,ONNEW,0.000000,0.000000,HOLD*00000000';

test('the body of a full-ASCII record is what sits after the last `;`, quotes stripped', () => {
  assert.deepEqual(configBodyTokens(INTERFACE), ['COM1', 'NOVATEL', 'NOVATEL', 'ON']);
  assert.deepEqual(configBodyTokens(ICOM), ['ICOM1', 'TCP', ':2000', 'ALL']);
  // Abbreviated ASCII has no body delimiter; guessing there would fabricate ports.
  assert.equal(configBodyTokens('<INTERFACEMODE COM1 NOVATEL NOVATEL ON'), null);
  assert.equal(configBodyTokens(''), null);
});

test('INTERFACEMODE becomes the page\'s rxType/txType per port', () => {
  const slice = configSliceOf(3, INTERFACE, null);
  assert.deepEqual(slice, {
    name: 3,
    data: { port: 'COM1', rxType: 'NOVATEL', txType: 'NOVATEL', responses: 'ON' },
  });
  // `CCOM1` is a port this model really reports; it must not be "corrected" to `COM1`.
  const ccom = configSliceOf(3, CCOM, null);
  assert.equal((ccom?.data as Record<string, unknown>).port, 'CCOM1');
});

test('SERIALCONFIG accumulates one whole per-port table', () => {
  const accumulator = createAccumulator();
  const first = configSliceOf(1246, SERIAL, accumulator);
  assert.deepEqual(first?.data, { COM1: { baud: 9600, parity: 'N', databits: 8, stopbits: 1 } });
  const second = configSliceOf(
    1246,
    '#SERIALCONFIGA,SPECIAL,1,73.5,UNKNOWN,0,2.176,03801800,6be8,18278;COM2,38400,N,8,1,N,ON*d4b6d70b',
    accumulator,
  );
  // The page replaces `current[1246]` wholesale, so every feed carries every port seen so far.
  assert.deepEqual(Object.keys(second?.data ?? {}), ['COM1', 'COM2']);
  assert.equal((second?.data as Record<string, Record<string, unknown>>).COM2.baud, 38400);
});

test('LOGLIST becomes a port → message → trigger table, as the chips read it', () => {
  const slice = configSliceOf(5, LOGLIST, createAccumulator());
  const table = slice?.data as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(table), ['COM1', 'USB1']);
  assert.equal(table.COM1.RXSTATUSEVENTA.name, 'RXSTATUSEVENTA');
  assert.equal(table.COM1.RXSTATUSEVENTA.trigger, 'ONNEW');
  assert.equal(table.USB1.RAWEPHEMB.hold, 'HOLD');
});

test('ICOMCONFIG, NTRIPCONFIG and SOURCETABLE keep the shape their pages nest on', () => {
  const icom = configSliceOf(1248, ICOM, null);
  assert.equal((icom?.data as Record<string, unknown>).port, 'ICOM1');
  const ntrip = configSliceOf(1249, NTRIP, null);
  assert.equal((ntrip?.data as Record<string, unknown>).port, 'NCOM1');
  assert.equal((ntrip?.data as Record<string, unknown>).type, 'DISABLED');
  const source = configSliceOf(1344, SOURCE, null);
  assert.deepEqual(source?.data, { endPoint: '', entryData: '' });
});

test('the message ids the feed listens to are exactly the ids the pages subscribe to', () => {
  const union = [...new Set(Object.values(CONFIG_SUBSCRIPTIONS).flat())].sort((a, b) => a - b);
  assert.deepEqual([...CONFIG_MESSAGE_IDS], union);
  assert.ok(CONFIG_MESSAGE_ID_SET.has(1082));
  // The six ids the feed used to understand are a subset of the pages' own list; the records the
  // other pages read are let through now (`HEADINGOFFSET`, `ELEVATIONCUTOFF`, `PPSCONTROL`,
  // `IPCONFIG`, `VERSION`, …) instead of being dropped before the page could see them.
  for (const id of [3, 5, 1246, 1248, 1249, 1344, 1082, 1735, 613, 1243, 1244, 37, 1148, 1329]) {
    assert.ok(union.includes(id), `#${id} is one the pages subscribe to`);
  }
});

/* ------------------------------------------------------------------ the pages that were empty
 *
 * Every line below was sent by the desk OEM729 on 2026-11-01 (`LOG <NAME>B ONCE` on COM10 =
 * receiver USB2). The expected fields are the ones each page's own `updateData`/`render` reads, so
 * a rename in a page and a stale mapping here cannot both pass.
 */

const HEADING_OFFSET =
  '#HEADINGOFFSETA,SPECIAL,0,72.0,UNKNOWN,0,1.982,03801800,59e2,18278;0.000000000,0.000000000*713ffcce';
const ELEVATION_GPS =
  '#ELEVATIONCUTOFFA,SPECIAL,6,73.0,UNKNOWN,0,2.282,03801800,50e0,18278;GPS,10.0,0*e0baeadd';
const ELEVATION_NAVIC =
  '#ELEVATIONCUTOFFA,SPECIAL,0,73.0,UNKNOWN,0,2.282,03801800,50e0,18278;NAVIC,5.0,0*535178e9';
const PPS_CONTROL =
  '#PPSCONTROLA,SPECIAL,0,73.0,UNKNOWN,0,2.136,03801800,409a,18278;ENABLE,NEGATIVE,1.000000000,1000*e3bba9c0';
const IP_CONFIG =
  '#IPCONFIGA,SPECIAL,0,72.5,UNKNOWN,0,2.365,03801800,3e3c,18278;ETHA,STATIC,"192.168.5.10","255.255.255.0","192.168.5.1"*81eac919';
const DNS_CONFIG = '#DNSCONFIGA,SPECIAL,0,72.5,UNKNOWN,0,2.386,03801800,b03d,18278;1,"192.168.5.1"*fca1d977';
const VERSION =
  '#VERSIONA,SPECIAL,0,73.5,COARSESTEERING,2443,26582.439,03801800,3681,18278;3,GPSCARD,"PFNLYNTBN","BMGX21030301G","OEM729-2.03","OM7MR1002RN0000","OM7BR0100RB0000","2026/Jul/17","10:53:39",OEM7FPGA,"","","","OMV070001RN0000","","","",DB_WWWISO,"WWWISO","0","","WMC010203RN0001","","2018/Mar/19","10:21:29"*1c200792';
const MODEL_FEATURES =
  '#MODELFEATURESA,SPECIAL,0,73.0,COARSESTEERING,2443,26585.472,03801800,141a,18278;21,20HZ,MAX_MSR_RATE,20HZ,MAX_POS_RATE,SINGLE,ANTENNA,AUTHORIZED,MEAS_OUTPUT,AUTHORIZED,DGPS_TX,AUTHORIZED,RTK_TX,AUTHORIZED,LOW_END_POSITIONING,AUTHORIZED,RAIM,AUTHORIZED,ALIGN_HEADING,AUTHORIZED,ALIGN_RELATIVE_POS,AUTHORIZED,NTRIP,UNAUTHORIZED,IMU,UNAUTHORIZED,INS,UNAUTHORIZED,RTK_FLOAT,UNAUTHORIZED,RTK_FIXED,UNAUTHORIZED,PPP,UNAUTHORIZED,API,UNAUTHORIZED,INTERFERENCE_MITIGATION,UNAUTHORIZED,SPRINKLER,UNAUTHORIZED,RTKASSIST,UNAUTHORIZED,SCINTILLATION*a8061d99';
const CHAN_CONFIG =
  '#CHANCONFIGLISTA,SPECIAL,0,73.0,COARSESTEERING,2443,26588.609,03801800,d1c0,18278;1,5,5,16,GPSL1L2PL5,7,QZSSL1CAL2CL5,4,SBASL1,30,BEIDOUB1B2B2B,5,LBAND,5,16,GPSL1L2,7,QZSSL1CAL2C,4,SBASL1,30,BEIDOUB1B2B,5,LBAND,5,16,GPSL1L2PL2CL5,7,QZSSL1CAL2CL5,4,SBASL1,30,BEIDOUB1B2B2B,5,LBAND,5,16,GPSL1L2PL2CL5,7,QZSSL1CAL2CL5,4,SBASL1L5,30,BEIDOUB1B1CB2B2BB3,5,LBAND,5,16,GPSL1L2PL2CL5L1C,4,QZSSL1CAL2CL5L1CL6,4,SBASL1L5,30,BEIDOUB1B1CB2B2BB3,5,LBAND*0fd411c1';
const VALID_MODELS = '#VALIDMODELSA,SPECIAL,0,70.5,UNKNOWN,0,0.000,03801800,342f,18278;1,"PFNLYNTBN",0,0,0*3e5a77fe';
const AUTH_CODES =
  '#AUTHCODESA,SPECIAL,0,72.5,COARSESTEERING,2443,26818.000,03801800,2ad2,18278;VALID,1,SIGNATURE,TRUE,"R35JCN,BTG98D,R4DD6P,5PCR7N,9WPP25,PFNLYNTBN"*64b31953';
const OCEANIX_STATUS = '#OCEANIXSTATUSA,SPECIAL,0,72.5,COARSESTEERING,2443,26771.165,03801800,049a,18278;DISABLE,NO_SIGNAL,UNKNOWN*457fdb1c';
const OCEANIX_INFO =
  '#OCEANIXINFOA,SPECIAL,0,71.5,COARSESTEERING,2443,26771.165,03801800,9ce8,18278;"TR624:5027:4440",UNASSIGNED,00000000,0,0,0,GEOGATED*18ffb02a';
const BEST_POS =
  '#BESTPOSA,SPECIAL_29,0,70.5,COARSESTEERING,2443,26815.000,03801800,cdba,18278;SOL_COMPUTED,SINGLE,30.53997148196,114.35280430879,63.2209,-14.4000,WGS84,1.0531,1.0655,3.4027,"",0.000,0.000,29,15,15,15,00,06,30,03*59f764cb';
const AUTOSURVEY = '#AUTOSURVEYA,SPECIAL,0,72.5,UNKNOWN,0,2.355,03801800,80ad,18278;DISABLE,1440,2.0,10.0,OFF,"AUTO"*ed09e561';

test('HEADINGOFFSET keeps a real zero: 0.000000000 is a value, not "no data"', () => {
  const slice = configSliceOf(1082, HEADING_OFFSET, null);
  assert.deepEqual(slice, {
    name: 1082,
    data: { headingoffsetindeg: 0, pitchoffsetindeg: 0 },
  });
  // `alignConfig.ts` prints it through `toFixed(2)`; a NaN or a missing token must stay missing.
  assert.equal(configSliceOf(1082, '<HEADINGOFFSETA,SPECIAL,0,72.0,UNKNOWN,0,2,0,0,0;*0', null), null);
});

test('ELEVATIONCUTOFF and PPSCONTROL arrive in the gnss page\'s own field names', () => {
  assert.deepEqual(configSliceOf(1735, ELEVATION_GPS, null), {
    name: 1735,
    data: { constellation: 'GPS', angle: 10, reserved: 0 },
  });
  // One record per constellation: the record says which one, the page holds one angle.
  assert.deepEqual(configSliceOf(1735, ELEVATION_NAVIC, null)?.data, {
    constellation: 'NAVIC',
    angle: 5,
    reserved: 0,
  });
  assert.deepEqual(configSliceOf(613, PPS_CONTROL, null), {
    name: 613,
    data: { switch: 'ENABLE', polarity: 'NEGATIVE', period: 1, pulsewidth: 1000 },
  });
});

test('IPCONFIG and DNSCONFIG fill the networking page\'s address boxes', () => {
  assert.deepEqual(configSliceOf(1243, IP_CONFIG, null), {
    name: 1243,
    data: {
      interfaceName: 'ETHA',
      mode: 'STATIC',
      ipAddress: '192.168.5.10',
      netmask: '255.255.255.0',
      gateway: '192.168.5.1',
    },
  });
  assert.deepEqual(configSliceOf(1244, DNS_CONFIG, null), {
    name: 1244,
    data: { dnsserver: 1, ipAddress: '192.168.5.1' },
  });
});

test('VERSION becomes one row per component, in the layout\'s own slot order', () => {
  const rows = configSliceOf(37, VERSION, null)?.data.data as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  // This receiver fills `model_name` with `PFNLYNTBN` and `psn` with `BMGX21030301G`; the page
  // prints the slots as they arrived rather than swapping them to look nicer.
  assert.deepEqual(rows[0], {
    type: 'GPSCARD',
    model: 'PFNLYNTBN',
    PSN: 'BMGX21030301G',
    hardwareVersion: 'OEM729-2.03',
    softwareVersion: 'OM7MR1002RN0000',
    bootVersion: 'OM7BR0100RB0000',
    compileDate: '2026/Jul/17',
    compileTime: '10:53:39',
  });
  assert.equal(rows[1].type, 'OEM7FPGA');
  assert.equal(rows[2].type, 'DB_WWWISO');
});

test('MODELFEATURES names are turned back into the codes the page indexes', () => {
  const rows = configSliceOf(1329, MODEL_FEATURES, null)?.data.data as Record<string, unknown>[];
  assert.equal(rows.length, 21);
  // `deviceDetails.ts#FEATURE_STATUS/FEATURE_TYPE` are the tables; the record pairs a status with
  // a feature: `20HZ,MAX_MSR_RATE` is code 6 with code 0 (the binary record says `6,0`).
  assert.equal(rows[0].featureStatus, 6);
  assert.equal(rows[0].featureType, 0);
  // `SINGLE,ANTENNA` is 25 / 28 — `FEATURE_TYPE[28] === 'ANTENNA'`.
  assert.equal(rows[2].featureStatus, 25);
  assert.equal(rows[2].featureType, 28);
  // `AUTHORIZED,MEAS_OUTPUT` is 0 / 3, the pair `renderModelFeatures` looks for.
  assert.equal(rows[3].featureStatus, 0);
  assert.equal(rows[3].featureType, 3);
  // The receiver's own names are kept beside the codes, so the page and the report agree.
  assert.equal(rows[0].status, '20HZ');
  assert.equal(rows[0].feature, 'MAX_MSR_RATE');
  // `INTERFERENCE_MITIGATION` (26) is the page's `FEATURE_INTERFERENCE_MITIGATION` — the leading
  // `FEATURE_` is normalised away, not lost.
  const interference = rows.find((row) => row.feature === 'INTERFERENCE_MITIGATION');
  assert.equal(interference?.featureType, 26);
});

test('CHANCONFIGLIST becomes the signal rows the channel table renders', () => {
  const rows = configSliceOf(1148, CHAN_CONFIG, null)?.data.data as Record<string, unknown>[];
  // Five signal sets of five entries each, exactly as the record enumerates them.
  assert.equal(rows.length, 25);
  assert.deepEqual(rows[0], { numChans: 16, signalType: 'GPSL1L2PL5' });
  assert.deepEqual(rows[4], { numChans: 5, signalType: 'LBAND' });
});

test('VALIDMODELS and AUTHCODES keep a quoted comma-list whole', () => {
  const models = configSliceOf(206, VALID_MODELS, null)?.data.data as Record<string, unknown>[];
  assert.deepEqual(models, [
    { model: 'PFNLYNTBN', expyear: 0, expmonth: 0, expday: 0 },
  ]);
  const codes = configSliceOf(1348, AUTH_CODES, null)?.data.data as Record<string, unknown>[];
  assert.equal(codes.length, 1);
  assert.equal(codes[0].authCodeType, 1);
  assert.equal(codes[0].authCodeValidity, 1);
  // A naive comma split turned this one field into seven tokens; the page splits it itself.
  assert.equal(codes[0].authCodeString, 'R35JCN,BTG98D,R4DD6P,5PCR7N,9WPP25,PFNLYNTBN');
});

test('TERRASTAR/OCEANIX records land on the names the subscription card reads', () => {
  assert.deepEqual(configSliceOf(2160, OCEANIX_STATUS, null)?.data, {
    access: 0,
    accessStatus: 'DISABLE',
    decoderSyncState: 'NO_SIGNAL',
    regionRestrictionStatus: 'UNKNOWN',
  });
  const info = configSliceOf(2159, OCEANIX_INFO, null)?.data;
  assert.equal(info?.subscriptionService, 'TR624:5027:4440');
  assert.equal(info?.mode, 0);
});

test('BESTPOS and AUTOSURVEY feed the positioning wizard', () => {
  const best = configSliceOf(42, BEST_POS, null)?.data;
  assert.equal(best?.latitude, 30.53997148196);
  assert.equal(best?.longitude, 114.35280430879);
  assert.equal(best?.height, 63.2209);
  assert.equal(best?.positionType, 'SINGLE');
  const survey = configSliceOf(1795, AUTOSURVEY, null)?.data;
  assert.equal(survey?.control, 'DISABLE');
  assert.equal(survey?.time, 1440);
  assert.equal(survey?.accuracy, 2);
});

test('a record no page reads a field of is left alone instead of given an invented shape', () => {
  // `networkingSettings` subscribes IPSTATUS/WIFINETLIST but renders neither.
  assert.equal(
    configSliceOf(1289, '#IPSTATUSA,SPECIAL,0,73.0,COARSESTEERING,2443,26833.000,03801800,7fe2,18278;1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",1,"192.168.5.1"*16d5f0f8', null),
    null,
  );
  // GIII-only ids never arrive on an OEM7 link.
  assert.equal(configSliceOf(4101, VERSION, null), null);
});
