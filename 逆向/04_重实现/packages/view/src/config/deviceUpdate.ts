import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import { COMMAND_RESPONSE } from './types.ts';
import { BaseConfigPage, addError, clearErrors } from './base.ts';

export const UPDATE_MSG = {
  VERSION: 37,
  SOFTLOAD_STATUS: 1235,
  SOFTLOAD_RESET: 476,
  SOFTLOAD_SREC: 477,
  SOFTLOAD_DATA: 1218,
  SOFTLOAD_COMMIT: 475,
} as const;

export type SoftloadStep =
  | { kind: 'srec'; value: string; record: string }
  | { kind: 'data'; offset: number; data: Uint8Array }
  | { kind: 'commit' };

export interface SoftloadFile {
  name: string;
  text: string;
}

export type LonghornUpdateComponent = 'MAIN' | 'ME1' | 'ME2';

const MAX_DATA_LENGTH = 4088;
const ERROR_STATUS = new Set(Array.from({ length: 20 }, (_, index) => index + 16));

/**
 * `deviceUpdate.js:339-406`: S0/S5/S7 remain individual SOFTLOADSREC records; contiguous S3
 * records are coalesced up to 4088 bytes, and a final SOFTLOADCOMMIT is always appended.
 */
export function parseSoftloadFile(
  text: string,
  generation: string,
): { steps: SoftloadStep[]; isWebContent: boolean } {
  const lines = text.split('\n');
  const steps: SoftloadStep[] = [];
  let isWebContent = false;
  let currentOffset: number | null = null;
  const bytes: number[] = [];

  const flush = (): void => {
    if (currentOffset !== null && bytes.length) {
      steps.push({
        kind: 'data',
        offset: currentOffset,
        data: Uint8Array.from(bytes),
      });
    }
    currentOffset = null;
    bytes.length = 0;
  };

  for (const raw of lines) {
    const record = raw.trim();
    if (!record) continue;
    if (record.startsWith('S0') || record.startsWith('S5') || record.startsWith('S7')) {
      flush();
      if (record.startsWith('S0') && record.includes('DATA4')) isWebContent = true;
      const value =
        (generation === 'OEMSTAR' ? record.padEnd(514) : record) + '\0';
      steps.push({ kind: 'srec', value, record });
      continue;
    }
    if (record.startsWith('S3')) {
      const offset = parseInt(record.slice(4, 12), 16);
      const hex = record.slice(12, -2);
      if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) {
        flush();
        steps.push({ kind: 'srec', value: record + '\0', record });
        continue;
      }
      const dataLength = hex.length / 2;
      const expected = currentOffset === null ? offset : currentOffset + bytes.length;
      if (
        (bytes.length > 0 && expected !== offset) ||
        bytes.length + dataLength > MAX_DATA_LENGTH
      ) {
        flush();
      }
      if (currentOffset === null) currentOffset = offset;
      for (let index = 0; index < hex.length; index += 2) {
        bytes.push(parseInt(hex.slice(index, index + 2), 16));
      }
      continue;
    }
    flush();
    steps.push({ kind: 'srec', value: record + '\0', record });
  }
  flush();
  steps.push({ kind: 'commit' });
  return { steps, isWebContent };
}

export function softloadDataParams(offset: number, data: Uint8Array): ConfigDataMap {
  return [
    { offset: [offset, 'ulong', 4] },
    { data_len: [data.length, 'ulong', 4] },
    { data: [String.fromCharCode(...data), 'novatelchar', data.length] },
  ];
}

export function cropFirmwareFileName(value: string, maxChars = 36, trailing = 9): string {
  if (value.length <= maxChars) return value;
  const front = value.substr(0, value.length - (maxChars - trailing - 3));
  return front + '...' + value.slice(-trailing);
}

export class DeviceUpdatePage extends BaseConfigPage {
  private readonly files = new Map<TabId, SoftloadFile>();
  private readonly steps = new Map<TabId, SoftloadStep[]>();
  private readonly stepIndex = new Map<TabId, number>();
  private readonly inProgress = new Map<TabId, boolean>();
  private readonly webContent = new Map<TabId, boolean>();
  private readonly authCode = new Map<TabId, string>();
  private readonly longhornFiles = new Map<
    TabId,
    Partial<Record<LonghornUpdateComponent, SoftloadFile>>
  >();
  private readonly hostNeeds = new Map<TabId, string[]>();
  private restartHandler: ((tab: TabId) => void) | undefined;

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'deviceUpdate',
      fragmentPath: './../deviceUpdate/deviceUpdate.html',
      containerId: (tab) => `deviceUpdate-layout_${tab}`,
    });
  }

  override mount(tab: TabId, containerId = `deviceUpdate-layout_${tab}`): boolean {
    const container = this.context.document.getElementById(containerId);
    if (!container) return false;
    container.innerHTML = this.context.fragments.load(
      this.context.features(tab).isLongHorn
        ? './../deviceUpdate/lghn-deviceUpdate.html'
        : this.fragmentPath,
    );
    this.bindActions(tab, container);
    return true;
  }

  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    container.querySelector('#deviceUpdateApplyBtn')?.addEventListener('click', () => {
      this.start(tab);
    });
    container.querySelector('#deviceUpdateBrowseBtn')?.addEventListener('click', () => {
      void this.browse(tab);
    });
    for (const [buttonId, component] of [
      ['#lghnDeviceUpdateBrowseBtn', 'MAIN'],
      ['#lghnUpdateEngine1BrowseBtn', 'ME1'],
      ['#lghnUpdateEngine2BrowseBtn', 'ME2'],
    ] as Array<[string, LonghornUpdateComponent]>) {
      container.querySelector(buttonId)?.addEventListener('click', () => {
        void this.browseLonghorn(tab, component);
      });
    }
    container.querySelector('#lghnDeviceUpdateApplyBtn')?.addEventListener('click', () => {
      this.startLonghorn(tab);
    });
  }

  setRestartHandler(handler: (tab: TabId) => void): void {
    this.restartHandler = handler;
  }

  setFile(tab: TabId, file: SoftloadFile): void {
    this.files.set(tab, { ...file });
    this.state.setPending(tab, 'file', 'name', file.name);
  }

  file(tab: TabId): SoftloadFile | undefined {
    return this.files.get(tab);
  }

  setLonghornFile(tab: TabId, component: LonghornUpdateComponent, file: SoftloadFile): void {
    const files = this.longhornFiles.get(tab) ?? {};
    files[component] = { ...file };
    this.longhornFiles.set(tab, files);
    this.state.setPending(tab, 'file', component, file.name);
    const selector =
      component === 'MAIN'
        ? '.update-firmware-1'
        : component === 'ME1'
          ? '.update-engine-1'
          : '.update-engine-2';
    const input = this.context.document.querySelector(`#${tab} ${selector}`) as
      | (Element & { value?: string; title?: string })
      | null;
    if (input) {
      input.value = cropFirmwareFileName(file.name);
      input.title = file.name.length > 36 ? file.name : '';
    }
  }

  longhornFile(tab: TabId, component: LonghornUpdateComponent): SoftloadFile | undefined {
    return this.longhornFiles.get(tab)?.[component];
  }

  private async browseLonghorn(tab: TabId, component: LonghornUpdateComponent): Promise<void> {
    const files = this.context.operations?.files;
    if (!files?.chooseOpenFile || !files.readText) {
      this.requireHost(tab, 'file chooser + FileReader');
      return;
    }
    const selected = await files.chooseOpenFile({
      title: this.context.translate('SELECT_FILE'),
      extensions: component === 'MAIN' ? ['hex', 'shex'] : ['bin'],
    });
    if (!selected) return;
    const text = String(await files.readText(selected));
    const name = selected.split(/[\\/]/).at(-1) ?? selected;
    this.setLonghornFile(tab, component, { name, text });
  }

  private async browse(tab: TabId): Promise<void> {
    const files = this.context.operations?.files;
    if (!files?.chooseOpenFile || !files.readText) {
      this.requireHost(tab, 'file chooser + FileReader');
      return;
    }
    const selected = await files.chooseOpenFile({
      title: this.context.translate('SELECT_FILE'),
      extensions: ['hex', 'shex'],
    });
    if (!selected) return;
    const text = await files.readText(selected);
    const name = selected.split(/[\\/]/).at(-1) ?? selected;
    this.setFile(tab, { name, text: String(text) });
    const input = this.context.document.querySelector(
      `#${tab} .device-update-file-path .input-text-box`,
    ) as
      | (Element & { value?: string; title?: string })
      | null;
    if (input) {
      input.value = cropFirmwareFileName(name);
      input.title = name;
    }
  }

  startLonghorn(tab: TabId): boolean {
    clearErrors(this.context, tab);
    const files = this.longhornFiles.get(tab) ?? {};
    const selected = (['MAIN', 'ME1', 'ME2'] as const).filter((component) => files[component]);
    if (!selected.length) {
      for (const node of this.context.document.querySelectorAll(
        `#${tab} .lghn-device-update-select-file span`,
      )) {
        node.classList.add('error-text');
      }
      for (const node of this.context.document.querySelectorAll(
        `#${tab} .lghn-device-update-file-path .input-text-box`,
      )) {
        node.classList.add('error-border');
      }
      addError(
        this.context,
        tab,
        '.lghn-device-update-file-path',
        'data-lang-select-valid-file',
      );
      return false;
    }
    if (
      (files.MAIN && !/\.shex$/i.test(files.MAIN.name)) ||
      (files.ME1 && !/\.bin$/i.test(files.ME1.name)) ||
      (files.ME2 && !/\.bin$/i.test(files.ME2.name))
    ) {
      addError(
        this.context,
        tab,
        '.lghn-device-update-file-path',
        'data-lang-select-valid-file',
      );
      return false;
    }
    // `lghn-deviceUpdate.js:545-669` constructs UPDATE_BEGIN/UPDATE_DATA/COMPLETE
    // through Edie.pimtpframer_api. There is no JS-only equivalent in the shipped artifact.
    this.requireHost(
      tab,
      'Edie.inputstream_api + Edie.pimtpframer_api(PIMTP UPDATE_BEGIN/UPDATE_DATA)',
    );
    return false;
  }

  start(tab: TabId, file = this.files.get(tab)): boolean {
    clearErrors(this.context, tab);
    if (!file || !/\.(hex|shex)$/i.test(file.name)) {
      addError(this.context, tab, '.device-update-file-path', 'data-lang-select-valid-file');
      return false;
    }
    const parsed = parseSoftloadFile(file.text, this.context.features(tab).generation);
    this.files.set(tab, file);
    this.steps.set(tab, parsed.steps);
    this.stepIndex.set(tab, 0);
    this.inProgress.set(tab, true);
    this.webContent.set(tab, parsed.isWebContent);
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, 30000, 'UPDATING');
    this.context.sendRaw?.(tab, 'unlogall thisport_30 true\n');
    this.context.clock.setTimeout(() => {
      this.context.sendRaw?.(tab, 'log softloadstatusb onchanged\n');
    }, 100);
    this.commands.place(
      this.name,
      'softloadreset',
      [{ reserved: [1, 'ulong', 4] }],
      tab,
    );
    return true;
  }

  handleDeviceUpdateCommandResponse(data: number, tab: TabId): void {
    if (data === COMMAND_RESPONSE.ERROR) {
      this.inProgress.set(tab, false);
      this.context.clock.setTimeout(() => this.context.closeApplyingScreen(tab, 2), 500);
      return;
    }
    if (!this.inProgress.get(tab)) return;
    const steps = this.steps.get(tab) ?? [];
    const index = this.stepIndex.get(tab) ?? 0;
    if (index >= steps.length) return;
    const step = steps[index];
    this.stepIndex.set(tab, index + 1);
    if (step.kind === 'srec') {
      this.commands.place(
        this.name,
        'softloadsrec',
        [
          { srecord: [step.value, 'string'] },
          { reserved: [1, 'ulong', 4] },
        ],
        tab,
      );
    } else if (step.kind === 'data') {
      this.commands.place(this.name, 'softloaddata', softloadDataParams(step.offset, step.data), tab);
    } else {
      this.context.showLoadingScreen(tab, 32000, 'UPDATING');
      this.commands.place(
        this.name,
        'softloadcommit',
        [{ reserved: [1, 'ulong', 4] }],
        tab,
      );
    }
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    this.state.updateCurrent(tab, msgId, data);
    this.render(tab);
    if (msgId !== UPDATE_MSG.SOFTLOAD_STATUS || this.inProgress.get(tab) !== true) return;
    const status = String(data.status ?? '');
    if (status === 'COMPLETE') {
      this.complete(tab);
    } else {
      const numeric = /^\d+$/.test(status)
        ? Number(status)
        : Number(
            Object.entries({
          1: 'NOT_STARTED',
          2: 'READY_FOR_SETUP',
          3: 'READY_FOR_DATA',
          4: 'DATA_VERIFIED',
          5: 'WRITING_FLASH',
          6: 'WROTE_FLASH',
          7: 'WROTE_AUTHCODE',
          8: 'COMPLETE',
          9: 'VERIFYING_DATA',
          10: 'COPIED_SIGNATURE_AUTH',
          11: 'WROTE_TRANSACTION_TABLE',
          16: 'ERROR',
          17: 'RESET_ERROR',
          18: 'BAD_SRECORD',
          19: 'BAD_PLATFORM',
          20: 'BAD_MODULE',
          21: 'BAD_AUTHCODE',
          22: 'NOT_READY_FOR_SETUP',
          23: 'NO_MODULE',
          24: 'NO_PLATFORM',
          25: 'NOT_READY_FOR_DATA',
          26: 'MODULE_MISMATCH',
          27: 'OUT_OF_MEMORY',
          28: 'DATA_OVERLAP',
          29: 'BAD_IMAGE_CRC',
          30: 'IMAGE_OVERSIZE',
          31: 'AUTHCODE_WRITE_ERROR',
          32: 'BAD_FLASH_ERASE',
          33: 'BAD_FLASH_WRITE',
          34: 'TIMEOUT',
          35: 'INCOMPATIBLE_FLASH',
            }).find(([, value]) => value === status)?.[0] ?? -1,
          );
      if (ERROR_STATUS.has(numeric)) {
        this.inProgress.set(tab, false);
        this.context.closeApplyingScreen(tab, 2);
      }
    }
  }

  dc_updateData(msgId: number, data: Record<string, unknown>): void {
    this.updateData(msgId, data);
  }

  handleAuthCodesLogResponse(data: unknown, tab: TabId): void {
    if (!Array.isArray(data)) return;
    const version = this.state.current(tab)[String(UPDATE_MSG.VERSION)] as
      | Record<string, unknown>
      | undefined;
    const currentModel = String(version?.model ?? '');
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const code =
        record.authCodeString && typeof record.authCodeString === 'object'
          ? String((record.authCodeString as Record<string, unknown>).value ?? '')
          : String(record.authCodeString ?? '');
      if (code.split(',').includes(currentModel)) {
        this.authCode.set(tab, code);
        break;
      }
    }
  }

  resetDeviceUpdateUI(tab: TabId): void {
    this.inProgress.set(tab, false);
    this.files.delete(tab);
    this.longhornFiles.delete(tab);
    this.steps.delete(tab);
    this.stepIndex.delete(tab);
    this.reset(tab);
    const input = this.context.document.querySelector(
      `#${tab} .device-update-file-path .input-text-box`,
    ) as
      | (Element & { value?: string })
      | null;
    if (input) input.value = '';
    for (const node of this.context.document.querySelectorAll(
      `#${tab} .lghn-device-update-file-path .input-text-box`,
    )) {
      (node as Element & { value?: string }).value = '';
    }
  }

  isDataChanged(tab: TabId): boolean {
    return this.files.has(tab) || !!this.longhornFiles.get(tab) || this.isDirty(tab);
  }

  progress(tab: TabId): number {
    const total = this.steps.get(tab)?.length ?? 0;
    if (!total) return 0;
    return Math.round(((this.stepIndex.get(tab) ?? 0) / total) * 100);
  }

  hostRequirements(tab: TabId): string[] {
    return [...(this.hostNeeds.get(tab) ?? [])];
  }

  protected runApply(tab: TabId): undefined {
    if (this.context.features(tab).isLongHorn) {
      if (!this.startLonghorn(tab)) this.context.closeApplyingScreen(tab, 2);
    } else {
      this.start(tab);
    }
    return undefined;
  }

  override handleCommandResponse(
    response: number,
    tab: TabId,
    _msgId?: number,
    _error?: string,
  ): void {
    this.handleDeviceUpdateCommandResponse(response, tab);
  }

  protected render(tab: TabId): void {
    const versions = this.state.current(tab)[String(UPDATE_MSG.VERSION)] as
      | Record<string, unknown>
      | undefined;
    if (!versions) return;
    const rows = rowsOfData(versions);
    const gpsCard = rows.find((row) => row.type === 'GPSCARD');
    const webContent = rows.find((row) => row.type === 'DB_WWWISO');
    const firmware = String(gpsCard?.softwareVersion ?? versions.firmwareVersion ?? '');
    const monitor = String(webContent?.softwareVersion ?? versions.softwareVersion ?? '');
    const hardware = this.context.document.querySelector(`#${tab} #deviceUpdatehardwareVersion`);
    const software = this.context.document.querySelector(
      `#${tab} #deviceUpdatesoftwareVersion`,
    );
    if (hardware) hardware.textContent = firmware || '--';
    if (software) software.textContent = monitor || '--';
  }

  private complete(tab: TabId): void {
    this.inProgress.set(tab, false);
    this.context.closeApplyingScreen(tab, 1);
    const features = this.context.features(tab);
    if (
      (features.generation === 'OEM6' && !this.webContent.get(tab)) ||
      features.generation === 'OEMSTAR'
    ) {
      const codes = this.authCode.get(tab);
      if (codes) {
        this.context.sendRaw?.(
          tab,
          `auth add_download ${codes
            .split(',')
            .map((value) => `"${value}"`)
            .join(',')}\n`,
        );
      }
    }
    this.restartHandler?.(tab);
  }

  private requireHost(tab: TabId, value: string): void {
    const current = this.hostNeeds.get(tab) ?? [];
    if (!current.includes(value)) current.push(value);
    this.hostNeeds.set(tab, current);
  }
}

function rowsOfData(data: Record<string, unknown>): Record<string, unknown>[] {
  for (const candidate of [data.data, data.blocks]) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === 'object',
      );
    }
  }
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < 512; index += 1) {
    const row = data[String(index)];
    if (!row || typeof row !== 'object') break;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}
