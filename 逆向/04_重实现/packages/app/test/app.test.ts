/**
 * End-to-end checks for the shell. Starts the real server on an ephemeral port (`--port 0`) and
 * talks to it over HTTP, so these tests exercise routing, path guards and the protocol pipeline
 * exactly as the browser does.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaybackEngine } from '../../playback/src/playback.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const samplesDir = join(repoRoot, '逆向', '00_来源', 'samples');
const goldenRoot = join(samplesDir, 'convert');

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in 20s\nstderr:\n${stderr}`)), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr}`));
    });
  });
}

async function getJson(path: string) {
  const response = await fetch(base + path);
  const body = await response.json();
  return { response, body };
}

interface ConvertBody {
  ok: boolean;
  format: string;
  fileName: string;
  bytes: number;
  lineTotal: number;
  shownLines: number;
  truncated: boolean;
  binary: boolean;
  text: string | null;
  preview: string | null;
  downloadUrl: string;
  records: { total: number; accepted: number; dropped: number; textRecords: number };
  elapsedMs: number;
}

async function convert(capture: string, format: string): Promise<{ body: ConvertBody; bytes: Buffer }> {
  const response = await fetch(base + '/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture, format }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as ConvertBody;
  assert.equal(body.ok, true);
  const download = await fetch(base + body.downloadUrl);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.byteLength, body.bytes, '下载字节数与响应声明一致');
  return { body, bytes };
}

function golden(...segments: string[]): Buffer {
  return readFileSync(join(goldenRoot, ...segments));
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    timer.unref();
  }
});

test('首页返回 200 且含页面标题与三个工作页', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>All powered-FSA/);
  assert.match(html, /id="panel-convert"/);
  assert.match(html, /id="panel-manage"/);
  assert.match(html, /id="panel-playback"/);
  assert.match(html, /Playback/);
  // Graph is wired too, and Playback is no longer a placeholder.
  assert.match(html, /id="panel-graph"/);
  assert.match(html, /data-tab="graph"/);
  assert.doesNotMatch(html, /NOT IMPLEMENTED/);
  // Offline shell: no CDN scripts or stylesheets.
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/i);
});

test('POST /api/convert 的 ASCII 产物与 golden 逐字节一致', async () => {
  const { body, bytes } = await convert('clean-9600.gps', 'ASCII');
  assert.equal(body.format, 'ASCII');
  assert.equal(body.fileName, 'clean-9600.ASCII');
  assert.equal(body.lineTotal, 119);
  assert.equal(body.shownLines, body.lineTotal);
  assert.equal(body.truncated, false);
  assert.equal(body.preview, null, '未截断时正文放在 text，不重复发送');
  assert.equal(typeof body.text, 'string');
  assert.equal(body.text!.split('\r\n').length - 1, body.lineTotal);
  assert.match(body.text!.split('\r\n')[0], /^#RANGEA,/);
  assert.ok(body.text!.endsWith('\r\n'));
  assert.deepEqual(body.records, { total: 119, accepted: 119, dropped: 0, textRecords: 0 });

  const expected = golden('golden-ascii', 'clean-9600', 'Converted_On_20261030_T1710', 'ASCII', 'clean-9600.ASCII');
  assert.ok(Buffer.from(body.text!, 'utf8').equals(expected), '响应里的 text 也应与 golden 一致');
  assert.equal(bytes.byteLength, expected.byteLength);
  assert.ok(bytes.equals(expected), 'ASCII 产物必须与 golden 逐字节一致');
});

test('其余确定性格式也与 golden 逐字节一致（ABBREV / BINARY / KML）', async () => {
  const abbrev = await convert('clean-9600.gps', 'ABBREV_ASCII');
  assert.ok(abbrev.body.truncated, '6294 行应触发 200 行截断');
  assert.equal(abbrev.body.shownLines, 200);
  assert.equal(abbrev.body.text, null);
  assert.equal(abbrev.body.preview!.split('\n').length, 200);
  assert.ok(abbrev.bytes.equals(golden('golden-abbrev', 'clean-9600', 'Converted_On_20261030_T1710', 'ABBREV_ASCII', 'clean-9600.ABBREV_ASCII')));

  const binary = await convert('clean-9600.gps', 'BINARY');
  assert.equal(binary.body.binary, true);
  assert.ok(binary.bytes.equals(golden('golden-binary', 'clean-9600', 'Converted_On_20261030_T1710', 'BINARY', 'clean-9600.BINARY')));

  const kmlPath = join(goldenRoot, 'golden-kml', 'clean-9600', 'Converted_On_20261030_T1710', 'KML', 'clean-9600_BESTPOS.KML');
  if (existsSync(kmlPath)) {
    const kml = await convert('clean-9600.gps', 'KML');
    assert.equal(kml.body.fileName, 'clean-9600_BESTPOS.KML');
    assert.ok(kml.bytes.equals(readFileSync(kmlPath)));
  }
});

test('GET /api/logs 的 RANGE / BESTPOS / RXSTATUS 条数正确', async () => {
  const { response, body } = await getJson('/api/logs?capture=clean-9600.gps');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.totalRecords, 119);
  assert.equal(body.accepted, 119);
  assert.equal(body.dropped, 0);
  assert.equal(body.types, 6);

  const counts = new Map<number, number>(body.groups.map((group: { id: number; count: number }) => [group.id, group.count]));
  assert.equal(counts.get(43), 100, 'RANGE');
  assert.equal(counts.get(42), 5, 'BESTPOS');
  assert.equal(counts.get(93), 4, 'RXSTATUS');

  const range = body.groups.find((group: { id: number }) => group.id === 43);
  assert.equal(range.name, 'RANGE');
  assert.ok(range.sample.startsWith('#RANGEA,'));
  assert.ok(range.firstMilliseconds <= range.lastMilliseconds);
  assert.ok(range.firstWeek >= 2000);
  assert.match(range.firstUtc, /^2026-10-30T/);
});

test('GET /api/records 返回解析后的字段表', async () => {
  const { response, body } = await getJson('/api/records?capture=clean-9600.gps&msgId=42&limit=1');
  assert.equal(response.status, 200);
  assert.equal(body.name, 'BESTPOS');
  assert.equal(body.total, 5);
  assert.equal(body.records.length, 1);
  const record = body.records[0];
  assert.equal(record.header.week, 2442);
  const latitude = record.fields.find((field: { path: string }) => field.path === 'latitude');
  assert.ok(latitude, '字段表应包含 latitude');
  assert.equal(typeof latitude.value, 'number');
  assert.ok(Math.abs(latitude.value) <= 90);
});

test('抓包路径不能逃出 samples 目录', async () => {
  for (const capture of ['../../../package.json', 'C:\\Windows\\win.ini', 'convert/../../package.json']) {
    const response = await fetch(base + '/api/logs?capture=' + encodeURIComponent(capture));
    assert.equal(response.status, 400, capture);
    const body = await response.json();
    assert.equal(body.ok, false);
  }
});

test('未知抓包与未知接口返回 404', async () => {
  const missing = await fetch(base + '/api/logs?capture=' + encodeURIComponent('convert/nope.gps'));
  assert.equal(missing.status, 404);
  const unknown = await fetch(base + '/api/nothing');
  assert.equal(unknown.status, 404);
});

/* ---------------- playback ---------------- */

const capturePath = join(samplesDir, 'convert', 'clean-9600.gps');
const graphCsvDir = join(samplesDir, 'graph', 'export', 'csv');

function sampleEngine(): PlaybackEngine {
  const engine = new PlaybackEngine();
  engine.load(new Uint8Array(readFileSync(capturePath)));
  return engine;
}

test('GET /api/playback/info 的帧数 / 时长与 clean-9600.gps 一致', async () => {
  const { response, body } = await getJson('/api/playback/info?capture=clean-9600.gps');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.frameCount, 119);
  assert.equal(body.durationMs, 4950);
  assert.equal(body.durationSeconds, 4.95);
  assert.equal(body.startWeek, 2442);
  assert.equal(body.startTime, 463097.35);
  assert.equal(body.finishTime, 463102.3);
  assert.deepEqual(body.speeds, [0.5, 1, 2, 4, 8]);
  assert.deepEqual(body.stats, { textFrames: 0, badCrc: 0, bufferedBytes: 0 });

  const counts = new Map<number, { count: number; name: string }>(
    body.messageCounts.map((item: { id: number; count: number; name: string }) => [item.id, item]),
  );
  assert.equal(counts.get(43)!.count, 100);
  assert.equal(counts.get(43)!.name, 'RANGE');
  assert.equal(counts.get(42)!.count, 5);
  assert.equal(counts.get(93)!.count, 4);
  // The whole capture is 4 messages short of the 119 records only if a CRC failed; nothing did.
  assert.equal([...counts.values()].reduce((total, item) => total + item.count, 0), 119);
});

test('POST /api/playback/frames 的时间轴首尾与窗口与引擎一致', async () => {
  const engine = sampleEngine();
  const response = await fetch(base + '/api/playback/frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture: 'clean-9600.gps' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 119);
  assert.equal(body.count, 119);
  assert.equal(body.frames.length, 119);
  assert.equal(body.frames[0].offsetMs, engine.frames[0].offsetMs);
  assert.equal(body.frames[0].messageId, 43);
  assert.equal(body.frames[118].offsetMs, engine.duration);
  assert.equal(body.frames[118].offsetMs, 4950);
  for (let i = 1; i < body.frames.length; i++) {
    assert.ok(body.frames[i].offsetMs >= body.frames[i - 1].offsetMs, `offset 在第 ${i} 帧回退`);
  }

  // A window is inclusive on both ends and matches the engine's own range.
  const windowed = await fetch(base + '/api/playback/frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture: 'clean-9600.gps', from: 1, to: 2 }),
  });
  const window = await windowed.json();
  assert.equal(window.from, 1);
  assert.equal(window.to, 2);
  assert.equal(window.count, engine.range(1, 2).frameCount);
  assert.equal(window.frames[0].offsetMs, 1000);
  assert.equal(window.frames[window.frames.length - 1].offsetMs, 2000);
});

test('GET /api/playback/export?from=1&to=2 的字节数与 exportRange 相同', async () => {
  const engine = sampleEngine();
  const expected = engine.exportRange(1, 2);
  const response = await fetch(base + '/api/playback/export?capture=clean-9600.gps&from=1&to=2');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/octet-stream/);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="/);
  assert.equal(response.headers.get('x-playback-frames'), String(engine.range(1, 2).frameCount));

  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.byteLength, expected.byteLength);
  assert.ok(bytes.equals(Buffer.from(expected)), '导出的 SBF 必须与 exportRange 逐字节一致');
  assert.ok(bytes.byteLength > 0);

  // The same range through POST returns the same bytes.
  const posted = await fetch(base + '/api/playback/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture: 'clean-9600.gps', from: 1, to: 2 }),
  });
  assert.equal(posted.status, 200);
  assert.ok(Buffer.from(await posted.arrayBuffer()).equals(bytes));
});

test('POST /api/playback/frame 返回当前帧的报文名与字段', async () => {
  const { response, body } = await getJson('/api/playback/frame?capture=clean-9600.gps&index=1');
  assert.equal(response.status, 200);
  assert.equal(body.index, 1);
  assert.equal(body.total, 119);
  assert.equal(body.frame.messageId, 43);
  assert.equal(body.frame.name, 'RANGE');
  assert.equal(body.layoutKnown, true);
  assert.ok(body.fields.length > 0);
  const field = body.fields.find((item: { path: string }) => item.path === 'obs[0].psr');
  assert.ok(field, 'RANGE 第 1 帧应解出 obs[0].psr');
  assert.equal(typeof field.value, 'number');
});

/* ---------------- graph ---------------- */

test('GET /api/graph/files 列出 12 份实际存在的 CSV', async () => {
  const onDisk = readdirSync(graphCsvDir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  assert.equal(onDisk.length, 12, 'samples/graph/export/csv 下应有 12 份 CSV');

  const { response, body } = await getJson('/api/graph/files');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 12);
  assert.deepEqual(body.files.map((file: { name: string }) => file.name), onDisk);
  assert.equal(body.directory, '逆向/00_来源/samples/graph/export/csv');

  for (const file of body.files) {
    const lines = readFileSync(join(graphCsvDir, file.name), 'utf8')
      .replace(/^\uFEFF/, '').split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'));
    assert.equal(file.rows, lines.length - 1, `${file.name} 的数据行数`);
    assert.equal(file.columns, lines[0].split(',').length, `${file.name} 的列数`);
  }
});

test('GET /api/graph/data 的行数与 golden CSV 一致，并给出可绘制的数值列', async () => {
  for (const name of ['2D Trajectory.csv', 'GNSS Signal Strength.csv', 'Tracking Time.csv', 'Receiver Status.csv']) {
    const lines = readFileSync(join(graphCsvDir, name), 'utf8')
      .replace(/^\uFEFF/, '').split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'));
    const expectedRows = lines.length - 1;

    const { response, body } = await getJson('/api/graph/data?file=' + encodeURIComponent(name));
    assert.equal(response.status, 200, name);
    assert.equal(body.name, name);
    assert.equal(body.rows, expectedRows, `${name} 的行数`);
    assert.equal(body.columns.length, lines[0].split(',').length, `${name} 的列数`);
    assert.equal(body.table.rows.length, Math.min(20, expectedRows), `${name} 的前 20 行`);
    assert.ok(body.table.rows[0].length === body.columns.length, `${name} 表格每行与表头列数一致`);
    assert.ok(body.numericColumns.length > 0, `${name} 应至少有一列数值`);
    assert.ok(body.series.points.length > 0, `${name} 应能画出折线`);
    assert.equal(body.series.points.length, expectedRows, `${name} 每个数据行一个点`);
    assert.ok(String(body.series.label).length > 0);

    // Metadata is read from the `#` block, not invented.
    const start = /^#Start Time\(GPS\):\s*(.+)$/m.exec(readFileSync(join(graphCsvDir, name), 'utf8'));
    assert.equal(body.comments.startTime, start![1].trim());
  }

  // A file whose every column is an enum label has no series to draw, and says so.
  const position = await getJson('/api/graph/data?file=' + encodeURIComponent('Position Status.csv'));
  assert.equal(position.body.rows, 5);
  assert.equal(position.body.numericColumns.length, 0);
  assert.equal(position.body.column, null);
  assert.equal(position.body.series.points.length, 0);
  assert.equal(position.body.table.rows.length, 5);

  // `&column=` picks a different numeric column.
  const picked = await getJson('/api/graph/data?file=' + encodeURIComponent('Position SD.csv') + '&column=' + encodeURIComponent('Height SD'));
  assert.equal(picked.body.column, 'Height SD');
  assert.equal(picked.body.series.points.length, 5);

  // The graph reader is confined to the CSV directory.
  for (const bad of ['../clean.gpf', 'C:\\Windows\\win.ini', 'nope.csv']) {
    const response = await fetch(base + '/api/graph/data?file=' + encodeURIComponent(bad));
    assert.ok(response.status === 400 || response.status === 404, bad);
  }
});


/* ---------------- 原版外观资源（/assets/* 与外壳静态文件） ---------------- */

const viewDir = join(repoRoot, '逆向', '01_解包', 'app', 'view');

/** 不走 URL 规范化：用原始路径发请求，才能测到字面的 `..`。 */
function rawGet(rawPath: string): Promise<number> {
  const target = new URL(base);
  return new Promise((resolveStatus, reject) => {
    const req = request(
      { host: target.hostname, port: Number(target.port), path: rawPath, method: 'GET' },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /assets/ 在默认路径下能取到原版 style.css 与图标', async () => {
  const cssPath = join(viewDir, 'css', 'style.css');
  assert.ok(existsSync(cssPath), '默认资源目录应指向 逆向/01_解包/app/view');

  const css = await fetch(base + '/assets/css/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  const text = await css.text();
  assert.equal(Buffer.byteLength(text, 'utf8'), statSync(cssPath).size, '返回的字节数应与磁盘上的原版文件一致');
  // 顶栏渐变与外壳用到的字体族，证明拿到的是真文件而不是占位
  assert.match(text, /#00ABC8/i);
  assert.match(text, /linear-gradient\(155\.01deg/);
  assert.match(text, /OpenSans-Bold/);

  const icon = await fetch(base + '/assets/images/app_menu.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') ?? '', /image\/svg\+xml/);

  const font = await fetch(base + '/assets/fonts/Roboto-Regular.ttf');
  assert.equal(font.status, 200, '原版 fonts/ 也要能取到');

  // 只开放 images / fonts / css：js、json 这些目录一律 404
  assert.equal((await fetch(base + '/assets/js/jquery.js')).status, 404);
  assert.equal((await fetch(base + '/assets/images/nope.svg')).status, 404);

  // 外壳自己的静态文件
  const shell = await fetch(base + '/shell.css');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type') ?? '', /text\/css/);
  assert.equal((await fetch(base + '/panels/definitely-not-here.js')).status, 404);
});

test('GET /geo/ 把原版 Graph 包变成只含 Luciad 的引擎模块', async () => {
  const bundlePath = join(repoRoot, '逆向', '01_解包', 'Graph', 'out', 'renderer', 'assets', 'index-B86bHcCD.js');
  assert.ok(existsSync(bundlePath), '原版渲染包应能被找到（引擎从 01_解包 现读，不进仓库）');

  const response = await fetch(base + '/geo/luciad-engine.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal(response.headers.get('x-luciad-source'), 'unpacked', '挂载调用应被切掉（source=unpacked）');

  const text = await response.text();
  // 1) 原版 React 应用的挂载语句不在里面 —— 那正是「不跑原版 Graph」的定义
  assert.ok(!text.includes('ReactDOM.createRoot(document.getElementById("root"))'),
    '引擎模块里不应出现原版应用的挂载语句');
  // 2) 引擎本体在（Class 名在打包时保留了）
  assert.ok(text.includes('class RIAMap'), 'RIAMap 应来自原版包本身');
  assert.ok(text.includes('class FeatureLayer'), 'FeatureLayer 应来自原版包本身');
  // 3) 我们追加的导出表在末尾，且只导出 Luciad 的东西
  assert.match(text, /export\s*\{[\s\S]*RIAMap[\s\S]*\};?\s*$/);
  for (const name of ['RIAMap', 'getReference', 'createPolyline', 'createBounds', 'createTransformation',
    'FeatureLayer', 'FeaturePainter', 'MemoryStore']) {
    assert.ok(new RegExp(`export\\s*\\{[\\s\\S]*\\b${name}\\b`).test(text), `应导出 ${name}`);
  }
  assert.ok(!/export\s*\{[^}]*\bReact\b/.test(text), '不应把原版应用的 React 一并导出');
  assert.equal(Number(response.headers.get('x-luciad-bytes')), Buffer.byteLength(text, 'utf8'));

  // 4) stage 文档与脚本也从 /geo/ 出去，并且带自己的 CSP（主页面那条 script-src 不含 wasm）
  const page = await fetch(base + '/geo/luciad-stage.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /wasm-unsafe-eval/, 'stage 必须允许 WebAssembly，否则引擎起不来');
  assert.match(html, /luciad-stage\.js/);

  const stage = await fetch(base + '/geo/luciad-stage.js');
  assert.equal(stage.status, 200);
  assert.match(stage.headers.get('content-type') ?? '', /text\/javascript/);
  const js = await stage.text();
  assert.match(js, /import\('\.\/luciad-engine\.js'\)/, 'stage 动态导入 /geo/ 引擎模块（静态 import 一失败就整块不执行）');
  assert.match(js, /postMessage/, 'stage 只通过 postMessage 与面板说话');

  // 5) /geo/ 没有别的入口
  assert.equal((await fetch(base + '/geo/nope.js')).status, 404);
  assert.equal(await rawGet('/geo/../server.ts'), 400);
});

test('/assets/ 与 /panels/ 的路径穿越一律 400', async () => {
  // 字面的 `..`：Node 的 http 服务器不会替我们规范化 req.url
  assert.equal(await rawGet('/assets/../package.json'), 400);
  assert.equal(await rawGet('/assets/images/../../packages/app/package.json'), 400);
  assert.equal(await rawGet('/panels/../server.ts'), 400);

  // 百分号编码的 `..`：%2e%2e 会被 URL 规范化掉（服务端看到的是塌缩后的路径），
  // %252e%252e 只会被解码一次、落到一个不存在的名字上 —— 两种都读不到任何东西。
  for (const path of [
    '/assets/images/%252e%252e/%252e%252e/%252e%252e/package.json',
    '/assets/%252e%252e/package.json',
    '/panels/%252e%252e/%252e%252e/server.ts',
  ]) {
    const response = await fetch(base + path);
    assert.ok(response.status === 400 || response.status === 404, `${path} → ${response.status}`);
    const body = await response.json();
    assert.equal(body.ok, false);
  }

  // 反斜杠（Windows 语义）也要被挡
  for (const path of [
    '/assets/images/..%5c..%5c..%5cpackage.json',
    '/assets/fonts/..%5c..%5c..%5cpackage.json',
  ]) {
    assert.equal((await fetch(base + path)).status, 400, path);
  }

  // 未开放的子目录不是穿越，但也不能被读到
  assert.equal((await fetch(base + '/assets/model/userStore.js')).status, 404);
});
