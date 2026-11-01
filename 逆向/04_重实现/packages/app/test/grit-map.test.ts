/**
 * GRIT · Map Settings / Terminal / Mitigation Assistant — the three blocks of the manual that
 * `05_GRIT-Monitor.md` listed as missing (5.7 / 5.8 / 5.2.5).
 *
 * Everything here is a **contract** test, because each of the three has one way to go silently
 * wrong:
 *
 *   1. Display — a switch that flips a boolean in the panel but never reaches the shared stage is
 *      indistinguishable from a switch that works, unless the `{type:'chrome'}` message (and the
 *      stage's reading of the five flags) is pinned;
 *   2. Points of Interest — the list is local, so overwriting it, deleting the wrong row or letting
 *      a corrupt `localStorage` block the page are all one keystroke away;
 *   3. Terminal — the old build handed off to Manage. "Opens inside this panel" and "no session
 *      means the server refused the line" are the two behaviours the manual's 5.8 and the
 *      hand-off would both satisfy at a glance, so both are asserted from the source and from the
 *      pure echo helper.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRIT_DISPLAY_FLAGS,
  POI_NOTIFICATIONS,
  gritChromeMessage,
  gritDisplayDefaults,
  gritDisplayFromStored,
  gritDisplayParse,
  gritDisplayToggle,
  gritEventLogs,
  gritPoiAdd,
  gritPoiForm,
  gritPoiMessage,
  gritPoiParse,
  gritPoiRemove,
  gritPoiSetFlag,
  gritTerminalEcho,
  gritTriggerSourceNote,
} from '../src/web/panels/grit.js';
import { STAGE_PROFILES, stageChrome } from '../src/web/geo/luciad-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..', 'src', 'web');
const gritJs = readFileSync(join(webDir, 'panels', 'grit.js'), 'utf8');
const gritCss = readFileSync(join(webDir, 'panels', 'grit.css'), 'utf8');
const stageJs = readFileSync(join(webDir, 'geo', 'luciad-stage.js'), 'utf8');

/* ---------------- 1. Display → chrome ---------------- */

test('Display 开关的五个项就是舞台 chrome 的五个 flag，默认取 GRIT profile', () => {
  const defaults = gritDisplayDefaults();
  assert.deepEqual(defaults, stageChrome('grit'));
  assert.deepEqual(defaults, STAGE_PROFILES.grit);
  assert.deepEqual(
    GRIT_DISPLAY_FLAGS.map((flag) => flag.key),
    ['graticule', 'labels', 'metric', 'scale', 'north'],
  );
  for (const flag of GRIT_DISPLAY_FLAGS) {
    assert.ok(flag.key in STAGE_PROFILES.grit, `${flag.key} 不是舞台认识的 flag`);
    assert.equal(typeof defaults[flag.key], 'boolean');
  }
  // 原版 GRIT 是不带经纬度标注的；开关打开标注时不能顺手把 profile 改回 graph
  assert.equal(defaults.labels, false);
  assert.equal(defaults.graticule, true);
});

test('关一个开关只翻这一个 flag，其余保持，且推出的是 {type:"chrome"}', () => {
  const off = gritDisplayToggle(gritDisplayDefaults(), 'graticule');
  assert.equal(off.graticule, false);
  assert.equal(off.labels, false);
  assert.equal(off.metric, true);
  assert.equal(off.scale, true);
  assert.equal(off.north, true);

  const message = gritChromeMessage(off);
  assert.equal(message.type, 'chrome');
  assert.deepEqual(message.chrome, off);
  // 舞台的 `{type:'chrome'}` 分支保留当前 profile，只覆盖这五个 flag
  assert.match(stageJs, /if \(data\.type === 'chrome'\)/);
  assert.match(stageJs, /setProfile\('', data\.chrome \|\| data\)/);

  // 再翻回来
  assert.deepEqual(gritDisplayToggle(off, 'graticule'), gritDisplayDefaults());
  // 不认识的 key 原样返回，不新增字段
  assert.deepEqual(gritDisplayToggle(off, 'roads'), off);
  assert.equal('roads' in gritDisplayToggle(off, 'roads'), false);
});

test('存下来的 Display 只接受布尔值：脏数据回默认，缺项按 profile 补', () => {
  assert.deepEqual(gritDisplayFromStored(null), gritDisplayDefaults());
  assert.deepEqual(gritDisplayFromStored({ graticule: 'yes', north: 0 }), gritDisplayDefaults());
  assert.deepEqual(
    gritDisplayFromStored({ north: false, bogus: true }),
    { ...gritDisplayDefaults(), north: false },
  );
  // localStorage 里的文本：坏 JSON / 空 / 非对象 都不能让页面挂掉
  assert.deepEqual(gritDisplayParse('{"north":false}'), { ...gritDisplayDefaults(), north: false });
  assert.deepEqual(gritDisplayParse('{oops'), gritDisplayDefaults());
  assert.deepEqual(gritDisplayParse(''), gritDisplayDefaults());
  assert.deepEqual(gritDisplayParse('[1,2,3]'), gritDisplayDefaults());
});

test('舞台把那五个 flag 真的画在不同的东西上', () => {
  // 经纬网 / 网格 / 标注是图层，比例尺与指北针是 HUD
  assert.match(stageJs, /state\.chrome\.graticule \? tickValues/);
  assert.match(stageJs, /state\.chrome\.metric && meterPx >= 36/);
  assert.match(stageJs, /setFeatures\(state\.layers\.labels, state\.chrome\.labels \? labels : \[\]\)/);
  assert.match(stageJs, /if \(!state\.chrome\.scale\) \{\s*SCALE\.hidden = true;/);
  assert.match(stageJs, /NORTH\.hidden = !state\.chrome\.north/);
  // 一个 flag 变了要重画，不能靠下一次地图移动
  assert.match(stageJs, /state\.gridKey = '';\s*\n\s*if \(state\.ready\) refresh\(\);/);
});

/* ---------------- 2. Points of Interest ---------------- */

const POI = {
  name: 'Gate 3',
  lat: 30.53999,
  lon: 114.35283,
  radius: 6,
  notification: 'entry',
};

test('POI 表单按手册的字段校验，默认是 Manual / Show / Active', () => {
  const ok = gritPoiForm(POI);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.poi.name, 'Gate 3');
  assert.equal(ok.ok && ok.poi.radius, 6);
  assert.equal(ok.ok && ok.poi.notification, 'entry');
  assert.equal(ok.ok && ok.poi.visible, true);
  assert.equal(ok.ok && ok.poi.active, true);
  // 手册 5.7.1：界面里加的点，「Triggered by」就是 Manual
  assert.equal(ok.ok && ok.poi.triggeredBy, 'Manual');

  assert.equal(gritPoiForm({ ...POI, name: '   ' }).ok, false);
  assert.equal(gritPoiForm({ ...POI, name: '12345678901234567' }).ok, false, '原版 maxlength=16');
  assert.equal(gritPoiForm({ ...POI, lat: 91 }).ok, false);
  assert.equal(gritPoiForm({ ...POI, lon: -181 }).ok, false);
  assert.equal(gritPoiForm({ ...POI, lat: 'north' }).ok, false);
  assert.equal(gritPoiForm({ ...POI, radius: -1 }).ok, false);
  // 空半径 = 0 m（手册：半径 0 只画点，不画圈）
  const zero = gritPoiForm({ ...POI, radius: '' });
  assert.equal(zero.ok && zero.poi.radius, 0);
  // 认不出的 notification 落到 None，不抛
  const none = gritPoiForm({ ...POI, notification: 'sometimes' });
  assert.equal(none.ok && none.poi.notification, 'none');
  assert.deepEqual(POI_NOTIFICATIONS.map((item) => item.key), ['none', 'entry', 'exit']);
});

test('POI 增删与 Show/Active 只动目标那一行', () => {
  const a = gritPoiForm({ ...POI, name: 'A' }).poi;
  const b = gritPoiForm({ ...POI, name: 'B' }).poi;
  let list = gritPoiAdd([], a, 'id-a');
  list = gritPoiAdd(list, b, 'id-b');
  assert.deepEqual(list.map((poi) => poi.id), ['id-a', 'id-b']);

  const hiddenA = gritPoiSetFlag(list, 'id-a', 'visible');
  assert.equal(hiddenA[0].visible, false);
  assert.equal(hiddenA[1].visible, true);
  // 只允许 Show / Active 两个字段
  assert.deepEqual(gritPoiSetFlag(list, 'id-a', 'name'), list);

  const left = gritPoiRemove(list, 'id-a');
  assert.deepEqual(left.map((poi) => poi.name), ['B']);
  // 删不存在的 id 不改变列表
  assert.deepEqual(gritPoiRemove(left, 'nope'), left);
  assert.deepEqual(gritPoiAdd([], a).length, 1, 'id 可以自动生成');
});

test('存下来的 POI 列表：坏 JSON 与坏行都不会让面板挂掉', () => {
  const stored = JSON.stringify([
    { ...POI, id: 'p1' },
    { name: '', lat: 1, lon: 1, id: 'bad' },
    { name: 'No lat', lon: 1, id: 'bad2' },
    'not an object',
  ]);
  const list = gritPoiParse(stored);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'p1');
  assert.equal(list[0].visible, true);
  assert.equal(gritPoiParse('{oops').length, 0);
  assert.equal(gritPoiParse('{"a":1}').length, 0);
  assert.equal(gritPoiParse('').length, 0);
  // 丢 id 的行补一个确定性的 id，重读两次一致
  const loose = gritPoiParse(JSON.stringify([{ name: 'X', lat: 1, lon: 2, radius: 3 }]));
  assert.equal(loose.length, 1);
  assert.equal(loose[0].id, gritPoiParse(JSON.stringify([{ name: 'X', lat: 1, lon: 2, radius: 3 }]))[0].id);
});

test('POI 图层消息：坐标、半径、显示与激活一起下去', () => {
  const list = gritPoiAdd([], POI, 'p1');
  const message = gritPoiMessage(list);
  assert.equal(message.type, 'pois');
  assert.deepEqual(message.pois, [
    {
      id: 'p1',
      name: 'Gate 3',
      lon: 114.35283,
      lat: 30.53999,
      radiusM: 6,
      visible: true,
      active: true,
    },
  ]);
  assert.deepEqual(gritPoiMessage(null), { type: 'pois', pois: [] });
  // 舞台建了照片图层，并按半径画圈（手册 5.7.1 的圆）
  assert.match(stageJs, /state\.layers\.pois = addLayer\('pois'/);
  assert.match(stageJs, /state\.layers\.poiLabels = addLayer\('poi-labels'/);
  assert.match(stageJs, /ringPolyline\(poi\.lon, poi\.lat, poi\.radiusM\)/);
  assert.match(stageJs, /if \(!poi\.visible\) continue;/);
});

/* ---------------- 3. Triggers ---------------- */

test('触发器的“事件源”只认 MARKxPOS / MARKxTIME，且从 /api/logs 的 groups 里读', () => {
  const groups = [
    { id: 42, name: 'BESTPOS', count: 62 },
    { id: 1007, name: 'MARK1POS', count: 1, firstUtc: '2026-11-01T08:00:00Z' },
    { id: 1008, name: 'MARK2POS', count: 2 },
    { id: 1009, name: 'MARK3POSX', count: 9 },
    { id: 1010, name: 'MARKTIME', count: 1 },
    { id: 1011, name: 'MARK1TIME', count: 1 },
  ];
  const logs = gritEventLogs(groups);
  assert.deepEqual(
    logs.map((log) => [log.name, log.count]),
    [['MARK1POS', 1], ['MARK2POS', 2], ['MARKTIME', 1], ['MARK1TIME', 1]],
  );
  assert.equal(logs[0].firstUtc, '2026-11-01T08:00:00Z');
  // 样本里的真实名字（b2 的 MARKPOS、b4 的 MARK1TIME）也要认
  assert.equal(gritEventLogs([{ name: 'MARKPOS', count: 31 }])[0].name, 'MARKPOS');
  assert.deepEqual(gritEventLogs(null), []);
});

test('触发器列表为空时，说明写的是“为什么没有”，三种状态各不相同', () => {
  const none = gritTriggerSourceNote({ eventLogs: [], live: false, capture: 'clean-9600.gps' });
  assert.match(none, /没有事件源/);
  assert.match(none, /MARKxPOS/);
  assert.match(none, /clean-9600\.gps/);
  assert.match(none, /列表为空/);

  const marks = gritTriggerSourceNote({
    eventLogs: [{ name: 'MARK1POS', count: 1 }],
    live: false,
    capture: 'b2-20261101.sbf',
  });
  assert.match(marks, /b2-20261101\.sbf/);
  assert.match(marks, /MARK1POS ×1/);
  assert.match(marks, /列表为空/);

  const live = gritTriggerSourceNote({ eventLogs: [], live: true });
  assert.match(live, /实时会话/);
  assert.match(live, /不订阅 MARKxPOS/);

  // 面板用同一个函数写这一段，而不是自己拼字符串
  assert.match(gritJs, /gritTriggerSourceNote\(\{/);
  assert.match(gritJs, /out\.eventLogs = gritEventLogs\(types\)/);
});

/* ---------------- 4. Terminal ---------------- */

test('终端没有会话时如实报“未发送”，不打印假回显', () => {
  const lines = gritTerminalEcho('VERSIONB', { connected: false, lastError: 'not connected' });
  assert.equal(lines[0], '> VERSIONB');
  assert.match(lines[1], /未发送/);
  assert.match(lines[1], /not connected/);
  assert.equal(lines.length, 2);

  const sent = gritTerminalEcho('LOG COM1 BESTPOSB ONTIME 1', {
    connected: true,
    lastError: null,
    commands: [{ line: 'LOG COM1 BESTPOSB ONTIME 1', status: 'pending', ok: true }],
  });
  assert.equal(sent[0], '> LOG COM1 BESTPOSB ONTIME 1');
  assert.match(sent[1], /已发送/);
  assert.ok(!/未发送/.test(sent[1]));

  const failed = gritTerminalEcho('X', {
    connected: true,
    lastError: 'serial port closed',
    commands: [],
  });
  assert.match(failed[1], /发送失败/);
  assert.match(failed[1], /serial port closed/);
});

test('Terminal 在 GRIT 面板内打开，不再把手放开到 Manage', () => {
  // 旧行为：点 Tools ▸ Terminal 切换页签。现在这段代码必须已经删掉。
  assert.ok(!gritJs.includes('data-tab="manage"'), 'Terminal 还在切到 Manage');
  assert.ok(!/Switched to Manage/.test(gritJs), 'Terminal 还在提示“已切到 Manage”');
  // 抽屉是本面板的一部分，走同一个端点与同一个服务端会话
  assert.match(gritJs, /data-el="term"/);
  assert.match(gritJs, /api\.post\('\/api\/live\/command'/);
  assert.match(gritJs, /api\.get\('\/api\/live\/logs'/);
  assert.match(gritJs, /gritTerminalEcho\(line, status\)/);
  assert.match(gritJs, /act === 'terminal'[\s\S]{0,80}openTerminal\(\)/);
  // 回显来自本面板已经在跑的那个轮询，不另开连接
  assert.match(gritJs, /if \(term\.open\) \{[\s\S]{0,200}termAppend/);
  assert.match(gritCss, /\.grit-term\s*\{[^}]*position: fixed/);
  assert.match(gritCss, /\.grit-term-out\s*\{/);
});

/* ---------------- 5. Map Settings 的骨架与数据来源声明 ---------------- */

test('Settings ▸ Map 打开三块，POI 那一块写明是本地列表', () => {
  // 菜单项真的接到 openMapSheet，占位文案已经不存在
  assert.match(gritJs, /act === 'map'[\s\S]{0,80}openMapSheet\('poi'\)/);
  assert.ok(!gritJs.includes('No basemap renderer ships here'));
  assert.ok(!/map: 'Map settings configure the basemap/.test(gritJs));

  // 三段页签与三块面板
  for (const key of ['poi', 'triggers', 'display']) {
    assert.match(gritJs, new RegExp(`data-map-tab="${key}"`));
    assert.match(gritJs, new RegExp(`data-map-panel="${key}"`));
  }
  // 数据来源：POI 是本地列表（localStorage），不是接收机
  assert.match(gritJs, /nas\.grit\.map\.poi\.v1/);
  assert.match(gritJs, /POI 为本地列表，不来自接收机/);
  // Display 段点名它改的是舞台的 chrome 参数
  assert.match(gritJs, /type:'chrome'/);
  assert.match(gritCss, /\.grit-sheet\s*\{[^}]*position: fixed/);
  assert.match(gritCss, /\.grit-disp-toggle\.is-on/);
});

test('Mitigation Assistant 的交互按手册补齐：展开/收起、两种状态、需要 ITK', () => {
  assert.match(gritJs, /data-el="mitToggle"/);
  assert.match(gritJs, /data-el="mitDetails"/);
  assert.match(gritJs, /aria-expanded/);
  // 值仍然是原版的 Not detected —— 没有 ITK 就没有条目，也不编数字
  assert.match(gritJs, /setText\(root, 'mitigation', 'Not detected'\)/);
  // 两种状态、Interference details 的操作、Add filter 的不可用，以及“需要 ITK”
  assert.match(gritJs, /Interference details/);
  assert.match(gritJs, /Add filter/);
  assert.match(gritJs, /需要 ITK 报文/);
  assert.match(gritCss, /\.grit-mitigation-details\[hidden\]/);
  assert.match(gritCss, /\.grit-mitigation-toggle\.is-open/);
});
