import {
  MSG_ID,
  escapeHTML,
  normalizeLog,
  numberValue,
  rowsOf,
  setStyle,
  setText,
  showRag,
  tabOf,
  type LogData,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import type { TabId } from '../types.ts';

export class InterferenceStatus {
  readonly ITKRagIndicatorColor: Record<TabId, string | undefined> = {};
  readonly detectedBands: Record<TabId, Array<{ rfPath: string; centerFrequency: number }>> = {};
  private readonly ctx: StatusContext;
  private readonly configOf: (tab: TabId) => string | undefined;

  constructor(ctx: StatusContext, configOf: (tab: TabId) => string | undefined) {
    this.ctx = ctx;
    this.configOf = configOf;
  }

  updateStatus(msgID: number, input: unknown): number {
    if (msgID !== MSG_ID.ITDETECTSTATUS) return 0;
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const bands: Array<{ rfPath: string; centerFrequency: number }> = [];
    const rows = rowsOf(data);
    const first = rows.length ? rows : [data];
    for (const row of first) {
      if (row.detectionType === 'SPECTRALANALYSIS') {
        bands.push({
          rfPath: String(row.rfPath ?? data.rfPath ?? '--'),
          centerFrequency: numberValue(row.centerFrequency ?? data.centerFrequency),
        });
      }
    }
    this.detectedBands[tab] = bands;
    const disabled = this.configOf(tab) === 'NONE';
    const state = disabled ? 'idle' : bands.length ? 'warning' : 'good';
    if (!disabled) this.ITKRagIndicatorColor[tab] = state;
    showRag(this.ctx, tab, 'interferenceStatus', state);
    setText(this.ctx, tab, '#interferenceStatusitkState', disabled ? 'Disabled' : bands.length ? 'Detected' : 'Not Detected');
    const host = this.ctx.document.querySelector(`#${tab} .spectral-bands`);
    if (host) {
      host.innerHTML = bands
        .map(
          (band) =>
            `<div class="row rfPath SPECTRALANALYSIS"><span class="title col-md-6 col-sm-6 col-xs-6">${escapeHTML(band.rfPath)}</span><span class="value col-md-6 col-sm-6 col-xs-6">${band.centerFrequency.toFixed(0)} MHz</span></div>`,
        )
        .join('');
    }
    return 1;
  }

  ITKRagColor(tab: TabId): string | undefined {
    return this.ITKRagIndicatorColor[tab];
  }

  resetData(tab: TabId): void {
    delete this.ITKRagIndicatorColor[tab];
    delete this.detectedBands[tab];
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      { selector: '[data-lang-interference]', value: __(this.ctx, 'INTERFERENCE') },
      { selector: '[data-lang-why-this-red]', value: __(this.ctx, 'WHY_IS_THIS_RED') },
      { selector: '[data-lang-not-detected]', value: __(this.ctx, 'NOT_DETECTED') },
      { selector: '[data-lang-detected]', value: __(this.ctx, 'DETECTED') },
      { selector: '[data-lang-need-help]', value: __(this.ctx, 'NEED_HELP') },
      { selector: '[data-lang-interferencestatusred]', value: __(this.ctx, 'INTERFERENCESTATUSRED') },
      { selector: '[data-lang-title-interferencestatusred]', value: `${__(this.ctx, 'INTERFERENCE')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}` },
      { selector: '[data-lang-error]', value: __(this.ctx, 'ERROR') },
      { selector: '[data-lang-good]', value: __(this.ctx, 'GOOD') },
      { selector: '[data-lang-warning]', value: __(this.ctx, 'WARNING') },
    ]);
  }
}
