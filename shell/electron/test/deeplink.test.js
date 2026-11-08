/**
 * 深链的逐条测试：两种方向、14 类畸形输入、字符集不许放宽。
 *
 *   node --test shell/electron/test/deeplink.test.js
 *
 * ## 为什么这一条要写这么细
 *
 * 深链是**外部输入**：可能来自浏览器、来自任意第三方程序、可能是恶意构造的。
 * 规格 25.15.2 把理由写得很直接 ——
 *
 *   如果不校验：恶意输入可能注入代码；错误输入可能导致崩溃；
 *   别的程序的链接可能打开错误的东西。
 *
 * 25.15.3 列了 14 类畸形输入，并要求「每一条都要有一条测试」。
 * 这里逐条落实，并且**两种 kind 各跑一遍** —— 因为 device 是后加的，
 * 最容易出现「job 校验了、device 漏了」。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDeepLink, linkFromArgv } = require('../deeplink.js');

/** 静音日志：测试里不需要每次都打印拒绝原因。 */
const quiet = () => {};

/* =============================================================================================
 * 一、正向：两种深链都要能过
 * =========================================================================================== */

test('fsa://job/<id> 能解析', () => {
  assert.deepEqual(parseDeepLink('fsa://job/t-abc123', quiet), { kind: 'job', id: 't-abc123' });
});

test('fsa://device/<id> 能解析（视-6 的正向方向）', () => {
  assert.deepEqual(parseDeepLink('fsa://device/WUHN-1', quiet), { kind: 'device', id: 'WUHN-1' });
});

test('id 允许的字符：字母数字与 . _ -', () => {
  for (const id of ['a', 'A', '0', 'a.b', 'a_b', 'a-b', 'WUHN-1', 't-abc123', 'x'.repeat(128)]) {
    const parsed = parseDeepLink(`fsa://job/${id}`, quiet);
    assert.ok(parsed, `应当接受 ${id}`);
    assert.equal(parsed.id, id);
  }
});

test('三种写法都认（多一条斜杠 / 无斜杠的规范化）', () => {
  // Windows 把协议 URL 当命令行参数递进来，不同来源的规范化不同。
  for (const text of ['fsa://job/abc', 'fsa:///job/abc', 'fsa:job/abc']) {
    const parsed = parseDeepLink(text, quiet);
    assert.ok(parsed, `应当接受 ${text}`);
    assert.equal(parsed.kind, 'job');
    assert.equal(parsed.id, 'abc');
  }
  assert.deepEqual(parseDeepLink('fsa:///device/WUHN-1', quiet), { kind: 'device', id: 'WUHN-1' });
});

test('两端的空白被裁掉（复制粘贴常见）', () => {
  assert.deepEqual(parseDeepLink('  fsa://job/abc  ', quiet), { kind: 'job', id: 'abc' });
});

/* =============================================================================================
 * 二、14 类畸形输入（25.15.3 逐条）
 *
 * 每一条都**两种 kind 各验一次**。这是本文件的主要价值。
 * =========================================================================================== */

/**
 * 14 类畸形输入。`build(kind)` 返回要测的串。
 *
 * 写成一个表而不是 14 个 test：加一类只要加一行，且 job / device 两遍自动覆盖。
 */
const MALFORMED = [
  { n: 1, why: '空 id', build: (kind) => `fsa://${kind}/` },
  { n: 2, why: 'id 太短（1 字符是允许的，所以这里测 0 字符）', build: (kind) => `fsa://${kind}` },
  { n: 3, why: 'id 太长（129 字符）', build: (kind) => `fsa://${kind}/${'x'.repeat(129)}` },
  { n: 4, why: '非法字符（空格）', build: (kind) => `fsa://${kind}/a b` },
  { n: 5, why: '非法字符（斜杠）', build: (kind) => `fsa://${kind}/a/b` },
  { n: 6, why: '非法字符（..）', build: (kind) => `fsa://${kind}/../etc/passwd` },
  { n: 7, why: '非法字符（中文）', build: (kind) => `fsa://${kind}/任务1` },
  { n: 8, why: '非法字符（%）', build: (kind) => `fsa://${kind}/a%00b` },
  { n: 9, why: '主机名大写', build: (kind) => `fsa://${kind.toUpperCase()}/abc` },
  { n: 10, why: '错误的 scheme', build: (kind) => `fsb://${kind}/abc` },
  { n: 11, why: '多余的段', build: (kind) => `fsa://${kind}/abc/def/ghi` },
  { n: 12, why: '带查询串', build: (kind) => `fsa://${kind}/abc?x=1` },
  { n: 13, why: '带片段', build: (kind) => `fsa://${kind}/abc#x` },
  { n: 14, why: '完全不是链接', build: () => 'hello' },
];

for (const kind of ['job', 'device']) {
  test(`14 类畸形输入全部拒绝（kind=${kind}）`, () => {
    for (const entry of MALFORMED) {
      const text = entry.build(kind);
      assert.equal(
        parseDeepLink(text, quiet),
        null,
        `第 ${entry.n} 类（${entry.why}）应当被拒：${text}`,
      );
    }
  });
}

/* =============================================================================================
 * 三、几条「差一点就过」的边界，单独钉住
 * =========================================================================================== */

test('不认识的 kind 一律拒绝，不是「忽略 kind 只看 id」', () => {
  for (const kind of ['fsa://bogus/abc', 'fsa://jobx/abc', 'fsa://devices/abc']) {
    assert.equal(parseDeepLink(kind, quiet), null, `应当拒绝 ${kind}`);
  }
});

test('id 里的 .. 不会被当成路径穿越（因为它根本过不了字符集）', () => {
  // `..` 本身是允许的字符组合（点号在字符集里），但它出现在**路径段**里时
  // `new URL` 已经规范化了；这里确认「越界」的形状一定被拒。
  assert.equal(parseDeepLink('fsa://job/../../etc/passwd', quiet), null);
  assert.equal(parseDeepLink('fsa://device/../secret', quiet), null);
});

test('百分号编码不解码 —— 所以编码绕过直接死在字符集上', () => {
  // 规格说明：刻意不用 decodeURIComponent。`%2e%2e` 解码后才显形，
  // 不解码时 `%` 通不过字符集，等于免费挡掉一层。
  for (const text of ['fsa://job/%2e%2e', 'fsa://device/%2e%2e', 'fsa://job/a%20b']) {
    assert.equal(parseDeepLink(text, quiet), null, `应当拒绝 ${text}`);
  }
});

test('大小写混合的主机名也拒绝（不只是全大写）', () => {
  // `new URL` 会把 hostname 转小写，所以必须回原文比对。
  for (const text of ['fsa://Job/abc', 'fsa://jOb/abc', 'fsa://DEVICE/abc', 'fsa://Device/abc']) {
    assert.equal(parseDeepLink(text, quiet), null, `应当拒绝 ${text}`);
  }
});

test('非字符串输入不崩', () => {
  for (const bad of [null, undefined, 0, 42, true, {}, [], () => {}]) {
    assert.equal(parseDeepLink(bad, quiet), null);
  }
});

test('scheme 大小写不敏感（FSA:// 与 fsa:// 等价）', () => {
  // URL 规范里 scheme 不分大小写，而**主机名**我们要求小写 —— 两件事别混。
  assert.deepEqual(parseDeepLink('FSA://job/abc', quiet), { kind: 'job', id: 'abc' });
  assert.deepEqual(parseDeepLink('Fsa://device/WUHN-1', quiet), { kind: 'device', id: 'WUHN-1' });
});

/* =============================================================================================
 * 四、字符集不许放宽（这是最重要的一条守护）
 * =========================================================================================== */

test('字符集是收窄的：危险字符一个都不收', () => {
  // 规格原话：「收窄是为了防注入。不要为了『支持更多 id』而放宽。」
  // 所以这里逐个列出「加进来就会出事的字符」，每一个都必须被拒。
  const dangerous = [
    '?', '&', '#', '/', '\\', ':', '@', '=', '+', '%', '$', '!', '*', "'", '"',
    '<', '>', '|', ';', ',', '(', ')', '[', ']', '{', '}', ' ', '\t', '\n', '~', '^', '`',
  ];
  for (const ch of dangerous) {
    const text = `fsa://job/a${ch}b`;
    assert.equal(parseDeepLink(text, quiet), null, `字符 ${JSON.stringify(ch)} 必须被拒：${text}`);
  }
});

test('长度上限正好是 128', () => {
  assert.ok(parseDeepLink(`fsa://job/${'x'.repeat(128)}`, quiet), '128 允许');
  assert.equal(parseDeepLink(`fsa://job/${'x'.repeat(129)}`, quiet), null, '129 拒绝');
});

/* =============================================================================================
 * 五、从 argv 里挑（Windows 把协议 URL 当普通参数递进来）
 * =========================================================================================== */

test('argv 里挑第一个认识的深链', () => {
  // 真实 argv 长这样：第一个是 exe，后面是各种标志，深链混在中间。
  const argv = ['--port', '7803', 'fsa://device/WUHN-1', 'fsa://job/t-1'];
  assert.deepEqual(linkFromArgv(argv, quiet), { kind: 'device', id: 'WUHN-1' });
});

test('argv 里没有深链时返回 null', () => {
  assert.equal(linkFromArgv(['--port', '7803'], quiet), null);
  assert.equal(linkFromArgv([], quiet), null);
  assert.equal(linkFromArgv(null, quiet), null);
});

test('argv 里的畸形深链被跳过，不影响后面的合法深链', () => {
  // 一个坏链接不该让整条命令行失效 —— 但也不能因为它坏了就猜一个。
  const argv = ['fsa://job/a b', 'fsa://device/WUHN-1'];
  assert.deepEqual(linkFromArgv(argv, quiet), { kind: 'device', id: 'WUHN-1' });
});
