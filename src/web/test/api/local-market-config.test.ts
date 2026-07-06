/**
 * Regression tests for F7: local-mode risk/projections requests must embed
 * market_config/monte_carlo_config built from the local settings sections
 * (getConfigSection('market')/('monte_carlo')) so hosted users' saved
 * assumptions actually reach v2's math instead of being silently ignored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { matchPayloadRoute, NOT_HANDLED, resetLocalAPICache, getLocalAPI } from '@/api/dispatcher';

describe('F7: market_config/monte_carlo_config embedding', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
  });

  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  it('GET /api/analysis/risk carries no market_config when nothing has been saved', () => {
    const match = matchPayloadRoute('/api/analysis/risk', { method: 'GET' });
    expect(match).not.toBe(NOT_HANDLED);
    if (match === NOT_HANDLED) throw new Error('unreachable');
    const body = match.options.body as Record<string, unknown>;
    expect(body.market_config).toBeUndefined();
    expect(body.monte_carlo_config).toBeUndefined();
    // Portfolio payload is still present — this endpoint didn't lose its
    // existing behavior.
    expect(body).toHaveProperty('accounts');
  });

  it('GET /api/analysis/risk embeds market_config once market assumptions are saved', () => {
    getLocalAPI().updateConfigSection('market', {
      stock_mean_return: 0.08,
      stock_std_dev: 0.16,
      bond_mean_return: 0.03,
      bond_std_dev: 0.05,
      stock_bond_correlation: -0.2,
      inflation_rate: 0.025,
      risk_free_rate: 0.02,
    });

    const match = matchPayloadRoute('/api/analysis/risk', { method: 'GET' });
    if (match === NOT_HANDLED) throw new Error('unreachable');
    const body = match.options.body as Record<string, unknown>;
    expect(body.market_config).toEqual({
      stock_mean_return: 0.08,
      stock_std_dev: 0.16,
      bond_mean_return: 0.03,
      bond_std_dev: 0.05,
      stock_bond_correlation: -0.2,
      inflation_rate: 0.025,
      risk_free_rate: 0.02,
    });
  });

  it('POST /api/projections/monte-carlo embeds both configs once saved', () => {
    getLocalAPI().updateConfigSection('market', { risk_free_rate: 0.02 });
    getLocalAPI().updateConfigSection('monte_carlo', {
      num_simulations: 5000,
      black_swan_probability: 0.05,
      black_swan_impact: 0.3,
      golden_swan_probability: 0.03,
      golden_swan_impact: 0.25,
      t_distribution_df: 5,
    });

    const match = matchPayloadRoute('/api/projections/monte-carlo', {
      method: 'POST',
      body: { current_age: 40, retirement_age: 65 },
    });
    if (match === NOT_HANDLED) throw new Error('unreachable');
    const body = match.options.body as Record<string, unknown>;
    expect(body.market_config).toEqual({ risk_free_rate: 0.02 });
    expect(body.monte_carlo_config).toMatchObject({
      num_simulations: 5000,
      black_swan_probability: 0.05,
    });
    // Original request fields are preserved alongside the injected configs.
    expect(body.current_age).toBe(40);
    expect(body.retirement_age).toBe(65);
  });

  it('POST /api/projections/sensitivity does not override an explicit market_config already in the request body', () => {
    getLocalAPI().updateConfigSection('market', { risk_free_rate: 0.02 });

    const explicitOverride = { risk_free_rate: 0.099 };
    const match = matchPayloadRoute('/api/projections/sensitivity', {
      method: 'POST',
      body: { market_config: explicitOverride },
    });
    if (match === NOT_HANDLED) throw new Error('unreachable');
    const body = match.options.body as Record<string, unknown>;
    expect(body.market_config).toEqual(explicitOverride);
  });
});
