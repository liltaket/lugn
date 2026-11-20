"""Minimal blocking HTTP for JSON APIs, run in a worker thread.

The standard library keeps the Pi install free of an HTTP stack; every call has
a connect and a read timeout, and callers add an asyncio deadline on top.
"""

from __future__ import annotations

import http.client
import json
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit


class HttpError(Exception):
    def __init__(self, message: str, *, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8")) if self.body else None
        except (UnicodeError, ValueError) as error:
            raise HttpError("invalid JSON in response", status=self.status) from error


def request(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    connect_timeout: float,
    read_timeout: float,
    max_response_bytes: int = 4 * 1024 * 1024,
) -> Response:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HttpError(f"unsupported URL: {url}")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname, port, timeout=connect_timeout)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.connect()
        if conn.sock is not None:
            conn.sock.settimeout(read_timeout)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read(max_response_bytes + 1)
        if len(data) > max_response_bytes:
            raise HttpError("response too large", status=resp.status)
        return Response(resp.status, data)
    except (OSError, socket.timeout, http.client.HTTPException) as error:
        raise HttpError(f"{type(error).__name__}: {error}") from error
    finally:
        conn.close()
