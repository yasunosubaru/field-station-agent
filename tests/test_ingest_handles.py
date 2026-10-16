#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KI-03：读观测文件时不得泄漏文件句柄。

`docs/known-issues.md` 的 KI-03 记了三处裸读：

| 位置 | 代码 |
|---|---|
| `rinex2._gzip_bytes` | `raw = open(path, "rb").read()` |
| `rinex3.Rinex3Obs.__init__` | `raw = gunzip_if_needed(open(path, "rb").read())` |
| `reader._read_text` | `raw = open(path, "rb").read()` |

三处都是 `open(...)` 的返回值没被绑定到名字，`.read()` 之后文件对象就失去引用；
CPython 在它被回收时抛一条 `ResourceWarning: unclosed file <_io.BufferedReader …>`。
短时间批量读会积累未关闭的句柄。

## 三条路径各走一遍，不直调私有函数

三处各自只在一条路径上被走到，所以本文件用**公开入口** `ObservationFile` 逐个覆盖：

| 用例 | 夹具 | 走到哪一处 |
|---|---|---|
| `test_rinex2_path` | `RINEX2_OBS` | `rinex2._gzip_bytes` |
| `test_rinex3_path` | `RINEX3_OBS` | `rinex3.Rinex3Obs.__init__` |
| `test_csv_path` | `CSV_OBS`（本文件内联） | `reader._read_text` |
| `test_gzipped_rinex2_path` | `RINEX2_OBS` 压成 `.gz` | 同上第一处，走解压输入 |

CSV 那一处只有 `ObservationFile._open` 的 CSV 分支会走到（`reader.py:273`），
而仓库原先没有任何夹具走这条分支，所以这里内联一份最小宽表：
`sniff` 的判据是「首行含逗号且逗号分段 ≥ 4」（`reader.py:194`）。

## 怎么探测这条告警

`ResourceWarning` 默认被 `warnings` 的过滤器压掉，所以必须自己开
`simplefilter("always")` 并用 `catch_warnings(record=True)` 收；`open(...)` 的
临时对象在 CPython 上引用计数立刻归零、`__del__` 当场执行，因此告警就落在 `with`
块内，不需要额外 `gc.collect()`。断言的成立条件是**一条都没有**，不是「少于几条」。

修复前本文件的前三条用例应全红（`.gz` 那条同样红）。
"""
from __future__ import annotations

import gzip
import os
import tempfile
import unittest
import warnings

from fieldstation.ingest import reader
from tests.fixtures_rinex import RINEX2_OBS, RINEX3_OBS

_TMPDIR = tempfile.mkdtemp(prefix="fieldstation-handles-")

#: 最小 CSV 宽表（仓库自建格式，不是厂商原始格式）。首行 4 个以上逗号分段即可被
#: `reader.sniff` 认成 CSV；`_from_csv` 认 `C1` / `L1` 这类「CODE_KIND + 数字」列。
CSV_OBS = """station,gps_week,gps_tow_s,system,sv,C1,L1
TESTSTN,2295,96528.0,GPS,1,24258042.582,-127476828.326
TESTSTN,2295,96528.0,GPS,2,24258043.100,-127476900.000
"""


def _write(text: str, name: str) -> str:
    path = os.path.join(_TMPDIR, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return path


def _unclosed_file_warnings(call) -> list[str]:
    """跑 `call()`，返回其中抛出的「未关闭文件句柄」告警文本。"""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        call()
    return [str(w.message) for w in caught
            if issubclass(w.category, ResourceWarning)
            and "unclosed file" in str(w.message)]


def tearDownModule() -> None:
    import shutil
    shutil.rmtree(_TMPDIR, ignore_errors=True)


class TestNoLeakedFileHandles(unittest.TestCase):
    """KI-03：三条路径打开观测文件时都必须把句柄关掉。"""

    def test_rinex2_path(self):
        path = _write(RINEX2_OBS, "leak2.rnx")
        leaked = _unclosed_file_warnings(lambda: reader.ObservationFile(path))
        self.assertEqual(leaked, [], "RINEX 2 路径泄漏了文件句柄：%s" % leaked)

    def test_rinex3_path(self):
        path = _write(RINEX3_OBS, "leak3.rnx")
        leaked = _unclosed_file_warnings(lambda: reader.ObservationFile(path))
        self.assertEqual(leaked, [], "RINEX 3 路径泄漏了文件句柄：%s" % leaked)

    def test_csv_path(self):
        path = _write(CSV_OBS, "leak.csv")
        leaked = _unclosed_file_warnings(lambda: reader.ObservationFile(path))
        self.assertEqual(leaked, [], "CSV 路径泄漏了文件句柄：%s" % leaked)

    def test_gzipped_rinex2_path(self):
        """`.gz` 再走一遍：解压输入经过的还是同一处 `open`。"""
        path = os.path.join(_TMPDIR, "leak2.rnx.gz")
        with gzip.open(path, "wb") as fh:
            fh.write(RINEX2_OBS.encode("utf-8"))
        leaked = _unclosed_file_warnings(lambda: reader.ObservationFile(path))
        self.assertEqual(leaked, [], "RINEX 2（.gz）路径泄漏了文件句柄：%s" % leaked)
