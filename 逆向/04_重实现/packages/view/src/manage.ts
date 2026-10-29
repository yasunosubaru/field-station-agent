/**
 * `manage.ts` — the composition root of the Manage view layer.
 *
 * Everything else in this package is one concern (`tabs`, `containers`, `tiles`, `layout`,
 * `connection`, `throttle`, `language`, `view`). This file is the only place that knows how they
 * fit together, and it implements `ManageRuntime`, which is the surface `connection.ts` drives.
 *
 * The wiring follows `03_分析/01_Manage主界面与视图层.md §2.5/§2.6` and §6.4, i.e. the exact
 * call order of `welcome.js:140-179` (enter Manage) and `jarvisInterface.js:1450-1970`
 * (checkConnectionReady → build UI → request logs).
 */

import type { Clock } from './clock.ts';
import { createContainers, type ContainerKit } from './containers.ts';
import type { ManageHost } from './tabs.ts';
import { createConnectionFlow, type ConnectionFlowRuntime } from './connection.ts';
import { createLanguage, type Language } from './language.ts';
import { createLayoutEngine, type LayoutEngineHandle } from './layout.ts';
import { createThrottle, type ThrottleImpl } from './throttle.ts';
import { createView, View } from './view.ts';
import type {
  AppId,
  ConnectionDetails,
  DeviceTileId,
  FeatureFlags,
  FragmentLoader,
  ManageRuntime,
  TabId,
  TileSystem,
  UserStoreLike,
} from './types.ts';
import { DEFAULT_FEATURES } from './types.ts';
import { connectionLoaderSelector, isGritTab, statusComponentsId, tileClassFor } from './ids.ts';
import { channelsForMessage, createStatusBundle, decodePayloadForStatus, type StatusBundle } from './status/index.ts';
import {
  createConfigBundle,
  type ConfigBundle,
  type ConfigCommandCatalog,
  type ConfigDialogButton,
  type ConfigDialogDisplay,
  type ConfigDialogOptions,
  type ConfigTransport,
  type ConfigTabName,
  type ConfigOperationsHost,
} from './config/index.ts';
import type { CommandResponse } from './config/types.ts';
import {
  createGritBundle,
  gritLogRequests,
  type GritBundle,
  type GritEvent,
} from './grit/index.ts';
import {
  buildAsciiCommand,
  buildBinaryCommand,
  makePortNamePredicate,
} from '../../protocol/src/index.ts';

/** `NovatelIdConstants.statusComponents` / `configComponents` (protocol data/components.json). */
export interface ComponentRegister {
  compRegister: Record<string, Record<string, string>>;
  statusComponents?: string[];
  configComponents?: string[];
  gritStatusComponents?: string[];
  gritConfigComponents?: string[];
}

export interface ManageOptions {
  document: Document;
  clock: Clock;
  store: UserStoreLike;
  /** Reads the shipped fragments (`./../positionStatus/positionStatus.html`). */
  fragments: FragmentLoader;
  /** `tiles.ts` — injected so this file stays a wiring layer, not an implementation. */
  tiles: TileSystem;
  /** `components.json#compRegister`: component → msgId → field list. */
  register: ComponentRegister;
  features?: (tab?: TabId) => FeatureFlags;
  /** `deviceManagement`'s persisted `devicedetails.menu`; page 1 when absent. */
  persistedPage?: (deviceTileId: DeviceTileId) => '' | 'page2';
  translate?: (key: string) => string;
  userAgent?: string;
  innerWidth?: number;
  /** Default true: mirror genericView bugs; false enables the documented fixes. */
  mirrorDefects?: boolean;
  /** Tab shell hooks (`tabs.ts`); optional so the wiring can be tested with a stub. */
  tabShell?: TabShell;
  /** Catalog name lookup used by logStatus; injected to keep this package dependency-free. */
  messageName?: (messageId: string | number, tab: TabId) => string;
  /** `loggingConfig.getLocalFileLoggingInfo(tab)` when the configuration layer is present. */
  localFileLoggingInfo?: (tab: TabId) => Record<string, unknown> | undefined;
  connectedPortName?: (tab: TabId) => string | undefined;
  giiiPortType?: (tab: TabId) => string | undefined;
  giiiDataPortState?: (tab: TabId) => string | undefined;
  setRadioPort?: (tab: TabId, port: string | undefined) => void;
  copyText?: (text: string) => void;
  publishStatusEvent?: (tab: TabId, channel: string, data: Record<string, unknown>) => void;
  /** `commands.json`; configuration commands cannot be framed without it. */
  commands?: ConfigCommandCatalog;
  /** `portnames.json`, used by the CRC-framed ASCII commands. */
  portNames?: readonly string[];
  configTransport?: ConfigTransport;
  isolateConfigTabs?: boolean;
  /** `messageIds[generation]` name-to-id lookup for the port page. */
  messageId?: (name: string, tab: TabId) => number | undefined;
  viewportHeight?: number;
  longhorn?: {
    applyConfiguration?(tab: TabId, values: Record<string, unknown>): void;
    resetReceiver?(tab: TabId): void;
    openFolder?(tab: TabId, path: string): void;
  };
  restartReceiver?: (tab: TabId, kind: 'normal' | 'giii') => void;
  operations?: ConfigOperationsHost;
  psn?: (tab: TabId) => string | undefined;
  enclosure?: (tab: TabId) => string | undefined;
  onMenuSelected?: (tab: TabId, menu: 'menuConfig' | 'statusPage1' | 'statusPage2') => void;
  /** Mirror the 300/800 ms reset calls; tests may disable them to isolate a page. */
  scheduleConfigResets?: boolean;
  onGritEvent?: (tab: TabId, event: GritEvent) => void;
}

/** The subset of `tabs.ts`'s `TabRegistry` the wiring calls. */
export interface TabShell {
  buildShell(root: Element): Element;
  create(input: { index: number; connType: 'SM' | 'GRIT'; deviceTileId: DeviceTileId; title: string; details: ConnectionDetails }): { tab: TabId };
  activate(tab: TabId): void;
  close(tab: TabId, opts?: { loggingConfirmed?: boolean; deviceToggleClicked?: boolean }): { activated: TabId | '' };
  list(): Array<{ tab: TabId; deviceTileId: DeviceTileId }>;
  get(tab: TabId): { tab: TabId; deviceTileId: DeviceTileId } | undefined;
  enableTabs(connType: 'SM' | 'GRIT'): void;
  setCurrentApp(app: AppId): void;
  enterManage?(host: ManageHost): void;
}

export class Manage implements ManageRuntime {
  private readonly doc: Document;
  private readonly clock: Clock;
  private readonly store: UserStoreLike;
  private readonly fragments: FragmentLoader;
  private readonly tiles: TileSystem;
  private readonly register: ComponentRegister;
  private readonly featuresOf: (tab?: TabId) => FeatureFlags;
  private readonly options: ManageOptions;

  readonly containers: ContainerKit;
  readonly layout: LayoutEngineHandle;
  readonly connection: ConnectionFlowRuntime;
  readonly throttle: ThrottleImpl;
  readonly language: Language;
  readonly view: View;
  readonly statuses: StatusBundle;
  readonly configs: ConfigBundle;
  readonly grit: GritBundle;

  private activeTab: TabId = '';
  private currentApp: AppId = 'HOME';
  private readonly sessions = new Map<TabId, unknown>();
  private readonly sentLogs = new Map<TabId, string[]>();
  private readonly unlogged = new Map<TabId, string[]>();
  private readonly lost = new Set<TabId>();
  private readonly configOpen = new Set<TabId>();
  private readonly configMenu = new Map<TabId, 'menuConfig' | 'statusPage1' | 'statusPage2'>();
  private readonly applyingTimers = new Map<TabId, number>();
  private readonly applyingBudgets = new Map<TabId, number>();
  private readonly requestedConfigLogs = new Set<string>();
  private readonly loaderElement: Element | null;
  private readonly loaderText: Element | null;
  private shell: TabShell | undefined;

  constructor(options: ManageOptions) {
    this.options = options;
    this.doc = options.document;
    this.clock = options.clock;
    this.store = options.store;
    this.fragments = options.fragments;
    this.tiles = options.tiles;
    this.register = options.register;
    this.featuresOf = options.features ?? (() => DEFAULT_FEATURES);
    this.shell = options.tabShell;

    this.language = createLanguage({
      features: (tab) => this.featuresOf(tab),
      gritActive: () => this.currentApp === 'GRIT',
    });
    this.view = createView(this.doc, {
      activeTab: () => this.activeTab,
      userAgent: options.userAgent,
      innerWidth: options.innerWidth,
      defaultLocale: 'en-US',
      mirrorDefects: options.mirrorDefects,
      viewportHeight: options.viewportHeight,
      keyForText: (text) => this.language.keyForText(text),
      translate: (key) => this.translate(key),
    });
    this.throttle = createThrottle({
      activeTab: () => this.activeTab,
      setActiveTab: (tab) => {
        this.activeTab = tab;
      },
    });
    this.containers = createContainers({
      features: () => this.featuresOf(),
      onPageChange: (tab, page) => this.onPageChange(tab, page),
    });
    this.statuses = createStatusBundle({
      document: this.doc,
      view: this.view,
      clock: this.clock,
      features: (tab) => this.featuresOf(tab),
      heightUnit: (tab) => this.heightUnitOf(tab),
      connectionType: (tab) => this.connection?.detailsOf(tab)?.type,
      componentFields: (component, msgId) => this.register.compRegister?.[component]?.[String(msgId)],
      deviceTileId: (tab) => this.deviceTileIdOf(tab),
      supportedConstellations: (tab) => this.featuresOf(tab).constellations,
      userData: <T>(path: string[]) => this.store.getData<T>(path),
      setUserData: (path, value) => this.store.set(path, value),
      messageName: (messageId, tab) =>
        this.options.messageName?.(messageId as string | number, tab) ?? String(messageId),
      localFileLoggingInfo: (tab) => this.options.localFileLoggingInfo?.(tab),
      connectedPortName: (tab) => this.options.connectedPortName?.(tab),
      giiiPortType: (tab) => this.options.giiiPortType?.(tab),
      setRadioPort: (tab, port) => this.options.setRadioPort?.(tab, port),
      openDialog: (options) => this.openStatusDialog(options),
      closeDialog: (tab) => this.closeStatusDialog(tab),
      copyText: (text) => this.options.copyText?.(text),
      publishEvent: (tab, channel, data) => {
        if (channel === 'events') {
          const messageId = Number(
            data.MessageID ??
              (data.MessageIdentifier !== undefined ? 2353 : NaN),
          );
          if (Number.isFinite(messageId)) {
            this.configs.events.updateData(messageId, { ...data, tab });
          }
        }
        this.options.publishStatusEvent?.(tab, channel, data);
      },
      theme: () => this.store.json.theme ?? 'light-theme',
      distanceUnit: () => (this.store.json.language === 'russian-lang' ? ' M' : ' m'),
      velocityUnit: () => (this.store.json.language === 'russian-lang' ? ' M/C' : ' m/s'),
      translate: this.translate,
    });
    this.layout = createLayoutEngine({
      clock: this.clock,
      store: this.store,
      isLongHorn: (tab) => this.featuresOf(tab).isLongHorn,
      translate: this.translate,
    });
    this.connection = createConnectionFlow({
      clock: this.clock,
      runtime: this,
      features: () => this.featuresOf(),
      deviceOf: (tab) => this.deviceTileIdOf(tab),
      resetLoaderText: (tab) => this.setLoaderText('CONNECTING'),
      sharedLogs: (tab) => this.sharedLogNames(tab),
    });
    this.configs = createConfigBundle({
      context: {
        document: this.doc,
        fragments: this.fragments,
        clock: this.clock,
        store: this.store,
        features: (tab) => this.featuresOf(tab),
        deviceTileId: (tab) => this.deviceTileIdOf(tab),
        translate: this.translate,
        createDialog: (dialog, display) => this.createDialog(dialog, display),
        closeDialog: (tab) => this.closeDialog(tab),
        showLoadingScreen: (tab, milliseconds, labelKey) =>
          this.showLoadingScreen(tab, milliseconds, labelKey),
        closeApplyingScreen: (tab, response) => this.closeApplyingScreen(tab, response),
        showConnectionLoader: (tab) => this.showConnectionLoader(tab),
        hideConnectionLoader: (tab) => this.hideConnectionLoader(tab),
        unloggingLogsOnWCOM: (tab) => this.unlogAll(tab),
        connectedPortName: (tab) => this.options.connectedPortName?.(tab),
        giiiDataPortState: (tab) => this.options.giiiDataPortState?.(tab),
        openConfigPage: (tab, name) => {
          this.statusConfigClick('menuConfig', tab);
          this.selectConfigPage(tab, name as ConfigTabName);
        },
        messageId: (name, tab) => this.options.messageId?.(name, tab),
        localFileLoggingInfo: (tab) => this.options.localFileLoggingInfo?.(tab),
        setRadioPort: (tab, port) => this.options.setRadioPort?.(tab, port),
        restartReceiver: (tab, kind) =>
          this.options.restartReceiver
            ? this.options.restartReceiver(tab, kind)
            : this.configs.deviceRestart.resetFunc(tab),
        setDialogDirty: (tab, dialogClass, dirty) =>
          this.view.setDialogDirty(tab, dialogClass, dirty),
        sendBinary: (tab, bytes) => this.sendConfigBinary(tab, bytes),
        sendRaw: (tab, text) => this.sendConfigRaw(tab, text),
        sendAsciiFrame: (tab, request) => this.sendConfigAsciiFrame(tab, request),
        portNames: options.portNames,
        localSettings: {
          heightUnit: (tab) => this.heightUnitOf(tab),
          setHeightUnit: (tab, unit) => {
            this.store.set(['app', 'heightUnits', this.deviceTileIdOf(tab)], unit);
            this.store.save();
          },
          applyLanguage: (languageId) => {
            this.language.applyUserLanguagePreference(languageId);
          },
        },
        copyText: (text) => this.options.copyText?.(text),
        longhorn: options.longhorn,
        operations: {
          ...options.operations,
          connection: {
            resetConfigData: (tab) => this.configs.discardAll(tab),
            ...options.operations?.connection,
          },
        },
      },
      catalog: options.commands,
      transport: options.configTransport,
      portNames: options.portNames,
      isolateTabs: options.isolateConfigTabs,
    });
    this.grit = createGritBundle({
      context: {
        document: this.doc,
        fragments: this.fragments,
        clock: this.clock,
        store: this.store,
        translate: this.translate,
        deviceTileId: (tab) => this.deviceTileIdOf(tab),
        connectionType: (tab) => this.connection?.detailsOf(tab)?.type,
        commands: options.commands,
        transport:
          options.configTransport ?? {
            sendBinary: (tab, bytes) => this.sendConfigBinary(tab, bytes),
            sendRaw: (tab, text) => this.sendConfigRaw(tab, text),
            sendAsciiFrame: (tab, text) => this.sendConfigAsciiFrame(tab, text),
          },
        sendLog: (tab, name, spec) => this.sendLog(tab, name, spec),
        onEvent: (tab, event) => this.options.onGritEvent?.(tab, event),
      },
      messageId: (name, tab) => this.options.messageId?.(name, tab),
    });

    this.loaderElement = this.doc.querySelector('#loader');
    this.loaderText = this.doc.querySelector('#loader-text-id');
    this.registerRenderers();
    this.registerLanguageComponents();
  }

  private translate = (key: string): string => {
    const fromDictionary = this.language?.translate?.(key);
    if (fromDictionary !== undefined && fromDictionary !== key) return fromDictionary;
    return this.options.translate ? this.options.translate(key) : key;
  };

  /* --------------------------------------------------------------- shell */

  setTabShell(shell: TabShell): void {
    this.shell = shell;
  }

  buildShell(root: Element): Element {
    if (!this.shell) throw new Error('manage: no tab shell was provided');
    return this.shell.buildShell(root);
  }

  /** `welcome.js:140-179` — the click-driven entry into Manage (R11). */
  enterManage(host: ManageHost): void {
    this.currentApp = 'SM';
    this.shell?.setCurrentApp('SM');
    // `welcome.js:158` runs `applyUserLanguagePreference` *before* enabling/activating the tabs.
    this.language.applyUserLanguagePreference(this.currentLanguage());
    this.shell?.enterManage?.(host);
    this.activeTab = 'tabs-1';
    this.throttle.setActiveTab('tabs-1');
  }

  currentLanguage(): string {
    const stored = (this.store.json as { language?: string }).language;
    return stored && stored.length ? stored : 'English';
  }

  /* --------------------------------------------------------------- tabs */

  /** Creates the tab DOM, then activates it the way `addTab` does (the new tab becomes active). */
  openTab(input: {
    index: number;
    connType?: 'SM' | 'GRIT';
    deviceTileId: DeviceTileId;
    title: string;
    details: ConnectionDetails;
  }): TabId {
    if (!this.shell) throw new Error('manage: no tab shell was provided');
    const record = this.shell.create({
      index: input.index,
      connType: input.connType ?? 'SM',
      deviceTileId: input.deviceTileId,
      title: input.title,
      details: input.details,
    });
    this.activateTab(record.tab);
    return record.tab;
  }

  /** R55: `tabs("option","active",…)`, `tabName = tabc`, then `loadCachedData(tab)`. */
  activateTab(tab: TabId): void {
    this.activeTab = tab;
    if (tab && tab !== 'tabs-1' && tab !== 'grit-tabs-1') {
      this.currentApp = isGritTab(tab) ? 'GRIT' : 'SM';
      this.shell?.setCurrentApp(this.currentApp);
    }
    this.shell?.activate(tab);
    this.throttle.setActiveTab(tab);
    if (isGritTab(tab)) {
      // `gritLoadCachedData` — the GRIT tabs replay their own three buckets, not the eleven.
      if (tab !== 'grit-tabs-1') this.throttle.replayGrit(tab);
    } else if (tab !== 'tabs-1') {
      this.throttle.replay(tab);
    }
  }

  /** `addTab`'s tail: the 1200 ms / 500 ms connection loader. */
  connect(tab: TabId, details: ConnectionDetails, session?: unknown): void {
    if (session !== undefined) this.sessions.set(tab, session);
    this.connection.newConnection(tab, details, session as never);
    this.wireSessionLogs(tab, session);
    this.armConnectionLoader(tab);
  }

  /**
   * The status modules are downstream of the decoder. Keep that wiring in the composition
   * root: the session still owns framing/readiness, and each decoded log is fanned out through
   * the same active-tab throttle as the original emitter.
   */
  private readonly wiredSessionTabs = new WeakMap<object, Set<TabId>>();

  private wireSessionLogs(tab: TabId, session: unknown): void {
    if (!session || typeof session !== 'object') return;
    const wired = this.wiredSessionTabs.get(session) ?? new Set<TabId>();
    if (wired.has(tab)) return;
    const emitter = session as { on?: (event: string, fn: (log: unknown) => void) => void };
    if (typeof emitter.on !== 'function') return;
    wired.add(tab);
    this.wiredSessionTabs.set(session, wired);
    emitter.on('log', (log) => this.handleDecodedLog(tab, log));
    emitter.on('response', (frame) => this.handleCommandResponseFrame(tab, frame));
    emitter.on('text', (prefix, text) => {
      this.handleSessionText(tab, String(text ?? ''), String(prefix ?? ''));
    });
  }

  tabOfDevice(deviceTileId: DeviceTileId): TabId[] {
    return this.shell ? this.shell.list().filter((row) => row.deviceTileId === deviceTileId).map((row) => row.tab) : [];
  }

  private deviceTileIdOf(tab: TabId): DeviceTileId {
    return this.shell?.get(tab)?.deviceTileId ?? tab;
  }

  /* --------------------------------------------------- ManageRuntime side */

  /** `createMainPanel`: the sixteen container steps of §2.7. */
  buildPanels(tab: TabId): void {
    const host = this.doc.getElementById(tab) ?? this.doc.getElementById(`tabs-${tab}`);
    if (!host) return;
    if (isGritTab(tab)) {
      this.grit.buildPanels(tab, host);
      return;
    }
    this.containers.buildPanels(tab, host);
  }

  /** statusBar first (index 0 → `#status-panel`), then the per-model plan of §3.2. */
  buildTiles(tab: TabId): void {
    const features = this.featuresOf(tab);
    if (isGritTab(tab)) {
      this.grit.mount(tab, features);
      const container = this.doc.getElementById(`grit-status-components-${tab}`);
      if (container) this.layout.initialise(tab, this.deviceTileIdOf(tab), container);
      return;
    }
    const plan = this.tiles.plan(features);
    plan.forEach((spec, index) => {
      const wrapper = this.tiles.mount(tab, spec, index);
      // `jarvisInterface.js:1482,1563-1566` — the final wrapper class is set by the caller.
      wrapper.className = tileClassFor(index, spec, features);
    });
    // Packery only ever sees `#status-components-<tab>` (page 1); the statusBar tile lives in
    // `#status-panel-<tab>` and is not a `.manage-tile`, so it can never enter a snapshot.
    const container = this.doc.getElementById(statusComponentsId(tab));
    if (container) this.layout.initialise(tab, this.deviceTileIdOf(tab), container);
  }

  applyLanguage(tab?: TabId): void {
    this.language.processLanguage(tab);
    this.language.applyMarkers(this.doc);
  }

  initialLogs(tab: TabId): Array<{ logName: string; spec: string }> | undefined {
    if (!isGritTab(tab)) return undefined;
    return gritLogRequests().map((request) => ({
      logName: request.name,
      spec: `${request.trigger.toLowerCase()},${request.period}`,
    }));
  }

  /**
   * `menuBar.statusConfigClick` equivalent. The state is explicit:
   * `menuConfig` → config, `statusPage1`/`statusPage2` → the two status pages.
   * Leaving a dirty config page raises the shipped unsaved-changes dialog unless `allowDirty`.
   */
  statusConfigClick(
    menu: 'menuConfig' | 'statusPage1' | 'statusPage2',
    tab: TabId,
    allowDirty = false,
  ): boolean {
    if (menu !== 'menuConfig' && this.configOpen.has(tab) && !allowDirty) {
      const dirty = this.configs.dirtyPages(tab);
      if (dirty.length) {
        this.createDialog(
          {
            title: this.translate('CONFIRMATION'),
            titledataLangAttr: 'data-lang-confirmation',
            content: this.translate('UNSAVED_POPUP_MSG'),
            buttons: [
              {
                text: this.translate('YES'),
                dataLang: 'data-lang-yes',
                callback: () => {
                  this.closeDialog(tab);
                  this.configs.discardAll(tab);
                  this.statusConfigClick(menu, tab, true);
                },
              },
              {
                text: this.translate('NO'),
                dataLang: 'data-lang-no',
                class: 'darkBtn',
                callback: () => this.closeDialog(tab),
              },
            ],
          },
          { tab },
        );
        return false;
      }
    }

    const built = this.containers.build(tab);
    if (!built) return false;
    const features = this.featuresOf(tab);
    if (menu === 'menuConfig') {
      this.configOpen.add(tab);
      this.configMenu.set(tab, menu);
      this.configs.mount(tab, { features });
      this.requestConfigLogs(tab, features);
      const initialPage: ConfigTabName = features.isLongHorn
        ? 'positioning'
        : features.isGIII
          ? 'logging'
          : features.positionModes.includes('NONE')
            ? 'ports'
            : 'positioning';
      this.configs.selectPage(tab, initialPage, features);
      this.scheduleConfigReset(
        tab,
        initialPage,
      );
      for (const element of this.doc.querySelectorAll(`#${tab} .tile`)) this.setVisible(element, false);
      const receiver = this.doc.querySelector(`#${tab} .receiverPanel`);
      if (receiver) this.setVisible(receiver, true);
      this.setVisible(built.statusComponents as unknown as Element, false);
      this.setVisible(built.statusComponentsPage2 as unknown as Element, false);
      this.setVisible(built.statusConfig as unknown as Element, false);
      this.setVisible(built.configComponents as unknown as Element, true);
      this.applyLanguage(tab);
      this.options.onMenuSelected?.(tab, menu);
      return true;
    }

    this.configOpen.delete(tab);
    this.configMenu.set(tab, menu);
    for (const element of this.doc.querySelectorAll(`#${tab} .tile`)) this.setVisible(element, true);
    this.setVisible(built.configComponents as unknown as Element, false);
    this.setVisible(built.statusConfig as unknown as Element, true);
    this.containers.setPage(tab, menu === 'statusPage2' ? 'page2' : '');
    this.options.onMenuSelected?.(tab, menu);
    return true;
  }

  configPage(name: string): ReturnType<ConfigBundle['page']> {
    return this.configs.page(name);
  }

  configDirtyPages(tab: TabId): string[] {
    return this.configs.dirtyPages(tab);
  }

  mountedConfigPages(tab: TabId): string[] {
    return this.configs.mountedPages(tab);
  }

  private requestConfigLogs(tab: TabId, features: FeatureFlags, target?: string): void {
    const requestKey = `${tab}:${target ?? 'config'}`;
    if (this.requestedConfigLogs.has(requestKey)) return;
    this.requestedConfigLogs.add(requestKey);
    const existing = new Set(
      this.sentLogsFor(tab).map((entry) => entry.split(' ')[0].toUpperCase()),
    );
    for (const request of this.configs.requiredLogs(features, target)) {
      if (existing.has(request.name.toUpperCase())) continue;
      try {
        this.sendLog(tab, request.name, request.spec);
        existing.add(request.name.toUpperCase());
      } catch {
        // A log missing from this receiver generation is skipped just like getMessageId()==-1.
      }
    }
  }

  selectConfigPage(tab: TabId, name: ConfigTabName): boolean {
    const selected = this.configs.selectPage(tab, name, this.featuresOf(tab));
    if (selected) this.scheduleConfigReset(tab, name);
    return selected;
  }

  /** Mount one of the non-pill configuration pages into its shipped menu-container id. */
  mountOperationalPage(tab: TabId, name: string): boolean {
    const ids: Record<string, string> = {
      deviceDetails: `deviceDetails-layout_${tab}`,
      deviceExport: `deviceExport-layout_${tab}`,
      deviceUpdate: `deviceUpdate-layout_${tab}`,
      deviceRestart: `deviceRestart-layout_${tab}`,
      terminalConsole: `terminalConsole-layout_${tab}`,
      events: `events-panel-${tab}`,
    };
    const containerId = ids[name];
    if (!containerId) return false;
    let container = this.doc.getElementById(containerId);
    if (!container) {
      const built = this.containers.build(tab);
      const parent = built?.menuBarPanel ?? this.doc.getElementById(tab);
      if (!parent) return false;
      container = this.doc.createElement('div');
      container.id = containerId;
      container.className = `${name}-layout`;
      parent.appendChild(container);
    }
    const mounted = this.configs.mountNamedPage(tab, name);
    if (mounted) {
      this.setVisible(container, true);
      if (name !== 'events' || !this.requestedConfigLogs.has(`${tab}:events`)) {
        this.requestConfigLogs(tab, this.featuresOf(tab), name);
      }
      this.applyLanguage(tab);
    }
    return mounted;
  }

  saveConfigurationFile(tab: TabId): boolean {
    const features = this.featuresOf(tab);
    return this.configs.saveConfiguration.start(
      tab,
      features,
      this.options.psn?.(tab) ?? this.deviceTileIdOf(tab),
      this.options.enclosure?.(tab),
    );
  }

  loadConfigurationFile(
    tab: TabId,
    text: string,
    responseDirectory: string,
    responseBaseName: string,
    currentPort = this.options.connectedPortName?.(tab) ?? '',
    versions = {
      hardwareVersion: this.featuresOf(tab).model,
      model: this.featuresOf(tab).model,
      softwareVersion: '',
      PSN: this.options.psn?.(tab),
    },
  ): string[] {
    if (this.featuresOf(tab).isGIII || this.featuresOf(tab).isLongHorn) {
      this.createDialog(
        {
          title: this.translate('WARNING_MSG'),
          content: this.translate('LOADING_MSG'),
          buttons: [
            {
              text: this.translate('OK'),
              dataLang: 'data-lang-manage',
              class: 'darkBtn',
              callback: () => this.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
      return [];
    }
    return this.configs.loadConfiguration.start(text, tab, {
      currentPort,
      versions,
      responseBaseName,
      responseDirectory,
    });
  }

  async chooseAndLoadConfigurationFile(
    tab: TabId,
    versions = {
      hardwareVersion: this.featuresOf(tab).model,
      model: this.featuresOf(tab).model,
      softwareVersion: '',
      PSN: this.options.psn?.(tab),
    },
  ): Promise<string[]> {
    const features = this.featuresOf(tab);
    if (features.isGIII || features.isLongHorn) {
      return this.loadConfigurationFile(tab, '', '', '', undefined, versions);
    }
    const files = this.options.operations?.files;
    if (!files?.chooseOpenFile || !files.readText) return [];
    this.configs.loadConfiguration.prepare(tab);
    const selected = await files.chooseOpenFile({
      title: 'Open',
      defaultPath: files.defaultDocuments?.(),
      extensions: ['txt', 'asc', 'gps', 'bat', 'cfg'],
    });
    if (!selected) return [];
    const text = String(await files.readText(selected));
    const normalized = selected.replace(/\\/g, '/');
    const directory = normalized.slice(0, normalized.lastIndexOf('/')) || '.';
    const name = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const start = (): string[] =>
      this.configs.loadConfiguration.start(text, tab, {
        currentPort: this.options.connectedPortName?.(tab) ?? '',
        versions,
        responseBaseName: name,
        responseDirectory: directory,
      });
    const loadWithoutReset = (): void => {
      this.closeDialog(tab);
      start();
    };
    this.createDialog(
      {
        title: 'Confirmation',
        content:
          'We suggest you to FRESET the receiver before loading the configuration file. Do you wish to proceed further?',
        buttons: [
          {
            text: this.translate('NO'),
            dataLang: 'data-lang-dismiss',
            callback: loadWithoutReset,
          },
          {
            text: this.translate('YES'),
            dataLang: 'data-lang-yes',
            class: 'darkBtn',
            callback: () => {
              this.closeDialog(tab);
              this.sendConfigAsciiFrame(tab, 'FRESET');
              this.sendConfigRaw(tab, '\n');
              this.showLoadingScreen(tab, 30000, 'FRESETLOADINGMSG');
              this.clock.setTimeout(start, 31000);
            },
          },
        ],
      },
      { tab, isOverlayPopup: false },
    );
    return [];
  }

  private scheduleConfigReset(tab: TabId, name: ConfigTabName): void {
    if (this.options.scheduleConfigResets === false) return;
    const features = this.featuresOf(tab);
    if (features.isLongHorn) {
      this.clock.setTimeout(() => {
        if (name === 'logging') this.configs.longhornLogging.reset(tab);
        else this.configs.longhornPosition.reset(tab);
      }, 100);
      return;
    }
    if (features.isGIII) {
      this.clock.setTimeout(() => this.configs.giiiLogging.reset(tab), 300);
      return;
    }
    if (name === 'span') {
      this.clock.setTimeout(() => this.configs.span.reset(tab), 800);
      return;
    }
    const delay = 300;
    if (name === 'positioning') this.showConnectionLoader(tab);
    this.clock.setTimeout(() => {
      if (name === 'positioning') {
        this.configs.positions.dh_createDefaultData(tab);
        this.configs.positions.reset(tab);
        this.hideConnectionLoader(tab);
      } else if (name === 'ports') {
        this.configs.ports.checkAndUpdatePortConfigDefaultData(tab);
      } else if (name === 'logging') {
        this.configs.logging.reset(tab);
      } else if (name === 'align') {
        this.configs.align.reset(tab);
      } else if (name === 'radio') {
        this.configs.radio.reset(tab);
      } else if (name === 'gnss') {
        this.configs.gnss.reset(tab);
      } else if (name === 'spoofing') {
        this.configs.spoofing.reset(tab);
      }
    }, delay);
  }

  isConfigOpen(tab: TabId): boolean {
    return this.configOpen.has(tab);
  }

  selectedMenu(tab: TabId): 'menuConfig' | 'statusPage1' | 'statusPage2' | undefined {
    return this.configMenu.get(tab);
  }

  /** `checkPersistPage`: restore the last page the user was on. */
  restorePersistedPage(tab: TabId): void {
    const page = this.options.persistedPage?.(this.deviceTileIdOf(tab)) ?? '';
    this.containers.setPage(tab, page);
  }

  private onPageChange(tab: TabId, page: '' | 'page2'): void {
    // R27 also calls `satelliteTracking.resetTrackingUI(tab)`.
    this.statuses.satelliteTracking.resetTrackingUI(tab);
    this.pageChanges.push({ tab, page });
  }

  private readonly pageChanges: Array<{ tab: TabId; page: '' | 'page2' }> = [];

  pageChangeLog(): Array<{ tab: TabId; page: '' | 'page2' }> {
    return [...this.pageChanges];
  }

  showApplicationLoader(text?: string): void {
    if (this.loaderElement) this.setVisible(this.loaderElement, true);
    if (text !== undefined) this.setLoaderText(text);
  }

  hideApplicationLoader(): void {
    if (this.loaderElement) this.setVisible(this.loaderElement, false);
  }

  private setLoaderText(text: string): void {
    if (this.loaderText) this.loaderText.textContent = text;
  }

  /**
   * `ManageRuntime` side of the tab-level loader. **DOM only** — the timers belong to
   * `connection.ts`, which calls this; calling it back would recurse.
   */
  showConnectionLoader(tab: TabId): void {
    const element = this.doc.querySelector(connectionLoaderSelector(tab));
    if (element) this.setVisible(element, true);
  }

  hideConnectionLoader(tab: TabId): void {
    const element = this.doc.querySelector(connectionLoaderSelector(tab));
    if (element) this.setVisible(element, false);
  }

  /** Arm the R30 auto-hide + 30 s backstop (delegates to the flow, which owns the timers). */
  armConnectionLoader(tab: TabId): void {
    this.connection.showConnectionLoader(tab);
  }

  /** Disarm and hide, the way `genericView.hideConnectionLoader` does. */
  disarmConnectionLoader(tab: TabId): void {
    this.connection.hideConnectionLoader(tab);
  }

  /** `sendLog(tab, 'bestposb', 'ontime,1')` — delegated to the session when there is one. */
  sendLog(tab: TabId, logName: string, spec: string): void {
    const list = this.sentLogs.get(tab) ?? [];
    list.push(`${logName} ${spec}`.trim());
    this.sentLogs.set(tab, list);
    const session = this.sessions.get(tab) as { log?: (name: string, options?: Record<string, unknown>) => void } | undefined;
    if (!session?.log) return;
    const [trigger, period] = spec.split(/[\s,]+/);
    session.log(logName, { trigger: (trigger ?? 'ONTIME').toUpperCase(), periodSeconds: Number(period ?? 1) });
  }

  unlogAll(tab: TabId): void {
    const shared = new Set(this.sharedLogNames(tab));
    const own = (this.sentLogs.get(tab) ?? []).filter((entry) => !shared.has(entry.split(' ')[0].toUpperCase()));
    this.unlogged.set(tab, own);
    const session = this.sessions.get(tab) as { unlog?: (name: string | number) => void } | undefined;
    if (!session?.unlog) return;
    for (const entry of own) {
      const name = entry.split(' ')[0];
      try {
        session.unlog?.(name.toUpperCase());
      } catch {
        // A name the catalogue does not know is skipped, exactly like `getMessageId() == -1`.
      }
    }
  }

  /** R36: the logs of this tab that another tab of the same device also asked for. */
  sharedLogNames(tab: TabId): string[] {
    const device = this.deviceTileIdOf(tab);
    const mine = new Set((this.sentLogs.get(tab) ?? []).map((entry) => entry.split(' ')[0]));
    const shared = new Set<string>();
    for (const row of this.shell?.list() ?? []) {
      if (row.tab === tab || row.deviceTileId !== device) continue;
      for (const entry of this.sentLogs.get(row.tab) ?? []) {
        const name = entry.split(' ')[0];
        if (mine.has(name)) shared.add(name);
      }
    }
    return [...shared];
  }

  onConnectionLost(tab: TabId): void {
    this.lost.add(tab);
    // `deletePackeryInstances(tab)` then the tile teardown, per `connectionLostHandler.js`.
    this.layout.destroy(tab);
    for (const id of this.doc.querySelectorAll(`#${tab} .status-components .tile`)) {
      id.appendChild(this.doc.createElement('div')).className = 'tile_nodata';
    }
  }

  isLost(tab: TabId): boolean {
    return this.lost.has(tab);
  }

  /* ------------------------------------------------------------ teardown */

  closeTab(tab: TabId): TabId | '' {
    this.throttle.clear(tab);
    this.layout.destroy(tab);
    this.configs.unmount(tab);
    this.tiles.unmount(tab);
    this.containers.unmount(tab);
    this.view.deleteElementIds(tab);
    this.sessions.delete(tab);
    this.sentLogs.delete(tab);
    this.unlogged.delete(tab);
    this.lost.delete(tab);
    this.configOpen.delete(tab);
    this.configMenu.delete(tab);
    const applying = this.applyingTimers.get(tab);
    if (applying !== undefined) this.clock.clearTimeout(applying);
    this.applyingTimers.delete(tab);
    this.applyingBudgets.delete(tab);
    for (const key of [...this.requestedConfigLogs]) {
      if (key.startsWith(`${tab}:`)) this.requestedConfigLogs.delete(key);
    }
    const result = this.shell?.close(tab) ?? { activated: '' as const };
    if (result.activated) this.activateTab(result.activated);
    else this.activeTab = '';
    return result.activated;
  }

  /* ------------------------------------------------------------- private */

  /** §6.4 R40: every channel renders through `updateView` with the component's field list. */
  private registerRenderers(): void {
    const channels: Array<[channel: string, component: keyof StatusBundle]> = [
      ['statusBar', 'statusBar'],
      ['positionStatus', 'positionStatus'],
      ['deviceInfo', 'deviceInfo'],
      ['spanStatus', 'spanStatus'],
      ['alignStatus', 'alignStatus'],
      ['radioStatus', 'radioStatus'],
      ['portStatus', 'portStatus'],
      ['logStatus', 'logStatus'],
      ['pppCorrections', 'pppCorrections'],
      ['interferenceStatus', 'interferenceStatus'],
      ['agcStatus', 'agcStatus'],
      ['satelliteView', 'satelliteView'],
      ['satelliteTracking', 'satelliteTracking'],
      ['constellationTrackstat', 'satelliteTracking'],
      ['constellationChanconfiglist', 'satelliteTracking'],
      ['constellationSatvis', 'satelliteTracking'],
      ['constellationBestsats', 'satelliteTracking'],
    ];
    for (const [channel, component] of channels) {
      this.throttle.on(channel, (payload) => this.render(component, payload));
    }
    this.throttle.on('gritStatusBar', (payload) => {
      const msgId = Number(payload[0]);
      const data = payload[1];
      if (Number.isFinite(msgId) && data && typeof data === 'object') {
        this.grit.statusBar.updateView(msgId, data as Record<string, unknown>);
      }
    });
    this.throttle.on('spectrumPlot', (payload) => {
      const msgId = Number(payload[0]);
      const data = payload[1];
      if (!Number.isFinite(msgId) || !data || typeof data !== 'object') return;
      const record = data as Record<string, unknown>;
      const tab = String(record.tab ?? '');
      if (!tab) return;
      if ([1968, 2063].includes(msgId)) this.grit.spectrumViewer.ingest(msgId, record, tab);
      if (msgId === 1991) this.grit.interferenceToolKit.updateFilterTable(record, tab);
      if (msgId === 1967) this.grit.interferenceToolKit.updateSpectralAnalysisStatus(record, tab);
      if (msgId === 2065) this.grit.interferenceToolKit.updateChart(record, tab);
    });
    this.throttle.on('solutionStatus', (payload) => {
      const msgId = payload[0];
      const data = payload[1];
      if (typeof msgId !== 'number' || !data || typeof data !== 'object') return;
      this.statuses.positionStatus.updateGIIIStatus(msgId, data);
    });
  }

  /** One channel → one `updateView` call, using `compRegister[component][msgId]` for the fields. */
  render(component: string, payload: unknown[]): number {
    const msgId = payload[0];
    const logData = payload[1];
    if (!logData || typeof logData !== 'object' || typeof msgId !== 'number') return 0;
    const tab = (logData as { tab?: TabId }).tab ?? '';
    if (tab) {
      const result = this.updateStatusComponent(component, msgId, logData);
      if (result >= 0) return result;
    }
    const fields = this.register.compRegister?.[component]?.[String(msgId)];
    if (!fields) return 0;
    return this.view.updateView(logData as Record<string, unknown>, fields, component);
  }

  /** Feed one decoded receiver log into every component that subscribes to it. */
  handleDecodedLog(tab: TabId, input: unknown): string[] {
    const data = input && typeof input === 'object' ? (input as { messageId?: unknown }) : {};
    const messageId = Number(data.messageId);
    if (!Number.isFinite(messageId)) return [];
    const payload = decodePayloadForStatus(messageId, input, tab);
    if (isGritTab(tab)) {
      const delivered = this.grit.handleLog(tab, messageId, payload);
      if ([37, 42, 93, 101, 963, 2065, 2127, 2143, 2358].includes(messageId)) {
        const outcome = this.throttle.dispatch('gritStatusBar', [messageId, payload]);
        if (outcome !== 'dropped') delivered.push('gritStatusBar');
      }
      if ([1967, 1968, 1991, 2022, 2023, 2039, 2063, 2065, 1733].includes(messageId)) {
        const outcome = this.throttle.dispatch('spectrumPlot', [messageId, payload]);
        if (outcome !== 'dropped') delivered.push('spectrumViewer');
      }
      return [...new Set(delivered)];
    }
    const delivered: string[] = [...this.configs.updateFromLog(messageId, payload)];
    for (const channel of channelsForMessage(messageId)) {
      if (channel === 'solutionStatus') {
        this.statuses.positionStatus.updateGIIIStatus(messageId, payload);
        delivered.push(channel);
        continue;
      }
      const outcome = this.throttle.dispatch(channel, [messageId, payload]);
      if (outcome !== 'dropped') delivered.push(channel);
    }
    return delivered;
  }

  /**
   * `logparsers.parseResponse`: a payload containing ASCII `OK` is Commanddata=1, anything else
   * is ERROR with the raw hex text retained for the page callback.
   */
  handleCommandResponseFrame(tab: TabId, frame: unknown): CommandResponse | undefined {
    if (!frame || typeof frame !== 'object') return undefined;
    const record = frame as {
      header?: { messageId?: unknown };
      payload?: unknown;
    };
    const msgId = Number(record.header?.messageId);
    if (!Number.isFinite(msgId)) return undefined;
    const payload =
      record.payload instanceof Uint8Array
        ? record.payload
        : record.payload instanceof ArrayBuffer
          ? new Uint8Array(record.payload)
          : new Uint8Array(0);
    let hex = '';
    for (const byte of payload) hex += byte.toString(16).padStart(2, '0');
    const response: CommandResponse = /4f4b/i.test(hex) ? 1 : 2;
    this.handleCommandResponse(tab, msgId, response, response === 2 ? hex : undefined);
    return response;
  }

  handleCommandResponse(
    tab: TabId,
    msgId: number,
    value: number,
    error?: string,
  ): void {
    const response: CommandResponse =
      value === 1 ? 1 : value === 2 ? 2 : 0;
    this.configs.handleResponse(msgId, response, tab, error);
  }

  /** Raw ASCII is shared by Terminal, save-config capture, and load-config response matching. */
  handleSessionText(tab: TabId, text: string, prefix = ''): void {
    const full = prefix + text;
    this.configs.terminal.updateData(full, tab);
    if (/(?:factoryreset|autoexec)\.lua|SCRIPT_ERROR|EXECUTOR_ERROR|Message is invalid/i.test(full)) {
      this.configs.deviceRestart.handleLuaStatusCommandResponse(full, tab);
    }
    if (this.configs.saveConfiguration.getSaveConfigActive(tab)) {
      this.configs.saveConfiguration.processIncomingData(full, tab);
    }
    if (this.configs.loadConfiguration.getLoadConfigActive(tab)) {
      const lines = full
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) this.configs.loadConfiguration.processResponses(lines, tab);
    }
  }

  /** Longhorn's backend supplies its own `{MessageID, Data}` records. */
  handleLonghornData(tab: TabId, data: Record<string, unknown>): number {
    return this.statuses.longhornStatusUI.uiUpdate(data, tab);
  }

  component<T extends keyof StatusBundle>(name: T): StatusBundle[T] {
    return this.statuses[name];
  }

  private sendConfigBinary(tab: TabId, bytes: Uint8Array): void {
    if (this.options.configTransport) {
      this.options.configTransport.sendBinary(tab, bytes);
      return;
    }
    const session = this.sessions.get(tab) as
      | { sendBytes?: (payload: Uint8Array) => void }
      | undefined;
    session?.sendBytes?.(bytes);
  }

  private sendConfigRaw(tab: TabId, text: string): void {
    if (this.options.configTransport) {
      this.options.configTransport.sendRaw(tab, text);
      return;
    }
    const session = this.sessions.get(tab) as
      | { sendRaw?: (line: string) => void }
      | undefined;
    session?.sendRaw?.(text);
  }

  private sendConfigAsciiFrame(tab: TabId, request: string): void {
    if (this.options.configTransport) {
      this.options.configTransport.sendAsciiFrame(tab, request);
      return;
    }
    const session = this.sessions.get(tab) as
      | {
          sendAscii?: (line: string) => void;
          sendRaw?: (line: string) => void;
        }
      | undefined;
    if (session?.sendAscii) {
      session.sendAscii(request);
      return;
    }
    if (session?.sendRaw) {
      session.sendRaw(
        buildAsciiCommand(
          request,
          makePortNamePredicate(this.options.portNames ?? []),
        ),
      );
    }
  }

  private restartReceiver(tab: TabId, kind: 'normal' | 'giii'): void {
    if (kind === 'giii') {
      this.sendConfigRaw(tab, 'LOG  VERSIONB ONTIME 1\n');
      this.sendConfigRaw(tab, 'RESET\n');
      return;
    }
    const resetId = this.options.commands
      ? Object.entries(this.options.commands).find(
          ([name]) => name.toLowerCase() === 'reset',
        )?.[1].messageId
      : undefined;
    if (resetId === undefined) return;
    this.sendConfigBinary(
      tab,
      buildBinaryCommand({
        messageId: resetId,
        params: [{ type: 'ulong', value: 0, length: 4 }],
      }),
    );
  }

  private showLoadingScreen(tab: TabId, milliseconds: number, labelKey = 'APPLYING'): void {
    const previous = this.applyingTimers.get(tab);
    if (previous !== undefined) this.clock.clearTimeout(previous);
    this.applyingBudgets.set(tab, milliseconds);
    this.applyingTimers.set(
      tab,
      this.clock.setTimeout(() => {
        const active = this.doc.getElementById(tab)?.querySelector('.translucent-layout');
        if (active) this.setVisible(active, false);
      }, milliseconds),
    );
    const root = this.doc.getElementById(tab);
    const loader = root?.querySelector('.translucent-layout');
    if (!loader) return;
    this.setVisible(loader, true);
    const label = loader.querySelector('.apply-label');
    if (label) {
      label.textContent = this.translate(labelKey);
      label.setAttribute(`data-lang-${labelKey.toLowerCase()}`, '');
    }
    const counter = loader.querySelector('.counter-val');
    if (counter) counter.textContent = '30';
  }

  private closeApplyingScreen(tab: TabId, response: CommandResponse): void {
    const timer = this.applyingTimers.get(tab);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.applyingTimers.delete(tab);
    const loader = this.doc.getElementById(tab)?.querySelector('.translucent-layout');
    if (loader) this.setVisible(loader, false);
    const banner =
      response === 1
        ? this.doc.querySelector(`#${tab} .banner-success-message`)
        : response === 2
          ? this.doc.querySelector(`#${tab} .banner-fail-message`)
          : null;
    if (banner) this.setVisible(banner, true);
  }

  applyingBudgetFor(tab: TabId): number | undefined {
    return this.applyingBudgets.get(tab);
  }

  createDialog(options: ConfigDialogOptions, display: ConfigDialogDisplay = {}): void {
    this.view.createDialog(options, display);
  }

  closeDialog(tab: TabId): boolean {
    return this.view.closeDialog(tab);
  }

  /**
   * R34: every component's `processLanguage()` is, in this codebase, "rewrite this component's
   * own markers". The real components do not exist yet, so each registration applies the markers
   * of its own tile subtree — which is what the assertion in the tests checks.
   */
  private registerLanguageComponents(): void {
    this.language.registerStatusFanOut((name) => (tab?: TabId) => {
      const component = (this.statuses as unknown as Record<string, unknown>)[name];
      if (component && typeof component === 'object') {
        const processLanguage = (component as { processLanguage?: (tab?: TabId) => void }).processLanguage;
        if (typeof processLanguage === 'function') processLanguage.call(component, tab);
      }
      const scope = tab ? this.doc.querySelector(`#${tab} .${name}`) ?? this.doc : this.doc;
      this.language.applyMarkers(scope as Document);
    });
    this.language.registerConfigFanOut((name) => (tab?: TabId) => {
      if (tab && this.configs.processLanguage(name, tab) > 0) {
        return;
      }
      if (name === 'longhornStatusUI') {
        this.statuses.longhornStatusUI.processLanguage();
        return;
      }
      const scope = tab ? this.doc.querySelector(`#${tab} .${name}`) ?? this.doc : this.doc;
      this.language.applyMarkers(scope as Document);
    });
    const alreadyRegistered = new Set(this.language.registeredComponents());
    for (const name of [
      'deviceDetails',
      'deviceExport',
      'deviceUpdate',
      'deviceRestart',
      'terminalConsole',
      'events',
    ]) {
      if (alreadyRegistered.has(name)) continue;
      this.language.register(name, (tab?: TabId) => {
        this.configs.page(name)?.processLanguage(tab);
        const scope = tab ? this.doc.getElementById(tab) ?? this.doc : this.doc;
        this.language.applyMarkers(scope);
      });
    }
  }

  private openStatusDialog(options: {
    tab: TabId;
    title: string;
    titleMarker?: string;
    content: string;
    className?: string;
  }): void {
    const buttons: ConfigDialogButton[] = [
      {
        text: this.translate('CLOSE'),
        dataLang: 'data-lang-close',
        callback: () => this.closeStatusDialog(options.tab),
      },
    ];
    this.view.createDialog(
      {
        title: options.title,
        titledataLangAttr: options.titleMarker,
        content: options.content,
        buttons,
      },
      { tab: options.tab },
    );
    const dialog = this.doc.querySelector(`#${options.tab} #popupModal .modal-dialog`);
    if (dialog && options.className) {
      for (const name of options.className.split(/\s+/).filter(Boolean)) dialog.classList.add(name);
    }
  }

  private closeStatusDialog(tab: TabId): void {
    this.view.closeDialog(tab);
  }

  private heightUnitOf(tab: TabId): 'Ellipsoidal' | 'MSL' {
    const device = this.deviceTileIdOf(tab);
    return this.store.json.app.heightUnits?.[device] ?? (this.featuresOf(tab).isMarinePak ? 'Ellipsoidal' : 'MSL');
  }

  private updateStatusComponent(component: string, msgId: number, data: Record<string, unknown>): number {
    const statuses = this.statuses as unknown as Record<string, unknown>;
    const target = statuses[component];
    if (target && typeof target === 'object') {
      const candidate = target as Record<string, unknown>;
      const method =
        component === 'statusBar'
          ? 'updateView'
          : component === 'positionStatus'
            ? 'updateStatus'
            : component === 'portStatus'
              ? msgId === 72
                ? 'updateStatus'
                : 'updateData'
              : component === 'deviceInfo'
                ? 'updateView'
                : component === 'spanStatus'
                  ? 'updateSpanStatus'
                  : component === 'alignStatus'
                    ? 'updateAlignStatus'
                    : component === 'radioStatus'
                      ? 'updateStatus'
                      : component === 'interferenceStatus'
                        ? 'updateStatus'
                        : component === 'logStatus'
                          ? msgId === 2127
                            ? 'updateLogStatus'
                            : 'updateData'
                          : component === 'agcStatus'
                            ? 'dc_updateData'
                            : component === 'pppCorrections'
                              ? 'updateStatus'
                              : component === 'satelliteView'
                                ? 'updateData'
                                : component === 'satelliteTracking'
                                  ? 'dc_updateData'
                                  : '';
      if (method && typeof candidate[method] === 'function') {
        return Number((candidate[method] as (id: number, value: unknown) => unknown)(msgId, data)) || 0;
      }
    }
    return -1;
  }

  private setVisible(element: Element, visible: boolean): void {
    const style = (element as { style?: { display: string } }).style;
    if (style) style.display = visible ? 'block' : 'none';
    else if (visible) element.removeAttribute('hidden');
    else element.setAttribute('hidden', '');
  }

  /** Observability for the integration test. */
  sentLogsFor(tab: TabId): string[] {
    return [...(this.sentLogs.get(tab) ?? [])];
  }

  unloggedFor(tab: TabId): string[] {
    return [...(this.unlogged.get(tab) ?? [])];
  }

  active(): TabId {
    return this.activeTab;
  }
}

export function createManage(options: ManageOptions): Manage {
  return new Manage(options);
}
