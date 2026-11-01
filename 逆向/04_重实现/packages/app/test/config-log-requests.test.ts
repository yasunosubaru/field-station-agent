/**
 * What each configuration page asks the receiver for, and what this build must therefore send when
 * the page is opened (`server.ts#primeConfigurationPage` → `configLogRequests`).
 *
 * The lists are the shipped controller's `requiredLogs` table; these assertions exist because two
 * pages had **no entry at all** (`gnssConfig`, `networkingSettings`), so opening them sent zero
 * `LOG` lines and the page could only ever be empty. Names are checked against what the desk OEM729
 * really answers (2026-11-01, COM10 = receiver USB2): a name this model refuses is a name that must
 * not be requested.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigHost } from '../src/config-host.ts';
import { configLogRequests } from '../src/config-http.ts';

const here = dirname(fileURLToPath(import.meta.url));

function appRoot(): string {
  let directory = resolve(here, '../../..');
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, '01_解包', 'app', 'view');
    if (existsSync(candidate)) return join(directory, '01_解包', 'app');
    directory = resolve(directory, '..');
  }
  throw new Error('01_解包/app not found above ' + here);
}

const options = () => ({
  appRoot: appRoot(),
  dataDir: join(here, '..', '..', 'protocol', 'data'),
});

test('gnssConfig requests the two records it reads', () => {
  const host = new ConfigHost(options());
  assert.deepEqual(
    host.requiredLogs('gnssConfig').map((request) => request.name),
    ['ELEVATIONCUTOFF', 'PPSCONTROL'],
  );
  // Asked for as binary records, once each: `decodeEdie` reads `B`, and `ONCE` leaves no stream
  // behind on the receiver.
  assert.deepEqual(configLogRequests('gnssConfig'), [
    'LOG ELEVATIONCUTOFFB ONCE',
    'LOG PPSCONTROLB ONCE',
  ]);
});

test('networkingSettings requests IPCONFIG/DNSCONFIG, never the WiFi logs this model rejects', () => {
  const host = new ConfigHost(options());
  const names = host.requiredLogs('networkingSettings').map((request) => request.name);
  assert.ok(names.includes('IPCONFIG'), 'the address/mask/gateway/DHCP record');
  assert.ok(names.includes('DNSCONFIG'), 'the DNS box');
  assert.ok(names.includes('IPSTATUS'));
  // Measured on the desk OEM729: these answer `<ERROR:Message is invalid for this model`, so asking
  // for them would only put errors on the link.
  for (const refused of ['WIFIMODE', 'WIFISTATUS', 'WIFIAPSETTINGS']) {
    assert.equal(names.includes(refused), false, `${refused} is not requested`);
  }
  const lines = configLogRequests('networkingSettings');
  assert.deepEqual(lines.slice(0, 2), ['LOG IPCONFIGB ONCE', 'LOG DNSCONFIGB ONCE']);
  assert.equal(new Set(lines).size, lines.length, 'no line is requested twice');
});

test('deviceDetails requests the records it fills its tables from', () => {
  const host = new ConfigHost(options());
  const names = host.requiredLogs('deviceDetails').map((request) => request.name);
  for (const wanted of ['VERSION', 'MODELFEATURES', 'CHANCONFIGLIST', 'VALIDMODELS', 'AUTHCODES']) {
    assert.ok(names.includes(wanted), `${wanted} is requested`);
  }
  const lines = configLogRequests('deviceDetails');
  assert.ok(lines.includes('LOG VERSIONB ONCE'));
  assert.ok(lines.includes('LOG MODELFEATURESB ONCE'));
  assert.ok(lines.includes('LOG CHANCONFIGLISTB ONCE'));
});

test('every page that has a request table asks in the one wire form this build sends', () => {
  const host = new ConfigHost(options());
  for (const page of host.pageNames()) {
    for (const line of configLogRequests(page)) {
      assert.match(line, /^LOG [A-Z0-9_]+B ONCE$/, `${page}: ${line}`);
    }
  }
});
