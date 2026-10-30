/**
 * Graph data layer + exports, checked against the **shipped golden** produced by Graph 2.11.0
 * (`00_来源/samples/graph/`, driven 2026-10-31 — see `03_分析/06_Graph应用.md §9.2`).
 *
 * The goldens embed the project path Graph itself used (`C:\Users\…\Temp\gs\clean`), which is the
 * same string stored in `clean.gpf`, so no substitution is needed: the comparison is a plain
 * `Buffer` equality.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject, chartTitles, chartMessages } from '../src/project.ts';
import { loadCapture } from '../src/capture.ts';
import { availableCsvCharts, exportCsv } from '../src/csv.ts';
import { renderKml } from '../src/kml.ts';
import { formatDuration, formatGpsColumn, formatTrimmed } from '../src/format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
const GPF = join(SAMPLES, 'graph', 'project', 'clean.gpf');
/** `clean-9600.gps` is the capture the project was built from: 270 864 B = `DataInfo.FileSize`. */
const CAPTURE = join(SAMPLES, 'convert', 'clean-9600.gps');
const CSV_GOLDEN = join(SAMPLES, 'graph', 'export', 'csv');
const KML_GOLDEN = join(SAMPLES, 'graph', 'export', 'clean.kml');

test('loadProject reads .gpf and the sibling DataSummary.json', () => {
  const project = loadProject(GPF);
  assert.equal(project.gpf.PageRoute, '/process');
  assert.equal(project.projectDirectory, 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\gs\\clean');
  assert.equal(project.projectName, 'clean');
  assert.equal(project.dataFileName, 'clean.gps');
  assert.deepEqual(project.dataInfo, {
    Duration: 4950,
    EndTime: 1477384702300,
    FileSize: 270864,
    StartTime: 1477384697350,
  });
  // Side-car file parsed and flattened in (R15): the .gpf already carries every key it has.
  assert.ok(project.dataSummaryFile, 'DataSummary.json parsed');
  assert.deepEqual(project.dataSummaryFile?.Messages, project.messages);
  assert.equal(project.messages.RANGE, 100);
});

test('PlotSummary decides which charts exist (12 titles for this project)', () => {
  const project = loadProject(GPF);
  assert.deepEqual(chartTitles(project.plotSummary), [
    '2D Trajectory',
    'Height',
    'Position SD',
    'Position Status',
    'Position Type',
    'Solution Statistics',
    'CPU Usage',
    'HW Monitor Status',
    'Receiver Status',
    'GNSS Signal Strength',
    'Satellites and Signals',
    'Tracking Time',
  ]);
  assert.deepEqual(chartMessages(project.plotSummary, 'Height'), { BESTPOS: 1 });
  assert.deepEqual(chartMessages(project.plotSummary, 'GNSS Signal Strength'), { RANGE: 1 });
  // A chart with no data is absent rather than empty.
  assert.deepEqual(chartMessages(project.plotSummary, 'Velocity'), {});
});

test('loadCapture decodes the capture with the shipped EDIE dictionary', () => {
  const capture = loadCapture(CAPTURE);
  assert.deepEqual([...capture.counts], [
    ['RANGE', 100],
    ['BESTPOS', 5],
    ['RAWEPHEM', 8],
    ['RXSTATUS', 4],
    ['PORTSTATS', 1],
    ['HWMONITOR', 1],
  ]);
  const bestpos = capture.byName('BESTPOS');
  assert.equal(bestpos[0].gpsMs, 1477384698000);
  assert.equal(bestpos.length, 5);
});

test('exportCsv lists only the implemented charts PlotSummary asks for', () => {
  const project = loadProject(GPF);
  assert.deepEqual(
    availableCsvCharts(project).map((spec) => spec.title),
    ['2D Trajectory', 'Height', 'Position Status', 'Position Type'],
  );
});

for (const name of ['2D Trajectory', 'Height', 'Position Status', 'Position Type']) {
  test(`CSV ${name}.csv is byte-identical to the golden`, () => {
    const project = loadProject(GPF);
    const capture = loadCapture(CAPTURE);
    const result = exportCsv(project, capture).find((entry) => entry.fileName === `${name}.csv`);
    assert.ok(result, `${name}.csv rendered`);
    const golden = readFileSync(join(CSV_GOLDEN, `${name}.csv`));
    assert.deepEqual(result.buffer, golden, `${name}.csv differs from golden`);
  });
}

test('CSV files start with BOM + the six hand-padded comment lines', () => {
  const project = loadProject(GPF);
  const capture = loadCapture(CAPTURE);
  const [first] = exportCsv(project, capture);
  assert.equal(Buffer.compare(first.buffer.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf])), 0);
  const lines = first.buffer.toString('utf8').replace(/^\uFEFF/, '').split('\r\n');
  assert.deepEqual(lines.slice(0, 7), [
    '#Project Name:          clean',
    '#Project Directory:    C:\\Users\\SunCh\\AppData\\Local\\Temp\\gs\\clean',
    '#Data File Name:      clean.gps',
    '#Start Time(GPS):      2442,463097.350',
    '#End Time(GPS):       2442,463102.300',
    '#Duration:                   00:00:04',
    'timestamp (GPS week sec),Latitude,Longitude',
  ]);
});

test('clean.kml is byte-identical to the golden', () => {
  const project = loadProject(GPF);
  const capture = loadCapture(CAPTURE);
  const golden = readFileSync(KML_GOLDEN);
  assert.deepEqual(renderKml(project, capture), golden, 'clean.kml differs from golden');
});

test('formatters match the golden spellings', () => {
  assert.equal(formatGpsColumn(1477384697350), '2442  463097.350');
  assert.equal(formatDuration(4950), '00:00:04');
  assert.equal(formatDuration(2 * 86400_000 + 3_600_000), '2 Days 01:00:00');
  // The one value in the goldens that proves trailing zeros are trimmed.
  assert.equal(formatTrimmed(1.1976104974746704, 6), '1.19761');
  assert.equal(formatTrimmed(30.539974892173998, 6), '30.539975');
});
