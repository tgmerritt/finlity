/**
 * LocalAPI smart import undo (browser path). Ports tests/api/test_smart_import_undo.py,
 * including the manual balance cases through LocalAPI.recordLiabilityBalance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmartImportHttpError } from '@/database/local-smart-import';
import {
  D1,
  D2,
  HASH_A,
  HASH_B,
  HASH_C,
  addExpense,
  addLiability,
  applyBody,
  candidate,
  count,
  setup,
  statement,
  tableHashes,
  teardown,
  txn,
  type Env,
  type Row,
} from './smart-import-support';

let env: Env;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => teardown(env));

const CLOSING = { amount: 321.5, as_of: '2026-09-30' };
const apply = (body: unknown): Row => env.api.applySmartImport(body) as unknown as Row;
const undo = (id: string): Row => env.api.undoSmartImport(id) as unknown as Row;
const one = (sql: string, params: unknown[] = []): Row => env.db.query<Row>(sql, params)[0] as Row;
const seed = (): void => {
  addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
  addExpense(env.db, 'E-link', 'Spotify', 10);
};
const later = (): void => vi.setSystemTime(new Date(Date.now() + 2000));

function expectError(fn: () => unknown, status: number, errorType: string): SmartImportHttpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SmartImportHttpError);
    expect((e as SmartImportHttpError).status).toBe(status);
    expect((e as SmartImportHttpError).errorType).toBe(errorType);
    return e as SmartImportHttpError;
  }
  throw new Error(`expected ${status} ${errorType}`);
}

function applied(
  o: { withCard?: boolean; recurring?: string[]; fileHash?: string; batch?: string } = {}
): [string, string | null] {
  const withCard = o.withCard ?? true;
  const fileHash = o.fileHash ?? HASH_A;
  const st = statement(
    fileHash,
    [txn(D1, -15.49), txn(D2, -9, 'GROCER', { category_id: 'cat-Groceries' })],
    {
      kind: 'credit_card',
      liabilityId: withCard ? 'L1' : null,
      closing: withCard ? CLOSING : null,
    }
  );
  const rec: Row[] = [];
  const kinds = o.recurring ?? ['create'];
  if (kinds.includes('create')) rec.push(candidate('create', 'NETFLIX', { fileHash }));
  if (kinds.includes('link'))
    rec.push(candidate('link', 'SPOTIFY', { name: 'Spotify', expenseId: 'E-link', fileHash }));
  if (kinds.includes('reject')) rec.push(candidate('reject', 'GYM', { name: 'Gym', fileHash }));
  const out = apply(
    applyBody([st], {
      rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }],
      recurring: rec,
      batch: o.batch ?? 'b1',
    })
  );
  const importId = out.imports[0].import_id as string;
  const cand = env.db.query<Row>(
    "SELECT created_expense_id FROM recurring_candidates WHERE import_id = ? AND status = 'accepted' AND name = 'Netflix'",
    [importId]
  )[0];
  return [importId, cand ? cand.created_expense_id : null];
}

describe('undo', () => {
  it('removes everything the import created', () => {
    seed();
    const baseline = tableHashes(env.db);
    const [importId, expenseId] = applied({ recurring: ['create', 'link', 'reject'] });
    expect(expenseId).toBeTruthy();
    expect(undo(importId)).toEqual({
      undone: true,
      kept: [],
      reassigned: { transactions: 0 },
      deleted: { transactions: 2, recurring_candidates: 3, expenses: 1, snapshots: 1 },
    });
    for (const t of [
      'import_transactions',
      'recurring_candidates',
      'smart_import_ledger',
      'smart_import_meta',
      'bank_statement_imports',
    ]) {
      expect(count(env.db, t)).toBe(0);
    }
    expect(count(env.db, 'budget_expenses', 'id = ?', [expenseId])).toBe(0);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([500, '2026-09-01']);
    expect(count(env.db, 'merchant_rules')).toBe(1);
    expect(count(env.db, 'budget_expenses', "id = 'E-link'")).toBe(1);
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
    const after = tableHashes(env.db);
    expect(after.budget_expenses).toBe(baseline.budget_expenses);
    expect(after.liability_balance_snapshots).toBe(baseline.liability_balance_snapshots);
    expectError(() => undo(importId), 404, 'import_not_found');
  });

  it('keeps an edited expense', () => {
    seed();
    const [importId, expenseId] = applied();
    env.db.execute('UPDATE budget_expenses SET amount = 19.99 WHERE id = ?', [expenseId]);
    const out = undo(importId);
    expect(out.kept).toEqual([{ table: 'budget_expenses', id: expenseId, reason: 'edited' }]);
    expect(out.deleted.expenses).toBe(0);
    expect(one('SELECT amount FROM budget_expenses WHERE id = ?', [expenseId]).amount).toBe(19.99);
    expect(count(env.db, 'recurring_candidates')).toBe(0);
  });

  it.each([
    ['name', 'Netflix HD'],
    ['frequency', 'annual'],
    ['category_id', 'cat-Other'],
    ['is_active', 0],
    ['entity_id', 'ent-9'],
    ['start_date', '2026-01-01'],
    ['end_date', '2027-01-01'],
    ['is_pretax', 1],
    ['is_mortgage', 1],
    ['principal_portion', 5],
    ['interest_portion', 2],
  ])('keeps an expense edited in %s', (field, value) => {
    seed();
    const [importId, expenseId] = applied();
    env.db.execute(`UPDATE budget_expenses SET ${field} = ? WHERE id = ?`, [value, expenseId]);
    expect(undo(importId).kept).toEqual([
      { table: 'budget_expenses', id: expenseId, reason: 'edited' },
    ]);
  });

  it('keeps an expense touched with no visible change (updated_at differs)', () => {
    seed();
    const [importId, expenseId] = applied();
    env.db.execute("UPDATE budget_expenses SET updated_at = '2030-01-01 00:00:00' WHERE id = ?", [
      expenseId,
    ]);
    expect(undo(importId).kept[0]!.reason).toBe('edited');
  });

  it('does not call an unchanged expense edited', () => {
    seed();
    const [importId] = applied();
    expect(undo(importId).kept).toEqual([]);
  });

  it('keeps an expense a debt now links', () => {
    seed();
    addLiability(env.db, 'L2', { name: 'Car loan', type: 'auto_loan' });
    const [importId, expenseId] = applied();
    env.db.execute('UPDATE liabilities SET expense_id = ? WHERE id = ?', [expenseId, 'L2']);
    expect(undo(importId).kept).toEqual([
      { table: 'budget_expenses', id: expenseId, reason: 'linked_to_debt' },
    ]);
    expect(count(env.db, 'budget_expenses', 'id = ?', [expenseId])).toBe(1);
  });

  it('keeps an expense another import links', () => {
    seed();
    const [first, expenseId] = applied();
    const st = statement(HASH_B, [txn(D1, -1, 'N', { dedupe_key: 'o1' })]);
    apply(
      applyBody([st], {
        recurring: [candidate('link', 'NETFLIX', { expenseId: expenseId!, fileHash: HASH_B })],
        batch: 'b2',
      })
    );
    expect(undo(first).kept).toEqual([
      { table: 'budget_expenses', id: expenseId, reason: 'used_by_other_import' },
    ]);
  });

  it('skips a created expense the user already deleted', () => {
    seed();
    const [importId, expenseId] = applied();
    env.db.execute('DELETE FROM budget_expenses WHERE id = ?', [expenseId]);
    const out = undo(importId);
    expect([out.kept, out.deleted.expenses]).toEqual([[], 0]);
  });

  it('never touches a linked expense even if edited', () => {
    seed();
    const [importId] = applied({ recurring: ['link'] });
    env.db.execute("UPDATE budget_expenses SET amount = 99 WHERE id = 'E-link'");
    expect(undo(importId).kept).toEqual([]);
    expect(one("SELECT amount FROM budget_expenses WHERE id = 'E-link'").amount).toBe(99);
  });
});

describe('undo and liability balances', () => {
  it('keeps a later manual balance', () => {
    seed();
    const [importId] = applied();
    env.api.recordLiabilityBalance('L1', { balance: 250, as_of: '2026-10-02' });
    undo(importId);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([250, '2026-10-02']);
    const sources = new Set(
      env.db.query<Row>('SELECT source FROM liability_balance_snapshots').map((r) => r.source)
    );
    expect([...sources]).toEqual(['manual']);
  });

  it('recomputes from the newest remaining snapshot', () => {
    seed();
    env.api.recordLiabilityBalance('L1', { balance: 480, as_of: '2026-09-10' });
    const [importId] = applied();
    undo(importId);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([480, '2026-09-10']);
  });

  it('keeps a snapshot the user overwrote on the same day', () => {
    seed();
    const [importId] = applied();
    env.api.recordLiabilityBalance('L1', { balance: 300, as_of: '2026-09-30' });
    const snap = one(
      "SELECT id FROM liability_balance_snapshots WHERE snapshot_date = '2026-09-30'"
    );
    const out = undo(importId);
    expect(out.kept).toEqual([
      { table: 'liability_balance_snapshots', id: snap.id, reason: 'edited' },
    ]);
    expect(out.deleted.snapshots).toBe(0);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([300, '2026-09-30']);
  });

  it('restores from the ledger when no snapshot remains', () => {
    seed();
    env.db.execute('DELETE FROM liability_balance_snapshots');
    const [importId] = applied();
    undo(importId);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([500, '2026-09-01']);
  });

  it('is fine when the liability was deleted', () => {
    seed();
    const [importId] = applied();
    env.db.execute('DELETE FROM liability_balance_snapshots');
    env.db.execute('DELETE FROM liabilities');
    expect(undo(importId).undone).toBe(true);
  });

  it('handles a manual balance on an older day after the import', () => {
    seed();
    const [importId] = applied();
    env.api.recordLiabilityBalance('L1', { balance: 410, as_of: '2026-09-15' });
    const mid = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([mid.current_balance, mid.balance_as_of]).toEqual([321.5, '2026-09-30']);
    undo(importId);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([410, '2026-09-15']);
  });

  it('only changes updated_at when a value changes', () => {
    seed();
    const [importId] = applied();
    env.api.recordLiabilityBalance('L1', { balance: 250, as_of: '2026-10-02' });
    const stamp = one("SELECT updated_at FROM liabilities WHERE id = 'L1'").updated_at;
    later();
    undo(importId);
    expect(one("SELECT updated_at FROM liabilities WHERE id = 'L1'").updated_at).toBe(stamp);
  });
});

describe('undo scope and errors', () => {
  it('only removes that import rows', () => {
    seed();
    const [first] = applied({ recurring: [] });
    const second = apply(
      applyBody([statement(HASH_B, [txn(D1, -1, 'N', { dedupe_key: 'x1' })])], { batch: 'b2' })
    ).imports[0].import_id;
    undo(first);
    expect(
      env.db.query<Row>('SELECT import_id FROM import_transactions').map((r) => r.import_id)
    ).toEqual([second]);
    expect(one('SELECT import_id FROM smart_import_meta').import_id).toBe(second);
  });

  it('answers 404 not_smart_import for a legacy import and import_not_found for unknown or undone', () => {
    seed();
    const [done] = applied();
    undo(done);
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('legacy', 'o.csv', 'h', 'analyzed')"
    );
    const before = tableHashes(env.db);
    const legacy = expectError(() => undo('legacy'), 404, 'not_smart_import');
    expect(legacy.body()).toEqual({
      error_type: 'not_smart_import',
      detail: 'This is not a smart import.',
    });
    for (const id of ['nope', done]) {
      const e = expectError(() => undo(id), 404, 'import_not_found');
      expect(e.body()).toEqual({
        error_type: 'import_not_found',
        detail: 'Import not found. It may have already been undone.',
      });
    }
    expect(tableHashes(env.db)).toEqual(before);
  });

  it('changes nothing when undo fails midway', () => {
    seed();
    const [importId] = applied();
    const before = tableHashes(env.db);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = env.db.execute.bind(env.db);
    vi.spyOn(env.db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.startsWith('DELETE FROM smart_import_meta')) throw new Error('leak ZQXSECRET');
      return real(sql, params);
    });
    const e = expectError(() => undo(importId), 500, 'save_failed');
    expect(e.body()).toEqual({
      error_type: 'save_failed',
      detail: 'The change could not be saved.',
    });
    vi.restoreAllMocks();
    expect(spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toContain(
      'ZQXSECRET'
    );
    expect(tableHashes(env.db)).toEqual(before);
    expect(undo(importId).undone).toBe(true);
  });

  it('undo then re-apply imports normally', () => {
    seed();
    const [importId] = applied();
    undo(importId);
    const again = apply(applyBody([statement(HASH_A, [txn(D1, -15.49)])]));
    expect(again.skipped_files).toEqual([]);
    expect(again.imports[0].txn_new).toBe(1);
  });

  it('works after the transactions were deleted or pruned', () => {
    seed();
    const [importId] = applied();
    env.api.deleteSmartImportTransactions();
    const out = undo(importId);
    expect([out.deleted.transactions, out.deleted.expenses]).toEqual([0, 1]);
    const [other] = applied({ fileHash: HASH_B, recurring: [], batch: 'b2' });
    env.db.execute('DELETE FROM import_transactions');
    expect(undo(other).undone).toBe(true);
    expect([count(env.db, 'smart_import_ledger'), count(env.db, 'smart_import_meta')]).toEqual([
      0, 0,
    ]);
  });
});

describe('overlapping imports (claimed rows)', () => {
  function overlap(): [string, string] {
    const a = statement(HASH_A, [
      txn(D1, -1, 'M1', { dedupe_key: 'k1' }),
      txn(D1, -2, 'M2', { dedupe_key: 'k2' }),
      txn(D2, -3, 'M3', { dedupe_key: 'k3' }),
    ]);
    const b = statement(HASH_B, [
      txn(D1, -2, 'M2', { dedupe_key: 'k2' }),
      txn(D2, -3, 'M3', { dedupe_key: 'k3' }),
      txn(D2, -4, 'M4', { dedupe_key: 'k4' }),
    ]);
    const ia = apply(applyBody([a])).imports[0];
    later();
    const ib = apply(applyBody([b], { batch: 'b2' })).imports[0];
    expect([ib.txn_new, ib.txn_duplicate]).toEqual([1, 2]);
    return [ia.import_id, ib.import_id];
  }
  const owners = (): Record<string, string> =>
    Object.fromEntries(
      env.db
        .query<Row>('SELECT dedupe_key, import_id FROM import_transactions')
        .map((r) => [r.dedupe_key, r.import_id])
    );
  const claims = (): string[] =>
    env.db
      .query<Row>("SELECT import_id, target_id FROM smart_import_ledger WHERE action = 'claimed'")
      .map((r) => `${r.import_id}|${r.target_id}`)
      .sort();
  const rowId = (key: string): string =>
    one('SELECT id FROM import_transactions WHERE dedupe_key = ?', [key]).id;

  it('ledgers a claim for each overlapping row', () => {
    const [, ib] = overlap();
    const rows = env.db.query<Row>("SELECT * FROM smart_import_ledger WHERE action = 'claimed'");
    expect(rows.map((r) => r.target_id).sort()).toEqual([rowId('k2'), rowId('k3')].sort());
    expect(
      rows.every(
        (r) =>
          r.import_id === ib && r.target_table === 'import_transactions' && r.before_json === null
      )
    ).toBe(true);
    expect(rows.map((r) => JSON.parse(r.after_json).dedupe_key).sort()).toEqual(['k2', 'k3']);
  });

  it('hands overlapping rows to the second import when the first is undone', () => {
    const [ia, ib] = overlap();
    const summary = (): number =>
      (env.api.getSpendingSummary(1, null) as unknown as Row).totals.actual_monthly;
    expect(summary()).toBe(10);
    const out = undo(ia);
    expect(out.deleted.transactions).toBe(1);
    expect(out.reassigned).toEqual({ transactions: 2 });
    expect(owners()).toEqual({ k2: ib, k3: ib, k4: ib });
    expect(claims()).toEqual([]);
    const meta = one('SELECT * FROM smart_import_meta WHERE import_id = ?', [ib]);
    expect([meta.txn_new, meta.txn_duplicate]).toEqual([3, 0]);
    expect(one('SELECT row_count FROM bank_statement_imports WHERE id = ?', [ib]).row_count).toBe(
      3
    );
    expect(summary()).toBe(9);
  });

  it('undoing the second then the first deletes everything', () => {
    const [ia, ib] = overlap();
    const out = undo(ib);
    expect([out.deleted.transactions, out.reassigned]).toEqual([1, { transactions: 0 }]);
    expect(owners()).toEqual({ k1: ia, k2: ia, k3: ia });
    expect(claims()).toEqual([]);
    expect(undo(ia).deleted.transactions).toBe(3);
    expect(owners()).toEqual({});
  });

  it('hands over to the newest claimer, then the next', () => {
    const [ia, ib] = overlap();
    later();
    const c = statement(HASH_C, [txn(D1, -2, 'M2', { dedupe_key: 'k2' })]);
    const ic = apply(applyBody([c], { batch: 'b3' })).imports[0].import_id;
    undo(ia);
    expect(owners().k2).toBe(ic);
    expect(owners().k3).toBe(ib);
    expect(claims()).toEqual([`${ib}|${rowId('k2')}`]);
    undo(ic);
    expect(owners().k2).toBe(ib);
    expect(claims()).toEqual([]);
    undo(ib);
    expect(owners()).toEqual({});
  });

  it('hands over to the newest claimer even when created_at ties (rowid breaks the tie)', () => {
    const [ia] = overlap();
    const c = statement(HASH_C, [txn(D1, -2, 'M2', { dedupe_key: 'k2' })]);
    const ic = apply(applyBody([c], { batch: 'b3' })).imports[0].import_id;
    undo(ia);
    expect(owners().k2).toBe(ic);
  });

  it('re-applying the first file after undoing it', () => {
    const [ia, ib] = overlap();
    undo(ia);
    later();
    const a = statement(HASH_A, [
      txn(D1, -1, 'M1', { dedupe_key: 'k1' }),
      txn(D1, -2, 'M2', { dedupe_key: 'k2' }),
      txn(D2, -3, 'M3', { dedupe_key: 'k3' }),
    ]);
    const again = apply(applyBody([a], { batch: 'b4' }));
    expect(again.skipped_files).toEqual([]);
    const imp = again.imports[0];
    expect([imp.txn_new, imp.txn_duplicate]).toEqual([1, 2]);
    expect(owners().k1).toBe(imp.import_id);
    expect(owners().k2).toBe(ib);
    undo(ib);
    expect(owners()).toEqual({ k1: imp.import_id, k2: imp.import_id, k3: imp.import_id });
  });

  it('claims between statements of one request but not within one statement', () => {
    const a = statement(HASH_A, [
      txn(D1, -1, 'N', { dedupe_key: 'k1' }),
      txn(D1, -1, 'N', { dedupe_key: 'k1' }),
    ]);
    const b = statement(HASH_B, [txn(D1, -1, 'N', { dedupe_key: 'k1' })], { key: 'acct:two' });
    const out = apply(applyBody([a, b])).imports;
    expect([out[0].txn_new, out[0].txn_duplicate]).toEqual([1, 1]);
    expect(claims()).toEqual([`${out[1].import_id}|${rowId('k1')}`]);
    undo(out[0].import_id);
    expect(owners()).toEqual({ k1: out[1].import_id });
  });
});
