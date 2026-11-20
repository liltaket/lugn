"""Client for Lugn's loopback capability API.

Voice is a client of Lugn capabilities, never a second control plane: every
action goes through `POST /capabilities/<name>` and Lugn decides.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Protocol

from . import httpjson

REASON_MAX = 256
REQUEST_ID_MAX = 128


class LugnError(Exception):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class LugnApi(Protocol):
    async def invoke(self, name: str, input: dict[str, Any], *, request_id: str | None = None,
                     reason: str | None = None) -> dict[str, Any]: ...

    async def get_state(self) -> dict[str, Any]: ...


def voice_reason(transcript: str) -> str:
    reason = f"röst: {transcript.strip()}"
    return reason if len(reason) <= REASON_MAX else reason[: REASON_MAX - 1] + "…"


class LugnClient:
    def __init__(self, base_url: str, token: str | None, *, timeout_s: float = 2.0) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout_s

    def _headers(self, json_body: bool) -> dict[str, str]:
        headers = {"accept": "application/json"}
        if json_body:
            headers["content-type"] = "application/json"
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        return headers

    async def _call(self, method: str, path: str, body: dict[str, Any] | None) -> Any:
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            resp = await asyncio.wait_for(
                asyncio.to_thread(
                    httpjson.request, method, self._base + path, body=payload,
                    headers=self._headers(body is not None),
                    connect_timeout=self._timeout, read_timeout=self._timeout,
                ),
                timeout=self._timeout + 0.5,
            )
        except asyncio.TimeoutError as error:
            raise LugnError(f"{path}: timeout") from error
        except httpjson.HttpError as error:
            raise LugnError(f"{path}: {error}") from error
        try:
            data = resp.json()
        except httpjson.HttpError:
            data = None
        if resp.status != 200:
            code = data.get("error") if isinstance(data, dict) else None
            raise LugnError(f"{path}: HTTP {resp.status} {code or ''}".strip(), status=resp.status,
                            code=code if isinstance(code, str) else None)
        if not isinstance(data, dict):
            raise LugnError(f"{path}: response is not an object", status=resp.status)
        return data

    async def invoke(self, name: str, input: dict[str, Any], *, request_id: str | None = None,
                     reason: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"input": input}
        if request_id:
            body["requestId"] = request_id[:REQUEST_ID_MAX]
        if reason:
            body["reason"] = reason[:REASON_MAX]
        result: dict[str, Any] = await self._call("POST", f"/capabilities/{name}", body)
        return result

    async def get_state(self) -> dict[str, Any]:
        result: dict[str, Any] = await self._call("GET", "/state", None)
        return result

    async def list_capabilities(self) -> list[str]:
        data = await self._call("GET", "/capabilities", None)
        caps = data.get("capabilities")
        return [c for c in caps if isinstance(c, str)] if isinstance(caps, list) else []
