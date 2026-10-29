/**
 * TabRegistry tests.
 *
 * Every assertion is tied to a rule of `03_分析/01_Manage主界面与视图层.md §8` (the `R<n>`
 * number is in the test name) or to a line of `view/html/setUpMonitor.html` /
 * `view/js/welcome.js`. Where the doc and the shipped source disagree the source wins and the
 * test comment says so (the two known cases: §3.1's missing space, and R45's dead selector).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../src/minidom.ts';
import type { ConnType, CreateTabInput } from '../src/types.ts';
import {
  GRIT_STATIC_TAB,
  MAX_CONNECTION,
  STATIC_TAB,
  createTabRegistry,
  tabIdFor,
} from '../src/tabs.ts';
import type { ManageHost, ManageTabs, TabHooks } from '../src/tabs.ts';

function shell(hooks: TabHooks = {}, onStep?: (step: string) => void): {
  root: ReturnType<ReturnType<typeof createDocument>['createElement']>;
  registry: ManageTabs;
} {
  const doc = createDocument();
  const root = doc.createElement('div');
  root.id = 'setUpMonitor-layout';
  doc.body.appendChild(root);
  const registry = createTabRegistry({ hooks, onStep });
  registry.buildShell(root);
  return { root, registry };
}

function device(index: number, connType: ConnType = 'SM', deviceTileId = 'dev-' + index): CreateTabInput {
  return {
    index,
    connType,
    deviceTileId,
    title: 'Device ' + index,
    details: { type: 'eth', ipAddress: '192.168.0.10', port: 3001 },
  };
}

function makeHost(): ManageHost {
  return {
    hideNonCoreApp() {},
    hideWelcome() {},
    showSetUpMonitor() {},
    hideLandingPages() {},
    showSetupMonitorLanding() {},
    setTitle() {},
    switchIcon() {},
    applyLanguage() {},
  };
}

test('R10 buildShell builds #tabs, #tabs-list and the static pages, and activates nothing', () => {
  const { root, registry } = shell();

  const tabs = root.querySelector('#tabs');
  assert.ok(tabs, '#tabs exists');
  assert.equal(tabs!.id, 'tabs');
  assert.ok(root.querySelector('#tabs-list'), '#tabs-list exists');

  const staticPanel = root.querySelector('#tabs-1')!;
  assert.ok(staticPanel, 'the static "Add device" page is #tabs-1');
  assert.equal(staticPanel.getAttribute('connType'), 'SM');
  assert.ok(staticPanel.classList.contains('tab-view'));
  assert.equal(staticPanel.getAttribute('hidden'), '', 'nothing is visible after buildShell');

  const gritStatic = root.querySelector('#grit-tabs-1')!;
  assert.ok(gritStatic, 'the GRIT static first tab is grit-tabs-1');
  assert.equal(gritStatic.getAttribute('connType'), 'GRIT');

  // R10: the shell must not make Manage visible. Only an external activate() may.
  assert.equal(registry.active, '', 'no tab is active after buildShell');
  for (const li of root.querySelectorAll('#tabs-list li')) {
    assert.equal(li.getAttribute('aria-disabled'), null, 'no tab is disabled until enableTabs runs');
  }
  assert.deepEqual(
    registry.list().map((record) => record.tab),
    ['tabs-1', 'grit-tabs-1'],
  );
});

test('R10 / §3.1 list() distinguishes the static "Add device" page from device tabs', () => {
  const { registry } = shell();
  assert.equal(registry.isStatic(STATIC_TAB), true);
  assert.equal(registry.isStatic(GRIT_STATIC_TAB), true);

  const record = registry.create(device(2, 'SM', 'tile-55'));
  assert.equal(registry.isStatic('tabs-2'), false);

  const staticRecord = registry.list().find((entry) => entry.tab === STATIC_TAB)!;
  assert.equal(staticRecord.deviceTileId, '', 'a static page carries no deviceTileId');
  assert.equal(staticRecord.title, 'Add device');
  assert.equal(record.deviceTileId, 'tile-55');

  assert.deepEqual(registry.byDevice('tile-55').map((entry) => entry.tab), ['tabs-2']);
  assert.equal(registry.byDevice('').length, 2, 'static pages answer only the empty deviceTileId');
});

test('§3.1 create writes li + panel with connType on both and a space between id and connType', () => {
  const { root, registry } = shell();
  const record = registry.create(device(2));

  const li = registry.tabElement('tabs-2')!;
  assert.equal(li.getAttribute('connType'), 'SM');
  assert.equal(li.querySelector('a')!.getAttribute('href'), '#tabs-2');
  assert.ok(li.querySelector('.ui-icon-close'), 'the close-icon span the click handler binds to');
  assert.ok(li.classList.contains('tabs-2'), 'li.addClass(id) — the $(".<tab>") selectors rely on it');

  const panel = registry.panel('tabs-2')!;
  assert.equal(panel.getAttribute('class'), 'tab-view');
  assert.equal(panel.getAttribute('connType'), 'SM');
  assert.equal(record.status, 'connecting', '§6.1: addTab puts a tab in [connecting]');

  // §3.1 (210-212): the original concatenated "<div id='" + id + "'connType='…'", i.e. the two
  // attributes ran together. Browsers still recover, which is why the bug shipped; ours is
  // well-formed, so attribute values can never glue onto the id.
  const html = panel.outerHTML;
  assert.match(html, /^<div id="tabs-2" connType="SM" class="tab-view"/);
  assert.ok(!html.includes('"connType'), 'no attribute runs into the previous value');

  // …and the recovery is exactly what hid the bug: the malformed form parses "correctly".
  const probe = root.ownerDocument!.createElement('div');
  probe.innerHTML = "<div id='x'connType='SM'></div>";
  assert.equal(probe.firstElementChild!.getAttribute('connType'), 'SM');
});

test('§3.1 a GRIT tab becomes grit-tabs-<n> with class "tab-view grit-connection"', () => {
  const { registry } = shell();
  registry.create(device(2, 'GRIT'));

  assert.equal(registry.panel('grit-tabs-2')!.getAttribute('class'), 'tab-view grit-connection');
  assert.equal(registry.panel('grit-tabs-2')!.getAttribute('connType'), 'GRIT');
  assert.equal(registry.tabElement('grit-tabs-2')!.getAttribute('connType'), 'GRIT');

  assert.equal(tabIdFor('GRIT', 7), 'grit-tabs-7');
  assert.equal(tabIdFor('SM', 7), 'tabs-7');
});

test('R11 enterManage runs the doc §6.1 sequence in order', () => {
  const calls: string[] = [];
  const host: ManageHost = {
    hideNonCoreApp: () => calls.push('hideNonCoreApp'),
    hideWelcome: () => calls.push('hideWelcome'),
    showSetUpMonitor: () => calls.push('showSetUpMonitor'),
    hideLandingPages: () => calls.push('hideLandingPages'),
    showSetupMonitorLanding: () => calls.push('showSetupMonitorLanding'),
    setTitle: (title) => calls.push('setTitle:' + title),
    switchIcon: () => calls.push('switchIcon'),
    applyLanguage: () => calls.push('applyLanguage'),
  };
  const { registry } = shell({}, (step) => calls.push(step));

  registry.enterManage(host);

  assert.deepEqual(calls, [
    'hideNonCoreApp',
    'hideWelcome',
    'showSetUpMonitor',
    'hideLandingPages',
    'showSetupMonitorLanding',
    'setTitle:Manage',
    'switchIcon',
    'hideTabs:PI|GRIT',
    'applyLanguage',
    'enableTabs:SM',
    'activate:tabs-1',
  ]);
  assert.deepEqual(registry.enterSteps(), ['hideTabs:PI|GRIT', 'enableTabs:SM', 'activate:tabs-1']);
});

test('R11 enterManage hides the GRIT static page, disables it, and activates #tabs-1', () => {
  const { registry } = shell();
  registry.enterManage(makeHost());

  assert.equal(registry.active, STATIC_TAB);
  assert.equal(registry.panel(STATIC_TAB)!.hasAttribute('hidden'), false);
  assert.equal(registry.isHidden(STATIC_TAB), false);
  assert.equal(registry.isHidden(GRIT_STATIC_TAB), true, 'connType GRIT is hidden');
  assert.equal(registry.isEnabled(STATIC_TAB), true, 'an SM static page stays usable');
  assert.equal(registry.isEnabled(GRIT_STATIC_TAB), false);
});

test('R12 enableTabs disables non-matching tabs instead of hiding them', () => {
  const { registry } = shell();
  registry.create(device(2, 'SM', 'sm-dev'));
  registry.create(device(3, 'GRIT', 'grit-dev'));

  registry.enableTabs('GRIT');
  const smLi = registry.tabElement('tabs-2')!;
  assert.equal(smLi.getAttribute('aria-disabled'), 'true');
  assert.ok(smLi.classList.contains('ui-state-disabled'), 'jQuery-UI disable marker');
  assert.equal(smLi.hasAttribute('hidden'), false, 'disabled is not hidden');
  assert.equal(registry.isEnabled('tabs-2'), false);
  assert.equal(registry.isEnabled('grit-tabs-3'), true);

  registry.enableTabs('SM');
  assert.equal(smLi.getAttribute('aria-disabled'), null);
  assert.ok(!smLi.classList.contains('ui-state-disabled'));
  assert.equal(registry.isEnabled('tabs-2'), true);
  assert.equal(registry.isEnabled('grit-tabs-3'), false);
});

test('R12 hidden is a separate axis from disabled (attribute, not HTMLElement.hidden)', () => {
  const { registry } = shell();
  registry.create(device(2));

  registry.setHidden('tabs-2', true);
  assert.equal(registry.isHidden('tabs-2'), true);
  assert.equal(registry.tabElement('tabs-2')!.hasAttribute('hidden'), true);
  assert.equal(registry.isEnabled('tabs-2'), true, 'a tab can be hidden and still enabled');

  registry.enableTabs('GRIT');
  assert.equal(registry.isEnabled('tabs-2'), false);
  assert.equal(registry.isHidden('tabs-2'), true, 'enableTabs must not unhide');
});

test('R45 getOpenState checks #<tab> in the DOM (the original #setupMonitorConn_* never existed)', () => {
  const { root, registry } = shell();

  assert.equal(registry.getOpenState('tabs-2'), false, 'not created yet');
  const record = registry.create(device(2));
  assert.equal(record.tab, 'tabs-2');
  assert.equal(registry.getOpenState('tabs-2'), false, 'default mirror keeps the dead lookup');

  const fixed = createTabRegistry({ mirrorOpenState: false });
  const fixedRoot = createDocument().createElement('div');
  fixed.buildShell(fixedRoot);
  fixed.create(device(2));
  assert.equal(fixed.getOpenState('tabs-2'), true);
  assert.ok(root.querySelector('#tabs-2'));

  registry.close('tabs-2', { loggingConfirmed: true });
  assert.equal(registry.getOpenState('tabs-2'), false, 'a closed tab is out of the DOM');

  // What the original queried instead — a selector the whole repo never creates, so it returned
  // `false` for every tab (jarvisInterface.js:1436-1449, doc R45 = "已知缺陷，复现时修正").
  assert.equal(root.querySelector('#setupMonitorConn_tabs-2'), null);
  assert.equal(root.querySelector('#gritConn_tabs-2'), null);
});

test('§3.1 allocIndex starts at 2 and a closed number is never reused', () => {
  const { registry } = shell();
  assert.equal(registry.counter, 2, 'tabCounter initialises to 2 (setUpMonitor.html:340)');

  const first = registry.allocIndex();
  assert.equal(first, 2);
  assert.equal(registry.counter, 3, 'allocIndex advances the counter');
  registry.create(device(first));

  const second = registry.allocIndex();
  assert.equal(second, 3);
  registry.create(device(second));
  assert.deepEqual(
    registry.list().map((record) => record.tab),
    ['tabs-1', 'grit-tabs-1', 'tabs-2', 'tabs-3'],
  );

  registry.close('tabs-2', { loggingConfirmed: true });
  const third = registry.allocIndex();
  assert.equal(third, 4, 'the closed index 2 is not handed out again');

  registry.create(device(third));
  assert.ok(registry.get('tabs-4'));
  assert.equal(registry.get('tabs-2'), undefined);

  // create() also keeps the counter ahead of any index handed to it.
  const fresh = createTabRegistry({ hooks: {} });
  const root = createDocument().createElement('div');
  fresh.buildShell(root);
  fresh.create(device(9));
  assert.equal(fresh.counter, 10);
  assert.equal(fresh.allocIndex(), 10);
});

test('§3.1 maxConnection = 10: the 11th simultaneous connection throws an error naming 10', () => {
  const { registry } = shell();
  for (let i = 0; i < MAX_CONNECTION; i++) registry.create(device(registry.allocIndex()));
  assert.equal(registry.countFor('SM'), MAX_CONNECTION);

  assert.throws(() => registry.create(device(registry.allocIndex())), /10/, 'error message names the limit');

  // The GRIT side shares the same budget ("含 GRIT 侧", doc §3.1).
  registry.close('tabs-2', { loggingConfirmed: true });
  const grit = registry.create(device(registry.allocIndex(), 'GRIT'));
  assert.equal(grit.connType, 'GRIT');
});

test('R49 close consults beforeClose and cancels the close when it returns false', () => {
  let asked = 0;
  const { registry } = shell({
    beforeClose: () => {
      asked++;
      return false;
    },
  });
  registry.create(device(2));

  const vetoed = registry.close('tabs-2');
  assert.equal(asked, 1, 'the device tab asks first');
  assert.equal(vetoed.removed, undefined, 'vetoed: nothing is removed');
  assert.equal(vetoed.activated, 'tabs-2', 'the tab stays active');
  assert.ok(registry.get('tabs-2'), 'still registered');
  assert.ok(registry.panel('tabs-2'), 'panel is still in the DOM');

  // The dialog's YES path sets loggingConfirmed and closes without asking again.
  const confirmed = registry.close('tabs-2', { loggingConfirmed: true });
  assert.equal(asked, 1);
  assert.equal(confirmed.removed?.tab, 'tabs-2');
  assert.equal(registry.get('tabs-2'), undefined);
});

test('R49 deviceToggleClicked skips the confirmation and forces #tabs-1', () => {
  const { registry } = shell({
    beforeClose: () => {
      throw new Error('beforeClose must not run when the device toggle initiated the close');
    },
  });
  registry.create(device(2));
  registry.create(device(3));
  registry.activate('tabs-3');

  const result = registry.close('tabs-3', { deviceToggleClicked: true });
  assert.equal(result.removed?.tab, 'tabs-3');
  assert.equal(result.activated, STATIC_TAB);
  assert.equal(registry.active, STATIC_TAB);
});

test('R49 static pages never trigger beforeClose (they have no device)', () => {
  let asked = 0;
  const { registry } = shell({
    beforeClose: () => {
      asked++;
      return false;
    },
  });
  const result = registry.close(STATIC_TAB);
  assert.equal(asked, 0, 'no device and no log to confirm');
  assert.equal(result.removed?.tab, STATIC_TAB);
});

test('§6.1 close removes both nodes and activates the right neighbour, else the left', () => {
  const { root, registry } = shell();
  registry.create(device(2));
  registry.create(device(3));
  registry.create(device(4));
  registry.activate('tabs-2');

  const result = registry.close('tabs-2', { loggingConfirmed: true });
  assert.equal(result.removed?.tab, 'tabs-2');
  assert.equal(result.activated, 'tabs-3', 'right neighbour wins');
  assert.equal(registry.active, 'tabs-3');
  assert.equal(registry.get('tabs-2'), undefined);
  assert.equal(root.querySelector('#tabs-2'), null, 'the panel is gone');
  assert.equal(root.querySelector('.tabs-2'), null, 'the li is gone');
  assert.equal(registry.panel('tabs-3')!.hasAttribute('hidden'), false);

  // The last tab has no right neighbour, so the left one is chosen.
  registry.activate('tabs-4');
  const last = registry.close('tabs-4', { loggingConfirmed: true });
  assert.equal(last.activated, 'tabs-3');
});

test('§6.1 closing the last device tab falls back to #tabs-1', () => {
  const { registry } = shell();
  registry.create(device(2));
  const result = registry.close('tabs-2', { loggingConfirmed: true });
  assert.equal(result.activated, STATIC_TAB);
  assert.equal(registry.active, STATIC_TAB);
});

test('§6.1 closing a non-active tab leaves the active one in place', () => {
  const { registry } = shell();
  registry.create(device(2));
  registry.create(device(3));
  registry.activate('tabs-2');

  const result = registry.close('tabs-3', { loggingConfirmed: true });
  assert.equal(result.activated, 'tabs-2');
  assert.equal(registry.active, 'tabs-2');
});

test('§3.1 rememberScroll / scrollTop round-trips when switching back', () => {
  const { registry } = shell();
  registry.create(device(2));
  assert.equal(registry.scrollTop('tabs-2'), 0, 'absent entries default to 0');

  registry.rememberScroll('tabs-2', 420);
  assert.equal(registry.scrollTop('tabs-2'), 420);

  registry.activate(STATIC_TAB);
  registry.activate('tabs-2');
  assert.equal(registry.scrollTop('tabs-2'), 420, 'setUpMonitor.html:350-352 restores it on switch-back');
});

test('§3.1 byDevice returns both the SM and the GRIT tab of one device', () => {
  const { registry } = shell();
  registry.create(device(2, 'SM', 'tile-9'));
  registry.create(device(3, 'GRIT', 'tile-9'));
  registry.create(device(4, 'SM', 'tile-10'));

  assert.deepEqual(registry.byDevice('tile-9').map((record) => record.tab), ['tabs-2', 'grit-tabs-3']);
  assert.deepEqual(registry.byDevice('tile-9').map((record) => record.connType), ['SM', 'GRIT']);
  assert.deepEqual(registry.byDevice('tile-10').map((record) => record.tab), ['tabs-4']);
});

test('§3.1 countFor counts device tabs only, not the static "Add device" page', () => {
  const { registry } = shell();
  assert.equal(registry.countFor('SM'), 0);

  registry.create(device(2, 'SM'));
  registry.create(device(3, 'GRIT'));
  assert.equal(registry.countFor('SM'), 1);
  assert.equal(registry.countFor('GRIT'), 1);

  registry.close('tabs-2', { loggingConfirmed: true });
  assert.equal(registry.countFor('SM'), 0);
});

test('§6.1 setStatus / status and setCurrentApp / currentApp', () => {
  const { registry } = shell();
  registry.create(device(2));

  assert.equal(registry.status('tabs-2'), 'connecting');
  registry.setStatus('tabs-2', 'lost');
  assert.equal(registry.status('tabs-2'), 'lost');
  assert.equal(registry.get('tabs-2')!.status, 'lost');
  registry.setStatus('tabs-2', 'ready');
  assert.equal(registry.status('tabs-2'), 'ready');
  assert.equal(registry.status('nope'), undefined);

  assert.equal(registry.currentApp(), 'HOME');
  registry.setCurrentApp('GRIT');
  assert.equal(registry.currentApp(), 'GRIT');
});

test('§3.1 create activates the new tab (addTab sets tabs("option","active"))', () => {
  const { registry } = shell();
  registry.create(device(2));
  assert.equal(registry.active, 'tabs-2');
  assert.equal(registry.panel('tabs-2')!.hasAttribute('hidden'), false);

  const third = registry.create(device(3));
  assert.equal(registry.active, third.tab);
  assert.equal(registry.panel('tabs-2')!.hasAttribute('hidden'), true, 'only one panel is open');
});

test('activate opens exactly one panel and keeps SM/GRIT panels independent', () => {
  const activated: string[] = [];
  const { registry } = shell({ onActivate: (tab) => activated.push(tab) });
  registry.create(device(2, 'SM'));
  registry.create(device(3, 'GRIT'));

  registry.activate('tabs-2');
  assert.equal(registry.panel('tabs-2')!.hasAttribute('hidden'), false);
  assert.equal(registry.panel('grit-tabs-3')!.hasAttribute('hidden'), true);
  assert.equal(registry.panel(STATIC_TAB)!.hasAttribute('hidden'), true);

  registry.activate('grit-tabs-3');
  assert.equal(registry.panel('tabs-2')!.hasAttribute('hidden'), true);
  assert.equal(registry.panel('grit-tabs-3')!.hasAttribute('hidden'), false);

  assert.deepEqual(activated, ['tabs-2', 'grit-tabs-3', 'tabs-2', 'grit-tabs-3']);
  assert.equal(registry.active, 'grit-tabs-3');
});
