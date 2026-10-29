import type { TabId } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage } from './base.ts';

export interface TerminalLine {
  text: string;
  linesCount: number;
  rxResponse: boolean;
}

export class TerminalConsolePage extends BaseConfigPage {
  private readonly incomplete = new Map<TabId, string>();
  private readonly commandBuffer = new Map<TabId, string[]>();
  private readonly commandHistory = new Map<TabId, string[]>();
  private readonly responses = new Map<TabId, string>();
  private readonly recording = new Map<TabId, boolean>();
  private readonly recorded = new Map<TabId, string[]>();
  private readonly lineCounter = new Map<TabId, number>();
  private readonly terminalLines = new Map<TabId, TerminalLine[]>();
  private readonly nativeNeeds = new Map<TabId, string[]>();
  private readonly historyIndex = new Map<TabId, number>();
  private readonly loadTimers = new Map<TabId, number>();
  private readonly responseMode = new Map<TabId, boolean>();
  private readonly active = new Map<TabId, boolean>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'terminalConsole',
      fragmentPath: './../terminalConsole/terminalConsole.html',
      containerId: (tab) => `terminalConsole-layout_${tab}`,
    });
  }

  override mount(tab: TabId, containerId = `terminalConsole-layout_${tab}`): boolean {
    const features = this.context.features(tab);
    const path = features.isGIII
      ? './../terminalConsole/giii-terminalConsole.html'
      : features.isLongHorn
        ? './../terminalConsole/lghn-terminalConsole.html'
        : './../terminalConsole/terminalConsole.html';
    const container = this.context.document.getElementById(containerId);
    if (!container) return false;
    container.innerHTML = this.context.fragments.load(path);
    this.bindActions(tab, container);
    return true;
  }

  protected override bindActions(tab: TabId, container: Element): void {
    const input = container.querySelector(
      '#terminal-input-box, #giii-terminal-input-box, #lghn-terminal-input-box',
    ) as
      | (Element & {
          value?: string;
          addEventListener(type: string, fn: (event: Record<string, unknown>) => void): void;
        })
      | null;
    input?.addEventListener('keydown', (event) => {
      const keyCode = Number(event.keyCode);
      if (keyCode === 13 && input.value?.trim()) {
        this.executeCommand(input.value.trim(), tab);
        input.value = '';
      } else if (keyCode === 38) {
        input.value = this.previousCommand(tab) ?? input.value;
      } else if (keyCode === 40) {
        input.value = this.nextCommand(tab) ?? '';
      }
    });
    container.querySelector('#terminal-record')?.addEventListener('click', () => {
      if (this.recording.get(tab)) void this.stopRecording(tab);
      else this.startRecording(tab);
    });
    container.querySelector('#terminal-save')?.addEventListener('click', () => {
      void this.saveOutput(tab);
    });
    container.querySelector('#terminal-load')?.addEventListener('click', () => {
      void this.loadCommands(tab);
    });
    container.querySelector('#terminal-apply')?.addEventListener('click', () => {
      this.applyGiiiState(tab);
    });
  }

  /** R66: command classifies on the sixth character, i.e. `#` immediately after `log `. */
  updateData(logData: string, tab: TabId): void {
    const text = String(logData ?? '');
    const port = this.context.connectedPortName?.(tab) ?? '';
    if (text === `[${port}]`) {
      this.responseMode.set(tab, true);
      const complete = (this.incomplete.get(tab) ?? '') + text;
      this.incomplete.set(tab, '');
      void this.handleDashboard(complete, tab, { recordFlag: false });
      return;
    }
    if (text.startsWith('#')) {
      const sequence = text.split(',')[2];
      if (sequence === '0' || sequence === undefined) {
        this.responseMode.set(tab, true);
        const complete = (this.incomplete.get(tab) ?? '') + text;
        this.incomplete.set(tab, '');
        void this.handleDashboard(complete, tab, { recordFlag: false });
      } else {
        this.incomplete.set(tab, (this.incomplete.get(tab) ?? '') + text);
      }
    } else if (text.startsWith('%') || text.startsWith('$')) {
      this.responseMode.set(tab, true);
      void this.handleDashboard(text, tab, { recordFlag: false });
    } else if (text.startsWith('<OK') || text.startsWith('<ERROR')) {
      this.responseMode.set(tab, true);
      void this.handleDashboard(text, tab, { recordFlag: false });
    } else {
      const pending = (this.incomplete.get(tab) ?? '') + text;
      this.incomplete.set(tab, pending);
      if (pending.split('\r\n').length > 400) {
        this.responseMode.set(tab, true);
        void this.handleDashboard('', tab, { recordFlag: false });
      }
    }
    if (this.recording.get(tab)) this.record(text, tab);
  }

  handleDashboard(
    input: string,
    tab: TabId,
    options: { recordFlag?: boolean } = {},
  ): TerminalLine | undefined {
    let response = input;
    if (response.includes('#LOGR')) {
      const parts = response.split(';');
      const header = parts[0].split(',');
      const port = header[1]?.split('_')[0] ?? '';
      response = '<' + (parts[1]?.split('*')[0] ?? '') + `\n[${port}]`;
      this.responses.set(tab, parts[1]?.split('*')[0] ?? '');
    } else if (response.includes('<OK')) {
      this.responses.set(tab, 'OK');
    } else if (response.includes('<ERROR')) {
      this.responses.set(tab, 'ERROR');
    }

    const count = response.split('\r\n').length;
    const line: TerminalLine = {
      text:
        response.startsWith('Starting')
          ? this.context.translate('STARTINGRECORDING')
          : response.startsWith('Ending')
            ? this.context.translate('ENDINGRECORDING')
            : response,
      linesCount: count > 1 ? count - 1 : 1,
      rxResponse: this.responseMode.get(tab) === true,
    };
    const list = this.context.document.querySelector(`#${tab} ${this.listSelector(tab)}`);
    if (list && this.active.get(tab) !== false) {
      const li = this.context.document.createElement('li');
      li.setAttribute('linesCount', String(line.linesCount));
      li.textContent = line.text;
      if (line.rxResponse) li.classList.add('rxResponse');
      list.appendChild(li);
      this.terminalLines.set(tab, [...(this.terminalLines.get(tab) ?? []), { ...line }]);
      this.lineCounter.set(tab, (this.lineCounter.get(tab) ?? 0) + line.linesCount);
      this.trimLines(tab);
    }
    this.commandBuffer.set(tab, [...(this.commandBuffer.get(tab) ?? []), line.text]);

    if (
      this.responseMode.get(tab) !== true &&
      line.text !== 'Starting Recording' &&
      line.text !== 'Ending Recording'
    ) {
      this.sendCommand(line.text, tab);
      this.updateHistory(line.text, tab);
    }
    this.responseMode.set(tab, false);
    return line;
  }

  executeCommand(command: string, tab: TabId): TerminalLine | undefined {
    this.active.set(tab, true);
    return this.handleDashboard(command.trim(), tab);
  }

  /** R68/R69. */
  sendCommand(command: string, tab: TabId): void {
    if (this.context.features(tab).isLongHorn) {
      const frame = this.context.operations?.native?.longhornTerminalFrame?.(command);
      if (frame) this.context.sendBinary?.(tab, frame);
      else this.requireNative(tab, 'Edie.pimtpframer_api terminal command frame');
      return;
    }
    const normalized = command.replace(/[, ]+/g, ' ').trim();
    const parts = normalized.split(' ');
    const verb = (parts[0] ?? '').toLowerCase();
    const second = parts[1] ?? '';
    const isLogBinary = verb === 'log' && /[bB]$/.test(second);
    if (!this.context.features(tab).isGIII && isLogBinary) {
      const port = this.context.connectedPortName?.(tab) ?? '';
      parts.splice(1, 0, `${port}_28`);
      this.context.sendRaw?.(tab, parts.join(' ') + '\n');
    } else if (tab === 'webui') {
      this.context.sendAsciiFrame?.(tab, command);
    } else {
      let text = command;
      const words = text.trim().split(/\s+/);
      const verb = (words[0] ?? '').toUpperCase();
      if (
        (this.context.features(tab).generation === 'OEM6' ||
          this.context.features(tab).generation === 'OEMSTAR') &&
        (verb === 'MODEL' || verb === 'AUTH') &&
        words[1]
      ) {
        words[1] =
          verb === 'AUTH'
            ? words[1]
                .split(',')
                .map((value) => `"${value}"`)
                .join(',')
            : `"${words[1]}"`;
        text = words.join(' ');
      } else if (
        this.context.features(tab).generation === 'SMART2' &&
        verb === 'MODEL' &&
        words[1]
      ) {
        words[1] = `"${words[1]}"`;
        text = words.join(' ');
      }
      if (
        this.context.features(tab).generation === 'OEM6' &&
        text.toLowerCase().startsWith('ipconfig')
      ) {
        const values = text.split(' ');
        if (!values[values.length - 1].includes('"')) {
          values[values.length - 1] = `"${values[values.length - 1]}"`;
          text = values.join(' ');
        }
      }
      this.context.sendRaw?.(tab, text + '\n');
    }
    if (normalized.toLowerCase().startsWith('unlog')) {
      this.context.sendRaw?.(tab, 'log thisport_30 loglistb once 0\n');
    }
  }

  setTerminalConsoleActive(tab: TabId, active: boolean): void {
    this.active.set(tab, active);
    this.context.operations?.connection?.setTerminalActive?.(tab, active);
  }

  getTerminalConsoleActive(tab: TabId): boolean {
    return this.active.get(tab) === true;
  }

  startRecording(tab: TabId): void {
    this.recording.set(tab, true);
    this.recorded.set(tab, []);
    this.handleDashboard('Starting Recording', tab, { recordFlag: false });
  }

  async stopRecording(tab: TabId): Promise<void> {
    this.recording.set(tab, false);
    this.handleDashboard('Ending Recording', tab, { recordFlag: false });
    const data = (this.recorded.get(tab) ?? []).join('');
    const files = this.context.operations?.files;
    const target = await files?.chooseSaveFile?.({
      title: this.context.translate('SELECTFOLDER'),
      defaultPath: joinPath(files?.defaultDocuments?.() ?? '', `${terminalFileBase(this.context.clock.now())}.gps`),
    });
    if (!target) return;
    await files?.writeText?.(target, data);
    this.recorded.delete(tab);
  }

  async saveOutput(tab: TabId): Promise<string | undefined> {
    const files = this.context.operations?.files;
    const fallback = joinPath(
      files?.defaultDocuments?.() ?? '',
      `${terminalFileBase(this.context.clock.now())}.txt`,
    );
    const target = await files?.chooseSaveFile?.({
      title: this.context.translate('SAVE'),
      defaultPath: fallback,
    });
    if (!target || !files?.writeText) return undefined;
    const data = (this.commandBuffer.get(tab) ?? [])
      .join('\r\n')
      .replace(/[\r\n]{2,}/g, '\r\n');
    await files.writeText(target, data);
    return target;
  }

  async loadCommands(tab: TabId): Promise<string[]> {
    const files = this.context.operations?.files;
    const target = await files?.chooseOpenFile?.({
      title: this.context.translate('LOAD'),
      extensions: ['txt', 'asc', 'gps', 'bat'],
    });
    if (!target || !files?.readText) return [];
    const text = String(await files.readText(target));
    const commands = text.split(/\r?\n/);
    let index = 0;
    const previous = this.loadTimers.get(tab);
    if (previous !== undefined) this.context.clock.clearInterval(previous);
    const timer = this.context.clock.setInterval(() => {
      const command = (commands[index++] ?? '').trim();
      if (command && !command.startsWith(';')) this.executeCommand(command, tab);
      if (index >= commands.length) {
        this.context.clock.clearInterval(timer);
        this.loadTimers.delete(tab);
      }
    }, 1000);
    this.loadTimers.set(tab, timer);
    return commands;
  }

  lines(tab: TabId): TerminalLine[] {
    return [...(this.terminalLines.get(tab) ?? [])];
  }

  maxLines(tab: TabId): number {
    const features = this.context.features(tab);
    return features.isLongHorn ? 500 : features.isGIII ? 1000 : 2000;
  }

  resetDataObject(tab: TabId): void {
    this.incomplete.delete(tab);
    this.commandBuffer.delete(tab);
    this.commandHistory.delete(tab);
    this.responses.delete(tab);
    this.recording.delete(tab);
    this.recorded.delete(tab);
    this.lineCounter.delete(tab);
    this.terminalLines.delete(tab);
    this.historyIndex.delete(tab);
    this.responseMode.delete(tab);
    this.active.delete(tab);
    const loadTimer = this.loadTimers.get(tab);
    if (loadTimer !== undefined) this.context.clock.clearInterval(loadTimer);
    this.loadTimers.delete(tab);
  }

  getCommandBuffer(tab: TabId): string[] {
    return [...(this.commandBuffer.get(tab) ?? [])];
  }

  responseData(tab: TabId): string | undefined {
    return this.responses.get(tab);
  }

  history(tab: TabId): string[] {
    return [...(this.commandHistory.get(tab) ?? [])];
  }

  nativeRequirements(tab: TabId): string[] {
    return [...(this.nativeNeeds.get(tab) ?? [])];
  }

  protected runApply(_tab: TabId): undefined {
    return undefined;
  }

  protected render(_tab: TabId): void {}

  applyGiiiState(tab: TabId): void {
    if (!this.context.features(tab).isGIII) return;
    const state = this.context.giiiDataPortState?.(tab) ?? '';
    if (state === 'Operational' || state === 'Maintenance') {
      this.context.createDialog(
        {
          title: this.context.translate('RESTARTCONFIRMATION'),
          content: this.context.translate('RECEIVERRESTART_1').replace('%1', '<br> <br>'),
          buttons: [
            {
              text: this.context.translate('YES'),
              dataLang: 'data-lang-yes',
              callback: () => {
                this.context.closeDialog(tab);
                this.context.restartReceiver?.(tab, 'giii');
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
      return;
    }
    this.executeCommand('CHANGESTATE OPERATIONAL', tab);
  }

  private updateHistory(value: string, tab: TabId): void {
    const list = this.commandHistory.get(tab) ?? [];
    if (list.at(-1) === value) return;
    if (list.length >= 100) list.shift();
    list.push(value);
    this.commandHistory.set(tab, list);
  }

  private previousCommand(tab: TabId): string | undefined {
    const history = this.history(tab);
    const current = this.historyIndex.get(tab) ?? history.length;
    const next = Math.max(0, current - 1);
    this.historyIndex.set(tab, next);
    return history[next];
  }

  private nextCommand(tab: TabId): string | undefined {
    const history = this.history(tab);
    const current = this.historyIndex.get(tab) ?? history.length;
    const next = Math.min(history.length, current + 1);
    this.historyIndex.set(tab, next);
    return history[next];
  }

  private record(data: string, tab: TabId): void {
    const list = this.recorded.get(tab) ?? [];
    list.push(data);
    this.recorded.set(tab, list);
  }

  private trimLines(tab: TabId): void {
    const list = this.context.document.querySelector(`#${tab} ${this.listSelector(tab)}`);
    if (!list) return;
    const max = this.maxLines(tab);
    let counter = this.lineCounter.get(tab) ?? 0;
    while (counter > max) {
      const first = list.firstElementChild;
      if (!first) break;
      const count = Number(first.getAttribute('linesCount') ?? 1);
      first.remove();
      this.terminalLines.get(tab)?.shift();
      counter -= count;
    }
    this.lineCounter.set(tab, counter);
  }

  private requireNative(tab: TabId, value: string): void {
    const current = this.nativeNeeds.get(tab) ?? [];
    if (!current.includes(value)) current.push(value);
    this.nativeNeeds.set(tab, current);
  }

  private listSelector(tab: TabId): string {
    return this.context.features(tab).isLongHorn
      ? '.lghn-terminal-console-list'
      : '.terminal-console-list';
  }
}

function joinPath(base: string, name: string): string {
  if (!base) return name;
  return base.replace(/[\\/]$/, '') + (base.includes('\\') ? '\\' : '/') + name;
}

function terminalFileBase(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `Console_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}
