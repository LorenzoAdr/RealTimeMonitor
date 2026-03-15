"""Cliente VarMonitor por Unix domain socket (length-prefixed JSON)."""

import json
import socket
import struct
import threading


class UdsBridge:
    def __init__(self, uds_path: str, timeout: float = 5.0):
        self._uds_path = uds_path
        self._sock: socket.socket | None = None
        self._lock = threading.Lock()
        self._timeout = timeout
        self._connect()

    def _connect(self):
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.settimeout(self._timeout)
        self._sock.connect(self._uds_path)

    def disconnect(self):
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def __del__(self):
        self.disconnect()

    def _send_msg(self, data: dict):
        raw = json.dumps(data, separators=(",", ":")).encode()
        header = struct.pack("!I", len(raw))
        self._sock.sendall(header + raw)

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Conexion cerrada por el servidor")
            buf += chunk
        return buf

    def _recv_msg(self) -> dict:
        header = self._recv_exact(4)
        length = struct.unpack("!I", header)[0]
        if length > 10 * 1024 * 1024:
            raise ValueError(f"Mensaje demasiado grande: {length}")
        raw = self._recv_exact(length)
        return json.loads(raw)

    def _request(self, data: dict) -> dict:
        with self._lock:
            try:
                self._send_msg(data)
                return self._recv_msg()
            except (ConnectionError, OSError, socket.timeout):
                self._reconnect()
                self._send_msg(data)
                return self._recv_msg()

    def _reconnect(self):
        self.disconnect()
        self._connect()

    def list_names(self) -> list[str]:
        resp = self._request({"cmd": "list_names"})
        return resp.get("data", [])

    def get_server_info(self) -> dict | None:
        try:
            return self._request({"cmd": "server_info"})
        except Exception:
            return None

    def list_vars(self) -> list[dict]:
        resp = self._request({"cmd": "list_vars"})
        return resp.get("data", [])

    def get_var(self, name: str) -> dict | None:
        resp = self._request({"cmd": "get_var", "name": name})
        return resp.get("data")

    def set_var(self, name: str, value, var_type: str = "double") -> bool:
        resp = self._request({
            "cmd": "set_var",
            "name": name,
            "value": float(value) if var_type != "string" else str(value),
            "type": var_type,
        })
        return resp.get("ok", False)

    def set_array_element(self, name: str, index: int, value: float) -> bool:
        resp = self._request({
            "cmd": "set_array_element",
            "name": name,
            "index": index,
            "value": value,
        })
        return resp.get("ok", False)

    def get_history(self, name: str) -> dict | None:
        resp = self._request({"cmd": "get_history", "name": name})
        return resp.get("data")

    def get_histories(self, names: list[str]) -> list[dict]:
        try:
            resp = self._request({"cmd": "get_histories", "names": names})
            data = resp.get("data")
            if isinstance(data, list):
                return data
        except Exception:
            pass
        result = []
        for name in names:
            try:
                h = self.get_history(name)
                if h:
                    result.append(h)
            except Exception:
                pass
        return result

    def get_histories_since(self, names: list[str], since_seq: int) -> dict:
        resp = self._request({
            "cmd": "get_histories_since",
            "names": names,
            "since_seq": since_seq,
        })
        return {"seq": resp.get("seq", 0), "data": resp.get("data", [])}

    def set_shm_subscription(self, names: list[str]) -> bool:
        try:
            resp = self._request({"cmd": "set_shm_subscription", "names": names})
            return resp.get("ok", False)
        except Exception:
            return False
