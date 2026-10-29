import {
  MSG_ID,
  clone,
  escapeHTML,
  findInternalFlash,
  formatNumber,
  normalizeLog,
  numberValue,
  rowsOf,
  setStyle,
  showRag,
  tabOf,
  updateFields,
  type LogData,
  type StatusContext,
  applyLanguageMarkers,
  __,
} from './common.ts';
import type { TabId } from '../types.ts';

type RagText = string | Record<string, string>;
type RagBucket = { amber: RagText[]; red: RagText[]; warning?: RagText[] };

export class DeviceInfo {
  readonly fsDictionary: Record<TabId, LogData> = {};
  readonly hwDictionary: Record<TabId, LogData> = {};
  readonly RAGTexts: Record<TabId, RagBucket> = {};
  readonly powerstatus: Record<TabId, number> = {};
  readonly deviceRAGIndicatorColor: Record<TabId, string | undefined> = {};
  private readonly ctx: StatusContext;
  private readonly markRag: (tab: TabId, msgId: number) => void;
  private readonly flashOf: (data: LogData) => LogData | null;

  constructor(
    ctx: StatusContext,
    markRag: (tab: TabId, msgId: number) => void = () => {},
    flashOf: (data: LogData) => LogData | null = findInternalFlash,
  ) {
    this.ctx = ctx;
    this.markRag = markRag;
    this.flashOf = flashOf;
  }

  updateView(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    this.markRag(tab, msgID);
    const ragBucket = this.ensureRag(tab);
    ragBucket.amber = [];
    ragBucket.red = [];

    if (msgID === MSG_ID.RXSTATUS) {
      this.powerstatus[tab] = numberValue(data.rxstatus3bit);
      this.updateRag(tab);
      return 1;
    }
    if (msgID === 963) {
      return this.updateHardware(tab, data);
    }
    if (msgID === MSG_ID.FILESYSTEMCAPACITY) {
      return this.updateStorage(tab, data);
    }
    if (msgID === MSG_ID.GIII_CARDSTATUS) {
      return this.updateCards(tab, data);
    }
    return 0;
  }

  decodeDeviceStatusRagMessages(tab: TabId): RagBucket | undefined {
    return this.RAGTexts[tab];
  }

  deviceInfoRAGColor(tab: TabId): string | undefined {
    return this.deviceRAGIndicatorColor[tab];
  }

  resetData(tab: TabId): void {
    delete this.fsDictionary[tab];
    delete this.hwDictionary[tab];
    delete this.RAGTexts[tab];
    delete this.powerstatus[tab];
    delete this.deviceRAGIndicatorColor[tab];
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['model', 'MODEL'], ['device', 'DEVICE'], ['cpuusage', 'CPU_USAGE'],
      ['why-this-amber', 'WHY_IS_THIS_AMBER'], ['why-this-red', 'WHY_IS_THIS_RED'],
      ['storageusage', 'STORAGE_USAGE'], ['temperature', 'TEMPERATURE'],
      ['antennapower', 'ANTENNA_VOLTAGE'], ['antennacurrent', 'ANTENNA_CURRENT'],
      ['cpuusage_amber', 'CPUUSAGE_AMBER'], ['storageusage_amber', 'STORAGEUSAGE_AMBER'],
      ['temperature_amber', 'TEMPERATURE_AMBER'], ['antenna_amber', 'ANTENNA_AMBER'],
      ['cpuusage_red', 'CPUUSAGE_RED'], ['storageusage_red', 'STORAGEUSAGE_RED'],
      ['temperature_red', 'TEMPERATURE_RED'], ['antenna_red', 'ANTENNA_RED'],
      ['modulevoltage', 'MODULE_INPUT_VOLTAGE'], ['inactive', 'INACTIVE'], ['active', 'ACTIVE'],
      ['need-help', 'NEED_HELP'],
      ['cpuusage_red_parameter', 'CPU_USAGE_RED_PARAMETER'],
      ['cpuusage_amber_parameter', 'CPU_USAGE_AMBER_PARAMETER'],
      ['temperature_amber_parameter', 'TEMPERATURE_AMBER_PARAMETER'],
      ['temperature_red_parameter', 'TEMPERATURE_RED_PARAMETER'],
      ['device-state', 'STATE'], ['device-mode', 'MODE'], ['device-software', 'DEVICE_SOFTWARE'],
      ['iomaster', 'IOMASTER'], ['error', 'ERROR'], ['good', 'GOOD'], ['warning', 'WARNING'],
    ];
    applyLanguageMarkers(this.ctx, [
      ...keys.map(([marker, key]) => ({ selector: `[data-lang-${marker}]`, value: __(this.ctx, key) })),
      { selector: '[data-lang-title-deviceinfored]', value: `${__(this.ctx, 'DEVICE')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}` },
      { selector: '[data-lang-title-deviceinfoamber]', value: `${__(this.ctx, 'DEVICE')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}` },
    ]);
  }

  private updateHardware(tab: TabId, data: LogData): number {
    const features = this.ctx.features(tab);
    const rows = rowsOf(data);
    const readings: LogData = {};
    if (rows.length) {
      for (const row of rows) {
        const readingType = numberValue(row.readingType, numberValue(row['<readingType>']));
        const key =
          typeof row.readingType === 'string'
            ? row.readingType
            : ({
                1: 'temperature',
                2: 'antennaCurrent',
                7: 'antennaVoltage',
                22: 'secondaryTemperature',
                24: 'secondaryAntennaCurrent',
                25: 'secondaryAntennaVoltage',
              } as Record<number, string>)[readingType];
        if (key) {
          readings[key] = row.reading ?? row.value ?? row.measurement;
          const status = numberValue(row.status);
          readings[`${key}Bound`] = status >>> 24;
        }
      }
    } else {
      Object.assign(readings, data);
      const high = numberValue(data.status) >>> 24;
      for (const key of ['temperature', 'antennaVoltage', 'antennaCurrent']) {
        if (Object.prototype.hasOwnProperty.call(data, key) && !Object.prototype.hasOwnProperty.call(data, `${key}Bound`)) {
          readings[`${key}Bound`] = high;
        }
      }
    }
    const output: LogData = {
      ...readings,
      tab,
      idleTime: `${formatNumber(this.ctx, data.idleTime, 0, tab)}%`,
      temperature:
        readings.temperature === undefined
          ? '--'
          : `${formatNumber(this.ctx, readings.temperature, 1, tab)} °C`,
      antennaVoltage:
        readings.antennaVoltage === undefined
          ? '--'
          : features.generation === 'OEMSTAR'
            ? '--'
            : `${formatNumber(this.ctx, readings.antennaVoltage, 1, tab)} V`,
      antennaCurrent:
        readings.antennaCurrent === undefined
          ? '--'
          : features.generation === 'OEMSTAR'
            ? '--'
            : `${formatNumber(
                this.ctx,
                features.generation === 'OEM6'
                  ? readings.antennaCurrent
                  : numberValue(readings.antennaCurrent) * 1000,
                1,
                tab,
              )} mA`,
    };
    const written = updateFields(
      this.ctx,
      tab,
      'deviceInfo',
      'temperature,antennaVoltage,idleTime,antennaCurrent',
      output,
    );
    if (features.generation === 'OEMSTAR') {
      setStyle(this.ctx.document.querySelector(`#${tab} .antenna-power`), 'display', 'block');
      setStyle(
        this.ctx.document.querySelector(`#${tab} #deviceInfoantennaVoltage`),
        'padding-left',
        '17px',
      );
    }
    this.hwDictionary[tab] = {
      cpuUsage: numberValue(data.idleTime),
      temperature: numberValue(readings.temperatureBound),
      antenna: numberValue(readings.antennaVoltageBound),
      current: numberValue(readings.antennaCurrentBound),
    };
    this.updateRag(tab);
    return written;
  }

  private updateStorage(tab: TabId, data: LogData): number {
    const flash = this.flashOf(data);
    if (!flash || numberValue(data.noOfDevices) === 0 || numberValue(flash.totalStorage) === 0) return 0;
    const usage = Math.round((numberValue(flash.usedStorage) / numberValue(flash.totalStorage)) * 100);
    const text = `${formatNumber(this.ctx, usage, 0, tab)}%`;
    setStyle(this.ctx.document.querySelector(`#${tab} .storage-usage`), 'display', 'block');
    setStyle(
      this.ctx.document.querySelector(`#${tab} .device-storage-details .storage-fields`),
      'visibility',
      'visible',
    );
    setStyle(
      this.ctx.document.querySelector(`#${tab} .statusBarusedStorageHide`),
      'display',
      'inline-block',
    );
    updateFields(this.ctx, tab, 'deviceInfo', 'usedStorage', { ...flash, tab, usedStorage: text });
    this.fsDictionary[tab] = { storageUsage: usage };
    this.updateRag(tab);
    return 1;
  }

  private updateCards(tab: TabId, data: LogData): number {
    const rawCards = Array.isArray(data.cardsData) ? (data.cardsData as LogData[]) : [];
    const fullCount: Record<string, number> = {};
    const duplicateIndexes = new Set<number>();
    let moduleId: unknown;
    rawCards.forEach((card, index) => {
      const component = String(card.component ?? '');
      if (!Object.prototype.hasOwnProperty.call(fullCount, component)) {
        fullCount[component] = 1;
        moduleId = card.moduleId;
        return;
      }
      if (moduleId !== card.moduleId) {
        moduleId = card.moduleId;
        fullCount[component] += 1;
      } else {
        duplicateIndexes.add(index);
      }
    });
    const cards = rawCards.filter((_card, index) => !duplicateIndexes.has(index));
    const host = this.ctx.document.querySelector(`#${tab} .giii-card-entries`);
    let overall = 'green';
    const entries: string[] = [];
    const counts: Record<string, number> = {};
    const cpuHigh: string[] = [];
    const tempHigh: string[] = [];
    const cpuWarning: string[] = [];
    const tempWarning: string[] = [];
    const bucket = this.ensureRag(tab);
    bucket.amber = [];
    bucket.red = [];
    bucket.warning = [];
    for (const card of cards) {
      const name = String(card.component ?? '');
      counts[name] = (counts[name] ?? 0) + 1;
      const title = name === 'IOMASTER' ? 'IOMaster' : name;
      const count = fullCount[name] === 1 ? '' : String(counts[name]);
      const tempRag = numberValue(card.warningWord) === 0 ? 'green' : 'red';
      const cpuRag =
        name === 'RFCC' || name === 'RFDC'
          ? 'green'
          : numberValue(card.idleTime) >= 90
            ? 'red'
            : numberValue(card.idleTime) < 70
              ? 'green'
              : 'yellow';
      if (overall === 'green' && tempRag === 'green' && cpuRag === 'green') {
        overall = 'green';
      } else if (tempRag === 'red' || cpuRag === 'red') {
        overall = 'red';
        if (tempRag === 'red') tempHigh.push(`${title} ${count}`);
        if (cpuRag === 'red' && name !== 'RFCC' && name !== 'RFDC') {
          cpuHigh.push(`${title} ${count}`);
        }
      } else {
        overall = 'yellow';
        if (tempRag === 'yellow') tempWarning.push(`${title} ${count}`);
        if (cpuRag === 'yellow' && name !== 'RFCC' && name !== 'RFDC') {
          cpuWarning.push(`${title} ${count}`);
        }
      }
      let entry =
        `<div class="row device-iomaster"><span class="title col-md-5 col-sm-5 col-xs-7 device-fields" data-lang-iomaster>${escapeHTML(title)} ${escapeHTML(count)}</span></div>`;
      if (name !== 'RFCC' && name !== 'RFDC') {
        entry += `<div class="row cpu-usage"><span class="title col-md-6 col-sm-4 device-fields" data-lang-cpuusage>${escapeHTML(__(this.ctx, 'CPU_USAGE'))}</span><span class="value col-md-3 col-sm-4" id="deviceInfoIOMasteridleTime">${formatNumber(this.ctx, card.idleTime, 0, tab)}%</span><div class="statustiles-traffic deviceinfo-field deviceInfo col-md-3 col-sm-4"><span class="${cpuRag}-status cpuUsageIndicator Device" data-lang-${cpuRag === 'green' ? 'good' : cpuRag === 'yellow' ? 'warning' : 'error'}>${escapeHTML(__(this.ctx, cpuRag === 'green' ? 'GOOD' : cpuRag === 'yellow' ? 'WARNING' : 'ERROR'))}</span></div></div>`;
      }
      entry += `<div class="row temperature"><span class="title col-md-6 col-sm-4 device-fields" data-lang-temperature>${escapeHTML(__(this.ctx, 'TEMPERATURE'))}</span><span class="value col-md-3 col-sm-4" id="deviceInfoIOMastertemperature">${formatNumber(this.ctx, card.value_1, 0, tab)}°C</span><div class="statustiles-traffic deviceinfo-field deviceInfo col-md-3 col-sm-4"><span class="${tempRag}-status temperatureIndicator Device" data-lang-${tempRag === 'green' ? 'good' : tempRag === 'yellow' ? 'warning' : 'error'}>${escapeHTML(__(this.ctx, tempRag === 'green' ? 'GOOD' : tempRag === 'yellow' ? 'WARNING' : 'ERROR'))}</span></div></div>`;
      entries.push(entry);
    }
    if (host) host.innerHTML = entries.join('');
    const state =
      data.state === 'Configuration'
        ? __(this.ctx, 'CONFIGURATION')
        : data.state;
    if (data.state === 'Configuration') {
      this.ctx.document
        .querySelector(`#${tab} #deviceInfoState`)
        ?.setAttribute('data-lang-configuration', '');
    }
    updateFields(this.ctx, tab, 'deviceInfo', 'State,Mode,Software', {
      tab,
      State: state,
      Mode: data.mode,
      Software: data.attenSetting,
    });
    if (cards.length > 2 && data.state === 'Operational') {
      const top = `-${cards.length * 58}px`;
      setStyle(this.ctx.document.querySelector(`#${tab} .sat`), 'top', top);
      setStyle(this.ctx.document.querySelector(`#${tab} .giii-agc-tile`), 'top', top);
      setStyle(this.ctx.document.querySelector(`#${tab} .main-panel`), 'height', '1500px');
    }
    this.deviceRAGIndicatorColor[tab] = overall === 'red' ? 'bad' : overall === 'yellow' ? 'warning' : 'good';
    if (overall === 'red') {
      if (cpuHigh.length) bucket.red.push({ CPUUSAGE_RED_PARAMETER: cpuHigh.join(' , ') });
      if (tempHigh.length) bucket.red.push({ TEMPERATURE_RED_PARAMETER: tempHigh.join(' , ') });
    } else if (overall === 'yellow') {
      if (cpuWarning.length) {
        bucket.warning!.push({ CPUUSAGE_AMBER_PARAMETER: cpuWarning.join(' , ') });
      }
      if (tempWarning.length) {
        bucket.warning!.push({ TEMPERATURE_AMBER_PARAMETER: tempWarning.join(' , ') });
      }
    }
    showRag(this.ctx, tab, 'deviceInfo', this.deviceRAGIndicatorColor[tab]);
    return cards.length;
  }

  private updateRag(tab: TabId): void {
    const hw = this.hwDictionary[tab] ?? {};
    const fs = this.fsDictionary[tab] ?? {};
    const bucket = this.ensureRag(tab);
    bucket.amber = [];
    bucket.red = [];
    for (const [key, label] of [
      ['cpuUsage', 'CPUUSAGE'],
      ['storageUsage', 'STORAGEUSAGE'],
    ] as const) {
      const value = numberValue((key === 'cpuUsage' ? hw : fs)[key], Number.NaN);
      if (!Number.isFinite(value)) continue;
      const indicator = `${key}Indicator`;
      if (value > 90) {
        bucket.red.push(`${label}_RED`);
        showRag(this.ctx, tab, indicator, 'bad');
      } else if (value > 80) {
        bucket.amber.push(`${label}_AMBER`);
        showRag(this.ctx, tab, indicator, 'warning');
      } else {
        showRag(this.ctx, tab, indicator, 'good');
      }
    }
    for (const [key, label] of [
      ['temperature', 'TEMPERATURE'],
      ['antenna', 'ANTENNA'],
      ['current', 'CURRENT'],
    ] as const) {
      const status = numberValue(hw[key], 0);
      const suppressed =
        this.powerstatus[tab] === 1 && (key === 'antenna' || key === 'current');
      if (suppressed) continue;
      const indicator = `${key}Indicator`;
      if (status === 2 || status === 4) {
        bucket.red.push(`${label}_RED`);
        showRag(this.ctx, tab, indicator, 'bad');
      } else if (status === 1 || status === 3) {
        bucket.amber.push(`${label}_AMBER`);
        showRag(this.ctx, tab, indicator, 'warning');
      } else {
        showRag(this.ctx, tab, indicator, 'good');
      }
    }
    const rag = bucket.red.length ? 'bad' : bucket.amber.length ? 'warning' : 'good';
    this.deviceRAGIndicatorColor[tab] = rag;
    showRag(this.ctx, tab, 'deviceInfo', rag);
  }

  private ensureRag(tab: TabId): RagBucket {
    return (this.RAGTexts[tab] ??= { amber: [], red: [] });
  }
}
