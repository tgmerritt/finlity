/**
 * Regression tests for F5's local-mode composites:
 * - POST /api/analysis/fund/analyze-portfolio (handleLocalAnalyzePortfolioFunds)
 * - POST /api/analysis/positions/update-sectors (handleLocalUpdatePositionSectors)
 * - GET /api/settings/demo-mode local stub
 * - POST /api/analysis/advisor/chat/clear local no-op
 *
 * Also covers F6: sector is exposed end-to-end (LocalAPI.getPositions -> the
 * dispatcher's PositionResponse -> buildPortfolioPayload).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@/state/store';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache, getLocalAPI, buildPortfolioPayload } from '@/api/dispatcher';
import { apiCall } from '@/api/client';

describe('local-mode fund/sector composites (F5) and sector plumbing (F6)', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    store.resetState();
    store.set('dataMode', 'local');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  it('F6: a seeded position with a sector carries it through getPositions and buildPortfolioPayload', async () => {
    const api = getLocalAPI();
    const account = api.createAccount({ name: 'Brokerage', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });
    api.setSectorForTicker('AAPL', 'Technology');

    const positions = api.getPositions();
    expect(positions[0]?.sector).toBe('Technology');

    const payload = buildPortfolioPayload();
    expect(payload.accounts[0]?.positions[0]?.sector).toBe('Technology');
  });

  it('GET /api/settings/demo-mode is a PASSTHROUGH (real server state, not a local stub)', async () => {
    // Regression: a local stub used to return enabled:false unconditionally,
    // which hid the demo banner/badge on the hosted demo site while the
    // server was actually running demo.db. The read must hit the network.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ enabled: true, demo_initialized: true, protected: true, disable_locked: true }),
    });

    const result = await apiCall<{ enabled: boolean; demo_initialized: boolean; protected: boolean }>(
      '/api/settings/demo-mode'
    );
    expect(result.enabled).toBe(true);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('POST /api/analysis/advisor/chat/clear succeeds without any network call', async () => {
    const result = await apiCall('/api/analysis/advisor/chat/clear', { method: 'POST' });
    expect(result).toEqual({ status: 'cleared' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fund/analyze-portfolio: analyzes each is_fund ticker via v2 and writes the primary sector back locally', async () => {
    const api = getLocalAPI();
    const account = api.createAccount({ name: 'Brokerage', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'VTI', shares: 5, is_fund: true });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        ticker: 'VTI',
        name: 'Vanguard Total Stock Market',
        sector_breakdown: { Technology: 0.3, Financials: 0.1 },
        data_source: 'claude',
      }),
    });

    const result = await apiCall<{
      analyzed: Array<Record<string, unknown>>;
      total_funds: number;
      positions_updated: number;
    }>('/api/analysis/fund/analyze-portfolio', { method: 'POST' });

    expect(result.total_funds).toBe(1);
    expect(result.positions_updated).toBe(1);
    expect(result.analyzed[0]?.primary_sector).toBe('Technology');

    const [, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(requestInit.body)).toEqual({ ticker: 'VTI' });

    const positions = api.getPositions();
    expect(positions[0]?.sector).toBe('Technology');
  });

  it('fund/analyze-portfolio: reports "no funds" without any network call when there are no is_fund positions', async () => {
    const result = await apiCall<{ analyzed: unknown[]; total_funds: number; message?: string }>(
      '/api/analysis/fund/analyze-portfolio',
      { method: 'POST' }
    );
    expect(result.total_funds).toBe(0);
    expect(result.message).toBe('No funds found in portfolio');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('update-sectors: batches tickers missing a sector, applies v2 results, and skips non-tradeable tickers', async () => {
    const api = getLocalAPI();
    const account = api.createAccount({ name: 'Brokerage', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'MSFT', shares: 3 });
    api.createCashPosition({ account_id: account.id, amount: 500 }); // ticker 'CASH' — excluded

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ sectors: { MSFT: 'Technology' }, errors: [] }),
    });

    const result = await apiCall<{
      analyzed: Array<{ ticker: string; sector: string | null }>;
      total_tickers: number;
      positions_updated: number;
    }>('/api/analysis/positions/update-sectors', { method: 'POST' });

    expect(result.total_tickers).toBe(1);
    expect(result.positions_updated).toBe(1);
    expect(result.analyzed).toEqual([{ ticker: 'MSFT', sector: 'Technology' }]);

    const [, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(requestInit.body)).toEqual({ tickers: ['MSFT'] });

    const positions = api.getPositions();
    const msft = positions.find((p) => p.ticker === 'MSFT');
    expect(msft?.sector).toBe('Technology');
  });

  it('update-sectors: reports "all set" without a network call when nothing is missing a sector', async () => {
    const result = await apiCall<{ analyzed: unknown[]; total_tickers: number; message?: string }>(
      '/api/analysis/positions/update-sectors',
      { method: 'POST' }
    );
    expect(result.total_tickers).toBe(0);
    expect(result.message).toBe('All positions already have sectors');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
