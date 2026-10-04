/**
 * LocalAPI smart import, read side and settings (browser path). Ports
 * tests/api/test_smart_import_api.py case by case against fresh in-memory
 * databases. Today is pinned to 2026-10-04. There is no demo protection in
 * the browser, so the server's 403 cases have no twin here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { LocalHttpError } from '@/database/local-error';
import { SmartImportHttpError } from '@/database/local-smart-import';
import { createTestApi, useSequentialUuids } from './helpers';

const TODAY = '2026-10-04';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const LAYOUT_SIG = 'c'.repeat(64);
const BAD_REQUEST = { error_type: 'bad_request', detail: 'The request could not be read.' };

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let restoreUuids: () => void;
let db: ClientDatabase;
let api: LocalAPI;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  restoreUuids = useSequentialUuids();
  ({ db, api } = await createTestApi());
  db.execute('DELETE FROM budget_expense_categories');
  ['Groceries', 'Dining', 'Debt Payments'].forEach((name, i) =>
    db.execute('INSERT INTO budget_expense_categories (id, name, sort_order) VALUES (?, ?, ?)', [
      `cat-${name}`,
      name,
      i,
    ])
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreUuids();
  db.close();
});

function addImport(
  id: string,
  o: {
    hash: string;
    key: string | null;
    kind?: string;
    label?: string | null;
    last4?: string | null;
    institution?: string | null;
    liabilityId?: string | null;
    created?: string;
    origin?: string;
    batch?: string;
    uploaded?: string;
    connectionId?: string | null;
  }
): void {
  db.execute(
    `INSERT INTO bank_statement_imports (id, file_name, content_hash, status, row_count, analyzed_at)
     VALUES (?, ?, ?, 'applied', 1, ?)`,
    [id, `${id}.csv`, o.hash, o.uploaded ?? '2026-09-01 12:00:00']
  );
  db.execute(
    `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind,
       account_key, account_label, account_last4, institution, liability_id, created_at,
       connection_id)
     VALUES (?, ?, ?, 'csv', 'csv', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.batch ?? 'batch-1',
      o.origin ?? 'file',
      o.kind ?? 'checking',
      o.key,
      o.label === undefined ? 'Main' : o.label,
      o.last4 === undefined ? '1234' : o.last4,
      o.institution === undefined ? 'Sample Bank' : o.institution,
      o.liabilityId ?? null,
      o.created ?? '2026-09-01 12:00:00',
      o.connectionId ?? null,
    ]
  );
}

let txnCounter = 0;
function addTxn(
  importId: string,
  key: string,
  o: { dedupe: string; merchant?: string; amount?: number; posted?: string }
): void {
  db.execute(
    `INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description,
       merchant_key, kind, category_source, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'expense', 'rule', ?)`,
    [
      `txn-${++txnCounter}`,
      importId,
      key,
      o.posted ?? '2026-09-01',
      o.amount ?? -15,
      o.merchant ?? 'NETFLIX',
      o.merchant ?? 'NETFLIX',
      o.dedupe,
    ]
  );
}

function addLiability(
  id: string,
  name: string,
  o: { lender?: string | null; type?: string; active?: boolean } = {}
): void {
  db.execute(
    `INSERT INTO liabilities (id, name, liability_type, lender, current_balance, balance_as_of,
       is_amortizing, is_active) VALUES (?, ?, ?, ?, 100, ?, 0, ?)`,
    [id, name, o.type ?? 'credit_card', o.lender ?? null, TODAY, o.active === false ? 0 : 1]
  );
}

function addRule(
  key: string,
  categoryId: string | null = null,
  kind: string | null = null,
  id?: string,
  hits = 1
): void {
  db.execute(
    `INSERT INTO merchant_rules (id, merchant_key, category_id, kind, hits, source)
     VALUES (?, ?, ?, ?, ?, 'user')`,
    [id ?? `rule-${key}`, key, categoryId, kind, hits]
  );
}

const counts = (): Record<string, number> => ({
  meta: db.query('SELECT 1 FROM smart_import_meta').length,
  txns: db.query('SELECT 1 FROM import_transactions').length,
  rules: db.query('SELECT 1 FROM merchant_rules').length,
  settings: db.query('SELECT 1 FROM app_settings WHERE key = ?', ['smart_import']).length,
});

function stmt(over: Row = {}): Row {
  return {
    file_hash: HASH_A,
    account_key: 'acct:one',
    account_kind: 'checking',
    institution: null,
    dedupe_keys: [],
    merchant_keys: [],
    ...over,
  };
}

const preview = (...statements: Row[]): ReturnType<LocalAPI['previewSmartImport']> =>
  api.previewSmartImport({ statements });

function expectBadRequest(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SmartImportHttpError);
    expect(e).toBeInstanceOf(LocalHttpError);
    expect((e as SmartImportHttpError).status).toBe(422);
    expect((e as SmartImportHttpError).body()).toEqual(BAD_REQUEST);
    return;
  }
  throw new Error('expected a 422 bad_request');
}

describe('context', () => {
  it('is empty with defaults', () => {
    const body = api.getSmartImportContext();
    expect(body.rules).toEqual([]);
    expect(body.accounts).toEqual([]);
    expect(body.csv_layouts).toEqual({});
    expect(body.settings).toEqual({
      retention_months: 24,
      ai_enabled: false,
      pdf_ai_enabled: false,
      csv_layouts: {},
      accounts: {},
    });
    expect(body.categories).toEqual([
      { id: 'cat-Groceries', name: 'Groceries' },
      { id: 'cat-Dining', name: 'Dining' },
      { id: 'cat-Debt Payments', name: 'Debt Payments' },
    ]);
  });

  it('ignores rules whose category was deleted and keeps kind-only rules', () => {
    addRule('NETFLIX', 'cat-Dining', 'expense');
    addRule('PAYROLL', null, 'income');
    addRule('GONE', 'cat-deleted', 'expense');
    const rules = api.getSmartImportContext().rules;
    expect(rules.map((r) => r.merchant_key)).toEqual(['NETFLIX', 'PAYROLL']);
    expect(rules[0]).toEqual({
      id: 'rule-NETFLIX',
      merchant_key: 'NETFLIX',
      category_id: 'cat-Dining',
      kind: 'expense',
    });
  });

  it('lists accounts from the newest meta row per key, sorted by label', () => {
    addImport('i1', {
      hash: 'h1',
      key: 'acct:one',
      label: 'Old name',
      last4: '1111',
      created: '2026-08-01 00:00:00',
    });
    addImport('i2', {
      hash: 'h2',
      key: 'acct:one',
      label: 'Everyday',
      liabilityId: 'L1',
      created: '2026-09-01 00:00:00',
    });
    addImport('i3', {
      hash: 'h3',
      key: 'label:cash',
      label: 'Cash',
      last4: null,
      kind: 'savings',
      institution: null,
      created: '2026-07-01 00:00:00',
    });
    addImport('i4', { hash: 'h4', key: null, created: '2026-09-05 00:00:00' });
    expect(api.getSmartImportContext().accounts).toEqual([
      {
        account_key: 'label:cash',
        label: 'Cash',
        last4: null,
        kind: 'savings',
        institution: null,
        liability_id: null,
      },
      {
        account_key: 'acct:one',
        label: 'Everyday',
        last4: '1234',
        kind: 'checking',
        institution: 'Sample Bank',
        liability_id: 'L1',
      },
    ]);
  });

  it('orders meta rows correctly when created_at mixes the T and space spellings', () => {
    addImport('i1', {
      hash: 'h1',
      key: 'acct:one',
      label: 'Space',
      created: '2026-09-01 08:00:00',
    });
    addImport('i2', {
      hash: 'h2',
      key: 'acct:one',
      label: 'T form',
      created: '2026-09-01T09:00:00.000Z',
    });
    expect(api.getSmartImportContext().accounts[0]!.label).toBe('T form');
  });

  it('lets a saved account label win', () => {
    addImport('i1', { hash: 'h1', key: 'acct:one', label: 'Everyday' });
    api.putSmartImportSettings({ accounts: { 'acct:one': 'Joint checking' } });
    expect(api.getSmartImportContext().accounts[0]!.label).toBe('Joint checking');
  });

  it('returns remembered csv layouts', () => {
    const layout = { [LAYOUT_SIG]: { date: 'Posted', description: 'Memo', amount: 'Amt' } };
    api.putSmartImportSettings({ csv_layouts: layout });
    expect(api.getSmartImportContext().csv_layouts).toEqual(layout);
  });
});

describe('preview', () => {
  it('returns existing dedupe keys, sorted and distinct', () => {
    addImport('i1', { hash: HASH_B, key: 'acct:one' });
    addTxn('i1', 'acct:one', { dedupe: 'acct:one|k1' });
    addTxn('i1', 'acct:one', { dedupe: 'acct:one|k2' });
    const body = preview(
      stmt({ dedupe_keys: ['acct:one|k2', 'acct:one|new', 'acct:one|k1'] }),
      stmt({ file_hash: HASH_B, dedupe_keys: ['acct:one|k1'] })
    );
    expect(body.existing_dedupe_keys).toEqual(['acct:one|k1', 'acct:one|k2']);
  });

  it('sorts keys by code point, like the server', () => {
    addImport('i1', { hash: HASH_B, key: 'acct:one' });
    const astral = String.fromCodePoint(0x1f600);
    const bmp = String.fromCharCode(0xff5e);
    addTxn('i1', 'acct:one', { dedupe: astral });
    addTxn('i1', 'acct:one', { dedupe: bmp });
    expect(preview(stmt({ dedupe_keys: [astral, bmp] })).existing_dedupe_keys).toEqual([
      bmp,
      astral,
    ]);
  });

  it('finds existing keys across chunks', () => {
    addImport('i1', { hash: HASH_B, key: 'acct:one' });
    db.execute('SAVEPOINT bulk');
    for (let n = 0; n < 1200; n++)
      addTxn('i1', 'acct:one', { dedupe: `acct:one|${n}`, merchant: 'X' });
    db.execute('RELEASE bulk');
    const keys = Array.from({ length: 1500 }, (_, n) => `acct:one|${n}`);
    expect(preview(stmt({ dedupe_keys: keys })).existing_dedupe_keys).toHaveLength(1200);
  });

  it('reports prior files, including the hash:index spelling', () => {
    addImport('i1', { hash: HASH_A, key: 'acct:one', uploaded: '2026-09-03 08:30:00' });
    addImport('i2', { hash: `${HASH_B}:1`, key: 'acct:two', uploaded: '2026-09-04 00:00:00' });
    const body = preview(
      stmt({ file_hash: HASH_A }),
      stmt({ file_hash: HASH_B }),
      stmt({ file_hash: 'c'.repeat(64) })
    );
    expect(body.prior_files).toEqual([
      { file_hash: HASH_A, import_id: 'i1', imported_at: '2026-09-03T08:30:00' },
      { file_hash: HASH_B, import_id: 'i2', imported_at: '2026-09-04T00:00:00' },
    ]);
  });

  it('does not treat a longer hash with the same prefix as a prior file', () => {
    addImport('i1', { hash: `${HASH_A}x`, key: 'acct:one' });
    expect(preview(stmt({ file_hash: HASH_A })).prior_files).toEqual([]);
  });

  it('picks the newest of several prior imports and lists a shared hash once', () => {
    addImport('i1', { hash: HASH_A, key: 'acct:one', uploaded: '2026-09-01 00:00:00' });
    addImport('i2', { hash: `${HASH_A}:2`, key: 'acct:two', uploaded: '2026-09-02 00:00:00' });
    const body = preview(
      stmt({ file_hash: HASH_A }),
      stmt({ file_hash: HASH_A, account_key: 'acct:two' })
    );
    expect(body.prior_files.map((p) => p.import_id)).toEqual(['i2']);
  });

  it('falls back to uploaded_at when analyzed_at is empty', () => {
    db.execute(
      `INSERT INTO bank_statement_imports (id, file_name, content_hash, status, uploaded_at) VALUES ('leg', 'x', ?, 'pending', '2026-08-01 10:00:00')`,
      [HASH_A]
    );
    expect(preview(stmt()).prior_files[0]!.imported_at).toBe('2026-08-01T10:00:00');
  });

  it('prefers the previous import for a liability', () => {
    addLiability('L-prev', 'Visa', { lender: 'Other Bank' });
    addLiability('L-lender', 'Sample Card', { lender: 'Sample Bank' });
    addImport('i1', {
      hash: 'h1',
      key: 'acct:card',
      kind: 'credit_card',
      liabilityId: 'L-prev',
      created: '2026-08-01 00:00:00',
    });
    const body = preview(
      stmt({ account_key: 'acct:card', account_kind: 'credit_card', institution: 'Sample Bank' })
    );
    expect(body.liability_suggestions).toEqual([
      {
        file_hash: HASH_A,
        account_key: 'acct:card',
        liability_id: 'L-prev',
        reason: 'previous_import',
      },
    ]);
  });

  it('matches a liability by lender', () => {
    addLiability('L1', 'Rewards Card', { lender: 'sample bank' });
    const body = preview(
      stmt({ account_key: 'acct:card', account_kind: 'credit_card', institution: 'Sample Bank' })
    );
    expect(body.liability_suggestions).toEqual([
      { file_hash: HASH_A, account_key: 'acct:card', liability_id: 'L1', reason: 'lender_match' },
    ]);
  });

  it('matches by name and respects the card or loan fit', () => {
    addLiability('L-mort', 'Sample Bank Mortgage', { type: 'mortgage', lender: 'Sample Bank' });
    addLiability('L-card', 'Sample Bank Card', { type: 'credit_card' });
    expect(
      preview(stmt({ account_kind: 'credit_card', institution: 'Sample Bank' }))
        .liability_suggestions[0]!.liability_id
    ).toBe('L-card');
    expect(
      preview(stmt({ account_kind: 'loan', institution: 'Sample Bank' })).liability_suggestions[0]!
        .liability_id
    ).toBe('L-mort');
  });

  it('uses an exact match before a contains match, and needs 3 characters for contains', () => {
    addLiability('A', 'Aaa Contains Sample Bank Inc', { lender: 'Sample Bank Inc' });
    addLiability('B', 'Zzz', { lender: 'Sample Bank' });
    expect(
      preview(stmt({ account_kind: 'credit_card', institution: 'sample bank' }))
        .liability_suggestions[0]!.liability_id
    ).toBe('B');
    expect(
      preview(stmt({ account_kind: 'credit_card', institution: 'sa' })).liability_suggestions
    ).toEqual([]);
    expect(
      preview(stmt({ account_kind: 'credit_card', institution: '  ' })).liability_suggestions
    ).toEqual([]);
  });

  it('never suggests an archived liability', () => {
    addLiability('L-old', 'Sample Card', { lender: 'Sample Bank', active: false });
    addLiability('L-prev', 'Visa', { active: false });
    addImport('i1', { hash: 'h1', key: 'acct:card', kind: 'credit_card', liabilityId: 'L-prev' });
    expect(
      preview(
        stmt({ account_key: 'acct:card', account_kind: 'credit_card', institution: 'Sample Bank' })
      ).liability_suggestions
    ).toEqual([]);
  });

  it('falls back to a lender match when the previous liability is gone', () => {
    addLiability('L1', 'Rewards', { lender: 'Sample Bank' });
    addImport('i1', { hash: 'h1', key: 'acct:card', kind: 'credit_card', liabilityId: 'gone' });
    const body = preview(
      stmt({ account_key: 'acct:card', account_kind: 'credit_card', institution: 'Sample Bank' })
    );
    expect(body.liability_suggestions[0]!.reason).toBe('lender_match');
  });

  it('makes no suggestion for a checking statement', () => {
    addLiability('L1', 'Rewards', { lender: 'Sample Bank' });
    expect(
      preview(stmt({ account_kind: 'checking', institution: 'Sample Bank' })).liability_suggestions
    ).toEqual([]);
  });

  it('returns outflows from the last 400 days, ordered, with the edge day included', () => {
    addImport('i1', { hash: 'h1', key: 'acct:one' });
    addTxn('i1', 'acct:one', { dedupe: 'd1', amount: -15.49, posted: '2026-09-04' });
    addTxn('i1', 'acct:one', { dedupe: 'd2', amount: -15.49, posted: '2025-09-01' }); // 399 days
    addTxn('i1', 'acct:one', { dedupe: 'd3', amount: -15.49, posted: '2025-08-30' }); // 400 days, in
    addTxn('i1', 'acct:one', { dedupe: 'd3b', amount: -15.49, posted: '2025-08-29' }); // 401 days, out
    addTxn('i1', 'acct:one', { dedupe: 'd4', amount: 20, posted: '2026-09-04' });
    addTxn('i1', 'acct:one', { dedupe: 'd5', merchant: 'OTHER', amount: -9, posted: '2026-09-04' });
    expect(preview(stmt({ merchant_keys: ['NETFLIX'] })).history).toEqual([
      { merchant_key: 'NETFLIX', posted_date: '2025-08-30', amount: -15.49 },
      { merchant_key: 'NETFLIX', posted_date: '2025-09-01', amount: -15.49 },
      { merchant_key: 'NETFLIX', posted_date: '2026-09-04', amount: -15.49 },
    ]);
  });

  it('truncates merchant keys to 120 characters before matching', () => {
    addImport('i1', { hash: 'h1', key: 'acct:one' });
    const stored = 'M'.repeat(120);
    addTxn('i1', 'acct:one', { dedupe: 'd1', merchant: stored, amount: -5, posted: '2026-09-04' });
    expect(preview(stmt({ merchant_keys: ['M'.repeat(119)] })).history).toHaveLength(0);
    expect(preview(stmt({ merchant_keys: ['M'.repeat(130)] })).history).toHaveLength(1);
  });

  it('handles an empty statement list and writes nothing', () => {
    expect(preview()).toEqual({
      existing_dedupe_keys: [],
      prior_files: [],
      liability_suggestions: [],
      history: [],
    });
    const before = counts();
    preview(stmt({ dedupe_keys: ['k'], merchant_keys: ['m'] }));
    expect(counts()).toEqual(before);
  });

  it.each([
    ['empty object', {}],
    ['statements not a list', { statements: 'x' }],
    ['null body', null],
    ['extra top-level key', { statements: [], extra: 1 }],
    ['empty hash', { statements: [stmt({ file_hash: '' })] }],
    ['hash with a space', { statements: [stmt({ file_hash: 'has space' })] }],
    ['hash with a trailing newline', { statements: [stmt({ file_hash: `${HASH_A}\n` })] }],
    ['hash over 100 chars', { statements: [stmt({ file_hash: 'a'.repeat(101) })] }],
    ['unknown kind', { statements: [stmt({ account_kind: 'boat' })] }],
    ['missing kind', { statements: [(({ account_kind: _k, ...rest }) => rest)(stmt())] }],
    ['extra statement key', { statements: [stmt({ extra: 'no' })] }],
    ['13 statements', { statements: Array.from({ length: 13 }, () => stmt()) }],
    ['10001 dedupe keys', { statements: [stmt({ dedupe_keys: Array(10_001).fill('k') })] }],
    ['dedupe key over 400', { statements: [stmt({ dedupe_keys: ['k'.repeat(401)] })] }],
    ['non-string merchant key', { statements: [stmt({ merchant_keys: [1] })] }],
    ['missing dedupe_keys', { statements: [(({ dedupe_keys: _d, ...rest }) => rest)(stmt())] }],
    ['account_key over 200', { statements: [stmt({ account_key: 'k'.repeat(201) })] }],
    ['institution over 120', { statements: [stmt({ institution: 'k'.repeat(121) })] }],
  ])('rejects %s with a fixed 422', (_name, body) => {
    expectBadRequest(() => api.previewSmartImport(body));
  });

  it('counts characters, not UTF-16 units, for the length limits', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(() => preview(stmt({ dedupe_keys: [emoji.repeat(400)] }))).not.toThrow();
    expectBadRequest(() => preview(stmt({ dedupe_keys: [emoji.repeat(401)] })));
  });

  it('accepts missing optional fields', () => {
    const { account_key: _a, institution: _i, ...rest } = stmt();
    expect(() => preview(rest)).not.toThrow();
  });
});

describe('imports', () => {
  it('lists smart imports newest first', () => {
    addImport('i1', { hash: 'h1', key: 'acct:one', created: '2026-08-01 00:00:00', batch: 'b1' });
    addImport('i2', {
      hash: 'h2',
      key: 'acct:one',
      created: '2026-09-01 00:00:00',
      batch: 'b2',
      origin: 'sample',
    });
    const rows = api.getSmartImports();
    expect(rows.map((r) => r.import_id)).toEqual(['i2', 'i1']);
    expect(rows[0]).toEqual({
      import_id: 'i2',
      batch_id: 'b2',
      file_name: 'i2.csv',
      origin: 'sample',
      format: 'csv',
      parser: 'csv',
      account_kind: 'checking',
      account_key: 'acct:one',
      account_label: 'Main',
      account_last4: '1234',
      institution: 'Sample Bank',
      period_start: null,
      period_end: null,
      closing_balance: null,
      closing_balance_date: null,
      liability_id: null,
      txn_new: 0,
      txn_duplicate: 0,
      txn_excluded: 0,
      ai_used: 0,
      ai_provider: null,
      connection_id: null,
      imported_at: '2026-09-01T00:00:00',
    });
  });

  it('returns the connection of a synced import', () => {
    const cid = '0f0e0d0c-0b0a-4908-8706-050403020100';
    addImport('i1', { hash: 'h1', key: 'acct:one', origin: 'connector', connectionId: cid });
    addImport('i2', { hash: 'h2', key: 'acct:one', created: '2026-09-02 00:00:00' });
    const rows = Object.fromEntries(api.getSmartImports().map((r) => [r.import_id, r]));
    expect(rows['i1']!.connection_id).toBe(cid);
    expect(rows['i2']!.connection_id).toBeNull();
  });

  it('skips legacy imports with no meta row', () => {
    db.execute(
      `INSERT INTO bank_statement_imports (id, file_name, content_hash, status) VALUES ('legacy', 'old.csv', 'hz', 'analyzed')`
    );
    expect(api.getSmartImports()).toEqual([]);
  });
});

describe('rules', () => {
  it('lists rules with the category name and the deleted flag', () => {
    addRule('NETFLIX', 'cat-Dining', 'expense', undefined, 3);
    addRule('GONE', 'cat-deleted', 'expense');
    const rules = api.getMerchantRules();
    expect(rules.map((r) => r.merchant_key)).toEqual(['GONE', 'NETFLIX']);
    const [gone, netflix] = rules as [Row, Row];
    expect(gone.category_deleted).toBe(true);
    expect(gone.category_name).toBeNull();
    expect(netflix.category_deleted).toBe(false);
    expect(netflix.category_name).toBe('Dining');
    expect(netflix.hits).toBe(3);
    expect(netflix.source).toBe('user');
    expect(netflix.kind).toBe('expense');
    expect(Object.keys(netflix).sort()).toEqual([
      'category_deleted',
      'category_id',
      'category_name',
      'hits',
      'id',
      'kind',
      'merchant_key',
      'source',
      'updated_at',
    ]);
  });

  it('returns null category_name and false deleted for a kind-only rule', () => {
    addRule('PAYROLL', null, 'income');
    const [rule] = api.getMerchantRules();
    expect(rule!.category_name).toBeNull();
    expect(rule!.category_deleted).toBe(false);
  });

  it('returns updated_at as server-style ISO text', () => {
    addRule('NETFLIX', 'cat-Dining', 'expense');
    db.execute("UPDATE merchant_rules SET updated_at = '2026-09-03 08:30:00'");
    expect(api.getMerchantRules()[0]!.updated_at).toBe('2026-09-03T08:30:00');
  });

  it('deletes only the rule row', () => {
    addRule('NETFLIX', 'cat-Dining', 'expense', 'r1');
    addRule('OTHER', null, 'income', 'r2');
    expect(api.deleteMerchantRule('r1')).toEqual({ deleted: true });
    expect(api.getMerchantRules().map((r) => r.id)).toEqual(['r2']);
    expect(db.query('SELECT 1 FROM budget_expense_categories')).toHaveLength(3);
  });

  it('answers 404 rule_not_found for an unknown id', () => {
    try {
      api.deleteMerchantRule('nope');
      throw new Error('expected a 404');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartImportHttpError);
      expect((e as SmartImportHttpError).status).toBe(404);
      expect((e as SmartImportHttpError).body()).toEqual({
        error_type: 'rule_not_found',
        detail: 'Rule not found.',
      });
    }
  });
});

describe('settings', () => {
  it('round trips every field', () => {
    expect(api.getSmartImportSettings().retention_months).toBe(24);
    const layout = { [LAYOUT_SIG]: { date: 'Posted', description: 'Memo', amount: 'Amt' } };
    const expected = {
      retention_months: 36,
      ai_enabled: true,
      pdf_ai_enabled: true,
      csv_layouts: layout,
      accounts: { 'acct:one': 'Joint', 'label:cash': 'Cash' },
    };
    expect(api.putSmartImportSettings(expected)).toEqual(expected);
    expect(api.getSmartImportSettings()).toEqual(expected);
  });

  it('is partial and stores only the fixed row with the five keys', () => {
    api.putSmartImportSettings({ ai_enabled: true });
    api.putSmartImportSettings({ retention_months: 0 });
    const body = api.getSmartImportSettings();
    expect(body.ai_enabled).toBe(true);
    expect(body.retention_months).toBe(0);
    const rows = db.query<Row>('SELECT key, value FROM app_settings WHERE key = ?', [
      'smart_import',
    ]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(JSON.parse(rows[0]!.value)).sort()).toEqual([
      'accounts',
      'ai_enabled',
      'csv_layouts',
      'pdf_ai_enabled',
      'retention_months',
    ]);
    const unrelated = db.query("SELECT key FROM app_settings WHERE key LIKE 'smart_import%'");
    expect(unrelated).toHaveLength(1);
  });

  it('treats an empty PUT as a no-op that writes nothing, not even the default row', () => {
    expect(api.putSmartImportSettings({}).retention_months).toBe(24);
    expect(counts().settings).toBe(0);
    api.putSmartImportSettings({ retention_months: 12 });
    db.execute("UPDATE app_settings SET updated_at = 'stamp' WHERE key = 'smart_import'");
    expect(api.putSmartImportSettings({}).retention_months).toBe(12);
    expect(
      db.query<Row>("SELECT updated_at FROM app_settings WHERE key = 'smart_import'")[0]!.updated_at
    ).toBe('stamp');
  });

  it('sets updated_at on a write', () => {
    api.putSmartImportSettings({ ai_enabled: true });
    const row = db.query<Row>("SELECT updated_at FROM app_settings WHERE key = 'smart_import'")[0]!;
    expect(row.updated_at).toBe(new Date().toISOString());
  });

  it('does not let a trailing newline pass the key patterns', () => {
    const badSig = { [`${LAYOUT_SIG}\n`]: { date: 'A' } };
    expectBadRequest(() => api.putSmartImportSettings({ csv_layouts: badSig }));
    expectBadRequest(() => api.putSmartImportSettings({ accounts: { 'acct:one\n': 'x' } }));
    db.execute("INSERT INTO app_settings (key, value, encrypted) VALUES ('smart_import', ?, 0)", [
      JSON.stringify({ csv_layouts: badSig }),
    ]);
    expect(api.getSmartImportSettings().csv_layouts).toEqual({});
  });

  it.each([0, 12, 24, 36])('accepts retention_months %i', (months) => {
    expect(api.putSmartImportSettings({ retention_months: months }).retention_months).toBe(months);
  });

  const many = (n: number, make: (i: number) => [string, unknown]): Record<string, unknown> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));

  it.each<[string, unknown]>([
    ['retention 13', { retention_months: 13 }],
    ['retention -1', { retention_months: -1 }],
    ['retention string', { retention_months: '12' }],
    ['retention fraction', { retention_months: 12.5 }],
    ['retention bool', { retention_months: false }],
    ['retention null', { retention_months: null }],
    ['ai_enabled string', { ai_enabled: 'true' }],
    ['ai_enabled number', { ai_enabled: 1 }],
    ['ai_enabled null', { ai_enabled: null }],
    ['pdf_ai_enabled string', { pdf_ai_enabled: 'yes' }],
    ['unknown key', { unknown_key: 1 }],
    ['secret-looking key', { app_password: 'x' }],
    ['null body', null],
    ['array body', []],
    ['short layout signature', { csv_layouts: { short: { date: 'A' } } }],
    ['unmappable field', { csv_layouts: { [LAYOUT_SIG]: { bogus: 'A' } } }],
    ['bank_category is not mappable', { csv_layouts: { [LAYOUT_SIG]: { bank_category: 'A' } } }],
    ['empty header name', { csv_layouts: { [LAYOUT_SIG]: { date: '' } } }],
    ['numeric header name', { csv_layouts: { [LAYOUT_SIG]: { date: 5 } } }],
    ['long header name', { csv_layouts: { [LAYOUT_SIG]: { date: 'x'.repeat(201) } } }],
    ['empty mapping', { csv_layouts: { [LAYOUT_SIG]: {} } }],
    ['upper-case signature', { csv_layouts: { ['C'.repeat(64)]: { date: 'A' } } }],
    [
      'too many layouts',
      { csv_layouts: many(51, (n) => [n.toString(16).padStart(64, '0'), { date: 'A' }]) },
    ],
    ['layouts as list', { csv_layouts: [] }],
    ['plain account key', { accounts: { plain: 'x' } }],
    ['empty label', { accounts: { 'acct:one': '' } }],
    ['long label', { accounts: { 'acct:one': 'x'.repeat(121) } }],
    ['numeric label', { accounts: { 'acct:one': 5 } }],
    ['too many accounts', { accounts: many(201, (n) => [`acct:${n}`, 'x']) }],
    ['accounts as list', { accounts: ['acct:one'] }],
    ['control character in key', { accounts: { 'acct:a\u0001b': 'x' } }],
  ])('rejects %s with a fixed 422 and writes nothing', (_name, body) => {
    const before = counts();
    expectBadRequest(() => api.putSmartImportSettings(body));
    expect(counts()).toEqual(before);
  });

  it('accepts the maximum map sizes', () => {
    const layouts = many(50, (n) => [n.toString(16).padStart(64, '0'), { date: 'A' }]);
    const accounts = many(200, (n) => [`acct:${n}`, 'x']);
    const out = api.putSmartImportSettings({ csv_layouts: layouts, accounts });
    expect(Object.keys(out.csv_layouts)).toHaveLength(50);
    expect(Object.keys(out.accounts)).toHaveLength(200);
  });

  it('sanitizes junk in the stored row on read', () => {
    db.execute("INSERT INTO app_settings (key, value, encrypted) VALUES ('smart_import', ?, 0)", [
      JSON.stringify({
        retention_months: 7,
        ai_enabled: 'yes',
        csv_layouts: [1],
        accounts: 'x',
        evil: 'x',
      }),
    ]);
    expect(api.getSmartImportSettings()).toEqual({
      retention_months: 24,
      ai_enabled: false,
      pdf_ai_enabled: false,
      csv_layouts: {},
      accounts: {},
    });
  });

  it('keeps valid entries and drops invalid ones inside a stored map', () => {
    db.execute("INSERT INTO app_settings (key, value, encrypted) VALUES ('smart_import', ?, 0)", [
      JSON.stringify({
        accounts: { 'acct:ok': 'Good', bad: 'x', 'acct:empty': '' },
        ai_enabled: true,
      }),
    ]);
    const s = api.getSmartImportSettings();
    expect(s.accounts).toEqual({ 'acct:ok': 'Good' });
    expect(s.ai_enabled).toBe(true);
  });

  it('survives a corrupt stored row', () => {
    db.execute(
      "INSERT INTO app_settings (key, value, encrypted) VALUES ('smart_import', '{not json', 0)"
    );
    expect(api.getSmartImportSettings().retention_months).toBe(24);
    expect(api.putSmartImportSettings({ retention_months: 12 }).retention_months).toBe(12);
  });
});

describe('fixed errors and logging', () => {
  const planted = 'ZQXSECRET';
  const logged = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

  it('turns an unexpected read failure into a fixed 500 without content', () => {
    addRule(planted, 'cat-Dining', 'expense', 'r1');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(db, 'query').mockImplementation(() => {
      throw new Error(`leak ${planted} 99.99`);
    });
    try {
      api.getMerchantRules();
      throw new Error('expected a 500');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartImportHttpError);
      expect((e as SmartImportHttpError).status).toBe(500);
      expect((e as SmartImportHttpError).body()).toEqual({
        error_type: 'server_error',
        detail: 'Something went wrong.',
      });
      expect((e as Error).message).not.toContain(planted);
    }
    expect(logged(spy)).not.toContain(planted);
    expect(logged(spy)).not.toContain('99.99');
  });

  it('turns a settings write failure into a fixed 500, rolls back, and keeps the old value', () => {
    api.putSmartImportSettings({ retention_months: 12 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO app_settings')) throw new Error(`leak ${planted}`);
      return real(sql, params);
    });
    try {
      api.putSmartImportSettings({ accounts: { 'acct:one': planted } });
      throw new Error('expected a 500');
    } catch (e) {
      expect((e as SmartImportHttpError).status).toBe(500);
      expect((e as SmartImportHttpError).body()).toEqual({
        error_type: 'save_failed',
        detail: 'The change could not be saved.',
      });
    }
    vi.restoreAllMocks();
    expect(logged(spy)).not.toContain(planted);
    expect(api.getSmartImportSettings().retention_months).toBe(12);
    expect(api.getSmartImportSettings().accounts).toEqual({});
  });

  it('rolls a failed rule delete back cleanly and releases its savepoint', () => {
    addRule('KEEP', null, 'income', 'r1');
    const real = db.execute.bind(db);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.startsWith('DELETE FROM merchant_rules')) throw new Error('boom');
      return real(sql, params);
    });
    expect(() => api.deleteMerchantRule('r1')).toThrow(SmartImportHttpError);
    vi.restoreAllMocks();
    expect(api.getMerchantRules()).toHaveLength(1);
    // the savepoint was released: a second call works
    expect(api.deleteMerchantRule('r1')).toEqual({ deleted: true });
  });

  it('logs no planted values across every call, success and failure', () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
    ];
    const secret = 'ZQXPLANTED WIDGETS';
    addImport('i1', { hash: HASH_B, key: 'acct:one', label: secret });
    addTxn('i1', 'acct:one', {
      dedupe: 'acct:one|zqx',
      merchant: secret,
      amount: -4242.42,
      posted: '2026-10-01',
    });
    addRule(secret, 'cat-Dining', 'expense', 'r1');
    api.getSmartImportContext();
    preview(stmt({ dedupe_keys: ['acct:one|zqx'], merchant_keys: [secret], institution: secret }));
    api.getSmartImports();
    api.getMerchantRules();
    api.putSmartImportSettings({ accounts: { 'acct:one': secret } });
    expect(() => api.putSmartImportSettings({ retention_months: 99 })).toThrow();
    api.deleteMerchantRule('r1');
    expect(() => api.deleteMerchantRule('missing')).toThrow();
    const text = spies.map(logged).join('\n');
    for (const s of [secret, 'ZQXPLANTED', '4242', 'acct:one|zqx']) expect(text).not.toContain(s);
  });
});
