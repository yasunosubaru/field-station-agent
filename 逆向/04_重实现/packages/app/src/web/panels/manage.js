/**
 * Manage panel — the suite's **device status dashboard** (the screen the original shows once a
 * receiver is connected), rebuilt on top of the local JSON API.
 *
 * Reference: `ref-ui/manage-device-open.png` (2560×1600 at 150 % → CSS = physical / 1.5, y measured
 * from the client area, i.e. the OS title bar 22.67 px already removed by the shell).
 *
 * Blocks, in the original's stacking order:
 *
 *   1. app bar            the shell's 70 px bar gains the open-file tab `clean-9600.gp… (0) ×`
 *                         and a disabled `+ Add Device`, both injected from here (index.html is
 *                         owned by the shell, so nothing there is edited)
 *   2. black menu bar     50 px #000: Status (the only real page) · Configuration · Settings ▾ ·
 *                         Tools ▾ · Device ▾, bell + "0" chip at the right end
 *   3. status band        135 px #E4E4E4 + 1 px #B6B6B6 rule, liner at 591: Positioning [Good]
 *                         (Position / Latitude / Longitude / Height (MSL)) | Device [Good]
 *                         (Model / CPU Usage / Logging, Time (UTC) / Interference)
 *   4. tab strip          Positioning (active, 2 px #115C7C underline) · Tracking
 *   5. three tiles        Positioning (8 fields) · Device (4 rows, one badge each) · Interference
 *   6. second row         Satellite View (2 columns: legend + 8 constellation rows + sky plot) ·
 *                         PPP Corrections - Off
 *
 * Two sources, never mixed, and the mode is always on screen:
 *
 *   **Live**     a receiver session is open (`LiveLink`, polled through `/api/live/status` and
 *                `/api/live/logs?after=<cursor>`). The four tiles read the decoded records the
 *                receiver is actually emitting; anything the stream does not carry prints `--`
 *                with the reason in the tile. The mode strip above the tabs says `Live`, names the
 *                target and the time of the newest record.
 *   **Capture**  no live session in this page: the dashboard replays a capture through
 *                `/api/records`, exactly as before. The strip says `Capture` and names the file, so
 *                replayed numbers can never be mistaken for a connected receiver.
 *   **Live lost**  a live session existed and the transport dropped (receiver unplugged, socket
 *                closed). Every live field falls back to `--` — the panel deliberately does *not*
 *                swap in capture values and pretend the receiver is back. `Back to capture replay`
 *                is an explicit action.
 *
 * Where the numbers come from (all of them from the local JSON API, nothing invented):
 *
 *   live mode (fields decoded by `LiveLink` from the EDIE dictionary, same paths `/api/records`
 *   returns for a capture):
 *     BESTPOS #42       → band left half + Positioning tile
 *     HWMONITOR #963    → Device tile + band right half; the status word's high byte is the reading
 *                         type (1 temperature · 2 antenna current · 7 antenna voltage), its low byte
 *                         the boundary limit. CPU Usage is `100 − idleTime / 2` (GRIT §5.6).
 *     RANGE #43         → constellation counts (`(c_status >> 16) & 7`, the same table as
 *                         `graph/src/range-charts.ts`); In Use = newest epoch, Not Used = seen
 *                         earlier in this session
 *     SATVIS2 #1043     → real azimuth/elevation for the sky dots, and Missing = visible but not in
 *                         the newest RANGE epoch. Without SATVIS2 the dots stay symbolic.
 *     VERSION #37       → Model. ITDETECTSTATUS #2065 → Interference.
 *     FILESTATUS #2127 / LOGLIST #5 are not asked for, so Logging stays `--`.
 *
 *   capture mode: the same four sources come from the capture's first/last records via
 *   `/api/records`; a capture that lacks VERSION / ITDETECTSTATUS prints the same `--` it always did.
 *
 * Without an open capture the panel falls back to the capture list (`ref-ui/manage-clean.png`):
 * the original's "All devices" page with one card per capture and a Connect/Open action.
 *
 * Contract with the shell (`src/web/index.html`): `mount(root, ctx)` / `unmount(root)`,
 * ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./manage.css', import.meta.url).href;
const CSS_ID = 'nas-panel-manage-css';

const BESTPOS = 42;
const RANGE = 43;
const HWMONITOR = 963;
const VERSION_LOG = 37;
const SATVIS2 = 1043;
const ITDETECTSTATUS = 2065;

/** `system` = `(c_status >> 16) & 7` — same table as `packages/graph/src/range-charts.ts`. */
const SYSTEM_GPS = 0;
const SYSTEM_GLO = 1;
const SYSTEM_SBAS = 2;
const SYSTEM_GAL = 3;
const SYSTEM_BDS = 4;
const SYSTEM_QZSS = 5;
const SYSTEM_NAVIC = 6;

/** Rows of the Satellite View tile, in the original's DOM order (`satelliteView.html:27-124`). */
const CONSTELLATIONS = [
  { key: 'gps', label: 'GPS', system: SYSTEM_GPS, icon: 'gps-legend', tone: 'gps' },
  { key: 'glo', label: 'GLO', system: SYSTEM_GLO, icon: 'glonass-legend', tone: 'glo' },
  { key: 'gal', label: 'GAL', system: SYSTEM_GAL, icon: 'galileo-legend', tone: 'gal' },
  { key: 'bds', label: 'BDS', system: SYSTEM_BDS, icon: 'bds-legend', tone: 'bds' },
  { key: 'qzss', label: 'QZSS', system: SYSTEM_QZSS, icon: 'qzss-legend', tone: 'qzss' },
  { key: 'navic', label: 'NAVIC', system: SYSTEM_NAVIC, icon: 'navic-legend', tone: 'navic' },
  { key: 'lband', label: 'LBAND', system: null, icon: 'lband-legend', tone: 'lband' },
  { key: 'sbas', label: 'SBAS', system: SYSTEM_SBAS, icon: 'sbas-legend', tone: 'sbas' },
];

/**
 * `HwMonitorStatusReadingType` → the row it feeds. The status word's high byte is the type, its
 * low byte the boundary limit (0 acceptable · 1 lower warning · 2 lower error · 3 upper warning ·
 * 4 upper error). A capture's binary HWMONITOR has no `idleTime`, but a live one does (the session
 * decoder keeps it), so CPU Usage is answered in live mode only.
 */
const HW_TYPES = { temperature: [1, 22], antennaCurrent: [2], antennaVoltage: [7], cpuUsage: [] };

/** `SATVIS2.system_type` → the Satellite View row it belongs to. */
const SATVIS_KEYS = {
  GPS: 'gps',
  GLONASS: 'glo',
  GLO: 'glo',
  GALILEO: 'gal',
  GAL: 'gal',
  BEIDOU: 'bds',
  BDS: 'bds',
  QZSS: 'qzss',
  NAVIC: 'navic',
  SBAS: 'sbas',
  LBAND: 'lband',
};

/** How many RANGE epochs the live session keeps for "seen but not in use" (≈2 min at 1 Hz). */
const LIVE_RANGE_HISTORY = 120;

/** Entries the Terminal asks for when it opens: enough context without a multi-MB backfill. */
const TERMINAL_BACKFILL = 150;

/* ------------------------------------------------------------------ the 2.3.x status tiles
 *
 * The seven tiles below the four above are the manual's §2.3.4 / §2.3.5 / §2.3.8 / §2.3.9 /
 * §2.3.10 / §2.3.11 / §2.3.12 pages. Every number they print comes from a record the receiver
 * emitted; a field the opened capture does not carry prints `--` and the tile says *why* (which
 * message id is missing, or which `MODELFEATURES` bit says the model cannot produce it). Nothing
 * here is computed from a neighbouring field and nothing is defaulted to zero.
 */

/** Message ids these tiles read (same numbers as `packages/view/src/status/common.ts:MSG_ID`). */
const PORTSTATS = 72;
const SERIALCONFIG = 1246;
const INTERFACEMODE = 3;
const LOGLIST = 5;
const FILESTATUS = 2127;
const MODELFEATURES = 1329;
const HEADING2 = 1335;
const DUALANTENNAALIGN = 1761;
const INSPVAX = 1465;
const PPPPOS = 1538;
const PPPDOP = 1997;
const PPPDOP2 = 1546;
const TERRASTARINFO = 1719;
const VERIPOSINFO = 1728;
const OCEANIXINFO = 2159;
const TERRASTARSTATUS = 1729;
const OCEANIXSTATUS = 2160;
const VERIPOSDECODERSTATUS = 2075;
const SATELDETECT = 2204;
const SATELSTATUS = 2205;
const NTRIPCONFIG = 1249;
const LBANDTRACKSTAT = 1201;

/**
 * `MODELFEATURES.features[].feature` ids these tiles gate on, and the observable that pins each
 * status word: b1 (`live-20261031/b1-20261101.sbf`, record 0) reports `AUTHORIZED` as 0 and
 * `UNAUTHORIZED` as 1 for all 21 entries, e.g. `feature 23 (IMU) = 1 (UNAUTHORIZED)` and
 * `feature 10 (ALIGN_HEADING) = 0 (AUTHORIZED)`.
 */
const FEATURE = {
  ALIGN_HEADING: 10,
  ALIGN_RELATIVE_POS: 11,
  NTRIP: 15,
  PPP: 19,
  INS: 22,
  IMU: 23,
  ANTENNA: 28,
  INTERFERENCE_MITIGATION: 26,
};

/**
 * `(system, 5-bit signal type)` → signal name. Copied from
 * `packages/graph/src/range-charts.ts:RANGE_SIGNALS`, where the split is verified cell-for-cell
 * against the shipped goldens. The three systems there are the three the captures track; any other
 * system keeps its raw pair (`S<system>·s<signal>`) rather than borrowing a name.
 */
const RANGE_SIGNALS = {
  0: {
    0: 'GPS_L1_CA',
    16: 'GPS_L1_CP',
    9: 'GPS_L2_PY',
    17: 'GPS_L2_CM',
    14: 'GPS_L5_Q',
  },
  4: {
    0: 'BEIDOU_B1I_D1',
    4: 'BEIDOU_B1I_D2',
    1: 'BEIDOU_B2I_D1',
    2: 'BEIDOU_B3I_D1',
    6: 'BEIDOU_B3I_D2',
  },
  5: {
    0: 'QZSS_L1_CA',
    16: 'QZSS_L1_CP',
    17: 'QZSS_L2_CM',
    14: 'QZSS_L5_Q',
  },
};

/** `system = (c_status >> 16) & 7` → the row of `CONSTELLATIONS` it belongs to. */
const SYSTEM_ROWS = [
  { system: SYSTEM_GPS, key: 'gps', label: 'GPS' },
  { system: SYSTEM_GLO, key: 'glo', label: 'GLO' },
  { system: SYSTEM_GAL, key: 'gal', label: 'GAL' },
  { system: SYSTEM_BDS, key: 'bds', label: 'BDS' },
  { system: SYSTEM_QZSS, key: 'qzss', label: 'QZSS' },
  { system: SYSTEM_NAVIC, key: 'navic', label: 'NAVIC' },
  { system: SYSTEM_SBAS, key: 'sbas', label: 'SBAS' },
];

function numOf(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** One record's `path → field` index; the readers below all speak `/api/records` shapes. */
function fieldIndex(record) {
  const map = new Map();
  if (!record || !Array.isArray(record.fields)) return map;
  for (const field of record.fields) if (!map.has(field.path)) map.set(field.path, field);
  return map;
}

/** `obs.count` / `features.count` style array length, capped so a damaged record cannot hang. */
function countOf(fields, path, cap) {
  return Math.max(0, Math.min(Number(fields.get(path)?.value) || 0, cap));
}

/**
 * `MODELFEATURES (#1329)` → `{ imu, ins, ppp, ntrip, alignHeading, alignRelative, antenna }`, each
 * the enum text the receiver printed (`AUTHORIZED` / `UNAUTHORIZED` / …) or `null` when the capture
 * has no MODELFEATURES record at all. `null` is different from "not authorized": only the receiver
 * may say a feature is missing.
 */
export function readFeatures(record) {
  if (!record) return null;
  const fields = fieldIndex(record);
  const byFeature = new Map();
  const total = countOf(fields, 'features.count', 128);
  for (let index = 0; index < total; index += 1) {
    const id = numOf(fields.get(`features[${index}].feature`)?.value);
    if (!Number.isFinite(id)) continue;
    byFeature.set(id, shown(fields.get(`features[${index}].feature_status`)));
  }
  const pick = (id) => byFeature.get(id) ?? null;
  return {
    alignHeading: pick(FEATURE.ALIGN_HEADING),
    alignRelative: pick(FEATURE.ALIGN_RELATIVE_POS),
    ntripp: pick(FEATURE.NTRIP),
    ppp: pick(FEATURE.PPP),
    ins: pick(FEATURE.INS),
    imu: pick(FEATURE.IMU),
    antenna: pick(FEATURE.ANTENNA),
    interference: pick(FEATURE.INTERFERENCE_MITIGATION),
    entries: byFeature.size,
  };
}

/** `AUTHORIZED` is the only status that means "the model can do this". */
function featureOff(value) {
  return typeof value === 'string' && value !== '' && value !== 'AUTHORIZED';
}

/* ---- 2.3.4 Ports ------------------------------------------------------------------------- */

/**
 * §2.3.4 Ports status, from the three records the original reads:
 *
 *   `SERIALCONFIG (#1246)` one record per serial port → the rate and framing (9600 8N1 …)
 *   `PORTSTATS (#72)`      one record, one entry per port → rx/tx counters and the error counters
 *   `LOGLIST (#5)`         one record, one entry per configured log → how many logs that port carries
 *   `INTERFACEMODE (#3)`   one record per port → the interface each direction speaks
 *
 * The row colours are the manual's own four: green = configured and active, amber = configured and
 * not active, red = the receiver's error counters moved, grey = not configured. "Active" is decided
 * by `LOGLIST` (a log is attached to the port), never by a threshold on the byte counters.
 */
export function readPorts(input = {}) {
  const stats = input.stats ?? null;
  const serial = input.serial ?? [];
  const logs = input.logs ?? null;
  const iface = input.iface ?? [];
  const rows = new Map();
  const row = (name) => {
    if (!rows.has(name)) {
      rows.set(name, {
        name,
        baud: NaN,
        framing: '',
        handshaking: '',
        breaksOn: '',
        logs: 0,
        logsKnown: false,
        rx: NaN,
        tx: NaN,
        framingErrors: NaN,
        parityErrors: NaN,
        overRuns: NaN,
        input: null,
        output: null,
        serialPresent: false,
        statsPresent: false,
      });
    }
    return rows.get(name);
  };

  for (const record of serial) {
    const fields = fieldIndex(record);
    const name = shown(fields.get('port'));
    if (!name) continue;
    const target = row(name);
    target.baud = numOf(fields.get('baud_rate')?.value);
    target.framing = [shown(fields.get('data_bits')), shown(fields.get('parity')), shown(fields.get('stop_bits'))]
      .filter((part) => part && part !== 'null')
      .join('');
    target.handshaking = shown(fields.get('hand_shaking')) ?? '';
    target.breaksOn = shown(fields.get('breaks')) ?? '';
    target.serialPresent = true;
  }

  if (stats) {
    const fields = fieldIndex(stats);
    const total = countOf(fields, 'port_statistics.count', 64);
    for (let index = 0; index < total; index += 1) {
      const base = `port_statistics[${index}]`;
      const name = shown(fields.get(`${base}.port`));
      if (!name) continue;
      const target = row(name);
      target.rx = numOf(fields.get(`${base}.rx_chars`)?.value);
      target.tx = numOf(fields.get(`${base}.tx_chars`)?.value);
      target.framingErrors = numOf(fields.get(`${base}.framing_errors`)?.value);
      target.parityErrors = numOf(fields.get(`${base}.parity_errors`)?.value);
      target.overRuns = numOf(fields.get(`${base}.over_runs`)?.value);
      target.statsPresent = true;
    }
  }

  if (logs) {
    const fields = fieldIndex(logs);
    const total = countOf(fields, 'log_list.count', 256);
    for (let index = 0; index < total; index += 1) {
      const name = shown(fields.get(`log_list[${index}].log_port_address`));
      if (!name) continue;
      const target = row(name);
      target.logs += 1;
      target.logsKnown = true;
    }
  }

  for (const record of iface) {
    const fields = fieldIndex(record);
    const name = shown(fields.get('port'));
    if (!name) continue;
    const target = row(name);
    target.input = shown(fields.get('receive_interface_mode'));
    target.output = shown(fields.get('transmit_interface_mode'));
  }

  const list = [...rows.values()]
    .map((item) => {
      const errors =
        (Number.isFinite(item.framingErrors) ? item.framingErrors : 0) +
        (Number.isFinite(item.parityErrors) ? item.parityErrors : 0) +
        (Number.isFinite(item.overRuns) ? item.overRuns : 0);
      /* `PORTSTATS` lists every port the firmware knows — 30 entries on this model, most of them
       * carrying 0/0 because nothing is attached. A row with no configuration, no log and no
       * traffic since boot is not "a port in the grey state", it is a port that does not exist on
       * this hardware, so it is left out rather than padding the tile with empty names. */
      const used =
        item.serialPresent ||
        item.logs > 0 ||
        item.input !== null ||
        item.rx > 0 ||
        item.tx > 0 ||
        errors > 0;
      /* Green = configured and active, amber = configured and idle, red = the receiver's error
       * counters moved, grey = nothing attached. "Active" is the byte counters: `LOGLIST` (which
       * would prove a log is attached) is not in every capture, so a port with traffic is still
       * active even when the log list is missing. */
      let tone = 'off';
      if (errors > 0) tone = 'bad';
      else if (item.logs > 0) tone = 'good';
      else if (item.rx > 0 || item.tx > 0) tone = 'good';
      else if (Number.isFinite(item.baud)) tone = 'warn';
      return { ...item, errors, tone, used };
    })
    .filter((item) => item.used)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const worst = { off: 0, unknown: 1, warn: 2, bad: 3 };
  let tone = 'off';
  for (const item of list) {
    if ((worst[item.tone] ?? 0) > (worst[tone] ?? 0)) tone = item.tone;
  }

  const missing = [];
  if (!stats) missing.push('PORTSTATS (#72)');
  if (!serial.length) missing.push('SERIALCONFIG (#1246)');
  if (!logs) missing.push('LOGLIST (#5)');
  if (!iface.length) missing.push('INTERFACEMODE (#3)');
  return { rows: list, tone: list.length ? tone : 'off', missing, configured: list.length };
}

/* ---- 2.3.5 Logging ---------------------------------------------------------------------- */

/**
 * §2.3.5 Logging status, from `FILESTATUS (#2127)`.
 *
 * The desk OEM729 answers `LOG FILESTATUS ONCE` with
 * `<ERROR:Message is invalid for this model` and emits no record at all
 * (`03_分析/17_A1_连接层与Terminal.md` §17.8.6), and none of the five b1..b5 captures contains
 * #2127 either. That is a *model* answer, not a zero, so the tile keeps `supported: false` and
 * every field `--`.
 */
export function readLogging(input = {}) {
  const records = input.filestatus ?? [];
  const logs = input.logs ?? null;
  let fileLogs = 0;
  if (logs) {
    const fields = fieldIndex(logs);
    const total = countOf(fields, 'log_list.count', 256);
    for (let index = 0; index < total; index += 1) {
      const name = shown(fields.get(`log_list[${index}].log_port_address`)) ?? '';
      if (/^FILE/i.test(name)) fileLogs += 1;
    }
  }
  const record = records.find((item) => {
    const fields = fieldIndex(item);
    const status = shown(fields.get('file_status')) ?? '';
    return status !== '' && status !== 'DISABLED' && status !== 'ERROR';
  }) ?? records[0] ?? null;
  if (!record) {
    return {
      supported: false,
      status: null,
      fileName: null,
      fileSize: NaN,
      messages: [],
      fileLogs,
      logsKnown: Boolean(logs),
      reason: 'FILESTATUS (#2127)',
    };
  }
  const fields = fieldIndex(record);
  return {
    supported: true,
    status: shown(fields.get('file_status')),
    fileName: shown(fields.get('file_name')),
    fileSize: numOf(fields.get('file_size')?.value),
    mediaType: shown(fields.get('media_type')),
    mediaRemaining: numOf(fields.get('media_remaining_capacity')?.value),
    mediaTotal: numOf(fields.get('media_total_capacity')?.value),
    messages: [],
    fileLogs,
    logsKnown: Boolean(logs),
    reason: '',
  };
}

/* ---- 2.3.10 PPP Corrections ------------------------------------------------------------- */

/** `subscription_details` / `operating_mode` of whichever correction service the model reports. */
function readSubscription(input) {
  const services = [
    { id: TERRASTARINFO, label: 'TerraStar', records: input.terrastar ?? [] },
    { id: OCEANIXINFO, label: 'Oceanix', records: input.oceanix ?? [] },
    { id: VERIPOSINFO, label: 'Veripos', records: input.veripos ?? [] },
  ];
  for (const service of services) {
    const record = service.records[0];
    if (!record) continue;
    const fields = fieldIndex(record);
    const mode = shown(fields.get('operating_mode')) ?? '';
    const details = fields.get('subscription_details');
    const code = details ? Number(details.value) : NaN;
    return {
      service: service.label,
      messageId: service.id,
      mode,
      details: details ? String(details.value) : '',
      detailsHex: Number.isFinite(code) ? `0x${(code >>> 0).toString(16).padStart(8, '0')}` : '--',
      subscribed: mode !== '' && mode !== 'UNASSIGNED' && mode !== 'NONE' && code !== 0,
    };
  }
  return null;
}

/**
 * §2.3.10 PPP Corrections. Subscribed / Locked / Lband Tracking / Primary Signal / Signal
 * Strength / Bit Success Rate / NTRIP are the manual's seven fields; each one names the record it
 * needs, and the PPP position/DOP rows print `PPPPOS`/`PPPDOP`/`PPPDOP2` when the capture has them
 * (b4 does, b1 does not).
 */
export function readPpp(input = {}) {
  const features = input.features ?? null;
  const subscription = readSubscription(input);
  const positionRecord = (input.ppppos ?? [])[0] ?? null;
  const dopRecord = (input.pppdop ?? [])[0] ?? null;
  const dop2Record = (input.pppdop2 ?? [])[0] ?? null;
  const lockRecord =
    (input.terrastarstatus ?? [])[0] ??
    (input.oceanixstatus ?? [])[0] ??
    (input.veriposdecoder ?? [])[0] ??
    null;
  const ntripRecord = (input.ntrip ?? [])[0] ?? null;
  const lbandRecord = (input.lband ?? [])[0] ?? null;

  const position = positionRecord
    ? (() => {
        const fields = fieldIndex(positionRecord);
        return {
          solution: shown(fields.get('solution_status')),
          type: shown(fields.get('position_type')),
          satellites: numOf(fields.get('num_svs')?.value),
          diffAge: numOf(fields.get('diff_age')?.value),
          utc: positionRecord.header?.utc ?? '',
        };
      })()
    : null;

  const dop = dopRecord || dop2Record
    ? (() => {
        const fields = fieldIndex(dopRecord ?? dop2Record);
        return {
          gdop: numOf(fields.get('gdop')?.value),
          pdop: numOf(fields.get('pdop')?.value),
          hdop: numOf(fields.get('hdop')?.value),
          vdop: numOf(fields.get('vdop')?.value),
          messageId: dopRecord ? PPPDOP : PPPDOP2,
        };
      })()
    : null;

  const pppOff = featureOff(features?.ppp);
  const missing = [];
  if (!subscription) missing.push('TERRASTARINFO (#1719) / OCEANIXINFO (#2159) / VERIPOSINFO (#1728)');
  if (!lockRecord) missing.push('TERRASTARSTATUS (#1729) / OCEANIXSTATUS (#2160) / VERIPOSDECODERSTATUS (#2075)');
  if (!lbandRecord) missing.push('LBANDTRACKSTAT (#1201)');
  if (!ntripRecord) missing.push('NTRIPCONFIG (#1249)');
  if (!positionRecord) missing.push('PPPPOS (#1538)');

  /* Off is the original's own state (grey): PPP is off when the model has no PPP authorization or
   * when nothing says it is running. An unsubscribed L-Band account is `Unsubscribed`, not `Off`. */
  const tone = pppOff || (!subscription && !position) ? 'off' : subscription && !subscription.subscribed ? 'warn' : 'good';
  return {
    subscription,
    position,
    dop,
    lockRecord: Boolean(lockRecord),
    ntripRecord: Boolean(ntripRecord),
    lbandRecord: Boolean(lbandRecord),
    pppOff,
    tone,
    missing,
  };
}

/* ---- 2.3.11 Radio ----------------------------------------------------------------------- */

/**
 * §2.3.11 Radio status. `SATELSTATUS (#2205)` is the status record and `SATELDETECT (#2204)` the
 * detect reply; the manual says the tile exists only on systems with an external transmit radio,
 * so "no such record in this capture" is the tile's own `Off` state, not a zero.
 */
export function readRadio(input = {}) {
  const status = (input.satelstatus ?? [])[0] ?? null;
  const detect = (input.sateldetect ?? [])[0] ?? null;
  if (!status && !detect) {
    return { present: false, tone: 'off', status: null, port: null, reason: 'SATELSTATUS (#2205) / SATELDETECT (#2204)' };
  }
  const fields = fieldIndex(status ?? detect);
  const statusWord = status ? shown(fields.get('satel_status')) : null;
  const errorWord = status ? shown(fields.get('satel_error')) : null;
  const failed = status ? shown(fields.get('failed_command')) : null;
  const port = detect ? shown(fields.get('comm_port')) : null;
  const bad = Boolean(failed) || (errorWord && errorWord !== '' && errorWord !== '0');
  return {
    present: true,
    tone: bad ? 'bad' : 'good',
    status: statusWord,
    error: errorWord,
    failed,
    port,
    reason: '',
  };
}

/* ---- 2.3.8 ALIGN / 2.3.9 SPAN ----------------------------------------------------------- */

/** §2.3.8 ALIGN: `HEADING2 (#1335)`, falling back to `DUALANTENNAALIGN (#1761)`. */
export function readAlign(input = {}) {
  const features = input.features ?? null;
  const headingRecords = input.heading2 ?? [];
  const dualRecords = input.dualantenna ?? [];
  const record = headingRecords[0] ?? dualRecords[0] ?? null;
  const messageId = headingRecords.length ? HEADING2 : dualRecords.length ? DUALANTENNAALIGN : null;
  const alignSupported =
    features && (features.alignHeading === 'AUTHORIZED' || features.alignRelative === 'AUTHORIZED');
  if (!record) {
    return {
      supported: alignSupported ?? null,
      messageId,
      heading: NaN,
      headingDev: NaN,
      pitch: NaN,
      pitchDev: NaN,
      baseline: NaN,
      solved: false,
      reason: 'HEADING2 (#1335) / DUALANTENNAALIGN (#1761)',
    };
  }
  const fields = fieldIndex(record);
  return {
    supported: true,
    messageId,
    heading: numOf(fields.get('heading')?.value),
    headingDev: numOf(fields.get('heading_std_dev')?.value),
    pitch: numOf(fields.get('pitch')?.value),
    pitchDev: numOf(fields.get('pitch_std_dev')?.value),
    baseline: numOf(fields.get('b_length')?.value),
    solved: (shown(fields.get('solution_status')) ?? '') === 'SOL_COMPUTED',
    status: shown(fields.get('solution_status')),
    type: shown(fields.get('position_type')),
    satellites: numOf(fields.get('num_svs')?.value),
    reason: '',
  };
}

/**
 * §2.3.9 SPAN: `INSPVAX (#1465)`. The manual's fields are Status / Position Type / Alignment /
 * Converged / Azimuth / Pitch / Roll / the three velocities and the position; `INSPVAX` carries all
 * of them except a separate "converged" word, so that row stays `--` rather than being guessed from
 * the standard deviations.
 */
export function readSpan(input = {}) {
  const features = input.features ?? null;
  const record = (input.inspvax ?? [])[0] ?? null;
  const spanSupported = features ? !featureOff(features.ins) || !featureOff(features.imu) : null;
  if (!record) {
    return {
      supported: spanSupported,
      reason: 'INSPVAX (#1465)',
      values: null,
    };
  }
  const fields = fieldIndex(record);
  return {
    supported: true,
    reason: '',
    values: {
      status: shown(fields.get('ins_solution_status')),
      type: shown(fields.get('position_type')),
      azimuth: numOf(fields.get('azimuth')?.value),
      azimuthDev: numOf(fields.get('azimuth_std_dev')?.value),
      pitch: numOf(fields.get('pitch')?.value),
      pitchDev: numOf(fields.get('pitch_std_dev')?.value),
      roll: numOf(fields.get('roll')?.value),
      rollDev: numOf(fields.get('roll_std_dev')?.value),
      north: numOf(fields.get('north_vel')?.value),
      east: numOf(fields.get('east_vel')?.value),
      up: numOf(fields.get('up_vel')?.value),
      latitude: numOf(fields.get('latitude')?.value),
      longitude: numOf(fields.get('longitude')?.value),
      height: numOf(fields.get('orthometric_height')?.value),
      heightDev: numOf(fields.get('height_std_dev')?.value),
      age: numOf(fields.get('time_since_update')?.value),
      utc: record.header?.utc ?? '',
    },
  };
}

/* ---- 2.3.12 Satellite Tracking ---------------------------------------------------------- */

/**
 * §2.3.12 Satellite Tracking: the newest `RANGE (#43)` epoch, one row per PRN and one bar per
 * signal, plus the real elevation/azimuth from `SATVIS2 (#1043)` when the capture has that record.
 *
 * `sv_freq` in the decoded record is 0 for every observation of the sample; the frequency index is
 * the `c_status` bits 21..25 (`packages/graph/src/range-charts.ts:8-14`), which is what the signal
 * name is looked up with. El/Az are `--` when `SATVIS2` has no entry for that PRN — never filled in
 * from a neighbouring satellite.
 */
export function readSatTracking(input = {}) {
  const range = (input.range ?? [])[0] ?? null;
  const satvis = input.satvis ?? [];
  const sky = new Map();
  let satvisEpoch = '';
  for (const record of satvis) {
    const fields = fieldIndex(record);
    const systemName = (shown(fields.get('system_type')) ?? '').toUpperCase();
    const system = Object.entries({ GPS: SYSTEM_GPS, GLONASS: SYSTEM_GLO, GALILEO: SYSTEM_GAL, BEIDOU: SYSTEM_BDS, QZSS: SYSTEM_QZSS, NAVIC: SYSTEM_NAVIC, SBAS: SYSTEM_SBAS })
      .find(([name]) => name === systemName)?.[1];
    if (system === undefined) continue;
    const total = countOf(fields, 'sat_vis_list.count', 128);
    for (let index = 0; index < total; index += 1) {
      const id = numOf(fields.get(`sat_vis_list[${index}].id`)?.value);
      if (!Number.isFinite(id)) continue;
      sky.set(`${system}:${id}`, {
        elevation: numOf(fields.get(`sat_vis_list[${index}].elevation`)?.value),
        azimuth: numOf(fields.get(`sat_vis_list[${index}].azimuth`)?.value),
        epoch: record.header?.utc ?? '',
      });
      if (record.header?.utc && record.header.utc > satvisEpoch) satvisEpoch = record.header.utc;
    }
  }

  if (!range) {
    return { rows: [], systems: [], epoch: '', total: 0, skyEpoch: satvisEpoch, reason: 'RANGE (#43)' };
  }
  const fields = fieldIndex(range);
  const total = countOf(fields, 'obs.count', 256);
  const rows = new Map();
  for (let index = 0; index < total; index += 1) {
    const base = `obs[${index}]`;
    const status = numOf(fields.get(`${base}.c_status`)?.value);
    if (!Number.isFinite(status)) continue;
    const system = (status >> 16) & 7;
    const signal = (status >> 21) & 0x1f;
    const prn = numOf(fields.get(`${base}.sv_prn`)?.value);
    if (!Number.isFinite(prn)) continue;
    const key = `${system}:${prn}`;
    if (!rows.has(key)) {
      const rowLabel = SYSTEM_ROWS.find((item) => item.system === system);
      rows.set(key, {
        key,
        system,
        systemLabel: rowLabel?.label ?? `S${system}`,
        rowKey: rowLabel?.key ?? `sys${system}`,
        prn,
        signals: [],
        elevation: NaN,
        azimuth: NaN,
      });
    }
    const row = rows.get(key);
    row.signals.push({
      signal,
      name: RANGE_SIGNALS[system]?.[signal] ?? `S${system}·s${signal}`,
      cno: numOf(fields.get(`${base}.C_No`)?.value),
      lock: numOf(fields.get(`${base}.lock_time`)?.value),
    });
  }
  for (const row of rows.values()) {
    row.signals.sort((a, b) => a.signal - b.signal);
    const hit = sky.get(row.key);
    if (hit) {
      row.elevation = hit.elevation;
      row.azimuth = hit.azimuth;
    }
  }
  const list = [...rows.values()].sort((a, b) => a.system - b.system || a.prn - b.prn);
  const systems = [...new Set(list.map((row) => row.rowKey))];
  return {
    rows: list,
    systems,
    epoch: range.header?.utc ?? '',
    total,
    skyEpoch: satvisEpoch,
    reason: '',
  };
}

/**
 * `MODELFEATURES` is a one-shot record; this is the sentence the tiles quote when a model bit, not
 * a missing record, is the reason a field has no value.
 */
export function featureSentence(features) {
  if (!features) return '这个抓包里没有 MODELFEATURES (#1329)，机型能力未知';
  const parts = [];
  if (features.antenna) parts.push(`ANTENNA = ${features.antenna}`);
  if (features.imu) parts.push(`IMU = ${features.imu}`);
  if (features.ins) parts.push(`INS = ${features.ins}`);
  if (features.ppp) parts.push(`PPP = ${features.ppp}`);
  if (features.alignHeading) parts.push(`ALIGN_HEADING = ${features.alignHeading}`);
  return parts.length ? `MODELFEATURES (#1329)：${parts.join(' · ')}` : 'MODELFEATURES (#1329) 没有这些能力项';
}

/* ------------------------------------------------- the `--` state, in words *
 * One function per tile, module level and pure, so the sentence a reader sees under a tile can be
 * asserted without a browser: it is the same string the renderer writes into `.mg-reason`. Every
 * one of them names the message id (or the MODELFEATURES bit) that would have filled the field —
 * the tile never says "no data" without saying which data.
 */

/** `--` when SERIALCONFIG never named this port: the tile must not print an invented 9600. */
export function portRateText(row) {
  if (!row || !Number.isFinite(row.baud)) return '--';
  return `${row.baud} ${row.framing}`.trim();
}

/** `--` when the capture has no LOGLIST (#5): "0 logs" would be a claim, not a measurement. */
export function portLogsText(row) {
  return row && row.logsKnown ? String(row.logs) : '--';
}

export function portsReasonText(ports) {
  if (!ports.rows.length) {
    return '抓包回放 · 这个抓包里没有 SERIALCONFIG (#1246) / PORTSTATS (#72) / LOGLIST (#5) — 端口表保持空。';
  }
  const present = [];
  if (ports.rows.some((row) => row.serialPresent)) present.push('SERIALCONFIG (#1246)');
  if (ports.rows.some((row) => row.statsPresent)) present.push('PORTSTATS (#72)');
  if (ports.rows.some((row) => row.logsKnown)) present.push('LOGLIST (#5)');
  if (ports.rows.some((row) => row.input !== null)) present.push('INTERFACEMODE (#3)');
  const missing = ports.missing.length ? ` · 缺 ${ports.missing.join(' / ')}` : '';
  const inputs = present.includes('INTERFACEMODE (#3)')
    ? ''
    : ' · Input/Output 两列要 INTERFACEMODE (#3)，本抓包没有 → 不列这两列';
  return `抓包回放 · ${ports.rows.length} 个端口 · 源 ${present.join(' + ') || '无'}${missing}${inputs}`;
}

export function loggingReasonText(logging, captureName) {
  if (logging.supported) {
    return `抓包回放 · FILESTATUS (#2127) ${captureName || ''} · ${logging.mediaType ?? '--'}`.trim();
  }
  const portLogs = logging.logsKnown
    ? `LOGLIST (#5) 有记录：${logging.fileLogs} 条落在 FILE 端口上`
    : 'LOGLIST (#5) 也不在这个抓包里，连“日志挂在哪”都不知道';
  return (
    `抓包回放 · 无文件日志：FILESTATUS (#2127) 不在 ${captureName || '这个抓包'} 里；本机实测 ` +
    `LOG FILESTATUS ONCE 回 <ERROR:Message is invalid for this model（该机型没有文件日志组件）· ${portLogs}`
  );
}

export function pppReasonText(ppp) {
  const reasons = [];
  reasons.push(
    ppp.pppOff
      ? 'PPP 未授权（MODELFEATURES #1329 里 PPP = UNAUTHORIZED）'
      : ppp.subscription
        ? `${ppp.subscription.service}：operating_mode = ${ppp.subscription.mode || '--'}，subscription_details = ${ppp.subscription.detailsHex}`
        : 'PPP 订阅：抓包里没有 TERRASTARINFO/OCEANIXINFO/VERIPOSINFO',
  );
  if (ppp.position) {
    reasons.push(`PPPPOS (#1538) ${utcClock(ppp.position.utc)} UTC = ${ppp.position.solution ?? '--'}`);
  }
  if (ppp.dop) reasons.push(`PPPDOP (#${ppp.dop.messageId})`);
  if (ppp.missing.length) reasons.push(`缺 ${ppp.missing.join(' / ')}`);
  return `抓包回放 · ${reasons.join(' · ')}`;
}

export function radioReasonText(radio, captureName) {
  if (radio.present) return `抓包回放 · ${radio.reason || 'SATELSTATUS (#2205)'}`;
  return (
    `抓包回放 · 无电台：${captureName || '这个抓包'} 里没有 SATELSTATUS (#2205) / SATELDETECT (#2204) — ` +
    '手册 2.3.11 说这一块只在外接发射电台的系统上出现，保持 Off（灰）而不是编一个 Good。'
  );
}

export function alignReasonText(align, features) {
  if (align.messageId) {
    return (
      `抓包回放 · #${align.messageId} ${align.status ?? '--'} / ${align.type ?? '--'} · ` +
      `${Number.isFinite(align.satellites) ? `${align.satellites} sv` : 'sv --'}`
    );
  }
  const antenna = features?.antenna;
  const capability = align.supported
    ? `MODELFEATURES (#1329) 里 ALIGN_HEADING 是 AUTHORIZED${antenna ? `、ANTENNA = ${antenna}` : ''}`
    : 'MODELFEATURES (#1329) 里看不到 ALIGN 能力项';
  return (
    `抓包回放 · 无 ALIGN 解：${capability}，抓包里也没有 HEADING2 (#1335) / DUALANTENNAALIGN (#1761) — ` +
    '手册 2.3.8 要有两台 ALIGN 接收机或双天线才出解。'
  );
}

export function spanReasonText(span) {
  if (span.values) {
    return (
      `抓包回放 · INSPVAX (#1465) ${utcClock(span.values.utc)} UTC · ` +
      'Alignment / Converged 在 INSPVAX 里没有对应字段，保持 --。'
    );
  }
  const capability =
    span.supported === false
      ? 'MODELFEATURES (#1329) 里 IMU / INS 都是 UNAUTHORIZED（该机型没有 SPAN）'
      : 'MODELFEATURES (#1329) 不在这个抓包里，机型能力未知';
  return `抓包回放 · 无 SPAN 解：${capability}，抓包里也没有 INSPVAX (#1465) — 字段保持 --。`;
}

export function trackingReasonText(tracking, metric) {
  if (!tracking.rows.length) {
    return '抓包回放 · 这个抓包里没有 RANGE (#43)，逐星表保持空。';
  }
  const satellites = tracking.rows.length;
  const signals = tracking.rows.reduce((sum, row) => sum + row.signals.length, 0);
  const sky = tracking.skyEpoch ? `${utcClock(tracking.skyEpoch)} UTC` : '--';
  return (
    `抓包回放 · RANGE (#43) ${utcClock(tracking.epoch)} UTC · ${satellites} 颗 / ${signals} 个信号 · ` +
    `El/Az 来自 SATVIS2 (#1043) ${sky}${tracking.skyEpoch ? '' : '（该抓包没有 SATVIS2 → --）'} · ` +
    `${metric === 'lock' ? 'Lock Time' : 'Carrier-to-Noise'}`
  );
}

/* ---------------------------------------------------------------------------------------------
 * Device ▸ Restart / Factory Reset — the original's `view/deviceRestart/deviceRestart.js`
 *
 * The command strings are measured off the shipped code, not guessed:
 *
 *   Restart        GIII branch: `LOG  VERSIONB ONTIME 1\n` then `RESET\n` (deviceRestart.js:80-81;
 *                  the double space is in the shipped literal). Every other model sends the *binary*
 *                  `reset` command — messageId 18 (deviceRestart.js:96 → `genericConfig.sendCommand`
 *                  → `NovatelIdConstants.commandsAndEnums.reset`). The ASCII spelling of message 18
 *                  is `RESET` with no argument, which is what a `POST /api/live/command` line carries.
 *   Factory Reset  binary `freset` — messageId 20 with one parameter, `target` = `STANDARD` (enum 0),
 *                  a 4-byte ulong (deviceRestart.js:218-221; targets at
 *                  `NovatelIdConstants.js:2078-2085`: STANDARD 0 · COMMAND 1 · GPSALMANAC 2 ·
 *                  USER_ACCOUNTS 60). It never sends `FRESET OEM`; ASCII: `FRESET STANDARD`.
 *   Erase NVM      the dialog's `#erase-nvm` box prepends the six `SOFTLOAD…` lines of
 *                  `clearLUAData()` (deviceRestart.js:103-110) before either command. Mirrored in
 *                  `resetCommands()`; this panel does not render that box.
 *   Longhorn       `longhornResetFunc` builds a PIMTP frame through the native EDIE addon and
 *                  re-opens the socket — not applicable to this build (no addon), and a Longhorn
 *                  model is not reachable from a capture.
 *
 * The confirmation copy is the shipped English entry, verbatim (`languageSupport/en.js:951-957`),
 * with `%1` — the original substitutes `<br> <br>` there:
 *
 *   RESTARTCONFIRMATION   "Restart Confirmation"
 *   RECEIVERRESTART_1     "Receiver will be restarted. %1 Are you sure you wish to restart the device?"
 *   FACTORY_RESET_CONIFRM "Factory Reset Confirmation"
 *   FRESETMESSAGE         "A factory reset will revert the receiver back to factory default.%1 Are you sure you wish to reset the device?"
 *
 * Everything below is pure: the panel only renders it and posts the lines it returns. Restart needs
 * an explicit confirmation click; Factory Reset starts disabled and stays disabled until the model
 * the receiver itself reports (VERSION #37) is typed in. A reset is sent once: `resetObserve` has no
 * retry transition, so a dropped link or a missed VERSION ends in `failed` and is shown, never re-sent.
 * ------------------------------------------------------------------------------------------- */

/** The one-shot read-back: `VERSIONB` is the log the original takes before a restart. */
export const RESET_VERIFY_LINE = 'LOG VERSIONB ONCE';

/** How long each phase may take, and then it is a failure — never a silent re-send. */
export const RESET_TIMING = Object.freeze({ dropMs: 30000, reconnectMs: 60000, versionMs: 60000 });

/** `deviceRestart.js:103-110` — sent *before* the reset when `#erase-nvm` is ticked. */
export const CLEAR_LUA_LINES = Object.freeze([
  'SOFTLOADRESET',
  'SOFTLOADSREC "S0~P~M7QP,M7QPB,OEM718D,OEM718DC,OEM719,OEM719A,OEM719B,OEM719C,OEM719D,OEM719AC,OEM719BC,OEM719N,OEM729,OEM729R,OEM729C,OEM729RC,OEM7500,OEM7500C,OEM7600,OEM7600C,OEM7700,OEM7700C,OEM7720,OEM7720C,PIM7500,PIM7500C"',
  'SOFTLOADSREC "S0~V~DEV-LOAD"',
  'SOFTLOADSREC "S0~T~DATA1"',
  'SOFTLOADSREC "S30900000000FFFFFFFFFA"',
  'SOFTLOADCOMMIT',
]);

/** The note both dialogs print when there is no session — the POST would be refused, not queued. */
export const NO_LINK_NOTE =
  'No live link — `POST /api/live/command` answers “not connected”, so nothing would be sent. ' +
  'Connect a receiver in Tools ▸ Terminal first.';

/** `deviceRestart.js:20-290` in one table: command, copy, gate and timings per action. */
export const RESET_ACTIONS = Object.freeze({
  restart: Object.freeze({
    key: 'restart',
    menuLabel: 'Restart…',
    command: 'RESET',
    title: 'Restart Confirmation',
    body: 'Receiver will be restarted.',
    question: 'Are you sure you wish to restart the device?',
    go: 'Restart device',
    needsModel: false,
    dropMs: 30000,
  }),
  factoryReset: Object.freeze({
    key: 'factoryReset',
    menuLabel: 'Factory Reset…',
    command: 'FRESET STANDARD',
    title: 'Factory Reset Confirmation',
    body: 'A factory reset will revert the receiver back to factory default.',
    question: 'Are you sure you wish to reset the device?',
    go: 'Factory reset',
    needsModel: true,
    dropMs: 30000,
  }),
});

/** The dialog copy for one action, or `null` for a key this build does not have. */
export function resetCopy(kind) {
  const action = RESET_ACTIONS[kind];
  if (!action) return null;
  return {
    title: action.title,
    body: action.body,
    question: action.question,
    command: action.command,
    go: action.go,
    needsModel: action.needsModel,
  };
}

/** NovAtel model names are uppercase; the typed confirmation is compared case- and space-insensitively. */
export function normalizeModel(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

/**
 * The exact lines to post, in order. One line for both actions; `eraseNvm` adds the shipped
 * `SOFTLOAD…` series in front (mirror only — the panel has no `#erase-nvm` box).
 */
/**
 * The `/api/live/connect` body for an `/api/live/status` target string. The status string is
 * `tcp://host:port` / `udp://host:port` or `COM10 @ 115200`; anything else returns `null`.
 */
export function resetReconnectBody(target) {
  const text = String(target ?? '').trim();
  let match = /^(tcp|udp):\/\/(.+):(\d+)$/.exec(text);
  if (match) return { kind: match[1], host: match[2], port: Number(match[3]) };
  match = /^(.+?) @ (\d+)$/.exec(text);
  if (match) return { kind: 'serial', path: match[1], baud: Number(match[2]) };
  return null;
}

export function resetCommands(kind, options = {}) {
  const action = RESET_ACTIONS[kind];
  if (!action) return [];
  const lines = options.eraseNvm ? [...CLEAR_LUA_LINES] : [];
  lines.push(action.command);
  return lines;
}

/**
 * May a command go out? `restart` needs the confirmation click; `factoryReset` needs the receiver's
 * own model typed in, and is refused outright while the model is unknown — the token is never
 * invented from a captured file.
 */
export function resetGate(kind, options = {}) {
  const action = RESET_ACTIONS[kind];
  const line = action ? action.command : '';
  if (!action) return { ok: false, reason: `Unknown reset action “${kind}”.`, line, lines: [] };
  const link = options.link;
  if (!link || link.connected !== true) {
    return { ok: false, reason: NO_LINK_NOTE, line, lines: [] };
  }
  if (action.needsModel) {
    const model = normalizeModel(options.model);
    if (!model) {
      return {
        ok: false,
        reason:
          'This receiver has not reported its model yet (VERSION #37), so there is nothing to type — ' +
          'a factory reset cannot be confirmed and the button stays disabled.',
        line,
        lines: [],
      };
    }
    if (normalizeModel(options.typed) !== model) {
      return {
        ok: false,
        reason: `Type ${model} to confirm — the receiver reports that model, and nothing is sent until the two match.`,
        line,
        lines: [],
      };
    }
  } else if (options.confirmed !== true) {
    return { ok: false, reason: 'Restart still needs its confirmation button.', line, lines: [] };
  }
  return { ok: true, reason: '', line, lines: resetCommands(kind, options) };
}

/** Start the wait: `awaiting-drop` → (link down) → `awaiting-link` → (session back) → `awaiting-version` → `done`. */
export function resetBegin(kind, options = {}) {
  const action = RESET_ACTIONS[kind];
  const at = Number(options.at) || 0;
  if (!action) {
    return {
      kind,
      phase: 'failed',
      at,
      sentAt: at,
      deadline: at,
      session: '',
      expected: '',
      model: '',
      verified: false,
      reason: `Unknown reset action “${kind}”.`,
    };
  }
  return {
    kind,
    phase: 'awaiting-drop',
    at,
    sentAt: at,
    deadline: at + action.dropMs,
    /** `connectedAt` of the session the command went out on — a different one proves a new session. */
    session: options.session ?? '',
    expected: normalizeModel(options.model),
    model: '',
    verified: false,
    reason: 'Command sent — waiting for the link to drop.',
  };
}

/**
 * One state step. `done` and `failed` are terminal: no event reopens them, which is what makes
 * "a failure is never retried" a property of the machine and not of the caller.
 */
export function resetObserve(state, event = {}) {
  if (!state || !state.phase) return state;
  if (state.phase === 'done' || state.phase === 'failed') return state;
  const at = Number(event.at) || state.at;
  const next = { ...state, at };

  if (event.type === 'link') {
    const connected = event.connected === true;
    const session = event.session ?? '';
    if (next.phase === 'awaiting-drop') {
      if (!connected) {
        next.phase = 'awaiting-link';
        next.deadline = at + RESET_TIMING.reconnectMs;
        next.reason = 'Link down — waiting for the session to come back.';
      } else if (session && next.session && session !== next.session) {
        // A reboot finished between two polls: the drop was never sampled, the new session id is
        // still proof that it happened.
        next.phase = 'awaiting-version';
        next.session = session;
        next.deadline = at + RESET_TIMING.versionMs;
        next.reason = 'A new session is open — reading VERSION (#37)…';
      }
    } else if (next.phase === 'awaiting-link' && connected) {
      next.phase = 'awaiting-version';
      next.session = session || next.session;
      next.deadline = at + RESET_TIMING.versionMs;
      next.reason = 'Reconnected — reading VERSION (#37)…';
    }
  } else if (event.type === 'version' && next.phase === 'awaiting-version') {
    next.model = String(event.model ?? '');
    next.verified = next.expected ? normalizeModel(next.model) === next.expected : Boolean(next.model);
    next.phase = 'done';
    next.reason = next.verified
      ? `VERSION (#37) reads ${next.model || '—'}.`
      : `VERSION (#37) reads ${next.model || '—'}, not ${next.expected} — check that this is the same receiver.`;
  } else if (event.type === 'error') {
    next.phase = 'failed';
    next.reason = String(event.reason || 'The command could not be sent.');
  } else if (event.type === 'tick' && at >= next.deadline) {
    next.phase = 'failed';
    next.reason = {
      'awaiting-drop':
        'Timed out: the link never dropped, so the receiver may not have restarted — nothing is retried.',
      'awaiting-link':
        'Timed out: the link dropped and did not come back — reconnect in Tools ▸ Terminal to read VERSION; nothing is retried.',
      'awaiting-version':
        'Timed out: the session came back but VERSION (#37) never arrived — nothing is retried.',
    }[state.phase] ?? 'Timed out — nothing is retried.';
  }
  return next;
}

/** Phase → the line the dialog shows, with the tone its bar uses. */
export function resetPhaseText(state) {
  if (!state) return { tone: 'idle', text: '' };
  const factory = state.kind === 'factoryReset';
  switch (state.phase) {
    case 'awaiting-drop':
      return {
        tone: 'busy',
        text: 'Command sent — waiting for the link to drop (a restart closes the session).',
      };
    case 'awaiting-link':
      return {
        tone: 'busy',
        text:
          'Link down — the receiver is restarting. This dialog does not reconnect by itself: ' +
          'reconnect in Tools ▸ Terminal and VERSION (#37) is read back here.',
      };
    case 'awaiting-version':
      return {
        tone: 'busy',
        text: `Reconnected — asking the receiver for VERSION (#37) with “${RESET_VERIFY_LINE}”…`,
      };
    case 'done':
      return {
        tone: state.verified ? 'good' : 'warn',
        text: factory
          ? `Factory reset sent; VERSION (#37) reads ${state.model || '—'}. The read-back proves the ` +
            'receiver came back — it does not prove every setting was cleared; check the configuration ' +
            'pages for that.'
          : state.verified
            ? `Restarted — VERSION (#37) reads ${state.model || '—'} again.`
            : `The link came back, but ${state.reason}`,
      };
    case 'failed':
      return { tone: 'bad', text: `${state.reason} Nothing is retried automatically.` };
    default:
      return { tone: 'idle', text: '' };
  }
}

/**
 * The black bar under the app bar. `Status` and `Configuration` are real pages in this build;
 * `Settings` carries the two shipped settings pages it has (General, Networking) and opens them in
 * the same drawer the Configuration pages use. `Tools` carries the Terminal, the Events drawer and
 * the Device `.cfg` pair — the same doors the original has.
 */
const MENU = [
  { key: 'status', label: 'Status', icon: 'status', caret: false, wired: true },
  { key: 'configuration', label: 'Configuration', icon: 'configuration', caret: false, wired: true },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    caret: true,
    wired: true,
    items: [
      { key: 'generalSettings', label: 'General…', wired: true },
      { key: 'networkingSettings', label: 'Networking…', wired: true },
      { key: 'vehicleSetup', label: 'Vehicle Setup…', wired: true },
    ],
  },
  {
    key: 'tools',
    label: 'Tools',
    icon: 'tools',
    caret: true,
    wired: true,
    items: [
      { key: 'terminal', label: 'Terminal', wired: true },
      { key: 'events', label: 'Events', wired: true },
      /* §2.2.9: "click the Tools menu and then click Interference Toolkit". */
      { key: 'interferenceToolkit', label: 'Interference Toolkit…', wired: true },
      {
        key: 'device',
        label: 'Device',
        wired: true,
        items: [
          { key: 'exportCfg', label: 'Export Configuration…', wired: true },
          { key: 'importCfg', label: 'Import Configuration…', wired: true },
        ],
      },
    ],
  },
  {
    key: 'device',
    label: 'Device',
    icon: 'device',
    caret: true,
    wired: true,
    items: [
      { key: 'deviceDetails', label: 'Device Details…', wired: true },
      { key: 'deviceExport', label: 'Storage…', wired: true },
      { key: 'deviceUpdate', label: 'Update…', wired: true },
      /* §2.2.10 Device ▸ Restart / Factory Reset: the original's `deviceRestart.html` dialog pair,
       * served here as the two fixed actions of this panel (same copy, same commands). */
      { key: 'restart', label: RESET_ACTIONS.restart.menuLabel, wired: true },
      { key: 'factoryReset', label: RESET_ACTIONS.factoryReset.menuLabel, wired: true },
    ],
  },
];

const UNWIRED_NOTE =
  'Not wired in this build: the local API only serves Status (this page) from a capture — ' +
  'the other pages need a live receiver.';

/** `Settings ▸ …` entries: each opens the drawer on the shipped page it names. */
export const SETTINGS_PAGES = new Set(['generalSettings', 'networkingSettings', 'vehicleSetup']);

/**
 * `Device ▸ …`: menu pages of the same family — mounted into the tab's menu layouts and served by
 * the same controller — but they belong to the Device menu, not to Settings. The drawer's page list
 * comes from `/api/config/pages`, which marks every menu page `settings: true`, so the name is what
 * tells the two menus apart here.
 *
 *   `deviceDetails` **Device Details** (§2.2.8)
 *   `deviceExport`  **Storage**       (§2.2.11) — the shipped component keeps its module name
 *   `deviceUpdate`  **Update**        (§2.2.12) — served read-only, see `READ_ONLY_PAGES`
 */
export const DEVICE_PAGES = new Set(['deviceDetails', 'deviceExport', 'deviceUpdate']);

/**
 * `Tools ▸ …` pages: §2.2.9's Interference Toolkit is a menu page of the same family (mounted into
 * the tab's menu layouts and served by the same controller pages) but belongs to the Tools menu, and
 * the drawer groups it apart for that reason. `/api/config/pages` marks it `tools: true`.
 */
export const TOOLS_PAGES = new Set(['interferenceToolkit']);

/* Material-style glyphs, 24×24 viewBox, drawn with `currentColor` so the bar can dim the
 * unwired items. The gear is the same path the shell's app-bar settings icon uses
 * (`icons/menubar_settings.svg`). */
const ICONS = {
  status:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M12 12 L16.4 7.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M12 3 A9 9 0 0 1 21 12" fill="none" stroke="currentColor" stroke-width="2.6"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>',
  configuration:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58C4.84 11.36 4.8 11.69 4.8 12s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  tools:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>',
  device:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/></svg>',
};

/* ---------------- small helpers (local: one panel at a time is loaded) ---------- */

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function withQuery(path, params) {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

function defaultApi() {
  const request = async (path, init) => {
    const response = await fetch(path, init);
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  };
  return {
    get: (path, params) => request(withQuery(path, params)),
    post: (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function utcClock(iso) {
  if (!iso) return '--:--:--';
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return match ? match[1] : String(iso);
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

/** `SINGLE` prints as `Single`, `SOL_COMPUTED` stays as-is — the original's tooltips do the same. */
function titleCase(text) {
  const value = String(text ?? '');
  if (!value) return '--';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function baseName(path) {
  const text = String(path ?? '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function shown(field) {
  if (!field) return null;
  const text = field.text;
  if (text === undefined || text === null || text === '') return String(field.value);
  return String(text);
}

/** `data-el="band-lat"` becomes `el.bandLat`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function kvRow(label, target, extra) {
  return (
    '<div class="mg-kv-row">' +
    `<span class="mg-kv-label">${esc(label)}</span>` +
    `<span class="mg-kv-value${extra ? ` ${extra}` : ''}" data-el="${target}">--</span>` +
    '</div>'
  );
}

function deviceRow(label, valueTarget, badgeTarget) {
  return (
    '<div class="mg-device-row">' +
    `<span class="mg-kv-label">${esc(label)}</span>` +
    `<span class="mg-kv-value" data-el="${valueTarget}">--</span>` +
    `<span class="mg-badge mg-badge-unknown" data-el="${badgeTarget}" data-tone="unknown">--</span>` +
    '</div>'
  );
}

function satRow(item) {
  /* The six GNSS glyphs in `sats-sprite.png` already carry their own name under the shape; only
   * LBAND and SBAS are bare icons, so they get a text label (S:29712 `.lband-label`/`.sbas-label`). */
  const needsLabel = item.key === 'lband' || item.key === 'sbas';
  return (
    `<div class="mg-sat-row" data-constellation="${item.key}">` +
    '<div class="mg-constel-shape">' +
    `<span class="mg-sat-glyph ${item.icon}" aria-hidden="true"></span>` +
    (needsLabel ? `<span class="mg-sat-name">${esc(item.label)}</span>` : '') +
    '</div>' +
    '<div class="mg-constel-value">' +
    `<div class="mg-good-chip" data-sat="${item.key}-use" title="In Use — distinct PRNs in the last RANGE epoch of this capture">0</div>` +
    `<div class="mg-idle-chip" data-sat="${item.key}-idle" title="Not Used — PRNs seen earlier in this capture but not in the last epoch">0</div>` +
    '<div class="mg-outer">' +
    `<div class="mg-bad-chip" data-sat="${item.key}-missing" title="Missing — needs SATVIS2, which this capture does not contain">0</div>` +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

/** Horizon, 30°/60° rings and the compass labels — drawn once, dots are added per capture. */
function skySvg() {
  const size = 300;
  const c = size / 2;
  return (
    `<svg class="mg-sky-svg" viewBox="0 0 ${size} ${size}" role="img" ` +
    'aria-label="Polar sky plot: horizon, 30 and 60 degree elevation rings; RANGE carries no azimuth or elevation, so the dots are symbolic">' +
    `<circle class="mg-sky-disc" cx="${c}" cy="${c}" r="148"/>` +
    `<circle class="mg-sky-ring" cx="${c}" cy="${c}" r="98"/>` +
    `<circle class="mg-sky-ring mg-sky-ring-inner" cx="${c}" cy="${c}" r="74"/>` +
    `<line class="mg-sky-axis" x1="2" y1="${c}" x2="${size - 2}" y2="${c}"/>` +
    `<line class="mg-sky-axis" x1="${c}" y1="2" x2="${c}" y2="${size - 2}"/>` +
    `<text class="mg-sky-dir" x="${c + 6}" y="14">N</text>` +
    `<text class="mg-sky-dir" x="${size - 14}" y="${c + 5}">E</text>` +
    `<text class="mg-sky-dir" x="4" y="${c + 5}">W</text>` +
    `<text class="mg-sky-dir" x="${c + 6}" y="${size - 5}">S</text>` +
    `<text class="mg-sky-deg" x="${c + 6}" y="${c - 94}">30&deg;</text>` +
    `<text class="mg-sky-deg" x="${c + 6}" y="${c - 70}">60&deg;</text>` +
    '<g class="mg-sky-sats" data-el="skySats"></g>' +
    '</svg>'
  );
}

/** A dropdown entry: a leaf (`data-menu-item`) or a nested flyout (`data-submenu`). */
function dropEntry(entry) {
  if (!entry.items) {
    const off = entry.wired ? '' : ' is-off';
    const disabled = entry.wired ? '' : `aria-disabled="true" disabled title="${esc(UNWIRED_NOTE)}"`;
    return (
      `<button type="button" class="mg-drop-item${off}" data-menu-item="${esc(entry.key)}" ` +
      `role="menuitem" ${disabled}>${esc(entry.label)}</button>`
    );
  }
  const entries = entry.items.map(dropEntry).join('');
  return (
    '<span class="mg-drop-host mg-drop-nested">' +
    `<button type="button" class="mg-drop-item mg-drop-parent" data-submenu="${esc(entry.key)}" ` +
    `role="menuitem" aria-haspopup="true" aria-expanded="false">${esc(entry.label)}` +
    '<span class="mg-drop-arrow" aria-hidden="true">›</span></button>' +
    `<span class="mg-drop mg-drop-fly" data-drop="${esc(entry.key)}" hidden>${entries}</span>` +
    '</span>'
  );
}

function menuBar() {
  const items = MENU.map((item) => {
    const off = item.wired ? '' : ' is-off';
    const title = item.wired ? `${item.label} — this page` : `${item.label}: ${UNWIRED_NOTE}`;
    const button =
      `<button type="button" class="mg-menu-btn${off}${item.wired && !item.items ? ' is-current' : ''}" ` +
      `data-menu="${esc(item.key)}" role="menuitem" title="${esc(title)}" ` +
      `${item.wired ? '' : 'aria-disabled="true" disabled'}>` +
      `<span class="mg-menu-icon" aria-hidden="true">${ICONS[item.icon] ?? ''}</span>` +
      `<span class="mg-menu-text">${esc(item.label)}</span>` +
      (item.caret ? '<span class="mg-menu-caret" aria-hidden="true"></span>' : '') +
      '</button>';
    if (!item.items) return button;
    const entries = item.items.map(dropEntry).join('');
    return `<span class="mg-drop-host">${button}<span class="mg-drop" data-drop="${esc(item.key)}" hidden>${entries}</span></span>`;
  }).join('');
  return (
    '<div class="mg-menubar" role="menubar" aria-label="Device pages">' +
    items +
    '<span class="mg-menu-spacer"></span>' +
    '<span class="mg-bell" aria-hidden="true"></span>' +
    '<span class="mg-bell-count">0</span>' +
    '</div>'
  );
}

function template() {
  return `
<div class="mg-device" data-el="device" hidden>
  ${menuBar()}

  <div class="mg-band">
    <div class="mg-band-inner">
      <div class="mg-band-half mg-band-left">
        <div class="mg-band-head">
          <span class="mg-band-title">Positioning</span>
          <span class="mg-badge mg-badge-good" data-el="bandPosBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-band-fields">
          <div class="mg-band-row mg-r1c1">
            <span class="mg-band-label">Position</span>
            <span class="mg-band-value mg-underlined" data-el="bandPosition">--</span>
          </div>
          <div class="mg-band-row mg-r2c1">
            <span class="mg-band-label">Latitude</span>
            <span class="mg-band-value" data-el="bandLat">--</span>
          </div>
          <div class="mg-band-row mg-r3c1">
            <span class="mg-band-label">Longitude</span>
            <span class="mg-band-value" data-el="bandLon">--</span>
          </div>
          <div class="mg-band-row mg-r2c2">
            <span class="mg-band-label">Height (MSL)</span>
            <span class="mg-band-value" data-el="bandHeight">--</span>
          </div>
        </div>
      </div>

      <div class="mg-band-split" aria-hidden="true"></div>

      <div class="mg-band-half mg-band-device">
        <div class="mg-band-head">
          <span class="mg-band-title">Device</span>
          <span class="mg-badge mg-badge-good" data-el="bandDevBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-band-fields mg-band-fields-device">
          <div class="mg-band-row mg-r1c1">
            <span class="mg-band-label">Model</span>
            <span class="mg-band-value" data-el="bandModel">--</span>
          </div>
          <div class="mg-band-row mg-r2c1">
            <span class="mg-band-label">CPU Usage</span>
            <span class="mg-band-value" data-el="bandCpu">--</span>
          </div>
          <div class="mg-band-row mg-r3c1">
            <span class="mg-band-label">Logging</span>
            <span class="mg-band-value" data-el="bandLogging">--</span>
          </div>
          <div class="mg-band-row mg-r1c2">
            <span class="mg-band-label">Time (UTC)</span>
            <span class="mg-band-value" data-el="bandTime">--</span>
          </div>
          <div class="mg-band-row mg-r2c2">
            <span class="mg-band-label">Interference</span>
            <span class="mg-band-value" data-el="bandInterference">Not detected</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="mg-page">
    <div class="mg-mode" data-el="mode" data-mode="capture" role="status" aria-live="polite">
      <span class="mg-mode-badge" data-el="modeBadge" data-tone="off">Capture</span>
      <span class="mg-mode-source" data-el="modeSource">no capture</span>
      <span class="mg-mode-detail" data-el="modeDetail"></span>
      <span class="mg-mode-spacer"></span>
      <button type="button" class="mg-mode-action" data-mode-action="connect">Connect live…</button>
      <button type="button" class="mg-mode-action" data-mode-action="disconnect" hidden>Disconnect</button>
      <button type="button" class="mg-mode-action" data-mode-action="replay" hidden>Back to capture replay</button>
    </div>

    <div class="mg-tabstrip" role="tablist" aria-label="Status pages">
      <button type="button" class="mg-tab is-active" role="tab" aria-selected="true">Positioning</button>
      <button type="button" class="mg-tab is-off" role="tab" aria-selected="false" disabled
              title="Tracking: ${esc(UNWIRED_NOTE)}">Tracking</button>
    </div>

    <div class="mg-grid">
      <section class="mg-card" data-area="positioning">
        <div class="mg-card-head">
          <h2 class="mg-heading">Positioning</h2>
          <span class="mg-badge mg-badge-good" data-el="cardPosBadge" data-tone="good">Good</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Operating Mode', 'posMode')}
          ${kvRow('Position', 'posPosition', 'mg-underlined')}
          ${kvRow('Latitude', 'posLat')}
          ${kvRow('Longitude', 'posLon')}
          ${kvRow('Height (MSL)', 'posHeight')}
          ${kvRow('Height Accuracy', 'posHeightAcc')}
          ${kvRow('2d-SD', 'pos2d')}
          ${kvRow('Datum', 'posDatum')}
        </div>
        <p class="mg-reason" data-el="posReason"></p>
        <button type="button" class="mg-help" data-help="positioning"
                title="Positioning comes from the first BESTPOS (#42) record of the capture, or the newest BESTPOS in a live session: Operating Mode is solution_status, Position is position_type, Height Accuracy is height_std_dev, 2d-SD is sqrt(latitude_std_dev² + longitude_std_dev²).">Help</button>
      </section>

      <section class="mg-card" data-area="device">
        <div class="mg-card-head">
          <h2 class="mg-heading">Device</h2>
        </div>
        <div class="mg-kv mg-device-list">
          ${deviceRow('CPU Usage', 'devCpu', 'devCpuBadge')}
          ${deviceRow('Temperature', 'devTemp', 'devTempBadge')}
          ${deviceRow('Antenna Voltage', 'devVoltage', 'devVoltageBadge')}
          ${deviceRow('Antenna Current', 'devCurrent', 'devCurrentBadge')}
        </div>
        <p class="mg-reason" data-el="devReason"></p>
        <button type="button" class="mg-help" data-help="device"
                title="Device readings are HWMONITOR (#963) measurements[]: the status word's high byte is the reading type (1 temperature · 2 antenna current · 7 antenna voltage), the low byte the boundary limit the badge reports. In a live session the session decoder keeps idleTime, so CPU Usage prints 100 − idleTime / 2; a capture's binary HWMONITOR has no idleTime and stays --.">Help</button>
      </section>

      <section class="mg-card" data-area="interference">
        <div class="mg-card-head">
          <h2 class="mg-heading">Interference</h2>
          <span class="mg-badge mg-badge-good" data-el="intBadge" data-tone="good">Good</span>
        </div>
        <p class="mg-interference" data-el="interference">Not detected</p>
        <p class="mg-reason" data-el="intReason"></p>
        <button type="button" class="mg-help" data-help="interference"
                title="Interference reads ITDETECTSTATUS (#2065): rfPath, detection method and the four parameters, with the tile badge driven by the severity words. A live session that does not log #2065 prints -- and says so; the captures in this build do not contain it, so capture mode keeps the original's Not detected with no number invented.">Help</button>
      </section>

      <section class="mg-card" data-area="ports">
        <div class="mg-card-head">
          <h2 class="mg-heading">Ports</h2>
          <span class="mg-badge mg-badge-unknown" data-el="portsBadge" data-tone="unknown">--</span>
        </div>
        <div class="mg-port-head">
          <span>Port</span><span>Rate</span><span>Logs</span><span>State</span>
        </div>
        <div class="mg-port-list" data-el="portsList"></div>
        <p class="mg-reason" data-el="portsReason"></p>
        <button type="button" class="mg-help" data-help="ports"
                title="Ports status (manual 2.3.4). Rate and framing are SERIALCONFIG (#1246, one record per serial port); Logs is how many entries of LOGLIST (#5) name that port; State is the receiver's own counters from PORTSTATS (#72): red when framing/parity/over-run counters moved, green when a log is attached or bytes moved, amber when the port is configured but idle, grey when nothing touches it. Input/Output need INTERFACEMODE (#3), which these captures do not carry, so those two columns print --.">Help</button>
      </section>

      <section class="mg-card" data-area="logging">
        <div class="mg-card-head">
          <h2 class="mg-heading">Logging</h2>
          <span class="mg-badge mg-badge-unknown" data-el="logBadge" data-tone="unknown">--</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Status', 'logStatus')}
          ${kvRow('Log File Size', 'logSize')}
          ${kvRow('Log File Name', 'logName')}
          ${kvRow('Messages', 'logMessages')}
        </div>
        <p class="mg-reason" data-el="logReason"></p>
        <button type="button" class="mg-help" data-help="logging"
                title="Logging status (manual 2.3.5) reads FILESTATUS (#2127): file_status, file_name, file_size and the log's message list. This model has no file-log subsystem — LOG FILESTATUS ONCE answers <ERROR:Message is invalid for this model and emits no record — and none of the b1..b5 captures contains #2127, so every field prints -- and the tile says so instead of inventing an empty file.">Help</button>
      </section>

      <section class="mg-card mg-card-wide" data-area="satellite">
        <div class="mg-card-head">
          <h2 class="mg-heading">Satellite View</h2>
          <span class="mg-badge mg-badge-unknown" data-el="satBadge" data-tone="unknown">--</span>
        </div>
        <div class="mg-sat-body">
          <div class="mg-sat-left">
            <div class="mg-sat-legend">
              <div class="mg-tracked">
                <p>Tracked</p>
                <div>
                  <div class="mg-inuse">In Use</div>
                  <div class="mg-notused">Not Used</div>
                </div>
              </div>
              <div class="mg-missing">Missing</div>
            </div>
            <div class="mg-shapes">${CONSTELLATIONS.map(satRow).join('')}</div>
            <p class="mg-sat-note" data-el="satNote">Counting RANGE (#43) observations…</p>
          </div>
          <div class="mg-sat-right" data-el="sky">${skySvg()}</div>
        </div>
        <button type="button" class="mg-help" data-help="satellite"
                title="Satellite View counts RANGE (#43) observations: system = (c_status >> 16) & 7 (0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC), In Use = distinct sv_prn in the newest epoch, Not Used = PRNs seen in earlier epochs only. In a live session SATVIS2 (#1043) adds real azimuth/elevation for the sky dots and Missing = visible but not in the newest epoch; a capture has neither, so its dots are symbolic and Missing stays 0.">Help</button>
      </section>

      <section class="mg-card" data-area="ppp">
        <div class="mg-card-head">
          <h2 class="mg-heading">PPP Corrections</h2>
          <span class="mg-badge mg-badge-off" data-el="pppBadge" data-tone="off">Off</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Subscribed', 'pppSubscribed')}
          ${kvRow('Locked', 'pppLocked')}
          ${kvRow('Lband Tracking', 'pppLband')}
          ${kvRow('Primary Signal', 'pppPrimary')}
          ${kvRow('Signal Strength', 'pppSignal')}
          ${kvRow('Bit Success Rate', 'pppBitRate')}
          ${kvRow('PPP NTRIP (SID) Link', 'pppNtrip')}
          ${kvRow('PPP Position', 'pppPosition')}
          ${kvRow('DOP (G/P/H/V)', 'pppDop')}
        </div>
        <p class="mg-reason" data-el="pppReason"></p>
        <button type="button" class="mg-help" data-help="ppp"
                title="PPP Corrections (manual 2.3.10). Subscribed comes from TERRASTARINFO (#1719) / OCEANIXINFO (#2159) / VERIPOSINFO (#1728) — operating_mode plus the subscription_details word; a service the model does not report stays -- . Locked needs TERRASTARSTATUS (#1729) / OCEANIXSTATUS (#2160) / VERIPOSDECODERSTATUS (#2075), Lband Tracking needs LBANDTRACKSTAT (#1201), PPP NTRIP needs NTRIPCONFIG (#1249): whichever of those the opened capture lacks prints -- with the id named on the tile. PPP Position and DOP are PPPPOS (#1538), PPPDOP (#1997) and PPPDOP2 (#1546) exactly as the receiver wrote them.">Help</button>
      </section>

      <section class="mg-card" data-area="radio">
        <div class="mg-card-head">
          <h2 class="mg-heading">Radio</h2>
          <span class="mg-badge mg-badge-off" data-el="radioBadge" data-tone="off">Off</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Status', 'radioStatus')}
          ${kvRow('Comm Port', 'radioPort')}
          ${kvRow('Failed Command', 'radioFailed')}
        </div>
        <p class="mg-reason" data-el="radioReason"></p>
        <button type="button" class="mg-help" data-help="radio"
                title="Radio status (manual 2.3.11) reads SATELSTATUS (#2205) and the SATELDETECT (#2204) reply. The manual says the tile only exists on systems with an external transmit radio; neither record is in any b1..b5 capture, so the tile keeps the manual's own Off state instead of printing a made-up Good.">Help</button>
      </section>

      <section class="mg-card" data-area="align">
        <div class="mg-card-head">
          <h2 class="mg-heading">ALIGN</h2>
          <span class="mg-badge mg-badge-unknown" data-el="alignBadge" data-tone="unknown">--</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Heading', 'alignHeading')}
          ${kvRow('Pitch', 'alignPitch')}
          ${kvRow('Baseline', 'alignBaseline')}
        </div>
        <p class="mg-reason" data-el="alignReason"></p>
        <button type="button" class="mg-help" data-help="align"
                title="ALIGN status (manual 2.3.8) reads HEADING2 (#1335) — heading, pitch, baseline length and their standard deviations — falling back to DUALANTENNAALIGN (#1761). Two ALIGN receivers or a dual-antenna receiver are required; MODELFEATURES (#1329) says this unit is authorized for ALIGN but reports ANTENNA = SINGLE, and no capture carries #1335/#1761, so the values stay --.">Help</button>
      </section>

      <section class="mg-card" data-area="span">
        <div class="mg-card-head">
          <h2 class="mg-heading">SPAN</h2>
          <span class="mg-badge mg-badge-off" data-el="spanBadge" data-tone="off">Off</span>
        </div>
        <div class="mg-kv">
          ${kvRow('Status', 'spanStatus')}
          ${kvRow('Position Type', 'spanType')}
          ${kvRow('Alignment', 'spanAlignment')}
          ${kvRow('Converged', 'spanConverged')}
          ${kvRow('Azimuth', 'spanAzimuth')}
          ${kvRow('Pitch', 'spanPitch')}
          ${kvRow('Roll', 'spanRoll')}
          ${kvRow('North Velocity', 'spanNorth')}
          ${kvRow('East Velocity', 'spanEast')}
          ${kvRow('Up Velocity', 'spanUp')}
          ${kvRow('Latitude', 'spanLat')}
          ${kvRow('Longitude', 'spanLon')}
          ${kvRow('Height (MSL)', 'spanHeight')}
        </div>
        <p class="mg-reason" data-el="spanReason"></p>
        <button type="button" class="mg-help" data-help="span"
                title="SPAN status (manual 2.3.9) reads INSPVAX (#1465): ins_solution_status, position_type, azimuth/pitch/roll, the three velocities, the position and the standard deviations beside each value. Alignment and Converged have no field of their own in INSPVAX, so they stay -- rather than being inferred. MODELFEATURES (#1329) reports IMU and INS as UNAUTHORIZED on this unit and no capture carries #1465.">Help</button>
      </section>

      <section class="mg-card mg-card-wide" data-area="tracking">
        <div class="mg-card-head">
          <h2 class="mg-heading">Satellite Tracking</h2>
          <span class="mg-badge mg-badge-unknown" data-el="trackBadge" data-tone="unknown">--</span>
          <div class="mg-track-tools">
            <div class="mg-track-consts" data-el="trackConsts" role="group" aria-label="Constellation"></div>
            <div class="mg-track-metrics" role="group" aria-label="Graph">
              <button type="button" class="mg-track-metric is-active" data-track-metric="cno" aria-pressed="true">Carrier-to-Noise</button>
              <button type="button" class="mg-track-metric" data-track-metric="lock" aria-pressed="false">Lock Time</button>
            </div>
          </div>
        </div>
        <div class="mg-track-legend" data-el="trackLegend"></div>
        <div class="mg-track-body" data-el="trackBody"></div>
        <p class="mg-reason" data-el="trackReason"></p>
        <button type="button" class="mg-help" data-help="tracking"
                title="Satellite Tracking (manual 2.3.12) is the newest RANGE (#43) epoch: one row per satellite, one bar per signal, C/No in dB-Hz and lock time in seconds taken straight from obs[].C_No and obs[].lock_time. The signal name comes from (c_status >> 21) & 0x1f, the same split packages/graph/src/range-charts.ts verifies against the goldens. Elevation/azimuth come from SATVIS2 (#1043) and print -- when that record has no entry for the PRN. Bar colours follow the shipped thresholds: C/No poor < 20, warning < 35, good >= 35 dB-Hz (axis 0..60); lock time < 1800 s, 1800..3600 s, > 3600 s.">Help</button>
      </section>
    </div>
  </div>
</div>

<div class="mg-list" data-el="list" hidden>
  <div class="mg-list-head">
    <h1 class="mg-list-title">All captures</h1>
    <button type="button" class="mg-add-device" data-mode-action="connect" title="Add Device: open the live connection drawer (serial COM port or TCP bridge)."><span class="mg-plus" aria-hidden="true"></span>Add Device</button>
  </div>
  <p class="mg-list-note" data-el="listNote">Reading the capture list…</p>
  <div class="mg-list-grid" data-el="listCards"></div>
  <p class="mg-list-help"><span class="mg-help-disc" aria-hidden="true">?</span>
    One card per capture under <code>逆向/00_来源/samples</code>. Open one to see the device
    dashboard the original shows for a connected receiver.</p>
</div>

<div class="notice mg-notice" data-el="error" hidden></div>

<div class="mg-terminal" data-el="terminal" role="dialog" aria-label="Terminal" hidden>
  <div class="mg-term-head">
    <span class="mg-term-title">Terminal</span>
    <span class="mg-term-status" data-term="status">Not connected</span>
    <button type="button" class="mg-term-close" data-term="close" aria-label="Close">×</button>
  </div>
  <div class="mg-term-rows">
    <label class="mg-term-field"><span>Serial</span>
      <input type="text" data-term="path" placeholder="COM8" spellcheck="false"></label>
    <label class="mg-term-field"><span>Baud</span>
      <input type="text" data-term="baud" value="115200" spellcheck="false"></label>
    <label class="mg-term-field"><span>or TCP</span>
      <input type="text" data-term="host" placeholder="127.0.0.1" spellcheck="false"></label>
    <label class="mg-term-field"><span>Port</span>
      <input type="text" data-term="port" placeholder="3001" spellcheck="false"></label>
    <button type="button" class="mg-term-btn" data-term="connect">Connect</button>
    <button type="button" class="mg-term-btn" data-term="disconnect">Disconnect</button>
  </div>
  <div class="mg-term-output" data-term="output" tabindex="0"></div>
  <form class="mg-term-send" data-term="form">
    <span class="mg-term-prompt" aria-hidden="true">&gt;</span>
    <input type="text" data-term="line" placeholder="LOG COM1 BESTPOSB ONTIME 1" spellcheck="false" autocomplete="off">
    <button type="submit" class="mg-term-btn">Send</button>
  </form>
</div>

<div class="mg-cfg mg-adddev" data-el="adddev" role="dialog" aria-modal="true" aria-label="Add Device" hidden>
  <div class="mg-cfg-sheet mg-adddev-sheet">
    <div class="mg-cfg-head">
      <span class="mg-cfg-title">Add Device</span>
      <button type="button" class="mg-cfg-close" data-adddev="close" aria-label="Close">×</button>
    </div>
    <div class="mg-adddev-body">
      <section class="mg-adddev-found">
        <div class="mg-adddev-bar">
          <h2 class="mg-adddev-h">Receivers on this machine</h2>
          <button type="button" class="mg-cfg-btn mg-cfg-btn-quiet" data-adddev="refresh">Scan again</button>
        </div>
        <p class="mg-adddev-note" data-adddev="note">Scanning serial ports…</p>
        <div class="mg-adddev-list" data-adddev="list"></div>
      </section>
      <section class="mg-adddev-manual">
        <h2 class="mg-adddev-h">Connect by address</h2>
        <div class="mg-adddev-rows">
          <label class="mg-adddev-field"><span>Serial port</span>
            <input type="text" data-adddev="path" placeholder="COM10" spellcheck="false"></label>
          <label class="mg-adddev-field"><span>Baud</span>
            <input type="text" data-adddev="baud" value="115200" spellcheck="false"></label>
          <label class="mg-adddev-field"><span>TCP / UDP host</span>
            <input type="text" data-adddev="host" placeholder="192.168.1.20" spellcheck="false"></label>
          <label class="mg-adddev-field"><span>Port</span>
            <input type="text" data-adddev="port" placeholder="3001" spellcheck="false"></label>
        </div>
        <div class="mg-adddev-manual-actions">
          <button type="button" class="mg-cfg-btn" data-adddev="manual">Connect</button>
          <button type="button" class="mg-cfg-btn mg-cfg-btn-quiet" data-adddev="udp">UDP</button>
        </div>
      </section>
    </div>
    <div class="mg-adddev-foot">
      <span class="mg-adddev-status" data-adddev="status"></span>
      <div class="mg-adddev-foot-actions">
        <button type="button" class="mg-cfg-btn mg-cfg-btn-quiet" data-adddev="terminal">Terminal</button>
        <button type="button" class="mg-cfg-btn" data-adddev="add" disabled>Add Device</button>
      </div>
    </div>
  </div>
</div>

<div class="mg-config" data-el="config" role="dialog" aria-label="Configuration" hidden>
  <div class="mg-config-head">
    <span class="mg-config-title" data-config="title">Configuration</span>
    <label class="mg-config-pick">
      <span class="mg-config-pick-label">Page</span>
      <select class="mg-config-select" data-config="page"></select>
    </label>
    <span class="mg-config-note" data-config="note">Replaces nothing: the shipped page, served by the suite's own controller.</span>
    <button type="button" class="mg-config-close" data-config="close" aria-label="Close configuration">×</button>
  </div>
  <iframe class="mg-config-frame" data-config="frame" title="Configuration page"></iframe>
</div>

<div class="mg-cfg" data-el="cfg" role="dialog" aria-modal="true" aria-label="Device configuration file" hidden>
  <div class="mg-cfg-sheet">
    <div class="mg-cfg-head">
      <span class="mg-cfg-title" data-cfg="title">Configuration file</span>
      <button type="button" class="mg-cfg-close" data-cfg="close" aria-label="Close">×</button>
    </div>
    <div class="mg-cfg-tabs" role="tablist">
      <button type="button" class="mg-cfg-tab is-active" data-cfg-tab="export" role="tab" aria-selected="true">Export</button>
      <button type="button" class="mg-cfg-tab" data-cfg-tab="import" role="tab" aria-selected="false">Import</button>
    </div>
    <section class="mg-cfg-body" data-cfg-body="export">
      <p class="mg-cfg-state" data-cfg="exportState">Checking the receiver…</p>
      <p class="mg-cfg-reason" data-cfg="exportReason"></p>
      <p class="mg-cfg-line" data-cfg="exportFile"></p>
      <div class="mg-cfg-actions">
        <button type="button" class="mg-cfg-btn" data-cfg="download" disabled>Download .cfg</button>
        <button type="button" class="mg-cfg-btn mg-cfg-btn-quiet" data-cfg="refresh">Re-check</button>
      </div>
    </section>
    <section class="mg-cfg-body" data-cfg-body="import" hidden>
      <p class="mg-cfg-state" data-cfg="importState">Parse first — the .cfg is read with the shipped loader, nothing is sent.</p>
      <label class="mg-cfg-pick">
        <span>Choose a .cfg</span>
        <input type="file" data-cfg="file" accept=".cfg,.txt,.gps,.asc">
      </label>
      <textarea class="mg-cfg-text" data-cfg="text" spellcheck="false"
        placeholder="…or paste the file’s text here"></textarea>
      <div class="mg-cfg-actions">
        <button type="button" class="mg-cfg-btn" data-cfg="parse">Parse</button>
        <button type="button" class="mg-cfg-btn mg-cfg-btn-primary" data-cfg="import" disabled>Import to receiver</button>
      </div>
      <p class="mg-cfg-reason" data-cfg="importReason"></p>
      <pre class="mg-cfg-report" data-cfg="report" hidden></pre>
    </section>
  </div>
</div>

<div class="mg-reset" data-el="reset" role="dialog" aria-modal="true" aria-labelledby="mg-reset-title" hidden>
  <div class="mg-reset-sheet">
    <div class="mg-reset-head">
      <span class="mg-reset-title" id="mg-reset-title" data-reset="title">Restart Confirmation</span>
      <button type="button" class="mg-reset-close" data-reset="close" aria-label="Close">×</button>
    </div>
    <div class="mg-reset-body">
      <p class="mg-reset-text" data-reset="body"></p>
      <p class="mg-reset-question" data-reset="question"></p>
      <div class="mg-reset-cmd">
        <span class="mg-reset-cmd-label">Line sent</span>
        <code data-reset="command">RESET</code>
      </div>
      <label class="mg-reset-type" data-reset="typeWrap" hidden>
        <span class="mg-reset-type-label" data-reset="typeLabel">Type the receiver model to confirm</span>
        <input class="mg-reset-input" type="text" data-reset="typed" autocomplete="off" spellcheck="false">
      </label>
      <label class="mg-reset-erase" data-reset="eraseWrap" hidden>
        <input type="checkbox" data-reset="eraseNvm">
        <span>Erase NVM (the shipped SOFTLOAD… series runs before the command; this is the original's #erase-nvm)</span>
      </label>
      <p class="mg-reset-state" data-reset="state" data-tone="idle"></p>
      <p class="mg-reset-reason" data-reset="reason"></p>
    </div>
    <div class="mg-reset-actions">
      <button type="button" class="mg-reset-btn mg-reset-btn-go" data-reset="go" disabled>Restart device</button>
      <button type="button" class="mg-reset-btn mg-reset-btn-quiet" data-reset="cancel">Cancel</button>
    </div>
  </div>
</div>`;
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__manageCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__manageCleanup = null;
}

export function mount(root, ctx = {}) {
  unmount(root);
  ensureCss();

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();
  root.classList.add('manage-panel');
  root.innerHTML = template();
  const el = collect(root);

  /* ---------------- live session + terminal (one poller feeds both) ---------------- */

  const term = { open: false, backfilling: false, lines: [] };
  const termEls = {};
  for (const node of root.querySelectorAll('[data-term]')) termEls[node.dataset.term] = node;

  /* ---- Configuration drawer: the shipped pages, served by the suite's own controller ---- */

  const configEls = {};
  for (const node of root.querySelectorAll('[data-config]')) configEls[node.dataset.config] = node;
  const fileEls = {};
  for (const node of root.querySelectorAll('[data-cfg]')) fileEls[node.dataset.cfg] = node;

  const drawer = { pages: null, page: '' };

  /** `/api/config/pages` is fetched once: the 14 pill pages plus the operational ones (Events). */
  async function configPages() {
    if (drawer.pages) return drawer.pages;
    try {
      const data = await api.get('/api/config/pages');
      drawer.pages = Array.isArray(data.pages) ? data.pages : [];
    } catch (error) {
      drawer.pages = [];
      if (configEls.note) configEls.note.textContent = `Page list failed: ${error.message}`;
    }
    if (configEls.page) {
      // Grouped by the menu the page belongs to, so the same one select covers Configuration and
      // Settings without pretending they are the same page family.
      const groups = [
        {
          label: 'Configuration',
          pages: drawer.pages.filter((page) => !page.settings && !page.operational && !page.tools),
        },
        {
          label: 'Settings',
          pages: drawer.pages.filter(
            (page) => page.settings && !DEVICE_PAGES.has(page.name) && !page.tools,
          ),
        },
        { label: 'Tools', pages: drawer.pages.filter((page) => page.tools) },
        { label: 'Device', pages: drawer.pages.filter((page) => DEVICE_PAGES.has(page.name)) },
        { label: 'Operational', pages: drawer.pages.filter((page) => page.operational) },
      ].filter((group) => group.pages.length);
      configEls.page.innerHTML = groups
        .map(
          (group) =>
            `<optgroup label="${esc(group.label)}">` +
            group.pages
              .map((page) => `<option value="${esc(page.name)}">${esc(page.label)}</option>`)
              .join('') +
            '</optgroup>',
        )
        .join('');
      if (drawer.page) configEls.page.value = drawer.page;
    }
    return drawer.pages;
  }

  function setConfigFrame(page) {
    if (!page) return;
    drawer.page = page;
    if (configEls.page) configEls.page.value = page;
    if (configEls.frame) {
      // Two pages read a capture rather than the live link: `Events` takes the capture's
      // `ITDETECTSTATUS` records, and `Interference Toolkit` (§2.2.9) takes the same records plus the
      // ITK configuration ones. The page's own script hands the name back so the server can read it.
      const fromCapture = page === 'events' || page === 'interferenceToolkit';
      const suffix = fromCapture && state.capture ? `?capture=${encodeURIComponent(state.capture)}` : '';
      configEls.frame.src = `/config/${encodeURIComponent(page)}${suffix}`;
    }
    const settings = SETTINGS_PAGES.has(page);
    const device = DEVICE_PAGES.has(page);
    const tools = TOOLS_PAGES.has(page);
    if (configEls.title) {
      configEls.title.textContent = device ? 'Device' : tools ? 'Tools' : settings ? 'Settings' : 'Configuration';
    }
    if (configEls.note) {
      const entry = (drawer.pages ?? []).find((item) => item.name === page);
      const family = device ? ' (Device page)' : tools ? ' (Tools page)' : settings ? ' (Settings page)' : '';
      configEls.note.textContent = entry
        ? `${entry.label}${family} — the suite’s shipped markup and controller (${page})`
        : page;
    }
  }

  async function openConfigDrawer(page) {
    if (!el.config) return;
    await configPages();
    el.config.hidden = false;
    setConfigFrame(page || drawer.page || 'portConfig');
  }

  function closeConfigDrawer() {
    if (!el.config) return;
    el.config.hidden = true;
    if (configEls.frame) configEls.frame.src = 'about:blank';
  }

  /* ---- Tools ▸ Device ▸ Export / Import Configuration (.cfg) ---- */

  const device = { status: null, parsed: null };

  function setCfgDisabled(node, disabled) {
    if (node) node.disabled = Boolean(disabled);
  }

  async function loadDeviceStatus() {
    try {
      device.status = await api.get('/api/config/device/status');
    } catch (error) {
      device.status = null;
      if (fileEls.exportReason) fileEls.exportReason.textContent = `Status failed: ${error.message}`;
      return;
    }
    const status = device.status;
    if (fileEls.exportState) {
      fileEls.exportState.textContent = status.connected
        ? 'A receiver session is open.'
        : 'No receiver connected — a .cfg is the receiver’s own configuration, so there is nothing to read it from.';
    }
    if (fileEls.exportReason) fileEls.exportReason.textContent = status.export?.reason ?? '';
    if (fileEls.exportFile) {
      fileEls.exportFile.textContent = status.suggestedFileName
        ? `File name the suite would use: ${status.suggestedFileName}` +
          (status.export?.records > 0 ? ` · ${status.export.records} receiver record(s) on the link` : '')
        : '';
    }
    if (fileEls.importReason) fileEls.importReason.textContent = status.import?.reason ?? '';
    setCfgDisabled(fileEls.download, !status.export?.available);
    setCfgDisabled(fileEls.import, !(status.import?.available && device.parsed?.ok));
  }

  function openDeviceModal(tab) {
    if (!el.cfg) return;
    el.cfg.hidden = false;
    selectCfgTab(tab);
    void loadDeviceStatus();
  }

  function closeDeviceModal() {
    if (el.cfg) el.cfg.hidden = true;
  }

  function selectCfgTab(tab) {
    for (const node of root.querySelectorAll('[data-cfg-tab]')) {
      const active = node.dataset.cfgTab === tab;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const node of root.querySelectorAll('[data-cfg-body]')) {
      node.hidden = node.dataset.cfgBody !== tab;
    }
    if (fileEls.title) {
      fileEls.title.textContent =
        tab === 'export' ? 'Export Configuration (.cfg)' : 'Import Configuration (.cfg)';
    }
  }

  function showReport(text) {
    if (!fileEls.report) return;
    fileEls.report.hidden = !text;
    fileEls.report.textContent = text ?? '';
  }

  async function downloadCfg() {
    try {
      const response = await fetch('/api/config/device/export');
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.includes('text/plain')) {
        const body = type.includes('application/json') ? await response.json() : null;
        showReport(`Export refused (HTTP ${response.status}): ${(body && body.reason) || 'no .cfg available'}`);
        return;
      }
      const text = await response.text();
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name ? name[1] : 'receiver.cfg';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showReport(`Downloaded ${anchor.download} (${text.length} bytes).`);
    } catch (error) {
      showReport(`Export failed: ${error.message}`);
    }
  }

  async function parseCfg() {
    const text = fileEls.text ? fileEls.text.value : '';
    try {
      const result = await api.post('/api/config/device/import/preview', { text });
      device.parsed = result;
      const lines = [
        `loadable commands: ${result.commands.length} · skipped lines: ${result.skipped} · comments: ${result.comments}`,
      ];
      if (result.currentPort) lines.push(`current port: ${result.currentPort} (its own CONFIG line is skipped)`);
      if (result.mismatches && result.mismatches.length) {
        lines.push(`version warnings: ${result.mismatches.join(', ')}`);
      }
      if (result.error) lines.push(`error: ${result.error}`);
      if (result.reason) lines.push(result.reason);
      for (const command of (result.commands ?? []).slice(0, 40)) lines.push(`  ${command}`);
      if ((result.commands ?? []).length > 40) {
        lines.push(`  … ${result.commands.length - 40} more`);
      }
      showReport(lines.join('\n'));
      if (fileEls.importState) {
        fileEls.importState.textContent = result.ok
          ? `Parsed — ${result.commands.length} command(s) would be sent.`
          : 'Parse finished, but nothing in this file can be loaded.';
      }
      setCfgDisabled(fileEls.import, !(device.status?.import?.available && result.ok));
    } catch (error) {
      showReport(`Parse failed: ${error.message}`);
    }
  }

  async function importCfg() {
    const text = fileEls.text ? fileEls.text.value : '';
    // One line goes out at a time and each waits for the receiver's own `<OK`/`<ERR…`; the button
    // stays disabled until the file is parsed again, so a second click cannot re-send a file whose
    // first line was already refused.
    setCfgDisabled(fileEls.import, true);
    if (fileEls.importReason) fileEls.importReason.textContent = '';
    if (fileEls.importState) {
      fileEls.importState.textContent =
        'Sending one line at a time — each line waits for the receiver’s <OK before the next one goes out.';
    }
    showReport('');
    try {
      const response = await fetch('/api/config/device/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const result = await response.json();
      applyImportOutcome(result, response.status);
      // A finished import must be re-parsed before it can run again (its text may have changed).
      device.parsed = null;
    } catch (error) {
      if (fileEls.importState) fileEls.importState.textContent = 'Import failed — nothing is claimed.';
      if (fileEls.importReason) fileEls.importReason.textContent = `Import failed: ${error.message}`;
      showReport(`Import failed: ${error.message}`);
    }
  }

  /**
   * Render one import answer. The reason under the button, the state line and the button's
   * disabled flag all come from this one object, so a failure cannot show one thing in the report
   * and another under the button.
   */
  function applyImportOutcome(result, httpStatus) {
    const answer = result ?? {};
    const steps = Array.isArray(answer.steps) ? answer.steps : [];
    const verification = answer.verification ?? null;
    const matched = verification ? Number(verification.matched) || 0 : 0;
    const absent = verification && Array.isArray(verification.absent) ? verification.absent : [];
    const report = [];
    if (answer.ok) {
      report.push(
        `Imported ${answer.sent} command(s): the receiver answered every line.`,
        `Read-back ${answer.verified ? 'confirmed' : 'did not confirm'} ${matched} of ${answer.sent}` +
          (absent.length ? ` · ${absent.length} line(s) are not reported by LOG RXCONFIG` : '') +
          '.',
      );
    } else {
      const status = httpStatus === 200 ? '' : ` (HTTP ${httpStatus})`;
      report.push(`Import stopped${status}: ${answer.reason ?? 'no reason given'}`);
    }
    for (const step of steps) {
      const verdict = step.verified ? ` · read-back ${step.verified}` : '';
      const reply = step.reply ?? `(no reply: ${step.status})`;
      report.push(`${step.ok ? 'OK  ' : 'FAIL'} ${step.index}. ${step.line} → ${reply} (${step.elapsedMs} ms)${verdict}`);
      if (step.verified === 'mismatch' && Array.isArray(step.readback)) {
        for (const line of step.readback) report.push(`      receiver: ${line}`);
      }
    }
    if (verification && verification.request) {
      report.push(`Read-back: ${verification.request} → ${verification.lines} configuration line(s).`);
    }
    showReport(report.join('\n'));
    if (fileEls.importReason) fileEls.importReason.textContent = answer.reason ?? '';
    if (fileEls.importState) {
      if (answer.ok) {
        fileEls.importState.textContent = answer.verified
          ? `Written: ${answer.sent} command(s) applied and read back.`
          : `Written: ${answer.sent} command(s) applied; the read-back did not confirm every line.`;
      } else if (answer.failedLine) {
        fileEls.importState.textContent = `Stopped at “${answer.failedLine}” — nothing after it was sent.`;
      } else {
        fileEls.importState.textContent = 'Import refused — nothing was written.';
      }
    }
    setCfgDisabled(fileEls.import, true);
  }

  /* ---- Device ▸ Restart / Factory Reset (the original's `deviceRestart.js`) ----
   *
   * The dialog is the only place that sends these lines. `resetGate` decides whether it may, and
   * `resetObserve` walks the wait afterwards; this block only posts what those two return and paints
   * the answer — so the shipped command strings and the "no retry" rule are testable without a page.
   */

  const resetEls = {};
  for (const node of root.querySelectorAll('[data-reset]')) resetEls[node.dataset.reset] = node;

  const reset = {
    kind: '',
    /** `null` until a command is on the wire; then the `resetObserve` state. */
    machine: null,
    /** The model the receiver reported before the reset (VERSION #37) — the Factory Reset token. */
    model: '',
    typed: '',
    /** The original's `#erase-nvm`: prepend the shipped SOFTLOAD lines (factory reset only). */
    eraseNvm: false,
    /** The one-shot VERSION request goes out once per reset, never twice. */
    verifySent: false,
    /** Auto-reconnect after the drop: one attempt at a time, retried every few seconds. */
    reconnecting: false,
    nextReconnect: 0,
    timer: 0,
  };

  /** The current session in the shape `resetGate` / `resetObserve` take. */
  function linkState() {
    return { connected: live.connected, session: live.session, target: live.target };
  }

  /**
   * The `/api/live/connect` body for the link that just dropped. `/api/live/status` gives a display
   * string (`tcp://host:port`, `COM10 @ 115200`), so parse it back; `null` when it is not one of the
   * two shapes this panel opens.
   */
  function reconnectTarget() {
    return resetReconnectBody(live.target);
  }

  /** After a Restart drops the link, open it again once every 3 s until the state machine moves on. */
  async function reconnectAfterReset() {
    if (reset.reconnecting) return;
    reset.reconnecting = true;
    reset.nextReconnect = Date.now() + 3000;
    const body = reconnectTarget();
    try {
      if (body) await api.post('/api/live/connect', body);
    } catch {
      /* the next tick tries again; the state machine's own deadline still bounds the wait */
    } finally {
      reset.reconnecting = false;
    }
  }

  /**
   * VERSION #37 of the **live session** — the Factory Reset token. A capture's model is never used
   * here: replay is not a receiver, and the token has to come from the thing being reset.
   */
  function liveModel() {
    const entry = live.latest.get(VERSION_LOG);
    return entry && entry.data && entry.data.kind === 'version' ? String(entry.data.model || '') : '';
  }

  function openResetDialog(kind) {
    const copy = resetCopy(kind);
    if (!el.reset || !copy) return;
    stopResetTimer();
    reset.kind = kind;
    reset.machine = null;
    reset.typed = '';
    reset.eraseNvm = false;
    reset.verifySent = false;
    reset.reconnecting = false;
    reset.nextReconnect = 0;
    reset.model = liveModel();
    setText(resetEls.title, copy.title);
    setText(resetEls.body, copy.body);
    setText(resetEls.question, copy.question);
    setText(resetEls.command, copy.command);
    if (resetEls.typed) resetEls.typed.value = '';
    if (resetEls.typeWrap) resetEls.typeWrap.hidden = !copy.needsModel;
    if (resetEls.eraseWrap) resetEls.eraseWrap.hidden = !copy.needsModel;
    if (resetEls.eraseNvm) resetEls.eraseNvm.checked = false;
    if (resetEls.typeLabel && copy.needsModel) resetEls.typeLabel.textContent = resetTypeLabel();
    el.reset.hidden = false;
    renderReset();
    if (copy.needsModel) resetEls.typed?.focus();
  }

  function resetTypeLabel() {
    return reset.model
      ? `Type the receiver’s model to confirm — ${reset.model}`
      : 'Type the receiver’s model to confirm — the receiver has not reported it yet (VERSION #37)';
  }

  function closeResetDialog() {
    if (el.reset) el.reset.hidden = true;
    stopResetTimer();
    reset.machine = null;
  }

  function startResetTimer() {
    stopResetTimer();
    reset.timer = setInterval(() => {
      if (!reset.machine) {
        stopResetTimer();
        return;
      }
      if (reset.machine.phase === 'done' || reset.machine.phase === 'failed') {
        stopResetTimer();
        return;
      }
      if (reset.machine.phase === 'awaiting-link'
        && Date.now() >= reset.nextReconnect
        && !reset.reconnecting) {
        void reconnectAfterReset();
      }
      const next = resetObserve(reset.machine, { type: 'tick', at: Date.now() });
      if (next.phase !== reset.machine.phase) {
        reset.machine = next;
        renderReset();
      }
    }, 1000);
  }

  function stopResetTimer() {
    if (reset.timer) {
      clearInterval(reset.timer);
      reset.timer = 0;
    }
  }

  function renderReset() {
    if (!resetEls.go) return;
    const phase = reset.machine ? reset.machine.phase : '';
    const finished = phase === 'done' || phase === 'failed';
    const running = Boolean(reset.machine) && !finished;
    resetEls.go.textContent = running
      ? 'Sending…'
      : finished
        ? 'Close'
        : RESET_ACTIONS[reset.kind]?.go ?? 'Send';
    if (resetEls.command && reset.kind) {
      const lines = resetCommands(reset.kind, { eraseNvm: reset.eraseNvm });
      setText(resetEls.command, lines.length > 1 ? lines.join(' → ') : lines[0] ?? '');
    }
    if (running) {
      const progress = resetPhaseText(reset.machine);
      setText(resetEls.state, progress.text);
      if (resetEls.state) resetEls.state.dataset.tone = progress.tone;
      setText(resetEls.reason, '');
      resetEls.go.disabled = true;
      if (resetEls.typed) resetEls.typed.disabled = true;
      return;
    }
    if (resetEls.typed) resetEls.typed.disabled = false;
    const gate = resetGate(reset.kind, {
      link: linkState(),
      model: reset.model,
      typed: reset.typed,
      eraseNvm: reset.eraseNvm,
      confirmed: true,
    });
    resetEls.go.disabled = finished ? false : !gate.ok;
    const answer = finished ? resetPhaseText(reset.machine) : { tone: 'idle', text: '' };
    setText(resetEls.state, answer.text);
    if (resetEls.state) resetEls.state.dataset.tone = answer.tone;
    setText(resetEls.reason, finished ? '' : gate.reason);
  }

  /**
   * One send, then the machine waits. The lines come from `resetGate`, so a Factory Reset cannot
   * leave this function without the typed model — and nothing here loops back on failure.
   */
  async function sendReset() {
    if (reset.machine) {
      if (reset.machine.phase === 'done' || reset.machine.phase === 'failed') closeResetDialog();
      return;
    }
    const gate = resetGate(reset.kind, {
      link: linkState(),
      model: reset.model,
      typed: reset.typed,
      eraseNvm: reset.eraseNvm,
      confirmed: true,
    });
    if (!gate.ok) {
      renderReset();
      return;
    }
    reset.machine = resetBegin(reset.kind, {
      at: Date.now(),
      session: live.session,
      model: reset.model,
    });
    reset.verifySent = false;
    reset.nextReconnect = 0;
    startResetTimer();
    renderReset();
    for (const line of gate.lines) {
      try {
        const status = await api.post('/api/live/command', { line });
        if (status && status.lastError) {
          reset.machine = resetObserve(reset.machine, {
            type: 'error',
            at: Date.now(),
            reason: `The receiver refused “${line}”: ${status.lastError}`,
          });
          renderReset();
          return;
        }
      } catch (error) {
        reset.machine = resetObserve(reset.machine, {
          type: 'error',
          at: Date.now(),
          reason: `POST /api/live/command failed for “${line}”: ${error.message}`,
        });
        renderReset();
        return;
      }
    }
  }

  /** The panel's own 900 ms poll, fed into the wait: drop first, then a session, then VERSION. */
  function feedResetLink() {
    if (!reset.machine) {
      /* An open dialog with nothing sent yet: a session may have appeared (or gone) while it sat
       * there, and the button has to follow that. No command is ever sent from here. */
      if (el.reset && !el.reset.hidden && reset.kind) renderReset();
      return;
    }
    const before = reset.machine.phase;
    const next = resetObserve(reset.machine, {
      type: 'link',
      connected: live.connected,
      session: live.session,
      at: Date.now(),
    });
    if (next.phase === before) return;
    reset.machine = next;
    if (next.phase === 'awaiting-version' && !reset.verifySent) {
      reset.verifySent = true;
      void sendVerifyLine();
    }
    renderReset();
  }

  /** `LOG VERSIONB ONCE` — the log the original takes before a restart, read once afterwards. */
  async function sendVerifyLine() {
    try {
      await api.post('/api/live/command', { line: RESET_VERIFY_LINE });
    } catch (error) {
      if (!reset.machine) return;
      reset.machine = resetObserve(reset.machine, {
        type: 'error',
        at: Date.now(),
        reason: `VERSION read-back “${RESET_VERIFY_LINE}” could not be sent: ${error.message}`,
      });
      renderReset();
    }
  }

  /** A VERSION record from the stream: the end of a reset wait, or the Factory Reset token. */
  function feedResetVersion(model) {
    if (!el.reset || el.reset.hidden) return;
    if (!reset.machine) {
      if (reset.kind !== 'factoryReset') return;
      if (!model || normalizeModel(model) === normalizeModel(reset.model)) return;
      reset.model = String(model);
      if (resetEls.typeLabel) resetEls.typeLabel.textContent = resetTypeLabel();
      renderReset();
      return;
    }
    if (reset.machine.phase !== 'awaiting-version') return;
    reset.machine = resetObserve(reset.machine, { type: 'version', model, at: Date.now() });
    renderReset();
  }

  /**
   * Everything the Status dashboard knows about the live link. `latest`/`ranges`/`satvis` are fed
   * incrementally from `/api/live/logs?after=<cursor>` so the device's one-shot VERSION record
   * survives the server's 400-record ring buffer.
   */
  const live = {
    connected: false,
    /** A live session existed at least once on this page — that is what "lost" means. */
    everConnected: false,
    /** The user chose "Back to capture replay" while the link was down. */
    dismissed: false,
    /** `connectedAt` of the session the cached data belongs to; a new one resets it. */
    session: '',
    target: '',
    disconnectedAt: '',
    lastError: '',
    lastRecordAt: '',
    cursor: 0,
    records: 0,
    /** Last `/api/live/status` body, so the Terminal can render without its own request. */
    status: null,
    latest: new Map(),
    ranges: [],
    satvis: new Map(),
    pollTimer: 0,
  };

  /** `live` wins over `lost` over `capture`; "lost" never silently falls back to replay. */
  function liveMode() {
    if (live.connected) return 'live';
    if (live.everConnected && !live.dismissed) return 'lost';
    return 'capture';
  }

  function resetLiveData() {
    live.latest = new Map();
    live.ranges = [];
    live.satvis = new Map();
    live.records = 0;
    live.lastRecordAt = '';
  }

  function applyLiveEntry(entry) {
    live.records += 1;
    if (entry.time) live.lastRecordAt = entry.time;
    const data = entry.data;
    if (!data) return;
    live.latest.set(entry.messageId, { data, time: entry.time, seq: entry.seq });
    if (data.kind === 'range') {
      live.ranges.push({ time: entry.time, observations: data.observations ?? [] });
      if (live.ranges.length > LIVE_RANGE_HISTORY) live.ranges.splice(0, live.ranges.length - LIVE_RANGE_HISTORY);
    } else if (data.kind === 'satvis') {
      const key = SATVIS_KEYS[String(data.system || '').toUpperCase()];
      if (key) live.satvis.set(key, { time: entry.time, satellites: data.satellites ?? [] });
    }
  }

  function termStatus(text) {
    if (termEls.status) termEls.status.textContent = text;
  }
  function termStatusText(status) {
    if (!status.connected) {
      return status.disconnectedAt ? `Disconnected — ${utcClock(status.disconnectedAt)} UTC` : 'Not connected';
    }
    const base = `Connected — ${status.target} — ${status.records} records`;
    return status.lastError ? `${base} — ${status.lastError}` : base;
  }
  function termAppend(text) {
    term.lines.push(text);
    if (term.lines.length > 400) term.lines.splice(0, term.lines.length - 400);
    if (termEls.output) {
      termEls.output.textContent = term.lines.join('\n');
      termEls.output.scrollTop = termEls.output.scrollHeight;
    }
  }

  /**
   * One poll for the whole panel: status first (the mode depends on it), then the log cursor. The
   * terminal drawer prints the same entries, so opening it never restarts or races the poll.
   */
  async function livePoll() {
    if (!state.alive) return;
    let status;
    try {
      status = await api.get('/api/live/status');
    } catch (error) {
      termStatus(`API error: ${error.message}`);
      /* The server itself is unreachable: stop claiming Live. The next successful poll restores
       * it (or reports the session gone), so this is not a dead end. */
      if (live.connected) {
        live.connected = false;
        live.lastError = `API error: ${error.message}`;
        live.disconnectedAt = live.disconnectedAt || new Date().toISOString();
        render();
      }
      return;
    }
    if (!state.alive) return;

    live.target = status.target || live.target;
    live.lastError = status.lastError || '';
    live.status = status;
    const connected = Boolean(status.connected);

    if (connected) {
      live.everConnected = true;
      live.dismissed = false;
      live.disconnectedAt = '';
      if (live.session !== (status.connectedAt || '')) {
        live.session = status.connectedAt || '';
        live.cursor = 0;
        resetLiveData();
      }
      if (status.lastRecordAt) live.lastRecordAt = status.lastRecordAt;
      try {
        const page = await api.get('/api/live/logs', { after: live.cursor });
        if (!state.alive) return;
        live.cursor = Number(page.cursor) || live.cursor;
        for (const entry of page.entries ?? []) {
          applyLiveEntry(entry);
          if (entry.messageId === VERSION_LOG && entry.data?.kind === 'version') {
            feedResetVersion(entry.data.model);
          }
          if (term.open && !term.backfilling) termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
        }
      } catch (error) {
        live.lastError = error.message;
      }
    } else {
      live.disconnectedAt = status.disconnectedAt || live.disconnectedAt;
    }

    live.connected = connected;
    termStatus(termStatusText(status));
    feedResetLink();

    /* A session opened from the Terminal (or before this page mounted) takes over the dashboard. */
    if (connected && !state.open) {
      state.open = true;
      setBodyState();
      renderDeviceShell();
    }
    render();
  }

  function startLivePolling() {
    stopLivePolling();
    live.pollTimer = setInterval(() => {
      void livePoll();
    }, 900);
    void livePoll();
  }
  function stopLivePolling() {
    if (live.pollTimer) {
      clearInterval(live.pollTimer);
      live.pollTimer = 0;
    }
  }

  async function termConnect() {
    const path = (termEls.path?.value ?? '').trim();
    const body = path
      ? { kind: 'serial', path, baud: Number(termEls.baud?.value) || 115200 }
      : { kind: 'tcp', host: (termEls.host?.value ?? '').trim() || '127.0.0.1', port: Number(termEls.port?.value) || 3001 };
    await connectLive(body, (line) => {
      term.lines = [];
      termAppend(line);
    });
  }

  /**
   * The one place a live session is opened. `report` prints a line where the caller shows text
   * (the Terminal's output, the Add Device dialog's status), so both doors behave the same and a
   * failure is never silent.
   */
  async function connectLive(body, report) {
    const say = typeof report === 'function' ? report : () => {};
    try {
      const status = await api.post('/api/live/connect', body);
      live.session = status.connectedAt || '';
      live.cursor = 0;
      live.everConnected = true;
      live.dismissed = false;
      resetLiveData();
      void livePoll();
      if (!live.pollTimer) startLivePolling();
      say(`Connected to ${status.target}`);
      return status;
    } catch (error) {
      say(`Connect failed: ${error.message}`);
      return null;
    }
  }
  async function termDisconnect() {
    try {
      await api.post('/api/live/disconnect', {});
      termAppend('Disconnected');
      live.disconnectedAt = new Date().toISOString();
      void livePoll();
    } catch (error) {
      termAppend(`Disconnect failed: ${error.message}`);
    }
  }
  /* ---- Add Device: the original's device list, filled from the machine's real ports ---- */

  const adddev = { open: false, loading: false, list: null, selected: null, busy: false, status: '' };
  const adddevEls = {};
  for (const node of root.querySelectorAll('[data-adddev]')) adddevEls[node.dataset.adddev] = node;

  function adddevSync() {
    const ports = adddev.list?.ports ?? [];
    const selected = ports.find((port) => port.path === adddev.selected);
    if (adddevEls.note) {
      if (adddev.loading) adddevEls.note.textContent = 'Scanning serial ports…';
      else if (!adddev.list) adddevEls.note.textContent = 'No scan yet.';
      else if (ports.length === 0) adddevEls.note.textContent = adddev.list.reason || 'No serial port found on this machine.';
      else adddevEls.note.textContent = `${ports.length} serial port${ports.length === 1 ? '' : 's'} found. Pick one, then Add Device.`;
    }
    if (adddevEls.status) adddevEls.status.textContent = adddev.status;
    if (adddevEls.add) {
      adddevEls.add.disabled = adddev.busy || !selected;
      adddevEls.add.textContent = selected ? `Add ${selected.path}` : 'Add Device';
    }
  }

  function adddevRenderList() {
    const listEl = adddevEls.list;
    if (!listEl) return;
    if (adddev.loading) {
      listEl.innerHTML = '<p class="mg-adddev-empty">Scanning…</p>';
      return;
    }
    const ports = adddev.list?.ports ?? [];
    if (ports.length === 0) {
      listEl.innerHTML =
        '<p class="mg-adddev-empty">Nothing to add yet. When the receiver is powered and its USB ' +
        'cable is in, its COM port appears here after <strong>Scan again</strong>.</p>';
      return;
    }
    listEl.innerHTML = ports.map((port) => {
      const active = adddev.selected === port.path ? ' is-active' : '';
      const name = port.friendlyName || port.path;
      return '<button type="button" class="mg-adddev-tile' + active + '" data-adddev-pick="' + esc(port.path) + '">' +
        `<span class="mg-adddev-tile-name">${esc(name)}</span>` +
        '<span class="mg-adddev-tile-row"><span>Type</span><span>Serial</span></span>' +
        `<span class="mg-adddev-tile-row"><span>Port</span><span>${esc(port.path)}</span></span>` +
        (port.manufacturer
          ? `<span class="mg-adddev-tile-row"><span>Manufacturer</span><span>${esc(port.manufacturer)}</span></span>`
          : '') +
        '</button>';
    }).join('');
  }

  async function scanPorts(force) {
    adddev.loading = true;
    adddevRenderList();
    adddevSync();
    try {
      const list = await api.get('/api/ports', force ? { refresh: 1 } : undefined);
      if (!state.alive) return;
      adddev.list = list;
      if (!list.ports?.some((port) => port.path === adddev.selected)) adddev.selected = null;
    } catch (error) {
      adddev.list = { available: false, ports: [], reason: `Port scan failed: ${error.message}` };
    } finally {
      adddev.loading = false;
      adddevRenderList();
      adddevSync();
    }
  }

  function openAddDevice() {
    if (!el.adddev) return;
    adddev.open = true;
    adddev.status = '';
    adddevLoad();
    el.adddev.hidden = false;
    adddevRenderList();
    adddevSync();
    void scanPorts(true);
  }

  /* The address fields survive a restart: retyping COM10/115200 every time is how a port gets
   * mistyped. Only the fields, never the session. */
  const ADDDEV_KEY = 'nas-adddev';

  function adddevLoad() {
    try {
      const saved = JSON.parse(localStorage.getItem(ADDDEV_KEY) || '{}');
      if (saved.path && adddevEls.path) adddevEls.path.value = saved.path;
      if (saved.baud && adddevEls.baud) adddevEls.baud.value = saved.baud;
      if (saved.host && adddevEls.host) adddevEls.host.value = saved.host;
      if (saved.port && adddevEls.port) adddevEls.port.value = saved.port;
    } catch {
      /* a corrupt value is not worth an error: the fields just stay empty */
    }
  }

  function adddevSave() {
    try {
      localStorage.setItem(ADDDEV_KEY, JSON.stringify({
        path: (adddevEls.path?.value ?? '').trim(),
        baud: (adddevEls.baud?.value ?? '').trim(),
        host: (adddevEls.host?.value ?? '').trim(),
        port: (adddevEls.port?.value ?? '').trim(),
      }));
    } catch {
      /* private mode: nothing to remember */
    }
  }

  function closeAddDevice() {
    adddev.open = false;
    if (el.adddev) el.adddev.hidden = true;
  }

  async function adddevConnect(body, label) {
    if (adddev.busy) return;
    adddev.busy = true;
    adddev.status = `Connecting to ${label}…`;
    adddevSync();
    const status = await connectLive(body, (line) => {
      adddev.status = line;
      adddevSync();
    });
    adddev.busy = false;
    if (status) {
      adddev.status = `Connected: ${status.target}`;
      closeAddDevice();
      render();
    }
    adddevSync();
  }

  const onAddDeviceClick = (event) => {
    const pick = event.target.closest('[data-adddev-pick]');
    if (pick && el.adddev?.contains(pick)) {
      adddev.selected = pick.dataset.adddevPick;
      adddevRenderList();
      adddevSync();
      return;
    }
    const node = event.target.closest('[data-adddev]');
    if (!node || !el.adddev?.contains(node)) return;
    const action = node.dataset.adddev;
    const baud = Number(adddevEls.baud?.value) || 115200;
    if (action === 'close') closeAddDevice();
    else if (action === 'refresh') void scanPorts(true);
    else if (action === 'terminal') {
      closeAddDevice();
      termOpen();
    } else if (action === 'add') {
      if (!adddev.selected) return;
      adddevSave();
      void adddevConnect({ kind: 'serial', path: adddev.selected, baud }, `${adddev.selected} @ ${baud}`);
    } else if (action === 'manual' || action === 'udp') {
      const path = (adddevEls.path?.value ?? '').trim();
      const host = (adddevEls.host?.value ?? '').trim();
      const port = Number(adddevEls.port?.value) || 3001;
      adddevSave();
      if (path) void adddevConnect({ kind: 'serial', path, baud }, `${path} @ ${baud}`);
      else if (!host) {
        adddev.status = 'Enter a serial port (COM10) or a TCP host and port.';
        adddevSync();
      } else void adddevConnect({ kind: action === 'udp' ? 'udp' : 'tcp', host, port }, `${host}:${port}`);
    }
  };

  async function termSend(line) {
    if (!line.trim()) return;
    try {
      const status = await api.post('/api/live/command', { line });
      if (status.lastError) termAppend(`> ${line}   (${status.lastError})`);
      else termAppend(`> ${line}`);
      void livePoll();
    } catch (error) {
      termAppend(`> ${line}   (${error.message})`);
    }
  }
  function termOpen() {
    term.open = true;
    if (el.terminal) el.terminal.hidden = false;
    if (!live.pollTimer) startLivePolling();
    if (live.status) termStatus(termStatusText(live.status));
    void termBackfill();
    if (live.connected) termEls.line?.focus();
    else termEls.path?.focus();
  }
  /** Re-open the drawer after a long session: the newest slice of the ring buffer, newest last. */
  async function termBackfill() {
    if (term.backfilling) return;
    term.backfilling = true;
    try {
      const page = await api.get('/api/live/logs', { after: 0, limit: TERMINAL_BACKFILL });
      term.lines = [];
      for (const entry of page.entries ?? []) {
        termAppend(entry.ascii || `#${entry.messageId} ${entry.name} ${entry.time}`);
      }
    } catch (error) {
      termAppend(`API error: ${error.message}`);
    } finally {
      term.backfilling = false;
    }
  }
  function termClose() {
    term.open = false;
    if (el.terminal) el.terminal.hidden = true;
  }

  /* The 1232 px column is centred in the area *left of the scrollbar* (the reference window has a
   * 15 px one). Chromium draws overlay scrollbars in this environment, which reserve nothing, so
   * the missing gutter is measured and passed to CSS instead of guessing. */
  {
    const scroller = document.querySelector('.nas-content');
    const gutter = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
    root.style.setProperty('--mg-gutter', `${gutter >= 8 ? 0 : 15}px`);
  }

  /** `gps-use` / `gps-idle` / `gps-missing` → the three count chips of every constellation row. */
  const satCount = {};
  for (const node of root.querySelectorAll('[data-sat]')) satCount[node.dataset.sat] = node;

  /* The open-file tab and "+ Add Device" live in the shell's app bar (`index.html #tabs-list`),
   * exactly like the original puts them next to the app name. Injected from here so the shell is
   * not edited; CSS pins them to this page and removes them again in the cleanup below. */
  const appBar = document.getElementById('tabs-list');
  const appTab = appBar ? document.createElement('li') : null;
  if (appTab) {
    appTab.className = 'mg-filetabs';
    appTab.setAttribute('role', 'presentation');
    appBar.appendChild(appTab);
  }

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    open: false,
    logs: null,
    position: null,
    device: null,
    range: null,
    version: null,
    interference: null,
    /** §2.3.4…§2.3.12 tiles: what `loadTiles()` read out of the opened capture. */
    tiles: null,
    time: '',
    /** Bumped per open; a slower response for an older capture never overwrites a newer one. */
    token: 0,
  };

  /* ---- shared bits ---- */

  function setBadge(node, tone, text) {
    if (!node) return;
    const labels = { good: 'Good', warn: 'Warning', bad: 'Error', off: 'Off', unknown: '--' };
    node.className = `mg-badge mg-badge-${tone}`;
    node.textContent = text ?? labels[tone] ?? '--';
    node.dataset.tone = tone;
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function alert(message) {
    if (!el.error) return;
    el.error.hidden = !message;
    el.error.textContent = message || '';
  }

  function setBodyState() {
    if (state.open) document.body.dataset.manageState = 'device';
    else document.body.dataset.manageState = 'list';
  }

  /* ---- app bar file tab ---- */

  function renderAppBar() {
    if (!appTab) return;
    if (!state.open) {
      appTab.hidden = true;
      appTab.innerHTML = '';
      delete appTab.dataset.manageKey;
      return;
    }
    appTab.hidden = false;
    const mode = liveMode();
    const key = `${mode}|${live.target}|${state.capture}`;
    if (appTab.dataset.manageKey === key) return;
    appTab.dataset.manageKey = key;
    if (mode !== 'capture') {
      /* A live dashboard is not a file: no ✕ that would look like it disconnects the receiver. */
      const label = mode === 'live' ? `Live · ${live.target || 'receiver'}` : 'Live lost';
      const title = mode === 'live'
        ? `Live session on ${live.target}. The cards read what the receiver is emitting right now.`
        : `The live session to ${live.target || 'the receiver'} closed — the cards show -- until it is connected again.`;
      appTab.innerHTML =
        '<span class="mg-filetab-plate mg-filetab-plate-live">' +
        `<span class="mg-filetab mg-filetab-live" title="${esc(title)}">` +
        `<span class="mg-filetab-name">${esc(label)}</span></span>` +
        '</span>' +
        '<button type="button" class="mg-add-tab" data-mode-action="connect" ' +
        `title="${esc('Add Device: open the live connection drawer (serial COM port or TCP bridge).')}">` +
        '<span class="mg-plus" aria-hidden="true"></span>Add Device</button>';
      return;
    }
    const name = baseName(state.capture);
    const short = name.length > 12 ? `${name.slice(0, 12)}…` : name;
    appTab.innerHTML =
      '<span class="mg-filetab-plate">' +
      `<a class="mg-filetab" href="#" title="${esc(state.capture)}">` +
      `<span class="mg-filetab-name">${esc(short)} (0)</span></a>` +
      '<button type="button" class="mg-filetab-close" aria-label="Close file">&times;</button>' +
      '</span>' +
      '<button type="button" class="mg-add-tab" data-mode-action="connect" ' +
      `title="${esc('Add Device: open the live connection drawer (serial COM port or TCP bridge).')}">` +
      '<span class="mg-plus" aria-hidden="true"></span>Add Device</button>';
  }

  /* ---- capture list (no open file) ---- */

  function renderList() {
    el.list.hidden = false;
    el.device.hidden = true;
    el.listNote.textContent = state.captures.length
      ? `${state.captures.length} capture${state.captures.length === 1 ? '' : 's'} · pick one to open its dashboard`
      : 'No capture under 逆向/00_来源/samples.';
    if (!state.captures.length) {
      el.listCards.innerHTML = '<p class="mg-list-empty">No capture found.</p>';
      return;
    }
    el.listCards.innerHTML = state.captures
      .map((item) => {
        const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '.';
        return (
          `<article class="mg-capture-card" data-capture="${esc(item.path)}">` +
          '<div class="mg-capture-menu" aria-hidden="true">⋮</div>' +
          `<h2 class="mg-capture-name" title="${esc(item.path)}">${esc(item.name)}</h2>` +
          '<div class="mg-capture-fields">' +
          `<span>File</span><span>${esc(item.name)}</span>` +
          `<span>Folder</span><span>${esc(folder)}</span>` +
          `<span>Size</span><span>${esc(bytesText(item.bytes))}</span>` +
          '</div>' +
          `<button type="button" class="mg-capture-open" data-open="${esc(item.path)}">` +
          '<span class="mg-link-glyph" aria-hidden="true"></span>Open</button>' +
          '</article>'
        );
      })
      .join('');
  }

  function renderDeviceShell() {
    el.list.hidden = true;
    el.device.hidden = false;
  }

  /* ---- mode strip + dashboard dispatch --------------------------------------
   * One place decides which source the cards read. `render()` is called by the poller every tick,
   * so it must be cheap and idempotent; it never fetches anything itself. */

  function setModeBadge(tone, text) {
    if (!el.modeBadge) return;
    el.modeBadge.className = `mg-mode-badge mg-mode-badge-${tone}`;
    el.modeBadge.dataset.tone = tone;
    el.modeBadge.textContent = text;
  }

  function renderModeStrip() {
    const mode = liveMode();
    if (el.mode) el.mode.dataset.mode = mode;
    root.dataset.mode = mode;

    const actions = { connect: mode !== 'live', disconnect: mode === 'live', replay: mode === 'lost' };
    for (const node of root.querySelectorAll('[data-mode-action]')) {
      node.hidden = !actions[node.dataset.modeAction];
    }

    if (mode === 'live') {
      setModeBadge('good', 'Live');
      if (el.modeBadge) el.modeBadge.title = `A receiver session is open on ${live.target}; the four tiles read its decoded records.`;
      setText(el.modeSource, live.target || 'receiver');
      if (el.modeSource) el.modeSource.title = 'The receiver this dashboard is connected to.';
      const at = live.lastRecordAt ? utcClock(live.lastRecordAt) : '—';
      const since = live.session ? utcClock(live.session) : '—';
      setText(el.modeDetail, `实时数据 · 会话连接于 ${since} UTC · 已收 ${live.records} 条 · 最后一条 ${at}（接收机时间）`);
      return;
    }

    if (mode === 'lost') {
      setModeBadge('bad', 'Live lost');
      if (el.modeBadge) el.modeBadge.title = 'The live session closed. Fields show -- until the receiver is connected again; capture values are never substituted.';
      setText(el.modeSource, live.target || 'receiver');
      const when = live.disconnectedAt ? utcClock(live.disconnectedAt) : '—';
      const error = live.lastError ? ` · ${live.lastError}` : '';
      setText(el.modeDetail, `连接已断开 ${when} UTC${error} · 字段回到 --，不会改用抓包数据`);
      const connect = root.querySelector('[data-mode-action="connect"]');
      if (connect) connect.textContent = 'Reconnect…';
      return;
    }

    setModeBadge('off', 'Capture');
    if (el.modeBadge) el.modeBadge.title = 'No live session: the numbers below are replayed from a capture, not read from a receiver.';
    setText(el.modeSource, state.capture ? baseName(state.capture) : 'no capture');
    if (el.modeSource) el.modeSource.title = state.capture ? `离线回放：${state.capture}` : 'No capture open.';
    setText(el.modeDetail, '离线回放 — 没有实时会话；数值来自抓包，不是接收机');
    const connect = root.querySelector('[data-mode-action="connect"]');
    if (connect) connect.textContent = 'Connect live…';
  }

  /** The single entry point: mode strip first, then whichever source the mode allows. */
  function render() {
    const mode = liveMode();
    renderModeStrip();
    renderAppBar();
    if (!state.open) return;
    if (mode === 'live') renderLiveDashboard();
    else if (mode === 'lost') renderLostDashboard();
    else renderCaptureDashboard();
  }

  function renderCaptureDashboard() {
    renderPosition();
    renderDevice();
    renderInterference(state.interference ? { entries: state.interference.entries, time: state.interference.time } : null, 'capture');
    renderSatellite();
    renderTiles('capture');
  }

  /* ---- the 2.3.4…2.3.12 tiles -------------------------------------------------
   *
   * `state.tiles` is what `loadTiles()` read out of the opened capture; the readers themselves are
   * module-level pure functions (`readPorts`, `readLogging`, `readPpp`, `readRadio`, `readAlign`,
   * `readSpan`, `readSatTracking`) so the mapping is testable without a DOM. A mode other than
   * `capture` prints `--` in every field and says which mode it is: live only decodes the four
   * records above, and "live lost" must never borrow capture values.
   */

  const TONE_WORD = {
    good: 'Active',
    warn: 'Not active',
    bad: 'Error',
    off: 'Not configured',
    unknown: '--',
  };

  const TRACK_VIEW = { system: 'all', metric: 'cno' };

  function dash(value, digits, suffix = '') {
    const parsed = numberOrNaN(value);
    return Number.isFinite(parsed) ? `${parsed.toFixed(digits)}${suffix}` : '--';
  }

  /** `value ± sd` — the manual puts the standard deviation right of each ALIGN/SPAN value. */
  function withDev(value, dev, digits, suffix = '') {
    const main = dash(value, digits, suffix);
    if (main === '--') return '--';
    const spread = numberOrNaN(dev);
    return Number.isFinite(spread) ? `${main} ± ${spread.toFixed(digits)}` : main;
  }

  function resetTileValues() {
    for (const node of [
      el.logStatus,
      el.logSize,
      el.logName,
      el.logMessages,
      el.pppSubscribed,
      el.pppLocked,
      el.pppLband,
      el.pppPrimary,
      el.pppSignal,
      el.pppBitRate,
      el.pppNtrip,
      el.pppPosition,
      el.pppDop,
      el.radioStatus,
      el.radioPort,
      el.radioFailed,
      el.alignHeading,
      el.alignPitch,
      el.alignBaseline,
      el.spanStatus,
      el.spanType,
      el.spanAlignment,
      el.spanConverged,
      el.spanAzimuth,
      el.spanPitch,
      el.spanRoll,
      el.spanNorth,
      el.spanEast,
      el.spanUp,
      el.spanLat,
      el.spanLon,
      el.spanHeight,
    ]) {
      setText(node, '--');
    }
    if (el.portsList) el.portsList.innerHTML = '';
    if (el.trackBody) el.trackBody.innerHTML = '';
    for (const node of [el.portsBadge, el.logBadge, el.pppBadge, el.radioBadge, el.alignBadge, el.spanBadge, el.trackBadge]) {
      setBadge(node, 'unknown');
    }
  }

  function renderTiles(mode) {
    const tiles = mode === 'capture' ? state.tiles : null;
    if (!tiles) {
      resetTileValues();
      const why =
        mode === 'live'
          ? 'Live · 这一路的解码器只产出 Positioning / Device / Interference / Satellite 记录的视图模型，这五块读的是抓包字段路径（/api/records）；要看它们，先断开回放到同一份抓包。'
          : 'Live lost · 会话已断开，不拿抓包数字顶替 — 字段回到 --。';
      for (const node of [el.portsReason, el.logReason, el.pppReason, el.radioReason, el.alignReason, el.spanReason, el.trackReason]) {
        setText(node, why);
      }
      setBadge(el.portsBadge, 'unknown');
      setBadge(el.logBadge, 'unknown');
      setBadge(el.pppBadge, 'off');
      setBadge(el.radioBadge, 'off');
      setBadge(el.alignBadge, 'unknown');
      setBadge(el.spanBadge, 'off');
      setBadge(el.trackBadge, 'unknown');
      if (el.trackConsts) el.trackConsts.innerHTML = '';
      if (el.trackLegend) el.trackLegend.innerHTML = '';
      setText(el.bandLogging, '--');
      return;
    }
    renderPortsTile(tiles.ports);
    renderLoggingTile(tiles.logging);
    renderPppTile(tiles.ppp);
    renderRadioTile(tiles.radio);
    renderAlignTile(tiles.align);
    renderSpanTile(tiles.span);
    renderTrackingTile(tiles.tracking);
  }

  /* ---- 2.3.4 Ports ---- */

  function portTitle(row) {
    const part = (label, value) => `${label} ${Number.isFinite(numberOrNaN(value)) ? value : '--'}`;
    return (
      `${row.name} — SERIALCONFIG (#1246): ${part('baud', row.baud)} ${row.framing || ''}`.trim() +
      ` · PORTSTATS (#72): ${part('rx_chars', row.rx)} / ${part('tx_chars', row.tx)}` +
      ` · framing ${Number.isFinite(row.framingErrors) ? row.framingErrors : '--'}` +
      ` parity ${Number.isFinite(row.parityErrors) ? row.parityErrors : '--'}` +
      ` over-runs ${Number.isFinite(row.overRuns) ? row.overRuns : '--'}` +
      ` · LOGLIST (#5): ${row.logsKnown ? `${row.logs} log(s)` : 'not in this capture'}`
    );
  }

  function renderPortsTile(ports) {
    if (!el.portsBadge) return;
    if (!ports.rows.length) {
      el.portsList.innerHTML = '<p class="mg-port-empty">No port row: this capture has none of SERIALCONFIG / PORTSTATS / LOGLIST.</p>';
      setBadge(el.portsBadge, 'off');
      setText(el.portsReason, portsReasonText(ports));
      return;
    }
    el.portsList.innerHTML = ports.rows
      .map((row) => {
        const rate = portRateText(row);
        const logs = portLogsText(row);
        return (
          `<div class="mg-port-row" data-tone="${esc(row.tone)}" title="${esc(portTitle(row))}">` +
          `<span class="mg-port-name">${esc(row.name)}</span>` +
          `<span class="mg-port-rate">${esc(rate)}</span>` +
          `<span class="mg-port-logs">${esc(logs)}</span>` +
          `<span class="mg-port-state" data-tone="${esc(row.tone)}">${esc(TONE_WORD[row.tone] ?? '--')}</span>` +
          '</div>'
        );
      })
      .join('');
    setBadge(el.portsBadge, ports.tone);
    el.portsBadge.title =
      'Row colour from the receiver’s own counters: red = framing/parity/over-run counter moved, ' +
      'green = a log is attached or bytes moved, amber = configured but idle, grey = not configured.';
    setText(el.portsReason, portsReasonText(ports));
  }

  /* ---- 2.3.5 Logging ---- */

  function renderLoggingTile(logging) {
    if (!el.logBadge) return;
    if (!logging.supported) {
      for (const node of [el.logStatus, el.logSize, el.logName, el.logMessages]) setText(node, '--');
      setBadge(el.logBadge, 'off');
      el.logBadge.title = 'No file-log subsystem on this model: FILESTATUS (#2127) is not produced.';
      setText(el.logReason, loggingReasonText(logging, baseName(state.capture)));
      setText(el.bandLogging, '--');
      if (el.bandLogging) el.bandLogging.title = 'No file-log subsystem: FILESTATUS (#2127) is not produced on this model.';
      return;
    }
    setText(el.logStatus, logging.status ?? '--');
    setText(el.logSize, Number.isFinite(logging.fileSize) ? bytesText(logging.fileSize) : '--');
    setText(el.logName, logging.fileName || '--');
    setText(el.logMessages, logging.messages.length ? String(logging.messages.length) : '--');
    const active = String(logging.status ?? '').toUpperCase() === 'ACTIVE';
    setBadge(el.logBadge, active ? 'good' : 'off');
    setText(el.logReason, loggingReasonText(logging, baseName(state.capture)));
    setText(el.bandLogging, logging.status ?? '--');
  }

  /* ---- 2.3.10 PPP Corrections ---- */

  function renderPppTile(ppp) {
    if (!el.pppBadge) return;
    const subscription = ppp.subscription;
    setText(
      el.pppSubscribed,
      subscription
        ? `${subscription.subscribed ? 'Subscribed' : 'Unsubscribed'} · ${subscription.mode || '--'} · ${subscription.detailsHex}`
        : '--',
    );
    setText(el.pppLocked, '--');
    setText(el.pppLband, ppp.pppOff ? 'Off' : '--');
    setText(el.pppPrimary, '--');
    setText(el.pppSignal, '--');
    setText(el.pppBitRate, '--');
    setText(el.pppNtrip, ppp.ntripRecord ? '--' : 'Off');
    setText(
      el.pppPosition,
      ppp.position
        ? `${ppp.position.solution ?? '--'} / ${ppp.position.type ?? '--'} · ${Number.isFinite(ppp.position.satellites) ? `${ppp.position.satellites} sv` : 'sv --'}`
        : '--',
    );
    setText(
      el.pppDop,
      ppp.dop
        ? `${dash(ppp.dop.gdop, 2)} / ${dash(ppp.dop.pdop, 2)} / ${dash(ppp.dop.hdop, 2)} / ${dash(ppp.dop.vdop, 2)}`
        : '--',
    );
    setBadge(el.pppBadge, ppp.tone);
    setText(el.pppReason, pppReasonText(ppp));
    for (const [node, present] of [
      [el.pppLocked, ppp.lockRecord],
      [el.pppPrimary, false],
      [el.pppSignal, false],
      [el.pppBitRate, false],
    ]) {
      if (node && !present) node.title = 'No record for this field in the opened capture.';
    }
  }

  /* ---- 2.3.11 Radio ---- */

  function renderRadioTile(radio) {
    if (!el.radioBadge) return;
    setText(el.radioStatus, radio.present ? radio.status ?? '--' : '--');
    setText(el.radioPort, radio.port || '--');
    setText(el.radioFailed, radio.failed || '--');
    setBadge(el.radioBadge, radio.tone);
    el.radioBadge.title = radio.present
      ? 'SATELSTATUS (#2205) / SATELDETECT (#2204) from the receiver.'
      : 'No SATELSTATUS (#2205) / SATELDETECT (#2204): the manual keeps this tile Off on systems without an external transmit radio.';
    setText(
      el.radioReason,
      radioReasonText(radio, baseName(state.capture)),
    );
  }

  /* ---- 2.3.8 ALIGN ---- */

  function renderAlignTile(align) {
    if (!el.alignBadge) return;
    setText(el.alignHeading, withDev(align.heading, align.headingDev, 2, '°'));
    setText(el.alignPitch, withDev(align.pitch, align.pitchDev, 2, '°'));
    setText(el.alignBaseline, dash(align.baseline, 3, ' m'));
    if (!align.messageId) {
      setBadge(el.alignBadge, align.supported ? 'off' : 'unknown');
      setText(el.alignReason, alignReasonText(align, state.tiles?.features));
      return;
    }
    setBadge(el.alignBadge, align.solved ? 'good' : 'warn');
    setText(el.alignReason, alignReasonText(align, state.tiles?.features));
  }

  /* ---- 2.3.9 SPAN ---- */

  function renderSpanTile(span) {
    if (!el.spanBadge) return;
    const v = span.values;
    if (!v) {
      setBadge(el.spanBadge, span.supported === false ? 'off' : 'unknown');
      setText(el.spanReason, spanReasonText(span));
      return;
    }
    setText(el.spanStatus, v.status ?? '--');
    setText(el.spanType, v.type ?? '--');
    setText(el.spanAlignment, '--');
    setText(el.spanConverged, '--');
    setText(el.spanAzimuth, withDev(v.azimuth, v.azimuthDev, 3, '°'));
    setText(el.spanPitch, withDev(v.pitch, v.pitchDev, 3, '°'));
    setText(el.spanRoll, withDev(v.roll, v.rollDev, 3, '°'));
    setText(el.spanNorth, dash(v.north, 3, ' m/s'));
    setText(el.spanEast, dash(v.east, 3, ' m/s'));
    setText(el.spanUp, dash(v.up, 3, ' m/s'));
    setText(el.spanLat, dash(v.latitude, 9, '°'));
    setText(el.spanLon, dash(v.longitude, 9, '°'));
    setText(el.spanHeight, withDev(v.height, v.heightDev, 3, ' m'));
    setBadge(el.spanBadge, (v.status ?? '') === 'INS_SOLUTION_GOOD' ? 'good' : 'warn');
    setText(el.spanReason, spanReasonText(span));
  }

  /* ---- 2.3.12 Satellite Tracking ---- */

  const TRACK_THRESHOLDS = {
    cno: { poor: 20, good: 35, max: 60, unit: ' dB-Hz', digits: 1 },
    lock: { poor: 1800, good: 3600, max: 3600, unit: ' s', digits: 0 },
  };

  function trackTone(value, metric) {
    const limit = TRACK_THRESHOLDS[metric];
    const parsed = numberOrNaN(value);
    if (!Number.isFinite(parsed)) return 'unknown';
    if (parsed < limit.poor) return 'poor';
    if (parsed < limit.good) return 'warn';
    return 'good';
  }

  function trackBarHtml(signal, metric) {
    const value = metric === 'lock' ? signal.lock : signal.cno;
    const limit = TRACK_THRESHOLDS[metric];
    const parsed = numberOrNaN(value);
    const pct = Number.isFinite(parsed) ? Math.max(1, Math.min(100, (parsed / limit.max) * 100)) : 0;
    const text = Number.isFinite(parsed) ? `${parsed.toFixed(limit.digits)}${limit.unit}` : 'no signal';
    const tone = Number.isFinite(parsed) ? trackTone(parsed, metric) : 'unknown';
    return (
      `<div class="mg-track-bar" data-tone="${tone}">` +
      `<span class="mg-track-name">${esc(signal.name)}</span>` +
      '<span class="mg-track-track"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
      `<span class="mg-track-value">${esc(text)}</span>` +
      '</div>'
    );
  }

  function renderTrackingTile(tracking) {
    if (!el.trackBadge) return;
    const rows = tracking.rows;
    if (!rows.length) {
      el.trackBody.innerHTML = '<p class="mg-track-empty">No RANGE (#43) record in this capture — nothing to track.</p>';
      setBadge(el.trackBadge, 'unknown');
      setText(el.trackReason, '抓包回放 · 这个抓包里没有 RANGE (#43)，逐星表保持空。');
      el.trackConsts.innerHTML = '';
      el.trackLegend.innerHTML = '';
      return;
    }
    const systems = tracking.systems;
    if (TRACK_VIEW.system !== 'all' && !systems.includes(TRACK_VIEW.system)) TRACK_VIEW.system = 'all';
    const labelOf = (key) => CONSTELLATIONS.find((item) => item.key === key)?.label ?? key.toUpperCase();
    el.trackConsts.innerHTML =
      '<button type="button" class="mg-track-const" data-track-system="all" aria-pressed="' +
      String(TRACK_VIEW.system === 'all') +
      '">All</button>' +
      systems
        .map(
          (key) =>
            `<button type="button" class="mg-track-const" data-track-system="${esc(key)}" aria-pressed="${String(TRACK_VIEW.system === key)}">${esc(labelOf(key))}</button>`,
        )
        .join('');

    const metric = TRACK_VIEW.metric === 'lock' ? 'lock' : 'cno';
    const limit = TRACK_THRESHOLDS[metric];
    el.trackLegend.innerHTML =
      metric === 'cno'
        ? `<span class="mg-track-key" data-tone="poor">&lt; ${limit.poor} dB-Hz</span>` +
          `<span class="mg-track-key" data-tone="warn">${limit.poor}–${limit.good} dB-Hz</span>` +
          `<span class="mg-track-key" data-tone="good">&ge; ${limit.good} dB-Hz</span>`
        : `<span class="mg-track-key" data-tone="poor">&lt; ${limit.poor} s</span>` +
          `<span class="mg-track-key" data-tone="warn">${limit.poor}–${limit.good} s</span>` +
          `<span class="mg-track-key" data-tone="good">&gt; ${limit.good} s</span>`;

    const visible = TRACK_VIEW.system === 'all' ? rows : rows.filter((row) => row.rowKey === TRACK_VIEW.system);
    const sky = tracking.skyEpoch
      ? `${utcClock(tracking.skyEpoch)} UTC`
      : '--';
    el.trackBody.innerHTML = visible
      .map((row) => {
        const elAz =
          Number.isFinite(row.elevation) && Number.isFinite(row.azimuth)
            ? `${row.elevation.toFixed(1)}° / ${row.azimuth.toFixed(1)}°`
            : '--';
        return (
          `<div class="mg-track-row" data-system="${esc(row.rowKey)}">` +
          `<span class="mg-track-prn">${esc(row.systemLabel)} ${esc(String(row.prn))}</span>` +
          `<div class="mg-track-bars">${row.signals.map((signal) => trackBarHtml(signal, metric)).join('')}</div>` +
          `<span class="mg-track-sky" title="Elevation / Azimuth from SATVIS2 (#1043) ${esc(sky)}">${esc(elAz)}</span>` +
          '</div>'
        );
      })
      .join('');

    setBadge(el.trackBadge, visible.length > 0 ? 'good' : 'warn');
    setText(el.trackReason, trackingReasonText({ ...tracking, rows: visible }, metric));
  }

  /* ---- numbers shared by both modes ---------------------------------------- */

  /** `Number(null)` is 0 — a missing EDIE field must stay missing, not become a real zero. */
  function numberOrNaN(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function withFixed(value, digits, suffix = '') {
    const parsed = numberOrNaN(value);
    return Number.isFinite(parsed) ? `${parsed.toFixed(digits)}${suffix}` : '--';
  }

  /** `/api/records` and `LiveLink` both speak `path → field`, so one reader serves both. */
  function fieldMap(record) {
    const map = new Map();
    if (!record || !Array.isArray(record.fields)) return map;
    for (const field of record.fields) if (!map.has(field.path)) map.set(field.path, field);
    return map;
  }

  /* ---- BESTPOS #42 → band left half + Positioning tile ---- */

  function readPosition(record) {
    if (!record) return null;
    const fields = new Map();
    for (const field of record.fields) if (!fields.has(field.path)) fields.set(field.path, field);
    const get = (path) => fields.get(path);
    const latDev = Number(get('latitude_std_dev')?.value);
    const lonDev = Number(get('longitude_std_dev')?.value);
    return {
      mode: shown(get('solution_status')),
      position: shown(get('position_type')),
      latitude: Number(get('latitude')?.value),
      longitude: Number(get('longitude')?.value),
      height: Number(get('orthometric_height')?.value),
      heightDev: Number(get('height_std_dev')?.value),
      twoSigma: Number.isFinite(latDev) && Number.isFinite(lonDev) ? Math.sqrt(latDev * latDev + lonDev * lonDev) : NaN,
      datum: shown(get('datum_id')),
      solved: shown(get('solution_status')) === 'SOL_COMPUTED',
    };
  }

  function renderPosition() {
    const p = state.position;
    const tone = p ? (p.solved ? 'good' : 'warn') : 'warn';
    if (!p) {
      setText(el.bandPosition, '--');
      setText(el.bandLat, '--');
      setText(el.bandLon, '--');
      setText(el.bandHeight, '--');
      for (const node of [el.posMode, el.posPosition, el.posLat, el.posLon, el.posHeight, el.posHeightAcc, el.pos2d, el.posDatum]) {
        setText(node, '--');
      }
      setBadge(el.bandPosBadge, tone);
      setBadge(el.cardPosBadge, tone);
      setText(
        el.posReason,
        `抓包回放 · ${baseName(state.capture) || '这个抓包'} 里没有 BESTPOS (#42) — 字段保持 --。`,
      );
      return;
    }
    const position = p.position ? titleCase(p.position) : '--';
    const lat = `${fixed(p.latitude, 7)}°`;
    const lon = `${fixed(p.longitude, 7)}°`;
    const height = `${fixed(p.height, 2)} m`;

    setText(el.bandPosition, position);
    setText(el.bandLat, lat);
    setText(el.bandLon, lon);
    setText(el.bandHeight, height);

    setText(el.posMode, p.mode ?? '--');
    setText(el.posPosition, position);
    setText(el.posLat, lat);
    setText(el.posLon, lon);
    setText(el.posHeight, height);
    setText(el.posHeightAcc, `${fixed(p.heightDev, 2)} m`);
    setText(el.pos2d, `${fixed(p.twoSigma, 2)} m`);
    setText(el.posDatum, p.datum ?? '--');

    setBadge(el.bandPosBadge, tone);
    setBadge(el.cardPosBadge, tone);
    setText(
      el.posReason,
      `抓包回放 · BESTPOS (#42) 首条记录 · 离线数据，不是接收机实时值`,
    );
  }

  /* ---- HWMONITOR #963 → Device tile + band right half ---- */

  function readDevice(record) {
    if (!record) return null;
    const values = new Map();
    for (const field of record.fields) {
      const match = /^measurements\[(\d+)\]\.(value|status)$/.exec(field.path);
      if (!match) continue;
      const index = Number(match[1]);
      if (!values.has(index)) values.set(index, {});
      values.get(index)[match[2]] = field.value;
    }
    const byType = new Map();
    for (const entry of values.values()) {
      const status = Number(entry.status) || 0;
      const type = (status >> 8) & 0xff;
      if (!byType.has(type)) byType.set(type, { value: Number(entry.value), limit: status & 0xff });
    }
    const pick = (types) => {
      for (const type of types) if (byType.has(type)) return byType.get(type);
      return null;
    };
    return {
      temperature: pick(HW_TYPES.temperature),
      antennaCurrent: pick(HW_TYPES.antennaCurrent),
      antennaVoltage: pick(HW_TYPES.antennaVoltage),
      cpuUsage: pick(HW_TYPES.cpuUsage),
    };
  }

  /** Sensor row tone: the receiver's own boundary limit wins when it flagged something. */
  function sensorTone(reading) {
    if (!reading) return 'unknown';
    const limit = reading.limit;
    if (limit === 0) return 'good';
    if (limit === 1 || limit === 3) return 'warn';
    return 'bad';
  }

  function renderDevice() {
    const d = state.device;
    // The original prints °C without decimals, V and mA with one — same convention here.
    const temp = d?.temperature ? `${withFixed(d.temperature.value, 0, ' °C')}` : '--';
    const volt = d?.antennaVoltage ? `${withFixed(d.antennaVoltage.value, 1, ' V')}` : '--';
    const amp = d?.antennaCurrent ? `${withFixed(d.antennaCurrent.value * 1000, 1, ' mA')}` : '--';
    const cpu = d?.cpuUsage ? `${withFixed(d.cpuUsage.value, 0, ' %')}` : '--';

    setText(el.devCpu, cpu);
    setText(el.devTemp, temp);
    setText(el.devVoltage, volt);
    setText(el.devCurrent, amp);

    setBadge(el.devCpuBadge, d?.cpuUsage ? sensorTone(d.cpuUsage) : 'unknown');
    setBadge(el.devTempBadge, sensorTone(d?.temperature));
    setBadge(el.devVoltageBadge, sensorTone(d?.antennaVoltage));
    setBadge(el.devCurrentBadge, sensorTone(d?.antennaCurrent));

    // Band right half: only what the capture can actually answer.
    setText(el.bandModel, state.version ? state.version.hardware || state.version.model || '--' : '--');
    setText(el.bandCpu, cpu);
    setText(el.bandLogging, '--'); // needs FILESTATUS (#2127) / LOGLIST (#5)
    setText(el.bandInterference, interferenceText(state.interference));
    setText(el.bandTime, state.time || '--');

    const complete = Boolean(d && d.temperature && d.antennaVoltage && d.antennaCurrent);
    setBadge(el.bandDevBadge, complete || d ? 'good' : 'warn');
    // The band's badge follows the readings the capture can answer; a missing CPU usage stays a
    // `--` in its own row rather than turning the whole device amber.
    el.bandDevBadge.title = d
      ? 'Device health from the HWMONITOR (#963) boundary limits; CPU Usage / Logging have no source in a capture.'
      : 'No HWMONITOR (#963) record in this capture.';

    const missing = [];
    if (!d) missing.push('HWMONITOR (#963) 不在这个抓包里');
    else if (!d.temperature || !d.antennaVoltage || !d.antennaCurrent) missing.push('HWMONITOR 缺温度/电压/电流读数');
    missing.push(d?.cpuUsage ? '' : 'CPU Usage：抓包的二进制 HWMONITOR 没有 idleTime');
    missing.push(state.version ? '' : 'Model：抓包里没有 VERSION (#37)');
    missing.push('Logging：需要 FILESTATUS (#2127)/LOGLIST (#5)');
    setText(el.devReason, `抓包回放 · ${missing.filter(Boolean).join(' · ')}`);
  }

  /* ---- VERSION #37 / ITDETECTSTATUS #2065 in a capture ---- */

  function readVersion(record) {
    if (!record) return null;
    const fields = fieldMap(record);
    const total = Number(fields.get('versions.count')?.value) || 0;
    let fallback = null;
    for (let index = 0; index < Math.min(total, 16); index += 1) {
      const base = `versions[${index}]`;
      const candidate = {
        model: shown(fields.get(`${base}.model_name`)) ?? '',
        hardware: shown(fields.get(`${base}.hardware_version`)) ?? '',
        software: shown(fields.get(`${base}.software_version`)) ?? '',
        component: shown(fields.get(`${base}.component_type`)) ?? '',
      };
      if (!fallback && (candidate.model || candidate.hardware)) fallback = candidate;
      if (candidate.component === 'GPSCARD' || candidate.component === 'GPSCARD2') return candidate;
    }
    return fallback;
  }

  function readInterference(record) {
    if (!record) return null;
    const fields = fieldMap(record);
    const total = Number(fields.get('interference_statuses.count')?.value) || 0;
    const entries = [];
    for (let index = 0; index < Math.min(total, 64); index += 1) {
      const base = `interference_statuses[${index}]`;
      entries.push({
        rfPath: shown(fields.get(`${base}.frequency`)) ?? '',
        detectionType: shown(fields.get(`${base}.int_detect_method`)) ?? '',
        centerFrequency: numberOrNaN(fields.get(`${base}.parameter1`)?.value),
        bandwidth: numberOrNaN(fields.get(`${base}.parameter2`)?.value),
        power: numberOrNaN(fields.get(`${base}.parameter3`)?.value),
        estimatedPower: numberOrNaN(fields.get(`${base}.parameter4`)?.value),
        severity: [
          numberOrNaN(fields.get(`${base}.severity1`)?.value) || 0,
          numberOrNaN(fields.get(`${base}.severity2`)?.value) || 0,
        ],
      });
    }
    return entries.length ? { entries, time: record.header?.utc ?? '' } : null;
  }

  /** Any non-zero severity word is the receiver saying it detected interference. */
  function interferenceDetected(data) {
    return (data?.entries ?? []).some((entry) => (entry.severity ?? []).some((value) => Number(value) !== 0));
  }

  function interferenceText(data) {
    if (!data) return null;
    return interferenceDetected(data) ? 'Detected' : 'Not detected';
  }

  /**
   * The Interference tile is shared by both modes: live fills it from ITDETECTSTATUS (#2065) when
   * the receiver logs it, and a capture prints the original's "Not detected" only when its own
   * #2065 record is absent — never a number that was invented.
   */
  function renderInterference(data, source) {
    const live_ = source === 'live';
    if (!data || !data.entries || !data.entries.length) {
      setText(el.interference, live_ ? '--' : 'Not detected');
      setBadge(el.intBadge, live_ ? 'unknown' : 'good');
      setText(
        el.intReason,
        live_
          ? 'Live · ITDETECTSTATUS (#2065) 没有到达 — 接收机没有在这一路输出干扰检测报文，字段保持 --。'
          : '抓包回放 · 这个抓包没有 ITDETECTSTATUS (#2065) — 沿用原界面的 Not detected，没有编造数值。',
      );
      return;
    }
    const detected = interferenceDetected(data);
    setText(el.interference, detected ? 'Detected' : 'Not detected');
    setBadge(el.intBadge, detected ? 'warn' : 'good', detected ? 'Detected' : 'Good');
    const detail = data.entries
      .map(
        (entry) =>
          `${entry.rfPath || '--'} · ${entry.detectionType || '--'} · ` +
          `center ${withFixed(entry.centerFrequency, 2)} · width ${withFixed(entry.bandwidth, 2)} · ` +
          `power ${withFixed(entry.power, 2)} · est ${withFixed(entry.estimatedPower, 2)}`,
      )
      .join(' ; ');
    const when = data.time ? `${utcClock(data.time)} UTC` : '—';
    setText(el.intReason, `${live_ ? 'Live' : '抓包回放'} · ITDETECTSTATUS (#2065) ${when} · ${detail}`);
  }

  /* ---- RANGE #43 → Satellite View ---- */

  const systemOf = (entry) => (Number(entry.c_status) >> 16) & 7;

  function parseEpoch(record) {
    const obs = new Map();
    for (const field of record.fields) {
      const match = /^obs\[(\d+)\]\.(sv_prn|c_status)$/.exec(field.path);
      if (!match) continue;
      const index = Number(match[1]);
      if (!obs.has(index)) obs.set(index, {});
      obs.get(index)[match[2]] = field.value;
    }
    const counts = new Map();
    for (const entry of obs.values()) {
      const system = systemOf(entry);
      if (!counts.has(system)) counts.set(system, new Set());
      counts.get(system).add(Number(entry.sv_prn));
    }
    return { counts, utc: record.header?.utc ?? '', observed: obs.size };
  }

  /**
   * Up to five RANGE epochs of the capture: the first, three in the middle and the last one. The
   * last epoch is "now" (In Use); the union of the sampled epochs is what the receiver has seen
   * (Not Used = seen − now), the same rule Playback applies while scrubbing.
   */
  function epochOffsets(total) {
    if (total <= 0) return [];
    if (total <= 5) return Array.from({ length: total }, (_v, i) => i);
    const wanted = [0, Math.round((total - 1) * 0.25), Math.round((total - 1) * 0.5), Math.round((total - 1) * 0.75), total - 1];
    return [...new Set(wanted)];
  }

  async function loadRange(capture) {
    const probe = await api.get('/api/records', { capture, msgId: RANGE, offset: 0, limit: 1 });
    const total = Number(probe.total) || 0;
    if (!total) return null;
    const offsets = epochOffsets(total);
    const records = new Map();
    if (probe.records && probe.records[0]) records.set(0, parseEpoch(probe.records[0]));
    await Promise.all(
      offsets
        .filter((offset) => offset !== 0)
        .map(async (offset) => {
          const data = await api.get('/api/records', { capture, msgId: RANGE, offset, limit: 1 });
          const record = data.records && data.records[0];
          if (record) records.set(offset, parseEpoch(record));
        }),
    );
    const lastOffset = offsets[offsets.length - 1];
    const current = records.get(lastOffset) ?? null;
    const seen = new Map();
    for (const epoch of records.values()) {
      for (const [system, prns] of epoch.counts) {
        if (!seen.has(system)) seen.set(system, new Set());
        for (const prn of prns) seen.get(system).add(prn);
      }
    }
    return { total, current, seen, sampled: records.size };
  }

  function renderSatellite() {
    const range = state.range;
    const current = range?.current ?? null;
    let inUseTotal = 0;
    const dots = [];
    for (const item of CONSTELLATIONS) {
      const inUse = item.system === null || !current ? 0 : (current.counts.get(item.system)?.size ?? 0);
      const seen = item.system === null || !range ? 0 : (range.seen.get(item.system)?.size ?? 0);
      const notUsed = Math.max(0, seen - inUse);
      inUseTotal += inUse;
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (useNode) useNode.textContent = String(inUse);
      if (idleNode) idleNode.textContent = String(notUsed);
      if (missNode) missNode.textContent = '0';
      if (item.system !== null && current && inUse) {
        for (const prn of [...(current.counts.get(item.system) ?? [])].sort((a, b) => a - b)) {
          dots.push({ prn, tone: item.tone });
        }
      }
    }

    if (!range) setBadge(el.satBadge, 'unknown');
    else setBadge(el.satBadge, inUseTotal > 0 ? 'good' : 'warn');

    const when = current && current.utc ? utcClock(current.utc) : '--:--:--';
    el.satNote.textContent = range
      ? `RANGE (#43) epoch ${when} UTC · ${inUseTotal} tracked PRNs · ` +
        `In Use = last epoch, Not Used = seen in ${range.sampled} sampled epoch(s) only`
      : 'No RANGE (#43) record in this capture — nothing to count.';

    /* Symbolic sky dots: one per tracked PRN, spread by a golden-angle walk so neighbouring PRNs
       do not overlap. RANGE has no az/el, so the position is explicitly not a sky position. */
    paintSky(symbolicSky(dots));
  }

  /* ---- sky plot painting (shared: capture is always symbolic, live prefers SATVIS2) ---- */

  function paintSky(dots) {
    if (!el.skySats) return;
    el.skySats.innerHTML = dots
      .map(
        (dot) =>
          `<g class="mg-sky-dot mg-sky-dot-${esc(dot.tone)}">` +
          `<circle cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="10"/>` +
          `<text x="${dot.x.toFixed(1)}" y="${(dot.y + 3.6).toFixed(1)}">${esc(dot.label)}</text>` +
          '</g>',
      )
      .join('');
  }

  function symbolicSky(prns) {
    return prns.map((dot, index) => {
      const angle = (-90 + index * 137.508) * (Math.PI / 180);
      const radius = 34 + ((index * 29) % 104);
      return {
        label: String(dot.prn),
        tone: dot.tone,
        x: 150 + Math.cos(angle) * radius,
        y: 150 + Math.sin(angle) * radius,
      };
    });
  }

  /** Real sky positions from SATVIS2: azimuth clockwise from north, elevation from the horizon. */
  function satvisSky() {
    const dots = [];
    for (const item of CONSTELLATIONS) {
      const visible = live.satvis.get(item.key);
      if (!visible) continue;
      for (const satellite of visible.satellites ?? []) {
        const elevation = numberOrNaN(satellite.elevation);
        const azimuth = numberOrNaN(satellite.azimuth);
        if (!Number.isFinite(elevation) || !Number.isFinite(azimuth) || elevation <= 0) continue;
        const radius = ((90 - Math.min(90, elevation)) / 90) * 140;
        const angle = (azimuth * Math.PI) / 180;
        dots.push({
          label: String(satellite.id),
          tone: item.tone,
          x: 150 + Math.sin(angle) * radius,
          y: 150 - Math.cos(angle) * radius,
        });
      }
    }
    return dots;
  }

  /* ---- live mode: the four tiles read the receiver's own records ---- */

  function renderLiveDashboard() {
    renderLivePosition();
    renderLiveDevice();
    const interference = live.latest.get(ITDETECTSTATUS);
    renderInterference(
      interference ? { entries: interference.data.entries, time: interference.time } : null,
      'live',
    );
    renderLiveSatellite();
  }

  function renderLivePosition() {
    const cached = live.latest.get(BESTPOS);
    const p = cached ? cached.data : null;
    const columns = [
      el.bandPosition,
      el.bandLat,
      el.bandLon,
      el.bandHeight,
      el.posMode,
      el.posPosition,
      el.posLat,
      el.posLon,
      el.posHeight,
      el.posHeightAcc,
      el.pos2d,
      el.posDatum,
    ];
    if (!p) {
      for (const node of columns) setText(node, '--');
      setBadge(el.bandPosBadge, 'unknown');
      setBadge(el.cardPosBadge, 'unknown');
      setText(el.posReason, 'Live · 还没有收到 BESTPOS (#42) — 这一路流没有位置报文，字段保持 --。');
      return;
    }

    const solved = p.solutionStatus === 'SOL_COMPUTED';
    const tone = solved ? 'good' : 'warn';
    const position = p.positionType ? titleCase(p.positionType) : '--';
    const lat = withFixed(p.latitude, 7, '°');
    const lon = withFixed(p.longitude, 7, '°');
    const height = withFixed(p.height, 2, ' m');
    const latDev = numberOrNaN(p.latitudeDeviation);
    const lonDev = numberOrNaN(p.longitudeDeviation);
    const twoSigma = Number.isFinite(latDev) && Number.isFinite(lonDev) ? Math.sqrt(latDev * latDev + lonDev * lonDev) : NaN;

    setText(el.bandPosition, position);
    setText(el.bandLat, lat);
    setText(el.bandLon, lon);
    setText(el.bandHeight, height);

    setText(el.posMode, p.solutionStatus || '--');
    setText(el.posPosition, position);
    setText(el.posLat, lat);
    setText(el.posLon, lon);
    setText(el.posHeight, height);
    setText(el.posHeightAcc, withFixed(p.heightDeviation, 2, ' m'));
    setText(el.pos2d, withFixed(twoSigma, 2, ' m'));
    setText(el.posDatum, p.datumId || '--');

    setBadge(el.bandPosBadge, tone);
    setBadge(el.cardPosBadge, tone);
    const used = Number.isFinite(numberOrNaN(p.satellitesUsed)) ? `${p.satellitesUsed} used` : 'used --';
    const tracked = Number.isFinite(numberOrNaN(p.satellitesTracked)) ? `${p.satellitesTracked} tracked` : 'tracked --';
    setText(el.posReason, `Live · BESTPOS (#42) ${utcClock(cached.time)} UTC · ${used} / ${tracked}`);
  }

  function sensorOf(sensors, types) {
    for (const type of types) {
      const hit = sensors.find((sensor) => sensor.type === type);
      if (hit) return hit;
    }
    return null;
  }

  /** Worst boundary limit across the readings on screen; a missing reading is simply absent. */
  function worstTone(readings) {
    const rank = { unknown: 0, good: 1, warn: 2, bad: 3 };
    let worst = 'unknown';
    for (const reading of readings) {
      const tone = sensorTone(reading);
      if (rank[tone] > rank[worst]) worst = tone;
    }
    return worst;
  }

  function renderLiveDevice() {
    const hwCached = live.latest.get(HWMONITOR);
    const hw = hwCached ? hwCached.data : null;
    const versionCached = live.latest.get(VERSION_LOG);
    const version = versionCached ? versionCached.data : null;
    const sensors = hw?.sensors ?? [];
    const temperature = sensorOf(sensors, HW_TYPES.temperature);
    const current = sensorOf(sensors, HW_TYPES.antennaCurrent);
    const voltage = sensorOf(sensors, HW_TYPES.antennaVoltage);
    const idleTime = numberOrNaN(hw?.idleTime);
    const cpu = Number.isFinite(idleTime) ? Math.max(0, Math.min(100, 100 - idleTime / 2)) : NaN;

    const temp = temperature ? withFixed(temperature.value, 0, ' °C') : '--';
    const volt = voltage ? withFixed(voltage.value, 1, ' V') : '--';
    const amp = current ? withFixed(current.value * 1000, 1, ' mA') : '--';
    const cpuText = Number.isFinite(cpu) ? `${cpu.toFixed(0)} %` : '--';

    setText(el.devCpu, cpuText);
    setText(el.devTemp, temp);
    setText(el.devVoltage, volt);
    setText(el.devCurrent, amp);

    setBadge(el.devCpuBadge, Number.isFinite(cpu) ? 'good' : 'unknown');
    setBadge(el.devTempBadge, sensorTone(temperature));
    setBadge(el.devVoltageBadge, sensorTone(voltage));
    setBadge(el.devCurrentBadge, sensorTone(current));

    const model = version ? version.hardwareVersion || version.model : '';
    setText(el.bandModel, model || '--');
    setText(el.bandCpu, cpuText);
    setText(el.bandLogging, '--');
    setText(
      el.bandInterference,
      interferenceText(live.latest.get(ITDETECTSTATUS)?.data) ?? '--',
    );
    setText(el.bandTime, live.lastRecordAt ? `${utcClock(live.lastRecordAt)} UTC` : '--');

    const tone = worstTone([temperature, voltage, current]);
    setBadge(el.bandDevBadge, hw ? (tone === 'unknown' ? 'good' : tone) : 'unknown');
    el.bandDevBadge.title = hw
      ? 'Device health from the live HWMONITOR (#963) boundary limits.'
      : 'No HWMONITOR (#963) in the live stream.';

    const reasons = [];
    reasons.push(hwCached ? `HWMONITOR (#963) ${utcClock(hwCached.time)} UTC` : 'HWMONITOR (#963) 未到达');
    reasons.push(
      version
        ? `Model: VERSION (#37) ${version.model || version.hardwareVersion || '--'}${version.softwareVersion ? ` / ${version.softwareVersion}` : ''}`
        : 'Model: 流里没有 VERSION (#37)',
    );
    reasons.push(Number.isFinite(idleTime) ? 'CPU Usage = 100 − idleTime / 2' : 'CPU Usage: 这一路没有 idleTime，保持 --');
    reasons.push('Logging: 需要 FILESTATUS (#2127)/LOGLIST (#5)，未读取');
    setText(el.devReason, `Live · ${reasons.join(' · ')}`);
  }

  function renderLiveSatellite() {
    const newest = live.ranges.length ? live.ranges[live.ranges.length - 1] : null;
    const inUse = new Map();
    const seen = new Map();
    const add = (map, system, prn) => {
      if (!map.has(system)) map.set(system, new Set());
      map.get(system).add(prn);
    };
    if (newest) for (const observation of newest.observations) add(inUse, observation.system, observation.prn);
    for (const range of live.ranges) {
      for (const observation of range.observations) add(seen, observation.system, observation.prn);
    }

    let inUseTotal = 0;
    let satvisTotal = 0;
    const symbolic = [];
    for (const item of CONSTELLATIONS) {
      const useNode = satCount[`${item.key}-use`];
      const idleNode = satCount[`${item.key}-idle`];
      const missNode = satCount[`${item.key}-missing`];
      if (!newest || item.system === null) {
        if (useNode) useNode.textContent = '--';
        if (idleNode) idleNode.textContent = '--';
        if (missNode) missNode.textContent = '--';
        continue;
      }
      const inUseSet = inUse.get(item.system) ?? new Set();
      const seenSet = seen.get(item.system) ?? new Set();
      const notUsed = Math.max(0, seenSet.size - inUseSet.size);
      inUseTotal += inUseSet.size;
      if (useNode) useNode.textContent = String(inUseSet.size);
      if (idleNode) idleNode.textContent = String(notUsed);

      const visible = live.satvis.get(item.key);
      if (visible) {
        const missing = (visible.satellites ?? []).filter(
          (satellite) => numberOrNaN(satellite.elevation) > 0 && !inUseSet.has(satellite.id),
        ).length;
        satvisTotal += (visible.satellites ?? []).length;
        if (missNode) missNode.textContent = String(missing);
      } else if (missNode) {
        missNode.textContent = '--';
      }

      for (const prn of [...inUseSet].sort((a, b) => a - b)) symbolic.push({ prn, tone: item.tone });
    }

    const liveBadge = newest ? (inUseTotal > 0 ? 'good' : 'warn') : 'unknown';
    setBadge(el.satBadge, liveBadge);

    const when = newest ? `${utcClock(newest.time)} UTC` : '—';
    const source = satvisTotal > 0
      ? '星点来自 SATVIS2 (#1043) 的实际方位角/高度角'
      : '流里没有 SATVIS2 (#1043)，星点按符号位置摆放';
    setText(
      el.satNote,
      newest
        ? `Live · RANGE (#43) ${when} · ${inUseTotal} 个在用 PRN · In Use = 最新历元，Not Used = 本次会话更早历元见过 · ${source}`
        : 'Live · 还没有收到 RANGE (#43) — 星座计数与星点保持 --。',
    );

    const real = satvisSky();
    paintSky(real.length ? real : symbolicSky(symbolic));
    renderTiles('live');
  }

  /* ---- lost mode: show the gap, never substitute captured values ---- */

  function renderLostDashboard() {
    const when = live.disconnectedAt ? `${utcClock(live.disconnectedAt)} UTC` : '—';
    const error = live.lastError ? `（${live.lastError}）` : '';

    for (const node of [
      el.bandPosition,
      el.bandLat,
      el.bandLon,
      el.bandHeight,
      el.posMode,
      el.posPosition,
      el.posLat,
      el.posLon,
      el.posHeight,
      el.posHeightAcc,
      el.pos2d,
      el.posDatum,
    ]) {
      setText(node, '--');
    }
    setBadge(el.bandPosBadge, 'unknown');
    setBadge(el.cardPosBadge, 'unknown');
    setText(el.posReason, `Live lost · 会话在 ${when} 断开${error} — 位置字段回到 --，不会改用抓包数据。`);

    setText(el.devCpu, '--');
    setText(el.devTemp, '--');
    setText(el.devVoltage, '--');
    setText(el.devCurrent, '--');
    setBadge(el.devCpuBadge, 'unknown');
    setBadge(el.devTempBadge, 'unknown');
    setBadge(el.devVoltageBadge, 'unknown');
    setBadge(el.devCurrentBadge, 'unknown');
    setText(el.bandModel, '--');
    setText(el.bandCpu, '--');
    setText(el.bandLogging, '--');
    setText(el.bandInterference, '--');
    setText(el.bandTime, '--');
    setBadge(el.bandDevBadge, 'unknown');
    el.bandDevBadge.title = 'The live session closed; no device readings are available.';
    setText(el.devReason, `Live lost · 会话在 ${when} 断开 — Device 读数不可用，重新连接后自动恢复。`);

    setText(el.interference, '--');
    setBadge(el.intBadge, 'unknown');
    setText(el.intReason, 'Live lost · 会话已断开 — 没有干扰检测数据。');

    for (const item of CONSTELLATIONS) {
      for (const suffix of ['use', 'idle', 'missing']) {
        const node = satCount[`${item.key}-${suffix}`];
        if (node) node.textContent = '--';
      }
    }
    setBadge(el.satBadge, 'unknown');
    setText(el.satNote, `Live lost · 会话在 ${when} 断开 — 星座计数与星点已清空。`);
    paintSky([]);
    renderTiles('lost');
  }

  /* ---- loading ---- */

  async function probe(msgId) {
    try {
      const data = await api.get('/api/records', { capture: state.capture, msgId, limit: 1 });
      return data.records && data.records[0] ? data.records[0] : null;
    } catch {
      return null;
    }
  }

  /** Several records of one id — `SERIALCONFIG`/`INTERFACEMODE` carry one record per port. */
  async function probeList(msgId, limit = 1, offset = 0) {
    try {
      const data = await api.get('/api/records', { capture: state.capture, msgId, offset, limit });
      return Array.isArray(data.records) ? data.records : [];
    } catch {
      return [];
    }
  }

  async function recordTotal(msgId) {
    try {
      const data = await api.get('/api/records', { capture: state.capture, msgId, limit: 1 });
      return Number(data.total) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * §2.3.4…§2.3.12 in one pass. Every list is fetched as a list (not as "the first record"), the
   * newest RANGE epoch is fetched by its own offset so the tracking table cannot drift from the
   * Satellite View counters, and a failed fetch degrades to an empty list — the readers then print
   * `--` and name the id, which is the same state a capture without that record produces.
   */
  async function loadTiles(capture) {
    if (!capture) return null;
    const [
      features,
      stats,
      serial,
      logs,
      iface,
      filestatus,
      ppppos,
      pppdop,
      pppdop2,
      terrastar,
      oceanix,
      veripos,
      terrastarstatus,
      oceanixstatus,
      veriposdecoder,
      ntrip,
      lband,
      satelstatus,
      sateldetect,
      heading2,
      dualantenna,
      inspvax,
    ] = await Promise.all([
      probeList(MODELFEATURES),
      probeList(PORTSTATS),
      probeList(SERIALCONFIG, 8),
      probeList(LOGLIST),
      probeList(INTERFACEMODE, 8),
      probeList(FILESTATUS),
      probeList(PPPPOS),
      probeList(PPPDOP),
      probeList(PPPDOP2),
      probeList(TERRASTARINFO),
      probeList(OCEANIXINFO),
      probeList(VERIPOSINFO),
      probeList(TERRASTARSTATUS),
      probeList(OCEANIXSTATUS),
      probeList(VERIPOSDECODERSTATUS),
      probeList(NTRIPCONFIG, 4),
      probeList(LBANDTRACKSTAT),
      probeList(SATELSTATUS),
      probeList(SATELDETECT, 2),
      probeList(HEADING2),
      probeList(DUALANTENNAALIGN),
      probeList(INSPVAX),
    ]);
    const featureState = readFeatures(features[0]);
    const rangeTotal = await recordTotal(RANGE);
    const newestRange = rangeTotal ? await probeList(RANGE, 1, rangeTotal - 1) : [];
    const satvis = await probeList(SATVIS2, 8);
    return {
      features: featureState,
      ports: readPorts({ stats: stats[0], serial, logs: logs[0], iface, features: featureState }),
      logging: readLogging({ filestatus, logs: logs[0] }),
      ppp: readPpp({
        features: featureState,
        ppppos,
        pppdop,
        pppdop2,
        terrastar,
        oceanix,
        veripos,
        terrastarstatus,
        oceanixstatus,
        veriposdecoder,
        ntrip,
        lband,
      }),
      radio: readRadio({ satelstatus, sateldetect }),
      align: readAlign({ features: featureState, heading2, dualantenna }),
      span: readSpan({ features: featureState, inspvax }),
      tracking: readSatTracking({ range: newestRange, satvis }),
    };
  }

  async function openCapture(capture) {
    if (!capture) return;
    const token = (state.token += 1);
    const stale = () => !state.alive || token !== state.token;
    state.capture = capture;
    state.open = true;
    state.version = null;
    state.interference = null;
    state.tiles = null;
    setBodyState();
    renderDeviceShell();

    /* A live dashboard owns the tiles: do not parse a 3 MB capture the user cannot see, and do
     * not let a slower capture response overwrite live values. */
    if (liveMode() === 'live') {
      render();
      return;
    }

    alert('');
    setText(el.bandTime, '--');

    let logs = null;
    try {
      logs = await api.get('/api/logs', { capture });
    } catch (error) {
      if (!stale()) alert(`Capture statistics failed: ${error.message}`);
    }
    if (stale()) return;
    state.logs = logs;

    /* A capture without BESTPOS / HWMONITOR / RANGE still shows the dashboard: every probe fails
       soft and leaves `--` behind. */
    const [bestpos, hw, version, interference] = await Promise.all([
      probe(BESTPOS),
      probe(HWMONITOR),
      probe(VERSION_LOG),
      probe(ITDETECTSTATUS),
    ]);
    if (stale()) return;
    state.position = readPosition(bestpos);
    state.device = readDevice(hw);
    state.version = readVersion(version);
    state.interference = readInterference(interference);

    let latest = '';
    if (logs && Array.isArray(logs.groups)) {
      for (const group of logs.groups) {
        if (group.lastUtc && group.lastUtc > latest) latest = group.lastUtc;
      }
    }
    state.time = latest ? utcClock(latest) : '';

    render();

    /* The counters and the 2.3.x tiles read the same capture in parallel: one capture parse is
     * cached per process, so the extra record fetches cost a JSON round trip each, not a re-parse. */
    const [range, tiles] = await Promise.all([
      loadRange(capture).catch(() => null),
      loadTiles(capture).catch(() => null),
    ]);
    if (stale()) return;
    state.range = range; // an unreadable RANGE only empties the counters
    state.tiles = tiles;
    render();
  }

  function closeCapture() {
    state.open = false;
    state.logs = null;
    state.position = null;
    state.device = null;
    state.range = null;
    state.version = null;
    state.interference = null;
    state.tiles = null;
    setBodyState();
    renderAppBar();
    renderList();
  }

  async function boot() {
    try {
      const data = await api.get('/api/captures');
      if (!state.alive) return;
      state.captures = data.captures ?? [];
    } catch (error) {
      if (state.alive) alert(`Capture list failed: ${error.message}`);
    }
    if (!state.alive) return;

    /* A session may already be open (Tools ▸ Terminal connects without leaving this page, and a
     * reload must not drop back to a capture while the receiver is streaming). */
    await livePoll();
    if (!state.alive) return;
    if (liveMode() === 'live') {
      state.open = true;
      setBodyState();
      renderDeviceShell();
      render();
      startLivePolling();
      return;
    }

    /* ctx.capture is empty on the very first mount (the shell fills its picker asynchronously),
       so the panel picks the same default the shell does. */
    const wanted =
      (state.capture && state.captures.some((item) => item.path === state.capture) && state.capture) ||
      (ctx.capture && state.captures.some((item) => item.path === ctx.capture) && ctx.capture) ||
      state.captures.find((item) => item.path === 'convert/clean-9600.gps')?.path ||
      state.captures[0]?.path ||
      '';

    if (wanted) await openCapture(wanted);
    else closeCapture();
    startLivePolling();
  }

  /* ---- events ---- */

  /** The injected app-bar node: the file tab is the current page, the ✕ closes it again. */
  const onAppTabClick = (event) => {
    event.preventDefault();
    if (event.target.closest('.mg-filetab-close')) closeCapture();
  };
  const onListClick = (event) => {
    const open = event.target.closest('[data-open]');
    if (!open) return;
    openCapture(open.dataset.open);
  };
  const onHelpClick = (event) => {
    const node = event.target.closest('[data-help]');
    if (!node) return;
    event.preventDefault();
  };

  /* Tools ▸ Terminal / Events / Device ▸ .cfg, and the Configuration drawer. */
  const closeDrops = () => {    root.querySelectorAll('[data-drop]').forEach((node) => {
      node.hidden = true;
    });
    root.querySelectorAll('[data-submenu]').forEach((node) => {
      node.setAttribute('aria-expanded', 'false');
    });
  };
  /**
   * Satellite Tracking's two controls: the constellation buttons and the Carrier-to-Noise /
   * Lock Time switch. Both only re-arrange the rows already read from the capture — no refetch,
   * no second pass over the file.
   */
  const onTrackClick = (event) => {
    const metric = event.target.closest('[data-track-metric]');
    if (metric) {
      TRACK_VIEW.metric = metric.dataset.trackMetric === 'lock' ? 'lock' : 'cno';
      for (const node of root.querySelectorAll('[data-track-metric]')) {
        const active = node.dataset.trackMetric === TRACK_VIEW.metric;
        node.classList.toggle('is-active', active);
        node.setAttribute('aria-pressed', String(active));
      }
      if (state.tiles?.tracking) renderTrackingTile(state.tiles.tracking);
      return;
    }
    const constellation = event.target.closest('[data-track-system]');
    if (!constellation) return;
    TRACK_VIEW.system = constellation.dataset.trackSystem || 'all';
    if (state.tiles?.tracking) renderTrackingTile(state.tiles.tracking);
  };

  const onMenuClick = (event) => {
    /* A nested flyout is opened by its own button and must not run the leaf action. Its parent
     * dropdown has to stay open, otherwise `closeDrops()` would hide the flyout along with it. */
    const submenu = event.target.closest('[data-submenu]');
    if (submenu) {
      const host = submenu.closest('.mg-drop-nested');
      const drop = host ? host.querySelector('[data-drop]') : null;
      const parentDrop = submenu.closest('.mg-drop');
      const wasOpen = drop ? !drop.hidden : false;
      closeDrops();
      if (parentDrop) parentDrop.hidden = false;
      if (drop && !wasOpen) {
        drop.hidden = false;
        submenu.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    const button = event.target.closest('[data-menu]');
    if (button) {
      const key = button.dataset.menu;
      if (key === 'configuration') {
        closeDrops();
        void openConfigDrawer();
        return;
      }
      const host = button.closest('.mg-drop-host');
      const drop = host ? host.querySelector('[data-drop]') : null;
      const wasOpen = drop ? !drop.hidden : false;
      closeDrops();
      if (drop && !wasOpen) drop.hidden = false;
      return;
    }
    const dropItem = event.target.closest('[data-menu-item]');
    if (!dropItem) return;
    const key = dropItem.dataset.menuItem;
    closeDrops();
    if (key === 'terminal') termOpen();
    else if (key === 'events') void openConfigDrawer('events');
    else if (SETTINGS_PAGES.has(key)) void openConfigDrawer(key);
    else if (DEVICE_PAGES.has(key)) void openConfigDrawer(key);
    else if (TOOLS_PAGES.has(key)) void openConfigDrawer(key);
    else if (key === 'exportCfg') openDeviceModal('export');
    else if (key === 'importCfg') openDeviceModal('import');
    else if (key === 'restart') openResetDialog('restart');
    else if (key === 'factoryReset') openResetDialog('factoryReset');
  };
  const onConfigClick = (event) => {
    const node = event.target.closest('[data-config]');
    if (!node) return;
    if (node.dataset.config === 'close') closeConfigDrawer();
  };
  const onConfigChange = (event) => {
    if (!event.target.matches('[data-config="page"]')) return;
    setConfigFrame(event.target.value);
  };
  const onCfgClick = (event) => {
    const node = event.target.closest('[data-cfg]');
    if (!node) return;
    const action = node.dataset.cfg;
    if (action === 'close') closeDeviceModal();
    else if (action === 'refresh') void loadDeviceStatus();
    else if (action === 'download') void downloadCfg();
    else if (action === 'parse') void parseCfg();
    else if (action === 'import') void importCfg();
  };
  const onCfgTabClick = (event) => {
    const node = event.target.closest('[data-cfg-tab]');
    if (!node) return;
    selectCfgTab(node.dataset.cfgTab);
    if (node.dataset.cfgTab === 'export') void loadDeviceStatus();
  };
  const onCfgFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (fileEls.text) fileEls.text.value = String(reader.result ?? '');
      void parseCfg();
    };
    reader.readAsText(file);
  };
  const onResetClick = (event) => {
    const node = event.target.closest('[data-reset]');
    if (!node) return;
    const action = node.dataset.reset;
    if (action === 'close' || action === 'cancel') closeResetDialog();
    else if (action === 'go') void sendReset();
  };
  const onResetInput = (event) => {
    if (event.target.matches('[data-reset="eraseNvm"]')) {
      reset.eraseNvm = Boolean(event.target.checked);
      renderReset();
      return;
    }
    if (!event.target.matches('[data-reset="typed"]')) return;
    reset.typed = event.target.value;
    renderReset();
  };
  const onTermClick = (event) => {
    const button = event.target.closest('[data-term]');
    if (!button) return;
    const action = button.dataset.term;
    if (action === 'close') termClose();
    else if (action === 'connect') void termConnect();
    else if (action === 'disconnect') void termDisconnect();
  };
  const onTermSubmit = (event) => {
    if (!event.target.matches('[data-term="form"]')) return;
    event.preventDefault();
    const line = termEls.line?.value ?? '';
    if (termEls.line) termEls.line.value = '';
    void termSend(line);
  };
  /** The mode strip's buttons: Connect/Reconnect opens the Terminal drawer, Disconnect closes the
   *  session, Back to capture replay is the only way out of "Live lost". */
  const onModeAction = (event) => {
    const button = event.target.closest('[data-mode-action]');
    if (!button) return;
    const action = button.dataset.modeAction;
    if (action === 'connect') openAddDevice();
    else if (action === 'disconnect') void termDisconnect();
    else if (action === 'replay') {
      live.dismissed = true;
      if (state.capture) void openCapture(state.capture);
      else closeCapture();
      render();
    }
  };


  if (appTab) {
    appTab.addEventListener('click', onAppTabClick);
    appTab.addEventListener('click', onModeAction);
  }
  el.listCards.addEventListener('click', onListClick);
  el.list.addEventListener('click', onModeAction);
  el.device.addEventListener('click', onHelpClick);
  el.device.addEventListener('click', onMenuClick);
  el.device.addEventListener('click', onModeAction);
  el.device.addEventListener('click', onTrackClick);
  if (el.config) {
    el.config.addEventListener('click', onConfigClick);
    el.config.addEventListener('change', onConfigChange);
  }
  if (el.cfg) {
    el.cfg.addEventListener('click', onCfgClick);
    el.cfg.addEventListener('click', onCfgTabClick);
    el.cfg.addEventListener('change', onCfgFile);
  }
  if (el.terminal) {
    el.terminal.addEventListener('click', onTermClick);
    el.terminal.addEventListener('submit', onTermSubmit);
  }
  if (el.adddev) el.adddev.addEventListener('click', onAddDeviceClick);
  if (el.reset) {
    el.reset.addEventListener('click', onResetClick);
    el.reset.addEventListener('input', onResetInput);
  }

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || !state.alive) return;
      if (state.open && name === state.capture) return;
      openCapture(name);
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__manageCleanup = () => {
    state.alive = false;
    stopLivePolling();
    el.listCards.removeEventListener('click', onListClick);
  el.list.removeEventListener('click', onModeAction);
    el.device.removeEventListener('click', onHelpClick);
    el.device.removeEventListener('click', onMenuClick);
    el.device.removeEventListener('click', onModeAction);
    el.device.removeEventListener('click', onTrackClick);
    if (el.config) {
      el.config.removeEventListener('click', onConfigClick);
      el.config.removeEventListener('change', onConfigChange);
    }
    if (el.cfg) {
      el.cfg.removeEventListener('click', onCfgClick);
      el.cfg.removeEventListener('click', onCfgTabClick);
      el.cfg.removeEventListener('change', onCfgFile);
    }
    if (el.terminal) {
      el.terminal.removeEventListener('click', onTermClick);
      el.terminal.removeEventListener('submit', onTermSubmit);
    }
    if (el.adddev) el.adddev.removeEventListener('click', onAddDeviceClick);
    if (el.reset) {
      el.reset.removeEventListener('click', onResetClick);
      el.reset.removeEventListener('input', onResetInput);
    }
    stopResetTimer();
    if (appTab) {
      appTab.removeEventListener('click', onAppTabClick);
      appTab.removeEventListener('click', onModeAction);
      appTab.remove();
    }
    if (offCapture) offCapture();
    if (document.body.dataset.manageState) delete document.body.dataset.manageState;
  };

  boot();
}

export default { mount, unmount };
