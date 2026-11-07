'use strict';
/**
 * `embed.js` 的状态机测试 —— 用假 user32，不碰真窗口。
 *
 * 为什么要在 CI 上跑假实现而不是"Windows 上真挂一次"：
 *
 *   1. 真挂一次需要原版套件在跑、需要桌面会话、需要能拿窗口句柄；CI 上没有这些，
 *      而"跳过"会让这个模块永远处于没人验过的状态（本仓库的门禁把 skip 当失败，
 *      这条纪律对 JS 侧同样成立）。
 *   2. 嵌入的失败模式几乎全在**状态机**里，不在 FFI 里：样式有没有先改再挂、
 *      失败有没有回滚、解挂有没有还原**原始**样式、跨进程焦点失败有没有被记下来。
 *      这些用假 win32 全部能钉死，而且比真挂一次更容易造出"SetParent 失败"这种分支。
 *
 * 运行：
 *
 *   cd shell/electron && node --test test/embed.test.js
 *
 * 真机上的一次冒烟在 `tools/embed_smoke.js`（只在 Windows + 装了 koffi 时能跑）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const embed = require('../embed.js');

const C = embed.constants;

/**
 * 假 user32：把每个调用的入参记下来，并按脚本化的返回值作答。
 *
 * 状态位是真的会变的（`setStyle` 写进去、`getStyle` 读出来），因为"解挂还原原始样式"
 * 这条断言只有在样式真的被存过一次之后才有意义。
 */
function fakeWin32(options = {}) {
  const calls = [];
  const styles = new Map();
  const exStyles = new Map();
  const parents = new Map();
  const live = new Set(options.live || [101, 202]);
  let lastError = 0;

  const record = (name, args) => calls.push({ name, args });

  return {
    calls,
    constants: C,
    exploit: { styles, exStyles, parents, live },
    setLastError(value) { lastError = value; },
    lastError() { return lastError; },

    isWindow(hwnd) { return live.has(Number(hwnd)); },

    getStyle(hwnd) {
      record('getStyle', [Number(hwnd)]);
      const key = Number(hwnd);
      if (!styles.has(key)) styles.set(key, C.WS_POPUP | C.WS_VISIBLE | C.WS_CAPTION | C.WS_THICKFRAME);
      return styles.get(key);
    },
    setStyle(hwnd, style) {
      record('setStyle', [Number(hwnd), style]);
      styles.set(Number(hwnd), style);
      return 0;
    },
    getExStyle(hwnd) {
      record('getExStyle', [Number(hwnd)]);
      const key = Number(hwnd);
      if (!exStyles.has(key)) exStyles.set(key, C.EX_WS_EX_APPWINDOW);
      return exStyles.get(key);
    },
    setExStyle(hwnd, style) {
      record('setExStyle', [Number(hwnd), style]);
      exStyles.set(Number(hwnd), style);
      return 0;
    },

    setParent(child, parent) {
      record('setParent', [Number(child), Number(parent)]);
      if (options.setParentFails) {
        lastError = 5;
        return 0; // 不改 parents，模拟"没挂上"
      }
      const previous = parents.get(Number(child)) || 0;
      parents.set(Number(child), Number(parent));
      lastError = 0;
      return previous;
    },
    getParent(hwnd) { return parents.get(Number(hwnd)) || 0; },

    moveWindow(hwnd, x, y, w, h) {
      record('moveWindow', [Number(hwnd), x, y, w, h]);
      return 1;
    },
    setWindowPos(hwnd, insertAfter, x, y, cx, cy, flags) {
      record('setWindowPos', [Number(hwnd), Number(insertAfter), x, y, cx, cy, flags]);
      return 1;
    },
    showWindow(hwnd, cmd) {
      record('showWindow', [Number(hwnd), cmd]);
      return 1;
    },
    setFocus(hwnd) {
      record('setFocus', [Number(hwnd)]);
      if (options.focusDenied) {
        lastError = C.ERROR_ACCESS_DENIED;
        return 0;
      }
      return Number(hwnd);
    },
    getClientSize(hwnd) {
      record('getClientSize', [Number(hwnd)]);
      return options.clientSize || { width: 800, height: 600 };
    },
    dpiOf(hwnd) {
      const key = Number(hwnd);
      const map = options.dpi || {};
      return map[key] != null ? map[key] : 96;
    },
    findWindow() { return 0; },
  };
}

const CHILD = 101;
const PARENT = 202;

test('attach 先改样式再 SetParent（顺序反过来会挂上一个刷不新的窗口）', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT, width: 800, height: 600 });

  const names = win32.calls.map((c) => c.name);
  const firstStyle = names.indexOf('setStyle');
  const firstSetParent = names.indexOf('setParent');
  assert.ok(firstStyle >= 0, '没有改样式');
  assert.ok(firstSetParent >= 0, '没有调 SetParent');
  assert.ok(firstStyle < firstSetParent, `样式必须在 SetParent 之前改，实际 ${names.join(' → ')}`);
});

test('attach 摘掉 WS_POPUP、加上 WS_CHILD 与裁剪位', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT });

  const style = win32.exploit.styles.get(CHILD);
  assert.equal(style & C.WS_POPUP, 0, 'WS_POPUP 必须摘掉');
  assert.ok(style & C.WS_CHILD, 'WS_CHILD 必须加上');
  assert.ok(style & C.WS_CLIPSIBLINGS, '要按兄弟窗口裁剪');
  assert.ok(style & C.WS_VISIBLE, '挂上后不能不可见');
});

test('attach 把窗口从任务栏摘掉（子窗口不该留任务栏条目）', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT });

  const ex = win32.exploit.exStyles.get(CHILD);
  assert.ok(ex & C.EX_WS_EX_TOOLWINDOW, '应加 TOOLWINDOW');
  assert.equal(ex & C.EX_WS_EX_APPWINDOW, 0, '应摘掉 APPWINDOW');
});

test('SetParent 没生效时回滚样式，不留一个改过样子却没挂上的窗口', () => {
  const win32 = fakeWin32({ setParentFails: true });
  const e = embed.createEmbedder(win32);
  const before = win32.getStyle(CHILD);
  const beforeEx = win32.getExStyle(CHILD);

  assert.throws(
    () => e.attach({ child: CHILD, parent: PARENT }),
    /SetParent 未生效/,
  );
  assert.equal(win32.exploit.styles.get(CHILD), before, '普通样式必须回滚');
  assert.equal(win32.exploit.exStyles.get(CHILD), beforeEx, '扩展样式必须回滚');
  assert.equal(e.state().attached, false, '失败后不能留下 attached 现场');
});

test('detach 还原的是挂载前的原始样式，不是拼出来的一套"像顶层窗口"', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  const originalStyle = win32.getStyle(CHILD);
  const originalEx = win32.getExStyle(CHILD);

  e.attach({ child: CHILD, parent: PARENT });
  assert.notEqual(win32.exploit.styles.get(CHILD), originalStyle, '前提：挂载时样式确实变了');

  const result = e.detach();
  assert.equal(result.detached, true);
  assert.equal(win32.exploit.styles.get(CHILD), originalStyle, '普通样式没还原');
  assert.equal(win32.exploit.exStyles.get(CHILD), originalEx, '扩展样式没还原');
  assert.equal(win32.getParent(CHILD), 0, '父窗口没摘掉');
});

test('跨进程 SetFocus 失败不是异常，但必须被记进 focusDeferred 与 warnings', () => {
  const win32 = fakeWin32({ focusDenied: true });
  const e = embed.createEmbedder(win32);
  const st = e.attach({ child: CHILD, parent: PARENT });

  assert.equal(st.attached, true, '焦点失败不能把嵌入判成失败');
  assert.equal(st.focusDeferred, true);
  assert.ok(
    st.warnings.some((w) => w.includes('SetFocus')),
    `warnings 里应说明焦点没拿到，实际 ${JSON.stringify(st.warnings)}`,
  );
});

test('DPI 不一致时按比例补偿，并把这件事写进 warnings（否则空白永远没人解释）', () => {
  const win32 = fakeWin32({ dpi: { [PARENT]: 144, [CHILD]: 96 }, clientSize: { width: 1000, height: 500 } });
  const e = embed.createEmbedder(win32);
  const st = e.attach({ child: CHILD, parent: PARENT });

  assert.equal(st.hostDpi, 144);
  assert.equal(st.childDpi, 96);
  assert.equal(st.dpiMismatch, true);
  assert.ok(Math.abs(st.dpiScale - 1.5) < 1e-9, `比例应为 1.5，实际 ${st.dpiScale}`);

  const move = win32.calls.filter((c) => c.name === 'moveWindow').pop();
  assert.equal(move.args[3], 1500, '宽度应按 1.5 倍补偿');
  assert.equal(move.args[4], 750, '高度应按 1.5 倍补偿');
  assert.ok(st.warnings.some((w) => w.includes('DPI')), 'DPI 不一致必须留下记录');
});

test('DPI 一致时不产生 DPI 警告，尺寸也不放大', () => {
  const win32 = fakeWin32({ clientSize: { width: 640, height: 480 } });
  const e = embed.createEmbedder(win32);
  const st = e.attach({ child: CHILD, parent: PARENT });

  assert.equal(st.dpiMismatch, false);
  assert.equal(st.dpiScale, 1);
  assert.ok(!st.warnings.some((w) => w.includes('DPI')));
  const move = win32.calls.filter((c) => c.name === 'moveWindow').pop();
  assert.equal(move.args[3], 640);
  assert.equal(move.args[4], 480);
});

test('resize 在没挂载时是空操作，不抛异常', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  assert.equal(e.resize(100, 100), false);
});

test('resize 按挂载时算出的比例缩放', () => {
  const win32 = fakeWin32({ dpi: { [PARENT]: 192, [CHILD]: 96 } });
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT, width: 400, height: 300 });
  win32.calls.length = 0;
  assert.equal(e.resize(500, 250), true);
  const move = win32.calls.filter((c) => c.name === 'moveWindow').pop();
  assert.equal(move.args[3], 1000);
  assert.equal(move.args[4], 500);
});

test('重复 attach 会被拒绝；detach 之后可以再挂', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT });
  assert.throws(() => e.attach({ child: CHILD, parent: PARENT }), /已经有一处嵌入/);
  e.detach();
  assert.equal(e.attach({ child: CHILD, parent: PARENT }).attached, true);
});

test('句柄接受 Buffer（Electron 的 getNativeWindowHandle 就是这个形状）', () => {
  const win32 = fakeWin32({ live: [CHILD, PARENT] });
  const e = embed.createEmbedder(win32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(CHILD), 0);
  const st = e.attach({ child: buf, parent: PARENT });
  assert.equal(st.attached, true);
  assert.equal(st.child, CHILD);
});

test('无效句柄在动手之前就被拦下，不去改样式', () => {
  const win32 = fakeWin32({ live: [PARENT] });
  const e = embed.createEmbedder(win32);
  assert.throws(() => e.attach({ child: CHILD, parent: PARENT }), /child 不是有效窗口/);
  assert.equal(win32.calls.filter((c) => c.name === 'setStyle').length, 0, '拦下之后不该改任何样式');
});

test('没有嵌入时 detach 返回明确原因，而不是假装成功', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  const result = e.detach();
  assert.equal(result.detached, false);
  assert.ok(result.reason && result.reason.length > 0);
});

test('SetParent 记下挂载前的父窗口（解挂信息可用于回滚诊断）', () => {
  const win32 = fakeWin32();
  const e = embed.createEmbedder(win32);
  e.attach({ child: CHILD, parent: PARENT });
  const call = win32.calls.filter((c) => c.name === 'setParent').pop();
  assert.equal(call.args[0], CHILD);
  assert.equal(call.args[1], PARENT);
});
