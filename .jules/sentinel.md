## 2024-05-24 - [Timing Attack in Secret Comparison]
**Vulnerability:** Found a timing attack vulnerability in `secretsEqual` (`src/runtime/display-server.ts`) and `constantTimeEqual` / `hasValidBearerToken` (`src/runtime/http-server.ts`).
**Learning:** `timingSafeEqual` throws if buffer lengths are different, so the original code used an early return `length === expectedLength`. This short-circuit revealed length differences via timing attacks.
**Prevention:** Hash inputs first using `createHash` to guarantee equal length before calling `timingSafeEqual`, ensuring constant time execution regardless of input length.
