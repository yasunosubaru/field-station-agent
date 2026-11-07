# W3 嵌入 spike：把原版套件的窗口挂进面板

- 状态：**spike 已通过（2026-11-07，本机 Windows 实测 16/16）**
- 关联：`docs/spec/2026-11-04-v4-实施计划.md` W3 第 1 周「嵌入 spike」
- 代码：`shell/electron/embed.js`（状态机 + FFI）、`shell/electron/test/embed.test.js`（单测）、`shell/electron/embed-smoke.js`（真机冒烟）
- 一句话：**`user32.SetParent` 这条路在本机走得通**，铺满到像素级，一键解挂能逐位还原原始窗口样式。

---

## 1. 结论先行

| 问题 | 结论 | 证据 |
|---|---|---|
| 原版窗口能不能挂进 Electron 面板？ | **能** | 真机 16/16；`GetParent(child)` 返回宿主 HWND |
| 挂进去会不会带一条多余的标题栏？ | **不会**（要显式摘掉外壳位） | 摘 `WS_CAPTION` 前客户区 1090×782，摘后 1108×829（与宿主一致） |
| 能不能一键退回独立窗口？ | **能，且逐位还原** | 解挂后 `style` 与挂载前完全相同（`0x16cf0000`） |
| DPI 不一致会怎样？ | **静默错位**，必须自己测补偿 | 见 §4；补偿后尺寸正确，但根治法不在本 spike 范围内 |
| 焦点能不能跨进程拿？ | **不能强夺**，是设计不是 bug | `SetFocus` 跨进程返回 0 + `ERROR_ACCESS_DENIED`；已记为 `focusDeferred` |
| `capturePage()` 能拍到嵌入的窗口吗？ | **不能** | 见 §6，这条踩过，很容易得出反向结论 |

---

## 2. 为什么不能只调一个 `SetParent`

只调 `SetParent` 会得到一个**挂上去但不好用**的窗口：它仍然是 `WS_POPUP` 的顶层样式，
没有客户区裁剪、不跟父窗口重绘、命中判定还留在桌面坐标系。表现是"看得见、点不到、一拖就撕裂"。

所以顺序是硬性的：**先改样式，再 `SetParent`**。反过来会短暂处于"`WS_POPUP` 的子窗口"
这个非法组合，症状是挂上后不刷新。

嵌入时对样式做三件事：

| 动作 | 位 | 为什么 |
|---|---|---|
| 摘 `WS_POPUP` | `0x80000000` | 不清掉它，窗口仍是"顶层窗口"，不参与父窗口裁剪 |
| 加 `WS_CHILD` | `0x40000000` | 子窗口身份；缺了它 `SetParent` 等于没挂 |
| 加 `WS_CLIPSIBLINGS` | `0x04000000` | 按兄弟窗口裁剪，否则会盖住同级的其他子窗口 |
| 摘 `WS_CAPTION` / `WS_THICKFRAME` / `WS_SYSMENU` / 两个 box | `0x00C00000` 等 | **不摘就在面板里再画一条标题栏和一圈粗边框**，客户区比面板小 18×47 |

解挂时**不用拼一套"看起来像顶层窗口"的样式**，而是把挂载前读到的两个 long 值原样写回去。
拼样式会把用户原来的窗口大小、位置、最大化状态弄丢——原版套件可能是最大化启动的。

---

## 3. `embed.js` 的接口

```js
const { createWin32, createEmbedder } = require('./embed');

const embed = createEmbedder(createWin32());   // 只有 Windows + 装了 koffi 才走得通

embed.attach({ child: childHwnd, parent: hostHwnd });   // 句柄接受 BigInt / number / Buffer
embed.resize(width, height);                            // 父窗口 resize 时调；未挂载是空操作
embed.detach();                                         // 一键退回独立窗口
embed.state();                                          // { attached, dpiMismatch, warnings, ... }
```

`createWin32()` 是唯一碰 FFI 的一层；`createEmbedder(win32)` 收一张纯 JS 函数表。
这样单测能用假 user32 把状态机完整跑一遍（Linux CI 上也能跑），真机集成只在 Windows 发生。

### 句柄从哪来

Electron 侧用 `win.getNativeWindowHandle()`，它是一个指针宽度的小端 `Buffer`；
`embed.js` 里 `decodeHandle()` 负责转成 `BigInt`。三种形状都接受，是因为冒烟脚本、
单测、真机三条路径给的形状不一样，让它各自适配比要求调用方统一更省事。

---

## 4. DPI：静默错位，必须自己测

两个进程各自声明 DPI 感知时，子窗口按**自己的** DPI 排版。表现是"右下角一大片空白"
或"内容被裁掉一半"，**而且不报错**。

`attach()` 会：

1. 用 `GetDpiForWindow` 分别量宿主与子窗口；
2. 比例不等于 1（容差 0.01）时按比例放大目标尺寸；
3. **把这件事写进 `warnings`**，并在 `state()` 里给 `dpiMismatch: true`。

第 3 条才是重点：不记下来，这片空白永远不会有人解释。补偿是**补偿不是修复**——
根治办法是让两个进程用同一档 DPI 感知启动，那属于 W3 第 2 周的事。

本机实测两边都是 96 DPI（比例 1.0），所以这条路径在真机上**没被触发过**，
只在单测里用假 win32 验过（144/96 = 1.5 → 宽度 1000 补到 1500）。
**这是本 spike 的一个已知验证缺口。**

---

## 5. 焦点：跨进程拿不到，这是设计

`SetFocus` 只能给自己线程的窗口。跨进程调用返回 0 并置 `ERROR_ACCESS_DENIED`。

`attach()` 的处理：**不当成失败**，但把 `focusDeferred: true` 和一条 warning 记下来。
不静默成功，是因为"用户点了面板没反应"和"嵌入失败"在界面上长得一样，
必须有东西能区分它们。

后续要做的是用户点面板时补一次 `SetFocus`（或 `AttachThreadInput`），那是第 2 周的事。

---

## 6. 截图这件事：`capturePage()` 拍不到

**踩过的坑，写下来防止再踩。**

`webContents.capturePage()` 走的是 Electron 自己的合成器。`SetParent` 挂进去的是
**原生子窗口**，不在合成器里 —— 截出来是一块干净的背景，看起来像"嵌入完全没生效"。

第一次跑冒烟时截出来是一张全黑的面板（`embedded.png`，6984 字节），差点据此判实现失败。
真正的证据要抓整屏（GDI `CopyFromScreen`）或者直接看屏幕。

`embed-smoke.js` 里两条都做了，断言文案也分别写清楚：

- `宿主渲染面截图落盘（不含原生子窗口）` —— 只证明宿主自己渲染正常
- `整屏抓取落盘（这条才看得出原生子窗口）` —— 这条才是视觉证据

---

## 7. 真机冒烟的 16 条断言

```powershell
cd shell\electron
$env:FSA_SMOKE_SHOT   = "$env:TEMP\opencode\embed-host.png"    # 可选：宿主渲染面
$env:FSA_SMOKE_SCREEN = "$env:TEMP\opencode\embed-screen.png"  # 可选：整屏（视觉证据）
node_modules\electron\dist\electron.exe embed-smoke.js
```

冒烟的做法：起**第二个 Electron 进程**当嵌入目标，让它用 `getNativeWindowHandle()`
把自己的 HWND 写进文件，主进程读出来挂上。不用记事本，是因为 Win11 上它是打包应用，
类名和标题随语言变，拿窗口只能靠枚举+启发式——"有时能跑"的冒烟证明不了任何事。

2026-11-07 实跑结果（`exit 0`）：

```
PASS  koffi + user32 可用
PASS  子进程报出自己的 HWND  —  hwnd=786566
PASS  子窗口句柄在 user32 里有效
PASS  宿主窗口句柄可读  —  hwnd=789462
PASS  宿主客户区可量  —  1108×829
PASS  attach 成功  —  {"dpiMismatch":false,"dpiScale":1,"focusDeferred":false}
PASS  user32 确认父窗口已变成宿主  —  GetParent=789462 期望 789462
PASS  WS_CHILD 已置位  —  style=0x56000000
PASS  WS_POPUP 已清除  —  style=0x56000000
PASS  子窗口已铺满宿主客户区（±4px 容差）  —  子 1108×829 / 宿主 1108×829 × 1
PASS  宿主渲染面截图落盘（不含原生子窗口）  —  6984 字节
PASS  整屏抓取落盘（这条才看得出原生子窗口）  —  352681 字节
PASS  detach 成功
PASS  解挂后父窗口已摘掉  —  GetParent=0
PASS  解挂后不再是子窗口  —  style=0x16cf0000
PASS  解挂后样式与挂载前逐位一致  —  挂载前 0x16cf0000 / 解挂后 0x16cf0000

合计 16/16 PASS
```

整屏那张图里，宿主窗口 `EMBED HOST` 的客户区完整显示着子进程的蓝色面板
（白字 `EMBED CHILD PROBE`），**没有标题栏、没有边框、铺满**。

---

## 8. 单测（不碰真窗口）

```powershell
cd shell\electron
node --test test/embed.test.js
```

15 条，skip 0。钉住的是**状态机**，不是 FFI：

| 断言 | 防的是哪种故障 |
|---|---|
| 先改样式再 `SetParent` | 顺序反了 → 挂上不刷新 |
| `WS_POPUP` 摘掉 / `WS_CHILD` 加上 | 少一个 → 等于没挂或点不到 |
| 进任务栏的扩展样式被摘掉 | 面板里嵌着套件，任务栏却多一个条目 |
| `SetParent` 失败时回滚样式 | 留一个"改过样子却没挂上"的窗口在现场 |
| `detach` 还原**原始**样式 | 拼样式 → 用户窗口尺寸/最大化状态丢失 |
| 焦点失败被记录而非抛异常 | 把设计约束当崩溃 |
| DPI 不一致时补偿并记 warning | 看起来嵌好了，右边一片空白 |
| 未挂载时 `resize` 是空操作 | 调用方到处判空 |
| 无效句柄在动手前被拦 | 改了样式才发现挂不上 |

---

## 9. 还没做的（诚实清单）

| 缺口 | 影响 | 归到哪 |
|---|---|---|
| **没接过真实的原版套件** | 冒烟用的是第二个 Electron 进程（同为 Chromium/Electron 窗口），不是 `NovAtelApplicationSuite.exe`。同为 Electron 窗口意味着它的窗口类、DPI 感知、渲染方式与本机实测对象一致，但这仍是**推断不是实测** | W3 第 1 周剩余 |
| DPI 不一致路径没在真机触发 | 本机两边都是 96 DPI。补偿逻辑只有单测覆盖 | W3 第 2 周（高 DPI 机器） |
| 焦点补获（`AttachThreadInput` 或点击补 `SetFocus`） | 嵌入后要用户点一下才拿到焦点 | W3 第 2 周 |
| 没接进 `main.js` | 现在只有 `embed.js` + 冒烟，主进程里没有"打开套件台"的入口 | W3 第 1 周收尾（与 W2 多窗口一起） |
| 层级细节：`SetWindowPos` 只在挂载时置顶一次 | 多子窗口叠加时可能被别的原生窗口盖住 | W3 第 2 周 |
| koffi 是**运行时可选依赖** | 没装时 `createWin32()` 抛带安装命令的错误，主进程必须捕获并降级到"独立窗口" | 已实现，见 `embed.js` 顶部注释 |

---

## 10. 依赖与回滚

`koffi` 加在 `shell/electron/package.json` 的 `dependencies`（不是 `devDependencies`：
它是运行时通过 FFI 调 `user32` 用的，打包时必须进包）。`node_modules` 照旧不入库。

安装：

```powershell
cd shell\electron
npm install --no-save --no-package-lock koffi --registry=https://registry.npmmirror.com
```

**回滚**：`shell/electron/embed.js`、`embed-smoke.js`、`test/embed.test.js` 都是新增文件，
删掉即可；`package.json` 里去掉 `koffi` 那一行。主进程没有引用它们，删了不影响现有壳。
