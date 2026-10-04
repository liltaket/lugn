## 2024-10-04 - Improve Login Form UX

**Learning:** Adding a placeholder to token inputs helps users understand the expected format, and explicitly marking required fields visually (e.g., with an asterisk) improves clarity for all users. Adding `aria-busy` to buttons during async submission provides critical screen reader feedback that an action is processing.
**Action:** Always add placeholders to ambiguous inputs like tokens, explicitly mark required fields both visually and semantically, and use `aria-busy` for async submit buttons to improve accessibility.
