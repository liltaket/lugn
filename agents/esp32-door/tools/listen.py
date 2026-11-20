"""Start one voice run on the door node without the wake word (push-to-talk).

The door bridge must own the voice pipeline; this only calls the node's
`start_listening` action. Usage: listen.py [--host lugn-door.local]
"""
import argparse, asyncio, pathlib
import yaml
from aioesphomeapi import APIClient

HERE = pathlib.Path(__file__).resolve().parent.parent

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="lugn-door.local")
    ap.add_argument("--secrets", default=str(HERE / "secrets.yaml"))
    args = ap.parse_args()
    key = yaml.safe_load(open(args.secrets))["api_encryption_key"]
    cli = APIClient(args.host, 6053, None, noise_psk=key)
    await cli.connect(login=True)
    _, services = await cli.list_entities_services()
    svc = next(s for s in services if s.name == "start_listening")
    await cli.execute_service(svc, {})
    await asyncio.sleep(0.5)
    await cli.disconnect()
    print("start_listening sent")

asyncio.run(main())
