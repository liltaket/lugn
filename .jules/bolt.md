## 2024-05-15 - Array Reverse Find Polyfill
**Learning:** The codebase used a common anti-pattern for finding elements from the end of an array: `[...arr].reverse().find(predicate)`. This clones the entire array and reverses it, allocating O(N) memory and taking O(N) time before even running the find predicate. Also, since TS target is ES2022, `Array.prototype.findLast()` is unavailable and causes compile errors.
**Action:** Replace `[...arr].reverse().find(predicate)` with backwards `for` loops. It's O(1) memory and O(K) time, and it compiles correctly on ES2022.
