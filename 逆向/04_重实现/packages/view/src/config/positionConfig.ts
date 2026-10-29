import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigDataMap,
  ConfigPageRuntime,
} from './types.ts';
import { COMMAND_RESPONSE } from './types.ts';
import {
  BaseConfigPage,
  addError,
  clearErrors,
  elementValue,
  namespaceCollapsePanels,
  setActive,
  setValue,
} from './base.ts';

export const POSITION_MSG = {
  BESTPOS: 42,
  FIXPOSITION: 44,
  INTERFACE_MODE: 3,
  LOG: 1,
  UNLOG: 36,
  UNLOGALL: 38,
  AUTOSURVEY: 1795,
  POSAVE: 173,
  SERIALCONFIG: 1246,
  ICOMCONFIG: 1248,
  NTRIPCONFIG: 1249,
  SBASCONTROL: 652,
  ASSIGNLBANDBEAM: 1733,
  FILECONFIG: 2116,
  LOGFILE: 157,
} as const;

type OperatingMode = 'Standalone' | 'Transmit' | 'Receive';

export interface PositionPageData {
  operatingMode: OperatingMode;
  selectedMode: OperatingMode;
  surveyType: 'survey-auto' | 'survey-manual';
  surveyTime: number;
  accuracy: number;
  latitude: number;
  longitude: number;
  height: number;
  inputFormat: string;
  correctionType: string;
  msmCorrectionType: string;
  selectedPorts: string[];
  serialByPort: Record<string, { baud: number; parity: string; databits: number; stopbits: number }>;
  receiveModeChanged: { rtk: boolean; ppp: boolean; sbas: boolean };
}

const CORRECTION_LOG_IDS: Record<string, number[]> = {
  RTCMV3: [768, 854, 1097, 770, 891],
  MSM12: [768, 1655, 854, 1097, 1472, 1479, 1486, 1648, 1592, 1473, 1480, 1487, 1649, 1593],
  MSM2: [768, 1655, 854, 1097, 1473, 1480, 1487, 1649, 1593],
  MSM3: [768, 1655, 854, 1097, 1474, 1481, 1488, 1650, 1594],
  MSM4: [768, 1655, 854, 1097, 1475, 1482, 1489, 1651, 1595],
  MSM5: [768, 1655, 854, 1097, 1476, 1483, 1490, 1652, 1596],
  MSM6: [768, 1655, 854, 1097, 1477, 1484, 1491, 1653, 1597],
  MSM7: [768, 1655, 854, 1097, 1478, 1485, 1492, 1654, 1598],
  RTCA: [11, 805],
  CMR: [105, 103, 882],
  RTCM: [117, 118, 665, 667, 260],
  NOVATELX: [1618],
};

const CORRECTION_PERIODS: Record<number, number> = {
  768: 10,
  854: 10,
  1097: 10,
  1655: 10,
};

const PAGE_DEFAULT: PositionPageData = {
  operatingMode: 'Standalone',
  selectedMode: 'Standalone',
  surveyType: 'survey-auto',
  surveyTime: 1440,
  accuracy: 2,
  latitude: 0,
  longitude: 0,
  height: 0,
  inputFormat: 'RTCMV3',
  correctionType: 'RTCMV3',
  msmCorrectionType: 'MSM4',
  selectedPorts: [],
  serialByPort: {},
  receiveModeChanged: { rtk: false, ppp: false, sbas: false },
};

function cloneData(value: PositionPageData): PositionPageData {
  return JSON.parse(JSON.stringify(value)) as PositionPageData;
}

/** `positionConfig.js` plus the RTK/PPP/SBAS orchestration in `positioningConfig`. */
export class PositionConfigPage extends BaseConfigPage {
  private readonly pages = new Map<TabId, PositionPageData>();
  private readonly baselinePages = new Map<TabId, PositionPageData>();
  private readonly confirmed = new Set<TabId>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'positionConfig',
      fragmentPath: './../positionConfig/positionConfig.html',
      containerId: (tab) => `config-pos-${tab}`,
    });
  }

  protected override loaderDuration(): number {
    return 10000;
  }

  protected override responseDelay(): number {
    return 4000;
  }

  page(tab: TabId): PositionPageData {
    let value = this.pages.get(tab);
    if (!value) {
      value = cloneData(PAGE_DEFAULT);
      this.pages.set(tab, value);
    }
    return value;
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    super.updateData(msgId, data);
    const tab = String(data.tab ?? '');
    if (!tab) return;
    if (msgId === POSITION_MSG.BESTPOS) {
      const value = this.page(tab);
      const mode = String(data.operatingMode ?? data.mode ?? 'Standalone');
      if (mode === 'Transmit' || mode === 'Receive' || mode === 'Standalone') {
        value.operatingMode = mode;
        value.selectedMode = mode;
      }
    }
  }

  protected render(tab: TabId): void {
    const value = this.page(tab);
    setActive(this.context, tab, '#posconfig-mainlist', value.selectedMode);
    setValue(this.context, tab, '#survey-time', value.surveyTime);
    setValue(this.context, tab, '#accuracy', value.accuracy);
    setValue(this.context, tab, '#latitude', value.latitude);
    setValue(this.context, tab, '#longitude', value.longitude);
    setValue(this.context, tab, '#height', value.height);
  }

  protected override namespace(tab: TabId, container: Element): void {
    namespaceCollapsePanels(container, tab);
    if (tab !== 'webui') {
      for (const button of [...container.querySelectorAll('.select-device-btn')]) {
        if (button.id) button.id = `${button.id}-${tab}`;
      }
    }
  }

  reset(tab: TabId): void {
    const operatingMode = this.page(tab).operatingMode;
    const fresh = cloneData(PAGE_DEFAULT);
    fresh.operatingMode = operatingMode;
    fresh.selectedMode = operatingMode;
    this.pages.set(tab, fresh);
    this.baselinePages.set(tab, cloneData(fresh));
    this.state.updateCurrent(tab, 'page', cloneData(fresh));
    super.reset(tab);
  }

  setMode(tab: TabId, mode: OperatingMode): void {
    this.page(tab).selectedMode = mode;
    this.state.setPending(tab, 'mode', 'selectedMode', mode, this.page(tab).operatingMode);
  }

  setSurvey(
    tab: TabId,
    values: Partial<
      Pick<
        PositionPageData,
        | 'surveyType'
        | 'surveyTime'
        | 'accuracy'
        | 'latitude'
        | 'longitude'
        | 'height'
        | 'inputFormat'
        | 'correctionType'
        | 'msmCorrectionType'
        | 'selectedPorts'
      >
    >,
  ): void {
    Object.assign(this.page(tab), values);
    const baseline = this.baselinePages.get(tab) ?? cloneData(PAGE_DEFAULT);
    for (const [key, value] of Object.entries(values)) {
      this.state.setPending(tab, key, key, value, (baseline as unknown as Record<string, unknown>)[key]);
    }
  }

  /** R32: a Transmit↔Receive change is confirmed before anything is sent. */
  onApplyButtonClick(tab: TabId): boolean {
    const page = this.page(tab);
    const crossing =
      (page.selectedMode === 'Transmit' && page.operatingMode === 'Receive') ||
      (page.selectedMode === 'Receive' && page.operatingMode === 'Transmit');
    if (crossing && !this.confirmed.has(tab)) {
      this.context.createDialog(
        {
          title: this.context.translate('CONFIRMATION'),
          titledataLangAttr: 'data-lang-confirmation',
          content: this.context.translate('CHANGE_OPMODE_CONFIRM'),
          buttons: [
            {
              text: this.context.translate('YES'),
              dataLang: 'data-lang-yes',
              callback: () => {
                this.confirmed.add(tab);
                this.context.closeDialog(tab);
                this.apply(tab);
                this.confirmed.delete(tab);
              },
            },
            {
              text: this.context.translate('NO'),
              dataLang: 'data-lang-no',
              class: 'darkBtn',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
      return false;
    }
    this.apply(tab);
    return true;
  }

  protected validateApply(tab: TabId): boolean {
    clearErrors(this.context, tab);
    const value = this.page(tab);
    if (value.selectedMode !== 'Standalone' && value.surveyType === 'survey-auto') {
      const min =
        this.context.features(tab).generation === 'OEM7' || this.context.features(tab).generation === 'SMART2'
          ? 1
          : this.context.features(tab).generation === 'OEM6'
            ? 10
            : 0.6;
      if (
        !Number.isFinite(value.surveyTime) ||
        value.surveyTime < min ||
        value.surveyTime > 6000 ||
        !Number.isFinite(value.accuracy) ||
        value.accuracy < 0 ||
        value.accuracy > 100
      ) {
        addError(this.context, tab, '#survey-time');
        return false;
      }
    }
    if (value.surveyType === 'survey-manual') {
      if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) {
        addError(this.context, tab, '#latitude');
        return false;
      }
      if (!Number.isFinite(value.longitude) || value.longitude < -360 || value.longitude > 360) {
        addError(this.context, tab, '#longitude');
        return false;
      }
      if (!Number.isFinite(value.height) || value.height < -1000 || value.height > 20_000_000) {
        addError(this.context, tab, '#height');
        return false;
      }
    }
    return true;
  }

  protected runApply(tab: TabId): CommandResponse | undefined {
    const page = this.page(tab);
    if (page.selectedMode === 'Standalone') this.sendStandalone(tab, page);
    else if (page.selectedMode === 'Transmit') this.sendTransmit(tab, page);
    else this.sendReceive(tab, page);
    return undefined;
  }

  private sendStandalone(tab: TabId, page: PositionPageData): void {
    if (this.context.features(tab).generation !== 'OEMSTAR') {
      this.commands.place(
        this.name,
        'autosurvey',
        this.autoSurveyParams({ state: 'DISABLE' }),
        tab,
      );
    }
    this.commands.place(this.name, 'posave', this.posaveParams({ state: 'DISABLE' }), tab);
    this.commands.place(
      this.name,
      'fixposition',
      [
        { state: ['NONE', 'enum', 4] },
        { param1: [0, 'double', 8] },
        { param2: [0, 'double', 8] },
        { param3: [0, 'double', 8] },
      ],
      tab,
    );
    if (this.context.features(tab).generation !== 'OEMSTAR' || this.context.features(tab).spanSupported) {
      this.commands.place(
        this.name,
        'sbascontrol',
        [
          { switch: ['DISABLE', 'enum', 4] },
          { system: ['NONE', 'enum', 4] },
          { prn: [0, 'ulong', 4] },
          { testmode: ['NONE', 'enum', 4] },
        ],
        tab,
      );
    }
    if (this.context.features(tab).terrastarSupported) {
      this.commands.place(
        this.name,
        'assignlbandbeam',
        [
          { option: ['IDLE', 'enum', 4] },
          { name: ['        ', 'string'] },
          { freq: [0, 'ulong', 4] },
          { baudrate: [0, 'ulong', 4] },
          { dop: [0, 'ulong', 4] },
        ],
        tab,
      );
    }
    void page;
  }

  private sendTransmit(tab: TabId, page: PositionPageData): void {
    if (page.surveyType === 'survey-auto') {
      if (this.context.features(tab).generation === 'OEMSTAR') {
        this.commands.place(this.name, 'posave', this.posaveParams({ state: 'ENABLE', maxtime: page.surveyTime / 60, maxhstddev: page.accuracy }), tab);
      } else {
        this.commands.place(
          this.name,
          'autosurvey',
          this.autoSurveyParams({
            state: 'ENABLE',
            maxtime: page.surveyTime,
            maxaccuracy: page.accuracy,
            maxtolarence: 4,
          }),
          tab,
        );
      }
    } else if (page.surveyType === 'survey-manual') {
      if (this.context.features(tab).generation !== 'OEMSTAR') {
        this.commands.place(this.name, 'autosurvey', this.autoSurveyParams({ state: 'DISABLE' }), tab);
      } else {
        this.commands.place(this.name, 'posave', this.posaveParams({ state: 'DISABLE' }), tab);
      }
      const height =
        this.context.localSettings?.heightUnit?.(tab) === 'Ellipsoidal'
          ? page.height
          : page.height;
      this.commands.place(
        this.name,
        'fixposition',
        [
          { state: ['POSITION', 'enum', 4] },
          { param1: [page.latitude, 'double', 8] },
          { param2: [page.longitude, 'double', 8] },
          { param3: [height, 'double', 8] },
        ],
        tab,
      );
    }

    const interfaceType =
      page.correctionType === 'RTCMV3-MSM' ? 'RTCMV3' : page.correctionType;
    const logType =
      page.correctionType === 'RTCMV3-MSM' ? page.msmCorrectionType : page.correctionType;
    for (const port of page.selectedPorts) {
      if (port.startsWith('COM')) {
        const serial = page.serialByPort[port] ?? { baud: 9600, parity: 'N', databits: 8, stopbits: 1 };
        this.commands.place(
          this.name,
          'serialconfig',
          [
            { port: [port, 'enum', 4] },
            { baud: [serial.baud, 'ulong', 4] },
            { parity: [serial.parity, 'enum', 4] },
            { databits: [serial.databits, 'ulong', 4] },
            { stopbits: [serial.stopbits, 'ulong', 4] },
            { handshake: ['N', 'enum', 4] },
            { break: ['ON', 'enum', 4] },
          ],
          tab,
        );
      }
      if (port.startsWith('ICOM')) {
        this.commands.place(
          this.name,
          'icomport',
          [
            { port: [port, 'enum', 4] },
            { protocol: ['TCP', 'enum', 4] },
            { endpoint: ['', 'string'] },
            { bindinterface: ['ALL', 'enum', 4] },
          ],
          tab,
        );
      }
      this.commands.place(
        this.name,
        'interfacemode',
        [
          { port: [port, 'enum', 4] },
          { rxtype: ['NOVATEL', 'enum', 4] },
          { txtype: [interfaceType, 'enum', 4] },
          { responses: ['ON', 'enum', 4] },
        ],
        tab,
      );
      if (port === 'FILE') this.sendFileOperation(tab, 'CLOSE');
      this.sendUnlogCorrections(tab, port, page.correctionType);
      if (port === 'FILE') this.sendFileOperation(tab, 'OPEN');
      this.sendLogCorrections(tab, port, logType);
    }
  }

  private sendFileOperation(tab: TabId, operation: 'OPEN' | 'CLOSE'): void {
    const oem7 = this.context.features(tab).generation === 'OEM7';
    this.commands.place(
      this.name,
      oem7 ? 'fileconfig' : 'logfile',
      oem7
        ? [{ fileOperation: [operation, 'enum', 4] }]
        : [
            { fileOperation: [operation, 'enum', 4] },
            { fileName: ['', 'char', 128] },
          ],
      tab,
    );
  }

  private sendReceive(tab: TabId, page: PositionPageData): void {
    if (page.operatingMode === 'Transmit') this.sendStandalone(tab, page);
    if (page.receiveModeChanged.rtk) {
      for (const port of page.selectedPorts) {
        this.commands.place(
          this.name,
          'interfacemode',
          [
            { port: [port, 'enum', 4] },
            { rxtype: [page.inputFormat, 'enum', 4] },
            { txtype: ['NOVATEL', 'enum', 4] },
            { responses: ['ON', 'enum', 4] },
          ],
          tab,
        );
      }
    }
    if (page.receiveModeChanged.sbas) {
      this.commands.place(
        this.name,
        'sbascontrol',
        [
          { switch: ['ENABLE', 'enum', 4] },
          { system: [(page.inputFormat || 'AUTO').toUpperCase(), 'enum', 4] },
          { prn: [0, 'ulong', 4] },
          { testmode: ['NONE', 'enum', 4] },
        ],
        tab,
      );
    }
    if (page.receiveModeChanged.ppp && this.context.features(tab).terrastarSupported) {
      this.commands.place(
        this.name,
        'assignlbandbeam',
        [
          { option: ['AUTO', 'enum', 4] },
          { name: ['        ', 'string'] },
          { freq: [0, 'ulong', 4] },
          { baudrate: [0, 'ulong', 4] },
          { dop: [6000, 'ulong', 4] },
        ],
        tab,
      );
    }
  }

  private sendUnlogCorrections(tab: TabId, port: string, type: string): void {
    const key = type === 'RTCMV3-MSM' ? this.page(tab).msmCorrectionType : type;
    for (const messageID of CORRECTION_LOG_IDS[key] ?? []) {
      this.commands.place(
        this.name,
        'unlog',
        [
          { port: [port, 'enum', 4] },
          { messageID: [messageID, 'ushort', 2] },
          { messageType: [0, 'char', 1] },
          { reserved: [0, 'char', 1] },
        ],
        tab,
      );
    }
  }

  private sendLogCorrections(tab: TabId, port: string, type: string): void {
    for (const messageID of CORRECTION_LOG_IDS[type] ?? []) {
      this.commands.place(
        this.name,
        'log',
        [
          { port: [port, 'enum', 4] },
          { messageID: [messageID, 'ushort', 2] },
          { messageType: [0, 'char', 1] },
          { reserved: [0, 'char', 1] },
          { trigger: ['ONTIME', 'enum', 4] },
          { period: [CORRECTION_PERIODS[messageID] ?? 1, 'double', 8] },
          { offset: [0, 'double', 8] },
          { hold: ['HOLD', 'enum', 4] },
        ],
        tab,
      );
    }
  }

  private autoSurveyParams(data: Record<string, unknown>): ConfigDataMap {
    return [
      { state: [data.state ?? 'DISABLE', 'enum', 4] },
      { maxtime: [data.maxtime ?? 1440, 'ulong', 4] },
      { maxaccuracy: [data.maxaccuracy ?? 2, 'float', 4] },
      { maxtolarence: [data.maxtolarence ?? 10, 'float', 4] },
      { savePos: [data.savePos ?? 0, 'float', 4] },
      { auto: [data.auto ?? 'AUTO', 'string'] },
    ];
  }

  private posaveParams(data: Record<string, unknown>): ConfigDataMap {
    return [
      { state: [data.state ?? 'DISABLE', 'enum', 4] },
      { maxtime: [data.maxtime ?? 0.1, 'float', 4] },
      { maxhstd: [data.maxhstddev ?? 0, 'float', 4] },
      { maxvstd: [data.maxvstddev ?? 0, 'float', 4] },
    ];
  }

  handlePositionConfigCommandResponse(data: 1 | 2, tab: TabId): void {
    this.handleCommandResponse(data, tab);
  }

  resetPositionConfigUI(tab: TabId): void {
    this.reset(tab);
  }

  dh_createDefaultData(tab: TabId): void {
    this.baselinePages.set(tab, cloneData(this.page(tab)));
    this.state.updateCurrent(tab, 'page', cloneData(this.page(tab)));
    this.state.snapshot(tab);
  }

  v_loadDefaultData(tab: TabId): void {
    this.render(tab);
  }

  correctionLogIds(type: string): number[] {
    return [...(CORRECTION_LOG_IDS[type] ?? [])];
  }

  override commit(tab: TabId): void {
    const page = this.page(tab);
    page.operatingMode = page.selectedMode;
    this.baselinePages.set(tab, cloneData(page));
    this.state.updateCurrent(tab, 'page', cloneData(page));
    super.commit(tab);
  }

  override handleCommandResponse(
    response: CommandResponse,
    tab: TabId,
    msgId?: number,
    error?: string,
  ): void {
    super.handleCommandResponse(response, tab, msgId, error);
  }
}
