import type { TabId } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage } from './base.ts';

export interface LonghornConfigData {
  LGHN_LOGGING: { loggingState: boolean; destFolder: string };
  RTK: { inputFormat: string; inputPort: string; enablePIMTPWrapper: boolean };
  PORTS: { com1: string; com2: string };
  BAUDRATES: {
    COM1: { baudrate: string };
    COM2: { baudrate: string };
  };
  CAN: { bitRate: string; DMIVal: string };
  VEHICLE_PARAMETERS: {
    steeringMethods: string;
    vehicleWheelBase: string;
    vehicleRearWheelTrack: string;
    vehicleFrontWheelTrack: string;
    vehicleSecondaryWheelBase: string;
    vehicleDMI: {
      vehicleDMIOffset_X: string;
      vehicleDMIOffset_Y: string;
      vehicleDMIOffset_Z: string;
      vehicleDMIOffset_Xdeviation: number;
      vehicleDMIOffset_Ydeviation: number;
      vehicleDMIOffset_Zdeviation: number;
    };
  };
  SPAN: {
    imu: {
      imuRotationalOffset_X: string;
      imuRotationalOffset_Y: string;
      imuRotationalOffset_Z: string;
      imuRotationalOffset_Xdeviation: number;
      imuRotationalOffset_Ydeviation: number;
      imuRotationalOffset_Zdeviation: number;
    };
    ant1: {
      primaryAntOffset_X: string;
      primaryAntOffset_Y: string;
      primaryAntOffset_Z: string;
      primaryAntOffset_Xdeviation: number;
      primaryAntOffset_Ydeviation: number;
      primaryAntOffset_Zdeviation: number;
    };
    ant2: {
      secondaryAntOffset_X: string;
      secondaryAntOffset_Y: string;
      secondaryAntOffset_Z: string;
      secondaryAntOffset_Xdeviation: number;
      secondaryAntOffset_Ydeviation: number;
      secondaryAntOffset_Zdeviation: number;
    };
    user: {
      userAntOffset_X: string;
      userAntOffset_Y: string;
      userAntOffset_Z: string;
      userAntOffset_Xdeviation: string;
      userAntOffset_Ydeviation: string;
      userAntOffset_Zdeviation: string;
    };
  };
}

export const LONGHORN_DEFAULT_CONFIG: LonghornConfigData = {
  LGHN_LOGGING: { loggingState: false, destFolder: '/Desktop' },
  RTK: { inputFormat: 'RTCMV3', inputPort: 'com2', enablePIMTPWrapper: false },
  PORTS: { com1: 'PIMTP', com2: 'NMEA' },
  BAUDRATES: {
    COM1: { baudrate: '460800' },
    COM2: { baudrate: '460800' },
  },
  CAN: { bitRate: '', DMIVal: 'Select' },
  VEHICLE_PARAMETERS: {
    steeringMethods: 'Select',
    vehicleWheelBase: '',
    vehicleRearWheelTrack: '',
    vehicleFrontWheelTrack: '',
    vehicleSecondaryWheelBase: '',
    vehicleDMI: {
      vehicleDMIOffset_X: '',
      vehicleDMIOffset_Y: '',
      vehicleDMIOffset_Z: '',
      vehicleDMIOffset_Xdeviation: 0.05,
      vehicleDMIOffset_Ydeviation: 0.05,
      vehicleDMIOffset_Zdeviation: 0.05,
    },
  },
  SPAN: {
    imu: {
      imuRotationalOffset_X: '',
      imuRotationalOffset_Y: '',
      imuRotationalOffset_Z: '',
      imuRotationalOffset_Xdeviation: 3,
      imuRotationalOffset_Ydeviation: 3,
      imuRotationalOffset_Zdeviation: 3,
    },
    ant1: {
      primaryAntOffset_X: '',
      primaryAntOffset_Y: '',
      primaryAntOffset_Z: '',
      primaryAntOffset_Xdeviation: 0.05,
      primaryAntOffset_Ydeviation: 0.05,
      primaryAntOffset_Zdeviation: 0.05,
    },
    ant2: {
      secondaryAntOffset_X: '',
      secondaryAntOffset_Y: '',
      secondaryAntOffset_Z: '',
      secondaryAntOffset_Xdeviation: 0.05,
      secondaryAntOffset_Ydeviation: 0.05,
      secondaryAntOffset_Zdeviation: 0.05,
    },
    user: {
      userAntOffset_X: '',
      userAntOffset_Y: '',
      userAntOffset_Z: '',
      userAntOffset_Xdeviation: '',
      userAntOffset_Ydeviation: '',
      userAntOffset_Zdeviation: '',
    },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `lghn-positionConfig .js:141-250`: parse the text config returned by
 * `controller.getconfigfilelonghorn`. The order is exact, including `INSRotation`'s leading field
 * that is not used and `INSTranslation`'s seven numeric fields.
 */
export function parseLonghornConfig(text: string): LonghornConfigData {
  const out = clone(LONGHORN_DEFAULT_CONFIG);
  const rtk: Record<string, string> = {};
  const six = (values: string[]) =>
    values.slice(1, 7).map((value) => String(parseFloat(value)));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('InterfaceMode:')) {
      const values = line.split(':')[1].split(',');
      if (values[0]) rtk[values[0]] = values[1] ?? '';
      if (values[0] === 'COM1') out.PORTS.com1 = values[2] ?? '';
      else if (values[0] === 'COM2') out.PORTS.com2 = values[2] ?? '';
    } else if (line.startsWith('BaudRate:')) {
      const values = line.split(':')[1].split(',');
      if (values[0] === 'COM1' || values[0] === 'COM2') {
        out.BAUDRATES[values[0]].baudrate = values[1] ?? '';
      }
    } else if (line.startsWith('CAN:')) {
      out.CAN.bitRate = line.split(',')[1] ?? '';
    } else if (line.startsWith('DMI:')) {
      out.CAN.DMIVal = (line.split(',')[1] ?? '').replace('DMI', '');
    } else if (line.startsWith('INSTranslation:')) {
      const values = line.split(':')[1].split(',');
      const translation = (values[0] ?? '').toUpperCase();
      const v = six(values);
      const target =
        translation === 'ANT1'
          ? out.SPAN.ant1
          : translation === 'ANT2'
            ? out.SPAN.ant2
            : translation === 'USER'
              ? out.SPAN.user
              : translation === 'DMI'
                ? out.VEHICLE_PARAMETERS.vehicleDMI
                : undefined;
      if (target) {
        const keys = Object.keys(target).filter((key) => key !== 'type');
        keys.forEach((key, index) => {
          (target as unknown as Record<string, unknown>)[key] = v[index] ?? '';
        });
      }
    } else if (line.startsWith('INSRotation:')) {
      const values = line.split(':')[1].split(',');
      const keys = Object.keys(out.SPAN.imu);
      six(values).forEach((value, index) => {
        (out.SPAN.imu as unknown as Record<string, unknown>)[keys[index]] = value;
      });
    } else if (line.startsWith('SetVehicleParameters:')) {
      const values = line.split(':')[1].split(',');
      out.VEHICLE_PARAMETERS.vehicleWheelBase = String(parseFloat(values[0] ?? ''));
      out.VEHICLE_PARAMETERS.vehicleRearWheelTrack = String(parseFloat(values[1] ?? ''));
      out.VEHICLE_PARAMETERS.vehicleFrontWheelTrack = String(parseFloat(values[2] ?? ''));
      out.VEHICLE_PARAMETERS.steeringMethods = values[3] ?? '';
      out.VEHICLE_PARAMETERS.vehicleSecondaryWheelBase = String(parseFloat(values[4] ?? ''));
    }
  }
  if (rtk.COM2 === 'PIMTP' || rtk.COM2 === 'RTCMV3') {
    out.RTK.inputFormat = rtk.COM2;
    out.RTK.inputPort = 'com2';
    out.RTK.enablePIMTPWrapper = rtk.COM2 === 'PIMTP';
  } else if (rtk.COM1 === 'PIMTP') {
    out.RTK.inputFormat = rtk.COM1;
    out.RTK.inputPort = 'com1';
    out.RTK.enablePIMTPWrapper = true;
  }
  return out;
}

export class LonghornPositionConfigPage extends BaseConfigPage {
  readonly configfiles = new Map<TabId, string>();
  private readonly pages = new Map<TabId, LonghornConfigData>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'lghnPositionConfig',
      fragmentPath: './../positionConfig/lghn-positionConfig.html',
      containerId: (tab) => `config-pos-${tab}`,
    });
  }

  setConfigFile(tab: TabId, text: string): void {
    this.configfiles.set(tab, text);
    this.pages.set(tab, parseLonghornConfig(text));
    this.state.updateCurrent(tab, 'config', this.pages.get(tab));
  }

  config(tab: TabId): LonghornConfigData {
    return clone(this.pages.get(tab) ?? LONGHORN_CONFIG_DEFAULT());
  }

  updateData(_msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (tab && typeof data.configText === 'string') this.setConfigFile(tab, data.configText);
  }

  setChanged(tab: TabId, path: string, value: unknown): void {
    const parts = path.split('.');
    const pending = this.state.pending(tab);
    let bucket = pending;
    for (const part of parts.slice(0, -1)) {
      const next =
        bucket[part] && typeof bucket[part] === 'object'
          ? (bucket[part] as Record<string, unknown>)
          : {};
      bucket[part] = next;
      bucket = next;
    }
    bucket[parts.at(-1)!] = value;
    this.state.setPendingBucket(tab, 'config', pending.config as Record<string, unknown> ?? pending);
  }

  protected runApply(tab: TabId): undefined {
    const pending = this.state.pending(tab).config as Record<string, unknown> | undefined;
    if (pending) this.context.longhorn?.applyConfiguration?.(tab, pending);
    return undefined;
  }

  resetLghnPositionConfigUI(tab: TabId): void {
    const text = this.configfiles.get(tab);
    if (text) this.pages.set(tab, parseLonghornConfig(text));
    const value = this.pages.get(tab);
    if (value) this.state.updateCurrent(tab, 'config', value);
    this.reset(tab);
  }

  handleConfigurationResponse(state: string, ackNack: number, tab: TabId): void {
    if (state === 'COMPLETE' && ackNack === 1) {
      this.context.closeApplyingScreen(tab, 1);
      this.context.clock.setTimeout(() => this.context.longhorn?.resetReceiver?.(tab), 10000);
    } else {
      this.context.closeApplyingScreen(tab, 2);
    }
  }

  handleCommandResponse(): void {
    // Longhorn config traffic does not use OEM Commanddata frames.
  }

  protected render(_tab: TabId): void {}
}

function LONGHORN_CONFIG_DEFAULT(): LonghornConfigData {
  return clone(LONGHORN_DEFAULT_CONFIG);
}

export class LonghornLoggingConfigPage extends LonghornPositionConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime);
  }

  override get name(): string {
    return 'lghnLoggingConfig';
  }

  override get fragmentPath(): string {
    return './../loggingConfig/lghn-loggingConfig.html';
  }

  override mount(tab: TabId, containerId = `config-log-${tab}`): boolean {
    return super.mount(tab, containerId);
  }
}
