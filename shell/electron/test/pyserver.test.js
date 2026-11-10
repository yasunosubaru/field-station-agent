'use strict';
/**
 * `pyserver.js` 的测试 —— 不碰 Electron、不真起 Python 进程。
 *
 * 运行：
 *
 *   cd shell/electron && node --test test/pyserver.test.js
 *
 * ## 就绪协议为什么是 `RUNTIME_GATEWAY_READY <url>`
 *
 * 不是自创的：`src/fieldstation/runtimes/server.py` 的 `main()` 已经在 stdout 打这一行
 * （第 115 行）。外壳这里只是**照它的约定读**，不改 Python 侧的协议 —— 改协议要同时改
 * 那边和它的调用方，而外壳没有这个必要。
 *
 * 但那一行是在 `ThreadingHTTPServer` 绑定**之前**打的（server.py 里 `print` 在前、
 * `serve()` 在后）。端口被占时进程会先打出 READY 再崩，所以外壳还必须探一次 `/health`，
 * 否则会拿着一个根本没有监听的地址去开窗口。测试里专门钉了这一条。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const pyserver = require('../pyserver.js');

/* =============================================================================================
 * 一、就绪行解析
 * =========================================================================================== */

test('parseReadyLine 认 runtimes/server.py 的 RUNTIME_GATEWAY_READY <url>', () => {
  const parsed = pyserver.parseReadyLine('RUNTIME_GATEWAY_READY http://127.0.0.1:8788');
  assert.deepEqual(parsed, {
    prefix: 'RUNTIME_GATEWAY_READY',
    host: '127.0.0.1',
    port: 8788,
    url: 'http://127.0.0.1:8788',
  });
});

test('parseReadyLine 容忍行尾 \\r\\n 与前后空白', () => {
  assert.equal(pyserver.parseReadyLine('  RUNTIME_GATEWAY_READY http://127.0.0.1:9001\r\n').port, 9001);
  assert.equal(pyserver.parseReadyLine('RUNTIME_GATEWAY_READY   http://127.0.0.1:9002  ').port, 9002);
});

test('parseReadyLine 也认 READY <port> 与 AGENT_READY <port>（项目里已有的两种写法）', () => {
  assert.deepEqual(pyserver.parseReadyLine('READY 7803'), {
    prefix: 'READY', host: '127.0.0.1', port: 7803, url: 'http://127.0.0.1:7803',
  });
  assert.equal(pyserver.parseReadyLine('AGENT_READY 8811').port, 8811);
});

test('parseReadyLine 对普通日志行返回 null（不能把 [server] 日志当就绪）', () => {
  for (const line of ['', '   ', '[server] READY 7803', 'READYING okay',
    'RUNTIME_GATEWAY_READY', 'RUNTIME_GATEWAY_READY http://127.0.0.1:0',
    'RUNTIME_GATEWAY_READY http://127.0.0.1:99999',
    'RUNTIME_GATEWAY_READY http://127.0.0.1:abc',
    'RUNTIME_GATEWAY_READY ftp://127.0.0.1:8788']) {
    assert.equal(pyserver.parseReadyLine(line), null, `不该认：${JSON.stringify(line)}`);
  }
});

test('parseReadyLine 不明写主机时按 127.0.0.1 补全（READY 8788 的写法）', () => {
  assert.equal(pyserver.parseReadyLine('READY 8788').url, 'http://127.0.0.1:8788');
});

/* =============================================================================================
 * 二、参数合成
 * =========================================================================================== */

test('buildPythonArgs：-m 模块 + 显式 host/port（不用 0，见 server.py 的 print 顺序）', () => {
  assert.deepEqual(pyserver.buildPythonArgs({ port: 8788 }), [
    '-m', 'fieldstation.runtimes.server', '--host', '127.0.0.1', '--port', '8788',
  ]);
  assert.deepEqual(pyserver.buildPythonArgs({ port: 9000, module: 'x.y', host: '0.0.0.0' }), [
    '-m', 'x.y', '--host', '0.0.0.0', '--port', '9000',
  ]);
});

test('buildPythonEnv：PYTHONPATH 指到 src，且保留调用方原有的 PYTHONPATH 与 PATH', () => {
  const env = pyserver.buildPythonEnv({
    baseEnv: { PATH: 'C:/Windows', PYTHONPATH: 'D:/other' },
    pythonPath: ['H:/repo/src'],
  });
  assert.equal(env.PYTHONPATH, `H:/repo/src${path.delimiter}D:/other`);
  assert.equal(env.PATH, 'C:/Windows');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
});

test('buildPythonEnv：原有 PYTHONPATH 为空时不留下开头分隔符', () => {
  const env = pyserver.buildPythonEnv({ baseEnv: {}, pythonPath: ['H:/repo/src'] });
  assert.equal(env.PYTHONPATH, 'H:/repo/src');
});

test('buildSpawnSpec：命令 / 参数 / cwd / env 一次给全', () => {
  const spec = pyserver.buildSpawnSpec({
    python: 'H:/repo/.deps/venv/Scripts/python.exe',
    port: 8788,
    repoRoot: path.join('H:', 'repo'),
    baseEnv: {},
  });
  assert.equal(spec.command, 'H:/repo/.deps/venv/Scripts/python.exe');
  assert.deepEqual(spec.args, [
    '-m', 'fieldstation.runtimes.server', '--host', '127.0.0.1', '--port', '8788',
  ]);
  assert.equal(spec.cwd, path.join('H:', 'repo'));
  assert.equal(spec.env.PYTHONPATH, path.join('H:', 'repo', 'src'));
  assert.equal(spec.options.windowsHide, true);
});

/* =============================================================================================
 * 三、找解释器
 * =========================================================================================== */

test('resolvePython：payload 里的解释器优先于 venv', () => {
  const repoRoot = path.join('H:', 'repo');
  const found = pyserver.resolvePython({
    repoRoot,
    payloadDir: path.join('H:', 'userData', 'payload'),
    platform: 'win32',
    exists: (file) => file === path.join('H:', 'userData', 'payload', 'runtime', 'python', 'python.exe')
      || file === path.join(repoRoot, '.deps', 'venv', 'Scripts', 'python.exe'),
  });
  assert.equal(found.path, path.join('H:', 'userData', 'payload', 'runtime', 'python', 'python.exe'));
  assert.equal(found.source, 'payload');
});

test('resolvePython：payload 里没有就退回 .deps/venv', () => {
  const repoRoot = path.join('H:', 'repo');
  const venv = path.join(repoRoot, '.deps', 'venv', 'Scripts', 'python.exe');
  const found = pyserver.resolvePython({
    repoRoot, payloadDir: null, platform: 'win32', exists: (file) => file === venv,
  });
  assert.equal(found.path, venv);
  assert.equal(found.source, 'venv');
});

test('resolvePython：都没有时返回 null（调用方决定是弹窗还是静默降级）', () => {
  assert.equal(pyserver.resolvePython({
    repoRoot: path.join('H:', 'repo'), payloadDir: null, platform: 'win32', exists: () => false,
  }), null);
});

test('resolvePython：posix 用 bin/python3，不找 Scripts/python.exe', () => {
  const repoRoot = '/repo';
  const venv = path.join(repoRoot, '.deps', 'venv', 'bin', 'python3');
  const found = pyserver.resolvePython({
    repoRoot, payloadDir: null, platform: 'linux', exists: (file) => file === venv,
  });
  assert.equal(found.path, venv);
});

/* =============================================================================================
 * 四、端口
 * =========================================================================================== */

test('choosePortCandidates：递增、最多 5 个、不越过 65535', () => {
  assert.deepEqual(pyserver.choosePortCandidates(8788), [8788, 8789, 8790, 8791, 8792]);
  assert.deepEqual(pyserver.choosePortCandidates(65533), [65533, 65534, 65535]);
  assert.deepEqual(pyserver.choosePortCandidates(8788, 2), [8788, 8789]);
});

/* =============================================================================================
 * 五、kill 树
 * =========================================================================================== */

test('killTreeCommand：Windows 用 taskkill /pid <pid> /T /F', () => {
  assert.deepEqual(pyserver.killTreeCommand({ pid: 4242, platform: 'win32' }), {
    command: 'taskkill',
    args: ['/pid', '4242', '/T', '/F'],
  });
});

test('killTreeCommand：posix 杀整个进程组（负 pid），而不是只杀父进程', () => {
  assert.deepEqual(pyserver.killTreeCommand({ pid: 4242, platform: 'linux' }), {
    command: 'kill',
    args: ['-TERM', '-4242'],
  });
});

test('killTreeCommand：没有 pid 时返回 null（不能拼出 taskkill /pid null）', () => {
  assert.equal(pyserver.killTreeCommand({ pid: 0, platform: 'win32' }), null);
  assert.equal(pyserver.killTreeCommand({ pid: undefined, platform: 'win32' }), null);
});

/* =============================================================================================
 * 六、就绪等待状态机（假子进程）
 * =========================================================================================== */

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.killed = true; };
  return child;
}

const okProbe = async () => true;

test('waitForReady：读到就绪行就 resolve，并带上 url', async () => {
  const child = fakeChild();
  const waiting = pyserver.waitForReady({
    child, probe: okProbe, timeoutMs: 500, intervalMs: 5,
  });
  setTimeout(() => child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n'), 5);
  const ready = await waiting;
  assert.equal(ready.url, 'http://127.0.0.1:8788');
  assert.equal(ready.port, 8788);
});

test('waitForReady：就绪行之后 /health 不通 → 拒绝（server.py 的 print 在 bind 之前）', async () => {
  const child = fakeChild();
  const waiting = pyserver.waitForReady({
    child, probe: async () => false, timeoutMs: 300, intervalMs: 5,
  });
  setTimeout(() => child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n'), 5);
  await assert.rejects(waiting, (error) => /health|就绪/.test(error.message));
});

test('waitForReady：/health 通但子进程随后崩了 → 拒绝，不把别人的服务当自己的', async () => {
  /*
   * 这是真机上踩到的坑（2026-11-09）：8788 上已经有一个 python 在跑，
   * 我们起的那个 bind 失败、打了一行 READY 就退出；而 /health 探测打到了**别人**
   * 那个进程，于是外壳以为「起来了」，接着 taskkill 了一个已经死掉的 pid，
   * 端口上留着一个不是我们拉起来的服务。
   */
  const child = fakeChild();
  const waiting = pyserver.waitForReady({
    child, probe: async () => true, timeoutMs: 3000, intervalMs: 5, settleMs: 60,
  });
  setTimeout(() => {
    child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n');
    // /health 通了（那是别人的服务），紧接着自己的进程退出。
    setTimeout(() => {
      child.stderr.emit('data', 'PermissionError: [WinError 10013]\n');
      child.exitCode = 1;
      child.emit('exit', 1, null);
    }, 10);
  }, 5);
  await assert.rejects(waiting, (error) => /退出|10013/.test(error.message));
});

test('waitForReady：/health 通、子进程稳着 → 等 settleMs 后 resolve', async () => {
  const child = fakeChild();
  const waiting = pyserver.waitForReady({
    child, probe: async () => true, timeoutMs: 2000, intervalMs: 5, settleMs: 60,
  });
  setTimeout(() => child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n'), 5);
  const ready = await waiting;
  assert.equal(ready.port, 8788);
  assert.equal(child.exitCode, null);
});

test('isPortFree：被占的端口返回 false（真开一个监听再关掉）', async () => {
  const net = require('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busy = server.address().port;
  assert.equal(await pyserver.isPortFree({ port: busy }), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await pyserver.isPortFree({ port: busy }), true);
});

test('waitForReady：子进程提前退出 → 立刻失败并带 stderr，不等满超时', async () => {
  const child = fakeChild();
  const waiting = pyserver.waitForReady({ child, probe: okProbe, timeoutMs: 5000, intervalMs: 5 });
  setTimeout(() => {
    child.stderr.emit('data', 'PermissionError: [WinError 10013]\n');
    child.exitCode = 1;
    child.emit('exit', 1, null);
  }, 5);
  await assert.rejects(waiting, (error) => /10013/.test(error.message) && /1/.test(error.message));
});

test('waitForReady：超时报明确错误', async () => {
  const child = fakeChild();
  await assert.rejects(
    pyserver.waitForReady({ child, probe: okProbe, timeoutMs: 40, intervalMs: 5 }),
    (error) => /超时/.test(error.message) || /timeout/i.test(error.message),
  );
});

test('attachOnly：探到已在跑的服务就只连不拉', async () => {
  const result = await pyserver.attachOnly({ port: 8788, probe: async () => true });
  assert.deepEqual(result, { attached: true, url: 'http://127.0.0.1:8788', port: 8788 });
});

test('attachOnly：没在跑就返回 attached:false，交给调用方决定是否拉起', async () => {
  const result = await pyserver.attachOnly({ port: 8788, probe: async () => false });
  assert.equal(result.attached, false);
});

/* =============================================================================================
 * 七、编排：起 / 停（注入 spawn，不真跑进程）
 * =========================================================================================== */

test('startPythonService：spawn 用的是解析出来的解释器，成功返回 child 与 url', async () => {
  const calls = [];
  const child = fakeChild({ pid: 5555 });
  const service = pyserver.startPythonService({
    python: 'H:/repo/.deps/venv/Scripts/python.exe',
    repoRoot: path.join('H:', 'repo'),
    port: 8788,
    baseEnv: {},
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
    probe: okProbe,
    timeoutMs: 500,
    intervalMs: 5,
  });
  setTimeout(() => child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n'), 5);
  const started = await service.ready;
  assert.equal(started.url, 'http://127.0.0.1:8788');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'H:/repo/.deps/venv/Scripts/python.exe');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-m', 'fieldstation.runtimes.server']);
  assert.equal(calls[0].options.env.PYTHONPATH, path.join('H:', 'repo', 'src'));
});

test('stopPythonService：Windows 上走 taskkill /T /F，且只调用一次', () => {
  const calls = [];
  const child = fakeChild({ pid: 7777 });
  pyserver.stopPythonService({
    child,
    platform: 'win32',
    spawnImpl: (command, args) => { calls.push({ command, args }); return null; },
  });
  pyserver.stopPythonService({
    child,
    platform: 'win32',
    spawnImpl: (command, args) => { calls.push({ command, args }); return null; },
  });
  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/pid', '7777', '/T', '/F'] }]);
});

test('stopPythonService：已经退出的进程不再补一刀', () => {
  const calls = [];
  const child = fakeChild({ pid: 7777 });
  child.exitCode = 0;
  pyserver.stopPythonService({
    child, platform: 'win32', spawnImpl: (command, args) => { calls.push({ command, args }); },
  });
  assert.deepEqual(calls, []);
});

test('pythonHealthUrl / defaultPort 的常量不漂', () => {
  assert.equal(pyserver.DEFAULT_PORT, 8788);
  assert.equal(pyserver.pythonHealthUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788/health');
});

/* =============================================================================================
 * 八、编排：端口冲突时换下一个
 * =========================================================================================== */

test('launchPythonService：端口被占（别的 python 在跑）→ 不认别人那个服务，换下一个端口', async () => {
  const spawned = [];
  let attempt = 0;
  const result = await pyserver.launchPythonService({
    repoRoot: path.join('H:', 'repo'),
    python: 'C:/py/python.exe',
    baseEnv: {},
    startPort: 8788,
    timeoutMs: 400,
    intervalMs: 5,
    settleMs: 30,
    // 8788 上是**别人的**服务：/health 通。我们起的进程 bind 失败退出。
    probe: async () => true,
    isPortFreeImpl: async ({ port }) => port !== 8788,
    spawnImpl: (command, args) => {
      const port = args[args.length - 1];
      spawned.push(port);
      attempt += 1;
      const child = fakeChild({ pid: 9000 + attempt });
      setTimeout(() => {
        if (port === '8788') {
          child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n');
          child.stderr.emit('data', 'PermissionError: [WinError 10013]\n');
          child.exitCode = 1;
          child.emit('exit', 1, null);
        } else {
          child.stdout.emit('data', `RUNTIME_GATEWAY_READY http://127.0.0.1:${port}\n`);
        }
      }, 5);
      return child;
    },
    log: () => {},
  });
  assert.deepEqual(spawned, ['8789'], '被占的 8788 不该被拉起一个注定要崩的进程');
  assert.equal(result.port, 8789);
  assert.equal(result.url, 'http://127.0.0.1:8789');
  assert.equal(result.python.path, 'C:/py/python.exe');
});

test('launchPythonService：预检说空闲、实际 bind 失败 → settle 检查拦住，不当成别人的服务', async () => {
  const spawned = [];
  const result = await pyserver.launchPythonService({
    repoRoot: path.join('H:', 'repo'),
    python: 'C:/py/python.exe',
    baseEnv: {},
    startPort: 8788,
    timeoutMs: 500,
    intervalMs: 5,
    settleMs: 25,
    // 预检与真 bind 之间有竞态：这里模拟「预检说空闲，实际被占」。
    probe: async () => true,
    isPortFreeImpl: async () => true,
    spawnImpl: (command, args) => {
      const port = args[args.length - 1];
      spawned.push(port);
      const child = fakeChild({ pid: 9100 + spawned.length });
      setTimeout(() => {
        if (port === '8788') {
          child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n');
          setTimeout(() => {
            child.stderr.emit('data', 'PermissionError: [WinError 10013]\n');
            child.exitCode = 1;
            child.emit('exit', 1, null);
          }, 5);
        } else {
          child.stdout.emit('data', `RUNTIME_GATEWAY_READY http://127.0.0.1:${port}\n`);
        }
      }, 5);
      return child;
    },
    log: () => {},
  });
  assert.deepEqual(spawned, ['8788', '8789']);
  assert.equal(result.port, 8789);
});

test('launchPythonService：非端口原因失败 → 立刻抛，不无谓重试', async () => {
  let calls = 0;
  await assert.rejects(pyserver.launchPythonService({
    repoRoot: path.join('H:', 'repo'),
    python: 'C:/py/python.exe',
    baseEnv: {},
    startPort: 8788,
    timeoutMs: 200,
    intervalMs: 5,
    probe: async () => true,
    spawnImpl: () => {
      calls += 1;
      const child = fakeChild({ pid: 9001 });
      setTimeout(() => {
        child.stderr.emit('data', 'ModuleNotFoundError: No module named fieldstation\n');
        child.exitCode = 1;
        child.emit('exit', 1, null);
      }, 5);
      return child;
    },
    log: () => {},
  }), (error) => /ModuleNotFoundError/.test(error.message));
  assert.equal(calls, 1);
});

test('launchPythonService：找不到解释器时给出可操作的报错', async () => {
  await assert.rejects(pyserver.launchPythonService({
    repoRoot: path.join('H:', 'nope'),
    platform: 'win32',
    log: () => {},
  }), (error) => /找不到 Python 解释器/.test(error.message) && /--no-python/.test(error.message));
});

/* =============================================================================================
 * 九、开关语义：--attach / --attach-python / --no-python
 *
 * 这一节钉的是「`--attach` 必须连 Python 服务也一起只连不拉」。
 * 外壳的 `--attach` 语义是「服务已经跑着，我只连」；如果它只对 Node 成立、
 * 对 Python 失效，用户带 `--attach` 启动时会意外多拉起一个 Python 进程 ——
 * 正是他想避免的那个冗余进程。
 * =========================================================================================== */

test('resolvePythonMode：默认拉起', () => {
  assert.deepEqual(pyserver.resolvePythonMode({}), { mode: 'launch', reason: 'default' });
  assert.equal(pyserver.resolvePythonMode({ python: true, attach: false }).mode, 'launch');
});

test('resolvePythonMode：--attach 隐含 Python 也只连不拉（不能只对 Node 生效）', () => {
  const choice = pyserver.resolvePythonMode({ attach: true });
  assert.equal(choice.mode, 'attach');
  assert.equal(choice.reason, '--attach');
});

test('resolvePythonMode：--attach-python 单独用也能只连不拉', () => {
  assert.equal(pyserver.resolvePythonMode({ attachPython: true }).mode, 'attach');
  assert.equal(pyserver.resolvePythonMode({ attachPython: true }).reason, '--attach-python');
});

test('resolvePythonMode：--no-python 优先级最高，盖过 --attach 与 --attach-python', () => {
  assert.equal(pyserver.resolvePythonMode({ python: false }).mode, 'skip');
  assert.equal(pyserver.resolvePythonMode({ python: false, attach: true }).mode, 'skip');
  assert.equal(
    pyserver.resolvePythonMode({ python: false, attach: true, attachPython: true }).mode, 'skip');
});

/* =============================================================================================
 * 十、onSpawn：进程一 spawn 就交出来（不等就绪）
 *
 * 为什么要这一条：`main.js` 的 `boot()` 可能在 `await pythonPromise` **之前**就失败
 * （Node 服务起不来、payload 坏了）。那时 `launchPythonService` 还没返回、
 * `main.js` 的 `pythonChild` 仍是 null，`stopPython()` 杀不到任何东西 ——
 * 已经拉起的 Python 会一直活着。启动路径上的失败比正常退出更常见。
 * =========================================================================================== */

test('startPythonService：onSpawn 在 waitForReady 之前就被调用', async () => {
  const spawned = [];
  const child = fakeChild({ pid: 6001 });
  const service = pyserver.startPythonService({
    python: 'H:/repo/.deps/venv/Scripts/python.exe',
    repoRoot: path.join('H:', 'repo'),
    port: 8788,
    baseEnv: {},
    spawnImpl: () => child,
    probe: okProbe,
    timeoutMs: 200,
    intervalMs: 5,
    onSpawn: (spawnedChild) => spawned.push(spawnedChild),
    log: () => {},
  });
  // 同步断言：onSpawn 必须在 startPythonService 返回之前就已经跑过，
  // 而不是等到 ready 兑现。
  assert.deepEqual(spawned, [child]);
  assert.equal(service.child, child);
  // 把 ready 收干净：这个 case 只关心「进程什么时候交出来」，
  // 让它超时失败并消费掉拒绝，避免挂在事件循环上变成 unhandledRejection。
  await assert.rejects(service.ready, /超时|退出/);
});

test('launchPythonService：就绪失败时 onSpawn 已经把 child 交出去，可据此做清理', async () => {
  const spawned = [];
  await assert.rejects(pyserver.launchPythonService({
    repoRoot: path.join('H:', 'repo'),
    python: 'C:/py/python.exe',
    baseEnv: {},
    startPort: 8788,
    timeoutMs: 200,
    intervalMs: 5,
    probe: async () => true,
    isPortFreeImpl: async () => true,
    spawnImpl: () => {
      const child = fakeChild({ pid: 9101 });
      setTimeout(() => {
        child.stderr.emit('data', 'ModuleNotFoundError: No module named fieldstation\n');
        child.exitCode = 1;
        child.emit('exit', 1, null);
      }, 5);
      return child;
    },
    onSpawn: (child) => spawned.push(child),
    log: () => {},
  }), (error) => /ModuleNotFoundError/.test(error.message));
  // 端口重试会 spawn 多次，每一次都要被交出来 —— 漏掉一次就漏掉一个进程。
  assert.ok(spawned.length >= 1, 'onSpawn 至少要收到一次');
  assert.ok(spawned.every((child) => child.pid === 9101));
});

test('launchPythonService：换端口重试时，被放弃的那个进程也被 onSpawn 交出来过', async () => {
  const spawned = [];
  let attempt = 0;
  const result = await pyserver.launchPythonService({
    repoRoot: path.join('H:', 'repo'),
    python: 'C:/py/python.exe',
    baseEnv: {},
    startPort: 8788,
    timeoutMs: 400,
    intervalMs: 5,
    settleMs: 30,
    probe: async () => true,
    isPortFreeImpl: async ({ port }) => port !== 8788,
    spawnImpl: (command, args) => {
      const port = args[args.length - 1];
      attempt += 1;
      const child = fakeChild({ pid: 9200 + attempt });
      setTimeout(() => {
        if (port === '8788') {
          child.stdout.emit('data', 'RUNTIME_GATEWAY_READY http://127.0.0.1:8788\n');
          child.stderr.emit('data', 'PermissionError: [WinError 10013]\n');
          child.exitCode = 1;
          child.emit('exit', 1, null);
        } else {
          child.stdout.emit('data', `RUNTIME_GATEWAY_READY http://127.0.0.1:${port}\n`);
        }
      }, 5);
      return child;
    },
    onSpawn: (child) => spawned.push(child),
    log: () => {},
  });
  assert.equal(result.port, 8789);
  // 8788 那次被放弃的进程也出现在 spawned 里，清理路径不会漏掉它。
  assert.ok(spawned.length >= 1);
});
