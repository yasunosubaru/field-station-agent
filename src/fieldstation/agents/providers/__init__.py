"""provider 抽象层的公开接口。"""
from .base import ChatMessage, ChatResponse, Provider
from .base import get_provider as _base_get_provider
from .fake import FakeProvider
from .ollama import OllamaProvider, ProviderError
from .openai_compatible import OpenAICompatibleProvider


def get_provider(name: str, config: dict) -> Provider:
    """按名字与配置构造 provider。

    与 ``base.get_provider`` 同一份契约（未知名字抛 ``ValueError``），额外认
    ``openai_compatible``（契约 §7 的云/兼容通道）。分支写在这里而不是
    ``base.py``：并行开发期间 WP3 只拥有本文件，``base.py`` 归其他工作包，
    等主控合并后再决定是否把分支下沉进去 —— 两条路对外行为一致，因为
    ``base.get_provider`` 本来就只有包内这一处对外入口。
    """
    if name == "openai_compatible":
        return OpenAICompatibleProvider(config)
    try:
        return _base_get_provider(name, config)
    except ValueError as exc:
        # base 的错误消息只列它自己认识的两个名字，这里补上新增分支。
        raise ValueError(
            f"未知 provider: {name!r}（支持 'fake'、'ollama' 与 "
            "'openai_compatible'，配置见 config/providers.json）") from exc


__all__ = ["ChatMessage", "ChatResponse", "Provider", "get_provider",
           "FakeProvider", "OllamaProvider", "OpenAICompatibleProvider",
           "ProviderError"]
