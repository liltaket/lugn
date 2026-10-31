## 2023-10-31 - Constant Time Equality Timing Attack

**Vulnerability:** Early length checks and uneven buffer sizes prior to timingSafeEqual call in secrets comparison.
**Learning:** `timingSafeEqual` in Node.js requires both buffers to be identical in length. By performing a length check and early return before calling it, an attacker could potentially infer the length of the expected secret. Additionally, using raw string lengths for equality comparisons before cryptographic comparison does not guarantee constant time if inputs vary.
**Prevention:** Always hash both inputs (e.g., using `createHash('sha256')`) prior to comparison to guarantee equal buffer lengths and constant execution time.
