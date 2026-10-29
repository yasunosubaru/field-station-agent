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
  updateFields,
  applyLanguageMarkers,
  __,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';

const SYSTEMS = ['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'OTHER', 'SBAS'] as const;
const SHORT = ['GPS', 'GLO', 'GAL', 'BDS', 'QZSS', 'NAVIC', 'other', 'SBAS'];
const HTML_IDS: Record<string, string> = {
  GPS: '#gpscount',
  GLONASS: '#glonasscount',
  GALILEO: '#galileocount',
  BEIDOU: '#beidoucount',
  QZSS: '#qzsscount',
  NAVIC: '#naviccount',
  OTHER: '#lbandcount',
  SBAS: '#sbascount',
};

export class SatelliteView {
  readonly data: Record<TabId, Record<number, LogData>> = {};
  readonly supportedConstellations: Record<TabId, string[]> = {};
  readonly satCounts: Record<TabId, Record<string, number>> = {};
  readonly rag: Record<TabId, string | undefined> = {};
  readonly satelliteMap: Record<TabId, Record<string, LogData>> = {};
  private readonly ctx: StatusContext;
  private goodCountSource?: (tab: TabId) => number;
  private readonly wiredSkyTabs = new Set<TabId>();

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  updateData(msgID: number, input: unknown): number {
    const source = normalizeLog(input);
    const tab = tabOf(source);
    if (!tab) return 0;
    (this.data[tab] ??= {})[msgID] = source;
    let written = 0;
    if (msgID === MSG_ID.PSRDOP) written += this.updateDOP(source, msgID);
    if (msgID === MSG_ID.CHANCONFIGLIST) this.captureConstellations(tab, source);
    if (msgID === MSG_ID.SATVIS2 || msgID === MSG_ID.TRACKSTAT) {
      written += this.updateCounts(tab, source);
    }
    if (msgID === MSG_ID.SATVIS2 || msgID === MSG_ID.TRACKSTAT || msgID === MSG_ID.BESTSATS) {
      this.updateSatelliteMap(tab, msgID, source);
      this.renderSatelliteMap(tab);
    }
    if (Array.isArray(source.supportedConstellations)) {
      written += this.displayingSupportedConstellations(source.supportedConstellations.map(String), tab);
    }
    return written;
  }

  updateSatViewStatus(totalGoodSats: number, tab: TabId): void {
    const state = numberValue(totalGoodSats) >= 4 ? 'good' : 'bad';
    this.rag[tab] = state;
    showRag(this.ctx, tab, 'satViewStatus', state);
  }

  updateExternalSatellites(
    rows: LogData[],
    tab: TabId,
    goodCount?: number,
  ): number {
    const map: Record<string, LogData> = {};
    for (const row of rows) {
      const system = this.systemOf(row);
      const prn = numberValue(row.prn ?? row.PRN ?? row.satelliteId);
      if (!prn) continue;
      map[`${system}-${prn}`] = {
        ...row,
        prn,
        system,
        azimuthal: numberValue(row.azimuthal ?? row.azimuth),
        elevation: numberValue(row.elevation),
        rejectCodes: row.rejectCodes ?? [1],
      };
    }
    this.satelliteMap[tab] = map;
    this.wiredSkyTabs.delete(tab);
    this.renderSatelliteMap(tab);
    if (goodCount !== undefined) this.updateSatViewStatus(goodCount, tab);
    return Object.keys(map).length;
  }

  displayingSupportedConstellations(supported: string[], tab: TabId): number {
    const features = this.ctx.features(tab);
    const incoming = !features.isGIII && !features.isLongHorn
      ? this.ctx.supportedConstellations(tab) ?? this.supportedConstellations[tab] ?? []
      : supported.filter((entry) => String(entry) !== '2' && String(entry) !== '7');
    const normalised = incoming.map((entry) => {
      const upper = String(entry).toUpperCase();
      if (upper === '0') return 'GPS';
      if (upper === '1') return 'GLONASS';
      if (upper === '2') return 'SBAS';
      if (upper === '3') return 'GALILEO';
      if (upper === '4') return 'BEIDOU';
      if (upper === '5') return 'QZSS';
      if (upper === '6') return 'NAVIC';
      if (upper === '7') return 'OTHER';
      if (upper === 'GLO') return 'GLONASS';
      if (upper === 'GAL') return 'GALILEO';
      if (upper === 'BDS') return 'BEIDOU';
      return upper;
    });
    this.supportedConstellations[tab] = [...new Set(normalised)];
    const scope = this.ctx.document.getElementById(tab);
    if (scope) {
      for (let index = 0; index < SYSTEMS.length; index += 1) {
        const selector = SYSTEMS[index] === 'GLONASS'
          ? '.glonass'
          : SYSTEMS[index] === 'BEIDOU'
            ? '.beidou'
            : '.' + SYSTEMS[index].toLowerCase();
        for (const shape of scope.querySelectorAll(`.shapes .sat-shape${selector}, .shapes ${selector}`)) {
          setStyle(shape, 'display', this.supportedConstellations[tab].includes(SYSTEMS[index]) ? 'block' : 'none');
        }
      }
      const active = scope.querySelector('#active-satellites');
      if (active) {
        active.textContent = SYSTEMS.filter((system) => this.supportedConstellations[tab].includes(system))
          .map((system) => SHORT[SYSTEMS.indexOf(system)])
          .join(' | ');
      }
    }
    return 1;
  }

  updateDOP(input: unknown, msgID = MSG_ID.PSRDOP): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const hdop = numberValue(data.hdop, 9999);
    const pdop = numberValue(data.pdop, 9999);
    const vdop = this.ctx.view.verticalDop(pdop, hdop);
    setStyle(this.ctx.document.querySelector(`#${tab} #SatelliteViewPanel .satelliteview-legend`), 'margin-bottom', '-1em');
    setStyle(this.ctx.document.querySelector(`#${tab} #SatelliteViewPanel .psrdop-layout`), 'display', 'block');
    return updateFields(this.ctx, tab, 'satelliteView', 'hdop,pdop,vdop', {
      tab,
      hdop: formatNumber(this.ctx, hdop, 3, tab),
      pdop: formatNumber(this.ctx, pdop, 3, tab),
      vdop: formatNumber(this.ctx, vdop, 3, tab),
      msgID,
    });
  }

  ragColor(tab: TabId): string | undefined {
    return this.rag[tab];
  }

  setGoodCountSource(source: (tab: TabId) => number): void {
    this.goodCountSource = source;
  }

  refreshGoodCount(tab: TabId): void {
    if (!this.goodCountSource) return;
    this.updateSatViewStatus(this.goodCountSource(tab), tab);
  }

  resetData(tab: TabId): void {
    delete this.data[tab];
    delete this.supportedConstellations[tab];
    delete this.satCounts[tab];
    delete this.rag[tab];
    delete this.satelliteMap[tab];
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['satillite-view', 'SATELLITE_VIEW'], ['tracked', 'TRACKED'], ['east-label', 'EAST_LABEL'],
      ['west-label', 'WEST_LABEL'], ['north-label', 'NORTH_LABEL'], ['south-label', 'SOUTH_LABEL'],
      ['angle90', 'ANGLE_90'], ['tracking-db', 'TRACKING_DB'], ['angle30', 'ANGLE_30'],
      ['angle60', 'ANGLE_60'], ['satviewstatusred', 'SATVIEWSTATUSRED'],
      ['why-this-red', 'WHY_IS_THIS_RED'], ['need-help', 'NEED_HELP'],
      ['giiitrackingred', 'GIIITRACKINGRED'], ['error', 'ERROR'], ['good', 'GOOD'],
      ['warning', 'WARNING'], ['in-use', 'IN_USE'], ['not-used', 'NOT_USED'],
      ['missing', 'MISSING'],
    ];
    applyLanguageMarkers(this.ctx, [
      ...keys.map(([marker, key]) => ({ selector: `[data-lang-${marker}]`, value: __(this.ctx, key) })),
      {
        selector: '[data-lang-title-satviewstatusred]',
        value: `${__(this.ctx, 'SATELLITE_VIEW')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
    ]);
  }

  private updateSatelliteMap(tab: TabId, msgID: number, data: LogData): void {
    const map = (this.satelliteMap[tab] ??= {});
    for (const row of rowsOf(data)) {
      const system = this.systemOf(row);
      const prn = numberValue(row.satelliteId ?? row.PRN ?? row.prn);
      if (!prn) continue;
      const key = `${system}-${prn}`;
      const entry = (map[key] ??= { prn, system, azimuthal: 0, elevation: -1 });
      if (msgID === MSG_ID.SATVIS2) {
        entry.azimuthal = numberValue(row.azimuth);
        entry.elevation = numberValue(row.elevation);
        entry.health = row.health ?? 0;
      } else if (msgID === MSG_ID.TRACKSTAT || msgID === MSG_ID.BESTSATS) {
        entry.cno = numberValue(row.carrierNoiseRatio ?? row.CNo);
        entry.rejectCodes = [
          msgID === MSG_ID.BESTSATS
            ? numberValue(row.status) === 0 || numberValue(row.status) === 26
              ? '0'
              : '1'
            : row.reject,
        ];
      }
    }
  }

  private renderSatelliteMap(tab: TabId): void {
    const circle = this.ctx.document.querySelector(`#${tab} .satelliteview-main-circle`);
    if (!circle) return;
    for (const old of circle.querySelectorAll('.prnsadded')) old.remove();
    const classes: Record<string, [string, string]> = {
      GPS: ['circular-const', 'circle-img'],
      GLONASS: ['square-const', 'square-img'],
      GALILEO: ['triangle-const', 'triangle-img'],
      BEIDOU: ['pentagon-const', 'pentagon-img'],
      QZSS: ['qzss-const', 'qzss-img'],
      NAVIC: ['navic-const', 'navic-img'],
      OTHER: ['lband-const', 'lband-img'],
      SBAS: ['sbas-const', 'sbas-img'],
    };
    const html: string[] = [];
    const supported = new Set(this.supportedConstellations[tab] ?? []);
    for (const satellite of Object.values(this.satelliteMap[tab] ?? {})) {
      if (supported.size && !supported.has(String(satellite.system))) continue;
      const elevation = numberValue(satellite.elevation);
      if (elevation <= 0) continue;
      const azimuth = numberValue(satellite.azimuthal);
      const point = this.skyCoordinates(azimuth, elevation);
      const system = String(satellite.system);
      const shape = classes[system] ?? classes.GPS;
      const reject = Array.isArray(satellite.rejectCodes)
        ? Number(satellite.rejectCodes[0])
        : numberValue(satellite.health);
      const colour =
        reject === 0 || [13, 18, 19, 20, 21, 22, 23, 26].includes(reject)
          ? 'satellite-good'
          : 'satellite-bad';
      html.push(
        `<div class="prnsadded ${colour}" sys="${escapeHTML(system)}" prn="${satellite.prn}" style="position:absolute;left:${point.x}%;top:${point.y}%;" id="${escapeHTML(system)}${satellite.prn}" data-azimuth="${satellite.azimuthal}" data-elevation="${satellite.elevation}" data-cno="${satellite.cno ?? ''}"><div class="${shape[0]}"><div class="${shape[1]}"></div><div class="border-line"></div><span class="customPRNnumber">${satellite.prn}</span></div></div>`,
      );
    }
    circle.insertAdjacentHTML ? circle.insertAdjacentHTML('beforeend', html.join('')) : (circle.innerHTML += html.join(''));
    if (!this.wiredSkyTabs.has(tab)) {
      this.wiredSkyTabs.add(tab);
      circle.addEventListener('click', (event) => {
        const target = event.target as unknown as {
          closest?: (selector: string) => Element | null;
        };
        const marker = target.closest?.('.prnsadded') as HTMLElement | null;
        const tooltip = circle.querySelector('#tooltip-sat') as HTMLElement | null;
        if (!marker || !tooltip) {
          setStyle(tooltip, 'display', 'none');
          return;
        }
        const system = marker.getAttribute('sys') ?? '';
        const prn = marker.getAttribute('prn') ?? '';
        const az = marker.getAttribute('data-azimuth') ?? '';
        const elevation = marker.getAttribute('data-elevation') ?? '';
        const cno = marker.getAttribute('data-cno') ?? '';
        const azNode = tooltip.querySelector('.tooltip-Az');
        const eleNode = tooltip.querySelector('.tooltip-ele');
        const details = tooltip.querySelector('.tracking-details');
        if (azNode) azNode.textContent = `Azimuth: ${az}°`;
        if (eleNode) eleNode.textContent = `Elevation: ${elevation}°`;
        if (details) details.textContent = `${system} PRN ${prn}: ${cno || '--'} dB-Hz`;
        setStyle(tooltip, 'left', marker.style.left);
        setStyle(tooltip, 'top', marker.style.top);
        setStyle(tooltip, 'display', 'block');
      });
    }
  }

  private skyCoordinates(azimuth: number, elevation: number): { x: number; y: number } {
    const center = 50;
    const radius = ((90 - Math.max(0, elevation)) / 90) * center;
    let x = center;
    let y = center;
    if (azimuth < 90) {
      const angle = (90 - azimuth) * Math.PI / 180;
      x += radius * Math.cos(angle);
      y -= radius * Math.sin(angle);
    } else if (azimuth <= 180) {
      const angle = (azimuth - 90) * Math.PI / 180;
      x += radius * Math.cos(angle);
      y += radius * Math.sin(angle);
    } else if (azimuth <= 270) {
      const angle = (270 - azimuth) * Math.PI / 180;
      x -= radius * Math.cos(angle);
      y += radius * Math.sin(angle);
    } else {
      const angle = (azimuth - 270) * Math.PI / 180;
      x -= radius * Math.cos(angle);
      y -= radius * Math.sin(angle);
    }
    return { x, y };
  }

  private updateCounts(tab: TabId, data: LogData): number {
    const rows = rowsOf(data);
    const counts: Record<string, { good: number; moderate: number; bad: number }> = {};
    for (const system of SYSTEMS) counts[system] = { good: 0, moderate: 0, bad: 0 };
    for (const row of rows) {
      const system = this.systemOf(row);
      const health = numberValue(row.health, 0);
      const bucket = health === 0 ? 'good' : health === 1 ? 'moderate' : 'bad';
      counts[system][bucket] += 1;
    }
    const totals = Object.fromEntries(
      Object.entries(counts).map(([system, values]) => [system, values.good + values.moderate + values.bad]),
    );
    this.satCounts[tab] = totals;
    let written = 0;
    for (const system of SYSTEMS) {
      const host = this.ctx.document.querySelector(`#${tab} ${HTML_IDS[system]}`);
      if (!host) continue;
      for (const bucket of ['good', 'moderate', 'bad'] as const) {
        const target = host.querySelector(`.${bucket}-health`);
        if (target) target.textContent = String(counts[system][bucket]);
      }
      written += 1;
    }
    const good = Object.values(counts).reduce((sum, value) => sum + value.good, 0);
    if (!this.goodCountSource) this.updateSatViewStatus(good || rows.length, tab);
    return written;
  }

  private captureConstellations(tab: TabId, data: LogData): void {
    const rows = rowsOf(data);
    const signals = rows.map((row) => numberValue(row.signalType)).filter((value) => value > 0);
    const names = new Set<string>();
    for (const signal of signals) {
      if (signal === 4 || signal === 6) names.add('SBAS');
      else if (signal >= 20 && signal <= 31) names.add('GLONASS');
      else if (signal >= 32 && signal <= 39) names.add('GALILEO');
      else if (signal >= 40 && signal <= 49) names.add('BEIDOU');
      else if (signal >= 50 && signal <= 59) names.add('QZSS');
      else if (signal >= 60 && signal <= 63) names.add('NAVIC');
      else if (signal === 9) names.add('OTHER');
      else names.add('GPS');
    }
    this.supportedConstellations[tab] = [...names];
  }

  private systemOf(row: LogData): string {
    const explicit = String(row.satelliteSystem ?? row.system ?? '').toUpperCase();
    if (SYSTEMS.includes(explicit as (typeof SYSTEMS)[number])) return explicit;
    const id = numberValue(row.satelliteId ?? row.PRN);
    const status = numberValue(row.channelTrackingStatus);
    if (status) {
      const fromStatus = (status >>> 16) & 0x7;
      return ['GPS', 'GLONASS', 'SBAS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'OTHER'][fromStatus] ?? 'OTHER';
    }
    if (id >= 1 && id <= 32) return 'GPS';
    if (id >= 38 && id <= 61) return 'GLONASS';
    if (id >= 120 && id <= 158) return 'SBAS';
    return 'OTHER';
  }
}
