"""Read the door node's entities and states over the encrypted native API.

Usage: probe.py [--host lugn-door.local] [--seconds 20]
The API key is read from the node's secrets.yaml (never printed).
"""
import argparse, asyncio, pathlib, time
import yaml
from aioesphomeapi import APIClient

HERE = pathlib.Path(__file__).resolve().parent.parent

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="lugn-door.local")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--secrets", default=str(HERE / "secrets.yaml"))
    args = ap.parse_args()
    key = yaml.safe_load(open(args.secrets))["api_encryption_key"]
    cli = APIClient(args.host, 6053, None, noise_psk=key)
    await cli.connect(login=True)
    info = await cli.device_info()
    print(f"device {info.name} esphome {info.esphome_version} compiled {info.compilation_time} project {info.project_version}")
    entities, _ = await cli.list_entities_services()
    names = {e.key: e.name for e in entities}
    t0 = time.monotonic()
    def on_state(s):
        v = getattr(s, "state", None)
        if hasattr(s, "data"):
            v = f"<image {len(s.data)} bytes>"
        print(f"{time.monotonic()-t0:6.1f}s {names.get(s.key, s.key)}: {v}")
    cli.subscribe_states(on_state)
    await asyncio.sleep(args.seconds)
    await cli.disconnect()

asyncio.run(main())
