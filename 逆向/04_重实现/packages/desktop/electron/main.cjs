'use strict';

/**
 * Electron shell for the Field Station console — the heavy half of `packages/desktop/`.
 *
 * It owns what the batch launcher owns, with a window instead of a browser tab: adopt a live
 * instance or spawn `packages/app/src/server.ts` on the first free candidate port, load
 * `http://127.0.0.1:<port>/`, and kill the child it started when the app quits.
 *
 * Written for whatever Electron the machine actually has. The runtime found here is Electron 8
 * (Chromium 80, Node 12) out of the DaVinci Resolve install, so:
 *   - every module is required WITHOUT the `node:` prefix (Node 12 rejects it);
 *   - no optional chaining / nullish coalescing / `Array.at` / `String.replaceAll`;
 *   - `webContents.setWindowOpenHandler` (Electron 12+) is feature-detected, not assumed;
 *   - type-stripped `.ts` needs Node >= 22.6, which Electron 8's bundled Node is not, so the
 *     server child is run by a real `node` — `FIELD_STATION_NODE`, else PATH.
 *
 * The port arithmetic is duplicated from `src/launcher.ts` on purpose: this file is CommonJS and
 * must run with no build step, and the duplication is five lines (see README.md).
 */

var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var Menu = electron.Menu;
var dialog = electron.dialog;
var ipcMain = electron.ipcMain;

var spawn = require('child_process').spawn;
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var DESKTOP_DIR = path.resolve(__dirname, '..');
/** `<repo>/逆向/04_重实现` — mirrors IMPL_DIR in src/launcher.ts. */
var IMPL_DIR = path.resolve(DESKTOP_DIR, '..', '..');
var SERVER_PATH = path.join(IMPL_DIR, 'packages', 'app', 'src', 'server.ts');
var PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

var SERVICE_ID = 'nas-reimpl-app';
var DEFAULT_PORT = 7788;
var PORT_ATTEMPTS = 5;
var READY_TIMEOUT_MS = 30000;
var LOG_LIMIT_BYTES = 200 * 1024;

var serverChild = null;
var serverPort = null;
var mainWindow = null;
var quitting = false;
var exitCode = 0;

// Electron 8 prints a deprecation warning about this default; Electron 9 flips it anyway.
app.allowRendererProcessReuse = true;

// ---------------------------------------------------------------- logging

var LOG_FILE = process.env.FIELD_STATION_LOG_DIR
  ? path.join(process.env.FIELD_STATION_LOG_DIR, 'electron.log')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FieldStation', 'electron.log');

function log(message) {
  var line = new Date().toISOString() + ' [electron] ' + message + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    var size = 0;
    try {
      size = fs.statSync(LOG_FILE).size;
    } catch (error) {
      size = 0;
    }
    if (size + Buffer.byteLength(line) > LOG_LIMIT_BYTES) {
      var kept = fs.readFileSync(LOG_FILE);
      var from = Math.max(0, kept.length - (LOG_LIMIT_BYTES - Buffer.byteLength(line)));
      var newline = kept.indexOf(10, from);
      fs.writeFileSync(LOG_FILE, kept.slice(newline >= 0 ? newline + 1 : from));
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (error) {
    /* logging must never be the reason the app fails */
  }
  try {
    process.stdout.write(line);
  } catch (error) {
    /* no console when started by double-click */
  }
}

// ---------------------------------------------------------------- server

function urlFor(port) {
  return 'http://127.0.0.1:' + port + '/';
}

function candidatePorts() {
  var preferred = parseInt(process.env.FIELD_STATION_PORT || '', 10);
  var start = isFinite(preferred) && preferred > 0 && preferred < 65536 ? preferred : DEFAULT_PORT;
  var ports = [];
  for (var i = 0; i < PORT_ATTEMPTS; i++) ports.push(start + i);
  return ports;
}

/** One `/api/health` call; false for "not ours", "nothing there" and "too slow" alike. */
function isRunning(port, timeout) {
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    var request = http.get(
      { host: '127.0.0.1', port: port, path: '/api/health', timeout: timeout || 600 },
      function (response) {
        var body = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
          body += chunk;
          if (body.length > 8192) {
            request.abort();
            finish(false);
          }
        });
        response.on('end', function () {
          try {
            finish(response.statusCode === 200 && JSON.parse(body).service === SERVICE_ID);
          } catch (error) {
            finish(false);
          }
        });
        response.on('error', function () {
          finish(false);
        });
      },
    );
    request.on('timeout', function () {
      request.abort();
      finish(false);
    });
    request.on('error', function () {
      finish(false);
    });
  });
}

/**
 * How to run Node source from inside Electron. `ELECTRON_RUN_AS_NODE` reuses our own executable,
 * which is the only path when there is no standalone `node` — but it only works when the bundled
 * Node can strip types (>= 22.6, i.e. Electron >= 37). Electron 8 bundles Node 12, so it has to
 * fall back to a real `node` on PATH, and say so clearly when there is none.
 */
function nodeCommand() {
  var override = process.env.FIELD_STATION_NODE;
  if (override) {
    return { command: override, args: [], env: {}, label: 'FIELD_STATION_NODE=' + override };
  }

  var parts = String(process.versions.node).split('.');
  var major = parseInt(parts[0], 10);
  var minor = parseInt(parts[1], 10);
  var stripsTypes = major > 22 || (major === 22 && minor >= 6);

  if (stripsTypes) {
    var args = major === 22 && minor < 18 ? ['--experimental-strip-types'] : [];
    return {
      command: process.execPath,
      args: args,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: 'electron ' + process.versions.electron + ' acting as node ' + process.versions.node,
    };
  }

  return {
    command: 'node',
    args: [],
    env: {},
    label: 'system node from PATH (electron ' + process.versions.electron + ' bundles node ' + process.versions.node + ')',
  };
}

function waitForReady(child, port) {
  return new Promise(function (resolve) {
    var settled = false;
    var stderr = '';
    var finish = function (ok, reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ ok: ok, reason: reason });
    };

    var timer = setTimeout(function () {
      finish(false, 'not ready after ' + READY_TIMEOUT_MS + ' ms');
    }, READY_TIMEOUT_MS);

    var poll = setInterval(function () {
      isRunning(port).then(function (alive) {
        if (alive) finish(true, 'health probe');
      });
    }, 150);

    if (child.stdout) {
      child.stdout.on('data', function () {});
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function (chunk) {
        stderr += chunk;
      });
    }
    child.once('error', function (error) {
      finish(false, 'spawn failed: ' + error.message + (error.code ? ' (' + error.code + ')' : ''));
    });
    child.once('exit', function (code) {
      var tail = stderr.trim().split(/\r?\n/).slice(-2).join(' | ');
      finish(false, 'exited with code ' + code + (tail ? ': ' + tail : ''));
    });
  });
}

/** Mirror the server's stdout/stderr into the same log, one timestamped line each. */
function pipeServerLogs(child) {
  var attach = function (stream, tag) {
    if (!stream) return;
    var buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', function (chunk) {
      buffer += chunk;
      var lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim()) log('[' + tag + '] ' + lines[i]);
      }
    });
  };
  attach(child.stdout, 'server');
  attach(child.stderr, 'server');
}

function startServer() {
  var candidates = candidatePorts();

  return (async function () {
    for (var i = 0; i < candidates.length; i++) {
      if (await isRunning(candidates[i])) return { port: candidates[i], reused: true };
    }

    var node = nodeCommand();
    log('starting server via ' + node.label + ', candidates ' + candidates.join(','));
    var failures = [];

    for (var j = 0; j < candidates.length; j++) {
      var port = candidates[j];
      var env = Object.assign({}, process.env, node.env, { PORT: String(port) });
      var child = spawn(node.command, node.args.concat([SERVER_PATH, '--port', String(port)]), {
        cwd: IMPL_DIR,
        env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      pipeServerLogs(child);
      var ready = await waitForReady(child, port);
      if (ready.ok) {
        serverChild = child;
        log('server ready on ' + urlFor(port) + ' (' + ready.reason + '), pid ' + child.pid);
        child.once('exit', function (code, signal) {
          log('server exited code=' + code + ' signal=' + signal);
        });
        return { port: port, reused: false };
      }
      log('port ' + port + ' unusable: ' + ready.reason);
      failures.push('端口 ' + port + '：' + ready.reason);
      try {
        child.kill();
      } catch (error) {
        /* already gone */
      }
      if (ready.reason.indexOf('ENOENT') >= 0) {
        throw new Error(
          '找不到 node.exe（Electron 自带的 Node 太旧，跑不了 .ts）。\n' +
            '请安装 Node.js 22.6+ 并加入 PATH，或用 FIELD_STATION_NODE 指向 node.exe。\n' +
            '当前尝试：' + node.label,
        );
      }
    }
    throw new Error('没有可用端口（' + candidates.join('、') + '）\n' + failures.join('\n'));
  })();
}

/** Only used to make the log say what it looked at; ports are probed right after. */
function importCandidates(candidates) {
  log('candidate ports: ' + candidates.join(', '));
}

// ---------------------------------------------------------------- window

function createWindow(port, reused) {
  var url = urlFor(port);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: '野外台站智能体 · 重实现控制台',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 8 defaults this to true and then warns in the console about it.
      enableRemoteModule: false,
      // Electron 8's sandboxed preloads are a 2020-era code path; the bridge needs no sandbox.
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', function () {
    if (mainWindow) mainWindow.show();
  });
  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  // Electron 12+ only; on Electron 8 the old `new-window` event is the equivalent.
  if (typeof mainWindow.webContents.setWindowOpenHandler === 'function') {
    mainWindow.webContents.setWindowOpenHandler(function () {
      return { action: 'deny' };
    });
  }

  mainWindow.webContents.on('did-finish-load', function () {
    log('did-finish-load ' + url);
    captureOnce();
  });
  mainWindow.webContents.on('did-fail-load', function (event, code, description, validatedUrl) {
    log('did-fail-load ' + code + ' ' + description + ' ' + validatedUrl);
    if (quitting) return;
    dialog.showErrorBox('加载失败', String(validatedUrl) + '\n' + code + ' ' + description);
  });
  mainWindow.webContents.on('console-message', function (event, level, message, line, sourceId) {
    log('console[' + level + '] ' + sourceId + ':' + line + ' ' + message);
  });
  mainWindow.webContents.on('render-process-gone', function (event, details) {
    log('render-process-gone ' + JSON.stringify(details));
  });

  mainWindow.loadURL(url);
  log((reused ? 'reuse' : 'ready') + ' ' + url);
}

/**
 * `FIELD_STATION_CAPTURE=<png>` writes one screenshot of the loaded page and is otherwise inert.
 * It exists because a screen grab is not evidence: on this machine any other window can be on top
 * of the app, and `CopyFromScreen` then saves somebody else's pixels. `capturePage` reads the
 * window's own surface, so the picture is always the thing under test.
 */
function captureOnce() {
  var target = process.env.FIELD_STATION_CAPTURE;
  if (!target || !mainWindow) return;
  setTimeout(function () {
    if (!mainWindow) return;
    mainWindow.webContents.capturePage().then(function (image) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      log('captured ' + target + ' (' + image.getSize().width + 'x' + image.getSize().height + ')');
    }).catch(function (error) {
      log('capture failed: ' + (error && error.message ? error.message : error));
    });
  }, 1200);
}

// ---------------------------------------------------------------- lifecycle

function stopServer() {
  if (!serverChild) return;
  var child = serverChild;
  serverChild = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  log('stopping server pid ' + child.pid);
  try {
    child.kill();
  } catch (error) {
    /* already gone */
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      /* nothing left */
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  ipcMain.handle('field-station:info', function () {
    return {
      port: serverPort,
      url: serverPort ? urlFor(serverPort) : null,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    };
  });

  ipcMain.handle('field-station:quit', function () {
    quitting = true;
    app.quit();
    return true;
  });

  app.on('window-all-closed', function () {
    quitting = true;
    app.quit();
  });

  app.on('before-quit', function () {
    quitting = true;
  });

  app.on('will-quit', function () {
    quitting = true;
    stopServer();
  });

  process.on('exit', stopServer);

  app.whenReady().then(function () {
    Menu.setApplicationMenu(null);
    log(
      'launch electron ' + process.versions.electron + ' (chromium ' + process.versions.chrome + ') node ' + process.versions.node,
    );
    return startServer().then(function (started) {
      serverPort = started.port;
      createWindow(started.port, started.reused);
    });
  }).catch(function (error) {
    log('startup failed: ' + (error && error.stack ? error.stack : error));
    dialog.showErrorBox('野外台站智能体启动失败', String((error && error.message) || error));
    exitCode = 1;
    quitting = true;
    app.exit(1);
  });
}

app.on('quit', function () {
  log('quit exitCode=' + exitCode);
});
