/**
 * Tools ▸ Interference Toolkit (§2.2.9) and the Wi-Fi feature bit (B6).
 *
 * Both halves are checked against the receiver's own bytes: `b7-20261101.sbf` holds 47
 * `#ITDETECTSTATUSA` text records (38 of them carrying a detection, all on L2) plus one binary
 * `ITDETECTCONFIG` / `ITWARNINGCONFIG` / `ITSPECTRALANALYSIS` each, and `b1-20261101.sbf` holds the
 * desk OEM729's `VERSION` (#37) with the component list the suite's Wi-Fi test runs on.
 *
 * The ITK page is fed the way the drawer feeds it — `POST /api/config/interferenceToolkit/event`
 * with `#itk-capture` and a capture name, i.e. `applyConfigEvent` — so what these tests exercise is
 * the path the browser takes, not a parallel one built for tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ConfigHost, TOOLS_PAGE_NAMES } from '../src/config-host.ts';
import { applyConfigEvent, configPageDocument, configPageList, feedItkCapture } from '../src/config-http.ts';
import { loadCapture, tables } from '../src/capture.ts';
import { resolveCapture } from '../src/paths.ts';
import { readRecords, readTextRecords } from '../src/logs.ts';
import {
  ITK_MSG,
  itkRowsOf,
  wifiSupportedFromVersion,
  WIFI_SUPPORTED_PSN_PREFIXES,
} from '../../view/src/config/index.ts';

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

const options = (features: Record<string, unknown> = {}) => ({
  appRoot: appRoot(),
  dataDir: join(here, '..', '..', 'protocol', 'data'),
  features,
});

/** `L2` / `SPECTRUMANALYSIS` / `00000400` — the printed token, as `config-http.ts` hands it over. */
function fieldMapOfRecord(record: {
  fields: Array<{ path: string; value: unknown; text?: string }>;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of record.fields) fields[field.path] = field.text ?? field.value;
  return fields;
}

function b7TextRecords(offset = 0, limit = 25) {
  return readTextRecords(
    loadCapture(resolveCapture('b7-20261101.sbf')),
    tables(),
    'ITDETECTSTATUS',
    offset,
    limit,
  );
}

/* ------------------------------------------------------------------ the mapping */

test('ITDETECTSTATUS: one row per interference_status, with the band and the detector', () => {
  const page = b7TextRecords();
  const rows = page.records.flatMap((record) => itkRowsOf(fieldMapOfRecord(record)));
  assert.equal(page.total, 47, 'the capture holds 47 ITDETECTSTATUS records');
  assert.equal(rows.length, page.records.length, 'one status per record in this capture');
  assert.equal(rows.every((row) => row.band === 'L2'), true, 'every detection is on L2');

  const statistical = rows.find((row) => row.method === 'STATISTICANALYSIS');
  assert.ok(statistical, 'the statistical detector is in the first page');
  // `parameter1` of a statistical detection is its statistic, not a frequency: 6.826 MHz would be
  // a lie, and this is the field the layout calls `frequency` (the band enum) one position earlier.
  assert.equal(statistical?.centreMHz, null);
  assert.equal(statistical?.parameters[0], 6.826);
  assert.equal(statistical?.severity, '00000000/00000000');

  const spectrum = rows.find((row) => row.method === 'SPECTRUMANALYSIS');
  assert.ok(spectrum, 'the spectrum detector is in the first page');
  assert.equal(spectrum?.detected, true);
  assert.ok((spectrum?.centreMHz ?? 0) > 1260 && (spectrum?.centreMHz ?? 0) < 1280,
    `spectrum centre ${spectrum?.centreMHz} MHz is in L2`);
});

test('a count-0 record is the receiver saying "nothing detected", not a row of zeros', () => {
  // `#ITDETECTSTATUSA,…,18278;0*8953c28a` — the shape 9 of b7's 47 records have.
  assert.deepEqual(itkRowsOf({ interference_statuses_count: 0 }), []);
  assert.deepEqual(itkRowsOf({}), []);
  assert.deepEqual(
    itkRowsOf({ 'interference_statuses[0].int_detect_method': 'NONE' }).map((row) => row.detected),
    [false],
    'a NONE row maps, but is not a detection',
  );
});

/* ------------------------------------------------------------------ the page */

test('the drawer lists the page under Tools, and it is a menu page', () => {
  const entry = configPageList().find((page) => page.name === 'interferenceToolkit');
  assert.ok(entry, 'Interference Toolkit is served');
  assert.equal(entry?.label, 'Interference Toolkit');
  assert.equal(entry?.tools, true, 'it belongs to the Tools group');
  assert.equal(entry?.settings, true, 'and lives in the tab’s menu layouts');
  assert.equal(entry?.operational, false);
  assert.deepEqual([...TOOLS_PAGE_NAMES], ['interferenceToolkit']);
});

test('the page opens with the shipped ITK markup and its own read-only sections', () => {
  const host = new ConfigHost(options());
  const page = host.show('interferenceToolkit');
  assert.equal(page.mounted, true, 'it mounts on first use');
  assert.equal(host.show('interferenceToolkit').mounted, false, 'and not again');

  const ids = host.ids();
  for (const id of ['itk-layout', 'itk-detections', 'itk-detection-rows', 'itk-no-detections', 'itk-config-rows', 'itk-capture']) {
    assert.ok(ids.includes(id), `#${id} exists`);
  }
  assert.ok(ids.includes('itk-layout_tabs-2'), 'the shipped container id keeps the tab suffix');
  // The shipped fragment's breadcrumb, title and band tabs came through verbatim.
  assert.match(page.html, /data-lang-tools=""/);
  assert.match(page.html, /class="nav-link itk-tab-link"[^>]*>L2</);
  // The plot-only controls cannot be operated: they are hidden or disabled in the served document.
  assert.match(page.html, /id="itk-l1-container"/, 'the shipped graph container is still there');
  assert.match(page.html, /id="itk-settings"[^>]*style="display: none"/);
});

test('naming a capture fills the page with the same 25 records /api/records returns', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  const applied = applyConfigEvent('interferenceToolkit', '#itk-capture', {
    value: 'b7-20261101.sbf',
  });
  assert.equal(applied.applied, true, 'the capture control was found');
  assert.equal(applied.commands.length, 0, 'a read-only page frames nothing');

  const page = b7TextRecords();
  const drawn = (applied.shell.match(/<tr class="itk-detection-row/g) ?? []).length;
  assert.equal(drawn, page.records.length, `the page draws ${page.records.length} rows`);
  assert.equal(page.records.length, 25, 'which is the API’s per-request limit');

  assert.match(applied.shell, /47 ITDETECTSTATUS record\(s\)/, 'the capture-wide record count');
  assert.match(applied.shell, /38 carrying a detection/, 'and how many are detections');
  assert.match(applied.shell, /STATISTICANALYSIS 25 · SPECTRUMANALYSIS 13/);
  assert.match(applied.shell, /data-itk-loaded="1"/);

  // The receiver's own configuration records are displayed, not written.
  assert.match(applied.shell, /ITDETECTCONFIG \(#2143\) frequency<\/td>/);
  assert.match(applied.shell, /<td class="itk-config-value">ALL<\/td>/);
  assert.match(applied.shell, /<td class="itk-config-value">PREDECIMATION<\/td>/);
  assert.match(applied.shell, /<td class="itk-config-value">2K<\/td>/);
  // `ITFRONTENDMODE` is not in the capture, so HDR mode is `--` and the page says which record is
  // missing rather than printing a zero.
  assert.match(applied.shell, /ITFRONTENDMODE \(#2039\)/);
  assert.match(applied.shell, /Not in this capture, so shown as --: ITFRONTENDMODE/);
});

test('the band tabs filter the list, and their ids make the click reachable', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  applyConfigEvent('interferenceToolkit', '#itk-capture', { value: 'b7-20261101.sbf' });
  // A drawer page is served as its menu panel alone, so a browser-computed `@i/j/k` path would not
  // address the same element in the server's document; the tabs need ids to be clickable at all.
  assert.ok(host.ids().includes('itk-tab-l1'));
  assert.ok(host.ids().includes('itk-tab-l2'));

  const l2 = applyConfigEvent('interferenceToolkit', '#itk-tab-l2', { click: true });
  assert.equal((l2.shell.match(/<tr class="itk-detection-row/g) ?? []).length, 25, 'every shown row is L2');
  assert.match(l2.shell, /Filtered to L2: 25 row\(s\) shown/);

  const l1 = applyConfigEvent('interferenceToolkit', '#itk-tab-l1', { click: true });
  assert.equal((l1.shell.match(/<tr class="itk-detection-row/g) ?? []).length, 0, 'nothing on L1');
  assert.match(l1.shell, /id="itk-no-detections"[^>]*style="display: block"/);

  const back = applyConfigEvent('interferenceToolkit', '#itk-tab-l1', { click: true });
  assert.equal(
    (back.shell.match(/<tr class="itk-detection-row/g) ?? []).length,
    25,
    'clicking the same tab again clears the filter',
  );
});

test('a capture without ITDETECTSTATUS keeps the shipped empty state', () => {  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  const applied = applyConfigEvent('interferenceToolkit', '#itk-capture', {
    value: 'b1-20261101.sbf',
  });
  assert.equal((applied.shell.match(/<tr class="itk-detection-row/g) ?? []).length, 0);
  assert.match(applied.shell, /id="itk-no-detections"[^>]*style="display: block"/);
  assert.match(applied.shell, /No interference detected\./);
  assert.match(applied.shell, /0 ITDETECTSTATUS record\(s\)/);
});

test('an unnamed or unknown capture is refused with a reason, and the page stays empty', () => {
  const missing = feedItkCapture('definitely-not-a-capture.sbf');
  assert.equal(missing.ok, false);
  assert.match(String(missing.reason), /未找到抓包|not found/i);
  const none = feedItkCapture('');
  assert.equal(none.ok, false);
  assert.match(String(none.reason), /no capture/);
});

test('the page document names its own capture control and the read-only note', () => {
  // What the drawer's iframe receives, before any capture is read.
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  const document = configPageDocument('interferenceToolkit', { connected: false });
  assert.match(document, /data-config-page="interferenceToolkit"/);
  assert.match(document, /id="itk-capture"/, 'the one control that is not a receiver setting');
  assert.match(document, /\.itk-readonly-section \{/, 'the page brings its own layout for its sections');
});

/* ------------------------------------------------------------------ the Wi-Fi bit */

test('the desk OEM729 fails the suite’s Wi-Fi test, and the note says so', () => {
  // `VERSION` (#37) as the capture API decodes it: no ENCLOSURE component at all.
  const version = readRecords(loadCapture(resolveCapture('b1-20261101.sbf')), tables(), 37, 0, 1);
  assert.equal(version.total, 1, 'b1 holds one VERSION record');
  const verdict = wifiSupportedFromVersion(fieldMapOfRecord(version.records[0]));
  assert.equal(verdict.supported, false);
  assert.match(verdict.reason, /no ENCLOSURE component/);
  assert.deepEqual(verdict.psnPrefixes, []);

  const host = new ConfigHost(options());
  const page = host.show('networkingSettings');
  // Same records the page would get from the link; the flag is derived, not configured.
  host.feed(37, fieldMapOfRecord(version.records[0]));
  const html = host.elementHtml('#networkingSettings-layout_tabs-2') ?? '';
  assert.match(html, /class="panel panel-default wifi-comp menubar-components" style="display: none"/);
  assert.match(html, /class="panel panel-default wifi-hotspot-comp menubar-components" style="display: none"/);
  assert.match(page.html, /id="config-wifi-note"/, 'the reason is printed above the panels');
  assert.match(page.html, /no ENCLOSURE component/);
});

test('a receiver whose ENCLOSURE PSN is in the suite’s list expands both panels', () => {
  // Synthetic fields — this is the shape the suite's own test reads (`featuresList.js:1077`):
  // an ENCLOSURE component, PSN minus its first character = one of the Wi-Fi prefixes.
  const synthetic = {
    'versions[0].component_type': 3,
    'versions[0].psn': `B${WIFI_SUPPORTED_PSN_PREFIXES[0]}A21030301G`,
  };
  const verdict = wifiSupportedFromVersion(synthetic);
  assert.equal(verdict.supported, true);
  assert.deepEqual(verdict.psnPrefixes, [WIFI_SUPPORTED_PSN_PREFIXES[0]]);

  const host = new ConfigHost(options());
  host.show('networkingSettings');
  host.feed(37, synthetic);
  const html = host.elementHtml('#networkingSettings-layout_tabs-2') ?? '';
  assert.match(html, /class="panel panel-default wifi-comp menubar-components" style="display: block"/);
  assert.match(html, /class="panel panel-default wifi-hotspot-comp menubar-components" style="display: block"/);
  assert.equal((html.match(/id="config-wifi-note"/g) ?? []).length, 0, 'and the note is withdrawn');
});

test('a PSN prefix outside the list keeps the panels hidden', () => {
  const verdict = wifiSupportedFromVersion({
    'versions[0].component_type': 3,
    'versions[0].psn': 'BMGX21030301G',
  });
  assert.equal(verdict.supported, false);
  assert.deepEqual(verdict.psnPrefixes, ['MGX']);
  assert.match(verdict.reason, /not one of the suite’s Wi-Fi prefixes/);
});

test('the feature flag alone decides the panels (no record needed)', () => {
  const hidden = new ConfigHost(options({ wifiSupported: false })).show('networkingSettings').html;
  assert.match(hidden, /wifi-comp menubar-components" style="display: none"/);
  const shown = new ConfigHost(options({ wifiSupported: true })).show('networkingSettings').html;
  assert.match(shown, /wifi-comp menubar-components" style="display: block"/);
  assert.equal((shown.match(/id="config-wifi-note"/g) ?? []).length, 0);
});

test('the ITK page reads no live message ids: its records are a capture’s text records', () => {
  // The page's contract with the link is empty on purpose (see CONFIG_SUBSCRIPTIONS), and the ids
  // it *does* name are the configuration records the host reads from the capture.
  assert.equal(ITK_MSG.ITDETECTSTATUS, 2065);
  assert.equal(ITK_MSG.ITDETECTCONFIG, 2143);
  assert.equal(ITK_MSG.ITWARNINGCONFIG, 2289);
  const source = readFileSync(join(here, '..', '..', 'view', 'src', 'config', 'index.ts'), 'utf8');
  assert.match(source, /interferenceToolkit: \[\],/);
});
