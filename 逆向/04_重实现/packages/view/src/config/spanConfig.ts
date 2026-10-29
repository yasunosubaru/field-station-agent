import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  namespaceCollapsePanels,
  namespaceRadioInputs,
  namespaceToggleSwitch,
} from './base.ts';

export const SPAN_MSG = {
  CONNECTIMU: 1428,
  INSCOMMAND: 379,
  SETINSROTATION: 1921,
  SETINSTRANSLATION: 1920,
  SETIMUTOANT: 383,
  SETIMUTOANT2: 1205,
  SETINSOFFSET: 676,
  SETIMUORIENTATION: 567,
  APPLYVBR: 1071,
  VEHICLEBODYROTATION: 642,
} as const;

interface SpanPageData {
  imuType: string;
  imuPort: string;
  insPosition: 'ant1' | 'ant2' | 'custom' | 'imu';
  inputFrame: 'IMUBODY' | 'VEHICLE';
  hardwareVersion: string;
  dualAntenna: boolean;
}

/** `spanConfig.js:2865-3368`, with the R36 IMU event order and R37 translation fan. */
export class SpanConfigPage extends BaseConfigPage {
  private readonly pages = new Map<TabId, SpanPageData>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'spanConfig',
      fragmentPath: './../spanConfig/spanConfig.html',
      containerId: (tab) => `config-span-${tab}`,
    });
  }

  protected override loaderDuration(_tab: TabId): number {
    return 7000;
  }

  protected override responseDelay(): number {
    return 2500;
  }

  page(tab: TabId): SpanPageData {
    let value = this.pages.get(tab);
    if (!value) {
      value = {
        imuType: 'UNKNOWN',
        imuPort: 'SPI',
        insPosition: 'ant1',
        inputFrame: 'VEHICLE',
        hardwareVersion: this.context.features(tab).model,
        dualAntenna: this.context.features(tab).dualAntennaSupported,
      };
      this.pages.set(tab, value);
    }
    return value;
  }

  setPage(tab: TabId, values: Partial<SpanPageData>): void {
    Object.assign(this.page(tab), values);
  }

  setConnectImu(tab: TabId, values: { IMUPort?: string; IMUType?: string }): void {
    const current =
      this.state.current(tab)[String(SPAN_MSG.CONNECTIMU)] && typeof this.state.current(tab)[String(SPAN_MSG.CONNECTIMU)] === 'object'
        ? (this.state.current(tab)[String(SPAN_MSG.CONNECTIMU)] as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(values)) {
      this.state.setPending(tab, SPAN_MSG.CONNECTIMU, key, value, current[key]);
    }
  }

  setField(tab: TabId, msgId: number, key: string, value: unknown, nested?: string): void {
    const current = this.state.current(tab)[String(msgId)];
    let baseline: unknown;
    if (nested) {
      baseline =
        current && typeof current === 'object'
          ? ((current as Record<string, Record<string, unknown>>)[nested]?.[key] as unknown)
          : undefined;
      const pending = this.state.pending(tab);
      const msgBucket =
        pending[String(msgId)] && typeof pending[String(msgId)] === 'object'
          ? (pending[String(msgId)] as Record<string, unknown>)
          : {};
      const nestedBucket =
        msgBucket[nested] && typeof msgBucket[nested] === 'object'
          ? (msgBucket[nested] as Record<string, unknown>)
          : {};
      if (JSON.stringify(value) === JSON.stringify(baseline)) delete nestedBucket[key];
      else nestedBucket[key] = value;
      if (Object.keys(nestedBucket).length) msgBucket[nested] = nestedBucket;
      else delete msgBucket[nested];
      this.state.setPendingBucket(tab, msgId, msgBucket);
      return;
    }
    baseline =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined;
    this.state.setPending(tab, msgId, key, value, baseline);
  }

  protected runApply(tab: TabId): undefined {
    const pending = this.state.pending(tab) as Record<string, unknown>;
    const connect = pending[String(SPAN_MSG.CONNECTIMU)] as Record<string, unknown> | undefined;
    if (connect) {
      let type = String(connect.IMUType ?? this.page(tab).imuType);
      const hardware = this.page(tab).hardwareVersion;
      if (type === '(7500 EVK) Epson G320' && (hardware.startsWith('OEM7500') || hardware.startsWith('PIM7500'))) {
        type = 'EPSON_G320';
        this.commands.place(this.name, 'setimuevent', this.imuEvent('IN', 'EVENT1'), tab);
      } else if (type === '(7500 EVK) Bosch SMI130') {
        type = 'BOSCH_SMI130';
        this.commands.place(this.name, 'setimuevent', this.imuEvent('IN', 'EVENT2'), tab);
        this.commands.place(this.name, 'setimuevent', this.imuEvent('IN2', 'EVENT1'), tab);
        this.context.sendRaw?.(tab, 'SPICONTROL IMU CS2\n');
        this.context.sendRaw?.(tab, 'SPICONTROL IMU2 CS1\n');
      } else if (type === '(7500 EVK) Invensense IAM-20680') {
        type = 'INVENSENSE_IAM20680';
        this.commands.place(this.name, 'setimuevent', this.imuEvent('IN', 'EVENT1'), tab);
      }
      this.commands.place(
        this.name,
        'connectimu',
        [
          { IMUPort: [connect.IMUPort ?? this.page(tab).imuPort, 'enum', 4] },
          { IMUType: [type, 'enum', 4] },
        ],
        tab,
      );
      this.commands.place(this.name, 'inscommand', [{ switch: ['ENABLE', 'enum', 4] }], tab);
    }

    const rotations = pending[String(SPAN_MSG.SETINSROTATION)] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (rotations) {
      for (const value of Object.values(rotations)) {
        const params: ConfigDataMap = [
          { rotationalOffset: ['RBV', 'enum', 4] },
          { xRotation: [value.xRotation ?? 0, 'float', 4] },
          { yRotation: [value.yRotation ?? 0, 'float', 4] },
          { zRotation: [value.zRotation ?? 0, 'float', 4] },
          { xRotationSD: [value.xRotationSD ?? 3, 'float', 4] },
          { yRotationSD: [value.yRotationSD ?? 3, 'float', 4] },
          { zRotationSD: [value.zRotationSD ?? 3, 'float', 4] },
          { reserved: [0, 'float', 4] },
        ];
        this.commands.place(this.name, 'setinsrotation', params, tab);
      }
    }

    const generation = this.context.features(tab).generation;
    const page = this.page(tab);
    if (generation === 'OEM7') {
      this.sendInsTranslation(tab, 'ANT1', 'ANT1');
      if (page.dualAntenna) this.sendInsTranslation(tab, 'ANT2', 'ANT2');
      if (page.insPosition === 'ant1') this.sendInsTranslation(tab, 'USER', 'ANT1');
      else if (page.insPosition === 'ant2') this.sendInsTranslation(tab, 'USER', 'ANT2');
      else if (page.insPosition === 'custom') this.sendInsTranslation(tab, 'USER', 'USER');
      else if (page.insPosition === 'imu') this.sendInsTranslation(tab, 'USER', 'USER', true);
    } else if (generation === 'OEM6') {
      this.sendImuToAnt(tab, 'ANT1', 'ANT1');
      if (page.dualAntenna) this.sendImuToAnt(tab, 'ANT2', 'ANT2');
      if (page.insPosition === 'ant1') this.sendImuToAnt(tab, 'USER', 'ANT1');
      else if (page.insPosition === 'ant2') this.sendImuToAnt(tab, 'USER', 'ANT2');
      else if (page.insPosition === 'custom') this.sendImuToAnt(tab, 'USER', 'USER');
      else if (page.insPosition === 'imu') this.sendImuToAnt(tab, 'USER', 'USER', true);
    }
    const orientation = pending[String(SPAN_MSG.SETIMUORIENTATION)] as Record<string, unknown> | undefined;
    if (orientation) {
      this.commands.place(
        this.name,
        'setimuorientation',
        [{ switch: [orientation.switch ?? orientation.orientation ?? 1, 'enum', 4] }],
        tab,
      );
    }
    const vbr = pending[String(SPAN_MSG.APPLYVBR)] as Record<string, unknown> | undefined;
    if (vbr) {
      this.commands.place(
        this.name,
        'applyVBR',
        [{ Switch: [vbr.Switch ?? vbr.switch ?? 'DISABLE', 'enum', 4] }],
        tab,
      );
    }
    return undefined;
  }

  private imuEvent(direction: string, event: string): ConfigDataMap {
    return [
      { direction: [direction, 'enum', 4] },
      { event: [event, 'enum', 4] },
    ];
  }

  private sendInsTranslation(
    tab: TabId,
    translation: 'ANT1' | 'ANT2' | 'USER',
    field: 'ANT1' | 'ANT2' | 'USER',
    reset = false,
  ): void {
    const current = this.state.current(tab)[String(SPAN_MSG.SETINSTRANSLATION)];
    const stored =
      current && typeof current === 'object'
        ? (current as Record<string, Record<string, unknown>>)[field] ?? {}
        : {};
    const x = reset ? 0 : Number(stored.xTranslation ?? 0);
    const y = reset ? 0 : Number(stored.yTranslation ?? 0);
    const z = reset ? 0 : Number(stored.zTranslation ?? 0);
    const params: ConfigDataMap = [
      { insTranslation: [translation, 'enum', 4] },
      { xTranslation: [x, 'float', 4] },
      { yTranslation: [y, 'float', 4] },
      { zTranslation: [z, 'float', 4] },
      {
        xTranslationSD: [
          reset ? 0 : stored.xTranslationSD ?? (x > 0 ? x / 10 : 0),
          'float',
          4,
        ],
      },
      {
        yTranslationSD: [
          reset ? 0 : stored.yTranslationSD ?? (y > 0 ? y / 10 : 0),
          'float',
          4,
        ],
      },
      {
        zTranslationSD: [
          reset ? 0 : stored.zTranslationSD ?? (z > 0 ? z / 10 : 0),
          'float',
          4,
        ],
      },
      { inputFrame: [this.page(tab).inputFrame, 'enum', 4] },
    ];
    this.commands.place(this.name, 'setinstranslation', params, tab);
  }

  private sendImuToAnt(
    tab: TabId,
    translation: 'ANT1' | 'ANT2' | 'USER',
    field: 'ANT1' | 'ANT2' | 'USER',
    reset = false,
  ): void {
    const current = this.state.current(tab)[String(SPAN_MSG.SETIMUTOANT)];
    const stored =
      current && typeof current === 'object'
        ? (current as Record<string, Record<string, unknown>>)[field] ?? {}
        : {};
    const x = reset ? 0 : Number(stored.xOffset ?? 0);
    const y = reset ? 0 : Number(stored.yOffset ?? 0);
    const z = reset ? 0 : Number(stored.zOffset ?? 0);
    const sd = (value: number) => (value > 0.1 ? value / 10 : 0.01);
    const params: ConfigDataMap =
      translation === 'USER'
        ? [
            { xOffset: [x, 'double', 8] },
            { yOffset: [y, 'double', 8] },
            { zOffset: [z, 'double', 8] },
          ]
        : [
            { xOffset: [x, 'double', 8] },
            { yOffset: [y, 'double', 8] },
            { zOffset: [z, 'double', 8] },
            { xOffsetSD: [reset ? 0 : stored.xOffsetSD ?? sd(x), 'double', 8] },
            { yOffsetSD: [reset ? 0 : stored.yOffsetSD ?? sd(y), 'double', 8] },
            { zOffsetSD: [reset ? 0 : stored.zOffsetSD ?? sd(z), 'double', 8] },
          ];
    this.commands.place(
      this.name,
      translation === 'ANT1' ? 'setimutoant' : translation === 'ANT2' ? 'setimutoant2' : 'setinsoffset',
      params,
      tab,
    );
  }

  handleSpanConfigCommandResponse(data: 1 | 2, tab: TabId): void {
    this.handleCommandResponse(data, tab);
  }

  resetSpanConfigUI(tab: TabId): void {
    this.reset(tab);
  }

  protected render(_tab: TabId): void {
    // The shipped wizard keeps its own accordion state. The numeric offsets and radio choice are
    // tracked in `state`/`page`; no text is invented when a field was never received.
  }

  protected override namespace(tab: TabId, container: Element): void {
    namespaceToggleSwitch(container, tab);
    namespaceCollapsePanels(container, tab);
    namespaceRadioInputs(container, tab);
    if (tab !== 'webui') {
      for (const button of [...container.querySelectorAll('.imutype-mode-btn')]) {
        button.setAttribute('href', `#collapseoffset-${tab}`);
      }
    }
  }
}
