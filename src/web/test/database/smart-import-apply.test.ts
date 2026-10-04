/**
 * LocalAPI smart import apply, transactions delete and spending summary
 * (browser path). Ports tests/api/test_smart_import_apply.py. There is no demo
 * protection in the browser, so its 403 cases have no twin here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmartImportHttpError } from '@/database/local-smart-import';
import {
  CONN_ID,
  D1,
  D2,
  D3,
  HASH_A,
  HASH_B,
  HASH_C,
  TODAY,
  addConnection,
  addConnections,
  addExpense,
  addLiability,
  applyBody,
  basic,
  candidate,
  connectionEntry,
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

const apply = (body: unknown): Row => env.api.applySmartImport(body) as unknown as Row;
const one = (sql: string, params: unknown[] = []): Row => env.db.query<Row>(sql, params)[0] as Row;

function expectError(fn: () => unknown, status: number, errorType: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SmartImportHttpError);
    expect((e as SmartImportHttpError).status).toBe(status);
    expect((e as SmartImportHttpError).errorType).toBe(errorType);
    return;
  }
  throw new Error(`expected ${status} ${errorType}`);
}

describe('apply', () => {
  it('writes the import, meta and transactions', () => {
    const body = apply(applyBody([basic()], { entityId: 'ent-1' }));
    expect(body.skipped_files).toEqual([]);
    expect(body.pruned).toBe(0);
    expect([body.rules_saved, body.expenses_created, body.expenses_linked]).toEqual([0, 0, 0]);
    const [imp] = body.imports;
    expect(imp.file_hash).toBe(HASH_A);
    expect(imp.balance).toBe('none');
    expect([imp.txn_new, imp.txn_duplicate, imp.txn_excluded]).toEqual([3, 0, 1]);
    const bsi = one('SELECT * FROM bank_statement_imports WHERE id = ?', [imp.import_id]);
    expect([bsi.content_hash, bsi.status, bsi.row_count, bsi.file_name, bsi.entity_id]).toEqual([
      HASH_A,
      'applied',
      3,
      'statement.csv',
      'ent-1',
    ]);
    expect(bsi.analyzed_at).toBeTruthy();
    const meta = one('SELECT * FROM smart_import_meta WHERE import_id = ?', [imp.import_id]);
    expect([meta.batch_id, meta.origin, meta.format, meta.parser]).toEqual([
      'batch-1',
      'file',
      'csv',
      'csv',
    ]);
    expect([
      meta.account_kind,
      meta.account_key,
      meta.account_label,
      meta.account_last4,
      meta.institution,
    ]).toEqual(['checking', 'acct:one', 'Main', '1234', 'Sample Bank']);
    expect([meta.txn_new, meta.txn_duplicate, meta.txn_excluded, meta.ai_used]).toEqual([
      3, 0, 1, 0,
    ]);
    const rows = env.db.query<Row>(
      'SELECT * FROM import_transactions ORDER BY posted_date, merchant_key'
    );
    expect(rows.map((r) => r.merchant_key)).toEqual(['NETFLIX', 'GROCER', 'PAYROLL']);
    expect(
      rows.every(
        (r) =>
          r.entity_id === 'ent-1' && r.import_id === imp.import_id && r.account_key === 'acct:one'
      )
    ).toBe(true);
    expect([
      rows[0].amount,
      rows[0].category_id,
      rows[0].category_source,
      rows[0].posted_date,
    ]).toEqual([-15.49, 'cat-Dining', 'rule', D1]);
  });

  it('stores AI fields, the period and the closing balance columns', () => {
    const st = statement(HASH_A, [txn(D1, -1)], {
      period: { start: '2026-09-01', end: '2026-09-30' },
      closing: { amount: 321.5, as_of: '2026-09-30' },
      ai_used: true,
      ai_provider: 'Claude',
    });
    const imp = apply(applyBody([st])).imports[0];
    const m = one('SELECT * FROM smart_import_meta WHERE import_id = ?', [imp.import_id]);
    expect([m.ai_used, m.ai_provider]).toEqual([1, 'Claude']);
    expect([m.period_start, m.period_end]).toEqual(['2026-09-01', '2026-09-30']);
    expect([m.closing_balance, m.closing_balance_date]).toEqual([321.5, '2026-09-30']);
  });

  it('truncates stored text', () => {
    const longKey = String.fromCharCode(0xfc).repeat(150);
    const st = statement(HASH_A, [txn(D1, -1, longKey, { description: 'd'.repeat(500) })]);
    (st.account as Row).last4 = '98761234';
    st.file_name = 'f'.repeat(400);
    apply(applyBody([st], { rules: [{ merchant_key: longKey, kind: 'expense' }] }));
    const t = one('SELECT * FROM import_transactions');
    expect(t.merchant_key).toHaveLength(120);
    expect(t.description).toHaveLength(120);
    expect(one('SELECT account_last4 FROM smart_import_meta').account_last4).toBe('1234');
    expect(one('SELECT merchant_key FROM merchant_rules').merchant_key).toHaveLength(120);
    expect(one('SELECT file_name FROM bank_statement_imports').file_name).toHaveLength(255);
  });

  it('gives two statements of one file separate imports and indexed hashes', () => {
    const a = statement(HASH_A, [txn(D1, -1, 'NETFLIX', { dedupe_key: 'k1' })]);
    const b = statement(HASH_A, [txn(D2, -2, 'NETFLIX', { dedupe_key: 'k2' })], {
      key: 'acct:two',
    });
    expect(apply(applyBody([a, b])).imports).toHaveLength(2);
    const hashes = env.db
      .query<Row>('SELECT content_hash FROM bank_statement_imports')
      .map((r) => r.content_hash)
      .sort();
    expect(hashes).toEqual([HASH_A, `${HASH_A}:1`]);
  });

  it('counts a repeated dedupe key in one request as one duplicate', () => {
    const st = statement(HASH_A, [
      txn(D1, -1, 'N', { dedupe_key: 'same' }),
      txn(D1, -1, 'N', { dedupe_key: 'same' }),
    ]);
    const imp = apply(applyBody([st])).imports[0];
    expect([imp.txn_new, imp.txn_duplicate]).toEqual([1, 1]);
  });

  it('writes nothing when the same batch is applied again', () => {
    const body = applyBody([basic(HASH_A), basic(HASH_B)], {
      rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }],
      recurring: [candidate('create')],
    });
    const first = apply(body);
    expect(first.imports[1].txn_duplicate).toBe(3);
    const before = tableHashes(env.db);
    const again = apply(body);
    expect(again.imports).toEqual([]);
    expect(again.skipped_files).toEqual([HASH_A, HASH_B]);
    expect([again.rules_saved, again.expenses_created, again.pruned]).toEqual([0, 0, 0]);
    expect(tableHashes(env.db)).toEqual(before);
  });

  it('adds only the new rows of an overlapping statement', () => {
    apply(applyBody([basic(HASH_A)]));
    const more = statement(HASH_B, [txn(D1, -15.49, 'NETFLIX'), txn('2026-09-20', -5, 'NEW')]);
    const imp = apply(applyBody([more], { batch: 'batch-2' })).imports[0];
    expect([imp.txn_new, imp.txn_duplicate]).toEqual([1, 1]);
    expect(count(env.db, 'import_transactions')).toBe(4);
  });

  it('skips a file hash known from a legacy import', () => {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('legacy', 'o.csv', ?, 'analyzed')",
      [HASH_A]
    );
    const body = apply(applyBody([basic(HASH_A)]));
    expect(body.skipped_files).toEqual([HASH_A]);
    expect(body.imports).toEqual([]);
    expect(count(env.db, 'import_transactions')).toBe(0);
  });

  it('reports a hash with a new later statement only in imports', () => {
    const two = [
      statement(HASH_A, [txn(D1, -1, 'N', { dedupe_key: 'p1' })]),
      statement(HASH_A, [txn(D2, -2, 'N', { dedupe_key: 'p2' })], { key: 'acct:two' }),
    ];
    expect(apply(applyBody(two)).imports).toHaveLength(2);
    const three = [
      ...two,
      statement(HASH_A, [txn(D3, -3, 'N', { dedupe_key: 'p3' })], { key: 'acct:three' }),
    ];
    const out = apply(applyBody(three, { batch: 'b2' }));
    expect(out.imports.map((i: Row) => i.file_hash)).toEqual([HASH_A]);
    expect(out.skipped_files).toEqual([]);
    const hashes = env.db
      .query<Row>('SELECT content_hash FROM bank_statement_imports ORDER BY content_hash')
      .map((r) => r.content_hash);
    expect(hashes).toEqual([HASH_A, `${HASH_A}:1`, `${HASH_A}:2`]);
  });

  it('orders the imports of one batch newest first by insertion, not by id', () => {
    // Ids that sort opposite to creation order: an id tie-break would list the first import first.
    let n = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () =>
        `id-${String(999 - ++n).padStart(3, '0')}` as `${string}-${string}-${string}-${string}-${string}`
    );
    const card = statement(HASH_A, [txn(D1, -5, 'BOOKSHOP', { dedupe_key: 'card|1' })], {
      key: 'acct:card',
      kind: 'credit_card',
    });
    const out = apply(applyBody([basic(HASH_A), card], { batch: 'split' }));
    const [first, second] = out.imports.map((i: Row) => i.import_id as string);
    expect(env.api.getSmartImports().map((i) => i.import_id)).toEqual([second, first]);
    const preview = env.api.previewSmartImport({
      statements: [
        {
          file_hash: HASH_A,
          account_key: 'acct:card',
          account_kind: 'credit_card',
          institution: null,
          dedupe_keys: [],
          merchant_keys: [],
        },
      ],
    });
    expect(preview.prior_files.map((p) => p.import_id)).toEqual([second]);
  });

  it('is a no-op with no statements', () => {
    expect(apply(applyBody([]))).toEqual({
      imports: [],
      skipped_files: [],
      rules_saved: 0,
      expenses_created: 0,
      expenses_linked: 0,
      pruned: 0,
    });
  });
});

describe('rules', () => {
  it('upserts with source, last_import_id and an explicit updated_at on insert and update', () => {
    env.db.execute(
      `INSERT INTO merchant_rules (id, merchant_key, category_id, kind, hits, source, created_at, updated_at)
       VALUES ('r-old', 'NETFLIX', 'cat-Other', 'expense', 4, 'import', '2020-01-01 00:00:00', '2020-01-01 00:00:00')`
    );
    const rules = [
      { merchant_key: 'NETFLIX', category_id: 'cat-Dining', kind: 'expense' },
      { merchant_key: 'GROCER', category_id: 'cat-Groceries', kind: 'expense', source: 'ai' },
      { merchant_key: 'PAYROLL', kind: 'income' },
    ];
    const body = apply(applyBody([basic()], { rules }));
    expect(body.rules_saved).toBe(3);
    const importId = body.imports[0].import_id;
    const by = Object.fromEntries(
      env.db.query<Row>('SELECT * FROM merchant_rules').map((r) => [r.merchant_key, r])
    );
    const n = by.NETFLIX;
    expect([n.id, n.category_id, n.hits, n.source, n.last_import_id]).toEqual([
      'r-old',
      'cat-Dining',
      5,
      'user',
      importId,
    ]);
    const stamp = new Date().toISOString();
    expect(n.updated_at).toBe(stamp);
    expect(n.created_at).toBe('2020-01-01 00:00:00');
    const g = by.GROCER;
    expect([g.hits, g.source, g.last_import_id, g.updated_at, g.created_at]).toEqual([
      1,
      'ai',
      importId,
      stamp,
      stamp,
    ]);
    const p = by.PAYROLL;
    expect([p.category_id, p.kind, p.hits]).toEqual([null, 'income', 1]);
  });

  it('moves updated_at forward on a second upsert', () => {
    apply(applyBody([basic(HASH_A)], { rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }] }));
    const first = one('SELECT updated_at FROM merchant_rules').updated_at;
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 5));
    apply(
      applyBody([basic(HASH_B)], {
        rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }],
        batch: 'b2',
      })
    );
    const row = one('SELECT updated_at, hits FROM merchant_rules');
    expect(row.hits).toBe(2);
    expect(row.updated_at > first).toBe(true);
  });

  it('lets the last rule per merchant win', () => {
    const rules = [
      { merchant_key: 'X', kind: 'expense', category_id: 'cat-Dining' },
      { merchant_key: 'X', kind: 'income' },
    ];
    expect(apply(applyBody([basic()], { rules })).rules_saved).toBe(1);
    const r = one('SELECT * FROM merchant_rules');
    expect([r.kind, r.category_id, r.hits]).toEqual(['income', null, 1]);
  });

  it('refuses a rule with a missing category and writes nothing', () => {
    const before = tableHashes(env.db);
    expectError(
      () => apply(applyBody([basic()], { rules: [{ merchant_key: 'X', category_id: 'nope' }] })),
      404,
      'category_not_found'
    );
    expect(tableHashes(env.db)).toEqual(before);
  });
});

describe('recurring', () => {
  it('creates, links and rejects', () => {
    addExpense(env.db, 'E-exist', 'Spotify', 10);
    const rec = [
      candidate('create', 'NETFLIX', { name: 'Netflix', amount: 15.49 }),
      candidate('link', 'SPOTIFY', { name: 'Spotify', amount: 10, expenseId: 'E-exist' }),
      candidate('reject', 'GYM', { name: 'Gym', amount: 30, frequency: 'weekly' }),
    ];
    const body = apply(applyBody([basic()], { recurring: rec, entityId: 'ent-1' }));
    expect([body.expenses_created, body.expenses_linked]).toEqual([1, 1]);
    const importId = body.imports[0].import_id;
    const cands = Object.fromEntries(
      env.db.query<Row>('SELECT * FROM recurring_candidates').map((c) => [c.name, c])
    );
    expect(
      Object.fromEntries(Object.entries(cands).map(([k, c]) => [k, [c.status, c.import_id]]))
    ).toEqual({
      Netflix: ['accepted', importId],
      Spotify: ['accepted', importId],
      Gym: ['rejected', importId],
    });
    expect(cands.Gym.created_expense_id).toBeNull();
    expect(cands.Spotify.created_expense_id).toBe('E-exist');
    const created = one('SELECT * FROM budget_expenses WHERE id = ?', [
      cands.Netflix.created_expense_id,
    ]);
    expect([
      created.name,
      created.amount,
      created.frequency,
      created.category_id,
      created.entity_id,
      created.is_active,
    ]).toEqual(['Netflix', 15.49, 'monthly', 'cat-Dining', 'ent-1', 1]);
    expect([cands.Netflix.amount, cands.Netflix.occurrences]).toEqual([15.49, 3]);
    const ledger = env.db.query<Row>('SELECT * FROM smart_import_ledger');
    const key = ledger.find((l) => l.action === 'created')!;
    expect([key.target_table, key.target_id, key.before_json, key.import_id]).toEqual([
      'budget_expenses',
      created.id,
      null,
      importId,
    ]);
    expect(
      ledger.some(
        (l) => l.action === 'linked' && l.target_id === 'E-exist' && l.after_json === null
      )
    ).toBe(true);
    const after = JSON.parse(key.after_json);
    expect(Object.keys(after).sort()).toEqual([
      'amount',
      'category_id',
      'end_date',
      'entity_id',
      'frequency',
      'interest_portion',
      'is_active',
      'is_mortgage',
      'is_pretax',
      'name',
      'principal_portion',
      'start_date',
      'updated_at',
    ]);
    expect([
      after.name,
      after.amount,
      after.entity_id,
      after.frequency,
      after.category_id,
      after.is_active,
    ]).toEqual(['Netflix', 15.49, 'ent-1', 'monthly', 'cat-Dining', true]);
    expect([after.is_pretax, after.is_mortgage]).toEqual([false, false]);
    expect(after.updated_at).toBe(new Date().toISOString().replace(/Z$/, ''));
  });

  it('attaches to the file holding the latest occurrence', () => {
    const out = apply(
      applyBody([basic(HASH_A), basic(HASH_B)], {
        recurring: [candidate('create', 'NETFLIX', { fileHash: HASH_B })],
      })
    );
    const second = out.imports.find((i: Row) => i.file_hash === HASH_B).import_id;
    expect(one('SELECT import_id FROM recurring_candidates').import_id).toBe(second);
  });

  it('attaches a candidate of a skipped file to the first new import', () => {
    apply(applyBody([basic(HASH_A)]));
    const body = applyBody(
      [basic(HASH_A), statement(HASH_B, [txn(D1, -1, 'N', { dedupe_key: 'n1' })])],
      { recurring: [candidate('create', 'NETFLIX', { fileHash: HASH_A })], batch: 'batch-2' }
    );
    const out = apply(body);
    expect(out.skipped_files).toEqual([HASH_A]);
    expect(one('SELECT import_id FROM recurring_candidates').import_id).toBe(
      out.imports[0].import_id
    );
  });

  it('drops candidates when the batch creates no import', () => {
    apply(applyBody([basic(HASH_A)]));
    const before = tableHashes(env.db);
    const out = apply(applyBody([basic(HASH_A)], { recurring: [candidate('create')] }));
    expect([out.expenses_created, out.imports]).toEqual([0, []]);
    expect(tableHashes(env.db)).toEqual(before);
  });

  it.each([
    ['link without an expense id', candidate('link'), 422],
    ['link to a missing expense', candidate('link', 'NETFLIX', { expenseId: 'missing' }), 404],
    ['create in a missing category', candidate('create', 'NETFLIX', { category: 'nope' }), 404],
    ['unknown frequency', candidate('create', 'NETFLIX', { frequency: 'daily' }), 422],
    ['unknown decision', candidate('maybe'), 422],
    ['expense id on a create', { ...candidate('create'), expense_id: 'E1' }, 422],
    ['zero amount', candidate('create', 'NETFLIX', { amount: 0 }), 422],
  ])('validates: %s', (_n, rec, status) => {
    const before = tableHashes(env.db);
    try {
      apply(applyBody([basic()], { recurring: [rec] }));
      throw new Error('expected an error');
    } catch (e) {
      expect((e as SmartImportHttpError).status).toBe(status);
    }
    expect(tableHashes(env.db)).toEqual(before);
  });

  it('needs an active expense in the same entity or the household to link', () => {
    addExpense(env.db, 'E-inactive', 'Old', 5, 'monthly', 'cat-Dining', { active: false });
    addExpense(env.db, 'E-other', 'Theirs', 5, 'monthly', 'cat-Dining', { entityId: 'ent-2' });
    addExpense(env.db, 'E-mine', 'Mine', 5, 'monthly', 'cat-Dining', { entityId: 'ent-1' });
    addExpense(env.db, 'E-house', 'House', 5);
    const before = tableHashes(env.db);
    for (const id of ['E-inactive', 'E-other']) {
      expectError(
        () =>
          apply(
            applyBody([basic()], {
              recurring: [candidate('link', 'NETFLIX', { expenseId: id })],
              entityId: 'ent-1',
            })
          ),
        404,
        'expense_not_found'
      );
    }
    expect(tableHashes(env.db)).toEqual(before);
    const rec = [
      candidate('link', 'A', { expenseId: 'E-mine' }),
      candidate('link', 'B', { expenseId: 'E-house' }),
    ];
    expect(apply(applyBody([basic()], { recurring: rec, entityId: 'ent-1' })).expenses_linked).toBe(
      2
    );
  });
});

describe('balances', () => {
  const balanceBody = (closing: Row): Row =>
    applyBody([
      statement(HASH_A, [txn(D1, -1)], { kind: 'credit_card', liabilityId: 'L1', closing }),
    ]);

  it('records the balance and moves the liability', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    env.db.execute("UPDATE liabilities SET updated_at = '2026-09-02 10:00:00' WHERE id = 'L1'");
    const out = apply(balanceBody({ amount: 321.5, as_of: '2026-09-30' }));
    expect(out.imports[0].balance).toBe('recorded');
    const importId = out.imports[0].import_id;
    const snap = one("SELECT * FROM liability_balance_snapshots WHERE source = 'import'");
    expect([snap.liability_id, snap.snapshot_date, snap.balance, snap.source_ref]).toEqual([
      'L1',
      '2026-09-30',
      321.5,
      importId,
    ]);
    const liab = one("SELECT * FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([321.5, '2026-09-30']);
    expect(liab.updated_at).toBe(new Date().toISOString());
    const ledger = Object.fromEntries(
      env.db.query<Row>('SELECT * FROM smart_import_ledger').map((l) => [l.action, l])
    );
    expect(Object.keys(ledger).sort()).toEqual(['balance_moved', 'snapshot']);
    expect([
      ledger.snapshot.target_table,
      ledger.snapshot.target_id,
      ledger.snapshot.before_json,
    ]).toEqual(['liability_balance_snapshots', snap.id, null]);
    expect(JSON.parse(ledger.snapshot.after_json)).toEqual({
      liability_id: 'L1',
      snapshot_date: '2026-09-30',
      balance: 321.5,
    });
    expect([ledger.balance_moved.target_table, ledger.balance_moved.target_id]).toEqual([
      'liabilities',
      'L1',
    ]);
    expect(JSON.parse(ledger.balance_moved.before_json)).toEqual({
      current_balance: 500,
      balance_as_of: '2026-09-01',
      updated_at: '2026-09-02T10:00:00',
    });
    expect(JSON.parse(ledger.balance_moved.after_json)).toEqual({
      current_balance: 321.5,
      balance_as_of: '2026-09-30',
    });
    expect(one('SELECT liability_id FROM smart_import_meta').liability_id).toBe('L1');
  });

  it('keeps a same-day snapshot and reports skipped_existing', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-30' });
    const out = apply(balanceBody({ amount: 321.5, as_of: '2026-09-30' }));
    expect(out.imports[0].balance).toBe('skipped_existing');
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
    expect(one("SELECT current_balance FROM liabilities WHERE id='L1'").current_balance).toBe(500);
    expect(count(env.db, 'smart_import_ledger')).toBe(0);
    expect(one('SELECT closing_balance FROM smart_import_meta').closing_balance).toBe(321.5);
  });

  it('inserts an older day without moving the liability', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    const out = apply(balanceBody({ amount: 700, as_of: '2026-08-15' }));
    expect(out.imports[0].balance).toBe('recorded');
    expect(count(env.db, 'liability_balance_snapshots')).toBe(2);
    expect(one("SELECT current_balance FROM liabilities WHERE id='L1'").current_balance).toBe(500);
    expect(
      env.db.query<Row>('SELECT action FROM smart_import_ledger').map((l) => l.action)
    ).toEqual(['snapshot']);
  });

  it('skips a future balance', () => {
    addLiability(env.db, 'L1');
    expect(apply(balanceBody({ amount: 1, as_of: '2026-10-05' })).imports[0].balance).toBe(
      'skipped_future'
    );
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('accepts a balance dated today', () => {
    addLiability(env.db, 'L1');
    expect(apply(balanceBody({ amount: 1, as_of: TODAY })).imports[0].balance).toBe('recorded');
  });

  it('writes no balance without a liability or without a closing balance', () => {
    addLiability(env.db, 'L1');
    const a = statement(HASH_A, [txn(D1, -1, 'N', { dedupe_key: '1' })], {
      kind: 'credit_card',
      closing: { amount: 5, as_of: '2026-09-30' },
    });
    const b = statement(HASH_B, [txn(D1, -1, 'N', { dedupe_key: '2' })], {
      kind: 'credit_card',
      liabilityId: 'L1',
    });
    expect(apply(applyBody([a, b])).imports.map((i: Row) => i.balance)).toEqual(['none', 'none']);
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('never sends a negative closing balance to a liability', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    expect(apply(balanceBody({ amount: -25, as_of: '2026-09-30' })).imports[0].balance).toBe(
      'none'
    );
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
    expect(one("SELECT current_balance FROM liabilities WHERE id='L1'").current_balance).toBe(500);
    expect(one('SELECT closing_balance FROM smart_import_meta').closing_balance).toBe(-25);
    expect(count(env.db, 'smart_import_ledger')).toBe(0);
  });

  it('refuses an unknown liability and writes nothing', () => {
    const before = tableHashes(env.db);
    expectError(
      () => apply(balanceBody({ amount: 1, as_of: '2026-09-30' })),
      404,
      'liability_not_found'
    );
    expect(tableHashes(env.db)).toEqual(before);
  });
});

describe('atomic apply', () => {
  const fullBody = (): Row =>
    applyBody(
      [
        basic(HASH_A),
        statement(HASH_B, [txn(D1, -3, 'N', { dedupe_key: 'b1' })], {
          kind: 'credit_card',
          liabilityId: 'L1',
          closing: { amount: 9, as_of: '2026-09-30' },
        }),
      ],
      {
        rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }],
        recurring: [candidate('create'), candidate('reject', 'GYM', { name: 'Gym' })],
      }
    );

  function failOn(match: (sql: string, params?: unknown[]) => boolean): void {
    const real = env.db.execute.bind(env.db);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(env.db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (match(sql, params)) throw new Error('leak ZQXSECRET');
      return real(sql, params);
    });
  }

  it.each([
    ['a ledger insert', (sql: string) => sql.startsWith('INSERT INTO smart_import_ledger')],
    ['the balance move', (sql: string) => sql.startsWith('UPDATE liabilities')],
    ['the prune', (sql: string) => sql.startsWith('DELETE FROM import_transactions')],
    ['a transaction insert', (sql: string) => sql.startsWith('INSERT INTO import_transactions')],
    ['a rule write', (sql: string) => sql.includes('merchant_rules')],
  ])('leaves every table unchanged when %s fails', (_n, match) => {
    addLiability(env.db, 'L1');
    addExpense(env.db, 'E1');
    const before = tableHashes(env.db);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failOn(match);
    try {
      apply(fullBody());
      throw new Error('expected a 500');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartImportHttpError);
      expect((e as SmartImportHttpError).status).toBe(500);
      expect((e as SmartImportHttpError).body()).toEqual({
        error_type: 'save_failed',
        detail: 'The change could not be saved.',
      });
      expect((e as Error).message).not.toContain('ZQXSECRET');
    }
    vi.restoreAllMocks();
    expect(spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toContain(
      'ZQXSECRET'
    );
    expect(tableHashes(env.db)).toEqual(before);
    // the savepoint was released: the same apply works afterwards
    expect(apply(fullBody()).imports).toHaveLength(2);
  });

  it('rolls back liability and snapshots when the failure comes after the balance move', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    const before = tableHashes(env.db);
    failOn(
      (sql, params) =>
        sql.startsWith('INSERT INTO smart_import_ledger') && params?.[2] === 'balance_moved'
    );
    expectError(
      () =>
        apply(
          applyBody([
            statement(HASH_A, [txn(D1, -1)], {
              kind: 'credit_card',
              liabilityId: 'L1',
              closing: { amount: 321.5, as_of: '2026-09-30' },
            }),
          ])
        ),
      500,
      'save_failed'
    );
    vi.restoreAllMocks();
    expect(tableHashes(env.db)).toEqual(before);
    expect(one("SELECT current_balance FROM liabilities WHERE id='L1'").current_balance).toBe(500);
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('commits everything when it succeeds', () => {
    addLiability(env.db, 'L1');
    apply(fullBody());
    expect(count(env.db, 'smart_import_meta')).toBe(2);
    expect(count(env.db, 'smart_import_ledger')).toBeGreaterThan(0);
  });

  it('does not close a caller transaction (nest-safe)', () => {
    env.db.execute('SAVEPOINT outer_tx');
    apply(applyBody([basic()]));
    env.db.execute('ROLLBACK TO outer_tx');
    env.db.execute('RELEASE outer_tx');
    expect(count(env.db, 'import_transactions')).toBe(0);
  });
});

describe('prune and delete', () => {
  function seedOld(
    origin = 'file',
    importId = 'old-imp',
    days = ['2022-01-05', '2024-10-03', '2024-10-04']
  ): void {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES (?, 'o.csv', ?, 'applied')",
      [importId, importId]
    );
    env.db.execute(
      `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key)
       VALUES (?, 'b0', ?, 'csv', 'csv', 'checking', 'acct:one')`,
      [importId, origin]
    );
    days.forEach((day, n) =>
      env.db.execute(
        `INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key)
         VALUES (?, ?, 'acct:one', ?, -1, 'OLD', 'OLD', 'expense', 'none', ?)`,
        [`old-${importId}-${n}`, importId, day, `${importId}|${n}`]
      )
    );
  }

  it('deletes older than the retention, only during apply, and nothing else', () => {
    seedOld();
    addExpense(env.db, 'E1');
    addLiability(env.db, 'L1');
    env.db.execute(
      "INSERT INTO merchant_rules (id, merchant_key, kind, hits, source) VALUES ('r1', 'OLD', 'expense', 1, 'user')"
    );
    // 24 months from 2026-10-04: cutoff 2024-10-04, earlier rows go
    expect(apply(applyBody([basic()])).pruned).toBe(2);
    expect(
      env.db
        .query<Row>("SELECT posted_date FROM import_transactions WHERE import_id = 'old-imp'")
        .map((r) => r.posted_date)
    ).toEqual(['2024-10-04']);
    expect(count(env.db, 'budget_expenses', "id = 'E1'")).toBe(1);
    expect(count(env.db, 'merchant_rules', "id = 'r1'")).toBe(1);
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('never touches sample imports', () => {
    seedOld('sample');
    expect(apply(applyBody([basic()])).pruned).toBe(0);
    expect(count(env.db, 'import_transactions', "import_id = 'old-imp'")).toBe(3);
  });

  it('keeps everything when retention is 0', () => {
    seedOld();
    env.api.putSmartImportSettings({ retention_months: 0 });
    expect(apply(applyBody([basic()])).pruned).toBe(0);
    expect(count(env.db, 'import_transactions', "import_id = 'old-imp'")).toBe(3);
  });

  it('clamps the cutoff to the end of the month', () => {
    vi.setSystemTime(new Date(2026, 4, 31, 12, 0, 0));
    seedOld('file', 'old-imp', ['2025-05-30', '2025-05-31']);
    env.api.putSmartImportSettings({ retention_months: 12 });
    expect(apply(applyBody([statement(HASH_A, [txn('2026-05-01', -1)])])).pruned).toBe(1);
    expect(
      env.db
        .query<Row>("SELECT posted_date FROM import_transactions WHERE import_id = 'old-imp'")
        .map((r) => r.posted_date)
    ).toEqual(['2025-05-31']);
  });

  it('clamps a leap day cutoff to the last day of February', () => {
    vi.setSystemTime(new Date(2028, 1, 29, 12, 0, 0)); // 2028-02-29, one year back is 2027-02-28
    seedOld('file', 'old-imp', ['2027-02-27', '2027-02-28']);
    env.api.putSmartImportSettings({ retention_months: 12 });
    expect(apply(applyBody([statement(HASH_A, [txn('2028-01-01', -1)])])).pruned).toBe(1);
    expect(
      env.db
        .query<Row>("SELECT posted_date FROM import_transactions WHERE import_id = 'old-imp'")
        .map((r) => r.posted_date)
    ).toEqual(['2027-02-28']);
  });

  it('does not prune a sample statement with old rows by its own apply', () => {
    const st = statement(
      HASH_A,
      [txn('2020-01-05', -1, 'N', { dedupe_key: 'o1' }), txn(D1, -2, 'N', { dedupe_key: 'o2' })],
      { origin: 'sample' }
    );
    const out = apply(applyBody([st]));
    expect([out.pruned, out.imports[0].txn_new]).toEqual([0, 2]);
  });

  it('can prune a very old statement in the same apply (non-sample)', () => {
    const st = statement(HASH_A, [
      txn('2020-01-05', -1, 'N', { dedupe_key: 'o1' }),
      txn(D1, -2, 'N', { dedupe_key: 'o2' }),
    ]);
    const out = apply(applyBody([st]));
    expect([out.pruned, out.imports[0].txn_new]).toEqual([1, 2]);
  });

  it('deleteSmartImportTransactions only removes transactions', () => {
    addLiability(env.db, 'L1');
    apply(
      applyBody(
        [
          basic(HASH_A),
          statement(HASH_B, [txn(D1, -3, 'N', { dedupe_key: 'b1' })], {
            kind: 'credit_card',
            liabilityId: 'L1',
            closing: { amount: 9, as_of: '2026-09-30' },
          }),
        ],
        { rules: [{ merchant_key: 'NETFLIX', kind: 'expense' }], recurring: [candidate('create')] }
      )
    );
    const tables = [
      'budget_expenses',
      'merchant_rules',
      'liability_balance_snapshots',
      'bank_statement_imports',
      'smart_import_meta',
      'smart_import_ledger',
      'recurring_candidates',
    ];
    const snap = (): Record<string, number> =>
      Object.fromEntries(tables.map((t) => [t, count(env.db, t)]));
    const before = snap();
    const txns = count(env.db, 'import_transactions');
    expect(txns).toBeGreaterThan(0);
    expect(env.api.deleteSmartImportTransactions()).toEqual({ deleted: txns });
    expect(snap()).toEqual(before);
    expect(count(env.db, 'import_transactions')).toBe(0);
    expect(env.api.deleteSmartImportTransactions()).toEqual({ deleted: 0 });
  });
});

describe('apply validation', () => {
  const day = (d: string): string => d;
  const mut = (fn: (b: Row) => void): Row => {
    const b = applyBody([basic()]);
    fn(b);
    return b;
  };
  const st0 = (b: Row): Row => b.statements[0];
  const t0 = (b: Row): Row => st0(b).transactions[0];

  it.each<[string, Row]>([
    ['missing batch_id', mut((b) => delete b.batch_id)],
    ['empty batch_id', mut((b) => (b.batch_id = ''))],
    ['batch_id over 100', mut((b) => (b.batch_id = 'x'.repeat(101)))],
    ['extra top key', mut((b) => (b.extra = 1))],
    ['null body', null as unknown as Row],
    ['13 statements', mut((b) => (b.statements = Array.from({ length: 13 }, () => basic())))],
    ['bad origin', mut((b) => (st0(b).origin = 'web'))],
    ['bad format', mut((b) => (st0(b).format = 'xls'))],
    ['bad hash', mut((b) => (st0(b).file_hash = 'bad hash'))],
    ['hash trailing newline', mut((b) => (st0(b).file_hash = `${HASH_A}\n`))],
    ['file_name over 1000', mut((b) => (st0(b).file_name = 'f'.repeat(1001)))],
    ['empty parser', mut((b) => (st0(b).parser = ''))],
    ['null account key', mut((b) => (st0(b).account.key = null))],
    ['bad account kind', mut((b) => (st0(b).account.kind = 'boat'))],
    ['extra account key', mut((b) => (st0(b).account.extra = 1))],
    ['last4 over 32', mut((b) => (st0(b).account.last4 = 'x'.repeat(33)))],
    ['datetime posted_date', mut((b) => (t0(b).posted_date = '2026-09-01T10:00:00'))],
    ['impossible posted_date', mut((b) => (t0(b).posted_date = '2026-02-30'))],
    ['string amount', mut((b) => (t0(b).amount = 'x'))],
    ['NaN amount', mut((b) => (t0(b).amount = NaN))],
    ['amount over 1e10', mut((b) => (t0(b).amount = 2e10))],
    ['bad kind', mut((b) => (t0(b).kind = 'gift'))],
    ['bad category_source', mut((b) => (t0(b).category_source = 'magic'))],
    ['empty dedupe_key', mut((b) => (t0(b).dedupe_key = ''))],
    ['dedupe_key over 400', mut((b) => (t0(b).dedupe_key = 'k'.repeat(401)))],
    ['merchant_key over 400', mut((b) => (t0(b).merchant_key = 'k'.repeat(401)))],
    ['description over 2000', mut((b) => (t0(b).description = 'k'.repeat(2001)))],
    ['ai_confidence over 1', mut((b) => (t0(b).ai_confidence = 1.5))],
    ['non-bool excluded', mut((b) => (t0(b).excluded = 'yes'))],
    ['unknown txn key', mut((b) => (t0(b).unknown = 1))],
    [
      '10001 transactions',
      mut(
        (b) =>
          (st0(b).transactions = Array.from({ length: 10_001 }, (_, n) =>
            txn(D1, -1, 'N', { dedupe_key: `k${n}` })
          ))
      ),
    ],
    ['bad rule source', mut((b) => (b.rules = [{ merchant_key: 'X', source: 'bogus' }]))],
    ['empty rule key', mut((b) => (b.rules = [{ merchant_key: '' }]))],
    ['bad rule kind', mut((b) => (b.rules = [{ merchant_key: 'X', kind: 'gift' }]))],
    [
      'closing amount over 1e10',
      mut((b) => (st0(b).closing_balance = { amount: 1e12, as_of: '2026-09-30' })),
    ],
    [
      'closing as_of datetime',
      mut((b) => (st0(b).closing_balance = { amount: 1, as_of: '2026-09-30T00:00:00' })),
    ],
    ['period datetime', mut((b) => (st0(b).period = { start: '2026-09-01T00:00:00', end: null }))],
    ['ai_used not bool', mut((b) => (st0(b).ai_used = 1))],
    ['rules not a list', mut((b) => (b.rules = 'x'))],
  ])('rejects %s with a fixed 422 and writes nothing', (_n, body) => {
    const before = tableHashes(env.db);
    expectError(() => apply(body), 422, 'bad_request');
    expect(tableHashes(env.db)).toEqual(before);
    void day;
  });

  it('accepts omitted optional fields and null optionals', () => {
    const st = basic();
    delete st.period;
    delete st.closing_balance;
    delete st.liability_id;
    delete st.ai_used;
    delete st.ai_provider;
    delete st.account.label;
    const body = { batch_id: 'b', statements: [st] };
    expect(apply(body).imports).toHaveLength(1);
  });
});

describe('logging', () => {
  it('logs no planted values across apply, summary, delete and undo', () => {
    const spies = (['error', 'warn', 'log', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const planted = 'ZQXPLANTED WIDGETS';
    addLiability(env.db, 'L1', { name: planted });
    const st = statement(HASH_C, [txn(D1, -4242.42, planted, { description: planted })], {
      kind: 'credit_card',
      liabilityId: 'L1',
      closing: { amount: 7777.77, as_of: '2026-09-30' },
    });
    st.file_name = 'ZQXFILE.csv';
    st.account.label = planted;
    const out = apply(
      applyBody([st], {
        rules: [{ merchant_key: planted, kind: 'expense' }],
        recurring: [candidate('create', planted, { name: planted, fileHash: HASH_C })],
      })
    );
    apply(applyBody([st]));
    env.api.getSpendingSummary(3, null);
    env.api.deleteSmartImportTransactions();
    env.api.undoSmartImport(out.imports[0].import_id);
    expect(() => env.api.undoSmartImport('nope')).toThrow();
    const text = spies
      .map((s) => s.mock.calls.map((c) => c.map(String).join(' ')).join('\n'))
      .join('\n');
    for (const secret of [planted, 'ZQX', '4242', '7777', HASH_C])
      expect(text).not.toContain(secret);
  });
});

describe('spending summary', () => {
  function seedSpending(entity = 'e1'): void {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status, entity_id) VALUES ('s1', 's.csv', 's1', 'applied', ?)",
      [entity]
    );
    env.db.execute(
      `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key, period_start, period_end)
       VALUES ('s1', 'b', 'file', 'csv', 'csv', 'checking', 'acct:one', '2026-07-01', '2026-09-30')`
    );
    const rows: [string, number, string, string | null][] = [
      ['2026-07-05', -300, 'expense', 'cat-Groceries'],
      ['2026-08-05', -300, 'fee', 'cat-Groceries'],
      ['2026-09-05', -300, 'interest', 'cat-Groceries'],
      ['2026-09-09', 60, 'refund', 'cat-Groceries'],
      ['2026-09-06', -90, 'expense', 'cat-Dining'],
      ['2026-09-07', -30, 'expense', null],
      ['2026-09-08', -30, 'expense', 'cat-deleted'],
      ['2026-09-10', -500, 'payment', 'cat-Debt Payments'],
      ['2026-09-11', -500, 'transfer', null],
      ['2026-09-12', 3000, 'income', null],
      ['2026-10-02', -999, 'expense', 'cat-Dining'],
      ['2026-06-20', -999, 'expense', 'cat-Dining'],
    ];
    rows.forEach(([day, amount, kind, cat], n) =>
      env.db.execute(
        `INSERT INTO import_transactions (id, import_id, entity_id, account_key, posted_date, amount, description, merchant_key, kind, category_id, category_source, dedupe_key)
         VALUES (?, 's1', ?, 'acct:one', ?, ?, 'X', 'X', ?, ?, 'none', ?)`,
        [`sp-${n}`, entity, day, amount, kind, cat, `sp|${n}`]
      )
    );
  }
  const summary = (months = 3, entity: string | null = null): Row =>
    env.api.getSpendingSummary(months, entity) as unknown as Row;
  const lines = (body: Row): Record<string, Row> =>
    Object.fromEntries(body.categories.map((c: Row) => [c.category_name, c]));

  it('averages over covered complete months', () => {
    seedSpending();
    addExpense(env.db, 'p1', 'Groceries plan', 100, 'weekly', 'cat-Groceries', { entityId: 'e1' });
    addExpense(env.db, 'p2', 'Phone', 120, 'annual', 'cat-Dining', { entityId: 'e1' });
    addExpense(env.db, 'p3', 'Gym', 30, 'biweekly', 'cat-Dining', { entityId: 'e1' });
    addExpense(env.db, 'p4', 'Insurance', 300, 'quarterly', 'cat-Other', { entityId: 'e1' });
    addExpense(env.db, 'p5', 'Old', 50, 'monthly', 'cat-Other', { active: false });
    addExpense(env.db, 'p6', 'Once', 50, 'one_time', 'cat-Other');
    addExpense(env.db, 'p7', 'Odd', 12, 'fortnightly', 'cat-Other');
    const body = summary(3);
    expect(body.months_covered).toBe(3);
    expect(body.months).toEqual(['2026-07', '2026-08', '2026-09']);
    const by = lines(body);
    expect(by.Groceries.actual_monthly).toBeCloseTo(280, 2);
    expect(by.Groceries.planned_monthly).toBeCloseTo((100 * 52) / 12, 2);
    expect(by.Groceries.difference).toBeCloseTo(280 - (100 * 52) / 12, 2);
    expect(by.Dining.actual_monthly).toBeCloseTo(30, 2);
    expect(by.Dining.planned_monthly).toBeCloseTo(120 / 12 + (30 * 26) / 12, 2);
    expect(by.Uncategorized.actual_monthly).toBeCloseTo(20, 2);
    expect(by.Uncategorized.category_id).toBeNull();
    expect(by.Other.planned_monthly).toBeCloseTo(100 + 12, 2); // quarterly 300 -> 100, unknown frequency 12 -> monthly
    expect(by.Other.actual_monthly).toBe(0);
    expect(by['Debt Payments']).toBeUndefined();
    expect(body.totals.actual_monthly).toBeCloseTo(330, 2);
    expect(body.categories.map((c: Row) => c.category_name)).toEqual([
      'Dining',
      'Groceries',
      'Other',
      'Uncategorized',
    ]);
  });

  it('uses the most recent n months', () => {
    seedSpending();
    const body = summary(1);
    expect(body.months).toEqual(['2026-09']);
    expect(lines(body).Groceries.actual_monthly).toBeCloseTo(240, 2);
  });

  it('filters by entity', () => {
    seedSpending('e1');
    addExpense(env.db, 'p1', 'Mine', 60, 'monthly', 'cat-Dining', { entityId: 'e1' });
    addExpense(env.db, 'p2', 'Theirs', 80, 'monthly', 'cat-Dining', { entityId: 'e2' });
    const mine = summary(3, 'e1');
    expect(lines(mine).Dining.planned_monthly).toBe(60);
    expect(mine.months_covered).toBe(3);
    const other = summary(3, 'e2');
    expect(other.months_covered).toBe(0);
    expect(other.months).toEqual([]);
    expect(lines(other).Dining.planned_monthly).toBe(80);
    expect(lines(other).Dining.actual_monthly).toBe(0);
  });

  it('takes coverage from stored transactions when the period is unknown', () => {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('s1', 's.csv', 's1', 'applied')"
    );
    env.db.execute(
      "INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key) VALUES ('s1', 'b', 'sample', 'csv', 'csv', 'checking', 'acct:one')"
    );
    ['2026-03-03', '2026-03-09', '2026-05-02'].forEach((day, n) =>
      env.db.execute(
        `INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_id, category_source, dedupe_key)
         VALUES (?, 's1', 'acct:one', ?, -10, 'X', 'X', 'expense', 'cat-Dining', 'none', ?)`,
        [`u${n}`, day, `u${n}`]
      )
    );
    const body = summary(3);
    expect(body.months).toEqual(['2026-03', '2026-05']);
    expect(lines(body).Dining.actual_monthly).toBeCloseTo(15, 2);
  });

  it('needs a stored transaction in the month, so a prune or delete removes coverage', () => {
    seedSpending();
    expect(summary().months).toEqual(['2026-07', '2026-08', '2026-09']);
    env.db.execute("DELETE FROM import_transactions WHERE posted_date < '2026-08-01'");
    expect(summary().months).toEqual(['2026-08', '2026-09']);
    env.api.deleteSmartImportTransactions();
    const empty = summary();
    expect([empty.months, empty.months_covered]).toEqual([[], 0]);
  });

  it('drops coverage after a real prune during apply', () => {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('old-imp', 'o.csv', 'old', 'applied')"
    );
    env.db.execute(
      "INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key, period_start, period_end) VALUES ('old-imp', 'b0', 'file', 'csv', 'csv', 'checking', 'acct:one', '2024-01-01', '2026-08-31')"
    );
    ['2024-01-05', '2026-08-05'].forEach((day, n) =>
      env.db.execute(
        `INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key)
         VALUES (?, 'old-imp', 'acct:one', ?, -1, 'OLD', 'OLD', 'expense', 'none', ?)`,
        [`o${n}`, day, `o|${n}`]
      )
    );
    expect(summary(24).months).toContain('2024-01');
    apply(applyBody([basic()]));
    expect(summary(24).months).not.toContain('2024-01');
  });

  it('ignores months outside an inverted period', () => {
    env.db.execute(
      "INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('s1', 's.csv', 's1', 'applied')"
    );
    env.db.execute(
      "INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key, period_start, period_end) VALUES ('s1', 'b', 'file', 'csv', 'csv', 'checking', 'acct:one', '2026-09-30', '2026-08-01')"
    );
    env.db.execute(
      "INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES ('t', 's1', 'acct:one', '2026-09-05', -1, 'X', 'X', 'expense', 'none', 'd')"
    );
    expect(summary().months).toEqual([]);
  });

  it('is empty with no data', () => {
    expect(summary()).toEqual({
      months_covered: 0,
      months: [],
      categories: [],
      totals: { actual_monthly: 0, planned_monthly: 0, difference: 0 },
    });
  });

  it('rounds half to even on exact ties, like the server', () => {
    addExpense(env.db, 'p1', 'Tie', 0.125, 'monthly', 'cat-Dining'); // planned 0.125 a month
    expect(lines(summary()).Dining.planned_monthly).toBe(0.12);
  });

  it.each([
    ['months=0', 0, null],
    ['months=25', 25, null],
    ['months=1.5', 1.5, null],
    ['entity over 64', 3, 'x'.repeat(65)],
  ])('rejects %s', (_n, months, entity) => {
    expectError(() => env.api.getSpendingSummary(months, entity), 422, 'bad_request');
  });

  it('treats an empty entity as none', () => {
    seedSpending();
    expect(summary(3, '').months_covered).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// connection_id (plan B3), mirror of the server tests in test_smart_import_apply.py
// ---------------------------------------------------------------------------

/** A connector statement as the wizard sends it after a sync. */
function synced(fileHash: string = HASH_A, txns: Row[] = [txn(D1, -1)], o: Row = {}): Row {
  const { cid, ...rest } = o;
  const body = statement(fileHash, txns, { origin: 'connector', ...rest });
  body.format = 'connector';
  body.parser = 'connector:demo';
  body.file_name = 'Demo sync';
  if (cid !== null) body.connection_id = cid === undefined ? CONN_ID : cid;
  return body;
}

describe('connection_id', () => {
  const UNKNOWN = '11111111-2222-4333-8444-555555555555';

  it.each<[string, () => Row]>([
    ['a connector statement without one', () => synced(HASH_A, [txn(D1, -1)], { cid: null })],
    [
      'a file statement with one',
      () => ({ ...statement(HASH_A, [txn(D1, -1)]), connection_id: CONN_ID }),
    ],
    [
      'a sample statement with one',
      () => ({ ...statement(HASH_A, [txn(D1, -1)], { origin: 'sample' }), connection_id: CONN_ID }),
    ],
    ['an empty one', () => synced(HASH_A, [txn(D1, -1)], { cid: '' })],
    ['one over 64 characters', () => synced(HASH_A, [txn(D1, -1)], { cid: 'c'.repeat(65) })],
    ['a number', () => synced(HASH_A, [txn(D1, -1)], { cid: 7 })],
  ])('refuses %s with a fixed 422 and writes nothing', (_n, make) => {
    addConnection(env.db);
    const before = tableHashes(env.db);
    expectError(() => apply(applyBody([make()])), 422, 'bad_request');
    expect(tableHashes(env.db)).toEqual(before);
  });

  it('accepts a file statement with a null connection_id', () => {
    const st = { ...statement(HASH_A, [txn(D1, -1)]), connection_id: null };
    expect(apply(applyBody([st])).imports).toHaveLength(1);
  });

  it.each([UNKNOWN, CONN_ID.toUpperCase(), 'connections'])(
    'refuses an unknown connection %s with 404 and writes nothing',
    (cid) => {
      addConnection(env.db);
      const before = tableHashes(env.db);
      expectError(
        () => apply(applyBody([synced(HASH_A, [txn(D1, -1)], { cid })])),
        404,
        'connection_not_found'
      );
      expect(tableHashes(env.db)).toEqual(before);
    }
  );

  it('refuses with no connections row', () => {
    expectError(() => apply(applyBody([synced()])), 404, 'connection_not_found');
  });

  it('does not count an entry the store would drop', () => {
    addConnections(env.db, { [CONN_ID]: connectionEntry({ provider: 'plaid' }) });
    expectError(() => apply(applyBody([synced()])), 404, 'connection_not_found');
  });

  it('refuses the whole batch for an unknown connection in a later statement', () => {
    addConnection(env.db);
    const before = tableHashes(env.db);
    const body = applyBody([
      synced(HASH_A, [txn(D1, -1, 'NETFLIX', { dedupe_key: '1' })]),
      synced(HASH_B, [txn(D1, -2, 'NETFLIX', { dedupe_key: '2' })], { cid: UNKNOWN }),
    ]);
    expectError(() => apply(body), 404, 'connection_not_found');
    expect(tableHashes(env.db)).toEqual(before);
  });

  it('stores the connection in the meta row and lists it', () => {
    addConnection(env.db);
    const out = apply(
      applyBody([
        synced(HASH_A, [txn(D1, -1, 'NETFLIX', { dedupe_key: '1' })], {
          period: { start: '2026-09-01', end: '2026-10-04' },
        }),
        statement(HASH_B, [txn(D1, -2, 'NETFLIX', { dedupe_key: '2' })]),
      ])
    );
    const [connectorId, fileId] = (out.imports as Row[]).map((i) => i.import_id as string);
    const meta = (id: string): Row =>
      one('SELECT * FROM smart_import_meta WHERE import_id = ?', [id]);
    expect([meta(connectorId!).connection_id, meta(connectorId!).origin]).toEqual([
      CONN_ID,
      'connector',
    ]);
    expect(meta(fileId!).connection_id).toBeNull();
    const rows = Object.fromEntries(env.api.getSmartImports().map((r) => [r.import_id, r]));
    expect([rows[connectorId!]!.connection_id, rows[connectorId!]!.origin]).toEqual([
      CONN_ID,
      'connector',
    ]);
    expect(rows[fileId!]!.connection_id).toBeNull();
  });

  it('leaves undo of a connector import unchanged', () => {
    addConnection(env.db);
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    const before = tableHashes(env.db);
    const out = apply(
      applyBody(
        [
          synced(HASH_A, [txn(D1, -1)], {
            kind: 'credit_card',
            liabilityId: 'L1',
            closing: { amount: 321.5, as_of: '2026-09-30' },
          }),
        ],
        { rules: [{ merchant_key: 'NETFLIX', category_id: 'cat-Dining', source: 'connector' }] }
      )
    );
    env.api.undoSmartImport(out.imports[0].import_id);
    expect(env.api.getSmartImports()).toEqual([]);
    const after = tableHashes(env.db);
    for (const table of ['budget_expenses', 'liability_balance_snapshots']) {
      expect(after[table]).toBe(before[table]);
    }
    for (const table of [
      'import_transactions',
      'smart_import_ledger',
      'smart_import_meta',
      'bank_statement_imports',
    ]) {
      expect(count(env.db, table)).toBe(0);
    }
    const liab = one("SELECT current_balance, balance_as_of FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([500, '2026-09-01']);
    expect(count(env.db, 'merchant_rules')).toBe(1);
  });
});

describe('connector balances', () => {
  const cardSync = (closing: Row): Row =>
    applyBody([synced(HASH_A, [txn(D1, -1)], { kind: 'credit_card', liabilityId: 'L1', closing })]);

  it('records a balance dated tomorrow as today and undo restores it', () => {
    addConnection(env.db);
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    const out = apply(cardSync({ amount: 321.5, as_of: '2026-10-05' }));
    expect(out.imports[0].balance).toBe('recorded');
    const importId = out.imports[0].import_id;
    const snap = one("SELECT * FROM liability_balance_snapshots WHERE source = 'import'");
    expect([snap.snapshot_date, snap.balance]).toEqual([TODAY, 321.5]);
    const liab = one("SELECT current_balance, balance_as_of FROM liabilities WHERE id = 'L1'");
    expect([liab.current_balance, liab.balance_as_of]).toEqual([321.5, TODAY]);
    const ledger = Object.fromEntries(
      env.db.query<Row>('SELECT * FROM smart_import_ledger').map((l) => [l.action, l])
    );
    expect(JSON.parse(ledger.snapshot.after_json).snapshot_date).toBe(TODAY);
    expect(JSON.parse(ledger.balance_moved.after_json).balance_as_of).toBe(TODAY);
    expect(one('SELECT closing_balance_date FROM smart_import_meta').closing_balance_date).toBe(
      '2026-10-05'
    );
    env.api.undoSmartImport(importId);
    const back = one("SELECT current_balance, balance_as_of FROM liabilities WHERE id = 'L1'");
    expect([back.current_balance, back.balance_as_of]).toEqual([500, '2026-09-01']);
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('keeps a snapshot already on today', () => {
    addConnection(env.db);
    addLiability(env.db, 'L1', { balance: 500, asOf: TODAY });
    expect(apply(cardSync({ amount: 321.5, as_of: '2026-10-05' })).imports[0].balance).toBe(
      'skipped_existing'
    );
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });

  it('still skips a balance two days ahead', () => {
    addConnection(env.db);
    addLiability(env.db, 'L1');
    expect(apply(cardSync({ amount: 1, as_of: '2026-10-06' })).imports[0].balance).toBe(
      'skipped_future'
    );
    expect(count(env.db, 'liability_balance_snapshots')).toBe(1);
  });
});
