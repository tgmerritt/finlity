/**
 * Submit-guard helper for mutating form buttons.
 *
 * Wraps an async function with the standard "disable button while in flight"
 * UX pattern. Exists to close a P0 audit finding: users could double-click
 * "Save" / "Add Position" and create duplicate writes because nothing
 * disabled the button during the in-flight `apiCall`.
 *
 * Behaviour:
 *  - Disables the button and sets `aria-busy="true"` for assistive tech.
 *  - If `loadingLabel` is non-empty, swaps the button's text content and
 *    restores the original on completion (success or failure).
 *  - Errors propagate — the helper does NOT swallow them. Callers stay in
 *    charge of toast messaging.
 *  - If `button` is null (caller couldn't find the element), `fn` still runs
 *    so functionality isn't blocked by missing DOM.
 */

export async function withSubmitGuard<T>(
  button: HTMLButtonElement | null,
  loadingLabel: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!button) {
    // No button to guard — execute the work anyway so callers fail open.
    return fn();
  }

  const wasDisabled = button.disabled;
  const previousAriaBusy = button.getAttribute('aria-busy');
  const previousText = button.textContent;
  const shouldSwapLabel = loadingLabel.length > 0;

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (shouldSwapLabel) {
    button.textContent = loadingLabel;
  }

  try {
    return await fn();
  } finally {
    button.disabled = wasDisabled;
    if (previousAriaBusy === null) {
      button.removeAttribute('aria-busy');
    } else {
      button.setAttribute('aria-busy', previousAriaBusy);
    }
    if (shouldSwapLabel) {
      button.textContent = previousText;
    }
  }
}
