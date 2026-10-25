## 2026-10-25 - Prevent timing attacks with hash comparison

**Vulnerability:** Node.js `crypto.timingSafeEqual()` was being used in a way that exposed a timing attack. Comparing the raw `Buffer.from(supplied)` to `Buffer.from(configured)` was guarded with a length check. If lengths didn't match, it immediately returned false. This allowed attackers to guess the correct length of a token, and then exploit the timing characteristics of how `Buffer.from()` works or other nuances.
**Learning:** `timingSafeEqual()` expects buffers of the exact same length. If you short-circuit when lengths differ, you leak the token length.
**Prevention:** Hash the left and right values using `createHash("sha256")` before passing them to `timingSafeEqual()`. Hashing makes both buffers 32 bytes and ensures execution time is constant, regardless of input length.
