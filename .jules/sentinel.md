## 2024-05-24 - Timing Attack via Length Short-Circuiting

**Vulnerability:** Length short-circuiting when comparing secrets allows for a timing attack that leaks the length of the expected string. This was found in `secretsEqual`, `constantTimeEqual`, and `authorized`.
**Learning:** `timingSafeEqual` in `node:crypto` protects against byte-by-byte timing attacks, but wrapping it in `if (provided.length === expected.length && ...)` leaks the length of the secret because the function returns early if the lengths don't match. An attacker can determine the exact length of a secret (like an API token) by measuring the response time.
**Prevention:** To prevent this, always hash both inputs using a strong hashing algorithm (like SHA-256) prior to comparison with `timingSafeEqual`. This guarantees equal buffer lengths and constant execution time regardless of the input sizes, thereby removing the short-circuit condition and completely preventing timing attacks.
