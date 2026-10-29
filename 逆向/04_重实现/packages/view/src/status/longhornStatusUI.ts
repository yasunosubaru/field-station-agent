import {
  MSG_ID,
  angleText,
  displayNumber,
  formatNumber,
  heightText,
  normalizeLog,
  numberValue,
  queryIn,
  renderPlotly,
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

export class LonghornStatusUI {
  readonly sdXAxisData: Record<TabId, number[]> = {};
  readonly sdYAxisData: Record<TabId, number[]> = {};
  readonly hdXAxisData: Record<TabId, number[]> = {};
  readonly hdYAxisData: Record<TabId, number[]> = {};
  readonly idleTimeTimer: Record<TabId, number | undefined> = {};
  readonly deviceInfoRAG: Record<TabId, string | undefined> = {};
  readonly positionStatusRAG: Record<TabId, string | undefined> = {};
  readonly RAGTexts: Record<TabId, { red: string[] }> = {};
  readonly currentStateDeviceInfo: Record<TabId, string | undefined> = {};
  readonly ggaLogAvailable: Record<TabId, boolean> = {};
  readonly gsvPRNsList: Record<TabId, Record<string, { prnlist: unknown[] }>> = {};
  readonly completeSatsObj: Record<TabId, Record<string, LogData[]>> = {};
  readonly ports: Record<TabId, Set<string>> = {};
  readonly gsvRepo: Record<TabId, Record<string, LogData[]>> = {};
  readonly gsvSeq: Record<TabId, number> = {};
  readonly gsaData: Record<TabId, Record<string, LogData>> = {};
  readonly pvaDataAvailable: Record<TabId, boolean> = {};
  readonly configFiles: Record<TabId, string> = {};
  readonly updateResponse: Record<TabId, LogData> = {};
  readonly deviceInfoRAGData: Record<TabId, LogData> = {};
  readonly plotInterval: Record<TabId, number | undefined> = {};
  readonly sdTimestampData: Record<TabId, number[]> = {};
  readonly hdTimestampData: Record<TabId, number[]> = {};
  readonly sdScale: Record<TabId, number> = {};
  readonly hdScale: Record<TabId, number> = {};
  readonly sdUnit: Record<TabId, 'centimeters' | 'meters'> = {};
  readonly hdUnit: Record<TabId, 'centimeters' | 'meters'> = {};
  private readonly ctx: StatusContext;
  private readonly wiredTabs = new Set<TabId>();
  private satelliteSnapshotListener?: (tab: TabId, rows: LogData[], goodCount: number) => void;

  constructor(ctx: StatusContext) {
    this.ctx = ctx;
  }

  uiUpdate(input: unknown, tab: TabId = tabOf(input)): number {
    if (!tab) return 0;
    const raw = normalizeLog(input);
    const messageId = numberValue(raw.MessageID ?? raw.messageId ?? raw.msgID, -1);
    const rows = Array.isArray(raw.Data)
      ? (raw.Data as LogData[])
      : Array.isArray(raw.data)
        ? (raw.data as LogData[])
        : [raw];
    const data = rows[0] ?? {};

    if (messageId === 218) return this.updateGga(tab, data);
    if (messageId === 222) return this.updateGst(tab, data);
    if (messageId === 226) return this.updateSpeed(tab, data);
    if (messageId === 227) return this.updateTime(tab, data);
    if (messageId === 221) return this.updateGsa(tab, raw, data);
    if (messageId === 223) return this.updateGsv(tab, raw);
    if (messageId === 2379) return this.updatePva(tab, data);
    if (messageId === 2353) return this.updateNmeaText(tab, data);
    if (messageId === 2388) {
      this.configFiles[tab] = String(data.ConfigFile ?? '');
      this.ctx.publishEvent?.(tab, 'config', { tab, MessageID: messageId, ...data });
      return 1;
    }
    if (messageId === 2390 || messageId === 2395) {
      this.updateResponse[tab] = { ...data };
      if (messageId === 2390) {
        this.ctx.publishEvent?.(tab, 'updateResponse', {
          tab,
          MessageID: messageId,
          ...data,
        });
      } else if (['COMPLETE', 'STOP', 'ME_FAILED'].includes(String(data.Status ?? ''))) {
        this.ctx.publishEvent?.(tab, 'updateResponse', {
          tab,
          MessageID: messageId,
          ACK: this.updateResponse[tab].ACK,
          ...data,
        });
      }
      return 1;
    }

    if (messageId === MSG_ID.BESTPOS) {
      return updateFields(this.ctx, tab, 'positionStatus', 'latitude,longitude,height', {
        tab,
        latitude: angleText(this.ctx, data.latitude, tab, 7),
        longitude: angleText(this.ctx, data.longitude, tab, 7),
        height: heightText(this.ctx, data, tab),
      });
    }
    return 0;
  }

  createPlot(tab: TabId): number {
    this.sdXAxisData[tab] ??= [0];
    this.sdYAxisData[tab] ??= [0];
    this.hdXAxisData[tab] ??= [0];
    this.hdYAxisData[tab] ??= [0];
    this.sdTimestampData[tab] ??= [];
    this.hdTimestampData[tab] ??= [];
    this.sdScale[tab] ??= 5;
    this.hdScale[tab] ??= 5;
    this.sdUnit[tab] ??= 'centimeters';
    this.hdUnit[tab] ??= 'centimeters';
    this.wirePlotControls(tab);
    return this.renderPlots(tab);
  }

  addPort(portName: string, tab: TabId): number {
    this.ports[tab] ??= new Set();
    this.ports[tab].add(portName);
    const list = this.ctx.document.querySelector(`#${tab} #port-dynamic-list`);
    if (!list) return 0;
    if (!list.querySelector(`#${cssId(portName)}-status-li`)) {
      list.innerHTML += `<div class="row com-ports" id="${cssId(portName)}-status-li"><div class="title col-md-6 col-sm-6 col-xs-6"><span>${portName}</span></div><div class="col-md-3 col-sm-3 col-xs-3"><div class="ports-status port-input-status green-circle" id="${cssId(portName)}-port-input"></div></div><div class="col-md-3 col-sm-3 col-xs-3"><div class="ports-status port-output-status green-circle" id="${cssId(portName)}-port-output"></div></div></div>`;
    }
    return 1;
  }

  clearPlotInterval(tab: TabId): void {
    const handle = this.plotInterval[tab];
    if (handle !== undefined) this.ctx.clock.clearInterval(handle);
    this.plotInterval[tab] = undefined;
    this.ctx.clock.setTimeout(() => {
      delete this.sdTimestampData[tab];
      delete this.hdTimestampData[tab];
    }, 500);
  }

  decodeDeviceStatusRagMessages(tab: TabId): { red: string[] } | undefined {
    return this.RAGTexts[tab];
  }

  resetData(tab: TabId): void {
    this.clearPlotInterval(tab);
    delete this.sdXAxisData[tab];
    delete this.sdYAxisData[tab];
    delete this.hdXAxisData[tab];
    delete this.hdYAxisData[tab];
    delete this.deviceInfoRAG[tab];
    delete this.positionStatusRAG[tab];
    delete this.RAGTexts[tab];
    delete this.currentStateDeviceInfo[tab];
    delete this.ggaLogAvailable[tab];
    delete this.gsvPRNsList[tab];
    delete this.completeSatsObj[tab];
    delete this.ports[tab];
    delete this.gsvRepo[tab];
    delete this.gsvSeq[tab];
    delete this.gsaData[tab];
    delete this.pvaDataAvailable[tab];
    delete this.configFiles[tab];
    delete this.updateResponse[tab];
    delete this.deviceInfoRAGData[tab];
    delete this.sdTimestampData[tab];
    delete this.hdTimestampData[tab];
    delete this.sdScale[tab];
    delete this.hdScale[tab];
    delete this.sdUnit[tab];
    delete this.hdUnit[tab];
    this.wiredTabs.delete(tab);
  }

  setSatelliteSnapshotListener(
    listener: (tab: TabId, rows: LogData[], goodCount: number) => void,
  ): void {
    this.satelliteSnapshotListener = listener;
  }

  processLanguage(_tab?: TabId): void {
    applyLanguageMarkers(this.ctx, [
      ['antennapower', 'MODULE_INPUT_VOLTAGE'], ['5cm', 'SD_5CM'], ['10cm', 'SD_10CM'],
      ['50cm', 'SD_50CM'], ['1m', 'SD_1M'], ['5m', 'SD_5M'], ['need-help', 'NEED_HELP'],
      ['why-this-red', 'WHY_IS_THIS_RED'], ['why-this-amber', 'WHY_IS_THIS_AMBER'],
      ['yaxis-scale', 'YAXIS_SCALE'], ['2d-sd-status', '2D_SD'], ['height-sd-status', 'HEIGHT_SD'],
    ].map(([marker, key]) => ({
      selector: `[data-lang-${marker}]`,
      value: __(this.ctx, key),
    })));
    for (const tab of Object.keys(this.sdScale)) this.renderPlots(tab);
  }

  private updateGga(tab: TabId, data: LogData): number {
    this.ggaLogAvailable[tab] = true;
    const quality = numberValue(data.Quality) - 48;
    const state = quality === 4 || quality === 5 ? 'good' : quality === 1 ? 'warning' : 'bad';
    this.positionStatusRAG[tab] = state;
    const scope = this.ctx.document.getElementById(tab);
    if (scope) {
      for (const node of scope.querySelectorAll('.posmodes')) node.classList.remove('activePosMode');
      for (const node of scope.querySelectorAll('.single, .RTK')) {
        setStyle(node, 'display', 'inline-block');
      }
      const active =
        quality === 1
          ? scope.querySelector('.single')
          : quality === 4 || quality === 5
            ? scope.querySelector('.RTK')
            : null;
      active?.classList.add('activePosMode');
    }
    showRag(this.ctx, tab, 'positionStatus', state);
    this.updateStatusRAG(tab);
    const lat = nmeaDegrees(data.Latitude);
    const lon = nmeaDegrees(data.Longitude);
    const latSign = String.fromCharCode(numberValue(data.NS, 78)) === 'N' ? '' : '-';
    const lonSign = String.fromCharCode(numberValue(data.EW, 69)) === 'E' ? '' : '-';
    const values: LogData = {
      tab,
      latitude: Number.isFinite(lat) ? `${latSign}${formatNumber(this.ctx, lat, 7, tab)}°` : '--',
      longitude: Number.isFinite(lon) ? `${lonSign}${formatNumber(this.ctx, lon, 7, tab)}°` : '--',
      height: displayNumber(this.ctx, data.AntennaAlt, 2, tab, this.ctx.distanceUnit()),
    };
    let written = 0;
    if (!this.pvaDataAvailable[tab]) {
      written += updateFields(this.ctx, tab, 'positionStatus', 'latitude,longitude,height', values);
      written += updateFields(this.ctx, tab, 'statusBar', 'latitude,longitude,height', values);
    }
    const time = nmeaTime(data.UTCHHMMSSss);
    written += updateFields(this.ctx, tab, 'statusBar', 'time', { tab, time });
    return written;
  }

  private updateGsa(tab: TabId, raw: LogData, data: LogData): number {
    const tracker = String(data.NMEA_TRAKERID ?? '');
    const prns = Array.isArray(data.PRN) ? data.PRN : [];
    let system = tracker === 'GN' ? '' : NMEA_SYSTEMS[tracker] ?? '';
    if (tracker === 'GN') {
      for (const prn of prns) {
        const lists = this.gsvPRNsList[tab] ?? {};
        if (lists.GPS?.prnlist.includes(prn)) {
          if (system !== 'GALILEO' && system !== 'BEIDOU') system = 'GPS';
        } else if (lists.GALILEO?.prnlist.includes(prn)) {
          if (system !== 'BEIDOU') system = 'GALILEO';
        } else if (lists.BEIDOU?.prnlist.includes(prn)) {
          system = 'BEIDOU';
        }
      }
    }
    const goodSats = this.goodSatelliteCount(tab, String(prns.length || 0));
    this.gsaData[tab] ??= {};
    this.gsaData[tab][system || 'UNKNOWN'] = {
      PRNList: prns,
      goodSats,
      tab,
    };
    const complete = (this.gsaData[tab][system || 'UNKNOWN'] as LogData);
    this.ctx.view.updateStatusIndicatorClrAndText(
      'satViewStatus',
      numberValue(complete.goodSats) >= 4 ? 'good' : 'bad',
      tab,
    );
    return 1;
  }

  private updateGsv(tab: TabId, raw: LogData): number {
    const rows = Array.isArray(raw.Data) ? (raw.Data as LogData[]) : [];
    if (!rows.length) return 0;
    const first = rows[0];
    const tracker = String(first.NMEA_TRAKERID ?? String(raw.MessageName ?? '').replace('GSV', ''));
    const system = NMEA_SYSTEMS[tracker] ?? 'GPS';
    const repo = (this.gsvRepo[tab] ??= {});
    const current = (repo[system] ??= []);
    const messageNumber = numberValue(first.MessageNumber);
    if (messageNumber === 1) current.length = 0;
    else {
      const previous = this.gsvSeq[tab] ?? 1;
      if (messageNumber < previous || messageNumber - previous > 1) {
        this.gsvSeq[tab] = numberValue(first.NumberSatellites) + 1;
        current.length = 0;
        return 0;
      }
    }
    this.gsvSeq[tab] = messageNumber;
    for (const row of rows) {
      const rowSystem = NMEA_SYSTEMS[String(row.NMEA_TRAKERID ?? tracker)] ?? system;
      const usedPrns = this.gsaData[tab]?.[rowSystem]?.PRNList;
      current.push({
        prn: numberValue(row.PNR),
        system: rowSystem,
        azimuthal: numberValue(row.Azimuth),
        elevation: numberValue(row.Elevation),
        cno: numberValue(row.SNR),
        rejectCodes: [
          Array.isArray(usedPrns) && usedPrns.includes(numberValue(row.PNR))
            ? '0'
            : '1',
        ],
      });
      const lists = (this.gsvPRNsList[tab] ??= {});
      const prnList = (lists[rowSystem] ??= { prnlist: [] }).prnlist;
      if (!prnList.includes(numberValue(row.PNR))) prnList.push(numberValue(row.PNR));
    }
    const expected = numberValue(first.NumberSatellites);
    if (current.length >= expected || expected === 0) {
      this.completeSatsObj[tab] ??= {};
      this.completeSatsObj[tab][system] = [...current];
      const all = Object.values(this.completeSatsObj[tab]).flat();
      const used = all.filter((satellite) =>
        Array.isArray(satellite.rejectCodes) &&
        satellite.rejectCodes.includes('0'),
      ).length;
      this.satelliteSnapshotListener?.(tab, all, used);
      this.ctx.publishEvent?.(tab, 'events', {
        tab,
        MessageID: 223,
        Data: all,
        time: new Date(this.ctx.clock.now()),
      });
      this.gsvRepo[tab] = {};
    }
    return current.length;
  }

  private updateNmeaText(tab: TabId, data: LogData): number {
    const identifier = numberValue(data.MessageIdentifier);
    const text = String(data.MessageText ?? '');
    if (identifier === 1) {
      const keys: Record<number, string> = {
        1: 'gnssHardwareVersion',
        3: 'gnssSerialNumber',
        4: 'gnssModelNumber',
        5: 'gnssSoftwareVersion',
        6: 'gnssBootVersion',
      };
      const key = keys[numberValue(data.MessageNumber)];
      if (key) {
        const value = text.split(': ')[1] ?? '';
        updateFields(this.ctx, tab, 'deviceDetails', key, { tab, [key]: value });
      }
      return 1;
    }
    if (identifier === 2 && numberValue(data.MessageNumber) === 1) {
      const errorWord = Number.parseInt((text.split(': ')[1] ?? '').slice(0, 1), 16);
      this.ctx.publishEvent?.(tab, 'events', {
        tab,
        MessageIdentifier: identifier,
        invalidAuthCode: (errorWord >> 5) & 1,
        invalidModel: (errorWord >> 17) & 1,
      });
      return 1;
    }
    if (identifier === 4) {
      const parts = text.split(' ');
      const idle = Math.round(100 - parseInt(parts[1], 10));
      const temperature = Math.round(Number(parts[3]));
      const voltage = Number.parseFloat(parts[5]);
      updateFields(this.ctx, tab, 'statusBar', 'idleTime', { tab, idleTime: `${idle}%` });
      updateFields(this.ctx, tab, 'deviceInfo', 'idleTime,temperature,antennaVoltage', {
        tab,
        idleTime: `${idle}%`,
        temperature: `${temperature} °C`,
        antennaVoltage: `${formatNumber(this.ctx, voltage, 1, tab)} V`,
      });
      const config = this.ctx.document.querySelector(`#${tab} #positionStatusConfiguredPosition`);
      const bar = this.ctx.document.querySelector(`#${tab} #statusBarConfiguredPosition`);
      if (config && bar) bar.innerHTML = config.innerHTML;
      this.deviceInfoRAGData[tab] ??= {};
      this.deviceInfoRAGData[tab].cpuUsage = idle;
      this.updateLonghornRag(tab);
      this.ctx.publishEvent?.(tab, 'events', {
        tab,
        MessageIdentifier: identifier,
        idleTime: 100 - idle,
      });
      return 1;
    }
    if (identifier === 3) {
      const words = text.split(' ');
      const statusWord = parseInt(words[0], 16);
      if (numberValue(data.MessageNumber) === 1) {
        this.deviceInfoRAGData[tab] ??= {};
        this.deviceInfoRAGData[tab].temperature = (statusWord >>> 1) & 1;
        this.deviceInfoRAGData[tab].antenna = (statusWord >>> 2) & 1;
        this.updateLonghornRag(tab);
        this.ctx.publishEvent?.(tab, 'events', {
          tab,
          MessageIdentifier: identifier,
          temperature: this.deviceInfoRAGData[tab].temperature,
          antennaVoltage: this.deviceInfoRAGData[tab].antenna,
        });
      }
      if (numberValue(data.MessageNumber) === 3) {
        this.ctx.publishEvent?.(tab, 'events', {
          tab,
          MessageIdentifier: identifier,
          com1BufferOverrun: (statusWord >> 9) & 1,
          com2BufferOverrun: (statusWord >> 10) & 1,
        });
      }
      return 1;
    }
    if (identifier === 5) {
      const parts = text.split(' ');
      if (!this.pvaDataAvailable[tab]) {
        updateFields(this.ctx, tab, 'positionStatus', 'positionStatus', {
          tab,
          positionStatus: INSPVA_STATUS[numberValue(parts[1])] ?? parts[1],
        });
        updateFields(this.ctx, tab, 'statusBar', 'spanstatus', {
          tab,
          spanstatus: numberValue(parts[1]) === 0 ? this.ctx.translate('INACTIVE') : this.ctx.translate('ACTIVE'),
        });
      }
    }
    return 1;
  }

  private goodSatelliteCount(tab: TabId, fallback: string): number {
    const used = Object.values(this.gsaData[tab] ?? {}).reduce(
      (sum, entry) => sum + (Array.isArray(entry.PRNList) ? entry.PRNList.length : 0),
      0,
    );
    return used || Number(fallback) || 0;
  }

  private updateLonghornRag(tab: TabId): void {
    const data = this.deviceInfoRAGData[tab] ?? {};
    const bucket = (this.RAGTexts[tab] ??= { red: [] });
    if (Object.prototype.hasOwnProperty.call(data, 'cpuUsage')) {
      const usage = numberValue(data.cpuUsage);
      if (usage >= 90) {
        if (
          this.currentStateDeviceInfo[tab] !== 'bad' &&
          (this.idleTimeTimer[tab] === undefined || this.idleTimeTimer[tab] === 0)
        ) {
          this.idleTimeTimer[tab] = this.ctx.clock.setTimeout(() => {
            this.currentStateDeviceInfo[tab] = 'bad';
            showRag(this.ctx, tab, 'cpuUsageIndicator', 'bad');
            if (!bucket.red.includes('CPUUSAGE_RED')) bucket.red.push('CPUUSAGE_RED');
            this.idleTimeTimer[tab] = 0;
            this.updateDeviceInfoRagStatus(tab);
          }, 5000);
        }
      } else if (usage <= 80) {
        if (this.idleTimeTimer[tab] !== undefined) {
          this.ctx.clock.clearTimeout(this.idleTimeTimer[tab]!);
          this.idleTimeTimer[tab] = 0;
        }
        const index = bucket.red.indexOf('CPUUSAGE_RED');
        if (index >= 0) bucket.red.splice(index, 1);
        this.currentStateDeviceInfo[tab] = 'good';
        showRag(this.ctx, tab, 'cpuUsageIndicator', 'good');
      } else {
        this.currentStateDeviceInfo[tab] = 'good';
        showRag(this.ctx, tab, 'cpuUsageIndicator', 'good');
      }
    }
    for (const [key, label] of [
      ['temperature', 'TEMPERATURE_RED'],
      ['antenna', 'ANTENNA_RED'],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      if (numberValue(data[key]) === 1) {
        if (!bucket.red.includes(label)) bucket.red.push(label);
        showRag(this.ctx, tab, `${key}Indicator`, 'bad');
      } else {
        const index = bucket.red.indexOf(label);
        if (index >= 0) bucket.red.splice(index, 1);
        showRag(this.ctx, tab, `${key}Indicator`, 'good');
      }
    }
    this.updateDeviceInfoRagStatus(tab);
  }

  private updateDeviceInfoRagStatus(tab: TabId): void {
    const red = (this.RAGTexts[tab]?.red.length ?? 0) > 0;
    const state = red ? 'bad' : 'good';
    this.deviceInfoRAG[tab] = state;
    showRag(this.ctx, tab, 'deviceInfo', state);
    this.updateStatusRAG(tab);
  }

  private updateStatusRAG(tab: TabId): void {
    const positioning =
      this.positionStatusRAG[tab] === 'bad'
        ? 'red'
        : this.positionStatusRAG[tab] === 'warning'
          ? 'yellow'
          : 'green';
    const device =
      this.deviceInfoRAG[tab] === 'bad'
        ? 'red'
        : this.deviceInfoRAG[tab] === 'warning'
          ? 'yellow'
          : 'green';
    for (const [parent, colour] of [
      ['positioning-traffic', positioning],
      ['device-traffic', device],
    ] as const) {
      for (const node of this.ctx.document.querySelectorAll(
        `#${tab} .${parent}.traffic-lights span`,
      )) {
        setStyle(node, 'display', 'none');
      }
      for (const node of this.ctx.document.querySelectorAll(
        `#${tab} .${parent}.traffic-lights span.${colour}-status`,
      )) {
        setStyle(node, 'display', 'inline');
      }
    }
    const connection =
      positioning === device
        ? device
        : positioning === 'red' || device === 'red'
          ? 'red'
          : positioning === 'yellow' || device === 'yellow'
            ? 'yellow'
            : 'green';
    const indicator = this.ctx.document.querySelector(
      `#${this.ctx.deviceTileId(tab)}-device-tile .devicetile-indicator`,
    );
    if (indicator) {
      for (const colour of ['red', 'yellow', 'green', 'grey']) {
        indicator.classList.remove(`${colour}-circle`);
      }
      indicator.classList.add(`${connection}-circle`);
    }
  }

  private updateGst(tab: TabId, data: LogData): number {
    if (this.pvaDataAvailable[tab]) return 0;
    const std2d = Math.sqrt(
      Math.pow(numberValue(data.STDLatitude), 2) +
        Math.pow(numberValue(data.STDLongitude), 2),
    );
    const height = numberValue(data.STDAltitude);
    const now = Date.now();
    (this.sdTimestampData[tab] ??= []).unshift(now);
    (this.hdTimestampData[tab] ??= []).unshift(now);
    (this.sdXAxisData[tab] ??= []).unshift(0);
    (this.sdYAxisData[tab] ??= []).unshift(std2d * 100);
    (this.hdXAxisData[tab] ??= []).unshift(0);
    (this.hdYAxisData[tab] ??= []).unshift(height * 100);
    this.trimHistory(tab, now);
    updateFields(this.ctx, tab, 'positionStatus', 'standard2D', {
      tab,
      standard2D: `${formatNumber(this.ctx, std2d * 100, 2, tab)} cm`,
    });
    this.ensurePlotInterval(tab);
    return this.renderPlots(tab);
  }

  private updateSpeed(tab: TabId, data: LogData): number {
    return updateFields(this.ctx, tab, 'positionStatus', 'Speed,CourseGround', {
      tab,
      Speed: `${formatNumber(this.ctx, data.Speed, 0, tab)} km/h`,
      CourseGround: angleText(this.ctx, data.TrueTrack, tab, 1),
    });
  }

  private updateTime(tab: TabId, data: LogData): number {
    if (this.ggaLogAvailable[tab]) return 0;
    const text = String(data.UTCHHMMSSss ?? '');
    const compact = text.split('.')[0].padStart(6, '0');
    return updateFields(this.ctx, tab, 'statusBar', 'time', {
      tab,
      time: `${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4, 6)}`,
    });
  }

  private updatePva(tab: TabId, data: LogData): number {
    this.pvaDataAvailable[tab] = true;
    const std2d = Math.sqrt(
      Math.pow(numberValue(data.LatStdDev), 2) +
        Math.pow(numberValue(data.LongStdDev), 2),
    );
    const heightSd = numberValue(data.HgtStdDev);
    const now = Date.now();
    (this.sdTimestampData[tab] ??= []).unshift(now);
    (this.hdTimestampData[tab] ??= []).unshift(now);
    (this.sdXAxisData[tab] ??= []).unshift(0);
    (this.sdYAxisData[tab] ??= []).unshift(std2d * 100);
    (this.hdXAxisData[tab] ??= []).unshift(0);
    (this.hdYAxisData[tab] ??= []).unshift(heightSd * 100);
    this.trimHistory(tab, now);
    const velocity = this.ctx.velocityUnit();
    const values: LogData = {
      tab,
      latitude: angleText(this.ctx, data.Latitude, tab, 7),
      longitude: angleText(this.ctx, data.Longitude, tab, 7),
      height: displayNumber(this.ctx, data.Height, 2, tab, this.ctx.distanceUnit()),
      azimuth: angleText(this.ctx, data.Azimuth, tab),
      pitch: angleText(this.ctx, data.Pitch, tab),
      roll: angleText(this.ctx, data.Roll, tab),
      positionStatus: data.INSStatus,
      spanstatus: data.INSStatus === 'INS_INACTIVE' ? 'Inactive' : 'Active',
      northVelocity: displayNumber(this.ctx, data.X, 2, tab, velocity),
      eastVelocity: displayNumber(this.ctx, data.Y, 2, tab, velocity),
      upVelocity: displayNumber(this.ctx, data.Z, 2, tab, velocity),
      standard2D: `${formatNumber(this.ctx, std2d * 100, 2, tab)} cm`,
    };
    let written = updateFields(
      this.ctx,
      tab,
      'positionStatus',
      'latitude,longitude,height,azimuth,pitch,roll,spanstatus,standard2D',
      values,
    );
    written += updateFields(
      this.ctx,
      tab,
      'statusBar',
      'latitude,longitude,height,spanstatus',
      values,
    );
    written += updateFields(
      this.ctx,
      tab,
      'spanStatus',
      'azimuth,pitch,roll,northVelocity,eastVelocity,upVelocity',
      values,
    );
    const scope = this.ctx.document.getElementById(tab);
    if (scope) {
      for (const node of scope.querySelectorAll('.posmodes')) setStyle(node, 'display', 'none');
      for (const node of scope.querySelectorAll('.RTK, .single')) {
        setStyle(node, 'display', 'inline-block');
      }
    }
    this.updateStatusRAG(tab);
    this.ensurePlotInterval(tab);
    return written + this.renderPlots(tab);
  }

  private updateLonghornHardware(tab: TabId, _messageId: number, data: LogData): number {
    const idle = numberValue(data.idleTime ?? data.CPUUsage);
    let state = 'good';
    if (idle >= 90) state = 'bad';
    else if (numberValue(data.temperatureStatus, 0) === 1 || numberValue(data.antennaStatus, 0) === 1) state = 'bad';
    this.deviceInfoRAG[tab] = state;
    showRag(this.ctx, tab, 'deviceInfo', state);
    return 1;
  }

  private renderPlots(tab: TabId): number {
    const sd = this.ctx.document.querySelector(`#${tab} .2d-sd-container`);
    const hd = this.ctx.document.querySelector(`#${tab} .height-sd-container`);
    const now = Date.now();
    const xFromTimestamps = (values: number[] | undefined): number[] =>
      values?.length
        ? values
            .map((stamp) => (stamp - now) / 60000)
            .filter((value) => value >= -10)
        : [0];
    const sdX = xFromTimestamps(this.sdTimestampData[tab]);
    const hdX = xFromTimestamps(this.hdTimestampData[tab]);
    this.sdXAxisData[tab] = sdX;
    this.hdXAxisData[tab] = hdX;
    const sdY = (this.sdYAxisData[tab] ?? []).map((value) =>
      (this.sdUnit[tab] ?? 'centimeters') === 'meters' ? value / 100 : value,
    );
    const hdY = (this.hdYAxisData[tab] ?? []).map((value) =>
      (this.hdUnit[tab] ?? 'centimeters') === 'meters' ? value / 100 : value,
    );
    let written = 0;
    if (sd) {
      const value = this.sdYAxisData[tab]?.[0];
      sd.id = `2d-sdLayout_${tab}`;
      const drew = renderPlotly(sd, [{
        x: sdX,
        y: sdY,
        type: 'scatter',
        mode: 'lines',
        hoverinfo: 'skip',
        line: { color: '#D0021B', width: 2 },
        name: 'spline',
      }], this.plotLayout(tab, '2d'));
      if (!drew) {
        sd.innerHTML = `<div class="longhorn-plot-value">2D SD: ${value === undefined ? '--' : `${formatNumber(this.ctx, value, 2, tab)} cm`}</div>`;
      }
      written += 1;
    }
    if (hd) {
      const value = this.hdYAxisData[tab]?.[0];
      hd.id = `height-sdLayout_${tab}`;
      const drew = renderPlotly(hd, [{
        x: hdX,
        y: hdY,
        type: 'scatter',
        mode: 'lines',
        hoverinfo: 'skip',
        line: { color: '#F5A623', width: 2 },
        name: 'spline',
      }], this.plotLayout(tab, 'height'));
      if (!drew) {
        hd.innerHTML = `<div class="longhorn-plot-value">Height SD: ${value === undefined ? '--' : `${formatNumber(this.ctx, value, 2, tab)} cm`}</div>`;
      }
      written += 1;
    }
    this.wirePlotControls(tab);
    return written;
  }

  private plotLayout(tab: TabId, kind: '2d' | 'height'): LogData {
    const scale = kind === '2d' ? this.sdScale[tab] ?? 5 : this.hdScale[tab] ?? 5;
    const unit = kind === '2d' ? this.sdUnit[tab] ?? 'centimeters' : this.hdUnit[tab] ?? 'centimeters';
    return {
      margin: { l: 15, r: 50, b: 50, t: 5, pad: 0 },
      xaxis: {
        range: [-10, 0],
        title: { text: __(this.ctx, 'TIME_M') },
        showgrid: false,
        zeroline: true,
        showline: true,
        mirror: true,
        ticks: 'outside',
        ticklen: 4,
        fixedrange: true,
        dtick: 2,
      },
      yaxis: {
        dtick: scale / 5,
        fixedrange: true,
        range: [0, scale],
        showgrid: false,
        zeroline: true,
        showline: true,
        ticks: 'outside',
        ticklen: 4,
        side: 'right',
        title: { text: __(this.ctx, unit === 'centimeters' ? 'CENTIMETERS' : 'METERS') },
      },
      colorscale: kind === '2d' ? '#A00214' : '#F5A623',
      paper_bgcolor: '#FCFCFC',
      plot_bgcolor: '#FCFCFC',
    };
  }

  private wirePlotControls(tab: TabId): void {
    if (this.wiredTabs.has(tab)) return;
    const scope = this.ctx.document.getElementById(tab);
    if (!scope) return;
    this.wiredTabs.add(tab);
    const bind = (
      selector: string,
      scale: Record<TabId, number>,
      units: Record<TabId, 'centimeters' | 'meters'>,
      persistKey: string,
    ): void => {
      const inputs = scope.querySelectorAll(selector) as Array<HTMLInputElement>;
      const saved = this.ctx.userData<LogData>([
        'app',
        'deviceManagement',
        'devices',
        this.ctx.deviceTileId(tab),
        persistKey,
      ]);
      const savedValue = String(saved?.selectedGraphVal ?? '');
      if (savedValue) {
        for (const input of inputs) input.checked = input.value === savedValue || savedValue.endsWith(`-${input.id}`);
      }
      for (const input of inputs) {
        input.addEventListener('change', () => {
          if (!input.checked) return;
          const value = input.value.replace(/^sd-/, '').replace(/^height-/, '');
          const numeric = Number.parseInt(value, 10);
          if (Number.isFinite(numeric)) scale[tab] = numeric;
          units[tab] = value.includes('cm') ? 'centimeters' : 'meters';
          this.ctx.setUserData(
            [
              'app',
              'deviceManagement',
              'devices',
              this.ctx.deviceTileId(tab),
              persistKey,
              'selectedGraphVal',
            ],
            input.value,
          );
          this.renderPlots(tab);
        });
      }
    };
    bind('.longhorn-2d-sd-tile input[type=radio], .2d-sd-checks input[type=radio]', this.sdScale, this.sdUnit, 'lghn_2d_sd');
    bind('.longhorn-height-sd-tile input[type=radio], .height-sd-checks input[type=radio]', this.hdScale, this.hdUnit, 'lghn_height_sd');
  }

  private ensurePlotInterval(tab: TabId): void {
    if (this.plotInterval[tab] !== undefined) return;
    this.plotInterval[tab] = this.ctx.clock.setInterval(() => this.renderPlots(tab), 100);
  }

  private trimHistory(tab: TabId, _now: number): void {
    for (const store of [
      this.sdXAxisData,
      this.sdYAxisData,
      this.hdXAxisData,
      this.hdYAxisData,
      this.sdTimestampData,
      this.hdTimestampData,
    ]) {
      if (store[tab] && store[tab].length > 6000) store[tab].length = 6000;
    }
  }
}

function nmeaDegrees(value: unknown): number {
  const text = String(value ?? '');
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return Number.NaN;
  const dot = text.indexOf('.');
  const split = dot >= 0 ? dot : text.length;
  const degreeDigits = Math.max(0, split - 2);
  const degrees = Number(text.slice(0, degreeDigits));
  const minutes = Number(text.slice(degreeDigits));
  return degrees + minutes / 60;
}

function cssId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

const NMEA_SYSTEMS: Record<string, string> = {
  GP: 'GPS',
  GA: 'GALILEO',
  BD: 'BEIDOU',
};

const INSPVA_STATUS: Record<number, string> = {
  0: 'INS_INACTIVE',
  1: 'INS_ALIGNING',
  2: 'INS_HIGH_VARIANCE',
  3: 'INS_SOLUTION_GOOD',
  6: 'INS_SOLUTION_FREE',
  7: 'INS_ALIGNMENT_COMPLETE',
  8: 'DETERMINING_ORIENTATION',
  9: 'WAITING_INITIALPOS',
  10: 'WAITING_AZIMUTH',
  11: 'INITIALIZING_BIASES',
  12: 'MOTION_DETECT',
  14: 'WAITING_ALIGNMENTORIENTATION',
};

function nmeaTime(value: unknown): string {
  const compact = String(value ?? '').split('.')[0];
  if (compact.length === 6) {
    return `${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4, 6)}`;
  }
  return `0${compact.slice(0, 1)}:${compact.slice(1, 3)}:${compact.slice(3, 5)}`;
}
