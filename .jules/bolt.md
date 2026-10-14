## 2024-05-18 - Avoid [...arr].reverse().find()

**Learning:** When trying to find the last item in an array matching a predicate, `[...arr].reverse().find()` creates a shallow copy of the entire array and reverses it. This leads to an O(N) memory allocation and O(N) operation overhead before the search even begins. This was found in `CommandLedger` where it is frequently called.
**Action:** Replace `[...arr].reverse().find()` with backward `for` loops. This avoids the memory allocation and retains O(N) worst-case time complexity, but fast-paths early exit for matching elements near the end. `Array.prototype.findLast()` would be another option if the project configuration supported ES2023 or newer.

## 2024-10-14 - Intl.DateTimeFormat Instantiation Overhead

**Learning:** Instantiating `Intl.DateTimeFormat` is expensive, especially in a hot loop like a timer callback (e.g. `setInterval` for a clock running every second) or in methods that get evaluated repeatedly during app state changes.
**Action:** Extract `Intl.DateTimeFormat` instances to module scope and reuse them when parsing/formatting dates. The formatter acts purely on the provided `Date` object and is safe to reuse across calls without leaking state.
