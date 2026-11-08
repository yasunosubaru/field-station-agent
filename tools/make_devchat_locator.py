#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""DevChat 定位器：给已发布的 exe 用。

## 解决什么问题

DevChat.exe 发布到 `dist\DevChat\` 之后，代码里「从 exe 往上找
`tools/dev_chat.py`」就找不到了 —— 因为发布目录里的 exe 是**自包含单文件**，
它被解压到临时目录运行，`AppContext.BaseDirectory` 指向的可能是：

    %TEMP%\.net\DevChat\<hash>\

或者发布目录 `dist\DevChat\`。两种情况下往上算都到不了仓库根。

于是就出现：「内置服务没能启动」「找不到仓库根」。

## 怎么解决

在发布目录写一个 `devchat.json`，把仓库根和 python 路径钉死：

```json
{"repoRoot": "<仓库根>",
 "python":   "<仓库根>\\.deps\\venv\\Scripts\\python.exe"}
```

exe 启动时按这个顺序找配置：

    1) 环境变量 DEVCHAT_REPO / DEVCHAT_PYTHON
    2) exe 同目录的 devchat.json
    3) exe 往上 8 层找 tools/dev_chat.py（开发态有效）
    4) %LOCALAPPDATA%\\DevChat\\settings.json 里的 repoRoot

本脚本负责生成第 2 条那个文件，并把第 4 条也一起写好。

## 用法

```powershell
$py = "<仓库根>\.deps\venv\Scripts\python.exe"
& $py tools\make_devchat_locator.py
```

会写两个文件：
- `<仓库根>\dist\DevChat\devchat.json`   ← exe 同目录，最可靠
- `%LOCALAPPDATA%\DevChat\settings.json` 里的 repoRoot / python 字段

以后仓库搬家了，重跑一次即可。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST = REPO / "dist" / "DevChat"


def find_python() -> str | None:
    for rel in (".deps/venv/Scripts/python.exe", ".venv/Scripts/python.exe"):
        p = REPO / rel
        if p.exists():
            return str(p)
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="给 DevChat.exe 写定位配置")
    ap.add_argument("--dist", default=str(DIST), help="exe 所在目录")
    ap.add_argument("--python", default=None, help="覆盖 python.exe 路径")
    a = ap.parse_args(argv)

    dist = Path(a.dist)
    py = a.python or find_python()
    if py is None:
        print("找不到 python.exe（.deps/venv 里没有），用 --python 指定", file=sys.stderr)
        return 2

    if not (REPO / "tools" / "dev_chat.py").exists():
        print("仓库根里没有 tools/dev_chat.py，路径不对：%s" % REPO, file=sys.stderr)
        return 2

    record = {"repoRoot": str(REPO), "python": py}

    # ① exe 同目录（最可靠：exe 自己读这里）
    if dist.exists():
        p = dist / "devchat.json"
        p.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print("已写 %s" % p)
    else:
        print("跳过 %s（目录不存在，先跑 dotnet publish）" % dist)

    # ② 用户设置（窗口里点「设置」看的也是这个）
    local = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "DevChat"
    local.mkdir(parents=True, exist_ok=True)
    sp = local / "settings.json"
    data = {}
    if sp.exists():
        try:
            data = json.loads(sp.read_text(encoding="utf-8")) or {}
        except (json.JSONDecodeError, OSError):
            data = {}
    data["repoRoot"] = str(REPO)
    data["pythonPath"] = py
    # 不要把 BaseUrl 指向死端口；内置模式会自己分配
    if not data.get("BaseUrl"):
        data["BaseUrl"] = "http://127.0.0.1:7805"
    sp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("已更新 %s" % sp)

    print("")
    print("仓库根   : %s" % REPO)
    print("python   : %s" % py)
    print("")
    print("现在双击 DevChat.exe 应该能自己起服务了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
