## 2023-10-25 - Fix timing attacks on length checks
**Vulnerability:** Comparing supplied secrets to expected secrets with a length check before `timingSafeEqual`. This exposes a timing attack to figure out the expected length.
**Learning:** `timingSafeEqual` throws if the strings aren't of the same length, leading to people using the `length` property to short circuit the function, causing an early-exit side channel.
**Prevention:** Use SHA-256 for comparisons. This ensures a consistent size.
