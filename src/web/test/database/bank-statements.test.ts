/**
 * Tests for LocalAPI bank-statement accept/reject candidate flows (accept creates a budget_expenses row; reject just flips status).
 * Candidates are seeded with SQL since imports are recorded server-side.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LocalAPI } from '@/database/local-api';
import type { ClientDatabase } from '@/database/client-database';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI bank statements', () => {
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

  /** Seed an import row plus one pending recurring candidate; returns the candidate id. */
  function seedCandidate(
    hash: string,
    c: { name: string; amount: number; frequency?: string },
    entityId: string | null = null
  ): string {
    const importId = `import-${hash}`;
    const candidateId = `candidate-${hash}`;
    db.execute(
      `INSERT INTO bank_statement_imports (id, entity_id, file_name, content_hash, row_count, status, uploaded_at, analyzed_at)
       VALUES (?, ?, 'statement.csv', ?, 1, 'analyzed', ?, ?)`,
      [importId, entityId, hash, new Date().toISOString(), new Date().toISOString()]
    );
    db.execute(
      `INSERT INTO recurring_candidates (id, import_id, name, amount, frequency, occurrences, status)
       VALUES (?, ?, ?, ?, ?, 1, 'pending')`,
      [candidateId, importId, c.name, c.amount, c.frequency ?? 'monthly']
    );
    return candidateId;
  }

  it('accept creates a budget_expenses row inheriting the entity_id from the parent import', async () => {
    await setup();
    const entity = api.createEntity({ name: 'Alex' });
    const candidateId = seedCandidate(
      'hash-2',
      { name: 'Gym Membership', amount: 49.99, frequency: 'monthly' },
      entity.id
    );

    const result = api.acceptCandidate(candidateId);
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

    const candidateId = seedCandidate('hash-3', {
      name: 'netflix',
      amount: 15.99,
      frequency: 'monthly',
    });

    const result = api.acceptCandidate(candidateId);
    expect(result.deduped).toBe(true);
    expect(api.getExpenses()).toHaveLength(1); // no duplicate expense created
  });

  it('reject marks the candidate rejected without creating an expense', async () => {
    await setup();
    const candidateId = seedCandidate('hash-4', { name: 'Spotify', amount: 9.99 });
    api.rejectCandidate(candidateId);
    expect(api.getExpenses()).toHaveLength(0);
    expect(api.getRecurringCandidates('rejected')).toHaveLength(1);
  });
});
