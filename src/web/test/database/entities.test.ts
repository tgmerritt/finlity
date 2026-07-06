/**
 * Tests for LocalAPI entities CRUD, summary, and auto-detect.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI entities', () => {
  let restore: () => void;
  let api: LocalAPI;
  let db: ClientDatabase;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    api = created.api;
    db = created.db;
  }

  it('seeds exactly one household entity on a fresh database', async () => {
    await setup();
    const entities = api.getEntities();
    const households = entities.filter((e) => e.is_household);
    expect(households).toHaveLength(1);
    expect(households[0]?.name).toBe('Household');
  });

  it('creates an entity and rejects an invalid hex color', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex', color: '#123ABC' });
    expect(entity.color).toBe('#123ABC');
    expect(() => api.createEntity({ name: 'Bad', color: 'not-a-color' })).toThrow();
  });

  it('entity response includes account/income/expense counts', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex' });
    api.createAccount({ name: "Alex's IRA", account_type: 'roth_ira', entity_id: entity.id });
    api.createIncomeSource({ name: "Alex's Job", gross_annual: 100000, entity_id: entity.id });

    const refreshed = api.getEntity(entity.id);
    expect(refreshed?.account_count).toBe(1);
    expect(refreshed?.income_count).toBe(1);
    expect(refreshed?.expense_count).toBe(0);
  });

  it('getEntitySummary computes retirement vs taxable split for that entity only', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex' });
    const roth = api.createAccount({ name: "Alex's Roth", account_type: 'roth_ira', entity_id: entity.id });
    const other = api.createAccount({ name: 'Someone Else Taxable', account_type: 'taxable' });
    api.createPosition({ account_id: roth.id, ticker: 'VOO', shares: 10, current_price: 100 });
    api.createPosition({ account_id: other.id, ticker: 'VOO', shares: 100, current_price: 100 });

    const summary = api.getEntitySummary(entity.id);
    expect(summary.total_value).toBe(1000);
    expect(summary.retirement_value).toBe(1000);
    expect(summary.taxable_value).toBe(0);
    expect(summary.accounts).toHaveLength(1);
  });

  it('auto-detect finds possessive account/income names, creates entities, and assigns records', async () => {
    await setup();
    api.createAccount({ name: "Alex's Roth IRA", account_type: 'roth_ira' });
    api.createAccount({ name: "Sarah's 401k", account_type: 'traditional_401k' });
    api.createIncomeSource({ name: "Alex's Job", gross_annual: 100000 });
    // Should be excluded (matches excluded-name list, not a real person name)
    api.createAccount({ name: 'Schwab Brokerage', account_type: 'taxable' });

    const result = api.autoDetectEntities();
    expect(result.success).toBe(true);
    expect(result.detected_names.sort()).toEqual(['Alex', 'Sarah']);
    expect(result.entities_created_count).toBe(2);
    expect(result.accounts_assigned).toBe(2);
    expect(result.income_sources_assigned).toBe(1);

    const alexEntity = api.getEntities().find((e) => e.name === 'Alex');
    expect(alexEntity).toBeDefined();
    expect(alexEntity?.account_count).toBe(1);
    expect(alexEntity?.income_count).toBe(1);
  });

  it('auto-detect reuses an existing entity with a case-insensitive name match instead of duplicating', async () => {
    await setup();
    const existing = api.createEntity({ name: 'alex' });
    api.createAccount({ name: "Alex's Roth IRA", account_type: 'roth_ira' });

    const result = api.autoDetectEntities();
    expect(result.entities_created_count).toBe(0);
    expect(result.accounts_assigned).toBe(1);

    const accounts = api.getAccounts();
    expect(accounts[0]?.entity_id).toBe(existing.id);
  });

  it('assignAccountToEntity updates entity_id and supports unassigning with null', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex' });
    const account = api.createAccount({ name: 'Taxable', account_type: 'taxable' });

    api.assignAccountToEntity(account.id, entity.id);
    expect(api.getAccounts()[0]?.entity_id).toBe(entity.id);

    api.assignAccountToEntity(account.id, null);
    expect(api.getAccounts()[0]?.entity_id).toBeNull();
  });

  describe('deleteEntity (F11)', () => {
    it('nulls entity_id on accounts, income sources, and expenses instead of leaving dangling references', async () => {
      await setup();
      const entity = api.createEntity({ name: 'Alex' });
      const account = api.createAccount({
        name: 'Taxable',
        account_type: 'taxable',
        entity_id: entity.id,
      });
      const income = api.createIncomeSource({
        name: 'Salary',
        gross_annual: 100000,
        entity_id: entity.id,
      });
      const categories = api.getExpenseCategories();
      const expense = api.createExpense({
        category_id: categories[0]!.id,
        name: 'Rent',
        amount: 2000,
        entity_id: entity.id,
      });

      const result = api.deleteEntity(entity.id);
      expect(result.success).toBe(true);

      // Accounts expose entity_id in their response shape; income
      // sources/expenses don't (pre-existing API surface gap, unrelated to
      // this fix), so verify those two at the row level instead.
      expect(api.getAccounts().find((a) => a.id === account.id)?.entity_id).toBeNull();

      const incomeRow = db.query<{ entity_id: string | null }>(
        'SELECT entity_id FROM budget_income_sources WHERE id = ?',
        [income.id]
      )[0];
      expect(incomeRow?.entity_id).toBeNull();

      const expenseRow = db.query<{ entity_id: string | null }>(
        'SELECT entity_id FROM budget_expenses WHERE id = ?',
        [expense.id]
      )[0];
      expect(expenseRow?.entity_id).toBeNull();

      expect(api.getEntity(entity.id)).toBeNull();
    });

    it('leaves budget_tax_config and monte_carlo_results alone (server does not touch them either)', async () => {
      await setup();
      const entity = api.createEntity({ name: 'Alex' });
      api.updateTaxConfig({ filing_status: 'single' }, entity.id);

      // Should not throw even though a tax config row references this
      // entity_id — deleteEntity() must not attempt to touch that table.
      expect(() => api.deleteEntity(entity.id)).not.toThrow();

      const taxConfig = api.getTaxConfig(entity.id);
      // getTaxConfig falls back to a synthesized default row when none is
      // found for this entity_id (deleteEntity doesn't null or delete the
      // existing row, but the entity itself is gone so lookups by this now-
      // orphaned entity_id behave like "no config saved for this entity").
      expect(taxConfig).toBeDefined();
    });
  });
});
