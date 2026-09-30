/**
 * GET /api/dashboard/data (hosted path) carries previous_close per position,
 * read from price_cache and null when the ticker has no cache row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { tryLocalRoute, resetLocalAPICache } from '@/api/dispatcher';

interface DashboardPositionLike {
  ticker: string;
  previous_close: number | null;
}

describe('dashboard data previous_close', () => {
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

  it('sends previous_close from price_cache, null when the ticker is not cached', async () => {
    const account = (await tryLocalRoute('/api/portfolio/accounts', {
      method: 'POST',
      body: { name: 'Brokerage', account_type: 'taxable' },
    })) as { id: string };
    await tryLocalRoute('/api/portfolio/positions', {
      method: 'POST',
      body: { account_id: account.id, ticker: 'VTI', shares: 10, current_price: 330, cost_basis: 3000 },
    });
    await tryLocalRoute('/api/portfolio/positions/cash', {
      method: 'POST',
      body: { account_id: account.id, amount: 1000 },
    });
    clientDB.execute(
      `INSERT OR REPLACE INTO price_cache (ticker, current_price, previous_close, last_updated)
       VALUES ('VTI', 330, 325, ?)`,
      [new Date().toISOString()]
    );

    const data = (await tryLocalRoute('/api/dashboard/data', { method: 'GET' })) as {
      positions: DashboardPositionLike[];
    };
    const vti = data.positions.find((p) => p.ticker === 'VTI');
    const cash = data.positions.find((p) => p.ticker === 'CASH');
    expect(vti).toBeDefined();
    expect(cash).toBeDefined();
    expect(vti?.previous_close).toBe(325);
    expect(cash?.previous_close).toBeNull();
  });
});
