## 2024-10-11 - Timing Attack Vulnerability in length mismatch checks
**Vulnerability:** Comparing secrets by first checking if their lengths match and returning `false` early, before performing a constant-time comparison (e.g. `crypto.timingSafeEqual`).
**Learning:** Node's `crypto.timingSafeEqual` strictly requires equal-length buffers and throws an error if they differ. This leads developers to check length equality first and return `false`, which inadvertently creates a length-based timing attack where an attacker can determine the correct length of a secret.
**Prevention:** Always ensure a constant-time operation runs even if the lengths don't match, e.g. `if (left.length !== right.length) { timingSafeEqual(left, left); return false; }`.
