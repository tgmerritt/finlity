/**
 * After a result appears, the Monte Carlo inputs panel collapses on phones only.
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
vi.mock('@/charts/projections', () => ({
  displayProjectionResults: vi.fn().mockResolvedValue(undefined),
}));

import { collapseConfigPanelOnPhone, toggleConfigPanel } from '@/pages/projections';

function setViewport(width: number): void {
  window.innerWidth = width;
}

describe('collapseConfigPanelOnPhone', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="config-panel" id="monte-carlo-config-panel"></div>';
  });

  it('collapses the panel at phone width', () => {
    setViewport(390);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(true);
  });

  it('leaves the panel as it was on desktop', () => {
    setViewport(1440);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(false);
  });

  it('lets the user reopen it with the header toggle', () => {
    setViewport(390);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    toggleConfigPanel('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(false);
  });

  it('ignores a missing panel', () => {
    setViewport(390);
    expect(() => collapseConfigPanelOnPhone('nope')).not.toThrow();
  });
});
