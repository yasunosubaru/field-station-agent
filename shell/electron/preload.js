'use strict';
/**
 * Electron preload —— W2 骨架；本机已用 Electron 45.2.2 随窗口一起加载过（README §8）。
 *
 * 页面侧只通过 `window.nasShell` 与主进程说话；`nodeIntegration:false` +
 * `contextIsolation:true` + `sandbox:true`，所以这里不 expose 任何 Node 能力。
 *
 * 契约（后续页面要读环境时按这个用）：
 *
 *   await window.nasShell.info()
 *     → { baseUrl, port, view, attach, views, versions }
 *       baseUrl   Node 服务的地址，例如 http://127.0.0.1:7803
 *       port      实际端口
 *       view      首屏视角（chat / fleet / data / suite）
 *       attach    true 表示没拉起服务，连的是已有进程
 *       views     四个视角 id
 *       versions  electron / node / chrome
 *
 *   await window.nasShell.navigate('fleet')
 *     → true | false（主进程把窗口切到 /fleet；Node 服务不动）
 *
 * 现有外壳页（web/views/layout.html）只用左导航链接跳转，不依赖这份契约；
 * 它存在是为了打包之后（深链、原生菜单状态、窗口标题）有一个稳定的入口。
 */

const { contextBridge, ipcRenderer } = require('electron');

const shellApi = Object.freeze({
  /** 主进程那边的一次性环境信息。 */
  info: () => ipcRenderer.invoke('shell:info'),

  /** 切视角（同窗口重新加载外壳页）。未知 id 由主进程拒绝并返回 false。 */
  navigate: (view) => ipcRenderer.invoke('shell:navigate', String(view)),

  /** 运行时版本；和 info().versions 一致，只是不必等 IPC。 */
  versions: Object.freeze({
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    v8: process.versions.v8 || '',
  }),

  platform: process.platform,
});

contextBridge.exposeInMainWorld('nasShell', shellApi);
