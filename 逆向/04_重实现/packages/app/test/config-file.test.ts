/**
 * The `.cfg` pair behind `Tools ▸ Device` (A1 item 4/12).
 *
 * The two halves are deliberately asymmetric and the tests say so:
 *  - **generate** works whenever the link holds the receiver's own configuration records: the file
 *    is built with `configurationFile.ts#transformSavedConfigLines`, the same function the desktop
 *    save flow calls;
 *  - **load** parses any `.cfg` (`filterLoadCommands` + `versionMismatch`) and then writes it only
 *    over a real command-response channel, one line at a time, with a read-back. Called without
 *    one — as below — it still refuses; the full flow is `cfg-import.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCfgFromTranscript,
  configFiles,
  countConfigurationRecords,
  deviceExportFile,
  deviceImportApply,
  deviceImportPreview,
  deviceStatus,
} from '../src/config-http.ts';
import { chooseIOPortDetails } from '../../view/src/config/configurationFile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORTS = chooseIOPortDetails('OEM729', 'OEM729', 'OEM729', false);

/** Full-ASCII `RXCONFIGA` records, the shape the suite's save flow consumes. */
const RXCONFIG = [
  '<RXCONFIGA,COM1,0,53.5,FINESTEERING,2287,137888.000,02000020,4b5f,1682;INTERFACEMODE COM1 NOVATEL NOVATEL ON*11223344',
  '<RXCONFIGA,COM1,0,53.5,FINESTEERING,2287,137889.000,02000020,4b5f,1683;SERIALCONFIG COM1 115200 N 8 1 N ON*22334455',
  '<RXCONFIGA,COM1,0,53.5,FINESTEERING,2287,137890.000,02000020,4b5f,1684;INTERFACEMODE COM9 NOVATEL NOVATEL ON*33445566',
];

/**
 * The desk OEM729's own shape (measured 2026-11-01, USB2/COM10): the statement name lives in a
 * nested header and the arguments are comma-separated. Taking the text after the last `;` used to
 * hand `transformSavedConfigLines` a nameless `COM1,9600,…` and the file came out empty.
 */
const RXCONFIG_WIRE = [
  '#RXCONFIGA,SPECIAL,268,68.0,SATTIME,0,0.000,03801800,f702,18278;' +
    '#SERIALCONFIGA,SPECIAL,268,68.0,SATTIME,0,0.000,03801800,6be8,18278;COM1,9600,N,8,1,N,ON*80f21651',
  '#RXCONFIGA,SPECIAL,270,68.0,SATTIME,0,0.000,03801800,f702,18278;' +
    '#ELEVATIONCUTOFFA,SPECIAL,270,68.0,SATTIME,0,0.000,03801800,50e0,18278;GLONASS,5.0,0*f46f6f34*f48f48c2',
  '#RXCONFIGA,SPECIAL,262,68.0,SATTIME,0,0.000,03801800,f702,18278;' +
    '#LOCKOUTSYSTEMA,SPECIAL,262,68.0,SATTIME,0,0.000,03801800,a6f7,18278;NAVIC*4b5ede34*6f61b52d',
  '#RXCONFIGA,SPECIAL,56,68.0,SATTIME,0,0.000,03801800,f702,18278;' +
    '#ICOMCONFIGA,SPECIAL,56,68.0,SATTIME,0,0.000,03801800,1faa,18278;ICOM1,TCP,":2000",ALL*9cb339a2',
];

test('a .cfg is generated from the receiver records the link holds', () => {
  const entries = RXCONFIG.map((ascii) => ({ name: 'RXCONFIG', ascii }));
  assert.equal(countConfigurationRecords(entries), 3);

  const file = buildCfgFromTranscript(entries, PORTS, 'OEM729_2026-11-01_10-00-00.cfg');
  assert.equal(file.ok, true, file.reason);
  assert.equal(file.fileName, 'OEM729_2026-11-01_10-00-00.cfg');
  assert.equal(file.records, 3);
  const text = file.text ?? '';
  assert.match(text, /^INTERFACEMODE COM1 NOVATEL NOVATEL ON$/m, 'the command is unwrapped from the header');
  assert.match(text, /^SERIALCONFIG COM1 115200 N 8 1 N ON$/m);
  // `COM9` is not one of the OEM729's ports, so `isAllowedPort` drops it — as the desktop flow does.
  assert.equal(/COM9/.test(text), false);
  assert.ok(text.endsWith('\n'));
});

test('the desk receiver’s nested, comma-separated records become real .cfg lines', () => {
  const entries = RXCONFIG_WIRE.map((ascii) => ({ name: 'RXCONFIG', ascii }));
  assert.equal(countConfigurationRecords(entries), 4);
  const file = buildCfgFromTranscript(entries, PORTS, 'wire.cfg');
  assert.equal(file.ok, true, file.reason);
  const text = file.text ?? '';
  assert.match(text, /^SERIALCONFIG COM1 9600 N 8 1 N ON$/m, 'name from the nested header, commas to spaces');
  assert.match(text, /^ELEVATIONCUTOFF GLONASS 5\.0 0$/m);
  assert.match(text, /^LOCKOUTSYSTEM NAVIC$/m, 'a single, comma-less argument keeps its command name');
  assert.match(
    text,
    /^ICOMCONFIG ICOM1 TCP ":2000" ALL$/m,
    'the ported two-line lookahead must not swallow the next statement',
  );

  // And the file it wrote is a file the loader can read back (the round trip the buttons promise).
  const parsed = deviceImportPreview(text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.ok(parsed.commands.includes('SERIALCONFIG COM1 9600 N 8 1 N ON'));
  assert.ok(parsed.commands.includes('ELEVATIONCUTOFF GLONASS 5.0 0'));
});

test('records that are not configuration logs never become a .cfg', () => {
  const entries = [
    { name: 'BESTPOS', ascii: '<BESTPOSA,COM1,0,53.5,FINESTEERING,2287,1.0,...;SOL_COMPUTED' },
    { name: 'RXSTATUSEVENT', ascii: '#RXSTATUSEVENTA,COM1,0,53.5,FINESTEERING,2287,1.0,...;"ERROR",1,1,0,0*00' },
  ];
  assert.equal(countConfigurationRecords(entries), 0);
  const file = buildCfgFromTranscript(entries, PORTS, 'x.cfg');
  assert.equal(file.ok, false);
  assert.equal(file.records, 0);
  assert.match(String(file.reason), /no configuration record/i);
});

test('deviceExportFile serves a file the save driver assembled, and refuses without one', () => {
  configFiles.reset();
  const empty = deviceExportFile([]);
  assert.equal(empty.ok, false, 'nothing to download yet');

  configFiles.writeText('/NovAtelData/Download Configuration/PSN1_2026-11-01_10-00-00.cfg', 'FRESET\n');
  const assembled = deviceExportFile([]);
  assert.equal(assembled.ok, true);
  assert.equal(assembled.fileName, 'PSN1_2026-11-01_10-00-00.cfg');
  assert.equal(assembled.text, 'FRESET\n');
  configFiles.reset();
});

test('the export gate opens only when the link holds configuration records', () => {
  configFiles.reset();
  const offline = deviceStatus(false, []);
  assert.equal(offline.export.available, false);
  assert.equal(offline.export.records, 0);
  assert.match(offline.export.reason, /receiver/i);

  const onlineNoRecords = deviceStatus(true, []);
  assert.equal(onlineNoRecords.export.available, false);
  assert.match(onlineNoRecords.export.reason, /LOG RXCONFIG/);

  const withRecords = deviceStatus(true, RXCONFIG.map((ascii) => ({ name: 'RXCONFIG', ascii })));
  assert.equal(withRecords.export.available, true);
  assert.equal(withRecords.export.records, 3);
  assert.match(withRecords.export.reason, /3 receiver configuration record/);
});

test('import parses but refuses to write without a verifiable read-back', async () => {
  const cfg = [
    '/* VERSION 1 OEM729 R4.10 */',
    'SERIALCONFIG COM2 9600 N 8 1 N ON',
    'SAVECONFIG',
    'RESET',
  ].join('\n');
  const preview = deviceImportPreview(cfg, {
    hardwareVersion: 'OEM729',
    model: 'OEM729',
    softwareVersion: 'R4.10',
  });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.commands, ['SERIALCONFIG COM2 9600 N 8 1 N ON']);

  const offline = await deviceImportApply(cfg, false);
  assert.equal(offline.ok, false);
  assert.equal(offline.sent, 0);
  assert.match(offline.reason, /receiver/i);

  // No command-response channel on the call: the write is refused, not half-applied.
  const online = await deviceImportApply(cfg, true);
  assert.equal(online.ok, false, 'the write is refused, not half-applied');
  assert.equal(online.sent, 0);
  assert.equal(online.verified, false);
  assert.match(online.reason, /read-back|verif/i);
  assert.equal(online.preview.commands.length, 1, 'the parse is still reported');
  assert.deepEqual(online.steps, [], 'nothing was sent');
});

test('a generated .cfg parses back to the commands it was built from', () => {
  // Round trip: generate from the receiver records, then read the file back with the loader's own
  // filter. A file the app writes must be a file the app can load.
  const entries = RXCONFIG.map((ascii) => ({ name: 'RXCONFIG', ascii }));
  const file = buildCfgFromTranscript(entries, PORTS, 'round-trip.cfg');
  assert.equal(file.ok, true);
  const parsed = deviceImportPreview(file.text ?? '');
  assert.equal(parsed.ok, true);
  assert.ok(parsed.commands.includes('INTERFACEMODE COM1 NOVATEL NOVATEL ON'));
  assert.ok(parsed.commands.includes('SERIALCONFIG COM1 115200 N 8 1 N ON'));
  assert.equal(parsed.commands.some((line) => line.includes('COM9')), false);
});
