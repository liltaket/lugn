## 2024-05-18 - Avoid short-circuiting length checks before timingSafeEqual

**Vulnerability:** Timing attack leaking expected secret length.
**Learning:** Checking `provided.length === expected.length` and short-circuiting *before* calling `crypto.timingSafeEqual()` allows an attacker to deduce the exact length of the expected secret by timing how long the server takes to respond to payloads of varying lengths.
**Prevention:** Hash both the provided input and the expected secret (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths (32 bytes for SHA-256) and constant execution time regardless of the input length, effectively masking the true length of the secret.
