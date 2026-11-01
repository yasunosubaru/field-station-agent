/**
 * Tools ▸ Interference Toolkit (manual §2.2.9) — the read-only half this build can honestly show.
 *
 * The shipped component (`view/interferenceToolKit/*`) is a spectrum *plotter*: it streams
 * `ITPSDFINAL` (#1968, 1024 bins per record) / `ITPSDDETECT` (#2063), draws a 2-D or 3-D trace with
 * Plotly, and its Settings pane writes `ITDETECTCONFIG`, `ITFRONTENDMODE`, `ITSPECTRALANALYSIS`,
 * `ITBANDPASSCONFIG` and friends. Nothing of that round trip can be reproduced from a capture, and
 * a plot drawn from invented samples would be a lie, so this page keeps what the receiver's own
 * records *do* say:
 *
 *   - the **detections** of `ITDETECTSTATUS` (#2065) — band, detector, centre frequency, the four
 *     parameters and the two severity words, one row per `interference_statuses[i]`;
 *   - the shipped **"No interference detected"** state, for a record whose status count is 0
 *     (`;0*…` — 9 of the b7 capture's 47 records are exactly that);
 *   - the **configuration** records the suite reads: `ITDETECTCONFIG` (#2143, the Interference
 *     Toolkit switch), `ITWARNINGCONFIG` (#2289), `ITFRONTENDMODE` (#2039, HDR mode) and
 *     `ITSPECTRALANALYSIS` (#1967, the Advanced Settings) — displayed, never written.
 *
 * The pieces the page cannot fill print `--` **and say why** (see `ItkCaptureSummary.missing`).
 *
 * `ITDETECTSTATUS` is a **text** record on this receiver (`#ITDETECTSTATUSA`), so it never reaches
 * the live decoder: the rows are handed over by the host from a capture
 * (`packages/app/src/config-http.ts#feedItkCapture`), which is why this page has no
 * `CONFIG_SUBSCRIPTIONS` entry.
 */

import type { TabId } from '../types.ts';
import type { ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, scopedQuery, scopedQueryAll, setVisible } from './base.ts';

export const ITK_MSG = {
  ITDETECTSTATUS: 2065,
  ITDETECTCONFIG: 2143,
  ITWARNINGCONFIG: 2289,
  ITSPECTRALANALYSIS: 1967,
  ITFRONTENDMODE: 2039,
} as const;

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
}

/** `interferenceToolKit.js` read-only slice: `#itk-layout`, its detections and its settings. */
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
    if (mounted) this.buildReadOnlySections(tab);
    return mounted;
  }

  /**
   * The page is a **view**: it never sends anything, so nothing can be dirty and there is nothing
   * to apply. `apply` therefore never reaches the transport, and `takeCommands()` stays empty.
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
    this.renderConfig(tab, summary);
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

  private renderConfig(tab: TabId, summary: ItkCaptureSummary | undefined): void {
    const document = this.context.document;
    const body = scopedQuery(this.context, tab, '#itk-config-rows');
    if (body) {
      body.innerHTML = '';
      for (const [item, value, source] of configLines(summary?.config)) {
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
          : 'No capture read yet: every value below is -- until the drawer opens this page with one.';
    }
  }

  /**
   * Create the read-only scaffolding once, inside the shipped fragment: two sections after the
   * tab strip (which the plot used to fill) plus a note that names what was removed and why.
   *
   * Nothing is drawn over the shipped markup: the parts that need a live spectrum stream (the plot
   * pane, the Settings sidenav, Show History, Share) are hidden, and the two panes this build can
   * fill are appended.
   */
  private buildReadOnlySections(tab: TabId): void {
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
      /* The toolkit switch is a *control*: leaving a disabled switch beside the title reads as a
       * broken toggle. Its state is the first row of the configuration table instead, with the
       * record it came from (`ITDETECTCONFIG` #2143). */
      '.toggle-switch.itdetect-toggle',
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
      'Read-only in this build: the detection list and the configuration below come from the ' +
      'capture’s own records. The spectrum plot, the filters and the Settings controls need the ' +
      'live ITPSDFINAL/ITPSDDETECT stream and are not drawn here; the Interference Toolkit switch ' +
      'is the first row of the configuration table.';
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
    configHeading.textContent = 'Configuration (read only)';
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

    root.append(detections, config);

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

  private pageState(tab: TabId): ItkPageState {
    let state = this.states.get(tab);
    if (!state) {
      state = { band: '' };
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
export function configLines(config: ItkConfigValues | undefined): Array<[string, string, string]> {
  return [
    ['Interference Toolkit switch', text(config?.itkSwitch), 'ITDETECTCONFIG (#2143) frequency'],
    ['Warning level', text(config?.warningLevel), 'ITWARNINGCONFIG (#2289) level'],
    ['Enable HDR Mode', text(config?.hdrMode), 'ITFRONTENDMODE (#2039) mode'],
    ['Spectral analysis source', text(config?.dataSource), 'ITSPECTRALANALYSIS (#1967) data_source'],
    ['Spectral analysis band', text(config?.analysisBand), 'ITSPECTRALANALYSIS (#1967) frequency'],
    ['Update Rate (secs)', text(config?.updatePeriodMs), 'ITSPECTRALANALYSIS (#1967) psd_update_period_ms'],
    ['Spectrum Resolution', text(config?.fftSize), 'ITSPECTRALANALYSIS (#1967) fft_size'],
    ['Time Averaging (secs)', text(config?.timeAveragingSec), 'ITSPECTRALANALYSIS (#1967) psd_time_ave_window_sec'],
    [
      'Detection Sensitivity (bins)',
      text(config?.detectionSensitivity),
      'ITSPECTRALANALYSIS (#1967) psd_subcarrier_ave_window',
    ],
    ['Filters', text(config?.filters), 'ITFILTTABLE (#1991) / ITPROGFILTBANK (#2023)'],
  ];
}

function text(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? '--' : trimmed;
}
