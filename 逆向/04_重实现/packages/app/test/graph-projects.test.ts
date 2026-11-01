/**
 * B10 — Graph's **Recent Projects**: more than one project, and the data actually changes when you
 * switch.
 *
 * What is checked, in order:
 *
 *  1. the project layer (`packages/graph/src/export-projects.ts`) discovers **directories**, not a
 *     hardcoded name list: `export/csv/` (the shipped `clean` project) and `export/b1/` (converted
 *     from `live-20261031/b1-20261101.sbf` by `packages/graph/tools/export-sbf-project.ts`);
 *  2. `?project=` accepts the directory key (`csv`, `b1`) **and** the CSV's `#Project Name:`
 *     (`clean`), refuses paths / `..` / an empty value, and 404s on an unknown project;
 *  3. the same CSV name returns **different rows, values and metadata** in the two projects — the
 *     judged failure mode is a card that looks switched while the pane still shows the old project;
 *  4. the second project is a **conversion**, not a fixture: re-running the exporter into a temp
 *     directory reproduces the committed CSVs byte for byte (the one machine-dependent line,
 *     `#Project Directory:`, is normalised);
 *  5. the default (parameterless) route and `?project=csv` agree field for field, because the
 *     parameterless path still goes through `graphcsv.ts`.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_DIR, SAMPLES_DIR } from '../src/paths.ts';
import { GRAPH_CSV_DIR, graphData, listGraphCsv } from '../src/graphcsv.ts';
import {
  GraphCsvError,
  listExportProjects,
  listProjectCsv,
  projectGraphData,
  resolveExportProject,
} from '../../graph/src/export-projects.ts';
import { loadCapture } from '../../graph/src/capture.ts';
import { writeCsv } from '../../graph/src/csv.ts';
import {
  cleanCapture,
  projectFromCapture,
} from '../../graph/tools/export-sbf-project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

/** `<repo>/逆向/00_来源/samples/graph/export` */
const EXPORT_DIR = resolve(SAMPLES_DIR, 'graph', 'export');
/** The capture the `b1` project was converted from. */
const B1_CAPTURE = resolve(SAMPLES_DIR, 'live-20261031', 'b1-20261101.sbf');
const B1_DIR = resolve(EXPORT_DIR, 'b1');

/* ---------------- 1. the project layer ---------------- */

test('listExportProjects finds every export directory, not a hardcoded name', () => {
  const projects = listExportProjects(EXPORT_DIR);
  const keys = projects.map((project) => project.key).sort();
  assert.deepEqual(keys, ['b1', 'csv', 'heading'], 'export/ 下应有三个工程目录');

  const clean = projects.find((project) => project.key === 'csv')!;
  assert.equal(clean.name, 'clean', '工程名取自 CSV 的 #Project Name:，不是目录名');
  assert.equal(clean.csvCount, 12);
  assert.equal(clean.startTime, '2442,463097.350');
  assert.equal(clean.endTime, '2442,463102.300');
  assert.equal(clean.duration, '00:00:04');
  assert.equal(clean.dataFileName, 'clean.gps');
  assert.equal(relative(REPO_DIR, clean.csvDirectory).split('\\').join('/'),
    '逆向/00_来源/samples/graph/export/csv');

  const b1 = projects.find((project) => project.key === 'b1')!;
  assert.equal(b1.name, 'b1');
  // b1 的采集里有 25 条 BESTVEL，所以重导之后是 13 份（多一份 Velocity.csv）；clean 没有 BESTVEL。
  assert.equal(b1.csvCount, 13);
  assert.equal(b1.dataFileName, 'b1-20261101.sbf', '第二个工程是从 b1 的 SBF 转出来的');
  assert.equal(b1.startTime, '2442,570227.100');
  assert.equal(b1.duration, '00:00:28');
  assert.equal(relative(REPO_DIR, b1.csvDirectory).split('\\').join('/'),
    '逆向/00_来源/samples/graph/export/b1/csv', 'Graph 把 CSV 写进 <project>/csv/');

  // 第三个工程是从**合成抓包**导出的（本机没有 INS 硬件），只有 Heading & Attitude 三份 CSV。
  const heading = projects.find((project) => project.key === 'heading')!;
  assert.equal(heading.name, 'heading');
  assert.equal(heading.csvCount, 3);
  assert.equal(heading.dataFileName, 'heading.sbf');
  assert.deepEqual(listProjectCsv(heading).map((file) => file.name).sort(), [
    'Azimuth.csv', 'Roll and Pitch.csv', 'SPAN Filter Updates.csv',
  ]);

  // Every project's CSVs are real files: the count is checked against disk, not against a constant.
  for (const project of projects) {
    assert.equal(project.csvCount, readdirSync(project.csvDirectory).filter((name) => name.endsWith('.csv')).length);
    assert.ok(project.csvCount > 0);
  }
});

test('resolveExportProject accepts the directory key and the project name, and refuses paths', () => {
  assert.equal(resolveExportProject(EXPORT_DIR, null).project?.key, 'csv', '无参数时是随样本发布的 clean 工程');
  assert.equal(resolveExportProject(EXPORT_DIR, 'b1').project?.key, 'b1');
  assert.equal(resolveExportProject(EXPORT_DIR, 'csv').project?.key, 'csv');
  assert.equal(resolveExportProject(EXPORT_DIR, 'clean').project?.name, 'clean', '#Project Name: 也算');
  assert.equal(resolveExportProject(EXPORT_DIR, 'B1').project?.key, 'b1', '大小写不敏感');
  assert.equal(resolveExportProject(EXPORT_DIR, 'Nope').project, null);

  for (const bad of ['', '  ', '../csv', 'csv/../b1', 'C:\\Windows', 'a/../b', 'x\0y']) {
    assert.throws(
      () => resolveExportProject(EXPORT_DIR, bad),
      (error: unknown) => error instanceof GraphCsvError && error.status === 400,
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test('the two projects export the same chart names — plus Velocity, which only b1 has data for', () => {
  const projects = listExportProjects(EXPORT_DIR);
  const clean = projects.find((project) => project.key === 'csv')!;
  const b1 = projects.find((project) => project.key === 'b1')!;
  const cleanNames = listProjectCsv(clean).map((file) => file.name);
  const b1Names = listProjectCsv(b1).map((file) => file.name);
  assert.deepEqual(b1Names.filter((name) => name !== 'Velocity.csv'), cleanNames, '12 份共有');
  assert.deepEqual(b1Names.filter((name) => !cleanNames.includes(name)), ['Velocity.csv'],
    'b1 多一份 Velocity：它的采集里有 25 条 BESTVEL，clean 一条也没有');

  const b1Velocity = projectGraphData(b1, 'Velocity.csv');
  assert.equal(b1Velocity.rows, 25);
  assert.deepEqual(b1Velocity.numericColumns.map((column) => column.name),
    ['North Vel', 'East Vel', 'Up Vel', 'Horizontal Speed', '3D Speed']);

  const cleanHeight = projectGraphData(clean, 'Height.csv');
  const b1Height = projectGraphData(b1, 'Height.csv');
  assert.equal(cleanHeight.rows, 5);
  assert.equal(b1Height.rows, 51, 'b1 的 Height.csv 是 28 s 里的 51 个 BESTPOS');
  assert.equal(cleanHeight.comments.projectName, 'clean');
  assert.equal(b1Height.comments.projectName, 'b1');
  assert.equal(b1Height.comments.dataFileName, 'b1-20261101.sbf');
  assert.notDeepEqual(b1Height.series.points[0], cleanHeight.series.points[0]);
  assert.equal(b1Height.series.points.length, 51);
  assert.equal(b1Height.series.spanSeconds, 27);
});

/* ---------------- 2. the HTTP routes ---------------- */

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((ready, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('server did not start in 20 s')), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        ready(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* drain */ });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: resolve(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!child || child.killed) return;
  const closed = new Promise((done) => child!.once('close', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
  timer.unref();
  await closed;
  clearTimeout(timer);
  await new Promise((done) => setTimeout(done, 150));
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(base + path, { headers: { connection: 'close' } });
  return { status: response.status, body: await response.json() };
}

test('GET /api/graph/projects lists every project with name, CSV count, time range and path', async () => {
  const { status, body } = await getJson('/api/graph/projects');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 3);
  assert.equal(body.count, body.projects.length);
  assert.equal(body.default, 'csv');
  assert.equal(body.root, '逆向/00_来源/samples/graph/export');

  const b1 = body.projects.find((project: any) => project.key === 'b1');
  assert.ok(b1, '列表里有第二个工程 b1');
  assert.deepEqual(Object.keys(b1).sort(), [
    'bytes', 'csvCount', 'csvDirectory', 'dataFileName', 'directory', 'duration',
    'endTime', 'key', 'modified', 'name', 'startTime',
  ]);
  assert.equal(b1.name, 'b1');
  assert.equal(b1.csvCount, 13);
  assert.equal(b1.startTime, '2442,570227.100');
  assert.equal(b1.endTime, '2442,570255.151');
  assert.equal(b1.duration, '00:00:28');
  assert.equal(b1.directory, '逆向/00_来源/samples/graph/export/b1');
  assert.equal(b1.csvDirectory, '逆向/00_来源/samples/graph/export/b1/csv');
  assert.ok(b1.bytes > 0);

  const clean = body.projects.find((project: any) => project.key === 'csv');
  assert.equal(clean.name, 'clean');
  assert.equal(clean.csvCount, 12);
  assert.equal(clean.duration, '00:00:04');
});

test('GET /api/graph/files|data take ?project= and stay 400/404 on bad input', async () => {
  const b1Files = await getJson('/api/graph/files?project=b1');
  assert.equal(b1Files.status, 200);
  assert.equal(b1Files.body.project.key, 'b1');
  assert.equal(b1Files.body.count, 13);
  assert.equal(b1Files.body.directory, '逆向/00_来源/samples/graph/export/b1/csv');
  assert.equal(b1Files.body.files[0].rows, 51);

  // The name form of the parameter (`clean`) reaches the same project as the directory key (`csv`).
  const byName = await getJson('/api/graph/files?project=clean');
  assert.equal(byName.status, 200);
  assert.equal(byName.body.project.key, 'csv');

  const b1Height = await getJson('/api/graph/data?file=Height.csv&project=b1');
  assert.equal(b1Height.status, 200);
  assert.equal(b1Height.body.project.key, 'b1');
  assert.equal(b1Height.body.rows, 51);
  assert.equal(b1Height.body.comments.projectName, 'b1');

  assert.equal((await getJson('/api/graph/data?file=Height.csv&project=Nope')).status, 404);
  assert.equal((await getJson('/api/graph/data?file=Height.csv&project=')).status, 400);
  assert.equal((await getJson('/api/graph/data?file=Height.csv&project=../b1')).status, 400);
  assert.equal((await getJson('/api/graph/files?project=../b1')).status, 400);
});

test('switching project changes the rows, the series and the metadata of the same file', async () => {
  const clean = await getJson('/api/graph/data?file=Height.csv&project=clean');
  const b1 = await getJson('/api/graph/data?file=Height.csv&project=b1');

  assert.equal(clean.body.name, b1.body.name, '同一个 CSV 名');
  assert.notEqual(clean.body.rows, b1.body.rows);
  assert.notEqual(clean.body.series.points[0][1], b1.body.series.points[0][1]);
  assert.notEqual(clean.body.comments.projectName, b1.body.comments.projectName);
  assert.notEqual(clean.body.comments.startTime, b1.body.comments.startTime);
  assert.equal(clean.body.project.key, 'csv');
  assert.equal(b1.body.project.key, 'b1');

  // A PVT tile reads `numericColumns`; both projects must report the CSV's own column set.
  const b1Row = await getJson('/api/graph/data?file=Tracking%20Time.csv&project=b1');
  assert.equal(b1Row.body.rows, 530);
  assert.ok(b1Row.body.columns.length > 60, 'b1 的 Tracking Time 列数明显多于 clean 的 60');
});

test('the parameterless routes still return the shipped clean project, field for field', async () => {
  const legacy = await getJson('/api/graph/files');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.directory, '逆向/00_来源/samples/graph/export/csv');
  assert.deepEqual(legacy.body.files, listGraphCsv());

  const viaProject = await getJson('/api/graph/files?project=csv');
  assert.deepEqual(viaProject.body.files, legacy.body.files, '?project=csv 与默认路径同一份文件列表');

  for (const name of ['2D Trajectory.csv', 'Height.csv', 'Receiver Status.csv', 'Tracking Time.csv']) {
    const plain = await getJson('/api/graph/data?file=' + encodeURIComponent(name));
    const scoped = await getJson('/api/graph/data?file=' + encodeURIComponent(name) + '&project=csv');
    for (const key of ['name', 'bytes', 'comments', 'columns', 'rows', 'numericColumns', 'column', 'series', 'table', 'tableTruncated']) {
      assert.deepEqual(scoped.body[key], plain.body[key], `${name} 的 ${key} 应与 graphcsv.ts 一致`);
    }
    // …and the old reader says the same thing the new one does, directly.
    const reference = graphData(name);
    assert.equal(reference.rows, plain.body.rows);
    assert.deepEqual(reference.columns, plain.body.columns);
  }
});

/* ---------------- 3. the second project is a conversion, not a fixture ---------------- */

test('re-running the exporter reproduces samples/graph/export/b1 byte for byte', () => {
  assert.ok(existsSync(B1_DIR), 'b1 工程应已随样本落地');
  const sidecar = JSON.parse(readFileSync(join(B1_DIR, 'project.json'), 'utf8'));
  assert.equal(sidecar.dataFileName, 'b1-20261101.sbf');
  assert.equal(sidecar.startTime, '2442,570227.100');
  assert.equal(sidecar.duration, '00:00:28');
  assert.equal(sidecar.droppedFrames.length, 1, 'b1 里有 1 帧损坏的 RANGE，转换时被跳过并记在这里');
  assert.equal(sidecar.droppedFrames[0].name, 'RANGE');

  const out = mkdtempSync(join(tmpdir(), 'graph-project-'));
  try {
    const { capture } = cleanCapture(loadCapture(B1_CAPTURE));
    const project = projectFromCapture(capture, { name: 'b1', outDir: out, capturePath: B1_CAPTURE });
    writeCsv(project, capture, out);

    const committed = readdirSync(join(B1_DIR, 'csv')).filter((name) => name.endsWith('.csv')).sort();
    const rendered = readdirSync(join(out, 'csv')).filter((name) => name.endsWith('.csv')).sort();
    assert.deepEqual(rendered, committed, '同样的 13 份 CSV（含 Velocity）');

    // `#Project Directory:` embeds the output directory, so it is the one line that may differ.
    const normalise = (text: string) => text.replace(/^#Project Directory:.*$/m, '#Project Directory: <out>');
    for (const name of committed) {
      assert.equal(
        normalise(readFileSync(join(out, 'csv', name), 'utf8')),
        normalise(readFileSync(join(B1_DIR, 'csv', name), 'utf8')),
        `${name} 应能由 SBF 重新转换出来`,
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the b1 CSVs carry the capture’s own numbers (no hand-written rows)', () => {
  const text = readFileSync(join(B1_DIR, 'csv', 'Solution Statistics.csv'), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  const header = lines[0].split(',');
  assert.equal(header.length, 5);
  const rows = lines.slice(1);
  assert.equal(rows.length, 51);
  for (const row of rows) assert.equal(row.split(',').length, header.length);

  // Every BESTPOS row must be inside the window the CSV's own comment lines declare.
  const start = /^#Start Time\(GPS\):\s*(\d+),([\d.]+)$/m.exec(text)!;
  const end = /^#End Time\(GPS\):\s*(\d+),([\d.]+)$/m.exec(text)!;
  const toSeconds = (week: string, seconds: string) => Number(week) * 604_800 + Number(seconds);
  const from = toSeconds(start[1], start[2]);
  const to = toSeconds(end[1], end[2]);
  for (const row of rows) {
    const [week, seconds] = row.split(',')[0].trim().split(/\s+/);
    const at = toSeconds(week, seconds);
    assert.ok(at >= from && at <= to, `第 ${rows.indexOf(row) + 1} 行在时间窗内`);
  }

  // The `clean` golden is untouched: its first Height row is still 66.429896.
  assert.match(readFileSync(join(GRAPH_CSV_DIR, 'Height.csv'), 'utf8'), /66\.429896/);
});

test('GET /api/graph/pdf?project=b1 exports that project, not clean', async () => {
  const b1 = await fetch(base + '/api/graph/pdf?project=b1', { headers: { connection: 'close' } });
  assert.equal(b1.status, 200);
  assert.equal(b1.headers.get('x-pdf-project'), 'b1');
  assert.equal(b1.headers.get('content-disposition'), 'attachment; filename="b1.pdf"');
  assert.equal(b1.headers.get('x-pdf-charts'), '13');
  assert.equal(b1.headers.get('x-pdf-pages'), '14');
  await b1.arrayBuffer();

  const unknown = await fetch(base + '/api/graph/pdf?project=Nope', { headers: { connection: 'close' } });
  assert.equal(unknown.status, 404);
  const error = await unknown.json();
  assert.match(error.error, /Nope/);
  assert.match(error.error, /clean/);
});
