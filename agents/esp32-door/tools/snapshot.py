"""Fetch one JPEG from the door node's camera over the encrypted API.

Usage: snapshot.py out.jpg [--host lugn-door.local]
"""
import argparse, asyncio, pathlib
import yaml
from aioesphomeapi import APIClient, CameraState

HERE = pathlib.Path(__file__).resolve().parent.parent

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--host", default="lugn-door.local")
    ap.add_argument("--secrets", default=str(HERE / "secrets.yaml"))
    args = ap.parse_args()
    key = yaml.safe_load(open(args.secrets))["api_encryption_key"]
    cli = APIClient(args.host, 6053, None, noise_psk=key)
    await cli.connect(login=True)
    got: asyncio.Future = asyncio.get_running_loop().create_future()

    def on_state(s):
        if isinstance(s, CameraState) and not got.done():
            got.set_result(s.data)

    cli.subscribe_states(on_state)
    cli.request_single_image()
    data = await asyncio.wait_for(got, 10)
    await cli.disconnect()
    pathlib.Path(args.out).write_bytes(data)
    print(f"wrote {len(data)} bytes to {args.out}")

asyncio.run(main())
