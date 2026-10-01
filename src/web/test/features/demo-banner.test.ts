/**
 * Demo banner: slim text, Settings link via showTab, session-scoped dismissal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockApiCall, mockShowTab } = vi.hoisted(() => ({
  mockApiCall: vi.fn(),
  mockShowTab: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiCall: mockApiCall }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/ui/loading', () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }));
vi.mock('@/ui/tabs', () => ({ showTab: mockShowTab }));
vi.mock('@/database/client-database', () => ({ clientDB: {} }));
vi.mock('@/api/dispatcher', () => ({ getLocalAPI: vi.fn() }));

import { updateDemoModeUI, initDemoBanner, startDemoMode } from '@/features/onboarding';

const banner = (): HTMLElement => document.getElementById('demo-mode-banner')!;
const isShown = (): boolean => !banner().classList.contains('hidden');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  document.body.innerHTML = `
    <div id="demo-mode-banner" class="demo-mode-banner hidden">
      <span class="demo-banner-text">Demo mode: sample data</span>
      <button class="demo-banner-link" id="demo-banner-settings">Settings</button>
      <button class="demo-banner-dismiss" id="demo-banner-dismiss" aria-label="Dismiss demo banner"></button>
    </div>`;
  initDemoBanner();
});

afterEach(() => vi.restoreAllMocks());

describe('demo banner', () => {
  it('shows when demo mode is on and hides when off', () => {
    updateDemoModeUI(true);
    expect(isShown()).toBe(true);
    updateDemoModeUI(false);
    expect(isShown()).toBe(false);
  });

  it('dismiss hides it and records sessionStorage.demoBannerDismissed', () => {
    updateDemoModeUI(true);
    document.getElementById('demo-banner-dismiss')!.click();
    expect(isShown()).toBe(false);
    expect(sessionStorage.getItem('demoBannerDismissed')).toBe('1');
  });

  it('stays hidden after dismissal on later updates and on startDemoMode', async () => {
    sessionStorage.setItem('demoBannerDismissed', '1');
    updateDemoModeUI(true);
    expect(isShown()).toBe(false);
    mockApiCall.mockResolvedValue({});
    await startDemoMode();
    expect(isShown()).toBe(false);
  });

  it('startDemoMode shows the banner when not dismissed', async () => {
    mockApiCall.mockResolvedValue({});
    await startDemoMode();
    expect(isShown()).toBe(true);
  });

  it('still shows, and dismiss still hides for the page, when sessionStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    updateDemoModeUI(true);
    expect(isShown()).toBe(true);
    document.getElementById('demo-banner-dismiss')!.click();
    expect(isShown()).toBe(false);
    updateDemoModeUI(true);
    expect(isShown()).toBe(false);
  });

  it('the Settings link opens the settings tab', () => {
    document.getElementById('demo-banner-settings')!.click();
    expect(mockShowTab).toHaveBeenCalledWith('settings');
  });
});
