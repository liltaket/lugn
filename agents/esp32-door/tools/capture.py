"""Record N seconds of microphone audio from the door node to a WAV file.

Uses the `start_listening` API action and the voice pipeline (API audio), so
it only works while no other client (the door bridge) owns the pipeline.
Usage: capture.py out.wav [--seconds 5] [--host lugn-door.local]
"""
import argparse, asyncio, pathlib, wave
import yaml
from aioesphomeapi import APIClient, VoiceAssistantEventType as Ev

HERE = pathlib.Path(__file__).resolve().parent.parent

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--host", default="lugn-door.local")
    ap.add_argument("--secrets", default=str(HERE / "secrets.yaml"))
    args = ap.parse_args()
    key = yaml.safe_load(open(args.secrets))["api_encryption_key"]
    cli = APIClient(args.host, 6053, None, noise_psk=key)
    await cli.connect(login=True)
    audio = bytearray()
    started = asyncio.Event()

    async def handle_start(conversation_id, flags, settings, wake_word):
        started.set()
        return 0  # API audio

    async def handle_stop(abort):
        pass

    async def handle_audio(data, _):
        audio.extend(data)

    unsub = cli.subscribe_voice_assistant(
        handle_start=handle_start, handle_stop=handle_stop, handle_audio=handle_audio
    )
    _, services = await cli.list_entities_services()
    svc = next(s for s in services if s.name == "start_listening")
    await cli.execute_service(svc, {})
    await asyncio.wait_for(started.wait(), 5)
    cli.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_START, None)
    await asyncio.sleep(args.seconds)
    cli.send_voice_assistant_event(Ev.VOICE_ASSISTANT_STT_VAD_END, None)
    cli.send_voice_assistant_event(Ev.VOICE_ASSISTANT_RUN_END, None)
    await asyncio.sleep(0.5)
    unsub()
    await cli.disconnect()
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(bytes(audio))
    print(f"wrote {len(audio)//2} samples ({len(audio)/32000:.2f} s) to {args.out}")

asyncio.run(main())
