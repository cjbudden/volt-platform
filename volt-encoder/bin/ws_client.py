#!/usr/bin/env python3
"""
A minimal RFC 6455 WebSocket client, stdlib only.

The encoder image stays dependency-free (the captions add-on image is the one
that carries models), and the Gladia live API is a websocket, so this is the
smallest client that speaks it correctly: the opening handshake with the
Sec-WebSocket-Accept check, masked client frames, fragmented messages, ping
answered with pong, and a clean close. TLS (wss://) through the ssl module
with certificate and hostname verification left on.

Not a general library: no extensions (no permessage-deflate), no proxy.
"""
import base64
import hashlib
import os
import socket
import ssl
import struct
from urllib.parse import urlsplit

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketClosed(Exception):
    def __init__(self, code=None, reason=""):
        super().__init__(f"websocket closed ({code}) {reason}".strip())
        self.code, self.reason = code, reason


def accept_for(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def encode_frame(opcode, payload, mask=True, fin=True):
    """One frame. Clients MUST mask (RFC 6455 5.3); a test server passes mask=False."""
    b0 = (0x80 if fin else 0) | opcode
    n = len(payload)
    head = bytes([b0])
    mbit = 0x80 if mask else 0
    if n < 126:
        head += bytes([mbit | n])
    elif n < 1 << 16:
        head += bytes([mbit | 126]) + struct.pack(">H", n)
    else:
        head += bytes([mbit | 127]) + struct.pack(">Q", n)
    if not mask:
        return head + payload
    key = os.urandom(4)
    return head + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise WebSocketClosed(None, "connection dropped")
        buf += chunk
    return buf


def read_frame(sock):
    """(fin, opcode, payload), unmasking if the peer masked."""
    b0, b1 = _recv_exact(sock, 2)
    fin, opcode = bool(b0 & 0x80), b0 & 0x0F
    masked, n = bool(b1 & 0x80), b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    key = _recv_exact(sock, 4) if masked else None
    data = _recv_exact(sock, n) if n else b""
    if key:
        data = bytes(b ^ key[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


class WebSocket:
    def __init__(self, url, headers=None, timeout=15.0):
        u = urlsplit(url)
        if u.scheme not in ("ws", "wss"):
            raise ValueError(f"not a websocket URL: {url}")
        port = u.port or (443 if u.scheme == "wss" else 80)
        raw = socket.create_connection((u.hostname, port), timeout=timeout)
        if u.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname)
        self.sock = raw
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        host = u.hostname + (f":{u.port}" if u.port else "")
        lines = [f"GET {path} HTTP/1.1", f"Host: {host}", "Upgrade: websocket", "Connection: Upgrade",
                 f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketClosed(None, "handshake: connection dropped")
            resp += chunk
            if len(resp) > 65536:
                raise WebSocketClosed(None, "handshake: response too large")
        head, _, self._rest = resp.partition(b"\r\n\r\n")
        status, *hdrs = head.decode("latin-1").split("\r\n")
        if " 101 " not in f"{status} ":
            raise WebSocketClosed(None, f"handshake refused: {status}")
        h = {k.strip().lower(): v.strip() for k, _, v in (x.partition(":") for x in hdrs)}
        if h.get("sec-websocket-accept") != accept_for(key):
            raise WebSocketClosed(None, "handshake: bad Sec-WebSocket-Accept")
        if self._rest:  # bytes that arrived with the handshake belong to the first frame
            self.sock = _Prefixed(self.sock, self._rest)
        self.closed = False

    def settimeout(self, t):
        self.sock.settimeout(t)

    def send_text(self, text):
        self.sock.sendall(encode_frame(OP_TEXT, text.encode()))

    def send_binary(self, data):
        self.sock.sendall(encode_frame(OP_BINARY, bytes(data)))

    def recv(self):
        """The next whole message as (opcode, bytes). Raises socket.timeout, WebSocketClosed."""
        parts, first_op = [], None
        while True:
            fin, op, data = read_frame(self.sock)
            if op == OP_PING:
                self.sock.sendall(encode_frame(OP_PONG, data))
                continue
            if op == OP_PONG:
                continue
            if op == OP_CLOSE:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else None
                try:
                    self.sock.sendall(encode_frame(OP_CLOSE, data[:2]))
                except OSError:
                    pass
                self.closed = True
                raise WebSocketClosed(code, data[2:].decode("utf-8", "replace"))
            if op != OP_CONT:
                first_op = op
            parts.append(data)
            if fin:
                return first_op, b"".join(parts)

    def close(self, code=1000):
        if self.closed:
            return
        self.closed = True
        try:
            self.sock.sendall(encode_frame(OP_CLOSE, struct.pack(">H", code)))
            self.sock.close()
        except OSError:
            pass


class _Prefixed:
    """A socket that first returns bytes already read past the handshake."""

    def __init__(self, sock, prefix):
        self._s, self._p = sock, prefix

    def recv(self, n):
        if self._p:
            out, self._p = self._p[:n], self._p[n:]
            return out
        return self._s.recv(n)

    def __getattr__(self, name):
        return getattr(self._s, name)
