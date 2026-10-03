/**
 * The Holdings account multi-select narrows the table within the toolbar View.
 * Its labels must not read like a second "All accounts" View selector.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn().mockResolvedValue({}) }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));

import { updateAccountFilterLabel } from '@/pages/holdings';

function setup(checked: boolean[]): void {
  document.body.innerHTML = `
    <span id="account-filter-label"></span>
    <div id="account-filter-options">
      ${checked
        .map((c, i) => `<input type="checkbox" value="Acct ${i}" ${c ? 'checked' : ''}>`)
        .join('')}
    </div>`;
}

const label = (): string => document.getElementById('account-filter-label')?.textContent ?? '';

describe('updateAccountFilterLabel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('says "All in view" rather than repeating the toolbar "All Accounts"', () => {
    setup([true, true, true]);
    updateAccountFilterLabel();
    expect(label()).toBe('All in view');
  });

  it('names a single account, counts a subset, and reports none', () => {
    setup([true, false, false]);
    updateAccountFilterLabel();
    expect(label()).toBe('Acct 0');

    setup([true, true, false]);
    updateAccountFilterLabel();
    expect(label()).toBe('2 of 3 accounts');

    setup([false, false]);
    updateAccountFilterLabel();
    expect(label()).toBe('No accounts');
  });
});
