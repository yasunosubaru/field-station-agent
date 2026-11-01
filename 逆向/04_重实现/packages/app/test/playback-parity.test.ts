/**
 * Playback · 手册第 3 章逐条对齐 —— 只钉那些「静默错也不会报错」的地方。
 *
 *   1. **Recent Playback Activity（§3.1）** —— 最近打开过的文件怎么记、记几条、格子里的
 *      Start / End / Duration / Last Viewed 各是什么格式（原版 `playback.js:236` `msToTimeString`）；
 *   2. **Files bar（§3.2.1）** —— 一个文件一个页签、正在看的那一个是亮的、✕ 只关掉自己、
 *      关掉当前页签后轮到谁；
 *   3. **Playback controls（§3.2.4）** —— 倍速档位必须等于原版 `playbackcontrol.html:79-83`
 *      的 1 / 2 / 5 / 10 / 20（`/api/playback/info` 报的是引擎自己的 0.5/1/2/4/8，页面不用它）；
 *   4. **Summary bar / Status tiles（§3.2.2 / §3.2.3）** —— 绿 Good / 琥珀 Warning / 红 Error /
 *      灰 Off 的判定，逐条照 `positionStatus.js:294-397` 与 `deviceInfo.js:10-130, 376-407`。
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playbackInfo } from '../src/playback.ts';
import { resolveCapture } from '../src/paths.ts';
import {
  BAD_SOLUTIONS,
  CONFIG_MODE_ORDER,
  PLAYBACK_SPEEDS,
  RECENT_LIMIT,
  REWIND_SECONDS,
  USAGE_LIMITS,
  configuredModeKey,
  deviceTone,
  durationText,
  fileTabsHtml,
  forgetRecent,
  limitTone,
  nextActiveAfterClose,
  positionTone,
  pushRecent,
  recentFromInfo,
  recentTileHtml,
  speedOptionsHtml,
  usageTone,
  viewedText,
  worstTone,
} from '../src/web/panels/playback.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..', 'src', 'web');
const panelJs = readFileSync(join(webDir, 'panels', 'playback.js'), 'utf8');
const panelCss = readFileSync(join(webDir, 'panels', 'playback.css'), 'utf8');

/* ---------------- 0. 常量：原版的号码，不是我们自己编的 ---------------- */

test('倍速档位 = 原版 Speed 菜单的 1x / 2x / 5x / 10x / 20x', () => {
  assert.deepEqual(PLAYBACK_SPEEDS, [1, 2, 5, 10, 20]);
  /* 原版 `playbackcontrol.html:79-83` 的五个 `<li>`，`playbackview.js:116` 把文本
   * `parseInt` 之后交给 `setSpeedRatio`。 */
  assert.match(panelJs, /playbackcontrol\.html:79-83/);
});

test('Speed 下拉的选项文本与 value 一一对应，默认 1x', () => {
  const html = speedOptionsHtml(1);
  assert.match(html, /<option value="1" selected>1x<\/option>/);
  assert.deepEqual([...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1])), [1, 2, 5, 10, 20]);
  // 4x / 8x / 0.5x 是引擎自己的档位，不能出现在菜单里
  for (const wrong of ['0.5', '4', '8']) {
    assert.ok(!html.includes(`value="${wrong}"`), `不应出现 ${wrong}x`);
  }
  // 传进来的值不在表里时退回 1x，绝不把非法倍速写进 select
  const fallback = speedOptionsHtml(3);
  assert.equal((fallback.match(/selected/g) ?? []).length, 1);
  assert.match(fallback, /<option value="1" selected>1x<\/option>/);
});

test('后退 30 秒、最近列表上限与原版一致', () => {
  assert.equal(REWIND_SECONDS, 30); // playbackview.js:435 rewind(30*1000, tab)
  assert.equal(RECENT_LIMIT, 12);
});

/* ---------------- 1. Recent Playback Activity（§3.1） ---------------- */

const info = {
  capture: 'convert/clean-9600.gps',
  bytes: 270864,
  frameCount: 119,
  durationMs: 4950,
  startUtc: '2026-11-01T08:38:17.350Z',
  finishUtc: '2026-11-01T08:38:22.300Z',
};

test('最近文件：从 /api/playback/info 取到的字段够填一格', () => {
  const entry = recentFromInfo(info, 1_700_000_000_000);
  assert.equal(entry.path, 'convert/clean-9600.gps');
  assert.equal(entry.name, 'clean-9600.gps');
  assert.equal(entry.durationMs, 4950);
  assert.equal(entry.startUtc, '2026-11-01T08:38:17.350Z');
  assert.equal(entry.endUtc, '2026-11-01T08:38:22.300Z');
  assert.equal(entry.viewedAt, 1_700_000_000_000);
});

test('最近文件：同一个文件只留一条，新的在前，超过上限截尾', () => {
  let list = [];
  list = pushRecent(list, recentFromInfo(info, 1000));
  assert.equal(list.length, 1);

  // 再打开同一份：不重复，时间戳更新
  list = pushRecent(list, recentFromInfo(info, 2000));
  assert.equal(list.length, 1);
  assert.equal(list[0].viewedAt, 2000);

  // 另一份文件排到最前
  list = pushRecent(list, recentFromInfo({ ...info, capture: 'live-20261031/b1-20261101.sbf' }, 3000));
  assert.deepEqual(list.map((item) => item.path), ['live-20261031/b1-20261101.sbf', 'convert/clean-9600.gps']);

  // 上限
  let many = [];
  for (let i = 0; i < RECENT_LIMIT + 5; i++) {
    many = pushRecent(many, recentFromInfo({ ...info, capture: `convert/f${i}.gps` }, 1000 + i));
  }
  assert.equal(many.length, RECENT_LIMIT);
  assert.equal(many[0].path, `convert/f${RECENT_LIMIT + 4}.gps`); // newest first

  // 传空 / 坏数据不炸
  assert.deepEqual(pushRecent(null, null), []);
  assert.deepEqual(pushRecent([{ path: 'a' }], { name: 'no path' }).map((i) => i.path), ['a']);
});

test('最近文件：✕ 之后只剩别的条目，列表本身不被改动', () => {
  const list = [recentFromInfo(info, 1), recentFromInfo({ ...info, capture: 'x/y.sbf' }, 2)];
  const kept = forgetRecent(list, 'convert/clean-9600.gps');
  assert.deepEqual(kept.map((item) => item.path), ['x/y.sbf']);
  assert.equal(list.length, 2, 'forgetRecent 不就地改数组');
});

test('Duration 文案 = 原版 msToTimeString(ms, true)', () => {
  assert.equal(durationText(4950), '0mins 4secs');
  assert.equal(durationText(28_079), '0mins 28secs');
  assert.equal(durationText(3_723_000), '1hrs 2mins 3secs');
  assert.equal(durationText(0), '0mins 0secs');
  assert.equal(durationText(NaN), '0mins 0secs');
});

test('Last Viewed 文案是 UTC 的 YYYY-MM-DD HH:MM', () => {
  assert.equal(viewedText(Date.UTC(2026, 10, 1, 9, 36, 12)), '2026-11-01 09:36');
  assert.equal(viewedText(0), '--');
  assert.equal(viewedText(undefined), '--');
});

test('最近文件的一格：图标 + 名字 + Start/End/Duration + Last Viewed + ✕', () => {
  const html = recentTileHtml(recentFromInfo(info, Date.UTC(2026, 10, 1, 9, 36)));
  assert.match(html, /class="pb-recent-img"/); // 原版 .recent-pb-img，手册的「文件图标」
  assert.match(html, /class="pb-recent-name">clean-9600\.gps</);
  assert.match(html, /Start<\/span><span class="pb-recent-value">08:38:17</);
  assert.match(html, /End<\/span><span class="pb-recent-value">08:38:22</);
  assert.match(html, /Duration<\/span><span class="pb-recent-value">0mins 4secs</);
  assert.match(html, /Last Viewed 2026-11-01 09:36/);
  assert.match(html, /data-role="open-recent"/);
  assert.match(html, /data-path="convert\/clean-9600\.gps"/);
  assert.match(html, /data-role="forget-recent"/);
  // 名字来自路径的最后一段，路径本身进 title
  assert.match(html, /title="convert\/clean-9600\.gps"/);
  assert.equal(recentTileHtml(null), '');
});

test('空态：Recent Activity 标题 + Open Playback File + 「No recent activity.」', () => {
  assert.match(panelJs, />Recent Activity</);
  assert.match(panelJs, /data-el="open">Open Playback File</);
  assert.match(panelJs, /No recent activity\./); // 原版 NO_RECENT_ACTIVITY
  assert.match(panelCss, /\.pb-recent-img[\s\S]{0,200}new_playbackicon\.png/);
});

/* ---------------- 2. Files bar（§3.2.1） ---------------- */

const files = [
  { path: 'convert/clean-9600.gps', name: 'clean-9600.gps' },
  { path: 'live-20261031/b1-20261101.sbf', name: 'b1-20261101.sbf' },
];

test('Files bar：每个文件一个页签，正在看的那一个是亮的', () => {
  const html = fileTabsHtml(files, 1);
  assert.equal((html.match(/data-role="activate-file"/g) ?? []).length, 2);
  assert.equal((html.match(/data-role="close-file"/g) ?? []).length, 2);
  assert.match(html, /class="pb-filetab is-active" role="tab" aria-selected="true" data-role="activate-file" data-index="1"/);
  assert.match(html, /class="pb-filetab" role="tab" aria-selected="false" data-role="activate-file" data-index="0"/);
  // 名字与 path 都在，关闭按钮带 aria-label
  assert.match(html, /pb-filetab-name">clean-9600\.gps</);
  assert.match(html, /aria-label="Close b1-20261101\.sbf"/);
  // 再开一个的入口
  assert.match(html, /data-el="openMore"/);
});

test('Files bar：另一个文件在看的，点它就是切换（状态不丢）', () => {
  /* `activate()` 只换 state.active 后整块重画；每份文件的 time/frames/epochs 都挂在自己的
   * 记录上（`makeFile`），所以切回来时播放头还在原处。这里钉住「记录按文件分开」这件事。 */
  assert.match(panelJs, /files: \[\],/);
  assert.match(panelJs, /function makeFile\(path\)/);
  for (const field of ['time: 0', 'frames: []', 'epochs: new Map()', 'position: null', 'device: null']) {
    assert.ok(panelJs.includes(field), `每份文件的记录里应有 ${field}`);
  }
  // 切换时先停表，避免两份文件一起走时钟
  assert.match(panelJs, /if \(state\.active !== index\) \{\s*\n\s*stop\(\);\s*\n\s*state\.active = index;/);
});

test('Files bar：✕ 只关掉自己，关掉当前页签后轮到右邻', () => {
  // (count, active, closing) → 新下标
  assert.equal(nextActiveAfterClose(3, 2, 2), 1); // 关掉最后一个 → 左邻
  assert.equal(nextActiveAfterClose(3, 2, 1), 1); // 关掉中间、在看最后一个 → 现在的下标要减一
  assert.equal(nextActiveAfterClose(3, 0, 2), 0); // 关掉别的 → 不动
  assert.equal(nextActiveAfterClose(3, 1, 1), 1); // 关掉自己 → 右邻顶上来
  assert.equal(nextActiveAfterClose(2, 0, 0), 0);
  assert.equal(nextActiveAfterClose(1, 0, 0), -1); // 关完回到 Recent Activity
  assert.equal(nextActiveAfterClose(0, -1, 0), -1);
});

test('Files bar 的页签挂在应用栏里，切页/卸载时收回', () => {
  assert.match(panelJs, /document\.getElementById\('tabs-list'\)/);
  assert.match(panelJs, /fileTabs\.remove\(\)/);
  assert.match(panelCss, /#tabs-list li\.pb-filetabs \.pb-filetab\.is-active/);
});

/* ---------------- 3. Playback controls（§3.2.4） ---------------- */

test('播放 / 暂停 / 重放 / 后退 30 秒都在，且都按当前文件走', () => {
  assert.match(panelJs, /class="pb-rewind" type="button" data-el="rewind" aria-label="Back 30 seconds"/);
  assert.match(panelJs, /class="pb-play" type="button" data-el="play" aria-label="Play"/);
  // 走到末尾 → 同一个按钮变成 Replay（原版 `.playControl.replay`）
  assert.match(panelJs, /setAttribute\('aria-label', state\.playing \? 'Pause' : ended \? 'Replay' : 'Play'\)/);
  assert.match(panelCss, /\.pb-play\.is-ended:not\(\.is-playing\)/);
  // 后退的量就是 30 s，并且钳到 0（setTime 里 Math.max(..., 0)）
  assert.match(panelJs, /setTime\(file\.time - REWIND_SECONDS\)/);
  assert.match(panelJs, /file\.time = Math\.min\(Math\.max\(seconds, 0\), file\.duration\)/);
});

test('倍速真的进了播放循环：步长 = Δt × speed', () => {
  assert.match(panelJs, /setTime\(file\.time \+ \(delta \* state\.speed\) \/ 1000\)/);
  assert.match(panelJs, /state\.speed = PLAYBACK_SPEEDS\.includes\(value\) \? value : PLAYBACK_SPEEDS\[0\]/);
});

test('时间轴：拖动 / ←→ 步进 / Home End / 空格 都在', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(panelJs.includes(`event.key === '${key}'`), `缺少键盘 ${key}`);
  }
  assert.match(panelJs, /const step = event\.shiftKey \? 1 : 0\.1/);
  assert.match(panelJs, /role="slider"/);
});

/* ---------------- 4. Summary bar / Status tiles 三色 ---------------- */

test('HWMONITOR 边界值 → 绿/琥珀/红/灰（HwMonitorStatusBoundaryLimitStatus）', () => {
  assert.equal(limitTone(0), 'good'); // acceptable bounds
  assert.equal(limitTone(1), 'warn'); // lower warning
  assert.equal(limitTone(3), 'warn'); // upper warning
  assert.equal(limitTone(2), 'bad'); // lower error
  assert.equal(limitTone(4), 'bad'); // upper error
  assert.equal(limitTone(undefined), 'off');
});

test('CPU / Storage 用量阈值 80 / 90 与 deviceInfo.js 一致', () => {
  assert.deepEqual(USAGE_LIMITS, { lower: 80, upper: 90 });
  assert.equal(usageTone(29), 'good');
  assert.equal(usageTone(80), 'good');
  assert.equal(usageTone(81), 'warn');
  assert.equal(usageTone(90), 'warn');
  assert.equal(usageTone(91), 'bad');
  assert.equal(usageTone(undefined), 'off');
});

test('worstTone：红 > 琥珀 > 绿 > 灰', () => {
  assert.equal(worstTone(['good', 'warn', 'bad']), 'bad');
  assert.equal(worstTone(['good', 'warn']), 'warn');
  assert.equal(worstTone(['good', 'off']), 'good');
  assert.equal(worstTone(['off', 'off']), 'off');
  assert.equal(worstTone([]), 'off');
});

test('Positioning 指示灯：四个「没有解」的状态是红的', () => {
  assert.deepEqual(BAD_SOLUTIONS, ['INSUFFICIENT_OBS', 'NO_CONVERGENCE', 'INVALID_FIX', 'INTEGRITY_WARNING']);
  for (const status of BAD_SOLUTIONS) {
    assert.equal(positionTone({ solutionStatus: status, positionType: 'SINGLE' }), 'bad', status);
  }
  assert.equal(positionTone({ solutionStatus: 'SOL_COMPUTED', positionType: 'SINGLE' }), 'good');
  assert.equal(positionTone({}), 'off');
  assert.equal(positionTone({ solutionStatus: 'SOL_COMPUTED' }), 'good');
});

test('Positioning 指示灯：配了高精度模式却没在用 → 琥珀（positionStatus.js:376-397）', () => {
  assert.deepEqual(CONFIG_MODE_ORDER, ['RTK', 'PPP', 'PSRDIFF', 'SBAS']);
  // 配了 RTK ROVER，实际只有 single → 琥珀
  assert.equal(
    positionTone({ solutionStatus: 'SOL_COMPUTED', positionType: 'SINGLE', configuredModes: ['RTK ROVER'], activeMode: 'single' }),
    'warn',
  );
  // 配置的 RTK 与在用的 rtk 对上 → 绿
  assert.equal(
    positionTone({ solutionStatus: 'SOL_COMPUTED', positionType: 'NARROW_INT', configuredModes: ['RTK ROVER'], activeMode: 'rtk' }),
    'good',
  );
  // 在用 RTK，但解是 float → 琥珀
  assert.equal(
    positionTone({ solutionStatus: 'SOL_COMPUTED', positionType: 'NARROW_FLOAT', configuredModes: ['RTK ROVER'], activeMode: 'rtk' }),
    'warn',
  );
  // 原版特例：只配 PSRDIFF ROVER 时是绿的
  assert.equal(
    positionTone({ solutionStatus: 'SOL_COMPUTED', positionType: 'PSRDIFF', configuredModes: ['PSRDIFF ROVER'], activeMode: 'dgps' }),
    'good',
  );
  // 模式名的归一：NTRIP → RTK，BASE/ROVER 去掉
  assert.equal(configuredModeKey('NTRIP CLIENT'), 'RTK');
  assert.equal(configuredModeKey('RTK ROVER'), 'RTK');
  assert.equal(configuredModeKey('PSRDIFF BASE'), 'PSRDIFF');
});

test('Device 指示灯：任一通道过限就压过其余；有字段没取到就是琥珀而不是绿', () => {
  const good = { limit: 0 };
  assert.equal(deviceTone({ rows: [good, good, good], unknown: 0 }), 'good');
  assert.equal(deviceTone({ rows: [good, { limit: 3 }], unknown: 0 }), 'warn');
  assert.equal(deviceTone({ rows: [good, { limit: 4 }], unknown: 3 }), 'bad');
  // 手册 §3.2.2：Amber = 功能正常但有需要关注的地方 —— 缺字段属于这一类，不涂成 Good
  assert.equal(deviceTone({ rows: [good, good], unknown: 2 }), 'warn');
  // 一个读数都没有 → 灰 Off（「功能被禁用或尚未配置」，§3.2.3）
  assert.equal(deviceTone({ rows: [], unknown: 0 }), 'off');
  assert.equal(deviceTone({ rows: [{ limit: undefined }], unknown: 0 }), 'off');
});

test('三色都落到 DOM：徽标类名、灰 Off、以及「点状态条跳到对应卡片」', () => {
  for (const tone of ['good', 'warn', 'bad', 'off']) {
    assert.ok(panelCss.includes(`.pb-badge-${tone}`), `缺少 .pb-badge-${tone}`);
  }
  assert.match(panelCss, /\.pb-badge-off[\s\S]{0,120}#ababab/); // S:19868 grey-status
  assert.match(panelJs, /const labels = \{ good: 'Good', warn: 'Warning', bad: 'Error', off: 'Off'/);
  // 手册 §3.2.2：琥珀/红条会出现在出问题的那块 tile 上 → 点状态条能找到它
  assert.match(panelJs, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  assert.match(panelJs, /data-tile="device"/);
  assert.match(panelJs, /data-tile="positioning"/);
});

test('Summary bar 的字段都来自真实报文（没有的就是 --）', () => {
  // 手册 3.2.2 列出的字段
  for (const el of [
    'bandPosition', 'bandLat', 'bandLon', 'bandHeight', 'bandSpan',
    'devModel', 'devCpu', 'devLogging', 'devTime', 'devInterference', 'devStorage',
  ]) {
    assert.ok(panelJs.includes(`data-el="${el}"`) || panelJs.includes(`'${el}'`), `缺少字段 ${el}`);
  }
  // Model = VERSION(#37) hardware_version（原版 #statusBarhardwareVersion，statusbar.js:141）
  assert.match(panelJs, /versions\[0\]\.hardware_version/);
  // Interference = ITDETECTSTATUS(#2065) severity 非零即 Detected（statusbar.js:144-173）
  assert.ok(panelJs.includes('interference_statuses'), '应按 interference_statuses[i].severity 取干扰');
  assert.ok(panelJs.includes('.severity'));
  // 取不到的字段必须带「需要哪条报文」的说明，不能凭空编
  assert.match(panelJs, /Storage Usage needs FILESYSTEMCAPACITY \(#2137\)/);
  assert.match(panelJs, /SPAN needs INSPVAX \(#1465\)/);
});

/* ---------------- 5. 抓包侧事实：这三条短信只出现在 b1 里 ---------------- */

test('b1-20261101.sbf 带 VERSION / ITDETECTSTATUS，clean-9600.gps 不带', () => {
  const b1 = playbackInfo(resolveCapture('live-20261031/b1-20261101.sbf'));
  const ids = new Set(b1.messageCounts.map((item) => item.id));
  assert.ok(ids.has(37), 'b1 应有 VERSION #37');
  assert.ok(ids.has(2065), 'b1 应有 ITDETECTSTATUS #2065');
  assert.ok(ids.has(1043), 'b1 应有 SATVIS2 #1043');
  assert.ok(!ids.has(1465), 'b1 没有 INSPVAX #1465 —— SPAN 因此是 --');

  const clean = playbackInfo(resolveCapture('convert/clean-9600.gps'));
  const cleanIds = new Set(clean.messageCounts.map((item) => item.id));
  assert.ok(!cleanIds.has(37));
  assert.ok(!cleanIds.has(2065));
  // 两份抓包的时长/帧数（页面上的 Start/End/Duration 就取这两个）
  assert.equal(clean.durationMs, 4950);
  assert.equal(b1.durationMs, 28079);
});
