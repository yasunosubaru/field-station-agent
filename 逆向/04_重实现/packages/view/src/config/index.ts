import type { FeatureFlags, TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigCommandCatalog,
  ConfigPage,
  ConfigPageContext,
  ConfigTransport,
} from './types.ts';
import { ConfigCommandCoordinator, type CommandCompletion } from './state.ts';
import { createContextTransport } from './command.ts';
import { applyPageMarkers } from './base.ts';
import { AlignConfigPage } from './alignConfig.ts';
import { GnssConfigPage } from './gnssConfig.ts';
import { GiiiLoggingConfigPage, LoggingConfigPage } from './loggingConfig.ts';
import {
  AutoUpdatesPage,
  DisplaysSettingsPage,
  GeneralSettingsPage,
  LanguageSettingsPage,
  SpanInstallationPage,
} from './localSettings.ts';
import {
  LonghornLoggingConfigPage,
  LonghornPositionConfigPage,
} from './longhorn.ts';
import { NetworkingSettingsPage } from './networkingSettings.ts';
import { PortConfigPage } from './portConfig.ts';
import { PositionConfigPage } from './positionConfig.ts';
import { RadioConfigPage } from './radioConfig.ts';
import { SpanConfigPage } from './spanConfig.ts';
import { SpoofingConfigurationPage } from './spoofingConfiguration.ts';
import { DeviceDetailsPage } from './deviceDetails.ts';
import { DeviceExportPage } from './deviceExport.ts';
import { DeviceUpdatePage } from './deviceUpdate.ts';
import { DeviceRestartPage } from './deviceRestart.ts';
import {
  LoadConfigurationDriver,
  SaveConfigurationDriver,
} from './configurationFile.ts';
import { TerminalConsolePage } from './terminalConsole.ts';
import { EventsPage } from './events.ts';

export interface ConfigBundleOptions {
  context: ConfigPageContext;
  catalog?: ConfigCommandCatalog;
  transport?: ConfigTransport;
  portNames?: readonly string[];
  isolateTabs?: boolean;
}

export interface MountConfigOptions {
  features: FeatureFlags;
  target?: string;
}

export type ConfigTabName =
  | 'positioning'
  | 'ports'
  | 'logging'
  | 'align'
  | 'span'
  | 'radio'
  | 'gnss'
  | 'spoofing';

export interface ConfigLogRequest {
  name: string;
  spec: string;
}

const CONFIG_LOG_REQUESTS: Record<string, ConfigLogRequest[]> = {
  positionConfig: [
    { name: 'RXCONFIG', spec: 'onchanged,0' },
    { name: 'MODELFEATURES', spec: 'onchanged,0' },
    { name: 'VERSION', spec: 'once,0' },
    { name: 'CHANCONFIGLIST', spec: 'once,0' },
    { name: 'POSAVE', spec: 'onchanged,0' },
    { name: 'SERIALCONFIG', spec: 'ontime,1' },
    { name: 'NTRIPCONFIG', spec: 'onchanged,0' },
    { name: 'LBANDBEAMTABLE', spec: 'onchanged,0' },
    { name: 'SOURCETABLE', spec: 'once,0' },
    { name: 'AVEPOS', spec: 'onchanged,0' },
    { name: 'THISANTENNATYPE', spec: 'onchanged,0' },
    { name: 'BASEANTENNATYPE', spec: 'onchanged,0' },
    { name: 'RTKANTENNA', spec: 'onchanged,0' },
    { name: 'BASEANTENNAPCO', spec: 'onchanged,0' },
    { name: 'THISANTENNAPCO', spec: 'onchanged,0' },
  ],
  portConfig: [
    { name: 'INTERFACEMODE', spec: 'onchanged,0' },
    { name: 'ICOMCONFIG', spec: 'once,0' },
    { name: 'SERIALCONFIG', spec: 'ontime,1' },
    { name: 'NTRIPCONFIG', spec: 'once,0' },
    { name: 'SOURCETABLE', spec: 'once,0' },
    { name: 'NMEATALKER', spec: 'onchanged,0' },
    { name: 'NMEABEIDOUTALKER', spec: 'onchanged,0' },
    { name: 'SATVIS2', spec: 'once,0' },
    { name: 'NMEAFORMAT', spec: 'onchanged,0' },
    { name: 'GGAQUALITY', spec: 'onchanged,0' },
  ],
  loggingConfig: [
    { name: 'FILESTATUS', spec: 'ontime,1' },
    { name: 'NMEATALKER', spec: 'onchanged,0' },
    { name: 'NMEABEIDOUTALKER', spec: 'onchanged,0' },
    { name: 'NMEAFORMAT', spec: 'onchanged,0' },
    { name: 'GGAQUALITY', spec: 'onchanged,0' },
  ],
  alignConfig: [
    { name: 'DUALANTENNAALIGN', spec: 'once,0' },
    { name: 'WIFIALIGNAUTOMATION', spec: 'once,0' },
    { name: 'HEADINGOFFSET', spec: 'onchanged,0' },
    { name: 'WIFIMODE', spec: 'once,0' },
    { name: 'WIFISTATUS', spec: 'ontime,1' },
    { name: 'ALIGNAUTOMATION', spec: 'once,0' },
  ],
  spanConfig: [
    { name: 'SETIMUEVENT', spec: 'onchanged,0' },
    { name: 'CONNECTIMU', spec: 'onchanged,0' },
    { name: 'INSCONFIG', spec: 'onchanged,0' },
    { name: 'SETIMUTOANTOFFSET', spec: 'onchanged,0' },
    { name: 'SETIMUTOANTOFFSET2', spec: 'onchanged,0' },
    { name: 'SERIALCONFIG', spec: 'ontime,1' },
  ],
  radioConfig: [
    { name: 'SATEL9INFO', spec: 'ontime,1' },
    { name: 'SATEL4CONFIG', spec: 'ontime,1' },
    { name: 'SATELSTATUS', spec: 'ontime,1' },
    { name: 'VERSION', spec: 'once,0' },
    { name: 'SATELDETECT', spec: 'onchanged,0' },
  ],
  deviceDetails: [
    { name: 'VERSION', spec: 'once,0' },
    { name: 'OCEANIXSTATUS', spec: 'onchanged,0' },
    { name: 'MODELFEATURES', spec: 'onchanged,0' },
    { name: 'CHANCONFIGLIST', spec: 'onchanged,0' },
    { name: 'TERRASTARINFO', spec: 'onchanged,0' },
    { name: 'OCEANIXINFO', spec: 'onchanged,0' },
    { name: 'VALIDMODELS', spec: 'once,0' },
    { name: 'AUTHCODES', spec: 'once,0' },
    { name: 'VERIPOSINFO', spec: 'onchanged,0' },
  ],
  deviceExport: [
    { name: 'FILESTATUS', spec: 'ontime,1' },
    { name: 'FILELIST', spec: 'ontime,1' },
    { name: 'FILESYSTEMSTATUS', spec: 'onchanged,0' },
    { name: 'FILESYSTEMCAPACITY', spec: 'ontime,1' },
    { name: 'IPSERVICE', spec: 'onchanged,0' },
    { name: 'FILETRANSFERSTATUS', spec: 'onchanged,0' },
    { name: 'IPSTATUS', spec: 'ontime,1' },
  ],
  deviceUpdate: [
    { name: 'VERSION', spec: 'once,0' },
    { name: 'SOFTLOADSTATUS', spec: 'onchanged,0' },
    { name: 'AUTHCODES', spec: 'once,0' },
  ],
  events: [
    { name: 'RXSTATUSEVENT', spec: 'onchanged,0' },
    { name: 'TIME', spec: 'ontime,1' },
    { name: 'HWMONITOR', spec: 'ontime,1' },
    { name: 'TRACKSTAT', spec: 'ontime,1' },
    { name: 'LBANDTRACKSTAT', spec: 'ontime,1' },
    { name: 'INSPVAX', spec: 'ontime,1' },
    { name: 'MODELFEATURES', spec: 'onchanged,0' },
  ],
};

const CONFIG_SUBSCRIPTIONS: Record<string, number[]> = {
  positionConfig: [42, 172, 173, 1795, 1335, 1428, 379],
  portConfig: [3, 5, 1246, 1248, 1249, 1344, 861, 2258, 1861, 691],
  loggingConfig: [5, 2127, 861, 2258, 1861, 691],
  giiiLoggingConfig: [5, 2127],
  alignConfig: [1761, 1082, 2214, 1323, 1335, 2207, 2144],
  spanConfig: [1428, 379, 1945, 383, 1205, 1246, 1920, 1921],
  radioConfig: [37, 2204, 2205, 2215, 2220],
  gnssConfig: [1735, 613],
  spoofingConfiguration: [2358, 2366, 2367],
  networkingSettings: [2091, 2093, 1243, 1289, 2210, 2207, 1244],
  lghnPositionConfig: [],
  lghnLoggingConfig: [],
  deviceDetails: [37, 4101, 4108, 1148, 1329, 1719, 1728, 2159, 2160, 206, 1348],
  deviceExport: [2127, 2100, 2104, 2137, 1575, 2101, 1289],
  deviceUpdate: [37, 1235],
  events: [42, 83, 93, 94, 101, 223, 963, 1043, 1201, 1465, 2065, 2353],
};

/** The application's `configComponentsProcessLanguage` set, in shipped order. */
export const CONFIG_LANGUAGE_PAGE_NAMES = [
  'positionConfig',
  'positioningConfig',
  'portConfig',
  'loggingConfig',
  'radioConfig',
  'alignConfig',
  'spanConfig',
  'gnssConfig',
  'interferenceToolKit',
] as const;

/** Fourteen page implementations; GIII Logging is a variant of `loggingConfig`. */
export const CONFIG_PAGE_NAMES = [
  'positionConfig',
  'portConfig',
  'loggingConfig',
  'alignConfig',
  'spanConfig',
  'radioConfig',
  'gnssConfig',
  'spoofingConfiguration',
  'networkingSettings',
  'generalSettings',
  'languageSettings',
  'spanInstallation',
  'lghnPositionConfig',
  'lghnLoggingConfig',
] as const;

export class ConfigBundle {
  readonly positions: PositionConfigPage;
  readonly ports: PortConfigPage;
  readonly logging: LoggingConfigPage;
  readonly giiiLogging: GiiiLoggingConfigPage;
  readonly align: AlignConfigPage;
  readonly span: SpanConfigPage;
  readonly radio: RadioConfigPage;
  readonly gnss: GnssConfigPage;
  readonly spoofing: SpoofingConfigurationPage;
  readonly networking: NetworkingSettingsPage;
  readonly general: GeneralSettingsPage;
  readonly language: LanguageSettingsPage;
  readonly spanInstallation: SpanInstallationPage;
  readonly displays: DisplaysSettingsPage;
  readonly autoUpdates = new AutoUpdatesPage();
  readonly longhornPosition: LonghornPositionConfigPage;
  readonly longhornLogging: LonghornLoggingConfigPage;
  readonly deviceDetails: DeviceDetailsPage;
  readonly deviceExport: DeviceExportPage;
  readonly deviceUpdate: DeviceUpdatePage;
  readonly deviceRestart: DeviceRestartPage;
  readonly terminal: TerminalConsolePage;
  readonly events: EventsPage;
  readonly saveConfiguration: SaveConfigurationDriver;
  readonly loadConfiguration: LoadConfigurationDriver;
  readonly commands: ConfigCommandCoordinator;

  private readonly context: ConfigPageContext;
  private readonly pagesByName: Record<string, ConfigPage | object>;
  private readonly mounted = new Map<TabId, string[]>();

  constructor(options: ConfigBundleOptions) {
    this.context = options.context;
    const catalog = options.catalog ?? {};
    const transport =
      options.transport ??
      createContextTransport(options.context);
    this.commands = new ConfigCommandCoordinator({
      catalog,
      transport,
      portNames: options.portNames ?? [],
      isolateTabs: options.isolateTabs,
    });
    const runtime = { context: options.context, commands: this.commands };
    this.positions = new PositionConfigPage(runtime);
    this.ports = new PortConfigPage(runtime);
    this.logging = new LoggingConfigPage(runtime);
    this.giiiLogging = new GiiiLoggingConfigPage(runtime);
    this.align = new AlignConfigPage(runtime);
    this.span = new SpanConfigPage(runtime);
    this.radio = new RadioConfigPage(runtime);
    this.gnss = new GnssConfigPage(runtime);
    this.spoofing = new SpoofingConfigurationPage(runtime);
    this.networking = new NetworkingSettingsPage(runtime);
    this.general = new GeneralSettingsPage(runtime);
    this.language = new LanguageSettingsPage(runtime);
    this.spanInstallation = new SpanInstallationPage(runtime);
    this.displays = new DisplaysSettingsPage(this.spanInstallation);
    this.longhornPosition = new LonghornPositionConfigPage(runtime);
    this.longhornLogging = new LonghornLoggingConfigPage(runtime);
    this.deviceDetails = new DeviceDetailsPage(runtime);
    this.deviceExport = new DeviceExportPage(runtime);
    this.deviceUpdate = new DeviceUpdatePage(runtime);
    this.deviceRestart = new DeviceRestartPage(runtime);
    this.terminal = new TerminalConsolePage(runtime);
    this.events = new EventsPage(runtime);
    this.saveConfiguration = new SaveConfigurationDriver(runtime);
    this.loadConfiguration = new LoadConfigurationDriver(runtime);
    this.deviceUpdate.setRestartHandler((tab) => this.deviceRestart.resetFunc(tab));
    this.pagesByName = {
      positionConfig: this.positions,
      positioningConfig: this.positions,
      portConfig: this.ports,
      loggingConfig: this.logging,
      giiiLoggingConfig: this.giiiLogging,
      alignConfig: this.align,
      spanConfig: this.span,
      radioConfig: this.radio,
      gnssConfig: this.gnss,
      spoofingConfiguration: this.spoofing,
      networkingSettings: this.networking,
      generalSettings: this.general,
      languageSettings: this.language,
      spanInstallation: this.spanInstallation,
      displaysSettings: this.displays,
      autoUpdates: this.autoUpdates,
      lghnPositionConfig: this.longhornPosition,
      lghnLoggingConfig: this.longhornLogging,
      deviceDetails: this.deviceDetails,
      deviceExport: this.deviceExport,
      deviceUpdate: this.deviceUpdate,
      deviceRestart: this.deviceRestart,
      terminalConsole: this.terminal,
      events: this.events,
    };
  }

  page(name: string): ConfigPage | undefined {
    const value = this.pagesByName[name];
    return value && 'apply' in value ? (value as ConfigPage) : undefined;
  }

  pageNames(): string[] {
    return [...CONFIG_PAGE_NAMES];
  }

  /** Mount the config tab template required by this receiver. */
  mount(tab: TabId, options: MountConfigOptions): string[] {
    const loaded: string[] = [];
    const mountIfNeeded = (page: ConfigPage): boolean => {
      if (this.mountedPages(tab).includes(page.name)) return false;
      if (!page.mount(tab)) return false;
      loaded.push(page.name);
      return true;
    };
    if (options.target === 'logging') {
      const page = options.features.isGIII
        ? this.giiiLogging
        : options.features.isLongHorn
          ? this.longhornLogging
          : this.logging;
      mountIfNeeded(page);
      this.storeMounted(tab, loaded);
      return loaded;
    }
    if (options.features.isGIII) {
      mountIfNeeded(this.giiiLogging);
      this.storeMounted(tab, loaded);
      return loaded;
    }
    if (options.features.isLongHorn) {
      mountIfNeeded(this.longhornPosition);
      this.storeMounted(tab, loaded);
      return loaded;
    }
    for (const [page, enabled] of [
      [this.positions, this.positionsAvailable(options.features)],
      [this.ports, true],
      [this.logging, true],
      [this.align, options.features.alignSupported],
      [this.span, options.features.spanSupported],
      [this.radio, options.features.radioTxSupported],
      [this.gnss, true],
      [this.spoofing, options.features.isMarinePak && options.features.spoofingSupported],
    ] as Array<[ConfigPage, boolean]>) {
      if (enabled) mountIfNeeded(page);
    }
    this.storeMounted(tab, loaded);
    return loaded;
  }

  private positionsAvailable(features: FeatureFlags): boolean {
    return !features.positionModes.includes('NONE');
  }

  private storeMounted(tab: TabId, loaded: string[]): void {
    const merged = new Set([...(this.mounted.get(tab) ?? []), ...loaded]);
    this.mounted.set(tab, [...merged]);
  }

  mountedPages(tab: TabId): string[] {
    return [...(this.mounted.get(tab) ?? [])];
  }

  mountNamedPage(tab: TabId, name: string): boolean {
    const page = this.page(name);
    if (!page) return false;
    const mounted = page.mount(tab);
    if (mounted) this.storeMounted(tab, [page.name]);
    return mounted;
  }

  requiredLogs(features: FeatureFlags, target?: string): ConfigLogRequest[] {
    if (features.isGIII) {
      const requests: Record<string, ConfigLogRequest[]> = {
        deviceDetails: [
          { name: 'VERSION', spec: 'ontime,1' },
          { name: 'ETHSTATUS', spec: 'ontime,1' },
        ],
        events: [],
        terminalConsole: [],
        deviceExport: [],
        deviceUpdate: [],
        deviceRestart: [],
      };
      if (target) return [...(requests[target] ?? [])];
      return [
        { name: 'FILESTATUS', spec: 'ontime,1' },
        { name: 'VERSION', spec: 'ontime,1' },
      ];
    }
    if (features.isLongHorn) return [];
    const names = target
      ? [target]
      : [
          'positionConfig',
          'portConfig',
          'loggingConfig',
          'alignConfig',
          'spanConfig',
          'radioConfig',
        ];
    const seen = new Set<string>();
    const requests: ConfigLogRequest[] = [];
    for (const name of names) {
      for (const request of CONFIG_LOG_REQUESTS[name] ?? []) {
        const key = request.name.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push(request);
      }
    }
    return requests;
  }

  /** Activate one config pill / Longhorn page. */
  selectPage(tab: TabId, name: ConfigTabName, features: FeatureFlags): boolean {
    const root = this.context.document.getElementById(tab);
    if (!root) return false;
    if (features.isGIII) {
      if (name !== 'logging') return false;
      if (!this.mountedPages(tab).includes('giiiLoggingConfig')) this.giiiLogging.mount(tab);
      return true;
    }
    if (features.isLongHorn) {
      if (name === 'positioning') {
        if (!this.mountedPages(tab).includes('lghnPositionConfig')) {
          this.longhornPosition.mount(tab);
          this.storeMounted(tab, ['lghnPositionConfig']);
        }
        this.showLonghornPage(tab, 'positioning');
        return true;
      }
      if (name === 'logging') {
        if (!this.mountedPages(tab).includes('lghnLoggingConfig')) {
          this.longhornLogging.mount(tab);
          this.storeMounted(tab, ['lghnLoggingConfig']);
        }
        this.showLonghornPage(tab, 'logging');
        return true;
      }
      return false;
    }
    const pageId = {
      positioning: 'positionTab',
      ports: 'portConfig',
      logging: 'loggingConfig',
      align: 'alignConfig',
      span: 'spanTab',
      radio: 'radioConfig',
      gnss: 'gnssConfig',
      spoofing: 'spoofingConfig',
    }[name];
    const panelId = {
      positioning: `config-pos-${tab}`,
      ports: `config-ports-${tab}`,
      logging: `config-log-${tab}`,
      align: `config-align-${tab}`,
      span: `config-span-${tab}`,
      radio: `config-radio-${tab}`,
      gnss: `config-gnss-${tab}`,
      spoofing: `config-spoofing-${tab}`,
    }[name];
    for (const pill of root.querySelectorAll('#config-tabs .configtabs')) {
      pill.classList.toggle('active', pill.id === pageId);
    }
    for (const panel of root.querySelectorAll('#config-tabs .tab-content > .totaldata')) {
      const styled = panel as Element & { style?: CSSStyleDeclaration };
      if (styled.style) styled.style.display = panel.id === panelId ? 'block' : 'none';
      panel.classList.toggle('active', panel.id === panelId);
      panel.classList.toggle('active-config', panel.id === panelId);
    }
    return true;
  }

  private showLonghornPage(tab: TabId, page: 'positioning' | 'logging'): void {
    const root = this.context.document.getElementById(tab);
    if (!root) return;
    const positionTab = root.querySelector('#lghn-positioningPage');
    const loggingTab = root.querySelector('#lghn-loggingPage');
    positionTab?.classList.toggle('active-tab', page === 'positioning');
    loggingTab?.classList.toggle('active-tab', page === 'logging');
    const position = root.querySelector(`#config-pos-${tab}`) as
      | (Element & { style?: CSSStyleDeclaration })
      | null;
    const logging = root.querySelector(`#config-log-${tab}`) as
      | (Element & { style?: CSSStyleDeclaration })
      | null;
    if (position?.style) position.style.display = page === 'positioning' ? 'block' : 'none';
    if (logging?.style) logging.style.display = page === 'logging' ? 'block' : 'none';
  }

  /** Feed one decoded log to every page that consumes the msg id. */
  updateFromLog(msgId: number, data: Record<string, unknown>): string[] {
    const delivered: string[] = [];
    for (const [name, ids] of Object.entries(CONFIG_SUBSCRIPTIONS)) {
      if (!ids.includes(msgId)) continue;
      const page = this.page(name);
      if (!page) continue;
      page.updateData(msgId, data);
      delivered.push(name);
    }
    return delivered;
  }

  /**
   * Feed the parser's Commanddata and dispatch each completed feature to its page callback.
   */
  handleResponse(msgId: number, value: number, tab: TabId, error?: string): CommandCompletion[] {
    for (const valueOrObject of Object.values(this.pagesByName)) {
      const page = valueOrObject as ConfigPage;
      page.onCommandResponse?.(msgId, value, tab, error);
    }
    const completions = this.commands.handleResponse(msgId, value, tab, error);
    // `genericConfig.js:61`: replies to UNLOGALL never invoke a feature handler.
    if (msgId === 38) return completions;
    for (const completion of completions) {
      const page = this.page(completion.feature);
      if (!page) continue;
      page.handleCommandResponse(completion.response, tab, msgId, error);
    }
    return completions;
  }

  apply(name: string, tab: TabId): CommandResponse | undefined {
    return this.page(name)?.apply(tab);
  }

  discard(name: string, tab: TabId): boolean {
    const page = this.page(name);
    if (!page) return false;
    page.discard(tab);
    return true;
  }

  dirtyPages(tab: TabId): string[] {
    const out: string[] = [];
    for (const name of Object.keys(this.pagesByName)) {
      const page = this.page(name);
      if (page?.isDirty(tab)) out.push(page.name);
    }
    return [...new Set(out)];
  }

  discardAll(tab: TabId): void {
    for (const name of this.dirtyPages(tab)) this.page(name)?.discard(tab);
  }

  processLanguage(name: string, tab?: TabId): number {
    if (name === 'positioningConfig') return this.positions.processLanguage(tab);
    if (name === 'interferenceToolKit') return tab ? applyPageMarkers(this.context, tab) : 0;
    return this.page(name)?.processLanguage(tab) ?? 0;
  }

  reset(tab: TabId, features: FeatureFlags): void {
    for (const name of this.mountedPages(tab)) this.page(name)?.reset(tab);
    if (features.isLongHorn) this.longhornPosition.resetLghnPositionConfigUI(tab);
  }

  unmount(tab: TabId): void {
    for (const name of this.mountedPages(tab)) this.page(name)?.unmount(tab);
    this.mounted.delete(tab);
  }
}

export function createConfigBundle(options: ConfigBundleOptions): ConfigBundle {
  return new ConfigBundle(options);
}

export * from './types.ts';
export * from './base.ts';
export * from './state.ts';
export * from './alignConfig.ts';
export * from './gnssConfig.ts';
export * from './loggingConfig.ts';
export * from './localSettings.ts';
export * from './longhorn.ts';
export * from './networkingSettings.ts';
export * from './portConfig.ts';
export * from './positionConfig.ts';
export * from './radioConfig.ts';
export * from './spanConfig.ts';
export * from './spoofingConfiguration.ts';
export * from './deviceDetails.ts';
export * from './deviceExport.ts';
export * from './deviceUpdate.ts';
export * from './deviceRestart.ts';
export * from './configurationFile.ts';
export * from './terminalConsole.ts';
export * from './events.ts';
