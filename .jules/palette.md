## 2024-05-18 - Tooltips on disabled buttons and aria-valuetext on sliders
**Learning:** Native range inputs need `aria-valuetext` to convey percentage or scaled meaning contextually to screen readers, avoiding them reading raw arbitrary numbers. Additionally, disabled adjust buttons without a tooltip leave users guessing *why* they cannot interact with them (e.g., already max/min, unavailable device, etc.).
**Action:** When implementing custom ranges or disable-able adjust controls, proactively add `aria-valuetext` updates and explicit title explanations for their disabled state.
