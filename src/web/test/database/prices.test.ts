/**
 * Tests for LocalAPI price cache staleness and applyPriceUpdates.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI prices', () => {
  let restore: () => void;
  let db: ClientDatabase;
  let api: LocalAPI;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    db = created.db;
    api = created.api;
  }

  it('treats a ticker with no price_cache entry as stale', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });

    const stale = api.getStaleTickers();
    expect(stale).toContain('AAPL');
  });

  it('applyPriceUpdates refreshes price_cache and positions.current_price, clearing staleness', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });

    api.applyPriceUpdates([{ ticker: 'aapl', price: 150 }]);

    const positions = api.getPositions();
    expect(positions[0]?.current_price).toBe(150);
    expect(api.getStaleTickers()).not.toContain('AAPL');
  });

  it('treats a price_cache entry older than maxAgeHours as stale', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });

    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.execute(
      `INSERT INTO price_cache (ticker, current_price, last_updated) VALUES ('AAPL', 100, ?)`,
      [oldTimestamp]
    );

    expect(api.getStaleTickers(24)).toContain('AAPL');
    expect(api.getStaleTickers(72)).not.toContain('AAPL');
  });

  it('excludes cash/CD/real-estate position types from price-status tracking', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createCashPosition({ account_id: account.id, amount: 5000 });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });

    const status = api.getPriceStatus();
    expect(status.total_tickers).toBe(1); // only AAPL, not CASH
  });

  it('getPriceStatus reports all_fresh true only when every ticker is within maxAgeHours', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'AAPL', shares: 10 });

    let status = api.getPriceStatus();
    expect(status.all_fresh).toBe(false);

    api.applyPriceUpdates([{ ticker: 'AAPL', price: 150 }]);
    status = api.getPriceStatus();
    expect(status.all_fresh).toBe(true);
    expect(status.fresh_tickers).toBe(1);
    expect(status.stale_tickers).toBe(0);
  });

  it('applyPriceUpdates leaves real estate rows unchanged', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    db.execute(
      `INSERT INTO positions (id, account_id, ticker, shares, current_price, position_type) VALUES
       ('z-eq', ?, 'ZHOME', 1, 10, 'equity'),
       ('z-re', ?, 'ZHOME', 1, 500000, 'real_estate'),
       ('re-untyped', ?, 'RE', 1, 90000, NULL)`,
      [account.id, account.id, account.id]
    );
    const estate = (): unknown[] =>
      db.query("SELECT * FROM positions WHERE id IN ('z-re', 're-untyped') ORDER BY id");
    const before = estate();

    api.applyPriceUpdates([
      { ticker: 'zhome', price: 12.5 },
      { ticker: 'RE', price: 1 },
    ]);

    expect(estate()).toEqual(before);
    expect(
      db.query<{ current_price: number }>(
        "SELECT current_price FROM positions WHERE id = 'z-eq'"
      )[0]?.current_price
    ).toBe(12.5);
  });
});
