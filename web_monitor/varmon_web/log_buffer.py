"""Buffer circular para el visor de log integrado (tee de stdout/stderr)."""

from __future__ import annotations

import collections
import sys
import threading
import time

from .settings import CONFIG

_LOG_BUFFER_LOCK = threading.Lock()
_LOG_SEQ = 0
_LOG_BUFFER: collections.deque = collections.deque(
    maxlen=max(100, min(50000, int(CONFIG.get("log_buffer_size", 5000)))),
)


class _LogTee:
    """Escribe en el stream original y duplica cada línea (con timestamp) al buffer de log."""

    def __init__(self, stream):
        self._stream = stream
        self._linebuf: list[str] = []

    @staticmethod
    def _level_for_line(line: str) -> str:
        u = line.upper()
        if "PÉRDIDA DE DATOS" in u or "PERDIDA DE DATOS" in u:
            return "error"
        if "WARNING:" in u or " WARNING " in u or u.startswith("WARNING"):
            return "warning"
        return "info"

    def write(self, data: str):
        self._stream.write(data)
        with _LOG_BUFFER_LOCK:
            for ch in data:
                if ch in "\n\r":
                    if self._linebuf:
                        line = "".join(self._linebuf).strip()
                        if line:
                            global _LOG_SEQ
                            _LOG_SEQ += 1
                            _LOG_BUFFER.append({
                                "seq": _LOG_SEQ,
                                "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                                "level": _LogTee._level_for_line(line),
                                "msg": line,
                            })
                        self._linebuf.clear()
                else:
                    self._linebuf.append(ch)
        return len(data)

    def flush(self):
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def install_stdio_tee() -> None:
    sys.stdout = _LogTee(sys.stdout)
    sys.stderr = _LogTee(sys.stderr)
