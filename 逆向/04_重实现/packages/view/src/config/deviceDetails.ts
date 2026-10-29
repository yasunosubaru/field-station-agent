import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import { signalTypeDesc } from '../../../protocol/src/generated-status-tables.ts';
import {
  BaseConfigPage,
  addError,
  clearErrors,
  elementValue,
  setVisible,
} from './base.ts';

export const DETAILS_MSG = {
  VERSION: 37,
  GIII_ETHSTATUS: 4101,
  GIII_VERSION: 4108,
  CHANCONFIGLIST: 1148,
  MODELFEATURES: 1329,
  TERRASTARINFO: 1719,
  VERIPOSINFO: 1728,
  OCEANIXINFO: 2159,
  OCEANIXSTATUS: 2160,
  VALIDMODELS: 206,
  AUTHCODES: 1348,
} as const;

export type AuthCommand =
  | { kind: 'invalid'; messageKey: 'ENTER_VALID' }
  | { kind: 'ascii'; text: string; quotedModels: boolean }
  | { kind: 'binary'; params: ConfigDataMap; parts: string[] };

const AUTH_SPECIAL_CHARACTERS = /(?=.*[a-zA-Z])(?=.*[^a-zA-Z0-9])/;

/**
 * `deviceDetails.js:112-167`.
 *
 * The OEMSTAR path deliberately still sends the quoted ASCII command even when the first part
 * triggers the "special characters" error branch; that observable 2.11.0 quirk is retained.
 */
export function buildAuthCommand(input: string, generation: string): AuthCommand {
  const parts = input.split(',');
  const special = AUTH_SPECIAL_CHARACTERS.test(parts[0] ?? '');
  const quotedModels = generation === 'OEMSTAR';
  if (quotedModels) {
    return {
      kind: 'ascii',
      text: 'AUTH ' + parts.map((part) => `"${part}"`).join(','),
      quotedModels,
    };
  }
  if (special) return { kind: 'invalid', messageKey: 'ENTER_VALID' };

  let params: ConfigDataMap;
  if (parts.length <= 5) {
    params = [
      { state: ['ADD', 'enum', 4] },
      ...parts.map((part, index) => ({
        [`part${index + 1}`]: [part, 'string'] as [string, 'string'],
      })),
    ];
  } else {
    params = [
      { state: ['ADD', 'enum', 4] },
      { part1: [parts[0], 'string'] },
      { part2: [parts[1], 'string'] },
      { part3: [parts[2], 'string'] },
      { part4: [parts[3], 'string'] },
      { part5: [parts[4], 'string'] },
      { model: [(parts[5] ?? '') + '\0', 'string'] },
      {
        date: [
          parts[6] &&
          parts[6].length < 7 &&
          parts[6].trim() !== '' &&
          !Number.isNaN(Number(parts[6]))
            ? parts[6]
            : '\0',
          'string',
        ],
      },
    ];
  }
  return { kind: 'binary', params, parts };
}

export class DeviceDetailsPage extends BaseConfigPage {
  private readonly authTimers = new Map<TabId, number>();
  private readonly authSent = new Map<TabId, boolean>();
  private readonly input = new Map<TabId, string>();
  private readonly modelName = new Map<TabId, string>();
  private readonly authCodes = new Map<TabId, Record<string, unknown>[]>();
  private readonly terraStar = new Map<TabId, Record<string, unknown>>();
  private readonly oceanix = new Map<TabId, Record<string, unknown>>();
  private readonly veripos = new Map<TabId, Record<string, unknown>>();
  private readonly oceanixStatus = new Map<TabId, number>();
  private readonly nativeNeeds = new Map<TabId, string[]>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'deviceDetails',
      fragmentPath: './../deviceDetails/deviceDetails.html',
      containerId: (tab) => `deviceDetails-layout_${tab}`,
    });
  }

  override mount(tab: TabId, containerId = `deviceDetails-layout_${tab}`): boolean {
    const container = this.context.document.getElementById(containerId);
    if (!container) return false;
    const path = this.context.features(tab).isGIII
      ? './../deviceDetails/giii-deviceDetails.html'
      : this.fragmentPath;
    container.innerHTML = this.context.fragments.load(path);
    this.bindActions(tab, container);
    return true;
  }

  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    const input = container.querySelector('#InputAuthCode') as
      | (Element & { value?: string })
      | null;
    input?.addEventListener('input', () => {
      this.input.set(tab, input.value ?? '');
    });
    input?.addEventListener('keydown', (event) => {
      if (Number((event as KeyboardEvent).keyCode) === 32) event.preventDefault?.();
    });
    container.querySelector('#authcodeapplybutton')?.addEventListener('click', () => {
      this.sendAuthCommand(tab);
    });
    for (const button of container.querySelectorAll('#activatebutton')) {
      button.addEventListener('click', () => {
        const id = button.closest('li')?.id;
        if (id) this.sendModelCommand(tab, id);
      });
    }
    container.querySelector('#susbcriptionResendButton')?.addEventListener('click', () => {
      void this.resendSubscription(tab);
    });
    for (const heading of container.querySelectorAll('.panel-heading[data-toggle="collapse"]')) {
      heading.addEventListener('click', () => {
        heading.nextElementSibling?.classList.toggle('in');
      });
    }
    container.querySelector('.devicedetails-info-copy-to-clipboard')?.addEventListener('click', () => {
      this.context.copyText?.(this.giiiClipboardText(tab));
    });
  }

  setAuthInput(tab: TabId, value: string): void {
    this.input.set(tab, value);
    const field = this.context.document.querySelector(`#${tab} #InputAuthCode`) as
      | (Element & { value?: string })
      | null;
    if (field) field.value = value;
    this.state.setPending(tab, 'auth', 'value', value);
  }

  sendAuthCommand(tab: TabId): AuthCommand | undefined {
    clearErrors(this.context, tab);
    const raw = this.input.get(tab) ?? elementValue(this.context, tab, '#InputAuthCode');
    if (!raw) {
      addError(this.context, tab, '.authorization-apply-new-auth-code .title');
      return undefined;
    }
    const command = buildAuthCommand(raw, this.context.features(tab).generation);
    if (command.kind === 'invalid') {
      this.handleDeviceDetailsCommandResponse(2, tab, this.context.translate(command.messageKey));
      return command;
    }
    this.authSent.set(tab, false);
    if (command.kind === 'ascii') {
      if (AUTH_SPECIAL_CHARACTERS.test(raw.split(',')[0] ?? '')) {
        this.handleDeviceDetailsCommandResponse(
          2,
          tab,
          this.context.translate('ENTER_VALID'),
        );
      }
      this.context.sendRaw?.(tab, command.text + '\n');
      this.authSent.set(tab, true);
      this.authTimers.set(
        tab,
        this.context.clock.setTimeout(() => this.handleAbbAsciiResponse('<ERROR', tab), 3000),
      );
      return command;
    }
    this.commands.setCurrentFeature(this.name);
    this.commands.place(this.name, 'auth', command.params, tab);
    this.authTimers.set(
      tab,
      this.context.clock.setTimeout(
        () => this.handleDeviceDetailsCommandResponse(2, tab, undefined),
        2000,
      ),
    );
    return command;
  }

  sendModelCommand(tab: TabId, modelId: string): void {
    this.context.sendRaw?.(tab, `Model ${modelId.replace(/"/g, '')}\n`);
    this.context.operations?.connection?.deletePingPongCounter?.(tab);
    this.context.showLoadingScreen(tab, 30000, 'RESTARTING');
    this.context.operations?.connection?.resetSpectrumViewer?.(tab);
  }

  isAuthCommandSent(tab: TabId): boolean {
    return this.authSent.get(tab) === true;
  }

  handleDeviceDetailsCommandResponse(data: number, tab: TabId, error?: string): void {
    const timer = this.authTimers.get(tab);
    if (timer !== undefined) this.context.clock.clearTimeout(timer);
    this.authTimers.delete(tab);
    this.commands.removeFeature(this.name, tab);
    const text = this.decodeError(error);
    if (data === 2) {
      clearErrors(this.context, tab);
      const field = this.context.document.querySelector(`#${tab} #InputAuthCode`);
      field?.classList.add('error-border');
      const title = this.context.document.querySelector(
        `#${tab} .authorization-apply-new-auth-code .title`,
      );
      title?.classList.add('error-text');
      const layout = this.context.document.querySelector(`#${tab} .input-layout`);
      if (layout) {
        const info = this.context.document.createElement('div');
        info.className = 'error-info';
        const span = this.context.document.createElement('span');
        span.textContent = text || this.context.translate('ENTER_VALID');
        info.appendChild(span);
        layout.appendChild(info);
      }
      return;
    }
    clearErrors(this.context, tab);
    this.context.operations?.connection?.deletePingPongCounter?.(tab);
    this.context.showLoadingScreen(tab, 30000, 'RESTARTING');
    this.context.operations?.connection?.resetSpectrumViewer?.(tab);
  }

  handleAbbAsciiResponse(data: string, tab: TabId): void {
    this.authSent.set(tab, false);
    const timer = this.authTimers.get(tab);
    if (timer !== undefined) this.context.clock.clearTimeout(timer);
    this.authTimers.delete(tab);
    if (data.startsWith('<ERROR')) {
      this.handleDeviceDetailsCommandResponse(2, tab, undefined);
    } else if (data.startsWith('<OK')) {
      this.handleDeviceDetailsCommandResponse(1, tab, undefined);
    }
  }

  updateStatus(msgId: number, data: Record<string, unknown>, tab?: TabId): void {
    const id = tab ?? String(data.tab ?? '');
    if (!id) return;
    this.state.updateCurrent(id, msgId, data);
    if (msgId === DETAILS_MSG.GIII_VERSION) {
      this.renderGiiiVersion(id, data);
    } else if (msgId === DETAILS_MSG.GIII_ETHSTATUS) {
      this.renderGiiiEthernet(id, data);
    } else if (msgId === DETAILS_MSG.VERSION) {
      const container = this.context.document.querySelector(`#${id} .device-comp`);
      setVisible(container, false);
      const wrapper = this.context.document.querySelector(
        `#${id} .devicedetails-components .gnss-and-terrastar-wrapper`,
      ) as (Element & { style?: CSSStyleDeclaration }) | null;
      if (wrapper?.style) wrapper.style.flexDirection = 'column';
      for (const row of rowsOfData(data)) {
        const type = String(row.type ?? '');
        if (type === 'GPSCARD') {
          this.modelName.set(id, String(row.model ?? ''));
          this.state.updateCurrent(id, 'psn', row.PSN);
          this.setText(id, '#deviceDetailsgnssSerialNumber', row.PSN);
          this.setText(id, '#deviceDetailsgnssModelNumber', row.model);
          this.setText(id, '#activeModelName', row.model);
          this.setText(id, '#deviceDetailsgnssHardwareVersion', row.hardwareVersion);
          this.setText(id, '#deviceDetailsgnssSoftwareVersion', row.softwareVersion);
          this.setText(id, '#deviceDetailsgnssBootVersion', row.bootVersion);
          if (this.context.features(id).terrastarSupported) {
            void this.generateBarrierTokenReq(id);
          }
        } else if (type === 'ENCLOSURE') {
          setVisible(container, true);
          this.setText(id, '#deviceDetailsserialNumber', row.PSN === '' ? '--' : row.PSN);
        } else if (type === 'WIFI') {
          setVisible(container, true);
          this.setText(id, '#deviceDetailsreceiverWifi', row.model === '' ? '--' : row.model);
          this.setText(
            id,
            '#deviceDetailswifiSoftwareVersion',
            String(row.softwareVersion ?? '').split('$')[0] || '--',
          );
        } else if (type === 'Regulatory') {
          setVisible(container, true);
          this.setText(id, '#deviceDetailsregion', row.model === '' ? '--' : row.model);
        }
      }
    } else if (msgId === DETAILS_MSG.CHANCONFIGLIST) {
      this.renderChannelSignals(id, data);
    } else if (msgId === DETAILS_MSG.MODELFEATURES) {
      this.renderModelFeatures(id, data);
    } else if (msgId === DETAILS_MSG.VALIDMODELS) {
      this.renderValidModels(id, data);
    } else if (msgId === DETAILS_MSG.AUTHCODES) {
      const rows = Array.isArray(data) ? data : rowsOfData(data);
      this.authCodes.set(id, rows);
      this.renderAuthModelChoices(id, rows);
    } else if (msgId === DETAILS_MSG.TERRASTARINFO) {
      this.terraStar.set(id, data);
      this.renderSubscription(id);
    } else if (msgId === DETAILS_MSG.OCEANIXINFO) {
      this.oceanix.set(id, data);
      this.renderSubscription(id);
    } else if (msgId === DETAILS_MSG.VERIPOSINFO) {
      this.veripos.set(id, data);
      this.renderSubscription(id);
    } else if (msgId === DETAILS_MSG.OCEANIXSTATUS) {
      this.oceanixStatus.set(id, Number(data.access ?? 0));
      this.renderSubscription(id);
    }
  }

  override updateData(msgId: number, data: Record<string, unknown>): void {
    this.updateStatus(msgId, data, String(data.tab ?? ''));
  }

  updateTerraStarTile(tab: TabId, noInternet: boolean): void {
    const noInternetNode = this.context.document.querySelector(
      `#${tab} [data-lang-terrStar-No-internet]`,
    );
    setVisible(noInternetNode, noInternet);
    setVisible(
      this.context.document.querySelector(`#${tab} .terraStar-Services-Details`),
      !noInternet,
    );
    setVisible(
      this.context.document.querySelector(`#${tab} .terrastar-no-internet-connected`),
      noInternet,
    );
    setVisible(this.context.document.querySelector(`#${tab} #susbcriptionResendButton`), noInternet);
  }

  async getPSNDetails(psn: string, tab: TabId): Promise<void> {
    this.state.updateCurrent(tab, 'psn', psn);
    await this.generateBarrierTokenReq(tab);
  }

  async generateBarrierTokenReq(tab: TabId): Promise<void> {
    if (!this.context.features(tab).terrastarSupported) return;
    const psn = String(this.state.current(tab).psn ?? '');
    if (!psn) return;
    const host = this.context.operations?.terrastar;
    if (!host?.fetch) {
      this.requireNative(tab, 'serverConnect.getLmbdaResult + TerraStar HTTP API');
      return;
    }
    try {
      const value = await host.fetch('info', psn);
      this.terraStar.set(tab, value);
      this.updateTerraStarTile(tab, false);
    } catch {
      this.updateTerraStarTile(tab, true);
    }
  }

  async resendSubscription(tab: TabId): Promise<void> {
    if (!this.context.features(tab).terrastarSupported) return;
    const psn = String(this.state.current(tab).psn ?? '');
    const host = this.context.operations?.terrastar;
    if (!psn || !host?.fetch) {
      this.requireNative(tab, 'serverConnect.getLmbdaResult + TerraStar HTTP API');
      return;
    }
    try {
      const value = await host.fetch('resend', psn);
      this.terraStar.set(tab, value);
      this.updateTerraStarTile(tab, false);
    } catch {
      this.updateTerraStarTile(tab, true);
    }
  }

  resetDeviceDetailsUI(tab: TabId): void {
    this.input.delete(tab);
    this.authSent.set(tab, false);
    const field = this.context.document.querySelector(`#${tab} #InputAuthCode`) as
      | (Element & { value?: string })
      | null;
    if (field) field.value = '';
    clearErrors(this.context, tab);
    this.reset(tab);
  }

  isDataChanged(tab: TabId): boolean {
    return (
      (this.input.get(tab) ??
        (this.context.document.querySelector(`#${tab} #InputAuthCode`) as
          | (Element & { value?: string })
          | null)?.value ??
        '').length > 0
    );
  }

  nativeRequirements(tab: TabId): string[] {
    return [...(this.nativeNeeds.get(tab) ?? [])];
  }

  updateDummyData(tab: TabId): void {
    this.renderGiiiVersion(tab, {
      data: ['IOMASTER', 'DSPC', 'RFCC', 'RFDC'].map((type) => ({
        type,
        slotId: '--',
        moduleId: '--',
        psn: '--',
        hwVersion: '--',
        swVersion: '',
        pbcVersion: '--',
        sbcVersion: '--',
        fpgaVersion: '--',
        compDate: '--',
        compTime: '--',
        fwInfoTag: '--',
        pbcInfoTag: '--',
        sbcInfoTag: '--',
      })),
    });
  }

  protected runApply(tab: TabId): undefined {
    this.sendAuthCommand(tab);
    return undefined;
  }

  override handleCommandResponse(
    response: number,
    tab: TabId,
    _msgId?: number,
    error?: string,
  ): void {
    this.handleDeviceDetailsCommandResponse(response, tab, error);
  }

  protected render(_tab: TabId): void {}

  private renderGiiiVersion(tab: TabId, data: Record<string, unknown>): number {
    const table = this.context.document.querySelector(`#${tab} .g3-devicedetails-table`);
    if (!table) return 0;
    const components = giiiComponentColumns(rowsOfData(data));
    const headerRow = table.querySelector('.component-names');
    headerRow?.querySelectorAll('th:not(:first-child)').forEach((node) => node.remove());
    for (const row of table.querySelectorAll('.g3-deviceDetails-entries')) {
      row.querySelectorAll('td:not(:first-child)').forEach((node) => node.remove());
    }
    const fields: Array<[string, string, string]> = [
      ['slotId', 'slot-id', '-slot-id'],
      ['moduleId', 'module-id', '-module-id'],
      ['psn', 'psn', '-psn'],
      ['hwVersion', 'hw-version', '-hwVersion'],
      ['swVersion', 'sw-version', '-swVersion'],
      ['pbcVersion', 'pbc-sw-version', '-pbc-swVersion'],
      ['sbcVersion', 'sbc-sw-version', '-sbc-swVersion'],
      ['fpgaVersion', 'fpga-version', '-fpga-version'],
      ['compDate', 'fw-compile-date', '-fw-compile-date'],
      ['compTime', 'fw-compile-time', '-fw-compile-time'],
      ['fwInfoTag', 'fw-info-tag', '-fw-info-tag'],
      ['pbcInfoTag', 'pbc-info-tag', '-pbc-info-tag'],
      ['sbcInfoTag', 'sbc-info-tag', '-sbc-info-tag'],
    ];
    let written = 0;
    for (const [key, component] of components) {
      const th = this.context.document.createElement('th');
      th.id = `${key}-comp-name`;
      if (key === 'IOMASTER') {
        th.textContent = 'IO Master';
      } else {
        th.textContent = key.replace(/\d+$/, '');
        const tooltip = this.context.document.createElement('span');
        tooltip.className = 'spanInline';
        const marker = giiiTooltipMarker(key);
        tooltip.innerHTML =
          '<div class="tooltip"><i class="dev-details-info"></i>' +
          `<span class="tooltiptext" data-lang-${marker}>${this.context.translate(
            marker.toUpperCase().replace(/-/g, '_'),
          )}</span></div>`;
        th.appendChild(tooltip);
      }
      headerRow?.appendChild(th);
      written += 1;
      for (const [field, rowClass, suffix] of fields) {
        const row = table.querySelector(`tr.g3-deviceDetails-entries.${rowClass}`);
        if (!row) continue;
        const td = this.context.document.createElement('td');
        td.className = 'giii-details-fields';
        td.id = `${key}${suffix}`;
        const raw = component[field];
        td.textContent = raw === undefined || raw === null || String(raw) === '' ? '--' : String(raw);
        row.appendChild(td);
        written += 1;
      }
    }
    return written;
  }

  private renderGiiiEthernet(tab: TabId, data: Record<string, unknown>): number {
    const rows = rowsOfData(data);
    const row = rows.at(-1);
    if (!row) return 0;
    const details = Number(row.details ?? 0);
    const [speed, duplex] = GIII_ETHERNET_DETAILS[details] ?? ['--', '--'];
    this.setText(tab, '#giiiEthMacAddress', row.mac || '--');
    this.setText(tab, '#giiiEthSpeed', speed);
    this.setText(tab, '#giiiEthDuplex', duplex);
    return 3;
  }

  private renderChannelSignals(tab: TabId, data: Record<string, unknown>): number {
    const rows = Array.isArray(data.currentChanConfigData)
      ? (data.currentChanConfigData as Record<string, unknown>[])
      : rowsOfData(data);
    const found: Record<string, Set<string>> = {
      gps: new Set(),
      glo: new Set(),
      gal: new Set(),
      bds: new Set(),
      qzss: new Set(),
      navic: new Set(),
    };
    let sbas = false;
    for (const row of rows) {
      const code = Number(row.signalTypeCode ?? row.signalType ?? 0);
      const name = String(row.signalType ?? signalTypeDesc[code] ?? '');
      if (!name) continue;
      if (name.startsWith('SBAS')) sbas = true;
      for (const [key, labels] of Object.entries(signalLabels(name))) {
        if (!found[key]) continue;
        for (const label of labels) found[key].add(label);
      }
    }
    for (const [key, values] of Object.entries(found)) {
      const value = this.context.document.querySelector(`#${tab} #${key}Signals`);
      setVisible(value?.parentElement ?? null, values.size > 0);
      if (value) value.textContent = [...values].join(', ');
    }
    setVisible(this.context.document.querySelector(`#${tab} .sbas-corrections`), sbas);
    return Object.values(found).reduce((count, values) => count + values.size, 0) + Number(sbas);
  }

  private renderModelFeatures(tab: TabId, data: Record<string, unknown>): number {
    const rows = rowsOfData(data);
    const visible = new Set<string>();
    let api = false;
    let ppp = false;
    let rate = '';
    for (const row of rows) {
      const status = FEATURE_STATUS[Number(row.featureStatus ?? -1)] ?? '';
      const feature = FEATURE_TYPE[Number(row.featureType ?? -1)] ?? '';
      if (status === 'AUTHORIZED') {
        if (feature === 'DGPS_TX') visible.add('dgpstx');
        if (feature === 'RTK_TX') visible.add('rtktx');
        if (feature === 'RTK_FLOAT') visible.add('rtkfloat');
        if (feature === 'RTK_FIXED') visible.add('rtkfixed');
        if (feature === 'API') api = true;
        if (feature === 'PPP' || feature === 'LOW_END_POSITIONING') ppp = true;
      }
      if (feature === 'MAX_POS_RATE' && status) {
        rate = status.replace(/(\d+)(Hz)/i, '$1 $2');
      }
    }
    for (const id of ['dgpstx', 'rtktx', 'rtkfloat', 'rtkfixed']) {
      setVisible(this.context.document.querySelector(`#${tab} #${id}`), visible.has(id));
    }
    setVisible(this.context.document.querySelector(`#${tab} .authorization-api`), api);
    setVisible(this.context.document.querySelector(`#${tab} .ppp-corrections`), ppp);
    if (rate) this.setText(tab, '#deviceDetailsoutputRate', rate);
    return visible.size + Number(api) + Number(ppp) + Number(!!rate);
  }

  private renderSubscription(tab: TabId): void {
    const feature = this.context.features(tab);
    const terra = this.terraStar.get(tab);
    const oceanix = this.oceanix.get(tab);
    const veripos = this.veripos.get(tab);
    let state: 'terrastar' | 'oceanix' | 'veripos' | 'disabled' = 'disabled';
    if (feature.terrastarSupported && terra && String(terra.subscriptionService ?? '') !== '') {
      state = 'terrastar';
    } else if (
      oceanix &&
      this.oceanixStatus.get(tab) === 1 &&
      (String(oceanix.subscriptionService ?? '').startsWith('Oceanix') ||
        [2, 4].includes(Number(oceanix.subscriptionService)))
    ) {
      state = 'oceanix';
    } else if (veripos && [7, 100].includes(Number(veripos.mode))) {
      state = 'veripos';
    }
    const target = this.context.document.querySelector(`#${tab} #pppCorrections`);
    if (!target) return;
    for (const marker of ['unknown', 'basic-enabled', 'high-accuracy', 'disabled', 'oceanix']) {
      target.removeAttribute(`data-lang-${marker}`);
    }
    const fourth = String(feature.model ?? '')[3] ?? '';
    if (state === 'terrastar') {
      if (fourth === 'N') {
        setVisible(this.context.document.querySelector(`#${tab} .terrastarCard-comp`), false);
        target.textContent = 'Disabled';
        target.setAttribute('data-lang-disabled', '');
      } else if (fourth === 'L') {
        target.textContent = this.context.translate('BASIC_ENABLED');
        target.setAttribute('data-lang-basic-enabled', '');
      } else if (fourth === 'P' || fourth === 'R') {
        target.textContent = this.context.translate('HIGH_ACCURACY');
        target.setAttribute('data-lang-high-accuracy', '');
      }
    } else if (state === 'oceanix') {
      target.textContent = 'Oceanix';
      target.setAttribute('data-lang-oceanix', '');
      const year = Number(oceanix?.serviceEndYear ?? 0);
      const day = Number(oceanix?.serviceEndDay ?? 0);
      const expiry = year && day ? dateFromYearDay(year, day, false) : '';
      for (const node of this.context.document.querySelectorAll(`#${tab} .oceanixExpiry`)) {
        setVisible(node, !!expiry);
      }
      if (expiry) this.setText(tab, '#expirydate', expiry);
    } else if (state === 'veripos') {
      target.textContent = 'Veripos';
    } else {
      if (fourth === 'N') {
        setVisible(this.context.document.querySelector(`#${tab} .terrastarCard-comp`), false);
      }
      target.textContent = 'Disabled';
      target.setAttribute('data-lang-disabled', '');
    }
  }

  private giiiClipboardText(tab: TabId): string {
    const table = this.context.document.querySelector(`#${tab} .g3-devicedetails-table`);
    if (!table) return '';
    const headers = [...(table.querySelectorAll('.component-names th') as unknown as Element[])]
      .map((node) => node.id.split('-')[0]);
    // `giii-deviceDetails.js:310`: the shipped buffer starts with one comma.
    const lines = [',' + headers.join(',')];
    for (const row of table.querySelectorAll('.g3-deviceDetails-entries')) {
      lines.push(
        [...(row.querySelectorAll('td') as unknown as Element[])]
          .map((node) => node.textContent ?? '')
          .join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  private setText(tab: TabId, selector: string, value: unknown): void {
    const element = this.context.document.querySelector(`#${tab} ${selector}`);
    if (element) element.textContent = value === undefined || value === null ? '--' : String(value);
  }

  private renderValidModels(tab: TabId, data: Record<string, unknown>): void {
    const model = this.modelName.get(tab) ?? '';
    const rows = rowsOfData(data);
    const matching = rows.find(
      (row) =>
        row.model &&
        String((row.model as Record<string, unknown>).value ?? row.model) === model &&
        Number(row.expyear) !== 0 &&
        Number(row.expmonth) !== 0 &&
        Number(row.expday) !== 0,
    );
    const value =
      matching === undefined
        ? this.context.translate('PERMANENT')
        : `${matching.expyear}-${String(matching.expmonth).padStart(2, '0')}-${String(matching.expday).padStart(2, '0')}`;
    this.setText(tab, '#expiryDateValue', value);
  }

  private renderAuthModelChoices(tab: TabId, data: Record<string, unknown>[]): void {
    const current = this.modelName.get(tab);
    if (!current) return;
    const list = this.context.document.querySelector(
      `#${tab} .authorization-comp #authorization-layout .models-list-ul`,
    );
    if (!list) return;
    list.innerHTML = '';
    const allModels = data
      .filter((entry) => Number(entry.authCodeValidity) === 1)
      .map((entry) => {
        const raw =
          entry.authCodeString && typeof entry.authCodeString === 'object'
            ? String((entry.authCodeString as Record<string, unknown>).value ?? '')
            : String(entry.authCodeString ?? '');
        const codes = raw.split(',');
        let last = codes.at(-1) ?? '';
        if (Number(entry.authCodeType) === 2 && /^\d+$/.test(last)) last = codes.at(-2) ?? '';
        if (Number(entry.authCodeType) === 3) last = last.replace('EMBEDDED AUTH CODE: ', '');
        return /^\d+$/.test(last) ? '' : last;
      })
      .filter(Boolean);
    const detected = this.context.document.querySelector(`#${tab} .detected-model-info`);
    setVisible(detected, allModels.length !== 1);
    if (allModels.length === 1) return;
    const models = allModels.filter(
      (value) => value.toLowerCase() !== current.toLowerCase(),
    );
    for (const model of models) {
      const li = this.context.document.createElement('li');
      li.className = 'list-class';
      li.id = model;
      const span = this.context.document.createElement('span');
      span.className = 'model-name';
      span.textContent = model;
      const button = this.context.document.createElement('button');
      button.id = 'activatebutton';
      button.className = 'btn btn-default darkBtn';
      button.setAttribute('data-lang-activate', '');
      button.addEventListener('click', () => this.sendModelCommand(tab, model));
      li.append(span, button);
      list.appendChild(li);
    }
  }

  private decodeError(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 30) return value;
    const hex = value.slice(76, -8);
    let out = '';
    for (let index = 0; index + 1 < hex.length; index += 2) {
      out += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
    }
    return out;
  }

  private requireNative(tab: TabId, value: string): void {
    const current = this.nativeNeeds.get(tab) ?? [];
    if (!current.includes(value)) current.push(value);
    this.nativeNeeds.set(tab, current);
  }
}

function rowsOfData(data: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [data.data, data.blocks, data];
  for (const candidate of candidates) {
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
  return rows.length ? rows : [data];
}

function giiiComponentColumns(
  rows: Record<string, unknown>[],
): Array<[string, Record<string, unknown>]> {
  const output: Array<[string, Record<string, unknown>]> = [];
  for (const row of rows) {
    const base = String(row.type ?? '').trim();
    if (!base || base === 'UNKNOWN') continue;
    const exists = (key: string): boolean => output.some(([existing]) => existing === key);
    let key = base;
    if (exists(base)) {
      if (!exists(`${base}1`)) {
        const previous = output.find(([existing]) => existing === base);
        if (previous) previous[0] = `${base}1`;
      }
      let duplicate = 2;
      key = `${base}${duplicate}`;
      while (exists(key)) key = `${base}${++duplicate}`;
    } else if (exists(`${base}1`)) {
      let duplicate = 2;
      key = `${base}${duplicate}`;
      while (exists(key)) key = `${base}${++duplicate}`;
    }
    output.push([key, row]);
  }
  return output;
}

function giiiTooltipMarker(key: string): string {
  if (key.startsWith('DSPC')) return 'signal-processor';
  if (key.startsWith('RFCC')) return 'frequency-carrier';
  if (key.startsWith('RFDC')) return 'frequency-daughter';
  return '';
}

const GIII_ETHERNET_DETAILS: Record<number, [string, string]> = {
  1: ['Not Connected', ''],
  2: ['10 Mbits/sec', 'Full'],
  3: ['10 Mbits/sec', 'Half'],
  4: ['100 Mbits/sec', 'Full'],
  5: ['100 Mbits/sec', 'Half'],
};

const FEATURE_STATUS: Record<number, string> = {
  0: 'AUTHORIZED',
  1: 'UNAUTHORIZED',
  2: '0Hz',
  6: '20Hz',
  8: '100Hz',
  9: 'RATE_INVALID',
  15: 'STANDARD',
  20: 'COMMERCIAL_MEMS',
  21: 'TACTICAL',
  22: 'HIGH_GRADE_TACTICAL',
  23: 'NAVIGATION',
  25: 'SINGLE',
  26: 'DUAL',
  30: 'LITE',
  33: 'CONSUMER_MEMS',
  37: 'RADIO_TX',
};

const FEATURE_TYPE: Record<number, string> = {
  0: 'MAX_MSR_RATE',
  1: 'MAX_POS_RATE',
  3: 'MEAS_OUTPUT',
  4: 'DGPS_TX',
  5: 'RTK_TX',
  6: 'RTK_FLOAT',
  7: 'RTK_FIXED',
  8: 'RAIM',
  9: 'LOW_END_POSITIONING',
  10: 'ALIGN_HEADING',
  11: 'ALIGN_RELATIVE_POS',
  12: 'API',
  15: 'NTRIP',
  19: 'PPP',
  20: 'SCINTILLATION',
  22: 'INS',
  23: 'IMU',
  26: 'FEATURE_INTERFERENCE_MITIGATION',
  28: 'ANTENNA',
  29: 'GENERIC_IMU',
  30: 'INS_PLUS_PROFILES',
  31: 'HEAVE',
  32: 'RELATIVE_INS',
  999: 'MODEL_INVALID',
};

function signalLabels(name: string): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  if (name.startsWith('GPS')) {
    output.gps = [
      ...(name.includes('L1') ? ['L1'] : []),
      ...(name.includes('L2') ? ['L2'] : []),
      ...(name.includes('L5') ? ['L5'] : []),
    ];
  } else if (name.startsWith('GLO')) {
    output.glo = [
      ...(name.includes('L1') ? ['L1'] : []),
      ...(name.includes('L2') ? ['L2'] : []),
      ...(name.includes('L3') ? ['L3'] : []),
    ];
  } else if (name.startsWith('GAL')) {
    output.gal = [
      ...(name.includes('E1') ? ['E1'] : []),
      ...(/E5A|E5B|ALTBOC/.test(name) ? ['E5'] : []),
      ...(name.includes('E6') ? ['E6'] : []),
    ];
  } else if (name.startsWith('BEIDOU')) {
    output.bds = [
      ...(name.includes('B1') ? ['B1'] : []),
      ...(/B2B|B2I/.test(name) || (!/B2B|B2I/.test(name) && name.includes('B2'))
        ? ['B2']
        : []),
      ...(name.includes('B3') ? ['B3'] : []),
    ];
  } else if (name.startsWith('QZSS')) {
    output.qzss = [
      ...(name.includes('L1') ? ['L1'] : []),
      ...(name.includes('L2') ? ['L2'] : []),
      ...(name.includes('L5') ? ['L5'] : []),
      ...(name.includes('L6') ? ['L6'] : []),
    ];
  } else if (name.startsWith('NAVIC')) {
    output.navic = [...(name.includes('L5') ? ['L5'] : [])];
  }
  return output;
}

function dateFromYearDay(year: number, day: number, iso: boolean): string {
  const result = new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
  const dd = String(result.getUTCDate()).padStart(2, '0');
  const month = String(result.getUTCMonth() + 1).padStart(2, '0');
  return iso ? `${year}-${month}-${dd}` : `${dd}-${month}-${year}`;
}
