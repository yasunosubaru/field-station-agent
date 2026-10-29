import {
  MSG_ID,
  clone,
  normalizeLog,
  numberValue,
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

interface SpanEntry {
  inspvaxData: LogData;
  connectIMUData: LogData;
  insCommandData: LogData;
  rxStatusData: LogData & { status?: string[] };
}

const GREEN = new Set(['INS_SOLUTION_GOOD']);
const RED = new Set(['INS_HIGH_VARIANCE']);
const IDLE = new Set(['INS_INACTIVE']);
const AMBER = new Set([
  'WAITING_ALIGNMENTORIENTATION',
  'INS_ALIGNING',
  'INS_SOLUTION_FREE',
  'INS_ALIGNMENT_COMPLETE',
  'DETERMINING_ORIENTATION',
  'WAITING_INITIALPOS',
  'WAITING_AZIMUTH',
  'INITIALIZING_BIASES',
  'MOTION_DETECT',
]);
const AZIMUTH_VALID = new Set(['INS_ALIGNMENT_COMPLETE', 'INS_SOLUTION_GOOD', 'INS_HIGH_VARIANCE', 'INS_SOLUTION_FREE']);
const SPAN_STATUS_STRING: Record<string, string> = {
  INS_ALIGNING: 'INS Aligning',
  INS_SOLUTION_FREE: 'INS Solution Free',
  INS_ALIGNMENT_COMPLETE: 'INS Alignment Complete',
  DETERMINING_ORIENTATION: 'Determining Orientation',
  WAITING_INITIALPOS: 'Waiting for Initial Pos',
  WAITING_AZIMUTH: 'Waiting For Azimuth',
  INITIALIZING_BIASES: 'Initializing Biases',
  MOTION_DETECT: 'Motion Detect',
  INS_HIGH_VARIANCE: 'High INS Variance',
  INS_INACTIVE: 'INS Inactive',
  INS_SOLUTION_GOOD: 'INS Solution Good',
};

export class SpanStatus {
  readonly spanStatusObj: Record<TabId, SpanEntry> = {};
  readonly spanRAGIndicatorColor: Record<TabId, string | undefined> = {};
  private readonly ctx: StatusContext;
  private readonly markRag: (tab: TabId, msgId: number) => void;

  constructor(ctx: StatusContext, markRag: (tab: TabId, msgId: number) => void = () => {}) {
    this.ctx = ctx;
    this.markRag = markRag;
  }

  updateSpanStatus(msgID: number, input: unknown): number {
    const data = normalizeLog(input);
    const tab = tabOf(data);
    if (!tab) return 0;
    const state = this.ensure(tab);
    this.markRag(tab, msgID);
    if (msgID === MSG_ID.RXSTATUS) {
      const status: string[] = [];
      if (numberValue(data.rxstatus17Bit) === 1) status.push('SPAN_IMU_COMMUNICATION_FAILURE');
      if (numberValue(data.aux1status30Bit) === 1) status.push('SPAN_IMU_STATUS_ERROR');
      if (numberValue(data.aux1status31Bit) === 1) status.push('SPAN_IMU_MEASUREMENT_OUTLIER');
      state.rxStatusData = { ...clone(data), status };
    } else if (msgID === MSG_ID.INSPVAX) {
      const display = clone(data);
      const status = String(display.status ?? '');
      if (!AZIMUTH_VALID.has(status)) display.azimuth = '--';
      if (IDLE.has(status)) {
        for (const key of [
          'azimuth',
          'pitch',
          'roll',
          'rollDev',
          'pitchDev',
          'azimuthDev',
          'northVelocity',
          'upVelocity',
          'eastVelocity',
          'northVelDev',
          'upVelDev',
          'eastVelDev',
          'latitude',
          'longitude',
          'height',
          'latDev',
          'longDev',
          'heightDev',
        ]) {
          display[key] = '--';
        }
      }
      display.statusStr = SPAN_STATUS_STRING[String(display.status)] ?? undefined;
      display.posType = String(display.posType ?? '').replace(/_/g, ' ');
      state.inspvaxData = display;
      const result = updateFields(
        this.ctx,
        tab,
        'spanStatus',
        [
          'posType',
          'northVelocity',
          'roll',
          'pitch',
          'azimuth',
          'rollDev',
          'pitchDev',
          'azimuthDev',
          'statusStr',
          'upVelocity',
          'eastVelocity',
          'latitude',
          'longitude',
          'height',
          'latDev',
          'longDev',
          'heightDev',
          'northVelDev',
          'eastVelDev',
          'upVelDev',
        ].join(','),
        display,
      );
      this.refresh(tab);
      return result;
    } else if (msgID === MSG_ID.CONNECTIMU) {
      state.connectIMUData = clone(data);
    } else if (msgID === 379) {
      state.insCommandData = clone(data);
    } else {
      return 0;
    }
    this.refresh(tab);
    return 1;
  }

  decodeSPANRagMessages(tab: TabId): string[] {
    const state = this.spanStatusObj[tab];
    if (!state) return [];
    const base = state.rxStatusData.status ?? [];
    const status = String(state.inspvaxData.status ?? '');
    return !GREEN.has(status) ? [status, ...base] : [...base];
  }

  spanRAGColor(tab: TabId): string | undefined {
    return this.spanRAGIndicatorColor[tab];
  }

  resetData(tab: TabId): void {
    this.spanStatusObj[tab] = {
      inspvaxData: {},
      connectIMUData: {},
      insCommandData: {},
      rxStatusData: {},
    };
  }

  processLanguage(_tab?: TabId): void {
    const keys: Array<[string, string]> = [
      ['span-status', 'SPAN_OFF'], ['why-this-amber', 'WHY_IS_THIS_AMBER'],
      ['why-this-red', 'WHY_IS_THIS_RED'],
      ['switch-on-via-configuration', 'SWITCH_ON_VIA_CONFIGURATION'],
      ['status', 'STATUS'], ['azimuth', 'AZIMUTH'], ['pitch', 'PITCH'], ['roll', 'ROLL'],
      ['north-velocity', 'NORTH_VELOCITY'], ['east-velocity', 'EAST_VELOCITY'],
      ['up-velocity', 'UP_VELOCITY'], ['need-help', 'NEED_HELP'], ['setup', 'SETUP'],
      ['ins_aligning', 'INS_ALIGNING'], ['ins_solution_free', 'INS_SOLUTION_FREE'],
      ['ins_alignment_complete', 'INS_ALIGNMENT_COMPLETE'],
      ['determining_orientation', 'DETERMINING_ORIENTATION'],
      ['waiting_initialpos', 'WAITING_INITIALPOS'], ['waiting_azimuth', 'WAITING_AZIMUTH'],
      ['ins_inactive', 'INS_INACTIVE'], ['ins_high_variance', 'INS_HIGH_VARIANCE'],
      ['waiting_alignmentorientation', 'WAITING_ALIGNMENTORIENTATION'],
      ['initializing_biases', 'INITIALIZING_BIASES'], ['motion_detect', 'MOTION_DETECT'],
      ['span_imu_communication_failure', 'SPAN_IMU_COMMUNICATION_FAILURE'],
      ['span_imu_status_error', 'SPAN_IMU_STATUS_ERROR'],
      ['span_imu_measurement_outlier', 'SPAN_IMU_MEASUREMENT_OUTLIER'],
      ['converged', 'CONVERGED'], ['alignment', 'ALIGNMENT'], ['position', 'POSITION'],
      ['error', 'ERROR'], ['good', 'GOOD'], ['warning', 'WARNING'], ['idle', 'IDLE'],
    ];
    applyLanguageMarkers(
      this.ctx,
      keys.map(([marker, key]) => ({
        selector: `[data-lang-${marker}]`,
        value: __(this.ctx, key).replace('%1', '<br>'),
      })).concat([
        {
          selector: '[data-lang-title-spanstatusred]',
          value: `${__(this.ctx, 'SPAN')} - ${__(this.ctx, 'WHY_IS_THIS_RED')}`,
        },
        {
          selector: '[data-lang-title-spanstatusamber]',
          value: `${__(this.ctx, 'SPAN')} - ${__(this.ctx, 'WHY_IS_THIS_AMBER')}`,
        },
      ]),
    );
  }

  private ensure(tab: TabId): SpanEntry {
    return (this.spanStatusObj[tab] ??= {
      inspvaxData: {},
      connectIMUData: {},
      insCommandData: {},
      rxStatusData: {},
    });
  }

  private refresh(tab: TabId): void {
    const state = this.ensure(tab);
    const ins = String(state.insCommandData.switch ?? '');
    const active =
      (state.connectIMUData.IMUType && state.connectIMUData.IMUType !== 'UNKNOWN' &&
        ['ENABLE', 'RESET', 'RESTART', 'START_NO_TIME', 'START_FINE_TIME'].includes(ins)) ||
      (this.ctx.connectionType(tab) === 'playback' &&
        Object.keys(state.inspvaxData).length > 0 &&
        !Object.keys(state.insCommandData).length);
    if (!active) {
      this.spanRAGIndicatorColor[tab] = 'idle';
      showRag(this.ctx, tab, 'spanStatus', 'idle');
      setStyle(this.ctx.document.querySelector(`#${tab} .span-fields`), 'display', 'none');
      setStyle(this.ctx.document.querySelector(`#${tab} .switch-span-config`), 'display', 'block');
      return;
    }
    const status = String(state.inspvaxData.status ?? '');
    let rag = 'idle';
    if (state.rxStatusData.rxstatus17Bit === 1 || RED.has(status) || IDLE.has(status)) rag = 'bad';
    else if (
      state.rxStatusData.aux1status30Bit === 1 ||
      state.rxStatusData.aux1status31Bit === 1 ||
      AMBER.has(status)
    ) {
      rag = 'warning';
    } else if (GREEN.has(status) && (state.rxStatusData.status?.length ?? 0) === 0) {
      rag = 'good';
    }
    this.spanRAGIndicatorColor[tab] = rag;
    showRag(this.ctx, tab, 'spanStatus', rag);
    setStyle(this.ctx.document.querySelector(`#${tab} .span-fields`), 'display', 'block');
    setStyle(this.ctx.document.querySelector(`#${tab} .switch-span-config`), 'display', 'none');
  }
}
