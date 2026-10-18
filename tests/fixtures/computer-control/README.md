# CONTROL v1 fixtures

These five examples and three schemas are copied byte-for-byte from
`agents/linux/protocol/` in companion PR #66. Observation v1 fixtures remain in
`../computer-mqtt/`. All identities and lease tokens here are deterministic test
values, not production credentials.

`tests/computer-playback-mqtt.test.ts` validates every example against the
consumer schemas and covers live-state authorization, reconnect sequence resets,
retained messages, malformed data, strict acknowledgement correlation, expiry,
and uncertain delivery. The agent owns the canonical CONTROL contract.
