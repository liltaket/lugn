## 2024-10-17 - Prevent Timing Attack Short-circuiting in length checks

**Vulnerability:** Comparing arbitrary length secrets using `Buffer.from(x).length === Buffer.from(y).length` and `timingSafeEqual(x, y)` is vulnerable to length-based timing attacks since the length comparison can short-circuit.
**Learning:** `timingSafeEqual` alone does not provide constant-time comparison for strings of differing lengths.
**Prevention:** To prevent length-based short-circuiting timing attacks, inputs should first be hashed using `createHash('sha256')` to ensure both values have fixed identical length before they are compared with `timingSafeEqual`.
