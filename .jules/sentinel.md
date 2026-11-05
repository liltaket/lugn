## 2024-11-05 - Fix timing safe equal length check attack

**Vulnerability:** timingSafeEqual comparisons checked length equality using an early return or boolean short-circuit (`&&`) before executing `timingSafeEqual`. This allows timing attacks to discover the length of the secret.
**Learning:** Using `timingSafeEqual` with unequal lengths will throw an error, which often leads developers to add an early short-circuit length check. However, short-circuiting re-introduces timing side-channels, defeating the purpose of constant-time comparison.
**Prevention:** To safely use `timingSafeEqual` with potentially arbitrary length strings without early length checks, always hash both strings (e.g., using `createHash('sha256')`) prior to comparison. The resulting hashes will have a fixed length and can be safely compared using `timingSafeEqual`.
