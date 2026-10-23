## 2023-10-23 - Timing Attack Vulnerability in node:crypto timingSafeEqual

**Vulnerability:** Found that `timingSafeEqual` was used after doing length checks, which short-circuits the comparison if the lengths differ. This allows timing attacks to determine the expected length.
**Learning:** `timingSafeEqual` in Node.js throws if the buffers are of unequal length, but guarding it with a length check reintroduces a timing side-channel.
**Prevention:** Always hash the inputs (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time regardless of input length.
