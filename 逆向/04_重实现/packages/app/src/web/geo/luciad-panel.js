/**
 * The **panel side** of the LuciadRIA stage contract — the one place a panel boots the iframe and
 * speaks its `postMessage` protocol.
 *
 * The engine lives in `/geo/luciad-stage.html` (+ `/geo/luciad-engine.js`, the shipped Graph bundle
 * with its React mount cut off), so a panel never imports the engine itself. It only:
 *
 *   1. points the iframe at the stage document and waits for `{type:'ready'}` (or `{type:'error'}`,
 *      or a timeout — a 16 MB module plus a wasm boot can stall, and a panel that waits forever
 *      would sit on "正在启动…" instead of saying why it fell back);
 *   2. sends the decoration profile (`graph` | `grit`) once the stage is ready — the panel never
 *      builds its own legend out of the stage's features;
 *   3. pushes the track / cursor / camera messages the stage documents.
 *
 * `luciad-stage.js` is the other half: keep the two message lists in sync. Nothing here touches the
 * DOM until a function is called, so the module is importable from Node tests.
 */

/**
 * What each panel asks for besides the track itself. `graph` is the Overview map (degree labels for
 * its graticule); `grit` is "position and track only" — same grid, same scale bar, no degree labels.
 * The stage's own table (`STAGE_PROFILES` in `luciad-stage.js`) is the authority; this is the copy a
 * panel sends and a test can read.
 */
export const STAGE_PROFILES = {
  graph: { graticule: true, labels: true, metric: true, scale: true, north: true },
  grit: { graticule: true, labels: false, metric: true, scale: true, north: true },
};

/** The decoration set of one profile, as a fresh object (never share the table's own). */
export function stageChrome(profile) {
  const base = STAGE_PROFILES[profile] || STAGE_PROFILES.graph;
  return { ...base };
}

/**
 * `{type:'profile'}` for a panel — the message that turns the shared stage into "this panel's map".
 * Pure, so the protocol can be pinned by a test without a browser.
 */
export function profileMessage(profile, overrides) {
  const chrome = stageChrome(profile);
  if (overrides && typeof overrides === 'object') {
    for (const flag of Object.keys(chrome)) {
      if (typeof overrides[flag] === 'boolean') chrome[flag] = overrides[flag];
    }
  }
  return { type: 'profile', profile: STAGE_PROFILES[profile] ? profile : 'graph', chrome };
}

/**
 * Boot and drive one stage iframe.
 *
 * @param {object} options
 * @param {HTMLIFrameElement} options.frame      the iframe the panel owns
 * @param {string} options.url                   `LUCIAD_STAGE_URL`
 * @param {string} [options.profile]             'graph' (default) | 'grit'
 * @param {number} [options.timeoutMs]           give up after this long without `ready`
 * @param {object} [options.window]              the window that owns the iframe (default `globalThis`)
 * @param {(data:object)=>void} [options.onReady]
 * @param {(reason:string)=>void} [options.onError]
 * @param {(data:object)=>void} [options.onView]
 * @param {(data:object)=>void} [options.onHover]
 * @param {(data:object)=>void} [options.onCursor]
 * @param {(data:object)=>void} [options.onProfile]  the stage's echo of the applied decoration set
 */
export function createStageClient(options) {
  const opts = options || {};
  const win = opts.window ?? globalThis;
  const frame = opts.frame;
  const url = opts.url;
  const origin = new URL(url, win.location ? win.location.href : 'http://localhost/').origin;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 30_000;

  const state = {
    status: 'idle', // idle | booting | ready | failed
    error: '',
    profile: opts.profile === 'grit' ? 'grit' : 'graph',
    /** What the stage reported: `{ reference, webgpu, profile }`. */
    view: null,
  };

  let timer = 0;

  function clearTimer() {
    if (timer) win.clearTimeout(timer);
    timer = 0;
  }

  function post(message) {
    if (state.status !== 'ready') return false;
    const target = frame && frame.contentWindow;
    if (!target) return false;
    target.postMessage(message, origin);
    return true;
  }

  function fail(reason) {
    if (state.status === 'failed') return;
    state.status = 'failed';
    state.error = String(reason || '未知原因').slice(0, 240);
    clearTimer();
    if (frame) frame.hidden = true;
    opts.onError?.(state.error);
  }

  function onMessage(event) {
    const target = frame && frame.contentWindow;
    if (!target || event.source !== target) return;
    const data = event.data || {};
    if (data.type === 'ready') {
      clearTimer();
      state.status = 'ready';
      state.view = {
        reference: data.reference,
        webgpu: data.webgpu,
        profile: data.profile,
      };
      /* The decoration set goes first: the stage then draws its graticule with the right flags on
       * the first `track` it receives after this. */
      post(profileMessage(state.profile));
      opts.onReady?.(state.view);
      return;
    }
    if (data.type === 'profile') {
      state.view = { ...state.view, profile: data.profile, chrome: data.chrome };
      opts.onProfile?.(data);
      return;
    }
    if (data.type === 'error') {
      fail(data.message || '引擎启动失败');
      return;
    }
    if (data.type === 'view') {
      state.view = { ...state.view, ...data };
      opts.onView?.(data);
      return;
    }
    if (data.type === 'hover') {
      opts.onHover?.(data);
      return;
    }
    if (data.type === 'cursor') opts.onCursor?.(data);
  }

  return {
    state,
    /** Point the iframe at the stage. Idempotent — a second call while booting does nothing. */
    start() {
      if (state.status === 'booting' || state.status === 'ready' || !frame) return;
      state.status = 'booting';
      state.error = '';
      win.removeEventListener('message', onMessage);
      win.addEventListener('message', onMessage);
      timer = win.setTimeout(() => {
        fail(`引擎 ${Math.round(timeoutMs / 1000)} 秒内没有就绪`);
      }, timeoutMs);
      frame.hidden = true;
      frame.src = url;
    },
    /** Detach: drop the timer, the listener and the document the iframe was holding. */
    stop() {
      clearTimer();
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('message', onMessage);
      }
      state.status = 'idle';
      state.view = null;
      if (frame && frame.getAttribute && frame.getAttribute('src') !== 'about:blank') {
        frame.src = 'about:blank';
      }
    },
    /** Switch decorations; sent at once when ready, otherwise once the `ready` arrives. */
    setProfile(profile, overrides) {
      if (profile === 'graph' || profile === 'grit') state.profile = profile;
      post(profileMessage(state.profile, overrides));
    },
    post,
    /**
     * The whole track. `fit: true` fits the camera to the fixes; without it the stage keeps its
     * own camera (a live session must not yank the view on every fix).
     */
    sendTrack(points, extra) {
      const list = Array.isArray(points) ? points : [];
      return post({
        type: 'track',
        points: list.map((point) => [point.lon, point.lat]),
        sigmaM: Number(extra && extra.sigmaM) || 0,
        trackColor: extra && extra.trackColor,
        fit: Boolean(extra && extra.fit),
      });
    },
    sendCursor(index) {
      return post({ type: 'cursor', index: Number.isInteger(index) ? index : -1 });
    },
    send(message) {
      return post(message);
    },
    /** For a browser check: what this panel believes and what the stage last said. */
    status() {
      return {
        ...state,
        frame: frame ? { src: frame.getAttribute ? frame.getAttribute('src') : '', hidden: frame.hidden } : null,
      };
    },
  };
}
