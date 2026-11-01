/**
 * Shared types and module contracts for the Manage view layer.
 *
 * Everything below is a *contract between modules*, not an implementation: `tabs.ts`,
 * `containers.ts`, `tiles.ts`, `layout.ts`, `connection.ts`, `throttle.ts`, `language.ts`
 * and `view.ts` each implement one of these interfaces, and `manage.ts` wires them together.
 * The acceptance criteria behind every member are the `R<n>` items of
 * `03_分析/01_Manage主界面与视图层.md §8` (and `00_通信协议与调度核心.md §8` for the flow).
 */

import type { Catalog, DecodedLog, ReceiverSession } from '../../session/src/session.ts';
import type { Clock } from './clock.ts';

export type { Clock };
export type { Catalog, DecodedLog, ReceiverSession };

/** `tabs-3` / `grit-tabs-3` — a tab DOM id. */
export type TabId = string;
/** The device tile id: `new Date().getTime()` as a string, shared by SM and GRIT tabs. */
export type DeviceTileId = string;
export type ConnType = 'SM' | 'GRIT';
export type ModelKind = 'standard' | 'longhorn' | 'giii';
export type ReceiverGen = 'OEM6' | 'OEM7' | 'OEMSTAR' | 'SMART2' | 'GIII';
export type AppId = 'HOME' | 'SM' | 'PI' | 'CONVERT' | 'GRIT';
export type TransportKind = 'eth' | 'Network' | 'Serial' | 'USB' | 'playback';
export type TabStatus = 'connecting' | 'ready' | 'lost' | 'closed';
export type ConnectionStatusKind = 'connectionsuccess' | 'connectionfailure';
export type TilePage = '' | 'page2';

/** `03_分析/00_…md §3.1` — the connection description the original keeps per tab. */
export interface ConnectionDetails {
  type: TransportKind;
  protocol?: 'tcp' | 'udp';
  ipAddress?: string;
  port?: number;
  /** spelled `buadrate` in the original, kept verbatim. */
  buadrate?: number;
  auto?: boolean;
  active?: boolean;
  tempactive?: boolean;
  hardwarehandshake?: boolean;
  pim222aRx?: boolean;
  playbackFileName?: string;
  /** filled in once VERSIONB identifies the receiver. */
  model?: string;
  name?: string;
}

export interface TabRecord {
  tab: TabId;
  index: number;
  connType: ConnType;
  deviceTileId: DeviceTileId;
  title: string;
  status: TabStatus;
  details: ConnectionDetails;
}

export interface CreateTabInput {
  index: number;
  connType: ConnType;
  deviceTileId: DeviceTileId;
  title: string;
  details: ConnectionDetails;
}

export interface TabHooks {
  onActivate?(tab: TabId): void;
  /** return false to veto the close (file logging still running, GRIT recording, …). */
  beforeClose?(record: TabRecord): boolean;
  onClosed?(record: TabRecord): void;
}

/** 3.1 / 6.1 of `01_Manage…md`. */
export interface TabRegistry {
  readonly counter: number;
  readonly active: TabId | '';
  /** Builds `#tabs`, `#tabs-list` and the static `#tabs-1` "Add device" page. */
  buildShell(root: Element): Element;
  list(): TabRecord[];
  get(tab: TabId): TabRecord | undefined;
  byDevice(deviceTileId: DeviceTileId): TabRecord[];
  /** Next free index; starts at 2 and closed indices are never reused. */
  allocIndex(): number;
  create(input: CreateTabInput): TabRecord;
  activate(tab: TabId): void;
  setStatus(tab: TabId, status: TabStatus): void;
  rememberScroll(tab: TabId, top: number): void;
  close(
    tab: TabId,
    opts?: { loggingConfirmed?: boolean; deviceToggleClicked?: boolean },
  ): { activated: TabId | ''; removed?: TabRecord };
  countFor(connType: ConnType): number;
  /** jQuery-UI tab semantics: non-matching tabs are disabled, not hidden. */
  enableTabs(connType: ConnType): void;
  isEnabled(tab: TabId): boolean;
  setCurrentApp(app: AppId): void;
}

export interface LayoutItem {
  id: string;
  position: { left: number; top: number };
}
export type LayoutSnapshot = LayoutItem[];

export interface GridMetrics {
  columns: number;
  columnWidth: number;
  gutter: number;
}

/** `dynamicTiles.js` — the packery-equivalent tile layout and its persistence. */
export interface LayoutEngine {
  /** `tabids[tab]` is the key: without it every entry point is a no-op. */
  initialise(tab: TabId, deviceTileId: DeviceTileId, container: Element): void;
  /** Saves first, then tears the instance down (`deletePackeryInstances`). */
  destroy(tab: TabId): void;
  isActive(tab: TabId): boolean;
  container(tab: TabId): Element | undefined;
  deviceTileId(tab: TabId): DeviceTileId | undefined;
  snapshot(tab: TabId): LayoutSnapshot;
  save(tab: TabId): void;
  restore(tab: TabId): void;
  isDifferent(tab: TabId): boolean;
  reset(tab: TabId): void;
  undo(tab: TabId): void;
  /** The original shows this when the layout *is* default; the reimplementation fixes it. */
  resetButtonVisible(tab: TabId): boolean;
  undoBannerVisible(tab: TabId): boolean;
  reflow(tab: TabId): void;
  /** Simulates a drag: place `identityClass` at a grid slot (0-based column/row). */
  moveTo(tab: TabId, identityClass: string, column: number, row: number): void;
  metricsFor(containerWidth: number): GridMetrics;
  onLayoutChange?: (tab: TabId) => void;
}

export interface FragmentLoader {
  /** `./../positionStatus/positionStatus.html` → the fragment text (no `#` prefix). */
  load(path: string): string;
}

export interface TileSpec {
  /** component name, e.g. `positionStatus`; also the fragment directory. */
  name: string;
  /** the `*-status` class Packery uses to identify the tile (doc §3.3). */
  identityClass: string;
  page: TilePage;
}

/** `featuresList.js` subset the tile plan and the connection flow branch on. */
export interface FeatureFlags {
  generation: ReceiverGen;
  model: string;
  isLongHorn: boolean;
  isGIII: boolean;
  isMarinePak: boolean;
  alignSupported: boolean;
  spanSupported: boolean;
  radioTxSupported: boolean;
  terrastarSupported: boolean;
  dualAntennaSupported: boolean;
  spoofingSupported: boolean;
  loggingComponent: boolean;
  fileSupported: boolean;
  /**
   * `featuresList.js#isWiFiClientSupported` / `#isWiFiHotspotSupported` — one bit for both, because
   * the suite sets both from the same test (`featuresList.js:1077`: an `ENCLOSURE` component of
   * `VERSION` (#37) whose PSN, minus its first character, starts with one of
   * `wifiSupportedPSNList`). `Settings ▸ Networking`'s `.wifi-comp` and `.wifi-hotspot-comp` panels
   * ship `display: none` and are only shown when this is true.
   */
  wifiSupported: boolean;
  constellations: string[];
  increasedLogLimit: boolean;
  positionModes: string[];
}

export const DEFAULT_FEATURES: FeatureFlags = {
  generation: 'OEM7',
  model: '',
  isLongHorn: false,
  isGIII: false,
  isMarinePak: false,
  alignSupported: false,
  spanSupported: false,
  radioTxSupported: false,
  terrastarSupported: false,
  dualAntennaSupported: false,
  spoofingSupported: false,
  loggingComponent: false,
  fileSupported: false,
  wifiSupported: false,
  constellations: [],
  increasedLogLimit: false,
  positionModes: [],
};

export interface TileSystem {
  /** The per-model tile set of doc §3.2, in DOM order. */
  plan(features: FeatureFlags): TileSpec[];
  /** Creates the tile wrapper, mounts the real fragment and returns the wrapper. */
  mount(tab: TabId, spec: TileSpec, index: number): Element;
  mounted(tab: TabId): Element[];
  identityClassOf(tileElement: Element): string | undefined;
  unmount(tab: TabId): void;
}

/* ------------------------------------------------------------- userStore */

export interface UserStoreData {
  theme?: string;
  language?: string;
  slider?: boolean;
  app: {
    dynamic: Record<DeviceTileId, LayoutSnapshot>;
    defaultLayout: Record<DeviceTileId, LayoutSnapshot>;
    lastManageSortedDevices: string[];
    lastGritSortedDevices: string[];
    heightUnits: Record<DeviceTileId, 'Ellipsoidal' | 'MSL'>;
    connectionMode: { network_mode?: string; network_type?: string };
  };
}

export interface UserStoreLike {
  json: UserStoreData;
  /** Deep copy, exactly like the original `getData`. */
  getData<T>(path: string[]): T | undefined;
  set(path: string[], value: unknown): void;
  save(): void;
}

/* ----------------------------------------------------------------- flow */

/** What `connection.ts` needs from the UI side; `manage.ts` implements it. */
export interface ManageRuntime {
  /** `createMainPanel` + `createMenuComponents` + the config page. */
  buildPanels(tab: TabId): void;
  /** statusBar + the per-model page1/page2 tiles. */
  buildTiles(tab: TabId): void;
  applyLanguage(tab?: TabId): void;
  restorePersistedPage(tab: TabId): void;
  showApplicationLoader(text?: string): void;
  hideApplicationLoader(): void;
  showConnectionLoader(tab: TabId): void;
  hideConnectionLoader(tab: TabId): void;
  /** Sends one registered log, e.g. `sendLog(tab, 'bestposb', 'ontime,1')`. */
  sendLog(tab: TabId, logName: string, spec: string): void;
  /** Optional component-specific initial request list (GRIT uses its own registry). */
  initialLogs?(tab: TabId): Array<{ logName: string; spec: string }> | undefined;
  unlogAll(tab: TabId): void;
  onConnectionLost(tab: TabId): void;
}

export interface ConnectionFlowOptions {
  clock: Clock;
  runtime: ManageRuntime;
  features: () => FeatureFlags;
  /** Overrides the 35 s guard (tests). */
  connectionTimeoutMs?: number;
}

export interface ConnectionFlow {
  newConnection(tab: TabId, details: ConnectionDetails, session?: ReceiverSession): void;
  connectionStatus(kind: ConnectionStatusKind, tab: TabId, error?: unknown): void;
  /** Waits for VERSIONB / feature detection, then builds the UI and requests logs. */
  checkConnectionReady(tab: TabId): void;
  requestInitialLogs(tab: TabId): void;
  closeTab(tab: TabId): void;
  isReady(tab: TabId): boolean;
  isLost(tab: TabId): boolean;
  pendingTimeout(tab: TabId): number | undefined;
  /** Feeds a decoded log into the feature detection + readiness gate. */
  handleLog(log: DecodedLog, tab: TabId): void;
}

/* -------------------------------------------------------------- throttle */

export interface CachedChannel {
  statusBar?: unknown;
  positionStatus?: unknown;
  alignStatus?: unknown;
  deviceInfo?: unknown;
  radioStatus?: unknown;
  spanStatus?: unknown;
  trackstat?: unknown;
  chanconfiglist?: unknown;
  satvis?: unknown;
  bestsats?: unknown;
  satelliteTracking?: unknown;
  portStatus?: unknown;
  logStatus?: unknown;
  [key: string]: unknown;
}

export interface Throttle {
  /** True when this tab's DOM is the one being updated (`tabs-1` and `''` count as active). */
  isActive(tab: TabId): boolean;
  setActiveTab(tab: TabId | ''): void;
  /** `emitter.emit` replacement: active tab → render now, otherwise keep the last frame. */
  dispatch(channel: string, data: unknown[]): void;
  cached(tab: TabId): CachedChannel;
  /** `loadCachedData(tab)` — replays the 11 channels of the original. */
  replay(tab: TabId): void;
  clear(tab: TabId): void;
  /** Wires the real renderers (`statusBar.updateView` …) once. */
  on(channel: string, renderer: (data: unknown[]) => void): void;
}

/* -------------------------------------------------------------- language */

export interface LanguageLayer {
  /** `__()`; falls back to the key itself when the dictionary has no entry. */
  translate(key: string): string;
  loadDictionary(dict: Record<string, string>, name?: string): void;
  /** `[$('[data-lang-x]').html(__('X'))]` in one call: writes every marker of the document. */
  applyMarkers(root?: Element): void;
  /** `applyUserLanguagePreference` — the `tab` argument is ignored on purpose (R32). */
  applyUserLanguagePreference(languageId: string, tab?: TabId): void;
  /** `applyLanguageChanges` — matches on `languageId.split('-')[0]`. */
  resolveLanguageId(languageId: string): string;
  /** All `data-lang-*` attribute names currently in the document (§9.4). */
  markers(root?: Element): string[];
  processLanguage(tab?: TabId): void;
  register(component: string, fn: (tab?: TabId) => void): void;
}

/* ------------------------------------------------------------------- view */

export interface ViewLayer {
  /** `genericView.updateView`, selector composition per doc §5.1. */
  updateView(jsonData: Record<string, unknown>, fields: string, featureName: string, tab?: TabId): void;
  selectorFor(featureName: string, field: string, tab?: TabId): string;
  /** RAG class for `good|warning|bad|idle` (doc §5.3). */
  ragClass(state: string): string;
  updateStatusIndicatorClrAndText(parent: string, state: string, tab: TabId): void;
  formatToSystemLocale(value: unknown, fractionDigits: number, tab?: TabId): string;
  getCommaLocale(tab?: TabId): string;
  /** `vdop = sqrt(pdop² − hdop²)`, 9999 passthrough (doc §5.4). */
  verticalDop(pdop: number, hdop: number): number;
  deleteElementIds(tab: TabId): void;
  resetDataObject(tab: TabId): void;
  createDialog?(
    options: {
      title?: string;
      content?: string;
      titledataLangAttr?: string;
      closeCallback?: (event?: unknown) => void;
      buttons?: Array<{
        text: string;
        callback?: (event?: unknown) => void;
        class?: string;
        dataLang?: string;
        'data-dismiss'?: string;
      }>;
    },
    display?: {
      tab?: TabId;
      isOverlayPopup?: boolean;
      isPOIPopup?: boolean;
      isErrorPopup?: boolean;
    },
  ): void;
  closeDialog?(tab: TabId): boolean;
  popupPositionCalculation?(
    tab: TabId,
    isOverlayPopup?: boolean,
    isPOIPopup?: boolean,
    overrideViewportHeight?: number,
  ): unknown;
  setDialogDirty?(tab: TabId, dialogClass: string, dirty: boolean): void;
  requestHideDialog?(
    tab: TabId,
    event?: { preventDefault(): void; stopPropagation?(): void },
  ): boolean;
}

export const VIEW_CHANNELS = [
  'statusBar',
  'positionStatus',
  'alignStatus',
  'deviceInfo',
  'radioStatus',
  'spanStatus',
  'trackstat',
  'chanconfiglist',
  'satvis',
  'bestsats',
  'satelliteTracking',
] as const;

export type ViewChannel = (typeof VIEW_CHANNELS)[number];

/** Emitter channel → `cachedData` key, including the original's quirks
 *  (`pppCorrections` writes into `positionStatus`, `portStatus`/`logStatus` are extra keys). */
export const CHANNEL_CACHE_KEYS: Record<string, string> = {
  statusBar: 'statusBar',
  positionStatus: 'positionStatus',
  pppCorrections: 'positionStatus',
  portStatus: 'portStatus',
  alignStatus: 'alignStatus',
  deviceInfo: 'deviceInfo',
  radioStatus: 'radioStatus',
  spanStatus: 'spanStatus',
  logStatus: 'logStatus',
  constellationTrackstat: 'trackstat',
  constellationChanconfiglist: 'chanconfiglist',
  constellationSatvis: 'satvis',
  constellationBestsats: 'bestsats',
  satelliteTracking: 'satelliteTracking',
};
