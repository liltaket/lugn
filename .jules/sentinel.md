## 2024-05-15 - Timing Attack Vulnerability in Token Validation

**Vulnerability:** Timing attack via short-circuiting on length mismatch when comparing strings using `crypto.timingSafeEqual()`.
**Learning:** `timingSafeEqual` throws an error if the buffers have different lengths. To avoid this, developers often add a length check before calling it (`provided.length === expected.length && timingSafeEqual(provided, expected)`). However, this length check short-circuits, allowing an attacker to determine the exact length of the expected secret by measuring response times.
**Prevention:** Always hash both inputs (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time regardless of the original input length.
