#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""secret_store.py —— 把 API key 存成「只有当前用户能解开」的本地文件。

契约见 ``docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`` §6/§7：
``%LOCALAPPDATA%\\AllPoweredFSA\\secrets.bin``，DPAPI。本模块只负责
「一个路径 → 一段密文」这一件事，路径由调用方给，不替调用方决定放哪。

文件格式（前 4 字节就能看出是哪种）：

* ``b"FSA1"`` + DPAPI blob —— ``CryptProtectData``，**用户作用域**
  （不加 ``CRYPTPROTECT_LOCAL_MACHINE``），换个 Windows 账户解不开。
  调用时带 ``CRYPTPROTECT_UI_FORBIDDEN``：无人值守进程里绝不允许弹窗。
* ``b"FSA1PLAIN\\n"`` + UTF-8 明文 —— **非 Windows 的降级方案**，同时
  尽量把文件权限设成 0600。它**不是等价的**：没有 DPAPI 就没有「换账户
  读不出」这层保证，只剩「同机同账户 + 权限位生效」。``backend()`` 会
  明说当前走的是哪一条，设置页应当据此提示。

设计决定（非事实断言）：

* **值不进日志、不进异常消息、不 print**：唯一的出口是 ``load_secret`` 的
  返回值。异常只报「哪个文件名 / 哪一步失败」，不报内容。
* **空值不写盘**（``ValueError``）：从剪贴板粘贴常带换行，``strip`` 后为空
  说明用户其实没填 —— 写成空文件会让 ``has_secret`` 变成「有 key」，
  首次启动的回退判断就会走错分支。
* **先写临时文件再 ``os.replace``**：中途失败不会留下半截密文。半截密文
  解不开，设置页会永久显示「key 损坏」，而用户手上并没有可恢复的副本。
* **损坏 / 空文件 / 解不开 / 不存在一律返回 ``None``，不抛**：对调用方
  这四种是同一件事 —— 没有可用的 key。要区分请查文件本身，不要靠异常。
* **读取时如果文件没有前缀**（早期版本直接写裸 blob），Windows 下仍尝试
  按 DPAPI 解一次；解不开就是 ``None``，不做猜测。

用法：

    from tools.secret_store import save_secret, load_secret, has_secret
    save_secret(path, "sk-...")     # 写盘
    load_secret(path)               # -> "sk-..." 或 None
    has_secret(path)                # -> True / False
    delete_secret(path)             # -> 是否真的删掉了一个文件

本模块只用标准库。
"""
from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

#: DPAPI 密文文件的前缀（4 字节）。
PROTECTED_PREFIX = b"FSA1"

#: 非 Windows 明文降级文件的前缀；换行符让 ``head -1`` 也能一眼看出是明文。
PLAINTEXT_PREFIX = b"FSA1PLAIN\n"

#: 禁止 DPAPI 在无人值守进程里弹任何 UI。
CRYPTPROTECT_UI_FORBIDDEN = 0x1

#: 密文里附带的数据描述（只写进密文头，不落盘成明文之外的元数据）。
_DESCRIPTION = "AllPoweredFSA secret"

_dpapi_probe: bool | None = None
_crypt32 = None
_kernel32 = None


class _DataBlob(ctypes.Structure):
    """Win32 ``DATA_BLOB``。"""

    # DWORD = 32 位无符号；在 Windows 上 c_ulong 也是 4 字节，仍显式写 uint32。
    _fields_ = [
        ("cbData", ctypes.c_uint32),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _load_dlls():
    """按需绑定 crypt32 / kernel32 的函数签名；非 Windows 直接报错。"""
    global _crypt32, _kernel32
    if _crypt32 is not None and _kernel32 is not None:
        return _crypt32, _kernel32

    from ctypes import wintypes

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),      # pDataIn
        wintypes.LPCWSTR,               # szDataDescr
        ctypes.POINTER(_DataBlob),      # pOptionalEntropy
        ctypes.c_void_p,                # pvReserved
        ctypes.c_void_p,                # pPromptStruct
        wintypes.DWORD,                 # dwFlags
        ctypes.POINTER(_DataBlob),      # pDataOut
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL

    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),      # pDataIn
        ctypes.POINTER(wintypes.LPWSTR),  # ppszDataDescr
        ctypes.POINTER(_DataBlob),      # pOptionalEntropy
        ctypes.c_void_p,                # pvReserved
        ctypes.c_void_p,                # pPromptStruct
        wintypes.DWORD,                 # dwFlags
        ctypes.POINTER(_DataBlob),      # pDataOut
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL

    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    _crypt32, _kernel32 = crypt32, kernel32
    return crypt32, kernel32


def _dpapi_available() -> bool:
    """当前进程能不能用 DPAPI（Windows 且 crypt32 绑得上）。"""
    global _dpapi_probe
    if _dpapi_probe is None:
        if sys.platform != "win32" or os.name != "nt":
            _dpapi_probe = False
        else:
            try:
                _load_dlls()
                _dpapi_probe = True
            except (OSError, AttributeError):
                _dpapi_probe = False
    return _dpapi_probe


def backend() -> str:
    """当前实际使用的存储后端：``"dpapi"`` 或 ``"plaintext-fallback"``。"""
    return "dpapi" if _dpapi_available() else "plaintext-fallback"


def _as_blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    """``bytes`` → ``DATA_BLOB``；返回 (blob, buffer)，buffer 必须活到调用结束。"""
    buffer = ctypes.create_string_buffer(data, len(data))
    blob = _DataBlob(len(data),
                     ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    return blob, buffer


def _dpapi_protect(data: bytes) -> bytes:
    """``CryptProtectData``（用户作用域，禁 UI）。失败抛 ``OSError``。"""
    crypt32, kernel32 = _load_dlls()
    in_blob, _buffer = _as_blob(data)
    out_blob = _DataBlob()
    ok = crypt32.CryptProtectData(
        ctypes.byref(in_blob), _DESCRIPTION, None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob))
    if not ok:
        raise OSError(ctypes.get_last_error() or -1,
                      "CryptProtectData 失败（无法用当前用户的 DPAPI 加密）")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        if out_blob.pbData:
            kernel32.LocalFree(ctypes.cast(out_blob.pbData, ctypes.c_void_p))


def _dpapi_unprotect(blob: bytes) -> bytes:
    """``CryptUnprotectData``。解不开抛 ``OSError``（调用方转成 ``None``）。"""
    if not blob:
        raise OSError("密文为空")
    crypt32, kernel32 = _load_dlls()
    in_blob, _buffer = _as_blob(blob)
    out_blob = _DataBlob()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob))
    if not ok:
        raise OSError(ctypes.get_last_error() or -1,
                      "CryptUnprotectData 失败（密文损坏或不属于当前用户）")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        if out_blob.pbData:
            kernel32.LocalFree(ctypes.cast(out_blob.pbData, ctypes.c_void_p))


def _encode(text: str) -> bytes:
    """明文 → 落盘字节。Windows 走 DPAPI，其余走带标记的明文。"""
    payload = text.encode("utf-8")
    if _dpapi_available():
        return PROTECTED_PREFIX + _dpapi_protect(payload)
    return PLAINTEXT_PREFIX + payload


def _decode(raw: bytes) -> str:
    """落盘字节 → 明文；解不开抛 ``OSError`` / ``UnicodeDecodeError``。"""
    if raw.startswith(PLAINTEXT_PREFIX):
        return raw[len(PLAINTEXT_PREFIX):].decode("utf-8").strip()
    if raw.startswith(PROTECTED_PREFIX):
        if not _dpapi_available():
            # 密文是从 Windows 拷过来的，本机没有 DPAPI —— 解不开不是损坏。
            raise OSError("DPAPI 不可用，无法解开 DPAPI 密文")
        return _dpapi_unprotect(raw[len(PROTECTED_PREFIX):]).decode("utf-8").strip()
    # 没有前缀：可能是早期直接写裸 blob 的文件，Windows 下再试一次。
    if _dpapi_available():
        return _dpapi_unprotect(raw).decode("utf-8").strip()
    raise OSError("无法识别的 secret 文件格式")


def save_secret(path, value: str) -> None:
    """把 ``value`` 加密写到 ``path``，覆盖旧值。

    ``value`` 会先 ``strip``；strip 后为空抛 ``ValueError``（不写空文件）。
    ``path`` 的父目录不存在会自动建。
    """
    if not isinstance(value, str):
        raise TypeError("secret 必须是 str，收到 "
                        f"{type(value).__name__}")
    text = value.strip()
    if not text:
        raise ValueError("拒绝保存空 secret：空值等于没有 key，"
                         "会让 has_secret 给出错误结论")

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    blob = _encode(text)

    tmp = target.with_name(f"{target.name}.tmp{os.getpid()}")
    try:
        fd = os.open(str(tmp),
                     os.O_WRONLY | os.O_CREAT | os.O_TRUNC
                     | getattr(os, "O_BINARY", 0),
                     0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)
    except OSError as exc:
        raise OSError(f"写入 secret 失败（{target.name}）：{exc}") from exc
    finally:
        # replace 成功后 tmp 已不存在；失败时清掉半截文件。
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass

    if not _dpapi_available():
        # 明文降级：尽量收紧到仅本人可读写（Windows 上 chmod 基本是空操作，
        # DPAPI 分支也不会走到这里）。
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass


def load_secret(path) -> str | None:
    """读出 ``path`` 里的 key；不存在 / 空 / 损坏 / 解不开都返回 ``None``。"""
    try:
        raw = Path(path).read_bytes()
    except (OSError, ValueError):
        return None
    if not raw:
        return None
    try:
        text = _decode(raw)
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return text or None


def has_secret(path) -> bool:
    """``path`` 里是否有一个能解出来的非空 key。"""
    return load_secret(path) is not None


def delete_secret(path) -> bool:
    """删除 ``path``；返回是否真的删掉了一个文件（本来就没有则 ``False``）。"""
    target = Path(path)
    try:
        target.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise OSError(f"删除 secret 失败（{target.name}）：{exc}") from exc


if __name__ == "__main__":  # pragma: no cover - 只做人手排查，不打印任何值
    import argparse

    parser = argparse.ArgumentParser(
        description="检查 secret 文件状态（只报有无，绝不打印值）")
    parser.add_argument("path", help="secrets.bin 路径")
    ns = parser.parse_args()
    print(f"backend={backend()}")
    print(f"has_secret={has_secret(ns.path)}")
    print(f"bytes={Path(ns.path).stat().st_size if Path(ns.path).is_file() else 0}")
