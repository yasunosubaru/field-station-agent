"""trace 决策留痕的公开接口。"""
from .reader import read_trace
from .writer import TraceWriter

__all__ = ["TraceWriter", "read_trace"]
