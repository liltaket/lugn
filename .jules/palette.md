
## 2026-10-10 - Manual DOM text nodes need explicit semantic linking
**Learning:** When building UI interfaces dynamically with imperative DOM scripts (e.g., `document.createElement`), simple text labels like `<p>` or `<span>` elements miss native HTML semantic linking to inputs. They don't improve the click target area and fail to implicitly inform screen readers without extra ARIA tags.
**Action:** Use actual `<label>` elements and explicitly map their `htmlFor` attribute to the respective input's `id` to ensure broader click targets and robust accessibility for dynamically generated form controls.
