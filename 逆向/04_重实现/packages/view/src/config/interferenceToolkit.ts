/**
 * Tools ▸ Interference Toolkit (manual §2.2.9) — the detections it reports and the six settings it
 * writes.
 *
 * The shipped component (`view/interferenceToolKit/*`) is a spectrum *plotter*: it streams
 * `ITPSDFINAL` (#1968, 1024 bins per record) / `ITPSDDETECT` (#2063), draws a 2-D or 3-D trace with
 * Plotly, and its Settings pane writes `ITDETECTCONFIG`, `ITFRONTENDMODE`, `ITSPECTRALANALYSIS`,
 * `ITBANDPASSCONFIG` and friends. The plot cannot be reproduced from a capture, and a plot drawn
 * from invented samples would be a lie, so the plot stays out. What the page *does* show is:
 *
 *   - the **detections** of `ITDETECTSTATUS` (#2065) — band, detector, centre frequency, the four
 *     parameters and the two severity words, one row per `interference_statuses[i]`;
 *   - the shipped **"No interference detected"** state, for a record whose status count is 0
 *     (`;0*…` — 9 of the b7 capture's 47 records are exactly that);
 *   - the **configuration** the receiver reports: `ITDETECTCONFIG` (#2143, the Interference Toolkit
 *     switch), `ITWARNINGCONFIG` (#2289), `ITFRONTENDMODE` (#2039, HDR mode),
 *     `ITSPECTRALANALYSIS` (#1967, the Advanced Settings), `ITBANDPASSCONFIG` (#1999) and
 *     `ITPROGFILTCONFIG` (#2000) — from a capture, and from the live link's read-back once one of
 *     the six settings below has been written;
 *   - **six write controls** (Detection / Warning level / Spectral analysis / HDR / Bandpass /
 *     Programmable filter). Each Apply frames the same data map the shipped page builds
 *     (`frameItSpectralAnalysisDataMap` and friends) and sends it as the receiver's own
 *     abbreviated-ASCII line — see `itkCommandLine`.
 *
 * The pieces the page cannot fill print `--` **and say why** (see `ItkCaptureSummary.missing`).
 *
 * `ITDETECTSTATUS` is a **text** record on this receiver (`#ITDETECTSTATUSA`), so it never reaches
 * the live decoder: the rows are handed over by the host from a capture
 * (`packages/app/src/config-http.ts#feedItkCapture`). The six `IT*CONFIG` records *are* decodable
 * and the live link renders them (`<ITWARNINGCONFIGA,…,;3,0*…`), so the read-back arrives as text
 * and is parsed here (`itkRecordOf`) rather than through `config-feed.ts#configSliceOf`, whose
 * per-id branches are other pages' field names.
 */

import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  elementValue,
  scopedQuery,
  scopedQueryAll,
  setValue,
  setVisible,
} from './base.ts';

export const ITK_MSG = {
  ITDETECTSTATUS: 2065,
  ITDETECTCONFIG: 2143,
  ITWARNINGCONFIG: 2289,
  ITSPECTRALANALYSIS: 1967,
  ITFRONTENDMODE: 2039,
  ITBANDPASSCONFIG: 1999,
  ITPROGFILTCONFIG: 2000,
} as const;

/* ------------------------------------------------------------------ the six write commands */

/**
 * The enum tables the six `IT*CONFIG` commands take, copied from
 * `01_解包/app/model/NovatelIdConstants.js#commandsAndEnums` (`itdetectconfig` :1774,
 * `itbandpassconfig` :2307, `itprogfiltconfig` :2265, `itfrontendmode` :2340,
 * `itspectralanalysis` :2354) — not invented: the shipped page indexes these very tables when it
 * turns a `<select>` label into a binary field (`genericConfig.js:176`), and `ITWARNINGCONFIG` is
 * the manual's own `0..3` (`OEM7 Commands and Logs Reference Manual §2.78`).
 *
 * `Reserved: 4` is left out of the frequency list: a receiver rejects it, so offering it would only
 * produce an `<ERROR` the page then has to explain.
 */
export const ITK_FREQUENCY_TOKENS = [
  'GPSL1',
  'GPSL2',
  'GLONASSL1',
  'GLONASSL2',
  'GPSL5',
  'LBAND',
  'GALILEOE1',
  'GALILEOE5A',
  'GALILEOE5B',
  'GALILEOALTBOC',
  'BEIDOUB1',
  'BEIDOUB2',
  'QZSSL1',
  'QZSSL2',
  'QZSSL5',
  'QZSSL6',
  'GALILEOE6',
  'BEIDOUB3',
  'GLONASSL3',
  'NAVICL5',
  'BEIDOUB1C',
  'BEIDOUB2A',
  'BEIDOUB2B',
] as const;

/** `ITSPECTRALANALYSIS mode` (`itspectralanalysis.mode`, binary 0–3). */
export const ITK_SPECTRAL_MODES = ['PREDECIMATION', 'POSTDECIMATION', 'POSTFILTER', 'OFF'] as const;
/** `ITSPECTRALANALYSIS FFTsize` (`itspectralanalysis.fftSize`, binary 0–6). */
export const ITK_FFT_SIZES = ['1K', '2K', '4K', '8K', '16K', '32K', '64K'] as const;
/** `ITDETECTCONFIG RFPath` (`itdetectconfig.rfpath`, binary 0–4). */
export const ITK_DETECT_PATHS = ['ALL', 'NONE', 'L1', 'L2', 'L5'] as const;
/** `ITFRONTENDMODE frequencyBand` (`itfrontendmode.frequencyBand`); the ASCII token is `LBAND`. */
export const ITK_FRONTEND_BANDS = ['L1', 'L2', 'L5', 'LBAND'] as const;
/** `ITFRONTENDMODE mode` (`itfrontendmode.mode`). */
export const ITK_FRONTEND_MODES = ['CIC3', 'HDR'] as const;
/** `ITPROGFILTCONFIG filterid` (`itprogfiltconfig.filterId`). */
export const ITK_FILTER_IDS = ['PF0', 'PF1'] as const;
/** `itbandpassconfig.filterSwitch` / `itprogfiltconfig.filterSwitch`. */
export const ITK_FILTER_SWITCHES = ['ENABLE', 'DISABLE'] as const;
/** `ITPROGFILTCONFIG filtermode` (`itprogfiltconfig.filterMode`). */
export const ITK_FILTER_MODES = ['NOTCHFILTER', 'BANDPASSFILTER', 'NONE'] as const;
/** `ITWARNINGCONFIG WarningLevel`: 0 = most sensitive, 3 = least (§2.78). */
export const ITK_WARNING_LEVELS = ['0', '1', '2', '3'] as const;

/** The reverse direction, for parsing a read-back body that prints numbers instead of names. */
function enumNameOf(table: Record<string, number>, token: string): string {
  const text = String(token ?? '').trim();
  if (text === '') return '';
  const upper = text.toUpperCase();
  if (upper in table) return upper;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    for (const [name, value] of Object.entries(table)) if (value === numeric) return name;
  }
  return upper;
}

const RF_PATH_BY_NAME: Record<string, number> = { NONE: 0, ALL: 1, L1: 2, L2: 3, L5: 4 };
const FREQUENCY_BY_NAME: Record<string, number> = Object.fromEntries(
  ITK_FREQUENCY_TOKENS.map((name, index) => [name, index < 4 ? index : index + 1]),
);
const SPECTRAL_MODE_BY_NAME: Record<string, number> = {
  OFF: 0,
  PREDECIMATION: 1,
  POSTDECIMATION: 2,
  POSTFILTER: 3,
};
const FFT_SIZE_BY_NAME: Record<string, number> = Object.fromEntries(
  ITK_FFT_SIZES.map((name, index) => [name, index]),
);
/** `itfrontendmode.frequencyBand` is the only table that is not `0..n`: `L1` is 2, `LBand` is 4. */
const FRONTEND_BAND_BY_NAME: Record<string, number> = { L1: 2, L2: 3, LBAND: 4, L5: 5 };
const FRONTEND_MODE_BY_NAME: Record<string, number> = { CIC3: 0, HDR: 1 };
const FILTER_ID_BY_NAME: Record<string, number> = { PF0: 0, PF1: 1 };
const FILTER_SWITCH_BY_NAME: Record<string, number> = { DISABLE: 0, ENABLE: 1 };
const FILTER_MODE_BY_NAME: Record<string, number> = { NOTCHFILTER: 0, BANDPASSFILTER: 1, NONE: 2 };

/** What one of the six Apply buttons sends. `spectralStop` is the shipped `ITSPECTRALANALYSIS OFF`. */
export type ItkWriteSection =
  | 'detect'
  | 'warning'
  | 'spectral'
  | 'spectralStop'
  | 'hdr'
  | 'bandpass'
  | 'progFilter';

/** The six records' names, ids and the `LOG` request that reads each one back. */
export const ITK_RECORDS: ReadonlyArray<{ messageId: number; name: string; label: string }> = [
  { messageId: ITK_MSG.ITDETECTCONFIG, name: 'ITDETECTCONFIG', label: 'Detection' },
  { messageId: ITK_MSG.ITWARNINGCONFIG, name: 'ITWARNINGCONFIG', label: 'Warning level' },
  { messageId: ITK_MSG.ITSPECTRALANALYSIS, name: 'ITSPECTRALANALYSIS', label: 'Spectral analysis' },
  { messageId: ITK_MSG.ITFRONTENDMODE, name: 'ITFRONTENDMODE', label: 'HDR front end' },
  { messageId: ITK_MSG.ITBANDPASSCONFIG, name: 'ITBANDPASSCONFIG', label: 'Bandpass filter' },
  { messageId: ITK_MSG.ITPROGFILTCONFIG, name: 'ITPROGFILTCONFIG', label: 'Programmable filter' },
];

/** `LOG <NAME>B ONCE` — the binary form, which is the one the live decoder renders. */
export function itkReadbackRequest(name: string): string {
  return `LOG ${name.toUpperCase()}B ONCE`;
}

/**
 * `frameitDetectConfigCommand` (`interferenceToolKit.js:5960`) verbatim: the RF path plus the three
 * reserved words. `ALL` is the shipped "on" (`#itk-itdetectconfig-on-off` checked) and `NONE` the
 * shipped "off" (line 5940 / 5943).
 */
export function frameItDetectConfigCommand(state: string): ConfigDataMap {
  return [
    { rfpath: [state, 'enum', 4] },
    { r1: [0, 'ulong', 4] },
    { r2: [0, 'ulong', 4] },
    { r3: [0, 'ulong', 4] },
  ];
}

/**
 * `ITWARNINGCONFIG WarningLevel [Reserved]` (§2.78). The shipped WebUI has no control for it — the
 * id only appears in its message table (`MessageIdConstants.js:603`) — so the map is the manual's
 * one argument, and `ITWARNINGCONFIG 1` is the line this receiver answered `<OK` to on 2026-11-01
 * (`03_分析/01_Manage主界面与视图层.md` §13.1).
 */
export function frameItWarningConfigCommand(level: number | string): ConfigDataMap {
  return [{ level: [level, 'ulong', 4] }];
}

/** `frameItSpectralAnalysisDataMap` (`interferenceToolKit.js:3211`) verbatim. */
export function frameItSpectralAnalysisDataMap(values: Partial<Record<ItkSpectralKey, unknown>>): ConfigDataMap {
  const mode = values.mode || 'PREDECIMATION';
  const frequency = values.frequency || 'GPSL1';
  const updatePeriod = values.updatePeriod || '200';
  const fftSize = values.fftSize || '2K';
  const timeAvg = values.timeAvg || '1';
  const subCarrierAvg = values.subCarrierAvg || '1';
  return [
    { mode: [mode, 'enum', 4] },
    { frequency: [frequency, 'enum', 4] },
    { updatePeriod: [updatePeriod, 'ulong', 4] },
    { fftSize: [fftSize, 'enum', 4] },
    { timeAvg: [timeAvg, 'ulong', 4] },
    { subCarrierAvg: [subCarrierAvg, 'ulong', 4] },
  ];
}

/** `frameItProgFiltConfigDataMap` (`interferenceToolKit.js:3260`) verbatim. */
export function frameItProgFiltConfigDataMap(
  values: Partial<Record<ItkProgFilterKey, unknown>>,
): ConfigDataMap {
  const frequency = values.frequency || 'GPSL1';
  const filterId = values.filterId || 'PF0';
  const filterSwitch = values.filterSwitch || 'ENABLE';
  const filterMode = values.filterMode || 'NOTCHFILTER';
  const cutOffFrequency = values.cutOffFrequency || '0';
  const notchWidth = values.notchWidth || '0';
  return [
    { frequency: [frequency, 'enum', 4] },
    { filterId: [filterId, 'enum', 4] },
    { filterSwitch: [filterSwitch, 'enum', 4] },
    { filterMode: [filterMode, 'enum', 4] },
    { cutOffFrequency: [cutOffFrequency, 'float', 4] },
    { notchWidth: [notchWidth, 'float', 4] },
  ];
}

/** `frameItBandPassConfigDataMap` (`interferenceToolKit.js:3312`) verbatim. */
export function frameItBandPassConfigDataMap(
  values: Partial<Record<ItkBandpassKey, unknown>>,
): ConfigDataMap {
  const frequency = values.frequency || 'GPSL5';
  const filterSwitch = values.filterSwitch || 'ENABLE';
  const cutOffFrequency = values.cutOffFrequency || '0';
  return [
    { frequency: [frequency, 'enum', 4] },
    { filterSwitch: [filterSwitch, 'enum', 4] },
    { cutOffFrequency: [cutOffFrequency, 'float', 4] },
  ];
}

/** `frameItFrontEndModeDataMap` (`interferenceToolKit.js:3361`) verbatim. */
export function frameItFrontEndModeDataMap(
  values: Partial<Record<ItkFrontEndKey, unknown>>,
): ConfigDataMap {
  const frequencyBand = values.frequencyBand || 'L1';
  const mode = values.mode || 'CIC3';
  return [
    { frequencyBand: [frequencyBand, 'enum', 4] },
    { mode: [mode, 'enum', 4] },
  ];
}

export type ItkSpectralKey =
  | 'mode'
  | 'frequency'
  | 'updatePeriod'
  | 'fftSize'
  | 'timeAvg'
  | 'subCarrierAvg';
export type ItkProgFilterKey =
  | 'frequency'
  | 'filterId'
  | 'filterSwitch'
  | 'filterMode'
  | 'cutOffFrequency'
  | 'notchWidth';
export type ItkBandpassKey = 'frequency' | 'filterSwitch' | 'cutOffFrequency';
export type ItkFrontEndKey = 'frequencyBand' | 'mode';

/**
 * One field of a data map as the token the receiver's parser takes.
 *
 * The shipped page never builds a line: `genericConfig.js:220` frames the map into a **binary**
 * command (`frameCommand.binaryCommand`), and the only place its own code turns an argument list
 * into text is `frameCommand.frameasciirequest` (:186), which normalises spaces to commas and
 * upper-cases `LOG`/`UNLOG` only. This build sends abbreviated ASCII, so what goes on the wire is
 * the manual's own syntax with upper-case enum tokens and single spaces —
 * `ITSPECTRALANALYSIS PREDECIMATION GPSL1 200 2K 1 1` — which is the shape this receiver answered
 * `<OK` to (measured 2026-11-01: `ITWARNINGCONFIG 1`, `ITDETECTCONFIG ALL`,
 * `ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1`, and `b7-restore.ps1`'s
 * `ITSPECTRALANALYSIS PREDECIMATION GPSL1 200 2K 1 1`).
 */
export function itkToken(value: unknown, type: string): string {
  if (type === 'enum') return String(value ?? '').trim().toUpperCase();
  if (type === 'ulong' || type === 'ushort') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new RangeError(`not a whole number: ${String(value)}`);
    return String(Math.trunc(numeric));
  }
  if (type === 'float') return itkFloatToken(value);
  return String(value ?? '').trim();
}

/** `1165.975` → `1165.975`, `1` → `1`, `0` → `0`: no exponent, no trailing zeros, no `-0`. */
export function itkFloatToken(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new RangeError(`not a number: ${String(value)}`);
  const text = numeric.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' || text === '' ? '0' : text;
}

/**
 * The final ASCII line for one data map: the command name and its fields in map order, separated by
 * one space. This is the string a test (and the transcript) can compare against the receiver's
 * `<OK`.
 */
export function itkCommandLine(name: string, map: ConfigDataMap): string {
  const tokens = [String(name ?? '').trim().toUpperCase()];
  for (const row of map) {
    for (const spec of Object.values(row)) {
      const [value, type] = spec as [unknown, string, number];
      tokens.push(itkToken(value, type));
    }
  }
  return tokens.join(' ');
}

/** One line an Apply frames, and the read-back request that follows it. */
export interface ItkCommand {
  /** The write itself (`ITWARNINGCONFIG 1`). */
  line: string;
  /** `LOG <NAME>B ONCE`, the record the page re-reads after the write. */
  readback: string;
}

/** The values the six controls hold when an Apply button is pressed. */
export interface ItkWriteValues {
  detectPath: string;
  warningLevel: string;
  spectral: Partial<Record<ItkSpectralKey, unknown>>;
  frontEnd: Partial<Record<ItkFrontEndKey, unknown>>;
  bandpass: Partial<Record<ItkBandpassKey, unknown>>;
  progFilter: Partial<Record<ItkProgFilterKey, unknown>>;
}

/**
 * What one Apply sends. Every branch is the shipped map plus the record that reads the result back;
 * `spectralStop` is the shipped page's own `ITSPECTRALANALYSIS OFF`
 * (`interferenceToolKit.js:3254` / `3287`, `controller.requestlog(tab, 'itspectralanalysis off')`).
 */
export function itkCommandsFor(section: ItkWriteSection, values: ItkWriteValues): ItkCommand[] {
  const one = (line: string, name: string): ItkCommand[] => [
    { line, readback: itkReadbackRequest(name) },
  ];
  switch (section) {
    case 'detect':
      return one(
        itkCommandLine('ITDETECTCONFIG', frameItDetectConfigCommand(values.detectPath)),
        'ITDETECTCONFIG',
      );
    case 'warning':
      return one(
        itkCommandLine('ITWARNINGCONFIG', frameItWarningConfigCommand(values.warningLevel)),
        'ITWARNINGCONFIG',
      );
    case 'spectral':
      return one(
        itkCommandLine('ITSPECTRALANALYSIS', frameItSpectralAnalysisDataMap(values.spectral)),
        'ITSPECTRALANALYSIS',
      );
    case 'spectralStop':
      return one('ITSPECTRALANALYSIS OFF', 'ITSPECTRALANALYSIS');
    case 'hdr':
      return one(
        itkCommandLine('ITFRONTENDMODE', frameItFrontEndModeDataMap(values.frontEnd)),
        'ITFRONTENDMODE',
      );
    case 'bandpass':
      return one(
        itkCommandLine('ITBANDPASSCONFIG', frameItBandPassConfigDataMap(values.bandpass)),
        'ITBANDPASSCONFIG',
      );
    case 'progFilter':
      return one(
        itkCommandLine('ITPROGFILTCONFIG', frameItProgFiltConfigDataMap(values.progFilter)),
        'ITPROGFILTCONFIG',
      );
    default:
      // Unreachable: `ItkWriteSection` is a closed union, and every member has a branch above.
      throw new RangeError(`unknown Interference Toolkit section: ${String(section)}`);
  }
}

/**
 * The receiver's own values, as read back from the link. Empty until a record arrives: the page
 * never fills a field from a default of its own.
 */
export interface ItkReported {
  detectPath?: string;
  warningLevel?: string;
  spectral?: Record<ItkSpectralKey, string>;
  frontEnd: Array<{ band: string; mode: string }>;
  bandpass: Array<{ frequency: string; filterSwitch: string; cutOffFrequency: string }>;
  progFilter: Array<{
    frequency: string;
    filterId: string;
    filterSwitch: string;
    filterMode: string;
    cutOffFrequency: string;
    notchWidth: string;
  }>;
}

/** One `IT*CONFIG` record the link handed over, already split into its body tokens. */
export interface ItkRecord {
  messageId: number;
  name: string;
  body: string[];
  /** The record as the receiver printed it, minus its CRC — what the page quotes as its source. */
  line: string;
}

/**
 * Split one rendered configuration record into its body tokens.
 *
 * Two shapes are accepted because both are the receiver's: the binary form the live link renders
 * (`ITWARNINGCONFIGA,USB2,276,68.5,SATTIME,0,0.000,03801800,3ae4,18278;3,0*75d69af9`, which is what
 * `b1-20261101.sbf`'s own `LOG RXCONFIGA ONCE` dump holds) and abbreviated ASCII
 * (`ITWARNINGCONFIG 3 0`). A line that does not name one of the six records is refused rather than
 * guessed at.
 */
export function itkRecordOf(messageId: number, line: string): ItkRecord | undefined {
  const record = ITK_RECORDS.find((candidate) => candidate.messageId === messageId);
  if (!record) return undefined;
  /* Three lead-ins are the receiver's own: `<` on a log line, `#` on a full-ASCII record (which is
   * what `live.ts#renderAscii` renders — the shape `/api/live/logs` carries), and nothing at all in
   * abbreviated ASCII. */
  const text = String(line ?? '').trim().replace(/^[<#]/, '');
  if (!text) return undefined;
  const star = text.lastIndexOf('*');
  const withoutCrc = star > 0 ? text.slice(0, star) : text;
  const semicolon = withoutCrc.lastIndexOf(';');
  const head = semicolon >= 0 ? withoutCrc.slice(0, semicolon) : withoutCrc;
  const name = head.split(/[ ,]/)[0] ?? '';
  if (name.toUpperCase().replace(/A$/, '') !== record.name) return undefined;
  const bodyText = semicolon >= 0 ? withoutCrc.slice(semicolon + 1) : '';
  const body = (bodyText ? bodyText.split(',') : head.split(/[ ,]+/).slice(1))
    .map((token) => token.trim())
    .filter((token, index) => token !== '' || index === 0);
  if (!body.length) return undefined;
  return { messageId, name: record.name, body, line: withoutCrc };
}

/** Fold one read-back record into the values the page shows. */
export function itkReportApply(reported: ItkReported, record: ItkRecord): ItkReported {
  const [first, second, third, fourth, fifth, sixth] = record.body;
  if (record.messageId === ITK_MSG.ITDETECTCONFIG) {
    return { ...reported, detectPath: enumNameOf(RF_PATH_BY_NAME, first) };
  }
  if (record.messageId === ITK_MSG.ITWARNINGCONFIG) {
    return { ...reported, warningLevel: String(first ?? '') };
  }
  if (record.messageId === ITK_MSG.ITSPECTRALANALYSIS) {
    return {
      ...reported,
      spectral: {
        mode: enumNameOf(SPECTRAL_MODE_BY_NAME, first),
        frequency: enumNameOf(FREQUENCY_BY_NAME, second),
        updatePeriod: String(third ?? ''),
        fftSize: enumNameOf(FFT_SIZE_BY_NAME, fourth),
        timeAvg: String(fifth ?? ''),
        subCarrierAvg: String(sixth ?? ''),
      },
    };
  }
  if (record.messageId === ITK_MSG.ITFRONTENDMODE) {
    const band = enumNameOf(FRONTEND_BAND_BY_NAME, first);
    const mode = enumNameOf(FRONTEND_MODE_BY_NAME, second);
    const others = reported.frontEnd.filter((entry) => entry.band !== band);
    return {
      ...reported,
      // `ITFRONTENDMODE` answers one record per band, so the list is keyed by the band it names.
      frontEnd: [...others, { band, mode }].sort((a, b) => a.band.localeCompare(b.band)),
    };
  }
  if (record.messageId === ITK_MSG.ITBANDPASSCONFIG) {
    const bandpass = {
      frequency: enumNameOf(FREQUENCY_BY_NAME, first),
      filterSwitch: enumNameOf(FILTER_SWITCH_BY_NAME, second),
      cutOffFrequency: String(third ?? ''),
    };
    return {
      ...reported,
      bandpass: [
        ...reported.bandpass.filter((entry) => entry.frequency !== bandpass.frequency),
        bandpass,
      ].sort((a, b) => a.frequency.localeCompare(b.frequency)),
    };
  }
  const progFilter = {
    frequency: enumNameOf(FREQUENCY_BY_NAME, first),
    filterId: enumNameOf(FILTER_ID_BY_NAME, second),
    filterSwitch: enumNameOf(FILTER_SWITCH_BY_NAME, third),
    filterMode: enumNameOf(FILTER_MODE_BY_NAME, fourth),
    cutOffFrequency: String(fifth ?? ''),
    notchWidth: String(sixth ?? ''),
  };
  return {
    ...reported,
    progFilter: [
      ...reported.progFilter.filter(
        (entry) =>
          entry.frequency !== progFilter.frequency || entry.filterId !== progFilter.filterId,
      ),
      progFilter,
    ].sort((a, b) =>
      `${a.frequency}${a.filterId}`.localeCompare(`${b.frequency}${b.filterId}`),
    ),
  };
}

/** An empty read-back, so `itkReportApply` never has to care whether anything arrived yet. */
export function emptyItkReport(): ItkReported {
  return { frontEnd: [], bandpass: [], progFilter: [] };
}

/** One `interference_statuses[i]` of an `ITDETECTSTATUS` record. */
export interface ItkRow {
  /** `frequency`, the band enum — `L2` on every b7 record. */
  band: string;
  /** `int_detect_method` — `SPECTRUMANALYSIS`, `STATISTICANALYSIS`, `NONE`. */
  method: string;
  /** True for a real detector; `NONE`/empty means the receiver reported nothing. */
  detected: boolean;
  /**
   * `parameter1` **only when the method is `SPECTRUMANALYSIS`**: the layout's `frequency` field is
   * the band enum, and a statistical detection's `parameter1` is its statistic, not a frequency
   * (measured on b7: `1,L2,SPECTRUMANALYSIS,1270.432,…` vs `1,L2,STATISTICANALYSIS,6.826,…`).
   */
  centreMHz: number | null;
  /** `parameter1..4`, in layout order. */
  parameters: Array<number | string | null>;
  /** `severity1/severity2`, as the record prints them. */
  severity: string;
}

/** The configuration records' values, already resolved to the names the receiver prints. */
export interface ItkConfigValues {
  /** `ITDETECTCONFIG.frequency`: `ALL` = detection enabled, `NONE` = disabled. */
  itkSwitch?: string;
  /** `ITWARNINGCONFIG.level`. */
  warningLevel?: string;
  /** `ITFRONTENDMODE.mode`: `HDR` / `NORMAL`. */
  hdrMode?: string;
  /** `ITSPECTRALANALYSIS.data_source`. */
  dataSource?: string;
  /** `ITSPECTRALANALYSIS.frequency`: the band the spectrum engine is pointed at. */
  analysisBand?: string;
  updatePeriodMs?: string;
  fftSize?: string;
  timeAveragingSec?: string;
  detectionSensitivity?: string;
  /** Set when the capture carries no filter table at all. */
  filters?: string;
}

/** Everything the page shows, as the host hands it over. */
export interface ItkCaptureSummary {
  /** The capture the records came from, verbatim, so the page can name its source. */
  capture: string;
  /** `ITDETECTSTATUS` records in the capture (`/api/records?name=…` → `total`). */
  total: number;
  /** Records the host actually mapped (the API's per-request limit is 25). */
  shown: number;
  /** How many of `shown` carry a detection. */
  detectedShown: number;
  /** How many of `total` carry one (38 of the b7 capture's 47). */
  detectedTotal: number;
  /** Detections per method over the whole capture, e.g. `{STATISTICANALYSIS: 25, …}`. */
  methods: Record<string, number>;
  /** Bands the detections name, in first-seen order. */
  bands: string[];
  rows: ItkRow[];
  config: ItkConfigValues;
  /** Records the capture does not hold, with their ids, already phrased as a sentence fragment. */
  missing: string[];
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * `ITDETECTSTATUS`'s `interference_statuses[]` → rows.
 *
 * Two shapes reach this function and both are read the same way: a capture's decoded text record
 * arrives as flat `interference_statuses[i].field` paths, the live link's projection as an array.
 * A record with a count of 0 has no such paths at all, which is why it yields **no rows** — that is
 * the receiver's own way of saying "nothing detected", and the page's empty state.
 */
export function itkRowsOf(fields: Record<string, unknown> | undefined): ItkRow[] {
  const grouped = new Map<number, Record<string, unknown>>();
  const array = fields?.interference_statuses;
  if (Array.isArray(array)) {
    for (const [index, entry] of array.entries()) {
      if (entry && typeof entry === 'object') grouped.set(index, entry as Record<string, unknown>);
    }
  } else if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      const match = /^interference_statuses\[(\d+)\]\.(\w+)$/.exec(key);
      if (!match) continue;
      const index = Number(match[1]);
      const status = grouped.get(index) ?? {};
      status[match[2]] = value;
      grouped.set(index, status);
    }
  }

  const rows: ItkRow[] = [];
  for (const status of [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)) {
    const method = String(status.int_detect_method ?? '').toUpperCase();
    const parameters = [status.parameter1, status.parameter2, status.parameter3, status.parameter4].map(
      (value) => {
        if (value === undefined || value === null || value === '') return null;
        const numeric = toNumber(value);
        return numeric === null ? String(value) : numeric;
      },
    );
    const severity1 = status.severity1;
    const severity2 = status.severity2;
    const severity =
      severity1 === undefined && severity2 === undefined
        ? '--'
        : `${severityWord(severity1)}/${severityWord(severity2)}`;
    rows.push({
      band: String(status.frequency ?? '--').trim() || '--',
      method: method || '--',
      detected: method !== '' && method !== 'NONE',
      // `parameter1` is a centre frequency only for the spectrum detector; the statistical one
      // reports its statistic there, so the column stays `--` for it rather than showing 6.826 MHz.
      centreMHz: method === 'SPECTRUMANALYSIS' ? toNumber(status.parameter1) : null,
      parameters,
      severity,
    });
  }
  return rows;
}

/** `12.5` → `12.500`; `null` → `--`. */
export function formatParameter(value: number | string | null): string {
  if (value === null || value === '') return '--';
  if (typeof value === 'number') return NUMBER_FORMAT.format(value);
  return value;
}

/**
 * One severity word. The layout prints both with `%08X`, and a decoded record hands them over as
 * numbers (`1024`), so the printed form is rebuilt here instead of showing `1024` where the receiver
 * says `00000400`.
 */
function severityWord(value: unknown): string {
  if (value === undefined || value === null || value === '') return '--';
  const numeric = toNumber(value);
  if (numeric === null) return String(value).startsWith('0x') ? String(value).slice(2) : String(value);
  return (numeric >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

interface ItkPageState {
  summary?: ItkCaptureSummary;
  /** Band filter from the shipped tab strip (`''` = every band). */
  band: string;
  /** What the receiver read back, in the order the records arrived (`frontEnd` keyed by band). */
  reported: ItkReported;
  /** The records the read-back produced, verbatim, newest last. */
  records: ItkRecord[];
  /** The lines the last Apply framed, as they went out. */
  sent: string[];
  /** The receiver's own answer to the last line (`<OK`, `<ERROR:…`), `null` until one arrives. */
  reply: string | null;
  /** Why a control's value was refused before anything was framed, `null` when it was accepted. */
  refused: string | null;
}

/** `interferenceToolKit.js`, its detections, its settings table and its six write controls. */
export class InterferenceToolkitPage extends BaseConfigPage {
  private readonly states = new Map<TabId, ItkPageState>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'interferenceToolkit',
      fragmentPath: './../interferenceToolKit/interferenceToolKit.html',
      containerId: (tab) => `itk-layout_${tab}`,
    });
  }

  override mount(tab: TabId, containerId = this.definition.containerId(tab)): boolean {
    const mounted = super.mount(tab, containerId);
    if (mounted) this.buildPageSections(tab);
    return mounted;
  }

  /**
   * The page has no Apply of its own: each of the six write groups carries its own button
   * (`applySection`), because the shipped page applies each setting on its own too. `apply()`
   * therefore never reaches the transport through the generic path, and `isDirty` is false —
   * nothing here is staged.
   */
  override apply(_tab: TabId): undefined {
    return undefined;
  }

  override isDirty(_tab: TabId): boolean {
    return false;
  }

  /** Hand the page the capture's records; `render` draws them. `undefined` clears the page. */
  setCapture(tab: TabId, summary: ItkCaptureSummary | undefined): void {
    const state = this.pageState(tab);
    state.summary = summary;
    // A new capture re-opens the whole band list rather than keeping a filter the new records may
    // not even contain.
    state.band = '';
    if (!summary) {
      // Nothing was read: the page must not keep rows from the capture it was pointed at before.
      const host = scopedQuery(this.context, tab, '#itk-detections');
      host?.removeAttribute('data-itk-loaded');
      host?.removeAttribute('data-itk-capture');
    }
    this.render(tab);
  }

  /** Clicking the active band tab again clears the filter, so the full list is reachable. */
  setBandFilter(tab: TabId, band: string): void {
    const state = this.pageState(tab);
    state.band = state.band === band ? '' : band;
    this.render(tab);
  }

  /** The rows `render` draws: the capture's rows, filtered by the selected band. */
  visibleRows(tab: TabId): ItkRow[] {
    const state = this.pageState(tab);
    const rows = state.summary?.rows ?? [];
    return state.band ? rows.filter((row) => row.band === state.band) : rows;
  }

  protected render(tab: TabId): void {
    const state = this.pageState(tab);
    const summary = state.summary;

    for (const link of scopedQueryAll(this.context, tab, '.itk-tab-link')) {
      const name = (link.textContent ?? '').trim();
      link.classList.toggle('active', name !== '' && name === state.band);
    }

    this.renderRows(tab, summary);
    this.renderConfig(tab, state);
    this.renderWriteState(tab, state);
  }

  /* ------------------------------------------------------------ the write half (six commands) */

  /**
   * Press one group's Apply: read that group's controls, validate them, frame the line the shipped
   * data map produces and the read-back request that follows it.
   *
   * Nothing is staged: the shipped page has no Apply either — each setting is written when it is
   * changed — so a refused value is reported here and nothing reaches the transport.
   */
  applySection(tab: TabId, section: ItkWriteSection): number {
    const state = this.pageState(tab);
    state.refused = null;
    let commands: ItkCommand[];
    try {
      commands = itkCommandsFor(section, this.writeValues(tab));
    } catch (error) {
      state.refused = error instanceof Error ? error.message : String(error);
      this.renderWriteState(tab, state);
      return 0;
    }
    for (const command of commands) {
      this.commands.place(this.name, 'send', [{ command: [command.line, 'string'] }], tab);
      this.commands.place(this.name, 'send', [{ command: [command.readback, 'string'] }], tab);
    }
    state.sent = commands.flatMap((command) => [command.line, command.readback]);
    state.reply = null;
    this.renderWriteState(tab, state);
    return state.sent.length;
  }

  /** The receiver's own answer to the last line (`<OK`, `<ERROR:…`), shown verbatim. */
  noteReply(tab: TabId, reply: string): void {
    const state = this.pageState(tab);
    state.reply = String(reply ?? '').trim() || null;
    this.renderWriteState(tab, state);
  }

  /**
   * Fold one `IT*CONFIG` record the live link handed over into the page and re-render.
   *
   * This is the read-back path: after an Apply the page asks for `LOG <NAME>B ONCE`, the link
   * decodes the record, `config-http.ts#feedConfigFromEntries` passes its rendered line here, and
   * the controls and the configuration table show what the receiver now holds. A line that is not
   * one of the six records is refused — a record the page cannot read is not a value.
   */
  feedRecord(tab: TabId, messageId: number, line: string): boolean {
    const record = itkRecordOf(messageId, line);
    if (!record) return false;
    const state = this.pageState(tab);
    state.reported = itkReportApply(state.reported, record);
    state.records = [...state.records.filter((entry) => entry.messageId !== record.messageId), record];
    this.render(tab);
    return true;
  }

  /** What the six groups' controls hold right now. */
  private writeValues(tab: TabId): ItkWriteValues {
    const control = (selector: string, fallback: string): string => {
      const value = elementValue(this.context, tab, selector).trim();
      return value === '' ? fallback : value;
    };
    return {
      detectPath: control('#itk-detect-path', 'ALL').toUpperCase(),
      warningLevel: control('#itk-warning-level', '0'),
      spectral: {
        mode: control('#itk-spectral-mode', 'PREDECIMATION').toUpperCase(),
        frequency: control('#itk-spectral-frequency', 'GPSL1').toUpperCase(),
        updatePeriod: itkRange('Spectrum update period', control('#itk-spectral-period', '200'), 50, 100000),
        fftSize: control('#itk-spectral-fft', '2K').toUpperCase(),
        timeAvg: itkRange('Time averaging', control('#itk-spectral-timeavg', '10'), 0, 50),
        subCarrierAvg: itkRange(
          'Detection sensitivity',
          control('#itk-spectral-subcarrier', '5'),
          1,
          1024,
        ),
      },
      frontEnd: {
        frequencyBand: control('#itk-hdr-band', 'L1').toUpperCase(),
        mode: control('#itk-hdr-mode', 'CIC3').toUpperCase(),
      },
      bandpass: {
        frequency: control('#itk-bandpass-frequency', 'GPSL5').toUpperCase(),
        filterSwitch: control('#itk-bandpass-switch', 'ENABLE').toUpperCase(),
        cutOffFrequency: control('#itk-bandpass-cutoff', '0'),
      },
      progFilter: {
        frequency: control('#itk-progfilt-frequency', 'GPSL1').toUpperCase(),
        filterId: control('#itk-progfilt-id', 'PF0').toUpperCase(),
        filterSwitch: control('#itk-progfilt-switch', 'ENABLE').toUpperCase(),
        filterMode: control('#itk-progfilt-mode', 'NOTCHFILTER').toUpperCase(),
        cutOffFrequency: control('#itk-progfilt-cutoff', '0'),
        notchWidth: control('#itk-progfilt-width', '0'),
      },
    };
  }

  /** The note / last-line / reply paragraphs under the six groups. */
  private renderWriteState(tab: TabId, state: ItkPageState): void {
    const sent = scopedQuery(this.context, tab, '#itk-last-command');
    if (sent) {
      sent.textContent = state.sent.length
        ? `Last framed: ${state.sent.join(' · ')}`
        : 'Nothing framed yet from this page.';
      sent.setAttribute('data-itk-sent', String(state.sent.length));
    }
    const reply = scopedQuery(this.context, tab, '#itk-command-reply');
    if (reply) {
      const text = state.reply ?? '';
      reply.textContent = text ? `Receiver: ${text}` : '';
      if (text && /^<err/i.test(text)) reply.setAttribute('data-itk-reply-error', '1');
      else reply.removeAttribute('data-itk-reply-error');
      if (text) reply.setAttribute('data-itk-reply', text);
      else reply.removeAttribute('data-itk-reply');
      setVisible(reply, text !== '');
    }
    const refused = scopedQuery(this.context, tab, '#itk-write-refused');
    if (refused) {
      refused.textContent = state.refused ? `Not sent: ${state.refused}` : '';
      setVisible(refused, Boolean(state.refused));
    }
    const readBack = scopedQuery(this.context, tab, '#itk-readback-summary');
    if (readBack) {
      /* Named in the page's own order (Detection → … → Programmable filter), not arrival order, so
       * the sentence reads the same however the records were interleaved on the link. */
      const names = ITK_RECORDS.map((record) => record.name).filter((name) =>
        state.records.some((entry) => entry.name === name),
      );
      readBack.textContent = names.length
        ? `${names.length} configuration record(s) read back from the receiver: ${names.join(', ')}.`
        : 'No configuration record read back yet: open this page on a live link, or read a capture ' +
          'that holds one, and the table below fills from the receiver’s own records.';
    }
  }

  private renderRows(tab: TabId, summary: ItkCaptureSummary | undefined): void {
    const document = this.context.document;
    const body = scopedQuery(this.context, tab, '#itk-detection-rows');
    if (body) {
      body.innerHTML = '';
      for (const row of this.visibleRows(tab)) {
        const tr = document.createElement('tr');
        tr.className = `itk-detection-row${row.detected ? '' : ' itk-not-detected'}`;
        tr.setAttribute('data-band', row.band);
        tr.setAttribute('data-method', row.method);
        const band = document.createElement('td');
        band.className = 'itk-band';
        band.textContent = row.band;
        const method = document.createElement('td');
        method.className = 'itk-method';
        method.textContent = row.method;
        const centre = document.createElement('td');
        centre.className = 'itk-centre';
        centre.textContent = row.centreMHz === null ? '--' : NUMBER_FORMAT.format(row.centreMHz);
        // The four parameters stay four cells' worth of information in one column: the drawer is
        // ~1000 px wide and eight nowrap columns do not fit, which would leave Severity off-screen.
        const parameters = document.createElement('td');
        parameters.className = 'itk-parameters';
        for (const [index, value] of row.parameters.entries()) {
          if (index > 0) parameters.appendChild(document.createTextNode(' / '));
          const span = document.createElement('span');
          span.className = `itk-p${index + 1}`;
          span.textContent = formatParameter(value);
          parameters.appendChild(span);
        }
        const severity = document.createElement('td');
        severity.className = 'itk-severity';
        severity.textContent = row.severity;
        tr.append(band, method, centre, parameters, severity);
        body.appendChild(tr);
      }
    }

    const rows = this.visibleRows(tab);
    setVisible(scopedQuery(this.context, tab, '#itk-no-detections'), rows.length === 0);
    const table = scopedQuery(this.context, tab, '#itk-detections-table');
    if (table) {
      if (rows.length === 0) table.setAttribute('hidden', '');
      else table.removeAttribute('hidden');
    }

    const shown = scopedQuery(this.context, tab, '#itk-detection-summary');
    if (shown) shown.textContent = summaryLine(summary, this.pageState(tab).band, rows.length);
    if (summary) {
      const host = scopedQuery(this.context, tab, '#itk-detections');
      host?.setAttribute('data-itk-loaded', '1');
      host?.setAttribute('data-itk-capture', summary.capture);
    }
  }

  private renderConfig(tab: TabId, state: ItkPageState): void {
    const summary = state.summary;
    const readback = state.records;
    const document = this.context.document;
    const body = scopedQuery(this.context, tab, '#itk-config-rows');
    if (body) {
      body.innerHTML = '';
      for (const [item, value, source] of configLines(summary?.config, state.reported)) {
        const tr = document.createElement('tr');
        tr.className = 'itk-config-row';
        for (const [className, text] of [
          ['itk-config-item', item],
          ['itk-config-value', value],
          ['itk-config-source', source],
        ] as Array<[string, string]>) {
          const td = document.createElement('td');
          td.className = className;
          td.textContent = text;
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
    }
    const missing = scopedQuery(this.context, tab, '#itk-config-missing');
    if (missing) {
      const gaps = summary?.missing ?? [];
      missing.textContent = gaps.length
        ? `Not in this capture, so shown as --: ${gaps.join('; ')}.`
        : summary
          ? ''
          : readback.length
            ? 'No capture read: the values above are the receiver’s live read-back, not a capture’s ' +
              'copy of them.'
            : 'No capture read and nothing read back yet: every value above is --.';
    }
    this.renderControls(tab, state.reported);
  }

  /**
   * Point each write control at the value the receiver reports, so an Apply starts from what the
   * device holds rather than from a default this build chose. A setting the receiver has not
   * reported leaves the control where it is.
   */
  private renderControls(tab: TabId, reported: ItkReported): void {
    if (reported.detectPath) setValue(this.context, tab, '#itk-detect-path', reported.detectPath);
    if (reported.warningLevel) {
      setValue(this.context, tab, '#itk-warning-level', reported.warningLevel);
    }
    const spectral = reported.spectral;
    if (spectral) {
      setValue(this.context, tab, '#itk-spectral-mode', spectral.mode);
      setValue(this.context, tab, '#itk-spectral-frequency', spectral.frequency);
      setValue(this.context, tab, '#itk-spectral-period', spectral.updatePeriod);
      setValue(this.context, tab, '#itk-spectral-fft', spectral.fftSize);
      setValue(this.context, tab, '#itk-spectral-timeavg', spectral.timeAvg);
      setValue(this.context, tab, '#itk-spectral-subcarrier', spectral.subCarrierAvg);
    }
    /* `ITFRONTENDMODE` answers one record per band, so the band select picks which one the group
     * writes and the mode select shows that band's mode. */
    const band = elementValue(this.context, tab, '#itk-hdr-band').trim().toUpperCase() || 'L1';
    const frontEnd = reported.frontEnd.find((entry) => entry.band === band);
    if (frontEnd) setValue(this.context, tab, '#itk-hdr-mode', frontEnd.mode);
    for (const [index, entry] of reported.bandpass.entries()) {
      if (index > 0) break;
      setValue(this.context, tab, '#itk-bandpass-frequency', entry.frequency);
      setValue(this.context, tab, '#itk-bandpass-switch', entry.filterSwitch);
      setValue(this.context, tab, '#itk-bandpass-cutoff', entry.cutOffFrequency);
    }
    for (const [index, entry] of reported.progFilter.entries()) {
      if (index > 0) break;
      setValue(this.context, tab, '#itk-progfilt-frequency', entry.frequency);
      setValue(this.context, tab, '#itk-progfilt-id', entry.filterId);
      setValue(this.context, tab, '#itk-progfilt-switch', entry.filterSwitch);
      setValue(this.context, tab, '#itk-progfilt-mode', entry.filterMode);
      setValue(this.context, tab, '#itk-progfilt-cutoff', entry.cutOffFrequency);
      setValue(this.context, tab, '#itk-progfilt-width', entry.notchWidth);
    }
  }

  /**
   * Create the page's scaffolding once, inside the shipped fragment: the detections, the
   * configuration table and the six write groups, after the tab strip (which the plot used to fill).
   *
   * Nothing is drawn over the shipped markup: the parts that need a live spectrum stream (the plot
   * pane, the Settings sidenav, Show History, Share) are hidden, and the panes this build can fill
   * are appended. Two shipped *controls* stay hidden with them, and each has a replacement below
   * that says exactly which command it sends:
   *
   *  - `#itdetectconfig-on-off` can only say `ALL`/`NONE` (line 5955's map), while `ITDETECTCONFIG`
   *    also takes `L1`/`L2`/`L5` — the Detection group's path list is the same command, complete;
   *  - `#hdr-slider` has no band, and `ITFRONTENDMODE` needs one — the HDR group asks for the band
   *    and then for its mode.
   */
  private buildPageSections(tab: TabId): void {
    const document = this.context.document;
    const root = scopedQuery(this.context, tab, '#itk-layout');
    if (!root) return;
    if (root.querySelector('#itk-detections')) return; // already built

    for (const selector of [
      '#itk-settings',
      '#itk-settings-sidenav',
      '.tab-content',
      '.slider-rectangle',
      '.itk-save-options',
      '.share-button',
      '#itk-loader',
      /* Replaced by the Detection group below, which sends the same `ITDETECTCONFIG` with every
       * path the command takes. */
      '.toggle-switch.itdetect-toggle',
      /* Replaced by the HDR group: the slider cannot name the band the record is per-band for. */
      '.itk-hdr',
    ]) {
      setVisible(root.querySelector(selector), false);
    }
    for (const input of [...root.querySelectorAll('input, select')]) {
      input.setAttribute('disabled', '');
    }

    const note = document.createElement('p');
    note.id = 'itk-readonly-note';
    note.className = 'itk-readonly-note';
    note.textContent =
      'The detection list and the configuration table are read from the receiver’s own records. ' +
      'The six groups under “Receiver settings” write to it: each Apply frames the shipped data map ' +
      'as one abbreviated-ASCII line (quoted under its button) and then reads the record back. The ' +
      'spectrum plot itself is not drawn — it needs the live ITPSDFINAL/ITPSDDETECT stream, and a ' +
      'curve drawn from anything else would be invented.';
    const tabs = root.querySelector('.itk-tabs');
    if (tabs?.parentElement) tabs.parentElement.insertBefore(note, tabs);
    else root.appendChild(note);

    /**
     * The one control on this page that is not a receiver setting: the **capture** to read. The
     * drawer's script writes the name the shell has open into it, and `config-http.ts#applyConfigEvent`
     * reads it — the page never has to guess which capture is on screen.
     */
    const capture = document.createElement('input');
    capture.id = 'itk-capture';
    capture.setAttribute('type', 'hidden');
    root.appendChild(capture);

    const detections = document.createElement('section');
    detections.id = 'itk-detections';
    detections.className = 'itk-readonly-section';
    const heading = document.createElement('h3');
    heading.textContent = 'Detections (ITDETECTSTATUS)';
    const summary = document.createElement('p');
    summary.id = 'itk-detection-summary';
    summary.className = 'itk-detection-summary';
    detections.append(heading, summary);

    const wrapper = document.createElement('div');
    wrapper.className = 'itk-table-wrap';
    const table = document.createElement('table');
    table.id = 'itk-detections-table';
    table.className = 'itk-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const name of [
      'Band',
      'Method',
      'Centre (MHz)',
      'Parameters 1 / 2 / 3 / 4',
      'Severity',
    ]) {
      const th = document.createElement('th');
      th.textContent = name;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const tbody = document.createElement('tbody');
    tbody.id = 'itk-detection-rows';
    table.append(head, tbody);
    wrapper.appendChild(table);
    const empty = document.createElement('p');
    empty.id = 'itk-no-detections';
    empty.className = 'itk-no-detections';
    empty.textContent = 'No interference detected.';
    detections.append(wrapper, empty);

    const config = document.createElement('section');
    config.id = 'itk-config';
    config.className = 'itk-readonly-section';
    const configHeading = document.createElement('h3');
    configHeading.textContent = 'Configuration (as the receiver reports it)';
    const configTable = document.createElement('table');
    configTable.id = 'itk-config-table';
    configTable.className = 'itk-table';
    const configHead = document.createElement('thead');
    const configHeadRow = document.createElement('tr');
    for (const name of ['Setting', 'Value', 'Receiver record']) {
      const th = document.createElement('th');
      th.textContent = name;
      configHeadRow.appendChild(th);
    }
    configHead.appendChild(configHeadRow);
    const configBody = document.createElement('tbody');
    configBody.id = 'itk-config-rows';
    configTable.append(configHead, configBody);
    const gaps = document.createElement('p');
    gaps.id = 'itk-config-missing';
    gaps.className = 'itk-config-missing';
    config.append(configHeading, configTable, gaps);

    root.append(detections, config, this.buildWriteSection(tab, root));

    for (const link of root.querySelectorAll('.itk-tab-link')) {
      const band = (link.textContent ?? '').trim();
      if (!band) continue;
      /* The shipped tabs have no id, and a drawer page is served as its menu panel only — a
       * `@i/j/k` child path computed in the browser would not address the same element in the
       * server's document (whose `#shell` holds the whole tab). An id is what makes the click
       * reachable, and it is the band the tab filters on. */
      link.id = `itk-tab-${band.toLowerCase()}`;
      link.addEventListener('click', () => this.setBandFilter(tab, band));
    }
  }

  /**
   * The six write groups. Every id here is what the browser posts back (`#id` on a `change`, or a
   * `click` on an Apply button), so each control is addressable from a form event without a
   * positional path.
   */
  private buildWriteSection(tab: TabId, _root: Element): Element {
    const document = this.context.document;
    const section = document.createElement('section');
    section.id = 'itk-write';
    section.className = 'itk-readonly-section itk-write';
    const heading = document.createElement('h3');
    heading.textContent = 'Receiver settings (these write to the receiver)';

    const readBack = document.createElement('p');
    readBack.id = 'itk-readback-summary';
    readBack.className = 'itk-write-help';
    section.append(heading, readBack);

    const grid = document.createElement('div');
    grid.className = 'itk-write-grid';
    section.appendChild(grid);

    const group = (
      id: string,
      legend: string,
      command: string,
      fields: Array<{
        kind: 'select' | 'text';
        id: string;
        label: string;
        options?: readonly string[];
        value?: string;
      }>,
      buttons: Array<{ id: string; label: string; section: ItkWriteSection }>,
      help: string,
    ): void => {
      const box = document.createElement('fieldset');
      box.id = `itk-write-${id}`;
      box.className = 'itk-write-group';
      const caption = document.createElement('legend');
      caption.textContent = `${legend} (${command})`;
      box.appendChild(caption);
      for (const field of fields) {
        const label = document.createElement('label');
        label.className = 'itk-write-field';
        const text = document.createElement('span');
        text.textContent = field.label;
        label.appendChild(text);
        if (field.kind === 'select') {
          const select = document.createElement('select');
          select.id = field.id;
          for (const option of field.options ?? []) {
            const node = document.createElement('option');
            node.setAttribute('value', option);
            node.textContent = option;
            select.appendChild(node);
          }
          select.value = field.value ?? (field.options ?? [''])[0] ?? '';
          /* `#itk-hdr-band` decides which `ITFRONTENDMODE` record the mode select shows. */
          if (field.id === 'itk-hdr-band') {
            select.addEventListener('change', () => this.render(tab));
          }
          label.appendChild(select);
        } else {
          const input = document.createElement('input');
          input.setAttribute('type', 'text');
          input.id = field.id;
          input.value = field.value ?? '';
          label.appendChild(input);
        }
        box.appendChild(label);
      }
      const helpText = document.createElement('p');
      helpText.className = 'itk-write-help';
      helpText.textContent = help;
      box.appendChild(helpText);
      for (const button of buttons) {
        const apply = document.createElement('button');
        apply.setAttribute('type', 'button');
        apply.className = 'itk-apply';
        apply.id = button.id;
        apply.textContent = button.label;
        apply.addEventListener('click', () => {
          this.applySection(tab, button.section);
        });
        box.appendChild(apply);
      }
      grid.appendChild(box);
    };

    group(
      'detect',
      'Detection',
      'ITDETECTCONFIG',
      [
        { kind: 'select', id: 'itk-detect-path', label: 'RF path', options: ITK_DETECT_PATHS, value: 'ALL' },
      ],
      [{ id: 'itk-apply-detect', label: 'Apply', section: 'detect' }],
      'Writes the line ITDETECTCONFIG <path> 0 0 0: ALL/NONE for every path, or exactly one of L1/L2/L5.',
    );
    group(
      'warning',
      'Warning level',
      'ITWARNINGCONFIG',
      [
        {
          kind: 'select',
          id: 'itk-warning-level',
          label: 'Level',
          options: ITK_WARNING_LEVELS,
          value: '3',
        },
      ],
      [{ id: 'itk-apply-warning', label: 'Apply', section: 'warning' }],
      'Writes ITWARNINGCONFIG <level>. 0 is the most sensitive, 3 the least (manual §2.78).',
    );
    group(
      'spectral',
      'Spectral analysis',
      'ITSPECTRALANALYSIS',
      [
        {
          kind: 'select',
          id: 'itk-spectral-mode',
          label: 'Mode',
          options: ITK_SPECTRAL_MODES,
          value: 'PREDECIMATION',
        },
        {
          kind: 'select',
          id: 'itk-spectral-frequency',
          label: 'Frequency',
          options: ITK_FREQUENCY_TOKENS,
          value: 'GPSL1',
        },
        { kind: 'text', id: 'itk-spectral-period', label: 'Update period (ms)', value: '200' },
        {
          kind: 'select',
          id: 'itk-spectral-fft',
          label: 'FFT size',
          options: ITK_FFT_SIZES,
          value: '2K',
        },
        { kind: 'text', id: 'itk-spectral-timeavg', label: 'Time averaging (s)', value: '10' },
        { kind: 'text', id: 'itk-spectral-subcarrier', label: 'Detection sensitivity (bins)', value: '5' },
      ],
      [
        { id: 'itk-apply-spectral', label: 'Start', section: 'spectral' },
        { id: 'itk-apply-spectral-stop', label: 'Stop', section: 'spectralStop' },
      ],
      'Start writes ITSPECTRALANALYSIS <mode> <frequency> <period> <fft> <timeavg> <bins>; ' +
        'Stop writes ITSPECTRALANALYSIS OFF — the shipped page’s own stop (lines 3254 / 3287).',
    );
    group(
      'hdr',
      'HDR front end',
      'ITFRONTENDMODE',
      [
        {
          kind: 'select',
          id: 'itk-hdr-band',
          label: 'Frequency band',
          options: ITK_FRONTEND_BANDS,
          value: 'L1',
        },
        {
          kind: 'select',
          id: 'itk-hdr-mode',
          label: 'Mode',
          options: ITK_FRONTEND_MODES,
          value: 'CIC3',
        },
      ],
      [{ id: 'itk-apply-hdr', label: 'Apply', section: 'hdr' }],
      'Writes ITFRONTENDMODE <band> <mode>, one band at a time: HDR costs more power (manual §2.75).',
    );
    group(
      'bandpass',
      'Bandpass filter',
      'ITBANDPASSCONFIG',
      [
        {
          kind: 'select',
          id: 'itk-bandpass-frequency',
          label: 'Frequency',
          options: ITK_FREQUENCY_TOKENS,
          value: 'GPSL5',
        },
        {
          kind: 'select',
          id: 'itk-bandpass-switch',
          label: 'Switch',
          options: ITK_FILTER_SWITCHES,
          value: 'ENABLE',
        },
        { kind: 'text', id: 'itk-bandpass-cutoff', label: 'Cutoff (MHz)', value: '0' },
      ],
      [{ id: 'itk-apply-bandpass', label: 'Apply', section: 'bandpass' }],
      'Writes ITBANDPASSCONFIG <frequency> <switch> <cutoff>; the symmetric cutoff is applied ' +
        'either side of the band’s centre (manual §2.73).',
    );
    group(
      'progfilt',
      'Programmable filter',
      'ITPROGFILTCONFIG',
      [
        {
          kind: 'select',
          id: 'itk-progfilt-frequency',
          label: 'Frequency',
          options: ITK_FREQUENCY_TOKENS,
          value: 'GPSL1',
        },
        { kind: 'select', id: 'itk-progfilt-id', label: 'Filter', options: ITK_FILTER_IDS, value: 'PF0' },
        {
          kind: 'select',
          id: 'itk-progfilt-switch',
          label: 'Switch',
          options: ITK_FILTER_SWITCHES,
          value: 'DISABLE',
        },
        {
          kind: 'select',
          id: 'itk-progfilt-mode',
          label: 'Mode',
          options: ITK_FILTER_MODES,
          value: 'NOTCHFILTER',
        },
        { kind: 'text', id: 'itk-progfilt-cutoff', label: 'Cutoff (MHz)', value: '0' },
        { kind: 'text', id: 'itk-progfilt-width', label: 'Notch width (MHz)', value: '0' },
      ],
      [{ id: 'itk-apply-progfilt', label: 'Apply', section: 'progFilter' }],
      'Writes ITPROGFILTCONFIG <frequency> <filter> <switch> <mode> <cutoff> <width> — the ' +
        'filter the shipped page adds from its Filters panel (manual §2.76).',
    );

    const sent = document.createElement('p');
    sent.id = 'itk-last-command';
    sent.className = 'itk-last-command';
    const reply = document.createElement('p');
    reply.id = 'itk-command-reply';
    reply.className = 'itk-command-reply';
    const refused = document.createElement('p');
    refused.id = 'itk-write-refused';
    refused.className = 'itk-command-reply itk-write-refused';
    section.append(sent, refused, reply);
    setVisible(refused, false);
    setVisible(reply, false);
    return section;
  }

  private pageState(tab: TabId): ItkPageState {
    let state = this.states.get(tab);
    if (!state) {
      state = {
        band: '',
        reported: emptyItkReport(),
        records: [],
        sent: [],
        reply: null,
        refused: null,
      };
      this.states.set(tab, state);
    }
    return state;
  }
}

function state_band(page: InterferenceToolkitPage, tab: TabId): string {
  return page.bandFilter(tab);
}

/** The sentence above the table: what the capture holds, what the API returned, what is drawn. */
export function summaryLine(
  summary: ItkCaptureSummary | undefined,
  band: string,
  drawn: number,
): string {
  if (!summary) {
    return 'No capture read: open this page from Tools ▸ Interference Toolkit so the shell can hand over a capture.';
  }
  const methods = Object.entries(summary.methods)
    .map(([method, count]) => `${method} ${count}`)
    .join(' · ');
  const bands = summary.bands.length ? summary.bands.join(', ') : '--';
  const head =
    `${summary.capture}: ${summary.total} ITDETECTSTATUS record(s), ` +
    `${summary.detectedTotal} carrying a detection` +
    (methods ? ` (${methods})` : '') +
    `, band ${bands}.`;
  const page =
    `Showing the first ${summary.shown} record(s) — the API’s per-request limit is 25 — ` +
    `${summary.detectedShown} of them with a detection.`;
  const filter = band
    ? ` Filtered to ${band}: ${drawn} row(s) shown. Click ${band} again to show every band.`
    : '';
  return `${head} ${page}${filter}`;
}

/**
 * The configuration rows, in the manual's order (§2.2.9 Settings ▸ HDR / Filters / Advanced).
 *
 * The third column names the record the value came from, because a value the receiver did not
 * report must never look like a value this build chose.
 */
export function configLines(
  config: ItkConfigValues | undefined,
  reported?: ItkReported,
): Array<[string, string, string]> {
  /* A value the link read back is the receiver's current setting and wins over the capture's,
   * which may be hours old; the third column says which of the two it is, because "as captured"
   * and "as reported now" are different claims. */
  const live = (value: string | undefined, source: string, captured?: string): [string, string] => {
    const trimmed = (value ?? '').trim();
    return trimmed
      ? [trimmed, `${source} · live read-back`]
      : [text(captured), source];
  };
  const spectral = reported?.spectral;
  const frontEnd = reported?.frontEnd.length
    ? reported.frontEnd.map((entry) => `${entry.band} ${entry.mode}`).join(' · ')
    : undefined;
  const filters = [
    ...(reported?.bandpass ?? []).map(
      (entry) => `${entry.frequency} ${entry.filterSwitch} (cutoff ${entry.cutOffFrequency})`,
    ),
    ...(reported?.progFilter ?? []).map(
      (entry) =>
        `${entry.frequency} ${entry.filterId} ${entry.filterSwitch} ${entry.filterMode} ` +
        `(cutoff ${entry.cutOffFrequency}, width ${entry.notchWidth})`,
    ),
  ].join(' · ');
  return [
    [
      'Interference Toolkit switch',
      ...live(reported?.detectPath, 'ITDETECTCONFIG (#2143) frequency', config?.itkSwitch),
    ],
    [
      'Warning level',
      ...live(reported?.warningLevel, 'ITWARNINGCONFIG (#2289) level', config?.warningLevel),
    ],
    ['Enable HDR Mode', ...live(frontEnd, 'ITFRONTENDMODE (#2039) mode', config?.hdrMode)],
    [
      'Spectral analysis source',
      ...live(spectral?.mode, 'ITSPECTRALANALYSIS (#1967) data_source', config?.dataSource),
    ],
    [
      'Spectral analysis band',
      ...live(spectral?.frequency, 'ITSPECTRALANALYSIS (#1967) frequency', config?.analysisBand),
    ],
    [
      'Update Rate (secs)',
      ...live(
        spectral?.updatePeriod,
        'ITSPECTRALANALYSIS (#1967) psd_update_period_ms',
        config?.updatePeriodMs,
      ),
    ],
    [
      'Spectrum Resolution',
      ...live(spectral?.fftSize, 'ITSPECTRALANALYSIS (#1967) fft_size', config?.fftSize),
    ],
    [
      'Time Averaging (secs)',
      ...live(
        spectral?.timeAvg,
        'ITSPECTRALANALYSIS (#1967) psd_time_ave_window_sec',
        config?.timeAveragingSec,
      ),
    ],
    [
      'Detection Sensitivity (bins)',
      ...live(
        spectral?.subCarrierAvg,
        'ITSPECTRALANALYSIS (#1967) psd_subcarrier_ave_window',
        config?.detectionSensitivity,
      ),
    ],
    [
      'Filters',
      ...live(
        filters,
        'ITBANDPASSCONFIG (#1999) / ITPROGFILTCONFIG (#2000)',
        config?.filters,
      ),
    ],
  ];
}

/**
 * A whole number inside the receiver's own range, or a sentence naming the field and the range.
 *
 * The ranges are the manual's: `updateperiod 50 .. 100000`, `timeavg 0 .. 50` and
 * `integration window 1 .. 1024` (`OEM7 Commands and Logs Reference Manual §2.77`). A value outside
 * one is refused here rather than sent to be answered with `<ERROR`.
 */
function itkRange(label: string, raw: string, minimum: number, maximum: number): number {
  const text = String(raw ?? '').trim();
  const numeric = Number(text);
  if (text === '' || !Number.isFinite(numeric)) {
    throw new RangeError(`${label} must be a number (got “${text}”)`);
  }
  const whole = Math.trunc(numeric);
  if (whole < minimum || whole > maximum) {
    throw new RangeError(`${label} must be ${minimum}..${maximum} (got ${whole})`);
  }
  return whole;
}

function text(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? '--' : trimmed;
}
