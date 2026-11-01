/**
 * Element `stride` and member offsets for the four counted-array logs that no capture contains:
 * `SBAS17` (dense 30 → 32), `ETHSTATUS` (26 → 28), `SAVEDSURVEYPOSITIONS` (29 → 32),
 * `WIFINETLIST` (63 → 68).
 *
 * Every sample these four ever produced had `count = 1` (ETHSTATUS: 15 records, all 32 B, all
 * byte-identical), and with one element "28-byte struct" and "26 bytes + 2 spare" cannot be told
 * apart. So each case here is a **synthetic** `count ≥ 2` frame whose values sit at the offsets our
 * model claims, handed to the installed suite's own Convert (`oracle.ts`). Every payload is built so
 * that a *different* model reads zeros or a neighbour instead, and then the two lines differ — the
 * comparison is a yes/no answer, not a round number.
 *
 * What the cases separate:
 *
 *  - `SBAS17` has no string members: is `x` read at the dense 6 or at the `pack(4)` 8, and are the
 *    elements 30 or 32 bytes apart? `count = 1` answers the first half on its own; the second
 *    element of the second half only exists at `count ≥ 2`. `t0` sits behind the array, so its
 *    position also tests the array's total size.
 *  - the other three carry a `variable` `STRING` inside the element, and two rules are possible:
 *    a fixed C struct (members at `pack(4)` offsets, elements `sizeof` apart) or re-walking the
 *    string's real bytes (the next member starts where the string ended, the element is as long as
 *    its content). A **short** string separates them; a full-width one makes both agree, which is
 *    why every real record matched either way.
 *  - `WIFINETLIST` holds **two** strings, so it also checks that the second one's drift is measured
 *    from where the first one ended, not from the dictionary's dense offsets (that is the case that
 *    was wrong before this round: the shift was added once per member instead of once per string).
 *
 *   node 逆向/tools/oracle-stride-sentinels.ts     # exit code 0 = every case byte-identical
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { packedStructSize, type EdieArray, type EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { Payload, frame, oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

function ours(input: Uint8Array): { ascii: string[]; abbrev: string[] } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const one = (format: 'ASCII' | 'ABBREV_ASCII'): string[] => {
    const text = convertFrames(frames, { format, at, tables, name: 'probe.sbf' }).files[0]?.text ?? '';
    return text.split('\r\n').filter(Boolean);
  };
  return { ascii: one('ASCII'), abbrev: one('ABBREV_ASCII') };
}

let failures = 0;

function run(label: string, id: number, payload: Uint8Array, note: string): void {
  const input = frame(id, payload);
  const result = oracle(input, label);
  const mine = ours(input);
  const suiteAscii = result.ascii.join('\r\n');
  const suiteAbbrev = result.abbrev.join('\r\n');
  const ok = suiteAscii === mine.ascii.join('\r\n') && suiteAbbrev === mine.abbrev.join('\r\n');
  if (!ok) failures += 1;
  console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${label}  (payload ${payload.length} B) — ${note}`);
  for (const line of result.ascii) console.log(`  suite       ${JSON.stringify(line)}`);
  for (const line of mine.ascii) console.log(`  ours        ${JSON.stringify(line)}`);
  for (const line of result.abbrev) console.log(`  suiteABBREV ${JSON.stringify(line)}`);
  if (!ok) console.log(`  oursABBREV  ${JSON.stringify(mine.abbrev.join('\r\n'))}`);
}

/** Bytes a `variable` STRING spends: up to its NUL, padded to 4; at least four. */
const stringSize = (text: string): number => Math.max(4, Math.ceil((text.length + 1) / 4) * 4);

// ---------------------------------------------------------------------------------------------
// SBAS17 (#980): prn(ULONG) + items[] { data_id, prn_3, health (USHORT), x, y, z, x_vel, y_vel,
// z_vel (LONG) } + t0(behind the array). Dense members 0/2/4/6/10/14/18/22/26 (30),
// pack(4) → 0/2/4/8/12/16/20/24/28 (32). Values are `1000 * element + 10 * member`.
// ---------------------------------------------------------------------------------------------
function sbas17(count: number): Uint8Array {
  const payload = new Payload(8 + count * 32 + 4);
  payload.u32(0, 0x51ab); // prn
  payload.u32(4, count);
  for (let element = 0; element < count; element += 1) {
    const base = 8 + element * 32;
    const v = (member: number): number => 1000 * (element + 1) + 10 * member;
    payload.u16(base, v(1));
    payload.u16(base + 2, v(2));
    payload.u16(base + 4, v(3));
    for (let member = 4; member <= 9; member += 1) payload.u32(base + 8 + (member - 4) * 4, v(member));
  }
  payload.u32(8 + count * 32, 0x51ab); // t0, right behind the elements
  return payload.bytes;
}

run('SBAS17 count=1', 980, sbas17(1), 'members at pack(4): x at 8, not the dense 6; t0 at 8+32');
run('SBAS17 count=2', 980, sbas17(2), 'elements 32 apart (dense says 30); t0 at 8+64');
run('SBAS17 count=3', 980, sbas17(3), 'stride repeats');

// ---------------------------------------------------------------------------------------------
// ETHSTATUS (#1288): eth_status[] { interface(enum), mac_address(STRING 18, variable),
// interface_config(enum) }. Dense 0/4/22 (26), pack(4) 0/4/24 (28).
// ---------------------------------------------------------------------------------------------
function ethStatus(mac: (element: number) => string): Uint8Array {
  const size = stringSize(mac(0));
  const stride = 4 + size + 4; // interface + string + config, no padding behind a re-walked string
  const payload = new Payload(4 + 2 * stride);
  payload.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    payload.u32(base, element === 0 ? 2 : 3); // ETHA / ETHB
    payload.ascii(base + 4, mac(element));
    payload.u32(base + 4 + size, element === 0 ? 4 : 5); // 100_FULL / 100_HALF
  }
  return payload.bytes;
}

run('ETHSTATUS count=2, 17-char MACs', 1288,
  ethStatus((element) => (element === 0 ? 'AA-BB-CC-DD-EE-FF' : '11-22-33-44-55-66')),
  'full width: the string takes 20 B, so 28 B per element = the dictionary stride plus pack(4)');
run('ETHSTATUS count=2, 2-char MACs', 1288,
  ethStatus((element) => (element === 0 ? 'a0' : 'b0')),
  'short: the element is content-sized (12 B), so is the stride');

// ---------------------------------------------------------------------------------------------
// SAVEDSURVEYPOSITIONS (#1951): positions[] { id(STRING 5, variable), latitude, longitude,
// height (DOUBLE) }. Dense 0/5/13/21 (29), pack(4) 0/8/16/24 (32).
// ---------------------------------------------------------------------------------------------
function savedSurvey(id: string): Uint8Array {
  const idSize = stringSize(id);
  const stride = idSize + 24;
  const payload = new Payload(4 + 2 * stride);
  payload.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    payload.ascii(base, element === 0 ? id : `${id.slice(0, -1).toUpperCase()}${id.slice(-1)}`);
    const value = element === 0 ? 11.5 : 21.5;
    payload.f64(base + idSize, value);
    payload.f64(base + idSize + 8, value + 1);
    payload.f64(base + idSize + 16, value + 2);
  }
  return payload.bytes;
}

run('SAVEDSURVEYPOSITIONS count=2, 1-char ids', 1951, savedSurvey('a'),
  'id 4 B: latitude at +4, so 28 B per element');
run('SAVEDSURVEYPOSITIONS count=2, 4-char ids', 1951, savedSurvey('abcd'),
  'id 8 B: latitude at +8, so 32 B per element — the dictionary stride');

// ---------------------------------------------------------------------------------------------
// WIFINETLIST (#2210): net_ap_info[] { ssid(STRING 33, variable), rssi(INT), channel(ULONG),
// bssid(STRING 18, variable), security(enum) }. Dense 0/33/37/41/59 (63), pack(4) 0/36/40/44/64 (68).
// ---------------------------------------------------------------------------------------------
function wifiNet(ssid: string, bssid: string): Uint8Array {
  const ssidSize = stringSize(ssid);
  const bssidSize = stringSize(bssid);
  const stride = ssidSize + 4 + 4 + bssidSize + 4;
  const payload = new Payload(4 + 2 * stride);
  payload.u32(0, 2);
  for (const [element, base] of [[0, 4], [1, 4 + stride]] as const) {
    payload.ascii(base, element === 0 ? ssid : `${ssid.slice(0, -1)}Z`);
    payload.u32(base + ssidSize, 0x1000 + element); // rssi
    payload.u32(base + ssidSize + 4, 0x2000 + element); // channel
    payload.ascii(base + ssidSize + 8, element === 0 ? bssid : `${bssid.slice(0, -1)}@`);
    payload.u32(base + ssidSize + 8 + bssidSize, element === 0 ? 1 : 2); // security
  }
  return payload.bytes;
}

run('WIFINETLIST count=2, 2-char SSID/BSSID', 2210, wifiNet('n0', 'zz-yy'),
  'content walk: 4 + 4 + 4 + 8 + 4 = 24 B per element');
run('WIFINETLIST count=2, full SSID and BSSID', 2210,
  wifiNet('01234567890123456789012345678901', 'AA-BB-CC-DD-EE-FF'),
  'full width: 36 + 4 + 4 + 20 + 4 = 68 B = the dictionary stride plus pack(4)');
run('WIFINETLIST count=2, full SSID, 1-char BSSID', 2210,
  wifiNet('01234567890123456789012345678901', 'q'),
  'the second string is 4 B, so 52 B per element: its drift is measured from where it really starts');

const geometry = ['980', '1288', '1951', '2210'].map((id) => {
  const layout = tables.messages[id]!;
  const array = layout.fields.find((segment) => segment.kind === 'array') as EdieArray;
  return `${layout.name.padEnd(21)} dense element ${array.stride} → pack(4) ${packedStructSize(array.elements)}`;
});
console.log(`\n${geometry.join('\n')}`);
console.log(failures === 0 ? '\nevery case is byte-identical to the suite' : `\n${failures} mismatch(es)`);
process.exitCode = failures === 0 ? 0 : 1;
