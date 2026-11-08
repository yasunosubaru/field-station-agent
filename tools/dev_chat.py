#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开发期五人群聊（A / B / C / D / 你）。

这是项目的**开发辅助工具**，不是交付给台站运维的功能。它解决一个具体问题：

    四条开发线（A 编排 / B 服务面 / C 界面 / D 数据设备）在各自的 worktree 里跑，
    彼此看不到对方说了什么、踩了什么坑、改了哪个共用文件。
    没有共享对话场所时，同一个坑会被四个人各踩一次。

## 为什么是本地页面，不是 QQ / 微信群

* 个人 QQ / 微信没有官方机器人接口；第三方协议实现（NapCat 等）有封号风险。
* 五个人都在同一台机器上（四条线是本地进程），没理由让消息绕一圈去外部服务器。
* 企业微信群可以，但要求注册企业 + 建 3 人以上群 + 拉人，对一个开发期工具过重。

## 用法

```text
python tools/dev_chat.py --port 0 --token <hex> --log <path>
→ stdout: DEV_CHAT_READY <port>
```

`--port 0` 让系统分配空闲端口，实际端口从 `DEV_CHAT_READY` 那行读。
也可以给固定端口：

```text
python tools/dev_chat.py --port 7805 --token <hex>
```

## 边界

* 默认只监听 `127.0.0.1`；要给手机看，显式 `--host 0.0.0.0`（此时**必须**带 token）。
* 给了 `--token` 时，每次请求都要 `Authorization: Bearer <token>`；
  页面本身不需要，但 `POST /api/say` 与 `GET /api/messages` 需要。
* 消息先落盘（JSONL，一行一条）再返回；进程被杀不丢已确认的消息。
* 请求体上限 64 KB。
* 不打印 token、不打印本机绝对路径。

## 成员与权限

五个成员固定：`A` / `B` / `C` / `D` / `你`。没有身份验证——
这是**开发期工具**，跑在本机或本机局域网内，不对外。
真要放开到公网，必须自己加反向代理和认证，不要直接暴露。

## 数据结构

`chat.jsonl` 每行：

```json
{"seq":1,"who":"B","text":"工-1 完成，存 c0f309a","tag":"进度","at":"2026-11-08T19:13:02"}
```

`seq` 单调递增，客户端靠它做增量拉取（`?since=N`）。
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MEMBERS = ("A", "B", "C", "D", "你")
ALIAS = {"USER": "你", "user": "你", "u": "你"}
MAX_BODY = 64 * 1024
MAX_TEXT = 4000


def _norm_who(raw) -> str | None:
    w = (raw or "").strip() if isinstance(raw, str) else ""
    if w in MEMBERS:
        return w
    if w in ALIAS:
        return ALIAS[w]
    up = w.upper()
    if up in ("A", "B", "C", "D"):
        return up
    return None


class Store:
    """JSONL 追加存储。seq 在内存里连续，落盘后再返回。"""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._rows: list[dict] = []
        self._seq = 0
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = row.get("seq")
                if isinstance(seq, int) and seq > self._seq:
                    self._seq = seq
                self._rows.append(row)

    def append(self, who: str, text: str, tag: str) -> dict:
        with self._lock:
            self._seq += 1
            row = {
                "seq": self._seq,
                "who": who,
                "text": text,
                "tag": tag,
                "at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            }
            with self.path.open("a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            self._rows.append(row)
            return row

    def since(self, n: int) -> list[dict]:
        with self._lock:
            return [r for r in self._rows if r.get("seq", 0) > n]

    @property
    def total(self) -> int:
        with self._lock:
            return self._seq


PAGE = r"""<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>开发群聊 · 四线</title>
<style>
:root{
  --bg:#fbfbfa;--panel:#fff;--line:#e7e6e3;--line2:#f0eee9;
  --ink:#1c1b19;--ink2:#5d5a55;--ink3:#94908a;--accent:#c2603a;
  --a:#3a6ea5;--b:#4a8a3f;--c:#9a5aa8;--d:#b8791a;--u:#c2603a;
  --ok:#4a8a3f;--warn:#b8791a;--bad:#b04a3a;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--bg);color:var(--ink);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  display:flex;flex-direction:column;-webkit-text-size-adjust:100%;
}
header{
  display:flex;align-items:center;gap:9px;padding:9px 14px;
  border-bottom:1px solid var(--line);background:var(--panel);flex-shrink:0;
}
header .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex-shrink:0}
header .dot.off{background:var(--bad)}
header b{font-size:15px;letter-spacing:.01em}
header .sub{color:var(--ink3);font-size:11px;margin-left:auto;font-variant-numeric:tabular-nums}
main{flex:1;display:flex;min-height:0}
nav{
  width:120px;border-right:1px solid var(--line);background:var(--panel);
  padding:9px 7px;overflow:auto;flex-shrink:0;
}
nav .m{
  display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:5px;
  cursor:pointer;color:var(--ink2);font-size:13px;user-select:none;
}
nav .m:hover{background:var(--line2)}
nav .m.on{background:var(--line2);color:var(--ink);font-weight:600}
nav .m i{width:8px;height:8px;border-radius:50%;flex-shrink:0}
nav .m .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav .m .cnt{font-size:10px;color:var(--ink3);font-variant-numeric:tabular-nums}
nav .sep{height:1px;background:var(--line);margin:7px 4px}
#feed{flex:1;overflow-y:auto;padding:13px 15px;min-width:0;overscroll-behavior:contain}
.msg{display:flex;gap:9px;margin-bottom:13px;align-items:flex-start}
.av{
  width:25px;height:25px;border-radius:5px;flex-shrink:0;display:grid;place-items:center;
  color:#fff;font-size:12px;font-weight:700;line-height:1;
}
.body{min-width:0;flex:1}
.meta{font-size:11px;color:var(--ink3);margin-bottom:1px;font-variant-numeric:tabular-nums}
.meta b{color:var(--ink2);font-weight:600;font-size:12px}
.text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.text code{
  background:var(--line2);padding:1px 4px;border-radius:3px;
  font:12px/1.4 ui-monospace,"Cascadia Mono",Consolas,monospace;
}
.text a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(194,96,58,.3)}
.at{padding:0 3px;border-radius:3px;font-weight:600}
.tag{
  display:inline-block;font-size:10px;padding:0 5px;border-radius:3px;
  background:var(--line2);color:var(--ink2);margin-left:5px;vertical-align:1px;
}
.empty{color:var(--ink3);padding:24px 2px;font-size:13px;line-height:1.9}
.empty code{background:var(--line2);padding:1px 5px;border-radius:3px;font-size:12px}
form{
  display:flex;gap:7px;padding:9px 13px;border-top:1px solid var(--line);
  background:var(--panel);flex-shrink:0;align-items:flex-end;
}
select,textarea,button{font:inherit;color:var(--ink)}
select{
  border:1px solid var(--line);background:#fff;border-radius:5px;
  padding:8px 6px;flex-shrink:0;
}
textarea{
  flex:1;border:1px solid var(--line);border-radius:5px;padding:8px 10px;
  resize:none;min-height:40px;max-height:132px;background:#fff;line-height:1.55;
}
textarea:focus,select:focus{outline:none;border-color:var(--accent)}
button{
  border:0;background:var(--accent);color:#fff;border-radius:5px;
  padding:0 17px;height:40px;font-weight:600;cursor:pointer;flex-shrink:0;
}
button:disabled{opacity:.45;cursor:default}
@media(max-width:680px){
  nav{width:52px;padding:7px 3px}
  nav .m{justify-content:center;padding:7px 0}
  nav .m .lbl,nav .m .cnt{display:none}
  #feed{padding:11px 12px}
  form{padding:8px 10px}
  select{max-width:92px}
}
</style>
</head><body>
<header>
  <span class="dot" id="dot"></span>
  <b>开发群聊</b>
  <span class="sub" id="stat">连接中</span>
</header>
<main>
  <nav id="nav"></nav>
  <div id="feed"></div>
</main>
<form id="f">
  <select id="who" aria-label="以谁的身份发言"></select>
  <textarea id="t" rows="1" placeholder="说点什么…（Ctrl+Enter 发送）" aria-label="消息内容"></textarea>
  <button id="send" type="submit">发送</button>
</form>
<script>
const COLORS={A:'var(--a)',B:'var(--b)',C:'var(--c)',D:'var(--d)','你':'var(--u)'};
const MEMBERS=[
  {id:'A',n:'A 线',d:'后台记账'},
  {id:'B',n:'B 线',d:'AI 工具'},
  {id:'C',n:'C 线',d:'界面'},
  {id:'D',n:'D 线',d:'数据设备'},
  {id:'你',n:'你',d:'决策'}
];
const TOKEN=new URLSearchParams(location.search).get('token')||'';
const H=TOKEN?{'Authorization':'Bearer '+TOKEN}:{};

let all=[],lastSeq=0,filter=null,busy=false;

const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function fmt(s){
  let h=esc(s);
  h=h.replace(/`([^`\n]+)`/g,'\u0000$1\u0001');
  h=h.replace(/@(A|B|C|D|你)/g,m=>`<span class="at" style="color:${COLORS[m.slice(1)]||'var(--ink2)'};background:${(COLORS[m.slice(1)]||'#888')}18">${m}</span>`);
  h=h.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noreferrer noopener">$1</a>');
  h=h.replace(/\u0000([^\u0001]*)\u0001/g,'<code>$1</code>');
  return h;
}

function buildNav(){
  const counts={};
  all.forEach(m=>counts[m.who]=(counts[m.who]||0)+1);
  const items=[{id:'',n:'全部',d:'',c:'var(--ink3)',cnt:all.length}]
    .concat(MEMBERS.map(m=>({id:m.id,n:m.n,d:m.d,c:COLORS[m.id],cnt:counts[m.id]||0})));
  document.getElementById('nav').innerHTML=items.map(it=>
    `<div class="m${(filter||'')===(it.id||'')?' on':''}" data-f="${it.id}" title="${it.d||it.n}">
       <i style="background:${it.c}"></i><span class="lbl">${it.n}</span><span class="cnt">${it.cnt}</span>
     </div>`).join('');
  document.querySelectorAll('#nav .m').forEach(el=>{
    el.onclick=()=>{filter=el.dataset.f||null;render();buildNav();};
  });
}

function render(){
  const feed=document.getElementById('feed');
  const list=filter?all.filter(m=>m.who===filter):all;
  if(!list.length){
    feed.innerHTML='<div class="empty">还没有消息。<br>四条线说话：<br>'+
      '<code>python tools/dev_chat_say.py --who B --text "..."</code></div>';
    return;
  }
  const nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<80;
  feed.innerHTML=list.map(m=>{
    const c=COLORS[m.who]||'var(--ink3)';
    const t=(m.at||'').replace('T',' ').slice(5,16);
    const tag=m.tag?`<span class="tag">${esc(m.tag)}</span>`:'';
    return `<div class="msg"><div class="av" style="background:${c}">${esc(m.who)}</div>`+
      `<div class="body"><div class="meta"><b>${esc(m.who)}</b> · ${t}${tag}</div>`+
      `<div class="text">${fmt(m.text||'')}</div></div></div>`;
  }).join('');
  if(nearBottom)feed.scrollTop=feed.scrollHeight;
}

async function pull(){
  try{
    const r=await fetch('/api/messages?since='+lastSeq,{headers:H});
    if(!r.ok)throw new Error(r.status);
    const d=await r.json();
    document.getElementById('dot').className='dot';
    document.getElementById('stat').textContent='共 '+d.total+' 条 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
    if(d.messages.length){
      d.messages.forEach(m=>{all.push(m);lastSeq=Math.max(lastSeq,m.seq||0);});
      render();buildNav();
    }
  }catch(e){
    document.getElementById('dot').className='dot off';
    document.getElementById('stat').textContent='连不上（'+(e.message||e)+'）';
  }
}

async function send(){
  if(busy)return;
  const who=document.getElementById('who').value;
  const ta=document.getElementById('t');
  const text=ta.value.trim();
  if(!text)return;
  busy=true;document.getElementById('send').disabled=true;
  try{
    const r=await fetch('/api/say',{method:'POST',
      headers:Object.assign({'content-type':'application/json'},H),
      body:JSON.stringify({who,text})});
    if(!r.ok){const e=await r.json().catch(()=>({error:r.status}));throw new Error(e.error||r.status);}
    ta.value='';ta.style.height='auto';
    await pull();
  }catch(e){
    alert('发送失败：'+e.message);
  }finally{
    busy=false;document.getElementById('send').disabled=false;ta.focus();
  }
}

document.getElementById('who').innerHTML=MEMBERS.map(m=>
  `<option value="${m.id}">${m.n}（${m.d}）</option>`).join('');
document.getElementById('who').value='你';
document.getElementById('f').onsubmit=e=>{e.preventDefault();send();};
const ta=document.getElementById('t');
ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,132)+'px';});
ta.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}
});
pull();
setInterval(pull,2500);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pull();});
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DevChat/1.0"

    def log_message(self, fmt, *args):  # 不打印请求行，避免刷屏
        return

    # ---- helpers ----

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, code: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        want = getattr(self.server, "token", "")
        if not want:
            return True
        got = self.headers.get("Authorization") or ""
        got = got[7:] if got.startswith("Bearer ") else ""
        return hmac.compare_digest(got, want)

    def _read_body(self) -> bytes | None:
        """读请求体。支持 Content-Length 与 chunked。

        返回 None 表示超过 MAX_BODY（调用方回 413）。
        """
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            return self._read_chunked()

        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return b""
        if n <= 0:
            return b""
        if n > MAX_BODY:
            return None
        return self.rfile.read(n)

    def _read_chunked(self) -> bytes | None:
        out = bytearray()
        while True:
            line = self.rfile.readline(1024)
            if not line:
                break
            size_field = line.split(b";", 1)[0].strip()
            try:
                size = int(size_field, 16)
            except ValueError:
                break
            if size == 0:
                # 吃掉 trailer
                while True:
                    trailer = self.rfile.readline(1024)
                    if not trailer or trailer in (b"\r\n", b"\n"):
                        break
                break
            if len(out) + size > MAX_BODY:
                return None
            out += self.rfile.read(size)
            self.rfile.read(2)  # 结尾 CRLF
        return bytes(out)

    # ---- routes ----

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            return self._html(HTTPStatus.OK, PAGE)

        if u.path == "/api/messages":
            if not self._authorized():
                return self._json(HTTPStatus.UNAUTHORIZED, {"error": "需要 token"})
            q = parse_qs(u.query)
            try:
                since = int((q.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            store = self.server.store
            return self._json(HTTPStatus.OK, {
                "total": store.total,
                "messages": store.since(since),
            })

        if u.path == "/api/health":
            return self._json(HTTPStatus.OK, {
                "ok": True,
                "total": self.server.store.total,
                "members": list(MEMBERS),
            })

        return self._json(HTTPStatus.NOT_FOUND, {"error": "没有这个路径"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/say":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "没有这个路径"})

        if not self._authorized():
            return self._json(HTTPStatus.UNAUTHORIZED, {"error": "需要 token"})

        # 读请求体。两种编码都要支持：
        #   * Content-Length —— curl / 大多数客户端
        #   * Transfer-Encoding: chunked —— .NET HttpClient 默认就这么发
        # 只认前者会让桌面端一直收到「空请求体」。
        raw = self._read_body()
        if raw is None:
            return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                              {"error": "请求体超过 %d 字节" % MAX_BODY})
        if not raw:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "空请求体"})

        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "不是合法 JSON"})
        if not isinstance(data, dict):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "JSON 顶层必须是对象"})

        who = _norm_who(data.get("who"))
        if not who:
            return self._json(HTTPStatus.BAD_REQUEST,
                              {"error": "who 必须是 A / B / C / D / 你"})

        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "text 不能为空"})
        text = text.strip()
        if len(text) > MAX_TEXT:
            return self._json(HTTPStatus.BAD_REQUEST,
                              {"error": "text 超过 %d 字" % MAX_TEXT})

        tag = data.get("tag")
        tag = tag.strip()[:20] if isinstance(tag, str) else ""

        row = self.server.store.append(who, text, tag)
        return self._json(HTTPStatus.OK, {"ok": True, "row": row, "total": self.server.store.total})


class ChatServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, *, store: Store, token: str):
        super().__init__(addr, handler)
        self.store = store
        self.token = token


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="开发期五人群聊（A/B/C/D/你）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--host", default="127.0.0.1",
                   help="监听地址；默认只本机。要给手机看用 0.0.0.0（必须带 token）")
    p.add_argument("--port", type=int, default=0,
                   help="端口；0 表示自动分配（默认），实际值见 DEV_CHAT_READY")
    p.add_argument("--token", default="",
                   help="访问令牌；给了就要求 Bearer。不给则等同免鉴权")
    p.add_argument("--log", default="",
                   help="消息文件路径；默认 <仓库>/logs/dev_chat/chat.jsonl")
    p.add_argument("--gen-token", action="store_true",
                   help="生成一个随机 token 并打印后退出")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    if args.gen_token:
        print(secrets.token_hex(16))
        return 0

    repo = Path(__file__).resolve().parents[1]
    log = Path(args.log) if args.log else repo / "logs" / "dev_chat" / "chat.jsonl"

    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.token:
        sys_msg = "--host %s 对外开放时必须带 --token，拒绝启动" % args.host
        print(sys_msg, file=__import__("sys").stderr)
        return 2

    store = Store(log)
    srv = ChatServer((args.host, args.port), Handler, store=store, token=args.token)
    port = srv.server_address[1]

    # 契约：就绪标记打到 stdout，端口从这行读
    __import__("sys").stdout.write("DEV_CHAT_READY %d\n" % port)
    __import__("sys").stdout.flush()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
