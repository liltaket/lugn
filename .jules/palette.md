## 2025-02-18 - Semantic `<output>` and `aria-valuetext` for Range Sliders

**Learning:** Screen readers might not correctly read out values for native HTML `<input type="range">` unless `aria-valuetext` is explicitly provided and updated dynamically. Additionally, the textual display of a slider's value should use the `<output>` tag linked via `htmlFor` matching the slider's `id` instead of a plain `<span>` to ensure proper semantic association and accessibility.
**Action:** When implementing custom range sliders, always set and update `aria-valuetext` in JavaScript and pair them with a semantically correct `<output>` element connected by `htmlFor` and `id`.

## 2026-10-12 - Form Validation Feedback with aria-invalid

**Learning:** When displaying inline form errors (like login failures), simply showing an error message isn't enough for screen readers. The associated input needs `aria-invalid` toggled to properly communicate its invalid state.
**Action:** Whenever showing or hiding an error message for an input field, always toggle the `aria-invalid` attribute on the corresponding input element simultaneously.
