
## 2024-11-21 - [CRITICAL] Fix timing attack vulnerability in timingSafeEqual
**Vulnerability:** Node.js `crypto.timingSafeEqual()` throws an error (or can short-circuit) if the two inputs have different lengths, which exposes a timing attack vulnerability that can leak the length of the expected secret.
**Learning:** Checking lengths prior to `timingSafeEqual()` (or catching length-mismatch errors) still leaks the length information of the expected value via timing differences.
**Prevention:** Always hash both the provided and expected values (e.g., using `createHash('sha256')`) prior to comparison. Hashing guarantees equal buffer lengths and constant execution time regardless of input length.
