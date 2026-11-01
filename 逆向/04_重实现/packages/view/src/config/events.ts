import type { TabId } from './../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, setVisible } from './base.ts';

export const EVENT_MSG = {
  BESTPOS: 42,
  TRACKSTAT: 83,
  RXSTATUS: 93,
  RXSTATUSEVENT: 94,
  TIME: 101,
  NMEA_GSV: 223,
  HWMONITOR: 963,
  SATVIS2: 1043,
  LBANDTRACKSTAT: 1201,
  INSPVAX: 1465,
  ITDETECTSTATUS: 2065,
  LONGHORN_NMEA: 2353,
} as const;

export const EVENTS_DATA_LANG_MAP: Record<string, string> = {
  'data-lang-high-ins-std-dev': 'EVENTS_HIGH_INS_STD_DEV',
  'data-lang-spoofing-detected': 'SPOOFING_DETECTED',
  'data-lang-itk-detected': 'ITK_DETECTED',
  'data-lang-itk-detected-at': 'ITK_DETECTED_AT',
  'data-lang-no-lband': 'EVENTS_NO_LBAND',
  'data-lang-no-position-available': 'NO_POSITION_AVAILABLE',
  'data-lang-high-pos-std-dev': 'HIGH_POS_STD_DEV',
  'data-lang-no-sbas-tracked': 'NO_SBAS_TRACKED',
  'data-lang-sbas-tracking-less': 'SBAS_TRACKING_LESS',
  'data-lang-gps-tracking-less': 'GPS_TRACKING_LESS',
  'data-lang-gps-tracking-less-good': 'GPS_TRACKING_LESS_GOOD',
  'data-lang-glo-tracking-less': 'GLO_TRACKING_LESS',
  'data-lang-gal-tracking-less': 'GAL_TRACKING_LESS',
  'data-lang-gal-tracking-less-good': 'GAL_TRACKING_LESS_GOOD',
  'data-lang-bds-tracking-less': 'BDS_TRACKING_LESS',
  'data-lang-bds-tracking-less-good': 'BDS_TRACKING_LESS_GOOD',
  'data-lang-navic-tracking-less': 'NAVIC_TRACKING_LESS',
  'data-lang-3v3-warning': '3V3_WARNING',
  'data-lang-voltage-warning': 'EVENTS_VOLTAGE_WARNING',
  'data-lang-1v2-warning': '1V2_WARNING',
  'data-lang-ant-vol-warning': 'ANT_VOL_WARNING',
  'data-lang-lghn-ant-vol-warning': 'ANT_VOL_WARNING_LGHN',
  'data-lang-ant-current-warning': 'ANT_CURRENT_WARNING',
  'data-lang-tcxo-warning': 'TCXO_WARNING',
  'data-lang-3v3-error': '3V3_ERROR',
  'data-lang-3v3-low-error': 'SUPPL_VOLTAGE_LW_ERR',
  'data-lang-3v3-upper-error': 'SUPPL_VOLTAGE_UPP_ERR',
  'data-lang-voltage-error': 'EVENTS_VOLTAGE_ERROR',
  'data-lang-1v2-error': '1V2_ERROR',
  'data-lang-ant-vol-error': 'ANT_VOL_ERROR',
  'data-lang-ant-current-error': 'ANT_CURRENT_ERROR',
  'data-lang-tcxo-error': 'TCXO_ERROR',
  'data-lang-high-cpu': 'HIGH_CPU',
  'data-lang-1v8-vol-error': '1V8_VOL_ERROR',
  'data-lang-1v8-vol-warning': '1V8_VOL_WARNING',
  'data-lang-ddr-temp-error': 'DDR_TEMP_ERROR',
  'data-lang-ddr-temp-warning': 'DDR_TEMP_WARNING',
  'data-lang-invalid-model': 'INVALID_MODEL',
  'data-lang-invalid-authcode': 'INVALID_AUTHCODE',
  'data-lang-com1-buffer-overrun': 'COM1_BUFFER_OVERRUN',
  'data-lang-com2-buffer-overrun': 'COM2_BUFFER_OVERRUN',
  'data-lang-good': 'GOOD',
  'data-lang-warning': 'WARNING',
  'data-lang-error': 'ERROR',
};

export interface EventEntry {
  startTime: Date;
  state: 'Good' | 'Moderate' | 'Poor' | string;
  alive: boolean;
  description: string;
  actualStr: string;
  endTime: Date | '';
  freqValue?: number;
}

interface EventState {
  current: Record<number, Record<string, unknown>>;
  previous: Record<number, Record<string, unknown>>;
  events: Record<string, EventEntry>;
  receiverTime: Date;
  filters: Set<string>;
  historyLimit: number;
  powerStatus?: number;
}

/** `events.js` reducers, history and `.esl` export. */
/**
 * The interference frequencies `ITDETECTSTATUS` (#2065) reports, as the Events page counts them.
 *
 * Two shapes reach this code: the live link's projection puts the rows in `data.data`, and a
 * capture's decoded records arrive as flat `interference_statuses[i].field` paths. Both are read by
 * the **layout's** field names (`frequency`, `int_detect_method`) — the earlier transcription used
 * `centerFrequency`/`detectionType`, which never match (measured against `data/edie-layouts.json`
 * and the b7 capture, 2026-11-01).
 *
 * `NONE`/empty means nothing detected; `STATISTICANALYSIS` is the statistical detector, which does
 * not raise events here either (only the spectrum detector does), matching the original.
 */
export function itkDetections(data: Record<string, unknown>): Set<number> {
  const rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(data.data)) {
    for (const raw of data.data) {
      if (raw && typeof raw === 'object') rows.push(raw as Record<string, unknown>);
    }
  } else {
    const grouped = new Map<number, Record<string, unknown>>();
    for (const [key, value] of Object.entries(data)) {
      const match = /^interference_statuses\[(\d+)\]\.(\w+)$/.exec(key);
      if (!match) continue;
      const index = Number(match[1]);
      const row = grouped.get(index) ?? {};
      row[match[2]] = value;
      grouped.set(index, row);
    }
    rows.push(...grouped.values());
  }
  const current = new Set<number>();
  for (const row of rows) {
    const method = String(row.int_detect_method ?? row.detectionType ?? '').toUpperCase();
    if (!method || method === 'NONE' || method === 'STATISTICANALYSIS') continue;
    // The centre frequency of a spectrum detection is the record's **`parameter1`**: the field the
    // layout calls `frequency` is the band enum (`L2`), measured on the b7 lines
    // `1,L2,SPECTRUMANALYSIS,1270.176,…` (2026-11-01).
    const frequency = Math.round(Number(row.parameter1 ?? row.frequency ?? 0));
    if (frequency) current.add(frequency);
  }
  return current;
}

export class EventsPage extends BaseConfigPage {
  private readonly states = new Map<TabId, EventState>();
  private readonly itkFrequencies = new Map<TabId, Set<number>>();
  private readonly idleTimers = new Map<TabId, number>();
  private readonly snoozeUntil = new Map<TabId, number>();
  private readonly snoozeTimers = new Map<TabId, number>();
  readonly events_data_lang_map = EVENTS_DATA_LANG_MAP;

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'events',
      fragmentPath: './../events/events.html',
      containerId: (tab) => `events-panel-${tab}`,
    });
  }

  protected override bindActions(tab: TabId, container: Element): void {
    for (const tabButton of container.querySelectorAll('.eventsTab')) {
      tabButton.addEventListener('click', () => {
        const historic = tabButton.id === 'eventsHistoricTab';
        container.querySelector('#eventsCurrentTab')?.classList.toggle('active', !historic);
        container.querySelector('#eventsHistoricTab')?.classList.toggle('active', historic);
        setVisible(container.querySelector('.current-events-layout'), !historic);
        setVisible(container.querySelector('.historic-events-layout'), historic);
      });
    }
    for (const item of container.querySelectorAll('.filter-list li')) {
      item.addEventListener('click', () => this.toggleFilter(tab, item.id));
    }
    const limitItems = [...container.querySelectorAll('.limit-dispaly-list .limit-count')];
    for (const [index, item] of limitItems.entries()) {
      item.addEventListener('click', () => {
        const values = [5, 10, 20, 50, 100];
        this.setHistoryLimit(tab, values[index] ?? 5);
      });
    }
    container.querySelector('#clearEventsBtn')?.addEventListener('click', () => {
      this.clearSelectedHistory(tab);
    });
    for (const item of container.querySelectorAll('.delete-list li')) {
      item.addEventListener('click', () => {
        item.querySelector('.select-event-btn')?.classList.toggle('active');
      });
    }
    container.querySelector('.event-notifications-off')?.addEventListener('click', () => {
      setVisible(container.querySelector('.events-snooze-options'), true);
    });
    container.querySelector('.clear-notification-settings')?.addEventListener('click', () => {
      this.resetEventsSnooze(tab);
      setVisible(container.querySelector('.events-snooze-options'), false);
    });
    for (const item of container.querySelectorAll('.snooze-time')) {
      item.addEventListener('click', () => {
        const minutes = Number(item.getAttribute('data-lang-snooze-time') ?? 30);
        this.snooze(tab, minutes);
      });
    }
    container.querySelector('.events-save-icon')?.addEventListener('click', () => {
      void this.exportToFile(tab);
    });
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    const state = this.eventState(tab);
    state.previous[msgId] = { ...(state.current[msgId] ?? {}) };
    state.current[msgId] = { ...data };
    const time = data.time instanceof Date ? data.time : new Date(this.context.clock.now());
    if (!this.context.features(tab).isLongHorn) state.receiverTime = time;
    else state.receiverTime = new Date(this.context.clock.now());

    if (msgId === EVENT_MSG.BESTPOS) this.bestPos(state);
    else if (msgId === EVENT_MSG.TRACKSTAT && data.antenna !== 'SECONDARY') {
      this.trackstat(state, tab);
    } else if (
      msgId === EVENT_MSG.LBANDTRACKSTAT &&
      this.context.features(tab).positionModes.includes('PPP')
    ) {
      this.lband(state);
    }
    else if (msgId === EVENT_MSG.HWMONITOR) this.hwMonitor(state);
    else if (msgId === EVENT_MSG.INSPVAX) this.inspvax(state);
    else if (msgId === EVENT_MSG.RXSTATUSEVENT) this.rxStatusEvent(state);
    else if (msgId === EVENT_MSG.RXSTATUS) {
      state.powerStatus = Number(data.rxstatus3bit ?? state.powerStatus ?? -1);
      this.rxStatus(state);
    }
    else if (msgId === EVENT_MSG.ITDETECTSTATUS) this.itk(state, data);
    else if (msgId === EVENT_MSG.LONGHORN_NMEA) this.longhornNmea(state, tab, data);
    else if (msgId === EVENT_MSG.NMEA_GSV) this.longhornGsv(state, tab, data);
    this.render(tab);
  }

  getEventHandlerObject(tab: TabId): Record<string, EventEntry> {
    return this.eventState(tab).events;
  }

  updateEventsOntoUI(tab: TabId): void {
    this.render(tab);
  }

  setFilter(tab: TabId, filters: string[]): void {
    this.eventState(tab).filters = new Set(filters);
    this.render(tab);
  }

  setHistoryLimit(tab: TabId, limit: number): void {
    this.eventState(tab).historyLimit = limit;
    this.render(tab);
  }

  toggleFilter(tab: TabId, id: string): void {
    const state = this.eventState(tab);
    if (id === 'allEvents') {
      if (state.filters.has('allEvents')) state.filters.clear();
      else state.filters = new Set(['allEvents']);
    } else {
      state.filters.delete('allEvents');
      if (state.filters.has(id)) state.filters.delete(id);
      else state.filters.add(id);
      if (state.filters.size === 0) state.filters.add('allEvents');
    }
    this.render(tab);
  }

  visibleHistory(tab: TabId): EventEntry[] {
    const state = this.eventState(tab);
    const filters = state.filters.size ? state.filters : new Set(['allEvents']);
    return Object.values(state.events)
      .filter((event) => !event.alive)
      .filter((event) => {
        if (filters.has('allEvents')) return true;
        if (event.state === 'Good') return filters.has('goodEvents');
        if (event.state === 'Poor') return filters.has('poorEvents');
        return filters.has('moderateEvents');
      });
  }

  /** R73, including the shipped `splice(0,-1)` timestamp defect. */
  exportData(tab: TabId): string {
    let data = '';
    for (const event of this.visibleHistory(tab).reverse()) {
      const start = formatEventTime(event.startTime, this.context.features(tab).isLongHorn);
      const end =
        event.endTime === ''
          ? ''
          : formatEventTime(event.endTime, this.context.features(tab).isLongHorn);
      const startParts = start.split(';');
      const dateParts = startParts[0].split('.');
      const startValue = `${dateParts[0]}-${dateParts[1]}-${dateParts[2]} ${startParts[1]}`;
      const tokens = startValue.split(' ');
      tokens.splice(0, -1);
      const endParts = end.split(';');
      const endDate = endParts[0].split('.');
      const endValue = `${endDate[0]}-${endDate[1]}-${endDate[2]} ${endParts[1]}`;
      const key = EVENTS_DATA_LANG_MAP[event.description] ?? event.description;
      const description = event.freqValue
        ? this.context.translate(key).replace('%1', String(event.freqValue))
        : this.context.translate(key);
      data += `${tokens[0]} ${tokens[1]} to ${endValue} - ${description}\n`;
    }
    return data;
  }

  async exportToFile(tab: TabId, psn?: string): Promise<string | undefined> {
    let data = this.exportData(tab);
    if (!data) data = ' ';
    const files = this.context.operations?.files;
    const date = new Date(this.context.clock.now());
    const name = `${psn ?? this.context.features(tab).model ?? (this.context.features(tab).isLongHorn ? 'PIM222A' : '')}_${fileNameDate(date)}.esl`;
    const directory = await files?.chooseDirectory?.({
      title: 'Save File',
      defaultPath: files.defaultDocuments?.(),
    });
    if (!directory || !files?.writeText) return undefined;
    const path =
      directory.replace(/[\\/]$/, '') +
      (directory.includes('\\') ? '\\' : '/') +
      name;
    await files.writeText(path, data.replace(/\n/g, '\r\n'));
    return path;
  }

  removeEntryFromCurrent(description: string, tab: TabId, freq?: number): number {
    const events = this.eventState(tab).events;
    let count = 0;
    for (const [id, event] of Object.entries(events)) {
      if (
        event.description === description &&
        event.alive &&
        (freq === undefined || event.freqValue === freq)
      ) {
        delete events[id];
        count += 1;
      }
    }
    return count;
  }

  resetEventsData(tab: TabId): void {
    this.states.delete(tab);
    this.itkFrequencies.delete(tab);
    const timer = this.idleTimers.get(tab);
    if (timer !== undefined) this.context.clock.clearTimeout(timer);
    this.idleTimers.delete(tab);
    const snoozeTimer = this.snoozeTimers.get(tab);
    if (snoozeTimer !== undefined) this.context.clock.clearTimeout(snoozeTimer);
    this.snoozeUntil.delete(tab);
    this.snoozeTimers.delete(tab);
  }

  setEventNotificationFlag(): void {
    // Notifications are presentation-only and need no device command.
  }

  delayEventsNotifications(): void {
    // The original delays only visual popups; event state is unchanged.
  }

  resetEventsSnooze(tab: TabId): void {
    const timer = this.snoozeTimers.get(tab);
    if (timer !== undefined) this.context.clock.clearTimeout(timer);
    this.snoozeTimers.delete(tab);
    this.snoozeUntil.delete(tab);
    const info = this.context.document.querySelector(`#${tab} .events-snooze-info`);
    setVisible(info, false);
  }

  getSMeventsCount(tab: TabId): number {
    return Object.values(this.eventState(tab).events).filter((event) => event.alive).length;
  }

  protected runApply(_tab: TabId): undefined {
    return undefined;
  }

  protected render(tab: TabId): void {
    const state = this.eventState(tab);
    const currentList = this.context.document.querySelector(
      `#${tab} .current-events-layout .event-entries`,
    );
    const historyList = this.context.document.querySelector(
      `#${tab} .history-events-layout .event-entries`,
    );
    if (currentList) currentList.innerHTML = '';
    if (historyList) historyList.innerHTML = '';
    for (const [id, event] of Object.entries(state.events)) {
      const list = event.alive ? currentList : historyList;
      if (list) list.appendChild(this.renderEvent(tab, id, event));
    }
    const visible = new Set(this.visibleHistory(tab).slice(0, state.historyLimit));
    if (historyList) {
      for (const li of historyList.querySelectorAll('li.eventElement')) {
        const event = Object.values(state.events).find(
          (candidate) => `${candidate.endTime instanceof Date ? candidate.endTime.getTime() : 0}_${eventName(candidate)}` === li.id,
        );
        if (event) setVisible(li, visible.has(event));
      }
    }
    this.renderEventControls(tab, state, currentList, historyList);
  }

  private eventState(tab: TabId): EventState {
    let state = this.states.get(tab);
    if (!state) {
      state = {
        current: {},
        previous: {},
        events: {},
        receiverTime: new Date(this.context.clock.now()),
      filters: new Set(['allEvents']),
      historyLimit: 5,
      };
      this.states.set(tab, state);
    }
    return state;
  }

  private createEvent(
    state: EventState,
    severity: string,
    alive: boolean,
    description: string,
    freqValue?: number,
  ): void {
    if (!alive) {
      const current = Object.entries(state.events).reverse().find(
        ([, event]) =>
          event.alive &&
          event.description === description &&
          (freqValue === undefined || event.freqValue === freqValue),
      );
      if (!current) return;
      const [id, event] = current;
      event.alive = false;
      event.endTime = new Date(state.receiverTime);
      delete state.events[id];
      const endedId = `${event.endTime.getTime()}_${eventName(event)}`;
      state.events[endedId] = event;
      const history = Object.values(state.events).filter((entry) => !entry.alive);
      if (history.length > 100) {
        const oldest = history
          .sort((a, b) => Number(a.endTime) - Number(b.endTime))[0];
        const idToDelete = Object.entries(state.events).find(([, entry]) => entry === oldest)?.[0];
        if (idToDelete) delete state.events[idToDelete];
      }
      return;
    }
    const start = new Date(state.receiverTime);
    const entry: EventEntry = {
      startTime: start,
      state: severity,
      alive: true,
      description,
      actualStr: this.context.translate(EVENTS_DATA_LANG_MAP[description] ?? description),
      endTime: '',
      freqValue,
    };
    state.events[`${start.getTime()}_${eventName(entry)}`] = entry;
  }

  private clearSelectedHistory(tab: TabId): void {
    const state = this.eventState(tab);
    const selected = [...this.context.document.querySelectorAll(
      `#${tab} .delete-list li`,
    )]
      .filter((item) => item.querySelector('.select-event-btn')?.classList.contains('active'))
      .map((item) => item.id);
    if (!selected.length) return;
    for (const [id, event] of Object.entries(state.events)) {
      if (event.alive) continue;
      const match =
        selected.includes('allEvents') ||
        (event.state === 'Good' && selected.includes('goodEvents')) ||
        (event.state === 'Poor' && selected.includes('poorEvents')) ||
        (event.state !== 'Good' && event.state !== 'Poor' && selected.includes('moderateEvents'));
      if (match) delete state.events[id];
    }
    this.render(tab);
  }

  private snooze(tab: TabId, minutes: number): void {
    const previous = this.snoozeTimers.get(tab);
    if (previous !== undefined) this.context.clock.clearTimeout(previous);
    const milliseconds = minutes === 1000 ? Number.POSITIVE_INFINITY : minutes * 60_000;
    this.snoozeUntil.set(tab, milliseconds === Infinity ? Infinity : this.context.clock.now() + milliseconds);
    const info = this.context.document.querySelector(`#${tab} .events-snooze-info`);
    if (info) {
      info.textContent =
        milliseconds === Infinity
          ? this.context.translate('NOTIFICATIONS_TURNED_OFF_SESSION')
          : this.context
              .translate('NOTIFICATIONS_TURNED_OFF')
              .replace('%1', String(minutes));
    }
    setVisible(info, true);
    setVisible(this.context.document.querySelector(`#${tab} .events-snooze-options`), false);
    if (milliseconds !== Infinity) {
      this.snoozeTimers.set(
        tab,
        this.context.clock.setTimeout(() => this.resetEventsSnooze(tab), milliseconds),
      );
    }
  }

  private renderEventControls(
    tab: TabId,
    state: EventState,
    currentList: Element | null,
    historyList: Element | null,
  ): void {
    const listed = currentList?.querySelectorAll('li.eventElement').length ?? 0;
    // A page rendered once before its events arrived keeps the empty state visible otherwise: fall
    // back to whatever `li.eventElement` the document already holds (measured on the b7 capture,
    // 2026-11-01 — four interference events were in the list while "No events present." still showed).
    const currentCount = listed || this.context.document.querySelectorAll(`#${tab} li.eventElement`).length;
    const historyCount = historyList?.querySelectorAll('li.eventElement').length ?? 0;
    const count = this.context.document.querySelector(`#${tab} #currentEventsCount`);
    if (count) count.textContent = `(${currentCount >= 100 ? '99+' : currentCount})`;
    setVisible(this.context.document.querySelector(`#${tab} .no-events`), currentCount === 0);
    setVisible(this.context.document.querySelector(`#${tab} .no-history-events`), historyCount === 0);
    this.context.document
      .querySelector(`#${tab} .events-save-icon`)
      ?.classList.toggle('customDisableButtons', historyCount === 0);
    for (const item of this.context.document.querySelectorAll(`#${tab} .filter-list li`)) {
      const button = item.querySelector('.select-event-btn');
      const all = state.filters.has('allEvents');
      const active = all || state.filters.has(item.id);
      button?.classList.toggle('active', active);
      button?.classList.toggle('tri-active-select-btn', !all && state.filters.size > 0 && state.filters.size < 4);
    }
    const display = this.context.document.querySelector(
      `#${tab} #events-limit-display .active-port`,
    );
    if (display) display.textContent = String(state.historyLimit);
  }

  private bestPos(state: EventState): void {
    const data = state.current[EVENT_MSG.BESTPOS];
    const previous = state.previous[EVENT_MSG.BESTPOS];
    const currentType = String(data.positionType ?? data.posType ?? '');
    const previousType = String(previous.positionType ?? previous.posType ?? '');
    if (currentType === 'NONE' && previousType !== 'NONE') {
      this.createEvent(state, 'Poor', true, 'data-lang-no-position-available');
    }
    if (previousType === 'NONE' && currentType !== 'NONE') {
      this.createEvent(state, 'Poor', false, 'data-lang-no-position-available');
    }
    const currentState = bestPosState(data);
    const previousState = bestPosState(previous);
    if (currentState === 'Poor' && previousState !== 'Poor') {
      this.createEvent(state, 'Poor', true, 'data-lang-high-pos-std-dev');
    }
    if (previousState === 'Poor' && currentState !== 'Poor') {
      this.createEvent(state, 'Poor', false, 'data-lang-high-pos-std-dev');
    }
    const idleNow = Number(data.idleTime);
    const idleBefore = Number(previous.idleTime);
    if (Number.isFinite(idleNow) && Number.isFinite(idleBefore)) {
      if (idleNow < 10 && !(idleBefore < 10)) {
        this.createEvent(state, 'Poor', true, 'data-lang-high-cpu');
      }
      if (idleBefore < 10 && !(idleNow < 10)) {
        this.createEvent(state, 'Poor', false, 'data-lang-high-cpu');
      }
    }
  }

  private trackstat(state: EventState, tab: TabId): void {
    const supported = this.context.features(tab).constellations;
    const current = satelliteCounts(state.current[EVENT_MSG.TRACKSTAT], supported);
    const previousData = state.previous[EVENT_MSG.TRACKSTAT] ?? {};
    const previous = satelliteCounts(previousData, supported);
    const first = Object.keys(previousData).length === 0;
    for (const constellation of [...new Set([...supported, 'SBAS'])]) {
      const now = current[constellation] ?? 0;
      const before = previous[constellation] ?? 0;
      const threshold = constellation === 'SBAS' ? 1 : 4;
      if (constellation === 'SBAS' && !this.context.features(tab).positionModes.includes('SBAS')) {
        continue;
      }
      if (first && now < threshold) {
        this.createEvent(
          state,
          'Poor',
          true,
          constellation === 'SBAS'
            ? 'data-lang-no-sbas-tracked'
            : trackingDescription(constellation),
        );
        continue;
      }
      if (now < threshold && before >= threshold) {
        this.createEvent(
          state,
          'Poor',
          true,
          constellation === 'SBAS'
            ? 'data-lang-no-sbas-tracked'
            : trackingDescription(constellation),
        );
      }
      if (before < threshold && now >= threshold) {
        this.createEvent(
          state,
          'Poor',
          false,
          constellation === 'SBAS'
            ? 'data-lang-no-sbas-tracked'
            : trackingDescription(constellation),
        );
      }
    }
  }

  private lband(state: EventState): void {
    const count = (data: Record<string, unknown> | undefined): number =>
      rowsOf(data ?? {}).filter((row) => row.name && row.name !== '').length;
    const now = count(state.current[EVENT_MSG.LBANDTRACKSTAT]);
    const previousData = state.previous[EVENT_MSG.LBANDTRACKSTAT] ?? {};
    const before = count(previousData);
    if (Object.keys(previousData).length === 0) {
      if (now === 0) this.createEvent(state, 'Poor', true, 'data-lang-no-lband');
      return;
    }
    if (now === 0 && before > 0) this.createEvent(state, 'Poor', true, 'data-lang-no-lband');
    if (before === 0 && now > 0) this.createEvent(state, 'Poor', false, 'data-lang-no-lband');
  }

  private inspvax(state: EventState): void {
    const now = inspvaxState(state.current[EVENT_MSG.INSPVAX]);
    const before = inspvaxState(state.previous[EVENT_MSG.INSPVAX]);
    if (now === 'Poor' && before !== 'Poor') {
      this.createEvent(state, 'Poor', true, 'data-lang-high-ins-std-dev');
    }
    if (before === 'Poor' && now !== 'Poor') {
      this.createEvent(state, 'Poor', false, 'data-lang-high-ins-std-dev');
    }
  }

  private rxStatus(state: EventState): void {
    const now = String(state.current[EVENT_MSG.RXSTATUS].spoofing ?? '');
    const before = String(state.previous[EVENT_MSG.RXSTATUS].spoofing ?? '');
    if (now === 'DETECTED' && before !== 'DETECTED') {
      this.createEvent(state, 'Poor', true, 'data-lang-spoofing-detected');
    }
    if (before === 'DETECTED' && now !== 'DETECTED') {
      this.createEvent(state, 'Poor', false, 'data-lang-spoofing-detected');
    }
  }

  private rxStatusEvent(state: EventState): void {
    const description = String(state.current[EVENT_MSG.RXSTATUSEVENT].description ?? '').toUpperCase();
    if (description === 'MODEL INVALID FOR THIS RECEIVER') {
      this.createEvent(state, 'Poor', true, 'data-lang-invalid-model');
    } else if (description === 'INVALID AUTHORIZATION CODE') {
      this.createEvent(state, 'Poor', true, 'data-lang-invalid-authcode');
    }
  }

  private removeHistoryByDescription(state: EventState, description: string): void {
    for (const [id, event] of Object.entries(state.events)) {
      if (!event.alive && event.description === description) delete state.events[id];
    }
  }

  private longhornNmea(
    state: EventState,
    tab: TabId,
    data: Record<string, unknown>,
  ): void {
    const identifier = Number(data.MessageIdentifier ?? 0);
    const previous = state.previous[EVENT_MSG.LONGHORN_NMEA] ?? {};
    const first = Object.keys(previous).length === 0;
    if (identifier === 2) {
      const fields: Array<[string, string]> = [
        ['invalidModel', 'data-lang-invalid-model'],
        ['invalidAuthCode', 'data-lang-invalid-authcode'],
      ];
      for (const [field, description] of fields) {
        const now = Number(data[field] ?? 0) === 1;
        const before = Number(previous[field] ?? 0) === 1;
        if (now && !before) {
          this.removeHistoryByDescription(state, description);
          this.createEvent(state, 'Poor', true, description);
        }
        if (before && !now) this.createEvent(state, 'Poor', false, description);
      }
      return;
    }
    if (identifier === 4) {
      const timer = this.idleTimers.get(tab);
      const idle = Number(data.idleTime ?? 100);
      const wasPoor = Number(previous.idleTime ?? 100) < 10;
      if (idle < 10) {
        if (!wasPoor && timer === undefined) {
          this.idleTimers.set(
            tab,
            this.context.clock.setTimeout(() => {
              this.idleTimers.delete(tab);
              this.createEvent(state, 'Poor', true, 'data-lang-high-cpu');
            }, 5000),
          );
        }
      } else if (timer !== undefined) {
        this.context.clock.clearTimeout(timer);
        this.idleTimers.delete(tab);
        this.createEvent(state, 'Poor', false, 'data-lang-high-cpu');
      }
      return;
    }
    if (identifier === 3) {
      const fields: Array<[string, string, string]> = [
        ['antennaVoltage', 'antennaVoltageLghn', 'data-lang-lghn-ant-vol-warning'],
        ['temperature', 'temperature', 'data-lang-tcxo-warning'],
        ['com1BufferOverrun', 'com1BufferOverrun', 'data-lang-com1-buffer-overrun'],
        ['com2BufferOverrun', 'com2BufferOverrun', 'data-lang-com2-buffer-overrun'],
      ];
      for (const [field, descriptionField, fallback] of fields) {
        const rawNow = Number(data[field] ?? 0);
        const rawBefore = Number(previous[field] ?? 0);
        const now =
          field === 'com1BufferOverrun' || field === 'com2BufferOverrun'
            ? rawNow === 1
              ? 'Poor'
              : 'Good'
            : hwState(rawNow, state.powerStatus);
        const before =
          field === 'com1BufferOverrun' || field === 'com2BufferOverrun'
            ? rawBefore === 1
              ? 'Poor'
              : 'Good'
            : hwState(rawBefore, state.powerStatus);
        if (!first && now !== before && (now === 'Moderate' || now === 'Poor')) {
          const description =
            field === 'antennaVoltage' || field === 'temperature'
              ? hwDescription(now, descriptionField)
              : fallback;
          this.createEvent(state, now, true, description);
        }
        if (!first && now !== before && (before === 'Moderate' || before === 'Poor')) {
          const description =
            field === 'antennaVoltage' || field === 'temperature'
              ? hwDescription(before, descriptionField)
              : fallback;
          this.createEvent(state, before, false, description);
        }
        if (first && (now === 'Moderate' || now === 'Poor')) {
          const description =
            field === 'antennaVoltage' || field === 'temperature'
              ? hwDescription(now, descriptionField)
              : fallback;
          this.createEvent(state, now, true, description);
        }
      }
    }
  }

  private longhornGsv(state: EventState, tab: TabId, data: Record<string, unknown>): void {
    const current = longhornSatelliteCounts(data);
    const previousData = state.previous[EVENT_MSG.NMEA_GSV] ?? {};
    const previous = longhornSatelliteCounts(previousData);
    const first = Object.keys(previousData).length === 0;
    for (const system of ['GPS', 'GALILEO', 'BEIDOU']) {
      const now = current[system] ?? 0;
      const before = previous[system] ?? 0;
      if (first && now < 4) {
        this.createEvent(state, 'Poor', true, trackingDescription(system, false));
      }
      if (!first && now !== before) {
        const description = trackingDescription(system, true);
        if (now < 4) this.createEvent(state, 'Poor', true, description);
        if (before < 4) this.createEvent(state, 'Poor', false, description);
      }
    }
  }

  private hwMonitor(state: EventState): void {
    const current = state.current[EVENT_MSG.HWMONITOR];
    const previous = state.previous[EVENT_MSG.HWMONITOR];
    const fields: Array<[string, string]> = [
      ['digitalCoreVoltage3V3Bound', 'digitalCoreVoltage3V3'],
      ['supplyVoltageBound', 'supplyVoltage'],
      ['digitalCoreVoltage1V2Bound', 'digitalCoreVoltage1V2'],
      ['voltage1V8Bound', 'voltage1V8'],
      ['antennaVoltageBound', 'antennaVoltage'],
      ['antennaCurrentBound', 'antennaCurrent'],
      ['temperatureBound', 'temperature'],
      ['secondaryTemperatureBound', 'secondaryTemperature'],
    ];
    for (const [field, event] of fields) {
      const now = hwState(Number(current[field] ?? 0), state.powerStatus);
      const before = hwState(Number(previous[field] ?? 0), state.powerStatus);
      if ((now === 'Moderate' || now === 'Poor') && now !== before) {
        this.createEvent(state, now, true, hwDescription(now, event));
      }
      if ((before === 'Moderate' || before === 'Poor') && before !== now) {
        this.createEvent(state, before, false, hwDescription(before, event));
      }
    }
  }

  private itk(state: EventState, data: Record<string, unknown>): void {
    const current = itkDetections(data);
    const old = this.itkFrequencies.get(stateTab(this.states, state)) ?? new Set<number>();
    for (const frequency of current) {
      if (!old.has(frequency)) {
        this.createEvent(state, 'Moderate', true, 'data-lang-itk-detected-at', frequency);
      }
    }
    for (const frequency of old) {
      if (!current.has(frequency)) {
        this.createEvent(state, 'Moderate', false, 'data-lang-itk-detected-at', frequency);
      }
    }
    const tab = stateTab(this.states, state);
    if (tab) this.itkFrequencies.set(tab, current);
  }

  private renderEvent(tab: TabId, id: string, event: EventEntry): Element {
    const li = this.context.document.createElement('li');
    li.className = `${event.state} eventElement`;
    li.id = id;
    li.setAttribute('data-message', event.description);
    if (event.freqValue !== undefined) li.setAttribute('data-event-freq', String(event.freqValue));
    li.setAttribute('startTime', String(event.startTime.getTime()));
    li.setAttribute('endTime', event.endTime ? String(event.endTime.getTime()) : '');
    const severity = severityView(event.state);
    const status = this.context.document.createElement('span');
    status.className = `${severity.cls} event-status`;
    status.setAttribute(`data-lang-${severity.text.toLowerCase()}`, '');
    status.textContent = severity.text;
    const info = this.context.document.createElement('div');
    info.className = 'event-information';
    const message = this.context.document.createElement('div');
    message.className = 'event-message elidedText';
    message.setAttribute(event.description, '');
    const translated = this.context.translate(EVENTS_DATA_LANG_MAP[event.description] ?? event.description);
    message.textContent = event.freqValue
      ? translated.replace('%1', String(event.freqValue))
      : translated;
    const timestamp = this.context.document.createElement('div');
    timestamp.className = 'event-timestamp';
    timestamp.textContent = event.alive
      ? formatEventTime(event.startTime, this.context.features(tab).isLongHorn)
      : formatEventTime(event.endTime as Date, this.context.features(tab).isLongHorn);
    info.append(message, timestamp);
    li.append(status, info);
    return li;
  }
}

function rowsOf(data: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [data.data, data.Data, data.blocks, data.channelData, data.sats];
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
  return rows;
}

function bestPosState(data: Record<string, unknown>): string | undefined {
  if (!data || !Object.keys(data).length) return undefined;
  const type = String(data.positionType ?? data.posType ?? '');
  const lat = Number(data.latitudeDeviation ?? data.latDev ?? 0);
  const lon = Number(data.longitudeDeviation ?? data.longDev ?? 0);
  const height = Number(data.heightDeviation ?? data.heightDev ?? 0);
  if (type === 'PPP' || type === 'PPP_CONVERGING') return lat <= 0.1 && lon <= 0.1 && height <= 0.15 ? 'Good' : 'Poor';
  if (
    ['RTKFIXED', 'RTKFLOAT', 'L1_FLOAT', 'IONOFREE_FLOAT', 'NARROW_FLOAT', 'L1_INT', 'NARROW_INT', 'RTK SINGLE'].includes(type)
  ) return lat <= 0.4 && lon <= 0.4 && height <= 0.6 ? 'Good' : 'Poor';
  if (type === 'PSRDIFF') return lat <= 0.5 && lon <= 0.5 && height <= 0.75 ? 'Good' : 'Poor';
  if (type === 'WAAS') return lat <= 0.9 && lon <= 0.9 && height <= 1.3 ? 'Good' : 'Poor';
  if (type === 'SINGLE') return lat <= 2 && lon <= 2 && height <= 4 ? 'Good' : 'Poor';
  return undefined;
}

function inspvaxState(data: Record<string, unknown>): string | undefined {
  if (!data || !Object.keys(data).length) return undefined;
  const type = String(data.posType ?? data.positionType ?? '');
  if (type === 'INS_PPP' || type === 'INS_PPP_CONVERGING') {
    return Number(data.latDev) <= 0.1 && Number(data.longDev) <= 0.1 && Number(data.heightDev) <= 0.15 ? 'Good' : 'Poor';
  }
  if (type === 'INS_RTKFIXED' || type === 'INS_RTKFLOAT') {
    return Number(data.latDev) <= 0.4 && Number(data.longDev) <= 0.4 && Number(data.heightDev) <= 0.6 ? 'Good' : 'Poor';
  }
  if (type === 'INS_PSRDIFF') {
    return Number(data.latDev) <= 0.5 && Number(data.longDev) <= 0.5 && Number(data.heightDev) <= 0.75 ? 'Good' : 'Poor';
  }
  if (type === 'INS_SBAS') {
    return Number(data.latDev) <= 0.9 && Number(data.longDev) <= 0.9 && Number(data.heightDev) <= 1.3 ? 'Good' : 'Poor';
  }
  if (type === 'INS_PSRSP') {
    return Number(data.latDev) <= 2 && Number(data.longDev) <= 2 && Number(data.heightDev) <= 4 ? 'Good' : 'Poor';
  }
  return undefined;
}

function satelliteCounts(
  data: Record<string, unknown>,
  supported: string[],
): Record<string, number> {
  const counts: Record<string, number> = { SBAS: 0 };
  for (const system of new Set(supported)) counts[system] = 0;
  for (const row of rowsOf(data ?? {})) {
    const system = String(row.satSystem ?? row.system ?? row.constellation ?? '');
    const status = Number(row.channelTrackingStatus ?? 0) & 0x1f;
    if (!system || Number(row.PRN ?? 0) === 0 || (status !== 0x04 && status !== 0x0b)) continue;
    counts[system] = (counts[system] ?? 0) + 1;
  }
  return counts;
}

function longhornSatelliteCounts(data: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rowsOf(data ?? {})) {
    const tracker = String(row.NMEA_TRAKERID ?? '');
    const system = String(
      row.system ??
        {
          GP: 'GPS',
          GL: 'GLONASS',
          GA: 'GALILEO',
          GB: 'BEIDOU',
          BD: 'BEIDOU',
        }[tracker] ??
        '',
    );
    if (!system) continue;
    const reject = Array.isArray(row.rejectCodes) ? String(row.rejectCodes[0] ?? '') : '0';
    if (reject === '0') counts[system] = (counts[system] ?? 0) + 1;
  }
  return counts;
}

function trackingDescription(system: string, good = false): string {
  const names: Record<string, [string, string]> = {
    GPS: ['data-lang-gps-tracking-less', 'data-lang-gps-tracking-less-good'],
    GLONASS: ['data-lang-glo-tracking-less', 'data-lang-glo-tracking-less'],
    GALILEO: ['data-lang-gal-tracking-less', 'data-lang-gal-tracking-less-good'],
    BEIDOU: ['data-lang-bds-tracking-less', 'data-lang-bds-tracking-less-good'],
    NAVIC: ['data-lang-navic-tracking-less', 'data-lang-navic-tracking-less'],
  };
  return names[system]?.[good ? 1 : 0] ?? 'data-lang-gps-tracking-less';
}

function hwState(value: number, powerStatus?: number): string {
  if (powerStatus === 1) return 'Good';
  if (value === 0) return 'Good';
  if (value === 1 || value === 3) return 'Moderate';
  if (value === 2) return 'Poor';
  if (value === 4) return 'upperPoor';
  return 'Good';
}

function hwDescription(state: string, event: string): string {
  const warning = state === 'Moderate';
  const map: Record<string, [string, string]> = {
    digitalCoreVoltage3V3: ['data-lang-3v3-error', 'data-lang-3v3-warning'],
    supplyVoltage: ['data-lang-voltage-error', 'data-lang-voltage-warning'],
    digitalCoreVoltage1V2: ['data-lang-1v2-error', 'data-lang-1v2-warning'],
    voltage1V8: ['data-lang-1v8-vol-error', 'data-lang-1v8-vol-warning'],
    antennaVoltage: ['data-lang-ant-vol-error', 'data-lang-ant-vol-warning'],
    antennaVoltageLghn: [
      'data-lang-lghn-ant-vol-warning',
      'data-lang-lghn-ant-vol-warning',
    ],
    antennaCurrent: ['data-lang-ant-current-error', 'data-lang-ant-current-warning'],
    temperature: ['data-lang-tcxo-error', 'data-lang-tcxo-warning'],
    secondaryTemperature: ['data-lang-ddr-temp-error', 'data-lang-ddr-temp-warning'],
  };
  return map[event]?.[warning ? 1 : 0] ?? (warning ? 'data-lang-warning' : 'data-lang-error');
}

function severityView(state: string): { cls: string; text: string } {
  if (state === 'Good') return { cls: 'green-status', text: 'Good' };
  if (state === 'Poor') return { cls: 'red-status', text: 'Error' };
  return { cls: 'yellow-status', text: 'Warning' };
}

function eventName(event: EventEntry): string {
  return event.description.replace(/^data-lang-/, '') + (event.freqValue !== undefined ? `_${event.freqValue}` : '');
}

function formatEventTime(date: Date, longhorn: boolean): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const base = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()};${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return longhorn ? base : base + ' UTC';
}

function fileNameDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function stateTab(states: Map<TabId, EventState>, target: EventState): TabId | undefined {
  for (const [tab, state] of states) if (state === target) return tab;
  return undefined;
}
