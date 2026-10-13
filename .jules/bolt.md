## 2024-05-18 - Avoid [...arr].reverse().find()

**Learning:** When trying to find the last item in an array matching a predicate, `[...arr].reverse().find()` creates a shallow copy of the entire array and reverses it. This leads to an O(N) memory allocation and O(N) operation overhead before the search even begins. This was found in `CommandLedger` where it is frequently called.
**Action:** Replace `[...arr].reverse().find()` with backward `for` loops. This avoids the memory allocation and retains O(N) worst-case time complexity, but fast-paths early exit for matching elements near the end. `Array.prototype.findLast()` would be another option if the project configuration supported ES2023 or newer.

## 2024-05-19 - Cache Intl.DateTimeFormat instantiations

**Learning:** `Intl.DateTimeFormat` instantiation is relatively expensive and was happening on hot paths, such as inside `setClock` in the UI (called every second) or in backend processing methods.
**Action:** Extract `Intl.DateTimeFormat` instantiations to module-level constants or class properties so they are created once and reused, reducing memory allocation and improving performance on hot paths.
