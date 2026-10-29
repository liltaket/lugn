## 2024-10-29 - Prevent Timing Attacks in timingSafeEqual

**Vulnerability:** Length-based short-circuiting before using `crypto.timingSafeEqual()`, which allows an attacker to deduce the expected token length and potentially execute a timing attack.
**Learning:** Checking string/buffer lengths before comparison defeats the purpose of constant-time comparison functions, as the early exit leaks information about the required length.
**Prevention:** Instead of short-circuiting on length, always hash both inputs (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time regardless of the input length.
