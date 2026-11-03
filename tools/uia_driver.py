#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""uia_driver.py —— 用 Windows UI Automation 操作**原版套件**的 GUI 驱动。

流程执行器只认逻辑控件名（``Device``、``Apply``、``Device > Update > Firmware file``），
本模块把它们翻译成 UIA 条件（Name / AutomationId / ControlType）并执行。**没有任何坐标**：

* 找不到控件就报 ``GuiUnavailable`` 并带上实际搜索条件，绝不点一个「大概的位置」；
* 只驱动 ``NovAtelApplicationSuite`` 的窗口，不碰桌面其它程序；
* 截图用 ``PrintWindow(PW_RENDERFULLCONTENT)``，必须在交互会话里跑。

为什么用 PowerShell 而不是 Python 扩展：本仓库的 Python 侧**零第三方依赖**，而
``UIAutomationClient`` 是 Windows 自带的 .NET 程序集。脚本本体纯 ASCII（PS 5.1 无 BOM
按 GBK 读，中文字面量会解析失败），所有参数经环境变量传入。

**前提**：原版套件要以 ``--force-renderer-accessibility`` 启动。Electron 默认不把网页内容
暴露给 UIA，只会看到一个 ``Intermediate D3D Window``；不带这个开关时本驱动会明确报
「control not found」，不会去猜坐标。用 :mod:`tools.suite_launcher` 启动（它固定带这个
开关），不要手工点图标。

用法::

    python tools/suite_launcher.py --launch    # 用正确的开关启动套件
    python tools/uia_driver.py --check         # 装没装、能不能驱动、选择器缺什么（JSON）
    python tools/uia_driver.py --read "Model"  # 读一个控件（调试用）

在流程里通过 ``--driver uia`` 使用（``fieldstation.workflows.gui.load_driver`` 会加载
本文件并调用 :func:`create`）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

__all__ = [
    "GuiUnavailable",
    "REQUIRED_CONTROLS",
    "UiaDriver",
    "check",
    "create",
    "load_selectors",
    "missing_locators",
    "workflow_locators",
]

_HERE = Path(__file__).resolve().parent
_SELECTORS_PATH = _HERE / "uia_selectors.json"
_DEFAULT_SUITE = Path(r"C:\Program Files\NovAtel Inc\NovAtel Application Suite")
_DEFAULT_EXE = "NovAtelApplicationSuite.exe"
_DEFAULT_PROCESS = "NovAtelApplicationSuite"

#: 纯 ASCII。参数全部从环境变量读，避免引号/中文在 PS 5.1 里的编码坑。
_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

$action = $env:UIA_ACTION
$locator = $null
if ($env:UIA_LOCATOR) { $locator = $env:UIA_LOCATOR | ConvertFrom-Json }
$value = $env:UIA_VALUE
$out = $env:UIA_OUT
$processName = $env:UIA_PROCESS

$winSig = @'
using System;
using System.Runtime.InteropServices;
public class UiaWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@
Add-Type -TypeDefinition $winSig -ErrorAction SilentlyContinue

function Get-SuiteWindow {
  $procs = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 })
  if ($procs.Count -eq 0) { return $null }
  return [System.Windows.Automation.AutomationElement]::FromHandle($procs[0].MainWindowHandle)
}

function Find-Desc([System.Windows.Automation.AutomationElement]$root, $desc) {
  if (-not $desc) { return $root }
  $names = @()
  if ($desc.names) { $names = @($desc.names) }
  elseif ($desc.name) { $names = @($desc.name) }
  if ($names.Count -eq 0) { $names = @($null) }
  foreach ($n in $names) {
    $conds = New-Object System.Collections.ArrayList
    if ($n) {
      [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $n)))
    }
    if ($desc.automationId) {
      [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $desc.automationId)))
    }
    if ($desc.controlType) {
      $ct = [System.Windows.Automation.ControlType]::$($desc.controlType)
      if ($ct) {
        [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)))
      }
    }
    if ($conds.Count -eq 0) { return $root }
    $cond = $conds[0]
    if ($conds.Count -gt 1) {
      $cond = New-Object System.Windows.Automation.AndCondition -ArgumentList (,[System.Windows.Automation.Condition[]]$conds.ToArray())
    }
    $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($found) { return $found }
  }
  return $null
}

function Wait-El($root, $desc, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $el = Find-Desc $root $desc
    if ($el) { return $el }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Invoke-El($el) {
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    return 'invoke'
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $p.Select()
    return 'select'
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $p.DoDefaultAction()
    return 'legacy'
  } catch {}
  throw 'control exposes no Invoke/SelectionItem/LegacyIAccessible pattern'
}

function Read-El($el) {
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$p.Current.Value
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    return [string]$p.DocumentRange.GetText(-1)
  } catch {}
  return [string]$el.Current.Name
}

function Save-Shot([System.Windows.Automation.AutomationElement]$win, $path) {
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  $rect = New-Object UiaWin+RECT
  [void][UiaWin]::GetWindowRect($hwnd, [ref]$rect)
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw 'suite window has no size' }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [UiaWin]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); throw 'PrintWindow failed' }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$result = @{ ok = $false }
try {
  $win = Get-SuiteWindow
  if (-not $win) { throw "NovAtel Application Suite is not running (process: $processName)" }

  if ($action -eq 'focus') {
    $win.SetFocus()
    $result = @{ ok = $true; action = 'focus'; name = [string]$win.Current.Name }
  }
  elseif ($action -eq 'open') {
    $segments = @()
    if ($value) { $segments = @($value -split '\s*>\s*') }
    $win.SetFocus()
    foreach ($segment in $segments) {
      if (-not $segment) { continue }
      if (-not $locator.$segment) { throw "no selector for menu segment '$segment'" }
      $el = Wait-El $win $locator.$segment 8
      if (-not $el) { throw "menu segment not found: $segment" }
      [void](Invoke-El $el)
      Start-Sleep -Milliseconds 350
    }
    $result = @{ ok = $true; action = 'open'; text = $value }
  }
  elseif ($action -eq 'click') {
    $el = Wait-El $win $locator 8
    if (-not $el) { throw 'control not found' }
    $how = Invoke-El $el
    $result = @{ ok = $true; action = 'click'; how = $how; name = [string]$el.Current.Name }
  }
  elseif ($action -eq 'type') {
    $el = Wait-El $win $locator 8
    if (-not $el) { throw 'control not found' }
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($value)
    $result = @{ ok = $true; action = 'type'; name = [string]$el.Current.Name }
  }
  elseif ($action -eq 'read') {
    $el = Wait-El $win $locator 8
    if (-not $el) { throw 'control not found' }
    $text = Read-El $el
    $result = @{ ok = $true; action = 'read'; text = $text; name = [string]$el.Current.Name }
  }
  elseif ($action -eq 'select') {
    $el = Wait-El $win $locator 8
    if (-not $el) { throw 'control not found' }
    try {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      $p.Expand()
      Start-Sleep -Milliseconds 200
    } catch {}
    $item = Wait-El $el @{ names = @($value); controlType = 'ListItem' } 5
    if (-not $item) { $item = Wait-El $win @{ names = @($value) } 5 }
    if (-not $item) { throw "option not found: $value" }
    [void](Invoke-El $item)
    $result = @{ ok = $true; action = 'select'; text = $value }
  }
  elseif ($action -eq 'screenshot') {
    Save-Shot $win $out
    $result = @{ ok = $true; action = 'screenshot'; path = $out }
  }
  else {
    throw "unknown action: $action"
  }
}
catch {
  $result = @{ ok = $false; error = $_.Exception.Message; action = $action }
}

$result | ConvertTo-Json -Compress -Depth 6
if (-not $result.ok) { exit 3 }
"""


class GuiUnavailable(RuntimeError):
    """原版套件不在、控件找不到，或这个驱动在这一步做不了。"""


def load_selectors(path: str | Path | None = None) -> dict:
    p = Path(path) if path else _SELECTORS_PATH
    with p.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data.get("controls"), dict):
        raise ValueError(f"{p} 缺少 controls")
    return data


#: 新流程（``workflows/gui.*.yaml``）点名要用到的逻辑控件。缺一条，``--check``
#: 就把它列进 ``missing``——这样「流程能跑」不靠人记得补选择器。
REQUIRED_CONTROLS: tuple[str, ...] = (
    "Graph",
    "Add Device",
    "Refresh ports",
    "Connect",
    "Settings",
    "Auto Updates",
    "Auto Updates status",
    "New Project",
    "Create from SBF",
    "Create from CSV",
    "SBF file",
    "Project name",
    "Next",
    "Process",
    "Graph > Pre-process > Flags",
    "Graph > Projects > Current",
    "Add application",
    "Application package",
    "Add application > Package",
    "Install",
    "Update application",
    "Update application > Application",
    "My Applications > Installed",
    "My Applications > Version",
)

#: YAML 里 ``locator:`` / ``control:`` 的行。只取标量，不引 yaml 依赖：本模块
#: 要能在 payload 里单独加载，不能假设 ``fieldstation`` 已经导入。
_LOCATOR_LINE = re.compile(
    r"^\s*(?:-\s*)?(?:locator|control):\s*(?P<value>[^\r\n#]+?)\s*$", re.MULTILINE)


def _workflow_dir(workflows_dir: str | Path | None = None) -> Path:
    return Path(workflows_dir) if workflows_dir else _HERE.parent / "workflows"


def workflow_locators(workflows_dir: str | Path | None = None) -> list[str]:
    """扫工作流 YAML，返回它们引用的逻辑控件名（去重、排序）。"""
    folder = _workflow_dir(workflows_dir)
    if not folder.is_dir():
        return []
    found: set[str] = set()
    for path in sorted(folder.glob("*.yaml")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for match in _LOCATOR_LINE.finditer(text):
            value = match.group("value").strip().strip("'\"")
            if value and not value.startswith("$"):
                found.add(value)
    return sorted(found)


def missing_locators(selectors: dict | None = None,
                     workflows_dir: str | Path | None = None) -> list[str]:
    """选择器表缺哪些名字。

    两类都算缺：``REQUIRED_CONTROLS`` 里没有的键，以及工作流引用了但表里（含
    ``A > B`` 退到末段）仍解析不到的名字。
    """
    controls = (selectors or load_selectors()).get("controls") or {}
    missing = {name for name in REQUIRED_CONTROLS if name not in controls}
    for locator in workflow_locators(workflows_dir):
        if locator in controls:
            continue
        if locator.split(">")[-1].strip() in controls:
            continue
        missing.add(locator)
    return sorted(missing)


def check(selectors: dict | None = None, suite_dir: str | Path | None = None,
          workflows_dir: str | Path | None = None) -> dict:
    """``--check`` 的完整报告：装没装、能不能驱动、选择器缺什么。"""
    driver = UiaDriver(selectors=selectors, suite_dir=suite_dir)
    controls = driver.selectors.get("controls") or {}
    powershell = shutil.which("powershell") or shutil.which("pwsh") or ""
    windows = sys.platform == "win32"
    return {
        "installed": bool(driver.available),
        "available": bool(driver.available and windows and powershell),
        "windows": windows,
        "powershell": powershell,
        "suite": str(driver.suite_dir),
        "exe": str(driver.exe),
        "process": driver.process,
        "selectorFile": str(_SELECTORS_PATH),
        "selectors": sorted(controls.keys()),
        "missing": missing_locators(driver.selectors, workflows_dir),
    }


class UiaDriver:
    """按 UIA 条件操作原版套件。``available`` 只代表「套件装了」，不代表「现在开着」。"""

    name = "uia"

    def __init__(
        self,
        selectors: dict | None = None,
        suite_dir: str | Path | None = None,
        ps_timeout: float = 30.0,
    ) -> None:
        self.selectors = selectors or load_selectors()
        suite = Path(suite_dir) if suite_dir else Path(
            os.environ.get("NOVATEL_SUITE", str(_DEFAULT_SUITE)))
        self.suite_dir = suite
        self.exe = suite / str(
            (self.selectors.get("suite") or {}).get("exe") or _DEFAULT_EXE)
        self.process = str(
            os.environ.get("NOVATEL_SUITE_PROCESS")
            or (self.selectors.get("window") or {}).get("process")
            or _DEFAULT_PROCESS)
        self.ps_timeout = float(ps_timeout)
        self.log: list[dict] = []

    # ------------------------------------------------------------------ 能力
    @property
    def available(self) -> bool:
        return self.exe.is_file()

    def _require(self) -> None:
        if not self.available:
            raise GuiUnavailable(
                f"没找到原版套件：{self.exe}（装套件，或把 NOVATEL_SUITE 指向安装目录）")

    # ------------------------------------------------------------------ 动作
    def open(self, page: str) -> None:
        """``page`` 为空 / ``manage`` 时只聚焦；``Device > Update`` 逐级点菜单。"""
        self._require()
        text = "" if (page or "").strip().lower() in ("", "manage") else page
        self._call("open", locator=self.selectors.get("controls") or {}, value=text)

    def read(self, control: str) -> str:
        self._require()
        result = self._call("read", locator=self._control(control))
        return str(result.get("text", ""))

    def click(self, locator: str) -> None:
        self._require()
        self._call("click", locator=self._control(locator))

    def type_text(self, locator: str, text: str) -> None:
        self._require()
        self._call("type", locator=self._control(locator), value=text)

    def select(self, locator: str, option: str) -> None:
        self._require()
        self._call("select", locator=self._control(locator), value=option)

    def screenshot(self, path: Path) -> str | None:
        self._require()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        result = self._call("screenshot", out=str(path))
        return str(result.get("path") or path)

    # ------------------------------------------------------------------ 内部
    def _control(self, locator: str) -> object:
        controls = self.selectors.get("controls") or {}
        if locator in controls:
            return controls[locator]
        # ``Device > Update > Firmware file`` 这类组合读值控件：退到最后一个片段
        tail = str(locator).split(">")[-1].strip()
        if tail in controls:
            return controls[tail]
        raise GuiUnavailable(
            f"选择器表里没有 {locator!r}；给 tools/uia_selectors.json 的 controls 补一条")

    def _call(self, action: str, *, locator: object = None, value: object = None,
              out: object = None) -> dict:
        payload = {"action": action, "ok": False}
        with tempfile.TemporaryDirectory(prefix="uia-") as tmp:
            script = Path(tmp) / "uia-action.ps1"
            script.write_text(_PS_SCRIPT, encoding="ascii", newline="\r\n")
            env = dict(os.environ)
            env.update({
                "UIA_ACTION": action,
                "UIA_VALUE": "" if value is None else str(value),
                "UIA_LOCATOR": "" if locator is None else json.dumps(
                    locator if isinstance(locator, dict) else {"names": [str(locator)]},
                    ensure_ascii=False),
                "UIA_OUT": "" if out is None else str(out),
                "UIA_PROCESS": self.process,
            })
            try:
                completed = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive",
                     "-ExecutionPolicy", "Bypass", "-File", str(script)],
                    capture_output=True, text=True, encoding="utf-8",
                    errors="replace", env=env, timeout=self.ps_timeout,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except FileNotFoundError as exc:
                raise GuiUnavailable("找不到 powershell.exe，UIA 驱动只在 Windows 可用") from exc
            except subprocess.TimeoutExpired as exc:
                raise GuiUnavailable(
                    f"UIA 动作 {action!r} 超过 {self.ps_timeout:g}s 未返回") from exc
        text = (completed.stdout or "").strip().splitlines()
        raw = text[-1] if text else ""
        try:
            payload = json.loads(raw) if raw else {"ok": False, "error": "PowerShell 没有输出"}
        except ValueError as exc:
            raise GuiUnavailable(
                f"UIA 输出不是 JSON：{raw[:300]!r}\n{(completed.stderr or '')[:300]}") from exc
        self.log.append({"action": action, "ok": bool(payload.get("ok")),
                         "value": value, "out": out})
        if not payload.get("ok"):
            raise GuiUnavailable(
                f"UIA {action} 失败：{payload.get('error') or '未知原因'}"
                f"（locator={locator!r}, value={value!r}）")
        return payload


def create() -> UiaDriver:
    """``fieldstation.workflows.gui.load_driver('uia')`` 的入口。"""
    return UiaDriver()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="原版套件 UIA 驱动（调试用）")
    ap.add_argument("--check", action="store_true", help="只报告套件是否安装 / 是否存在窗口")
    ap.add_argument("--read", metavar="CONTROL", help="读一个逻辑控件")
    ap.add_argument("--click", metavar="CONTROL", help="点一个逻辑控件")
    ap.add_argument("--open", metavar="PAGE", help="聚焦窗口或逐级打开菜单")
    ap.add_argument("--screenshot", metavar="PATH", help="打印窗口到 PNG")
    args = ap.parse_args(argv)

    driver = UiaDriver()
    if args.check:
        print(json.dumps(check(selectors=driver.selectors,
                               suite_dir=driver.suite_dir),
                         ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if driver.available else 1

    try:
        if args.open:
            driver.open(args.open)
        if args.read:
            print(driver.read(args.read))
        if args.click:
            driver.click(args.click)
        if args.screenshot:
            print(driver.screenshot(Path(args.screenshot)))
    except GuiUnavailable as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
