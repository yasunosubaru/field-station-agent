import type { TabId } from '../types.ts';
import type {
  ConfigDataMap,
  ConfigPageRuntime,
} from './types.ts';
import {
  BaseConfigPage,
  addError,
  clearErrors,
  scopedQuery,
} from './base.ts';

export const PORT_MSG = {
  INTERFACE_MODE: 3,
  LOGLIST: 5,
  LOG: 1,
  UNLOG: 36,
  UNLOGALL: 38,
  SERIALCONFIG: 1246,
  ICOMCONFIG: 1248,
  NTRIPCONFIG: 1249,
  SOURCETABLE: 1344,
  NMEA_CONFIG: 861,
  NMEA_BEIDOU_CONFIG: 2258,
  NMEA_FORMAT: 1861,
  GGA_QUALITY: 691,
} as const;

const REQUIRED_BASE = [
  PORT_MSG.LOGLIST,
  PORT_MSG.INTERFACE_MODE,
  PORT_MSG.SERIALCONFIG,
] as const;

/** `NovatelIdConstants.inputFormatList` / `outputFormatList` (`model/NovatelIdConstants.js:51-52`). */
const INPUT_FORMATS = ['NONE', 'AUTO', 'CMR', 'NOVATEL', 'NOVATELX', 'RTCA', 'RTCM', 'RTCMV3', 'VERIPOS'];
const OUTPUT_FORMATS = ['NONE', 'CMR', 'NMEA', 'NOVATEL', 'NOVATELX', 'RTCA', 'RTCM', 'RTCMV3'];

/** `portConfig.js:2670-2752` — the message box placeholder for the current output format. */
const PLACEHOLDER_MESSAGE = 'Type a message name, then press Enter';
const PLACEHOLDER_NO_OUTPUT = 'Output format is NONE — no messages can be logged on this port';

function optionList(values: string[], attribute: string): string {
  return values.map((value) => `<li class="portconfigvalues" ${attribute}>${value}</li>`).join('');
}

/**
 * One row of `#desktop-portconfig-list`, exactly the ids/classes `getPortItem` writes
 * (`portConfig.js:2712-2752`): `div#<port>.portconfig-item` with three dropdowns and the message
 * textarea. Two deliberate deltas, both because this markup is *serialised* and re-parsed by the
 * browser rather than built with `append()`:
 *  - the root is an `<li>`: a `<div>` inside `<ul>` would be foster-parented out of the list by the
 *    HTML parser, and `#desktop-portconfig-list` would come back empty;
 *  - `list-style:none` restores the look of the original `<div>` children.
 */
function portRowHtml(port: string, inputFormat: string, outputFormat: string): string {
  const noOutput = outputFormat === 'NONE' || outputFormat === 'Select';
  const placeholder = noOutput ? PLACEHOLDER_NO_OUTPUT : PLACEHOLDER_MESSAGE;
  return `<li class="row portconfig-item" id="${port}" style="list-style:none">
        <div class="title col-md-2 col-sm-2 col-xs-2">
            <div class="dropdown input-selection">
                <button class="btn portconfig-dropdown" type="button" data-toggle="dropdown">
                    <span class="active-port">${inputFormat}</span>
                    <div class="portconfig-down-arrow"></div>
                </button>
                <ul class="dropdown-menu scrollable-menu inputlist">${optionList(INPUT_FORMATS, '')}</ul>
            </div>
        </div>
        <div class="title col-md-2 col-sm-2 col-xs-2">
            <div class="dropdown port-selection">
                <button class="btn portconfig-dropdown portsListDropdown" type="button" data-toggle="dropdown">
                    <span class="active-port">${port}</span>
                    <div class="portconfig-down-arrow"></div>
                </button>
                <div><button class="port-config-settings config-settings-desk-btn port-selected"></button></div>
                <ul class="dropdown-menu scrollable-menu portlist"></ul>
            </div>
        </div>
        <div class="title col-md-2 col-sm-2 col-xs-2">
            <div class="dropdown output-selection">
                <button class="btn portconfig-dropdown" type="button" data-toggle="dropdown">
                    <span class="active-port">${outputFormat}</span>
                    <div class="portconfig-down-arrow"></div>
                </button>
                <ul class="dropdown-menu scrollable-menu outputlist">${optionList(OUTPUT_FORMATS, '')}</ul>
            </div>
        </div>
        <div class="title col-md-5 col-sm-5 col-xs-5 message-layout autocomplete">
            <textarea class="message-text-area" placeholder="${placeholder}"${noOutput ? ' disabled' : ''}></textarea>
            <button class="msg-stng-btn config-settings-desk-btn"></button>
            <div class="overlay-msg-blocks">
                <ul class="msg-items" role="listbox"></ul>
                <div class="msg-info-tile"><span>+2</span><span data-lang-more>&nbsp;More</span></div>
            </div>
        </div>
        <div type="button" class="list-close-btn"></div>
    </li>`;
}

/** Honest empty state: no receiver configuration has arrived, so no port row can be shown. */
const NO_RECEIVER_NOTE =
  '<li class="portconfig-note" data-portconfig-note="no-receiver" style="list-style:none">' +
  'No receiver configuration yet: the port rows are built from the receiver’s INTERFACEMODE and ' +
  'SERIALCONFIG records, and no such record has arrived on this link. The row below is the shipped ' +
  'template (the one the “+” button adds); Apply stays a no-op until the receiver answers.' +
  '</li>';

const REQUIRED_NTRIP = [
  PORT_MSG.ICOMCONFIG,
  PORT_MSG.NTRIPCONFIG,
  PORT_MSG.SOURCETABLE,
] as const;

/** `portConfig.js` data model and Apply pipeline (R24–R29). */
export class PortConfigPage extends BaseConfigPage {
  readonly connectedComPort = new Map<
    TabId,
    { comPort?: string; discardResponse: boolean }
  >();
  private readonly refreshTimers = new Map<TabId, number>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'portConfig',
      fragmentPath: './../portConfig/portConfig.html',
      containerId: (tab) => `config-ports-${tab}`,
    });
  }

  protected override loaderDuration(tab: TabId): number {
    return this.connectedComPort.get(tab)?.discardResponse
      ? 20000
      : 8000;
  }

  override apply(tab: TabId) {
    if (!this.isDirty(tab) || !this.validateApply(tab)) return undefined;
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const connected = this.connectedComPort.get(tab);
    const interfaceChange = connected?.comPort
      ? (pending[String(PORT_MSG.INTERFACE_MODE)]?.[connected.comPort] as
          | Record<string, unknown>
          | undefined)
      : undefined;
    if (interfaceChange?.rxType === 'NONE' && interfaceChange?.txType === 'NONE') {
      connected!.discardResponse = true;
    }
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, this.loaderDuration(tab), 'APPLYING');
    return this.runApply(tab);
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    if (
      msgId === PORT_MSG.INTERFACE_MODE ||
      msgId === PORT_MSG.ICOMCONFIG ||
      msgId === PORT_MSG.NTRIPCONFIG
    ) {
      const current = this.state.current(tab);
      const id = String(msgId);
      const nested =
        current[id] && typeof current[id] === 'object'
          ? (current[id] as Record<string, unknown>)
          : {};
      const key = String(data.port ?? data.endPoint ?? id);
      nested[key] = { ...data };
      current[id] = nested;
      return;
    }
    if (msgId === PORT_MSG.SOURCETABLE) {
      const current = this.state.current(tab);
      const id = String(msgId);
      const table =
        current[id] && typeof current[id] === 'object'
          ? (current[id] as Record<string, Record<string, unknown>>)
          : {};
      const endpoint = String(data.endPoint ?? '');
      const entry = String(
        data.entryData ?? data.mountpoint ?? Object.keys(table[endpoint] ?? {}).length,
      );
      table[endpoint] = table[endpoint] ?? {};
      table[endpoint][entry] = { ...data };
      current[id] = table;
      return;
    }
    super.updateData(msgId, data);
  }

  isPortConfigDataAvailable(tab: TabId): boolean {
    const current = this.state.current(tab);
    if (!REQUIRED_BASE.every((id) => current[String(id)] !== undefined)) return false;
    const interfaceModes = current[String(PORT_MSG.INTERFACE_MODE)];
    const ports =
      interfaceModes && typeof interfaceModes === 'object'
        ? Object.keys(interfaceModes)
        : [];
    const supportsIcom = ports.some((port) => port.startsWith('ICOM'));
    const supportsNcom = ports.some((port) => port.startsWith('NCOM'));
    if (supportsIcom && supportsNcom) {
      return REQUIRED_NTRIP.every((id) => current[String(id)] !== undefined);
    }
    if (this.context.features(tab).generation === 'OEMSTAR') return true;
    return current[String(PORT_MSG.SOURCETABLE)] !== undefined;
  }

  /** R24/R25: poll once a second until the six dictionaries are complete, and probe the port. */
  checkAndUpdatePortConfigDefaultData(tab: TabId): void {
    this.cancelRefresh(tab);
    const check = (): boolean => {
      if (!this.isPortConfigDataAvailable(tab)) return false;
      this.context.hideConnectionLoader(tab);
      this.resetPortConfigUI(tab);
      this.cancelRefresh(tab);
      return true;
    };
    if (!check()) {
      this.context.showConnectionLoader(tab);
      const handle = this.context.clock.setInterval(check, 1000);
      this.refreshTimers.set(tab, handle);
    }
    this.probeConnectedPort(tab);
  }

  private cancelRefresh(tab: TabId): void {
    const handle = this.refreshTimers.get(tab);
    if (handle !== undefined) this.context.clock.clearInterval(handle);
    this.refreshTimers.delete(tab);
  }

  probeConnectedPort(tab: TabId): void {
    this.commands.place(this.name, 'send', [{ command: ['send abcd', 'novatelchar', 9] }], tab);
  }

  /** `setConnectedPortAddress` (`portConfig.js:4689-4700`). */
  setConnectedPortAddress(response: string, tab: TabId): string | undefined {
    if (!response.startsWith('#SENDR')) return this.connectedComPort.get(tab)?.comPort;
    const values = response.split(';')[0].split(',');
    const port = values[1]?.split('_')[0];
    if (!port) return this.connectedComPort.get(tab)?.comPort;
    const current = this.connectedComPort.get(tab) ?? { discardResponse: false };
    current.comPort = port;
    this.connectedComPort.set(tab, current);
    return port;
  }

  setInterface(
    tab: TabId,
    port: string,
    values: { rxType?: string; txType?: string; responses?: 'ON' | 'OFF' },
  ): void {
    this.setPortField(tab, PORT_MSG.INTERFACE_MODE, port, values);
  }

  setPortField(
    tab: TabId,
    msgId: number,
    port: string,
    values: Record<string, unknown>,
  ): void {
    const dialogClass =
      msgId === PORT_MSG.LOG
        ? 'edit-port-msg'
        : port.startsWith('NCOM')
          ? 'edit-ncom-config'
          : port.startsWith('ICOM')
            ? 'edit-icom-config'
            : port.startsWith('COM')
              ? 'edit-com-config'
              : '';
    const current = this.state.current(tab) as Record<string, Record<string, Record<string, unknown>>>;
    const baseline = current[String(msgId)]?.[port] ?? {};
    const pending = this.state.pending(tab);
    const bucket =
      pending[String(msgId)] && typeof pending[String(msgId)] === 'object'
        ? (pending[String(msgId)] as Record<string, unknown>)
        : {};
    const portBucket =
      bucket[port] && typeof bucket[port] === 'object'
        ? (bucket[port] as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(value) === JSON.stringify(baseline[key])) delete portBucket[key];
      else portBucket[key] = value;
    }
    if (Object.keys(portBucket).length) bucket[port] = portBucket;
    else delete bucket[port];
    this.state.setPendingBucket(tab, msgId, Object.keys(bucket).length ? bucket : {});
    if (dialogClass) {
      this.context.setDialogDirty?.(tab, dialogClass, this.state.isDirty(tab));
    }
  }

  setLog(
    tab: TabId,
    port: string,
    name: string,
    value: Record<string, unknown>,
  ): void {
    this.setPortField(tab, PORT_MSG.LOG, port, { [name]: value });
  }

  setUnlog(
    tab: TabId,
    port: string,
    value: Record<string, unknown>,
  ): void {
    this.setPortField(tab, PORT_MSG.UNLOG, port, value);
  }

  setUnlogAll(tab: TabId, port: string): void {
    this.setPortField(tab, PORT_MSG.UNLOGALL, port, { held: 'TRUE' });
  }

  setNmeaTalker(tab: TabId, option: string, beidou = false): void {
    const msgId = beidou ? PORT_MSG.NMEA_BEIDOU_CONFIG : PORT_MSG.NMEA_CONFIG;
    const baseline = this.state.current(tab)[String(msgId)]?.option;
    this.state.setPending(tab, msgId, 'option', option, baseline);
  }

  setNmeaFormat(tab: TabId, format: string): void {
    const baseline = this.state.current(tab)[String(PORT_MSG.NMEA_FORMAT)]?.format;
    this.state.setPending(tab, PORT_MSG.NMEA_FORMAT, 'format', format, baseline);
  }

  setGgaQuality(tab: TabId, quality: number): void {
    const baseline = this.state.current(tab)[String(PORT_MSG.GGA_QUALITY)]?.quality;
    this.state.setPending(tab, PORT_MSG.GGA_QUALITY, 'quality', quality, baseline);
  }

  protected validateApply(tab: TabId): boolean {
    clearErrors(this.context, tab);
    if (!this.isDirty(tab)) {
      addError(this.context, tab, '#desktop-portconfig-list', 'data-lang-no-changes');
      return false;
    }
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const interfaces = pending[String(PORT_MSG.INTERFACE_MODE)] ?? {};
    for (const [port, value] of Object.entries(interfaces)) {
      if (!port.startsWith('NCOM') || !value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const rx = record.rxType;
      const tx = record.txType;
      if (
        (rx !== undefined && rx !== 'NONE' && rx !== 'NOVATEL') ||
        (tx !== undefined && tx !== 'NONE' && tx !== 'NOVATEL')
      ) {
        const ntrip = this.ntripForPort(tab, port);
        if (!ntrip.domain || !ntrip.ntripport || !ntrip.mountPoint) {
          addError(this.context, tab, `#${port} .port-selection`, 'data-lang-please-configure');
          return false;
        }
      }
    }
    return true;
  }

  protected runApply(tab: TabId): undefined {
    const pending = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const current = this.state.current(tab) as Record<string, Record<string, Record<string, unknown>>>;
    const connected = this.connectedComPort.get(tab);

    const interfaces = pending[String(PORT_MSG.INTERFACE_MODE)] ?? {};
    for (const [port, changedAny] of Object.entries(interfaces)) {
      const changed = changedAny as Record<string, unknown>;
      const baseline = current[String(PORT_MSG.INTERFACE_MODE)]?.[port] ?? {};
      let input = String(changed.rxType ?? baseline.rxType ?? 'NONE');
      let output = String(changed.txType ?? baseline.txType ?? 'NONE');
      if (output === 'NMEA') output = 'NOVATEL';
      if (port === connected?.comPort && input === 'NONE' && output === 'NONE') {
        connected.discardResponse = true;
      }
      this.commands.place(
        this.name,
        'interfacemode',
        [
          { port: [port, 'enum', 4] },
          { rxtype: [input, 'enum', 4] },
          { txtype: [output, 'enum', 4] },
          { responses: ['ON', 'enum', 4] },
        ],
        tab,
      );
    }

    const ntripPorts = new Set([
      ...Object.keys(interfaces),
      ...Object.keys(pending[String(PORT_MSG.NTRIPCONFIG)] ?? {}),
    ]);
    for (const port of ntripPorts) {
      if (!port.startsWith('NCOM')) continue;
      const changed =
        (interfaces[port] as Record<string, unknown> | undefined) ??
        (pending[String(PORT_MSG.NTRIPCONFIG)]?.[port] as Record<string, unknown> | undefined) ??
        {};
      const baselineInterface = current[String(PORT_MSG.INTERFACE_MODE)]?.[port] ?? {};
      const input = String(changed.rxType ?? baselineInterface.rxType ?? 'NONE');
      const output = String(changed.txType ?? baselineInterface.txType ?? 'NONE');
      const ntrip = this.ntripForPort(tab, port);
      const type = output === 'RTCM' || output === 'RTCMV3' || output === 'CMR' || output === 'RTCA'
        ? 'SERVER'
        : input === 'AUTO' || ['RTCM', 'RTCMV3', 'CMR', 'RTCA', 'VERIPOS'].includes(input)
          ? 'CLIENT'
          : 'DISABLED';
      const params: ConfigDataMap = [
        { port: [port, 'enum', 4] },
        { type: [type, 'enum', 4] },
        { protocol: [ntrip.userName && ntrip.password ? 'V2' : 'V1', 'enum', 4] },
        { endpoint: [ntrip.domain, 'string'] },
        { mountpoint: [ntrip.mountPoint, 'string'] },
        { username: [ntrip.userName, 'string'] },
        { password: [ntrip.password, 'string'] },
        { bindinterface: ['ALL', 'enum', 4] },
      ];
      this.commands.place(this.name, 'ntripconfig', params, tab);
    }
    for (const [port, changed] of Object.entries(pending[String(PORT_MSG.ICOMCONFIG)] ?? {})) {
      const baseline = current[String(PORT_MSG.ICOMCONFIG)]?.[port] ?? {};
      const record = changed as Record<string, unknown>;
      this.commands.place(
        this.name,
        'icomport',
        [
          { port: [port, 'enum', 4] },
          { protocol: [record.protocol ?? baseline.protocol ?? 'TCP', 'enum', 4] },
          { endpoint: [record.endPoint ?? record.endpoint ?? baseline.endPoint ?? '', 'string'] },
          { bindinterface: ['ALL', 'enum', 4] },
        ],
        tab,
      );
    }
    for (const [port, changed] of Object.entries(pending[String(PORT_MSG.SERIALCONFIG)] ?? {})) {
      const baseline = current[String(PORT_MSG.SERIALCONFIG)]?.[port] ?? {};
      const record = changed as Record<string, unknown>;
      this.commands.place(
        this.name,
        'serialconfig',
        [
          { port: [port, 'enum', 4] },
          { baud: [record.baud ?? baseline.baud ?? 9600, 'ulong', 4] },
          { parity: [record.parity ?? baseline.parity ?? 'N', 'enum', 4] },
          { databits: [record.databits ?? baseline.databits ?? 8, 'ulong', 4] },
          { stopbits: [record.stopbits ?? baseline.stopbits ?? 1, 'ulong', 4] },
          { handshake: ['N', 'enum', 4] },
          { break: ['ON', 'enum', 4] },
        ],
        tab,
      );
    }

    for (const [port, changed] of Object.entries(pending[String(PORT_MSG.LOG)] ?? {})) {
      for (const [name, value] of Object.entries(changed as Record<string, Record<string, unknown>>)) {
        const old = current[String(PORT_MSG.LOGLIST)]?.[port]?.[name] as Record<string, unknown> | undefined;
        const format = String(value.format ?? 'Binary');
        const messageType = this.messageType(format, name.endsWith('_1'));
        if (old && old.format !== undefined && old.format !== format) {
          this.commands.place(
            this.name,
            'unlog',
            [
              { port: [port, 'enum', 4] },
              { messageID: [value.messageID, 'ushort', 2] },
              { messageType: [this.messageType(String(old.format), name.endsWith('_1')), 'char', 1] },
              { reserved: [0, 'char', 1] },
            ],
            tab,
          );
        }
        const trigger = String(value.trigger ?? 'ONTIME').toUpperCase();
        this.commands.place(
          this.name,
          'log',
          [
            { port: [port, 'enum', 4] },
            { messageID: [value.messageID ?? value.msgId, 'ushort', 2] },
            { messageType: [messageType, 'char', 1] },
            { reserved: [0, 'char', 1] },
            { trigger: [trigger, 'enum', 4] },
            { period: [trigger === 'ONTIME' ? value.period ?? 1 : 0, 'double', 8] },
            { offset: [0, 'double', 8] },
            { hold: ['HOLD', 'enum', 4] },
          ],
          tab,
        );
      }
    }
    for (const [port, changed] of Object.entries(pending[String(PORT_MSG.UNLOG)] ?? {})) {
      const record = changed as Record<string, unknown>;
      this.commands.place(
        this.name,
        'unlog',
        [
          { port: [port, 'enum', 4] },
          { messageID: [record.messageID ?? record.msgId, 'ushort', 2] },
          { messageType: [record.messageType ?? 0, 'char', 1] },
          { reserved: [0, 'char', 1] },
        ],
        tab,
      );
    }
    for (const port of Object.keys(pending[String(PORT_MSG.UNLOGALL)] ?? {})) {
      this.commands.place(
        this.name,
        'unlogall',
        [
          { port: [port, 'enum', 4] },
          { held: ['TRUE', 'enum', 4] },
        ],
        tab,
      );
    }
    this.sendNmeaSettings(tab, pending);
    return undefined;
  }

  private sendNmeaSettings(tab: TabId, pending: Record<string, Record<string, unknown>>): void {
    const nmea = pending[String(PORT_MSG.NMEA_CONFIG)];
    if (nmea) {
      this.commands.place(this.name, 'nmeaConfig', [{ option: [nmea.option, 'enum', 4] }], tab);
    }
    const beidou = pending[String(PORT_MSG.NMEA_BEIDOU_CONFIG)];
    if (beidou) {
      this.commands.place(this.name, 'nmeaBeiDouConfig', [{ option: [beidou.option, 'enum', 4] }], tab);
    }
    const format = pending[String(PORT_MSG.NMEA_FORMAT)];
    if (format) {
      const value = Number(format.format);
      let latitude = '0';
      let longitude = '0';
      if (value === 5) [latitude, longitude] = ['10.5', '11.5'];
      else if (value === 6) [latitude, longitude] = ['11.6', '12.6'];
      else if (value === 7) [latitude, longitude] = ['12.7', '13.7'];
      else if (value === 8) [latitude, longitude] = ['12.8', '14.8'];
      this.commands.place(
        this.name,
        'nmeaFormatConfig',
        [
          { field: ['GGA_LATITUDE', 'enum', 4] },
          { format: [latitude, 'string', 8] },
        ],
        tab,
      );
      this.commands.place(
        this.name,
        'nmeaFormatConfig',
        [
          { field: ['GGA_LONGITUDE', 'enum', 4] },
          { format: [longitude, 'string', 8] },
        ],
        tab,
      );
    }
    const gga = pending[String(PORT_MSG.GGA_QUALITY)];
    if (gga) {
      this.commands.place(
        this.name,
        'ggaQualityConfig',
        [
          { entries: [1, 'ulong', 4] },
          { posType: ['PPP', 'enum', 4] },
          { quality: [Number(gga.quality) || '', 'ulong', 4] },
        ],
        tab,
      );
    }
  }

  private messageType(format: string, timed = false): number {
    const base = format === 'ASCII' ? 32 : format === 'Abbr ASCII' ? 64 : 0;
    return base + (timed ? 1 : 0);
  }

  private ntripForPort(tab: TabId, port: string): {
    domain: string;
    ntripport: string;
    mountPoint: string;
    userName: string;
    password: string;
  } {
    const current = this.state.current(tab) as Record<string, Record<string, Record<string, unknown>>>;
    const raw = current[String(PORT_MSG.NTRIPCONFIG)]?.[port] ?? {};
    return {
      domain: String(raw.endpoint ?? raw.endPoint ?? raw.domain ?? ''),
      ntripport: String(raw.ntripport ?? raw.portNumber ?? ''),
      mountPoint: String(raw.mountpoint ?? raw.mountPoint ?? ''),
      userName: String(raw.username ?? raw.userName ?? ''),
      password: String(raw.password ?? ''),
    };
  }

  handlePortConfigCommandResponse(data: 1 | 2, tab: TabId): void {
    const connected = this.connectedComPort.get(tab);
    if (connected?.discardResponse) return;
    this.commands.removeFeature(this.name, tab);
    this.context.clock.setTimeout(() => {
      this.context.closeApplyingScreen(tab, data);
      if (data === 1) this.commit(tab);
      this.resetPortConfigUI(tab);
    }, 2000);
  }

  resetPortConfigUI(tab: TabId): void {
    for (const dialogClass of [
      'edit-com-config',
      'edit-port-msg',
      'edit-icom-config',
      'edit-ncom-config',
    ]) {
      this.context.setDialogDirty?.(tab, dialogClass, false);
    }
    this.context.clock.setTimeout(() => this.reset(tab), 0);
  }

  applyButtonCheck(tab: TabId): boolean {
    return this.validateApply(tab);
  }

  /**
   * `portConfig.js:2772-2790` (`addDesktopComponent`): one row per port whose INTERFACEMODE is not
   * NONE/NONE, in the receiver's own port order. Without that record the list is empty in 2.11.0
   * too, so a `Select` template row plus the note explains why — never a fabricated port.
   */
  private readonly rowSignature = new Map<TabId, string>();

  protected render(tab: TabId): void {
    const root = scopedQuery(this.context, tab, '#desktop-portconfig-list');
    if (!root) return;
    const connected = this.connectedComPort.get(tab)?.comPort;
    if (connected) root.setAttribute('data-connected-port', connected);

    const current = this.state.current(tab) as Record<string, Record<string, Record<string, unknown>>>;
    const interfaces = current[String(PORT_MSG.INTERFACE_MODE)] ?? {};
    const ports = Object.keys(interfaces)
      .filter((port) => {
        const value = interfaces[port] ?? {};
        return value.rxType !== 'NONE' || value.txType !== 'NONE';
      })
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

    const signature = ports.join(',');
    if (this.rowSignature.get(tab) === signature && root.querySelector('.portconfig-item')) {
      this.paintLogMessages(tab, root, ports);
      return;
    }
    this.rowSignature.set(tab, signature);

    if (!ports.length) {
      root.innerHTML = NO_RECEIVER_NOTE + portRowHtml('Select', 'Select', 'Select');
      return;
    }
    root.innerHTML = ports
      .map((port) =>
        portRowHtml(
          port,
          String(interfaces[port]?.rxType ?? 'NONE'),
          String(interfaces[port]?.txType ?? 'NONE'),
        ),
      )
      .join('');
    this.paintLogMessages(tab, root, ports);
  }

  /** `portConfig.js:1590-1660` (`prepareMessageList`): the port's LOGLIST entries as chips. */
  private paintLogMessages(tab: TabId, root: Element, ports: string[]): void {
    const current = this.state.current(tab) as Record<string, Record<string, Record<string, unknown>>>;
    const logList = current[String(PORT_MSG.LOGLIST)] ?? {};
    for (const port of ports) {
      const row = root.querySelector(`#${port} .msg-items`);
      const area = root.querySelector(`#${port} .message-text-area`) as
        | (Element & { placeholder?: string })
        | null;
      if (!row) continue;
      const messages = Object.values(logList[port] ?? {})
        .map((entry) => String(entry?.name ?? entry?.message ?? ''))
        .filter(Boolean);
      row.innerHTML = messages
        .map((name) => `<li class="msg-item elidedText">${name}</li>`)
        .join('');
      if (area && messages.length) area.setAttribute('placeholder', messages.join(', '));
    }
  }
}
