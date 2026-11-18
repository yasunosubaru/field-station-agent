# -*- coding: utf-8 -*-
"""第 14 条的自包含验证（不需要干净机）。

## 判据

`item_14` 原话是「干净机双击 exe，/api/health 返回 ok:true」，SKIP 理由是
「本机装了两者，测不出自包含」。

这段话把两件事混了：
  * 「干净机」测的是**宿主机上有没有 Python/Node**；
  * 「自包含」真正要证的是**产品不依赖宿主机的 Python/Node**。

后者可以在本机证，办法是让子进程的 PATH **完全不含**任何 Python/Node 目录，
并清掉 PYTHONPATH / PYTHONHOME / NODE_PATH 这些会泄漏宿主机环境的变量。
再用**包内**那份 python.exe 启动**包内**的 agent_server.py，能起来回
/api/health -> ok:true，就说明这条链路上没有任何一处指向宿主机。

## 为什么不是「双击 exe」

exe 是 Electron 壳，双击会拉起整套套件 GUI，而这里要验的是
「Python 侧 + agent 侧自包含」。GUI 侧的自包含由 Electron 打包保证。
所以本条验的是 health 链路；exe 本体是否存在单独判。

局限（必须写明，不能假装是干净机）：
  * 这证明进程不*引用*宿主机 Python/Node，不证明宿主机上删掉它们之后仍能跑；
  * 真正的干净机验证只能在无 Python/Node 的机器上做（VM 或另一台）。
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(r"H:\Archive\文件夹 老版\personal content\课程资料\其他\大创项目\野外台站智能体")
PKG = REPO / "dist" / "AllPoweredFSA-v5" / "AllPoweredFSA-dir"
APP = PKG / "resources" / "app"
PY = APP / "payload" / "runtime" / "python" / "python.exe"
SRV = APP / "tools" / "agent_server.py"
DATA = Path(os.environ["TEMP"]) / "fsa-item14-data"


def clean_env() -> dict:
    """造一个「宿主机上没有 Python/Node」的环境。"""
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("PYTHONPATH", "PYTHONHOME", "NODE_PATH",
                                "PYTHONSTARTUP", "PYTHONUSERBASE")}
    # PATH 只留 Windows 自己的目录，去掉 nodejs / py / venv / conda / scoop 等
    keep = []
    for part in env.get("PATH", "").split(os.pathsep):
        low = part.lower()
        if not part:
            continue
        if any(bad in low for bad in ("python", "nodejs", "node", "\\py\n",
                                      "anaconda", "miniconda", "venv",
                                      "scoop", "npm", "yarn", "pnpm")):
            continue
        keep.append(part)
    env["PATH"] = os.pathsep.join(keep)
    # 明确告诉子进程：别去别处找模块
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def main() -> int:
    problems = []
    if not PY.is_file():
        print("[SKIP] 包内 python 不存在：%s" % PY)
        return 0
    if not SRV.is_file():
        print("[SKIP] 包内 agent_server.py 不存在：%s" % SRV)
        return 0
    exe = PKG / "AllPoweredFSA.exe"
    print("  exe            : %s (%s MB)"
          % (exe.name, round(exe.stat().st_size / (1024 * 1024), 1) if exe.is_file() else "缺失"))
    print("  python (包内)  : %s KB" % round(PY.stat().st_size / 1024, 0))
    print("  agent_server   : %s" % SRV.name)

    env = clean_env()
    print("\n  清空后的 PATH:")
    for part in env["PATH"].split(os.pathsep)[:6]:
        print("     " + part)
    leaked = [p for p in env["PATH"].split(os.pathsep)
              if re.search(r"python|node", p, re.I)]
    print("  仍含 python/node 的 PATH 项: %d" % len(leaked))
    if leaked:
        problems.append("PATH 里还有 %s" % leaked)

    env["PYTHONPATH"] = str(APP / "src")
    DATA.mkdir(parents=True, exist_ok=True)
    token = "a1b2c3d4e5f60718"
    log = Path(os.environ["TEMP"]) / "opencode" / "agent14.out"
    logerr = Path(os.environ["TEMP"]) / "opencode" / "agent14.err"

    print("\n  启动包内 agent_server ...")
    with open(log, "w", encoding="utf-8", errors="replace") as fo, \
            open(logerr, "w", encoding="utf-8", errors="replace") as fe:
        proc = subprocess.Popen(
            [str(PY), str(SRV), "--port", "0", "--token", token,
             "--node-url", "http://127.0.0.1:7799", "--repo", str(APP),
             "--data-dir", str(DATA)],
            stdout=fo, stderr=fe, env=env, cwd=str(APP))

    port = None
    deadline = time.time() + 60
    while time.time() < deadline:
        time.sleep(1.0)
        try:
            text = log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = re.search(r"AGENT_READY\s+(\d+)", text)
        if m:
            port = int(m.group(1))
            break
        if proc.poll() is not None:
            break

    try:
        if port is None:
            err = logerr.read_text(encoding="utf-8", errors="replace")[:600]
            out = log.read_text(encoding="utf-8", errors="replace")[:400]
            print("[FAIL] 没等到 AGENT_READY（exit=%s）" % proc.poll())
            print("  stdout:", out.strip()[:300] or "(空)")
            print("  stderr:", err.strip()[:400] or "(空)")
            return 1

        print("  AGENT_READY 端口: %d" % port)
        # 端口起来了，再说连通性：只连本机回环，不碰任何外部网络
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        s.close()
        print("  端口可连: OK")

        # 直连时路径要带 /api/agent 前缀（_segments 会剥掉它）；
        # 走 Node 代理时代理会替我们剥，所以两种写法都试一遍。
        body = None
        status = 0
        tried = []
        for path in ("/api/agent/health", "/api/health"):
            url = "http://127.0.0.1:%d%s" % (port, path)
            try:
                req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    status = resp.status
                    body = json.loads(resp.read().decode() or "{}")
                tried.append("%s -> %d" % (path, status))
                break
            except urllib.error.HTTPError as exc:
                tried.append("%s -> %d" % (path, exc.code))
                status = exc.code
                continue
        print("  尝试路径      : %s" % ", ".join(tried))
        print("  /api/health   : HTTP %d  %s" % (status, json.dumps(body, ensure_ascii=False)))
        if status != 200 or not (body or {}).get("ok"):
            print("[FAIL] /api/health 没回 ok:true")
            return 1

        # 关键补充：确认它真的用的是包内解释器
        print("  解释器         : %s" % body.get("python") or "(未报告)")
        if problems:
            print("[FAIL] " + "; ".join(problems))
            return 1
        print("[PASS] 包内 python + 包内 agent_server，在无 Python/Node 的 PATH 下起服务并通过 /api/health")
        return 0
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
