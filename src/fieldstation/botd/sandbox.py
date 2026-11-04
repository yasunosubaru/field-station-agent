"""E2 botd 受限工作区：每个 bot 只能碰 ``workspace/<bot_id>/``。

规则是**白名单**，不是黑名单：

* ``relpath`` 必须是相对路径；绝对路径、盘符（``C:``）、UNC（``\\\\host\\share``）
  一律拒绝 —— 只查 ``".."`` 挡不住 ``C:\\Windows``；
* 路径分量里的 ``..`` 直接拒绝，不做"先拼接再规范化"的补救；
* 目标或其任一已存在的父级是符号链接/junction 时拒绝。仅比较字符串前缀会被
  ``workspace/bot/link -> /etc`` 绕过，所以既查链路上的 ``is_symlink``，也用
  ``realpath`` 做最终包含判断；
* 换盘符、大小写、分隔符混用（``a/..\\..\\x``）都在解析阶段归一后再判断。

Windows 上 ``Path.resolve`` 对 junction 的处理随版本变化，因此包含判断同时用
``os.path.realpath`` 与 ``normcase``，不依赖 pathlib 的实现细节。
"""
from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterator, List

_BOT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_SEPARATORS = re.compile(r"[\\/]+")


class SandboxViolation(ValueError):
    """越界路径、非法 bot id，或链路上出现符号链接。"""


def _is_symlink(path: Path) -> bool:
    """可替换的探测点：测试在无权限建链接的机器上也能验证拒绝逻辑。"""
    try:
        if os.path.islink(str(path)):
            return True
        checker = getattr(os.path, "isjunction", None)
        if checker is not None and checker(str(path)):
            return True
    except OSError:
        return False
    return False


def _normalized(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def _within(base: Path, candidate: Path) -> bool:
    base_n = _normalized(base)
    cand_n = _normalized(candidate)
    return cand_n == base_n or cand_n.startswith(base_n + os.sep)


class WorkspaceSandbox:
    """``root/workspace/<bot_id>/`` 下的受限文件访问。"""

    def __init__(self, root: str | Path, *, workspace_dirname: str = "workspace") -> None:
        if not isinstance(workspace_dirname, str) or not workspace_dirname.strip():
            raise ValueError("workspace_dirname 不能为空")
        if "/" in workspace_dirname or "\\" in workspace_dirname:
            raise ValueError("workspace_dirname 只能是单层目录名")
        self.root = Path(root)
        self.workspace_dirname = workspace_dirname

    # -------------------------------------------------------------- 根目录 --
    @property
    def workspace_root(self) -> Path:
        return self.root / self.workspace_dirname

    def _check_bot_id(self, bot_id: str) -> str:
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise SandboxViolation("bot_id 必须是非空字符串")
        value = bot_id.strip()
        if value in (".", "..") or not _BOT_ID_RE.match(value):
            raise SandboxViolation(
                f"非法 bot_id {bot_id!r}：只允许字母/数字开头，"
                "后续为字母、数字、下划线、点、连字符"
            )
        return value

    def bot_root(self, bot_id: str, *, create: bool = False) -> Path:
        value = self._check_bot_id(bot_id)
        workspace = self.workspace_root
        if _is_symlink(workspace):
            raise SandboxViolation(f"工作区根目录是符号链接：{workspace}")
        base = workspace / value
        if _is_symlink(base):
            raise SandboxViolation(f"bot 工作目录是符号链接：{base}")
        if create:
            base.mkdir(parents=True, exist_ok=True)
            if _is_symlink(base):
                raise SandboxViolation(f"bot 工作目录是符号链接：{base}")
        return base

    # -------------------------------------------------------------- 解析 --
    def _split(self, relpath: str | Path) -> List[str]:
        if isinstance(relpath, Path):
            relpath = str(relpath)
        if not isinstance(relpath, str):
            raise SandboxViolation("relpath 必须是字符串")
        if "\x00" in relpath:
            raise SandboxViolation("relpath 不能包含 NUL")
        raw = relpath.strip()
        if raw in ("", "."):
            return []

        win = PureWindowsPath(raw)
        posix = PurePosixPath(raw)
        if win.drive:
            raise SandboxViolation(f"禁止盘符或 UNC 路径：{relpath!r}")
        if win.is_absolute() or posix.is_absolute():
            raise SandboxViolation(f"禁止绝对路径：{relpath!r}")

        parts: List[str] = []
        for piece in _SEPARATORS.split(raw):
            if piece in ("", "."):
                continue
            if piece == "..":
                raise SandboxViolation(f"禁止路径上溯 '..'：{relpath!r}")
            if ":" in piece:
                raise SandboxViolation(f"禁止盘符/数据流语法：{relpath!r}")
            parts.append(piece)
        return parts

    def resolve(
        self, bot_id: str, relpath: str | Path = ".", *, create: bool = False
    ) -> Path:
        """把相对路径解析成真实磁盘路径；任何越界都抛 :class:`SandboxViolation`。"""
        base = self.bot_root(bot_id, create=create)
        parts = self._split(relpath)
        candidate = base.joinpath(*parts) if parts else base

        current = base
        if _is_symlink(current):
            raise SandboxViolation(f"bot 工作目录是符号链接：{current}")
        for part in parts:
            current = current / part
            if _is_symlink(current):
                raise SandboxViolation(f"路径包含符号链接：{current}")

        base_real = Path(os.path.realpath(str(base)))
        cand_real = Path(os.path.realpath(str(candidate)))
        if not _within(base_real, cand_real) or not _within(base, candidate):
            raise SandboxViolation(f"路径越出 bot 工作区：{relpath!r}")
        if create and parts:
            parent = candidate.parent
            parent.mkdir(parents=True, exist_ok=True)
            if not _within(Path(os.path.realpath(str(base))),
                           Path(os.path.realpath(str(parent)))):
                raise SandboxViolation(f"路径越出 bot 工作区：{relpath!r}")
        return candidate

    # ------------------------------------------------------------ 文件操作 --
    def write_text(
        self,
        bot_id: str,
        relpath: str | Path,
        content: str,
        *,
        encoding: str = "utf-8",
    ) -> Path:
        if not isinstance(content, str):
            raise TypeError("content 必须是字符串")
        path = self.resolve(bot_id, relpath, create=True)
        if path == self.bot_root(bot_id):
            raise SandboxViolation("不能把文件写到工作目录本身")
        path.write_text(content, encoding=encoding)
        return path

    def read_text(
        self, bot_id: str, relpath: str | Path, *, encoding: str = "utf-8"
    ) -> str:
        path = self.resolve(bot_id, relpath)
        return path.read_text(encoding=encoding)

    def exists(self, bot_id: str, relpath: str | Path) -> bool:
        return self.resolve(bot_id, relpath).exists()

    def listdir(self, bot_id: str, relpath: str | Path = ".") -> List[str]:
        path = self.resolve(bot_id, relpath)
        if not path.is_dir():
            raise NotADirectoryError(f"不是目录：{path}")
        return sorted(entry.name for entry in path.iterdir())

    def walk(self, bot_id: str, relpath: str | Path = ".") -> Iterator[Path]:
        path = self.resolve(bot_id, relpath)
        yield from sorted(path.rglob("*"))

    def relative(self, bot_id: str, path: Path) -> str:
        """把工作区内路径转回相对路径（越界即拒绝）。"""
        base = self.bot_root(bot_id)
        target = Path(path)
        if not _within(base, target):
            raise SandboxViolation(f"路径越出 bot 工作区：{path}")
        return target.relative_to(base).as_posix()
