/**
 * The three pages the Manage drawer was missing: **Vehicle Setup** (§2.2.7), **Storage** (§2.2.11)
 * and **Update** (§2.2.12).
 *
 * What this pins:
 *
 *   1. all three are in the served page list, with the label and the menu each one belongs to;
 *   2. each one mounts from the *shipped* fragment (original ids, not a redrawn form);
 *   3. Vehicle Setup asks the receiver for **nothing** — the manual says its dimensions only scale
 *      the drawing, so the page writes to the user store and `requiredLogs` is empty;
 *   4. Update is served **read-only**: Browse and Apply are `disabled` in the document, the note
 *      that says why is in the page, and `takeCommands()` refuses any SOFTLOAD frame the page still
 *      manages to queue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ALL_PAGE_NAMES, ConfigHost, READ_ONLY_PAGES } from '../src/config-host.ts';
import { CONFIG_LABELS, configPageList } from '../src/config-http.ts';
import { DEVICE_PAGES, SETTINGS_PAGES } from '../src/web/panels/manage.js';

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

const PAGES = [
  {
    name: 'vehicleSetup',
    label: 'Vehicle Setup',
    menu: 'Settings',
    container: 'vehicleSetup-layout_tabs-2',
    /* The §2.2.7 screen *is* `spanInstallation.html`; its own root id comes from that fragment. */
    root: 'id="spanInstallation"',
  },
  { name: 'deviceExport', label: 'Storage', menu: 'Device', container: 'deviceExport-layout_tabs-2', root: 'id="export-device"' },
  { name: 'deviceUpdate', label: 'Update', menu: 'Device', container: 'deviceUpdate-layout_tabs-2', root: 'id="update-device"' },
];

test('the three pages are served, labelled and filed under the right menu', () => {
  const list = configPageList();
  for (const page of PAGES) {
    assert.ok(
      (ALL_PAGE_NAMES as readonly string[]).includes(page.name),
      `${page.name} is in the served catalogue`,
    );
    const entry = list.find((item) => item.name === page.name);
    assert.ok(entry, `${page.name} is in /api/config/pages`);
    assert.equal(entry?.label, page.label);
    assert.equal(CONFIG_LABELS[page.name], page.label);
    assert.equal(entry?.operational, false, 'a menu page, not an operational one');
    assert.equal(entry?.settings, true, 'the drawer files menu pages under settings');
    // The drawer's own split: Settings for §2.2.7, Device for §2.2.11 / §2.2.12.
    assert.equal(SETTINGS_PAGES.has(page.name), page.menu === 'Settings', page.name);
    assert.equal(DEVICE_PAGES.has(page.name), page.menu === 'Device', page.name);
  }
});

test('each page mounts from its shipped fragment, in its own menu-layout container', () => {
  for (const page of PAGES) {
    const host = new ConfigHost(options());
    const shown = host.show(page.name);
    assert.equal(shown.mounted, true, `${page.name} mounts on first use`);
    assert.match(shown.html, new RegExp(`id="${page.container}"`), `${page.container} exists`);
    assert.match(shown.html, new RegExp(page.root), `${page.name} fragment came through`);
    assert.equal(host.readOnlyRefusals(), 0);
  }
});

test('Vehicle Setup is the §2.2.7 screen: vehicle types, dimensions and RP location', () => {
  const host = new ConfigHost(options());
  const { html } = host.show('vehicleSetup');
  // The shipped `spanInstallation.html` is the Vehicle Setup screen; these are its own ids.
  assert.match(html, /id="maxHeight"/);
  assert.match(html, /id="maxWidth"/);
  assert.match(html, /id="maxLength"/);
  assert.match(html, /id="baseLine"/);
  assert.match(html, /id="TBDLine"/);
  assert.match(html, /id="rearLine"/);
  assert.match(html, /id="vehicleSetup-spanConfig-link"/);
  assert.match(html, /data-lang-maxheight/);
});

test('Vehicle Setup asks the receiver for no records at all (its fields are local by the manual)', () => {
  const host = new ConfigHost(options());
  assert.deepEqual(host.requiredLogs('vehicleSetup'), [], 'no LOG … ONCE is requested');
  const { html } = host.show('vehicleSetup');
  // Nothing is fed, so nothing is claimed: the six inputs start empty, not at a default 0.
  for (const id of ['maxHeight', 'maxWidth', 'maxLength', 'baseLine', 'TBDLine', 'rearLine']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>`, 'i'), `${id} is an input, not a value`);
  }
  assert.equal(host.manage.configs.vehicleSetup.name, 'vehicleSetup');
});

test('Storage is the shipped deviceExport window: active log file, available files, the three actions', () => {
  const host = new ConfigHost(options());
  const { html } = host.show('deviceExport');
  assert.match(html, /id="active-log-name"/);
  assert.match(html, /id="active-log-size"/);
  assert.match(html, /available-logs-list/);
  assert.match(html, /download-image-btn/);
  assert.match(html, /usb-image-btn/);
  assert.match(html, /delete-image-btn/);
});

test('Storage hides the shipped sample row instead of presenting LOG_9898 / 72 KB as content', () => {
  // `deviceExport.html` ships a filled-in active-log row (`LOG_9898`, `72 KB`) as a *layout sample*.
  // `DeviceExportPage.mount` hides that block; if the hide ever goes away the page shows mock text
  // where a measured file name belongs, so this pins it.
  const host = new ConfigHost(options());
  const { html } = host.show('deviceExport');
  const block = /<div class="active-log-layout[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(block, /display: none/, 'the sample active-log block stays hidden');
});

test('Storage says the model has no storage instead of letting "No log files found" imply an empty disk', () => {
  const host = new ConfigHost(options());
  const { html } = host.show('deviceExport');
  assert.match(html, /id="config-unsupported-note"[^>]*>No storage on this model/);
  assert.match(html, /FILESTATUS \(#2127\)` answers &lt;ERROR:Message is invalid/);
  // The three actions need a receiver and a mounted device: they are disabled, not merely empty.
  for (const cls of ['download-image-btn', 'usb-image-btn', 'delete-image-btn']) {
    assert.match(html, new RegExp(`class="${cls}"[^>]*disabled|${cls}[^>]*disabled`), cls);
  }
});

test('Update is served read-only: both doors disabled, the reason in the page, no SOFTLOAD frame', () => {
  const host = new ConfigHost(options());
  const { html } = host.show('deviceUpdate');
  assert.match(html, /id="deviceUpdateApplyBtn"[^>]*disabled/, 'Apply is disabled');
  assert.match(html, /id="deviceUpdateBrowseBtn"[^>]*disabled/, 'Browse is disabled');
  assert.match(html, /id="config-readonly-note"[^>]*>Read-only in this build/, 'the page says why');
  assert.match(READ_ONLY_PAGES.deviceUpdate ?? '', /Read-only in this build/);
  // The read half stays: the two version rows the receiver fills are still in the document.
  assert.match(html, /id="deviceUpdatehardwareVersion"/);
  assert.match(html, /id="deviceUpdatesoftwareVersion"/);

  // Even a hand-written event cannot get a firmware frame onto the link.
  host.applyEvent('#deviceUpdateApplyBtn', { click: true });
  assert.deepEqual(host.takeCommands(), [], 'the read-only gate drops what the page framed');

  // And the controller's own start path is refused too: give it a valid image name and start it.
  host.manage.configs.deviceUpdate.setFile(host.tabId as never, {
    name: 'read-only-test.hex',
    text: 'SOFTLOADSREC "S0~V~READ-ONLY-TEST"\n',
  });
  host.manage.configs.deviceUpdate.start(host.tabId as never);
  assert.deepEqual(host.takeCommands(), [], 'no SOFTLOADRESET / SOFTLOADSREC / SOFTLOADDATA frame escapes');
  assert.ok(host.readOnlyRefusals() > 0, 'the frames were framed and refused, not silently absent');
});
