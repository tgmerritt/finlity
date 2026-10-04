import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  addFile,
  applyCategorizeResponse,
  applyPreview,
  acceptAllSuggestions,
  buildAnalyzeContext,
  ApplyTooLargeError,
  buildApplyRequest,
  buildSettingsPatch,
  csvHeaderSignature,
  forgetMerchant,
  layoutFor,
  setAiProvider,
  setFileMapping,
  accountKey,
  buildCategorizeRequest,
  buildPreviewRequest,
  createWizardState,
  filterRows,
  mergeAnalyze,
  markFileError,
  recurringRequest,
  reviewCounts,
  setCategory,
  setExcluded,
  setKind,
  setRecurring,
  setStatement,
  updateRecurring,
  type WizardState,
} from '@/utils/smart-import-state';
import type {
  AnalyzeResponse,
  NormalizedStatement,
  NormalizedTransaction,
  PreviewResponse,
  SmartImportContext,
} from '@/types/api';

const HASH = 'a'.repeat(64);
const CATS = [
  { id: 'c-food', name: 'Food' },
  { id: 'c-fun', name: 'Fun' },
  { id: 'c-home', name: 'Home' },
];
const CTX: SmartImportContext = {
  rules: [{ id: 'r1', merchant_key: 'NETFLIX', category_id: 'c-fun', kind: null }],
  categories: CATS,
  accounts: [],
  csv_layouts: {},
  settings: {
    retention_months: 24,
    ai_enabled: false,
    pdf_ai_enabled: false,
    csv_layouts: {},
    accounts: {},
  },
};

let rowNo = 0;
function txn(over: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  rowNo += 1;
  return {
    row: rowNo,
    posted_date: '2026-09-01',
    amount: -10,
    description: 'masked description',
    merchant_key: 'CAFE',
    kind: 'expense',
    category_id: null,
    category_source: 'none',
    external_id: null,
    dedupe_base: `base${rowNo}`,
    ...over,
  };
}

function stmt(
  txns: NormalizedTransaction[],
  over: Partial<NormalizedStatement> = {}
): NormalizedStatement {
  return {
    file_hash: HASH,
    file_name: 'bank.csv',
    origin: 'file',
    format: 'csv',
    parser: 'csv',
    account: { kind: 'checking', key: 'acct:1', last4: '1234', institution: 'Bank' },
    period: { start: '2026-09-01', end: '2026-09-30' },
    closing_balance: null,
    extras: null,
    warnings: [],
    transactions: txns,
    ...over,
  };
}

function ok(...statements: NormalizedStatement[]): AnalyzeResponse {
  return { status: 'ok', statements };
}

function fresh(): WizardState {
  rowNo = 0;
  let s = createWizardState(CTX, 'batch-1');
  s = addFile(s, { id: 'f1', file_name: 'bank.csv', origin: 'file' });
  return s;
}

function loaded(
  txns: NormalizedTransaction[],
  over: Partial<NormalizedStatement> = {}
): WizardState {
  return mergeAnalyze(fresh(), 'f1', ok(stmt(txns, over)));
}

describe('buildAnalyzeContext', () => {
  it('passes rules, categories and only the overrides that are set', () => {
    expect(buildAnalyzeContext(CTX, {})).toEqual({ rules: CTX.rules, categories: CATS });
    expect(
      buildAnalyzeContext(CTX, {
        origin: 'sample',
        mapping: { date: 'Date' },
        account_kind: 'credit_card',
        flip_sign: true,
        date_order: 'dmy',
      })
    ).toEqual({
      rules: CTX.rules,
      categories: CATS,
      origin: 'sample',
      mapping: { date: 'Date' },
      account_kind: 'credit_card',
      flip_sign: true,
      date_order: 'dmy',
    });
  });
});

describe('mergeAnalyze', () => {
  it('turns statements into rows with stable ids and the parser categorization', () => {
    const s = loaded([
      txn({ merchant_key: 'NETFLIX', category_id: 'c-fun', category_source: 'rule' }),
      txn(),
    ]);
    expect(s.statements).toHaveLength(1);
    expect(s.statements[0]).toMatchObject({
      id: 'f1:0',
      file_id: 'f1',
      account_key: 'acct:1',
      account_kind: 'checking',
      skipped: false,
      liability_id: null,
    });
    expect(s.rows.map((r) => r.id)).toEqual(['f1:0:1', 'f1:0:2']);
    expect(s.rows[0]).toMatchObject({
      category_id: 'c-fun',
      category_source: 'rule',
      excluded: false,
    });
    expect(s.rows[1]).toMatchObject({
      category_id: null,
      category_source: 'none',
      duplicate: false,
    });
    expect(s.files[0]!.status).toBe('ok');
  });

  it('does not mutate the input state', () => {
    const before = fresh();
    const snapshot = JSON.stringify(before);
    mergeAnalyze(before, 'f1', ok(stmt([txn()])));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('creates one statement per OFX statement of a file', () => {
    const s = mergeAnalyze(
      fresh(),
      'f1',
      ok(
        stmt([txn()], { format: 'ofx' }),
        stmt([txn()], {
          format: 'ofx',
          account: { kind: 'credit_card', key: 'acct:2', last4: '5678', institution: null },
        })
      )
    );
    expect(s.statements.map((x) => x.id)).toEqual(['f1:0', 'f1:1']);
    expect(s.rows.map((r) => r.statement_id)).toEqual(['f1:0', 'f1:1']);
  });

  it('replaces the previous rows of the same file on re-analyze and keeps the file options', () => {
    let s = loaded([txn(), txn()]);
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    s = { ...s, files: s.files.map((f) => ({ ...f, options: { flip_sign: true } })) };
    s = mergeAnalyze(s, 'f1', ok(stmt([txn()])));
    expect(s.rows).toHaveLength(1);
    expect(s.files[0]!.options.flip_sign).toBe(true);
  });

  it('keeps other files untouched', () => {
    let s = loaded([txn()]);
    s = addFile(s, { id: 'f2', file_name: 'b.ofx', origin: 'file' });
    s = mergeAnalyze(s, 'f2', ok(stmt([txn(), txn()], { file_hash: 'b'.repeat(64) })));
    s = mergeAnalyze(s, 'f1', ok(stmt([txn()])));
    expect(s.rows.filter((r) => r.statement_id.startsWith('f2'))).toHaveLength(2);
  });

  it('records needs_mapping and needs_ai_layout without rows', () => {
    let s = mergeAnalyze(fresh(), 'f1', {
      status: 'needs_mapping',
      headers: ['A', 'B'],
      sample_rows: [['1', '2']],
    });
    expect(s.files[0]).toMatchObject({ status: 'needs_mapping', headers: ['A', 'B'] });
    expect(s.rows).toHaveLength(0);
    s = mergeAnalyze(s, 'f1', {
      status: 'needs_ai_layout',
      file_hash: HASH,
      line_count: 2,
      lines: ['a', 'b'],
    });
    expect(s.files[0]).toMatchObject({ status: 'needs_ai_layout', file_hash: HASH, line_count: 2 });
    expect(s.files[0]!.lines).toEqual(['a', 'b']);
  });

  it('keeps the file hash from the layout answer when the AI extract result arrives', () => {
    let s = mergeAnalyze(fresh(), 'f1', {
      status: 'needs_ai_layout',
      file_hash: HASH,
      line_count: 1,
      lines: ['x'],
    });
    s = mergeAnalyze(
      s,
      'f1',
      ok(stmt([txn()], { file_hash: 'c'.repeat(64), parser: 'pdf:ai', format: 'pdf' }))
    );
    expect(s.statements[0]!.file_hash).toBe(HASH);
  });

  it('records a file error as a code only', () => {
    const s = markFileError(fresh(), 'f1', 'unreadable');
    expect(s.files[0]).toMatchObject({ status: 'error', error_type: 'unreadable' });
  });
});

describe('preview', () => {
  it('builds dedupe keys from the account key and falls back to a label key', () => {
    let s = loaded([txn({ dedupe_base: 'zz', merchant_key: 'A' })], {
      account: { kind: 'checking', key: null, last4: null, institution: null },
    });
    expect(buildPreviewRequest(s).statements).toEqual([]);
    s = setStatement(s, 'f1:0', { account_label: '  My Checking ' });
    const req = buildPreviewRequest(s);
    expect(req.statements).toEqual([
      {
        file_hash: HASH,
        account_key: 'label:my checking',
        account_kind: 'checking',
        institution: null,
        dedupe_keys: ['label:my checking|zz'],
        merchant_keys: ['A'],
      },
    ]);
  });

  it('marks existing and in-batch duplicates and keeps the suggestion unapplied', () => {
    let s = mergeAnalyze(
      fresh(),
      'f1',
      ok(
        stmt([txn({ dedupe_base: 'k1' }), txn({ dedupe_base: 'k2' }), txn({ dedupe_base: 'k3' })], {
          account: { kind: 'credit_card', key: 'acct:1', last4: '1', institution: null },
        })
      )
    );
    s = addFile(s, { id: 'f2', file_name: 'again.csv', origin: 'file' });
    s = mergeAnalyze(
      s,
      'f2',
      ok(stmt([txn({ dedupe_base: 'k3' })], { file_hash: 'b'.repeat(64) }))
    );
    const preview: PreviewResponse = {
      existing_dedupe_keys: ['acct:1|k1'],
      prior_files: [{ file_hash: HASH, import_id: 'i1', imported_at: '2026-09-02T10:00:00' }],
      liability_suggestions: [
        { file_hash: HASH, account_key: 'acct:1', liability_id: 'L1', reason: 'previous_import' },
      ],
      history: [{ merchant_key: 'CAFE', posted_date: '2026-08-01', amount: -9 }],
    };
    s = applyPreview(s, preview);
    expect(s.rows.map((r) => r.duplicate)).toEqual([true, false, false, true]);
    expect(s.statements[0]).toMatchObject({
      prior_import_at: '2026-09-02T10:00:00',
      suggested_liability_id: 'L1',
      liability_id: null,
    });
    expect(s.history).toEqual(preview.history);
  });
});

describe('buildCategorizeRequest', () => {
  function many(): WizardState {
    return loaded([
      txn({ merchant_key: 'BLUE BOTTLE COFFEE', amount: -4.4 }),
      txn({ merchant_key: 'BLUE BOTTLE COFFEE', amount: -5.6 }),
      txn({ merchant_key: 'BLUE BOTTLE COFFEE', amount: -9.2 }),
      txn({ merchant_key: 'SALARY', amount: 3000, kind: 'income' }),
      txn({ merchant_key: 'ZELLE TO JANE', amount: -50, kind: 'transfer' }),
      txn({ merchant_key: 'CARD PAYMENT', amount: -200, kind: 'payment' }),
      txn({ merchant_key: 'NETFLIX', amount: -15, category_id: 'c-fun', category_source: 'rule' }),
      txn({ merchant_key: 'AB 12', amount: -5 }),
      txn({ merchant_key: 'DUP STORE', amount: -5 }),
      txn({ merchant_key: 'GONE STORE', amount: -5 }),
      txn({ merchant_key: 'STORE REFUND', amount: 12, kind: 'refund' }),
    ]);
  }

  it('sends one item per unique uncategorized expense-like merchant, with nothing else', () => {
    let s = many();
    s = setExcluded(s, [s.rows.find((r) => r.merchant_key === 'GONE STORE')!.id], true);
    s = {
      ...s,
      rows: s.rows.map((r) => (r.merchant_key === 'DUP STORE' ? { ...r, duplicate: true } : r)),
    };
    const { request, chunks } = buildCategorizeRequest(s, CATS);
    expect(request.categories).toEqual(['Food', 'Fun', 'Home']);
    expect(request.items.map((i) => i.merchant)).toEqual(['BLUE BOTTLE COFFEE', 'STORE REFUND']);
    expect(request.items[0]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
      merchant: 'BLUE BOTTLE COFFEE',
      typical_amount: 6,
      direction: 'out',
      count: 3,
    });
    expect(request.items[1]).toMatchObject({ typical_amount: 12, direction: 'in', count: 1 });
    expect(chunks).toEqual([request]);
  });

  it('matches the strict server contract: exact keys, integer amounts, unique ids', () => {
    const { request } = buildCategorizeRequest(many(), CATS);
    expect(Object.keys(request).sort()).toEqual(['categories', 'items']);
    const ids = request.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of request.items) {
      expect(Object.keys(item).sort()).toEqual([
        'count',
        'direction',
        'id',
        'merchant',
        'typical_amount',
      ]);
      expect(Number.isInteger(item.typical_amount)).toBe(true);
      expect(Number.isInteger(item.count)).toBe(true);
    }
  });

  it('never carries dates, descriptions, accounts or file names', () => {
    const s = loaded([txn({ merchant_key: 'SHOP', description: 'SECRETDESC' })], {
      file_name: 'secret-file.csv',
      account: {
        kind: 'checking',
        key: 'acct:SECRETKEY',
        last4: '9876',
        institution: 'SecretBank',
      },
    });
    const { request, chunks } = buildCategorizeRequest(s, CATS);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(request);
    walk(chunks);
    expect([...keys].sort()).toEqual(
      ['categories', 'count', 'direction', 'id', 'items', 'merchant', 'typical_amount'].sort()
    );
    expect(request.items.map((i) => i.merchant)).toEqual(['SHOP']);
  });

  it('cuts merchants to 48 characters and skips keys with fewer than 3 letters', () => {
    const long = 'X'.repeat(80);
    const s = loaded([
      txn({ merchant_key: long }),
      txn({ merchant_key: '12 3456' }),
      txn({ merchant_key: 'A1' }),
    ]);
    const { request } = buildCategorizeRequest(s, CATS);
    expect(request.items).toHaveLength(1);
    expect(request.items[0]!.merchant).toBe('X'.repeat(48));
  });

  it('splits into chunks of 60 items with at most 60 categories each', () => {
    const txns = Array.from({ length: 130 }, (_, i) =>
      txn({
        merchant_key: `SHOP ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}X`,
        amount: -3,
      })
    );
    const s = loaded(txns);
    const cats = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, name: `Cat ${i}` }));
    const { request, chunks } = buildCategorizeRequest(s, cats);
    expect(request.items).toHaveLength(130);
    expect(request.categories).toHaveLength(60);
    expect(chunks.map((c) => c.items.length)).toEqual([60, 60, 10]);
    expect(chunks.flatMap((c) => c.items)).toEqual(request.items);
    expect(chunks.every((c) => c.categories.length <= 60)).toBe(true);
  });

  it('returns no chunks when nothing needs a category', () => {
    const s = loaded([txn({ category_id: 'c-food', category_source: 'seed' })]);
    const { request, chunks } = buildCategorizeRequest(s, CATS);
    expect(request.items).toEqual([]);
    expect(chunks).toEqual([]);
  });
});

describe('applyCategorizeResponse', () => {
  it('applies suggestions to every uncategorized row of the merchant', () => {
    let s = loaded([
      txn({ merchant_key: 'CAFE' }),
      txn({ merchant_key: 'CAFE' }),
      txn({ merchant_key: 'DINER' }),
    ]);
    const { request } = buildCategorizeRequest(s, CATS);
    const [cafe, diner] = request.items;
    s = applyCategorizeResponse(s, {
      suggestions: [
        { id: cafe!.id, category: 'Food', kind: null, confidence: 0.92 },
        { id: diner!.id, category: 'Nope', kind: null, confidence: 0.4 },
        { id: 'unknown', category: 'Food', kind: null, confidence: 1 },
      ],
      provider: 'Claude',
      model: 'haiku',
    });
    expect(s.rows[0]).toMatchObject({
      category_id: 'c-food',
      category_source: 'ai',
      ai_confidence: 0.92,
    });
    expect(s.rows[1]).toMatchObject({ category_id: 'c-food', category_source: 'ai' });
    expect(s.rows[2]).toMatchObject({ category_id: null, category_source: 'none' });
    expect(s.ai_provider).toBe('Claude');
  });

  it('never overwrites a category the user or a rule already set', () => {
    let s = loaded([txn({ merchant_key: 'CAFE' }), txn({ merchant_key: 'CAFE' })]);
    const { request } = buildCategorizeRequest(s, CATS);
    s = setCategory(s, [s.rows[0]!.id], 'c-home', false);
    s = applyCategorizeResponse(s, {
      suggestions: [{ id: request.items[0]!.id, category: 'Food', kind: null, confidence: 0.9 }],
      provider: 'p',
      model: 'm',
    });
    expect(s.rows[0]).toMatchObject({ category_id: 'c-home', category_source: 'user' });
    expect(s.rows[1]).toMatchObject({ category_id: 'c-food', category_source: 'ai' });
  });

  it('keeps ids stable across chunks, so a later chunk still resolves after an earlier one applied', () => {
    let s = loaded([txn({ merchant_key: 'ALPHA' }), txn({ merchant_key: 'BRAVO' })]);
    const { request } = buildCategorizeRequest(s, CATS);
    s = applyCategorizeResponse(s, {
      suggestions: [{ id: request.items[0]!.id, category: 'Food', kind: null, confidence: 0.9 }],
      provider: 'p',
      model: 'm',
    });
    s = applyCategorizeResponse(s, {
      suggestions: [{ id: request.items[1]!.id, category: 'Home', kind: null, confidence: 0.9 }],
      provider: 'p',
      model: 'm',
    });
    expect(s.rows.map((r) => r.category_id)).toEqual(['c-food', 'c-home']);
  });

  it('applies a non-spending kind and clears the category', () => {
    let s = loaded([txn({ merchant_key: 'ZELLE FRIEND' })]);
    const { request } = buildCategorizeRequest(s, CATS);
    s = applyCategorizeResponse(s, {
      suggestions: [
        { id: request.items[0]!.id, category: 'Food', kind: 'transfer', confidence: 0.9 },
      ],
      provider: 'p',
      model: 'm',
    });
    expect(s.rows[0]).toMatchObject({ kind: 'transfer', category_id: null });
  });
});

describe('setCategory and setKind', () => {
  it('remember applies to every row with the same merchant key and records one rule', () => {
    let s = loaded([
      txn({ merchant_key: 'CAFE' }),
      txn({ merchant_key: 'CAFE' }),
      txn({ merchant_key: 'DINER' }),
    ]);
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    expect(s.rows.map((r) => r.category_id)).toEqual(['c-food', 'c-food', null]);
    expect(s.rows.map((r) => r.category_source)).toEqual(['user', 'user', 'none']);
    expect(s.remembered).toEqual({ CAFE: { category_id: 'c-food' } });
  });

  it('without remember changes only the given rows', () => {
    let s = loaded([txn({ merchant_key: 'CAFE' }), txn({ merchant_key: 'CAFE' })]);
    s = setCategory(s, [s.rows[0]!.id], 'c-food', false);
    expect(s.rows.map((r) => r.category_id)).toEqual(['c-food', null]);
    expect(s.remembered).toEqual({});
  });

  it('leaves rows that are not spending alone', () => {
    let s = loaded([txn({ merchant_key: 'PAY', kind: 'income', amount: 5 })]);
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    expect(s.rows[0]!.category_id).toBeNull();
  });

  it('setKind to a non-spending kind clears the category; remember merges with the category rule', () => {
    let s = loaded([txn({ merchant_key: 'CAFE' }), txn({ merchant_key: 'CAFE' })]);
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    s = setKind(s, [s.rows[0]!.id], 'transfer', true);
    expect(s.rows.map((r) => [r.kind, r.category_id])).toEqual([
      ['transfer', null],
      ['transfer', null],
    ]);
    expect(s.remembered.CAFE).toEqual({ category_id: null, kind: 'transfer' });
  });

  it('setKind to a spending kind keeps the category', () => {
    let s = loaded([txn({ category_id: 'c-food', category_source: 'seed' })]);
    s = setKind(s, [s.rows[0]!.id], 'fee', false);
    expect(s.rows[0]).toMatchObject({ kind: 'fee', category_id: 'c-food' });
  });
});

describe('suggestions and filters', () => {
  function withAi(): WizardState {
    let s = loaded([
      txn({ merchant_key: 'HIGH' }),
      txn({ merchant_key: 'LOW' }),
      txn({ merchant_key: 'NONE' }),
      txn({ merchant_key: 'RULED', category_id: 'c-fun', category_source: 'rule' }),
    ]);
    const { request } = buildCategorizeRequest(s, CATS);
    const id = (m: string): string => request.items.find((i) => i.merchant === m)!.id;
    s = applyCategorizeResponse(s, {
      suggestions: [
        { id: id('HIGH'), category: 'Food', kind: null, confidence: 0.95 },
        { id: id('LOW'), category: 'Home', kind: null, confidence: 0.5 },
        { id: id('NONE'), category: null, kind: null, confidence: 0 },
      ],
      provider: 'p',
      model: 'm',
    });
    return s;
  }

  it('Needs review lists low-confidence AI rows and uncategorized spending, not confident ones', () => {
    const s = withAi();
    expect(filterRows(s, 'review').map((r) => r.merchant_key)).toEqual(['LOW', 'NONE']);
    expect(filterRows(s, 'all')).toHaveLength(4);
  });

  it('acceptAllSuggestions confirms AI rows without changing their category', () => {
    let s = withAi();
    s = acceptAllSuggestions(s);
    expect(filterRows(s, 'review').map((r) => r.merchant_key)).toEqual(['NONE']);
    expect(s.rows.find((r) => r.merchant_key === 'LOW')).toMatchObject({
      category_id: 'c-home',
      category_source: 'ai',
    });
  });

  it('acceptAllSuggestions can be limited to chosen rows', () => {
    let s = withAi();
    const low = s.rows.find((r) => r.merchant_key === 'LOW')!;
    s = acceptAllSuggestions(s, [s.rows.find((r) => r.merchant_key === 'NONE')!.id]);
    expect(filterRows(s, 'review').map((r) => r.id)).toContain(low.id);
  });

  it('filters duplicates and excluded separately', () => {
    let s = loaded([txn(), txn(), txn()]);
    s = setExcluded(s, [s.rows[0]!.id], true);
    s = { ...s, rows: s.rows.map((r, i) => (i === 1 ? { ...r, duplicate: true } : r)) };
    expect(filterRows(s, 'excluded').map((r) => r.id)).toEqual([s.rows[0]!.id]);
    expect(filterRows(s, 'duplicates').map((r) => r.id)).toEqual([s.rows[1]!.id]);
    expect(filterRows(s, 'review').map((r) => r.id)).toEqual([s.rows[2]!.id]);
    s = setExcluded(s, [s.rows[0]!.id], false);
    expect(filterRows(s, 'excluded')).toEqual([]);
  });
});

describe('recurring', () => {
  const EXPENSES = [
    {
      id: 'e1',
      name: 'Netflix',
      amount: 15,
      frequency: 'monthly',
      category_id: 'c-fun',
      is_active: true,
    },
  ];

  it('builds the request from reviewed rows, history and the budget, without duplicates or excluded rows', () => {
    let s = loaded([
      txn({ merchant_key: 'NETFLIX', amount: -15 }),
      txn({ merchant_key: 'GYM', amount: -30 }),
      txn({ merchant_key: 'DUPE', amount: -5 }),
    ]);
    s = setExcluded(s, [s.rows[1]!.id], true);
    s = {
      ...s,
      rows: s.rows.map((r) => (r.merchant_key === 'DUPE' ? { ...r, duplicate: true } : r)),
      history: [{ merchant_key: 'NETFLIX', posted_date: '2026-08-01', amount: -15 }],
    };
    const req = recurringRequest(s, { expenses: EXPENSES, categories: CATS });
    expect(req.rows.map((r) => r.merchant_key)).toEqual(['NETFLIX']);
    expect(Object.keys(req.rows[0]!).sort()).toEqual([
      'amount',
      'category_id',
      'description',
      'kind',
      'merchant_key',
      'posted_date',
    ]);
    expect(req.history).toEqual(s.history);
    expect(req.expenses).toEqual(EXPENSES);
    expect(req.categories).toEqual(CATS);
  });

  it('defaults an already budgeted candidate to unticked and maps ticks to create, link or reject', () => {
    let s = loaded([txn({ merchant_key: 'NETFLIX' }), txn({ merchant_key: 'GYM' })]);
    s = setRecurring(s, [
      {
        merchant_key: 'NETFLIX',
        name: 'Netflix',
        amount: 15,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: 'c-fun',
        already_budgeted: true,
        matched_expense_id: 'e1',
      },
      {
        merchant_key: 'GYM',
        name: 'Gym',
        amount: 30,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: 'c-home',
        already_budgeted: false,
        matched_expense_id: null,
      },
    ]);
    expect(s.recurring.map((c) => c.checked)).toEqual([false, true]);
    let req = buildApplyRequest(s);
    expect(req.recurring!.map((r) => [r.merchant_key, r.decision, r.expense_id])).toEqual([
      ['NETFLIX', 'reject', undefined],
      ['GYM', 'create', undefined],
    ]);
    s = updateRecurring(s, 'NETFLIX', { checked: true });
    s = updateRecurring(s, 'GYM', { name: 'Gym membership', amount: 32, category_id: 'c-fun' });
    req = buildApplyRequest(s);
    expect(req.recurring![0]).toMatchObject({
      decision: 'link',
      expense_id: 'e1',
      file_hash: HASH,
    });
    expect(req.recurring![1]).toMatchObject({
      decision: 'create',
      name: 'Gym membership',
      amount: 32,
      category_id: 'c-fun',
    });
    expect(req.recurring![1]).not.toHaveProperty('expense_id');
  });

  it('starts everyday spending unticked and flags it, but keeps bills ticked', () => {
    const cand = (merchant_key: string, category_id: string | null) => ({
      merchant_key,
      name: merchant_key,
      amount: 50,
      frequency: 'monthly' as const,
      occurrences: 3,
      last_date: '2026-09-01',
      category_id,
      already_budgeted: false,
      matched_expense_id: null,
    });
    let s = createWizardState(
      {
        categories: [
          { id: 'food', name: 'Food & Dining' },
          { id: 'groc', name: 'Groceries' },
          { id: 'shop', name: 'Shopping' },
          { id: 'gas', name: 'Gas' },
          { id: 'util', name: 'Utilities' },
          { id: 'trans', name: 'Transportation' },
        ],
      },
      'b'
    );
    s = setRecurring(s, [
      cand('SAFEWAY', 'food'),
      cand('KROGER', 'groc'),
      cand('TARGET', 'shop'),
      cand('SHELL', 'gas'),
      cand('VERIZON', 'util'),
      cand('CAR LOAN', 'trans'),
      cand('MYSTERY', null),
    ]);
    expect(s.recurring.map((c) => [c.merchant_key, c.checked, c.everyday])).toEqual([
      ['SAFEWAY', false, true],
      ['KROGER', false, true],
      ['TARGET', false, true],
      ['SHELL', false, true],
      ['VERIZON', true, false],
      ['CAR LOAN', true, false],
      ['MYSTERY', true, false],
    ]);
  });

  it('skips a candidate that has no category, which the server would reject', () => {
    let s = loaded([txn({ merchant_key: 'GYM' })]);
    s = setRecurring(s, [
      {
        merchant_key: 'GYM',
        name: 'Gym',
        amount: 30,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: null,
        already_budgeted: false,
        matched_expense_id: null,
      },
    ]);
    expect(buildApplyRequest(s).recurring).toEqual([]);
  });
});

describe('buildApplyRequest', () => {
  it('maps statements, rows and remembered rules to the apply contract', () => {
    let s = loaded(
      [
        txn({ merchant_key: 'CAFE', amount: -4.5, external_id: 'FIT1' }),
        txn({
          merchant_key: 'NETFLIX',
          amount: -15,
          category_id: 'c-fun',
          category_source: 'rule',
        }),
      ],
      { closing_balance: { amount: 120.5, as_of: '2026-09-30' } }
    );
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    s = setStatement(s, 'f1:0', { liability_id: 'L1', account_label: 'Everyday' });
    const req = buildApplyRequest(s);
    expect(req.batch_id).toBe('batch-1');
    expect(req.statements).toHaveLength(1);
    const st = req.statements[0]!;
    expect(st).toMatchObject({
      file_hash: HASH,
      file_name: 'bank.csv',
      origin: 'file',
      format: 'csv',
      parser: 'csv',
      account: {
        kind: 'checking',
        key: 'acct:1',
        label: 'Everyday',
        last4: '1234',
        institution: 'Bank',
      },
      period: { start: '2026-09-01', end: '2026-09-30' },
      closing_balance: { amount: 120.5, as_of: '2026-09-30' },
      liability_id: 'L1',
      ai_used: false,
    });
    expect(st.transactions[0]).toEqual({
      posted_date: '2026-09-01',
      amount: -4.5,
      description: 'masked description',
      merchant_key: 'CAFE',
      kind: 'expense',
      category_id: 'c-food',
      category_source: 'user',
      external_id: 'FIT1',
      dedupe_key: 'acct:1|' + s.rows[0]!.dedupe_base,
      excluded: false,
    });
    expect(st.transactions[1]).toMatchObject({ category_source: 'rule', category_id: 'c-fun' });
    expect(req.rules).toEqual([{ merchant_key: 'CAFE', category_id: 'c-food', source: 'user' }]);
  });

  it('never sends a duplicate and sends excluded rows as excluded', () => {
    let s = loaded([txn(), txn(), txn()]);
    s = setExcluded(s, [s.rows[0]!.id], true);
    s = { ...s, rows: s.rows.map((r, i) => (i === 1 ? { ...r, duplicate: true } : r)) };
    const sent = buildApplyRequest(s).statements[0]!.transactions;
    expect(sent).toHaveLength(2);
    expect(sent.map((t) => t.excluded)).toEqual([true, false]);
    expect(sent.some((t) => t.dedupe_key.endsWith(s.rows[1]!.dedupe_base))).toBe(false);
  });

  it('an excluded row stays excluded even when its duplicate flag is cleared', () => {
    let s = loaded([txn()]);
    s = setExcluded(s, [s.rows[0]!.id], true);
    expect(buildApplyRequest(s).statements[0]!.transactions.every((t) => t.excluded)).toBe(true);
  });

  it('sends no category for rows that are not spending and marks the source none', () => {
    const s = loaded([
      txn({ kind: 'income', amount: 10, category_id: 'c-food', category_source: 'seed' }),
    ]);
    expect(buildApplyRequest(s).statements[0]!.transactions[0]).toMatchObject({
      category_id: null,
      category_source: 'none',
    });
  });

  it('sends AI confidence only for AI categorized rows and marks ai_used', () => {
    let s = loaded([txn({ merchant_key: 'CAFE' }), txn({ merchant_key: 'OTHER' })]);
    const { request } = buildCategorizeRequest(s, CATS);
    s = applyCategorizeResponse(s, {
      suggestions: [{ id: request.items[0]!.id, category: 'Food', kind: null, confidence: 0.9 }],
      provider: 'Claude',
      model: 'm',
    });
    const st = buildApplyRequest(s).statements[0]!;
    expect(st.transactions[0]).toMatchObject({ category_source: 'ai', ai_confidence: 0.9 });
    expect(st.transactions[1]).not.toHaveProperty('ai_confidence');
    expect(st).toMatchObject({ ai_used: true, ai_provider: 'Claude' });
  });

  it('leaves out skipped statements and files already imported', () => {
    let s = mergeAnalyze(
      fresh(),
      'f1',
      ok(
        stmt([txn()]),
        stmt([txn()], {
          account: { kind: 'savings', key: 'acct:2', last4: null, institution: null },
        })
      )
    );
    s = setStatement(s, 'f1:1', { skipped: true });
    expect(buildApplyRequest(s).statements).toHaveLength(1);
    s = applyPreview(s, {
      existing_dedupe_keys: [],
      prior_files: [{ file_hash: HASH, import_id: 'i', imported_at: null }],
      liability_suggestions: [],
      history: [],
    });
    expect(buildApplyRequest(s).statements).toHaveLength(0);
  });

  it('leaves out statements without an account key or label', () => {
    const s = loaded([txn()], {
      account: { kind: 'checking', key: null, last4: null, institution: null },
    });
    expect(buildApplyRequest(s).statements).toEqual([]);
  });

  it('uses the account kind override and carries the entity id', () => {
    let s = createWizardState(CTX, 'b2', 'ent-1');
    s = addFile(s, { id: 'f1', file_name: 's.csv', origin: 'sample' });
    s = mergeAnalyze(s, 'f1', ok(stmt([txn()], { origin: 'sample' })));
    s = setStatement(s, 'f1:0', { account_kind: 'credit_card' });
    const req = buildApplyRequest(s);
    expect(req.entity_id).toBe('ent-1');
    expect(req.statements[0]).toMatchObject({ origin: 'sample', account: { kind: 'credit_card' } });
  });
});

describe('reviewCounts', () => {
  it('counts what Review shows', () => {
    let s = loaded(
      [
        txn({ merchant_key: 'CAFE' }),
        txn({ merchant_key: 'CAFE' }),
        txn({ merchant_key: 'DINER' }),
        txn({ merchant_key: 'SKIP' }),
        txn({ merchant_key: 'DUP' }),
      ],
      {
        account: { kind: 'credit_card', key: 'acct:1', last4: '1234', institution: 'Bank' },
        closing_balance: { amount: 900, as_of: '2026-09-30' },
      }
    );
    s = setCategory(s, [s.rows[0]!.id], 'c-food', true);
    s = setCategory(s, [s.rows[2]!.id], 'c-home', false);
    s = setExcluded(s, [s.rows[3]!.id], true);
    s = {
      ...s,
      rows: s.rows.map((r) => (r.merchant_key === 'DUP' ? { ...r, duplicate: true } : r)),
    };
    s = setStatement(s, 'f1:0', { liability_id: 'L1', account_label: 'Card' });
    s = setRecurring(s, [
      {
        merchant_key: 'CAFE',
        name: 'Cafe',
        amount: 5,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: 'c-home',
        already_budgeted: false,
        matched_expense_id: null,
      },
      {
        merchant_key: 'DINER',
        name: 'Diner',
        amount: 5,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: 'c-food',
        already_budgeted: true,
        matched_expense_id: 'e1',
      },
    ]);
    s = updateRecurring(s, 'DINER', { checked: true });
    expect(reviewCounts(s)).toEqual({
      new: 3,
      duplicates: 1,
      excluded: 1,
      needs_review: 0,
      merchants_to_remember: 1,
      files_skipped: 0,
      expenses_to_add: 1,
      expenses_to_link: 1,
      debts: [
        {
          liability_id: 'L1',
          statement_id: 'f1:0',
          label: 'Card',
          closing_balance: 900,
          as_of: '2026-09-30',
        },
      ],
    });
  });
});

describe('CSV layouts and settings patch', () => {
  const HEADERS = ['Date', 'Memo', 'Amount'];

  it('csvHeaderSignature is 64 lowercase hex and matches sha256 of the normalized headers', () => {
    const sig = csvHeaderSignature(HEADERS);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(createHash('sha256').update('date\nmemo\namount').digest('hex'));
    expect(csvHeaderSignature([' DATE', 'memo ', 'Amount'])).toBe(sig);
    const long = ['h\u00e9ader ' + 'x'.repeat(300), 'b'];
    expect(csvHeaderSignature(long)).toBe(
      createHash('sha256').update(long.join('\n').toLowerCase()).digest('hex')
    );
  });

  it('buildAnalyzeContext applies a remembered layout by header signature, not an explicit mapping', () => {
    const layouts = { [csvHeaderSignature(HEADERS)]: { date: 'Date', amount: 'Amount' } };
    const ctx = { ...CTX, csv_layouts: layouts };
    expect(layoutFor(ctx, HEADERS)).toEqual({ date: 'Date', amount: 'Amount' });
    expect(buildAnalyzeContext(ctx, { headers: HEADERS })).toMatchObject({
      mapping: { date: 'Date', amount: 'Amount' },
    });
    expect(buildAnalyzeContext(ctx, { headers: HEADERS })).not.toHaveProperty('headers');
    expect(buildAnalyzeContext(ctx, { headers: HEADERS, mapping: { date: 'X' } }).mapping).toEqual({
      date: 'X',
    });
    expect(buildAnalyzeContext(ctx, { headers: ['Other'] })).not.toHaveProperty('mapping');
  });

  it('records the mapping by signature and merges it into the settings patch', () => {
    let s = mergeAnalyze(fresh(), 'f1', {
      status: 'needs_mapping',
      headers: HEADERS,
      sample_rows: [],
    });
    s = setFileMapping(s, 'f1', { date: 'Date', amount: 'Amount' });
    expect(s.files[0]!.layout_signature).toBe(csvHeaderSignature(HEADERS));
    s = mergeAnalyze(
      s,
      'f1',
      ok(
        stmt([txn()], { account: { kind: 'checking', key: null, last4: null, institution: null } })
      )
    );
    s = setStatement(s, 'f1:0', { account_label: ' Everyday ' });
    const patch = buildSettingsPatch(s, {
      csv_layouts: { ['b'.repeat(64)]: { date: 'D' } },
      accounts: { 'acct:old': 'Old' },
    });
    expect(patch.csv_layouts).toEqual({
      ['b'.repeat(64)]: { date: 'D' },
      [csvHeaderSignature(HEADERS)]: { date: 'Date', amount: 'Amount' },
    });
    expect(patch.accounts).toEqual({ 'acct:old': 'Old', 'label:everyday': 'Everyday' });
  });

  it('keeps the patch within 50 layouts and 200 accounts, dropping the oldest', () => {
    let s = mergeAnalyze(fresh(), 'f1', {
      status: 'needs_mapping',
      headers: HEADERS,
      sample_rows: [],
    });
    s = setFileMapping(s, 'f1', { date: 'Date' });
    s = mergeAnalyze(
      s,
      'f1',
      ok(
        stmt([txn()], { account: { kind: 'checking', key: null, last4: null, institution: null } })
      )
    );
    s = setStatement(s, 'f1:0', { account_label: 'Mine' });
    const layouts = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [i.toString(16).padStart(64, '0'), { date: 'D' }])
    );
    const accounts = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`acct:${i}`, `L${i}`])
    );
    const patch = buildSettingsPatch(s, { csv_layouts: layouts, accounts });
    expect(Object.keys(patch.csv_layouts)).toHaveLength(50);
    expect(patch.csv_layouts[csvHeaderSignature(HEADERS)]).toBeDefined();
    expect(Object.keys(patch.csv_layouts)[0]).toBe('1'.padStart(64, '0'));
    expect(Object.keys(patch.accounts)).toHaveLength(200);
    expect(patch.accounts['label:mine']).toBe('Mine');
    expect(patch.accounts['acct:0']).toBeUndefined();
  });
});

describe('accountKey', () => {
  it('caps the label part so the key stays within the server limits', () => {
    const key = accountKey({ account_key: null, account_label: 'A'.repeat(500) })!;
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/^label:a{190}$/);
  });

  it('drops control characters from a label', () => {
    expect(accountKey({ account_key: null, account_label: 'My\u0000 Acct\n' })).toBe(
      'label:my acct'
    );
  });
});

describe('apply caps and AI provider', () => {
  it('throws a typed error past the transaction cap', () => {
    const s = loaded(Array.from({ length: 10_001 }, () => txn()));
    expect(() => buildApplyRequest(s)).toThrow(ApplyTooLargeError);
    try {
      buildApplyRequest(s);
    } catch (e) {
      expect(e).toMatchObject({ limit: 'transactions', max: 10_000 });
    }
  });

  it('throws past 12 statements and past 5000 rules', () => {
    let s = fresh();
    for (let i = 0; i < 13; i++) {
      s = addFile(s, { id: `g${i}`, file_name: 'x.csv' });
      s = mergeAnalyze(s, `g${i}`, ok(stmt([txn()], { file_hash: String(i).padStart(64, '0') })));
    }
    expect(() => buildApplyRequest(s)).toThrow(expect.objectContaining({ limit: 'statements' }));
    const t = loaded([txn()]);
    const remembered = Object.fromEntries(
      Array.from({ length: 5001 }, (_, i) => [`M${i}`, { category_id: 'c-food' }])
    );
    expect(() => buildApplyRequest({ ...t, remembered })).toThrow(
      expect.objectContaining({ limit: 'rules' })
    );
  });

  it('sends ai_provider for a pdf:ai statement once the provider is set', () => {
    let s = loaded([txn()], { parser: 'pdf:ai', format: 'pdf' });
    expect(buildApplyRequest(s).statements[0]).toMatchObject({ ai_used: true });
    expect(buildApplyRequest(s).statements[0]).not.toHaveProperty('ai_provider');
    s = setAiProvider(s, 'Claude');
    expect(buildApplyRequest(s).statements[0]).toMatchObject({ ai_provider: 'Claude' });
  });

  it('returns no chunks when there are no categories', () => {
    const s = loaded([txn({ merchant_key: 'CAFE' })]);
    const { request, chunks } = buildCategorizeRequest(s, []);
    expect(request.items).toHaveLength(1);
    expect(chunks).toEqual([]);
  });
});

describe('remembered rules merge', () => {
  const stored = (r: Partial<SmartImportContext['rules'][number]>): WizardState => {
    rowNo = 0;
    const ctx = {
      ...CTX,
      rules: [{ id: 'r', merchant_key: 'CAFE', category_id: 'c-home', kind: 'fee', ...r }],
    };
    let s = createWizardState(ctx, 'b');
    s = addFile(s, { id: 'f1', file_name: 'a.csv' });
    return mergeAnalyze(s, 'f1', ok(stmt([txn({ merchant_key: 'CAFE' })])));
  };

  it('a category choice keeps the stored kind', () => {
    const s = setCategory(stored({}), ['f1:0:1'], 'c-food', true);
    expect(buildApplyRequest(s).rules).toEqual([
      { merchant_key: 'CAFE', category_id: 'c-food', kind: 'fee', source: 'user' },
    ]);
  });

  it('a kind choice keeps the stored category', () => {
    const s = setKind(stored({ kind: null }), ['f1:0:1'], 'refund', true);
    expect(buildApplyRequest(s).rules).toEqual([
      { merchant_key: 'CAFE', category_id: 'c-home', kind: 'refund', source: 'user' },
    ]);
  });

  it('a non-spending kind overrides the stored category', () => {
    const s = setKind(stored({}), ['f1:0:1'], 'transfer', true);
    expect(buildApplyRequest(s).rules).toEqual([
      { merchant_key: 'CAFE', category_id: null, kind: 'transfer', source: 'user' },
    ]);
  });

  it('skips an empty entry but sends an explicit forget', () => {
    let s = stored({ category_id: null, kind: null });
    s = setCategory(s, ['f1:0:1'], null, true);
    expect(buildApplyRequest(s).rules).toEqual([]);
    expect(reviewCounts(s).merchants_to_remember).toBe(0);
    s = forgetMerchant(s, 'CAFE');
    expect(buildApplyRequest(s).rules).toEqual([
      { merchant_key: 'CAFE', category_id: null, source: 'user' },
    ]);
  });
});

// Field lists copied from the pydantic models in src/api/smart_import.py
// (ApplyRequest and the models it nests). All of them forbid extra keys.
const CONTRACT: Record<string, { required: string[]; optional: string[] }> = {
  request: { required: ['batch_id', 'statements'], optional: ['entity_id', 'rules', 'recurring'] },
  statement: {
    required: ['file_hash', 'file_name', 'origin', 'format', 'parser', 'account', 'transactions'],
    optional: ['period', 'closing_balance', 'liability_id', 'ai_used', 'ai_provider'],
  },
  account: { required: ['kind', 'key'], optional: ['label', 'last4', 'institution'] },
  period: { required: [], optional: ['start', 'end'] },
  closing_balance: { required: ['amount', 'as_of'], optional: [] },
  transaction: {
    required: [
      'posted_date',
      'amount',
      'description',
      'merchant_key',
      'kind',
      'category_source',
      'dedupe_key',
    ],
    optional: ['category_id', 'ai_confidence', 'external_id', 'excluded'],
  },
  rule: { required: ['merchant_key'], optional: ['category_id', 'kind', 'source'] },
  recurring: {
    required: [
      'merchant_key',
      'name',
      'amount',
      'frequency',
      'category_id',
      'occurrences',
      'file_hash',
      'decision',
    ],
    optional: ['expense_id'],
  },
};

function conforms(name: string, obj: object): void {
  const spec = CONTRACT[name]!;
  const keys = Object.keys(obj);
  for (const r of spec.required) expect(keys, `${name} needs ${r}`).toContain(r);
  for (const k of keys)
    expect([...spec.required, ...spec.optional], `${name} has unknown ${k}`).toContain(k);
}

describe('apply body contract', () => {
  it('a realistic body uses exactly the fields the server models allow', () => {
    let s = loaded(
      [
        txn({
          merchant_key: 'NETFLIX',
          category_id: 'c-fun',
          category_source: 'rule',
          external_id: 'F1',
        }),
        txn({ merchant_key: 'CAFE' }),
        txn({ merchant_key: 'SALARY', kind: 'income', amount: 100 }),
      ],
      { closing_balance: { amount: 10, as_of: '2026-09-30' } }
    );
    const { request } = buildCategorizeRequest(s, CATS);
    s = applyCategorizeResponse(s, {
      suggestions: [{ id: request.items[0]!.id, category: 'Food', kind: null, confidence: 0.9 }],
      provider: 'Claude',
      model: 'm',
    });
    s = setCategory(s, [s.rows[0]!.id], 'c-fun', true);
    s = setStatement(s, 'f1:0', { liability_id: 'L1', account_label: 'Everyday' });
    s = setRecurring(s, [
      {
        merchant_key: 'NETFLIX',
        name: 'Netflix',
        amount: 15,
        frequency: 'monthly',
        occurrences: 3,
        last_date: '2026-09-01',
        category_id: 'c-fun',
        already_budgeted: true,
        matched_expense_id: 'e1',
      },
    ]);
    s = updateRecurring(s, 'NETFLIX', { checked: true });
    const body = buildApplyRequest({ ...s, entity_id: 'ent' });
    conforms('request', body);
    for (const st of body.statements) {
      conforms('statement', st);
      conforms('account', st.account);
      if (st.period) conforms('period', st.period);
      if (st.closing_balance) conforms('closing_balance', st.closing_balance);
      expect(st.file_hash).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
      st.transactions.forEach((t) => conforms('transaction', t));
    }
    body.rules!.forEach((r) => conforms('rule', r));
    expect(body.rules!.length).toBeGreaterThan(0);
    body.recurring!.forEach((r) => conforms('recurring', r));
    expect(body.recurring!.length).toBe(1);
  });
});
