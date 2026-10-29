/**
 * Container layer tests — `03_分析/01_Manage主界面与视图层.md §2.7` and R13-R16.
 *
 * Every assertion is made against the **real** element tree produced by `buildPanels`: the
 * declarative `panelSteps()` is compared with `PanelBuild.stepIds()` (the roots the run actually
 * appended), and the templates' internals are pinned id by id. A typo in a template or in the step
 * table therefore fails the suite.
 *
 * Source of truth: `01_解包/app/jarvisInterface.js:893-1141` (the sixteen steps) and `:970-1004`
 * (the three config page templates).
 *
 * Two notes about the DOM shim, which is *not* a browser:
 *  - `minidom`'s `querySelector` does not stop at the first match when a duplicate id exists, so
 *    these tests never rely on it for the R14 duplicates — they use the `#<tab> ` prefix (which is
 *    the point of R14) and `querySelectorAll` counts;
 *  - for the same reason assertions compare ids and booleans, never two DOM nodes (`assert` would
 *    have to `inspect` a whole shim tree to build its failure message).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPanels,
  configPageKind,
  createContainers,
  currentPage,
  panelIdsInOrder,
  panelSteps,
  scopedSelector,
  setPage,
} from '../src/containers.ts';
import {
  configComponentsId,
  connectionLoaderId,
  eventsPanelId,
  fetchLoaderId,
  mainPanelId,
  menuBarPanelId,
  statusComponentsId,
  statusComponentsPage2Id,
  statusConfigId,
  statusPanelId,
} from '../src/ids.ts';
import { createDocument, querySelector, querySelectorAll } from '../src/minidom.ts';
import { DEFAULT_FEATURES, type FeatureFlags } from '../src/types.ts';

function tabHost(doc: ReturnType<typeof createDocument>, tab: string): any {
  const host = doc.createElement('div');
  host.className = 'tab-view';
  host.id = tab;
  doc.body.appendChild(host);
  return host;
}

/** `data-lang-*` marker of an element, if any — R35 keeps the text out of the markup. */
function langMarker(element: any): string | undefined {
  return element?.getAttributeNames().find((name: string) => name.startsWith('data-lang-'));
}

test('§2.7: sixteen steps, in the documented order', () => {
  const steps = panelSteps('tabs-3');
  assert.equal(steps.length, 16);
  assert.deepEqual(
    steps.map((step) => step.step),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
  assert.deepEqual(
    steps.map((step) => step.ids),
    [
      [eventsPanelId('tabs-3')],
      [menuBarPanelId('tabs-3')],
      [statusPanelId('tabs-3')],
      [mainPanelId('tabs-3')],
      [fetchLoaderId('tabs-3')],
      [statusConfigId('tabs-3')],
      [statusComponentsId('tabs-3')],
      [statusComponentsPage2Id('tabs-3')],
      [configComponentsId('tabs-3')],
      ['config-tabs'],
      ['statusPage1', 'statusPage2', 'resetDefault'],
      ['tabs-popup'],
      [null], // `.cancel-modal[data-popup=overlay-popup]` ships without an id (:1073)
      [null], // `.help-modal.container` (:1100)
      [null], // `.translucent-layout` (:1123)
      ['connection-loader'],
    ],
  );
  // R14: step 12-16 are the per-tab duplicates, so only the tab prefix disambiguates them.
  assert.equal(scopedSelector('tabs-3', '#popupModal'), '#tabs-3 #popupModal');
  assert.deepEqual(steps[11].selectors, ['#tabs-3 #tabs-popup']);
  assert.deepEqual(steps[12].selectors, ['#tabs-3 [data-popup="overlay-popup"]']);
  assert.deepEqual(steps[13].selectors, ['#tabs-3 .help-modal']);
  assert.deepEqual(steps[14].selectors, ['#tabs-3 .translucent-layout']);
  assert.deepEqual(steps[15].selectors, ['#tabs-3 #connection-loader']);
  // The GIII config page is a bare `.row`; Longhorn appends a row *and* a panel.
  assert.deepEqual(panelSteps('gT', { ...DEFAULT_FEATURES, isGIII: true })[9].ids, [null]);
  assert.deepEqual(panelSteps('lT', { ...DEFAULT_FEATURES, isLongHorn: true })[9].ids, ['longhorn-config-lT', null]);
});

test('buildPanels appends exactly what the step table declares, in that order', () => {
  const kit = createContainers();
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);

  assert.equal(built.kind, 'standard');
  assert.equal(built.steps.length, 16);
  assert.deepEqual(built.stepIds(), panelSteps('tabs-3').flatMap((step) => step.ids));
  assert.deepEqual(panelIdsInOrder('tabs-3'), built.stepIds().filter((id) => id !== null));

  // The four top-level panels, then steps 12-16, are children of `#<tab>`.
  for (const element of [built.eventsPanel, built.menuBarPanel, built.statusPanel, built.mainPanel]) {
    assert.equal((element as any).parentElement.id, 'tabs-3');
  }
  for (const element of [
    built.tabsPopup,
    built.overlayPopup,
    built.helpModal,
    built.translucentLayout,
    built.connectionLoader,
  ]) {
    assert.equal((element as any).parentElement.id, 'tabs-3');
  }

  // Append order is *not* document order: step 11 writes into step 6's `#status-config-<tab>`, so
  // the page tabs appear before steps 7-9 in the tree.
  const order = querySelectorAll(host, '[id]').map((element) => element.id);
  assert.ok(order.indexOf('statusPage1') < order.indexOf(statusComponentsId('tabs-3')));
  assert.ok(order.indexOf(mainPanelId('tabs-3')) < order.indexOf(fetchLoaderId('tabs-3')));
  // …and the whole tree lives under the tab panel, so `#<tab> #…` resolves for every step.
  for (const step of panelSteps('tabs-3')) {
    for (const selector of step.selectors) {
      assert.ok(querySelector(doc, selector), `${selector} resolves`);
    }
  }
});

test('R13: fetch-loader, status-components (both pages) and config-components live in main-panel', () => {
  const kit = createContainers();
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);
  const scoped = (selector: string): any => querySelector(doc, scopedSelector('tabs-3', selector));

  for (const id of [
    fetchLoaderId('tabs-3'),
    statusConfigId('tabs-3'),
    statusComponentsId('tabs-3'),
    statusComponentsPage2Id('tabs-3'),
    configComponentsId('tabs-3'),
  ]) {
    const element = scoped('#' + id);
    assert.ok(element, `#${id} resolves through the tab prefix`);
    assert.equal((element as any).parentElement.id, mainPanelId('tabs-3'), `#${id} is a child of #main-panel`);
  }
  assert.equal((built.mainPanel as any).className, 'main-panel complete-panel');
  assert.equal((built.statusComponents as any).className, 'status-components manage-status-components');
  assert.equal((built.statusComponentsPage2 as any).className, 'status-components-page2');
  // R16's three items hang off #status-config-<tab>, inside #main-panel-<tab>.
  assert.equal((scoped('#statusPage1') as any).parentElement.id, statusConfigId('tabs-3'));
  assert.equal((built.statusConfig as any).className, 'row status-config');
});

test('R14: steps 12-16 exist once per tab, and only the prefix keeps them apart', () => {
  const kit = createContainers();
  const doc = createDocument();
  const hostA = tabHost(doc, 'tabs-3');
  const hostB = tabHost(doc, 'tabs-4');
  kit.buildPanels('tabs-3', hostA);
  kit.buildPanels('tabs-4', hostB);

  for (const selector of ['#popupModal', '#overlayPopupModal', '#helpModal', '.translucent-layout', '#connection-loader']) {
    assert.equal(querySelectorAll(doc, selector).length, 2, `${selector} is duplicated once per tab`);
  }

  const a = querySelector(doc, scopedSelector('tabs-3', '#popupModal'));
  const b = querySelector(doc, scopedSelector('tabs-4', '#popupModal'));
  assert.ok(a && b);
  assert.ok(a !== b, 'the two tabs own different nodes');
  assert.ok(hostA.contains(a!));
  assert.ok(!hostB.contains(a!), 'tabs-4 does not contain tabs-3\'s modal');
  assert.equal((a as any).parentElement.id, 'tabs-popup');
  assert.equal((b as any).parentElement.id, 'tabs-popup');
  // The inner ids of step 12/16 are pinned too: they are what `createDialog`/`showLoader` look up.
  assert.deepEqual(
    querySelectorAll(a!, '[id]').map((element) => element.id),
    ['btn-template'],
    'the dialog button template is the only id inside #popupModal',
  );
  assert.deepEqual(
    querySelectorAll(querySelector(doc, scopedSelector('tabs-3', '#connection-loader'))!, '[id]').map(
      (element) => element.id,
    ),
    ['fetch-loader-tabs-1', 'load-screen', 'loader-class', 'loader-img', 'loader-text-id'],
  );

  // `#connection-loader` keeps the literal id of the original (`:1129`); the duplicate is
  // disambiguated by the `#<tab> ` prefix, which is exactly why R14 names `#connection-loader`.
  assert.equal(connectionLoaderId('tabs-3'), 'connection-loader');
  assert.ok(querySelector(doc, scopedSelector('tabs-3', '#connection-loader')));
  // …and its inner div really does duplicate `#fetch-loader-tabs-1` (:1130) for tab `tabs-1`.
  const host1 = tabHost(doc, 'tabs-1');
  const built1 = kit.buildPanels('tabs-1', host1);
  const inner = querySelector(built1.connectionLoader, '.fetch-loader');
  assert.equal((inner as any).id, 'fetch-loader-tabs-1');
  // Inside `tabs-1` the id appears twice (step 5's real loader and step 16's child)…
  assert.equal(querySelectorAll(host1, '#fetch-loader-tabs-1').length, 2);
  // …and the hard-coded id of :1130 means every other tab's connection loader repeats it as well.
  assert.equal(querySelectorAll(doc, '#fetch-loader-tabs-1').length, 4);
});

test('R15: the config page is chosen by the flags, Longhorn/GIII before generation', () => {
  const standard = (extra: Partial<FeatureFlags>): FeatureFlags => ({ ...DEFAULT_FEATURES, ...extra });
  assert.equal(configPageKind(standard({ generation: 'OEM6' })), 'standard');
  assert.equal(configPageKind(standard({ generation: 'GIII' })), 'standard', 'the generation string never decides');
  assert.equal(configPageKind(standard({ isGIII: true })), 'giii');
  assert.equal(configPageKind(standard({ isLongHorn: true })), 'longhorn');
  // both flags set: the original's `else if` chain picks GIII (:973 before :1004)
  assert.equal(configPageKind(standard({ isLongHorn: true, isGIII: true })), 'giii');
});

test('R15: the standard page is the eight-pill template', () => {
  const kit = createContainers();
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);
  const page = built.configPage as any;

  assert.equal(page.id, 'config-tabs');
  assert.equal(page.parentElement.id, configComponentsId('tabs-3'));
  assert.equal(querySelectorAll(built.configComponents, '[id]').length, 17, 'config-tabs + 8 pills + 8 panels');

  const pills = querySelectorAll(page, 'li');
  assert.deepEqual(
    pills.map((pill) => pill.id),
    ['positionTab', 'portConfig', 'loggingConfig', 'alignConfig', 'spanTab', 'radioConfig', 'gnssConfig', 'spoofingConfig'],
  );
  assert.deepEqual(
    // R35: markers only — language.ts writes the text, so every pill ships empty.
    pills.map((pill) => langMarker(querySelector(pill, 'a'))),
    [
      'data-lang-positioning',
      'data-lang-ports',
      'data-lang-logging',
      'data-lang-align',
      'data-lang-span',
      'data-lang-radio',
      'data-lang-gnss',
      'data-lang-spoofing-title',
    ],
  );
  for (const pill of pills) assert.equal(pill.textContent, '', 'no literal label in the markup');
  assert.ok(pills[0].classList.contains('active'));

  const panels = querySelectorAll(querySelector(page, '.tab-content')!, 'div');
  assert.deepEqual(
    panels.map((panel) => panel.id),
    ['config-pos', 'config-ports', 'config-log', 'config-align', 'config-span', 'config-radio', 'config-gnss', 'config-spoofing'].map(
      (name) => `${name}-tabs-3`,
    ),
  );
});

test('R15: the GIII page drops every pill but Logging and warns about the restart', () => {
  const kit = createContainers({ features: () => ({ ...DEFAULT_FEATURES, isGIII: true }) });
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);
  const page = built.configPage as any;

  assert.equal(built.kind, 'giii');
  assert.equal(querySelector(doc, scopedSelector('tabs-3', '#config-tabs')), null);
  assert.equal(querySelector(page, '#config-pos-tabs-3'), null, 'no Positioning panel for GIII');
  assert.ok(querySelector(page, '.giii-logging-restart-container'));
  assert.ok(querySelector(page, '#giii-loggingDismiss-btn'));
  assert.ok(querySelector(page, '#giii-loggingRestart-btn'));
  const logging = querySelector(page, '#loggingConfig > a')!;
  assert.equal(logging.id, 'giii-file-path');
  assert.equal(logging.getAttribute('data-lang-logging'), '');
  assert.equal((querySelector(page, '#config-log-tabs-3') as any).className, 'totaldata');
  assert.deepEqual(
    querySelectorAll(page, '[id]').map((element) => element.id),
    ['giii-loggingDismiss-btn', 'giii-loggingRestart-btn', 'loggingConfig', 'giii-file-path', 'config-log-tabs-3'],
  );
});

test('R15: the Longhorn page is the two-tab Positioning/Logging template', () => {
  const kit = createContainers({ features: () => ({ ...DEFAULT_FEATURES, isLongHorn: true }) });
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);
  const configComponents = built.configComponents as any;

  assert.equal(built.kind, 'longhorn');
  assert.ok(configComponents.classList.contains('longhorn-config'));
  assert.equal((built.configPage as any).id, 'longhorn-config-tabs-3');
  assert.deepEqual(querySelectorAll(built.configPage, 'div').map((element) => element.id), [
    'lghn-positioningPage',
    'lghn-loggingPage',
  ]);
  const panel = querySelector(configComponents, '.longhorn-config-panel')!;
  assert.deepEqual(querySelectorAll(panel, 'div').map((element) => element.id), [
    'config-pos-tabs-3',
    'config-align-tabs-3',
    'config-span-tabs-3',
    'config-ports-tabs-3',
    'config-log-tabs-3',
    'config-radio-tabs-3',
  ]);
  assert.equal(querySelector(doc, scopedSelector('tabs-3', '#config-tabs')), null);
  assert.deepEqual(built.stepIds(), [
    'events-panel-tabs-3',
    'menuBar-panel-tabs-3',
    'status-panel-tabs-3',
    'main-panel-tabs-3',
    'fetch-loader-tabs-3',
    'status-config-tabs-3',
    'status-components-tabs-3',
    'status-components-page2-tabs-3',
    'config-components-tabs-3',
    'longhorn-config-tabs-3',
    null,
    'statusPage1',
    'statusPage2',
    'resetDefault',
    'tabs-popup',
    null,
    null,
    null,
    'connection-loader',
  ]);
});

test('R16: #status-config-<tab> carries the page tabs and the reset-layout action', () => {
  const kit = createContainers();
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);

  for (const id of ['statusPage1', 'statusPage2', 'resetDefault']) {
    assert.ok(querySelector(built.statusConfig, '#' + id), `#${id} is inside #status-config-<tab>`);
  }
  assert.equal(langMarker(querySelector(built.page1Tab, 'a')), 'data-lang-page1');
  assert.equal(langMarker(querySelector(built.page2Tab, 'a')), 'data-lang-page2');
  assert.equal(langMarker(querySelector(built.resetDefault, 'a')), 'data-lang-reset-default-layout');
});

test('R27/R28: setPage switches the Packery containers and the reset button', () => {
  const calls: Array<[string, string]> = [];
  const kit = createContainers({ onPageChange: (tab, page) => calls.push([tab, page]) });
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-3');
  const built = kit.buildPanels('tabs-3', host);
  const page1 = built.statusComponents as any;
  const page2 = built.statusComponentsPage2 as any;

  assert.equal(kit.currentPage('tabs-3'), '', 'page 1 is the start page');
  assert.equal(page1.hasAttribute('hidden'), false);

  assert.equal(kit.setPage('tabs-3', 'page2'), 'page2');
  assert.equal(page1.hasAttribute('hidden'), true);
  assert.equal(page1.style.display, 'none');
  assert.equal(page2.hasAttribute('hidden'), false);
  assert.equal((built.resetDefault as any).style.visibility, 'hidden');
  assert.equal((built.page2Tab as any).classList.contains('active-tab'), true);
  assert.equal((built.page1Tab as any).classList.contains('active-tab'), false);
  assert.equal((built.configComponents as any).hasAttribute('hidden'), true, ':359 shows the status view');
  assert.equal((built.statusConfig as any).hasAttribute('hidden'), false);

  assert.equal(kit.setPage('tabs-3', ''), '');
  assert.equal(page1.hasAttribute('hidden'), false);
  assert.equal(page2.hasAttribute('hidden'), true);
  assert.equal((built.resetDefault as any).style.visibility, 'visible');
  assert.equal((built.page1Tab as any).classList.contains('active-tab'), true);
  assert.deepEqual(calls, [
    ['tabs-3', 'page2'],
    ['tabs-3', ''],
  ]);

  // Nothing built yet: the answer must still be the normalized page (menuBar persists it).
  assert.equal(kit.setPage('tabs-9', 'page2'), 'page2');
  assert.equal(kit.setPage('tabs-9', ''), '');
});

test('unmount removes the sixteen steps of one tab only', () => {
  const kit = createContainers();
  const doc = createDocument();
  kit.buildPanels('tabs-3', tabHost(doc, 'tabs-3'));
  kit.buildPanels('tabs-4', tabHost(doc, 'tabs-4'));
  assert.equal(querySelectorAll(doc, '#tabs-popup').length, 2);

  kit.unmount('tabs-3');
  assert.equal(querySelectorAll(doc, '#tabs-popup').length, 1);
  assert.equal(querySelector(doc, scopedSelector('tabs-3', '#' + mainPanelId('tabs-3'))), null);
  assert.ok(querySelector(doc, scopedSelector('tabs-4', '#' + mainPanelId('tabs-4'))));
  assert.equal(kit.build('tabs-3'), undefined);
});

test('the module-level buildPanels/setPage pair is the same sixteen steps', () => {
  const doc = createDocument();
  const host = tabHost(doc, 'tabs-7');
  const built = buildPanels('tabs-7', host);
  // Not the module-level kit's doc? it is: `buildPanels` uses its own default kit, and `setPage`
  // must find the same build.
  assert.deepEqual(built.stepIds(), panelSteps('tabs-7').flatMap((step) => step.ids));
  assert.equal(currentPage('tabs-7'), '');
  assert.equal(setPage('tabs-7', 'page2'), 'page2');
  assert.equal(currentPage('tabs-7'), 'page2');
  assert.equal((built.resetDefault as any).style.visibility, 'hidden');
});
