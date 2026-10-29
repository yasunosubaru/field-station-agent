import {
  MSG_ID,
  escapeHTML,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  applyLanguageMarkers,
  __,
  setStyle,
  showRag,
  tabOf,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';

const RF_TYPES = ['L1', 'L2', 'L5', 'S'];
const CARD_IDS: Record<number, string> = { 3: 'DSPC1', 4: 'DSPC2' };
const RF_COLOURS = {
  light: { L1: 'rgb(105, 41, 196)', L2: 'rgb(17, 146, 232)', L5: '#005d5d', S: 'rgb(105, 41, 196)' },
  dark: { L1: 'rgb(138, 63, 252)', L2: 'rgb(51, 177, 255)', L5: 'rgb(0, 125, 121)', S: 'rgb(138, 63, 252)' },
};
const PROPERTIES = ['pulseWidth', 'modulus'];

export class AgcStatus {
  readonly AGCUIData: Record<TabId, Record<string, Record<string, LogData>>> = {};
  readonly RAGStatus: Record<TabId, string[]> = {};
  readonly RAGIndicatorColor: Record<TabId, string | undefined> = {};
  readonly agcPlotData: Record<TabId, LogData[]> = {};
  readonly hoverInfo: Record<TabId, LogData> = {};
  readonly cardsUpdateFlag: Record<TabId, boolean> = {};
  readonly plotCreated: Record<TabId, boolean> = {};
  readonly popopPlotCreated: Record<TabId, boolean> = {};
  readonly hoverFlag: Record<TabId, boolean> = {};
  readonly agcDetailedInfo: Record<TabId, Record<string, LogData>> = {};
  private readonly ctx: StatusContext;
  private readonly wiredTabs = new Set<TabId>();

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  dc_updateData(msgID: number, input: unknown): number {
    if (msgID !== MSG_ID.AGCINFO) return 0;
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const rows = rowsOf(data);
    if (!rows.length) rows.push(data);
    const cards = (this.AGCUIData[tab] ??= {});
    for (const source of rows) {
      const row = this.derive(source);
      const card = String(row.cardId ?? 'UNKNOWN');
      const rf = String(row.rfType ?? 'UNKNOWN');
      (cards[card] ??= {})[rf] = row;
    }
    this.render(tab);
    return rows.length;
  }

  updateAGCPlot(tab: TabId, _updateLegends = false): number {
    return this.render(tab);
  }

  AGCStatusRAGMessages(tab: TabId): string[] {
    return [...new Set(this.RAGStatus[tab] ?? [])];
  }

  clearPlotDetails(tab: TabId): void {
    delete this.plotCreated[tab];
    delete this.popopPlotCreated[tab];
    delete this.cardsUpdateFlag[tab];
  }

  resetData(tab: TabId): void {
    this.wiredTabs.delete(tab);
    delete this.AGCUIData[tab];
    delete this.RAGStatus[tab];
    delete this.RAGIndicatorColor[tab];
    delete this.agcPlotData[tab];
    delete this.hoverInfo[tab];
    delete this.hoverFlag[tab];
    delete this.agcDetailedInfo[tab];
    this.clearPlotDetails(tab);
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      ['agcStatus', 'AGC_STATUS'], ['view-agc-detailed-info', 'VIEW_AGC_DETAILED_INFO'],
      ['card', 'CARD'], ['legend', 'LEGEND'], ['rescale', 'RESCALE'],
      ['pulseWidth', 'PULSEWIDTH'], ['modulus', 'MODULUS'], ['agc-ylabel', 'AGC_YLABEL'],
      ['data-lang-railed-gain', 'RAILED_GAIN_1'],
      ['data-lang-pulse-width-above', 'AGC_PULSE_WIDTH_ABOVE_900'],
      ['data-lang-pulse-width-below', 'AGC_PULSE_WITH_BELOW_100'],
      ['data-lang-bin-skew', 'BIN_SKEW_1'], ['data-lang-bins-empty', 'BINS_EMPTY'],
      ['data-lang-bins-not-empty', 'BINS_NOT_FULL'],
    ].map(([marker, key]) => ({
      selector: `[data-lang-${marker}]`,
      value: __(this.ctx, key),
    })).concat([
      {
        selector: '[data-lang-title-agcstatusred]',
        value: `${__(this.ctx, 'AGC_STATUS')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
      {
        selector: '[data-lang-title-agcstatusamber]',
        value: `${__(this.ctx, 'AGC_STATUS')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}`,
      },
    ]));
    for (const element of Array.from(this.ctx.document.querySelectorAll('[data-lang-pulse-width-is]'))) {
      const last = element.textContent?.lastIndexOf(' ') ?? -1;
      element.textContent = this.ctx.translate('AGC_PULSE_WIDTH_IS').replace('%1', element.textContent?.slice(last + 1) ?? '');
    }
  }

  private derive(data: LogData): LogData {
    const word = numberValue(data.statusWord);
    return {
      ...data,
      rfType: data.rfType ?? RF_TYPES[(word >>> 25) & 0x7],
      cardId: data.cardId ?? CARD_IDS[(word >>> 28) & 0xf],
      railGain:
        data.railGain ??
        (((word >>> 13) & 1) ? 'VGA railed for 3+ seconds' : 'VGA not railed'),
      binsEmpty:
        data.binsEmpty ??
        (((word >>> 11) & 1) ? 'All bins are empty' : 'Bins contain data'),
      binSkew: data.binSkew ?? (((word >>> 23) & 1) ? 'Present' : 'Not Present'),
      binsNotFull:
        data.binsNotFull ??
        (((word >>> 12) & 1) ? 'All Bins Not Filled' : 'One of more bins filled'),
    };
  }

  private render(tab: TabId, updateLegends = false): number {
    const cards = this.AGCUIData[tab];
    if (!cards) return 0;
    const cardNames = Object.keys(cards);
    const existing = this.ctx.document.querySelector(
      `#${tab} .agc-main-cards #agc-card-items .agc-card-btn.active`,
    );
    const selected =
      existing?.textContent && cardNames.includes(existing.textContent)
        ? existing.textContent
        : cardNames[0] ?? '';
    const info = cards[selected] ?? {};
    const cardList = this.ctx.document.querySelector(
      `#${tab} .agc-main-cards #agc-card-items`,
    );
    if (cardList && !this.cardsUpdateFlag[tab]) {
      cardList.innerHTML = cardNames
        .map(
          (name, index) =>
            `<li class="agc-card-btn${index === 0 ? ' active' : ''}" id="${escapeHTML(name)}-card">${escapeHTML(name)}</li>`,
        )
        .join('');
      this.cardsUpdateFlag[tab] = true;
    }
    this.wireUi(tab);
    const signals = Object.keys(info);
    const display = this.ctx.document.querySelector(`#${tab} .agc-display-dataContainer`);
    if (display) {
      const header = [
        '<span class="agc-info-outer agc-header"></span>',
        ...signals.map(
          (signal) =>
            `<span class="agc-info-outer agc-header">${escapeHTML(signal)}</span>`,
        ),
      ].join('');
      const rows = PROPERTIES.map(
        (property) =>
          `<tr class="agcInfo-entries-outer"><td data-lang-${property} class="agc-info-outer agc-heading-outer">${escapeHTML(__(this.ctx, property.toUpperCase()))}</td>${signals
            .map(
              (signal) =>
                `<td class="agc-info-outer">${escapeHTML(String(info[signal][property] ?? ''))}</td>`,
            )
            .join('')}</tr>`,
      ).join('');
      display.innerHTML = `<div class="agc-data-entries-outer"><div class="agcInfo-header-outer">${header}</div><div class="agc-table-data-outer"><table class="agc-table-entries-outer"><tbody>${rows}</tbody></table></div></div>`;
    }

    const plotData = signals.map((rf) => ({
      x: ['<b>Bin 0</b>', '<b>Bin 1</b>', '<b>Bin 2</b>', '<b>Bin 3</b>', '<b>Bin 4</b>', '<b>Bin 5</b>'],
      y: Array.from({ length: 6 }, (_, index) => numberValue(info[rf][`bin${index + 1}`])),
      type: 'bar',
      name: rf,
      marker: {
        color: (this.ctx.theme?.(tab) === 'dark-theme' ? RF_COLOURS.dark : RF_COLOURS.light)[
          rf as keyof typeof RF_COLOURS.light
        ] ?? RF_COLOURS.light.L1,
        text: rf,
      },
      hovertemplate: 'TEXT',
    }));
    this.agcPlotData[tab] = plotData;
    this.renderAgcPlot(tab, plotData, false);
    this.renderLegend(tab, info);
    if (updateLegends) this.renderLegend(tab, info);

    this.RAGStatus[tab] = [];
    let overall: string | undefined;
    for (const card of cardNames) {
      const rfs = Object.keys(cards[card]);
      for (const rf of rfs) {
        const entry = cards[card][rf];
        const pulseWidth = numberValue(entry.pulseWidth);
        if (
          pulseWidth === 0 ||
          pulseWidth === 1000 ||
          entry.railGain === 'VGA railed for 3+ seconds'
        ) {
          overall = 'bad';
          if (pulseWidth === 0) {
            this.RAGStatus[tab].push(
              __(this.ctx, 'AGC_PULSE_WIDTH_IS').replace('%1', '0'),
            );
          } else if (pulseWidth === 1000) {
            this.RAGStatus[tab].push(
              __(this.ctx, 'AGC_PULSE_WIDTH_IS').replace('%1', '1000'),
            );
          }
          if (entry.railGain === 'VGA railed for 3+ seconds') {
            this.RAGStatus[tab].push(__(this.ctx, 'RAILED_GAIN_1'));
          }
          break;
        }
        const carrierWarning = pulseWidth > 900 || pulseWidth < 100;
        if (
          ((!overall || overall !== 'bad') && carrierWarning) ||
          entry.binSkew === 'Present' ||
          entry.binsEmpty === 'All bins are empty' ||
          entry.binsNotFull === 'All Bins Not Filled'
        ) {
          overall = 'warning';
          if (pulseWidth > 900) {
            this.RAGStatus[tab].push(__(this.ctx, 'AGC_PULSE_WIDTH_ABOVE_900'));
          } else if (pulseWidth < 100) {
            this.RAGStatus[tab].push(__(this.ctx, 'AGC_PULSE_WITH_BELOW_100'));
          }
          if (entry.binSkew === 'Present') {
            this.RAGStatus[tab].push(__(this.ctx, 'BIN_SKEW_1'));
          }
          if (entry.binsEmpty === 'All bins are empty') {
            this.RAGStatus[tab].push(__(this.ctx, 'BINS_EMPTY'));
          }
          if (entry.binsNotFull === 'All Bins Not Filled') {
            this.RAGStatus[tab].push(__(this.ctx, 'BINS_NOT_FULL'));
          }
        } else if (
          (!overall || overall === 'good') &&
          (pulseWidth <= 900 || pulseWidth >= 100) &&
          entry.binSkew === 'Not Present' &&
          entry.binsEmpty === 'Bins contain data' &&
          entry.binsNotFull === 'One of more bins filled' &&
          entry.railGain === 'VGA not railed'
        ) {
          overall = 'good';
        }
      }
      if (overall === 'bad') break;
    }
    this.RAGIndicatorColor[tab] = overall;
    for (const node of this.ctx.document.querySelectorAll(
      `#${tab} .agcStatus.statustiles-traffic span`,
    )) {
      setStyle(node, 'display', 'none');
    }
    if (overall) showRag(this.ctx, tab, 'agcStatus', overall);
    return plotData.length;
  }

  private layout(tab: TabId): LogData {
    const dark = this.ctx.theme?.(tab) === 'dark-theme';
    const line = dark ? 'RGBA(146, 146, 146,0.6)' : '#d8d8d8';
    const tick = dark ? 'RGBA(255, 255, 255, 0.60)' : '#444444';
    return {
      barmode: 'group',
      showlegend: false,
      hovermode: 'closest',
      bargap: 0.15,
      bargroupgap: 0.1,
      paper_bgcolor: dark ? 'rgb(18, 18, 18)' : undefined,
      plot_bgcolor: dark ? 'rgb(18, 18, 18)' : undefined,
      margin: { b: 30, l: 50, r: 20, t: 10, pad: 0 },
      xaxis: {
        showgrid: true,
        tickson: 'boundaries',
        fixedrange: true,
        autorange: true,
        tickangle: 0,
        linecolor: line,
        mirror: true,
        gridcolor: line,
        showline: true,
        tickfont: { color: tick },
      },
      yaxis: {
        showgrid: true,
        fixedrange: true,
        showline: true,
        ticks: 'outside',
        tickwidth: 1,
        linecolor: line,
        mirror: true,
        gridcolor: line,
        tickfont: { color: tick },
      },
    };
  }

  private renderAgcPlot(
    tab: TabId,
    plotData: LogData[],
    popup: boolean,
  ): boolean {
    const element = popup
      ? this.ctx.document.querySelector(`#${tab} #popupModal .agcPlotArea .agcStatusChart`)
      : this.ctx.document.querySelector(`#${tab} .agcPlotArea .agcStatusChart`);
    if (!element) return false;
    element.id = `agcStatus${popup ? 'Popup' : ''}Plot-${tab}`;
    const runtime = globalThis as typeof globalThis & {
      Plotly?: {
        newPlot?: (id: string, data: LogData[], layout: LogData) => unknown;
        react?: (id: string, data: LogData[], layout: LogData) => unknown;
      };
    };
    const created = popup ? this.popopPlotCreated[tab] : this.plotCreated[tab];
    const plotly = runtime.Plotly;
    const render =
      (created ? plotly?.react ?? plotly?.newPlot : plotly?.newPlot ?? plotly?.react) ?? null;
    if (render && plotly) {
      try {
        const result = render.call(plotly, element.id, plotData, this.layout(tab));
        if (popup) this.popopPlotCreated[tab] = true;
        else this.plotCreated[tab] = true;
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          (result as PromiseLike<{ on?: (name: string, fn: (event: LogData) => void) => void }>).then(
            (graph) => {
              graph?.on?.('plotly_hover', (event) => this.onHover(tab, event));
              graph?.on?.('plotly_unhover', () => this.onUnhover(tab));
            },
          );
        }
        return true;
      } catch {
        // Fall through to the textual Node view.
      }
    }
    if (popup) return false;
    element.innerHTML = plotData
      .map(
        ({ name, y }) =>
          `<div class="agc-plot-row" data-rf="${escapeHTML(String(name))}"><span>${escapeHTML(String(name))}</span>${(y as number[])
            .map(
              (value, index) =>
                `<span class="agc-plot-bin" data-bin="${index}">${formatNumber(this.ctx, value, 3, tab)}</span>`,
            )
            .join('')}</div>`,
      )
      .join('');
    return false;
  }

  private renderLegend(tab: TabId, info: Record<string, LogData>): void {
    const host = this.ctx.document.querySelector(`#${tab} .agc-legend-fields .legend-entries`);
    if (!host) return;
    host.innerHTML = Object.keys(info)
      .map(
        (rf) =>
          `<div class="${escapeHTML(rf)}-entry"><div class="agc-legend-box"></div><label>${escapeHTML(rf)}</label></div>`,
      )
      .join('');
  }

  private wireUi(tab: TabId): void {
    if (this.wiredTabs.has(tab)) return;
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    this.wiredTabs.add(tab);
    for (const item of scope.querySelectorAll('.agc-main-cards #agc-card-items li')) {
      item.addEventListener('click', () => {
        for (const other of scope.querySelectorAll('.agc-main-cards #agc-card-items li')) {
          other.classList.remove('active');
        }
        item.classList.add('active');
        this.updateAGCPlot(tab, true);
      });
    }
    scope.querySelector('.view-agc-detailed-info')?.addEventListener('click', (event) => {
      event.preventDefault();
      this.openDetailedDialog(tab);
    });
  }

  private detailedValues(tab: TabId, info: Record<string, LogData>): Record<string, LogData> {
    const detail: Record<string, LogData> = {};
    for (const signal of Object.keys(info)) {
      const row = info[signal];
      const word = numberValue(row.statusWord) >>> 0;
      detail[signal] = {
        'Bin 0': formatNumber(this.ctx, row.bin1, 3, tab),
        'Bin 1': formatNumber(this.ctx, row.bin2, 3, tab),
        'Bin 2': formatNumber(this.ctx, row.bin3, 3, tab),
        'Bin 3': formatNumber(this.ctx, row.bin4, 3, tab),
        'Bin 4': formatNumber(this.ctx, row.bin5, 3, tab),
        'Bin 5': formatNumber(this.ctx, row.bin6, 3, tab),
        'AGC Word': `0x${word.toString(16).padStart(8, '0')}`,
        'Pulse Width': row.pulseWidth,
        Modulus: row.modulus,
        'Noise Floor': row.noiseFloor,
        '% Pulses blanked': formatNumber(this.ctx, row.pulsesBlankedPercent, 2, tab),
        'DC Offset': row.dcOffset,
        'Active Flag': row.activeFlag,
        'Bin Skew': row.binSkew,
        'AGC Calibration': row.AGCCollaboration,
        'ADC Range': row.ADCRange,
        'Noise Floor Calculation Method': row.noiseFloorCalMethod,
        'Bin Count Overflow': row.binCountOverflow,
        'Rail Gain': row.railGain,
        'Bins Not Full': row.binsNotFull,
        'Bins Empty': row.binsEmpty,
      };
    }
    this.agcDetailedInfo[tab] = detail;
    return detail;
  }

  private openDetailedDialog(tab: TabId): void {
    const selected = this.ctx.document.querySelector(
      `#${tab} .agc-main-cards #agc-card-items li.active`,
    )?.textContent ?? Object.keys(this.AGCUIData[tab] ?? {})[0] ?? '';
    const info = this.AGCUIData[tab]?.[selected] ?? {};
    const detail = this.detailedValues(tab, info);
    const signals = Object.keys(detail);
    const keys = signals.length ? Object.keys(detail[signals[0]]) : [];
    const header = ['', ...signals]
      .map((signal) => `<span class="agc-info">${escapeHTML(signal)}</span>`)
      .join('');
    const rows = keys
      .map(
        (key) =>
          `<tr class="agcInfo-entries"><td class="agc-info agc-heading">${escapeHTML(key)}</td>${signals
            .map(
              (signal) =>
                `<td class="agc-info">${escapeHTML(String(detail[signal][key] ?? ''))}</td>`,
            )
            .join('')}</tr>`,
      )
      .join('');
    const legend = Object.keys(info)
      .map(
        (rf) =>
          `<div class="${escapeHTML(rf)}-entry"><div class="agc-legend-box"></div><label>${escapeHTML(rf)}</label></div>`,
      )
      .join('');
    const content = `<div class="agc-status"><div class="agc-settings">
      <div class="agc-card-options"><label data-lang-card>${escapeHTML(__(this.ctx, 'CARD'))}</label><ul class="list-inline legend-layout" id="agc-card-items">${Object.keys(this.AGCUIData[tab] ?? {})
        .map(
          (card, index) =>
            `<li class="agc-card-btn${index === 0 ? ' active' : ''}" id="${escapeHTML(card)}-card">${escapeHTML(card)}</li>`,
        )
        .join('')}</ul></div>
      <div class="agc-legend-fields"><label data-lang-legend>${escapeHTML(__(this.ctx, 'LEGEND'))}</label><div class="legend-entries">${legend}</div></div>
      <div class="rescale-settings"><ul class="list-inline legend-layout"><li class="agc-card-btn" id="agcPlotRescaleBtn" data-lang-rescale>${escapeHTML(__(this.ctx, 'RESCALE'))}</li></ul></div>
    </div><div class="agcPlotArea"><span class="agcTileYLabel" data-lang-agc-ylabel>${escapeHTML(__(this.ctx, 'AGC_YLABEL'))}</span><div class="agcStatusChart" id="agcStatusPopupPlot-${tab}"></div><div class="hoverinfo"><p>L1 B3: 0.345</p></div></div>
    <div class="agc-display-data"><div class="agc-data-entries"><div class="agcInfo-header">${header}</div><div class="agc-table-data"><table class="agc-table-entries">${rows}</table></div></div></div></div>
    <div class="view-agcpopup-footer"><div class="copy-icon"><div class="outer-rect"></div><div class="inner-rect"></div></div><button type="button" class="btn btn-default whiteBtn agc-status-copy-to-clipboard elidedText" data-lang-tracking-copy-to-clipboard>${escapeHTML(__(this.ctx, 'TRACKING_COPY_TO_CLIPBOARD'))}</button><button type="button" class="btn btn-default whiteBtn darkBtn" id="view-agc-done-btn" data-lang-done>${escapeHTML(__(this.ctx, 'DONE'))}</button></div>`;
    this.ctx.openDialog?.({
      tab,
      title: __(this.ctx, 'VIEW_AGC_DETAILED_INFO'),
      titleMarker: 'data-lang-view-agc-detailed-info',
      content,
      className: 'agc-popup',
    });
    const dialog = this.ctx.document.querySelector(`#${tab} #popupModal`);
    if (dialog) {
      dialog.querySelector('.agcInfo-header')!.innerHTML = header;
      dialog.querySelector('.agc-table-entries')!.innerHTML = rows;
    }
    this.renderAgcPlot(tab, this.agcPlotData[tab] ?? [], true);
    dialog?.querySelector('.agc-status-copy-to-clipboard')?.addEventListener('click', () => {
      const copy = [
        ['', ...signals].join(','),
        ...keys.map((key) => [
          key,
          ...signals.map((signal) => String(detail[signal][key] ?? '')),
        ].join(',')),
      ].join('\n');
      this.ctx.copyText?.(copy);
    });
    dialog?.querySelector('#view-agc-done-btn')?.addEventListener('click', () => {
      this.ctx.closeDialog?.(tab);
    });
  }

  private onHover(tab: TabId, event: LogData): void {
    const points = event.points as LogData[] | undefined;
    const point = points?.[0];
    if (!point) return;
    this.hoverFlag[tab] = true;
    this.hoverInfo[tab] = {
      binLabel: point.x,
      binVal: point.y,
      posX: numberValue((event.event as LogData | undefined)?.clientX),
      posY: numberValue((event.event as LogData | undefined)?.clientY),
      signal: (point.data as LogData | undefined)?.marker
        ? ((point.data as LogData).marker as LogData).text
        : undefined,
    };
    this.updateHoverPopup(tab);
  }

  private onUnhover(tab: TabId): void {
    this.hoverFlag[tab] = false;
    setStyle(this.ctx.document.querySelector(`#${tab} .agcPlotArea .hoverinfo`), 'display', 'none');
  }

  private updateHoverPopup(tab: TabId): void {
    const host = this.ctx.document.querySelector(`#${tab} .agcPlotArea .hoverinfo`);
    if (!host) return;
    if (!this.hoverFlag[tab]) {
      setStyle(host, 'display', 'none');
      return;
    }
    const info = this.hoverInfo[tab];
    host.innerHTML = `<p>${escapeHTML(String(info.signal ?? ''))} ${escapeHTML(String(info.binLabel ?? ''))} - ${formatNumber(this.ctx, info.binVal, 3, tab)}</p>`;
    setStyle(host, 'display', 'block');
  }
}
