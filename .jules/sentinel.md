## 2024-05-24 - Timing attacks with Node.js crypto.timingSafeEqual
**Vulnerability:** Timing attacks due to early returns on mismatched lengths when using `timingSafeEqual`.
**Learning:** `crypto.timingSafeEqual` in Node.js throws if inputs are not the same length, prompting developers to often add a length check before it. However, if length is checked and short-circuited (`left.length === right.length`), the comparison leaks information about the length of the expected secret.
**Prevention:** To prevent length leakage, always hash both inputs (e.g. `createHash('sha256')`) prior to comparison. Hashes of the same algorithm always have equal lengths, allowing `timingSafeEqual` to be used safely without an explicit, vulnerable length check.
