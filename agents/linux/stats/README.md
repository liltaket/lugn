# Computer statistics publisher

`lugn-computer-stats.py` publishes this desktop's resource numbers to Lugn over
MQTT, for the Hubs' **Dator** page: CPU (total, per core, temperature, clock), GPU
(AMD: load, VRAM, temperature, power, fan), RAM and swap, the default network
interface, the root disk and the busiest programs. It is read-only, needs only
Python 3.11+ and `psutil`, and sends one small message about every two seconds
to `<topic_prefix>/<device_id>/stats` (not retained).

It reads the broker, credentials, `device_id` and `topic_prefix` from the Linux
agent's own configuration (`~/.config/lugn-linux-agent/config.toml`, and the
optional `environment` file for the password), so no secret is copied. The
broker user must be allowed to publish to the `stats` topic as well as the
agent's three observation topics.

```sh
install -m 0755 lugn-computer-stats.py ~/.local/bin/
install -m 0644 lugn-computer-stats.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lugn-computer-stats.service
lugn-computer-stats.py --once     # print one sample and exit
```

Lugn subscribes to the topic for every computer in `mqtt.computers`, keeps the
last sample with a short history, and shows nothing at all when no sample has
arrived for 15 seconds, so a stopped publisher leaves no stale numbers on the
Hub. Only AMD GPUs are read today (sysfs); on other hardware the GPU card is
simply absent.
