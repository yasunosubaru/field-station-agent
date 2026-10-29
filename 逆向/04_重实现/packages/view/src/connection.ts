/**
 * ConnectionFlow — the tab connection lifecycle of the original `jarvisInterface.js`.
 *
 * Mirrors `newConnection` (:815-864), `connectionStatus` (:2858-2991), `checkConnectionReady`
 * (:1450-1970) and `requestInitialLogs` (:2693-2747), plus the loader budgets the original
 * spreads over `genericView.js:1008-1035` and `setUpMonitor.html:382-427`.
 *
 * The four timer budgets the acceptance criteria single out (all evidenced in the original):
 *  - 35 000 ms  the `newConnection` guard                — jarvisInterface.js:820-839
 *  - 40 000 ms  the connection flow's application loader — setUpMonitor.html:1454,1505,1521
 *  - 30 000 ms  the tab connection loader's backstop     — genericView.js:1022-1035
 *  -  1 200 ms  `addTab`'s connection-loader auto-hide   — setUpMonitor.html:408-410 (GRIT 500 ms :415-417)
 *
 * Two behaviours are reimplemented on purpose and are *not* in the original:
 *  - `unlogAll` accounting is observable (`unloggedLogs` / `sharedLogNames`), because R36 (only
 *    tab-unique logs may be UNLOGged) cannot be checked from the original's side effects;
 *  - the 40 s loader timeout resets the text through `runtime.showApplicationLoader('CONNECTING')`
 *    when no `resetLoaderText` hook is supplied, because `ManageRuntime` has no such member.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { guessGeneration } from '../../session/src/session.ts';
import { DEFAULT_FEATURES } from './types.ts';
import { isGritTab } from './ids.ts';
import type { Clock } from './clock.ts';
import type {
  ConnectionDetails,
  ConnectionFlow,
  ConnectionFlowOptions,
  ConnectionStatusKind,
  DecodedLog,
  DeviceTileId,
  FeatureFlags,
  ManageRuntime,
  ReceiverSession,
  TabId,
  TabStatus,
} from './types.ts';

/** The VERSIONB message id (`NovatelIdConstants.messageIdConstants.versionMessageId`). */
export const VERSION_MESSAGE_ID = 37;

export const DEFAULT_CONNECTION_TIMEOUT_MS = 35_000;
export const DEFAULT_APPLICATION_LOADER_MS = 40_000;
export const DEFAULT_CONNECTION_LOADER_BACKSTOP_MS = 30_000;
export const SM_CONNECTION_LOADER_MS = 1_200;
export const GRIT_CONNECTION_LOADER_MS = 500;

/* --------------------------------------------------------------- log lists */

/** One `compLogsRegister` entry, already ordered by its component list. */
export interface InitialLogEntry {
  component: string;
  /** verbatim register key, e.g. `bestposb` (trailing `b` kept — `sendLog` gets it as-is). */
  logName: string;
  /** verbatim register value, e.g. `ontime,1` / `onchanged,0` / `once,0`. */
  spec: string;
}

export interface InitialLogsSource {
  statusComponents: InitialLogEntry[];
  configComponents: InitialLogEntry[];
}

interface ComponentsJson {
  compLogsRegister?: Record<string, Record<string, string>>;
  statusComponents?: string[];
  configComponents?: string[];
}

export function flattenRegister(
  register: Record<string, Record<string, string>>,
  components: string[],
): InitialLogEntry[] {
  const out: InitialLogEntry[] = [];
  for (const component of components) {
    const group = register[component];
    if (!group) continue;
    for (const [logName, spec] of Object.entries(group)) out.push({ component, logName, spec });
  }
  return out;
}

/**
 * Reads `packages/protocol/data/components.json`. `compLogsRegister` is walked in the order of
 * `statusComponents` / `configComponents`, exactly like `compReqlogs` (`jarvisInterface.js:5246`).
 */
export function loadInitialLogsSource(file?: string): InitialLogsSource {
  const path =
    file ?? join(dirname(fileURLToPath(import.meta.url)), '../../protocol/data/components.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as ComponentsJson;
  const register = json.compLogsRegister ?? {};
  return {
    statusComponents: flattenRegister(register, json.statusComponents ?? []),
    configComponents: flattenRegister(register, json.configComponents ?? []),
  };
}

let cachedDefaultSource: InitialLogsSource | undefined;

function defaultInitialLogsSource(): InitialLogsSource {
  if (!cachedDefaultSource) cachedDefaultSource = loadInitialLogsSource();
  return cachedDefaultSource;
}

/**
 * `compReqlogs`' capability filter (`jarvisInterface.js:5254-5289`), limited to the cases the
 * acceptance criteria name. `spanSupported === false` is the reimplementation's spelling of the
 * original `featuresList.getSPANSupported(tab) == -1`.
 */
export function isExcludedByFeatures(entry: InitialLogEntry, features: FeatureFlags): boolean {
  const name = entry.logName.toLowerCase();
  if ((name === 'inspvaxb' || name === 'inscommandb' || name === 'setimueventb' || name === 'insconfigb') && !features.spanSupported) {
    return true;
  }
  if (name === 'heading2b' && !features.alignSupported) return true;
  if (name === 'sourcetableb' && features.generation === 'OEMSTAR') return true;
  if (entry.component === 'radioStatus' && !features.radioTxSupported) return true;
  return false;
}

/* ------------------------------------------------------------------- flow */

export type LoaderTimerKind =
  | 'connection'
  | 'applicationLoader'
  | 'connectionLoader'
  | 'connectionLoaderBackstop';

export interface PendingTimeout {
  kind: LoaderTimerKind;
  /** Milliseconds until it fires, measured on the injected clock. */
  remaining: number;
}

/** Extra hooks the wiring passes in; none of them exist on `ConnectionFlowOptions`. */
export interface ConnectionFlowHooks {
  /** Names that must NOT be UNLOGged when this tab closes (R36). Overrides the default. */
  sharedLogs?: (tab: TabId) => string[];
  /** Which device tile a tab belongs to; two tabs of one device share their logs (R37). */
  deviceOf?: (tab: TabId) => DeviceTileId;
  /** R43's text reset. Falls back to `runtime.showApplicationLoader('CONNECTING')`. */
  resetLoaderText?: (tab: TabId) => void;
  /** Overrides the addTab connection-loader auto-hide (1200 ms SM / 500 ms GRIT). */
  connectionLoaderMs?: number;
  applicationLoaderMs?: number;
  connectionLoaderBackstopMs?: number;
  initialLogs?: InitialLogsSource;
}

export interface ConnectionFlowConfig extends ConnectionFlowOptions, ConnectionFlowHooks {}

/**
 * `ConnectionFlow` plus the observability the tests (and `manage.ts`) need. Only the interface
 * of `types.ts` is frozen; this one is additive and lives with the implementation.
 */
export interface ConnectionFlowRuntime extends ConnectionFlow {
  detailsOf(tab: TabId): ConnectionDetails | undefined;
  lastError(tab: TabId): unknown;
  ignoredBeforeReady(tab: TabId): number;
  modelOf(tab: TabId): string;
  initConfigPage(tab: TabId): boolean;
  setInitConfigPage(tab: TabId, value: boolean): void;
  /** R43 — 40 s guard plus the `CONNECTING` text reset. */
  showApplicationLoader(tab: TabId, ms?: number): void;
  hideApplicationLoader(tab: TabId): void;
  /** R30 — arms the auto-hide and the 30 s backstop. */
  showConnectionLoader(tab: TabId): void;
  hideConnectionLoader(tab: TabId): void;
  connectionLoaderDelay(tab: TabId): number;
  pendingTimeout(tab: TabId): number | undefined;
  pendingTimeouts(tab: TabId): PendingTimeout[];
  requestedLogs(tab: TabId): string[];
  sharedLogNames(tab: TabId): string[];
  /** R36 accounting: the tab-unique logs that were handed to `runtime.unlogAll`. */
  unloggedLogs(tab: TabId): string[];
  dispose(): void;
}

interface ArmedTimer {
  handle: number;
  at: number;
}

interface TabState {
  details: ConnectionDetails;
  status: TabStatus;
  ready: boolean;
  sawVersion: boolean;
  identified: boolean;
  model: string;
  ignored: number;
  error: unknown;
  initConfigPage: boolean;
  requested: string[];
  unlogged: string[];
  session?: ReceiverSession;
  sessionListeners?: { onLog: (log: DecodedLog) => void; onReady: (generation: string) => void };
}

function copyDetails(details: ConnectionDetails): ConnectionDetails {
  return { ...details };
}

function versionModel(log: DecodedLog): string {
  const fields = log.fields ?? {};
  const fromFields = fields.model ?? fields.receiverModel ?? fields.hardwareVersion;
  if (typeof fromFields === 'string' && fromFields) return fromFields;
  for (const block of log.blocks ?? []) {
    const value = block?.model;
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

class Flow implements ConnectionFlowRuntime {
  private readonly clock: Clock;
  private readonly runtime: ManageRuntime;
  private readonly featuresFn: () => FeatureFlags;
  private readonly connectionTimeoutMs: number;
  private readonly applicationLoaderMs: number;
  private readonly connectionLoaderBackstopMs: number;
  private readonly connectionLoaderOverride?: number;
  private readonly hooks: ConnectionFlowHooks;
  private readonly states = new Map<TabId, TabState>();
  private readonly timers = new Map<TabId, Map<LoaderTimerKind, ArmedTimer>>();
  private source?: InitialLogsSource;

  constructor(options: ConnectionFlowConfig) {
    this.clock = options.clock;
    this.runtime = options.runtime;
    this.featuresFn = options.features;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.applicationLoaderMs = options.applicationLoaderMs ?? DEFAULT_APPLICATION_LOADER_MS;
    this.connectionLoaderBackstopMs = options.connectionLoaderBackstopMs ?? DEFAULT_CONNECTION_LOADER_BACKSTOP_MS;
    this.connectionLoaderOverride = options.connectionLoaderMs;
    this.hooks = {
      sharedLogs: options.sharedLogs,
      deviceOf: options.deviceOf,
      resetLoaderText: options.resetLoaderText,
    };
    this.source = options.initialLogs;
  }

  /* ----------------------------------------------------------- newConnection */

  newConnection(tab: TabId, details: ConnectionDetails, session?: ReceiverSession): void {
    const existing = this.states.get(tab);
    // Idempotent for a tab that is already up or already gone (no second 35 s timer).
    if (existing && (existing.ready || existing.status === 'closed')) return;

    const state: TabState = existing ?? {
      details: copyDetails(details),
      status: 'connecting',
      ready: false,
      sawVersion: false,
      identified: false,
      model: '',
      ignored: 0,
      error: undefined,
      initConfigPage: false,
      requested: [],
      unlogged: [],
    };
    state.details = copyDetails(details);
    state.status = 'connecting';
    this.states.set(tab, state);

    if (details.type === 'playback') {
      // `jarvisInterface.js:2867-2891` — a playback tab is ready at once, no VERSIONB needed.
      state.sawVersion = true;
      state.identified = true;
      state.requested = [];
      return;
    }

    // 35 s guard — `jarvisInterface.js:820-839`.
    this.armTimer(tab, 'connection', this.connectionTimeoutMs, () => {
      state.status = 'lost';
      state.ready = false;
      this.runtime.hideApplicationLoader();
      this.runtime.onConnectionLost(tab);
    });

    if (session && typeof session.on === 'function') {
      const onLog = (log: DecodedLog): void => this.handleLog(log, tab);
      const onReady = (generation: string): void => {
        state.sawVersion = true;
        state.identified = true;
        if (!state.model) state.model = String(generation);
        this.checkConnectionReady(tab);
      };
      session.on('log', onLog);
      session.on('ready', onReady);
      state.session = session;
      state.sessionListeners = { onLog, onReady };
    }
  }

  /* --------------------------------------------------------- connectionStatus */

  connectionStatus(kind: ConnectionStatusKind, tab: TabId, error?: unknown): void {
    const state = this.state(tab);
    if (!state) return;
    // `jarvisInterface.js:2861` — the success *and* failure branches both clear the 35 s timer.
    this.clearTimer(tab, 'connection');

    if (kind === 'connectionsuccess') {
      state.status = 'connecting'; // not ready yet: VERSIONB still has to arrive (R29 / R28).
      state.error = undefined;
      this.clearTimer(tab, 'applicationLoader');
      state.ready = false;
      this.runtime.hideApplicationLoader();
      this.checkConnectionReady(tab);
      return;
    }

    state.status = 'lost';
    state.ready = false;
    state.error = error;
  }

  /* ------------------------------------------------------ checkConnectionReady */

  checkConnectionReady(tab: TabId): void {
    const state = this.state(tab);
    if (!state) return;
    if (state.status === 'closed' || state.status === 'lost') return;
    if (state.ready) return; // a second VERSIONB (reconnect) must not rebuild the panels.
    if (!state.sawVersion || !state.identified) return; // R28 gate: VERSIONB + identified model.

    state.ready = true;
    state.status = 'ready';
    // Order fixed by `jarvisInterface.js:1471-1490,2632` and doc §2.6.
    this.runtime.buildPanels(tab);
    this.runtime.buildTiles(tab);
    this.runtime.restorePersistedPage(tab);
    this.runtime.applyLanguage(tab);
    this.requestInitialLogs(tab);
  }

  /* ------------------------------------------------------------- handleLog */

  handleLog(log: DecodedLog, tab: TabId): void {
    const state = this.state(tab);
    if (!state || state.status === 'closed') return;

    const isVersion =
      log.messageId === VERSION_MESSAGE_ID || String(log.name ?? '').toUpperCase() === 'VERSION';

    if (state.ready) return;

    if (!isVersion) {
      // Everything before VERSIONB is dropped and counted (R28).
      state.ignored += 1;
      return;
    }

    state.sawVersion = true;
    const model = versionModel(log);
    if (model) {
      state.model = model;
      state.details.model = model;
      state.identified = true;
    } else if (guessGeneration(state.model)) {
      state.identified = true;
    }
    this.checkConnectionReady(tab);
  }

  /* ------------------------------------------------------- requestInitialLogs */

  requestInitialLogs(tab: TabId): void {
    const state = this.state(tab);
    if (!state) return;
    const override = this.runtime.initialLogs?.(tab);
    const source = this.source ?? defaultInitialLogsSource();
    const list = override ?? (state.initConfigPage ? source.configComponents : source.statusComponents);
    const features = this.featuresFn();
    const sent: string[] = [];
    for (const entry of list) {
      if (isExcludedByFeatures(entry, features)) continue;
      this.runtime.sendLog(tab, entry.logName, entry.spec);
      sent.push(entry.logName);
    }
    state.requested = sent;
  }

  /* --------------------------------------------------------------- closeTab */

  closeTab(tab: TabId): void {
    const state = this.state(tab);
    if (!state) return;
    // R36: unlog only what this tab alone holds; logs shared with another tab of the same device
    // are left alone. `runtime.unlogAll` is the only sender, so the accounting is what we expose.
    const shared = new Set(this.sharedLogNames(tab));
    const unique = state.requested.filter((name) => !shared.has(name));
    state.unlogged = unique;
    if (unique.length > 0) this.runtime.unlogAll(tab);

    this.detachSession(state);
    this.clearAllTimers(tab);
    this.runtime.hideConnectionLoader(tab);
    state.status = 'closed';
    state.ready = false;
  }

  /* ------------------------------------------------------------ loaders */

  showApplicationLoader(tab: TabId, ms = this.applicationLoaderMs): void {
    this.clearTimer(tab, 'applicationLoader');
    this.runtime.showApplicationLoader();
    this.armTimer(tab, 'applicationLoader', ms, () => {
      this.runtime.hideApplicationLoader();
      this.resetLoaderText(tab);
    });
  }

  hideApplicationLoader(tab: TabId): void {
    this.clearTimer(tab, 'applicationLoader');
    this.runtime.hideApplicationLoader();
  }

  showConnectionLoader(tab: TabId): void {
    // R30 — `setUpMonitor.html:408-418` auto-hides, `genericView.js:1026-1028` has a 30 s backstop.
    this.runtime.showConnectionLoader(tab);
    this.armTimer(tab, 'connectionLoader', this.connectionLoaderDelay(tab), () => {
      this.hideConnectionLoader(tab);
    });
    this.armTimer(tab, 'connectionLoaderBackstop', this.connectionLoaderBackstopMs, () => {
      this.hideConnectionLoader(tab);
    });
  }

  hideConnectionLoader(tab: TabId): void {
    // `genericView.js:1031-1032` clears the pending backstop too.
    this.clearTimer(tab, 'connectionLoader');
    this.clearTimer(tab, 'connectionLoaderBackstop');
    this.runtime.hideConnectionLoader(tab);
  }

  connectionLoaderDelay(tab: TabId): number {
    if (this.connectionLoaderOverride !== undefined) return this.connectionLoaderOverride;
    return isGritTab(tab) ? GRIT_CONNECTION_LOADER_MS : SM_CONNECTION_LOADER_MS;
  }

  /* -------------------------------------------------------------- queries */

  isReady(tab: TabId): boolean {
    return this.state(tab)?.ready === true;
  }

  isLost(tab: TabId): boolean {
    return this.state(tab)?.status === 'lost';
  }

  detailsOf(tab: TabId): ConnectionDetails | undefined {
    const state = this.state(tab);
    return state ? copyDetails(state.details) : undefined;
  }

  lastError(tab: TabId): unknown {
    return this.state(tab)?.error;
  }

  ignoredBeforeReady(tab: TabId): number {
    return this.state(tab)?.ignored ?? 0;
  }

  modelOf(tab: TabId): string {
    return this.state(tab)?.model ?? '';
  }

  initConfigPage(tab: TabId): boolean {
    return this.state(tab)?.initConfigPage === true;
  }

  setInitConfigPage(tab: TabId, value: boolean): void {
    const state = this.state(tab);
    if (state) state.initConfigPage = value;
  }

  pendingTimeout(tab: TabId): number | undefined {
    return this.pendingTimeouts(tab)[0]?.remaining;
  }

  pendingTimeouts(tab: TabId): PendingTimeout[] {
    const map = this.timers.get(tab);
    if (!map) return [];
    const now = this.clock.now();
    return [...map.entries()]
      .map(([kind, timer]) => ({ kind, remaining: timer.at - now }))
      .sort((a, b) => a.remaining - b.remaining);
  }

  requestedLogs(tab: TabId): string[] {
    return [...(this.state(tab)?.requested ?? [])];
  }

  sharedLogNames(tab: TabId): string[] {
    const state = this.state(tab);
    if (!state) return [];
    if (this.hooks.sharedLogs) return [...this.hooks.sharedLogs(tab)];
    const deviceOf = this.hooks.deviceOf ?? ((id: TabId): DeviceTileId => id);
    const device = deviceOf(tab);
    const shared = new Set<string>();
    for (const [other, otherState] of this.states) {
      if (other === tab) continue;
      if (otherState.status === 'closed') continue;
      if (deviceOf(other) !== device) continue;
      for (const name of otherState.requested) shared.add(name);
    }
    return state.requested.filter((name) => shared.has(name));
  }

  unloggedLogs(tab: TabId): string[] {
    return [...(this.state(tab)?.unlogged ?? [])];
  }

  dispose(): void {
    for (const tab of [...this.states.keys()]) this.clearAllTimers(tab);
    this.states.clear();
  }

  /* ------------------------------------------------------------- internals */

  private state(tab: TabId): TabState | undefined {
    return this.states.get(tab);
  }

  private armTimer(tab: TabId, kind: LoaderTimerKind, ms: number, fn: () => void): void {
    this.clearTimer(tab, kind);
    let map = this.timers.get(tab);
    if (!map) {
      map = new Map();
      this.timers.set(tab, map);
    }
    const handle = this.clock.setTimeout(() => {
      map!.delete(kind);
      fn();
    }, ms);
    map.set(kind, { handle, at: this.clock.now() + ms });
  }

  private clearTimer(tab: TabId, kind: LoaderTimerKind): void {
    const map = this.timers.get(tab);
    const timer = map?.get(kind);
    if (!timer) return;
    this.clock.clearTimeout(timer.handle);
    map!.delete(kind);
  }

  private clearAllTimers(tab: TabId): void {
    const map = this.timers.get(tab);
    if (!map) return;
    for (const timer of map.values()) this.clock.clearTimeout(timer.handle);
    map.clear();
  }

  private detachSession(state: TabState): void {
    const session = state.session;
    const listeners = state.sessionListeners;
    if (!session || !listeners) return;
    if (typeof session.off === 'function') {
      session.off('log', listeners.onLog);
      session.off('ready', listeners.onReady);
    }
    state.session = undefined;
    state.sessionListeners = undefined;
  }

  private resetLoaderText(tab: TabId): void {
    if (this.hooks.resetLoaderText) {
      this.hooks.resetLoaderText(tab);
      return;
    }
    const duck = this.runtime as unknown as { resetLoaderText?: (tab: TabId) => void };
    if (typeof duck.resetLoaderText === 'function') {
      duck.resetLoaderText(tab);
      return;
    }
    // R43 without a hook: express the `#loader-text-id` reset through the runtime we have.
    this.runtime.showApplicationLoader('CONNECTING');
  }
}

export function createConnectionFlow(options: ConnectionFlowConfig): ConnectionFlowRuntime {
  return new Flow(options);
}

/** Convenience for callers that only want a features object with the defaults. */
export function defaultFeatures(): FeatureFlags {
  return { ...DEFAULT_FEATURES };
}
