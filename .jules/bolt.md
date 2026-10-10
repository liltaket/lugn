## 2024-05-18 - Avoid [...arr].reverse().find()

**Learning:** When trying to find the last item in an array matching a predicate, `[...arr].reverse().find()` creates a shallow copy of the entire array and reverses it. This leads to an O(N) memory allocation and O(N) operation overhead before the search even begins. This was found in `CommandLedger` where it is frequently called.
**Action:** Replace `[...arr].reverse().find()` with backward `for` loops. This avoids the memory allocation and retains O(N) worst-case time complexity, but fast-paths early exit for matching elements near the end. `Array.prototype.findLast()` would be another option if the project configuration supported ES2023 or newer.
