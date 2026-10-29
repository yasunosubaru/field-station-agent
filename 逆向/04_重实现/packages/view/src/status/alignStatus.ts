import {
  MSG_ID,
  angleText,
  clone,
  formatNumber,
  heightText,
  normalizeLog,
  setStyle,
  showRag,
  tabOf,
  updateFields,
  type LogData,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import type { TabId } from '../types.ts';

interface AlignEntry {
  heading2: LogData;
  dualAntennaAlign: LogData;
  wifiAlign: LogData;
  alignAutomation: LogData;
}

export class AlignStatus {
  readonly alignStatusObj: Record<TabId, AlignEntry> = {};
  private readonly rag: Record<TabId, string> = {};
  private readonly ctx: StatusContext;

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  updateAlignStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    if (msgID === MSG_ID.HEADING2) {
      state.heading2 = clone(data);
      state.heading2.headingTitle = data.heading;
      state.heading2.length = `${formatNumber(this.ctx, data.length, 2, tab)}${this.ctx.distanceUnit()}`;
      if (typeof data.pitch !== 'string') state.heading2.pitch = angleText(this.ctx, data.pitch, tab);
      if (typeof data.headingDev !== 'string') {
        state.heading2.hdgStdDev = angleText(this.ctx, data.hdgStdDev, tab);
      }
      if (typeof data.pitchStdDev !== 'string') {
        state.heading2.ptchStdDev = angleText(this.ctx, data.ptchStdDev, tab);
      }
    } else if (msgID === MSG_ID.DUALANTENNAALIGN) state.dualAntennaAlign = clone(data);
    else if (msgID === MSG_ID.WIFIALIGNAUTOMATION) state.wifiAlign = clone(data);
    else if (msgID === MSG_ID.ALIGNAUTOMATION) state.alignAutomation = clone(data);
    else return 0;

    let status = 'idle';
    // The shipped code uses `solStatus == 0` (loose equality).
    const headingGood = (state.heading2.solStatus as unknown) == 0;
    if (Object.prototype.hasOwnProperty.call(state.dualAntennaAlign, 'switch')) {
      if (
        state.wifiAlign.option === 'DISABLE' &&
        state.alignAutomation.option === 'DISABLE' &&
        state.dualAntennaAlign.switch === 'DISABLE'
      ) {
        status = 'idle';
      } else if (
        !Object.prototype.hasOwnProperty.call(state.alignAutomation, 'option') &&
        !Object.prototype.hasOwnProperty.call(state.wifiAlign, 'option') &&
        state.dualAntennaAlign.switch === 'DISABLE'
      ) {
        status = 'idle';
      } else if (state.dualAntennaAlign.switch === 'ENABLE') {
        status = headingGood ? 'good' : 'bad';
      }
    }
    if (Object.prototype.hasOwnProperty.call(state.wifiAlign, 'option')) {
      if (
        state.dualAntennaAlign.switch === 'DISABLE' &&
        state.alignAutomation.option === 'DISABLE' &&
        state.wifiAlign.option === 'DISABLE'
      ) {
        status = 'idle';
      } else if (
        !Object.prototype.hasOwnProperty.call(state.alignAutomation, 'option') &&
        !Object.prototype.hasOwnProperty.call(state.dualAntennaAlign, 'switch') &&
        state.wifiAlign.option === 'DISABLE'
      ) {
        status = 'idle';
      } else if (state.wifiAlign.option === 'ENABLE') {
        status = headingGood ? 'good' : 'bad';
      }
    }
    if (Object.prototype.hasOwnProperty.call(state.alignAutomation, 'option')) {
      if (
        state.dualAntennaAlign.switch === 'DISABLE' &&
        state.wifiAlign.option === 'DISABLE' &&
        state.alignAutomation.option === 'DISABLE'
      ) {
        status = 'idle';
      } else if (
        !Object.prototype.hasOwnProperty.call(state.wifiAlign, 'option') &&
        !Object.prototype.hasOwnProperty.call(state.dualAntennaAlign, 'switch') &&
        state.alignAutomation.option === 'DISABLE'
      ) {
        status = 'idle';
      } else if (state.alignAutomation.option === 'ENABLE') {
        status = headingGood ? 'good' : 'bad';
      }
    }
    if (
      this.ctx.connectionType(tab) === 'playback' &&
      Object.prototype.hasOwnProperty.call(state.heading2, 'solStatus')
    ) {
      status = headingGood ? 'good' : 'bad';
    }
    this.rag[tab] = status;
    showRag(this.ctx, tab, 'alignStatus', status);
    const title = tab ? this.ctx.document.querySelector(`#${tab} .align-pc-title`) : null;
    if (title) title.textContent = this.ctx.translate(status === 'idle' ? 'ALIGN_OFF' : 'ALIGN');
    setStyle(tab ? this.ctx.document.querySelector(`#${tab} .switch-align-config`) : null, 'display', status === 'idle' ? 'block' : 'none');
    setStyle(tab ? this.ctx.document.querySelector(`#${tab} #alignStatusDetails`) : null, 'display', status === 'idle' ? 'none' : 'block');

    if (status === 'idle') return 1;
    const values: LogData = {
      ...state.heading2,
      tab,
      ...(status === 'bad'
        ? {
            heading: '--',
            headingTitle: '--',
            pitch: '--',
            hdgStdDev: '--',
            ptchStdDev: '--',
            length: '--',
          }
        : {}),
    };
    return updateFields(this.ctx, tab, 'alignStatus', 'solStatus,heading,pitch,length,headingTitle,hdgStdDev,ptchStdDev', values);
  }

  ragColor(tab: TabId): string | undefined {
    return this.rag[tab];
  }

  resetData(tab: TabId): void {
    this.alignStatusObj[tab] = {
      heading2: {},
      dualAntennaAlign: {},
      wifiAlign: {},
      alignAutomation: {},
    };
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      { selector: '[data-lang-align-status]', value: __(this.ctx, 'ALIGN_OFF') },
      { selector: '[data-lang-why-this-red]', value: __(this.ctx, 'WHY_IS_THIS_RED') },
      { selector: '[data-lang-switch-on-via-configuration]', value: __(this.ctx, 'SWITCH_ON_VIA_CONFIGURATION') },
      { selector: '[data-lang-heading]', value: __(this.ctx, 'HEADING') },
      { selector: '[data-lang-pitch]', value: __(this.ctx, 'PITCH') },
      { selector: '[data-lang-baseline]', value: __(this.ctx, 'BASELINE') },
      { selector: '[data-lang-need-help]', value: __(this.ctx, 'NEED_HELP') },
      { selector: '[data-lang-alignstatusred]', value: __(this.ctx, 'ALIGNSTATUSRED') },
      { selector: '[data-lang-title-alignStatusRed]', value: `${__(this.ctx, 'ALIGN')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}` },
      { selector: '[data-lang-error]', value: __(this.ctx, 'ERROR') },
      { selector: '[data-lang-good]', value: __(this.ctx, 'GOOD') },
      { selector: '[data-lang-warning]', value: __(this.ctx, 'WARNING') },
      { selector: '[data-lang-idle]', value: __(this.ctx, 'IDLE') },
    ]);
  }

  private ensure(tab: TabId): AlignEntry {
    return (this.alignStatusObj[tab] ??= {
      heading2: {},
      dualAntennaAlign: {},
      wifiAlign: {},
      alignAutomation: {},
    });
  }
}
