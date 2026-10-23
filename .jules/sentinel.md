## 2024-05-15 - Timing Attack Vulnerability in Token Comparisons

**Vulnerability:** Comparing strings of different lengths with `timingSafeEqual` by checking their length first allows timing attacks because the length check is not constant time. Attackers can figure out the correct length of a token/secret by observing response times.
**Learning:** `timingSafeEqual` throws an error if buffer lengths are different, so developers often add a short-circuit length check. However, this re-introduces a timing leak since inputs of wrong length return immediately.
**Prevention:** Hash both strings using a cryptographic hash function (like `createHash('sha256')`) before comparing them with `timingSafeEqual`. Hashes are always the same length, allowing constant-time comparison without exposing the length or content of the expected string.
