/**
 * ConnectionFlow tests.
 *
 * Every test name carries the acceptance id it pins down (R28 / R29 / R30 / R36 / R37 / R43 of
 * `03_分析/00_通信协议与调度核心.md §8` and `01_Manage主界面与视图层.md §8`), or the exact
 * source line when the behaviour has no R number yet. Where the analysis document and the
 * unpacked source disagree, the source wins and the test says so.
 *
 * All four loader budgets are asserted through `pendingTimeout(tab)` / `pendingTimeouts(tab)`
 * against a `FakeClock`, so no test ever waits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeClock } from '../src/clock.ts';
import {
  createConnectionFlow,
  flattenRegister,
  isExcludedByFeatures,
} from '../src/connection.ts';
import type {
  ConnectionFlowConfig,
  ConnectionFlowRuntime,
  InitialLogsSource,
} from '../src/connection.ts';
import { DEFAULT_FEATURES } from '../src/types.ts';
import type {
  ConnectionDetails,
  DecodedLog,
  FeatureFlags,
  ManageRuntime,
  ReceiverSession,
  TabId,
} from '../src/types.ts';

/* ------------------------------------------------------------------ stubs */

interface Recorded {
  fn: string;
  args: unknown[];
}

/** Records call order and counts; nothing here touches a DOM or another module. */
class RecordingRuntime implements ManageRuntime {
  calls: Recorded[] = [];

  private record(fn: string, ...args: unknown[]): void {
    this.calls.push({ fn, args });
  }

  buildPanels(tab: TabId): void {
    this.record('buildPanels', tab);
  }
  buildTiles(tab: TabId): void {
    this.record('buildTiles', tab);
  }
  applyLanguage(tab?: TabId): void {
    this.record('applyLanguage', tab);
  }
  restorePersistedPage(tab: TabId): void {
    this.record('restorePersistedPage', tab);
  }
  showApplicationLoader(text?: string): void {
    this.record('showApplicationLoader', text);
  }
  hideApplicationLoader(): void {
    this.record('hideApplicationLoader');
  }
  showConnectionLoader(tab: TabId): void {
    this.record('showConnectionLoader', tab);
  }
  hideConnectionLoader(tab: TabId): void {
    this.record('hideConnectionLoader', tab);
  }
  sendLog(tab: TabId, logName: string, spec: string): void {
    this.record('sendLog', tab, logName, spec);
  }
  unlogAll(tab: TabId): void {
    this.record('unlogAll', tab);
  }
  onConnectionLost(tab: TabId): void {
    this.record('onConnectionLost', tab);
  }

  count(fn: string): number {
    return this.calls.filter((call) => call.fn === fn).length;
  }
  order(): string[] {
    return this.calls.map((call) => call.fn);
  }
  sentNames(): string[] {
    return this.calls.filter((call) => call.fn === 'sendLog').map((call) => String(call.args[1]));
  }
  sentSpecs(): string[] {
    return this.calls.filter((call) => call.fn === 'sendLog').map((call) => String(call.args[2]));
  }
}

/** Minimal stand-in for `ReceiverSession`'s event surface. */
class FakeSession {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, fn: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, fn: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((entry) => entry !== fn));
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  log(): void {}
  unlog(): void {}
  resolveMessageId(): number {
    return 0;
  }
}

/* ---------------------------------------------------------------- fixtures */

const TEST_LOGS: InitialLogsSource = {
  statusComponents: [
    { component: 'statusBar', logName: 'bestposb', spec: 'ontime,1' },
    { component: 'statusBar', logName: 'inspvaxb', spec: 'ontime,1' },
    { component: 'statusBar', logName: 'inscommandb', spec: 'ontime,1' },
    { component: 'statusBar', logName: 'sourcetableb', spec: 'once,0' },
    { component: 'alignStatus', logName: 'heading2b', spec: 'onchanged,0' },
    { component: 'radioStatus', logName: 'satelstatusb', spec: 'ontime,1' },
    { component: 'radioStatus', logName: 'sateldetectb', spec: 'onchanged,0' },
  ],
  configComponents: [
    { component: 'portConfig', logName: 'serialconfigb', spec: 'ontime,1' },
    { component: 'portConfig', logName: 'sourcetableb', spec: 'once,0' },
  ],
};

function details(over: Partial<ConnectionDetails> = {}): ConnectionDetails {
  return { type: 'eth', ipAddress: '10.0.0.1', port: 2000, ...over };
}

function versionLog(model: string): DecodedLog {
  return { messageId: 37, name: 'VERSION', fields: { model }, blocks: [] } as unknown as DecodedLog;
}

function plainLog(name = 'BESTPOS', messageId = 42): DecodedLog {
  return { messageId, name, fields: {}, blocks: [] } as unknown as DecodedLog;
}

interface Harness {
  clock: FakeClock;
  runtime: RecordingRuntime;
  flow: ConnectionFlowRuntime;
  features: FeatureFlags;
}

function makeFlow(over: Partial<ConnectionFlowConfig> = {}): Harness {
  const clock = new FakeClock();
  const runtime = new RecordingRuntime();
  const features: FeatureFlags = { ...DEFAULT_FEATURES };
  const flow = createConnectionFlow({
    clock,
    runtime,
    features: () => features,
    connectionTimeoutMs: 1000,
    initialLogs: TEST_LOGS,
    ...over,
  });
  return { clock, runtime, flow, features };
}

/* ------------------------------------------------- time budgets (35/40/30/1200) */

test('newConnection 装 35 s 保护（jarvisInterface.js:820-839），pendingTimeout 报告默认 35000', () => {
  const { flow } = makeFlow({ connectionTimeoutMs: undefined });
  flow.newConnection('tabs-3', details());
  assert.equal(flow.pendingTimeout('tabs-3'), 35_000);
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), [
    { kind: 'connection', remaining: 35_000 },
  ]);
});

test('35 s 到点前不判死，到点后 lost + hideApplicationLoader + onConnectionLost（jarvisInterface.js:820-839）', () => {
  const { flow, clock, runtime } = makeFlow({ connectionTimeoutMs: undefined });
  flow.newConnection('tabs-3', details());

  clock.advance(34_999);
  assert.equal(flow.isLost('tabs-3'), false);
  assert.equal(runtime.count('onConnectionLost'), 0);
  assert.equal(flow.pendingTimeout('tabs-3'), 1);

  clock.advance(1);
  assert.equal(flow.isLost('tabs-3'), true);
  assert.equal(runtime.count('hideApplicationLoader'), 1);
  assert.deepEqual(runtime.calls.filter((c) => c.fn === 'onConnectionLost')[0].args, ['tabs-3']);
  assert.equal(flow.pendingTimeout('tabs-3'), undefined);
});

test('connectionTimeoutMs 覆盖 35 s（测试用 1000）', () => {
  const { flow, clock } = makeFlow({ connectionTimeoutMs: 1000 });
  flow.newConnection('tabs-3', details());
  assert.equal(flow.pendingTimeout('tabs-3'), 1000);
  clock.advance(1000);
  assert.equal(flow.isLost('tabs-3'), true);
});

test('R30 showConnectionLoader：addTab 场景 1200 ms 自动隐藏，30 s 兜底', () => {
  const { flow, clock, runtime } = makeFlow();
  flow.showConnectionLoader('tabs-3');

  assert.equal(flow.connectionLoaderDelay('tabs-3'), 1_200);
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), [
    { kind: 'connectionLoader', remaining: 1_200 },
    { kind: 'connectionLoaderBackstop', remaining: 30_000 },
  ]);
  assert.equal(flow.pendingTimeout('tabs-3'), 1_200);

  clock.advance(1_200 - 1);
  assert.equal(runtime.count('hideConnectionLoader'), 0);

  clock.advance(1);
  assert.equal(runtime.count('hideConnectionLoader'), 1);
  // Source beats document: `hideConnectionLoader` (genericView.js:1031-1032) clears the pending
  // backstop, so after the 1200 ms auto-hide nothing of this loader is left armed.
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), []);
});

test('R30 GRIT 场景 500 ms 自动隐藏', () => {
  const { flow, clock, runtime } = makeFlow();
  flow.showConnectionLoader('grit-tabs-3');
  assert.equal(flow.connectionLoaderDelay('grit-tabs-3'), 500);
  assert.equal(flow.pendingTimeout('grit-tabs-3'), 500);
  clock.advance(500);
  assert.equal(runtime.count('hideConnectionLoader'), 1);
});

test('R30 30 s 兜底真的会触发（把自动隐藏推迟到 40 s 时由兜底先关）', () => {
  const { flow, clock, runtime } = makeFlow({ connectionLoaderMs: 40_000 });
  flow.showConnectionLoader('tabs-3');
  assert.equal(flow.pendingTimeout('tabs-3'), 30_000);
  clock.advance(30_000);
  assert.equal(runtime.count('hideConnectionLoader'), 1);
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), []);
});

test("R43 showApplicationLoader 连接流程用 40 s；超时 hide + runtime.showApplicationLoader('CONNECTING') 复位文案", () => {
  const { flow, clock, runtime } = makeFlow();
  flow.showApplicationLoader('tabs-3');

  assert.equal(flow.pendingTimeout('tabs-3'), 40_000);
  assert.deepEqual(runtime.calls[0], { fn: 'showApplicationLoader', args: [undefined] });

  clock.advance(40_000);
  const shown = runtime.calls.filter((c) => c.fn === 'showApplicationLoader');
  assert.equal(shown.length, 2, 'the timeout re-shows the loader with the reset text');
  assert.deepEqual(shown[1].args, ['CONNECTING']);
  assert.equal(shown[0].args[0], undefined, 'showing it first does not force a text');
  assert.equal(runtime.count('hideApplicationLoader'), 1);
  assert.equal(flow.pendingTimeout('tabs-3'), undefined);
});

test('R43 提供 resetLoaderText 钩子时优先用它，不再走 showApplicationLoader 复位', () => {
  const clock = new FakeClock();
  const runtime = new RecordingRuntime();
  const calls: TabId[] = [];
  const flow = createConnectionFlow({
    clock,
    runtime,
    features: () => ({ ...DEFAULT_FEATURES }),
    initialLogs: TEST_LOGS,
    resetLoaderText: (tab) => calls.push(tab),
  });
  flow.showApplicationLoader('tabs-3');
  clock.advance(40_000);
  assert.deepEqual(calls, ['tabs-3']);
  assert.equal(runtime.count('showApplicationLoader'), 1, 'only the initial show, no text reset');
});

/* --------------------------------------------------------- readiness gate (R28) */

test('R28 只有收到 VERSIONB 且识别出型号后 isReady 才为真，且 UI 按顺序构建', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.connectionStatus('connectionsuccess', 'tabs-3');
  assert.equal(flow.isReady('tabs-3'), false, 'R29: success does not imply ready');

  flow.handleLog(versionLog('OEM7'), 'tabs-3');
  assert.equal(flow.isReady('tabs-3'), true);
  assert.deepEqual(runtime.order(), [
    'hideApplicationLoader',
    'buildPanels',
    'buildTiles',
    'restorePersistedPage',
    'applyLanguage',
    'sendLog',
    'sendLog',
  ]);
  assert.deepEqual(runtime.calls[5].args, ['tabs-3', 'bestposb', 'ontime,1']);
});

test('R28 VERSION 之前的其它日志被丢弃并计入 ignoredBeforeReady', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.connectionStatus('connectionsuccess', 'tabs-3');

  flow.handleLog(plainLog('BESTPOS', 42), 'tabs-3');
  flow.handleLog(plainLog('HWMONITOR', 963), 'tabs-3');

  assert.equal(flow.ignoredBeforeReady('tabs-3'), 2);
  assert.equal(runtime.count('buildPanels'), 0, 'nothing may be built before VERSIONB');
  assert.equal(flow.isReady('tabs-3'), false);
});

test('R28 第二次 VERSION（重连）不重复建面板', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.connectionStatus('connectionsuccess', 'tabs-3');
  flow.handleLog(versionLog('OEM7'), 'tabs-3');
  flow.handleLog(versionLog('OEM7'), 'tabs-3');

  assert.equal(runtime.count('buildPanels'), 1);
  assert.equal(runtime.count('buildTiles'), 1);
});

test('R28 VERSION 无法识别型号时不放行（空 model）', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog(''), 'tabs-3');
  assert.equal(flow.isReady('tabs-3'), false);
  assert.equal(runtime.count('buildPanels'), 0);
});

test('newConnection 注入 session 时，VERSION 日志与 ready 事件都能放行', () => {
  const { flow, runtime } = makeFlow();
  const session = new FakeSession();
  flow.newConnection('tabs-3', details(), session as unknown as ReceiverSession);

  session.emit('log', versionLog('SPAN7'));
  assert.equal(flow.isReady('tabs-3'), true);
  assert.equal(flow.modelOf('tabs-3'), 'SPAN7');
  assert.equal(runtime.count('buildPanels'), 1);
});

/* -------------------------------------------------- connectionStatus branches */

test('connectionStatus 成功分支清掉 35 s 定时器，失败分支置 lost 并存 error', () => {
  const { flow, clock, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.connectionStatus('connectionsuccess', 'tabs-3', 'ignored-on-success');
  assert.equal(flow.pendingTimeout('tabs-3'), undefined);
  // Success *does* hide the application loader (`jarvisInterface.js:2934`), before the gate check.
  assert.equal(runtime.count('hideApplicationLoader'), 1);

  flow.newConnection('tabs-4', details());
  const error = new Error('boom');
  flow.connectionStatus('connectionfailure', 'tabs-4', error);
  assert.equal(flow.isLost('tabs-4'), true);
  assert.equal(flow.lastError('tabs-4'), error);
  assert.equal(flow.pendingTimeout('tabs-4'), undefined);
  clock.advance(60_000);
  assert.equal(runtime.count('onConnectionLost'), 0, 'the cleared 35 s guard must not fire');
});

/* ----------------------------------------------------------- newConnection */

test('newConnection 记住 details，detailsOf 返回副本', () => {
  const { flow } = makeFlow();
  flow.newConnection('tabs-3', details({ name: 'RX-1' }));
  const seen = flow.detailsOf('tabs-3');
  assert.equal(seen?.name, 'RX-1');
  assert.equal(seen?.port, 2000);
  seen!.port = 9;
  assert.equal(flow.detailsOf('tabs-3')?.port, 2000, 'the internal record is not aliased');
});

test('VERSIONB 识别后 model 写回 details（types.ts ConnectionDetails.model）', () => {
  const { flow } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('OEM7700'), 'tabs-3');
  assert.equal(flow.detailsOf('tabs-3')?.model, 'OEM7700');
  assert.equal(flow.modelOf('tabs-3'), 'OEM7700');
});

test('已 ready 或已关闭的 tab 再调 newConnection 幂等，不重复装定时器', () => {
  const { flow } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.connectionStatus('connectionsuccess', 'tabs-3');
  flow.handleLog(versionLog('OEM7'), 'tabs-3');
  flow.newConnection('tabs-3', details());
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), [], 'ready tab gets no fresh 35 s guard');

  const second = makeFlow();
  second.flow.newConnection('tabs-5', details());
  second.flow.closeTab('tabs-5');
  second.flow.newConnection('tabs-5', details());
  assert.deepEqual(second.flow.pendingTimeouts('tabs-5'), [], 'closed tab stays closed');
});

test('playback 连接不装 35 s 定时器（jarvisInterface.js:819）', () => {
  const { flow } = makeFlow();
  flow.newConnection('tabs-3', details({ type: 'playback', playbackFileName: 'a.sbf' }));
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), []);
});

/* ------------------------------------------------------ requestInitialLogs */

test('无 SPAN / 无 ALIGN / 无 radioTx 时按 §6.1 跳过对应条目，顺序不变', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('OEM7'), 'tabs-3');

  assert.deepEqual(runtime.sentNames(), ['bestposb', 'sourcetableb']);
  assert.deepEqual(runtime.sentSpecs(), ['ontime,1', 'once,0'], 'spec is the register value verbatim');
  assert.deepEqual(flow.requestedLogs('tabs-3'), ['bestposb', 'sourcetableb']);
});

test('SPAN + ALIGN + radioTx 齐全时清单顺序与 compLogsRegister 一致', () => {
  const { flow, runtime, features } = makeFlow();
  features.spanSupported = true;
  features.alignSupported = true;
  features.radioTxSupported = true;

  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('SPAN7'), 'tabs-3');

  assert.deepEqual(runtime.sentNames(), [
    'bestposb',
    'inspvaxb',
    'inscommandb',
    'sourcetableb',
    'heading2b',
    'satelstatusb',
    'sateldetectb',
  ]);
});

test('OEMSTAR 世代跳过 sourcetableb', () => {
  const { flow, runtime, features } = makeFlow();
  features.generation = 'OEMSTAR';
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('OEMSTAR1'), 'tabs-3');
  assert.equal(runtime.sentNames().includes('sourcetableb'), false);
});

test('initConfigPage 为真时改用 configComponents', () => {
  const { flow, runtime } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.setInitConfigPage('tabs-3', true);
  assert.equal(flow.initConfigPage('tabs-3'), true);
  flow.handleLog(versionLog('OEM7'), 'tabs-3');
  assert.deepEqual(runtime.sentNames(), ['serialconfigb', 'sourcetableb']);
});

test('默认清单直接来自 packages/protocol/data/components.json', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', '..', 'protocol', 'data', 'components.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as {
    compLogsRegister: Record<string, Record<string, string>>;
    statusComponents: string[];
  };
  const register = json.compLogsRegister;
  const excludedForDefaults = new Set([
    'inspvaxb',
    'inscommandb',
    'setimueventb',
    'insconfigb',
    'heading2b',
    'satelstatusb',
    'sateldetectb',
  ]);
  const expected: Array<{ logName: string; spec: string }> = [];
  for (const component of json.statusComponents) {
    for (const [logName, spec] of Object.entries(register[component] ?? {})) {
      if (!excludedForDefaults.has(logName)) expected.push({ logName, spec });
    }
  }

  const { flow, runtime } = makeFlow({ initialLogs: undefined });
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('OEM7'), 'tabs-3');

  assert.deepEqual(runtime.sentNames(), expected.map((entry) => entry.logName));
  assert.deepEqual(runtime.sentSpecs(), expected.map((entry) => entry.spec));
  assert.equal(expected.length > 0, true);
  assert.equal(runtime.sentNames()[0], 'lbandbeamtableb', 'satelliteView is first in statusComponents');
});

/* --------------------------------------------------------------- closeTab */

test('R36 closeTab 只 UNLOG 本 tab 独有的日志，共享的不动', () => {
  // Both names the tab requests are declared shared (a sibling tab of the same device holds them).
  const { flow, runtime } = makeFlow({
    sharedLogs: () => ['bestposb', 'sourcetableb'],
  });
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('SPAN7'), 'tabs-3');
  assert.deepEqual(flow.requestedLogs('tabs-3'), ['bestposb', 'sourcetableb']);

  flow.closeTab('tabs-3');
  assert.deepEqual(flow.sharedLogNames('tabs-3'), ['bestposb', 'sourcetableb']);
  assert.deepEqual(flow.unloggedLogs('tabs-3'), []);
  assert.equal(runtime.count('unlogAll'), 0, 'a fully shared tab must not UNLOG');
});

test('R36 closeTab 有独有日志时调用 runtime.unlogAll 并记账', () => {
  const { flow, runtime, features } = makeFlow();
  features.spanSupported = true;
  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('SPAN7'), 'tabs-3');

  flow.closeTab('tabs-3');
  assert.deepEqual(flow.unloggedLogs('tabs-3'), ['bestposb', 'inspvaxb', 'inscommandb', 'sourcetableb']);
  assert.deepEqual(runtime.calls.filter((c) => c.fn === 'unlogAll')[0].args, ['tabs-3']);
});

test('R37 同设备两个 tab 共享日志：deviceOf 让他们互相认定为共享', () => {
  const { flow, runtime } = makeFlow({
    deviceOf: () => 'tile-77',
    sharedLogs: undefined,
  });

  flow.newConnection('tabs-3', details());
  flow.handleLog(versionLog('SPAN7'), 'tabs-3');
  flow.newConnection('grit-tabs-4', details());
  flow.handleLog(versionLog('SPAN7'), 'grit-tabs-4');

  assert.deepEqual(flow.sharedLogNames('tabs-3'), flow.requestedLogs('grit-tabs-4'));

  flow.closeTab('tabs-3');
  assert.deepEqual(flow.unloggedLogs('tabs-3'), [], 'every log is also held by the sibling tab');
  assert.equal(runtime.count('unlogAll'), 0);
});

test('closeTab 清状态与定时器并把 tab 标记为 closed', () => {
  const { flow } = makeFlow();
  flow.newConnection('tabs-3', details());
  flow.showConnectionLoader('tabs-3');
  flow.closeTab('tabs-3');
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), []);
  assert.equal(flow.isReady('tabs-3'), false);
  assert.equal(flow.isLost('tabs-3'), false);
  flow.handleLog(versionLog('OEM7'), 'tabs-3');
  assert.equal(flow.isReady('tabs-3'), false, 'a closed tab ignores later logs');
});

/* ------------------------------------------------------------- accessors */

test('pendingTimeout 在 newConnection 之前为 undefined', () => {
  const { flow } = makeFlow();
  assert.equal(flow.pendingTimeout('tabs-3'), undefined);
  assert.deepEqual(flow.pendingTimeouts('tabs-3'), []);
  assert.equal(flow.detailsOf('tabs-3'), undefined);
  assert.equal(flow.ignoredBeforeReady('tabs-3'), 0);
  assert.equal(flow.lastError('tabs-3'), undefined);
});
