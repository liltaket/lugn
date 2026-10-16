#!/usr/bin/env python3
"""Isolated MQTT integration checks; requires Python 3 and a real mosquitto.

Build the agent first, then run:
  python3 tests/mqtt_integration.py --broker /path/to/mosquitto [--measure-seconds 6]

No desktop bus, Wayland socket, real PipeWire service, or existing broker is used.
Resource measurements describe this synthetic headless fixture, not KDE usage.
"""

import argparse
import collections
import dataclasses
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid


AGENT_DIR = Path(__file__).resolve().parents[1]
DEVICE = "integration-desktop"
TOPIC = "lugn-integration/computers/" + DEVICE


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check_schema(value, schema, path="payload"):
    """Check exactly the keywords used by our local schemas, without dependencies.

    This is deliberately not a general JSON Schema implementation. New schema
    keywords fail explicitly so they cannot silently weaken this test.
    """
    supported = {"$schema", "$id", "title", "description", "type", "const",
                 "enum", "format", "pattern", "minimum", "maximum", "anyOf",
                 "required", "properties", "additionalProperties", "items",
                 "maxLength", "maxItems"}
    require(not set(schema) - supported, f"unsupported schema keywords at {path}")
    if "anyOf" in schema:
        for candidate in schema["anyOf"]:
            try:
                check_schema(value, candidate, path)
                break
            except AssertionError:
                pass
        else:
            raise AssertionError(f"{path}: no anyOf branch matched")
    if "type" in schema:
        kinds = {"object": dict, "array": list, "string": str,
                 "integer": int, "boolean": bool, "null": type(None)}
        require(type(value) is kinds[schema["type"]], f"{path}: wrong type")
    if "const" in schema:
        require(value == schema["const"] and type(value) is type(schema["const"]),
                f"{path}: wrong constant")
    if "enum" in schema:
        require(value in schema["enum"], f"{path}: invalid enum value")
    if "minimum" in schema:
        require(value >= schema["minimum"], f"{path}: below minimum")
    if "maximum" in schema:
        require(value <= schema["maximum"], f"{path}: above maximum")
    for keyword in ("maxLength", "maxItems"):
        if keyword in schema:
            require(len(value) <= schema[keyword], f"{path}: exceeds {keyword}")
    if "pattern" in schema:
        require(re.search(schema["pattern"], value), f"{path}: pattern mismatch")
    if "format" in schema:
        require(schema["format"] == "uuid", f"{path}: unsupported format")
        try:
            require(str(uuid.UUID(value)) == value.lower(), f"{path}: invalid UUID")
        except (ValueError, AttributeError) as error:
            raise AssertionError(f"{path}: invalid UUID") from error
    if isinstance(value, dict):
        require(set(schema.get("required", [])) <= set(value), f"{path}: missing fields")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            require(set(value) <= set(properties), f"{path}: unexpected fields")
        for key, child in value.items():
            if key in properties:
                check_schema(child, properties[key], f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        for index, child in enumerate(value):
            check_schema(child, schema["items"], f"{path}[{index}]")


class Contract:
    def __init__(self):
        protocol = AGENT_DIR / "protocol"
        self.schemas = {leaf: json.loads((protocol / f"{leaf}.schema.json").read_text())
                        for leaf in ("state", "availability", "events")}
        self.count = 0
        for fixture in protocol.glob("*.example.json"):
            leaf = fixture.name.split(".")[0].split("-")[0]
            check_schema(json.loads(fixture.read_text()), self.schemas[leaf], fixture.name)

    def check(self, message):
        require(message.topic.startswith(TOPIC + "/"), "unexpected topic")
        leaf = message.topic.rsplit("/", 1)[1]
        require(leaf in self.schemas, f"unexpected topic leaf {leaf}")
        check_schema(message.data, self.schemas[leaf])
        require(message.data["device_id"] == DEVICE, "wrong device identity")
        require(message.qos == 1, "agent telemetry must arrive at subscribed QoS 1")
        if leaf == "state":
            require(message.data["heartbeat_interval_ms"] == 5000, "wrong heartbeat interval")
        if leaf == "events":
            require(not message.retained, "change events must never be retained")
        self.count += 1


def mqtt_string(text):
    data = text.encode()
    return struct.pack("!H", len(data)) + data


@dataclasses.dataclass
class Message:
    topic: str
    data: dict
    retained: bool
    qos: int

    @property
    def leaf(self):
        return self.topic.rsplit("/", 1)[1]


class Subscriber:
    """Small MQTT 3.1.1 clean-session QoS-1 subscriber with PUBACK support."""

    def __init__(self, port, contract, credentials=None):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=3)
        self.buffer = bytearray()
        self.pending = collections.deque()
        self.messages = []
        self.contract = contract
        try:
            flags = 0xC2 if credentials else 0x02
            payload = mqtt_string("integration-" + uuid.uuid4().hex)
            if credentials:
                payload += mqtt_string(credentials[0]) + mqtt_string(credentials[1])
            self.send(0x10, mqtt_string("MQTT") + bytes([4, flags, 0, 60]) + payload)
            head, body = self.packet(time.monotonic() + 3)
            require(head == 0x20 and body == b"\x00\x00", "broker rejected CONNECT")
            self.send(0x82, b"\x00\x01" + mqtt_string(TOPIC + "/#") + b"\x01")
            deadline = time.monotonic() + 3
            while True:
                head, body = self.packet(deadline)
                if head == 0x90:
                    require(body == b"\x00\x01\x01", "broker rejected QoS 1 SUBSCRIBE")
                    break
                self.pending.append(self.publish(head, body))
        except BaseException:
            self.socket.close()
            raise

    def send(self, header, body=b""):
        length = len(body)
        encoded = bytearray([header])
        while True:
            digit = length % 128
            length //= 128
            encoded.append(digit | (0x80 if length else 0))
            if not length:
                break
        self.socket.sendall(encoded + body)

    def packet(self, deadline):
        while True:
            if len(self.buffer) >= 2:
                length, multiplier, offset = 0, 1, 1
                while offset < len(self.buffer) and offset <= 4:
                    digit = self.buffer[offset]
                    length += (digit & 127) * multiplier
                    offset += 1
                    if not digit & 128:
                        require(length <= 1024 * 1024, "oversized MQTT test packet")
                        if len(self.buffer) >= offset + length:
                            header = self.buffer[0]
                            body = bytes(self.buffer[offset:offset + length])
                            del self.buffer[:offset + length]
                            return header, body
                        break
                    multiplier *= 128
                require(offset <= 4 or not self.buffer[4] & 128, "invalid MQTT length")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("waiting for MQTT packet")
            self.socket.settimeout(remaining)
            chunk = self.socket.recv(65536)
            if not chunk:
                raise ConnectionError("broker closed subscriber connection")
            self.buffer.extend(chunk)

    def publish(self, header, body):
        require(header >> 4 == 3 and len(body) >= 2, "expected MQTT PUBLISH")
        size = struct.unpack("!H", body[:2])[0]
        topic = body[2:2 + size].decode()
        offset = 2 + size
        qos = (header >> 1) & 3
        require(qos in (0, 1), "unexpected MQTT QoS")
        if qos == 1:
            require(len(body) >= offset + 2, "missing PUBLISH packet id")
            self.send(0x40, body[offset:offset + 2])
            offset += 2
        message = Message(topic, json.loads(body[offset:]), bool(header & 1), qos)
        self.contract.check(message)
        self.messages.append(message)
        return message

    def next(self, timeout):
        if self.pending:
            return self.pending.popleft()
        return self.publish(*self.packet(time.monotonic() + timeout))

    def wait(self, predicate, description, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.next(max(0.001, deadline - time.monotonic()))
            except TimeoutError:
                break
            if predicate(message):
                return message
        raise AssertionError("timed out: " + description)

    def collect(self, seconds):
        result = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                result.append(self.next(max(0.001, deadline - time.monotonic())))
            except TimeoutError:
                break
        return result

    def close(self):
        try:
            self.send(0xE0)
        except OSError:
            pass
        self.socket.close()


class Fixture:
    def __init__(self, root, broker_path, agent_path):
        self.root = root
        self.broker_path = broker_path
        self.agent_path = agent_path
        self.processes, self.logs, self.clients = [], [], []
        self.contract = Contract()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        (root / "mosquitto.conf").write_text(
            f"listener {self.port} 127.0.0.1\nallow_anonymous true\n"
            "persistence false\nlog_type all\n")
        (root / "config.toml").write_text(
            f'device_id = "{DEVICE}"\nmqtt_host = "127.0.0.1"\n'
            f'mqtt_port = {self.port}\ntopic_prefix = "lugn-integration/computers"\n'
            'heartbeat_secs = 5\nidle_secs = 300\n')
        (root / "config.toml").chmod(0o600)
        (root / "bin").mkdir()
        (root / "runtime").mkdir(mode=0o700)
        os.mkfifo(root / "audio.fifo", 0o600)
        self.fifo = os.open(root / "audio.fifo", os.O_RDWR | os.O_NONBLOCK)
        self.audio_serial = 0
        self.credentials = None
        helper = root / "bin" / "pw-dump"
        helper.write_text("#!/usr/bin/env python3\n" +
                          "import os, sys\nfrom pathlib import Path\n"
                          "root = Path(os.environ['LUGN_TEST_ROOT'])\n"
                          "print('[]', flush=True)\n"
                          "with (root / 'audio.fifo').open() as source:\n"
                          "    for line in source:\n"
                          "        print(line, end='', flush=True)\n"
                          "        (root / 'audio.ack').write_text(line)\n")
        helper.chmod(0o755)
        self.agent_count = 0

    def launch(self, args, name, env=None):
        log = (self.root / name).open("ab", buffering=0)
        self.logs.append(log)
        process = subprocess.Popen(args, env=env, stdout=log, stderr=log,
                                   start_new_session=True)
        self.processes.append(process)
        return process

    def start_broker(self):
        self.broker = self.launch([self.broker_path, "-c", str(self.root / "mosquitto.conf"),
                                   "-v"], "broker.log")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            require(self.broker.poll() is None, "broker exited before accepting connections")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.025)
        raise AssertionError("broker did not open its isolated listener")

    def start_agent(self, extra_env=None):
        self.agent_count += 1
        env = os.environ.copy()
        for key in ("WAYLAND_SOCKET", "DISPLAY", "LUGN_MQTT_PASSWORD"):
            env.pop(key, None)
        env.update({"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent-lugn-test-session",
                    "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/nonexistent-lugn-test-system",
                    "WAYLAND_DISPLAY": "nonexistent-lugn-test-wayland",
                    "XDG_RUNTIME_DIR": str(self.root / "runtime"),
                    "LUGN_TEST_ROOT": str(self.root),
                    "PATH": str(self.root / "bin") + os.pathsep + env.get("PATH", "")})
        env.update(extra_env or {})
        self.agent = self.launch([self.agent_path, "--config", str(self.root / "config.toml")],
                                 f"agent-{self.agent_count}.log", env)
        return self.agent

    def subscribe(self):
        client = Subscriber(self.port, self.contract, self.credentials)
        self.clients.append(client)
        return client

    def audio(self, name=None):
        self.audio_serial += 1
        # Distinct serials also let us wait until the helper flushed every frame.
        frame = [{"id": 73, "type": "PipeWire:Interface:Node", "serial": self.audio_serial,
                  "info": {"state": "running" if name else "idle", "props": {
                      "media.class": "Stream/Output/Audio", "application.name": name,
                      "media.role": "Music"}}}]
        line = json.dumps(frame, separators=(",", ":")) + "\n"
        require(os.write(self.fifo, line.encode()) == len(line), "short FIFO write")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            ack = self.root / "audio.ack"
            if ack.exists() and ack.read_text() == line:
                return
            time.sleep(0.01)
        raise AssertionError("controlled pw-dump did not flush audio frame")

    def close(self):
        for client in self.clients:
            client.close()
        for process in reversed(self.processes):
            # The group includes pw-dump, including after its agent is SIGKILLed.
            try:
                os.killpg(process.pid, signal.SIGCONT)
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=2)
        os.close(self.fifo)
        for log in self.logs:
            log.close()

    def diagnostics(self):
        for path in sorted(self.root.glob("*.log")):
            print(f"--- {path.name} (isolated fixture) ---", file=sys.stderr)
            print("\n".join(path.read_text(errors="replace").splitlines()[-30:]), file=sys.stderr)


def state(message, reason=None):
    return message.leaf == "state" and (reason is None or message.data["reason"] == reason)


def audio_matches(message, name):
    if not state(message):
        return False
    audio = message.data["observations"]["audio"]
    return audio == {"playing": bool(name), "applications": [name] if name else [],
                     "roles": ["Music"] if name else []}


def retained(client, status, session):
    seen = {}
    deadline = time.monotonic() + 3
    while len(seen) < 2:
        message = client.next(max(0.001, deadline - time.monotonic()))
        require(message.retained, "late subscription did not receive retained telemetry")
        require(message.leaf in ("state", "availability"), "unexpected retained event")
        require(message.data["session_id"] == session, "retained session differs")
        seen[message.leaf] = message
    require(seen["availability"].data["status"] == status, "wrong retained availability")
    require(not any(m.retained and m.leaf == "events" for m in client.collect(0.15)),
            "late subscriber received retained events")
    return seen["state"]


def change(client, name):
    message = client.wait(lambda m: state(m, "change") and audio_matches(m, name),
                          f"audio change to {name}")
    event = client.wait(lambda m: m.leaf == "events" and
                        m.data["sequence"] == message.data["sequence"], "matching change event")
    require(not message.retained and not event.retained, "live messages have RETAIN set")
    for field in ("session_id", "sequence", "timestamp_ms"):
        require(event.data[field] == message.data[field], f"event/state {field} differs")
    return message


def proc_sample(root_pid):
    result, pending = {}, [root_pid]
    while pending:
        pid = pending.pop()
        if pid in result:
            continue
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()
            ticks = int(fields[11]) + int(fields[12])
            rss = int(fields[21]) * os.sysconf("SC_PAGE_SIZE")
            result[pid] = (ticks, rss)
            pending.extend(map(int, Path(f"/proc/{pid}/task/{pid}/children").read_text().split()))
        except FileNotFoundError:
            continue
    return result


def measure(client, process, seconds):
    first, latest = {}, {}
    peak_rss, peak_processes = 0, 0
    component_peaks = {"agent": 0, "controlled_pw_dump": 0}
    started = time.monotonic()
    while time.monotonic() - started < seconds:
        sample = proc_sample(process.pid)
        require(process.pid in sample, "agent exited during resource measurement")
        for pid, (ticks, _) in sample.items():
            first.setdefault(pid, ticks)
            latest[pid] = ticks
        peak_rss = max(peak_rss, sum(rss for _, rss in sample.values()))
        peak_processes = max(peak_processes, len(sample))
        for role in component_peaks:
            rss = sum(rss for pid, (_, rss) in sample.items()
                      if (pid == process.pid) == (role == "agent"))
            component_peaks[role] = max(component_peaks[role], rss)
        client.collect(min(0.1, max(0.001, seconds - (time.monotonic() - started))))
    elapsed = time.monotonic() - started
    cpu = sum(latest[pid] - ticks for pid, ticks in first.items()) / os.sysconf("SC_CLK_TCK")
    components = {}
    for role, rss in component_peaks.items():
        ticks = sum(latest[pid] - ticks for pid, ticks in first.items()
                    if (pid == process.pid) == (role == "agent"))
        components[role] = {"cpu_seconds": round(ticks / os.sysconf("SC_CLK_TCK"), 4),
                            "peak_rss_bytes": rss}
    return {"fixture": "synthetic headless agent + controlled pw-dump; not real KDE",
            "elapsed_secs": round(elapsed, 3), "cpu_seconds": round(cpu, 4),
            "cpu_percent_of_one_core": round(cpu / elapsed * 100, 3),
            "peak_aggregate_rss_bytes": peak_rss, "peak_processes": peak_processes,
            "components": components, "clock_ticks_per_second": os.sysconf("SC_CLK_TCK")}


def run(fixture, measure_seconds, password_tool):
    fixture.start_broker()
    live = fixture.subscribe()
    fixture.start_agent()
    online = live.wait(lambda m: m.leaf == "availability" and m.data["status"] == "online",
                       "initial online availability")
    session = online.data["session_id"]
    initial = live.wait(lambda m: state(m, "startup"), "startup state")
    baseline = initial if audio_matches(initial, None) else live.wait(
        lambda m: audio_matches(m, None), "initial empty PipeWire graph")
    observations = baseline.data["observations"]
    require(all(observations[key] is None for key in
                ("network_online", "locked", "idle", "active_application", "media")),
            "isolated unavailable desktop observations must remain unknown")
    require(baseline.data["inference"]["activity"] == "unknown", "unknown desktop was classified")
    require(not online.retained and not initial.retained, "fresh telemetry marked retained")
    late = fixture.subscribe()
    saved = retained(late, "online", session)
    require(saved.data["sequence"] == baseline.data["sequence"], "late subscriber state differs")
    late.close()
    print("PASS startup unknowns, live flags, schema fixtures, and late retained state/availability")

    start_index = len(live.messages)
    metrics = measure(live, fixture.agent, measure_seconds) if measure_seconds else None
    heartbeats = [m for m in live.messages[start_index:] if state(m, "heartbeat")]
    heartbeat = heartbeats[0] if heartbeats else live.wait(
        lambda m: state(m, "heartbeat"), "fresh heartbeat", timeout=7)
    require(heartbeat.data["sequence"] > baseline.data["sequence"], "heartbeat sequence did not advance")
    require(heartbeat.data["observations"] == baseline.data["observations"], "steady heartbeat changed state")
    require(not heartbeat.retained, "live heartbeat marked retained")
    live.collect(0.15)
    require(not any(m.leaf == "events" and m.data["sequence"] == heartbeat.data["sequence"]
                    for m in live.messages), "heartbeat emitted a change event")
    fixture.audio("SyntheticPlayer")
    changed = change(live, "SyntheticPlayer")
    require(changed.data["sequence"] > heartbeat.data["sequence"], "change sequence did not advance")
    fixture.audio("SyntheticPlayer")
    require(not live.collect(0.2), "identical native audio state produced telemetry")
    print("PASS heartbeat sequencing and native audio state/event identity and deduplication")

    fixture.agent.send_signal(signal.SIGTERM)
    live.wait(lambda m: m.leaf == "availability" and m.data["status"] == "offline" and
              m.data["session_id"] == session, "SIGTERM offline")
    require(fixture.agent.wait(timeout=5) == 0, "SIGTERM did not exit cleanly")
    late = fixture.subscribe()
    retained(late, "offline", session)
    late.close()
    live.collect(0.15)
    offline = [m for m in live.messages if m.leaf == "availability" and
               m.data["session_id"] == session and m.data["status"] == "offline"]
    require(len(offline) == 1, "graceful shutdown also published a Last Will")
    require(f"Received DISCONNECT from lugn-{DEVICE}" in
            (fixture.root / "broker.log").read_text(), "graceful MQTT DISCONNECT missing")
    print("PASS SIGTERM offline retention and clean MQTT disconnect")

    fixture.start_agent()
    second = live.wait(lambda m: m.leaf == "availability" and m.data["status"] == "online",
                       "restart online").data["session_id"]
    require(second != session, "restart reused session identity")
    live.wait(lambda m: state(m, "startup") and m.data["session_id"] == second, "restart startup")
    os.killpg(fixture.agent.pid, signal.SIGKILL)
    fixture.agent.wait(timeout=3)
    will = live.wait(lambda m: m.leaf == "availability" and m.data["status"] == "offline" and
                     m.data["session_id"] == second, "SIGKILL Last Will")
    require(not will.retained, "live Last Will marked retained")
    late = fixture.subscribe()
    retained(late, "offline", second)
    late.close()
    print("PASS new session identity and retained SIGKILL Last Will")

    fixture.start_agent()
    third = live.wait(lambda m: m.leaf == "availability" and m.data["status"] == "online",
                      "second restart online").data["session_id"]
    require(third not in (session, second), "second restart reused session identity")
    live.wait(lambda m: audio_matches(m, None) and m.data["session_id"] == third,
              "restarted empty PipeWire graph")
    fixture.broker.terminate()
    fixture.broker.wait(timeout=3)
    live.close()
    fixture.audio("OutageIntermediate")
    time.sleep(0.15)
    fixture.audio("OutageLatest")
    # Let the native collector update watch's latest value while MQTT is down.
    time.sleep(0.2)
    fixture.agent.send_signal(signal.SIGSTOP)
    fixture.start_broker()
    recovered = fixture.subscribe()
    require(not recovered.collect(0.1), "nonpersistent broker unexpectedly retained old data")
    fixture.agent.send_signal(signal.SIGCONT)
    latest = recovered.wait(lambda m: state(m, "reconnect"), "reconnect latest state")
    require(latest.data["session_id"] == third, "reconnect changed process session")
    require(audio_matches(latest, "OutageLatest"), "reconnect replayed stale outage state")
    recovered.collect(0.3)
    require(not any(m.leaf == "events" for m in recovered.messages), "reconnect replayed change events")
    require(all(audio_matches(m, "OutageLatest") for m in recovered.messages if state(m)),
            "reconnect published intermediate observations")
    late = fixture.subscribe()
    retained(late, "online", third)
    late.close()
    fixture.audio("PostRecovery")
    change(recovered, "PostRecovery")
    print("PASS broker outage coalescing, reconnect reason, no event replay, and resumed changes")
    if password_tool:
        auth_check(fixture, recovered, password_tool)
    if metrics:
        print("Synthetic resource sample: " + json.dumps(metrics, sort_keys=True))
    print(f"PASS {fixture.contract.count} actual MQTT payload schema checks")


def auth_check(fixture, subscriber, password_tool):
    """Use synthetic credentials to prove the environment overrides TOML."""
    fixture.agent.terminate()
    fixture.agent.wait(timeout=5)
    subscriber.close()
    fixture.broker.terminate()
    fixture.broker.wait(timeout=3)
    password_file = fixture.root / "broker-passwords"
    user, password = "synthetic-user", "synthetic-integration-password"
    subprocess.run([password_tool, "-b", "-c", str(password_file), user, password],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    password_file.chmod(0o600)
    (fixture.root / "mosquitto.conf").write_text(
        f"listener {fixture.port} 127.0.0.1\nallow_anonymous false\n"
        f"password_file {password_file}\npersistence false\nlog_type all\n")
    with (fixture.root / "config.toml").open("a") as config:
        config.write(f'\nmqtt_username = "{user}"\nmqtt_password = "intentionally-wrong"\n')
    fixture.credentials = (user, password)
    fixture.start_broker()
    try:
        invalid = Subscriber(fixture.port, fixture.contract, (user, "intentionally-wrong"))
    except AssertionError as error:
        require(str(error) == "broker rejected CONNECT", "unexpected credential rejection")
    else:
        invalid.close()
        raise AssertionError("broker accepted an invalid password")
    client = fixture.subscribe()
    fixture.start_agent({"LUGN_MQTT_PASSWORD": password})
    online = client.wait(lambda m: m.leaf == "availability" and m.data["status"] == "online",
                         "authenticated agent online with password override")
    client.wait(lambda m: state(m, "startup"), "authenticated startup")
    fixture.agent.terminate()
    client.wait(lambda m: m.leaf == "availability" and m.data["status"] == "offline" and
                m.data["session_id"] == online.data["session_id"], "authenticated offline")
    require(fixture.agent.wait(timeout=5) == 0, "authenticated agent shutdown failed")
    print("PASS broker rejects wrong password and agent environment overrides wrong TOML password")


def executable(value, description):
    path = shutil.which(value) if value else None
    if path is None:
        raise ValueError(f"{description} executable missing: {value!r}")
    return str(Path(path).resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker", default="mosquitto", help="isolated mosquitto executable")
    parser.add_argument("--agent", default=str(AGENT_DIR / "target/debug/lugn-linux-agent"))
    parser.add_argument("--measure-seconds", "--measure", nargs="?", const=6, default=0,
                        type=float, help="sample synthetic idle CPU/RSS (six seconds if omitted)")
    parser.add_argument("--password-tool", help="optional mosquitto_passwd executable for credential override check")
    args = parser.parse_args()
    try:
        broker = executable(args.broker, "broker")
        agent = executable(args.agent, "agent")
        password_tool = executable(args.password_tool, "password tool") if args.password_tool else None
    except ValueError as error:
        parser.error(str(error))
    if not 0 <= args.measure_seconds <= 30:
        parser.error("--measure-seconds must be between 0 and 30")
    with tempfile.TemporaryDirectory(prefix="lugn-mqtt-integration-") as directory:
        fixture = Fixture(Path(directory), broker, agent)
        try:
            run(fixture, args.measure_seconds, password_tool)
        except BaseException:
            fixture.diagnostics()
            raise
        finally:
            fixture.close()


if __name__ == "__main__":
    main()
