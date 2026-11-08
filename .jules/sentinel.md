## 2024-03-20 - Prevent Timing Attacks with Node.js crypto.timingSafeEqual

**Vulnerability:** Found uses of `crypto.timingSafeEqual()` comparing string lengths and short-circuiting on mismatch, which creates a length-based timing vulnerability that could allow attackers to guess secrets.
**Learning:** `crypto.timingSafeEqual()` requires inputs of the same length. Short-circuiting a length check leaks the length of the expected secret.
**Prevention:** Before calling `timingSafeEqual()`, hash both inputs (e.g., using `createHash('sha256')`). This ensures the buffers passed to `timingSafeEqual()` are always the same length, regardless of the input string lengths, fully preventing both content-based and length-based timing attacks.
