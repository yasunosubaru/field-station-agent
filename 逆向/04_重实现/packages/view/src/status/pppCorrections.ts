import {
  MSG_ID,
  escapeHTML,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  setStyle,
  showRag,
  tabOf,
  applyLanguageMarkers,
  __,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';

interface PppEntry {
  trackingState: unknown;
  syncState: unknown;
  option: number | null;
  ntripStatus: string | null;
  isAnySignalEnabled: string | null;
  subscriptionState: boolean | null;
  terrastar: boolean;
  oceanix: boolean;
  veripos: boolean;
  isAnySignalEnabledandCNo: boolean | null;
  satelliteStatusStats: LogData;
  veriposStatusStats: LogData;
  lbandRows: LogData[];
}

type PppState = PppEntry;

export class PppCorrections {
  readonly pppRagStatus: Record<TabId, PppState> = {};
  readonly ntripData: Record<TabId, Record<string, LogData>> = {};
  readonly interfaceModeData: Record<TabId, Record<string, LogData>> = {};
  readonly oceanixStatus: Record<TabId, unknown> = {};
  private readonly ctx: StatusContext;
  private readonly markRag: (tab: TabId, msgId: number) => void;
  private readonly wiredTabs = new Set<TabId>();
  private readonly detailsExpanded: Record<TabId, boolean> = {};
  private readonly detailsTouched: Record<TabId, boolean> = {};

  constructor(ctx: StatusContext, markRag: (tab: TabId, msgId: number) => void = () => {}) {
    this.ctx = ctx;
    this.markRag = markRag;
  }

  updateStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    this.markRag(tab, msgID);

    if (msgID === MSG_ID.LBANDTRACKSTAT) {
      const rows = rowsOf(data);
      state.lbandRows = (rows.length ? rows : [data]).map((row) => ({ ...row }));
      const locked = state.lbandRows.some((row) => numberValue(row.trackingState ?? row.state ?? row.status) === 2);
      const enabled = state.lbandRows.filter((row) => numberValue(row.frequency) > 0);
      const enabledWithCno = enabled.filter((row) => numberValue(row['C/No']) > 0);
      state.isAnySignalEnabled = enabled.length ? (locked ? 'good' : 'bad') : 'idle';
      state.isAnySignalEnabledandCNo = enabledWithCno.length > 0;
      showRag(this.ctx, tab, 'lbandstatus', locked ? 'good' : 'bad');
      this.renderBands(tab, state.lbandRows);
    } else if (msgID === MSG_ID.ASSIGNLBANDBEAM) {
      state.option = numberValue(data.option);
      const hidden = state.option === 0;
      setStyle(this.ctx.document.querySelector(`#${tab} .corrections-status-tiles-traffic`), 'display', hidden ? 'block' : 'none');
      setStyle(this.ctx.document.querySelector(`#${tab} .square-info-box.lband-tracking-contnet`), 'display', hidden ? 'none' : 'block');
      setStyle(this.ctx.document.querySelector(`#${tab} .square-info-box.primary-signal-contnet`), 'display', hidden ? 'none' : 'block');
      setStyle(this.ctx.document.querySelector(`#${tab} .corrections-signal-strength-section`), 'display', hidden ? 'none' : 'block');
      setStyle(this.ctx.document.querySelector(`#${tab} .corrections-bit-success-rate-section`), 'display', hidden ? 'none' : 'block');
    } else if (msgID === MSG_ID.TERRASTARSTATUS || msgID === MSG_ID.OCEANIXSTATUS) {
      if (msgID === MSG_ID.OCEANIXSTATUS) this.oceanixStatus[tab] = data.access;
      state.satelliteStatusStats = { ...data };
      this.updateLocked(tab, numberValue(data.syncState, -1));
    } else if (msgID === MSG_ID.TERRASTARINFO || msgID === MSG_ID.OCEANIXINFO || msgID === MSG_ID.VERIPOSINFO) {
      const previous = state.subscriptionState;
      if (msgID === MSG_ID.TERRASTARINFO) state.terrastar = String(data.subscriptionService ?? '') !== '';
      else if (msgID === MSG_ID.OCEANIXINFO) {
        state.oceanix =
          numberValue(this.oceanixStatus[tab]) === 1 &&
          String(data.subscriptionService ?? '').startsWith('Oceanix');
      } else {
        state.veripos = ['VERIPOS', 'VERIPOS_A'].includes(String(data.mode ?? '')) || numberValue(data.mode) === 100;
      }
      state.subscriptionState = state.terrastar || state.oceanix || state.veripos;
      if (previous !== state.subscriptionState) {
        this.updateSubscription(tab, state.subscriptionState);
      }
    } else if (msgID === MSG_ID.NTRIPCONFIG) {
      this.ntripData[tab] ??= {};
      this.ntripData[tab][String(data.port ?? '')] = { ...data };
    } else if (msgID === MSG_ID.INTERFACEMODE) {
      this.interfaceModeData[tab] ??= {};
      this.interfaceModeData[tab][String(data.port ?? '')] = { ...data };
    } else if (msgID === MSG_ID.VERIPOSDECODERSTATUS) {
      const rows = rowsOf(data);
      let ntripMatchesDefault = false;
      for (const [port, ntrip] of Object.entries(this.ntripData[tab] ?? {})) {
        const mode = this.interfaceModeData[tab]?.[port];
        if (mode?.responses !== 'ON' || mode?.rxType !== 'VERIPOS') continue;
        const candidate: LogData = {
          type: 'CLIENT',
          endpoint: 'sid-output.com:2101',
          mountpoint: 'SID08',
          userName: 'SID',
          password: 'MELs9tPw4',
          operatingMode: 'Receive',
          port,
          tab: ntrip.tab,
          time: ntrip.time,
        };
        if (ntrip.mountpoint === 'SID08' || ntrip.mountpoint === 'SID09') {
          candidate.mountpoint = ntrip.mountpoint;
        }
        ntripMatchesDefault = deepEqualSubset(candidate, ntrip);
      }
      if (ntripMatchesDefault) {
        const ncom = rows.find(
          (row) =>
            String(row.comPort ?? '').includes('NCOM') ||
            String(row.name ?? '').includes('UNKNOWN'),
        );
        if (ncom) state.veriposStatusStats = { ...ncom };
        const locked = rows.some(
          (row) =>
            numberValue(row.syncState) === 2 &&
            String(row.comPort ?? '').startsWith('NCOM'),
        );
        state.ntripStatus = locked ? 'good' : 'bad';
        showRag(this.ctx, tab, 'pppNtripLink', state.ntripStatus);
        setStyle(
          this.ctx.document.querySelector(`#${tab} .ppp-ntrip-link-status`),
          'display',
          'block',
        );
      } else {
        state.ntripStatus = 'idle';
        showRag(this.ctx, tab, 'pppNtripLink', 'idle');
        setStyle(
          this.ctx.document.querySelector(`#${tab} .ppp-ntrip-link-status`),
          'display',
          'none',
        );
      }
    } else {
      return 0;
    }
    this.updateOverall(tab);
    return 1;
  }

  getSubscribedState(tab: TabId, pppOverAllStatusIndicatorClick = false): string | string[] {
    const state = this.pppRagStatus[tab];
    if (!state || state.subscriptionState === false) return 'pppStatusUnsubscribed';
    const messages: string[] = [];
    const sync = numberValue(state.satelliteStatusStats.syncState, -1);
    if (pppOverAllStatusIndicatorClick && state.isAnySignalEnabled === 'bad' && state.ntripStatus === 'bad') {
      if (sync === 0 && state.isAnySignalEnabledandCNo === false) messages.push('lbandNonStatusRed');
      else if (sync === 2 && state.isAnySignalEnabledandCNo === false) messages.push('lbandStatusRed');
      if (state.veriposStatusStats.syncState === 2 && state.veriposStatusStats.comPort === 'NOPORT') {
        messages.push('ntripLinkNonLockedRed');
      } else if (state.ntripStatus === 'bad') messages.push('ntripLinkLockedRed');
      return messages;
    }
    if (state.isAnySignalEnabled === 'bad' && (state.ntripStatus === 'bad' || state.ntripStatus === 'idle')) return 'pppStatusRed';
    if (state.isAnySignalEnabled === 'idle' && state.ntripStatus === 'bad') return 'pppStatusRed';
    if (state.veriposStatusStats.syncState === 2 && state.veriposStatusStats.comPort === 'NOPORT') return 'ntripLinkNonLockedRed';
    if (state.ntripStatus === 'bad') return 'ntripLinkLockedRed';
    if (sync === 0 && state.isAnySignalEnabledandCNo === false) return 'lbandNonStatusRed';
    if (sync === 2 && state.isAnySignalEnabledandCNo === false) return 'lbandStatusRed';
    return 'pppStatusRed';
  }

  resetDataObject(tab: TabId): void {
    this.ntripData[tab] = {};
    this.interfaceModeData[tab] = {};
    delete this.oceanixStatus[tab];
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['ppp-corrections', 'PPPCORRECTIONS'], ['ppp-corrections-off', 'PPPCORRECTIONSOFF'],
      ['warning', 'WARNING'], ['lband', 'LBAND'], ['lband-cno', 'LBAND_CNO'],
      ['primary-beam-cno', 'PRIMARY_BEAM_CNO'], ['primary-secondary-cno', 'SECONDARY_BEAM_CNO'],
      ['teritary-beam-cno', 'TERTIARY_BEAM_CNO'], ['ntrip-link', 'NTRIP_LINK'],
      ['ppp-ntrip-link', 'PPP_NTRIP_LINK'], ['pppstatusamber', 'PPPSTATUSAMBER'],
      ['pppstatusred', 'PPPSTATUSRED'], ['pppstatusunsubscribed', 'PPPSTATUSUNSUBSCRIBED'],
      ['ntripLinkNonLockedRed', 'NTRIPLINKLOCKEDRED'],
      ['ntripLinkLockedRed', 'NTRIPLINKNONLOCKEDRED'],
      ['lbandNonStatusRed', 'LBANDNONSTATUSRED'], ['lbandStatusRed', 'LBANDSTATUSRED'],
      ['correction-link', 'CORRECTION_LINK'], ['show-details', 'SHOW_DETAILS'],
      ['hide-details', 'HIDE_DETAILS'], ['subscribed', 'SUBSCRIBED'],
      ['unsubscribed', 'UNSUBSCRIBED'], ['locked', 'LOCKED'], ['unlocked', 'UNLOCKED'],
      ['lband-tracking', 'LBAND_TRACKING'], ['primary-signal', 'PRIMARY_SIGNAL'],
      ['enabled', 'ENABLED'], ['off', 'OFF'], ['active', 'ACTIVE'], ['error', 'ERROR'],
      ['signal-strength', 'SIGNAL_STRENGTH'], ['beam-info', 'BEAM_INFO'],
      ['bit-success-rate', 'BIT_SUCCESS_RATE'],
    ];
    applyLanguageMarkers(this.ctx, [
      ...keys.map(([marker, key]) => ({ selector: `[data-lang-${marker}]`, value: __(this.ctx, key) })),
      {
        selector: '[data-lang-title-pppstatusamber]',
        value: `${__(this.ctx, 'PPPCORRECTIONS')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}`,
      },
      {
        selector: '[data-lang-title-ntriplinkred]',
        value: `${__(this.ctx, 'PPPNTRIP')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
      {
        selector: '[data-lang-title-pppstatusred]',
        value: `${__(this.ctx, 'PPPCORRECTIONS')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
    ]);
  }

  private ensure(tab: TabId): PppState {
    return (this.pppRagStatus[tab] ??= {
      trackingState: null,
      syncState: null,
      option: null,
      ntripStatus: null,
      isAnySignalEnabled: null,
      subscriptionState: false,
      terrastar: false,
      oceanix: false,
      veripos: false,
      isAnySignalEnabledandCNo: null,
      satelliteStatusStats: {},
      veriposStatusStats: {},
      lbandRows: [],
    });
  }

  private updateLocked(tab: TabId, sync: number): void {
    const state = sync === 2 ? 'good' : sync === 1 ? 'warning' : 'idle';
    showRag(this.ctx, tab, 'locked', state);
    const scope = this.ctx.document.querySelector(`#${tab} .rectangle-status-box.locked`);
    if (!scope) return;
    for (const node of scope.querySelectorAll('span')) {
      node.classList.remove('green-status', 'yellow-status', 'red-status', 'grey-status');
    }
    const label = scope.querySelector(`.${sync === 2 ? 'locked-label' : 'unlocked-label'}`);
    if (label) label.classList.add(sync === 2 ? 'green-status' : sync === 1 ? 'yellow-status' : 'grey-status');
  }

  private renderBands(tab: TabId, rows: LogData[]): void {
    const clean = rows.filter(
      (row) =>
        String(row.name ?? '').trim() !== 'LbandCno' &&
        (String(row.name ?? '').trim() !== '' ||
          (String(row.name ?? '').trim() === '' && numberValue(row.frequency) !== 0)),
    );
    for (const row of clean) {
      if (!String(row.name ?? '').trim() && numberValue(row.frequency) > 0) row.name = 'Manual';
    }
    clean.sort((a, b) => numberValue(b['C/No']) - numberValue(a['C/No']));
    const state = this.ensure(tab);
    const disconnected =
      numberValue(state.satelliteStatusStats.access) === 1 &&
      numberValue(state.satelliteStatusStats.syncState) === 0;
    const signal = this.ctx.document.querySelector(`#${tab} #signalStrength .ppp-cno`);
    const bsr = this.ctx.document.querySelector(`#${tab} #bitSuccessRate .ppp-cno`);
    if (signal) {
      signal.innerHTML = clean
        .map(
          (row) => {
            const cno = numberValue(row['C/No']);
            const className = disconnected
              ? ''
              : cno > 39
                ? 'green-bar'
                : cno >= 36
                  ? 'yellow-bar'
                  : 'red-bar';
            const width = disconnected ? '0px' : `${Math.min(100, (cno / 60) * 100)}%`;
            return `<div class="row ppp-cno-val" id="${escapeHTML(String(row.name))}"><span class="satellite-name ppp-signal-status">${escapeHTML(String(row.name))}</span><div class="signal-progress-bar-container"><div class="progress-bar-data signal-strength-progress-bar"><div class="progress-bar-fill ${className}" style="width: ${width}"></div><hr class="errorLabel-line" id="fixedVStrengthline"><hr class="warningLabel-line" id="fixedVStrengthline"><span class="error-value" id="fixedVStrengthVal">36</span><span class="warning-value" id="fixedVStrengthVal">39</span></div><span class="component-value">${formatNumber(this.ctx, cno, 2, tab)} dB/Hz</span></div></div>`;
          },
        )
        .join('');
    }
    if (bsr) {
      bsr.innerHTML = clean
        .map((row) => {
          const error = numberValue(row.biterrorRate) * 100;
          let successValue: number =
            disconnected || numberValue(row['C/No']) === 0
              ? 0
              : error === 0
                ? 100
                : 100 - error;
          if (successValue === 100) successValue = 100;
          const success =
            successValue === 100 ? '100' : formatNumber(this.ctx, successValue, 2, tab);
          const className =
            successValue > 98
              ? 'green-bar'
              : successValue >= 94
                ? 'yellow-bar'
                : 'red-bar';
          const radius = successValue === 100 ? 'border-radius: 54px;' : '';
          const width = disconnected ? '0px' : `${Math.min(100, successValue)}%`;
          return `<div class="row ppp-cno-val" id="${escapeHTML(String(row.name))}"><span class="satellite-name ppp-signal-status">${escapeHTML(String(row.name))}</span><div class="signal-progress-bar-container"><div class="progress-bar-data signal-strength-progress-bar"><div class="progress-bar-fill ${className}" style="width: ${width}; ${radius}"></div><hr class="errorLabel-line" id="fixedVStrengthline"><hr class="warningLabel-line" id="fixedVStrengthline"><span class="error-value" id="fixedVStrengthVal">94%</span><span class="warning-value" id="fixedVStrengthVal">98%</span></div><span class="component-value">${success} %</span></div></div>`;
        })
        .join('');
    }
    const first = String(clean[0]?.name ?? '');
    const primary = this.ctx.document.querySelector(`#${tab} .corrections-info-section .primary-signal-name`);
    if (primary && first) primary.textContent = first;
    const linkType = this.ctx.document.querySelector(`#${tab} .ppp-corrections-container .link-type`);
    setStyle(linkType, 'display', clean.length > 1 ? 'block' : 'none');
    for (const beamInfo of this.ctx.document.querySelectorAll(
      `#${tab} .beam-info-label-sub-container`,
    )) {
      setStyle(beamInfo, 'display', clean.length > 1 ? 'inline' : 'none');
      const label = beamInfo.querySelector('.beam-info');
      if (label) {
        label.textContent = __(this.ctx, 'BEAM_INFO').replace('%1', String(clean.length));
      }
    }
    this.wireUi(tab);
    this.applyDetailsView(tab);
  }

  private wireUi(tab: TabId): void {
    if (this.wiredTabs.has(tab)) return;
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    this.wiredTabs.add(tab);
    this.detailsExpanded[tab] ??= false;
    scope
      .querySelector('.ppp-corrections-container .switch-show-hide-details')
      ?.addEventListener('click', (event) => {
        event.preventDefault();
        const button = scope.querySelector(
          '.ppp-corrections-container .switch-show-hide-details',
        );
        if (!button) return;
        this.detailsTouched[tab] = true;
        this.detailsExpanded[tab] = !this.detailsExpanded[tab];
        const expanded = this.detailsExpanded[tab];
        button.classList.toggle('show-details', !expanded);
        button.classList.toggle('hide-details', expanded);
        button.removeAttribute(expanded ? 'data-lang-show-details' : 'data-lang-hide-details');
        button.setAttribute(
          expanded ? 'data-lang-hide-details' : 'data-lang-show-details',
          '',
        );
        button.textContent = __(this.ctx, expanded ? 'HIDE_DETAILS' : 'SHOW_DETAILS');
        this.applyDetailsView(tab);
      });
  }

  private applyDetailsView(tab: TabId): void {
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    const expanded = this.detailsExpanded[tab] === true;
    const collapsed = this.detailsTouched[tab] === true && !expanded;
    for (const selector of ['#signalStrength', '#bitSuccessRate']) {
      const host = scope.querySelector(selector);
      if (!host) continue;
      const rows = host.querySelectorAll('.row.ppp-cno-val');
      rows.forEach((row, index) =>
        setStyle(row, 'display', collapsed && index > 0 ? 'none' : 'block'),
      );
      for (const name of host.querySelectorAll('.row.ppp-cno-val .satellite-name')) {
        setStyle(name, 'display', collapsed ? 'none' : 'block');
      }
      for (const container of host.querySelectorAll('.signal-progress-bar-container')) {
        container.classList.toggle('container-top', expanded);
      }
      const satelliteContainer = host.querySelector('.satellite-container');
      setStyle(satelliteContainer, 'display', collapsed ? 'block' : 'none');
      const beamInfo = host.querySelector('.beam-info-label-sub-container');
      setStyle(beamInfo, 'display', collapsed ? 'inline-block' : 'none');
      const top = rows.find((row) => row.style.display !== 'none');
      const topName = satelliteContainer?.querySelector('.satellite-name');
      if (topName && top) topName.textContent = top.id;
    }
  }

  private updateSubscription(tab: TabId, subscribed: boolean): void {
    const scope = this.ctx.document.querySelector(`#${tab} .rectangle-status-box.subscribed`);
    if (!scope) return;
    for (const node of scope.querySelectorAll('span')) {
      node.classList.remove('red-status', 'green-status', 'grey-status');
    }
    if (subscribed) {
      scope.querySelector('.subscribed-label')?.classList.add('green-status');
    } else {
      scope.querySelector('.unsubscribed-label')?.classList.add('red-status');
    }
    showRag(this.ctx, tab, 'subscribed', subscribed ? 'good' : 'bad');
    showRag(this.ctx, tab, 'pppStatus', subscribed ? 'good' : 'bad');
  }

  private updateOverall(tab: TabId): void {
    const state = this.ensure(tab);
    let rag: string;
    if (
      (state.subscriptionState === false && state.option === 0 && state.ntripStatus === 'idle') ||
      (state.subscriptionState === null && state.ntripStatus === null && state.isAnySignalEnabled === 'idle')
    ) {
      rag = 'idle';
    } else if (state.subscriptionState === false) {
      rag = 'bad';
    } else if (state.option === 0 && state.ntripStatus === 'idle') {
      rag = 'idle';
    } else if (state.isAnySignalEnabled === 'bad' || state.ntripStatus === 'bad') {
      rag = 'bad';
    } else if (numberValue(state.satelliteStatusStats.syncState) === 1) {
      rag = 'warning';
    } else if (state.isAnySignalEnabled === 'good' || state.ntripStatus === 'good') {
      rag = 'good';
    } else {
      rag = 'idle';
    }
    showRag(this.ctx, tab, 'pppStatus', rag);
    const enabled = rag !== 'idle';
    setStyle(this.ctx.document.querySelector(`#${tab} .ppp-status-main-container`), 'display', enabled ? 'block' : 'none');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-position-config`), 'display', enabled ? 'none' : 'block');
    const title = this.ctx.document.querySelector(`#${tab} .ppp-pc-title`);
    if (title) {
      title.textContent = __(this.ctx, enabled ? 'PPPCORRECTIONS' : 'PPPCORRECTIONSOFF');
    }
  }
}

function deepEqualSubset(expected: LogData, actual: LogData): boolean {
  for (const [key, value] of Object.entries(expected)) {
    const other = actual[key];
    if (value && typeof value === 'object') {
      if (!other || typeof other !== 'object' || !deepEqualSubset(value as LogData, other as LogData)) {
        return false;
      }
    } else if (String(value) !== String(other)) {
      return false;
    }
  }
  return true;
}
