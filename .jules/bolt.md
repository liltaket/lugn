## 2026-10-16 - Cached Intl formatters for performance
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiations are computationally expensive. Repeatedly creating them inside frequent functions like rendering or formatting loops introduces overhead and garbage collection churn.
**Action:** Always cache these formatters at the module or class level to reuse instances efficiently without altering application behavior.
