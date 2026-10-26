## 2024-10-26 - Timing Attack Vulnerability in Token Validation

**Vulnerability:** Node.js `crypto.timingSafeEqual()` was used to compare inputs of potentially different lengths, which exposes the system to timing attacks because a length check short-circuit reveals length mismatches immediately.
**Learning:** `timingSafeEqual()` itself only prevents timing side-channels during the actual byte-by-byte comparison _if the lengths are equal_. If lengths are unequal, it inherently throws or early returns (depending on manual checks), which compromises the constant-time guarantee with respect to the input length.
**Prevention:** Always hash both inputs (e.g., using `createHash('sha256').update(value).digest()`) before comparing them with `timingSafeEqual()`. This ensures the inputs passed to the comparison function are always of the exact same length (e.g., 32 bytes for SHA-256), thereby completely masking the length of the original target string.
