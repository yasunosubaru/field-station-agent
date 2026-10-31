/**
 * The config host: the suite's 14 Configuration pages, mounted server-side on `minidom` and handed
 * to the browser as HTML (A1's adapter; see `packages/app/src/config-host.ts`).
 *
 * These assertions are against the **shipped** markup (`01_解包/app/view/<page>/<page>.html`), so a
 * pass means the original ids came through the adapter rather than a hand-drawn look-alike. The
 * fragments are only skeletons — the rows are filled from the receiver's configuration records —
 * so the test checks ids and behaviour, not the row contents.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ConfigHost, CONFIG_PAGE_NAMES } from '../src/config-host.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up to the unpacked app (`01_解包/app`), like `packages/view/test/helpers.ts` does. */
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

test('the host mounts a shipped configuration page and returns its original markup', () => {
  const host = new ConfigHost(options());
  // The constructor mounts the tab template, which already includes position/ports/logging/align/
  // span/radio (the six the original opens with), so mounting those is a no-op.
  const ports = host.show('portConfig');
  assert.equal(ports.mounted, false, 'portConfig is part of the initial template');
  assert.ok(ports.html.length > 2_000, `serialised document is ${ports.html.length} bytes`);
  assert.ok(host.ids().includes('config-ports-tabs-2'), 'the ports pane exists');
  assert.ok(host.ids().includes('portConfiguration'), 'the page body came from the fragment');
  assert.ok(host.ids().includes('desktop-portconfig-list'), 'the row list container exists');
  assert.ok(host.ids().includes('portConfig-apply'), 'the Apply button exists');

  // A page the template does not carry mounts on first use, and only once.
  const spoofing = host.show('spoofingConfiguration');
  assert.equal(spoofing.mounted, true, 'spoofingConfiguration mounts on first use');
  assert.equal(host.show('spoofingConfiguration').mounted, false, 'and not again');
});

test('every page in the catalogue mounts (14 pages)', () => {
  const host = new ConfigHost(options());
  assert.equal(CONFIG_PAGE_NAMES.length, 14);
  const failed: string[] = [];
  for (const name of CONFIG_PAGE_NAMES) {
    try {
      host.show(name);
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failed, [], 'no page throws on mount');
  const ids = host.ids();
  for (const pane of ['config-pos-tabs-2', 'config-ports-tabs-2', 'config-log-tabs-2', 'config-align-tabs-2']) {
    assert.ok(ids.includes(pane), `${pane} mounted`);
  }
});

test('a decoded record can be fed to the controller', () => {
  const host = new ConfigHost(options());
  host.show('portConfig');
  const updated = host.feed(93, { rxError: '00000000', statusWords: [] });
  assert.ok(Array.isArray(updated), 'updateFromLog returns the pages it touched');
  assert.ok(host.html().length > 2_000, 'the document is still serialisable after an update');
});

test('form events are applied by selector, and unknown selectors are refused', () => {
  const host = new ConfigHost(options());
  host.show('portConfig');
  assert.equal(host.applyEvent('#definitely-not-a-selector', { value: 'x' }), false);
  assert.equal(host.applyEvent('#portConfig-apply', { click: true }), true);
});

test('an unknown page name is rejected instead of silently doing nothing', () => {
  const host = new ConfigHost(options());
  assert.throws(() => host.show('noSuchPage'), /unknown config page/);
});

/* ------------------------------------------------------- 1/12 the page becomes visible */

test('select() switches the tab to Configuration and leaves the pane displayed', () => {
  const host = new ConfigHost(options());
  host.show('portConfig');
  const detail = host.selectDetail('portConfig');
  // This is the pair `statusConfigClick` → `containers.build(tab)` used to fail on: the build is
  // registered by `buildPanels`, the tab is switched, the pane is the active one.
  assert.equal(detail.selected, true, 'the Ports pill was activated');
  assert.equal(detail.configOpen, true, 'the tab is in the Configuration view');
  assert.equal(detail.paneId, 'config-ports-tabs-2');
  assert.equal(detail.paneDisplay, 'block', 'the pane is not folded away');
  assert.ok(host.elementHtml('#config-ports-tabs-2')?.includes('class="totaldata active active-config"'));
});

test('the Ports page shows the shipped row template before any receiver record', () => {
  const host = new ConfigHost(options());
  host.show('portConfig');
  const list = host.elementHtml('#desktop-portconfig-list') ?? '';
  // `portConfig.html` ships only the empty <ul>; the row is built by the page's own render().
  assert.ok(list.includes('data-portconfig-note="no-receiver"'), 'the empty state explains itself');
  assert.ok(list.includes('class="row portconfig-item"'), 'the "+" row is there');
  assert.ok(list.includes('class="message-text-area"'), 'the message box is an editable input');
  assert.ok(list.includes('class="dropdown input-selection"'));
  assert.ok(list.includes('class="dropdown output-selection"'));
  // Apply is the shipped button, not a re-drawn one.
  assert.match(host.elementHtml('#portConfig-apply') ?? '', /applyPortButtonReceive/);
});

test('an INTERFACEMODE record produces one row per configured port', () => {
  const host = new ConfigHost(options());
  host.show('portConfig');
  const tab = host.tabId;
  host.feed(3, { tab, port: 'COM1', rxType: 'NOVATEL', txType: 'NOVATEL' });
  host.feed(3, { tab, port: 'COM2', rxType: 'NONE', txType: 'NOVATEL' });
  host.feed(3, { tab, port: 'COM3', rxType: 'NONE', txType: 'NONE' });
  host.show('portConfig'); // reset + render, the same two steps `resetPortConfigUI` takes
  const list = host.elementHtml('#desktop-portconfig-list') ?? '';
  assert.ok(list.includes('id="COM1"'), 'a configured port gets a row');
  assert.ok(list.includes('id="COM2"'), 'NONE/NOVATEL still counts as configured');
  assert.ok(!list.includes('id="COM3"'), 'NONE/NONE is not a row — the receiver says it is off');
  assert.ok(!list.includes('data-portconfig-note'), 'the empty-state note is gone');
});

/* ------------------------------------------------------------------ 3/12 Events */

test('the Events page mounts into its shipped panel and starts honestly empty', () => {
  const host = new ConfigHost(options());
  const shown = host.showOperational('events');
  assert.equal(shown.mounted, true, 'events mounts on first use');
  const panel = host.elementHtml('#events-panel-tabs-2') ?? '';
  assert.ok(panel.includes('events-sidenav'), 'the shipped drawer markup mounted');
  assert.ok(panel.includes('showEvents'), 'the drawer is slid in, otherwise it sits off-screen');
  assert.ok(panel.includes('No events present'), 'no data is stated, not invented');
  assert.equal(host.eventCount(), 0);
});

test('a real RXSTATUSEVENT line becomes one event entry', () => {
  const host = new ConfigHost(options());
  host.showOperational('events');
  const ascii =
    '#RXSTATUSEVENTA,COM1,0,53.5,FINESTEERING,2287,137888.000,02000020,4b5f,1682;' +
    '"MODEL INVALID FOR THIS RECEIVER",1,1,0,0*7c1c2f8e';
  assert.deepEqual(host.feedAscii(94, ascii), ['events']);
  assert.equal(host.eventCount(), 1);
  const entries = host.elementHtml('#events-panel-tabs-2 .current-events-layout .event-entries') ?? '';
  assert.ok(entries.includes('eventElement'), 'the list has an entry');
  assert.ok(entries.includes('Invalid Model'), 'the receiver’s description is translated, not guessed');
  // A line with no quoted description is not an event.
  assert.deepEqual(host.feedAscii(94, '#RXSTATUSEVENTA,COM1'), []);
  assert.deepEqual(host.feedAscii(93, ascii), [], 'RXSTATUS is not an event record');
  assert.equal(host.eventCount(), 1, 'nothing was invented');
});
