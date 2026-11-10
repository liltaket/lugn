1. **Add an input event listener to clear `aria-invalid` from `tokenInput` in `web/app.js`.**
   - The user should have the invalid state cleared as soon as they modify the input, as per memory instructions for accessible form validation.
2. **Update the `setLoginError` function in `web/app.js` to manage the `aria-invalid` state.**
   - When a login error message is present, set `tokenInput.setAttribute('aria-invalid', 'true')` to mark the field as invalid for screen readers.
   - When the error is cleared (no message), call `tokenInput.removeAttribute('aria-invalid')`.
3. **Add a journal entry to `.jules/palette.md`.**
   - Record the learning about explicitly managing the `aria-invalid` state for accessiblity and immediately clearing it on user interaction.
4. **Verify the changes and complete pre-commit steps.**
   - Check that `tokenInput` event listener and `setLoginError` modifications have been applied correctly in `web/app.js` by running `read_file`.
   - Run `pnpm check` and formatting to ensure no breakages or pipeline failures.
   - Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.
5. **Create a pull request.**
   - Title: `🎨 Palette: [UX improvement]`
   - Description containing What, Why, Before/After, and Accessibility sections.
