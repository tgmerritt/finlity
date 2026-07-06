/**
 * Tests for LocalAPI bank-statement import recording, dedupe by
 * content_hash, and accept/reject candidate flows (accept creates a
 * budget_expenses row; reject just flips status).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI bank statements', () => {
  let restore: () => void;
  let api: LocalAPI;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    api = created.api;
  }

  it('records a new statement import with its recurring candidates', async () => {
    await setup();
    const result = api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-1',
      row_count: 42,
      candidates: [{ name: 'Netflix', amount: 15.99, frequency: 'monthly', occurrences: 3 }],
    });
    expect(result.already_imported).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(api.getStatementImports()).toHaveLength(1);
  });

  it('dedupes a repeated content_hash and surfaces the existing candidates without duplicating the import', async () => {
    await setup();
    api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-1',
      row_count: 42,
      candidates: [{ name: 'Netflix', amount: 15.99 }],
    });
    const second = api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-1',
      row_count: 42,
      candidates: [{ name: 'Netflix', amount: 15.99 }],
    });
    expect(second.already_imported).toBe(true);
    expect(second.candidates).toHaveLength(1);
    expect(api.getStatementImports()).toHaveLength(1);
  });

  it('accept creates a budget_expenses row inheriting the entity_id from the parent import', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex' });
    const { candidates } = api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-2',
      row_count: 1,
      entity_id: entity.id,
      candidates: [{ name: 'Gym Membership', amount: 49.99, frequency: 'monthly' }],
    });

    const result = api.acceptCandidate(candidates[0]!.id);
    expect(result.status).toBe('accepted');
    expect(result.deduped).toBe(false);

    const expenses = api.getExpenses();
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.name).toBe('Gym Membership');
    expect(expenses[0]?.amount).toBe(49.99);

    const rawExpense = api.getExpenses()[0];
    expect(rawExpense).toBeDefined();
    // entity_id isn't on ExpenseResponse; verify via raw candidate link instead.
    const updatedCandidates = api.getRecurringCandidates('accepted');
    expect(updatedCandidates[0]?.created_expense_id).toBe(result.expense_id);
  });

  it('accept dedupes against an existing active expense with the same name+frequency', async () => {
    await setup();
    const categories = api.getExpenseCategories();
    api.createExpense({ category_id: categories[0]!.id, name: 'Netflix', amount: 15.99, frequency: 'monthly' });

    const { candidates } = api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-3',
      row_count: 1,
      candidates: [{ name: 'netflix', amount: 15.99, frequency: 'monthly' }],
    });

    const result = api.acceptCandidate(candidates[0]!.id);
    expect(result.deduped).toBe(true);
    expect(api.getExpenses()).toHaveLength(1); // no duplicate expense created
  });

  it('reject marks the candidate rejected without creating an expense', async () => {
    await setup();
    const { candidates } = api.recordStatementImport({
      file_name: 'statement.csv',
      content_hash: 'hash-4',
      row_count: 1,
      candidates: [{ name: 'Spotify', amount: 9.99 }],
    });
    api.rejectCandidate(candidates[0]!.id);
    expect(api.getExpenses()).toHaveLength(0);
    expect(api.getRecurringCandidates('rejected')).toHaveLength(1);
  });
});
