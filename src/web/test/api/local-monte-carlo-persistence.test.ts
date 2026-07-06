/**
 * Regression tests for F13: local Monte Carlo persistence.
 *
 * After a successful local-mode POST /api/projections/monte-carlo, the
 * result must be saved into the local monte_carlo_results table
 * (LocalAPI.saveMonteCarloResult), and the dashboard-metrics composite
 * (GET /api/portfolio/dashboard-metrics) must read the latest saved row
 * instead of always reporting simulation_required: true.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@/state/store';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache, getLocalAPI } from '@/api/dispatcher';
import { apiCall } from '@/api/client';

describe('F13: local Monte Carlo persistence', () => {
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

  it('dashboard-metrics reports simulation_required: true when nothing has ever been saved', async () => {
    const metrics = await apiCall<{ simulation_required: boolean }>(
      '/api/portfolio/dashboard-metrics'
    );
    expect(metrics.simulation_required).toBe(true);
  });

  it('a successful local monte-carlo call persists a row and dashboard-metrics reflects it afterward', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        status: 'completed',
        success_rate: 0.87,
        median_end_value: 1500000,
        percentile_10: 400000,
        percentile_90: 3000000,
      }),
    });

    await apiCall('/api/projections/monte-carlo', {
      method: 'POST',
      body: {
        current_age: 45,
        retirement_age: 65,
        current_balance: 500000,
        monthly_contribution: 2000,
        monthly_withdrawal: 4000,
        stock_allocation: 0.7,
        bond_allocation: 0.3,
      },
    });

    const latest = getLocalAPI().getLatestMonteCarloResult();
    expect(latest).not.toBeNull();
    expect(latest?.current_age).toBe(45);
    expect(latest?.retirement_age).toBe(65);
    expect(latest?.success_rate).toBe(0.87);
    expect(latest?.median_final_value).toBe(1500000);
    expect(latest?.worst_case_final).toBe(400000);
    expect(latest?.best_case_final).toBe(3000000);

    const metrics = await apiCall<{
      simulation_required: boolean;
      success_probability: number | null;
      current_age: number | null;
      target_retirement_age: number | null;
      projected_value_at_retirement: number | null;
      conservative_value_at_retirement: number | null;
    }>('/api/portfolio/dashboard-metrics');

    expect(metrics.simulation_required).toBe(false);
    expect(metrics.success_probability).toBe(0.87);
    expect(metrics.current_age).toBe(45);
    expect(metrics.target_retirement_age).toBe(65);
    expect(metrics.projected_value_at_retirement).toBe(1500000);
    expect(metrics.conservative_value_at_retirement).toBe(400000);
  });

  it('a monte-carlo call missing current_age/retirement_age in the request does not write a row or throw', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success_rate: 0.5 }),
    });

    await expect(
      apiCall('/api/projections/monte-carlo', {
        method: 'POST',
        body: { stock_allocation: 0.7, bond_allocation: 0.3 },
      })
    ).resolves.toBeDefined();

    expect(getLocalAPI().getLatestMonteCarloResult()).toBeNull();
  });

  it('a save failure is swallowed (warns, does not reject the caller — the simulation itself already succeeded)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success_rate: 0.9 }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(getLocalAPI(), 'saveMonteCarloResult').mockImplementation(() => {
      throw new Error('simulated write failure');
    });

    await expect(
      apiCall('/api/projections/monte-carlo', {
        method: 'POST',
        body: { current_age: 40, retirement_age: 60 },
      })
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('getLatestMonteCarloResult returns the most recently saved row when multiple exist', async () => {
    const api = getLocalAPI();
    api.saveMonteCarloResult({
      current_age: 30,
      retirement_age: 65,
      portfolio_balance: 100000,
      success_rate: 0.5,
    });
    // sql.js's CURRENT_TIMESTAMP has 1-second resolution; force a distinct,
    // later run_date so the ORDER BY is unambiguous.
    clientDB.execute(
      "UPDATE monte_carlo_results SET run_date = datetime('now', '+1 second') WHERE current_age = 30"
    );
    api.saveMonteCarloResult({
      current_age: 50,
      retirement_age: 67,
      portfolio_balance: 900000,
      success_rate: 0.95,
    });
    clientDB.execute(
      "UPDATE monte_carlo_results SET run_date = datetime('now', '+2 seconds') WHERE current_age = 50"
    );

    const latest = api.getLatestMonteCarloResult();
    expect(latest?.current_age).toBe(50);
    expect(latest?.success_rate).toBe(0.95);
  });
});
