from __future__ import annotations

from pathlib import Path
from typing import Any

from aioesphomeapi import (
    APIConnectionError,
    BinarySensorInfo,
    SensorInfo,
    SensorState,
    VoiceAssistantEventType,
)

from conftest import FakeLugn, FakePlayer, FakeStt, chunks, silence, tone
from door_bridge.config import LugnConfig, NodeConfig, VoiceConfig
from door_bridge.executor import Executor
from door_bridge.node import NodeLink, slug
from door_bridge.voice import Journal, VoiceEvent, VoicePipeline


class Clock:
    t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.args, self.kwargs = args, kwargs
        self.on_state: Any = None
        self.voice: dict[str, Any] = {}
        self.sent: list[tuple[VoiceAssistantEventType, Any]] = []
        self.broken = False

    async def list_entities_services(self) -> tuple[list[Any], list[Any]]:
        return [SensorInfo(key=1, name="Ljudnivå RMS", unit_of_measurement="dBFS"),
                SensorInfo(key=2, name="Ljudnivå topp", unit_of_measurement="dBFS"),
                SensorInfo(key=3, name="Band 63 Hz", unit_of_measurement="dB"),
                BinarySensorInfo(key=9, name="Status")], []

    def subscribe_states(self, cb: Any) -> None:
        self.on_state = cb

    def subscribe_voice_assistant(self, **handlers: Any) -> Any:
        self.voice = handlers
        return lambda: None

    def send_voice_assistant_event(self, event: VoiceAssistantEventType, data: Any) -> None:
        if self.broken:
            raise APIConnectionError("gone")
        self.sent.append((event, data))

    async def disconnect(self) -> None:
        pass


class FakeReconnect:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass


async def connected_node(tmp_path: Path, stt: Any = None) -> tuple[NodeLink, FakeClient, Clock]:
    clock = Clock()
    node = NodeLink(NodeConfig(), "psk", clock=clock, client_factory=FakeClient, reconnect_factory=FakeReconnect)
    stt = stt or FakeStt()
    node.pipeline = VoicePipeline(cfg=VoiceConfig(journal_path=str(tmp_path / "v.jsonl")), transport=node, stt=stt,
                                  stt_confident=stt.confident, executor=Executor(FakeLugn(), LugnConfig()),
                                  earcons=FakePlayer(), journal=Journal(str(tmp_path / "v.jsonl"), 10**6))
    await node.start()
    await node._reconnect.kwargs["on_connect"]()
    return node, node._client, clock


def test_slug() -> None:
    assert slug("Ljudnivå RMS") == "ljudniva_rms"
    assert slug("Band 63 Hz") == "band_63_hz"
    assert slug("Spektral planhet (flatness)") == "spektral_planhet_flatness"
    assert slug("!!!") == "unnamed"


async def test_connect_subscribes_and_tracks_sensors(tmp_path: Path) -> None:
    node, client, clock = await connected_node(tmp_path)
    assert client.kwargs["noise_psk"] == "psk"
    assert set(client.voice) == {"handle_start", "handle_stop", "handle_audio"}
    assert node.connected and node.catalog_revision == 1
    client.on_state(SensorState(key=1, state=-52.0))
    client.on_state(SensorState(key=2, state=float("nan")))
    client.on_state(SensorState(key=99, state=1.0))  # unknown entity
    assert node.sensor_values(2.5) == {"ljudniva_rms": -52.0, "ljudniva_topp": None, "band_63_hz": None}
    clock.t += 3
    assert node.sensor_values(2.5)["ljudniva_rms"] is None


async def test_ambient_floor_ignores_wake_word_second(tmp_path: Path) -> None:
    node, client, clock = await connected_node(tmp_path)
    assert node.ambient_floor_dbfs() is None
    for level in (-55.0, -54.0, -56.0, -38.0):  # the last second holds "Hej Jarvis"
        clock.t += 1
        client.on_state(SensorState(key=1, state=level))
    assert node.ambient_floor_dbfs() == -56.0
    clock.t += 10
    assert node.ambient_floor_dbfs() is None


async def test_voice_run_over_node_and_disconnect(tmp_path: Path) -> None:
    node, client, _ = await connected_node(tmp_path)
    assert await client.voice["handle_start"]("c", 0, None, None) == 0
    run = node.pipeline.active
    for c in chunks(silence(200) + tone(800, -20) + silence(900)):
        await client.voice["handle_audio"](c, None)
    await run.wait()
    sent = [e for e, _ in client.sent]
    assert sent[0] == VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START
    assert sent.count(VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END) == 1

    # a second run, and the connection drops while listening
    await client.voice["handle_start"]("c", 0, None, None)
    run = node.pipeline.active
    await client.voice["handle_audio"](tone(300, -20), None)
    await node._reconnect.kwargs["on_disconnect"](False)
    await run.wait()
    assert not node.connected and run.finished
    assert node.send_event(VoiceEvent.RUN_END) is False
    assert [e for e, _ in client.sent].count(VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END) == 1


async def test_send_event_survives_broken_connection(tmp_path: Path) -> None:
    node, client, _ = await connected_node(tmp_path)
    client.broken = True
    assert node.send_event(VoiceEvent.RUN_END) is False
