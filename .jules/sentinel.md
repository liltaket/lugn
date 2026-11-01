## 2024-03-01 - Prevent Timing Attacks by Hashing Inputs

**Vulnerability:** Timing attack vulnerability due to comparing variable-length raw inputs using `timingSafeEqual`, where length mismatches short-circuit the comparison.
**Learning:** `timingSafeEqual` throws an error or short-circuits if buffer lengths don't match, allowing an attacker to determine the expected length and exploit timing differences.
**Prevention:** Always hash both inputs (e.g., using `createHash('sha256')`) prior to comparison. This guarantees equal buffer lengths and constant execution time.
