/**
 * Playback panel — the suite's transport bar (`view/playbackcontrol/playbackcontrol.html`)
 * driving the local `PlaybackEngine` over `/api/playback/*`.
 *
 * Transcription of the original bar:
 *   `.playback-controls` > `.player`
 *     `.progress-bar` > `.timeline` > `#playbackscrub`      scrub strip + handle
 *     `.playback-events`                                    one tick per record
 *     `.snippet`                                            the exported range
 *     `.row.player-footer` > `.left-controls` `.startEnddate`
 *                            `.middle-controls` `.rewind` `.play-pause` `.time-timeline`
 *                            `.right-controls` `.speed-section` `.snippet-section`
 * The dark bar is the suite's own (style.css `.player` is `rgba(0,0,0,.87)`); the cards
 * under it reuse Convert/Manage's light surfaces.
 *
 * Contract: `mount(root, ctx)` / `unmount(root)`, ctx = { api, capture, onCaptureChange }.
 */

const CSS_URL = new URL('./playback.css', import.meta.url).href;
const CSS_ID = 'nas-panel-playback-css';

/** Snippet band + tick colours, all taken from style.css (timeline cyan, teal, amber, red). */
const TICK_COLORS = ['#00abc8', '#27a0bf', '#7fd3e8', '#f5a623', '#d0021b', '#9b9b9b', '#ffffff'];

/* ---------------- helpers ---------------- */

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function withQuery(path, params) {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

function defaultApi() {
  const request = async (path, init) => {
    const response = await fetch(path, init);
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  };
  return {
    get: (path, params) => request(withQuery(path, params)),
    post: (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function clockText(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

function utcClock(iso) {
  if (!iso) return '--:--:--';
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return match ? match[1] : String(iso);
}

function fixed(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** `data-el="frame-body"` becomes `el.frameBody`. */
function collect(root) {
  const map = {};
  for (const node of root.querySelectorAll('[data-el]')) {
    map[node.dataset.el.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = node;
  }
  return map;
}

/* ---------------- markup ---------------- */

function template(speedOptions) {
  return `
<div class="notice" data-el="error" hidden></div>

<div class="selected-file-info">
  <div class="sel-files-view single-file-view">
    <label class="single-file-msg">Playback file:</label>
    <select class="playback-capture" data-el="capture" aria-label="Capture file"></select>
    <label class="size-colon">Speed:</label>
    <select class="playback-speed" data-el="speed" aria-label="Playback speed">${speedOptions}</select>
    <button type="button" class="btn btn-default darkBtn" data-el="load">Load timeline</button>
  </div>
  <p class="pb-meta" data-el="meta">Reading capture list…</p>
</div>

<div class="playback-controls" id="controls">
  <div class="player">
    <div class="progress-bar" data-el="bar" role="slider" tabindex="0"
         aria-label="Playback position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
      <div class="timeline" data-el="fill">
        <div id="playbackscrub" data-el="scrub"></div>
      </div>
      <div class="snippet" data-el="snippet" hidden></div>
      <div class="playback-events" data-el="ticks"></div>
    </div>

    <div class="row player-footer">
      <div class="left-controls">
        <div class="startEnddate">
          <span>
            <span>Start </span><span data-el="start">--:--:--</span>
            <span> End </span><span data-el="end">--:--:--</span>
          </span>
        </div>
      </div>

      <div class="middle-controls">
        <button class="rewind" type="button" data-el="rewind" aria-label="Back 30 seconds"></button>
        <button class="play-pause playControl pause" type="button" data-el="play" aria-label="Play"></button>
        <span class="time-timeline">
          <span data-el="clock">0:00.000</span><span> | </span><span data-el="duration">0:00.000</span>
        </span>
      </div>

      <div class="right-controls">
        <div class="speed-section">
          <label data-el="speed-label">Speed</label>
          <div class="dropdown speed-dropdown">
            <span class="speed-value" data-el="speed-value">1x</span>
            <span class="caret"></span>
          </div>
        </div>
        <div class="snippet-section">
          <button class="btn createSnippet darkBtn" type="button" data-el="snippet-btn">Create Snippet</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="pb-cards">
  <div class="tile pb-frame-tile">
    <div class="pb-header">
      <span class="heading" data-el="frame-title">Current Frame</span>
      <span class="pb-frame-note" data-el="frame-note">No timeline loaded</span>
    </div>
    <div class="pb-frame-body" data-el="frame-body">
      <p class="pb-empty">Load a timeline to decode the record under the play head.</p>
    </div>
  </div>

  <div class="tile pb-snippet-tile">
    <div class="pb-header">
      <span class="heading">Snippet</span>
      <span class="pb-frame-note" data-el="snippet-note">Pick a range, then download the raw SBF slice.</span>
    </div>
    <div class="pb-range-row">
      <label class="pb-field"><span>From (s)</span>
        <input type="number" data-el="from" min="0" step="0.001" value="0">
      </label>
      <label class="pb-field"><span>To (s)</span>
        <input type="number" data-el="to" min="0" step="0.001" value="0">
      </label>
      <button type="button" class="btn btn-default darkBtn" data-el="download" disabled>Download SBF</button>
    </div>
    <p class="pb-hint">
      Records are copied verbatim between the two offsets — CRCs are never recomputed.
    </p>
  </div>
</div>`;
}

/* ---------------- mount / unmount ---------------- */

export function unmount(root) {
  if (!root) return;
  const cleanup = root.__playbackCleanup;
  if (typeof cleanup === 'function') cleanup();
  root.__playbackCleanup = null;
}

export function mount(root, ctx = {}) {
  unmount(root);
  ensureCss();

  const api = ctx.api && typeof ctx.api.get === 'function' ? ctx.api : defaultApi();

  const speeds = [0.5, 1, 2, 4, 8];
  root.classList.add('playback-panel');
  root.innerHTML = template(
    speeds.map((value) => `<option value="${value}">${value}×</option>`).join(''),
  );
  const el = collect(root);
  el.speed.value = '1';

  const state = {
    alive: true,
    capture: typeof ctx.capture === 'string' ? ctx.capture : '',
    captures: [],
    loaded: false,
    info: null,
    frames: [],
    duration: 0,
    time: 0,
    speed: 1,
    playing: false,
    raf: 0,
    last: 0,
    detailIndex: -1,
    detailPending: false,
    pendingDetail: null,
    from: 0,
    to: 0,
  };

  function alert(message) {
    if (!message) {
      el.error.hidden = true;
      el.error.textContent = '';
      return;
    }
    el.error.hidden = false;
    el.error.textContent = message;
  }

  /* ---- capture list ---- */

  function fillCaptures() {
    el.capture.innerHTML = state.captures.length
      ? state.captures
          .map((item) => `<option value="${esc(item.path)}">${esc(`${item.name} · ${bytesText(item.bytes)}`)}</option>`)
          .join('')
      : '<option value="">(no capture under samples/)</option>';
    if (state.capture && state.captures.some((item) => item.path === state.capture)) {
      el.capture.value = state.capture;
    } else if (state.captures.length) {
      const preferred =
        state.captures.find((item) => item.path === 'convert/clean-9600.gps') ||
        state.captures.find((item) => item.name === 'clean-9600.gps') ||
        state.captures[0];
      state.capture = preferred.path;
      el.capture.value = preferred.path;
    }
  }

  /* ---- timeline ---- */

  function frameIndexAt(seconds) {
    const frames = state.frames;
    if (!frames.length) return -1;
    const target = seconds * 1000 + 0.5;
    let low = 0;
    let high = frames.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid].offsetMs <= target) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function renderTicks() {
    if (!state.frames.length || !state.duration) {
      el.ticks.innerHTML = '';
      return;
    }
    const colors = {};
    const parts = [];
    for (const frame of state.frames) {
      const key = String(frame.messageId);
      if (!colors[key]) colors[key] = TICK_COLORS[Object.keys(colors).length % TICK_COLORS.length];
      const left = (frame.offsetMs / (state.duration * 1000)) * 100;
      parts.push(
        `<span class="pb-tick" title="${esc(`${frame.name} #${frame.index + 1} · ${(frame.offsetMs / 1000).toFixed(3)} s`)}" ` +
          `style="left:${left.toFixed(3)}%;background:${colors[key]}"></span>`,
      );
    }
    el.ticks.innerHTML = parts.join('');
  }

  function renderSnippet() {
    if (!state.loaded || !state.duration) {
      el.snippet.hidden = true;
      return;
    }
    const from = Math.min(Math.max(state.from, 0), state.duration);
    const to = Math.min(Math.max(state.to, 0), state.duration);
    if (to <= from) {
      el.snippet.hidden = true;
      return;
    }
    el.snippet.hidden = false;
    el.snippet.style.left = `${((from / state.duration) * 100).toFixed(3)}%`;
    el.snippet.style.width = `${(((to - from) / state.duration) * 100).toFixed(3)}%`;
  }

  function renderClock() {
    const ratio = state.duration ? state.time / state.duration : 0;
    el.fill.style.width = `${(ratio * 100).toFixed(4)}%`;
    el.clock.textContent = clockText(state.time);
    el.duration.textContent = clockText(state.duration);
    el.bar.setAttribute('aria-valuenow', state.time.toFixed(3));
    el.bar.setAttribute('aria-valuemax', state.duration.toFixed(3));
    el.bar.setAttribute('aria-valuetext', `${clockText(state.time)} of ${clockText(state.duration)}`);
  }

  function setPlayButton() {
    el.play.classList.toggle('pause', !state.playing);
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.play.disabled = !state.loaded;
  }

  function renderFrameHead(frame) {
    el.frameTitle.textContent = `Current Frame · ${frame.name} · #${frame.index + 1} / ${state.frames.length}`;
    el.frameNote.textContent = `offset ${clockText(frame.time)} · ${frame.bytes} B record`;
  }

  function renderFrameFields(data) {
    if (!data.fields.length) {
      el.frameBody.innerHTML =
        '<p class="pb-empty">No EDIE layout for this message — only the SBF header is available.</p>';
      return;
    }
    const rows = data.fields
      .slice(0, 14)
      .map((field) => {
        const shown = field.text === undefined || field.text === null || field.text === '' ? String(field.value) : field.text;
        return `<tr><td class="path">${esc(field.path)}</td><td class="shown">${esc(shown)}</td></tr>`;
      })
      .join('');
    el.frameBody.innerHTML =
      '<div class="pb-frame-table-wrap"><table class="g3-devicedetails-table pb-frame-table"><tbody>' +
      rows +
      '</tbody></table></div>' +
      `<p class="pb-hint">${data.fields.length} of ${data.fieldTotal} fields${data.fieldsTruncated ? ' (decoder cap)' : ''}` +
      ` · UTC ${esc(data.utc || '—')}${data.layoutKnown ? '' : ' · no EDIE layout'}</p>`;
  }

  function fetchFrameDetail(index) {
    if (state.detailPending) {
      state.pendingDetail = index;
      return;
    }
    state.detailPending = true;
    api
      .get('/api/playback/frame', { capture: state.capture, index })
      .then((data) => {
        if (!state.alive || state.detailIndex !== index) return;
        renderFrameFields(data);
      })
      .catch(() => {
        /* a frame that scrolled out while the request was in flight is not worth a banner */
      })
      .finally(() => {
        state.detailPending = false;
        const next = state.pendingDetail;
        state.pendingDetail = null;
        if (state.alive && next !== null && next !== index) fetchFrameDetail(next);
      });
  }

  function updateCurrentFrame() {
    const index = frameIndexAt(state.time);
    if (index < 0) return;
    if (index === state.detailIndex) return;
    state.detailIndex = index;
    renderFrameHead(state.frames[index]);
    el.frameBody.innerHTML = '<p class="pb-empty">Decoding…</p>';
    fetchFrameDetail(index);
  }

  function setTime(seconds) {
    if (!state.loaded) return;
    state.time = Math.min(Math.max(seconds, 0), state.duration);
    renderClock();
    updateCurrentFrame();
  }

  function stop() {
    state.playing = false;
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    setPlayButton();
  }

  function tick(now) {
    if (!state.playing) return;
    if (!state.last) state.last = now;
    let delta = now - state.last;
    state.last = now;
    if (delta > 250) delta = 250; // tab was hidden: never jump the whole capture
    setTime(state.time + (delta * state.speed) / 1000);
    if (state.time >= state.duration - 1e-9) {
      stop();
      el.frameNote.textContent = `end of capture · ${clockText(state.duration)}`;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!state.loaded || state.playing) return;
    if (state.time >= state.duration - 1e-9) setTime(0);
    state.playing = true;
    state.last = 0;
    setPlayButton();
    state.raf = requestAnimationFrame(tick);
  }

  /* ---- snippet / export ---- */

  function exportUrl(from, to) {
    return withQuery('/api/playback/export', { capture: state.capture, from: from.toFixed(3), to: to.toFixed(3) });
  }

  function syncSnippet() {
    const from = Number(el.from.value);
    const to = Number(el.to.value);
    if (!state.loaded) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Load a timeline first.';
      return;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from > to) {
      el.download.disabled = true;
      el.snippetBtn.disabled = true;
      el.snippetNote.textContent = 'Invalid range: need 0 ≤ from ≤ to.';
      return;
    }
    state.from = from;
    state.to = Math.min(to, state.duration);
    renderSnippet();
    el.download.disabled = false;
    el.snippetBtn.disabled = false;
    el.snippetNote.textContent =
      `[ ${from.toFixed(3)} s , ${state.to.toFixed(3)} s ] of ${clockText(state.duration)}` +
      ` · ${((state.to - from) / (state.duration || 1) * 100).toFixed(1)}% of the capture`;
  }

  function download(from, to) {
    if (!state.loaded) return;
    const anchor = document.createElement('a');
    anchor.href = exportUrl(from, to);
    const stem = (state.capture.split('/').pop() || 'capture').replace(/\.[^.]+$/, '');
    anchor.download = `${stem}_${from.toFixed(3)}-${to.toFixed(3)}.sbf`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  /* ---- load ---- */

  async function load() {
    if (!state.capture) {
      alert('No capture file selected.');
      return;
    }
    stop();
    alert('');
    el.load.disabled = true;
    el.meta.textContent = 'Reading timeline…';
    try {
      const [info, frames] = await Promise.all([
        api.get('/api/playback/info', { capture: state.capture }),
        api.post('/api/playback/frames', { capture: state.capture }),
      ]);
      if (!state.alive) return;
      state.info = info;
      state.frames = frames.frames ?? [];
      state.duration = (info.durationMs || 0) / 1000;
      state.loaded = true;
      state.time = 0;
      state.detailIndex = -1;
      state.pendingDetail = null;
      state.speed = Number(el.speed.value) || 1;

      const options = (info.speeds ?? speeds).map((value) => `<option value="${value}">${value}×</option>`).join('');
      el.speed.innerHTML = options;
      el.speed.value = String(state.speed);
      el.speedValue.textContent = `${state.speed}x`;

      el.start.textContent = utcClock(info.startUtc);
      el.end.textContent = utcClock(info.finishUtc);
      el.from.value = '0';
      el.to.value = state.duration.toFixed(3);

      renderTicks();
      setPlayButton();
      setTime(0);
      syncSnippet();

      const counts = (info.messageCounts ?? []).map((item) => `${item.name} ${item.count}`).join(' · ');
      el.meta.textContent =
        `${info.capture} · ${bytesText(info.bytes)} · ${info.frameCount} frames · ` +
        `${state.duration.toFixed(3)} s · ${info.startUtc || '—'} → ${info.finishUtc || '—'} UTC` +
        (counts ? ` · ${counts}` : '') +
        (info.stats?.badCrc ? ` · ${info.stats.badCrc} bad CRC` : '');
    } catch (error) {
      if (!state.alive) return;
      state.loaded = false;
      state.frames = [];
      state.duration = 0;
      el.ticks.innerHTML = '';
      el.snippet.hidden = true;
      el.frameBody.innerHTML = '<p class="pb-empty">No timeline loaded.</p>';
      el.meta.textContent = '—';
      alert(`Timeline failed: ${error.message}`);
      setPlayButton();
    } finally {
      el.load.disabled = false;
    }
  }

  /* ---- pointer + keyboard on the scrub strip ---- */

  function seekFromEvent(event) {
    const rect = el.bar.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    setTime(ratio * state.duration);
  }

  let dragging = false;
  const onBarDown = (event) => {
    if (!state.loaded) return;
    event.preventDefault();
    dragging = true;
    stop();
    seekFromEvent(event);
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
  };
  const onDocMove = (event) => {
    if (dragging) seekFromEvent(event);
  };
  const onDocUp = () => {
    dragging = false;
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', onDocUp);
  };
  const onBarKey = (event) => {
    if (!state.loaded) return;
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setTime(state.time + step);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setTime(state.time - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setTime(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setTime(state.duration);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (state.playing) stop();
      else play();
    }
  };

  const onPlay = () => {
    if (state.playing) stop();
    else play();
  };
  const onRewind = () => {
    if (!state.loaded) return;
    stop();
    setTime(state.time - 30);
  };
  const onSpeed = () => {
    state.speed = Number(el.speed.value) || 1;
    el.speedValue.textContent = `${state.speed}x`;
    state.last = 0;
  };
  const onLoad = () => load();
  const onCapture = () => {
    state.capture = el.capture.value;
    load();
  };
  const onRange = () => syncSnippet();
  const onDownload = () => download(state.from, state.to);
  const onSnippet = () => download(state.from, state.to);

  el.bar.addEventListener('mousedown', onBarDown);
  el.bar.addEventListener('keydown', onBarKey);
  el.play.addEventListener('click', onPlay);
  el.rewind.addEventListener('click', onRewind);
  el.speed.addEventListener('change', onSpeed);
  el.load.addEventListener('click', onLoad);
  el.capture.addEventListener('change', onCapture);
  el.from.addEventListener('change', onRange);
  el.to.addEventListener('change', onRange);
  el.download.addEventListener('click', onDownload);
  el.snippetBtn.addEventListener('click', onSnippet);

  let offCapture = null;
  if (typeof ctx.onCaptureChange === 'function') {
    const unsubscribe = ctx.onCaptureChange((name) => {
      if (!name || name === state.capture) return;
      state.capture = name;
      if (state.captures.some((item) => item.path === name)) el.capture.value = name;
      load();
    });
    if (typeof unsubscribe === 'function') offCapture = unsubscribe;
  }

  root.__playbackCleanup = () => {
    state.alive = false;
    stop();
    onDocUp();
    el.bar.removeEventListener('mousedown', onBarDown);
    el.bar.removeEventListener('keydown', onBarKey);
    el.play.removeEventListener('click', onPlay);
    el.rewind.removeEventListener('click', onRewind);
    el.speed.removeEventListener('change', onSpeed);
    el.load.removeEventListener('click', onLoad);
    el.capture.removeEventListener('change', onCapture);
    el.from.removeEventListener('change', onRange);
    el.to.removeEventListener('change', onRange);
    el.download.removeEventListener('click', onDownload);
    el.snippetBtn.removeEventListener('click', onSnippet);
    if (offCapture) offCapture();
  };

  setPlayButton();

  api
    .get('/api/captures')
    .then((data) => {
      if (!state.alive) return;
      state.captures = data.captures ?? [];
      fillCaptures();
      return load();
    })
    .catch((error) => {
      if (!state.alive) return;
      alert(`Capture list failed: ${error.message}`);
      el.meta.textContent = '—';
    });
}

export default { mount, unmount };
