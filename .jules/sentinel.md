## 2024-05-24 - Prevent timing attacks with crypto.timingSafeEqual

**Vulnerability:** Use of `timingSafeEqual` with a short-circuit length check.
**Learning:** `timingSafeEqual` will throw an error if the buffers are of different lengths. If you short circuit and return false for different lengths, you open up a timing attack where an attacker can determine the expected length based on the time it takes to respond.
**Prevention:** Instead of short circuiting, hash both the expected and provided secrets using SHA-256 (or another constant-size hashing algorithm) before comparing them. This ensures the comparison is always between buffers of the same length and takes the same amount of time.
