import {
  MSG_ID,
  clone,
  escapeHTML,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  renderPlotly,
  setStyle,
  setText,
  showRag,
  tabOf,
  applyLanguageMarkers,
  __,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';
import {
  ConstellationIdConstants,
  ConstellationWiseSingalEnums,
  giiiSatvisConstellationMap,
  giiiConstellationWiseSingalEnums,
  giiitrackstatConstellationMap,
  satvisConstellationMap,
  signalTypeDesc,
  trackstatConstellationMap,
  updatedSignalTypeDesc,
} from '../../../protocol/src/generated-status-tables.ts';

const SYSTEM_BY_MASK = ['GPS', 'GLONASS', 'SBAS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'OTHER'];
const GOOD_REJECT = new Set<unknown>([0, 13, 18, 19, 20, 21, 22, 23, 26]);
const CARRIER_POOR = 20;
const CARRIER_WARNING = 35;
const CARRIER_GOOD = 60;
const LOCK_LESS_MINUTE = 1800;
const LOCK_LESS_HOUR = 3600;
const CUTOFF_IDS = new Set([50, 735, 1114, 1350, 1582, 2134]);

const GIII_SIGNALS: Record<string, Record<string, string[]>> = {
  GIII: {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS', 'L1L2', 'L5L2'],
    GALILEO: ['E1', 'E5A'],
    NAVIC: ['L5', 'S'],
    QZSS: ['L1CA', 'L1C', 'L2C', 'L5', 'L1SA', 'L1SB', 'L5S', 'L5SI', 'L5SQ'],
  },
  'WAAS G-III': {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS', 'L1L2', 'L5L2'],
    GALILEO: ['E1', 'E5A'],
  },
  'IRIMS G-III': { NAVIC: ['L5', 'S'] },
  'QZSS G-III': {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    QZSS: ['L1CA', 'L1C', 'L2C', 'L5', 'L1SA', 'L1SB', 'L5S', 'L5SI', 'L5SQ'],
  },
  Galileo: {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS'],
    GALILEO: ['E1', 'E5A'],
  },
  'KASS G-III': {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS'],
  },
  'EGNOS RIMS V3': {
    GPS: ['L1CA', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS'],
    GALILEO: ['E1', 'E5A'],
  },
  'KUS G-III': {
    GPS: ['L1CA', 'L1C', 'L2P(Y)', 'L2C', 'L5'],
    SBAS: ['L1CASBAS', 'L5SBAS', 'L1L2', 'L5L2'],
  },
};

const CONSTELLATION_ALIASES: Record<string, string> = {
  GLO: 'GLONASS',
  GAL: 'GALILEO',
  BDS: 'BEIDOU',
  OTHER: 'LBAND',
};

function constellationName(value: unknown): string {
  const text = String(value ?? '').toUpperCase();
  const direct = String(
    (trackstatConstellationMap as Record<string, string>)[text] ??
      (satvisConstellationMap as Record<string, string>)[text] ??
      text,
  ).toUpperCase();
  return CONSTELLATION_ALIASES[direct] ?? direct;
}

function featureConstellationName(value: unknown): string {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const id = String(value);
    const match = Object.entries(ConstellationIdConstants).find(([, code]) => String(code) === id);
    if (match) return match[0] === 'OTHER' ? 'LBAND' : match[0];
  }
  return constellationName(value);
}

interface TrackPoint extends LogData {
  prn: number;
  cno: number;
  channel: string;
  system: string;
  rejectcode: unknown;
  doppler: number;
  psr: number;
  residual: number;
  lockTime: number;
  channelNumber: number;
  elevation?: number;
}

interface VisibilityPoint extends LogData {
  prn: number;
  azimuthal: number;
  elevation: number;
  health: unknown;
}

export class SatelliteTracking {
  readonly data: Record<TabId, Record<string, LogData>> = {};
  readonly satelliteCountData: Record<TabId, Record<string, number>> = {};
  readonly trackingRAGStatus: Record<TabId, string | undefined> = {};
  readonly ui: Record<TabId, {
    antenna: 'PRIMARY' | 'SECONDARY';
    constellation: string;
    graph: 'carrierToNoise' | 'lockTime';
    sortby: string;
    gridlines: boolean;
    elevationMask: boolean;
    highestLowest: boolean;
  }> = {};
  readonly trackingData: Record<TabId, Partial<Record<'PRIMARY' | 'SECONDARY', Record<string, TrackPoint[]>>>> = {};
  readonly visibilityData: Record<TabId, Record<string, VisibilityPoint[]>> = {};
  readonly satvisData: Record<TabId, Record<string, LogData>> = {};
  readonly supportedSignals: Record<TabId, Map<string, string[]>> = {};
  readonly bestPosData: Record<TabId, LogData> = {};
  readonly lbandTrackstatData: Record<TabId, LogData> = {};
  readonly lbandBeamTableData: Record<TabId, LogData> = {};
  readonly cutoffData: Record<TabId, Record<string, number>> = {};
  readonly highestLowestData: Record<TabId, Record<string, number[]>> = {};
  readonly legendHidden: Record<TabId, boolean> = {};
  readonly satelliteDialogOpen: Record<TabId, boolean> = {};
  readonly hoverMask: Record<TabId, boolean> = {};
  private readonly ctx: StatusContext;
  private goodCountListener?: (tab: TabId, count: number) => void;
  private positionStatusSource?: (tab: TabId) => {
    giiiFix?: string;
    clockComputed?: LogData;
  };
  private readonly wiredTabs = new Set<TabId>();
  private readonly lbandFallbackShown = new Set<TabId>();

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  dc_updateData(msgID: number, input: unknown): number {
    const data = clone(normalizeLog(input)) as LogData;
    const tab = tabOf(data);
    if (!tab) return 0;
    this.ensureUi(tab);
    const bucket = (this.data[tab] ??= {});
    if (msgID === MSG_ID.TRACKSTAT) {
      const antenna = data.antenna === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
      data.antenna = antenna;
      const parsed = this.parseTrackstat(tab, data);
      this.trackingData[tab] ??= {};
      this.trackingData[tab][antenna] = parsed;
      bucket[this.ui[tab].antenna === antenna ? String(msgID) : `${msgID}_1`] = data;
      this.updateCounts(tab, data);
      if (this.ui[tab].antenna === antenna) this.renderChart(tab, data);
    } else if (msgID === MSG_ID.RXSTATUS) {
      bucket[String(msgID)] = data;
      this.updateStatus(tab);
    } else if (msgID === MSG_ID.SATVIS2) {
      bucket[String(msgID)] = data;
      this.captureVisibility(tab, data);
      this.renderChart(tab, data);
    } else if (msgID === MSG_ID.CHANCONFIGLIST) {
      bucket[String(msgID)] = data;
      this.captureSupportedSignals(tab, data);
      this.renderChart(tab, data);
    } else if (msgID === MSG_ID.BESTPOS) {
      this.bestPosData[tab] = data;
      bucket[String(msgID)] = data;
    } else if (msgID === MSG_ID.LBANDTRACKSTAT) {
      this.lbandTrackstatData[tab] = data;
      bucket[String(msgID)] = data;
      const lband = this.parseLbandTracking(tab, data);
      this.trackingData[tab] ??= {};
      const antenna = this.ui[tab].antenna;
      this.trackingData[tab][antenna] ??= {};
      this.trackingData[tab][antenna]!.LBAND = lband;
      this.renderChart(tab, data);
    } else if (msgID === MSG_ID.LBANDBEAMTABLE) {
      this.lbandBeamTableData[tab] = data;
      bucket[String(msgID)] = data;
    } else if (msgID === MSG_ID.GIII_MEASUREMENTDATA) {
      bucket[String(msgID)] = data;
      this.dc_updateData(MSG_ID.TRACKSTAT, this.fromGiiiMeasurement(tab, data));
    } else if (msgID === MSG_ID.GIII_SATPOS) {
      bucket[String(msgID)] = data;
      this.dc_updateData(MSG_ID.SATVIS2, this.fromGiiiSatpos(tab, data));
    } else if (msgID === MSG_ID.GIII_RXCOMMANDS) {
      bucket[String(msgID)] = data;
      const commands = Array.isArray(data.configData) ? data.configData.map(String) : [];
      const cutoff = commands
        .find((command) => command.toUpperCase().startsWith('ECUTOFF'))
        ?.split(/\s+/)
        .at(-1);
      if (cutoff !== undefined && Number.isFinite(Number(cutoff))) {
        const cutoffs = (this.cutoffData[tab] ??= {});
        for (const id of CUTOFF_IDS) cutoffs[String(id)] = Number(cutoff);
      }
    } else if (CUTOFF_IDS.has(msgID)) {
      bucket[String(msgID)] = data;
      const cutoffs = (this.cutoffData[tab] ??= {});
      cutoffs[String(msgID)] = numberValue(data.angle);
    } else {
      bucket[String(msgID)] = data;
    }
    if (this.satelliteDialogOpen[tab]) this.refreshSatelliteDataList(tab);
    return 1;
  }

  resetTrackingUI(tab: TabId): void {
    const persisted = this.ctx.userData<LogData>([
      'app',
      'deviceManagement',
      'devices',
      this.ctx.deviceTileId(tab),
      'trackingTiles',
    ]) ?? {};
    const features = this.ctx.features(tab);
    const antenna =
      !features.dualAntennaSupported || persisted.selectedAntenna !== 'dual-antenna'
        ? 'PRIMARY'
        : 'SECONDARY';
    this.ui[tab] = {
      antenna,
      constellation: String(persisted.selectedSatellite ?? 'GPS'),
      graph: (persisted.selectedGraph === 'lockTime' ? 'lockTime' : 'carrierToNoise'),
      sortby: String(persisted.selectedSortOption ?? 'trackingprn'),
      gridlines: persisted.selectedGridlinesOption !== false,
      elevationMask: persisted.selectedEleMaskOption !== false,
      highestLowest: persisted.selectedHighLowOption !== false,
    };
    this.legendHidden[tab] = false;
    this.satelliteDialogOpen[tab] = false;
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    const dual = scope.querySelector('#dual-antenna');
    setStyle(dual, 'display', features.dualAntennaSupported ? 'inline-block' : 'none');
    if (features.dualAntennaSupported) setStyle(dual, 'border-radius', '0px 5px 5px 0px');
    setStyle(
      scope.querySelector('#single-antenna'),
      'border-radius',
      features.dualAntennaSupported ? '5px 0px 0px 5px' : '5px 5px 5px 5px',
    );
    for (const node of scope.querySelectorAll('#antennaFields-items li')) node.classList.remove('active');
    for (const node of scope.querySelectorAll('#constellation-items li')) node.classList.remove('active');
    for (const node of scope.querySelectorAll('#graphsFields-items li')) node.classList.remove('active');
    const firstVisible = (selector: string): Element | undefined =>
      scope
        .querySelectorAll(selector)
        .find((element) => (element as Element & { style?: CSSStyleDeclaration }).style?.display !== 'none');
    const antennaChoice =
      scope.querySelector('#' + (antenna === 'SECONDARY' ? 'dual-antenna' : 'single-antenna')) ??
      firstVisible('#antennaFields-items li');
    antennaChoice?.classList.add('active');
    const constellationChoice =
      scope.querySelector('#' + this.ui[tab].constellation) ??
      firstVisible('#constellation-items li');
    constellationChoice?.classList.add('active');
    this.ui[tab].constellation = constellationChoice?.getAttribute('id') ?? 'GPS';
    const graphChoice =
      scope.querySelector('#' + this.ui[tab].graph) ??
      firstVisible('#graphsFields-items li');
    graphChoice?.classList.add('active');
    this.ui[tab].graph =
      graphChoice?.getAttribute('id') === 'lockTime' ? 'lockTime' : 'carrierToNoise';
    for (const input of scope.querySelectorAll('.sortSection input[type=radio]')) {
      const inputElement = input as HTMLInputElement;
      const id = inputElement.id.replace(new RegExp(`-${tab}$`), '');
      inputElement.checked = id === this.ui[tab].sortby;
    }
    for (const [selector, property] of [
      ['#elevationMask', 'elevationMask'],
      ['#highLowValues', 'highestLowest'],
      ['#gridlines', 'gridlines'],
    ] as const) {
      const input = scope.querySelector(selector) as HTMLInputElement | null;
      if (input) input.checked = Boolean(this.ui[tab][property]);
    }
    this.updateGraphUi(tab);
    this.wireUi(tab, scope);
    this.renderChart(tab, this.data[tab]?.[String(MSG_ID.TRACKSTAT)] ?? {});
  }

  displayingSupportedConstellations(supported: string[], tab: TabId): number {
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return 0;
    const features = this.ctx.features(tab);
    const input = features.isGIII
      ? supported
      : this.ctx.supportedConstellations(tab) ?? supported;
    const identity = new Set(input.map((entry) => featureConstellationName(entry)));
    const hasOther = identity.has('OTHER') || identity.has('LBAND');
    for (const node of scope.querySelectorAll('#constellation-items li')) {
      const id = node.getAttribute('id') ?? '';
      const aliases = id === 'GLONASS' ? ['GLONASS', 'GLO'] : id === 'BEIDOU' ? ['BEIDOU', 'BDS'] : id === 'GALILEO' ? ['GALILEO', 'GAL'] : [id];
      let visible = aliases.some((alias) => identity.has(alias));
      if (id === 'LBAND' && !hasOther && !this.lbandFallbackShown.has(tab)) {
        visible = true;
        this.lbandFallbackShown.add(tab);
      }
      setStyle(node, 'display', visible ? 'inline-block' : 'none');
    }
    const visibleItems = scope
      .querySelectorAll('#constellation-items li')
      .filter((node) => (node as Element & { style?: CSSStyleDeclaration }).style?.display !== 'none');
    if (visibleItems.length) {
      setStyle(visibleItems[0], 'border-radius', '5px 0px 0px 5px');
      setStyle(visibleItems.at(-1)!, 'border-radius', '0px 5px 5px 0px');
    }
    return 1;
  }

  decodeTrackingStatusRagMessages(tab: TabId): string | undefined {
    return this.trackingRAGStatus[tab];
  }

  dataDialogClosed(tab: TabId): void {
    this.satelliteDialogOpen[tab] = false;
  }

  handleTabClick(tab: TabId): void {
    if (!this.legendHidden[tab]) this.legendHidden[tab] = false;
    this.renderChart(tab, this.data[tab]?.[String(MSG_ID.TRACKSTAT)] ?? {});
  }

  resetData(tab: TabId): void {
    this.wiredTabs.delete(tab);
    delete this.data[tab];
    delete this.satelliteCountData[tab];
    delete this.trackingRAGStatus[tab];
    delete this.trackingData[tab];
    delete this.visibilityData[tab];
    delete this.satvisData[tab];
    delete this.supportedSignals[tab];
    delete this.bestPosData[tab];
    delete this.lbandTrackstatData[tab];
    delete this.lbandBeamTableData[tab];
    delete this.cutoffData[tab];
    delete this.highestLowestData[tab];
    delete this.legendHidden[tab];
    delete this.satelliteDialogOpen[tab];
    this.resetTrackingUI(tab);
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['satelliteTracking', 'SATELLITE_TRACKING'], ['view-all-sat-info', 'VIEW_ALL_SAT_INFO'],
      ['antenna', 'ANTENNA'], ['constellation', 'CONSTELLATION'], ['graphs', 'GRAPHS'],
      ['carrier-to-noise', 'CARRIER_TO_NOISE'], ['carrier-to-noise-ratio', 'CARRIER_TO_NOISE_RATIO'],
      ['lock-time-sec', 'LOCK_TIME_SEC'], ['lock-time', 'LOCK_TIME'], ['sortby', 'SORT_BY'],
      ['prn', 'PRN'], ['elevation-lessthan-90', 'ELEVATION_LESSTHAN_90'],
      ['elevation-greaterthan-90', 'ELEVATION_GREATERTHAN_90'],
      ['showLegend', 'SHOWLEGEND'], ['gridlines', 'GRIDLINES'],
      ['high-low-values', 'HIGHEST_LOWEST_VALUES'], ['elevation-mask', 'ELEVATION_MASK'],
      ['elevation', 'ELEVATION'], ['channel', 'CHANNEL'], ['frequency', 'FREQUENCY'],
      ['all-sat-info', 'ALL_SATELLITE_INFO_TITLE'], ['no-signal', 'NO_SIGNAL'],
      ['satellite-number-prn', 'SATELLITE_NUMBER_PRN'],
      ['tracking-copy-to-clipboard', 'TRACKING_COPY_TO_CLIPBOARD'],
      ['warning', 'WARNING'], ['poor', 'POOR'], ['good', 'GOOD'],
      ['tracking-AUX4-Warning', 'TRACKING-AUX4-WARNING'],
      ['tracking-less-sats-oem6', 'TRACKING-LESS-SATS-OEM6'],
      ['tracking-AUX4-Bad', 'TRACKING-AUX4-BAD'],
      ['satviewstatusred', 'SATVIEWSTATUSRED'],
      ['tracking-less-than4-sats', 'TRACKING-LESS-THAN4-SATS'],
    ];
    applyLanguageMarkers(this.ctx, keys.map(([marker, key]) => ({
      selector: `[data-lang-${marker}]`,
      value: __(this.ctx, key),
    })));
  }

  private ensureUi(tab: TabId): void {
    this.ui[tab] ??= {
      antenna: 'PRIMARY',
      constellation: 'GPS',
      graph: 'carrierToNoise',
      sortby: 'trackingprn',
      gridlines: true,
      elevationMask: true,
      highestLowest: true,
    };
  }

  private updateCounts(tab: TabId, data: LogData): void {
    const counts: Record<string, number> = {
      GPS: 0,
      GLONASS: 0,
      GALILEO: 0,
      BEIDOU: 0,
      QZSS: 0,
      NAVIC: 0,
      SBAS: 0,
      OTHER: 0,
    };
    for (const row of rowsOf(data)) {
      const status = numberValue(row.channelTrackingStatus);
      const system = constellationName(
        row.satSystem ?? SYSTEM_BY_MASK[(status >>> 16) & 0x7] ?? 'OTHER',
      );
      const used = [0x04, 0x0b].includes(status & 0x1f);
      if (used && numberValue(row.PRN) && Object.prototype.hasOwnProperty.call(counts, system)) {
        counts[system] += 1;
      }
    }
    this.satelliteCountData[tab] = counts;
    this.goodCountListener?.(
      tab,
      Object.values(counts).reduce((sum, count) => sum + count, 0),
    );
    this.updateStatus(tab);
  }

  setGoodCountListener(listener: (tab: TabId, count: number) => void): void {
    this.goodCountListener = listener;
  }

  setPositionStatusSource(source: (tab: TabId) => {
    giiiFix?: string;
    clockComputed?: LogData;
  }): void {
    this.positionStatusSource = source;
  }

  private updateStatus(tab: TabId): void {
    const track = this.data[tab]?.[String(MSG_ID.TRACKSTAT)];
    if (!track) return;
    const features = this.ctx.features(tab);
    const rows = this.trackingData[tab]?.[this.ui[tab].antenna] ?? {};
    const total = this.satelliteCountData[tab] ?? {};
    if (features.isGIII) {
      const parent = 'giiisatelliteTrackingStatus';
      const good = Object.values(total).reduce((sum, count) => sum + count, 0);
      const hasVisibility = Object.values(this.satvisData[tab] ?? {}).some(
        (system) => rowsOf(system).length > 0,
      );
      if (good < 4 || !hasVisibility) {
        this.trackingRAGStatus[tab] = 'nofixgiiitrackingred';
        showRag(this.ctx, tab, parent, 'bad');
        return;
      }
      const position = this.positionStatusSource?.(tab);
      const clock = position?.clockComputed ?? {};
      const clockComputed =
        Object.keys(clock).length > 0 && !Object.values(clock).includes('Not Computed');
      if (position?.giiiFix === 'FIX' && !clockComputed) {
        this.trackingRAGStatus[tab] = 'giiiTrackingRed';
        showRag(this.ctx, tab, parent, 'bad');
      } else if (position?.giiiFix && position.giiiFix !== 'FIX') {
        this.trackingRAGStatus[tab] = 'nofixgiiitrackingred';
        showRag(this.ctx, tab, parent, 'bad');
      } else {
        showRag(this.ctx, tab, parent, 'good');
      }
      return;
    }
    const gpsGood = (rows.GPS ?? []).filter((row) => GOOD_REJECT.has(row.rejectcode)).length;
    const aux4 = numberValue(this.data[tab]?.[String(MSG_ID.RXSTATUS)]?.aux4statusBit, -1);
    if (features.generation === 'OEM6' || features.generation === 'OEMSTAR') {
      const good = Object.values(total).reduce((sum, count) => sum + count, 0);
      if (good >= 4) {
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'good');
      } else {
        this.trackingRAGStatus[tab] = 'satviewstatusred';
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'bad');
      }
      return;
    }
    const gps = rows.GPS;
    if (gps) {
      if (gpsGood <= 4) {
        this.trackingRAGStatus[tab] = 'tracking-less-than4-sats';
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'bad');
        return;
      }
      if (aux4 === 0) {
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'good');
      } else if (aux4 === 1) {
        this.trackingRAGStatus[tab] = 'tracking-AUX4-Warning';
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'warning');
      } else {
        this.trackingRAGStatus[tab] = 'tracking-AUX4-Bad';
        showRag(this.ctx, tab, 'satelliteTrackingStatus', 'bad');
      }
    } else {
      showRag(this.ctx, tab, 'satelliteTrackingStatus', 'bad');
      this.trackingRAGStatus[tab] =
        aux4 === 2 ? 'tracking-AUX4-Bad' : 'tracking-less-than4-sats';
    }
  }

  private renderChart(tab: TabId, _data: LogData): void {
    const selected = constellationName(this.ui[tab].constellation);
    const points = this.trackingData[tab]?.[this.ui[tab].antenna]?.[selected] ?? [];
    const visibility =
      selected === 'LBAND'
        ? points.map((row) => ({
            prn: row.prn,
            azimuthal: 0,
            elevation: row.elevation ?? 0,
            health: 0,
          }))
        : this.visibilityData[tab]?.[selected] ?? [];
    const byPrn = new Map<number, VisibilityPoint>();
    for (const row of visibility) {
      if (numberValue(row.elevation) >= 0) byPrn.set(numberValue(row.prn), row);
    }
    for (const row of points) {
      if (!byPrn.has(row.prn)) {
        byPrn.set(row.prn, {
          prn: row.prn,
          azimuthal: 0,
          elevation: row.elevation ?? 0,
          health: 0,
        });
      }
    }
    const satellites = [...byPrn.values()].sort((a, b) => a.prn - b.prn);
    const supported = this.supportedSignals[tab]?.get(selected) ?? [];
    const channels = [...new Set(points.map((point) => point.channel))];
    const signals = supported.length ? supported : channels;
    const x = satellites.map((row) => `<b>${row.prn}</b>|${Math.round(row.elevation)}°`);
    const yData = signals.map((_signal, signalIndex) =>
      satellites.map((satellite) => {
        const point = points.filter((candidate) => candidate.prn === satellite.prn)[signalIndex];
        if (!point) return 0;
        if (this.ui[tab].graph === 'lockTime') {
          if (point.lockTime <= 60) return point.lockTime * 30;
          const scaled = LOCK_LESS_MINUTE + point.lockTime / 2;
          return scaled > LOCK_LESS_HOUR ? LOCK_LESS_HOUR + 50 : scaled;
        }
        return point.cno;
      }),
    );
    if (this.ui[tab].graph === 'carrierToNoise') {
      const bucket: Record<string, number[]> = (this.highestLowestData[tab] ??= {});
      bucket[selected] = [...(bucket[selected] ?? []), ...yData.flat()].slice(-30);
    }
    const traces = yData.map((values, index) => ({
      x,
      y: values,
      type: 'bar',
      name: `Data-${index}`,
      marker: { color: values.map((value) => this.plotColour(value, tab)) },
      customdata: satellites.map((satellite) => [
        satellite.prn,
        satellite.azimuthal,
        satellite.health,
        signals[index] ?? '',
      ]),
    }));
    const annotations = this.noSignalAnnotations(tab, x, yData);
    const highestLowest =
      this.ui[tab].graph === 'carrierToNoise' && this.ui[tab].highestLowest
        ? this.highestLowestAnnotations(tab, selected, x, yData)
        : [];
    const plot = this.ctx.document.querySelector(`#${tab} .satelliteTrackingChart`);
    if (plot) {
      plot.id = `satelliteTrackingPlot-${tab}`;
      const drew = renderPlotly(plot, traces, {
        barmode: 'group',
        showlegend: false,
        hovermode: 'closest',
        width: Math.max(1125, x.length * Math.max(1, yData.length) * 45),
        margin: { b: 30, l: 50, r: 20, t: 20, pad: 0 },
        xaxis: {
          showgrid: this.ui[tab].gridlines,
          fixedrange: true,
          showline: true,
          tickangle: 0,
        },
        yaxis:
          this.ui[tab].graph === 'lockTime'
            ? {
                showgrid: this.ui[tab].gridlines,
                fixedrange: true,
                range: [0, 3820],
                tickmode: 'array',
                tickvals: [0, LOCK_LESS_MINUTE, LOCK_LESS_HOUR],
                ticktext: [0, 60, LOCK_LESS_HOUR],
              }
            : { showgrid: this.ui[tab].gridlines, fixedrange: true, range: [0, 60] },
        annotations: [...annotations, ...highestLowest],
        shapes:
          this.ui[tab].graph === 'lockTime'
            ? [LOCK_LESS_MINUTE, LOCK_LESS_HOUR].map((value, index) => ({
                type: 'line',
                xref: 'paper',
                x0: 0,
                x1: 1,
                y0: value,
                y1: value,
                line: { color: index === 0 ? '#005d5d' : '#d9534f', width: 1 },
              }))
            : [CARRIER_POOR, CARRIER_WARNING, CARRIER_GOOD].map((value) => ({
                type: 'line',
                xref: 'paper',
                x0: 0,
                x1: 1,
                y0: value,
                y1: value,
                line: { color: '#828282', width: 1 },
              })),
      }, (graph) => {
        graph.on?.('plotly_hover', (event) => this.onTrackingHover(tab, event));
        graph.on?.('plotly_unhover', () => this.hideTrackingContextMenu(tab));
      });
      if (!drew) {
        const rows = points
          .slice()
          .sort((a, b) => a.prn - b.prn)
          .map(
            (row) =>
              `<span class="tracking-point" data-system="${escapeHTML(row.system)}" data-prn="${row.prn}" data-signal="${escapeHTML(row.channel)}">${escapeHTML(row.system)} ${row.prn} · ${formatNumber(this.ctx, row.cno, 1, tab)} dB-Hz · ${escapeHTML(row.channel)} · ${escapeHTML(this.lockTimeText(row.lockTime))}</span>`,
          )
          .join(' | ');
        plot.innerHTML = `<div class="tracking-summary">${rows || escapeHTML(__(this.ctx, 'NO_SIGNAL'))}</div>`;
      }
    }
    this.renderLegend(tab, selected, signals);
    this.updateGraphUi(tab);
    const highest = plot?.parentElement?.parentElement?.querySelector('#highest-lowest-toggle');
    if (highest) setStyle(highest, 'display', this.ui[tab].graph === 'carrierToNoise' ? 'block' : 'none');
  }

  private parseTrackstat(tab: TabId, data: LogData): Record<string, TrackPoint[]> {
    const result: Record<string, TrackPoint[]> = {};
    const available = new Set(
      (this.ctx.supportedConstellations(tab) ?? []).map((entry) => featureConstellationName(entry)),
    );
    for (const row of rowsOf(data)) {
      if (numberValue(row.PRN) === 0) continue;
      const status = numberValue(row.channelTrackingStatus) >>> 0;
      const features = this.ctx.features(tab);
      const system = features.isGIII
        ? features.model === 'IRIMS G-III'
          ? 'NAVIC'
          : constellationName(
              (giiitrackstatConstellationMap as Record<string, string>)[
                String((status & 0xe0) >>> 5)
              ] ?? 'OTHER',
            )
        : constellationName(row.satSystem ?? SYSTEM_BY_MASK[(status >>> 16) & 0x7] ?? 'OTHER');
      if (available.size && !available.has(system)) continue;
      const signalCode = features.isGIII ? status & 0x1f : (status >>> 21) & 0x1f;
      const signal =
        ((features.isGIII ? giiiConstellationWiseSingalEnums : ConstellationWiseSingalEnums) as Record<string, Record<string, string>>)[system]?.[
          String(signalCode)
        ] ?? String(signalCode);
      const point: TrackPoint = {
        prn: numberValue(row.PRN),
        cno: numberValue(row.carrierNoiseRatio),
        channel: signal === 'L2PCODELESS' ? 'L2PCL' : signal,
        system,
        rejectcode: row.reject,
        doppler: numberValue(row.doppler),
        psr: numberValue(row.pseudoRange),
        residual: numberValue(row.pseudoRangeResidual),
        lockTime: numberValue(row.lockTime),
        channelNumber: features.isGIII ? status & 0x1f : (status >>> 5) & 0x1f,
      };
      (result[system] ??= []).push(point);
    }
    return result;
  }

  private parseLbandTracking(tab: TabId, data: LogData): TrackPoint[] {
    const result: TrackPoint[] = [];
    for (const row of rowsOf(data)) {
      const cno = numberValue(row['C/No'] ?? row.CNo ?? row.cn0);
      const frequency = numberValue(row.frequency);
      if (frequency <= 0) continue;
      const rejectcode = cno > 39 ? 0 : cno > 36 && cno < 39 ? 1 : 99;
      result.push({
        prn: numberValue(row.id ?? row.PRN),
        cno,
        channel: 'L-band',
        system: 'LBAND',
        rejectcode,
        doppler: numberValue(row.doppler),
        psr: 0,
        residual: 0,
        lockTime: numberValue(row.lockTime),
        channelNumber: 0,
        elevation: this.lbandElevation(tab, data),
      });
    }
    return result;
  }

  private fromGiiiMeasurement(tab: TabId, data: LogData): LogData {
    const channels = Array.isArray(data.channelData)
      ? (data.channelData as LogData[])
      : rowsOf(data);
    const blocks = channels
      .filter((row) => numberValue(row.PRN) !== 0)
      .map((row) => ({
        PRN: numberValue(row.PRN),
        carrierNoiseRatio: Math.max(0, Math.min(60, numberValue(row.CNO ?? row.cno))),
        channelTrackingStatus: numberValue(row.trackType),
        doppler: numberValue(row.dopp),
        glonassFrequency: 0,
        lockTime: numberValue(row.lockTime),
        pseudoRange: numberValue(row.PSR),
        pseudoRangeResidual: numberValue(row.PSRstd),
        reject: row.rejectcode,
        channelNumber: numberValue(row.svChan),
      }));
    return {
      tab,
      antenna: 'PRIMARY',
      numberOfChannels: blocks.length,
      blocks,
      data: blocks,
    };
  }

  private fromGiiiSatpos(tab: TabId, data: LogData): LogData {
    const channels = Array.isArray(data.channelData)
      ? (data.channelData as LogData[])
      : rowsOf(data);
    const rawSystem = data.satelliteSystem ?? data.satSystem ?? 0;
    const system =
      (giiiSatvisConstellationMap as Record<string, string>)[String(rawSystem)] ??
      constellationName(rawSystem);
    const blocks = channels
      .filter((row) => numberValue(row.PRN ?? row.prn) !== 0)
      .map((row) => ({
        satelliteId: numberValue(row.prn ?? row.PRN),
        health: row.almHealth,
        elevation: numberValue(row.ephElevation),
        azimuth: numberValue(row.ephAzimuth),
        trueDoppler: numberValue(row.almDop),
      }));
    return {
      tab,
      satelliteSystem: system,
      satelliteSystemId: data.satelliteSystem ?? data.satSystem,
      numberOfSatellites: blocks.length,
      sequence: 0,
      blocks,
      data: blocks,
    };
  }

  private captureVisibility(tab: TabId, data: LogData): void {
    const system = constellationName(
      data.satelliteSystem ?? data.satSystem ?? data.system ?? 'OTHER',
    );
    (this.satvisData[tab] ??= {})[system] = data;
    const points = rowsOf(data)
      .filter((row) => numberValue(row.satelliteId ?? row.PRN) !== 0)
      .map((row) => ({
        prn: numberValue(row.satelliteId ?? row.PRN),
        azimuthal: numberValue(row.azimuth),
        elevation: numberValue(row.elevation),
        health: row.health,
      }));
    (this.visibilityData[tab] ??= {})[system] = points;
  }

  private captureSupportedSignals(tab: TabId, data: LogData): void {
    const map = (this.supportedSignals[tab] ??= new Map());
    const features = this.ctx.features(tab);
    if (features.isGIII) {
      const staticSignals = GIII_SIGNALS[features.model] ?? {};
      for (const [system, signals] of Object.entries(staticSignals)) {
        map.set(system, [...signals]);
      }
      this.displayingSupportedConstellations(Object.keys(staticSignals), tab);
      return;
    }
    const current = Array.isArray(data.currentChanConfigData)
      ? (data.currentChanConfigData as LogData[])
      : rowsOf(data);
    const names = features.generation === 'OEM6' ||
      features.generation === 'OEMSTAR'
      ? signalTypeDesc
      : updatedSignalTypeDesc;
    for (const row of current) {
      const value = row.signalType;
      const family = String(value ?? '').replace(/\s+/g, '').toUpperCase();
      const description =
        (names as Record<string, string>)[family] ?? family;
      const system =
        family.startsWith('GPS') ? 'GPS'
        : family.startsWith('QZSS') ? 'QZSS'
        : family.startsWith('SBAS') ? 'SBAS'
        : family.startsWith('GLO') ? 'GLONASS'
        : family.startsWith('GAL') ? 'GALILEO'
        : family.startsWith('BEIDOU') || family.startsWith('BDS') ? 'BEIDOU'
        : family.startsWith('NAVIC') ? 'NAVIC'
        : family.includes('LBAND') || family.includes('L-BAND') ? 'LBAND'
        : '';
      if (!system) continue;
      for (const rawSignal of description.split(',')) {
        const signal = rawSignal.replace(/\s+/g, '').toUpperCase();
        if (!signal) continue;
        const list = map.get(system) ?? [];
        if (!list.includes(signal)) list.push(signal);
        map.set(system, list);
      }
    }
  }

  private constellationName(value: unknown): string {
    return constellationName(value);
  }

  private plotColour(value: number, tab: TabId): string {
    if (this.ui[tab].graph === 'lockTime') return '#5d758d';
    if (value < CARRIER_POOR) return '#d9534f';
    if (value > CARRIER_WARNING && value < CARRIER_GOOD) return '#5cb85c';
    return '#f0ad4e';
  }

  private noSignalAnnotations(
    tab: TabId,
    x: string[],
    yData: number[][],
  ): LogData[] {
    const annotations: LogData[] = [];
    for (let signal = 0; signal < yData.length; signal += 1) {
      for (let index = 0; index < x.length; index += 1) {
        if (yData[signal][index] !== 0 || x[index]?.trim() === '') continue;
        annotations.push({
          x: x[index],
          y: this.ui[tab].graph === 'lockTime' ? 130 : 2,
          text: __(this.ctx, 'NO_SIGNAL'),
          showarrow: false,
          font: { color: '#d9534f', size: 11 },
        });
      }
    }
    return annotations;
  }

  private highestLowestAnnotations(
    tab: TabId,
    constellation: string,
    x: string[],
    yData: number[][],
  ): LogData[] {
    const values = this.highestLowestData[tab]?.[constellation] ?? [];
    if (!values.length) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const out: LogData[] = [];
    yData.forEach((series, signal) => {
      series.forEach((value, index) => {
        if (value === min) {
          out.push({
            x: x[index],
            y: value,
            text: 'L',
            showarrow: false,
            bgcolor: '#07afcb',
            font: { color: '#ffffff', size: 10 },
            yshift: 10,
          });
        }
        if (value === max) {
          out.push({
            x: x[index],
            y: value,
            text: 'H',
            showarrow: false,
            bgcolor: '#07afcb',
            font: { color: '#ffffff', size: 10 },
            yshift: 10,
          });
        }
      });
      void signal;
    });
    return out;
  }

  private renderLegend(tab: TabId, constellation: string, signals: string[]): void {
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    const legend = scope.querySelector('.trackingTileLegend');
    if (legend) legend.classList.toggle('hideTrackingLegend', this.legendHidden[tab] === true);
    for (const node of scope.querySelectorAll('.trackingPlotLegend')) setStyle(node, 'display', 'none');
    const selectedLegend = scope.querySelector(
      this.ui[tab].graph === 'lockTime' ? '.lockTimeLegend' : '.carrierNoiseLegend',
    );
    setStyle(selectedLegend, 'display', 'block');
    const host = scope.querySelector('.tracking-settings .legend-entries');
    if (host) {
      host.innerHTML = signals
        .map((signal) => `<span class="tracking-signal-legend" data-signal="${escapeHTML(signal)}">${escapeHTML(constellation)} ${escapeHTML(signal)}</span>`)
        .join('');
    }
  }

  private updateGraphUi(tab: TabId): void {
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    const label = scope.querySelector('.trackingTileYLabel');
    if (!label) return;
    if (this.ui[tab].graph === 'lockTime') {
      label.classList.add('lockTimeLabel');
      label.textContent = __(this.ctx, 'LOCK_TIME_SEC');
      label.setAttribute('data-lang-lock-time-sec', '');
      label.removeAttribute('data-lang-carrier-to-noise-ratio');
    } else {
      label.classList.remove('lockTimeLabel');
      label.textContent = __(this.ctx, 'CARRIER_TO_NOISE_RATIO');
      label.setAttribute('data-lang-carrier-to-noise-ratio', '');
      label.removeAttribute('data-lang-lock-time-sec');
    }
  }

  private onTrackingHover(tab: TabId, event: LogData): void {
    const point = (event.points as LogData[] | undefined)?.[0];
    if (!point) return;
    const custom = point.customdata as unknown[] | undefined;
    const prn = numberValue(custom?.[0] ?? point.x);
    const selected = constellationName(this.ui[tab].constellation);
    const points = (this.trackingData[tab]?.[this.ui[tab].antenna]?.[selected] ?? []).filter(
      (row) => row.prn === prn,
    );
    const scope = this.ctx.document.getElementById(tab);
    const menu = scope?.querySelector('.satellite-info-contextmenu') as HTMLElement | null;
    if (!scope || !menu) return;
    const prnNode = menu.querySelector('#contextSatellitePRNno');
    const channelNode = menu.querySelector('#contextSatelliteChannelNo');
    if (prnNode) prnNode.textContent = String(prn);
    if (channelNode) {
      channelNode.textContent = String(points[0]?.channelNumber ?? '--');
    }
    const entries = menu.querySelector('.satellite-data-entries');
    if (entries) {
      entries.innerHTML = points
        .map(
          (row) =>
            `<div class="satellite-info frequencyEntry">${escapeHTML(selected)} ${escapeHTML(row.channel)}</div><div class="satellite-info carriertoNoiseEntry">${formatNumber(this.ctx, row.cno, 1, tab)} dB-Hz</div><div class="satellite-info lockTimeEntry">${escapeHTML(this.lockTimeText(row.lockTime))}</div>`,
        )
        .join('');
    }
    const pointer = event.event as LogData | undefined;
    const area = scope.querySelector('.trackingPlotArea') as HTMLElement | null;
    const rect = area?.getBoundingClientRect();
    const x = Math.max(0, numberValue(pointer?.clientX) - (rect?.left ?? 0) + 12);
    const y = Math.max(0, numberValue(pointer?.clientY) - (rect?.top ?? 0) + 12);
    setStyle(menu, 'left', `${x}px`);
    setStyle(menu, 'top', `${y}px`);
    setStyle(menu, 'display', 'block');
    this.hoverMask[tab] = true;
  }

  private hideTrackingContextMenu(tab: TabId): void {
    this.hoverMask[tab] = false;
    setStyle(
      this.ctx.document.querySelector(`#${tab} .satellite-info-contextmenu`),
      'display',
      'none',
    );
  }

  private lockTimeText(lockTime: number): string {
    const total = Math.max(0, Math.trunc(lockTime));
    const days = Math.trunc(total / 86400);
    const hours = days * 24 + Math.trunc((total / 3600) % 24);
    const minutes = Math.trunc((total / 60) % 60);
    const seconds = Math.trunc(total % 60);
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  private lbandElevation(_tab: TabId, _data: LogData): number {
    // The shipped implementation projects the beam from BESTPOS.  Keeping the
    // point visible while that geometry needs a live position is preferable to
    // silently dropping the LBAND signal.
    return 0;
  }

  private refreshSatelliteDataList(tab: TabId): void {
    if (!this.satelliteDialogOpen[tab]) return;
    const selected = constellationName(this.ui[tab].constellation);
    const visibility = this.visibilityData[tab]?.[selected] ?? [];
    const points = this.trackingData[tab]?.[this.ui[tab].antenna]?.[selected] ?? [];
    const elevation = new Map(visibility.map((row) => [row.prn, row.elevation]));
    const rows = points
      .slice()
      .sort((a, b) => {
        if (this.ui[tab].sortby === 'elevation-lessthan-90') {
          return (elevation.get(a.prn) ?? 0) - (elevation.get(b.prn) ?? 0);
        }
        if (this.ui[tab].sortby === 'elevation-greaterthan-90') {
          return (elevation.get(b.prn) ?? 0) - (elevation.get(a.prn) ?? 0);
        }
        return a.prn - b.prn;
      })
      .filter((row) => (elevation.get(row.prn) ?? row.elevation ?? 0) >= 0);
    const host = this.ctx.document.querySelector(`#${tab} .satellite-data-entries`);
    if (!host) return;
    host.innerHTML = rows
      .map(
        (row) =>
          `<tr class="satellite-entries"><td class="satellite-info prnEntry">${row.prn}</td><td class="satellite-info elevationEntry">${formatNumber(this.ctx, elevation.get(row.prn) ?? row.elevation ?? 0, 1, tab)}°</td><td class="satellite-info channelEntry">${escapeHTML(String(row.channelNumber))}</td><td class="satellite-info frequencyEntry">${escapeHTML(selected)} ${escapeHTML(row.channel)}</td><td class="satellite-info carriertoNoiseEntry"><span>${formatNumber(this.ctx, row.cno, 1, tab)}</span><span> dB-Hz</span></td><td class="satellite-info lockTimeEntry">${escapeHTML(this.lockTimeText(row.lockTime))}</td></tr>`,
      )
      .join('');
  }

  private wireUi(tab: TabId, scope: Element): void {
    if (this.wiredTabs.has(tab)) return;
    this.wiredTabs.add(tab);
    const choose = (
      selector: string,
      property: 'antenna' | 'constellation' | 'graph',
      valueOf: (element: Element) => string,
      persistenceKey: string,
    ): void => {
      for (const element of scope.querySelectorAll(selector)) {
        element.addEventListener('click', () => {
          for (const other of scope.querySelectorAll(selector)) other.classList.remove('active');
          element.classList.add('active');
          (this.ui[tab][property] as string) = valueOf(element);
          this.persistTrackingValue(tab, persistenceKey, valueOf(element));
          if (property === 'graph') this.updateGraphUi(tab);
          this.renderChart(tab, this.data[tab]?.[String(MSG_ID.TRACKSTAT)] ?? {});
        });
      }
    };
    choose('#antennaFields-items li', 'antenna', (element) => (element.id === 'dual-antenna' ? 'SECONDARY' : 'PRIMARY'), 'selectedAntenna');
    choose('#constellation-items li', 'constellation', (element) => element.id, 'selectedSatellite');
    choose('#graphsFields-items li', 'graph', (element) => element.id, 'selectedGraph');
    for (const input of scope.querySelectorAll('.sortSection input[type=radio]')) {
      input.addEventListener('change', () => {
        if ((input as HTMLInputElement).checked) {
          this.ui[tab].sortby = input.id.replace('-' + tab, '');
          this.persistTrackingValue(tab, 'selectedSortOption', this.ui[tab].sortby);
          this.renderChart(tab, this.data[tab]?.[String(MSG_ID.TRACKSTAT)] ?? {});
        }
      });
    }
    for (const [selector, property, key] of [
      ['#elevationMask', 'elevationMask', 'selectedEleMaskOption'],
      ['#highLowValues', 'highestLowest', 'selectedHighLowOption'],
      ['#gridlines', 'gridlines', 'selectedGridlinesOption'],
    ] as const) {
      const input = scope.querySelector(selector) as HTMLInputElement | null;
      if (!input) continue;
      input.checked = Boolean(this.ui[tab][property]);
      input.addEventListener('change', () => {
        (this.ui[tab][property] as boolean) = input.checked;
        this.persistTrackingValue(tab, key, input.checked);
        this.renderChart(tab, this.data[tab]?.[String(MSG_ID.TRACKSTAT)] ?? {});
      });
    }
    const legendButton = scope.querySelector('.trackingLegendBtn');
    legendButton?.addEventListener('click', (event) => {
      event.preventDefault();
      this.legendHidden[tab] = !this.legendHidden[tab];
      scope.querySelector('.trackingTileLegend')?.classList.toggle(
        'hideTrackingLegend',
        this.legendHidden[tab],
      );
    });
    const allInfo = scope.querySelector('.view-all-satellite-info');
    allInfo?.addEventListener('click', (event) => {
      event.preventDefault();
      this.openSatelliteDialog(tab);
    });
  }

  private openSatelliteDialog(tab: TabId): void {
    this.satelliteDialogOpen[tab] = true;
    const selected = constellationName(this.ui[tab].constellation);
    const elevationMask = this.elevationMaskFor(tab);
    const content = `<div class="satellite-info-popupcontent">
      <div class="selected-satellite-info">
        <span data-lang-antenna>${escapeHTML(__(this.ctx, 'ANTENNA'))}</span>
        <span class="satellite-data">${escapeHTML(this.ui[tab].antenna)}</span>
        <span data-lang-constellation>${escapeHTML(__(this.ctx, 'CONSTELLATION'))}</span>
        <span class="satellite-data">${escapeHTML(selected)}</span>
        <span data-lang-elevation-mask>${escapeHTML(__(this.ctx, 'ELEVATION_MASK'))}</span>
        <span class="satellite-data elevation-mask-data">${formatNumber(this.ctx, elevationMask, 1, tab)}°</span>
      </div>
      <div class="satellite-display-data">
        <div class="satellite-data-heading">
          <div data-lang-prn class="satellite-info prnEntry">${escapeHTML(__(this.ctx, 'PRN'))}</div>
          <div data-lang-elevation class="satellite-info elevationEntry">${escapeHTML(__(this.ctx, 'ELEVATION'))}</div>
          <div data-lang-channel class="satellite-info channelEntry">${escapeHTML(__(this.ctx, 'CHANNEL'))}</div>
          <div data-lang-frequency class="satellite-info frequencyEntry">${escapeHTML(__(this.ctx, 'FREQUENCY'))}</div>
          <div data-lang-carrier-to-noise class="satellite-info carriertoNoiseEntry">${escapeHTML(__(this.ctx, 'CARRIER_TO_NOISE'))}</div>
          <div data-lang-lock-time class="satellite-info lockTimeEntry">${escapeHTML(__(this.ctx, 'LOCK_TIME'))}</div>
        </div>
        <div class="satellite-data-entries"><table class="satellite-table-entries"></table></div>
      </div>
    </div><hr><div class="oem-rx view-sats-footer">
      <div class="copy-icon"><div class="outer-rect"></div><div class="inner-rect"></div></div>
      <button type="button" class="btn btn-default whiteBtn satellite-info-copy-to-clipboard" data-lang-tracking-copy-to-clipboard>${escapeHTML(__(this.ctx, 'TRACKING_COPY_TO_CLIPBOARD'))}</button>
      <button type="button" class="btn btn-default whiteBtn darkBtn" id="view-sats-done-btn" data-lang-done>${escapeHTML(__(this.ctx, 'DONE'))}</button>
    </div>`;
    this.ctx.openDialog?.({
      tab,
      title: __(this.ctx, 'ALL_SATELLITE_INFO_TITLE'),
      titleMarker: 'data-lang-all-sat-info',
      content,
      className: 'all-satellite-info-popup',
    });
    const dialog = this.ctx.document.getElementById('popupModal');
    if (dialog) {
      const entries = dialog.querySelector('.satellite-data-entries');
      if (entries) entries.innerHTML = this.satelliteRowsHtml(tab);
      dialog.querySelector('.satellite-info-copy-to-clipboard')?.addEventListener('click', () => {
        this.copySatelliteData(tab);
      });
      dialog.querySelector('#view-sats-done-btn')?.addEventListener('click', () => {
        this.ctx.closeDialog?.(tab);
        this.dataDialogClosed(tab);
      });
    }
    this.refreshSatelliteDataList(tab);
  }

  private satelliteRowsHtml(tab: TabId): string {
    const selected = constellationName(this.ui[tab].constellation);
    const visibility = this.visibilityData[tab]?.[selected] ?? [];
    const points = this.trackingData[tab]?.[this.ui[tab].antenna]?.[selected] ?? [];
    const elevation = new Map(visibility.map((row) => [row.prn, row.elevation]));
    return points
      .slice()
      .sort((a, b) => {
        if (this.ui[tab].sortby === 'elevation-greaterthan-90') {
          return (elevation.get(b.prn) ?? 0) - (elevation.get(a.prn) ?? 0);
        }
        if (this.ui[tab].sortby === 'elevation-lessthan-90') {
          return (elevation.get(a.prn) ?? 0) - (elevation.get(b.prn) ?? 0);
        }
        return a.prn - b.prn;
      })
      .map(
        (row) =>
          `<tr class="satellite-entries"><td class="satellite-info prnEntry">${row.prn}</td><td class="satellite-info elevationEntry">${formatNumber(this.ctx, elevation.get(row.prn) ?? 0, 1, tab)}°</td><td class="satellite-info channelEntry">${escapeHTML(String(row.channelNumber))}</td><td class="satellite-info frequencyEntry">${escapeHTML(selected)} ${escapeHTML(row.channel)}</td><td class="satellite-info carriertoNoiseEntry"><span>${Math.round(row.cno)}</span><span> dB-Hz</span></td><td class="satellite-info lockTimeEntry">${escapeHTML(this.lockTimeText(row.lockTime))}</td></tr>`,
      )
      .join('');
  }

  private copySatelliteData(tab: TabId): void {
    const dialog = this.ctx.document.getElementById('popupModal');
    const lines: string[] = [];
    if (dialog) {
      const selected = dialog.querySelector('.selected-satellite-info');
      if (selected) {
        lines.push(
          [...selected.querySelectorAll('span')].map((span) => span.textContent).join(','),
          '',
        );
      }
      const heading = dialog.querySelector('.satellite-data-heading');
      if (heading) {
        lines.push(
          [...heading.querySelectorAll('div')].map((cell) => cell.textContent).join(','),
        );
      }
      for (const row of dialog.querySelectorAll('.satellite-entries')) {
        lines.push([...row.querySelectorAll('td')].map((cell) => cell.textContent).join(','));
      }
    }
    this.ctx.copyText?.(lines.join('\n'));
  }

  private elevationMaskFor(tab: TabId): number {
    const selected = constellationName(this.ui[tab].constellation);
    const ids: Record<string, number> = {
      GPS: MSG_ID.ECUTOFF,
      GLONASS: 735,
      GALILEO: MSG_ID.GALECUTOFF,
      BEIDOU: MSG_ID.BDSECUTOFF,
      QZSS: MSG_ID.QZSSECUTOFF,
      NAVIC: MSG_ID.NAVICECUTOFF,
    };
    return this.cutoffData[tab]?.[String(ids[selected])] ?? 0;
  }

  private persistTrackingValue(tab: TabId, key: string, value: unknown): void {
    const path = [
      'app',
      'deviceManagement',
      'devices',
      this.ctx.deviceTileId(tab),
      'trackingTiles',
      key,
    ];
    this.ctx.setUserData(path, value);
  }
}
