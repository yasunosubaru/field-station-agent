import {
  MSG_ID,
  normalizeLog,
  setStyle,
  showRag,
  tabOf,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import type { TabId } from '../types.ts';

export class RadioStatus {
  private readonly rag: Record<TabId, string> = {};
  readonly radioPorts: Record<TabId, string | undefined> = {};
  private readonly ctx: StatusContext;

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  updateStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    if (msgID === MSG_ID.SATELDETECT) {
      this.radioPorts[tab] = typeof data.port === 'string' ? data.port : undefined;
      this.ctx.setRadioPort?.(tab, this.radioPorts[tab]);
      return 1;
    }
    if (msgID !== MSG_ID.SATELSTATUS) return 0;
    const state = String(data.state ?? '');
    const rag = state === 'READY' ? 'good' : state === 'BUSY' ? 'warning' : state === 'ERROR' ? 'bad' : 'idle';
    this.rag[tab] = rag;
    showRag(this.ctx, tab, 'radioStatus', rag);
    const title = this.ctx.document.querySelector(`#${tab} .radio-pc-title`);
    if (title) title.textContent = this.ctx.translate(rag === 'idle' ? 'RADIO_OFF' : 'RADIO');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-radio-config`), 'display', rag === 'idle' ? 'block' : 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .radio-message-field`), 'display', rag === 'idle' ? 'none' : 'block');
    return 1;
  }

  ragColor(tab: TabId): string | undefined {
    return this.rag[tab];
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      { selector: '[data-lang-radio-status]', value: __(this.ctx, 'RADIO_OFF') },
      { selector: '[data-lang-why-this-amber]', value: __(this.ctx, 'WHY_IS_THIS_AMBER') },
      { selector: '[data-lang-why-this-red]', value: __(this.ctx, 'WHY_IS_THIS_RED') },
      { selector: '[data-lang-switch-on-via-configuration]', value: __(this.ctx, 'SWITCH_ON_VIA_CONFIGURATION') },
      { selector: '[data-lang-no-further-information]', value: __(this.ctx, 'NO_FURTHER_INFORMATION_AVAILABLE') },
      { selector: '[data-lang-need-help]', value: __(this.ctx, 'NEED_HELP') },
      { selector: '[data-lang-radiostatusamber]', value: __(this.ctx, 'RADIOSTATUSAMBER') },
      { selector: '[data-lang-title-radiostatusamber]', value: `${__(this.ctx, 'RADIO')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}` },
      { selector: '[data-lang-radiostatusred]', value: __(this.ctx, 'RADIOSTATUSRED') },
      { selector: '[data-lang-title-radiostatusred]', value: `${__(this.ctx, 'RADIO')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}` },
      { selector: '[data-lang-error]', value: __(this.ctx, 'ERROR') },
      { selector: '[data-lang-good]', value: __(this.ctx, 'GOOD') },
      { selector: '[data-lang-warning]', value: __(this.ctx, 'WARNING') },
      { selector: '[data-lang-idle]', value: __(this.ctx, 'IDLE') },
    ]);
  }
}
