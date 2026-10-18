## 2024-05-18 - Avoid [...arr].reverse().find()

**Learning:** When trying to find the last item in an array matching a predicate, `[...arr].reverse().find()` creates a shallow copy of the entire array and reverses it. This leads to an O(N) memory allocation and O(N) operation overhead before the search even begins. This was found in `CommandLedger` where it is frequently called.
**Action:** Replace `[...arr].reverse().find()` with backward `for` loops. This avoids the memory allocation and retains O(N) worst-case time complexity, but fast-paths early exit for matching elements near the end. `Array.prototype.findLast()` would be another option if the project configuration supported ES2023 or newer.

## 2024-05-18 - Caching Intl.DateTimeFormat and Intl.NumberFormat instantiations

**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is relatively expensive in JavaScript. If instantiated inline inside highly-frequent operations like render loops or timer callbacks (e.g. `setClock` running every second), it can become a performance bottleneck.
**Action:** Always extract and cache `Intl.DateTimeFormat` and `Intl.NumberFormat` instances into module-level variables or class-level properties when used repeatedly or on hot paths.
## 2026-10-18 - Avoid [...document.querySelectorAll()].find()
**Learning:** When trying to find a single matching DOM element,  queries all matching elements, allocates an array of the NodeList, and iterates through it. This creates unnecessary O(N) memory allocation and overhead, slowing down critical render paths.
**Action:** Use  with a specific attribute selector (e.g. `[data-focus-key="${CSS.escape(key)}"]`) to directly fetch the intended node without extra array allocations.

## 2024-05-18 - Avoid [...document.querySelectorAll()].find()
**Learning:** When trying to find a single matching DOM element, `[...document.querySelectorAll()].find()` queries all matching elements, allocates an array of the NodeList, and iterates through it. This creates unnecessary O(N) memory allocation and overhead, slowing down critical render paths.
**Action:** Use `document.querySelector` with a specific attribute selector (e.g. `[data-focus-key="${CSS.escape(key)}"]`) to directly fetch the intended node without extra array allocations.
