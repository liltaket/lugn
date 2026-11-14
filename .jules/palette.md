## 2024-11-08 - Accessible Buttons During Async Operations

**Learning:** Buttons handling asynchronous actions (like saving data) should clearly indicate their busy state to screen readers while simultaneously disabling related actions to prevent duplicate submissions or concurrent modifications.
**Action:** When creating or updating a busy state function (like `setPresetBusy`), always set `aria-busy="true"` on the primary action button and ensure all related buttons (save, delete, activate) are disabled during the operation.

## 2024-11-08 - Accessible Buttons During Async Operations

**Learning:** Buttons handling asynchronous actions (like saving data) should clearly indicate their busy state to screen readers while simultaneously disabling related actions to prevent duplicate submissions or concurrent modifications.
**Action:** When creating or updating a busy state function (like `setPresetBusy`), always set `aria-busy="true"` on the primary action button and ensure all related buttons (save, delete, activate) are disabled during the operation.
