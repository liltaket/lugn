1. **Add `aria-busy` to `camera-save` button in `web/app.js`**:
   - Update `updateCameraWebControls()` in `web/app.js` to modify the `aria-busy` attribute of the `camera-save` button.
   - Set `aria-busy` to `'true'` when `cameraWebBusy` is true, and remove the attribute when false.

2. **Add `aria-busy` to Lugn 2 UI buttons (`routine-save`, `intelligence-save`)**:
   - Update `updateLugn2Controls()` in `web/app.js` to manage the `aria-busy` state of these save buttons when they are waiting for server responses (`l2Pending`).

3. **Complete pre commit steps**
   - Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.

4. **Submit PR with the UX improvement.**
