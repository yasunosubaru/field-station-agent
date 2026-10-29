import type { Clock } from '../clock.ts';
import type { FragmentLoader, TabId, UserStoreLike } from '../types.ts';
import type { ConfigCommandCatalog, ConfigTransport, ConfigDataMap } from '../config/types.ts';
import { buildConfigBinary } from '../config/command.ts';
import { applyPageMarkers, scopedQuery, scopedQueryAll, setVisible, type ConfigPageContext } from '../config/base.ts';

export interface GritContext {
  document: Document;
  fragments: FragmentLoader;
  clock: Clock;
  store: UserStoreLike;
  translate(key: string): string;
  deviceTileId(tab: TabId): string;
  connectionType(tab: TabId): string | undefined;
  commands?: ConfigCommandCatalog;
  transport: ConfigTransport;
  sendLog?(tab: TabId, name: string, spec: string): void;
  onEvent?(tab: TabId, event: GritEvent): void;
}

/**
 * The `ConfigPageContext` shape that the shared DOM helpers (`config/base.ts`) expect. GRIT's own
 * context carries the same document/fragments/clock/store, so the adapter is mechanical — but it
 * must be an *object*: passing `ctx.document` where a context is expected is what broke `R38`
 * (`scopedQueryAll(context: ConfigPageContext, …)` then reads `context.document`).
 */
export function pageContext(ctx: GritContext): ConfigPageContext {
  return {
    document: ctx.document,
    fragments: ctx.fragments,
    clock: ctx.clock,
    store: ctx.store,
    features: () => ({ generation: 'OEM7', model: '', isLongHorn: false, isGIII: false, isMarinePak: false, alignSupported: false, spanSupported: false, radioTxSupported: false, terrastarSupported: false, dualAntennaSupported: false, spoofingSupported: false, loggingComponent: false, fileSupported: false, constellations: [], increasedLogLimit: false, positionModes: [] }),
    translate: ctx.translate,
    createDialog() {},
    closeDialog() {},
    showLoadingScreen() {},
    closeApplyingScreen() {},
    showConnectionLoader() {},
    hideConnectionLoader() {},
  };
}

export function text(ctx: GritContext, tab: TabId, selector: string, value: unknown): boolean {
  const node = scopedQuery(pageContext(ctx), tab, selector);
  if (!node) return false;
  node.textContent = value === undefined || value === null ? '--' : String(value);
  return true;
}

export function setMarker(
  element: Element | null,
  marker: string,
  value: string,
): void {
  if (!element) return;
  for (const name of element.getAttributeNames()) {
    if (name === 'data-lang' || name.startsWith('data-lang-')) element.removeAttribute(name);
  }
  element.setAttribute(marker, '');
  element.textContent = value;
}

function number(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class GritStatusBar {
  readonly values = new Map<TabId, Record<string, unknown>>();
  readonly cpu = new Map<TabId, number>();
  readonly itk = new Map<TabId, boolean>();
  readonly jamming = new Map<TabId, boolean>();
  readonly spoofing = new Map<TabId, boolean>();
  readonly spoofingEnabled = new Map<TabId, boolean>();
  readonly calibrated = new Map<TabId, boolean>();
  readonly satellites = new Map<TabId, number>();
  readonly configuredModes = new Map<TabId, string[]>();
  readonly activeMode = new Map<TabId, string>();
  readonly ctx: GritContext;

  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }

  updateView(msgId: number, data: Record<string, unknown>, _live = false): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    this.values.set(tab, { ...(this.values.get(tab) ?? {}), ...data });
    if (msgId === 42) this.bestPos(tab, data);
    else if (msgId === 963) {
      this.cpu.set(tab, number(data.idleTime));
      text(this.ctx, tab, `#gritStatusBaridleTime`, `${Math.round(number(data.idleTime))}%`);
    } else if (msgId === 101) {
      const hh = String(number(data.hours)).padStart(2, '0');
      const mm = String(number(data.minutes)).padStart(2, '0');
      const ss = String(number(data.seconds)).padStart(2, '0');
      text(this.ctx, tab, '#gritStatusBartime', `${hh}:${mm}:${ss} UTC`);
    } else if (msgId === 37) {
      text(this.ctx, tab, '#gritStatusBarhardwareVersion', data.hardwareVersion ?? data.model);
    } else if (msgId === 2065) {
      const rows = Array.isArray(data.data) ? data.data : [];
      this.itk.set(tab, rows.some((row) => {
        const record = row as Record<string, unknown>;
        return String(record.detectionType) !== 'STATISTICALANALYSIS';
      }));
      this.renderEnvironment(tab);
    } else if (msgId === 93) {
      this.spoofing.set(tab, number(data.rxstatus9bit) === 1);
      this.jamming.set(tab, number(data.rxstatus15bit) === 1);
      this.calibrated.set(tab, number(data.aux3status25bit) !== 1);
      this.renderEnvironment(tab);
    } else if (msgId === 2358) {
      this.spoofingEnabled.set(tab, String(data.mode) === 'ENABLE');
      this.renderEnvironment(tab);
    } else if (msgId === 2143) {
      this.itk.set(tab, String(data.rfpath) !== 'NONE');
      this.renderEnvironment(tab);
    }
    this.renderRag(tab);
  }

  updateStatus(data: Record<string, unknown>, msgId: number): void {
    const tab = String(data.tab ?? '');
    if (tab) this.updateView(msgId, data);
  }

  updateGritPositionModes(
    configured: string[],
    active: string,
    data: Record<string, unknown>,
  ): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    this.configuredModes.set(tab, [...configured]);
    this.activeMode.set(tab, active);
    for (const item of scopedQueryAll(pageContext(this.ctx), tab, '.grit_configuredPositions')) {
      item.classList.toggle('active', item.id === active);
    }
    this.renderRag(tab);
  }

  private bestPos(tab: TabId, data: Record<string, unknown>): void {
    text(this.ctx, tab, '#gritStatusBarlatitude', `${Number(data.latitude ?? 0).toFixed(7)}°`);
    text(this.ctx, tab, '#gritStatusBarlongitude', `${Number(data.longitude ?? 0).toFixed(7)}°`);
    text(this.ctx, tab, '#gritStatusBarheight', `${data.height ?? '--'} m`);
    text(this.ctx, tab, '#satelliteTrackedStatus', data.satellitesTracked ?? '--');
    text(this.ctx, tab, '#satelliteUsedStatus', data.satellitesUsed ?? '--');
    this.satellites.set(tab, number(data.satellitesUsed));
    this.activeMode.set(tab, String(data.positionType ?? data.operatingMode ?? ''));
  }

  private renderEnvironment(tab: TabId): void {
    const itk = this.itk.get(tab) ? 'Detected' : 'Not detected';
    const jam = this.jamming.get(tab) ? 'Detected' : 'Not detected';
    let spoof = this.spoofing.get(tab) ? 'Detected' : 'Not detected';
    if (!this.calibrated.has(tab) || !this.calibrated.get(tab)) spoof = 'Not calibrated';
    else if (!this.spoofingEnabled.has(tab) || !this.spoofingEnabled.get(tab)) spoof = 'Detection disabled';
    text(this.ctx, tab, '#gritStatusBaritkState', itk);
    text(this.ctx, tab, '#gritStatusBarjamming', jam);
    text(this.ctx, tab, '#gritStatusBarspoofing', spoof);
  }

  gritRagIndicatorDetection(tab: TabId): { position: 'good' | 'warning' | 'bad'; device: 'good' | 'warning' | 'bad' } {
    const data = this.values.get(tab) ?? {};
    const solution = String(data.solutionStatus ?? '');
    let position: 'good' | 'warning' | 'bad' =
      ['INSUFFICIENT_OBS', 'NO_CONVERGENCE', 'INVALID_FIX', 'INTEGRITY_WARNING'].includes(solution)
        ? 'bad'
        : (this.satellites.get(tab) ?? 99) < 4
          ? 'bad'
          : 'good';
    const active = this.activeMode.get(tab);
    const modes = this.configuredModes.get(tab) ?? [];
    if (position === 'good' && active && modes.length && !modes.includes(active)) position = 'warning';

    let device: 'good' | 'warning' | 'bad' = 'good';
    const cpu = this.cpu.get(tab) ?? 0;
    if (cpu > 80 && cpu <= 90) device = 'warning';
    else if (cpu > 90) device = 'bad';
    const detected = [this.itk.get(tab), this.jamming.get(tab), this.spoofing.get(tab)].filter(Boolean).length;
    if (detected > 0) device = detected === 1 && this.itk.get(tab) ? 'warning' : 'bad';
    return { position, device };
  }

  private renderRag(tab: TabId): void {
    const rag = this.gritRagIndicatorDetection(tab);
    for (const [parent, state] of [['positioning-traffic', rag.position], ['device-traffic', rag.device]] as const) {
      for (const node of scopedQueryAll(pageContext(this.ctx), tab, `.${parent} span`)) setVisible(node, false);
      const cls = state === 'bad' ? 'red-status' : state === 'warning' ? 'yellow-status' : 'green-status';
      for (const node of scopedQueryAll(pageContext(this.ctx), tab, `.${parent} span.${cls}`)) setVisible(node, true);
    }
  }

  processLanguage(tab?: TabId): number {
    return tab ? applyPageMarkers(pageContext(this.ctx), tab) : 0;
  }
}

export interface GritEvent {
  id: string;
  startTime: Date;
  endTime?: Date;
  state: 'Good' | 'Moderate' | 'Poor';
  alive: boolean;
  description: string;
  actualStr: string;
  freqValue?: number;
  poiName?: string;
}

export class GritEvents {
  readonly current = new Map<TabId, Record<string, GritEvent>>();
  readonly history = new Map<TabId, GritEvent[]>();
  readonly historyLimit = new Map<TabId, number>();
  readonly notifyEnabled = new Map<TabId, boolean>();
  readonly startupUntil = new Map<TabId, number>();
  readonly notificationTimers = new Map<TabId, number[]>();
  readonly ctx: GritContext;

  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }

  updateData(data: Record<string, unknown>, msgId: number): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    if (msgId === 93) {
      this.toggle('SPOOFING_DETECTED', 'Poor', number(data.rxstatus9bit) === 1, tab);
      this.toggle('JAMMING_DETECTED', 'Poor', number(data.rxstatus15bit) === 1, tab);
    } else if (msgId === 2065) {
      const rows = Array.isArray(data.data) ? data.data : [];
      const hit = rows.find((row) => String((row as Record<string, unknown>).detectionType) === 'SPECTRALANALYSIS');
      this.toggle(
        'ITK_DETECTED',
        'Moderate',
        !!hit,
        tab,
        hit ? Math.round(number((hit as Record<string, unknown>).centerFrequency)) : undefined,
      );
    } else if (msgId === 963) {
      if (number(data.idleTime) > 90) this.addOrClose('HIGH_CPU', 'Moderate', true, tab);
      else this.addOrClose('HIGH_CPU', 'Moderate', false, tab);
    }
    this.updateEventsOntoUI(tab);
  }

  private toggle(
    description: string,
    state: 'Good' | 'Moderate' | 'Poor',
    on: boolean,
    tab: TabId,
    freq?: number,
  ): void {
    this.addOrClose(description, state, on, tab, freq);
  }

  private addOrClose(
    description: string,
    state: 'Good' | 'Moderate' | 'Poor',
    on: boolean,
    tab: TabId,
    freq?: number,
  ): void {
    const bucket = this.current.get(tab) ?? {};
    const existing = Object.values(bucket).find(
      (event) => event.description === description && event.alive,
    );
    if (!on) {
      if (existing) {
        existing.alive = false;
        existing.endTime = new Date(this.ctx.clock.now());
        delete bucket[existing.id];
      }
      this.current.set(tab, bucket);
      return;
    }
    if (existing) return;
    const now = new Date(this.ctx.clock.now());
    const id = `${now.getTime()}_${description}`;
    const event: GritEvent = {
      id,
      startTime: now,
      state,
      alive: true,
      description,
      actualStr: description,
      freqValue: freq,
    };
    bucket[id] = event;
    this.current.set(tab, bucket);
    this.ctx.onEvent?.(tab, event);
    this.notify(tab, event);
  }

  addPOIEvent(kind: 'ENTERED_INTO' | 'EXITED_FROM', name: string, speed: number, tab: TabId): void {
    if (speed <= 0.1) return;
    const now = new Date(this.ctx.clock.now());
    const event: GritEvent = {
      id: `${now.getTime()}_${kind}_${name}`,
      startTime: now,
      state: 'Moderate',
      alive: true,
      description: kind,
      actualStr: `${kind === 'ENTERED_INTO' ? 'Entered' : 'Exited'} ${name}`,
      poiName: name,
    };
    const bucket = this.current.get(tab) ?? {};
    bucket[event.id] = event;
    this.current.set(tab, bucket);
    this.notify(tab, event);
    this.ctx.clock.setTimeout(() => {
      event.alive = false;
      event.endTime = new Date(this.ctx.clock.now());
      this.updateEventsOntoUI(tab);
    }, 5000);
  }

  private notify(tab: TabId, event: GritEvent): void {
    if (!this.notifyEnabled.get(tab)) return;
    if (this.ctx.clock.now() < (this.startupUntil.get(tab) ?? 0)) return;
    const delay = event.description === 'HIGH_CPU' ? 7000 : 0;
    const timer = this.ctx.clock.setTimeout(() => {
      const scope = this.ctx.document.getElementById(tab);
      const popup = scope?.querySelector('.grit-event-popup-entries');
      if (!popup) return;
      popup.innerHTML += `<li id="${event.id}" class="${event.state} eventElement"><span class="red-status"></span><p>${event.actualStr}</p></li>`;
      this.ctx.clock.setTimeout(() => {
        popup.querySelector(`#${event.id}`)?.remove();
      }, 5000);
    }, delay);
    const timers = this.notificationTimers.get(tab) ?? [];
    timers.push(timer);
    this.notificationTimers.set(tab, timers);
  }

  setEventNotificationFlag(tab: TabId, enabled = true): void {
    this.notifyEnabled.set(tab, enabled);
    this.ctx.clock.setTimeout(() => this.notifyEnabled.set(tab, true), 10000);
  }

  delayEventsNotifications(tab: TabId): void {
    this.notifyEnabled.set(tab, false);
    this.startupUntil.set(tab, this.ctx.clock.now() + 12000);
    this.ctx.clock.setTimeout(() => this.notifyEnabled.set(tab, true), 10000);
  }

  setEventLimit(tab: TabId, limit: number): void {
    if (![5, 10, 20, 50, 100].includes(limit)) return;
    this.historyLimit.set(tab, limit);
    const device = this.ctx.deviceTileId(tab);
    this.ctx.store.set(
      ['app', 'deviceManagement', 'devices', device, 'eventHistoryLimit'],
      limit,
    );
    this.ctx.store.save();
  }

  updateEventsOntoUI(tab: TabId): void {
    const list = this.ctx.document.querySelector(`#${tab} .grit-current-events-layout .grit-event-entries`);
    if (!list) return;
    const events = Object.values(this.current.get(tab) ?? {});
    list.innerHTML = events
      .map((event) => `<li id="${event.id}" class="${event.state} eventElement"><p>${event.actualStr}</p></li>`)
      .join('');
    const count = events.filter((event) => event.alive).length;
    text(this.ctx, tab, '#gritCurrentEventsCount', `(${count})`);
    text(this.ctx, tab, '#grit-events-count', count);
  }

  resetEventsData(tab: TabId): void {
    const live = Object.values(this.current.get(tab) ?? {}).filter((event) => event.alive);
    const all = [...(this.history.get(tab) ?? []), ...live];
    this.history.set(tab, all.slice(-(this.historyLimit.get(tab) ?? 100)));
    this.current.set(tab, {});
    this.updateEventsOntoUI(tab);
  }

  processLanguage(tab?: TabId): number {
    return new GritStatusBar(this.ctx).processLanguage(tab);
  }
}

export interface SpectrumSample { frequency: number; power: number }
export interface SpectrumSettings {
  updateRate: number;
  spectrumResolution: number;
  timeAveraging: number;
  detectionSensitivity: number;
}

export class SpectrumViewer {
  readonly settings = new Map<TabId, SpectrumSettings>();
  readonly chunks = new Map<TabId, Map<number, SpectrumSample[]>>();
  readonly seen = new Map<TabId, Set<number>>();
  readonly samples = new Map<TabId, SpectrumSample[]>();
  readonly waterfall = new Map<TabId, SpectrumSample[][]>();
  readonly plotType = new Map<TabId, 'spectrumPlot' | 'waterfallPlot'>();
  readonly yRange = new Map<TabId, [number, number]>();
  readonly ctx: GritContext;

  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }

  getAdvSettingInfo(tab: TabId): SpectrumSettings {
    let value = this.settings.get(tab);
    if (!value) {
      value = { updateRate: 1, spectrumResolution: 1, timeAveraging: 10, detectionSensitivity: 5 };
      this.settings.set(tab, value);
    }
    return { ...value };
  }

  setAdvSettingInfo(data: Partial<SpectrumSettings>, tab: TabId): SpectrumSettings {
    const current = this.getAdvSettingInfo(tab);
    const next = { ...current, ...data };
    const validRes = [1, 2, 4, 8, 16, 32, 64].includes(next.spectrumResolution);
    if (!validRes) next.spectrumResolution = current.spectrumResolution;
    if (next.spectrumResolution === 64 && next.updateRate < 0.2) next.updateRate = 0.2;
    else if (next.spectrumResolution === 32 && next.updateRate < 0.1) next.updateRate = 0.1;
    else if (next.updateRate < 0.05) next.updateRate = 0.05;
    if (this.plotType.get(tab) === 'waterfallPlot' && next.updateRate < 1) next.updateRate = 1;
    next.timeAveraging = Math.min(50, Math.max(0, next.timeAveraging));
    next.detectionSensitivity = Math.min(30, Math.max(1, next.detectionSensitivity));
    this.settings.set(tab, next);
    return { ...next };
  }

  setPlotType(tab: TabId, type: 'spectrumPlot' | 'waterfallPlot'): void {
    this.plotType.set(tab, type);
    if (type === 'waterfallPlot') this.setAdvSettingInfo({ updateRate: 1 }, tab);
  }

  ingest(msgId: number, data: Record<string, unknown>, tab: TabId): boolean {
    if (msgId !== 1968 && msgId !== 2063) return false;
    const sequence = number(data.sequence);
    const seen = this.seen.get(tab) ?? new Set<number>();
    let chunks = this.chunks.get(tab);
    if (!chunks) {
      chunks = new Map();
      this.chunks.set(tab, chunks);
    }
    if (seen.has(sequence)) return false;
    seen.add(sequence);
    this.seen.set(tab, seen);
    const start = number(data.frequencyStart);
    const stepMHz = number(data.stepSize) / 1_000_000;
    const rows = Array.isArray(data.data) ? data.data : [];
    chunks.set(
      sequence,
      rows.map((row, index) => {
        const record = row as Record<string, unknown>;
        const raw = number(record.sample ?? record.raw ?? record.power);
        return {
          frequency: start + index * stepMHz,
          power: record.power !== undefined ? number(record.power) : raw / 256 - 200,
        };
      }),
    );
    if (sequence !== 0) return true;
    const samples: SpectrumSample[] = [];
    for (const key of [...chunks.keys()].reverse()) {
      const chunk = chunks.get(key);
      if (chunk) samples.push(...chunk);
    }
    if (samples.length) {
      this.samples.set(tab, samples);
      this.yRange.set(tab, this.calculateYRange(samples));
      if (this.plotType.get(tab) === 'waterfallPlot') {
        const frames = this.waterfall.get(tab) ?? [];
        frames.push(samples);
        this.waterfall.set(tab, frames.slice(-10));
      }
      this.render(tab);
    }
    chunks.clear();
    seen.clear();
    return true;
  }

  calculateYRange(samples: SpectrumSample[]): [number, number] {
    if (!samples.length) return [-135, -30];
    let min = Math.min(...samples.map((sample) => sample.power));
    let max = Math.max(...samples.map((sample) => sample.power));
    min = min < 0 ? Math.floor(min / 10) * 10 - 1 : Math.floor(min / 10) * 10 + 1;
    max = max < 0 ? Math.floor(max / 10) * 10 + 9 : Math.floor(max / 10) * 10 - 1;
    return [min - 10, max + 10];
  }

  placeConfiguration(tab: TabId, frequency = 'LBAND', mode = 'PREDECIMATION'): Uint8Array | undefined {
    const settings = this.getAdvSettingInfo(tab);
    const serial = this.ctx.connectionType(tab) === 'Serial';
    const params: ConfigDataMap = [
      { frequency: [frequency, 'enum', 4] },
      { mode: [mode, 'enum', 4] },
      { updatePeriod: [(serial ? 1 : settings.updateRate) * 1000, 'ulong', 4] },
      { fftSize: [`${serial ? 1 : settings.spectrumResolution}K`, 'enum', 4] },
      { timeAvg: [serial ? 10 : settings.timeAveraging, 'ulong', 4] },
      { subCarrierAvg: [serial ? 5 : settings.detectionSensitivity, 'ulong', 4] },
    ];
    const bytes = this.ctx.commands
      ? buildConfigBinary(this.ctx.commands, 'itspectralanalysis', params)
      : undefined;
    if (bytes) this.ctx.transport.sendBinary(tab, bytes);
    return bytes;
  }

  private render(tab: TabId): void {
    const target = this.ctx.document.getElementById(`${tab}-graph`);
    const samples = this.samples.get(tab) ?? [];
    if (!target || !samples.length) return;
    const plotly = (globalThis as { Plotly?: { react?: Function; newPlot?: Function } }).Plotly;
    const trace = [{ x: samples.map((sample) => sample.frequency), y: samples.map((sample) => sample.power), type: 'scatter' }];
    const layout = { yaxis: { range: this.yRange.get(tab) }, colorway: ['1192E8'] };
    try {
      (plotly?.react ?? plotly?.newPlot)?.call(plotly, target.id, trace, layout);
    } catch {}
  }

  resetSpectrumViewer(tab: TabId): void {
    this.samples.delete(tab);
    this.chunks.delete(tab);
    this.seen.delete(tab);
    this.waterfall.delete(tab);
  }

  processLanguage(tab?: TabId): number {
    return new GritStatusBar(this.ctx).processLanguage(tab);
  }
}

export class GritInterferenceToolKit {
  readonly detections = new Map<TabId, Record<string, unknown>[]>();
  readonly filterTable = new Map<TabId, Record<string, unknown>[]>();
  readonly fftStatus = new Map<TabId, number>();
  readonly ctx: GritContext;
  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }

  updateChart(data: Record<string, unknown>, tab: TabId): void {
    const rows = Array.isArray(data.data) ? data.data : [];
    this.detections.set(
      tab,
      rows.filter((row) => String((row as Record<string, unknown>).detectionType) === 'SPECTRALANALYSIS') as Record<string, unknown>[],
    );
  }

  updateFilterTable(data: Record<string, unknown>, tab: TabId): void {
    const rows = Array.isArray(data.data) ? data.data : [];
    this.filterTable.set(tab, rows as Record<string, unknown>[]);
  }

  updateSpectralAnalysisStatus(data: Record<string, unknown>, tab: TabId): void {
    this.fftStatus.set(tab, (number(data.status) & 0x0700) >> 8);
  }

  frameFilter(tab: TabId, frequency: string, filterId: string, enabled: boolean, mode: string, cutoff: number, width: number): Uint8Array | undefined {
    const params: ConfigDataMap = [
      { frequency: [frequency, 'enum', 4] },
      { filterId: [filterId, 'enum', 4] },
      { filterSwitch: [enabled ? 'ENABLE' : 'DISABLE', 'enum', 4] },
      { filterMode: [mode, 'enum', 4] },
      { cutOffFrequency: [cutoff, 'float', 4] },
      { notchWidth: [width, 'float', 4] },
    ];
    const bytes = this.ctx.commands ? buildConfigBinary(this.ctx.commands, 'itprogfiltconfig', params) : undefined;
    if (bytes) this.ctx.transport.sendBinary(tab, bytes);
    return bytes;
  }

  processLanguage(tab?: TabId): number {
    return new GritStatusBar(this.ctx).processLanguage(tab);
  }
}

export interface PoiRecord {
  name: string;
  radius: number;
  lat: number;
  lng: number;
  notification: 'entry' | 'exit' | 'none';
  visible: 'show' | 'hide';
  status: 'active' | 'inactive';
  type: string;
}

export class PointsOfInterest {
  readonly inside = new Map<string, boolean>();
  readonly ctx: GritContext;
  readonly events: GritEvents;
  constructor(ctx: GritContext, events: GritEvents) {
    this.ctx = ctx;
    this.events = events;
  }

  data(tab: TabId): { manual: Record<string, PoiRecord>; triggers: Record<string, PoiRecord> } {
    const device = this.ctx.deviceTileId(tab);
    const raw = this.ctx.store.getData<Record<string, unknown>>(['app', 'poi', device]);
    const source = (raw ?? {}) as { manual?: Record<string, PoiRecord>; triggers?: Record<string, PoiRecord> };
    return { manual: { ...(source.manual ?? {}) }, triggers: { ...(source.triggers ?? {}) } };
  }

  adddataUI(tab: TabId): Record<string, PoiRecord> {
    const data = this.data(tab);
    const all = { ...data.manual, ...data.triggers };
    const list = this.ctx.document.querySelector(`#${tab} #poiListView`);
    if (list) {
      list.innerHTML = Object.values(all)
        .map((poi) => `<li data-poi="${poi.name}"><span>${poi.name}</span><span>${poi.radius}</span></li>`)
        .join('');
    }
    return all;
  }

  save(tab: TabId, kind: 'manual' | 'triggers', poi: PoiRecord): boolean {
    if (poi.name.length === 0 || poi.name.length > 16) return false;
    if (poi.radius < 0 || poi.radius > 99999) return false;
    const data = this.data(tab);
    if (data.manual[poi.name] || data.triggers[poi.name]) return false;
    const device = this.ctx.deviceTileId(tab);
    const next = { ...data, [kind]: { ...data[kind], [poi.name]: poi } };
    this.ctx.store.set(['app', 'poi', device], next);
    this.ctx.store.save();
    this.adddataUI(tab);
    return true;
  }

  updateData(data: Record<string, unknown>, msgId: number, tab: TabId): void {
    if (msgId !== 42) return;
    const speed = number(data.horSpeed ?? this.ctx.document?.documentElement?.getAttribute('data-grit-speed'));
    // `gritEvents.js:610` — the whole handler returns below 0.1 m/s *including* the inside/outside
    // bookkeeping, so a slow frame never swallows the next real entry.
    if (!(speed > 0.1)) return;
    const latitude = number(data.latitude);
    const longitude = number(data.longitude);
    for (const poi of Object.values(this.data(tab).manual)) {
      if (poi.status !== 'active' || poi.notification === 'none') continue;
      const key = `${tab}:${poi.name}`;
      const distance = this.distance(latitude, longitude, poi.lat, poi.lng);
      const nowInside = distance <= poi.radius;
      const before = this.inside.get(key) ?? false;
      if (nowInside !== before) {
        this.events.addPOIEvent(nowInside ? 'ENTERED_INTO' : 'EXITED_FROM', poi.name, speed, tab);
      }
      this.inside.set(key, nowInside);
    }
  }

  distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  refactorPOIObjects(records: Record<string, PoiRecord>): Record<string, PoiRecord> {
    const seen = new Set<string>();
    const out: Record<string, PoiRecord> = {};
    for (const [key, poi] of Object.entries(records)) {
      const id = `${poi.lat.toFixed(6)},${poi.lng.toFixed(6)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out[key] = poi;
    }
    return out;
  }
}

export class GritSpoofingConfiguration {
  readonly stages = new Map<TabId, string>();
  readonly enabled = new Map<TabId, boolean>();
  readonly ctx: GritContext;
  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }

  setSpoofingPageStage(data: Record<string, unknown>, tab: TabId): void {
    this.stages.set(tab, String(data.mode ?? 'NONE'));
    for (const id of ['stageOneView', 'stageTwoView', 'stageThreeView', 'stageFourView']) {
      setVisible(this.ctx.document.querySelector(`#${tab} #${id}`), false);
    }
    const id =
      data.mode === 'PASS'
        ? 'stageThreeView'
        : data.mode === 'INPROGRESS'
          ? 'stageTwoView'
          : data.mode === 'FAIL'
            ? 'stageFourView'
            : 'stageOneView';
    setVisible(this.ctx.document.querySelector(`#${tab} #${id}`), true);
  }

  setSKDetectInitialState(data: Record<string, unknown>, tab: TabId): void {
    const enabled = data.mode === 'ENABLE';
    this.enabled.set(tab, enabled);
    const input = scopedQuery(
      pageContext(this.ctx),
      tab,
      '.spoofing-toggle-button',
    ) as (Element & { checked?: boolean }) | null;
    if (input) input.checked = enabled;
  }

  sendCalibration(tab: TabId, option = 'ALL'): Uint8Array | undefined {
    return this.send(tab, 'skcalibrate', [
      { mode: ['START', 'enum', 4] },
      { option: [option, 'enum', 4] },
      { reserved: [0, 'ulong', 4] },
    ]);
  }

  sendToggle(tab: TabId, enabled: boolean): Uint8Array | undefined {
    this.enabled.set(tab, enabled);
    return this.send(tab, 'skdetectconfig', [
      { mode: [enabled ? 'ENABLE' : 'DISABLE', 'enum', 4] },
      { reserved1: [0, 'ulong', 4] },
      { reserved2: [0, 'ulong', 4] },
    ]);
  }

  private send(tab: TabId, command: string, params: ConfigDataMap): Uint8Array | undefined {
    const bytes = this.ctx.commands ? buildConfigBinary(this.ctx.commands, command, params) : undefined;
    if (bytes) this.ctx.transport.sendBinary(tab, bytes);
    return bytes;
  }

  processLanguage(tab?: TabId): number {
    return new GritStatusBar(this.ctx).processLanguage(tab);
  }
}

export class GritMenuBar {
  readonly ctx: GritContext;
  constructor(ctx: GritContext) {
    this.ctx = ctx;
  }
  setEventCount(tab: TabId, count: number): void {
    text(this.ctx, tab, '#grit-events-count', count);
  }
  hideCapabilities(tab: TabId, spoofing: boolean, ethernet: boolean, map: boolean): void {
    if (!spoofing) setVisible(this.ctx.document.querySelector(`#${tab} #menuConfig`), false);
    if (!ethernet) setVisible(this.ctx.document.querySelector(`#${tab} #gritNetworkingSettings`), false);
    if (!ethernet && !map) setVisible(this.ctx.document.querySelector(`#${tab} #menuSettings`), false);
  }
  processLanguage(tab?: TabId): number {
    return new GritStatusBar(this.ctx).processLanguage(tab);
  }
}

