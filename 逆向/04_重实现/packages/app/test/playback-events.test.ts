/**
 * Playback · D1 —— 事件条（`pb-events` / `.show-events`）。
 *
 * 原版把**接收机事件**画在进度条下面的一条独立带子上（`playbackcontrol.html:23`
 * `.playback-events`），由 `controller/playback.js:991-1071` `markEvents()` 逐个事件 append：
 *
 *     element.className = state + "Event";                 // PoorEvent 红 / ModerateEvent 琥珀
 *     element.setAttribute("data-message", description);   // data-lang-… 键
 *     element.setAttribute("data-event-freq", freqValue);  // 只有 ITK 事件有频率
 *     element.setAttribute("time", getUTCTimeFormatOnly(start));  // HH:MM:SS UTC
 *     element.style.left = "calc(" + per*100 + "% - 17px)";       // per = (start - startTime)/total
 *
 * 点击只开/关 tooltip，**不动播放头**（`playbackview.js:194-253` 里没有 `onProgressbarSeek`）；
 * `Show Events` 开关只切整条带子的 `display`（`playbackview.js:122-135`）。
 *
 * 这里钉的是「静默错也不会报错」的四处：
 *
 *   1. b7 抓包的事件提取（47 条 ITDETECTSTATUS → 3 个事件，含同频率重新出现）；
 *   2. 没有事件源时是空态，不是空白天；
 *   3. 标记数量与位置（`eventMarkers`）；
 *   4. 点击标记的时间语义（只选中，不 seek）。
 *
 *   node --test --test-force-exit "packages/app/test/playback-events.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playbackEvents } from '../src/playback.ts';
import { resolveCapture } from '../src/paths.ts';
import {
  SHOW_EVENTS_KEY,
  eventMarkers,
  eventTooltipText,
  eventsEmptyNote,
  nextEventSelection,
  showEventsFromStore,
} from '../src/web/panels/playback.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..', 'src');
const panelJs = readFileSync(join(srcDir, 'web', 'panels', 'playback.js'), 'utf8');
const panelCss = readFileSync(join(srcDir, 'web', 'panels', 'playback.css'), 'utf8');
const serverTs = readFileSync(join(srcDir, 'server.ts'), 'utf8');

const B7 = 'live-20261031/b7-20261101.sbf';
const B1 = 'live-20261031/b1-20261101.sbf';

/* ---------------- 1. 事件提取：b7 的 ITK ---------------- */

test('b7：47 条 ITDETECTSTATUS 只出 3 个事件，时间都落在时间轴内', () => {
  const payload = playbackEvents(resolveCapture(B7));

  // 47 条记录里 25 条 STATISTICANALYSIS（统计量，不是频率）和 9 条空记录都不算事件；只有 13 条
  // SPECTRUMANALYSIS 参与状态机，其中 3 次是「新出现」——1269/1270 反复切换，1270 最后又回来。
  assert.equal(payload.sources.itk, 47);
  assert.equal(payload.count, 3);
  assert.equal(payload.events.length, 3);
  assert.equal(payload.outside, 0);
  assert.equal(payload.durationMs, 61717);

  const [first, second, third] = payload.events;
  // 时间轴起点 2443/35942.303；三条记录分别是 35961 / 35967 / 36002。
  assert.deepEqual(
    payload.events.map((event) => event.time),
    [18.697, 24.697, 59.697],
  );
  assert.deepEqual(
    payload.events.map((event) => event.frequency),
    [1270, 1269, 1270],
  );
  // 结束时间也来自记录：1270 在 35967 消失，1269 在 35973 消失，最后一个 1270 到结束还在。
  assert.deepEqual(
    payload.events.map((event) => event.endTime),
    [24.697, 30.697, null],
  );

  // 时间换算按 suite 自己的「无闰秒」缺陷（gpsAsUtc），514 秒的 UTC 就是这个。
  assert.equal(first.utc, '2026-11-01T09:59:21.000Z');
  assert.equal(first.severity, 'Moderate'); // events.js:1525 createEventInHandlerObject("Moderate", …)
  assert.equal(first.kind, 'itk');
  assert.equal(first.description, 'data-lang-itk-detected-at');
  // 原版 tooltip 的句子：en.js:1389 "Interference is being detected at %1Mhz."
  assert.equal(first.detail, 'Interference is being detected at 1270Mhz.');
  assert.equal(first.source, 'ITDETECTSTATUS (#2065)');
  assert.equal(second.detail, 'Interference is being detected at 1269Mhz.');
  assert.equal(third.endTime, null);
});

test('b7：同一个 (kind, 频率, 时间) 只留一个标记，且不把带宽枚举当成频率', () => {
  const payload = playbackEvents(resolveCapture(B7));
  const seen = new Set();
  for (const event of payload.events) {
    const key = `${event.kind}|${event.frequency ?? ''}|${event.time.toFixed(3)}`;
    assert.ok(!seen.has(key), `重复标记：${key}`);
    seen.add(key);
    // `frequency` 字段是带宽枚举（L2），真正的中心频率是 parameter1；混进来就是假的 7/8 MHz 事件。
    assert.ok(event.frequency >= 1200 && event.frequency <= 1300, `频率不像 L 波段：${event.frequency}`);
  }
  // 若把 STATISTICANALYSIS 的 parameter1（6.8 / 7.3 这类统计量）当成频率，事件会多出十几个。
  assert.equal(payload.count, 3);
  assert.ok(!payload.events.some((event) => event.frequency < 100));
});

/* ---------------- 2. 无事件：空态 ---------------- */

test('b1 有 6 条 ITDETECTSTATUS 但全是统计检测，事件条是空的', () => {
  const payload = playbackEvents(resolveCapture(B1));
  assert.equal(payload.sources.itk, 6);
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.events, []);
});

test('clean-9600.gps 完全没有事件源：不是伪造 0 条，而是三条日志都读过、都是 0', () => {
  const payload = playbackEvents(resolveCapture('convert/clean-9600.gps'));
  assert.equal(payload.sources.itk, 0);
  assert.equal(payload.sources.rxstatusevent, 0);
  assert.equal(payload.count, 0);
  // 93 有记录，但没有一个带 `spoofing` 字段（layout 只有 rx_error / status_words），所以也不会凭空出事件。
  assert.equal(payload.events.filter((event) => event.kind === 'spoofing').length, 0);
});

test('空态文案：没读到事件记录 vs 读到了但都不到告警级，说的是两件事', () => {
  const nothing = eventsEmptyNote({ itk: 0, spoofing: 0, rxstatusevent: 0 });
  assert.match(nothing, /No events in this capture/);
  assert.match(nothing, /ITDETECTSTATUS \(#2065\)/); // 空态要点名缺哪三条日志
  assert.match(nothing, /RXSTATUSEVENT \(#94\)/);

  const readButClean = eventsEmptyNote({ itk: 6, spoofing: 5, rxstatusevent: 0 });
  assert.match(readButClean, /11 event records read/);
  assert.match(readButClean, /none above Good/);

  // 单数也要对
  assert.match(eventsEmptyNote({ itk: 1 }), /1 event record read/);
  // 面板没有把空态写成空白：`renderEvents` 一律写一行 `.pb-events-note`
  assert.match(panelJs, /el\.events\.innerHTML = `<span class="pb-events-note">\$\{esc\(eventsEmptyNote\(file\.eventSources\)\)\}<\/span>`/);
});

/* ---------------- 3. 时间轴上的标记 ---------------- */

test('标记数量与位置：3 个，百分比 = 事件时间 / 时长，按时序排', () => {
  const payload = playbackEvents(resolveCapture(B7));
  const markers = eventMarkers(payload.events, payload.durationMs / 1000);

  assert.equal(markers.length, 3);
  const lefts = markers.map((marker) => marker.left);
  assert.deepEqual(
    lefts.map((left) => Number(left.toFixed(3))),
    [30.295, 40.017, 96.727],
  );
  // 单调递增（时间轴从左到右）
  assert.deepEqual(lefts, [...lefts].sort((a, b) => a - b));
  assert.equal(markers[0].severity, 'Moderate');
  assert.equal(markers[0].frequency, 1270);

  // 边界：没有事件 / 没有时长时是空数组，不是 NaN 的 left
  assert.deepEqual(eventMarkers([], 10), []);
  assert.deepEqual(eventMarkers(payload.events, 0), []);
  assert.deepEqual(eventMarkers(null, 10), []);
});

test('标记是一个带 role 的按钮，红色/琥珀按 severity 上色，位置用 left 百分比', () => {
  assert.match(panelJs, /data-role="event-marker"/);
  assert.match(panelJs, /class="pb-event pb-event-\$\{esc\(marker\.severity\.toLowerCase\(\)\)\}/);
  assert.match(panelJs, /style="left:\$\{marker\.left\.toFixed\(3\)\}%"/);
  // 原版两个颜色的来源：#D0021B（S:5358 PoorEvent）、琥珀（S:5363 ModerateEvent）
  assert.match(panelCss, /\.pb-event-poor\s*\{[^}]*#d0021b/);
  assert.match(panelCss, /\.pb-event-moderate\s*\{[^}]*--pb-amber/);
  // 标记要能点（带子自己 pointer-events:none，标记单独打开）
  assert.match(panelCss, /\.pb-event\s*\{[^}]*pointer-events:\s*auto/);
});

test('tooltip 文案 = 原版的 HH:MM:SS + 句子（playbackview.js:244-245）', () => {
  const payload = playbackEvents(resolveCapture(B7));
  assert.equal(
    eventTooltipText(payload.events[0]),
    '09:59:21 Interference is being detected at 1270Mhz.',
  );
  assert.equal(eventTooltipText(null), '');
  assert.equal(
    eventTooltipText({ utc: '', detail: 'Spoofing is being detected' }),
    'Spoofing is being detected',
  );
});

/* ---------------- 4. 点击：只选中，不动播放头 ---------------- */

test('点击标记：同一个再点一次收起，点别的换一个（原版 data-event-count 的 -1 约定）', () => {
  assert.equal(nextEventSelection(-1, 0), 0); // 没选中 → 选中第 0 个
  assert.equal(nextEventSelection(0, 0), -1); // 同一个 → 收起
  assert.equal(nextEventSelection(0, 2), 2); // 另一个 → 换
  assert.equal(nextEventSelection(2, -1), -1); // 索引不合法 → 收起
  assert.equal(nextEventSelection(2, 1.5), -1);
});

test('点击标记不 seek：事件条上没有任何 setTime 调用，进度条也放行这段点击', () => {
  const clickHandler = /const onEventClick = \(event\) => \{[\s\S]*?\n  \};/.exec(panelJs)?.[0] ?? '';
  assert.ok(clickHandler.includes('selectEvent('), '点击应走 selectEvent');
  assert.ok(!clickHandler.includes('setTime('), '点击事件标记不能移动播放头（原版只开 tooltip）');

  const selection = /function selectEvent\(index\) \{[\s\S]*?\n  \}/.exec(panelJs)?.[0] ?? '';
  assert.ok(selection.length > 0);
  assert.ok(!selection.includes('setTime('));

  // 标记就在进度条里面，按下时不能触发 seek
  const barDown = /const onBarDown = \(event\) => \{[\s\S]*?\n  \};/.exec(panelJs)?.[0] ?? '';
  assert.match(barDown, /\[data-role="event-marker"\]/);
  assert.match(barDown, /return;/);
  // 键盘同理：标记上的 Enter/Space 不能变成播放/暂停
  const barKey = /const onBarKey = \(event\) => \{[\s\S]*?\n  \};/.exec(panelJs)?.[0] ?? '';
  assert.match(barKey, /\[data-role="event-marker"\]/);
});

/* ---------------- 5. Show Events 开关 + 路由接线 ---------------- */

test('Show Events 默认开；关掉后存进 localStorage，重开页面还是关的', () => {
  assert.equal(SHOW_EVENTS_KEY, 'nas.playback.showEvents');
  // 原版 getPlaybackShowEvents 在没有记录时返回 true（deviceManagement.js:188-193）
  assert.equal(showEventsFromStore(undefined), true);
  assert.equal(showEventsFromStore(null), true);
  assert.equal(showEventsFromStore(''), true);
  assert.equal(showEventsFromStore('true'), true);
  assert.equal(showEventsFromStore('false'), false);
  assert.equal(showEventsFromStore('0'), false);
  assert.match(panelJs, /showEvents: showEventsFromStore\(storage\.get\(SHOW_EVENTS_KEY\)\)/);
  assert.match(panelJs, /storage\.set\(SHOW_EVENTS_KEY/);
  // 关闭时整条带子藏起来（原版 `$("… .playback-events").css("display","none")`）
  assert.match(panelJs, /el\.events\.hidden = !file \|\| !state\.showEvents;/);
});

test('前端要的 /api/playback/events 与 server 的路由是同一个，且是只读 GET', () => {
  assert.match(panelJs, /api\.get\('\/api\/playback\/events'/);
  assert.match(serverTs, /path === '\/api\/playback\/events'/);
  assert.match(serverTs, /function handlePlaybackEvents\(url: URL, res: ServerResponse, method: string\)/);
  assert.match(serverTs, /\.\.\.playbackEvents\(capture\)/);
  // 只有 GET 进得来：路由在 method 检查之后（同一段里 `/api/playback/events` 没有 POST 分支）
  const block = /if \(path === '\/api\/playback\/events'\) \{[\s\S]*?\n      \}/.exec(serverTs)?.[0] ?? '';
  assert.ok(!block.includes('POST'), '事件路由不该有 POST 分支');
  assert.match(serverTs, /'\/api\/playback\/events',/); // /api/health 的 endpoints 列表
});
