/**
 * Agent 工作台 · 纯函数模型测试（WP1）。
 *
 * 只测不碰 DOM 的那一层：事件 → 卡片、markdown 安全渲染、会话排序、产物落哪个专业面板。
 * 浏览器行为（SSE、点击、滚动）由 agent-bridge.test.ts 与手工验收覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  artifactKindLabel,
  artifactPanel,
  buildCards,
  deriveSessionTitle,
  escapeHtml,
  formatDuration,
  renderMarkdown,
  sessionTitle,
  sortSessions,
  statusLabel,
  toolMeta,
} from '../src/web/agent/model.js';
import { artifactUrl } from '../src/web/agent/api.js';

/* ------------------------------------------------------------------ markdown */

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('renderMarkdown never lets raw HTML through', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('renderMarkdown renders fences, inline code and bold', () => {
  const html = renderMarkdown('**粗** `code`\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /ag-code/);
  assert.match(html, /const a = 1;/);
});

test('renderMarkdown drops javascript: links but keeps the text', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.equal(html.includes('href="javascript'), false);
  assert.match(html, /点我/);
});

/* ------------------------------------------------------------------ 事件 → 卡片 */

test('token events with one id merge, then message overwrites the streamed text', () => {
  let cards = [];
  cards = applyEvent(cards, { type: 'token', id: 'm1', delta: '你' });
  cards = applyEvent(cards, { type: 'token', id: 'm1', delta: '好' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].content, '你好');
  assert.equal(cards[0].streaming, true);

  cards = applyEvent(cards, { type: 'message', id: 'm1', role: 'assistant', content: '你好（完整）' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].content, '你好（完整）');
  assert.equal(cards[0].streaming, false);
});

test('tool_call + tool_result share one card and become ok', () => {
  let cards = applyEvent([], { type: 'tool_call', id: 'c1', name: 'device_heartbeat', risk: 'low' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'running');
  assert.equal(cards[0].label, '设备心跳');

  cards = applyEvent(cards, {
    type: 'tool_result', id: 'c1', ok: true, summary: '4 台',
    data: { total: 4 }, evidence: { agent: 'ops', call_id: 't0001' }, duration_ms: 12,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'ok');
  assert.equal(cards[0].summary, '4 台');
  assert.equal(cards[0].evidence.call_id, 't0001');
});

test('a failed tool_result becomes failed, not a new card', () => {
  let cards = applyEvent([], { type: 'tool_call', id: 'c2', name: 'nope' });
  cards = applyEvent(cards, { type: 'tool_result', id: 'c2', ok: false, summary: '未注册' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'failed');
  assert.equal(cards[0].ok, false);
});

test('approval pending then decision updates the same card', () => {
  let cards = applyEvent([], {
    type: 'approval', id: 'a1', call_id: 'c1', risk: 'high',
    reason: '重启设备', prompt: '批准？', status: 'pending',
  });
  assert.equal(cards[0].status, 'pending');
  cards = applyEvent(cards, {
    type: 'approval', id: 'a1', call_id: 'c1', status: 'rejected', note: '现场不允许',
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'rejected');
});

test('artifact events become artifact cards with a panel hint', () => {
  const cards = buildCards([
    { type: 'artifact', id: 'f1', name: 'graph-report.pdf', kind: 'pdf', sha256: 'abc' },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, 'artifact');
  assert.equal(cards[0].name, 'graph-report.pdf');
  assert.equal(artifactPanel(cards[0]), 'graph');
});

/* ------------------------------------------------------------------ 会话与工具 */

test('sortSessions puts the newest update first and breaks ties by id', () => {
  const sorted = sortSessions([
    { id: 'b', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'a', updated_at: '2026-01-02T00:00:00Z' },
    { id: 'c', updated_at: '2026-01-02T00:00:00Z' },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'c', 'b']);
});

test('sessionTitle falls back to a derived first line', () => {
  assert.equal(sessionTitle({ title: '显式标题' }), '显式标题');
  assert.equal(sessionTitle({}, '别名'), '别名');
  assert.equal(deriveSessionTitle('帮我检查\n第二行'), '帮我检查');
  assert.equal(deriveSessionTitle('   '), '新会话');
});

test('toolMeta labels known tools and leaves unknown names untouched', () => {
  assert.equal(toolMeta('station_health').label, '台站健康度');
  assert.equal(toolMeta('mystery_tool').label, 'mystery_tool');
  assert.equal(statusLabel('running'), '运行中');
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(artifactKindLabel('csv'), 'CSV');
});

test('artifactUrl points at the download endpoint with an encoded name', () => {
  assert.equal(
    artifactUrl('s1', { name: 'a b.pdf' }),
    '/api/agent/sessions/s1/artifacts/a%20b.pdf',
  );
  assert.equal(artifactUrl('s1', { url: '/x/y' }), '/x/y');
});
