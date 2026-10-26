## 2025-02-18 - Semantic `<output>` and `aria-valuetext` for Range Sliders

**Learning:** Screen readers might not correctly read out values for native HTML `<input type="range">` unless `aria-valuetext` is explicitly provided and updated dynamically. Additionally, the textual display of a slider's value should use the `<output>` tag linked via `htmlFor` matching the slider's `id` instead of a plain `<span>` to ensure proper semantic association and accessibility.
**Action:** When implementing custom range sliders, always set and update `aria-valuetext` in JavaScript and pair them with a semantically correct `<output>` element connected by `htmlFor` and `id`.

## 2024-05-14 - Improve accessibility of volume and brightness sliders

**Learning:** Dynamically updated text nodes tied to range inputs (like `<output>`) must use `aria-live` to ensure screen readers read the value updates properly.
**Action:** When creating slider elements, always ensure their associated `<output>` elements have `aria-live="polite"` so screen readers can announce the changes.
