## 2024-05-15 - Prevent Timing Attacks in Buffer Equality Checks

**Vulnerability:** Node.js `timingSafeEqual()` was protected by an early return length check (`left.length === right.length`), rendering it vulnerable to timing attacks that could reveal the length of secret tokens.
**Learning:** Checking lengths first short-circuits the timing-safe comparison, meaning different token lengths take different amounts of time to evaluate.
**Prevention:** Hash both strings/buffers (e.g. using `createHash('sha256')`) first and compare the hashes with `timingSafeEqual()`, which ensures lengths are always equal and comparison time is always constant.
