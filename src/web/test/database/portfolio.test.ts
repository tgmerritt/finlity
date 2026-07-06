/**
 * Tests for LocalAPI portfolio methods: accounts, positions, market value,
 * duplicates, and snapshot retirement/taxable split.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI portfolio', () => {
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

  it('creates and lists accounts with computed value/position_count', async () => {
    await setup();
    const account = api.createAccount({ name: 'Schwab Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'aapl', shares: 10, current_price: 20, cost_basis: 100 });

    const accounts = api.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.value).toBe(200);
    expect(accounts[0]?.position_count).toBe(1);
    expect(accounts[0]?.cost_basis).toBe(100);
    // ticker was upper-cased on insert
    expect(api.getPositions()[0]?.ticker).toBe('AAPL');
  });

  it('infers retirement status from account_type when is_retirement not explicitly set', async () => {
    await setup();
    const roth = api.createAccount({ name: 'Roth IRA', account_type: 'roth_ira' });
    const taxable = api.createAccount({ name: 'Brokerage', account_type: 'taxable' });
    expect(roth.is_retirement).toBe(true);
    expect(taxable.is_retirement).toBe(false);
  });

  it('deleteAccount cascades to its positions', async () => {
    await setup();
    const account = api.createAccount({ name: 'Test', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'MSFT', shares: 5 });
    api.deleteAccount(account.id);
    expect(api.getPositions()).toHaveLength(0);
    expect(api.getAccounts()).toHaveLength(0);
  });

  it('computes market_value with contract_multiplier for options-style positions', async () => {
    await setup();
    const account = api.createAccount({ name: 'Options', account_type: 'taxable' });
    db.execute(
      `INSERT INTO positions (id, account_id, ticker, shares, current_price, position_type, contract_multiplier)
       VALUES ('opt-1', ?, 'GOOG', 2, 5, 'option', 100)`,
      [account.id]
    );
    const positions = api.getPositions();
    const opt = positions.find((p) => p.id === 'opt-1');
    expect(opt?.market_value).toBe(1000); // 2 shares * 5 price * 100 multiplier
    expect(opt?.contracts).toBe(2);
    expect(opt?.premium).toBe(5);
  });

  it('computes accrued value for CD positions using simple interest', async () => {
    await setup();
    const account = api.createAccount({ name: 'CDs', account_type: 'taxable' });
    const purchaseDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago
    api.createCDPosition({
      account_id: account.id,
      amount: 1000,
      name: 'CD 1',
      interest_rate: 0.05,
      maturity_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      purchase_date: purchaseDate,
    });
    const positions = api.getPositions();
    const cd = positions.find((p) => p.ticker === 'CD');
    // ~1000 * (1 + 0.05 * 1) = ~1050
    expect(cd?.market_value).toBeGreaterThan(1040);
    expect(cd?.market_value).toBeLessThan(1060);
  });

  it('flags exact-quantity duplicate positions across different accounts only', async () => {
    await setup();
    const a1 = api.createAccount({ name: 'Account 1', account_type: 'taxable' });
    const a2 = api.createAccount({ name: 'Account 2', account_type: 'taxable' });
    api.createPosition({ account_id: a1.id, ticker: 'VTI', shares: 12.345678 });
    api.createPosition({ account_id: a2.id, ticker: 'VTI', shares: 12.345678 });
    // Same account, same ticker/shares should NOT count (would violate the (account_id,ticker)
    // uniqueness assumption elsewhere, but duplicates() itself only checks cross-account spread).
    api.createPosition({ account_id: a1.id, ticker: 'BND', shares: 5 });

    const result = api.getDuplicates();
    expect(result.has_duplicates).toBe(true);
    expect(result.count).toBe(1);
    expect(result.duplicates[0]?.ticker).toBe('VTI');
    expect(result.duplicates[0]?.positions).toHaveLength(2);
  });

  it('does not flag positions with the same ticker in only one account', async () => {
    await setup();
    const a1 = api.createAccount({ name: 'Account 1', account_type: 'taxable' });
    db.execute(`INSERT INTO positions (id, account_id, ticker, shares) VALUES ('p1', ?, 'VTI', 10)`, [a1.id]);
    db.execute(`INSERT INTO positions (id, account_id, ticker, shares) VALUES ('p2', ?, 'VTI', 10)`, [a1.id]);
    const result = api.getDuplicates();
    expect(result.has_duplicates).toBe(false);
  });

  it('takeSnapshot splits totals into retirement vs taxable based on account type', async () => {
    await setup();
    const roth = api.createAccount({ name: 'Roth', account_type: 'roth_ira' });
    const taxable = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: roth.id, ticker: 'VOO', shares: 10, current_price: 100 });
    api.createPosition({ account_id: taxable.id, ticker: 'VOO', shares: 5, current_price: 100 });

    const result = api.takeSnapshot();
    expect(result.total_value).toBe(1500);

    const snapshots = api.getSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.retirement_value).toBe(1000);
    expect(snapshots[0]?.taxable_value).toBe(500);
  });

  it('takeSnapshot upserts by date instead of creating duplicate rows', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'VOO', shares: 10, current_price: 100 });

    api.takeSnapshot();
    api.createPosition({ account_id: account.id, ticker: 'VOO2', shares: 1, current_price: 500 });
    api.takeSnapshot();

    const snapshots = api.getSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.total_value).toBe(1500);
  });

  it('getHistory returns ascending-date points derived from snapshots', async () => {
    await setup();
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: account.id, ticker: 'VOO', shares: 10, current_price: 100 });
    api.takeSnapshot();

    const history = api.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.total).toBe(1000);
  });

  it('exportCsv(accounts) returns a header row plus one row per account', async () => {
    await setup();
    api.createAccount({ name: 'Taxable', account_type: 'taxable' });
    const csv = api.exportCsv('accounts');
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,name,account_type');
    expect(lines).toHaveLength(2);
  });
});
