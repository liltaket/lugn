# DISPLAY v1 fixtures

These four examples are copied byte-for-byte from `agents/linux/protocol/`
(`display-*.example.json`). All identities are deterministic test values.

`tests/computer-display-mqtt.test.ts` validates every example against the
consumer schemas and covers live-state authorization, retained state, strict
acknowledgement correlation, expiry and reconnects. The agent owns the
canonical DISPLAY contract (`agents/linux/protocol/DISPLAY.md`).
