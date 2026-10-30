## 2025-02-18 - Semantic `<output>` and `aria-valuetext` for Range Sliders

**Learning:** Screen readers might not correctly read out values for native HTML `<input type="range">` unless `aria-valuetext` is explicitly provided and updated dynamically. Additionally, the textual display of a slider's value should use the `<output>` tag linked via `htmlFor` matching the slider's `id` instead of a plain `<span>` to ensure proper semantic association and accessibility.
**Action:** When implementing custom range sliders, always set and update `aria-valuetext` in JavaScript and pair them with a semantically correct `<output>` element connected by `htmlFor` and `id`.

## 2024-11-20 - Adding aria-busy to async operations

**Learning:** During long-running operations like API calls for music settings, buttons must reflect an `aria-busy` state for screen reader users, indicating the pending operation without simply relying on text changes.
**Action:** When updating a button's visual or text state during async operations (e.g., `button.textContent = 'Sparar…'`), remember to also add `button.setAttribute('aria-busy', 'true')` and remove it in the `finally` block to ensure a consistent experience for assistive technologies.

## 2024-05-18 - Missing ARIA busy state on login loading button

**Learning:** Found that the main login submission button disabled itself and changed text during loading but failed to announce to screen readers via the `aria-busy` attribute, leaving them without context on the background loading status.
**Action:** When adding or verifying loading states that modify button text to include a loading indication, ensure the `aria-busy` attribute is also toggled correctly and cleaned up using `finally` blocks to keep the component fully accessible in all execution paths.
