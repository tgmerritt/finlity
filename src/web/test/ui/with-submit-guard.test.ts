/**
 * Tests for withSubmitGuard.
 *
 * Covers the audit-finding behaviour: button must be disabled while the
 * promise is in flight, must be re-enabled on both success AND rejection,
 * aria-busy must toggle, and an optional loading label must round-trip.
 */

import { describe, it, expect, vi } from 'vitest';
import { withSubmitGuard } from '@/ui/with-submit-guard';

function makeButton(initialText = 'Save'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = initialText;
  return btn;
}

describe('withSubmitGuard', () => {
  it('disables the button for the duration of the promise', async () => {
    const btn = makeButton();
    let observedDisabledMidFlight = false;

    const work = vi.fn(async () => {
      observedDisabledMidFlight = btn.disabled;
      return 'ok';
    });

    const result = await withSubmitGuard(btn, '', work);

    expect(observedDisabledMidFlight).toBe(true);
    expect(result).toBe('ok');
    expect(btn.disabled).toBe(false);
  });

  it('re-enables the button after the promise rejects', async () => {
    const btn = makeButton();

    await expect(
      withSubmitGuard(btn, '', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(btn.disabled).toBe(false);
  });

  it('toggles aria-busy on entry and clears it on exit when none was set', async () => {
    const btn = makeButton();

    await withSubmitGuard(btn, '', async () => {
      expect(btn.getAttribute('aria-busy')).toBe('true');
    });

    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('restores a pre-existing aria-busy value', async () => {
    const btn = makeButton();
    btn.setAttribute('aria-busy', 'false');

    await withSubmitGuard(btn, '', async () => {
      expect(btn.getAttribute('aria-busy')).toBe('true');
    });

    expect(btn.getAttribute('aria-busy')).toBe('false');
  });

  it('swaps the loading label and restores the original text', async () => {
    const btn = makeButton('Save Account');

    await withSubmitGuard(btn, 'Saving...', async () => {
      expect(btn.textContent).toBe('Saving...');
    });

    expect(btn.textContent).toBe('Save Account');
  });

  it('restores label even when the promise rejects', async () => {
    const btn = makeButton('Add Position');

    await expect(
      withSubmitGuard(btn, 'Adding...', async () => {
        expect(btn.textContent).toBe('Adding...');
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');

    expect(btn.textContent).toBe('Add Position');
  });

  it('does not swap label when loadingLabel is empty', async () => {
    const btn = makeButton('Update Prices');

    await withSubmitGuard(btn, '', async () => {
      // Empty label => caller doesn't want a swap. Text stays put.
      expect(btn.textContent).toBe('Update Prices');
    });

    expect(btn.textContent).toBe('Update Prices');
  });

  it('still runs the callback when the button is null', async () => {
    const fn = vi.fn().mockResolvedValue('ran');
    const result = await withSubmitGuard(null, 'ignored', fn);

    expect(fn).toHaveBeenCalled();
    expect(result).toBe('ran');
  });

  it('preserves the original disabled state if it was already true', async () => {
    const btn = makeButton();
    btn.disabled = true;

    await withSubmitGuard(btn, '', async () => {
      expect(btn.disabled).toBe(true);
    });

    // We're not in the business of "fixing" pre-disabled buttons.
    expect(btn.disabled).toBe(true);
  });
});
