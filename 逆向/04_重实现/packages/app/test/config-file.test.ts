/**
 * The `.cfg` pair behind `Tools ▸ Device` (A1 item 4/12).
 *
 * The two halves are deliberately asymmetric and the tests say so:
 *  - **generate** works whenever the link holds the receiver's own configuration records: the file
 *    is built with `configurationFile.ts#transformSavedConfigLines`, the same function the desktop
 *    save flow calls;
 *  - **load** parses any `.cfg` (`filterLoadCommands` + `versionMismatch`) but refuses to write,
 *    because the read-back verification needs command responses this app's live link does not
 *    surface. A refused write is asserted, not a silent one.
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

test('import parses but refuses to write without a verifiable read-back', () => {
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

  const offline = deviceImportApply(cfg, false);
  assert.equal(offline.ok, false);
  assert.equal(offline.sent, 0);
  assert.match(offline.reason, /receiver/i);

  const online = deviceImportApply(cfg, true);
  assert.equal(online.ok, false, 'the write is refused, not half-applied');
  assert.equal(online.sent, 0);
  assert.equal(online.verified, false);
  assert.match(online.reason, /read-back|verif/i);
  assert.equal(online.preview.commands.length, 1, 'the parse is still reported');
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
