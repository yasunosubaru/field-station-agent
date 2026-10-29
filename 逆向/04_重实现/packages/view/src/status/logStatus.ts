import {
  MSG_ID,
  escapeHTML,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  setStyle,
  setText,
  showRag,
  tabOf,
  updateFields,
  type LogData,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import type { TabId } from '../types.ts';

export class LogStatus {
  readonly fileMessageList: Record<TabId, string[]> = {};
  readonly tempFileMessageList: Record<TabId, string[]> = {};
  readonly fileStatus: Record<TabId, { isFileOpen: boolean; fileStatusEnum?: number | string }> = {};
  readonly loggingRAGIndicatorColor: Record<TabId, string | undefined> = {};
  private readonly ctx: StatusContext;
  private readonly markRag: (tab: TabId, msgId: number) => void;

  constructor(
    ctx: StatusContext,
    markRag: (tab: TabId, msgId: number) => void = () => {},
  ) {
    this.ctx = ctx;
    this.markRag = markRag;
  }

  updateLogStatus(msgID: number, input: unknown): number {
    if (msgID !== MSG_ID.FILESTATUS) return 0;
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    this.markRag(tab, msgID);
    const generation = this.ctx.features(tab).generation;
    const local = this.ctx.localFileLoggingInfo?.(tab);
    if (local?.status === true) {
      this.updateLocalFileData(tab, local);
      return 1;
    }
    if (generation === 'GIII') {
      this.fileStatus[tab] = { isFileOpen: true, fileStatusEnum: data.fileStatusEnum };
      return this.showOff(tab, data);
    }
    const status = data.fileStatusEnum ?? data.fileStatus ?? data.filestatus;
    const numeric =
      typeof status === 'number'
        ? status
        : ({
            UNMOUNTED: 1,
            MOUNTED: 2,
            BUSY: 3,
            ERROR: 4,
            UNMOUNTING: 5,
            MOUNTING: 6,
          } as Record<string, number>)[String(status)] ?? Number(status);
    const open =
      generation === 'OEM7'
        ? [1, 4, 6].includes(numeric)
        : generation === 'OEM6'
          ? [0, 2, 3].includes(numeric)
          : false;
    this.fileStatus[tab] = { isFileOpen: open, fileStatusEnum: status as number | string };
    const enabled =
      this.ctx.features(tab).loggingComponent &&
      (this.tempFileMessageList[tab]?.length ?? 0) > 0;
    if (!open || !enabled) return this.showOff(tab, data);

    const rag =
      generation === 'OEM7' && numeric === 1
        ? 'good'
        : generation === 'OEM6' && numeric === 0
          ? 'good'
          : 'bad';
    this.loggingRAGIndicatorColor[tab] = rag;
    showRag(this.ctx, tab, 'logStatus', rag);
    const title = this.ctx.document.querySelector(`#${tab} .logging-pc-title`);
    if (title) title.textContent = this.ctx.translate('LOGGING');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-logging-config`), 'display', 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-size`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-name`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-messages`), 'display', 'block');
    const prefix = generation === 'GIII' ? '#giii-' : '#';
    setText(this.ctx, tab, `${prefix}logStatusfilestatus`, __(this.ctx, 'ACTIVE'));
    setText(this.ctx, tab, `${prefix}logStatusfilename`, String(data.fileName ?? data.filename ?? '--'));
    setText(
      this.ctx,
      tab,
      `${prefix}logStatusfilesize`,
      `${formatNumber(this.ctx, Math.round(numberValue(data.fileSize) * 0.001), 0, tab)} KB`,
    );
    setText(this.ctx, tab, '#statusBarlogging', __(this.ctx, 'ACTIVE'));
    updateFields(this.ctx, tab, 'logStatus', 'filestatus,filename,filesize', {
      tab,
      filestatus: __(this.ctx, 'ACTIVE'),
      filename: data.fileName ?? data.filename,
      filesize: `${formatNumber(this.ctx, Math.round(numberValue(data.fileSize) * 0.001), 0, tab)} KB`,
    });
    return 1;
  }

  updateData(msgID: number, input: unknown): number {
    if (msgID !== MSG_ID.LOGLIST) return 0;
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    this.markRag(tab, msgID);
    const rows = rowsOf(data);
    const local = this.ctx.localFileLoggingInfo?.(tab);
    const localActive = local?.status === true;
    const connected = this.ctx.connectedPortName?.(tab);
    const messages: string[] = [];
    for (const row of rows) {
      const id = String(row.message ?? '');
      if (id === '94' || id === '1537') continue;
      if (localActive) {
        if (String(row.port) !== `${connected ?? ''}_29`) continue;
      } else if (row.port !== 'FILE') {
        continue;
      }
      const type = numberValue(row.messageType);
      messages.push(type === 1 || type === 33 || type === 65 ? `${id}_1` : id);
    }
    this.fileMessageList[tab] = [...new Set(messages)];
    if (!this.ctx.features(tab).loggingComponent) {
      if (localActive) {
        this.updateLocalFileData(tab, local!);
      } else {
        this.showOff(tab, data);
      }
    }
    const previous = this.tempFileMessageList[tab] ?? [];
    const prefix = this.ctx.features(tab).isGIII ? 'giii-' : '';
    const list = this.ctx.document.querySelector(`#${tab} #${prefix}logStatus-msg-list`);
    if (list) {
      list.innerHTML = this.fileMessageList[tab]
        .sort()
        .map(
          (name) =>
            `<li class="value msg-list-item" id="${escapeHTML(this.ctx.messageName(name, tab))}-msg-listitem"><span class="value">${escapeHTML(this.ctx.messageName(name, tab))}</span></li>`,
        )
        .join('');
    }
    this.tempFileMessageList[tab] = [...this.fileMessageList[tab]];
    return previous.length === messages.length ? 0 : messages.length;
  }

  loggingRAGColor(tab: TabId): string | undefined {
    return this.loggingRAGIndicatorColor[tab];
  }

  resetData(tab: TabId): void {
    delete this.fileMessageList[tab];
    delete this.tempFileMessageList[tab];
    delete this.fileStatus[tab];
    delete this.loggingRAGIndicatorColor[tab];
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      { selector: '[data-lang-logging]', value: __(this.ctx, 'LOGGING') },
      { selector: '[data-lang-log-status]', value: __(this.ctx, 'LOGGING_OFF') },
      { selector: '[data-lang-why-this-red]', value: __(this.ctx, 'WHY_IS_THIS_RED') },
      { selector: '[data-lang-switch-on-via-configuration]', value: __(this.ctx, 'SWITCH_ON_VIA_CONFIGURATION') },
      { selector: '[data-lang-log-file-size]', value: __(this.ctx, 'LOG_FILE_SIZE') },
      { selector: '[data-lang-log-file-name]', value: __(this.ctx, 'LOG_FILE_NAME') },
      { selector: '[data-lang-messages]', value: __(this.ctx, 'MESSAGES') },
      { selector: '[data-lang-need-help]', value: __(this.ctx, 'NEED_HELP') },
      { selector: '[data-lang-error]', value: __(this.ctx, 'ERROR') },
      { selector: '[data-lang-good]', value: __(this.ctx, 'GOOD') },
      { selector: '[data-lang-warning]', value: __(this.ctx, 'WARNING') },
      { selector: '[data-lang-idle]', value: __(this.ctx, 'IDLE') },
    ]);
  }

  private showOff(tab: TabId, data: LogData): number {
    this.loggingRAGIndicatorColor[tab] = 'idle';
    showRag(this.ctx, tab, 'logStatus', 'idle');
    const title = this.ctx.document.querySelector(`#${tab} .logging-pc-title`);
    if (title) title.textContent = this.ctx.translate('LOGGING_OFF');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-logging-config`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-size`), 'display', 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-name`), 'display', 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-messages`), 'display', 'none');
    setText(this.ctx, tab, '#statusBarlogging', __(this.ctx, 'INACTIVE'));
    return updateFields(this.ctx, tab, 'logStatus', 'filestatus,filename,filesize', {
      tab,
      filestatus: '',
      filename: '',
      filesize: '',
      fileStatusEnum: data.fileStatusEnum,
    });
  }

  private updateLocalFileData(tab: TabId, info: LogData): void {
    this.loggingRAGIndicatorColor[tab] = 'good';
    showRag(this.ctx, tab, 'logStatus', 'good');
    const title = this.ctx.document.querySelector(`#${tab} .logging-pc-title`);
    if (title) title.textContent = this.ctx.translate('LOGGING');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-logging-config`), 'display', 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-size`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-file-name`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .log-messages`), 'display', 'block');
    const prefix = this.ctx.features(tab).isGIII ? 'giii-' : '';
    setText(this.ctx, tab, `#${prefix}logStatusfilesize`, String(info.fileSize ?? ''));
    setText(this.ctx, tab, `#${prefix}logStatusfilename`, String(info.fileName ?? ''));
    setText(this.ctx, tab, '#statusBarlogging', this.ctx.translate('ACTIVE'));
    const list = this.ctx.document.querySelector(`#${tab} #${prefix}logStatus-msg-list`);
    if (list && Array.isArray(info.messagesList)) {
      list.innerHTML = (info.messagesList as unknown[])
        .map(String)
        .sort()
        .map(
          (name) =>
            `<li class="value msg-list-item" id="${escapeHTML(name)}-msg-listitem"><span class="value">${escapeHTML(name)}</span></li>`,
        )
        .join('');
    }
  }
}
