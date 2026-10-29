import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  namespaceCollapsePanels,
  namespaceRadioInputs,
} from './base.ts';

export const LOGGING_MSG = {
  LOGLIST: 5,
  LOG: 1,
  UNLOG: 36,
  UNLOGALL: 38,
  FILESTATUS: 2127,
  FILECONFIG: 2116,
  LOGFILE: 157,
  FILEROTATE: 2133,
  NMEA_CONFIG: 861,
  NMEA_BEIDOU_CONFIG: 2258,
  NMEA_FORMAT: 1861,
  GGA_QUALITY: 691,
} as const;

export type LoggingStorage = 'Onboard' | 'LocalFile';

export interface LoggingPageData {
  storage: LoggingStorage;
  localFileName: string;
  desktopFileSettings: { maxFileTime: number; diskFullAction: string };
}

/** `loggingConfig.js` and its GIII four-command subset. */
export class LoggingConfigPage extends BaseConfigPage {
  private readonly pages = new Map<TabId, LoggingPageData>();
  readonly variant: 'standard' | 'giii';

  constructor(runtime: ConfigPageRuntime, variant: 'standard' | 'giii' = 'standard') {
    super(runtime, {
      name: variant === 'giii' ? 'giiiLoggingConfig' : 'loggingConfig',
      fragmentPath:
        variant === 'giii'
          ? './../loggingConfig/giii-loggingConfig.html'
          : './../loggingConfig/loggingConfig.html',
      containerId: (tab) => `config-log-${tab}`,
    });
    this.variant = variant;
  }

  protected override loaderDuration(_tab: TabId): number {
    return 15000;
  }

  page(tab: TabId): LoggingPageData {
    let value = this.pages.get(tab);
    if (!value) {
      value = {
        storage: 'Onboard',
        localFileName: '',
        desktopFileSettings: { maxFileTime: 0, diskFullAction: 'STOP' },
      };
      this.pages.set(tab, value);
    }
    return value;
  }

  selectStorage(tab: TabId, storage: LoggingStorage): void {
    this.page(tab).storage = storage;
    this.state.setPending(tab, 'storage', 'storage', storage);
  }

  setFileRotation(
    tab: TabId,
    values: { maxFileTime?: number; diskFullAction?: string },
  ): void {
    const current = this.state.current(tab)[String(LOGGING_MSG.FILEROTATE)];
    const baseline =
      current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(values)) {
      if (this.page(tab).storage === 'LocalFile' && key === 'maxFileTime') {
        this.page(tab).desktopFileSettings.maxFileTime = Number(value);
        this.state.setPending(tab, 'desktopFileSettings', key, value);
      } else if (this.page(tab).storage === 'LocalFile' && key === 'diskFullAction') {
        this.page(tab).desktopFileSettings.diskFullAction = String(value);
        this.state.setPending(tab, 'desktopFileSettings', key, value);
      } else {
        this.state.setPending(tab, LOGGING_MSG.FILEROTATE, key, value, baseline[key]);
      }
    }
  }

  setLog(
    tab: TabId,
    name: string,
    value: {
      messageID?: number;
      format?: string;
      trigger?: string;
      period?: number;
      category?: string;
    },
  ): void {
    const current = this.state.current(tab)[String(LOGGING_MSG.LOGLIST)];
    const baseline =
      current && typeof current === 'object'
        ? (current as Record<string, Record<string, unknown>>)[name]
        : undefined;
    this.state.setPending(tab, LOGGING_MSG.LOG, name, value, baseline);
  }

  setLocalFileName(tab: TabId, name: string): void {
    this.page(tab).localFileName = name;
    this.state.setPending(tab, 'localFile', 'fileName', name);
  }

  protected runApply(tab: TabId): undefined {
    const page = this.page(tab);
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    if (this.variant === 'standard') this.sendNmea(tab, pending);

    let port: string;
    if (page.storage === 'Onboard') {
      port = 'FILE';
      const oem7 = this.context.features(tab).generation === 'OEM7';
      if (oem7) {
        this.commands.place(
          this.name,
          'fileconfig',
          [{ fileOperation: ['OPEN', 'enum', 4] }],
          tab,
        );
        if (pending[String(LOGGING_MSG.FILEROTATE)]) {
          const changed = pending[String(LOGGING_MSG.FILEROTATE)];
          this.commands.place(
            this.name,
            'filerotateconfig',
            [
              { maxFileTime: [changed.maxFileTime ?? 0, 'ushort', 2] },
              { maxFileSize: [4096, 'ushort', 2] },
              { diskFullAction: [changed.diskFullAction ?? 'STOP', 'enum', 4] },
            ],
            tab,
          );
        }
      } else {
        this.commands.place(
          this.name,
          'logfile',
          [
            { fileOperation: ['OPEN', 'enum', 4] },
            { fileName: ['', 'char', 128] },
          ],
          tab,
        );
      }
    } else {
      port = `${this.context.connectedPortName?.(tab) ?? 'COM1'}_29`;
      this.context.store.set(['app', 'fileRotation', this.context.deviceTileId(tab)], page.desktopFileSettings.maxFileTime);
      this.context.store.set(['app', 'diskFullAction', this.context.deviceTileId(tab)], page.desktopFileSettings.diskFullAction);
    }

    for (const [name, changed] of Object.entries(pending[String(LOGGING_MSG.LOG)] ?? {})) {
      const record = changed as Record<string, unknown>;
      const trigger = String(record.trigger ?? 'ONTIME').toUpperCase();
      const messageType = this.messageType(String(record.format ?? 'Binary'), name.endsWith('_1'));
      this.commands.place(
        this.name,
        'log',
        [
          { port: [port, 'enum', 4] },
          { messageID: [record.messageID ?? record.msgId, 'ushort', 2] },
          { messageType: [messageType, 'char', 1] },
          { reserved: [0, 'char', 1] },
          { trigger: [trigger, 'enum', 4] },
          { period: [trigger === 'ONTIME' ? record.period ?? 1 : 0, 'double', 8] },
          { offset: [0, 'double', 8] },
          { hold: ['HOLD', 'enum', 4] },
        ],
        tab,
      );
    }

    const logEntries = Object.values(pending[String(LOGGING_MSG.LOG)] ?? {}) as Array<Record<string, unknown>>;
    if (logEntries.length > 0 && logEntries.every((entry) => String(entry.trigger).toUpperCase() === 'ONCE')) {
      this.context.clock.setTimeout(() => this.stopalllogs(tab), 3000);
    } else {
      this.context.unloggingLogsOnWCOM?.(tab);
    }
    return undefined;
  }

  private sendNmea(tab: TabId, pending: Record<string, Record<string, unknown>>): void {
    const nmea = pending[String(LOGGING_MSG.NMEA_CONFIG)];
    if (nmea) {
      this.commands.place(this.name, 'nmeaConfig', [{ option: [nmea.option, 'enum', 4] }], tab);
    }
    const beidou = pending[String(LOGGING_MSG.NMEA_BEIDOU_CONFIG)];
    if (beidou) {
      this.commands.place(this.name, 'nmeaBeiDouConfig', [{ option: [beidou.option, 'enum', 4] }], tab);
    }
    const format = pending[String(LOGGING_MSG.NMEA_FORMAT)];
    if (format) {
      const numeric = Number(format.format);
      let latitude = '0';
      let longitude = '0';
      if (numeric === 5) [latitude, longitude] = ['10.5', '11.5'];
      else if (numeric === 6) [latitude, longitude] = ['11.6', '12.6'];
      else if (numeric === 7) [latitude, longitude] = ['12.7', '13.7'];
      else if (numeric === 8) [latitude, longitude] = ['12.8', '14.8'];
      this.commands.place(
        this.name,
        'nmeaFormatConfig',
        [
          { field: ['GGA_LATITUDE', 'enum', 4] },
          { format: [latitude, 'string', 8] },
        ],
        tab,
      );
      this.commands.place(
        this.name,
        'nmeaFormatConfig',
        [
          { field: ['GGA_LONGITUDE', 'enum', 4] },
          { format: [longitude, 'string', 8] },
        ],
        tab,
      );
    }
    const gga = pending[String(LOGGING_MSG.GGA_QUALITY)];
    if (gga) {
      this.commands.place(
        this.name,
        'ggaQualityConfig',
        [
          { entries: [1, 'ulong', 4] },
          { posType: ['PPP', 'enum', 4] },
          { quality: [Number(gga.quality) || '', 'ulong', 4] },
        ],
        tab,
      );
    }
  }

  private messageType(format: string, timed = false): number {
    const base = format === 'ASCII' ? 32 : format === 'Abbr ASCII' ? 64 : 0;
    return base + (timed ? 1 : 0);
  }

  /**
   * R40: stopping the final active log first closes the file, then releases component logs.
   * `logCount` is the current receiver LOGLIST count for this destination.
   */
  stopLog(tab: TabId, name: string, format = 'Binary', logCount?: number): void {
    const storage = this.page(tab).storage;
    const port =
      storage === 'Onboard'
        ? 'FILE'
        : `${this.context.connectedPortName?.(tab) ?? 'COM1'}_29`;
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, 10000, 'STOPPING');
    const messageId =
      this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] &&
      typeof this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] === 'object'
        ? (
            this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] as Record<
              string,
              Record<string, unknown>
            >
          )[name]?.messageID
        : undefined;
    this.commands.place(
      this.name,
      'unlog',
      [
        { port: [port, 'enum', 4] },
        { messageID: [messageId ?? -1, 'ushort', 2] },
        { messageType: [this.messageType(format, name.endsWith('_1')), 'char', 1] },
        { reserved: [0, 'char', 1] },
      ],
      tab,
    );
    const count =
      logCount ??
      (this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] &&
      typeof this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] === 'object'
        ? Object.keys(this.state.current(tab)[String(LOGGING_MSG.LOGLIST)] as object).length
        : 1);
    if (count <= 1) this.sendCloseFile(tab, storage);
    this.context.unloggingLogsOnWCOM?.(tab);
  }

  /** `stopalllogs`: close the file for onboard storage and UNLOGALL on the selected destination. */
  stopalllogs(tab: TabId): void {
    const storage = this.page(tab).storage;
    const port =
      storage === 'Onboard'
        ? 'FILE'
        : `${this.context.connectedPortName?.(tab) ?? 'COM1'}_29`;
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, 10000, 'STOPPING');
    if (storage === 'Onboard') this.sendCloseFile(tab, storage);
    this.commands.place(
      this.name,
      'unlogall',
      [
        { port: [port, 'enum', 4] },
        { held: ['TRUE', 'enum', 4] },
      ],
      tab,
    );
    this.context.unloggingLogsOnWCOM?.(tab);
  }

  private sendCloseFile(tab: TabId, storage: LoggingStorage): void {
    void storage;
    const oem7 = this.context.features(tab).generation === 'OEM7';
    this.commands.place(
      this.name,
      oem7 ? 'fileconfig' : 'logfile',
      oem7
        ? [{ fileOperation: ['CLOSE', 'enum', 4] }]
        : [
            { fileOperation: ['CLOSE', 'enum', 4] },
            { fileName: ['', 'char', 128] },
          ],
      tab,
    );
  }

  getLocalFileLoggingInfo(tab: TabId): Record<string, unknown> {
    return {
      storage: this.page(tab).storage,
      fileName: this.page(tab).localFileName,
      ...this.page(tab).desktopFileSettings,
    };
  }

  handleLoggingConfigCommandResponse(data: 1 | 2, tab: TabId): void {
    this.handleCommandResponse(data, tab);
  }

  resetLoggingConfigUI(tab: TabId, _skipLoader = false): void {
    this.context.clock.setTimeout(() => this.reset(tab), 0);
  }

  startLogging(tab: TabId): 1 | 2 | undefined {
    return this.apply(tab);
  }

  protected render(_tab: TabId): void {
    // The shipped page populates its generated message rows from LOGLIST/FILESTATUS. Those are
    // retained verbatim in `currentData`; no synthetic row text is created here.
  }

  protected override namespace(tab: TabId, container: Element): void {
    namespaceCollapsePanels(container, tab);
    namespaceRadioInputs(container, tab);
  }
}

export class GiiiLoggingConfigPage extends LoggingConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, 'giii');
  }

  override mount(tab: TabId, containerId = `config-log-${tab}`): boolean {
    const mounted = super.mount(tab, containerId);
    if (!mounted) return false;
    const root = this.context.document.getElementById(tab);
    const dismiss = root?.querySelector('#giii-loggingDismiss-btn');
    const restart = root?.querySelector('#giii-loggingRestart-btn');
    dismiss?.addEventListener('click', () => {
      const notice = root?.querySelector('.giii-logging-restart-container') as
        | (Element & { style?: CSSStyleDeclaration })
        | null;
      if (notice?.style) notice.style.display = 'none';
    });
    restart?.addEventListener('click', () => this.context.restartReceiver?.(tab, 'giii'));
    return true;
  }
}
