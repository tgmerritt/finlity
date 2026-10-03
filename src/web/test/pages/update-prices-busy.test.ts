/**
 * The Update Prices button keeps its icon and label markup while busy (the
 * "Updating..." text is CSS keyed on aria-busy), and is disabled meanwhile.
 */

import { describe, it, expect, vi } from 'vitest';

let release: (v: unknown) => void = () => {};
vi.mock('@/api/client', () => ({
  apiCall: vi.fn(
    (url: string) =>
      new Promise((resolve) => {
        if (url.includes('refresh-prices')) release = resolve;
        else resolve({});
      })
  ),
}));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));

import { initDashboard } from '@/pages/dashboard';

describe('Update Prices button while refreshing', () => {
  it('sets aria-busy and disabled and keeps the icon and label', async () => {
    document.body.innerHTML = `
      <button id="update-prices-btn" aria-label="Update prices">
        <svg id="up-icon"></svg><span class="btn-label">Update Prices</span>
      </button>`;
    initDashboard();
    const btn = document.getElementById('update-prices-btn') as HTMLButtonElement;

    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(document.getElementById('up-icon')).not.toBeNull();
    expect(btn.querySelector('.btn-label')!.textContent).toBe('Update Prices');

    release({ updated: 0, all_fresh: true });
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(document.getElementById('up-icon')).not.toBeNull();
  });
});
