#!/usr/bin/env python3
"""Publishes this computer's resource statistics to Lugn over MQTT.

Read-only: CPU, GPU (AMD sysfs), memory, swap, network, the root disk and the
busiest programs, as one small JSON message every couple of seconds on
`<topic_prefix>/<device_id>/stats` (not retained). Lugn shows them on the Hubs'
computer page, and shows nothing at all when they stop arriving.

It reads the broker and device id from the Linux agent's own configuration
(`~/.config/lugn-linux-agent/config.toml`; the optional `environment` file can
override the password), so no secret is copied anywhere. Only the Python
standard library and psutil are used; the MQTT client below sends nothing but
CONNECT, PUBLISH QoS 0 and DISCONNECT.

    lugn-computer-stats.py [--config PATH] [--once]   # --once prints a sample
"""

import argparse
import json
import os
import socket
import sys
import time
import tomllib
from collections import defaultdict
from pathlib import Path

import psutil

INTERVAL_SECONDS = 2.0
PROCESS_EVERY = 2  # the process table is walked every Nth sample
TOP_PROGRAMS = 8


def load_config(path):
    with open(path, "rb") as handle:
        config = tomllib.load(handle)
    env_file = Path(path).parent / "environment"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("LUGN_MQTT_PASSWORD="):
                config["mqtt_password"] = line.split("=", 1)[1].strip()
    return config


# ── A minimal MQTT 3.1.1 publisher ──────────────────────────────────────────


def _length(n):
    out = bytearray()
    while True:
        digit, n = n % 128, n // 128
        out.append(digit | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _string(value):
    data = value.encode()
    return len(data).to_bytes(2, "big") + data


class Publisher:
    def __init__(self, host, port, username, password, client_id):
        self.host, self.port = host, port
        self.username, self.password, self.client_id = username, password, client_id
        self.sock = None

    def connect(self):
        sock = socket.create_connection((self.host, self.port), timeout=5)
        flags = 0x02  # clean session
        payload = _string(self.client_id)
        if self.username:
            flags |= 0x80
            payload += _string(self.username)
            if self.password:
                flags |= 0x40
                payload += _string(self.password)
        variable = _string("MQTT") + bytes([4, flags]) + (60).to_bytes(2, "big")
        body = variable + payload
        sock.sendall(bytes([0x10]) + _length(len(body)) + body)
        reply = sock.recv(4)
        if len(reply) < 4 or reply[0] != 0x20 or reply[3] != 0:
            sock.close()
            raise ConnectionError("broker refused the connection")
        sock.settimeout(5)
        self.sock = sock

    def publish(self, topic, payload):
        if self.sock is None:
            self.connect()
        body = _string(topic) + payload
        try:
            self.sock.sendall(bytes([0x30]) + _length(len(body)) + body)
        except OSError:
            self.close()
            raise

    def close(self):
        if self.sock is not None:
            try:
                self.sock.sendall(bytes([0xE0, 0x00]))
            except OSError:
                pass
            self.sock.close()
            self.sock = None


# ── Sampling ────────────────────────────────────────────────────────────────


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def number(path, scale=1.0):
    value = read(path)
    try:
        return float(value) / scale if value is not None else None
    except ValueError:
        return None


def amd_gpu():
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
        device = card / "device"
        if not (device / "gpu_busy_percent").exists():
            continue
        out = {
            "percent": number(device / "gpu_busy_percent"),
            "vram_used_mb": None,
            "vram_total_mb": None,
            "temp_c": None,
            "power_w": None,
            "fan_percent": None,
        }
        used = number(device / "mem_info_vram_used", 1024 * 1024)
        total = number(device / "mem_info_vram_total", 1024 * 1024)
        out["vram_used_mb"], out["vram_total_mb"] = used, total
        for hwmon in sorted((device / "hwmon").glob("hwmon*")):
            out["temp_c"] = number(hwmon / "temp1_input", 1000) or out["temp_c"]
            out["power_w"] = number(hwmon / "power1_average", 1_000_000) or out["power_w"]
            pwm, pwm_max = number(hwmon / "pwm1"), number(hwmon / "pwm1_max")
            if pwm is not None and pwm_max:
                out["fan_percent"] = round(100 * pwm / pwm_max)
        return out
    return None


def cpu_model():
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return " ".join(line.split(":", 1)[1].split())[:64]
    except OSError:
        pass
    return None


def cpu_temperature():
    try:
        sensors = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return None
    for name in ("coretemp", "k10temp", "zenpower"):
        for entry in sensors.get(name, []):
            if entry.label in ("Package id 0", "Tctl", "Tdie", ""):
                return entry.current
    return None


def default_interface():
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == "00000000":
                return fields[0]
    except OSError:
        pass
    return None


def root_block_device():
    """The whole disk under `/` (nvme0n1 for nvme0n1p5, sda for sda2)."""
    try:
        source = next(
            p.device for p in psutil.disk_partitions(all=False) if p.mountpoint == "/"
        )
        name = os.path.basename(os.path.realpath(source))
        real = Path(f"/sys/class/block/{name}").resolve()
        return real.parent.name if (real / "partition").exists() else name
    except (StopIteration, OSError):
        return None


class Sampler:
    def __init__(self, device_id):
        self.device_id = device_id
        self.model = cpu_model()
        self.cores = psutil.cpu_count() or 1
        self.iface = default_interface()
        self.disk = root_block_device()
        self.last_net = None
        self.last_disk = None
        self.last_time = None
        self.processes = []
        self.count = 0
        psutil.cpu_percent(percpu=True)  # the first reading is meaningless
        for process in psutil.process_iter():
            try:
                process.cpu_percent(None)
            except psutil.Error:
                pass

    def programs(self):
        grouped = defaultdict(lambda: [0.0, 0])
        for process in psutil.process_iter(["name", "memory_info"]):
            try:
                cpu = process.cpu_percent(None) / self.cores
                info = process.info
                name = (info.get("name") or "").strip()
                if not name:
                    continue
                grouped[name][0] += cpu
                grouped[name][1] += (info["memory_info"].rss if info.get("memory_info") else 0)
            except psutil.Error:
                continue
        ranked = sorted(grouped.items(), key=lambda item: (item[1][0], item[1][1]), reverse=True)
        return [
            {"name": name[:64], "cpu_percent": round(min(cpu, 100.0), 1), "ram_mb": round(ram / 1048576)}
            for name, (cpu, ram) in ranked[:TOP_PROGRAMS]
        ]

    def sample(self):
        now = time.monotonic()
        cores = psutil.cpu_percent(percpu=True)
        # Started before the network was up, there is no default route yet.
        if self.iface is None:
            self.iface = default_interface()
        frequency = psutil.cpu_freq()
        ram, swap = psutil.virtual_memory(), psutil.swap_memory()
        net = psutil.net_io_counters(pernic=True).get(self.iface) if self.iface else None
        disk_io = psutil.disk_io_counters(perdisk=True).get(self.disk) if self.disk else None
        elapsed = (now - self.last_time) if self.last_time else None
        down = up = read_mb = write_mb = 0.0
        if elapsed and elapsed > 0:
            if net and self.last_net:
                down = max(0.0, (net.bytes_recv - self.last_net.bytes_recv) * 8 / 1e6 / elapsed)
                up = max(0.0, (net.bytes_sent - self.last_net.bytes_sent) * 8 / 1e6 / elapsed)
            if disk_io and self.last_disk:
                read_mb = max(0.0, (disk_io.read_bytes - self.last_disk.read_bytes) / 1e6 / elapsed)
                write_mb = max(0.0, (disk_io.write_bytes - self.last_disk.write_bytes) / 1e6 / elapsed)
        self.last_net, self.last_disk, self.last_time = net, disk_io, now
        if self.count % PROCESS_EVERY == 0:
            self.processes = self.programs()
        self.count += 1
        usage = psutil.disk_usage("/")
        return {
            "schema_version": 1,
            "device_id": self.device_id,
            "timestamp_ms": int(time.time() * 1000),
            "model": self.model,
            "uptime_sec": round(time.time() - psutil.boot_time()),
            "cpu": {
                "percent": round(sum(cores) / len(cores), 1) if cores else 0,
                "temp_c": cpu_temperature(),
                "ghz": round(frequency.current / 1000, 2) if frequency else None,
                "cores": [round(value, 1) for value in cores],
            },
            "gpu": amd_gpu(),
            "memory": {
                "ram_used_mb": round((ram.total - ram.available) / 1048576),
                "ram_total_mb": round(ram.total / 1048576),
                "swap_used_mb": round(swap.used / 1048576),
                "swap_total_mb": round(swap.total / 1048576),
            },
            "network": {
                "iface": self.iface,
                "down_mbit": round(down, 2),
                "up_mbit": round(up, 2),
            },
            "disk": {
                "label": self.disk,
                "used_gb": round(usage.used / 1e9, 1),
                "total_gb": round(usage.total / 1e9, 1),
                "read_mbs": round(read_mb, 1),
                "write_mbs": round(write_mb, 1),
            },
            "processes": self.processes,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default=os.path.join(
            os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
            "lugn-linux-agent",
            "config.toml",
        ),
    )
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    config = load_config(args.config)
    device_id = config["device_id"]
    topic = f"{config.get('topic_prefix', 'lugn/computers').rstrip('/')}/{device_id}/stats"
    sampler = Sampler(device_id)
    if args.once:
        time.sleep(1.0)
        sampler.sample()
        time.sleep(1.0)
        print(json.dumps(sampler.sample(), indent=1))
        return
    publisher = Publisher(
        config["mqtt_host"],
        int(config.get("mqtt_port", 1883)),
        config.get("mqtt_username"),
        config.get("mqtt_password"),
        f"lugn-computer-stats-{device_id}",
    )
    while True:
        started = time.monotonic()
        try:
            publisher.publish(topic, json.dumps(sampler.sample(), separators=(",", ":")).encode())
        except (OSError, ConnectionError) as error:
            print(f"publish failed: {error}", file=sys.stderr)
            time.sleep(5)
        time.sleep(max(0.2, INTERVAL_SECONDS - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
