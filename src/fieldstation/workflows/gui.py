"""gui —— GUI 驱动边界。

原版 GUI 的操作要变成固定流程，只有两条路：

1. **有驱动**（Windows UIA / 浏览器自动化）：``gui`` 步骤真的去点、去填、去读控件值。
2. **没有驱动**：流程**不假装点过**。``gui`` / ``verify_ui`` 步骤变成一条
   ``waiting_operator`` 的人工任务，把要做的事写成明确指令，人做完再 ``resume``。
   这是本项目「不伪造证据」约束的直接落地——截图和控件值只能来自真实驱动。

本模块只定义边界与两种内置实现；真正的 UIA 驱动是可选插件，按模块名加载，
不装就不存在。
"""
from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path
from typing import Protocol, runtime_checkable

__all__ = [
    "AssistedDriver",
    "GuiDriver",
    "GuiUnavailable",
    "ScriptedDriver",
    "describe_driver",
    "load_driver",
]

_ROOT = Path(__file__).resolve().parents[3]


class GuiUnavailable(RuntimeError):
    """没有可用的 GUI 驱动，或驱动拒绝了这个动作。"""


@runtime_checkable
class GuiDriver(Protocol):
    """一个能操作 GUI 的驱动。所有坐标/控件名都是**驱动自己的词汇**，流程只传字符串。"""

    name: str
    available: bool

    def open(self, page: str) -> None:
        ...

    def read(self, control: str) -> str:
        ...

    def click(self, locator: str) -> None:
        ...

    def type_text(self, locator: str, text: str) -> None:
        ...

    def select(self, locator: str, option: str) -> None:
        ...

    def screenshot(self, path: Path) -> str | None:
        """把当前界面存到 ``path``；返回实际写出的路径，驱动不支持时返回 ``None``。"""
        ...


class AssistedDriver:
    """没有驱动时的占位：``available=False``，任何动作都明确拒绝。

    它存在的意义是让「有没有驱动」成为一个**可查询的事实**，而不是让执行器
    用 ``try/except`` 猜。
    """

    name = "assisted"
    available = False

    def _refuse(self, what: str) -> None:
        raise GuiUnavailable(
            f"没有 GUI 驱动，不能{what}。装驱动后重试，或让流程以 assisted 模式"
            "生成人工任务（waiting_operator）。")

    def open(self, page: str) -> None:
        self._refuse(f"打开页面 {page!r}")

    def read(self, control: str) -> str:
        self._refuse(f"读取控件 {control!r}")
        return ""

    def click(self, locator: str) -> None:
        self._refuse(f"点击 {locator!r}")

    def type_text(self, locator: str, text: str) -> None:
        self._refuse(f"在 {locator!r} 输入")

    def select(self, locator: str, option: str) -> None:
        self._refuse(f"在 {locator!r} 选择 {option!r}")

    def screenshot(self, path: Path) -> str | None:
        return None


class ScriptedDriver:
    """测试与演练用：读值来自预置表，动作只记账，截图写一个带标记的文件。

    **不要**在生产流程里用它冒充真实驱动——它写出的「截图」不是屏幕内容。
    """

    name = "scripted"
    available = True

    def __init__(self, reads: dict[str, str] | None = None,
                 screenshots: bool = True) -> None:
        self.reads = dict(reads or {})
        self.actions: list[dict] = []
        self.screenshots = screenshots

    def _record(self, action: str, **fields: object) -> None:
        self.actions.append({"action": action, **fields})

    def open(self, page: str) -> None:
        self._record("open", page=page)

    def read(self, control: str) -> str:
        self._record("read", control=control)
        if control not in self.reads:
            raise GuiUnavailable(f"scripted 驱动没有为 {control!r} 预置读值")
        return self.reads[control]

    def click(self, locator: str) -> None:
        self._record("click", locator=locator)

    def type_text(self, locator: str, text: str) -> None:
        self._record("type", locator=locator, text=text)

    def select(self, locator: str, option: str) -> None:
        self._record("select", locator=locator, option=option)

    def screenshot(self, path: Path) -> str | None:
        if not self.screenshots:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"SCRIPTED-SCREENSHOT\n")
        self._record("screenshot", path=str(path))
        return str(path)


def load_driver(name: str = "assisted") -> GuiDriver:
    """按名字加载驱动。

    * ``assisted``（默认）：没有驱动，GUI 步骤走人工任务。
    * ``scripted``：测试用，生产环境不要用。
    * ``uia``：仓库自带的 Windows UI Automation 驱动（``tools/uia_driver.py``）。
    * 其它名字：当作模块名导入；以 ``.py`` 结尾或含路径分隔符时按文件加载。
      模块必须提供 ``create() -> GuiDriver``。
    """
    key = (name or "assisted").strip().lower()
    if key in ("", "assisted", "none"):
        return AssistedDriver()
    if key == "scripted":
        return ScriptedDriver()
    if key == "uia":
        return _load_path(_ROOT / "tools" / "uia_driver.py")
    if key == "cdp":
        return _load_path(_ROOT / "tools" / "cdp_driver.py")
    if key.endswith(".py") or "/" in key or "\\" in key:
        path = Path(name)
        if not path.is_absolute():
            path = _ROOT / path
        return _load_path(path)
    module_name = name if "." in name else f"fieldstation.workflows.{name}"
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise GuiUnavailable(
            f"GUI 驱动 {name!r} 不存在（导入 {module_name} 失败）：{exc}") from exc
    return _factory(module, module_name)


def _factory(module: object, label: str) -> GuiDriver:
    factory = getattr(module, "create", None)
    if not callable(factory):
        raise GuiUnavailable(f"GUI 驱动模块 {label} 没有 create()")
    driver = factory()
    if not getattr(driver, "available", False):
        raise GuiUnavailable(f"GUI 驱动 {label!r} 报告自己不可用")
    return driver


def _load_path(path: Path) -> GuiDriver:
    if not path.is_file():
        raise GuiUnavailable(f"GUI 驱动文件不存在：{path}")
    module_name = f"fieldstation_gui_driver_{path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise GuiUnavailable(f"加载 GUI 驱动失败：{path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 —— 驱动自己的导入错误要原样带出
        raise GuiUnavailable(f"GUI 驱动 {path} 导入失败：{exc}") from exc
    return _factory(module, str(path))


def describe_driver(driver: GuiDriver) -> dict:
    return {
        "name": getattr(driver, "name", type(driver).__name__),
        "available": bool(getattr(driver, "available", False)),
    }
