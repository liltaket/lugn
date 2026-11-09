## 2024-11-09 - Fix timing attacks via length-check short-circuiting

**Vulnerability:** Found uses of `crypto.timingSafeEqual` in `src/runtime/display-server.ts` and `src/runtime/http-server.ts` that were preceded by length checks. If lengths were unequal, the function returned early, exposing the exact length of the secret token through timing attacks.
**Learning:** Checking lengths before `timingSafeEqual` introduces a timing attack vulnerability on the secret length.
**Prevention:** To prevent this, inputs should be hashed (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time regardless of input length.
