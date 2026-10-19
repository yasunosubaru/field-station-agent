"""归档导出工具：沿用 store.product 的 synthetic 隔离口径。"""
from __future__ import annotations

from pathlib import Path

from ...store import product
from . import ToolResult


class ArchiveExportTool:
    name = "archive_export"
    description = (
        "把 JSON 产物导出到归档根目录。synthetic=true 时强制进入 "
        "synthetic/ 子目录并使用 SYNTHETIC_ 文件名前缀。")
    params = {
        "relative_path": {"type": "string", "required": True},
        "payload": {"type": "object", "required": True},
        "synthetic": {"type": "boolean", "required": True},
    }
    risk = "low"

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def invoke(self, args: dict) -> ToolResult:
        relative = args.get("relative_path")
        payload = args.get("payload")
        synthetic = args.get("synthetic")
        if not isinstance(relative, str) or not relative.strip():
            return ToolResult(ok=False, error="relative_path 必须是非空字符串")
        if not isinstance(payload, dict):
            return ToolResult(ok=False, error="payload 必须是 JSON object")
        if not isinstance(synthetic, bool):
            return ToolResult(ok=False, error="synthetic 必须是布尔值")

        raw = Path(relative)
        if raw.is_absolute() or any(part == ".." for part in raw.parts):
            return ToolResult(ok=False, error="归档路径不得为绝对路径或包含 ..")
        target = (self.root / raw).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            return ToolResult(ok=False, error="归档路径越出根目录")

        written = product.write_json(payload, target, synthetic=synthetic)
        rel = written.resolve().relative_to(self.root).as_posix()
        return ToolResult(ok=True, data={
            "path": rel,
            "synthetic": synthetic,
            "sha256": product.sha256_file(written),
        })


def archive_export_tool(root: str | Path) -> ArchiveExportTool:
    return ArchiveExportTool(root)
