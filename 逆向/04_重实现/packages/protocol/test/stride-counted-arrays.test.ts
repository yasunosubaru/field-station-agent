/**
 * The **element stride** of the four counted-array logs that no capture contains.
 *
 * Every real sample of these four carries exactly one element (`ETHSTATUS`: 15 records, all 32 B,
 * all byte-identical), and one element cannot tell a 28-byte struct from "26 bytes + 2 spare". The
 * lines below are therefore pinned from **synthetic** `count ≥ 2` frames run through the installed
 * NovAtel Application Suite's own Convert — `逆向/tools/oracle-stride-sentinels.ts` rebuilds every
 * payload here and prints the same lines (exit code 0 = byte-identical), so the literals are that
 * run's output, copied.
 *
 * What was measured, and what it changed in `edie.ts`:
 *
 *  - `SBAS17` (no string member): members sit at `pack(4)` offsets (`x` at 8, not the dense 6) and
 *    the elements are 32 bytes apart, so `t0` lands at `8 + count * 32`. The dictionary's dense 30
 *    is wrong for `count ≥ 1`, but only `count ≥ 2` shows the *spacing*.
 *  - `ETHSTATUS` / `SAVEDSURVEYPOSITIONS` / `WIFINETLIST` carry a `variable` `STRING`: the suite
 *    re-walks the string's real bytes, so the member behind it starts where the string ended and the
 *    element is as long as its content. A 17-char MAC gives 28, a 2-char MAC gives 12; a 4-char id
 *    gives 32, a 1-char id gives 28; a 32-char SSID with a 17-char BSSID gives 68, with a 1-char
 *    BSSID 52.
 *  - `WIFINETLIST` has **two** strings, and this is what the old shift arithmetic got wrong: it added
 *    the drift once per *member* instead of once per *string*, so everything behind the second string
 *    was placed from a stale offset.
 *
 * The dictionary's dense strides are still asserted (30 / 26 / 29 / 63), so the difference between
 * "what the table says" and "what the wire uses" stays visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { appendCrcLe } from '../src/crc.ts';
import { buildLongHeader } from '../src/header.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { encodeAbbrevLines } from '../src/abbrev-log.ts';
import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import {
  packedStructSize,
  walkArray,
  wireElementSegments,
  type EdieArray,
  type EdieTables,
} from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const HEADER = 'COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278';

function frameOf(messageId: number, payload: Uint8Array): SbfFrame {
  const head = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    portAddress: 32, // COM1
    sequence: 1,
    idleTimeRaw: 0,
    timeStatus: 180, // FINESTEERING
    week: 2402,
    milliseconds: 577759000,
    receiverStatus: 0x03800800,
    reserved: 0xcdba,
    softwareVersion: 18278,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return new SbfDeframer({ crcMode: 'validate' }).push(appendCrcLe(body))[0] as SbfFrame;
}

const ascii = (id: number, payload: Uint8Array): string =>
  encodeAsciiLog(frameOf(id, payload), tables.messages[String(id)]!, tables);
const abbrev = (id: number, payload: Uint8Array): string[] =>
  encodeAbbrevLines(frameOf(id, payload), tables.messages[String(id)]!, tables);

/** Little-endian writer over a zeroed payload. */
class Words {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(at: number, value: number): this { this.view.setUint8(at, value); return this; }
  u16(at: number, value: number): this { this.view.setUint16(at, value, true); return this; }
  u32(at: number, value: number): this { this.view.setUint32(at, value, true); return this; }
  f64(at: number, value: number): this { this.view.setFloat64(at, value, true); return this; }
  ascii(at: number, text: string): this {
    for (let i = 0; i < text.length; i += 1) this.view.setUint8(at + i, text.charCodeAt(i) & 0xff);
    return this;
  }
}

/** Bytes a `variable` STRING spends: up to its NUL, padded to 4; at least four. */
const stringSize = (text: string): number => Math.max(4, Math.ceil((text.length + 1) / 4) * 4);

const arrayOf = (id: number): EdieArray =>
  tables.messages[String(id)]!.fields.find((segment): segment is EdieArray => segment.kind === 'array')!;

// ---------------------------------------------------------------------------------------------
// SBAS17 (#980): prn(ULONG) + items[] { data_id, prn_3, health (USHORT), x, y, z, x_vel, y_vel,
// z_vel (LONG) } + t0. Dense members 0/2/4/6/10/14/18/22/26 (30); pack(4) 0/2/4/8/12/16/20/24/28.
// ---------------------------------------------------------------------------------------------
function sbas17(count: number): Uint8Array {
  const out = new Words(8 + count * 32 + 4);
  out.u32(0, 0x51ab); // prn
  out.u32(4, count);
  for (let element = 0; element < count; element += 1) {
    const base = 8 + element * 32;
    const value = (member: number): number => 1000 * (element + 1) + 10 * member;
    out.u16(base, value(1));
    out.u16(base + 2, value(2));
    out.u16(base + 4, value(3));
    for (let member = 4; member <= 9; member += 1) out.u32(base + 8 + (member - 4) * 4, value(member));
  }
  out.u32(8 + count * 32, 0x51ab); // t0, behind the elements
  return out.bytes;
}

test('SBAS17: a fixed element list is `pack(4)` — members and stride', () => {
  const array = arrayOf(980);
  assert.equal(array.stride, 30, 'the dictionary still says the dense element size');
  assert.equal(packedStructSize(array.elements), 32);
  // The rewrite the writers see: `x` moves 6 → 8, and `z_vel` ends at 32.
  assert.deepEqual(
    wireElementSegments(array.elements).map((segment) => [segment.name, segment.offset]),
    [['data_id', 0], ['prn_3', 2], ['health', 4], ['x', 8], ['y', 12], ['z', 16],
      ['x_vel', 20], ['y_vel', 24], ['z_vel', 28]],
  );
  const walk = walkArray(sbas17(3), array, array.offset);
  assert.equal(walk.count, 3);
  assert.deepEqual(walk.starts, [8, 40, 72]);
  assert.equal(walk.size, 4 + 3 * 32, 'count prefix + three 32-byte elements');
});

test('SBAS17: the suite reads the pack(4) member offsets, one element and three', () => {
  assert.equal(
    ascii(980, sbas17(1)),
    `#SBAS17A,${HEADER};20907,1,1010,1020,1030,1040,1050,1060,1070,1080,1090,20907*dd56e7e3`,
  );
  assert.equal(
    ascii(980, sbas17(2)),
    `#SBAS17A,${HEADER};20907,2,1010,1020,1030,1040,1050,1060,1070,1080,1090,2010,2020,2030,2040,2050,2060,2070,2080,2090,20907*45a3c929`,
  );
  assert.equal(
    ascii(980, sbas17(3)),
    `#SBAS17A,${HEADER};20907,3,1010,1020,1030,1040,1050,1060,1070,1080,1090,2010,2020,2030,2040,2050,2060,2070,2080,2090,3010,3020,3030,3040,3050,3060,3070,3080,3090,20907*932cf54c`,
  );
  assert.deepEqual(abbrev(980, sbas17(2)), [
    `<SBAS17 ${HEADER.replace(/,/g, ' ')}`,
    '<     20907 2 ',
    '<          1010 1020 1030 1040 1050 1060 1070 1080 1090 ',
    '<          2010 2020 2030 2040 2050 2060 2070 2080 2090 ',
    '<     20907',
  ]);
});

// ---------------------------------------------------------------------------------------------
// ETHSTATUS (#1288): eth_status[] { interface(enum), mac_address(STRING 18, variable),
// interface_config(enum) }. Dense 0/4/22 (26); pack(4) 0/4/24 (28).
// ---------------------------------------------------------------------------------------------
function ethStatus(mac: (element: number) => string): Uint8Array {
  const size = stringSize(mac(0));
  const stride = 4 + size + 4; // interface + string + config, nothing behind a re-walked string
  const out = new Words(4 + 2 * stride);
  out.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    out.u32(base, element === 0 ? 2 : 3); // ETHA / ETHB
    out.ascii(base + 4, mac(element));
    out.u32(base + 4 + size, element === 0 ? 4 : 5); // 100_FULL / 100_HALF
  }
  return out.bytes;
}

test('ETHSTATUS: a full-width MAC gives 28-byte elements, a short one 12', () => {
  const array = arrayOf(1288);
  assert.equal(array.stride, 26);
  assert.equal(packedStructSize(array.elements), 28);
  // A list with a `variable` STRING keeps its dense offsets — the drift is measured per record.
  assert.deepEqual(
    wireElementSegments(array.elements).map((segment) => segment.offset),
    [0, 4, 22],
  );
  assert.deepEqual(walkArray(ethStatus(() => 'AA-BB-CC-DD-EE-FF'), array, 0).starts, [4, 32]);
  assert.deepEqual(walkArray(ethStatus(() => 'a0'), array, 0).starts, [4, 16]);
});

test('ETHSTATUS: the suite prints the elements where the strings put them', () => {
  assert.equal(
    ascii(1288, ethStatus((element) => (element === 0 ? 'AA-BB-CC-DD-EE-FF' : '11-22-33-44-55-66'))),
    `#ETHSTATUSA,${HEADER};2,ETHA,"AA-BB-CC-DD-EE-FF",100_FULL,ETHB,"11-22-33-44-55-66",100_HALF*fc03a1c2`,
  );
  assert.equal(
    ascii(1288, ethStatus((element) => (element === 0 ? 'a0' : 'b0'))),
    `#ETHSTATUSA,${HEADER};2,ETHA,"a0",100_FULL,ETHB,"b0",100_HALF*6b5e7bd1`,
  );
  assert.deepEqual(abbrev(1288, ethStatus((element) => (element === 0 ? 'a0' : 'b0'))), [
    `<ETHSTATUS ${HEADER.replace(/,/g, ' ')}`,
    '<     2 ',
    '<          ETHA "a0" 100_FULL ',
    '<          ETHB "b0" 100_HALF',
  ]);
});

// ---------------------------------------------------------------------------------------------
// SAVEDSURVEYPOSITIONS (#1951): positions[] { id(STRING 5, variable), latitude, longitude,
// height (DOUBLE) }. Dense 0/5/13/21 (29); pack(4) 0/8/16/24 (32).
// ---------------------------------------------------------------------------------------------
function savedSurvey(id: string): Uint8Array {
  const idSize = stringSize(id);
  const stride = idSize + 24;
  const out = new Words(4 + 2 * stride);
  out.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    out.ascii(base, element === 0 ? id : `${id.slice(0, -1).toUpperCase()}${id.slice(-1)}`);
    const value = element === 0 ? 11.5 : 21.5;
    out.f64(base + idSize, value);
    out.f64(base + idSize + 8, value + 1);
    out.f64(base + idSize + 16, value + 2);
  }
  return out.bytes;
}

test('SAVEDSURVEYPOSITIONS: the id is re-walked — 4 B gives 28, 8 B gives 32', () => {
  const array = arrayOf(1951);
  assert.equal(array.stride, 29);
  assert.equal(packedStructSize(array.elements), 32);
  assert.deepEqual(walkArray(savedSurvey('a'), array, 0).starts, [4, 32]);
  assert.deepEqual(walkArray(savedSurvey('abcd'), array, 0).starts, [4, 36]);
});

test('SAVEDSURVEYPOSITIONS: the suite prints the doubles behind the id', () => {
  assert.equal(
    ascii(1951, savedSurvey('a')),
    `#SAVEDSURVEYPOSITIONSA,${HEADER};2,"a",11.50000000000,12.50000000000,13.5000,"a",21.50000000000,22.50000000000,23.5000*014ce30c`,
  );
  assert.equal(
    ascii(1951, savedSurvey('abcd')),
    `#SAVEDSURVEYPOSITIONSA,${HEADER};2,"abcd",11.50000000000,12.50000000000,13.5000,"ABCd",21.50000000000,22.50000000000,23.5000*59fc4c74`,
  );
  assert.deepEqual(abbrev(1951, savedSurvey('abcd')), [
    `<SAVEDSURVEYPOSITIONS ${HEADER.replace(/,/g, ' ')}`,
    '<     2 ',
    '<          "abcd" 11.50000000000 12.50000000000 13.5000 ',
    '<          "ABCd" 21.50000000000 22.50000000000 23.5000',
  ]);
});

// ---------------------------------------------------------------------------------------------
// WIFINETLIST (#2210): net_ap_info[] { ssid(STRING 33, variable), rssi(INT), channel(ULONG),
// bssid(STRING 18, variable), security(enum) }. Dense 0/33/37/41/59 (63); pack(4) 0/36/40/44/64.
// ---------------------------------------------------------------------------------------------
function wifiNet(ssid: string, bssid: string): Uint8Array {
  const ssidSize = stringSize(ssid);
  const bssidSize = stringSize(bssid);
  const stride = ssidSize + 4 + 4 + bssidSize + 4;
  const out = new Words(4 + 2 * stride);
  out.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    out.ascii(base, element === 0 ? ssid : `${ssid.slice(0, -1)}Z`);
    out.u32(base + ssidSize, 0x1000 + element); // rssi
    out.u32(base + ssidSize + 4, 0x2000 + element); // channel
    out.ascii(base + ssidSize + 8, element === 0 ? bssid : `${bssid.slice(0, -1)}@`);
    out.u32(base + ssidSize + 8 + bssidSize, element === 0 ? 1 : 2); // security
  }
  return out.bytes;
}

const WIFI_SSID = '01234567890123456789012345678901';

test('WIFINETLIST: two strings per element — 24 / 52 / 68 bytes', () => {
  const array = arrayOf(2210);
  assert.equal(array.stride, 63);
  assert.equal(packedStructSize(array.elements), 68);
  assert.deepEqual(walkArray(wifiNet('n0', 'zz-yy'), array, 0).starts, [4, 28]);
  assert.deepEqual(walkArray(wifiNet(WIFI_SSID, 'q'), array, 0).starts, [4, 56]);
  assert.deepEqual(walkArray(wifiNet(WIFI_SSID, 'AA-BB-CC-DD-EE-FF'), array, 0).starts, [4, 72]);
});

test('WIFINETLIST: the suite reads the second string from where the first one really ended', () => {
  assert.equal(
    ascii(2210, wifiNet('n0', 'zz-yy')),
    `#WIFINETLISTA,${HEADER};2,"n0",4096,8192,"zz-yy",OPEN,"nZ",4097,8193,"zz-y@",WPA*453c5e3f`,
  );
  assert.equal(
    ascii(2210, wifiNet(WIFI_SSID, 'AA-BB-CC-DD-EE-FF')),
    `#WIFINETLISTA,${HEADER};2,"${WIFI_SSID}",4096,8192,"AA-BB-CC-DD-EE-FF",OPEN,"${WIFI_SSID.slice(0, -1)}Z",4097,8193,"AA-BB-CC-DD-EE-F@",WPA*381b8957`,
  );
  assert.equal(
    ascii(2210, wifiNet(WIFI_SSID, 'q')),
    `#WIFINETLISTA,${HEADER};2,"${WIFI_SSID}",4096,8192,"q",OPEN,"${WIFI_SSID.slice(0, -1)}Z",4097,8193,"@",WPA*6d426e2a`,
  );
  assert.deepEqual(abbrev(2210, wifiNet(WIFI_SSID, 'q')), [
    `<WIFINETLIST ${HEADER.replace(/,/g, ' ')}`,
    '<     2 ',
    `<          "${WIFI_SSID}" 4096 8192 "q" OPEN `,
    `<          "${WIFI_SSID.slice(0, -1)}Z" 4097 8193 "@" WPA`,
  ]);
});
