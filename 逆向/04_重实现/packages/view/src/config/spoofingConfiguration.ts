import type { TabId } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, setVisible } from './base.ts';

export const SPOOFING_MSG = {
  SKCALIBRATE: 2366,
  SKDETECTCONFIG: 2358,
  SKCALIBRATESTATUS: 2367,
} as const;

export interface SpoofingPageData {
  stage: 'NONE' | 'INPROGRESS' | 'PASS' | 'FAIL' | string;
  calibrationResults: string[];
  timeStamps: number[];
  showNow: boolean;
  enabled: boolean;
}

/** `spoofingConfiguration.js:1-320`. */
export class SpoofingConfigurationPage extends BaseConfigPage {
  private readonly pages = new Map<TabId, SpoofingPageData>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'spoofingConfiguration',
      fragmentPath: './../GRIT/spoofingConfiguration/spoofingConfiguration.html',
      containerId: (tab) => `config-spoofing-${tab}`,
    });
  }

  page(tab: TabId): SpoofingPageData {
    let value = this.pages.get(tab);
    if (!value) {
      value = {
        stage: 'NONE',
        calibrationResults: [],
        timeStamps: [],
        showNow: false,
        enabled: false,
      };
      this.pages.set(tab, value);
    }
    return value;
  }

  setToggle(tab: TabId, enabled: boolean): void {
    this.page(tab).enabled = enabled;
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, 3000, 'APPLYING');
    this.commands.place(
      this.name,
      'skdetectconfig',
      [
        { mode: [enabled ? 'ENABLE' : 'DISABLE', 'enum', 4] },
        { reserved1: [0, 'ulong', 4] },
        { reserved2: [0, 'ulong', 4] },
      ],
      tab,
    );
    this.context.unloggingLogsOnWCOM?.(tab);
  }

  calibrate(tab: TabId): void {
    const page = this.page(tab);
    const option =
      page.stage === 'FAIL' && page.calibrationResults.includes('PASS') ? 'REMAINING' : 'ALL';
    this.commands.setCurrentFeature(this.name);
    this.commands.place(
      this.name,
      'skcalibrate',
      [
        { mode: ['START', 'enum', 4] },
        { option: [option, 'enum', 4] },
        { reserved: [0, 'ulong', 4] },
      ],
      tab,
    );
  }

  setStage(tab: TabId, data: Record<string, unknown>): void {
    const page = this.page(tab);
    page.stage = String(data.mode ?? data.stage ?? 'NONE');
    const rows = Array.isArray(data.data) ? data.data : [];
    page.calibrationResults = rows.map((row) =>
      String((row as Record<string, unknown>).calibrationResult ?? ''),
    );
    page.timeStamps = rows.map((row) => Number((row as Record<string, unknown>).timeStamp ?? 0));
    this.render(tab);
  }

  decodeTimestamp(dataWord: number): string {
    const binary = dataWord.toString(2).padStart(32, '0');
    const weekSeconds = parseInt(binary.slice(0, 17), 2) * 8;
    const weekNumber = parseInt(binary.slice(17, 29), 2);
    const totalSeconds = weekNumber * 7 * 24 * 60 * 60 + weekSeconds;
    const epoch = Date.UTC(1980, 0, 6);
    const stamp = new Date(epoch + totalSeconds * 1000);
    const day = String(stamp.getUTCDate()).padStart(2, '0');
    const month = String(stamp.getUTCMonth() + 1).padStart(2, '0');
    const year = stamp.getUTCFullYear();
    let hours = stamp.getUTCHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours %= 12;
    const hour = String(hours || 12).padStart(2, '0');
    const minute = String(stamp.getUTCMinutes()).padStart(2, '0');
    const second = String(stamp.getUTCSeconds()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}:${minute}:${second} ${ampm}`;
  }

  protected runApply(_tab: TabId): undefined {
    return undefined;
  }

  protected render(tab: TabId): void {
    const page = this.page(tab);
    let stage = page.stage;
    if (stage === 'FAIL' && page.calibrationResults.includes('PASS')) stage = 'PASS';
    for (const id of ['stageOneView', 'stageTwoView', 'stageThreeView', 'stageFourView']) {
      setVisible(this.context.document.querySelector(`#${tab} #${id}`), false);
    }
    const stageId =
      stage === 'INPROGRESS'
        ? 'stageTwoView'
        : stage === 'PASS'
          ? 'stageThreeView'
          : stage === 'FAIL'
            ? 'stageFourView'
            : 'stageOneView';
    setVisible(this.context.document.querySelector(`#${tab} #${stageId}`), true);
  }

  handleSpoofingConfigurationCommandResponse(data: 1 | 2, tab: TabId, msgId?: number): void {
    this.commands.removeFeature(this.name, tab);
    this.context.clock.setTimeout(() => {
      this.context.closeApplyingScreen(tab, data);
      if (msgId === SPOOFING_MSG.SKCALIBRATE && data === 1) this.page(tab).showNow = true;
    }, 1000);
  }

  resetSpoofingConfigUI(tab: TabId): void {
    const page = this.page(tab);
    page.showNow = false;
    this.reset(tab);
  }
}
