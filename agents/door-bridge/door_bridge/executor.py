"""Turn a typed voice action into Lugn capability calls."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import LugnConfig
from .intents import (
    Action,
    ActivateScene,
    BrightnessStep,
    CeilingPower,
    MusicPlayback,
    VolumeSet,
    VolumeStep,
)
from .lugn_client import LugnApi, LugnError, voice_reason

SCENE_IDS = {
    "all_off": "scene.all_off",
    "soft": "scene.soft_light",
    "everyday": "scene.everyday_light",
    "focus": "scene.focus_light",
    "movie": "scene.movie_light",
}


@dataclass
class Execution:
    ok: bool
    calls: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


class Executor:
    def __init__(self, lugn: LugnApi, cfg: LugnConfig) -> None:
        self._lugn = lugn
        self._cfg = cfg

    def plan(self, action: Action) -> tuple[str, dict[str, Any]] | None:
        """The capability call for actions that need no current state."""
        c = self._cfg
        if isinstance(action, CeilingPower):
            return "lighting.set", {"target": c.ceiling_target, "values": {"power": action.on}}
        if isinstance(action, ActivateScene):
            scene = c.all_on_scene if action.scene == "all_on" else SCENE_IDS[action.scene]
            return "lighting.activateScene", {"sceneId": scene}
        if isinstance(action, BrightnessStep):
            return "lighting.adjust", {"target": c.ceiling_target,
                                       "brightnessDelta": action.direction * c.brightness_step}
        if isinstance(action, MusicPlayback):
            return ("music.play" if action.play else "music.pause"), {"target": c.music_target}
        return None

    async def execute(self, action: Action, *, transcript: str, request_id: str) -> Execution:
        result = Execution(ok=False)
        reason = voice_reason(transcript)
        try:
            call = self.plan(action)
            if call is None:
                call = await self._volume_call(action, result, request_id, reason)
                if call is None:
                    return result
            name, payload = call
            output = await self._lugn.invoke(name, payload, request_id=request_id, reason=reason)
            result.calls.append({"capability": name, "input": payload, "output": _brief(output)})
            result.ok = True
        except LugnError as error:
            result.error = error.code or str(error)
        return result

    async def _volume_call(self, action: Action, result: Execution, request_id: str,
                           reason: str) -> tuple[str, dict[str, Any]] | None:
        c = self._cfg
        cap = c.max_voice_volume
        if isinstance(action, VolumeSet):
            volume = action.percent / 100
            if volume > cap + 1e-9:
                result.error = "above_voice_volume_cap"
                return None
            return "music.setVolume", {"target": c.music_target, "volume": round(volume, 2)}
        if not isinstance(action, VolumeStep):
            result.error = "unsupported_action"
            return None
        state = await self._lugn.invoke("music.getState", {"target": c.music_target},
                                        request_id=f"{request_id}:read", reason=reason)
        result.calls.append({"capability": "music.getState", "input": {"target": c.music_target}})
        device = state.get("device") if isinstance(state, dict) else None
        observed = device.get("observed") if isinstance(device, dict) else None
        current = observed.get("volume") if isinstance(observed, dict) else None
        if not isinstance(current, (int, float)) or device.get("availability") != "available":  # type: ignore[union-attr]
            result.error = "volume_unknown"
            return None
        target = round(current + action.direction * c.volume_step, 2)
        if action.direction > 0:
            if current >= cap - 1e-9:
                result.error = "at_voice_volume_cap"
                return None
            target = min(target, cap)
        target = max(0.0, min(1.0, target))
        return "music.setVolume", {"target": c.music_target, "volume": target}


def _brief(output: dict[str, Any]) -> dict[str, Any]:
    keys = ("accepted", "status", "commandId", "brightness", "sceneRevision")
    return {k: output[k] for k in keys if k in output}
