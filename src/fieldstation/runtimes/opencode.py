"""运行时 A 的**原生**适配器：直接驱动 `opencode run --format json`。

## 为什么需要它（而不是继续用 OpenAI 兼容别名）

`impl.py` 第 136–139 行原本写着：

    #: 兼容旧名：OpenCode 的 v2 API 不是 OpenAI 兼容的（实测 /openapi.json 401，
    #: serve 会打印 server password），要接它得单独写原生适配器。在那之前，
    #: 这个名字指向通用 OpenAI 兼容实现，避免"以为已经接了 OpenCode"。
    OpenCodeRuntime = OpenAICompatibleRuntime

那段话把问题定义得很准：**OpenCode 不是 OpenAI 兼容的**，所以拿 OpenAI 兼容实现
冒充它，会得到一个"能说话、但工具全都不工作"的假运行时。本模块补的就是那个
"单独写的原生适配器"。

## 为什么走 CLI 而不是 HTTP

`opencode` 同时提供两条路：

* `opencode serve` —— 一个 v2 HTTP API，但要处理鉴权（serve 会打印 server
  password）、端点形状未公开文档化；
* `opencode run --format json` —— **CLI 契约，NDJSON 输出**，版本升级时不容易碎。

选后者：`--format json` 的存在本身就是给程序读的，而 HTTP API 的 `401` 已经在
注释里记过一次教训了。代价是不能中途 `cancel` 单个工具，只能结束整个进程——
这条限制写在 `cancel()` 的 docstring 里，不假装支持精细取消。

## 实测到的真实事件形状（2026-11-07，opencode v2.2.0）

每行一个 JSON 对象，顶层固定 `type` / `timestamp` / `sessionID` / `part`：

```
{"type":"step_start",  "part":{"type":"step-start", ...}}
{"type":"tool_use",    "part":{"type":"tool","tool":"shell","id":"call_xxx",
                               "state":{"status":"completed","input":{...},
                                        "output":"...","time":{...}}}}
{"type":"step_finish", "part":{"type":"step-finish","reason":"tool-calls",
                               "cost":0.00089,
                               "tokens":{"input":3606,"output":46,
                                         "reasoning":129,
                                         "cache":{"read":82176,"write":0}}}}
{"type":"text",        "part":{"type":"text","text":"收到",...}}
```

四种类型里 `step_start` / `step_finish` 是**帧**（开始/结束一个推理步），
`tool_use` / `text` 才是内容。

## 一个必须说清的事实：没有显式的"结束"事件

`opencode run` **不输出 `message.done` 之类的终止标记**，它跑完就直接退出（退出码 0）。
所以本适配器在**进程退出码为 0** 且流正常结束时，自己补一条 `message.done`
（`data.reason = "stop"` 或 `"tool_calls"`，看最后一步是什么）。

这条不能省：上层（SSE 网关、前端）靠 `message.done` 收尾，没有它就会一直等。
也不能乱补：进程非零退出时补的是 `error` 而不是 `message.done`——
"跑完了"和"崩了"必须分开，否则前端会把崩溃显示成一次成功的空回答。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .base import Event, RuntimeRequest, RuntimeUnavailable

#: 默认总超时（秒）。`opencode run` 会自己多轮调用工具，一次问答跑几分钟是正常的；
#: 但**不能让调用方永久阻塞**，所以给一个上限，超时就发 error 并结束子进程。
DEFAULT_TIMEOUT_S = 300.0

#: `RuntimeRequest.model` 的默认值是 `deepseek-v4.1-flash`（不带 provider 前缀），
#: 而 opencode 的 `--model` 要求 `provider/model` 形状。没前缀时用这个补上。
#: 选 commandcode 是因为本机 `opencode models` 里它的模型最全，且是项目现在用的通道。
DEFAULT_MODEL_PREFIX = "commandcode/"

#: 环境变量：直接指定 opencode 可执行文件（测试与换机器用）。
ENV_BIN = "FSA_OPENCODE_BIN"
#: 环境变量：覆盖默认模型前缀。
ENV_MODEL_PREFIX = "FSA_OPENCODE_MODEL_PREFIX"

#: 已知但**故意不映射**的 part 类型。列出来是为了让"没映射"变成一个有记录的决定，
#: 而不是一次静默丢弃 —— 后者会让"模型什么都没说"和"我们没解析出来"长得一样。
INTENTIONALLY_IGNORED = {
    "step-start": "帧标记：只表示一步开始，没有可呈现内容",
    "step-finish": "帧标记：它的 tokens/cost 已经映射成 usage 事件",
    "reasoning": "思维链：默认不外泄到 UI（需要时用 opencode run --thinking）",
    "snapshot": "内部快照 id，与用户无关",
}


def _find_binary() -> Optional[Path]:
    """按优先级找 opencode 可执行文件。

    顺序是「显式指定 → 仓库自带 → PATH」：仓库自带的 `.deps/opencode` 是钉住版本的，
    优先于用户 PATH 里那个不确定版本的 opencode —— 版本漂移会让事件形状悄悄变。
    """
    explicit = os.environ.get(ENV_BIN, "").strip()
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None

    repo = Path(__file__).resolve().parents[3]
    for name in ("opencode.exe", "opencode"):
        candidate = repo / ".deps" / "opencode" / "bin" / name
        if candidate.is_file():
            return candidate

    found = shutil.which("opencode")
    return Path(found) if found else None


class OpenCodeNativeRuntime:
    """直接跑 `opencode run --format json`，把 NDJSON 折成内部事件。

    与 `impl.py` 里其他运行时同接口（`name` / `available()` / `run()` / `cancel()`），
    但不继承它们：那些走 HTTP，这个走子进程，生命周期管理完全不同。
    """

    name = "opencode"

    def __init__(
        self,
        binary: Optional[Path | str] = None,
        *,
        model_prefix: str = "",
        timeout: float = DEFAULT_TIMEOUT_S,
        extra_args: Optional[List[str]] = None,
    ) -> None:
        self.reason = ""
        resolved = Path(binary) if binary else _find_binary()
        self.binary: Optional[Path] = resolved if resolved and Path(resolved).is_file() else None
        self.model_prefix = model_prefix or os.environ.get(ENV_MODEL_PREFIX, DEFAULT_MODEL_PREFIX)
        self.timeout = float(timeout)
        self.extra_args = list(extra_args or [])
        self._procs: Dict[str, subprocess.Popen] = {}
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- 可用性
    def available(self) -> bool:
        """二进制在、且 `--version` 能跑通。

        只查文件存在是不够的：一个被截断的下载、一个架构不匹配的 exe 都存在但跑不起来。
        `--version` 是最便宜的真探测（不联网、不读配置、不花钱）。
        """
        if self.binary is None:
            self.reason = (
                "找不到 opencode 可执行文件。装法见 docs/operations/opencode.md；"
                f"或用 {ENV_BIN} 指定完整路径。")
            return False
        try:
            proc = subprocess.run(
                [str(self.binary), "--version"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=20, shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            self.reason = f"opencode --version 跑不起来：{type(exc).__name__}: {exc}"
            return False
        if proc.returncode != 0:
            self.reason = f"opencode --version 退出码 {proc.returncode}：{(proc.stderr or '').strip()[:200]}"
            return False
        if "opencode" not in (proc.stdout or "").lower():
            self.reason = f"opencode --version 输出不像 opencode：{(proc.stdout or '').strip()[:120]}"
            return False
        self.reason = ""
        return True

    # ---------------------------------------------------------------- 模型名
    def model_name(self, model: str) -> str:
        """`deepseek-v4.1-flash` → `commandcode/deepseek-v4.1-flash`。

        opencode 的 `--model` 要求 `provider/model`。不带 provider 的名字会被它
        当成"未知模型"然后回落到配置默认值 —— 一个**静默的**行为改变：
        你以为在用 A 模型，实际跑的是 B。所以这里显式补前缀，而不是留给它猜。
        """
        text = str(model or "").strip()
        if not text:
            return ""
        if "/" in text:
            return text
        return f"{self.model_prefix}{text}"

    # ---------------------------------------------------------------- 运行
    def run(self, req: RuntimeRequest) -> Iterator[Event]:
        if self.binary is None:
            raise RuntimeUnavailable(self.reason or "找不到 opencode 可执行文件")

        session = str(req.session_id or "")
        model = self.model_name(req.model)
        # prompt 是**位置参数**，不是 `--prompt`。
        # 实测：`opencode run --prompt x` 会直接报
        # `Unrecognized flag: --prompt in command opencode run` 然后打印帮助、退出码 1。
        # 这条只能靠真机验证发现——假脚本会照着我错误的写法写，两边一起错。
        message = str(req.prompt or "")
        if req.system:
            # opencode 没有独立的 system 参数；把 system 作为提示的前缀。
            # 不做"悄悄丢掉"——丢掉系统提示会让两个运行时的行为出现无法解释的差异。
            message = f"{req.system}\n\n{message}"

        argv = [str(self.binary), "run", "--format", "json"]
        if session:
            argv += ["--session", session]
        if model:
            argv += ["--model", model]
        argv += self.extra_args
        argv.append(message)

        try:
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                bufsize=1,
            )
        except OSError as exc:
            yield Event("error", session, {
                "class": "environment",
                "message": f"opencode 启动失败：{exc}",
                "retryable": False,
            })
            yield Event("message.done", session, {"reason": "error"})
            return

        with self._lock:
            self._procs[session] = proc

        started = time.monotonic()
        emitted_start = False
        last_reason = "stop"
        saw_tool = False
        errors: List[str] = []

        # stderr 必须在**后台线程**里读走。
        # 原因有两个：管道缓冲满时子进程会阻塞写 stderr（表现为"卡住不动"）；
        # 而如果在 `finally` 里先关管道、事后再读，就会读到空字符串——
        # 排查时最需要的那段 stderr 恰好被自己弄丢了。实测踩过。
        stderr_chunks: List[str] = []

        def _drain_stderr() -> None:
            try:
                if proc.stderr is not None:
                    for chunk in proc.stderr:
                        stderr_chunks.append(chunk)
            except (OSError, ValueError):  # pragma: no cover - 管道已关闭
                pass

        drain = threading.Thread(target=_drain_stderr, daemon=True)
        drain.start()

        def _stderr_text() -> str:
            drain.join(timeout=3)
            return "".join(stderr_chunks).strip()[:500]

        def _timed_out() -> bool:
            return (time.monotonic() - started) > self.timeout

        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                if _timed_out():
                    errors.append(f"超过 {self.timeout:.0f} 秒仍未结束")
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    # 非 JSON 行不当"噪音"扔掉：它可能是 opencode 的警告或崩溃栈，
                    # 那正是排查时要看的东西。折成 error 事件而不是静默跳过。
                    yield Event("error", session, {
                        "class": "execution",
                        "message": "opencode 输出了非 JSON 行（已保留原文片段）",
                        "retryable": False,
                        "detail": {"line": line[:500]},
                    })
                    continue

                if not emitted_start:
                    emitted_start = True
                    yield Event("session.start", session, {
                        "runtime": "opencode",
                        "model": model,
                        "native_session": str(payload.get("sessionID") or session),
                    })

                events, reason, had_tool = self._translate(payload, session)
                if reason:
                    last_reason = reason
                saw_tool = saw_tool or had_tool
                for event in events:
                    yield event

            if _timed_out():
                self._kill(proc)
                yield Event("error", session, {
                    "class": "environment",
                    "message": f"opencode 超过 {self.timeout:.0f} 秒超时，已结束进程",
                    "retryable": True,
                })
                yield Event("message.done", session, {"reason": "error"})
                return

            code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._kill(proc)
            yield Event("error", session, {
                "class": "environment", "message": "opencode 未在预期时间内退出",
                "retryable": True,
            })
            yield Event("message.done", session, {"reason": "error"})
            return
        finally:
            with self._lock:
                self._procs.pop(session, None)
            # 显式关管道：`Popen` 不会替我们关，而一次问答会起一个进程。
            # 不关的话，长跑的 daemon 每轮泄漏两个句柄，几百轮后就会撞上限
            # （Windows 上表现为"打不开文件"，很难联想到是这里）。
            # 用 getattr 取 close：调用方注入的替代实现（测试、或以后换成别的
            # IO 层）可能给的是不可关闭的迭代器，那不是错误。
            for stream in (proc.stdout, proc.stderr, proc.stdin):
                closer = getattr(stream, "close", None)
                if closer is None:
                    continue
                try:
                    closer()
                except (OSError, ValueError):  # pragma: no cover - 已关或已失效
                    pass

        if not emitted_start:
            # 一行都没读到：可能是配置错误、鉴权失败、或二进制静默退出。
            # 不补 session.start，直接报错 —— 假装"开始过"会让上层以为有内容。
            yield Event("error", session, {
                "class": "environment",
                "message": f"opencode 没有输出任何事件（退出码 {code}）",
                "retryable": code != 0,
                "detail": {"stderr": _stderr_text()},
            })
            yield Event("message.done", session, {"reason": "error"})
            return

        if code != 0:
            # 有输出但退出码非零：进程在跑到一半时出事了。**不补 stop**，
            # 否则前端会把一次崩溃显示成一次成功的空回答。
            yield Event("error", session, {
                "class": "execution",
                "message": f"opencode 退出码 {code}（已产出部分事件，保留不丢）",
                "retryable": True,
                "detail": {"stderr": _stderr_text()},
            })
            yield Event("message.done", session, {"reason": "error"})
            return

        for message in errors:
            yield Event("error", session, {
                "class": "environment", "message": message, "retryable": True,
            })
        yield Event("message.done", session, {
            "reason": "tool_calls" if (saw_tool and last_reason == "tool-calls") else "stop",
        })

    # ---------------------------------------------------------------- 翻译
    def _translate(self, payload: Dict[str, Any], session: str):
        """一行 NDJSON → (事件列表, 本行的 reason, 本行有没有工具)。

        返回 reason 与 had_tool 是为了让 `run()` 能决定最后那条 `message.done`
        该写 `stop` 还是 `tool_calls`——不要在 run() 里再解析一遍 payload。
        """
        kind = str(payload.get("type") or "")
        part = payload.get("part") if isinstance(payload.get("part"), dict) else {}
        part_type = str(part.get("type") or "")

        # ---- 工具调用：一条 tool_use 同时给出输入与（已完成的）输出
        if kind == "tool_use" or part_type == "tool":
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            call_id = str(part.get("id") or part.get("partID") or "")
            tool_name = str(part.get("tool") or "")
            raw_input = state.get("input")
            arguments = json.dumps(raw_input, ensure_ascii=False) if raw_input is not None else "{}"
            status = str(state.get("status") or "")
            ok = status == "completed"

            events = [
                Event("tool.call", session, {
                    "id": call_id,
                    "name": tool_name,
                    # 契约要求 arguments 是 **JSON 文本**，不是对象
                    "arguments": arguments,
                }),
                Event("tool.result", session, self._result_payload(
                    call_id, tool_name, ok, state)),
            ]
            return events, "", True

        # ---- 文本增量
        if kind == "text" or part_type == "text":
            text = part.get("text")
            if isinstance(text, str) and text:
                return [Event("message.delta", session, {"text": text})], "", False
            return [], "", False

        # ---- 一步结束：带 tokens 与 cost
        if kind == "step_finish" or part_type == "step-finish":
            reason = str(part.get("reason") or "")
            tokens = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
            prompt_tokens = int(tokens.get("input") or 0)
            completion_tokens = int(tokens.get("output") or 0) + int(tokens.get("reasoning") or 0)
            cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
            data: Dict[str, Any] = {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            }
            if cache.get("read"):
                data["cache_read_tokens"] = int(cache["read"])
            if part.get("cost") is not None:
                data["cost"] = part.get("cost")
            return [Event("usage", session, data)], reason, False

        # ---- 帧标记：有记录地忽略
        if part_type in INTENTIONALLY_IGNORED or kind in ("step_start", "step_finish"):
            return [], "", False

        # ---- 不认识的类型：**不静默丢**。这是本模块最重要的纪律。
        return [Event("error", session, {
            "class": "execution",
            "message": f"opencode 输出了未映射的事件类型 type={kind!r} part.type={part_type!r}",
            "retryable": False,
            "detail": {"sample": json.dumps(payload, ensure_ascii=False)[:500]},
        })], "", False

    @staticmethod
    def _result_payload(call_id: str, tool_name: str, ok: bool,
                        state: Dict[str, Any]) -> Dict[str, Any]:
        """把 opencode 的 `state` 折成契约要求的 `tool.result`。

        成功时给 `data`，失败时给 `error`（`{code,message,retryable}`）。
        **两者不要同时给**：契约说成败只看 `ok`，同时给会让下游各自猜一套优先级。
        """
        if ok:
            output = state.get("output")
            data: Dict[str, Any] = {}
            if isinstance(output, str):
                data["output"] = output
            elif output is not None:
                data["output"] = json.dumps(output, ensure_ascii=False)
            meta = state.get("metadata")
            if isinstance(meta, dict):
                inner = meta.get("metadata") if isinstance(meta.get("metadata"), dict) else {}
                if "exit" in inner:
                    data["exit_code"] = inner["exit"]
                if inner.get("truncated"):
                    data["truncated"] = True
            if state.get("title"):
                data["title"] = state["title"]
            return {"id": call_id, "name": tool_name, "ok": True, "data": data}

        return {
            "id": call_id,
            "name": tool_name,
            "ok": False,
            "error": {
                "code": "E_TOOL_FAILED",
                "message": str(state.get("error") or state.get("output") or "工具执行失败")[:500],
                # 工具失败不自动重试：写动作重试一次可能就是两次副作用。
                "retryable": False,
            },
        }

    # ---------------------------------------------------------------- 取消
    def cancel(self, session_id: str) -> None:
        """结束对应会话的子进程。

        **做不到"只取消当前工具"**：CLI 模式下一次 `run` 就是一个进程，
        没有中间控制通道。强行假装能精细取消，会让调用方以为工具停了而实际还在跑。
        这条限制是有意的取舍（见模块 docstring 的"为什么走 CLI"）。
        """
        with self._lock:
            proc = self._procs.get(str(session_id))
        if proc is None or proc.poll() is not None:
            return
        self._kill(proc)

    @staticmethod
    def _kill(proc: subprocess.Popen) -> None:
        """结束整棵进程树。

        Windows 上只 kill 父进程会留下 opencode 派生的子进程（它自己会起 shell 工具），
        所以用 `taskkill /T /F`。这与 `shell/electron/main.js` 的 `stopServer()` 同一条经验。
        """
        if proc.poll() is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/pid", str(proc.pid), "/T", "/F"],
                    capture_output=True, shell=False, timeout=10,
                )
            else:  # pragma: no cover - 本机是 Windows，这条只保证不崩
                proc.terminate()
        except (OSError, subprocess.SubprocessError):  # pragma: no cover
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            try:
                proc.kill()
            except OSError:
                pass
