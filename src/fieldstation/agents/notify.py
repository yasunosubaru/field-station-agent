"""上报通道：Webhook（M6-6，issue #110）。

**默认 dry-run**：不发任何请求，只把「将要发什么」写进审计。要真发，必须同时
满足三件事 —— 显式构造一个非 dry-run 的 notifier、给了 URL、调用方主动触发。
仓库里的默认路径（回放、看板、测试）全部走 dry-run，CI 不联网。

## 契约（载荷）

只发**摘要**，不发完整日志，也不发本机绝对路径：

| 字段 | 含义 |
|---|---|
| ``version`` | 载荷版本，当前 1 |
| ``event`` | 固定 ``station_alert`` |
| ``level`` | ``warn`` / ``critical`` |
| ``station`` | 台站 id |
| ``source`` | 告警来源（``heartbeat`` / ``station_health`` / ``data_quality``） |
| ``title`` | 一行标题（换行折成空格） |
| ``detail`` | 摘要（换行折成空格、截断到 ``DETAIL_MAX`` 字符） |
| ``evidence`` | 证据列表；只保留 ``agent`` / ``call_id`` |
| ``generated_at`` | 生成时间（由调用方给，不读墙钟） |
| ``log_path`` | 本地日志路径（相对仓库；家目录已替换成 ``<home>``） |

## 失败语义

* 上报失败**不影响链路结论**：``send`` 返回失败结果，不抛异常；
* 重试有上限（``max_attempts``），每一次尝试都进审计；
* 4xx（除 429）不重试 —— 对方明确拒绝，重试只会更糟；
* 审计里只记 URL 的 ``host``，不记完整 URL（Webhook URL 常带 token）。

本模块只用标准库。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from .tools.heartbeat_tools import ROOT

#: 载荷里允许出现的字段（白名单；上游多给的字段一律丢弃）。
PAYLOAD_FIELDS = ("version", "event", "level", "station", "source", "title",
                  "detail", "evidence", "generated_at", "log_path")
#: ``detail`` 的上限：只发摘要，完整日志留在本地。
DETAIL_MAX = 240
#: 环境变量名（URL 不入库）。
ENV_ENABLED = "FIELD_STATION_WEBHOOK_ENABLED"
ENV_URL = "FIELD_STATION_WEBHOOK_URL"
ENV_TIMEOUT = "FIELD_STATION_WEBHOOK_TIMEOUT"
ENV_ATTEMPTS = "FIELD_STATION_WEBHOOK_MAX_ATTEMPTS"

TRUE_VALUES = ("1", "true", "yes", "on")


def _one_line(text, limit: int | None = None) -> str:
    """折成一行并可选截断；家目录替换成 ``<home>``（审计与载荷都要入库）。"""
    value = "" if text is None else str(text)
    home = str(Path.home())
    for form in (home, home.replace("\\", "/")):
        if form:
            value = value.replace(form, "<home>")
    value = " ".join(value.split())
    if limit is not None and len(value) > limit:
        value = value[: max(0, limit - 1)] + "…"
    return value


def build_payload(alert: dict, *, generated_at: str,
                  log_path: str = "") -> dict:
    """按白名单拼载荷；缺字段给空串，不猜内容。"""
    if not isinstance(alert, dict):
        raise ValueError("alert 必须是 object")
    evidence = []
    for item in alert.get("evidence") or []:
        if isinstance(item, dict):
            evidence.append({
                "agent": _one_line(item.get("agent"), 64),
                "call_id": _one_line(item.get("call_id"), 64),
            })
    payload = {
        "version": 1,
        "event": "station_alert",
        "level": _one_line(alert.get("level"), 32),
        "station": _one_line(alert.get("station"), 64),
        "source": _one_line(alert.get("source"), 64),
        "title": _one_line(alert.get("title"), 160),
        "detail": _one_line(alert.get("detail"), DETAIL_MAX),
        "evidence": evidence,
        "generated_at": _one_line(generated_at, 64),
        "log_path": _one_line(log_path, 200),
    }
    return {key: payload[key] for key in PAYLOAD_FIELDS}


@dataclass
class DeliveryResult:
    """一次 ``send`` 的结果：``dry_run`` / ``sent`` / ``failed``。"""

    status: str
    attempts: int
    payload: dict
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status in ("dry_run", "sent")


class WebhookNotifier:
    """Webhook 上报器。``dry_run=True`` 时 ``send`` 永不触网。"""

    def __init__(self, url: str | None = None, *, dry_run: bool = True,
                 timeout_s: float = 5.0, max_attempts: int = 2,
                 retry_backoff_s: float = 0.0,
                 audit_path: str | Path | None = None,
                 opener=None) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts 必须 ≥ 1")
        if timeout_s <= 0:
            raise ValueError("timeout_s 必须是正数")
        self.url = (url or "").strip()
        # 没有 URL 就不可能真发 —— 无论如何都是 dry-run。
        self.dry_run = bool(dry_run) or not self.url
        self.timeout_s = float(timeout_s)
        self.max_attempts = int(max_attempts)
        self.retry_backoff_s = max(0.0, float(retry_backoff_s))
        self.audit_path = Path(audit_path) if audit_path else None
        self._opener = opener

    @classmethod
    def from_env(cls, env: dict | None = None, *,
                 audit_path: str | Path | None = None,
                 opener=None) -> "WebhookNotifier":
        """从环境变量读配置。``ENABLED`` 未开 → dry-run（即使给了 URL）。"""
        import os
        source = os.environ if env is None else env
        enabled = str(source.get(ENV_ENABLED, "")).strip().lower() in TRUE_VALUES
        url = str(source.get(ENV_URL, "")).strip()
        timeout = float(source.get(ENV_TIMEOUT, "5") or 5)
        attempts = int(source.get(ENV_ATTEMPTS, "2") or 2)
        return cls(url, dry_run=not enabled, timeout_s=timeout,
                   max_attempts=attempts, audit_path=audit_path,
                   opener=opener)

    # ------------------------------------------------------------- 审计
    def _audit(self, *, generated_at: str, status: str, attempt: int,
               payload: dict, error: str = "") -> None:
        if self.audit_path is None:
            return
        host = urlparse(self.url).netloc if self.url else ""
        row = {
            "ts": _one_line(generated_at, 64),
            "event": "station_alert.webhook",
            "status": status,
            "attempt": attempt,
            "level": payload.get("level", ""),
            "station": payload.get("station", ""),
            "source": payload.get("source", ""),
            "title": payload.get("title", ""),
            "url_host": host,
            "error": _one_line(error, 200),
        }
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    # ------------------------------------------------------------- 发送
    def _post(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False,
                          sort_keys=True).encode("utf-8")
        request = urllib.request.Request(
            self.url, data=body, method="POST",
            headers={"Content-Type": "application/json; charset=utf-8",
                     "User-Agent": "field-station-agent/webhook"})
        if self._opener is not None:
            response = self._opener.open(request, timeout=self.timeout_s)
        else:
            response = urllib.request.urlopen(request, timeout=self.timeout_s)
        try:
            response.read()
        finally:
            response.close()

    def send(self, alert: dict, *, generated_at: str,
             log_path: str = "") -> DeliveryResult:
        """发一条告警摘要。**不抛异常**；失败只体现在返回值与审计里。"""
        payload = build_payload(alert, generated_at=generated_at,
                                log_path=log_path)
        if self.dry_run:
            self._audit(generated_at=generated_at, status="dry_run", attempt=0,
                        payload=payload)
            return DeliveryResult("dry_run", 0, payload)

        errors: list[str] = []
        for attempt in range(1, self.max_attempts + 1):
            try:
                self._post(payload)
            except urllib.error.HTTPError as exc:
                error = f"HTTP {exc.code}"
                errors.append(error)
                # 4xx（429 除外）是对方明确拒绝：不重试。
                retryable = (exc.code == 429 or exc.code >= 500) and \
                    attempt < self.max_attempts
                self._audit(generated_at=generated_at,
                            status="retry" if retryable else "failed",
                            attempt=attempt, payload=payload, error=error)
                if not retryable:
                    return DeliveryResult("failed", attempt, payload, errors)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                error = f"{type(exc).__name__}: {exc}"
                errors.append(error)
                self._audit(generated_at=generated_at,
                            status="retry" if attempt < self.max_attempts
                            else "failed",
                            attempt=attempt, payload=payload, error=error)
            else:
                self._audit(generated_at=generated_at, status="sent",
                            attempt=attempt, payload=payload)
                return DeliveryResult("sent", attempt, payload)
            if attempt < self.max_attempts and self.retry_backoff_s:
                time.sleep(self.retry_backoff_s)
        return DeliveryResult("failed", len(errors), payload, errors)


def notify_alerts(notifier: WebhookNotifier, alerts, *, generated_at: str,
                  log_path: str = "") -> list[DeliveryResult]:
    """逐条发；单条失败不影响后续条（上报不是链路的一部分）。"""
    return [notifier.send(alert, generated_at=generated_at, log_path=log_path)
            for alert in alerts or []]


__all__ = ["PAYLOAD_FIELDS", "DETAIL_MAX", "DeliveryResult", "WebhookNotifier",
           "build_payload", "notify_alerts"]
