/**
 * The launcher process `Start-FieldStation.cmd` hands control to.
 *
 *   node packages/desktop/src/cli.ts [-NoBrowser] [-Minimize] [-Port 7790]
 *
 * Exits 0 on a clean stop, 1 on failure (the `.cmd` then pauses so the message is readable).
 */

import { createInterface } from 'node:readline';

import {
  DEFAULT_PORT,
  PORT_ATTEMPTS,
  defaultLogFile,
  launch,
  parseArgs,
  type LaunchResult,
} from './launcher.ts';

const HELP = `野外台站智能体 · 桌面启动器

用法：
  Start-FieldStation.cmd [-NoBrowser] [-NoMinimize] [-Port <端口>]

参数：
  -NoBrowser        只起服务，不打开浏览器
  -Minimize         起好后把控制台最小化（.cmd 默认已带，双击时生效）
  -NoMinimize       保持控制台可见
  -Port <n>         首选端口，默认 ${DEFAULT_PORT}；被占用则顺延，最多试 ${PORT_ATTEMPTS} 个
  -h, --help        显示本帮助

环境变量：
  FIELD_STATION_PORT       首选端口（被 -Port 覆盖）
  FIELD_STATION_NO_BROWSER 置 1 等价于 -NoBrowser
  FIELD_STATION_LOG        日志路径，默认 %LOCALAPPDATA%\\FieldStation\\launcher.log
  FIELD_STATION_NODE       node.exe 的完整路径（.cmd 找不到 node 时用）
`;

/** Keep a double-clicked window readable when the launcher reused somebody else's process. */
function waitForDismiss(): Promise<void> {
  return new Promise((done) => {
    const finish = () => done();
    if (!process.stdin.isTTY) {
      const timer = setTimeout(finish, 3_000);
      timer.unref();
      return;
    }
    process.stdout.write('\n按任意键关闭本窗口…\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', () => {
      rl.close();
      finish();
    });
    rl.once('SIGINT', () => {
      rl.close();
      finish();
    });
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const logFile = defaultLogFile();
  let result: LaunchResult;
  try {
    result = await launch({
      preferredPort: args.port,
      openBrowser: args.openBrowser,
      minimizeConsole: args.minimize,
      logFile,
    });
  } catch (error) {
    process.stderr.write(`\n[fieldstation] 启动失败：${(error as Error).message}\n`);
    process.stderr.write(`[fieldstation] 日志：${logFile}\n`);
    return 1;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${result.reused ? '复用在运行的实例' : '服务已启动'}：${result.url}\n`);
  process.stdout.write(`  日志：${result.logFile}\n`);

  if (result.reused) {
    process.stdout.write('  本次没有启动新进程；关掉本窗口不会影响已在运行的服务。\n');
    await waitForDismiss();
    return 0;
  }

  process.stdout.write('  按 Ctrl+C 或直接关闭此窗口即退出（会同时结束服务）。\n');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[fieldstation] 收到 ${signal}，正在停止服务…\n`);
    try {
      await result.stop();
    } finally {
      process.exit(0);
    }
  };
  // SIGHUP is what libuv synthesises for CTRL_CLOSE_EVENT (the operator clicked the X).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  const child = result.child;
  const code = await new Promise<number>((done) => {
    if (!child) {
      done(0);
      return;
    }
    child.once('exit', (exitCode, signal) => {
      if (shuttingDown) return done(0);
      process.stderr.write(`\n[fieldstation] 服务进程意外退出（code=${exitCode ?? 'null'} signal=${signal ?? 'none'}）。\n`);
      process.stderr.write(`[fieldstation] 日志末尾：${result.logFile}\n`);
      done(exitCode ?? 1);
    });
  });
  return code === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`\n[fieldstation] 未捕获的错误：${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
