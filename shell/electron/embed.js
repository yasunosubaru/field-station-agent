'use strict';
/**
 * W3 嵌入 spike —— 把另一个进程的顶层窗口挂成我们的子窗口（`user32.SetParent`）。
 *
 * 为什么要有这么一层，而不是在 main.js 里直接调 SetParent：
 *
 *   1. **SetParent 只是第一步。** 单独调它会把窗口挂进去，但窗口仍然是 WS_POPUP 的
 *      顶层样式：没有客户区裁剪、不会跟着父窗口重绘、鼠标命中判定还留在桌面坐标系，
 *      表现是"挂上去了但点不到、拖动会撕裂"。必须先把样式改成 WS_CHILD 再挂。
 *   2. **挂完必须解挂。** 原版套件被塞进面板后，用户随时要"退回独立窗口"（W3 的
 *      验收原话）。解挂要恢复**挂之前的**样式，而不是写死一套"看起来像顶层窗口"的
 *      样式——后者会把用户原来的窗口大小、位置、最大化状态弄丢。
 *   3. **DPI 不匹配是静默的。** 两个进程各自声明 DPI 感知时，子窗口按自己的 DPI 画，
 *      在高分屏上表现为"右下角一大片空白"或"内容被裁掉一半"，而且不报错。所以这里
 *      测出来、按比例补偿、并把结论记进返回值，让人能看见这件事发生过。
 *   4. **跨进程 SetFocus 允许失败。** SetFocus 只能给自己线程的窗口，跨进程会返回
 *      0 并置 ERROR_ACCESS_DENIED。这不是错误，是设计：记录下来，让调用方决定是
 *      提示用户点一下、还是走 AttachThreadInput。**不静默当成成功。**
 *
 * 依赖注入的设计：`createEmbedder(win32)` 收一个纯 JS 的函数表，而不是自己去
 * `require('koffi')`。这样单测可以用假 user32 把状态机跑一遍（Linux CI 上也能跑），
 * 真机集成只在 Windows 上、且只在装了 koffi 时发生。`createWin32()` 才是真正碰 FFI 的那层。
 *
 * 用法（主进程）：
 *
 *   const { createWin32, createEmbedder } = require('./embed');
 *   const embed = createEmbedder(createWin32());
 *   await embed.attach({ child: childHwnd, parent: hostHwnd, width, height });
 *   embed.resize(width, height);        // 父窗口 resize 时调
 *   embed.detach();                     // 一键退回独立窗口
 */

/* ---------------------------------------------------------------------------------------------
 * Win32 常量（只抄这里真的用到的那几个，抄全表反而不好核对）
 * ------------------------------------------------------------------------------------------- */

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

/** 顶层窗口的标志位；挂进去时要摘掉它。 */
const WS_POPUP = 0x80000000;
/** 子窗口的标志位；挂进去时要加上它。缺了它 SetParent 之后窗口不参与父窗口的绘制裁剪。 */
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
/** 有边框/标题栏的顶层窗口；解挂后要不要恢复由"挂之前有没有"决定，所以这里只做识别。 */
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
/** 父窗口重绘时不擦背景，嵌入的第三方内容才不会闪。 */
const WS_CLIPCHILDREN = 0x02000000;
const WS_CLIPSIBLINGS = 0x04000000;

const EX_WS_EX_APPWINDOW = 0x00040000;
const EX_WS_EX_TOOLWINDOW = 0x00000080;

const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOOWNERZORDER = 0x0200;

const SW_HIDE = 0;
const SW_SHOW = 5;

const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;

/** 嵌入后要保持的样式：子窗口 + 可见 + 按父窗口裁剪。 */
const EMBEDDED_STYLE = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
/**
 * 嵌入时要摘掉的"窗口外壳"位。
 *
 * 不摘的话，子窗口会在面板里**再画一条标题栏和一圈粗边框**：客户区比面板小
 * 18×47 左右（实测 1090×782 vs 1108×829），看起来像"嵌进去但没铺满"。
 * 面板的标题由我们自己的界面提供，这里不需要第二个标题栏。
 */
const CHROME_BITS = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

/* ---------------------------------------------------------------------------------------------
 * 真正的 FFI 层：koffi + user32/kernel32。只有 Windows 才有意义。
 * ------------------------------------------------------------------------------------------- */

/**
 * 载入 koffi 并声明本模块用到的全部 user32/kernel32 入口。
 *
 * 刻意不用 `bool` 声明 Windows 的 `BOOL`：C 的 `BOOL` 是 4 字节 int，
 * 而 koffi 的 `bool` 是 1 字节，返回值高位会被当成垃圾，`SetWindowPos` 就会
 * "偶尔返回真、偶尔返回假"。一律用 `int` 接 BOOL 是本模块的一条硬约定。
 */
function createWin32(options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('嵌入功能只支持 Windows（user32.SetParent 是 Win32 API）');
  }
  let koffi;
  try {
    koffi = options.koffi || require('koffi');
  } catch (error) {
    throw new Error(
      '找不到 koffi，无法调用 user32。\n'
      + '在 shell/electron 下执行：\n'
      + '  npm install --no-save --no-package-lock koffi --registry=https://registry.npmmirror.com\n'
      + `（原始错误：${error && error.message}）`,
    );
  }

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const RECT = koffi.struct('FSA_RECT', {
    left: 'int',
    top: 'int',
    right: 'int',
    bottom: 'int',
  });

  /*
   * 句柄一律走 `intptr_t` 而不是 `void *`：
   *   - koffi 接受 BigInt 传 `intptr_t`，而 Electron 的 getNativeWindowHandle()
   *     给的就是一个 Buffer，转 BigInt 比转指针对象简单；
   *   - 假实现（单测）可以直接传普通数字，不必构造指针。
   */
  const api = {
    setParent: user32.func('intptr_t SetParent(intptr_t hWndChild, intptr_t hWndNewParent)'),
    getParent: user32.func('intptr_t GetParent(intptr_t hWnd)'),
    getWindowLongPtr: user32.func('intptr_t GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
    setWindowLongPtr: user32.func('intptr_t SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)'),
    setWindowPos: user32.func(
      'int SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags)',
    ),
    moveWindow: user32.func('int MoveWindow(intptr_t hWnd, int X, int Y, int nWidth, int nHeight, int bRepaint)'),
    showWindow: user32.func('int ShowWindow(intptr_t hWnd, int nCmdShow)'),
    isWindow: user32.func('int IsWindow(intptr_t hWnd)'),
    setFocus: user32.func('intptr_t SetFocus(intptr_t hWnd)'),
    getClientRect: user32.func('int GetClientRect(intptr_t hWnd, _Out_ FSA_RECT *lpRect)'),
    getDpiForWindow: user32.func('unsigned int GetDpiForWindow(intptr_t hWnd)'),
    findWindow: user32.func('intptr_t FindWindowW(str16 lpClassName, str16 lpWindowName)'),
    getLastError: kernel32.func('unsigned int GetLastError()'),
  };

  return {
    constants: {
      GWL_STYLE, GWL_EXSTYLE, WS_POPUP, WS_CHILD, WS_VISIBLE, WS_CAPTION,
      WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
      WS_CLIPCHILDREN, WS_CLIPSIBLINGS, EX_WS_EX_APPWINDOW, EX_WS_EX_TOOLWINDOW,
      HWND_TOP, SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE,
      SWP_FRAMECHANGED, SWP_SHOWWINDOW, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOW,
      ERROR_ACCESS_DENIED,
    },
    // 每次读都要现调：GetLastError 是线程局部的，缓存下来只会读到上一次的错误。
    lastError: () => api.getLastError(),
    getStyle: (hwnd) => api.getWindowLongPtr(hwnd, GWL_STYLE),
    setStyle: (hwnd, style) => api.setWindowLongPtr(hwnd, GWL_STYLE, style),
    getExStyle: (hwnd) => api.getWindowLongPtr(hwnd, GWL_EXSTYLE),
    setExStyle: (hwnd, style) => api.setWindowLongPtr(hwnd, GWL_EXSTYLE, style),
    setParent: (child, parent) => api.setParent(child, parent),
    getParent: (hwnd) => api.getParent(hwnd),
    setWindowPos: (hwnd, insertAfter, x, y, cx, cy, flags) => api.setWindowPos(hwnd, insertAfter, x, y, cx, cy, flags),
    moveWindow: (hwnd, x, y, w, h, repaint) => api.moveWindow(hwnd, x, y, w, h, repaint ? 1 : 0),
    showWindow: (hwnd, cmd) => api.showWindow(hwnd, cmd),
    isWindow: (hwnd) => api.isWindow(hwnd) !== 0,
    setFocus: (hwnd) => api.setFocus(hwnd),
    getClientSize: (hwnd) => {
      const rect = {};
      if (!api.getClientRect(hwnd, rect)) return null;
      return { width: rect.right - rect.left, height: rect.bottom - rect.top };
    },
    dpiOf: (hwnd) => api.getDpiForWindow(hwnd) || 96,
    findWindow: (title) => api.findWindow(null, title),
  };
}

/* ---------------------------------------------------------------------------------------------
 * 嵌入状态机（与 FFI 无关，可用假 win32 完整测试）
 * ------------------------------------------------------------------------------------------- */

/**
 * @param {object} win32 `createWin32()` 的返回值，或单测里的假实现（接口相同）。
 */
function createEmbedder(win32) {
  const C = win32.constants;

  /** 每次 attach 的现场，解挂时按它原样还原；不写死"像顶层窗口的样式"。 */
  let session = null;

  function decodeHandle(handle) {
    if (typeof handle === 'bigint') return handle;
    if (typeof handle === 'number') return BigInt(Math.trunc(handle));
    // Electron 的 getNativeWindowHandle() 给的是指针宽度的小端 Buffer。
    if (Buffer.isBuffer(handle)) {
      if (handle.length >= 8) return handle.readBigUInt64LE(0);
      if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
    }
    throw new TypeError(`无法解释的窗口句柄：${Object.prototype.toString.call(handle)}`);
  }

  function state() {
    if (!session) return { attached: false };
    return {
      attached: true,
      child: Number(session.child),
      parent: Number(session.parent),
      hostDpi: session.hostDpi,
      childDpi: session.childDpi,
      dpiScale: session.dpiScale,
      dpiMismatch: session.childDpi !== session.hostDpi,
      focusDeferred: session.focusDeferred,
      warnings: session.warnings.slice(),
    };
  }

  /**
   * 把 `child` 挂成 `parent` 的子窗口。
   *
   * 顺序是硬性的：**先改样式、再 SetParent**。反过来（先 SetParent 再改样式）时，
   * 窗口会短暂处于"WS_POPUP 的子窗口"这个非法组合，表现为挂上后不刷新、点不到。
   */
  function attach({ child, parent, width, height, focus = true }) {
    if (session) throw new Error('已经有一处嵌入在进行中，先 detach() 再重新 attach()');
    const childHwnd = decodeHandle(child);
    const parentHwnd = decodeHandle(parent);
    if (childHwnd === 0n || parentHwnd === 0n) throw new Error('child / parent 句柄不能为空');
    if (!win32.isWindow(childHwnd)) throw new Error(`child 不是有效窗口：${childHwnd}`);
    if (!win32.isWindow(parentHwnd)) throw new Error(`parent 不是有效窗口：${parentHwnd}`);

    const warnings = [];
    const originalStyle = win32.getStyle(childHwnd);
    const originalExStyle = win32.getExStyle(childHwnd);

    // 1) 样式：摘 WS_POPUP 与窗口外壳位、加 WS_CHILD 与裁剪位，并保留 WS_VISIBLE 免得挂上后不可见。
    const embeddedStyle = (originalStyle & ~C.WS_POPUP & ~CHROME_BITS) | EMBEDDED_STYLE;
    win32.setStyle(childHwnd, embeddedStyle);

    /*
     * 2) 扩展样式：把窗口从任务栏里摘掉。子窗口不该在任务栏留一个条目——
     *    用户看到的是"一个面板里嵌着一份套件"，而不是"两个程序"。
     *    单独还原时要把它加回去，所以原值存在 session 里。
     */
    win32.setExStyle(childHwnd, (originalExStyle | C.EX_WS_EX_TOOLWINDOW) & ~C.EX_WS_EX_APPWINDOW);

    // 3) 挂载。跨进程 SetParent 合法，但输入队列不共享，焦点要单独处理（见第 6 步）。
    const previousParent = win32.setParent(childHwnd, parentHwnd);
    if (Number(win32.getParent(childHwnd)) !== Number(parentHwnd)) {
      // 挂载没生效就把样式回滚，别留一个"改过样式却没挂上"的窗口在现场。
      win32.setStyle(childHwnd, originalStyle);
      win32.setExStyle(childHwnd, originalExStyle);
      throw new Error(`SetParent 未生效（返回 ${previousParent}，错误码 ${win32.lastError()}）`);
    }

    // 4) 尺寸与层级：按面板客户区铺满，并置顶到兄弟窗口之上。
    const hostDpi = win32.dpiOf(parentHwnd);
    const childDpi = win32.dpiOf(childHwnd);
    const dpiScale = childDpi > 0 && hostDpi > 0 ? hostDpi / childDpi : 1;
    if (Math.abs(dpiScale - 1) > 0.01) {
      /*
       * 两个进程 DPI 感知不一致时，子窗口会按**自己的** DPI 排版。
       * 补偿办法是把尺寸按比例放大，让它的内容物理上正好铺满面板；
       * 这是补偿不是修复——真正干净的做法是让两边用同一档 DPI 感知启动。
       * 写进 warnings 才是重点：不然这片空白永远不会有人解释。
       */
      warnings.push(
        `DPI 不一致：宿主 ${hostDpi} / 子窗口 ${childDpi}（比例 ${dpiScale.toFixed(3)}）。`
        + '已按比例补偿尺寸；根治要让两个进程用同一档 DPI 感知启动。',
      );
    }
    const client = win32.getClientSize(parentHwnd) || { width: 0, height: 0 };
    const targetWidth = Math.max(0, Math.round((width != null ? width : client.width) * dpiScale));
    const targetHeight = Math.max(0, Math.round((height != null ? height : client.height) * dpiScale));
    win32.moveWindow(childHwnd, 0, 0, targetWidth, targetHeight, true);
    win32.setWindowPos(
      childHwnd, C.HWND_TOP, 0, 0, targetWidth, targetHeight,
      C.SWP_FRAMECHANGED | C.SWP_SHOWWINDOW | C.SWP_NOACTIVATE,
    );
    win32.showWindow(childHwnd, C.SW_SHOW);

    // 5) 焦点：跨进程 SetFocus 会失败，失败不是异常，但要如实记录。
    let focusDeferred = false;
    if (focus && win32.setFocus(childHwnd) === 0) {
      focusDeferred = win32.lastError() === C.ERROR_ACCESS_DENIED || true;
      warnings.push(
        `SetFocus 未生效（错误码 ${win32.lastError()}）：跨进程焦点不能强夺。`
        + '已记录 focusDeferred，用户点一下面板即可获得焦点。',
      );
    }

    session = {
      child: childHwnd,
      parent: parentHwnd,
      hostDpi,
      childDpi,
      dpiScale,
      originalStyle,
      originalExStyle,
      focusDeferred,
      warnings,
    };
    return state();
  }

  /** 父窗口改大小时跟着改；没挂载时是空操作，免得调用方到处判空。 */
  function resize(width, height) {
    if (!session) return false;
    const w = Math.max(0, Math.round(width * session.dpiScale));
    const h = Math.max(0, Math.round(height * session.dpiScale));
    return win32.moveWindow(session.child, 0, 0, w, h, true) !== 0;
  }

  /**
   * 一键退回独立窗口：恢复**挂载前**的样式与扩展样式，摘掉父窗口。
   *
   * 为什么必须用原样式而不是拼一套"看起来像顶层窗口"的：原版套件可能是最大化启动、
   * 可能被用户改过窗口大小，拼出来的样式会让它跳成另一个尺寸。这里只做一件事——
   * 把那两个 long 值原样写回去。
   */
  function detach() {
    if (!session) return { detached: false, reason: '当前没有嵌入' };
    const s = session;
    win32.setParent(s.child, 0);
    win32.setStyle(s.child, s.originalStyle);
    win32.setExStyle(s.child, s.originalExStyle);
    win32.setWindowPos(
      s.child, C.HWND_TOP, 0, 0, 0, 0,
      C.SWP_FRAMECHANGED | C.SWP_NOMOVE | C.SWP_NOSIZE | C.SWP_SHOWWINDOW,
    );
    win32.showWindow(s.child, C.SW_SHOW);
    session = null;
    return {
      detached: true,
      child: Number(s.child),
      styleRestored: true,
      parentAfterDetach: Number(win32.getParent(s.child)),
    };
  }

  return { attach, resize, detach, state, decodeHandle };
}

module.exports = {
  createWin32,
  createEmbedder,
  // 导出常量供单测与文档核对，不鼓励外部直接拼样式位。
  constants: {
    GWL_STYLE, GWL_EXSTYLE, WS_POPUP, WS_CHILD, WS_VISIBLE, WS_CAPTION,
    WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS, EX_WS_EX_APPWINDOW, EX_WS_EX_TOOLWINDOW,
    HWND_TOP, SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE,
    SWP_FRAMECHANGED, SWP_SHOWWINDOW, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOW,
    ERROR_ACCESS_DENIED, EMBEDDED_STYLE,
  },
};
