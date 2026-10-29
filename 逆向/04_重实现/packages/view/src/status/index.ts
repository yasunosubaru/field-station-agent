import type { TabId } from '../types.ts';
import { AgcStatus } from './agcStatus.ts';
import { AlignStatus } from './alignStatus.ts';
import {
  MSG_ID,
  normalizeLog,
  type LogData,
  type StatusContext,
} from './common.ts';
import { DeviceInfo } from './deviceInfo.ts';
import { InterferenceStatus } from './interferenceStatus.ts';
import { LogStatus } from './logStatus.ts';
import { LonghornStatusUI } from './longhornStatusUI.ts';
import { PortStatus } from './portStatus.ts';
import { PositionStatus } from './positionStatus.ts';
import { PppCorrections } from './pppCorrections.ts';
import { RadioStatus } from './radioStatus.ts';
import { SatelliteTracking } from './satelliteTracking.ts';
import { SatelliteView } from './satelliteView.ts';
import { SpanStatus } from './spanStatus.ts';
import { StatusBar } from './statusBar.ts';

export interface StatusBundle {
  statusBar: StatusBar;
  positionStatus: PositionStatus;
  portStatus: PortStatus;
  deviceInfo: DeviceInfo;
  spanStatus: SpanStatus;
  alignStatus: AlignStatus;
  radioStatus: RadioStatus;
  interferenceStatus: InterferenceStatus;
  logStatus: LogStatus;
  agcStatus: AgcStatus;
  pppCorrections: PppCorrections;
  satelliteView: SatelliteView;
  satelliteTracking: SatelliteTracking;
  longhornStatusUI: LonghornStatusUI;
}

export function createStatusBundle(context: StatusContext): StatusBundle {
  const positionStatus = new PositionStatus(
    context,
    (tab, msgId) => statusBar.editRagIndicatorObject(tab, msgId),
  );
  const deviceInfo = new DeviceInfo(
    context,
    (tab, msgId) => statusBar.editRagIndicatorObject(tab, msgId),
    (data) => statusBar.getInternalFlashOnly(data),
  );
  const spanStatus = new SpanStatus(
    context,
    (tab, msgId) => statusBar.editRagIndicatorObject(tab, msgId),
  );
  const interferenceStatus = new InterferenceStatus(
    context,
    (tab) => statusBar.getitDetectConfigData(tab),
  );
  const logStatus = new LogStatus(context, (tab, msgId) =>
    statusBar.editRagIndicatorObject(tab, msgId),
  );
  const pppCorrections = new PppCorrections(
    context,
    (tab, msgId) => statusBar.editRagIndicatorObject(tab, msgId),
  );
  const statusBar = new StatusBar(context, {
    position: (tab) => positionStatus.posRAGColor(tab),
    span: (tab) => spanStatus.spanRAGColor(tab),
    device: (tab) => deviceInfo.deviceInfoRAGColor(tab),
    interference: (tab) => interferenceStatus.ITKRagColor(tab),
    logging: (tab) => logStatus.loggingRAGColor(tab),
    positionMessages: (tab, colour) =>
      context.features(tab).isGIII
        ? positionStatus.decodeGIIIPositionStatusRagMessages(
            tab,
            colour === 'yellow' ? 'amber' : colour,
          )
        : positionStatus.decodePositionStatusRagMessages(tab, colour),
    spanMessages: (tab) => spanStatus.decodeSPANRagMessages(tab),
    deviceMessages: (tab) => deviceInfo.decodeDeviceStatusRagMessages(tab),
    longhornDeviceMessages: (tab) =>
      longhornStatusUI.decodeDeviceStatusRagMessages(tab),
  });
  const satelliteView = new SatelliteView(context);
  const satelliteTracking = new SatelliteTracking(context);
  satelliteTracking.setPositionStatusSource((tab) => ({
    giiiFix: String(positionStatus.positionStatusObj[tab]?.rxCommands?.giiiFix ?? ''),
    clockComputed: positionStatus.clockComputed[tab] ?? {},
  }));
  const longhornStatusUI = new LonghornStatusUI(context);
  satelliteView.setGoodCountSource((tab) =>
    Object.values(satelliteTracking.satelliteCountData[tab] ?? {}).reduce((sum, value) => sum + value, 0),
  );
  satelliteTracking.setGoodCountListener((tab, count) => satelliteView.updateSatViewStatus(count, tab));
  longhornStatusUI.setSatelliteSnapshotListener((tab, rows, goodCount) => {
    satelliteView.updateExternalSatellites(rows, tab, goodCount);
  });
  return {
    statusBar,
    positionStatus,
    portStatus: new PortStatus(context),
    deviceInfo,
    spanStatus,
    alignStatus: new AlignStatus(context),
    radioStatus: new RadioStatus(context),
    interferenceStatus,
    logStatus,
    agcStatus: new AgcStatus(context),
    pppCorrections,
    satelliteView,
    satelliteTracking,
    longhornStatusUI,
  };
}

const STATUS_BAR_IDS = new Set<number>([
  MSG_ID.INTERFACEMODE,
  MSG_ID.VERSION,
  MSG_ID.BESTPOS,
  MSG_ID.PORTSTATS,
  MSG_ID.RXSTATUS,
  MSG_ID.TIME,
  379,
  963,
  MSG_ID.SATVIS2,
  MSG_ID.CHANCONFIGLIST,
  MSG_ID.NTRIPCONFIG,
  MSG_ID.CONNECTIMU,
  MSG_ID.INSPVAX,
  MSG_ID.ASSIGNLBANDBEAM,
  MSG_ID.ITDETECTSTATUS,
  MSG_ID.FILESYSTEMCAPACITY,
  MSG_ID.ITDETECTCONFIG,
  MSG_ID.SKDETECTCONFIG,
  MSG_ID.GIII_CARDSTATUS,
  MSG_ID.GIII_TIMESOLUTION,
]);

export function channelsForMessage(messageId: number): string[] {
  const channels: string[] = [];
  if (STATUS_BAR_IDS.has(messageId)) channels.push('statusBar');
  if ([MSG_ID.BESTPOS, 379, MSG_ID.HEADING2, MSG_ID.CONNECTIMU, MSG_ID.INSPVAX, MSG_ID.AVEPOS, MSG_ID.POSAVE, MSG_ID.AUTOSURVEY, MSG_ID.DUALANTENNAALIGN, MSG_ID.WIFIALIGNAUTOMATION, MSG_ID.ALIGNAUTOMATION].includes(messageId)) {
    channels.push('positionStatus');
  }
  if (
    [
      MSG_ID.LBANDTRACKSTAT,
      MSG_ID.TERRASTARINFO,
      MSG_ID.VERIPOSINFO,
      MSG_ID.TERRASTARSTATUS,
      MSG_ID.VERIPOSDECODERSTATUS,
      MSG_ID.OCEANIXINFO,
      MSG_ID.OCEANIXSTATUS,
      MSG_ID.NTRIPCONFIG,
      MSG_ID.INTERFACEMODE,
      MSG_ID.ASSIGNLBANDBEAM,
    ].includes(messageId)
  ) {
    channels.push('pppCorrections');
  }
  if ([MSG_ID.INTERFACEMODE, MSG_ID.LOGLIST, MSG_ID.PORTSTATS, MSG_ID.RXSTATUS, MSG_ID.SERIALCONFIG].includes(messageId)) {
    channels.push('portStatus');
  }
  if ([MSG_ID.LOGLIST, MSG_ID.FILESTATUS].includes(messageId)) channels.push('logStatus');
  if ([MSG_ID.RXSTATUS, 963, MSG_ID.FILESYSTEMCAPACITY, MSG_ID.GIII_CARDSTATUS].includes(messageId)) channels.push('deviceInfo');
  if ([MSG_ID.RXSTATUS, MSG_ID.INSPVAX, 379, MSG_ID.CONNECTIMU].includes(messageId)) channels.push('spanStatus');
  if ([MSG_ID.HEADING2, MSG_ID.DUALANTENNAALIGN, MSG_ID.WIFIALIGNAUTOMATION, MSG_ID.ALIGNAUTOMATION].includes(messageId)) {
    channels.push('alignStatus');
  }
  if ([MSG_ID.SATELSTATUS, MSG_ID.SATELDETECT].includes(messageId)) channels.push('radioStatus');
  if (messageId === MSG_ID.ITDETECTSTATUS) channels.push('interferenceStatus');
  if (messageId === MSG_ID.AGCINFO) channels.push('agcStatus');
  if (messageId === MSG_ID.GIII_RXCOMMANDS || messageId === MSG_ID.GIII_TIMESOLUTION) {
    channels.push('solutionStatus');
  }
  if ([MSG_ID.BESTPOS, MSG_ID.TRACKSTAT, MSG_ID.PSRDOP, MSG_ID.SATVIS2, MSG_ID.BESTSATS, MSG_ID.LBANDTRACKSTAT, MSG_ID.LBANDBEAMTABLE, MSG_ID.GIII_SATPOS, MSG_ID.GIII_MEASUREMENTDATA].includes(messageId)) {
    channels.push('satelliteView');
  }
  if (
    [
      MSG_ID.BESTPOS,
      MSG_ID.ECUTOFF,
      MSG_ID.TRACKSTAT,
      MSG_ID.RXSTATUS,
      MSG_ID.SATVIS2,
      MSG_ID.GALECUTOFF,
      MSG_ID.CHANCONFIGLIST,
      MSG_ID.LBANDTRACKSTAT,
      MSG_ID.QZSSECUTOFF,
      MSG_ID.BDSECUTOFF,
      MSG_ID.LBANDBEAMTABLE,
      MSG_ID.NAVICECUTOFF,
      MSG_ID.GIII_MEASUREMENTDATA,
      MSG_ID.GIII_RXCOMMANDS,
      MSG_ID.GIII_SATPOS,
    ].includes(messageId)
  ) {
    channels.push('satelliteTracking');
  }
  return channels;
}

export function decodePayloadForStatus(messageId: number, input: unknown, tab: TabId): LogData {
  return {
    ...normalizeLog(input),
    tab,
    messageId,
  };
}

export {
  AgcStatus,
  AlignStatus,
  DeviceInfo,
  InterferenceStatus,
  LogStatus,
  LonghornStatusUI,
  PortStatus,
  PositionStatus,
  PppCorrections,
  RadioStatus,
  SatelliteTracking,
  SatelliteView,
  SpanStatus,
  StatusBar,
};
export * from './common.ts';

