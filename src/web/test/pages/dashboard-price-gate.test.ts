/**
 * Tests for the market-gated price refresh flow:
 * - autoRefreshIfStale skips the POST when the market is closed,
 * - stays silent when the gate returns updated === 0,
 * - toasts and re-renders when a refresh actually ran,
 * - updatePriceStatus shows the "Markets closed" badge.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { autoRefreshIfStale, updatePriceStatus } from '@/pages/dashboard';

const apiCallMock = vi.mocked(apiCall);
const showToastMock = vi.mocked(showToast);

// Default response for any call the flow makes after the refresh POST
// (price-status re-fetch, dashboard data, metrics, widgets): enough shape
// that the dashboard render chain does not crash.
const DASHBOARD_DATA = {
  summary: { accounts: [] },
  positions: [],
  history: [],
};

afterEach(() => {
  vi.clearAllMocks();
  document.getElementById('price-status')?.remove();
});

function addPriceStatusEl(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'price-status';
  document.body.appendChild(el);
  return el;
}

describe('updatePriceStatus', () => {
  it('shows the markets-closed badge when the market is closed', async () => {
    const el = addPriceStatusEl();
    apiCallMock.mockResolvedValue({
      all_fresh: true,
      stale_tickers: 0,
      market_open: false,
      newest_update: '2026-08-07T20:00:00.000Z',
    });

    await updatePriceStatus();

    expect(el.className).toContain('fresh');
    expect(el.textContent).toContain('Markets closed');
    expect(el.textContent).toContain('prices as of');
  });

  it('still shows the stale count when the market is open', async () => {
    const el = addPriceStatusEl();
    apiCallMock.mockResolvedValue({
      all_fresh: false,
      stale_tickers: 3,
      market_open: true,
    });

    await updatePriceStatus();

    expect(el.className).toContain('stale');
    expect(el.textContent).toContain('3 stale');
  });
});

describe('autoRefreshIfStale', () => {
  it('skips the refresh POST when the market is closed', async () => {
    apiCallMock.mockResolvedValue({
      all_fresh: true,
      stale_tickers: 0,
      market_open: false,
    });

    await autoRefreshIfStale();

    // price-status only; no refresh-prices POST.
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('skips the refresh POST when everything is fresh', async () => {
    apiCallMock.mockResolvedValue({
      all_fresh: true,
      stale_tickers: 0,
      market_open: true,
    });

    await autoRefreshIfStale();

    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('stays silent when the gate returns updated === 0', async () => {
    apiCallMock.mockResolvedValue({});
    apiCallMock
      .mockResolvedValueOnce({ all_fresh: false, stale_tickers: 2, market_open: true })
      .mockResolvedValueOnce({
        all_fresh: false,
        updated: 0,
        next_refresh_at: '2026-08-11T16:00:00.000Z',
      });

    await autoRefreshIfStale();

    expect(apiCallMock).toHaveBeenCalledTimes(2);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('toasts and refreshes the dashboard when a refresh ran', async () => {
    apiCallMock.mockResolvedValue(DASHBOARD_DATA);
    apiCallMock
      .mockResolvedValueOnce({ all_fresh: false, stale_tickers: 2, market_open: true })
      .mockResolvedValueOnce({ all_fresh: false, updated: 2, failed: 0 });

    await autoRefreshIfStale();

    expect(showToastMock).toHaveBeenCalledWith('Auto-updated 2 price(s)', 'info');
    expect(apiCallMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
