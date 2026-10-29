import type { TabId } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, setVisible } from './base.ts';

export const EXPORT_MSG = {
  FILE_STATUS: 2127,
  FILE_LIST: 2100,
  FILE_SYSTEM_STATUS: 2104,
  FILE_SYSTEM_CAPACITY: 2137,
  IP_SERVICE: 1575,
  FILE_TRANSFER_STATUS: 2101,
  IP_STATUS: 1289,
  FILE_DELETE: 2190,
  FILE_TRANSFER: 2109,
} as const;

export interface ExportTransferState {
  selected: string[];
  all: boolean;
  index: number;
  active: boolean;
  responses: number[];
}

/** `deviceExport.js:210-710`; FTP package work is delegated to the operations host. */
export class DeviceExportPage extends BaseConfigPage {
  private readonly selected = new Map<TabId, Set<string>>();
  private readonly transfer = new Map<TabId, ExportTransferState>();
  private readonly deleteResponses = new Map<TabId, number[]>();
  private readonly activeFileName = new Map<TabId, string>();
  private readonly nativeNeeds = new Map<TabId, string[]>();
  private readonly refreshTimers = new Map<TabId, number>();
  private readonly refreshRequired = new Map<TabId, boolean>();
  private readonly selectAllActive = new Map<TabId, boolean>();
  private readonly deleteAllPending = new Map<TabId, boolean>();
  private readonly partialRecords = new Map<string, Record<string, unknown>[]>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'deviceExport',
      fragmentPath: './../deviceExport/deviceExport.html',
      containerId: (tab) => `deviceExport-layout_${tab}`,
    });
  }

  override mount(tab: TabId, containerId = `deviceExport-layout_${tab}`): boolean {
    const container = this.context.document.getElementById(containerId);
    if (!container) return false;
    container.innerHTML = this.context.fragments.load(this.fragmentPath);
    this.bindActions(tab, container);
    setVisible(this.context.document.querySelector(`#${tab} .active-log-layout`), false);
    this.resetDeviceExportUI(tab);
    return true;
  }

  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    for (const row of container.querySelectorAll('.available-logs-list li.device-export-row')) {
      row.addEventListener('click', () => {
        const name = row.id.replace(/^li-/, '');
        this.toggleFile(tab, name);
      });
    }
    container.querySelector('#select-unselect-logs')?.addEventListener('click', () => {
      this.toggleSelectAll(tab);
    });
    container.querySelector('.delete-image-btn')?.addEventListener('click', () => {
      this.confirmDelete(tab);
    });
    container.querySelector('.usb-image-btn')?.addEventListener('click', () => {
      this.copyToUsb(tab);
    });
    container.querySelector('.download-image-btn')?.addEventListener('click', () => {
      void this.downloadSelected(tab);
    });
    container.querySelector('.active-log-edit')?.addEventListener('click', () => {
      this.openLoggingConfig(tab);
    });
  }

  openLoggingConfig(tab: TabId): void {
    this.context.openConfigPage?.(tab, 'logging');
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    if (msgId === EXPORT_MSG.FILE_LIST) {
      const source = this.recordsForFrame(tab, msgId, data);
      if (!source.length && sequenceOf(data) !== 0) return;
      const active = this.activeFileName.get(tab) ?? '';
      const filtered: Record<string, unknown>[] = [];
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const row = source[index];
        if (!row || typeof row !== 'object') continue;
        const record = row as Record<string, unknown>;
        if (record.fileType === 'FILE' && record.fileName !== active) filtered.push(record);
      }
      this.state.updateCurrent(tab, msgId, filtered);
      if (this.refreshRequired.get(tab) === true) {
        this.refreshRequired.set(tab, false);
        this.state.snapshot(tab);
        this.renderFileList(tab);
        const timer = this.refreshTimers.get(tab);
        if (timer !== undefined) this.context.clock.clearInterval(timer);
        this.refreshTimers.delete(tab);
      }
    } else if (msgId === EXPORT_MSG.IP_SERVICE) {
      const source = this.recordsForFrame(tab, msgId, data);
      if (!source.length && sequenceOf(data) !== 0) return;
      const out: Record<string, unknown> = {};
      for (const row of source) {
        if (row && typeof row === 'object') {
          const record = row as Record<string, unknown>;
          out[String(record.ipService ?? '')] = record;
        }
      }
      this.state.updateCurrent(tab, msgId, out);
    } else if (msgId === EXPORT_MSG.FILE_SYSTEM_STATUS) {
      const source = this.recordsForFrame(tab, msgId, data);
      if (!source.length && sequenceOf(data) !== 0) return;
      const out: Record<string, unknown> = {};
      for (const row of source) {
        if (row && typeof row === 'object') {
          const record = row as Record<string, unknown>;
          out[String(record.massStorageDevice ?? '')] = record;
        }
      }
      this.state.updateCurrent(tab, msgId, out);
    } else if (msgId === EXPORT_MSG.IP_STATUS) {
      this.state.updateCurrent(tab, msgId, parseIpStatus(data));
    } else if (msgId === EXPORT_MSG.FILE_STATUS || msgId === EXPORT_MSG.FILE_TRANSFER_STATUS) {
      this.state.updateCurrent(tab, msgId, normalizeRecord(data));
    } else {
      this.state.updateCurrent(tab, msgId, data);
    }
    if (msgId === EXPORT_MSG.FILE_STATUS) {
      this.activeFileName.set(tab, data.fileStatusEnum === 1 ? String(data.fileName ?? '') : '');
      this.renderActiveFile(tab, data);
    } else if (msgId === EXPORT_MSG.FILE_TRANSFER_STATUS) {
      this.handleTransferStatus(tab, data);
    }
    this.renderAvailability(tab);
  }

  dc_updateData(msgId: number, data: Record<string, unknown>): void {
    this.updateData(msgId, data);
  }

  files(tab: TabId): Record<string, unknown>[] {
    return (this.state.current(tab)[String(EXPORT_MSG.FILE_LIST)] as Record<string, unknown>[] | undefined) ?? [];
  }

  selectedFiles(tab: TabId): string[] {
    return [...(this.selected.get(tab) ?? new Set<string>())];
  }

  select(tab: TabId, files: string[]): void {
    this.selected.set(tab, new Set(files));
    this.renderSelection(tab);
  }

  toggleFile(tab: TabId, file: string): void {
    const set = this.selected.get(tab) ?? new Set<string>();
    if (set.has(file)) set.delete(file);
    else set.add(file);
    this.selectAllActive.set(tab, false);
    this.selected.set(tab, set);
    this.renderSelection(tab);
  }

  toggleSelectAll(tab: TabId): void {
    const current = this.selected.get(tab) ?? new Set<string>();
    const active = this.selectAllActive.get(tab) === true;
    if (active) current.clear();
    else for (const file of this.files(tab)) current.add(String(file.fileName ?? ''));
    this.selectAllActive.set(tab, !active);
    this.selected.set(tab, current);
    this.renderSelection(tab);
  }

  confirmDelete(tab: TabId): void {
    const files = this.selectedFiles(tab);
    if (!files.length) {
      this.showFilesError(tab, 'DELETE', 'DELETE');
      return;
    }
    const all = this.selectAllActive.get(tab) === true || files.length === this.files(tab).length;
    this.context.createDialog(
      {
        title: this.context.translate('DELETELOGCONFIRMATION'),
        titledataLangAttr: 'data-lang-delete-confirmation',
        content: this.context.translate('DELETELOGCONFMSG').replace('%1', '<br> <br>'),
        buttons: [
          {
            text: this.context.translate('YES'),
            dataLang: 'data-lang-yes',
            callback: () => {
              this.context.closeDialog(tab);
              this.deleteLogFiles(files, tab, all);
            },
          },
          {
            text: this.context.translate('NO'),
            dataLang: 'data-lang-no',
            class: 'darkBtn',
            callback: () => this.context.closeDialog(tab),
          },
        ],
      },
      { tab },
    );
  }

  /** R52: `*` plus one command, or 4 ms between individual deletes. */
  deleteLogFiles(files: string[], tab: TabId, all = false): void {
    this.commands.setCurrentFeature(this.name);
    this.deleteResponses.set(tab, []);
    this.deleteAllPending.set(tab, all);
    if (all) {
      this.commands.place(
        this.name,
        'filedelete',
        [{ filename: ['*', 'string'] }],
        tab,
      );
      this.context.clock.setTimeout(() => this.finishDelete(tab, true), 2000);
      return;
    }
    let index = 0;
    const sendNext = (): void => {
      if (index >= files.length) {
        const timeout = this.context.clock.setTimeout(() => this.finishDelete(tab), 3000);
        const poll = this.context.clock.setInterval(() => {
          if (this.deleteResponses.get(tab)?.length === files.length) {
            this.context.clock.clearInterval(poll);
            this.context.clock.clearTimeout(timeout);
            this.context.clock.setTimeout(() => this.finishDelete(tab), 2500);
          }
        }, 500);
        return;
      }
      const filename = files[index++];
      this.commands.place(
        this.name,
        'filedelete',
        [{ filename: [filename, 'string'] }],
        tab,
      );
      this.context.clock.setTimeout(sendNext, 4);
    };
    sendNext();
  }

  onCommandResponse(msgId: number, value: number, tab: TabId): void {
    if (msgId === EXPORT_MSG.FILE_DELETE) {
      const values = this.deleteResponses.get(tab) ?? [];
      values.push(value);
      this.deleteResponses.set(tab, values);
    }
  }

  handleDeviceExportCommandResponse(data: number, tab: TabId): void {
    this.onCommandResponse(EXPORT_MSG.FILE_DELETE, data, tab);
  }

  /** R53: selected files are serialized; each FINISHED response advances the queue. */
  copyToUsb(tab: TabId, all = false): boolean {
    if (!filesCount(this.files(tab))) {
      this.showFilesError(tab, 'COPYTOUSBDEVICE', 'COPY');
      return false;
    }
    if (!this.usbMounted(tab)) {
      this.context.createDialog(
        {
          title: this.context.translate('COPYTOUSBDEVICE'),
          content:
            '<div class="popup-content-header"><div class="usb-fail-img"></div>' +
            `<p data-lang-nousbfound>${this.context.translate('NOUSBFOUND')}</p></div>` +
            `<p data-lang-insertusbmsg>${this.context.translate('INSERTUSBMSG')}</p>`,
          buttons: [
            {
              text: this.context.translate('OK'),
              dataLang: 'data-lang-ok',
              class: 'darkBtn',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
      return false;
    }
    const files = this.selectedFiles(tab);
    all ||=
      this.selectAllActive.get(tab) === true ||
      (files.length > 0 && files.length === this.files(tab).length);
    if (!all && !files.length) {
      this.showFilesError(tab, 'COPYTOUSBDEVICE', 'COPY');
      return false;
    }
    const state: ExportTransferState = {
      selected: all ? [] : files,
      all,
      index: 0,
      active: false,
      responses: [],
    };
    this.transfer.set(tab, state);
    this.commands.setCurrentFeature(this.name);
    this.sendNextTransfer(tab);
    return true;
  }

  private sendNextTransfer(tab: TabId): void {
    const state = this.transfer.get(tab);
    if (!state) return;
    if (!state.all && state.index >= state.selected.length) {
      state.active = false;
      return;
    }
    const filename = state.all ? 'ALL' : state.selected[state.index];
    state.active = true;
    this.commands.place(
      this.name,
      'filetransfer',
      [
        { operation: ['COPY', 'enum', 4] },
        { filename: [filename, 'string'] },
      ],
      tab,
    );
  }

  updateTransferStatus(tab: TabId, status: string): void {
    const state = this.transfer.get(tab);
    if (!state?.active) return;
    if (status === 'FINISHED') {
      state.index += 1;
      if (!state.all && state.index < state.selected.length) {
        this.sendNextTransfer(tab);
      } else {
        state.active = false;
        this.selected.set(tab, new Set());
        this.selectAllActive.set(tab, false);
        this.renderSelection(tab);
        this.showCopySuccess(tab, state.all ? filesCount(this.files(tab)) : state.selected.length);
      }
    } else if (status === 'ERROR' || status === 'CANCELLED') {
      state.active = false;
      if (status === 'ERROR') this.showCopyFailure(tab);
    }
  }

  async downloadSelected(tab: TabId): Promise<void> {
    const files = this.selectedFiles(tab);
    if (!files.length) {
      this.showFilesError(tab, 'DOWNLOAD', 'DOWNLOAD');
      return;
    }
    if (!this.downloadEnabled(tab)) {
      this.context.createDialog(
        {
          title: this.context.translate('FILEDOWNLOAD'),
          content: this.context.translate('FTP_OVER_IP_MSG'),
          buttons: [
            {
              text: this.context.translate('OK'),
              dataLang: 'data-lang-ok',
              class: 'darkBtn',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
      return;
    }
    const ipStatus = this.state.current(tab)[String(EXPORT_MSG.IP_STATUS)] as
      | Record<string, unknown>
      | undefined;
    const ipAddress = String(
      ipStatus?.ipAddress ??
        (ipStatus?.ETHA as Record<string, unknown> | undefined)?.ipAddress ??
        '',
    );
    const filesHost = this.context.operations?.files;
    const directory = await filesHost?.chooseDirectory?.({
      title: this.context.translate('SELECTFOLDER'),
      defaultPath: filesHost.defaultDocuments?.(),
    });
    if (!directory) return;
    const ftp = this.context.operations?.ftp?.download;
    if (!ftp) {
      this.requireNative(tab, 'ftp package');
      return;
    }
    try {
      await ftp(tab, { host: ipAddress, port: 21, user: 'guest', files, directory });
    } catch {
      this.context.createDialog(
        {
          title: this.context.translate('FILEDOWNLOAD'),
          content: this.context.translate('FTPCONNECTIONFAILMSG'),
          buttons: [
            {
              text: this.context.translate('OKAY'),
              dataLang: 'data-lang-okay',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
    }
  }

  resetDeviceExportUI(tab: TabId): void {
    this.selected.set(tab, new Set());
    this.selectAllActive.set(tab, false);
    this.state.snapshot(tab);
    this.refreshRequired.set(tab, true);
    this.renderFileList(tab);
    if (this.files(tab).length) return;
    const timer = this.context.clock.setInterval(() => {
      if (this.files(tab).length) {
        this.context.clock.clearInterval(timer);
        this.refreshTimers.delete(tab);
        this.state.snapshot(tab);
        this.renderFileList(tab);
      }
    }, 400);
    this.refreshTimers.set(tab, timer);
  }

  isDataChanged(tab: TabId): boolean {
    return this.selectedFiles(tab).length > 0 || this.isDirty(tab);
  }

  nativeRequirements(tab: TabId): string[] {
    return [...(this.nativeNeeds.get(tab) ?? [])];
  }

  protected runApply(_tab: TabId): undefined {
    return undefined;
  }

  protected render(tab: TabId): void {
    this.renderFileList(tab);
  }

  override unmount(tab: TabId): void {
    const timer = this.refreshTimers.get(tab);
    if (timer !== undefined) this.context.clock.clearInterval(timer);
    this.refreshTimers.delete(tab);
    this.refreshRequired.delete(tab);
    for (const key of this.partialRecords.keys()) {
      if (key.startsWith(`${tab}:`)) this.partialRecords.delete(key);
    }
    super.unmount(tab);
  }

  private handleTransferStatus(tab: TabId, data: Record<string, unknown>): void {
    if (data.fileTransferStatus === 'TRANSFERRING') return;
    this.updateTransferStatus(tab, String(data.fileTransferStatus ?? ''));
  }

  private recordsForFrame(
    tab: TabId,
    msgId: number,
    data: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const rows = Array.isArray(data.data)
      ? data.data
          .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
          .map(normalizeRecord)
      : [normalizeRecord(data)];
    const sequence = sequenceOf(data);
    const key = `${tab}:${msgId}`;
    const pending = [...(this.partialRecords.get(key) ?? []), ...rows];
    if (sequence !== 0) {
      this.partialRecords.set(key, pending);
      return [];
    }
    this.partialRecords.delete(key);
    return pending;
  }

  private finishDelete(tab: TabId, all = this.deleteAllPending.get(tab) === true): void {
    const responses = this.deleteResponses.get(tab) ?? [];
    const selected = this.selectedFiles(tab);
    const success = new Set<string>();
    for (let index = 0; index < Math.min(selected.length, responses.length); index += 1) {
      if (responses[index] === 1) success.add(selected[index]);
    }
    if (all) {
      for (const node of this.context.document.querySelectorAll(
        `#${tab} .available-logs-list li.device-export-row`,
      )) {
        node.remove();
      }
      this.state.updateCurrent(tab, EXPORT_MSG.FILE_LIST, []);
    } else {
      for (const file of success) {
        this.context.document.querySelector(`#${tab} #li-${cssSafe(file.replace(/\.LOG$/i, ''))}`)?.remove();
      }
    }
    this.selected.set(tab, new Set());
    this.selectAllActive.set(tab, false);
    this.commands.removeFeature(this.name, tab);
    this.deleteAllPending.delete(tab);
    this.renderSelection(tab);
    this.renderAvailability(tab);
  }

  private renderFileList(tab: TabId): void {
    const list = this.context.document.querySelector(`#${tab} .available-logs-list`);
    if (!list) return;
    const rows = this.files(tab);
    list.innerHTML = '';
    for (const row of rows) {
      const name = String(row.fileName ?? '');
      const li = this.context.document.createElement('li');
      li.className = 'device-export-row';
      li.id = `li-${name.replace(/\.LOG$/i, '')}`;
      li.setAttribute('data-file-name', name);
      const label = this.context.document.createElement('div');
      label.className = 'row-label-name col-md-10 col-sm-10 col-xs-10';
      label.textContent = name.replace(/\.LOG$/i, '');
      const size = this.context.document.createElement('div');
      size.className = 'row-label-filesize col-md-2 col-sm-2 col-xs-2';
      size.textContent = bytesToSize(Number(row.fileSize ?? 0));
      li.append(label, size);
      list.appendChild(li);
    }
    for (const row of list.querySelectorAll('li.device-export-row')) {
      const name = row.getAttribute('data-file-name') ?? String(row.id).replace(/^li-/, '');
      row.addEventListener('click', () => this.toggleFile(tab, name));
    }
    this.renderSelection(tab);
    this.renderAvailability(tab);
  }

  private renderSelection(tab: TabId): void {
    const selected = this.selected.get(tab) ?? new Set<string>();
    for (const row of this.context.document.querySelectorAll(`#${tab} .available-logs-list li.device-export-row`)) {
      const name = row.getAttribute('data-file-name') ?? String(row.id).replace(/^li-/, '');
      row.classList.toggle('mode-selected', selected.has(name));
    }
    const checkbox = this.context.document.querySelector(`#${tab} #select-unselect-logs`);
    const all = this.selectAllActive.get(tab) === true;
    checkbox?.classList.toggle('active-select-btn', all || (selected.size > 0 && selected.size === this.files(tab).length));
    checkbox?.classList.toggle(
      'tri-active-select-btn',
      selected.size > 0 && selected.size < this.files(tab).length,
    );
  }

  private renderActiveFile(tab: TabId, data: Record<string, unknown>): void {
    const container = this.context.document.querySelector(`#${tab} .active-log-layout`);
    setVisible(container, data.fileStatusEnum === 1);
    if (data.fileStatusEnum !== 1) return;
    const name = this.context.document.querySelector(`#${tab} .activeLogName`);
    const size = this.context.document.querySelector(`#${tab} .activeLogSize`);
    if (name) name.textContent = String(data.fileName ?? '');
    if (size) size.textContent = bytesToSize(Number(data.fileSize ?? 0));
  }

  private renderAvailability(tab: TabId): void {
    const available = this.files(tab).length > 0;
    setVisible(this.context.document.querySelector(`#${tab} .edit-selection-panel`), available);
    setVisible(
      this.context.document.querySelector(`#${tab} .available-log-layout .device-export-container`),
      available,
    );
    setVisible(this.context.document.querySelector(`#${tab} .nologs-label`), !available);
    setVisible(this.context.document.querySelector(`#${tab} .export-select-label`), available);
    const count = this.context.document.querySelector(`#${tab} .filescount`);
    if (count) count.textContent = `${this.context.translate('FILES')} (${this.files(tab).length})`;
    const download = this.context.document.querySelector(`#${tab} .download-image-btn`);
    if (download) {
      download.classList.toggle('customDisableButtons', !this.downloadEnabled(tab));
      download.removeAttribute('title');
      if (!this.downloadEnabled(tab)) download.setAttribute('title', 'FTP_OVER_IP_MSG');
    }
  }

  private usbMounted(tab: TabId): boolean {
    const status = this.state.current(tab)[String(EXPORT_MSG.FILE_SYSTEM_STATUS)] as
      | Record<string, unknown>
      | undefined;
    const usb = status?.USBSTICK as Record<string, unknown> | undefined;
    return usb?.massStorageStatus === 'MOUNTED';
  }

  private downloadEnabled(tab: TabId): boolean {
    const services = this.state.current(tab)[String(EXPORT_MSG.IP_SERVICE)] as
      | Record<string, unknown>
      | undefined;
    const ftp = services?.FTP_SERVER as Record<string, unknown> | undefined;
    const status = this.state.current(tab)[String(EXPORT_MSG.IP_STATUS)] as
      | Record<string, unknown>
      | undefined;
    const address = String(
      status?.ipAddress ?? (status?.ETHA as Record<string, unknown> | undefined)?.ipAddress ?? '',
    );
    return ftp?.switch === 'ENABLE' && address !== '';
  }

  private showFilesError(tab: TabId, titleKey: string, operationKey: string): void {
    this.context.createDialog(
      {
        title: this.context.translate(titleKey),
        content:
          '<div class="popup-content-header"><div class="usb-fail-img"></div>' +
          '<p data-lang-nologsselected></p></div><p>' +
          `${this.context.translate('LOGFILESCLOSEWINDOWMSG')}${this.context.translate(operationKey)}.</p>`,
        buttons: [
          {
            text: this.context.translate('CLOSE'),
            dataLang: 'data-lang-close',
            class: 'autoWidthBtn',
            callback: () => this.context.closeDialog(tab),
          },
        ],
      },
      { tab },
    );
  }

  private showCopySuccess(tab: TabId, count: number): void {
    this.context.createDialog(
      {
        title: this.context.translate('COPYTOUSBDEVICE'),
        content:
          '<div class="popup-content-header"><div class="usb-success-img"></div>' +
          '<div class="single-line" style="display: flex;"><p data-lang-copytousbsuccessmsg>' +
          `${this.context.translate('COPYTOUSBSUCCESSMSG').replace('%1', String(count))}</p></div></div>`,
        buttons: [
          {
            text: this.context.translate('DONE'),
            dataLang: 'data-lang-done',
            class: 'darkBtn',
            callback: () => this.context.closeDialog(tab),
          },
        ],
      },
      { tab },
    );
  }

  private showCopyFailure(tab: TabId): void {
    this.context.createDialog(
      {
        title: this.context.translate('COPYTOUSBDEVICE'),
        content:
          '<div class="popup-content-header"><div class="usb-fail-img"></div>' +
          '<p data-lang-copyfailed></p></div><p>Copy failed. <br><br>Please try again.</p>',
        buttons: [
          {
            text: this.context.translate('CLOSE'),
            dataLang: 'data-lang-close',
            class: 'darkBtn',
            callback: () => this.context.closeDialog(tab),
          },
        ],
      },
      { tab },
    );
  }

  private requireNative(tab: TabId, requirement: string): void {
    const current = this.nativeNeeds.get(tab) ?? [];
    if (!current.includes(requirement)) current.push(requirement);
    this.nativeNeeds.set(tab, current);
  }
}

export function bytesToSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  let value = bytes / Math.pow(1024, index);
  let unit = index;
  if (sizes[unit] === 'B') {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(value);
  return `${formatted} ${sizes[unit]}`;
}

function cssSafe(value: string): string {
  return value.replace(/[^\w-]/g, '\\$&');
}

function filesCount(files: Record<string, unknown>[]): number {
  return files.length;
}

function sequenceOf(data: Record<string, unknown>): number {
  const header = data.header as Record<string, unknown> | undefined;
  const value = data.sequence ?? header?.sequence ?? 0;
  return Number(value) || 0;
}

function normalizeRecord(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...data };
  for (const field of ['fileName', 'errorMsg']) {
    const value = output[field];
    if (value && typeof value === 'object' && 'value' in value) {
      output[field] = (value as { value?: unknown }).value;
    }
  }
  return output;
}

function parseIpStatus(data: Record<string, unknown>): Record<string, unknown> {
  if (data.ETHA || data.WIFI || data.WIFICLIENT) return data;
  const payload = data.payload;
  if (!(payload instanceof Uint8Array) || payload.byteLength < 4) return data;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint32(0, true);
  let offset = 4;
  const output: Record<string, unknown> = { IpRec: count, tab: data.tab };
  const interfaces: Record<number, string> = { 2: 'ETHA', 10: 'WIFI', 11: 'WIFICLIENT' };
  for (let index = 0; index < count && offset + 4 <= payload.byteLength; index += 1) {
    const name = interfaces[view.getUint32(offset, true)] ?? String(view.getUint32(offset, true));
    offset += 4;
    const values: Record<string, string> = {};
    for (const field of ['ipAddress', 'netmask', 'gateway']) {
      const parsed = readCString(payload, offset);
      values[field] = parsed.value;
      offset = parsed.next;
    }
    output[name] = values;
  }
  return output;
}

function readCString(
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } {
  let value = '';
  let cursor = offset;
  while (cursor < bytes.length && bytes[cursor] !== 0) {
    value += String.fromCharCode(bytes[cursor]);
    cursor += 1;
  }
  if (cursor < bytes.length) cursor += 1;
  return { value, next: Math.ceil(cursor / 4) * 4 };
}
