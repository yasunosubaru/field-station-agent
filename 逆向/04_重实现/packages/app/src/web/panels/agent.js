/**
 * Agent 工作台 —— 面板薄壳（WP1）。
 *
 * 这里只有一件事：`import('../agent/index.js')` 并转交 mount。
 * 真正的状态、渲染、SSE、设置都在 web/agent/ 下，按契约 §10 的模块切分：
 *   model.js（纯函数）/ api.js / cards.js / composer.js / settings.js / index.js
 *
 * 不用静态 import：面板是点开时才挂载的，Agent 代码不该在被打开前就加载。
 *
 * 失败时必须说清楚缺什么：外壳的 mountPanel 只 await 了 import，不 await mount，
 * 所以这里自己兜住异常并画一张可读的错误卡（样式内联，不依赖 agent.css）。
 */

function renderLoadError(root, error, retry) {
  const box = document.createElement('div');
  box.className = 'agent-load-error';
  box.setAttribute('role', 'alert');
  box.style.cssText = 'max-width:760px;margin:40px auto;padding:18px 20px;border:1px solid #f85149;'
    + 'border-radius:10px;background:#1b1416;color:#e6e9ef;'
    + 'font:14px/1.6 "Segoe UI Variable","Segoe UI","Microsoft YaHei",sans-serif;';

  const heading = document.createElement('h2');
  heading.textContent = 'Agent 界面没能载入';
  heading.style.cssText = 'margin:0 0 8px;font-size:16px;color:#f85149;';

  const message = document.createElement('p');
  message.textContent = String((error && error.message) || error);
  message.style.cssText = 'margin:0 0 10px;white-space:pre-wrap;word-break:break-word;';

  const hint = document.createElement('p');
  hint.textContent = '自检：GET /agent.css 与 GET /agent/index.js 都应返回 200。'
    + '若返回 404，说明服务端静态白名单还没放行 /agent/（packages/app/src/server.ts）；'
    + '修好后点「重试」，不用刷新页面。';
  hint.style.cssText = 'margin:0 0 12px;color:#9aa4b2;font-size:12.5px;';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '重试';
  button.style.cssText = 'height:30px;padding:0 14px;border-radius:8px;border:1px solid #4c8dff;'
    + 'background:#4c8dff;color:#fff;font:inherit;font-weight:600;cursor:pointer;';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '载入中…';
    retry();
  });

  box.append(heading, message, hint, button);
  root.innerHTML = '';
  root.appendChild(box);
}

export async function mount(root, ctx = {}) {
  try {
    const module = await import('../agent/index.js');
    if (!module || typeof module.mount !== 'function') {
      throw new Error('web/agent/index.js 没有导出 mount(root, ctx)');
    }
    return await module.mount(root, ctx);
  } catch (error) {
    renderLoadError(root, error, () => mount(root, ctx));
    // 让外壳的控制台也能看到，但不把异常再抛给不会 await 的调用方
    console.error('[agent] 工作台挂载失败：', error);
    return undefined;
  }
}
