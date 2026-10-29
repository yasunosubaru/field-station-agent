import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  namespaceCollapsePanels,
  namespaceToggleSwitch,
  setValue,
} from './base.ts';

export const ALIGN_MSG = {
  DUAL_ANTENNA: 1761,
  HEADING_OFFSET: 1082,
  WIFI_AUTOMATION: 2214,
  ALIGN_AUTOMATION: 1323,
} as const;

/** `alignConfig.js:948-1150`. */
export class AlignConfigPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'alignConfig',
      fragmentPath: './../alignConfig/alignConfig.html',
      containerId: (tab) => `config-align-${tab}`,
    });
  }

  protected override responseDelay(): number {
    return 1500;
  }

  protected render(tab: TabId): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    const heading = current[String(ALIGN_MSG.HEADING_OFFSET)];
    if (heading) {
      setValue(this.context, tab, '#hoffsetVal', heading.headingoffsetindeg);
      setValue(this.context, tab, '#poffsetVal', heading.pitchoffsetindeg);
    }
  }

  protected override namespace(tab: TabId, container: Element): void {
    namespaceToggleSwitch(container, tab);
    namespaceCollapsePanels(container, tab);
  }

  setChanged(
    tab: TabId,
    msgId: number,
    key: string,
    value: unknown,
  ): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    this.state.setPending(tab, msgId, key, value, current[String(msgId)]?.[key]);
  }

  protected runApply(tab: TabId) {
    const changed = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const ordered: Array<[number, Record<string, unknown> | undefined]> = [
      [ALIGN_MSG.DUAL_ANTENNA, changed[String(ALIGN_MSG.DUAL_ANTENNA)]],
      [ALIGN_MSG.HEADING_OFFSET, changed[String(ALIGN_MSG.HEADING_OFFSET)]],
      [ALIGN_MSG.WIFI_AUTOMATION, changed[String(ALIGN_MSG.WIFI_AUTOMATION)]],
      [ALIGN_MSG.ALIGN_AUTOMATION, changed[String(ALIGN_MSG.ALIGN_AUTOMATION)]],
    ];
    for (const [msgId, value] of ordered) {
      if (!value) continue;
      if (msgId === ALIGN_MSG.DUAL_ANTENNA) {
        const params: ConfigDataMap = [
          { switch: [value.switch ?? 'DISABLE', 'enum', 4] },
          { obsrate: [value.obsrate ?? 1, 'ulong', 4] },
          { posrate: [1, 'ulong', 4] },
        ];
        this.commands.place(this.name, 'dualantennaalign', params, tab);
      } else if (msgId === ALIGN_MSG.HEADING_OFFSET) {
        const params: ConfigDataMap = [
          { headingoffsetindeg: [value.headingoffsetindeg ?? 0, 'float', 4] },
          { pitchoffsetindeg: [value.pitchoffsetindeg ?? 0, 'float', 4] },
        ];
        this.commands.place(this.name, 'headingoffset', params, tab);
      } else if (msgId === ALIGN_MSG.WIFI_AUTOMATION) {
        const params: ConfigDataMap = [
          { option: [value.option ?? 'DISABLE', 'enum', 4] },
          { master_networkid: [1, 'ulong', 4] },
          { rover_icom: ['ICOM1', 'enum', 4] },
          { datarate: [value.datarate ?? 1, 'ulong', 4] },
          { headingextboption: ['ON', 'enum', 4] },
          { interfacemode: ['NOVATELX', 'enum', 4] },
        ];
        this.commands.place(this.name, 'wifialignautomation', params, tab);
      } else if (msgId === ALIGN_MSG.ALIGN_AUTOMATION) {
        const params: ConfigDataMap = [
          { option: [value.option ?? 'DISABLE', 'enum', 4] },
          { comport: ['COM2', 'enum', 4] },
          { baudrate: [230400, 'ulong', 4] },
          { datarate: [value.datarate ?? 10, 'ulong', 4] },
          { headingextboption: ['ON', 'enum', 4] },
          { interfacemode: ['NONE', 'enum', 4] },
        ];
        this.commands.place(this.name, 'alignautomation', params, tab);
      }
    }
    return undefined;
  }

  handleAlignConfigCommandResponse(data: 1 | 2, tab: TabId, msgId?: number): void {
    if (msgId === 36 || msgId === 1) return;
    this.handleCommandResponse(data, tab, msgId);
  }

  resetALIGNConfigUI(tab: TabId): void {
    this.reset(tab);
  }
}
