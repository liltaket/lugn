## 2024-05-18 - Missing ARIA busy state on login loading button
**Learning:** Found that the main login submission button disabled itself and changed text during loading but failed to announce to screen readers via the `aria-busy` attribute, leaving them without context on the background loading status.
**Action:** When adding or verifying loading states that modify button text to include a loading indication, ensure the `aria-busy` attribute is also toggled correctly to keep the component fully accessible.
