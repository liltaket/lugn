## 2025-02-28 - Timing attack vulnerability in timingSafeEqual

**Vulnerability:** `timingSafeEqual` in `src/runtime/display-server.ts` and `src/runtime/http-server.ts` was used to compare inputs where length checks could short-circuit.
**Learning:** `timingSafeEqual` only guarantees constant time execution for buffers of the same length. Comparing buffers of different lengths or checking lengths before comparison can still leak information about the expected length or contents.
**Prevention:** Always hash both inputs (e.g., using SHA-256) before passing them to `timingSafeEqual`. This ensures that the buffers are always the same length and avoids short-circuiting based on raw input length.
