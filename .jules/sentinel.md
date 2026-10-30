## 2023-10-30 - Fix Timing Attack Vulnerability in node:crypto timingSafeEqual

**Vulnerability:** Node.js `crypto.timingSafeEqual()` was used directly with raw string inputs and a short-circuiting length check.
**Learning:** Checking length before calling `timingSafeEqual()` allows timing attacks to discover the exact length of a secret. Furthermore, if length isn't checked but the raw strings differ in length, `timingSafeEqual` will throw.
**Prevention:** To prevent timing attacks on secrets of unknown lengths, always hash both the provided and expected strings using a cryptographic hash function like SHA-256 before comparing them with `timingSafeEqual()`. Hashes always have a constant length, so length checks are unnecessary and the operation takes constant time.
