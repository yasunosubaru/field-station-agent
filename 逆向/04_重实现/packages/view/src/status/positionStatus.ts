import {
  MSG_ID,
  angleText,
  clone,
  formatNumber,
  heightText,
  normalizeLog,
  numberValue,
  queryIn,
  removeMarkers,
  setStyle,
  setText,
  showRag,
  tabOf,
  updateFields,
  applyLanguageMarkers,
  __,
  type LogData,
  type StatusContext,
} from './common.ts';
import type { TabId } from '../types.ts';

interface PositionEntry extends LogData {
  aveposData: LogData;
  posaveData: LogData;
  autoSurveyData: LogData;
  heading2: LogData;
  inspvax: LogData;
  insCommanddata: LogData;
  connectimu: LogData;
  spanState: string;
  dualAntennaAlign: LogData;
  wifiAlign: LogData;
  alignAutomation: LogData;
  rxCommands: LogData;
  timeSolution: LogData;
}

const BAD_SOLUTIONS = new Set(['INSUFFICIENT_OBS', 'NO_CONVERGENCE', 'INVALID_FIX', 'INTEGRITY_WARNING']);
const PPP_INTERMEDIATE = new Set(['PPP_CONVERGING', 'INS_PPP_CONVERGING', 'PPP_BASIC_CONVERGING', 'INS_PPP_BASIC_CONVERGING']);
const INS_SOLUTIONS = new Set([
  'INS_SBAS',
  'INS_PSRSP',
  'INS_PSRDIFF',
  'INS_RTKFLOAT',
  'INS_RTKFIXED',
  'INS_PPP_CONVERGING',
  'INS_PPP',
  'INS_PPP_BASIC_CONVERGING',
  'INS_PPP_BASIC',
]);

export class PositionStatus {
  readonly positionStatusObj: Record<TabId, PositionEntry> = {};
  readonly configuredPosModes: Record<TabId, string[]> = {};
  readonly clockComputed: Record<TabId, LogData> = {};
  readonly posragIndicatorColor: Record<TabId, string | undefined> = {};
  readonly solutionStatus: Record<TabId, unknown> = {};
  readonly positionType: Record<TabId, unknown> = {};
  readonly remainingSurveyTime: Record<TabId, string> = {};
  readonly galileoE1Checked: Record<TabId, boolean> = {};

  private readonly ctx: StatusContext;
  private readonly markRag: (tab: TabId, msgId: number) => void;
  private convergingFlag = true;
  private alignSupported = false;
  private spanSupported = false;
  private marinePakSupported = false;

  constructor(
    ctx: StatusContext,
    markRag: (tab: TabId, msgId: number) => void = () => {},
  ) {
    this.ctx = ctx;
    this.markRag = markRag;
  }

  updateStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    this.markRag(tab, msgID);

    if (msgID === MSG_ID.CONNECTIMU) {
      state.connectimu = clone(data);
      return this.renderSpanState(tab);
    }
    if (msgID === 379) {
      if (!Object.prototype.hasOwnProperty.call(data, 'Commanddata')) state.insCommanddata = clone(data);
      return this.renderSpanState(tab);
    }
    if (msgID === MSG_ID.INSPVAX) {
      state.inspvax = clone(data);
      return this.renderSpanState(tab);
    }
    if (msgID === MSG_ID.BESTPOS) return this.updateBestPos(tab, data);
    if (msgID === MSG_ID.AUTOSURVEY) {
      state.autoSurveyData = clone(data);
      return 1;
    }
    if (msgID === MSG_ID.POSAVE) {
      state.posaveData = clone(data);
      return 1;
    }
    if (msgID === MSG_ID.AVEPOS) {
      state.aveposData = clone(data);
      this.updateSurveyProgress(tab);
      return 1;
    }
    if (msgID === MSG_ID.DUALANTENNAALIGN) state.dualAntennaAlign = clone(data);
    else if (msgID === MSG_ID.WIFIALIGNAUTOMATION) state.wifiAlign = clone(data);
    else if (msgID === MSG_ID.ALIGNAUTOMATION) state.alignAutomation = clone(data);
    else if (msgID === MSG_ID.HEADING2) state.heading2 = clone(data);
    else return 0;
    return this.renderAlignment(tab, data);
  }

  updateGIIIStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    if (msgID === MSG_ID.GIII_TIMESOLUTION) {
      state.timeSolution = clone(data);
      this.clockComputed[tab] = clone(data);
      const viewData: LogData = {
        tab,
        clockModel: data.clockModel,
        clockOffset: `${formatNumber(this.ctx, data.clockOffset, 6, tab)} μs`,
        clockOffsetsd: `${formatNumber(this.ctx, data.offsetStd, 7, tab)} μs`,
        clockDrift: `${formatNumber(this.ctx, data.clockDrift, 7, tab)} μs/s`,
        clockSignalType: data.signalType,
      };
      if (this.ctx.features(tab).isGIII && data.signalType === 'E1 GALILEO') {
        if (!this.galileoE1Checked[tab]) {
          this.galileoE1Checked[tab] = true;
          const gal = this.ctx.document.querySelector(`#${tab} .giii-position-status-data .galileo-sol-status`);
          gal?.classList.add('active');
          setText(this.ctx, tab, '.giii-position-status-data .clock-info-title', 'GPS Clock Information');
        }
        (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
          viewData,
          'clockModel,clockOffset,clockDrift,clockOffsetsd,clockSignalType',
          'positionStatusGal',
        );
        this.clockComputed[tab] = { ...this.clockComputed[tab], gal: data.clockModel };
      } else {
        (this.ctx.view.updateView as unknown as (d: LogData, f: string, n: string) => number)(
          viewData,
          'clockModel,clockOffset,clockDrift,clockOffsetsd,clockSignalType',
          'positionStatus',
        );
        this.clockComputed[tab] = { ...this.clockComputed[tab], gps: data.clockModel };
      }
      delete this.galileoE1Checked[tab];
    } else if (msgID === MSG_ID.GIII_RXCOMMANDS) {
      state.rxCommands = clone(data);
      const commands = Array.isArray(data.configData) ? data.configData.map(String) : [];
      const viewData: LogData = {
        tab,
        latitude: '--',
        longitude: '--',
        height: '--',
        datumId: '--',
        heightGIII: '--',
      };
      state.rxCommands.giiiFix = 'NOT_FIX';
      for (const command of commands) {
        if (!command.startsWith('FIX')) continue;
        const fields = command.split(' ');
        if (fields.length > 2) {
          state.rxCommands.giiiFix = 'FIX';
          viewData.latitude = `${formatNumber(this.ctx, fields[2], 7, tab)}°`;
          viewData.longitude = `${formatNumber(this.ctx, fields[3], 7, tab)}°`;
          viewData.height = `${formatNumber(this.ctx, fields[4], 2, tab)}${this.ctx.distanceUnit()}`;
          viewData.heightGIII = viewData.height;
          viewData.datumId = 'WGS84';
        }
        break;
      }
      updateFields(this.ctx, tab, 'positionStatus', 'latitude,longitude,height,datumId', viewData);
      updateFields(this.ctx, tab, 'statusBar', 'latitude,longitude,heightGIII', viewData);
    } else {
      return 0;
    }
    this.updateGiiRag(tab);
    this.markRag(tab, msgID);
    return 1;
  }

  setisAlignSupported(flag: boolean, tab?: TabId): void {
    this.alignSupported = flag;
    if (tab) setStyle(queryIn(this.ctx, tab, '.position-status .align-heading'), 'display', flag ? 'block' : 'none');
  }

  setisSpanSupported(flag: boolean, tab?: TabId): void {
    this.spanSupported = flag;
    if (tab) {
      setStyle(queryIn(this.ctx, tab, '.span-status'), 'display', flag ? 'block' : 'none');
      setStyle(queryIn(this.ctx, tab, '.position-status .azimuth'), 'display', flag ? 'block' : 'none');
    }
  }

  setisMarinePakSupported(flag: boolean, tab?: TabId): void {
    this.marinePakSupported = flag;
    if (tab) {
      for (const selector of ['.height-accuracy', '.correction-age', '.reference-station']) {
        setStyle(queryIn(this.ctx, tab, `.position-status ${selector}`), 'display', flag ? 'block' : 'none');
      }
    }
  }

  updatePositionModes(
    configured: string[],
    active: string | string[],
    tab: TabId,
    msgID = MSG_ID.INTERFACEMODE,
  ): number {
    this.ensure(tab);
    this.markRag(tab, msgID);
    this.configuredPosModes[tab] = [...configured];
    const activeText = Array.isArray(active) ? active[0] ?? '' : active;
    const scope = this.ctx.document.getElementById(tab);
    const features = this.ctx.features(tab);
    const supportsModes = !features.positionModes.includes('NONE');
    let activeKey = '';
    if (scope) {
      for (const node of scope.querySelectorAll('.posmodes')) setStyle(node, 'display', 'none');
      const isDgnssConfigured =
        features.positionModes.includes('PSRDIFF ROVER') &&
        configured.some((mode) => mode.replace(/\s/g, '') === 'PSRDIFFROVER');
      if (supportsModes) {
        for (const configuredMode of configured) {
          let mode = configuredMode.replace(/\s/g, '');
          if (mode === 'PSRDIFFROVER') mode = 'DGNSS';
          else if (mode === 'NTRIPCLIENT') mode = 'RTKROVER';
          else if (mode === 'NTRIPSERVER' || mode === 'PSRDIFFBASE') mode = 'RTKBASE';
          if (isDgnssConfigured && mode === 'RTKROVER') continue;
          mode = mode.replace(/BASE|ROVER/gi, '');
          for (const node of scope.querySelectorAll(`.${mode}`)) {
            setStyle(node, 'display', 'inline-block');
          }
          for (const node of scope.querySelectorAll(`.${mode}Title`)) {
            setStyle(node, 'display', 'inline-block');
          }
        }
      }
      if (supportsModes && activeText === 'NONE') {
        for (const node of scope.querySelectorAll('.NONE')) setStyle(node, 'display', 'inline-block');
      } else if (supportsModes) {
        for (const node of scope.querySelectorAll('.single')) setStyle(node, 'display', 'inline-block');
      }
      for (const node of scope.querySelectorAll('.posmodes')) node.classList.remove('activePosMode');
      if (activeText === 'PSRDIFF ROVER' && (configured.includes('PSRDIFF ROVER') || configured.length === 0)) {
        activeKey = 'DGNSS';
      } else if (activeText === 'NTRIP CLIENT') {
        activeKey = 'RTKROVER';
      } else if (activeText === 'NTRIP SERVER') {
        activeKey = 'RTKBASE';
      }
      const activeClass = (activeKey || activeText).replace(/BASE|ROVER/gi, '').replace(/\s/g, '');
      if (activeClass) {
        for (const node of scope.querySelectorAll(`.${activeClass}`)) node.classList.add('activePosMode');
      }
      if (
        (activeText === 'PPP' || activeText === 'SBAS') &&
        activeClass &&
        (scope.querySelector(`.${activeClass}`) as (Element & { style?: CSSStyleDeclaration }) | null)
          ?.style?.display === 'none'
      ) {
        setStyle(scope.querySelector(`.${activeClass}`), 'display', 'inline-block');
      } else if (
        (activeText === 'NTRIP CLIENT' || activeText === 'PSRDIFF ROVER') &&
        configured.length === 0 &&
        activeClass
      ) {
        for (const node of scope.querySelectorAll(`.${activeClass}`)) {
          setStyle(node, 'display', 'inline-block');
        }
        for (const node of scope.querySelectorAll(`.${activeClass}Title`)) {
          setStyle(node, 'display', 'inline-block');
        }
      }
    }
    if (String(this.positionType[tab]) === 'FIXEDPOS' && scope) {
      const configuredMode = this.configuredPosModes[tab];
      if (
        !configuredMode.includes('RTK BASE') &&
        !(features.isMarinePak && configuredMode.includes('PSRDIFF BASE'))
      ) {
        for (const node of scope.querySelectorAll('.posmodes')) setStyle(node, 'display', 'none');
        for (const node of scope.querySelectorAll('.FIXEDPOS')) {
          setStyle(node, 'display', 'inline-block');
          node.classList.add('activePosMode');
        }
      }
    }
    this.updateRag(tab, configured, activeKey || activeText);
    this.updateSurveyProgress(tab);
    return 1;
  }

  decodePositionStatusRagMessages(tab: TabId, state: string): string {
    if (state === 'red') return String(this.solutionStatus[tab] ?? 'POSITIONSTATUSRED');
    const type = String(this.positionType[tab] ?? '');
    const rtkVisible = this.ctx.document.querySelector(
      `#${tab} #positionStatusConfiguredPosition .RTK`,
    );
    if (
      (rtkVisible as HTMLElement | null)?.style?.display === 'inline-block' &&
      (type === 'WIDE_INT' || type === 'PSRDIFF' || type === 'NARROW_FLOAT')
    ) {
      return type;
    }
    if (!this.convergingFlag) return 'PPP_INTERMEDIATE_STATE';
    if (this.positionStatusObj[tab]?.aveposData?.posaveStatus === 'INPROGRESS') return 'SURVEY_IN_PROGRESS';
    return 'positionStatusAmber';
  }

  decodeGIIIPositionStatusRagMessages(tab: TabId, state: string): string {
    const fixed = this.positionStatusObj[tab]?.rxCommands?.giiiFix === 'FIX';
    if (state === 'red' && fixed) return 'CLOCK_NOT_COMPUTED';
    if (state === 'red' && !fixed) return 'NO_FIX_CLOCK_NOT_COMPUTED';
    return 'POS_NOT_FIXED';
  }

  posRAGColor(tab: TabId): string | undefined {
    return this.posragIndicatorColor[tab];
  }

  resetData(tab: TabId): void {
    this.positionStatusObj[tab] = {
      aveposData: {},
      posaveData: {},
      autoSurveyData: {},
      heading2: {},
      inspvax: {},
      insCommanddata: {},
      connectimu: {},
      spanState: '',
      dualAntennaAlign: {},
      wifiAlign: {},
      alignAutomation: {},
      rxCommands: {},
      timeSolution: {},
    };
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['positioning', 'POSITIONING'], ['position', 'POSITION'], ['operating-mode', 'OPERATING_MODE'],
      ['rtk', 'RTK'], ['ppp', 'PPP'], ['sbas', 'SBAS'], ['psrdiff-corr', 'PSRDIFF_CORR'],
      ['none-pos', 'NONE_POS'], ['single', 'SINGLE'], ['fixedpos', 'FIXEDPOS'], ['dgnss', 'DGNSS'],
      ['span', 'SPAN'], ['latitude', 'LATITUDE'], ['longitude', 'LONGITUDE'],
      ['height-ellipsoidal', 'HEIGHT_ELLIPSOIDAL'], ['height-msl', 'HEIGHT_MSL'],
      ['azimuth', 'AZIMUTH'], ['heading', 'HEADING'], ['2d-sd', '2D_SD'], ['datum', 'DATUM'],
      ['reference-station', 'REFERENCE_STATUS'], ['correction-age', 'CORRECTION_AGE'],
      ['height-accuracy', 'HEIGHT_ACCURACY'], ['course-ground', 'COURSE_OVER_GROUNG'],
      ['yaxis-scale', 'YAXIS_SCALE'], ['height-sd-status', 'HEIGHT_SD'], ['ins', 'INS'],
      ['positionstatusamber', 'POSITIONSTATUSAMBER'], ['insufficient_obs', 'INSUFFICIENT_OBS'],
      ['no_convergence', 'NO_CONVERGENCE'], ['invalid_fix', 'INVALID_FIX'],
      ['integrity_warning', 'INTEGRITY_WARNING'], ['ppp_intermediate_state', 'PPP_INTERMEDIATE_STATE'],
      ['survey_in_progress', 'SURVEY_IN_PROGRESS'], ['wide_int', 'WIDE_INT'],
      ['narrow_float', 'NARROW_FLOAT'], ['psrdiff', 'PSRDIFF'], ['transmit', 'TRANSMIT'],
      ['receive', 'RECEIVE'], ['standalone', 'STANDALONE'], ['transmit-fixedpos', 'TRANSMIT_FIXEDPOS'],
      ['solutions', 'SOLUTIONS'], ['clock_not_computed', 'CLOCK_NOT_COMPUTED'],
      ['pos_not_fixed', 'POS_NOT_FIXED'], ['clockinfo', 'CLOCK_INFO'],
      ['gal-clockinfo', 'GAL_CLOCK_INFO'], ['clock-model', 'CLOCK_MODEL'],
      ['clock-offset', 'CLOCK_OFFSET'], ['clock-offsetsd', 'CLOCK_OFFSETSD'],
      ['clock-drift', 'CLOCK_DRIFT'], ['clock-signaltype', 'CLOCK_SIGNAL_TYPE'],
    ];
    applyLanguageMarkers(this.ctx, [
      ...keys.map(([marker, key]) => ({ selector: `[data-lang-${marker}]`, value: __(this.ctx, key) })),
      {
        selector: '[data-lang-title-positionstatusred]',
        value: `${__(this.ctx, this.ctx.features(_tab ?? '').isGIII ? 'SOLUTIONS' : 'POSITIONING')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
      {
        selector: '[data-lang-title-positionstatusamber]',
        value: `${__(this.ctx, this.ctx.features(_tab ?? '').isGIII ? 'SOLUTIONS' : 'POSITIONING')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}`,
      },
      {
        selector: '[data-lang-title-solutionstatusred]',
        value: `${__(this.ctx, 'SOLUTIONS')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
      },
      {
        selector: '[data-lang-title-solutionstatusamber]',
        value: `${__(this.ctx, 'SOLUTIONS')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}`,
      },
    ]);
  }

  private ensure(tab: TabId): PositionEntry {
    let state = this.positionStatusObj[tab];
    if (!state) {
      state = {
        aveposData: {},
        posaveData: {},
        autoSurveyData: {},
        heading2: {},
        inspvax: {},
        insCommanddata: {},
        connectimu: {},
        spanState: '',
        dualAntennaAlign: {},
        wifiAlign: {},
        alignAutomation: {},
        rxCommands: {},
        timeSolution: {},
      };
      this.positionStatusObj[tab] = state;
    }
    return state;
  }

  private updateBestPos(tab: TabId, data: LogData): number {
    const copy = clone(data);
    if (!Object.prototype.hasOwnProperty.call(copy, 'solutionStatus')) {
      return updateFields(
        this.ctx,
        tab,
        'positionStatus',
        'latitude,longitude,height,undulation,operatingMode,datumId,standard2D,differentialAge,stationId,heightDeviation',
        copy,
      );
    }
    this.solutionStatus[tab] = copy.solutionStatus;
    this.positionType[tab] = copy.positionType;
    this.convergingFlag = !PPP_INTERMEDIATE.has(String(copy.positionType ?? ''));
    const activeMode =
      typeof copy.activePositionModes === 'string'
        ? copy.activePositionModes
        : String(copy.positionType ?? '');
    const configured = Array.isArray(copy.configuredPositionModes)
      ? copy.configuredPositionModes.map(String)
      : this.configuredPosModes[tab] ?? [];
    const computed2d = Math.sqrt(
      Math.pow(numberValue(copy.latitudeDeviation), 2) +
        Math.pow(numberValue(copy.longitudeDeviation), 2),
    );
    const values: LogData = {
      ...copy,
      tab,
      latitude:
        Number.isFinite(numberValue(copy.latitude, Number.NaN))
          ? `${formatNumber(this.ctx, copy.latitude, 7, tab)}°`
          : '--',
      longitude:
        Number.isFinite(numberValue(copy.longitude, Number.NaN))
          ? `${formatNumber(this.ctx, copy.longitude, 7, tab)}°`
          : '--',
      height: heightText(this.ctx, copy, tab),
      heightDeviation: angleText(this.ctx, copy.heightDeviation, tab).replace('°', this.ctx.distanceUnit()),
      differentialAge: `${formatNumber(this.ctx, copy.differentialAge, 2, tab)} s`,
      stationId: `"${String(copy.stationId)}"`,
      standard2D:
        copy.standard2D === undefined
          ? Number.isFinite(computed2d)
            ? `${formatNumber(this.ctx, computed2d, 2, tab)}${this.ctx.distanceUnit()}`
            : '--'
          : `${formatNumber(this.ctx, copy.standard2D, 2, tab)}${this.ctx.distanceUnit()}`,
    };
    const operatingElement = queryIn(this.ctx, tab, '#positionStatusoperatingMode');
    removeMarkers(operatingElement, [
      'data-lang-transmit-fixedpos',
      'data-lang-transmit',
      'data-lang-receive',
      'data-lang-standalone',
    ]);
    const positionType = String(copy.positionType ?? '');
    let operatingMode = String(copy.operatingMode ?? '');
    if (operatingMode === 'Transmit') {
      if (positionType === 'FIXEDPOS') {
        operatingElement?.setAttribute('data-lang-transmit-fixedpos', '');
        operatingMode = this.ctx.translate('TRANSMIT_FIXEDPOS');
      } else {
        operatingElement?.setAttribute('data-lang-transmit', '');
        operatingMode = this.ctx.translate('TRANSMIT');
      }
    } else if (operatingMode === 'Receive') {
      operatingElement?.setAttribute('data-lang-receive', '');
      operatingMode = this.ctx.translate('RECEIVE');
    } else if (operatingMode === 'Standalone') {
      operatingElement?.setAttribute('data-lang-standalone', '');
      operatingMode = this.ctx.translate('STANDALONE');
    }
    if (
      positionType === 'FIXEDPOS' &&
      this.configuredPosModes[tab]?.length &&
      !this.configuredPosModes[tab].includes('RTK BASE')
    ) {
      operatingElement?.setAttribute('data-lang-standalone', '');
      operatingMode = this.ctx.translate('STANDALONE');
    }
    values.operatingMode = operatingMode;
    const result = updateFields(
      this.ctx,
      tab,
      'positionStatus',
      'latitude,longitude,height,operatingMode,datumId,standard2D,differentialAge,stationId,heightDeviation',
      values,
    );
    this.updatePositionModes(configured, activeMode, tab, MSG_ID.BESTPOS);
    return result;
  }

  private updateRag(tab: TabId, configured: string[], active: string): void {
    const solution = String(this.solutionStatus[tab] ?? '');
    let state = 'good';
    const mappedActive =
      active === 'NTRIP CLIENT' || active === 'NTRIP SERVER'
        ? 'RTK'
        : active === 'PSRDIFF ROVER'
          ? 'DGNSS'
          : active;
    if (BAD_SOLUTIONS.has(solution)) state = 'bad';
    else if (!this.convergingFlag || this.positionStatusObj[tab]?.aveposData?.posaveStatus === 'INPROGRESS') state = 'warning';
    else if (
      configured.includes('PSRDIFF ROVER') &&
      (mappedActive.includes('single') || mappedActive.includes('SINGLE'))
    ) {
      state = 'warning';
    } else if (
      configured.includes('PSRDIFF ROVER') &&
      mappedActive.includes('DGNSS') &&
      configured.includes('RTK ROVER')
    ) {
      state = 'warning';
    } else if (configured.includes('PSRDIFF ROVER')) {
      state = 'good';
    }
    else if (!configured.includes('PSRDIFF ROVER') && configured.length) {
      const order = ['RTK', 'PPP', 'PSRDIFF', 'SBAS'];
      const configuredModes = configured
        .map((entry) =>
          entry === 'NTRIP CLIENT' || entry === 'NTRIP SERVER'
            ? 'RTK'
            : entry.replace(/BASE|ROVER/gi, '').trim(),
        );
      const mode = order.find((entry) => configuredModes.includes(entry));
      if (mode) {
        const activeMode = mappedActive.replace(/BASE|ROVER/gi, '').trim();
        state = activeMode.includes(mode) ? 'good' : 'warning';
        if (activeMode === 'RTK' && ['WIDE_INT', 'PSRDIFF', 'NARROW_FLOAT'].includes(String(this.positionType[tab]))) {
          state = 'warning';
        }
      }
    }
    this.posragIndicatorColor[tab] = state;
    showRag(this.ctx, tab, 'positionStatus', state);
  }

  private renderSpanState(tab: TabId): number {
    const state = this.ensure(tab);
    const inspvax = state.inspvax;
    const imuType = String(state.connectimu.IMUType ?? '');
    const command = String(state.insCommanddata.switch ?? '');
    let spanstatus = 'OFF';
    if (Object.keys(state.connectimu).length && state.insCommanddata && state.insCommanddata.switch !== undefined) {
      if (imuType !== 'UNKNOWN' && command === 'ENABLE') {
        const good = String(inspvax.status ?? '') === 'INS_SOLUTION_GOOD';
        if (good) {
          spanstatus = INS_SOLUTIONS.has(String(this.positionType[tab] ?? ''))
            ? this.ctx.translate('AIDING')
            : this.ctx.translate('READY');
        } else {
          spanstatus = this.ctx.translate('INACTIVE');
        }
      } else if (
        imuType !== 'UNKNOWN' &&
        ['RESET', 'RESTART', 'START_NO_TIME', 'START_FINE_TIME'].includes(command)
      ) {
        spanstatus = this.ctx.translate('INACTIVE');
      }
    }
    state.spanState = spanstatus;
    if (!Object.keys(inspvax).length) return 0;
    const azimuthValid = new Set([
      'INS_ALIGNMENT_COMPLETE',
      'INS_SOLUTION_GOOD',
      'INS_HIGH_VARIANCE',
      'INS_SOLUTION_FREE',
    ]);
    const displayStatus = String(inspvax.status ?? '');
    const result = updateFields(
      this.ctx,
      tab,
      'positionStatus',
      'spanstatus,azimuth',
      {
        ...inspvax,
        tab,
        spanstatus,
        azimuth: azimuthValid.has(displayStatus) ? angleText(this.ctx, inspvax.azimuth, tab) : '--',
      },
    );
    updateFields(this.ctx, tab, 'statusBar', 'spanstatus', {
      ...inspvax,
      tab,
      spanstatus,
    });
    return result;
  }

  private renderAlignment(tab: TabId, data: LogData): number {
    const state = this.ensure(tab);
    const heading2 = Object.keys(state.heading2 ?? {}).length ? state.heading2 : data;
    let status = 'Disabled';
    if (state.dualAntennaAlign.switch === 'ENABLE' || state.wifiAlign.option === 'ENABLE' || state.alignAutomation.option === 'ENABLE') {
      status = (heading2.solStatus as unknown) == 0 ? 'Active' : 'Inactive';
    }
    return updateFields(
      this.ctx,
      tab,
      'positionStatus',
      'heading,pitch,length,headingTitle,hdgStdDev,ptchStdDev',
      {
        ...heading2,
        tab,
        heading: status === 'Active' ? angleText(this.ctx, heading2.heading, tab) : '--',
        headingTitle: status,
        pitch: status === 'Active' ? angleText(this.ctx, heading2.pitch, tab) : '--',
        length: status === 'Active' ? `${formatNumber(this.ctx, heading2.length, 2, tab)}${this.ctx.distanceUnit()}` : '--',
        hdgStdDev: angleText(this.ctx, heading2.hdgStdDev, tab),
        ptchStdDev: angleText(this.ctx, heading2.ptchStdDev, tab),
      },
    );
  }

  private updateSurveyProgress(tab: TabId): void {
    const state = this.positionStatusObj[tab];
    if (!state || state.aveposData.posaveStatus !== 'INPROGRESS') {
      setStyle(queryIn(this.ctx, tab, '.rtk-progress'), 'display', 'none');
      return;
    }
    const toHms = (seconds: number): string => {
      const hours = Math.floor(Math.max(0, seconds) / 3600);
      const minutes = Math.floor((Math.max(0, seconds) % 3600) / 60);
      const secs = Math.floor(Math.max(0, seconds) % 60);
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };
    let text: string;
    if (Object.keys(state.autoSurveyData ?? {}).length) {
      const target = numberValue(state.autoSurveyData.time) * 60;
      text = toHms(target - numberValue(state.aveposData.avetime));
      if (
        state.autoSurveyData.control === 'ENABLE' &&
        state.aveposData.posaveStatus === 'ON'
      ) {
        text = toHms(
          Math.max(target, numberValue(state.aveposData.avetime) * 3600),
        );
      }
    } else if (Object.keys(state.posaveData ?? {}).length) {
      const target = numberValue(state.posaveData.posavetime) * 3600;
      text = toHms(target - numberValue(state.aveposData.avetime));
      if (
        numberValue(state.posaveData.control) === 1 &&
        state.aveposData.posaveStatus === 'ON'
      ) {
        text = toHms(
          Math.max(target, numberValue(state.aveposData.avetime) * 3600),
        );
      }
    } else {
      const hours = Math.trunc(numberValue(state.aveposData.avetime));
      const minutes = Math.round(
        (numberValue(state.aveposData.avetime) - hours) * 60,
      );
      text = `${hours}:${minutes}`;
    }
    this.remainingSurveyTime[tab] = text;
    setStyle(queryIn(this.ctx, tab, '.rtk-progress'), 'display', 'block');
    setText(
      this.ctx,
      tab,
      '.remaining-surveytime',
      `${__(this.ctx, 'READY_IN')}: ${text}`,
    );
  }

  private updateGiiRag(tab: TabId): void {
    const state = this.ensure(tab);
    const clock = String(state.timeSolution.clockModel ?? '');
    const values = this.clockComputed[tab];
    const allComputed = values ? Object.values(values).indexOf('Not Computed') === -1 : true;
    const stateName = clock === 'Not Computed' || !allComputed ? 'bad' : state.rxCommands.giiiFix === 'FIX' ? 'good' : 'warning';
    this.posragIndicatorColor[tab] = stateName;
    showRag(this.ctx, tab, 'solutionStatus', stateName);
  }
}
