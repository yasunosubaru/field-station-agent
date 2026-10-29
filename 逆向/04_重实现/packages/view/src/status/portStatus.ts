import {
  MSG_ID,
  escapeHTML,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  showRag,
  tabOf,
  removeMarkers,
  setStyle,
  setText,
  updateFields,
  type LogData,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import { cssEscape } from '../minidom.ts';
import type { TabId } from '../types.ts';

interface PortEntry {
  interfacemode: Record<string, LogData>;
  configuredPorts: Record<string, LogData>;
  portStats: Record<string, LogData>;
  logList: Record<string, LogData>;
}

function sortAlphaNum(a: string, b: string): number {
  const lettersA = a.replace(/[^a-zA-Z]/g, '');
  const lettersB = b.replace(/[^a-zA-Z]/g, '');
  if (lettersA !== lettersB) return lettersA > lettersB ? 1 : -1;
  const numberA = Number.parseInt(a.replace(/[^0-9]/g, ''), 10);
  const numberB = Number.parseInt(b.replace(/[^0-9]/g, ''), 10);
  return numberA === numberB ? 0 : numberA > numberB ? 1 : -1;
}

export class PortStatus {
  readonly portStatusObj: Record<TabId, PortEntry> = {};
  readonly previousPortStatsData: Record<TabId, Record<string, LogData>> = {};
  readonly ChangedPortStatsData: Record<TabId, Record<string, { port: string; rx: boolean; tx: boolean }>> = {};
  readonly rxDataList: Record<TabId, string[]> = {};
  readonly bufferOverflowList: Record<TabId, string[]> = {};
  readonly supportedPortList: Record<TabId, string[]> = {};
  readonly configuredPortList: Record<TabId, string[]> = {};
  readonly rag: Record<TabId, string> = {};
  private readonly ctx: StatusContext;

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  updateStatus(msgID: number, input: unknown): number {
    if (msgID !== MSG_ID.PORTSTATS) return 0;
    const data = normalizeLog(input);
    const tab = tabOf(data);
    const fields = this.ctx.componentFields('portStatus', msgID) ?? 'port,rxChars,txChars';
    const written = updateFields(this.ctx, tab, 'portStatus', fields, data);
    return this.renderStats(tab, data) + written;
  }

  updateData(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    if (msgID === MSG_ID.INTERFACEMODE) {
      const port = typeof data.port === 'string' ? data.port : `PORT${String(data.port)}`;
      const supported = (this.supportedPortList[tab] ??= []);
      if (!/(SCOM|CCOM|FILE|WCOM)/.test(port)) {
        if (!supported.includes(port)) {
          const features = this.ctx.features(tab);
          const model = features.model;
          const noSupportCom6 = port === 'COM6' && !model.startsWith('OEM638');
          const noSupportCom4And5 =
            (port === 'COM4' || port === 'COM5') &&
            (model.startsWith('PwrPak7') ||
              model.startsWith('PwrPak7D') ||
              features.isMarinePak);
          const hiddenMarinePort =
            features.isMarinePak &&
            (port.startsWith('USB') || port === this.ctx.connectedPortName?.(tab));
          if (
            (data.rxType !== 'NONE' || data.txType !== 'NONE') &&
            !noSupportCom6 &&
            !noSupportCom4And5 &&
            !hiddenMarinePort
          ) {
            state.interfacemode[port] = { ...data, port };
            supported.push(port);
          }
        } else if (data.rxType === 'NONE' && data.txType === 'NONE') {
          delete state.interfacemode[port];
          const index = supported.indexOf(port);
          if (index >= 0) supported.splice(index, 1);
        } else {
          state.interfacemode[port].rxType = data.rxType;
          state.interfacemode[port].txType = data.txType;
        }
      }
      if (data.sequence !== undefined && numberValue(data.sequence) !== 0) return 1;
      this.updateConfiguredPorts(tab);
      return 1;
    }
    if (msgID === MSG_ID.PORTSTATS) return this.renderStats(tab, data);
    if (msgID === MSG_ID.RXSTATUS) {
      return this.handleRxStatus(tab, data);
    }
    if (msgID === MSG_ID.LOGLIST || msgID === MSG_ID.SERIALCONFIG) {
      state.logList[msgID === MSG_ID.LOGLIST ? 'liste' : 'serial'] = { ...data };
      return 1;
    }
    return 0;
  }

  deletePortStatusData(tab: TabId): void {
    delete this.supportedPortList[tab];
    delete this.configuredPortList[tab];
    delete this.bufferOverflowList[tab];
  }

  resetData(tab: TabId): void {
    this.deletePortStatusData(tab);
    delete this.portStatusObj[tab];
    delete this.previousPortStatsData[tab];
    delete this.ChangedPortStatsData[tab];
    delete this.rxDataList[tab];
    delete this.rag[tab];
  }

  ragColor(tab: TabId): string | undefined {
    return this.rag[tab];
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['ports-status', 'PORTS_OFF'], ['port', 'PORT'], ['input', 'INPUT'], ['output', 'OUTPUT'],
      ['why-this-amber', 'WHY_IS_THIS_AMBER'], ['why-this-red', 'WHY_IS_THIS_RED'],
      ['switch-on-via-configuration', 'SWITCH_ON_VIA_CONFIGURATION'], ['need-help', 'NEED_HELP'],
      ['portstatus-compred', 'PORTSTATUS-COMPRED'], ['portstatus-compamber', 'PORTSTATUS-COMPAMBER'],
      ['active', 'ACTIVE'], ['nodata', 'NODATA'], ['idle', 'IDLE'], ['good', 'GOOD'],
      ['warning', 'WARNING'], ['error', 'ERROR'],
    ];
    applyLanguageMarkers(this.ctx, [
      ...keys.map(([marker, key]) => ({ selector: `[data-lang-${marker}]`, value: __(this.ctx, key) })),
      { selector: '[data-lang-title-portstatus-compred]', value: `${__(this.ctx, 'PORTS')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}` },
      { selector: '[data-lang-title-portstatus-compamber]', value: `${__(this.ctx, 'PORTS')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}` },
    ]);
  }

  private renderStats(tab: TabId, data: LogData): number {
    if (!tab) return 0;
    const state = this.ensure(tab);
    const list = this.ctx.document.querySelector(`#${tab} #port-dynamic-list`);
    if (!list || list.children.length === 0) return 0;
    const rows = rowsOf(data);
    if (!rows.length && Object.prototype.hasOwnProperty.call(data, 'port')) rows.push(data);
    const previous = this.previousPortStatsData[tab] ?? {};
    const previousPorts = Object.keys(previous);
    const changed: Record<string, { port: string; rx: boolean; tx: boolean }> = {};
    const current: Record<string, LogData> = {};
    for (const row of rows) {
      const port = typeof row.port === 'string' ? row.port : `PORT${String(row.port)}`;
      current[port] = { ...row, port };
    }
    const currentPorts = Object.keys(current);
    for (let index = 0; index < rows.length; index += 1) {
      const row = current[currentPorts[index]];
      const old = previous[previousPorts[index]];
      const port = String(row?.port ?? '');
      if (
        row &&
        port &&
        old &&
        !/(SCOM|CCOM|FILE|WCOM)/.test(port) &&
        (numberValue(row.rxChars) > numberValue(old.rxChars) ||
          numberValue(row.txChars) > numberValue(old.txChars))
      ) {
        changed[port] = {
          port,
          rx: numberValue(row.rxChars) > numberValue(old.rxChars),
          tx: numberValue(row.txChars) > numberValue(old.txChars),
        };
      }
    }
    state.portStats = current;
    this.previousPortStatsData[tab] = current;
    this.ChangedPortStatsData[tab] = changed;
    this.rxDataList[tab] = Object.keys(changed).filter((port) => changed[port].rx);
    this.refreshStats(tab);
    return Object.keys(current).length;
  }

  private handleRxStatus(tab: TabId, data: LogData): number {
    const state = this.ensure(tab);
    const overflows = this.bufferOverflowList[tab] ?? [];
    const rows = rowsOf(data, 'portsRxData');
    for (const row of rows) {
      const port = String(row.port ?? '');
      if (!state.interfacemode[port]) continue;
      if (numberValue(row.bits) === 1 && !overflows.includes(port)) overflows.push(port);
      else if (numberValue(row.bits) !== 1) {
        const at = overflows.indexOf(port);
        if (at >= 0) overflows.splice(at, 1);
      }
    }
    this.bufferOverflowList[tab] = overflows;
    this.refreshStats(tab);
    this.rag[tab] = overflows.length ? 'bad' : this.rag[tab] ?? 'idle';
    showRag(this.ctx, tab, 'portStatus-comp', this.rag[tab]);
    return rows.length;
  }

  private rebuildRows(tab: TabId): void {
    this.updateConfiguredPorts(tab);
  }

  private updateConfiguredPorts(tab: TabId): void {
    const state = this.ensure(tab);
    const list = this.ctx.document.querySelector(`#${tab} #port-dynamic-list`);
    if (!list) return;
    state.configuredPorts = Object.fromEntries(
      Object.keys(state.interfacemode).map((port) => [port, { port }]),
    );
    if (
      this.configuredPortList[tab]?.length &&
      list.children.length === 0
    ) {
      delete this.configuredPortList[tab];
    }
    const configured = (this.configuredPortList[tab] ??= []);
    for (const port of Object.keys(state.configuredPorts)) {
      if (!configured.includes(port) && !(this.rxDataList[tab] ?? []).includes(port)) {
        configured.push(port);
        this.insertPortRow(tab, port);
      }
    }
    for (let index = 0; index < configured.length; index += 1) {
      const port = configured[index];
      if (!state.configuredPorts[port]) {
        this.removePortRow(tab, port);
        configured.splice(index, 1);
      }
    }
    this.sortPortRows(tab);
    setStyle(this.ctx.document.querySelector(`#${tab} #port-status-layout .titles`), 'display', list.children.length ? 'block' : 'none');
    if (!list.children.length && (this.rxDataList[tab] ?? []).length === 0) {
      this.rag[tab] = 'idle';
      showRag(this.ctx, tab, 'portStatus-comp', 'idle');
      setStyle(this.ctx.document.querySelector(`#${tab} .switch-ports-config`), 'display', 'block');
      setText(this.ctx, tab, '.ports-pc-title', this.ctx.translate('PORTS_OFF'));
      list.innerHTML = '';
    }
  }

  private insertPortRow(tab: TabId, port: string): void {
    const list = this.ctx.document.querySelector(`#${tab} #port-dynamic-list`);
    const mode = this.ensure(tab).interfacemode[port];
    if (!list || !mode) return;
    const input = mode.rxType === 'NONE' ? 'grey-status elidedText" data-lang-idle>Idle' : 'yellow-status elidedText" data-lang-nodata>No Data';
    const output = mode.txType === 'NONE' ? 'grey-status elidedText" data-lang-idle>Idle' : 'yellow-status elidedText" data-lang-nodata>No Data';
    list.innerHTML +=
      `<div class="row com-ports" id="${escapeHTML(port)}-status-li"><div class="title col-md-6 col-sm-6 col-xs-6"><span>${escapeHTML(port)}</span></div>` +
      `<div class="col-md-3 col-sm-3 col-xs-3"><div class="ports-status port-input-status ${input.replace('>', ` id="${escapeHTML(port)}-port-input">`)}</div></div>` +
      `<div class="col-md-3 col-sm-3 col-xs-3"><div class="ports-status port-output-status ${output.replace('>', ` id="${escapeHTML(port)}-port-output">`)}</div></div></div>`;
  }

  private removePortRow(tab: TabId, port: string): void {
    this.ctx.document.querySelector(`#${tab} #${cssEscape(port)}-status-li`)?.remove();
  }

  private sortPortRows(tab: TabId): void {
    const list = this.ctx.document.querySelector(`#${tab} #port-dynamic-list`);
    if (!list) return;
    const rows = [...list.children].sort((a, b) =>
      sortAlphaNum(a.id.replace(/-status-li$/, ''), b.id.replace(/-status-li$/, '')),
    );
    for (const row of rows) list.appendChild(row);
  }

  private refreshStats(tab: TabId): void {
    const state = this.ensure(tab);
    const changed = this.ChangedPortStatsData[tab] ?? {};
    const overflow = this.bufferOverflowList[tab] ?? [];
    const configured = this.configuredPortList[tab] ?? [];
    const changedPorts = Object.keys(changed);
    for (const port of configured) {
      const mode = state.interfacemode[port];
      if (!mode) continue;
      const isChanged = changed[port];
      const rx = overflow.includes(port) ? 'red' : isChanged?.rx ? 'green' : mode.rxType === 'NONE' ? 'grey' : 'yellow';
      const tx = overflow.includes(port) ? 'red' : isChanged?.tx ? 'green' : mode.txType === 'NONE' ? 'grey' : 'yellow';
      this.setPortIndicator(tab, port, 'input', rx);
      this.setPortIndicator(tab, port, 'output', tx);
      const title = this.ctx.document.querySelector(`#${tab} #${cssEscape(port)}-status-li .title`);
      const stats = state.portStats[port];
      if (title && stats) {
        let counter = title.querySelector('.port-counters');
        if (!counter) {
          counter = this.ctx.document.createElement('span');
          counter.className = 'port-counters';
          title.appendChild(counter);
        }
        counter.textContent = ` ${formatNumber(this.ctx, stats.rxChars ?? 0, 0, tab)}/${formatNumber(this.ctx, stats.txChars ?? 0, 0, tab)}`;
      }
    }
    if (changedPorts.length === 0) {
      for (const port of this.rxDataList[tab] ?? []) this.removePortRow(tab, port);
      this.rxDataList[tab] = [];
    }
    if (overflow.length) {
      this.rag[tab] = 'bad';
    } else if (changedPorts.length) {
      const yellow = this.ctx.document.querySelectorAll(`#${tab} .port-input-status.yellow-status`).length / 2 +
        this.ctx.document.querySelectorAll(`#${tab} .port-output-status.yellow-status`).length / 2;
      this.rag[tab] = yellow > 0 ? 'warning' : 'good';
      setStyle(this.ctx.document.querySelector(`#${tab} .switch-ports-config`), 'display', 'none');
      setText(this.ctx, tab, '.ports-pc-title', this.ctx.translate('PORTS'));
    } else {
      this.rag[tab] = 'warning';
      setStyle(this.ctx.document.querySelector(`#${tab} .switch-ports-config`), 'display', 'none');
      setText(this.ctx, tab, '.ports-pc-title', this.ctx.translate('PORTS'));
    }
    showRag(this.ctx, tab, 'portStatus-comp', this.rag[tab]);
  }

  private setPortIndicator(tab: TabId, port: string, direction: 'input' | 'output', colour: string): void {
    const element = this.ctx.document.querySelector(
      `#${tab} #${cssEscape(port)}-port-${direction}`,
    );
    if (!element) return;
    element.classList.remove('yellow-status', 'red-status', 'green-status', 'grey-status');
    element.classList.add(colour + '-status');
    removeMarkers(element, ['data-lang-nodata', 'data-lang-idle', 'data-lang-active', 'data-lang-error']);
    const label = colour === 'green' ? 'ACTIVE' : colour === 'red' ? 'ERROR' : colour === 'grey' ? 'IDLE' : 'NODATA';
    element.setAttribute(`data-lang-${label.toLowerCase()}`, '');
    element.textContent = this.ctx.translate(label);
  }

  private ensure(tab: TabId): PortEntry {
    return (this.portStatusObj[tab] ??= {
      interfacemode: {},
      configuredPorts: {},
      portStats: {},
      logList: {},
    });
  }
}
