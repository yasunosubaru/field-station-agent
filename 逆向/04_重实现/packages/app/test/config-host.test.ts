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
