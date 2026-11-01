/**
 * The A1 Configuration / Events / `.cfg` surface as the **browser** sees it: the real server on an
 * ephemeral port, the real endpoints, and the shipped ids in the answers.
 *
 * `config-host.test.ts` covers the adapter in-process; this file is the HTTP contract the drawer,
 * the Events page and the Device menu actually call.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in 20s\n${stderr}`)), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr}`));
    });
  });
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  base = `http://127.0.0.1:${await waitForReady(child)}`;
});

after(() => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    timer.unref();
  }
});

async function getText(path: string) {
  const response = await fetch(base + path);
  return { response, text: await response.text() };
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

/* ------------------------------------------------------------------ 1/12 the pages */

test('the page list serves the Configuration pages, the four menu pages and Events', async () => {
  const { response, text } = await getText('/api/config/pages');
  assert.equal(response.status, 200);
  const body = JSON.parse(text) as { pages: Array<{ name: string; label: string; operational: boolean }> };
  const names = body.pages.map((page) => page.name);
  assert.equal(body.pages.filter((page) => !page.operational).length, 18);
  assert.ok(names.includes('portConfig'));
  assert.ok(names.includes('deviceDetails'), 'Device ▸ Device Details is served by this build');
  assert.ok(names.includes('deviceExport'), 'Device ▸ Storage (§2.2.11) is served by this build');
  assert.ok(names.includes('deviceUpdate'), 'Device ▸ Update (§2.2.12) is served by this build');
  assert.ok(names.includes('vehicleSetup'), 'Settings ▸ Vehicle Setup (§2.2.7) is served by this build');
  assert.ok(names.includes('events'));
  const events = body.pages.find((page) => page.name === 'events');
  assert.equal(events?.label, 'Events');
  assert.equal(events?.operational, true);
});

test('/config/portConfig is 200 and carries the shipped Ports ids with a live row', async () => {
  const { response, text } = await getText('/config/portConfig');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  // The shipped fragment and its handlers.
  assert.match(text, /id="portConfiguration"/);
  assert.match(text, /id="desktop-portconfig-list"/);
  assert.match(text, /id="portConfig-apply"/);
  // The row the page's own render() builds (`getPortItem`), which is what makes the page usable
  // before any receiver record arrives: three dropdowns and the message box.
  assert.match(text, /class="row portconfig-item"/);
  assert.match(text, /class="message-text-area"/);
  assert.match(text, /data-portconfig-note="no-receiver"/);
  // The tab strip of the Manage tab is suppressed; this document is the page alone.
  assert.match(text, /#tabs > \.tabs-view-data \{ display: none !important; \}/);
  // The pane really is active, not a hidden shell.
  assert.match(text, /id="config-ports-tabs-2" class="totaldata active active-config"/);
});

test('every served page answers 200', async () => {
  const { text } = await getText('/api/config/pages');
  const names = (JSON.parse(text) as { pages: Array<{ name: string }> }).pages.map((page) => page.name);
  for (const name of names) {
    const response = await fetch(`${base}/config/${name}`);
    assert.equal(response.status, 200, `${name} responded ${response.status}`);
    const body = await response.text();
    assert.ok(body.includes(`data-config-page="${name}"`), `${name} is tagged for its event endpoint`);
  }
});

test('a click in the Ports page round-trips through /api/config/:page/event', async () => {
  // The drawer script posts every click this way; Apply must not throw and must not try to frame a
  // command when nothing changed.
  const { response, body } = await postJson('/api/config/portConfig/event', {
    selector: '#portConfig-apply',
    click: true,
  });
  assert.equal(response.status, 200);
  assert.equal(body.applied, true);
  assert.equal(body.commands, 0, 'apply with no changes frames nothing');
  assert.match(String(body.shell), /id="portConfig-apply"/);
});

test('an unknown config page is 404 and a non-POST event is refused', async () => {
  const missing = await fetch(`${base}/config/noSuchPage`);
  assert.equal(missing.status, 404);
  const wrongMethod = await fetch(`${base}/api/config/portConfig/event`);
  assert.equal(wrongMethod.status, 405);
});

/* ------------------------------------------------------------------ 3/12 Events */

test('/config/events serves the shipped Events drawer, slid in', async () => {
  const { response, text } = await getText('/config/events');
  assert.equal(response.status, 200);
  assert.match(text, /id="events-panel-tabs-2"/);
  assert.match(text, /id="events-menu-sidenav"/);
  // `showEvents` is the class the shipped CSS needs (`right:-330px` → `right:0`).
  assert.match(text, /events-sidenav showEvents/);
  assert.match(text, /current-events-layout/);
  assert.match(text, /No events present/i);
});

/* ------------------------------------------------------------------ 4/12 .cfg */

test('the Device status refuses both directions without a receiver and says why', async () => {
  const { response, text } = await getText('/api/config/device/status');
  assert.equal(response.status, 200);
  const body = JSON.parse(text) as {
    connected: boolean;
    export: { available: boolean; reason: string };
    import: { available: boolean; reason: string; previewAvailable: boolean };
    suggestedFileName: string;
  };
  assert.equal(body.connected, false);
  assert.equal(body.export.available, false);
  assert.equal(body.import.available, false);
  assert.equal(body.import.previewAvailable, true, 'parsing never needs a receiver');
  assert.match(body.export.reason, /receiver/i);
  assert.match(body.suggestedFileName, /\.cfg$/);
});

test('the .cfg parser returns the commands the loader would send', async () => {
  const cfg = [
    '/* VERSION 1 OEM729 R4.10 */',
    'FRESET',
    'SERIALCONFIG COM1 115200 N 8 1 N ON',
    'INTERFACEMODE COM2 NONE NONE OFF',
    'LOG COM1 BESTPOSB ONTIME 1',
    'SAVECONFIG',
    'RESET',
  ].join('\n');
  const { response, body } = await postJson('/api/config/device/import/preview', { text: cfg });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.commands, [
    'FRESET',
    'SERIALCONFIG COM1 115200 N 8 1 N ON',
    'INTERFACEMODE COM2 NONE NONE OFF',
    'LOG COM1 BESTPOSB ONTIME 1',
  ]);
  assert.equal(body.skipped, 3, 'the comment, SAVECONFIG and RESET are dropped by the loader');
  assert.equal(body.comments, 1);
  assert.deepEqual(body.mismatches, []);
});

test('the .cfg parser reports a version mismatch instead of hiding it', async () => {
  const { body } = await postJson('/api/config/device/import/preview', {
    text: '/* VERSION 1 OEM719 R4.00 */\nFRESET\n',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: 'R4.10' },
  });
  const mismatches = body.mismatches as string[];
  assert.ok(mismatches.includes('Hardware version'));
  assert.ok(mismatches.includes('Model'));
  assert.ok(mismatches.includes('Firmware version'));
});

test('export and import answer 409 with the reason while no receiver records exist', async () => {
  const download = await fetch(`${base}/api/config/device/export`);
  assert.equal(download.status, 409);
  const downloadBody = (await download.json()) as { ok: boolean; reason: string; records: number };
  assert.equal(downloadBody.ok, false);
  assert.equal(downloadBody.records, 0);
  assert.match(downloadBody.reason, /receiver/i);

  const applied = await postJson('/api/config/device/import', { text: 'FRESET\n' });
  assert.equal(applied.response.status, 409);
  assert.equal(applied.body.ok, false);
  assert.equal(applied.body.sent, 0);
  assert.equal(applied.body.verified, false);
  assert.match(String(applied.body.reason), /receiver/i);
});

/* ------------------------------------------------- Settings ▸ General / Networking */

test('the page list marks the Settings pages apart from the Configuration pills', async () => {
  const { text } = await getText('/api/config/pages');
  const body = JSON.parse(text) as {
    pages: Array<{ name: string; label: string; operational: boolean; settings: boolean }>;
  };
  const settings = body.pages.filter((page) => page.settings).map((page) => page.name);
  assert.ok(settings.includes('generalSettings'), 'General is listed as a Settings page');
  assert.ok(settings.includes('networkingSettings'), 'so is Networking');
  assert.equal(settings.includes('portConfig'), false, 'the pill pages are not');
  assert.ok(settings.includes('deviceDetails'), 'Device Details is a menu page too');
  const general = body.pages.find((page) => page.name === 'generalSettings');
  assert.equal(general?.label, 'General');
  const networking = body.pages.find((page) => page.name === 'networkingSettings');
  assert.equal(networking?.label, 'Networking');
  assert.equal(networking?.settings, true);
  const details = body.pages.find((page) => page.name === 'deviceDetails');
  assert.equal(details?.label, 'Device Details');
  /* §2.2.7 / §2.2.11 / §2.2.12: the three pages this build added, with the menu each one hangs in. */
  const vehicle = body.pages.find((page) => page.name === 'vehicleSetup');
  assert.equal(vehicle?.label, 'Vehicle Setup');
  assert.equal(vehicle?.settings, true);
  const storage = body.pages.find((page) => page.name === 'deviceExport');
  assert.equal(storage?.label, 'Storage', 'the module is deviceExport, the window is Storage');
  assert.equal(storage?.settings, true);
  const update = body.pages.find((page) => page.name === 'deviceUpdate');
  assert.equal(update?.label, 'Update');
  assert.equal(update?.settings, true);
  assert.equal(
    body.pages.filter((page) => !page.operational).length,
    18,
    'fourteen pills plus Device Details, Storage, Update and Vehicle Setup',
  );
});

test('/config/generalSettings serves the shipped General page alone, and says there is no session', async () => {
  const { response, text } = await getText('/config/generalSettings');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(text, /data-config-page="generalSettings"/);
  // The menu layout `createMenuComponents` builds, shown (`.menu-layouts` ships `display:none`).
  assert.match(text, /<div id="generalSettings-layout_tabs-2" class="menu-layouts" style="display: block">/);
  assert.match(text, /id="general-settings"/);
  assert.match(text, /class="height-selection-list selector-positioning"/);
  assert.match(text, /id="Ellipsoidal"/);
  assert.match(text, /class="btn btn-default darkBtn general-settings-apply"/);
  // The words the reader sees (the fragment itself is only `data-lang-*` markers).
  assert.match(text, />General</);
  assert.match(text, />Height</);
  assert.match(text, />Ellipsoidal</);
  // Not the whole Manage tab: the Configuration panes stay out of this document.
  assert.doesNotMatch(text, /id="config-ports-tabs-2"/);
  assert.match(text, /id="config-session-note"/, 'the missing session is stated in the page');
});

test('/config/networkingSettings serves the shipped Networking controls', async () => {
  const { response, text } = await getText('/config/networkingSettings');
  assert.equal(response.status, 200);
  assert.match(text, /<div id="networkingSettings-layout_tabs-2" class="menu-layouts" style="display: block">/);
  assert.match(text, /id="networking-details"/);
  assert.match(text, /id="networking-accordion"/);
  assert.match(text, /class="input-text-box ipaddress ethernet-input"/);
  assert.match(text, /id="dhcp-on-off"/);
  assert.match(text, /class="btn btn-default darkBtn ethernet-applyBtn"/);
  assert.match(text, /id="hotspot-applyBtn"/);
  assert.match(text, />Networking</);
  assert.match(text, />IP Address</);
  assert.doesNotMatch(text, /id="config-pos-tabs-2"/);
});

test('a change in a Settings page reaches the controller, and the dropped command is named', async () => {
  // Typing into the address field records a pending value on the page…
  const typed = await postJson('/api/config/networkingSettings/event', {
    selector: '#networkingSettings-layout_tabs-2 .ipaddress',
    value: '10.0.0.5',
  });
  assert.equal(typed.response.status, 200);
  assert.equal(typed.body.applied, true);
  assert.equal(typed.body.commands, 0, 'typing frames nothing yet');
  // …and Apply frames the shipped IPCONFIG + SAVEETHERNETDATA pair. No session is open, so the
  // two commands are dropped — and the answer says so in words the page can print.
  const applied = await postJson('/api/config/networkingSettings/event', {
    selector: '#networkingSettings-layout_tabs-2 .ethernet-applyBtn',
    click: true,
  });
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.commands, 2);
  assert.equal(applied.body.sent, 0);
  assert.match(String(applied.body.note), /no live receiver session/i);
  assert.match(String(applied.body.note), /2 command\(s\)/);
});

/* ------------------------------------------------------------------ the menu wiring */

test('the panel script ships the Configuration drawer and the Device submenu', async () => {
  const { response, text } = await getText('/panels/manage.js');
  assert.equal(response.status, 200);
  assert.match(text, /mg-config-frame/, 'the drawer iframe is in the panel');
  assert.match(text, /data-submenu/, 'Tools ▸ Device is a nested flyout');
  assert.match(text, /key: 'configuration'[\s\S]{0,80}wired: true/, 'Configuration is wired');
  assert.match(text, /\/api\/config\/pages/, 'the page list comes from the API');
  assert.match(text, /\/api\/config\/device\/status/, 'the .cfg buttons read the server reason');
  // Settings is wired now: its two entries open the drawer on the shipped page they name.
  assert.match(text, /key: 'settings'[\s\S]{0,120}wired: true/, 'Settings is wired');
  assert.match(text, /label: 'General…'/, 'Settings ▸ General… exists');
  assert.match(text, /label: 'Networking…'/, 'Settings ▸ Networking… exists');
  assert.match(text, /SETTINGS_PAGES\.has\(key\)/, 'the two entries open the drawer');
});
