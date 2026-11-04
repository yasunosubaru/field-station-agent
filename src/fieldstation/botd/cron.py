"""5 段 cron 的解析与下一跳计算（纯标准库）。

支持 ``*``、``*/n``、``a-b``、``a-b/n``、``a/n`` 与逗号列表；星期 0/7 都表示
周日。**不**支持 ``?``、月份/星期英文缩写、``@daily`` 之类的扩展 —— 遇到就报
明确错误，而不是猜。原因很简单：编队里定时任务写错一个字段，可能变成"每分钟
跑一次全站巡检"，静默容错比报错危险。

``next_after`` 严格返回**严格晚于** ``now`` 的下一跳。用"逐日 + 当日候选
时分"两层循环，最多看 8 年（含 2 月 29 日这种跨 4 年的组合）；不用"逐分钟
加一"，那条路在稀疏表达式上会跑上百万次。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import FrozenSet, Tuple


class CronError(ValueError):
    """非法 cron 表达式（字段数、范围、步长、语法）。"""


_FIELD_SPECS: Tuple[Tuple[str, int, int], ...] = (
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day_of_month", 1, 31),
    ("month", 1, 12),
    ("day_of_week", 0, 7),
)

_FIELD_LABELS = {
    "minute": "分钟",
    "hour": "小时",
    "day_of_month": "日",
    "month": "月",
    "day_of_week": "星期",
}

#: 最大搜索天数：8 年，覆盖 2 月 29 日 + 指定星期的组合。
_MAX_DAYS = 366 * 8


def _parse_int(text: str, *, field: str, expression: str) -> int:
    raw = text.strip()
    if not raw:
        raise CronError(
            f"无效 cron 表达式 {expression!r}：{_FIELD_LABELS[field]} 字段有空项"
        )
    if not raw.isdigit():
        raise CronError(
            f"无效 cron 表达式 {expression!r}："
            f"{_FIELD_LABELS[field]} 字段的值 {raw!r} 不是非负整数"
        )
    return int(raw)


def _parse_field(text: str, field: str, low: int, high: int,
                 expression: str) -> Tuple[FrozenSet[int], bool]:
    """解析一个字段，返回 (取值集合, 是否等价于全通配)。"""
    label = _FIELD_LABELS[field]
    values: set[int] = set()
    # 星期 7 先按 7 解析，最后归一成 0；范围 5-7 因此能正常落到 5,6,0。
    for part in text.split(","):
        piece = part.strip()
        if not piece:
            raise CronError(
                f"无效 cron 表达式 {expression!r}：{label} 字段列表里有空项"
            )
        step = 1
        base = piece
        if "/" in piece:
            base, _, step_text = piece.partition("/")
            if "/" in step_text:
                raise CronError(
                    f"无效 cron 表达式 {expression!r}：{label} 字段 {piece!r} 有多个 '/'"
                )
            step = _parse_int(step_text, field=field, expression=expression)
            if step <= 0:
                raise CronError(
                    f"无效 cron 表达式 {expression!r}：{label} 字段步长必须 ≥ 1"
                )
            if not base.strip():
                raise CronError(
                    f"无效 cron 表达式 {expression!r}：{label} 字段 {piece!r} 缺少数值"
                )
        base = base.strip()
        if base == "*":
            start, end = low, high
        elif "-" in base:
            first, _, last = base.partition("-")
            if "-" in last:
                raise CronError(
                    f"无效 cron 表达式 {expression!r}：{label} 字段 {piece!r} 不是合法范围"
                )
            start = _parse_int(first, field=field, expression=expression)
            end = _parse_int(last, field=field, expression=expression)
            if start > end:
                raise CronError(
                    f"无效 cron 表达式 {expression!r}："
                    f"{label} 字段范围 {start}-{end} 起点大于终点"
                )
        else:
            start = _parse_int(base, field=field, expression=expression)
            # "5/15" 表示"从 5 开始每 15 一个"，等价于 5-max/15。
            end = high if "/" in piece else start
        for value in (start, end):
            if value < low or value > high:
                raise CronError(
                    f"无效 cron 表达式 {expression!r}："
                    f"{label} 字段的值 {value} 超出范围 {low}-{high}"
                )
        values.update(range(start, end + 1, step))

    if field == "day_of_week":
        if 7 in values:
            values.discard(7)
            values.add(0)

    full = set(range(low, high + 1))
    if field == "day_of_week":
        full.discard(7)
    wildcard = values == full
    return frozenset(values), wildcard


@dataclass(frozen=True)
class CronExpr:
    """一个已解析的 5 段 cron 表达式。"""

    expression: str
    minutes: FrozenSet[int]
    hours: FrozenSet[int]
    days_of_month: FrozenSet[int]
    months: FrozenSet[int]
    days_of_week: FrozenSet[int]
    dom_wildcard: bool
    dow_wildcard: bool

    # ------------------------------------------------------------ 解析 --
    @classmethod
    def parse(cls, expression: str) -> "CronExpr":
        if not isinstance(expression, str) or not expression.strip():
            raise CronError("cron 表达式不能为空")
        fields = expression.split()
        if len(fields) != 5:
            raise CronError(
                f"无效 cron 表达式 {expression!r}：需要 5 段"
                "（分 时 日 月 周），实际 %d 段" % len(fields)
            )
        parsed = [
            _parse_field(text, field, low, high, expression)
            for text, (field, low, high) in zip(fields, _FIELD_SPECS)
        ]
        minutes, _ = parsed[0]
        hours, _ = parsed[1]
        doms, dom_wildcard = parsed[2]
        months, _ = parsed[3]
        dows, dow_wildcard = parsed[4]
        return cls(
            expression=expression.strip(),
            minutes=minutes,
            hours=hours,
            days_of_month=doms,
            months=months,
            days_of_week=dows,
            dom_wildcard=dom_wildcard,
            dow_wildcard=dow_wildcard,
        )

    # ---------------------------------------------------------- 匹配 --
    @staticmethod
    def _cron_weekday(moment: datetime) -> int:
        return (moment.weekday() + 1) % 7  # Python 周一=0；cron 周日=0

    def _day_matches(self, moment: datetime) -> bool:
        dom_ok = moment.day in self.days_of_month
        dow_ok = self._cron_weekday(moment) in self.days_of_week
        if self.dom_wildcard and self.dow_wildcard:
            return True
        if self.dom_wildcard:
            return dow_ok
        if self.dow_wildcard:
            return dom_ok
        # 标准 cron：日与星期都受限时取"或"，不是"与"。
        return dom_ok or dow_ok

    def matches(self, moment: datetime) -> bool:
        """``moment`` 的分钟是否命中（秒/微秒不参与判断）。"""
        return (
            moment.minute in self.minutes
            and moment.hour in self.hours
            and moment.month in self.months
            and self._day_matches(moment)
        )

    # ---------------------------------------------------------- 下一跳 --
    def next_after(self, now: datetime) -> datetime:
        """返回严格晚于 ``now`` 的第一个命中时间点（秒/微秒归零）。"""
        if not isinstance(now, datetime):
            raise TypeError("next_after 需要 datetime")
        candidate = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
        hours = sorted(self.hours)
        minutes = sorted(self.minutes)
        day = candidate
        for _ in range(_MAX_DAYS + 1):
            if day.month in self.months and self._day_matches(day):
                first_hour = day.hour
                for hour in hours:
                    if hour < first_hour:
                        continue
                    first_minute = day.minute if hour == first_hour else 0
                    for minute in minutes:
                        if minute < first_minute:
                            continue
                        return day.replace(
                            hour=hour, minute=minute, second=0, microsecond=0
                        )
            day = (day + timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        raise CronError(
            f"cron 表达式 {self.expression!r} 在 {_MAX_DAYS} 天内没有下一跳"
            "（日/月/星期的组合可能永远不成立）"
        )

    def __str__(self) -> str:  # pragma: no cover - 调试输出
        return self.expression


def parse(expression: str) -> CronExpr:
    return CronExpr.parse(expression)


def next_after(expression: str, now: datetime) -> datetime:
    return CronExpr.parse(expression).next_after(now)
