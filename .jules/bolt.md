## 2024-05-30 - Optimize reverse array searches

**Learning:** Using `[...arr].reverse().find()` in environments without native `findLast()` support (like the TypeScript/ES2022 setup in this project without TS config modifications) is an O(N) operation but creates a full shallow copy of the array and reverses it, which adds memory pressure and garbage collection overhead.
**Action:** Always prefer a backward `for` loop (e.g. `for (let i = arr.length - 1; i >= 0; i--)`) to find the last element matching a condition, which achieves true O(1) space complexity and avoids copying.
