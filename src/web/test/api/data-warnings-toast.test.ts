/**
 * Regression tests for F14: surfacing data_warnings from v2 analysis/
 * projection responses as a throttled toast.
 *
 * When a PAYLOAD-routed local-mode response includes a non-null
 * data_warnings.excluded_positions, show a single warning toast
 * ("N position(s) excluded from analysis — missing prices"), throttled to
 * once per page-load per endpoint family (grouped by the v1 path's second
 * segment, e.g. "analysis" or "projections").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@/state/store';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache } from '@/api/dispatcher';
import { apiCall, resetDataWarningsThrottle } from '@/api/client';

vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
import { showToast } from '@/ui/toast';

describe('F14: data_warnings toast', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    resetDataWarningsThrottle();
    store.resetState();
    store.set('dataMode', 'local');
    global.fetch = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  function mockJsonResponse(body: unknown): void {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => body,
    });
  }

  it('shows a warning toast when data_warnings.excluded_positions is non-empty', async () => {
    mockJsonResponse({
      risk_score: 5,
      data_warnings: {
        excluded_positions: [{ ticker: 'XYZ', account_name: 'Brokerage', reason: 'missing price' }],
        count: 1,
      },
    });

    await apiCall('/api/analysis/risk');

    expect(showToast).toHaveBeenCalledWith(
      '1 position excluded from analysis — missing prices',
      'warning'
    );
  });

  it('pluralizes for more than one excluded position', async () => {
    mockJsonResponse({
      data_warnings: {
        excluded_positions: [
          { ticker: 'A', account_name: 'Acc', reason: 'x' },
          { ticker: 'B', account_name: 'Acc', reason: 'x' },
        ],
        count: 2,
      },
    });

    await apiCall('/api/analysis/risk');

    expect(showToast).toHaveBeenCalledWith(
      '2 positions excluded from analysis — missing prices',
      'warning'
    );
  });

  it('does not toast when data_warnings is null', async () => {
    mockJsonResponse({ risk_score: 5, data_warnings: null });

    await apiCall('/api/analysis/risk');

    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not toast when data_warnings is absent entirely (older/unaffected responses)', async () => {
    mockJsonResponse({ risk_score: 5 });

    await apiCall('/api/analysis/risk');

    expect(showToast).not.toHaveBeenCalled();
  });

  it('throttles to once per page-load per endpoint family: a second call to the same family does not re-toast', async () => {
    mockJsonResponse({
      data_warnings: { excluded_positions: [{ ticker: 'A', account_name: 'Acc', reason: 'x' }], count: 1 },
    });

    await apiCall('/api/analysis/risk');
    await apiCall('/api/analysis/performance'); // same family ("analysis")

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('a different endpoint family (projections) gets its own toast even after analysis already warned', async () => {
    mockJsonResponse({
      data_warnings: { excluded_positions: [{ ticker: 'A', account_name: 'Acc', reason: 'x' }], count: 1 },
    });

    await apiCall('/api/analysis/risk');
    await apiCall('/api/projections/monte-carlo', {
      method: 'POST',
      body: { current_age: 40, retirement_age: 65 },
    });

    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('resetDataWarningsThrottle() allows a fresh toast for a family already warned (simulates a new page load)', async () => {
    mockJsonResponse({
      data_warnings: { excluded_positions: [{ ticker: 'A', account_name: 'Acc', reason: 'x' }], count: 1 },
    });

    await apiCall('/api/analysis/risk');
    resetDataWarningsThrottle();
    await apiCall('/api/analysis/risk');

    expect(showToast).toHaveBeenCalledTimes(2);
  });
});
