import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigPageRuntime,
  ConfigDataMap,
} from './types.ts';
import { COMMAND_RESPONSE } from './types.ts';
import {
  BaseConfigPage,
  activeText,
  addError,
  clearErrors,
  elementValue,
  scopedQuery,
  setChecked,
  setValue,
} from './base.ts';

export const GNSS_MSG = {
  ELEVATION_CUTOFF: 1735,
  PPS_CONTROL: 613,
} as const;

/** `gnssConfig.js:1-260`. */
export class GnssConfigPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'gnssConfig',
      fragmentPath: './../gnssConfig/gnssConfig.html',
      containerId: (tab) => `config-gnss-${tab}`,
    });
  }

  protected override loaderDuration(_tab: TabId): number {
    return 10000;
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    if (msgId !== GNSS_MSG.ELEVATION_CUTOFF && msgId !== GNSS_MSG.PPS_CONTROL) return;
    super.updateData(msgId, data);
  }

  protected render(tab: TabId): void {
    const current = this.state.current(tab);
    const elevation = current[String(GNSS_MSG.ELEVATION_CUTOFF)] as Record<string, unknown> | undefined;
    const pps = current[String(GNSS_MSG.PPS_CONTROL)] as Record<string, unknown> | undefined;
    if (elevation) setValue(this.context, tab, '#gnss-elevation-mask-value', elevation.angle);
    if (pps) {
      setChecked(this.context, tab, '.gnss-pulse-toggle-button', pps.switch === 'ENABLE');
      setChecked(this.context, tab, '#polarityNeg', pps.polarity === 'NEGATIVE');
      setChecked(this.context, tab, '#polarityPos', pps.polarity === 'POSITIVE');
      const neg = scopedQuery(this.context, tab, '#polarityNeg');
      const pos = scopedQuery(this.context, tab, '#polarityPos');
      neg?.classList.toggle('active', pps.polarity === 'NEGATIVE');
      pos?.classList.toggle('active', pps.polarity === 'POSITIVE');
      const container = scopedQuery(this.context, tab, '.gnss-polarity-container');
      container?.classList.toggle('customDisableButton', pps.switch !== 'ENABLE');
    }
  }

  setElevation(tab: TabId, value: number): void {
    const current = this.state.current(tab);
    this.state.setPending(tab, GNSS_MSG.ELEVATION_CUTOFF, 'angle', value, current[String(GNSS_MSG.ELEVATION_CUTOFF)]?.angle);
  }

  setPps(tab: TabId, key: 'switch' | 'polarity', value: string): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    this.state.setPending(tab, GNSS_MSG.PPS_CONTROL, key, value, current[String(GNSS_MSG.PPS_CONTROL)]?.[key]);
  }

  protected validateApply(tab: TabId): boolean {
    clearErrors(this.context, tab);
    const raw =
      elementValue(this.context, tab, '.gnss-elevation-mask-inputbox input') ||
      elementValue(this.context, tab, '#gnss-elevation-mask-value');
    const angle = Number(raw);
    const lower = this.context.features(tab).isMarinePak ? 0 : -90;
    if (raw === '' || !Number.isFinite(angle) || angle < lower || angle > 90) {
      addError(this.context, tab, '.gnss-elevation-mask-container');
      return false;
    }
    return true;
  }

  protected runApply(tab: TabId): CommandResponse | undefined {
    const changed = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const elevation = changed[String(GNSS_MSG.ELEVATION_CUTOFF)];
    if (elevation) {
      const params: ConfigDataMap = [
        { constellation: ['ALL', 'enum', 4] },
        { angle: [elevation.angle, 'float', 4] },
        { reserved: [0, 'ulong', 4] },
      ];
      this.commands.place(this.name, 'elevationcutoff', params, tab);
    }
    const pps = changed[String(GNSS_MSG.PPS_CONTROL)];
    if (pps) {
      const params: ConfigDataMap = [
        { switch: [pps.switch ?? 'DISABLE', 'enum', 4] },
        { polarity: [pps.polarity ?? 'POSITIVE', 'enum', 4] },
        { period: [1, 'double', 8] },
        { pulsewidth: [1000, 'ulong', 4] },
      ];
      this.commands.place(this.name, 'ppscontrol', params, tab);
    }
    return undefined;
  }

  handleGNSSConfigCommandResponse(data: CommandResponse, tab: TabId): void {
    this.handleCommandResponse(data, tab);
  }

  resetGNSSConfigUI(tab: TabId): void {
    this.reset(tab);
  }

  applyButtonCheck(tab: TabId): boolean {
    return this.validateApply(tab) && this.isDirty(tab);
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
