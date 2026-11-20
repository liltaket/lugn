"""The one persistent native-API connection to the door node.

The bridge must be the node's only voice client: ESPHome accepts a single
voice subscriber and silently refuses later ones (Home Assistant must not
adopt the node).
"""

from __future__ import annotations

import logging
import math
import re
import time
import unicodedata
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from .config import NodeConfig
from .voice import VoiceEvent, VoicePipeline

log = logging.getLogger(__name__)
AMBIENT_WINDOW_S = 6.0


def slug(name: str) -> str:
    """Stable ASCII key for an entity name ('Ljudnivå RMS' -> 'ljudniva_rms')."""
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", folded.lower()).strip("_") or "unnamed"


@dataclass(frozen=True)
class SensorMeta:
    key: str
    name: str
    unit: str
    device_class: str


class NodeLink:
    def __init__(self, cfg: NodeConfig, noise_psk: str, *, clock: Callable[[], float] = time.monotonic,
                 client_factory: Callable[..., Any] | None = None,
                 reconnect_factory: Callable[..., Any] | None = None) -> None:
        self.cfg = cfg
        self._psk = noise_psk
        self._clock = clock
        self._client_factory = client_factory
        self._reconnect_factory = reconnect_factory
        self.pipeline: VoicePipeline | None = None
        self.connected = False
        self.connects = 0
        self.catalog: dict[int, SensorMeta] = {}
        self.catalog_revision = 0
        self._values: dict[int, tuple[float | None, float]] = {}
        self._ambient: deque[tuple[float, float]] = deque(maxlen=16)
        self._client: Any = None
        self._reconnect: Any = None
        self._unsub_voice: Callable[[], None] | None = None

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        if self._client_factory is None or self._reconnect_factory is None:
            from aioesphomeapi import APIClient, ReconnectLogic

            self._client_factory = self._client_factory or APIClient
            self._reconnect_factory = self._reconnect_factory or ReconnectLogic
        self._client = self._client_factory(self.cfg.host, self.cfg.port, None, noise_psk=self._psk,
                                            client_info="lugn-door-bridge")
        self._reconnect = self._reconnect_factory(client=self._client, on_connect=self._on_connect,
                                                  on_disconnect=self._on_disconnect,
                                                  on_connect_error=self._on_connect_error, name=self.cfg.name)
        await self._reconnect.start()

    async def stop(self) -> None:
        if self.pipeline is not None:
            await self.pipeline.close()
        if self._reconnect is not None:
            await self._reconnect.stop()
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001 - best effort on shutdown
                pass

    async def _on_connect(self) -> None:
        client = self._client
        entities, _ = await client.list_entities_services()
        from aioesphomeapi import SensorInfo

        catalog = {e.key: SensorMeta(slug(e.name), e.name, e.unit_of_measurement, e.device_class)
                   for e in entities if isinstance(e, SensorInfo)}
        if catalog != self.catalog:
            self.catalog = catalog
            self.catalog_revision += 1
        self._values.clear()
        client.subscribe_states(self.on_state)
        if self.pipeline is not None:
            p = self.pipeline
            self._unsub_voice = client.subscribe_voice_assistant(
                handle_start=p.handle_start, handle_stop=p.handle_stop, handle_audio=p.handle_audio)
        self.connected = True
        self.connects += 1
        log.info("connected to %s (%d sensors)", self.cfg.host, len(catalog))

    async def _on_disconnect(self, expected: bool) -> None:
        self.connected = False
        self._unsub_voice = None
        self._values.clear()
        if self.pipeline is not None:
            self.pipeline.on_disconnect()
        log.info("disconnected from %s (expected=%s)", self.cfg.host, expected)

    async def _on_connect_error(self, error: Exception) -> None:
        log.info("connect to %s failed: %s", self.cfg.host, error)

    # -- state ----------------------------------------------------------------

    def on_state(self, state: Any) -> None:
        meta = self.catalog.get(getattr(state, "key", -1))
        if meta is None:
            return
        raw = getattr(state, "state", None)
        value: float | None = None
        if not getattr(state, "missing_state", False) and isinstance(raw, (int, float)) \
                and not isinstance(raw, bool) and math.isfinite(float(raw)):
            value = float(raw)
        now = self._clock()
        self._values[state.key] = (value, now)
        if value is not None and meta.name == self.cfg.ambient_sensor_name:
            self._ambient.append((now, value))

    def sensor_values(self, max_age_s: float) -> dict[str, float | None]:
        """Every known sensor by slug; stale or missing values are None."""
        now = self._clock()
        out: dict[str, float | None] = {}
        for key, meta in self.catalog.items():
            value, at = self._values.get(key, (None, -math.inf))
            out[meta.key] = value if now - at <= max_age_s else None
        return out

    def ambient_floor_dbfs(self) -> float | None:
        """Quietest recent ambient level; the newest value may contain the wake word."""
        now = self._clock()
        recent = [v for t, v in self._ambient if now - t <= AMBIENT_WINDOW_S]
        return min(recent) if recent else None

    # -- voice transport --------------------------------------------------------

    def send_event(self, event: VoiceEvent, data: dict[str, str] | None = None) -> bool:
        if not self.connected or self._client is None:
            return False
        try:
            from aioesphomeapi import VoiceAssistantEventType

            self._client.send_voice_assistant_event(VoiceAssistantEventType(int(event)), data)
            return True
        except Exception as error:  # noqa: BLE001 - connection may vanish at any time
            log.info("voice event %s not delivered: %s", event.name, error)
            return False
