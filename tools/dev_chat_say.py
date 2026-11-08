#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""往开发群聊发一条消息，或读最近的。

配套 ``tools/dev_chat.py``。四条开发线用这个说话。

## 用法

```text
python tools/dev_chat_say.py --who B --text "工-1 完成，存 c0f309a"
python tools/dev_chat_say.py --who B --text "..." --tag 进度
python tools/dev_chat_say.py --read 20
python tools/dev_chat_say.py --read 20 --who A
python tools/dev_chat_say.py --who B --file note.txt
```

## 地址从哪来

三种来源，优先级从高到低：

1. 命令行 ``--url http://127.0.0.1:7805``
2. 环境变量 ``FSA_DEV_CHAT_URL``
3. 默认 ``http://127.0.0.1:7805``

## token

给了 ``--token`` 或环境变量 ``FSA_DEV_CHAT_TOKEN`` 就带 ``Authorization``。
本地默认监听不带 token，所以通常不用管。

## 退出码

* 0 成功
* 1 服务端拒绝（参数错、太long）
* 2 连不上服务（没启动或端口不对）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:7805"
MEMBERS = ("A", "B", "C", "D", "你")
ALIAS = {"USER": "你", "user": "你", "u": "你"}


def _norm(who: str | None) -> str | None:
    if not who:
        return None
    w = who.strip()
    if w in MEMBERS:
        return w
    if w in ALIAS:
        return ALIAS[w]
    up = w.upper()
    if up in ("A", "B", "C", "D"):
        return up
    return None


def _headers(token: str) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    return h


def _open(req, timeout=15):
    return urllib.request.urlopen(req, timeout=timeout)


def post(url: str, who: str, text: str, tag: str, token: str) -> dict:
    body = json.dumps({"who": who, "text": text, "tag": tag},
                      ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url.rstrip("/") + "/api/say", data=body,
                                 headers=_headers(token), method="POST")
    with _open(req) as r:
        return json.loads(r.read().decode("utf-8"))


def read(url: str, since: int, token: str) -> dict:
    req = urllib.request.Request(
        url.rstrip("/") + "/api/messages?since=%d" % since,
        headers=_headers(token), method="GET")
    with _open(req) as r:
        return json.loads(r.read().decode("utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="开发群聊：说一句 / 读最近")
    ap.add_argument("--who", help="A / B / C / D / 你")
    ap.add_argument("--text", help="消息内容")
    ap.add_argument("--file", help="从文件读内容（长文本用）")
    ap.add_argument("--tag", default="", help="可选标签，例如 进度 / 问题 / 汇报")
    ap.add_argument("--read", type=int, default=0, metavar="N", help="读最近 N 条")
    ap.add_argument("--url", default=os.environ.get("FSA_DEV_CHAT_URL", DEFAULT_URL))
    ap.add_argument("--token", default=os.environ.get("FSA_DEV_CHAT_TOKEN", ""))
    a = ap.parse_args(argv)

    if a.read:
        who = _norm(a.who) if a.who else None
        if a.who and not who:
            print("--who 必须是 A / B / C / D / 你", file=sys.stderr)
            return 1
        try:
            d = read(a.url, 0, a.token)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print("服务要求 token：加 --token 或设 FSA_DEV_CHAT_TOKEN", file=sys.stderr)
                return 2
            print("服务返回 %s" % e.code, file=sys.stderr)
            return 2
        except Exception as e:
            print("连不上群聊（%s）：%s" % (a.url, e), file=sys.stderr)
            print("先启动：python tools/dev_chat.py --port 7805", file=sys.stderr)
            return 2

        rows = d.get("messages", [])
        total = d.get("total", len(rows))
        if who:
            rows = [m for m in rows if m.get("who") == who]
        rows = rows[-a.read:]

        for m in rows:
            tag = (" [%s]" % m["tag"]) if m.get("tag") else ""
            at = (m.get("at") or "").replace("T", " ")[5:16]
            print("%s  %s%s: %s" % (at, m.get("who", "?"), tag, m.get("text", "")))
        print("\n（群共 %d 条，显示最近 %d 条%s）"
              % (total, len(rows), ("，只看 %s" % who) if who else ""))
        return 0

    if not a.who:
        ap.error("要么 --read N，要么 --who")
    who = _norm(a.who)
    if not who:
        ap.error("--who 必须是 A / B / C / D / 你（或 USER）")

    text = a.text
    if a.file:
        with open(a.file, encoding="utf-8") as f:
            text = f.read()
    if not text or not text.strip():
        ap.error("要么 --text，要么 --file")

    try:
        r = post(a.url, who, text.strip(), a.tag, a.token)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:
            pass
        if e.code == 401:
            print("服务要求 token：加 --token 或设 FSA_DEV_CHAT_TOKEN", file=sys.stderr)
        else:
            print("服务端拒绝（%s）：%s" % (e.code, detail), file=sys.stderr)
        return 1
    except Exception as e:
        print("连不上群聊（%s）：%s" % (a.url, e), file=sys.stderr)
        print("先启动：python tools/dev_chat.py --port 7805", file=sys.stderr)
        return 2

    row = r.get("row", {})
    print("[%s] 已发（seq=%s），群共 %d 条"
          % (who, row.get("seq"), r.get("total", 0)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
