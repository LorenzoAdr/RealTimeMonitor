"""Tests unitarios para web_monitor/uds_client.py — framing UDS y protocolo."""

from __future__ import annotations

import json
import socket
import struct
import threading
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

import uds_client
from uds_client import UdsBridge


def _frame_message(data: dict) -> bytes:
    """Construye un frame length-prefixed (big-endian 4B + JSON)."""
    raw = json.dumps(data, separators=(",", ":")).encode()
    return struct.pack("!I", len(raw)) + raw


class FakeSocket:
    """Socket falso para tests que simula send/recv con buffers."""

    def __init__(self, recv_data: bytes = b""):
        self._recv_buf = bytearray(recv_data)
        self._recv_pos = 0
        self._sent = bytearray()
        self.closed = False
        self._timeout = 5.0

    def connect(self, addr):
        pass

    def settimeout(self, t):
        self._timeout = t

    def sendall(self, data: bytes):
        self._sent.extend(data)

    def recv(self, n: int) -> bytes:
        if self._recv_pos >= len(self._recv_buf):
            return b""
        end = min(self._recv_pos + n, len(self._recv_buf))
        chunk = bytes(self._recv_buf[self._recv_pos:end])
        self._recv_pos = end
        return chunk

    def close(self):
        self.closed = True

    def get_sent_data(self) -> bytes:
        return bytes(self._sent)

    def queue_response(self, data: dict):
        frame = _frame_message(data)
        self._recv_buf.extend(frame)


# ── _send_msg framing ──


class TestSendMsg:
    @patch("socket.socket")
    def test_framing_format(self, mock_socket_cls):
        fake = FakeSocket(_frame_message({"ok": True}))
        mock_socket_cls.return_value = fake

        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0

        msg = {"cmd": "list_names"}
        bridge._send_msg(msg)

        sent = fake.get_sent_data()
        assert len(sent) >= 4
        length = struct.unpack("!I", sent[:4])[0]
        body = json.loads(sent[4:4 + length])
        assert body == {"cmd": "list_names"}


# ── _recv_msg ──


class TestRecvMsg:
    def _make_bridge(self, fake: FakeSocket) -> UdsBridge:
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        return bridge

    def test_valid_message(self):
        response = {"data": ["a", "b"]}
        fake = FakeSocket(_frame_message(response))
        bridge = self._make_bridge(fake)
        result = bridge._recv_msg()
        assert result == response

    def test_oversized_message_raises_valueerror(self):
        size = 11 * 1024 * 1024  # > 10 MiB
        fake_data = struct.pack("!I", size) + b"\x00" * 100
        fake = FakeSocket(fake_data)
        bridge = self._make_bridge(fake)
        with pytest.raises(ValueError, match="demasiado grande"):
            bridge._recv_msg()

    def test_connection_closed_raises_error(self):
        fake = FakeSocket(b"")  # empty recv
        bridge = self._make_bridge(fake)
        with pytest.raises(ConnectionError, match="cerrada"):
            bridge._recv_msg()

    def test_partial_header_connection_closed(self):
        fake = FakeSocket(b"\x00\x00")  # only 2 bytes, then EOF
        bridge = self._make_bridge(fake)
        with pytest.raises(ConnectionError):
            bridge._recv_msg()


# ── _recv_exact ──


class TestRecvExact:
    def test_exact_bytes(self):
        data = b"hello world"
        fake = FakeSocket(data)
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        result = bridge._recv_exact(11)
        assert result == data

    def test_empty_recv_raises(self):
        fake = FakeSocket(b"")
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        with pytest.raises(ConnectionError):
            bridge._recv_exact(10)


# ── _request reconnect ──


class TestRequest:
    def test_reconnect_on_connection_error(self):
        response = {"ok": True}
        call_count = [0]

        class ReconnectFakeSocket(FakeSocket):
            def sendall(self, data):
                call_count[0] += 1
                if call_count[0] == 1:
                    raise ConnectionError("broken pipe")
                super().sendall(data)

        fake = ReconnectFakeSocket()
        fake.queue_response(response)

        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock(side_effect=lambda: setattr(bridge, '_sock', fake))
        bridge.disconnect = MagicMock()

        result = bridge._request({"cmd": "test"})
        assert result == response
        bridge.disconnect.assert_called_once()

    def test_reconnect_on_os_error(self):
        response = {"ok": True}
        call_count = [0]

        class OsErrorSocket(FakeSocket):
            def sendall(self, data):
                call_count[0] += 1
                if call_count[0] == 1:
                    raise OSError("network error")
                super().sendall(data)

        fake = OsErrorSocket()
        fake.queue_response(response)

        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock(side_effect=lambda: setattr(bridge, '_sock', fake))
        bridge.disconnect = MagicMock()

        result = bridge._request({"cmd": "test"})
        assert result == response


# ── set_var coercion ──


class TestSetVar:
    def _make_bridge_with_response(self, response: dict):
        fake = FakeSocket()
        fake.queue_response(response)
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock()
        return bridge, fake

    def test_double_coercion(self):
        bridge, fake = self._make_bridge_with_response({"ok": True})
        result = bridge.set_var("x", "3.14", var_type="double")
        assert result is True
        sent = fake.get_sent_data()
        length = struct.unpack("!I", sent[:4])[0]
        body = json.loads(sent[4:4 + length])
        assert body["value"] == 3.14
        assert isinstance(body["value"], float)

    def test_string_type_no_float_coercion(self):
        bridge, fake = self._make_bridge_with_response({"ok": True})
        result = bridge.set_var("label", 42, var_type="string")
        assert result is True
        sent = fake.get_sent_data()
        length = struct.unpack("!I", sent[:4])[0]
        body = json.loads(sent[4:4 + length])
        assert body["value"] == "42"
        assert isinstance(body["value"], str)

    def test_set_var_returns_false_on_failure(self):
        bridge, _ = self._make_bridge_with_response({"ok": False})
        result = bridge.set_var("x", 1.0)
        assert result is False


# ── Public API methods ──


class TestPublicMethods:
    def _make_bridge_with_response(self, response: dict):
        fake = FakeSocket()
        fake.queue_response(response)
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = fake
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock()
        return bridge

    def test_list_names(self):
        bridge = self._make_bridge_with_response({"data": ["a", "b", "c"]})
        result = bridge.list_names()
        assert result == ["a", "b", "c"]

    def test_list_vars(self):
        data = [{"name": "x", "type": "double", "value": 1.0}]
        bridge = self._make_bridge_with_response({"data": data})
        result = bridge.list_vars()
        assert result == data

    def test_get_var_found(self):
        bridge = self._make_bridge_with_response({"data": {"name": "x", "value": 1.0}})
        result = bridge.get_var("x")
        assert result["name"] == "x"

    def test_get_var_not_found(self):
        bridge = self._make_bridge_with_response({})
        result = bridge.get_var("nonexistent")
        assert result is None

    def test_get_server_info_exception_returns_none(self):
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = None
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock(side_effect=Exception("fail"))
        result = bridge.get_server_info()
        assert result is None

    def test_set_shm_subscription_ok(self):
        bridge = self._make_bridge_with_response({"ok": True})
        result = bridge.set_shm_subscription(["a", "b"])
        assert result is True

    def test_set_shm_subscription_exception(self):
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = FakeSocket(b"")
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock(side_effect=ConnectionError("fail"))
        result = bridge.set_shm_subscription(["a"])
        assert result is False

    def test_set_perf_collect(self):
        bridge = self._make_bridge_with_response({"ok": True})
        assert bridge.set_perf_collect(True) is True

    def test_set_perf_collect_exception(self):
        bridge = UdsBridge.__new__(UdsBridge)
        bridge._sock = FakeSocket(b"")
        bridge._lock = threading.Lock()
        bridge._uds_path = "/tmp/test.sock"
        bridge._timeout = 5.0
        bridge._connect = MagicMock(side_effect=ConnectionError("fail"))
        assert bridge.set_perf_collect(True) is False

    def test_set_shm_publish_slice(self):
        bridge = self._make_bridge_with_response({"ok": True})
        assert bridge.set_shm_publish_slice(4, force_full=False) is True

    def test_set_array_element(self):
        bridge = self._make_bridge_with_response({"ok": True})
        assert bridge.set_array_element("arr", 3, 2.5) is True
