import {
  MSG_ID,
  clone,
  escapeHTML,
  formatNumber,
  heightText,
  normalizeLog,
  numberValue,
  queryIn,
  removeMarkers,
  scopeOf,
  setStyle,
  setText,
  showTrafficLight,
  tabOf,
  applyLanguageMarkers,
  __,
  updateFields,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';

interface StatusBarState {
  skdetectConfig: Record<TabId, string | undefined>;
  itDetectConfigData: Record<TabId, string | undefined>;
  spoofingRAGColor: Record<TabId, string | undefined>;
  jammingRAGColor: Record<TabId, string | undefined>;
  ragIndicatorLogs: Record<TabId, Record<number, boolean>>;
  ragIndicatorLogsList: number[];
  gIIIRagIndicatorLogsList: number[];
  giiiDataPortState: Record<TabId, string | undefined>;
}

const STANDARD_RAG_LOGS = [
  MSG_ID.INTERFACEMODE,
  MSG_ID.LOGLIST,
  MSG_ID.BESTPOS,
  MSG_ID.PORTSTATS,
  MSG_ID.RXSTATUS,
  963,
  MSG_ID.FILESTATUS,
  MSG_ID.FILESYSTEMCAPACITY,
  MSG_ID.INSPVAX,
  379,
  MSG_ID.ITDETECTSTATUS,
];

export class StatusBar {
  readonly state: StatusBarState = {
    skdetectConfig: {},
    itDetectConfigData: {},
    spoofingRAGColor: {},
    jammingRAGColor: {},
    ragIndicatorLogs: {},
    ragIndicatorLogsList: [...STANDARD_RAG_LOGS],
    gIIIRagIndicatorLogsList: [MSG_ID.GIII_CARDSTATUS],
    giiiDataPortState: {},
  };

  private readonly ctx: StatusContext;
  private readonly ragOf: {
    position(tab: TabId): string | undefined;
    span(tab: TabId): string | undefined;
    device(tab: TabId): string | undefined;
    interference(tab: TabId): string | undefined;
    logging(tab: TabId): string | undefined;
    positionMessages?(tab: TabId, colour: 'red' | 'yellow'): string | string[];
    spanMessages?(tab: TabId): string[];
    deviceMessages?(tab: TabId): Record<string, Array<string | Record<string, string>>> | undefined;
    longhornDeviceMessages?(tab: TabId): { red: Array<string | Record<string, string>> } | undefined;
  };
  private readonly wiredTabs = new Set<TabId>();

  constructor(
    ctx: StatusContext,
    ragOf: {
      position(tab: TabId): string | undefined;
      span(tab: TabId): string | undefined;
      device(tab: TabId): string | undefined;
      interference(tab: TabId): string | undefined;
      logging(tab: TabId): string | undefined;
      positionMessages?(tab: TabId, colour: 'red' | 'yellow'): string | string[];
      spanMessages?(tab: TabId): string[];
      deviceMessages?(tab: TabId): Record<string, Array<string | Record<string, string>>> | undefined;
      longhornDeviceMessages?(tab: TabId): { red: Array<string | Record<string, string>> } | undefined;
    },
  ) {
    this.ctx = ctx;
    this.ragOf = ragOf;
  }

  updateView(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    if (!STATUS_BAR_IDS.has(msgID)) return 0;
    const features = this.ctx.features(tab);
    this.ensureRag(tab);
    this.editRagIndicatorObject(tab, msgID);
    setText(this.ctx, tab, '#statusBarhardwareVersion', features.model || String(data.hardwareVersion ?? '--'));

    if (msgID === MSG_ID.BESTPOS) {
      return this.updateBestPos(tab, data);
    }
    if (msgID === 963) {
      const idle = numberValue(data.idleTime, Number.NaN);
      return setText(
        this.ctx,
        tab,
        '#statusBaridleTime',
        Number.isFinite(idle) ? `${formatNumber(this.ctx, idle, 0, tab)}%` : '--',
      )
        ? 1
        : 0;
    }
    if (msgID === MSG_ID.FILESYSTEMCAPACITY) {
      return this.updateStorage(tab, data);
    }
    if (msgID === MSG_ID.TIME) {
      const hour = `${numberValue(data.utcHour)}`.padStart(2, '0');
      const minute = `${numberValue(data.utcMin)}`.padStart(2, '0');
      const second = `${Math.floor(numberValue(data.utcMS) / 1000)}`.padStart(2, '0');
      return setText(this.ctx, tab, '#statusBartime', `${hour}:${minute}:${second}`) ? 1 : 0;
    }
    if (msgID === MSG_ID.VERSION) {
      const block = Array.isArray(data.blocks) ? data.blocks[0] : undefined;
      const version = (block as LogData | undefined)?.hardwareVersion ?? data.hardwareVersion;
      if (typeof version === 'string') {
        setText(this.ctx, tab, '#statusBarhardwareVersion', version);
      }
      updateFields(this.ctx, tab, 'statusBar', this.ctx.componentFields('statusBar', msgID) ?? 'hardwareVersion', {
        ...data,
        hardwareVersion: version,
        tab,
      });
      this.updateOverall(tab);
      return 1;
    }
    if (msgID === MSG_ID.ITDETECTSTATUS) {
      return this.updateInterference(tab, data);
    }
    if (msgID === MSG_ID.RXSTATUS) {
      return this.updateRxStatus(tab, data);
    }
    if (msgID === MSG_ID.SKDETECTCONFIG) {
      this.state.skdetectConfig[tab] = String(data.mode ?? '');
      this.updateOverall(tab);
      return 1;
    }
    if (msgID === MSG_ID.ITDETECTCONFIG) {
      this.state.itDetectConfigData[tab] = String(data.rfpath ?? '');
      return 1;
    }
    if (msgID === MSG_ID.GIII_CARDSTATUS) {
      return this.updateCardStatus(tab, data);
    }

    const fields = this.ctx.componentFields('statusBar', msgID) ?? this.fieldsFor(msgID).join(',');
    if (fields) {
      const viewData = { ...data, tab };
      (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
        viewData,
        fields,
        'statusBar',
      );
    }
    this.updateOverall(tab);
    return 1;
  }

  editRagIndicatorObject(tab: TabId, msgID: number): void {
    const logs = this.state.ragIndicatorLogs[tab];
    if (logs && (!Object.prototype.hasOwnProperty.call(logs, msgID) || logs[msgID] !== true)) {
      logs[msgID] = true;
    }
  }

  getitDetectConfigData(tab: TabId): string | undefined {
    return this.state.itDetectConfigData[tab];
  }

  getInternalFlashOnly(data: LogData): LogData | null {
    const devices = Object.values(data).filter(
      (item): item is LogData =>
        !!item && typeof item === 'object' && 'massStorageDevice' in item,
    );
    return devices.find((device) => device.massStorageDevice === 'INTERNAL_FLASH') ?? null;
  }

  allLogsReceived(tab: TabId): boolean {
    this.ensureRag(tab);
    return Object.values(this.state.ragIndicatorLogs[tab]).every(Boolean);
  }

  reset(tab: TabId): void {
    delete this.state.skdetectConfig[tab];
    delete this.state.itDetectConfigData[tab];
    delete this.state.spoofingRAGColor[tab];
    delete this.state.jammingRAGColor[tab];
    delete this.state.ragIndicatorLogs[tab];
    delete this.state.giiiDataPortState[tab];
  }

  processLanguage(): void {
    const keys: Array<[string, string]> = [
      ['positioning', 'POSITIONING'], ['position', 'POSITION'], ['latitude', 'LAT'],
      ['longitude', 'LONG'], ['height', 'HEIGHT'], ['height-msl', 'HEIGHT_MSL'],
      ['height-ellipsoidal', 'HEIGHT_ELLIPSOIDAL'], ['span', 'SPAN'], ['model', 'MODEL'],
      ['cpuusage', 'CPU_USAGE'], ['logging', 'LOGGING'], ['spoofing', 'SPOOFING'],
      ['storageusage', 'STORAGE_USAGE'], ['interference', 'INTERFERENCE'],
      ['jamming-detected', 'JAMMING_DETECTED'], ['spoofing-detected', 'SPOOFING_DETECTED'],
      ['device', 'DEVICE'], ['error', 'ERROR'], ['good', 'GOOD'], ['warning', 'WARNING'],
      ['time-utc', 'TIME_UTC'], ['device-status', 'STATE'], ['not-detected', 'NOT_DETECTED'],
      ['detected', 'DETECTED'], ['detection-disabled', 'DETECTION_DISABLED'],
      ['not-calibrated', 'NOT_CALIBRATED'], ['disabled', 'DISABLED'],
    ];
    applyLanguageMarkers(this.ctx, keys.map(([marker, key]) => ({
      selector: `[data-lang-${marker}]`,
      value: __(this.ctx, key),
    })));
  }

  private updateBestPos(tab: TabId, source: LogData): number {
    const data = clone(source);
    // The component receives full decoder output in production. Keep the lower-level
    // genericView contract for callers that provide only the registered field subset.
    if (!Object.prototype.hasOwnProperty.call(data, 'solutionStatus')) {
      return (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
        { ...data, tab },
        'latitude,longitude,height,undulation',
        'statusBar',
      );
    }
    const latitude = numberValue(data.latitude, Number.NaN);
    const longitude = numberValue(data.longitude, Number.NaN);
    let written = 0;
    if (Number.isFinite(latitude)) {
      written += setText(
        this.ctx,
        tab,
        '#statusBarlatitude',
        `${formatNumber(this.ctx, latitude, 7, tab)}°`,
      )
        ? 1
        : 0;
    }
    if (Number.isFinite(longitude)) {
      written += setText(
        this.ctx,
        tab,
        '#statusBarlongitude',
        `${formatNumber(this.ctx, longitude, 7, tab)}°`,
      )
        ? 1
        : 0;
    }
    written += setText(this.ctx, tab, '#statusBarheight', heightText(this.ctx, data, tab)) ? 1 : 0;
    const configPosition = queryIn(this.ctx, tab, '#positionStatusConfiguredPosition');
    const barPosition = queryIn(this.ctx, tab, '#statusBarConfiguredPosition');
    if (configPosition && barPosition) {
      barPosition.innerHTML = configPosition.innerHTML;
      for (const node of barPosition.querySelectorAll('span')) node.classList.add('elidedText');
      for (const node of barPosition.querySelectorAll('.single')) node.classList.add('elidedText');
    }
    this.updateOverall(tab);
    return written;
  }

  private updateStorage(tab: TabId, data: LogData): number {
    const flash = this.getInternalFlashOnly(data);
    if (!flash || numberValue(flash.totalStorage) === 0) return 0;
    const percent = Math.round(
      (numberValue(flash.usedStorage) / numberValue(flash.totalStorage)) * 100,
    );
    const text = `${formatNumber(this.ctx, percent, 0, tab)}%`;
    setStyle(queryIn(this.ctx, tab, '.statusBarusedStorageHide'), 'display', 'inline-block');
    const field = queryIn(this.ctx, tab, '#statusBarusedStorage');
    if (field) {
      field.textContent = text;
      return 1;
    }
    return 0;
  }

  private updateInterference(tab: TabId, data: LogData): number {
    if (this.ctx.features(tab).generation === 'OEM6') return 1;
    const field = queryIn(this.ctx, tab, '#statusBaritkState');
    removeMarkers(field, ['data-lang-detected', 'data-lang-not-detected', 'data-lang-disabled']);
    if (this.state.itDetectConfigData[tab] === 'NONE') {
      setText(this.ctx, tab, '#statusBaritkState', 'Disabled');
      field?.setAttribute('data-lang-disabled', '');
      return 1;
    }
    setText(
      this.ctx,
      tab,
      '#statusBaritkState',
      String(data.itkState ?? (numberValue(data.noOfEntries) > 0 ? 'Detected' : 'Not Detected')),
    );
    if (field) {
      const value = field.textContent;
      field.setAttribute(
        value === 'Detected'
          ? 'data-lang-detected'
          : value === 'Disabled'
            ? 'data-lang-disabled'
            : 'data-lang-not-detected',
        '',
      );
    }
    this.updateOverall(tab);
    return 1;
  }

  private updateRxStatus(tab: TabId, data: LogData): number {
    const spoofingValue = queryIn(this.ctx, tab, '#statusBarspoofing');
    removeMarkers(spoofingValue, [
      'data-lang-not-calibrated',
      'data-lang-detected',
      'data-lang-not-detected',
      'data-lang-disabled',
    ]);
    const rx15 = Number(data.rxstatus15bit);
    const features = this.ctx.features(tab);
    setStyle(
      this.ctx.document.querySelector(`#${tab} .statusBarSpoofingView`),
      'display',
      features.spoofingSupported ? 'inline-block' : 'none',
    );
    if (features.spoofingSupported) {
      const storage = this.ctx.document.querySelector(
        `#${tab} .status-bar .statusBarusedStorageHide`,
      ) as (Element & { style?: CSSStyleDeclaration }) | null;
      const storageVisible = storage?.style?.display !== 'none';
      setStyle(
        this.ctx.document.querySelector(`#${tab} .receiverPanel`),
        'height',
        storageVisible ? '162px' : '136px',
      );
      setStyle(
        this.ctx.document.querySelector(`#${tab} .result-content`),
        'padding-top',
        storageVisible ? '4em' : '3.5em',
      );
    }
    if (rx15 === 0) this.state.jammingRAGColor[tab] = 'good';
    else if (rx15 === 1) this.state.jammingRAGColor[tab] = 'bad';

    const aux25 = Number(data.aux3status25bit);
    const rx9 = Number(data.rxstatus9bit);
    this.state.spoofingRAGColor[tab] = 'good';
    if (aux25 === 1) {
      setText(this.ctx, tab, '#statusBarspoofing', 'Not Calibrated');
      spoofingValue?.setAttribute('data-lang-not-calibrated', '');
    } else {
      const config = this.state.skdetectConfig[tab];
      if (config === 'ENABLE') {
        if (rx9 === 0) {
          setText(this.ctx, tab, '#statusBarspoofing', 'Not Detected');
          spoofingValue?.setAttribute('data-lang-not-detected', '');
        } else if (rx9 === 1) {
          setText(this.ctx, tab, '#statusBarspoofing', 'Detected');
          spoofingValue?.setAttribute('data-lang-detected', '');
        }
        if (rx9 === 1) this.state.spoofingRAGColor[tab] = 'bad';
      } else if (config === 'DISABLE') {
        setText(this.ctx, tab, '#statusBarspoofing', 'Detection Disabled');
        spoofingValue?.setAttribute('data-lang-detection-disabled', '');
      }
    }
    const viewData: LogData = {
      tab,
      time: data.time,
      rxstatus3bit: data.rxstatus3bit,
    };
    if (aux25 === 1) viewData.spoofing = 'Not Calibrated';
    else if (this.state.skdetectConfig[tab] === 'ENABLE' && (rx9 === 0 || rx9 === 1)) {
      viewData.spoofing = rx9 === 1 ? 'Detected' : 'Not Detected';
    } else if (this.state.skdetectConfig[tab] === 'DISABLE') {
      viewData.spoofing = 'Detection Disabled';
    }
    (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
      viewData,
      this.ctx.componentFields('statusBar', MSG_ID.RXSTATUS) ?? 'spoofing',
      'statusBar',
    );
    this.updateOverall(tab);
    return 1;
  }

  private updateCardStatus(tab: TabId, data: LogData): number {
    this.state.giiiDataPortState[tab] = String(data.state ?? '');
    const fields = new Set([
      'State',
      'Mode',
      'Software',
      'IOMasteridleTime',
      'IOMastertemperature',
      'DSPCidleTime',
      'DSPCtemperature',
      'Week',
      'Milliseconds',
    ]);
    const values: LogData = {
      ...data,
      State:
        data.state === 'Configuration'
          ? __(this.ctx, 'CONFIGURATION')
          : data.state,
      Mode: data.mode,
      Software: data.attenSetting,
      Week: `${data.week ?? '--'} (Wk)`,
      Milliseconds: `${Math.floor(numberValue(data.milliseconds) / 1000)} (Secs)`,
    };
    if (data.state === 'Configuration') {
      queryIn(this.ctx, tab, '#statusBarState')?.setAttribute(
        'data-lang-configuration',
        '',
      );
    }
    const cards = Array.isArray(data.cardsData) ? (data.cardsData as LogData[]) : [];
    for (const card of cards) {
      const name = String(card.component ?? '');
      if (name === 'IOMASTER' || name === 'DSPC') {
        values[`${name}idleTime`] = `${formatNumber(this.ctx, card.idleTime, 0, tab)}%`;
        values[`${name}temperature`] = `${formatNumber(this.ctx, card.value_1, 0, tab)} °C`;
      }
    }
    (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
      { ...values, tab },
      [...fields].join(','),
      'statusBar',
    );
    this.updateOverall(tab);
    return 1;
  }

  private updateOverall(tab: TabId): void {
    this.wireStatusLights(tab);
    const features = this.ctx.features(tab);
    const position = this.ragOf.position(tab);
    const span = features.spanSupported ? this.ragOf.span(tab) : undefined;
    const positioning =
      position === 'bad' || span === 'bad'
        ? 'red'
        : position === 'warning' || span === 'warning'
          ? 'yellow'
          : 'green';

    const device = this.ragOf.device(tab);
    const interference = this.ragOf.interference(tab);
    const logging = this.ragOf.logging(tab);
    const spoofing = this.state.spoofingRAGColor[tab];
    const jamming = this.state.jammingRAGColor[tab];
    const deviceColour =
      [device, interference, logging, spoofing, jamming].includes('bad')
        ? 'red'
        : [device, interference, logging].includes('warning')
          ? 'yellow'
          : 'green';

    const allReceived = this.allLogsReceived(tab);
    const scope = scopeOf(this.ctx, tab);
    const hasIndicators =
      !!scope?.querySelector('.positioning-traffic') && !!scope?.querySelector('.device-traffic');
    if (allReceived && !hasIndicators) {
      this.updateDeviceTileIndicator(tab, positioning, deviceColour, features);
      return;
    }
    showTrafficLight(this.ctx, tab, 'positioning-traffic', positioning);
    showTrafficLight(this.ctx, tab, 'device-traffic', deviceColour);
    if (allReceived) this.updateDeviceTileIndicator(tab, positioning, deviceColour, features);
  }

  private updateDeviceTileIndicator(
    tab: TabId,
    positioning: 'red' | 'yellow' | 'green',
    device: 'red' | 'yellow' | 'green',
    features: ReturnType<StatusContext['features']>,
  ): void {
    let connection = 'grey';
    if (positioning === device) connection = device;
    else if (
      features.isGIII &&
      this.ctx.giiiPortType?.(tab) === 'Data' &&
      this.state.giiiDataPortState[tab] === 'Configuration'
    ) {
      connection = device;
    } else if (positioning === 'red' || device === 'red') connection = 'red';
    else if (positioning === 'yellow' || device === 'yellow') connection = 'yellow';
    const element = this.ctx.document.querySelector(
      `#${this.ctx.deviceTileId(tab)}-device-tile .devicetile-indicator`,
    );
    if (!element) return;
    for (const colour of ['red', 'yellow', 'green', 'grey']) element.classList.remove(colour + '-circle');
    element.classList.add(connection + '-circle');
  }

  private wireStatusLights(tab: TabId): void {
    if (this.wiredTabs.has(tab)) return;
    const scope = scopeOf(this.ctx, tab);
    if (!scope) return;
    const bind = (parent: string, colour: 'red' | 'yellow'): void => {
      for (const node of scope.querySelectorAll(
        `.${parent}.traffic-lights span.${colour}-status`,
      )) {
        node.addEventListener('click', () => this.openStatusDialog(tab, parent, colour));
      }
    };
    bind('positioning-traffic', 'red');
    bind('positioning-traffic', 'yellow');
    bind('device-traffic', 'red');
    bind('device-traffic', 'yellow');
    this.wiredTabs.add(tab);
  }

  private languageText(value: unknown): string {
    if (value && typeof value === 'object') {
      const [key, parameter] = Object.entries(value)[0] ?? [];
      return key
        ? __(this.ctx, key).replace('%1', String(parameter ?? ''))
        : '';
    }
    return value ? __(this.ctx, String(value).toUpperCase()) : '';
  }

  private openStatusDialog(
    tab: TabId,
    parent: 'positioning-traffic' | 'device-traffic',
    colour: 'red' | 'yellow',
  ): void {
    const messages: string[] = [];
    if (parent === 'positioning-traffic') {
      const position = this.ragOf.positionMessages?.(tab, colour);
      if (Array.isArray(position)) {
        for (const message of position) messages.push(this.languageText(message));
      } else if (position) {
        messages.push(this.languageText(position));
      }
      for (const message of this.ragOf.spanMessages?.(tab) ?? []) {
        messages.push(this.languageText(message));
      }
    } else {
      const bucket = this.ctx.features(tab).isLongHorn
        ? this.ragOf.longhornDeviceMessages?.(tab)
        : this.ragOf.deviceMessages?.(tab);
      const entries =
        colour === 'red'
          ? bucket?.red
          : bucket?.amber?.length
            ? bucket.amber
            : bucket?.warning;
      for (const entry of entries ?? []) messages.push(this.languageText(entry));
      const desired = colour === 'red' ? 'bad' : 'warning';
      if (this.ragOf.interference(tab) === desired) {
        messages.push(this.languageText('INTERFERENCESTATUSRED'));
      }
      if (this.ragOf.logging(tab) === desired) {
        messages.push(this.languageText('LOGSTATUSRED'));
      }
      if (colour === 'red' && this.state.spoofingRAGColor[tab] === 'bad') {
        messages.push(this.languageText('SPOOFING_DETECTED'));
      }
      if (colour === 'red' && this.state.jammingRAGColor[tab] === 'bad') {
        messages.push(this.languageText('JAMMING_DETECTED'));
      }
    }
    const text = messages.filter(Boolean);
    if (!text.length) return;
    const titleBase = parent === 'positioning-traffic' ? 'POSITIONING' : 'DEVICE';
    const title = `${__(this.ctx, titleBase)} - ${__(
      this.ctx,
      colour === 'yellow' ? 'WHY_IS_THIS_AMBER' : 'WHY_IS_THIS_RED',
    )}`;
    this.ctx.openDialog?.({
      tab,
      title,
      titleMarker:
        parent === 'positioning-traffic'
          ? `data-lang-title-positionStatus${colour === 'yellow' ? 'Amber' : 'Red'}`
          : `data-lang-title-deviceInfo${colour === 'yellow' ? 'Amber' : 'Red'}`,
      content: text
        .map((message) => `<p class="preserve-line-breaks">${escapeHTML(message).replace(/\n/g, '<br>')}</p>`)
        .join(''),
    });
  }

  private ensureRag(tab: TabId): void {
    if (this.state.ragIndicatorLogs[tab]) return;
    const features = this.ctx.features(tab);
    let ids = features.isGIII
      ? [...this.state.gIIIRagIndicatorLogsList]
      : [...this.state.ragIndicatorLogsList];
    if (!features.spanSupported && !features.isGIII) {
      ids = ids.filter((id) => id !== MSG_ID.INSPVAX && id !== 379);
    }
    if (features.positionModes.includes('NONE')) ids = ids.filter((id) => id !== MSG_ID.BESTPOS);
    if ((features.generation === 'OEM6' || features.generation === 'OEMSTAR') && !features.isGIII) {
      ids = ids.filter((id) => id !== MSG_ID.ITDETECTSTATUS);
    }
    if (!features.loggingComponent || !features.fileSupported) {
      ids = ids.filter((id) => id !== MSG_ID.FILESTATUS && id !== MSG_ID.FILESYSTEMCAPACITY);
    }
    if (!features.spoofingSupported) {
      ids = ids.filter((id) => id !== MSG_ID.SKDETECTCONFIG);
    }
    this.state.ragIndicatorLogs[tab] = Object.fromEntries(ids.map((id) => [id, false]));
  }

  private fieldsFor(msgID: number): string[] {
    switch (msgID) {
      case MSG_ID.VERSION:
        return ['hardwareVersion'];
      case 963:
        return ['idleTime'];
      case MSG_ID.TIME:
        return ['time'];
      case MSG_ID.INSPVAX:
        return ['spanstatus'];
      default:
        return [];
    }
  }
}

const STATUS_BAR_IDS = new Set<number>([
  MSG_ID.INTERFACEMODE,
  MSG_ID.VERSION,
  MSG_ID.BESTPOS,
  MSG_ID.PORTSTATS,
  MSG_ID.RXSTATUS,
  MSG_ID.TIME,
  379,
  963,
  MSG_ID.SATVIS2,
  MSG_ID.CHANCONFIGLIST,
  MSG_ID.NTRIPCONFIG,
  MSG_ID.CONNECTIMU,
  MSG_ID.INSPVAX,
  MSG_ID.ASSIGNLBANDBEAM,
  MSG_ID.ITDETECTSTATUS,
  MSG_ID.FILESYSTEMCAPACITY,
  MSG_ID.ITDETECTCONFIG,
  MSG_ID.SKDETECTCONFIG,
  MSG_ID.GIII_CARDSTATUS,
  MSG_ID.GIII_TIMESOLUTION,
]);
