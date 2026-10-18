"""provider 抽象层的公开接口。"""
from .base import ChatMessage, ChatResponse, Provider, get_provider
from .fake import FakeProvider
from .ollama import OllamaProvider, ProviderError

__all__ = ["ChatMessage", "ChatResponse", "Provider", "get_provider",
           "FakeProvider", "OllamaProvider", "ProviderError"]
