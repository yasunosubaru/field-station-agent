/**
 * 主题切换 —— 原版 NovAtel Application Suite 只有两套主题，写法是给 <body> 加一个 class：
 *
 *   逆向/01_解包/app/view/html/index.html:1071-1073
 *     if (userStore.userStoreJSON.theme == "dark-theme") { $('body').addClass("darkMode"); }
 *
 * 也就是说：**浅色 = body 上没有 class；深色 = body.classList 含 `darkMode`**，
 * 对应 style.css:23313-23315 的 `body.darkMode` 和 style.css:23245 起那一整段 `.darkMode ...`。
 * 设置菜单里的两项 `<li id="light-theme">` / `<li id="dark-theme">`（index.html:278-285）
 * 本身没有样式含义，只是把选中的主题名写进 localStorage。
 *
 * 本文件提供 setTheme() / getTheme() / toggleTheme()（另有 initTheme() 与自动执行），
 * 并把选择写进 localStorage，页面加载时优先用已保存值、否则跟随系统 prefers-color-scheme。
 *
 * 用法（两件都行）：
 *   <script type="module" src="/theme.js"></script>      —— ESM 具名导出
 *   运行时注入一段模块脚本（自测就是这么做的）           —— globalThis 上同时挂了同名函数
 * 既然 index.html 不允许改动，这里同时负责**用 JS 往顶栏右上角插一个切换按钮**（齿轮左边）。
 */

/** localStorage 键；值沿用原版的名字 `dark-theme` / `light-theme`，同时接受简写 `dark` / `light` */
const STORAGE_KEY = 'nas-theme';
/** 原版的深色 class，写在 <body> 上（不要改名：style.css:23313 的选择器就是 body.darkMode） */
const DARK_CLASS = 'darkMode';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';
const LIGHT_VALUE = 'light-theme';
const DARK_VALUE = 'dark-theme';

/** 把调用方/存储里的各种写法归一成 'light' | 'dark'；不认识的值返回 null */
function normalize(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'dark' || v === DARK_VALUE) return 'dark';
  if (v === 'light' || v === LIGHT_VALUE) return 'light';
  return null;
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式 / file:// 下访问 localStorage 会抛
    return null;
  }
}

/** 读已保存的主题；没存过返回 null */
function readStored() {
  const store = storage();
  if (!store) return null;
  try {
    return normalize(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(theme) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, theme === 'dark' ? DARK_VALUE : LIGHT_VALUE);
  } catch {
    /* 存不进去就只影响「记住」，不影响本次渲染 */
  }
}

function systemTheme() {
  try {
    return globalThis.matchMedia?.(SYSTEM_DARK)?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 当前主题：以 body 上的 class 为准（外部若自己加了 class，也能读到） */
export function getTheme() {
  return document.body?.classList.contains(DARK_CLASS) ? 'dark' : 'light';
}

/**
 * 设置主题并记住。
 * @param {'light'|'dark'} theme
 * @returns {'light'|'dark'} 实际生效的主题
 */
export function setTheme(theme) {
  const next = normalize(theme);
  if (!next) throw new TypeError(`theme 只能是 'light' 或 'dark'，收到：${String(theme)}`);

  const body = document.body;
  if (body) {
    body.classList.toggle(DARK_CLASS, next === 'dark'); // 原版写法：$('body').addClass("darkMode")
  }
  writeStored(next);
  syncToggle();
  return next;
}

/** 在浅色/深色之间来回切 */
export function toggleTheme() {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/** 页面加载时初始化：已保存值优先，否则跟随系统偏好（不写回 localStorage，免得把系统偏好当成用户选择） */
export function initTheme() {
  /* The original only turns dark when the stored setting says `dark-theme`
   * (index.html:1071-1073). It does not follow the OS, so a Windows set to dark still opens the
   * light suite. Following prefers-color-scheme here made a dark desktop open our half-dark,
   * half-light build by default — the exact complaint from the bench on 2026-11-02. */
  const theme = readStored() ?? 'light';
  document.body?.classList.toggle(DARK_CLASS, theme === 'dark');
  mountToggle();
  syncToggle();
  return theme;
}

let systemWatcher = null;
/** 没存过值时跟随系统主题变化 */
function watchSystem() {
  let media;
  try {
    media = globalThis.matchMedia?.(SYSTEM_DARK);
  } catch {
    return;
  }
  if (!media?.addEventListener || systemWatcher) return;
  systemWatcher = (event) => {
    if (readStored()) return; // 用户选过就不再跟系统
    document.body?.classList.toggle(DARK_CLASS, event.matches);
    syncToggle();
  };
  media.addEventListener('change', systemWatcher);
}

/* ---------------- 顶栏里的切换按钮 ---------------- */

const TOGGLE_SELECTOR = '[data-theme-toggle]';

function toggleElement() {
  return document.querySelector(TOGGLE_SELECTOR);
}

/**
 * 往顶栏右上角插按钮（齿轮左边）。
 * 类名用原版菜单项的两件套 `sidebar-nav-subitem-title menubar-items`，
 * 几何与 hover 由 theme.css 的 .theme-toggle 按 S:1432-1446 补齐。
 * 注意：不碰 index.html，页面里原本没有这个按钮时就现场造一个。
 */
export function mountToggle() {
  if (toggleElement() || !document.body) return toggleElement();

  const settings = document.getElementById('settings-banner');
  const host =
    settings?.closest('ul') ??
    document.querySelector('.right-section .sidebar-nav') ??
    document.querySelector('.right-section ul');

  const anchor = document.createElement('a');
  anchor.className = 'sidebar-nav-subitem-title menubar-items theme-toggle';
  anchor.setAttribute('data-theme-toggle', '');
  anchor.setAttribute('role', 'button');
  anchor.setAttribute('tabindex', '0');

  const item = document.createElement('li');
  item.className = 'sidebar-nav-item menu-highlight';
  item.appendChild(anchor);

  if (settings) {
    // 齿轮所在的 li 前面（原版顺序：九宫格在左，齿轮/问号在右）
    (settings.closest('li') ?? settings).before(item);
  } else if (host) {
    host.insertBefore(item, host.firstElementChild);
  } else {
    document.body.appendChild(item);
  }

  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    toggleTheme();
  });
  anchor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleTheme();
    }
  });

  syncToggle();
  return anchor;
}

/** 按钮的可访问文案跟着主题走 */
function syncToggle() {
  const el = toggleElement();
  if (!el) return;
  const dark = getTheme() === 'dark';
  el.setAttribute('aria-pressed', dark ? 'true' : 'false');
  el.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  el.setAttribute('title', dark ? '浅色主题 (Light)' : '深色主题 (Dark)');
}

/* ---------------- 自动执行 ---------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initTheme(), { once: true });
} else {
  initTheme();
}

/* 运行时注入（无 import 环境/自测脚本）也要能直接拿到这三个函数 */
globalThis.getTheme = getTheme;
globalThis.setTheme = setTheme;
globalThis.toggleTheme = toggleTheme;
globalThis.initTheme = initTheme;
