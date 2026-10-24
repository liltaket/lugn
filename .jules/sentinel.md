## 2024-10-24 - Timing attack vulnerabilities in authentication checks

**Vulnerability:** Use of `crypto.timingSafeEqual` with unequal length buffers could leak the length of expected secrets due to short-circuiting length checks on raw inputs.
**Learning:** Checking length before `timingSafeEqual` avoids throwing an exception when comparing unequal length buffers, but still allows timing attacks to leak the length of the secret.
**Prevention:** To prevent timing attacks, always hash inputs (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time regardless of the raw input length.
