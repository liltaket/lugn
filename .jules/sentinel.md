## 2024-11-11 - Timing Attacks via Length Checks in `timingSafeEqual`

**Vulnerability:** Found uses of `crypto.timingSafeEqual()` that prefixed the comparison with a length check (e.g., `left.length === right.length && timingSafeEqual(left, right)`).
**Learning:** Checking lengths prior to `timingSafeEqual` or relying on it to throw on length mismatch creates early returns based on input length, opening a timing side-channel that can be exploited to guess secret lengths.
**Prevention:** To prevent timing attack vulnerabilities when using Node.js `crypto.timingSafeEqual()`, avoid short-circuiting length checks on raw inputs. Instead, hash both inputs (e.g., using `createHash('sha256')`) prior to comparison to guarantee equal buffer lengths and constant execution time.
