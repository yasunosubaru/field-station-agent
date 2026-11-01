import type { TabId, FeatureFlags } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { COMMAND_RESPONSE } from './types.ts';

export const SAVE_LOG_COMMANDS = [
  'LOG VERSION',
  'LOG VALIDMODELS',
  'LOG RXCONFIG',
  'LOG CHANCONFIG',
  'LOG PROFILEINFO',
  'LOG SETUTCLEAPSECONDS',
  'LOG SETBASEWEEK',
  'LOG NVMUSERDATA',
  'LOG TERRASTARINFO',
  'LOG SAVEDSURVEYPOSITIONS',
  'LOG USERANTENNA',
  'LOG TERRASTARAUTOCHANCONFIG',
  'LOG SATEL4INFO',
  'LOG SATEL9INFO',
  'LOG CLOCKCALIBRATE',
] as const;

export const IO_PORT_DETAILS: Record<string, string[]> = {
  MarinePak7: ['COM1', 'COM2', 'COM3', 'ICOM', 'MARK1', 'MARK2', 'MARK3', 'MARK4'],
  PWRPAK7: ['COM1', 'COM2', 'COM3', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3'],
  PWRPAK7D: ['COM1', 'COM2', 'COM3', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3'],
  CPT7: ['COM1', 'COM2', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3'],
  CPT7700: ['COM1', 'COM2', 'ICOM', 'USB', 'USB', 'MARK1', 'MARK2', 'MARK3'],
  OEM719: ['COM1', 'COM2', 'USB', 'MARK1', 'MARK2'],
  OEM729: ['COM1', 'COM2', 'COM3', 'ICOM', 'USB', 'MARK1', 'MARK2'],
  OEM7500: ['COM1', 'COM2', 'COM3', 'USB', 'MARK1', 'MARK2', 'MARK3'],
  OEM7600: ['COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3', 'MARK4'],
  OEM7700: ['COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3', 'MARK4'],
  OEM7720: ['COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'ICOM', 'USB', 'MARK1', 'MARK2', 'MARK3', 'MARK4'],
  OEM718D: ['COM1', 'COM2', 'COM3', 'ICOM', 'USB', 'MARK1', 'MARK2'],
  SMART7: ['COM1', 'COM2', 'COM3', 'ICOM', 'MARK1', 'MARK2', 'MARK3'],
  SMART2: ['COM1', 'COM2', 'COM3', 'MARK1', 'MARK2', 'MARK3'],
};

export const CONFIG_COMMENT_KEYWORDS = [
  'WIFIAPCHANNEL',
  'WIFIAPIPCONFIG',
  'WIFIAPPASSKEY',
  'WIFIAPSSID',
  'WIFIMODE',
  'WIFINETCONFIG',
  'VERSION',
  'WIFIAPSETTINGS',
  'IPCONFIG',
  'WIFINETLIST',
  'WIFISTATUS',
  'IPCONFIG',
  'VALIDMODELS',
  'CHANCONFIG',
  'TERRASTARINFO',
] as const;

export function chooseIOPortDetails(
  model: string,
  enclosure: string,
  version: string,
  marinePak: boolean,
): string[] {
  if (marinePak) return [...IO_PORT_DETAILS.MarinePak7];
  let matched: string[] | null = null;
  for (const [key, ports] of Object.entries(IO_PORT_DETAILS)) {
    if (
      (enclosure.includes(key) || key.includes(enclosure)) &&
      enclosure !== version
    ) {
      matched = ports;
      break;
    }
    if (
      matched === null &&
      (version.includes(key) || (key.includes(version) && enclosure === version))
    ) {
      matched = ports;
      break;
    }
  }
  void model;
  return [...(matched ?? [])];
}

export function formatConfigurationFileName(psn: string, date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${psn}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.cfg`;
}

export function formatResponseFileName(base: string, date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${base}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}_responses.txt`;
}

function tokenize(line: string): string[] {
  return line.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];
}

function isAllowedPort(port: string, allowed: string[]): boolean {
  if (!port) return true;
  if (port.startsWith('COM') || port.startsWith('MARK')) return allowed.includes(port);
  if (port.startsWith('ICOM') || port.startsWith('USB')) {
    return allowed.some((item) => port.includes(item));
  }
  return true;
}

/** `saveConfiguration.js:314-437`: one saved log block to final `.cfg` lines. */
export function transformSavedConfigLines(
  lines: string[],
  log: string,
  portDetails: string[],
): string[] {
  if (log === 'PROFILEINFO') return transformProfileInfo(lines);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.replace(/<(\w+)/g, '< $1') ?? '';
    if (!line) continue;
    let words = tokenize(line);
    if (!words.length) continue;
    let firstWord: string;
    if (line.startsWith('<') && line.includes('ASSIGNLBANDBEAM') && lines[index + 1]) {
      firstWord = (tokenize(line)[1] ?? '').replace(/^</, '');
      words = lines[index + 1].split(/<|&|\\/).join('').trim().split(/\s(?=[^:]+)/);
    } else if (line.startsWith('<') && line.includes('ICOMCONFIG') && lines[index + 1]) {
      firstWord = (tokenize(line)[1] ?? '').replace(/^</, '');
      words = lines[index + 1].replace(/< |"/g, '').trim().split(/\s(?=[^:]+)/);
    } else {
      firstWord = (words[1] ?? '').replace(/^</, '');
    }
    if (!firstWord) continue;
    if (firstWord === 'LOG') continue;
    const clean = (
      // The same guard as the two lookahead branches above: without a following line there is
      // nothing to splice in, and `lines[index + 1] ?? ''` used to leave the command name alone
      // (`<ICOMCONFIG ICOM1 TCP ":2000" ALL` came out as just `ICOMCONFIG` when the statements are
      // handed over one at a time — see `config-http.ts#buildCfgFromTranscript`).
      line.startsWith('<') && (line.includes('ASSIGNLBANDBEAM') || line.includes('ICOMCONFIG')) && lines[index + 1]
        ? [firstWord, ...(lines[index + 1] ?? '').replace(/< |"/g, '').split(/\s+/).filter(Boolean)]
        : words.map((word) => word.replace(/^</, '')).filter(Boolean)
    );
    if (clean.length > 1 && !isAllowedPort(clean[1], portDetails)) continue;
    let outputLine = clean.join(' ');
    if (outputLine.includes('USERANTENNA')) {
      outputLine = outputLine.replace(/\bUSERANTENNA\b/g, 'ANTENNATYPE ADD');
    }
    const keyword = CONFIG_COMMENT_KEYWORDS.find((value) => outputLine.startsWith(value));
    if (
      keyword ||
      outputLine.includes('NVMUSERDATA 0') ||
      outputLine.includes('ETHCONFIG')
    ) {
      outputLine = `/* ${outputLine} */`;
    }
    if (outputLine.length >= 300 && outputLine.includes('CHANCONFIG')) {
      const split = outputLine.split(/(?=CHANCONFIG)/);
      for (const value of split) {
        output.push(value.startsWith('CHANCONFIG') ? `/* ${value.trim()} */` : value.trim());
      }
    } else if (outputLine.trim() && outputLine.trim() !== ':Invalid') {
      output.push(outputLine);
    }
  }
  return output;
}

/** Minimal equivalent of `processProfileInfoLog`: profile create/activate/createelement. */
export function transformProfileInfo(lines: string[]): string[] {
  const output: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const match = tokenize(lines[index]);
    if (!match.length) continue;
    const name = (match[1] ?? '').replace(/"/g, '');
    if (!name) continue;
    output.push(`PROFILE create ${name}`);
    if (match[2] === '1') output.push(`/* PROFILE activate ${name} */`);
    const count = Number(match[3] ?? 0);
    for (let element = 0; element < count && index + 1 < lines.length; element += 1) {
      index += 1;
      output.push(
        `PROFILE createelement ${name} ${lines[index]
          .trim()
          .replace(/^<\s*/, '')
          .replace(/\s+/g, ' ')}`,
      );
    }
  }
  return output;
}

export interface ConfigFileResponseLink {
  command: string;
  status?: string;
}

function joinPath(base: string, name: string): string {
  if (!base) return name;
  const separator = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]$/, '') + separator + name;
}

export class SaveConfigurationDriver {
  readonly name = 'saveConfiguration';
  private readonly runtime: ConfigPageRuntime;
  private readonly active = new Map<TabId, boolean>();
  private readonly lines = new Map<TabId, string[]>();
  private readonly fileName = new Map<TabId, string>();
  private readonly versions = new Map<TabId, Record<string, unknown>>();
  private readonly portDetails = new Map<TabId, string[]>();
  private readonly endpoints = new Map<TabId, boolean>();
  private readonly activeLog = new Map<TabId, string>();

  constructor(runtime: ConfigPageRuntime) {
    this.runtime = runtime;
  }

  get requireNative(): string[] {
    return [];
  }

  getSaveConfigActive(tab: TabId): boolean {
    return this.active.get(tab) === true;
  }

  getDefaultExportDir(): string {
    return joinPath(
      joinPath(
        this.runtime.context.operations?.files?.defaultDocuments?.() ?? '',
        'NovAtelData',
      ),
      'Download Configuration',
    );
  }

  getLogVersionData(data: Record<string, unknown>, tab: TabId): void {
    this.versions.set(tab, { ...data });
  }

  start(tab: TabId, features: FeatureFlags, psn: string, enclosure?: string): boolean {
    if (features.isGIII || features.isLongHorn) {
      this.runtime.context.createDialog(
        {
          title: this.runtime.context.translate('WARNING_MSG'),
          content: this.runtime.context.translate('DOWNLOAD_MSG'),
          buttons: [
            {
              text: this.runtime.context.translate('OK'),
              dataLang: 'data-lang-manage',
              class: 'darkBtn',
              callback: () => this.runtime.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
      return false;
    }
    this.active.set(tab, true);
    this.lines.set(tab, []);
    this.fileName.set(
      tab,
      formatConfigurationFileName(psn, new Date(this.runtime.context.clock.now())),
    );
    const version = String(this.versions.get(tab)?.hardwareVersion ?? features.model);
    this.portDetails.set(
      tab,
      chooseIOPortDetails(
        features.model,
        enclosure ?? version,
        version,
        features.isMarinePak,
      ),
    );
    this.placeLogRequest(tab);
    this.runtime.context.operations?.connection?.setTerminalActive?.(tab, false);
    return true;
  }

  /**
   * Exact 2.11.0 timing: 14 LOGs now, RXCONFIG at 2 s, then SAVECONFIG and RESET together
   * inside the 500 ms callback at 3.5 s. `saveCheck` is cleared in that same callback.
   */
  placeLogRequest(tab: TabId): void {
    this.endpoints.set(tab, false);
    for (const command of SAVE_LOG_COMMANDS) {
      if (command !== 'LOG RXCONFIG') this.runtime.context.sendRaw?.(tab, command + '\n');
    }
    this.runtime.context.clock.setTimeout(() => {
      this.runtime.context.sendRaw?.(tab, 'LOG RXCONFIG\n');
    }, 2000);
    this.runtime.context.clock.setTimeout(() => {
      this.runtime.context.clock.setTimeout(() => {
        this.runtime.context.sendRaw?.(tab, 'SAVECONFIG\n');
        this.runtime.context.sendRaw?.(tab, 'RESET\n');
        const file = this.fileName.get(tab);
        const files = this.runtime.context.operations?.files;
        if (file && files?.writeText) {
          const path = joinPath(this.getDefaultExportDir(), file);
          void files.ensureDirectory?.(this.getDefaultExportDir());
          void files.writeText(path, 'SAVECONFIG\nRESET\n', { append: true });
        }
        this.active.set(tab, false);
      }, 500);
    }, 3000);
  }

  processIncomingData(data: string, tab: TabId): string[] {
    const command = SAVE_LOG_COMMANDS.find(
      (entry) => data.includes(entry.replace('LOG ', '')) && !data.includes('RXCONFIG'),
    );
    const trimmed = data.trim();
    if (command) this.activeLog.set(tab, command.replace('LOG ', ''));
    if (
      trimmed.startsWith('[') ||
      trimmed.startsWith('<OK') ||
      trimmed.startsWith('<ERR')
    ) {
      this.endpoints.set(tab, false);
      if (trimmed.startsWith('<ERR')) {
        this.lines.set(tab, []);
        this.activeLog.delete(tab);
        return [];
      }
      const log = this.activeLog.get(tab);
      const currentLogLines = this.lines.get(tab) ?? [];
      this.lines.set(tab, []);
      this.activeLog.delete(tab);
      if (!log || !currentLogLines.length) return [];
      const output = transformSavedConfigLines(
        currentLogLines,
        log,
        this.portDetails.get(tab) ?? [],
      );
      if (output.length) this.appendOutput(tab, output);
      return output;
    }
    const current = this.lines.get(tab) ?? [];
    const normalized = trimmed.replace(/<(\w+)/g, '< $1');
    // `saveConfiguration.js:172-182`: addLineToConfig appends exactly once.
    current.push(normalized);
    this.lines.set(tab, current);
    return [];
  }

  private appendOutput(tab: TabId, output: string[]): void {
    const file = this.fileName.get(tab);
    const files = this.runtime.context.operations?.files;
    if (!file || !files?.writeText) return;
    const path = joinPath(this.getDefaultExportDir(), file);
    void files.ensureDirectory?.(this.getDefaultExportDir());
    void files.writeText(path, output.join('\n') + '\n', { append: true });
  }

  getFileName(tab: TabId): string | undefined {
    return this.fileName.get(tab);
  }
}

export interface ConfigLoadOptions {
  currentPort: string;
  versions: {
    hardwareVersion: string;
    model: string;
    softwareVersion: string;
    PSN?: string;
  };
  responseBaseName: string;
  responseDirectory: string;
}

export function filterLoadCommands(text: string, currentPort: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('/*') &&
        !line.startsWith('RESET') &&
        !line.startsWith('SAVECONFIG') &&
        !line.includes(`ICOMCONFIG ${currentPort}`) &&
        !line.includes(`SERIALCONFIG ${currentPort}`),
    );
}

export function versionMismatch(line: string, versions: ConfigLoadOptions['versions']): string[] {
  if (!line.startsWith('/*') || !line.includes('VERSION')) return [];
  const mismatch: string[] = [];
  if (!line.includes(String(versions.hardwareVersion))) mismatch.push('Hardware version');
  if (!line.includes(String(versions.model))) mismatch.push('Model');
  if (!line.includes(String(versions.softwareVersion))) mismatch.push('Firmware version');
  return mismatch;
}

export class LoadConfigurationDriver {
  readonly name = 'loadConfiguration';
  private readonly runtime: ConfigPageRuntime;
  private readonly active = new Map<TabId, boolean>();
  private readonly commands = new Map<TabId, string[]>();
  private readonly index = new Map<TabId, number>();
  private readonly responses = new Map<TabId, Record<string, ConfigFileResponseLink>>();
  private readonly sent = new Map<TabId, string[]>();
  private readonly retryDone = new Map<TabId, boolean>();
  private readonly saveConfigResponse = new Map<TabId, string>();
  private readonly versions = new Map<TabId, ConfigLoadOptions['versions']>();
  private readonly responsePath = new Map<TabId, string>();
  private readonly timers = new Map<TabId, number>();
  private readonly timeoutAt = new Map<TabId, number>();
  private readonly pending = new Map<TabId, string>();
  private readonly resetSent = new Map<TabId, boolean>();
  private readonly paused = new Map<TabId, boolean>();
  private readonly responseTimer = new Map<TabId, number>();

  constructor(runtime: ConfigPageRuntime) {
    this.runtime = runtime;
  }

  getLoadConfigActive(tab: TabId): boolean {
    return this.active.get(tab) === true;
  }

  prepare(tab: TabId): void {
    this.active.set(tab, true);
    this.paused.set(tab, true);
  }

  getLogversionDetails(versions: ConfigLoadOptions['versions'], tab: TabId): void {
    this.versions.set(tab, { ...versions });
  }

  start(text: string, tab: TabId, options: ConfigLoadOptions): string[] {
    const mismatches: string[] = [];
    for (const line of text.split('\n')) {
      mismatches.push(...versionMismatch(line.trim(), options.versions));
    }
    this.active.set(tab, true);
    this.commands.set(tab, filterLoadCommands(text, options.currentPort));
    this.index.set(tab, 0);
    this.responses.set(tab, {});
    this.sent.set(tab, []);
    this.retryDone.set(tab, false);
    this.resetSent.set(tab, false);
    this.paused.set(tab, false);
    this.versions.set(tab, options.versions);
    this.responsePath.set(
      tab,
      joinPath(
        options.responseDirectory,
        formatResponseFileName(
          options.responseBaseName,
          new Date(this.runtime.context.clock.now()),
        ),
      ),
    );
    this.runtime.context.operations?.connection?.setTerminalActive?.(tab, false);
    if (mismatches.length) {
      this.paused.set(tab, true);
      this.runtime.context.createDialog(
        {
          title: 'Confirmation',
          content: `${[...new Set(mismatches)].join(', ')} different. Do you wish to proceed further?`,
          buttons: [
            {
              text: 'Yes',
              dataLang: 'data-lang-manage',
              callback: () => {
                this.paused.set(tab, false);
                this.runtime.context.closeDialog(tab);
                this.schedule(tab);
              },
            },
            { text: 'No', dataLang: 'data-lang-dismiss', callback: () => this.cancel(tab) },
          ],
        },
        { tab },
      );
    } else this.schedule(tab);
    return [...new Set(mismatches)];
  }

  private schedule(tab: TabId): void {
    const handle = this.runtime.context.clock.setInterval(() => this.step(tab), 1000);
    this.timers.set(tab, handle);
  }

  step(tab: TabId): void {
    if (!this.active.get(tab) || this.paused.get(tab)) return;
    const commands = this.commands.get(tab) ?? [];
    const index = this.index.get(tab) ?? 0;
    if (index >= commands.length) {
      this.finishRound(tab);
      return;
    }
    const command = commands[index];
    const key = command.split(' ').slice(0, 3).join(' ');
    const previous = this.pending.get(tab) ?? '';
    if (previous && !this.responses.get(tab)?.[previous]?.status) return;
    this.runtime.context.sendAsciiFrame?.(tab, command);
    // `loadConfiguration.js:407` appends an extra CRLF after the already-framed request.
    this.runtime.context.sendRaw?.(tab, '\r\n');
    this.sent.get(tab)?.push(command);
    this.index.set(tab, index + 1);
    this.pending.set(tab, key);
    this.armResponseTimeout(tab, key);
  }

  processResponses(response: string[], tab: TabId): void {
    if (!response.length) return;
    const first = response[0].split(',')[0].replace(/^#/, '');
    const second = (response[1]?.split('*')[0] ?? '').replace(/^</, '');
    const commands = this.commands.get(tab) ?? [];
    const activeCommand =
      this.pending.get(tab) ?? commands[Math.max(0, (this.index.get(tab) ?? 1) - 1)] ?? '';
    const activeName = activeCommand.split(' ')[0];
    if (first === 'FRESETR') {
      this.responses.get(tab)!.FRESET = { command: 'FRESET', status: second };
    } else if (first.startsWith(activeName) || first.includes(activeName)) {
      const key = activeCommand.split(' ').slice(0, 3).join(' ');
      this.responses.get(tab)![key] = { command: activeName, status: second };
      if (activeName === 'SAVECONFIG') this.saveConfigResponse.set(tab, second);
      const timer = this.responseTimer.get(tab);
      if (timer !== undefined) this.runtime.context.clock.clearTimeout(timer);
      this.responseTimer.delete(tab);
    }
  }

  private currentCommand(tab: TabId): string {
    const commands = this.commands.get(tab) ?? [];
    return commands[Math.max(0, (this.index.get(tab) ?? 1) - 1)] ?? '';
  }

  private finishRound(tab: TabId): void {
    const responses = this.responses.get(tab) ?? {};
    const pending = this.pending.get(tab);
    if (pending && !responses[pending]?.status) return;
    if (!this.retryDone.get(tab)) {
      this.retryDone.set(tab, true);
      const missing = (this.commands.get(tab) ?? []).filter((command) => {
        const key = command.split(' ').slice(0, 3).join(' ');
        return !responses[key]?.status;
      });
      this.commands.set(tab, missing);
      this.index.set(tab, 0);
      if (missing.length) return;
    }
    const save = responses.SAVECONFIG?.status ?? '';
    if (!save) {
      this.runtime.context.sendAsciiFrame?.(tab, 'SAVECONFIG');
      this.runtime.context.sendRaw?.(tab, '\r\n');
      this.responses.get(tab)!.SAVECONFIG = { command: 'SAVECONFIG', status: '' };
      this.pending.set(tab, 'SAVECONFIG');
      this.armResponseTimeout(tab, 'SAVECONFIG');
      return;
    }
    const needReset = !save.includes('ERROR:Profile Active.');
    if (needReset) {
      if (!this.resetSent.get(tab)) {
        this.runtime.context.sendAsciiFrame?.(tab, 'RESET');
        this.runtime.context.sendRaw?.(tab, '\r\n');
        this.resetSent.set(tab, true);
        this.pending.set(tab, 'RESET');
        this.armResponseTimeout(tab, 'RESET');
        return;
      }
      if (!responses.RESET?.status) return;
    }
    this.writeResponses(tab);
    this.active.set(tab, false);
    const timer = this.timers.get(tab);
    if (timer !== undefined) this.runtime.context.clock.clearInterval(timer);
    this.timers.delete(tab);
  }

  private writeResponses(tab: TabId): void {
    const path = this.responsePath.get(tab);
    const files = this.runtime.context.operations?.files;
    if (!path || !files?.writeText) return;
    const lines = Object.values(this.responses.get(tab) ?? {})
      .map(({ command, status }) => {
        if (status?.startsWith('ERROR')) return `${command} --> Failure(${status})`;
        if (status?.startsWith('OK')) return `${command} --> Success`;
        return '';
      })
      .filter(Boolean);
    void files.writeText(path, lines.join('\n') + (lines.length ? '\n' : ''));
  }

  private armResponseTimeout(tab: TabId, key: string): void {
    const timeoutAt = this.runtime.context.clock.now() + 30000;
    this.timeoutAt.set(tab, timeoutAt);
    const previousTimer = this.responseTimer.get(tab);
    if (previousTimer !== undefined) this.runtime.context.clock.clearTimeout(previousTimer);
    this.responseTimer.set(
      tab,
      this.runtime.context.clock.setTimeout(() => {
        if (
          this.active.get(tab) &&
          this.pending.get(tab) === key &&
          this.timeoutAt.get(tab) === timeoutAt &&
          !this.responses.get(tab)?.[key]?.status
        ) {
          this.cancel(tab);
        }
      }, 30000),
    );
  }

  cancel(tab: TabId): void {
    this.active.set(tab, false);
    this.paused.set(tab, false);
    const timer = this.timers.get(tab);
    if (timer !== undefined) this.runtime.context.clock.clearInterval(timer);
    this.timers.delete(tab);
    const responseTimer = this.responseTimer.get(tab);
    if (responseTimer !== undefined) this.runtime.context.clock.clearTimeout(responseTimer);
    this.responseTimer.delete(tab);
  }

  responseReport(tab: TabId): ConfigFileResponseLink[] {
    return Object.entries(this.responses.get(tab) ?? {}).map(([command, value]) => ({
      command,
      status: value.status,
    }));
  }

  sentCommands(tab: TabId): string[] {
    return [...(this.sent.get(tab) ?? [])];
  }

  responseFile(tab: TabId): string | undefined {
    return this.responsePath.get(tab);
  }
}
