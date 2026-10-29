import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  addError,
  clearErrors,
  namespaceCollapsePanels,
} from './base.ts';

export const RADIO_MSG = {
  VERSION: 37,
  SATEL_DETECT: 2204,
  SATEL_STATUS: 2205,
  SATEL4_CONFIG: 2215,
  SATEL9_INFO: 2220,
  SATEL9_CONFIG_N: 2219,
  SATEL9_CONFIG_L: 2218,
  SATEL_STARTUP_DETECT: 2221,
} as const;

export interface RadioDetectionState {
  currentSatelDetectIndex: number;
  radioDetectionStarted: boolean;
  satelStatusCheck?: number;
  satelStatusDefectCheck?: number;
  satel4Sent: boolean;
  satel9Sent: boolean;
  status: string;
}

/** `radioConfig.js:1-1060`. */
export class RadioConfigPage extends BaseConfigPage {
  readonly satelPorts = ['COM2', 'COM3', 'COM1'] as const;
  readonly detection = new Map<TabId, RadioDetectionState>();
  readonly radioCommandsSent = new Map<TabId, boolean>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'radioConfig',
      fragmentPath: './../radioConfig/radioConfig.html',
      containerId: (tab) => `config-radio-${tab}`,
    });
  }

  protected override loaderDuration(_tab: TabId): number {
    return 9000;
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    super.updateData(msgId, data);
    const tab = String(data.tab ?? '');
    if (!tab || msgId !== RADIO_MSG.SATEL_STATUS) return;
    this.detectionState(tab).status = String(data.state ?? data.status ?? '');
  }

  detectionState(tab: TabId): RadioDetectionState {
    let value = this.detection.get(tab);
    if (!value) {
      value = {
        currentSatelDetectIndex: 0,
        radioDetectionStarted: false,
        satel4Sent: false,
        satel9Sent: false,
        status: '',
      };
      this.detection.set(tab, value);
    }
    return value;
  }

  detectRadio(tab: TabId): void {
    const state = this.detectionState(tab);
    this.clearDetectionTimers(tab);
    state.currentSatelDetectIndex = 0;
    state.radioDetectionStarted = true;
    this.sendDetect(tab, this.satelPorts[0]);
    state.satelStatusCheck = this.context.clock.setInterval(() => this.pollReady(tab), 1000);
    state.satelStatusDefectCheck = this.context.clock.setInterval(() => this.pollNotReady(tab), 20000);
    this.context.clock.setTimeout(() => this.radioCommandsSent.set(tab, true), 1000);
  }

  private pollReady(tab: TabId): void {
    const state = this.detectionState(tab);
    if (!state.radioDetectionStarted || state.status !== 'READY') return;
    const port = this.satelPorts[state.currentSatelDetectIndex];
    const radio = this.radioType(tab);
    if (radio === 'EASy' || radio === 'EASy-35W') {
      this.context.sendRaw?.(tab, 'log thisport_30 satel4configb ontime 1\n');
    }
    if (radio === 'M3-TR9' || radio === 'Proof-TR9') {
      this.context.sendRaw?.(tab, 'log thisport_30 satel9info ontime 1\n');
    }
    state.radioDetectionStarted = false;
    this.clearDetectionTimers(tab);
    this.commands.place(
      this.name,
      'satelstartupdetect',
      [
        { switch: ['ENABLE', 'enum', 4] },
        { port: [port, 'enum', 4] },
      ],
      tab,
    );
    this.context.setRadioPort?.(tab, port);
    this.context.clock.setTimeout(() => this.resetRadioConfigUI(tab), 5000);
  }

  private pollNotReady(tab: TabId): void {
    const state = this.detectionState(tab);
    if (!state.radioDetectionStarted || state.status === 'READY') return;
    if (state.currentSatelDetectIndex < 2) {
      state.currentSatelDetectIndex += 1;
      this.sendDetect(tab, this.satelPorts[state.currentSatelDetectIndex]);
    } else {
      state.radioDetectionStarted = false;
      this.clearDetectionTimers(tab);
    }
  }

  private sendDetect(tab: TabId, port: string): void {
    this.commands.place(this.name, 'sateldetect', [{ port: [port, 'enum', 4] }], tab);
  }

  private clearDetectionTimers(tab: TabId): void {
    const state = this.detectionState(tab);
    if (state.satelStatusCheck !== undefined) this.context.clock.clearInterval(state.satelStatusCheck);
    if (state.satelStatusDefectCheck !== undefined) {
      this.context.clock.clearInterval(state.satelStatusDefectCheck);
    }
    state.satelStatusCheck = undefined;
    state.satelStatusDefectCheck = undefined;
  }

  radioType(tab: TabId): string {
    const version = this.state.current(tab)[String(RADIO_MSG.VERSION)];
    if (version && typeof version === 'object') {
      const rows = Object.values(version as Record<string, unknown>);
      for (const row of rows) {
        if (row && typeof row === 'object' && (row as Record<string, unknown>).type === 'RADIO') {
          return String((row as Record<string, unknown>).model ?? 'NONE');
        }
      }
    }
    return this.context.features(tab).model.includes('SATEL') ? 'SATEL' : 'NONE';
  }

  setSatel4(tab: TabId, values: { frequencyMHz?: number; compatibilityMode?: number; txPower?: number }): void {
    const current = this.state.current(tab)[String(RADIO_MSG.SATEL4_CONFIG)];
    const baseline =
      current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(values)) {
      this.state.setPending(tab, RADIO_MSG.SATEL4_CONFIG, key, value, baseline[key]);
    }
  }

  setSatel9(
    tab: TabId,
    values: { protocol?: string; channel?: number; txPower?: number },
  ): void {
    const current = this.state.current(tab)[String(RADIO_MSG.SATEL9_INFO)];
    const baseline =
      current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(values)) {
      this.state.setPending(tab, RADIO_MSG.SATEL9_INFO, key, value, baseline[key]);
    }
  }

  protected validateApply(tab: TabId): boolean {
    clearErrors(this.context, tab);
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const satel4 = pending[String(RADIO_MSG.SATEL4_CONFIG)];
    if (satel4) {
      const frequency = Number(satel4.frequencyMHz ?? satel4.frequency);
      if (!Number.isFinite(frequency) || frequency < 403 || frequency > 473) {
        addError(this.context, tab, '#transmit-freq-400');
        return false;
      }
    }
    const satel9 = pending[String(RADIO_MSG.SATEL9_INFO)];
    if (satel9) {
      const channel = Number(satel9.channel);
      const protocol = String(satel9.protocol ?? '');
      const max = protocol === 'Freewave Leica' ? 9 : protocol === 'Freewave Novariant' ? 3824 : Number.NaN;
      if (!Number.isFinite(channel) || channel < 1 || channel > max) {
        addError(this.context, tab, '#satel-channel-900');
        return false;
      }
    }
    return true;
  }

  protected runApply(tab: TabId): undefined {
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const satel4 = pending[String(RADIO_MSG.SATEL4_CONFIG)];
    if (satel4) {
      const current = (this.state.current(tab)[String(RADIO_MSG.SATEL4_CONFIG)] as Record<string, unknown> | undefined) ?? {};
      const compatibility = Number(satel4.compatibilityMode ?? current.compatibilityMode ?? 0);
      const baseType = [7, 8, 17, 18].includes(compatibility) ? 'TRIMBLE' : 'NONE';
      this.detectionState(tab).satel4Sent = true;
      this.commands.place(
        this.name,
        'satel4config',
        [
          { radioBehavior: ['TX', 'enum', 4] },
          { txPower: [satel4.txPower ?? current.txPower ?? 0, 'ulong', 4] },
          {
            frequency: [
              Number(satel4.frequencyMHz ?? current.frequency ?? 0) * 1_000_000,
              'ulong',
              4,
            ],
          },
          { compatibilityMode: [compatibility, 'ulong', 4] },
          { baseType: [baseType, 'enum', 4] },
        ],
        tab,
      );
    }
    const satel9 = pending[String(RADIO_MSG.SATEL9_INFO)];
    if (satel9) {
      const current = (this.state.current(tab)[String(RADIO_MSG.SATEL9_INFO)] as Record<string, unknown> | undefined) ?? {};
      const protocol = String(satel9.protocol ?? current.protocol ?? 'Freewave Novariant');
      const modemmode =
        current.modemMode === 3
          ? 'P2MP_SLAVE'
          : current.modemMode === 8
            ? 'P2MP_RX_SLAVE'
            : 'P2MP_MASTER';
      this.detectionState(tab).satel9Sent = true;
      this.commands.place(
        this.name,
        protocol === 'Freewave Leica' ? 'satel9configl' : 'satel9confign',
        [
          { modemmode: [modemmode, 'enum', 4] },
          { channel: [satel9.channel ?? current.channel ?? 1, 'ulong', 4] },
          { retrytimeout: [current.retryTimeOut ?? 0, 'ulong', 4] },
          { subnet: [current.subnet ?? 0, 'ulong', 4] },
          { repeaters: [current.repeaters === 1 ? 'TRUE' : 'FALSE', 'enum', 4] },
          { masterpacketrepeat: [current.masterPacketRepeat ?? 0, 'ulong', 4] },
          { txpwr: [satel9.txPower ?? current.txPower ?? 0, 'ulong', 4] },
        ],
        tab,
      );
    }
    return undefined;
  }

  handleRadioConfigCommandResponse(data: 1 | 2, tab: TabId): void {
    this.handleCommandResponse(data, tab);
  }

  resetRadioConfigUI(tab: TabId): void {
    this.reset(tab);
  }

  stopDetection(tab: TabId): void {
    const state = this.detectionState(tab);
    state.radioDetectionStarted = false;
    this.clearDetectionTimers(tab);
  }

  protected render(_tab: TabId): void {}

  protected override namespace(tab: TabId, container: Element): void {
    namespaceCollapsePanels(container, tab);
    if (tab !== 'webui') {
      for (const button of [...container.querySelectorAll('.nextButtonCompatibility')]) {
        button.setAttribute('href', `#collapseradioPF-${tab}`);
      }
    }
  }
}
