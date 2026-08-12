/**
 * Demo-mode lock UI tests (checkDemoModeStatus / updateDemoModeUI in
 * src/features/onboarding.ts).
 *
 * The hosted site reports disable_locked: true from
 * GET /api/settings/demo-mode (one visitor toggling demo off would flip the
 * whole shared site). The settings toggle must grey out and show the locked
 * hint instead of letting the PUT fail with a 403 toast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApiCall } = vi.hoisted(() => ({
  mockApiCall: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiCall: mockApiCall,
}));

vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/ui/loading', () => ({
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

vi.mock('@/ui/tabs', () => ({
  showTab: vi.fn(),
}));

vi.mock('@/database/client-database', () => ({
  clientDB: {},
}));

vi.mock('@/api/dispatcher', () => ({
  getLocalAPI: vi.fn(),
}));

import { checkDemoModeStatus } from '@/features/onboarding';

function setupDom(): void {
  document.body.replaceChildren();

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'demo-mode-toggle';

  const status = document.createElement('span');
  status.id = 'demo-mode-status';

  const banner = document.createElement('div');
  banner.id = 'demo-mode-banner';
  banner.classList.add('hidden');

  const hint = document.createElement('p');
  hint.id = 'demo-mode-locked-hint';
  hint.classList.add('hidden');

  document.body.append(toggle, status, banner, hint);
}

describe('demo mode lock UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDom();
  });

  it('disables the toggle and shows the hint when the server locks disabling', async () => {
    mockApiCall.mockResolvedValue({ enabled: true, disable_locked: true });

    await checkDemoModeStatus();

    const toggle = document.getElementById('demo-mode-toggle') as HTMLInputElement;
    const hint = document.getElementById('demo-mode-locked-hint') as HTMLElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(hint.classList.contains('hidden')).toBe(false);
  });

  it('leaves the toggle usable when disabling is not locked', async () => {
    mockApiCall.mockResolvedValue({ enabled: true, disable_locked: false });

    await checkDemoModeStatus();

    const toggle = document.getElementById('demo-mode-toggle') as HTMLInputElement;
    const hint = document.getElementById('demo-mode-locked-hint') as HTMLElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(hint.classList.contains('hidden')).toBe(true);
  });

  it('keeps the toggle usable when locked but demo is off (turning ON is allowed)', async () => {
    mockApiCall.mockResolvedValue({ enabled: false, disable_locked: true });

    await checkDemoModeStatus();

    const toggle = document.getElementById('demo-mode-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
  });
});
