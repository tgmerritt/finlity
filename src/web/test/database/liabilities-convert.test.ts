/**
 * LocalAPI conversion of a real estate position into a mortgage, and its undo
 * (browser path). Ports tests/api/test_liabilities_convert.py case by case.
 * Row checks use SELECT * so "unchanged" means every stored value is identical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { LocalHttpError } from '@/database/local-error';
import { clientDB } from '@/database/client-database';
import { tryLocalRoute, resetLocalAPICache } from '@/api/dispatcher';
import { createTestApi, useSequentialUuids } from './helpers';

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
type Result = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SAVE_FAILED = 'Could not save the liability';

let restoreUuids: () => void;
let db: ClientDatabase;
let api: LocalAPI;

function seed(target: ClientDatabase): void {
  target.execute('DELETE FROM budget_expense_categories');
  ['Housing', 'Transportation', 'Debt Payments', 'Other'].forEach((name, i) =>
    target.execute(
      'INSERT INTO budget_expense_categories (id, name, sort_order) VALUES (?, ?, ?)',
      [`cat-${name}`, name, i]
    )
  );
  target.execute(
    "INSERT INTO accounts (id, name, account_type) VALUES ('acct-b', 'Brokerage', 'taxable')"
  );
  target.execute(
    "INSERT INTO positions (id, account_id, ticker, name, shares, current_price) VALUES ('pos-vti', 'acct-b', 'VTI', 'Total Market', 10, 330)"
  );
  target.execute(
    `INSERT INTO positions (id, account_id, ticker, name, shares, current_price, cost_basis, position_type, asset_class, purchase_date)
     VALUES ('pos-re', 'acct-b', 'RE', 'Home', 1.0, 612000, 400000, 'real_estate', 'alternative', '2015-06-01')`
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  restoreUuids = useSequentialUuids();
  ({ db, api } = await createTestApi());
  seed(db);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreUuids();
  db.close();
});

function rows(table: string): Row[] {
  return db.query<Row>(`SELECT * FROM ${table} ORDER BY id`);
}

function row(table: string, id: string): Row | undefined {
  return rows(table).find((r) => r['id'] === id);
}

function hashes(): Record<string, string> {
  return Object.fromEntries(
    ['positions', 'accounts', 'budget_expenses', 'position_lots'].map((t) => [
      t,
      JSON.stringify(rows(t)),
    ])
  );
}

function counts(): Record<string, number> {
  const n = (t: string): number => db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)[0]!.c;
  return {
    liabilities: n('liabilities'),
    snapshots: n('liability_balance_snapshots'),
    accounts: n('accounts'),
    positions: n('positions'),
    expenses: n('budget_expenses'),
  };
}

function state(): string {
  return JSON.stringify([hashes(), counts()]);
}

function mortgage(over: Body = {}): Body {
  return {
    name: 'Mortgage',
    lender: 'First Bank',
    current_balance: 248000,
    balance_as_of: '2026-10-01',
    interest_rate: 0.0625,
    payment_amount: 1980,
    next_payment_date: '2026-11-01',
    ...over,
  };
}

function body(mode: string, over: Body = {}): Body {
  return {
    position_id: 'pos-re',
    mode,
    mortgage: mortgage(),
    ...(mode === 'equity' ? { home_value: 860000 } : {}),
    ...over,
  };
}

function convert(mode: string, over: Body = {}): Result {
  return api.convertPosition(body(mode, over) as never) as unknown as Result;
}

function revert(id: string): Result {
  return api.revertConversion(id) as unknown as Result;
}

function errorOf(fn: () => unknown): LocalHttpError | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof LocalHttpError) return e;
    throw e;
  }
  return null;
}

function statusOf(fn: () => unknown): number {
  return errorOf(fn)?.status ?? 200;
}

function detailOf(id: string): Result {
  const r = db.query<{ source_detail: string }>(
    'SELECT source_detail FROM liabilities WHERE id = ?',
    [id]
  )[0]!;
  return JSON.parse(r.source_detail) as Result;
}

function seedExpense(amount = 1500): string {
  db.execute(
    "INSERT INTO budget_expenses (id, category_id, name, amount, frequency) VALUES ('exp-m', 'cat-Housing', 'Mortgage', ?, 'monthly')",
    [amount]
  );
  return 'exp-m';
}

describe('property_value mode', () => {
  it('leaves the position byte for byte and links a new mortgage', () => {
    const before = hashes();
    const res = convert('property_value');
    const liab = res['liability'];
    expect(liab.liability_type).toBe('mortgage');
    expect(liab.is_amortizing).toBe(true);
    expect(liab.source).toBe('converted_position');
    expect(liab.source_ref).toBe('pos-re');
    expect(liab.linked_position_id).toBe('pos-re');
    expect(liab.linked_position.value).toBe(612000);
    expect(liab.current_balance).toBe(248000);
    expect(res['position']).toEqual({ id: 'pos-re', name: 'Home', value: 612000 });
    expect(res['created']).toEqual({ account_id: null, position_id: null, expense_id: null });
    expect('source_detail' in liab).toBe(false);
    expect(hashes()).toEqual(before);
    const detail = detailOf(liab.id);
    expect(detail['mode']).toBe('property_value');
    expect(detail['position_before']).toEqual(row('positions', 'pos-re'));
    const snap = db.query<Row>('SELECT * FROM liability_balance_snapshots')[0]!;
    expect(snap['balance']).toBe(248000);
    expect(snap['source']).toBe('converted_position');
  });
});

describe('equity mode', () => {
  it('changes only current_price', () => {
    const original = row('positions', 'pos-re')!;
    const others = JSON.stringify([rows('accounts'), rows('budget_expenses')]);
    const res = convert('equity');
    expect(res['liability'].current_balance).toBe(248000);
    expect(res['position']).toEqual({ id: 'pos-re', name: 'Home', value: 860000 });
    expect(row('positions', 'pos-re')).toEqual({ ...original, current_price: 860000 });
    expect(JSON.stringify([rows('accounts'), rows('budget_expenses')])).toBe(others);
    const detail = detailOf(res['liability'].id);
    expect(detail['position_before'].current_price).toBe(612000);
    expect(detail['set_current_price']).toBe(860000);
  });

  it('prices per unit when the row has several units', () => {
    db.execute("UPDATE positions SET shares = 4 WHERE id = 'pos-re'");
    const res = convert('equity', { home_value: 800000 });
    expect(row('positions', 'pos-re')!['current_price']).toBe(200000);
    expect(res['position'].value).toBe(800000);
  });

  it('requires home_value, and zero units is a 409', () => {
    expect(
      statusOf(() =>
        api.convertPosition({
          position_id: 'pos-re',
          mode: 'equity',
          mortgage: mortgage(),
        } as never)
      )
    ).toBe(422);
    db.execute("UPDATE positions SET shares = 0 WHERE id = 'pos-re'");
    const before = state();
    expect(statusOf(() => convert('equity'))).toBe(409);
    expect(state()).toBe(before);
  });
});

describe('loan mode', () => {
  it('deletes the position, stores the full row and defaults the balance', () => {
    db.execute("UPDATE positions SET current_price = -251234.56 WHERE id = 'pos-re'");
    const original = row('positions', 'pos-re');
    const res = convert('loan', { mortgage: mortgage({ current_balance: null }) });
    expect(res['liability'].current_balance).toBe(251234.56);
    expect(res['liability'].linked_position_id).toBeNull();
    expect(res['position']).toBeNull();
    expect(row('positions', 'pos-re')).toBeUndefined();
    expect(detailOf(res['liability'].id)['position_before']).toEqual(original);
  });

  it('adds a home in a new property account when asked', () => {
    const res = convert('loan', {
      add_home: { name: 'Our house', value: 700000, purchase_date: '2015-06-01' },
    });
    const created = res['created'];
    expect(created.account_id).toBeTruthy();
    expect(created.position_id).toBeTruthy();
    expect(created.expense_id).toBeNull();
    expect(res['liability'].linked_position_id).toBe(created.position_id);
    expect(res['liability'].current_balance).toBe(248000);
    expect(row('accounts', created.account_id)!['account_type']).toBe('property');
    const pos = row('positions', created.position_id)!;
    expect(pos['account_id']).toBe(created.account_id);
    expect(pos['current_price']).toBe(700000);
    expect(pos['position_type']).toBe('real_estate');
    expect(detailOf(res['liability'].id)['created']).toEqual(created);
  });

  it('reuses an existing property account and does not record it as created', () => {
    db.execute(
      "INSERT INTO accounts (id, name, account_type) VALUES ('acct-p', 'Houses', 'property')"
    );
    const created = convert('loan', { add_home: { name: 'Our house', value: 700000 } })['created'];
    expect(created.account_id).toBeNull();
    expect(row('positions', created.position_id)!['account_id']).toBe('acct-p');
  });

  it('refuses positions with tax lots', () => {
    db.execute(
      "INSERT INTO position_lots (id, position_id, purchase_date, shares, cost_basis) VALUES ('lot-1', 'pos-re', '2015-06-01', 1, 400000)"
    );
    const before = state();
    expect(statusOf(() => convert('loan'))).toBe(409);
    expect(state()).toBe(before);
  });
});

describe('validation and refusals', () => {
  it.each<Body>([
    { mode: 'rent' },
    { position_id: '' },
    { mortgage: mortgage({ current_balance: null }) },
    { mortgage: mortgage({ liability_type: 'heloc' }) },
    { mortgage: mortgage({ source: 'wizard' }) },
    { mortgage: mortgage({ linked_position_id: 'pos-vti' }) },
    { mortgage: mortgage({ interest_rate: 2 }) },
    { mortgage: mortgage({ balance_as_of: '2026-10-01T00:00:00' }) },
    { mortgage: mortgage({ name: null }) },
    { home_value: 5 },
    { add_home: { name: 'x', value: 1 } },
    { surprise: true },
  ])('rejects %j with 422 and writes nothing', (patch) => {
    const before = state();
    expect(statusOf(() => api.convertPosition(body('property_value', patch) as never))).toBe(422);
    expect(state()).toBe(before);
  });

  it('404s, refuses non real estate and double conversion', () => {
    const before = state();
    expect(statusOf(() => convert('property_value', { position_id: 'nope' }))).toBe(404);
    const err = errorOf(() => convert('property_value', { position_id: 'pos-vti' }));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('Only real estate positions can be converted');
    expect(
      statusOf(() =>
        convert('property_value', { mortgage: mortgage({ balance_as_of: '2026-10-05' }) })
      )
    ).toBe(422);
    expect(state()).toBe(before);
    convert('property_value');
    const again = errorOf(() => convert('equity'));
    expect(again?.status).toBe(409);
    expect(again?.message).toBe('This position is already converted');
  });

  it('defaults the name to Mortgage', () => {
    const res = api.convertPosition({
      position_id: 'pos-re',
      mode: 'property_value',
      mortgage: { current_balance: 1000 },
    } as never) as unknown as Result;
    expect(res['liability'].name).toBe('Mortgage');
  });
});

describe('cash flow', () => {
  it('creates a mortgage expense', () => {
    const res = convert('equity', { cash_flow: { mode: 'create' } });
    const expenseId = res['created'].expense_id as string;
    expect(res['liability'].expense_id).toBe(expenseId);
    const exp = row('budget_expenses', expenseId)!;
    expect(exp['category_id']).toBe('cat-Housing');
    expect(exp['amount']).toBe(1980);
    expect(exp['is_mortgage']).toBe(1);
    expect(exp['interest_portion'] as number).toBeCloseTo((248000 * 0.0625) / 12, 2);
  });

  it('links an existing expense and records its previous split', () => {
    const expId = seedExpense();
    const res = convert('property_value', { cash_flow: { mode: 'link', expense_id: expId } });
    expect(res['liability'].expense_id).toBe(expId);
    expect(res['created'].expense_id).toBeNull();
    expect(row('budget_expenses', expId)!['amount']).toBe(1500);
    expect(row('budget_expenses', expId)!['is_mortgage']).toBe(1);
    const linked = detailOf(res['liability'].id)['linked_expense'];
    expect(linked.id).toBe(expId);
    expect(linked.is_mortgage).toBeFalsy();
  });

  it('none writes no expense', () => {
    const before = counts().expenses;
    convert('property_value', { cash_flow: { mode: 'none' } });
    expect(counts().expenses).toBe(before);
  });
});

describe('atomicity', () => {
  it.each(['property_value', 'equity', 'loan'])(
    '%s: a failing cash flow step rolls back everything',
    (mode) => {
      const extra = mode === 'loan' ? { add_home: { name: 'New', value: 1 } } : {};
      const before = state();
      expect(
        statusOf(() => convert(mode, { ...extra, cash_flow: { mode: 'link', expense_id: 'nope' } }))
      ).toBe(404);
      expect(state()).toBe(before);
      expect(
        statusOf(() =>
          convert(mode, { ...extra, cash_flow: { mode: 'create', category_id: 'nope' } })
        )
      ).toBe(404);
      expect(state()).toBe(before);
    }
  );

  it.each(['property_value', 'equity', 'loan'])(
    '%s: an unexpected failure is a fixed 500, rolls back and leaks nothing',
    (mode) => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {})
      );
      const real = db.execute.bind(db);
      vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('SET source_detail')) throw new Error('UNIQUE 248000 SecretHouse');
        return real(sql, params);
      });
      const extra = mode === 'loan' ? { add_home: { name: 'SecretHouse', value: 1 } } : {};
      const before = state();
      const err = errorOf(() => convert(mode, { ...extra, cash_flow: { mode: 'create' } }));
      expect(err?.status).toBe(500);
      expect(err?.message).toBe(SAVE_FAILED);
      const text = spies
        .flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
        .join('\n');
      for (const secret of ['248000', '612000', '860000', 'SecretHouse', 'First Bank'])
        expect(text).not.toContain(secret);
      vi.restoreAllMocks();
      expect(state()).toBe(before);
    }
  );
});

describe('revert', () => {
  const cases: Array<[string, Body | null]> = [];
  for (const mode of ['property_value', 'equity', 'loan'])
    for (const cashFlow of [null, { mode: 'create' }]) cases.push([mode, cashFlow]);

  it.each(cases)('%s with cash flow %j restores everything exactly', (mode, cashFlow) => {
    const before = state();
    const extra: Body = mode === 'loan' ? { add_home: { name: 'Our house', value: 700000 } } : {};
    if (cashFlow) extra['cash_flow'] = cashFlow;
    const id = convert(mode, extra)['liability'].id as string;
    api.recordLiabilityBalance(id, { balance: 247000 });
    expect(revert(id)).toEqual({ reverted: true });
    expect(state()).toBe(before);
    expect(statusOf(() => api.getLiability(id))).toBe(404);
  });

  it('restores the split of a linked expense', () => {
    const expId = seedExpense();
    const before = hashes();
    const id = convert('property_value', { cash_flow: { mode: 'link', expense_id: expId } })[
      'liability'
    ].id as string;
    expect(row('budget_expenses', expId)!['is_mortgage']).toBe(1);
    revert(id);
    expect(hashes()).toEqual(before);
  });

  it('keeps a created property account that holds later positions', () => {
    const res = convert('loan', { add_home: { name: 'Our house', value: 700000 } });
    const acct = res['created'].account_id as string;
    db.execute(
      "INSERT INTO positions (id, account_id, ticker, name, shares, current_price) VALUES ('pos-later', ?, 'RE', 'Cabin', 1, 1)",
      [acct]
    );
    revert(res['liability'].id);
    expect(row('accounts', acct)).toBeDefined();
    expect(row('positions', 'pos-later')).toBeDefined();
    expect(row('positions', res['created'].position_id)).toBeUndefined();
    expect(row('positions', 'pos-re')).toBeDefined();
  });

  it('refuses liabilities that are not conversions, and unknown ids', () => {
    const id = api.createLiability({
      name: 'Card',
      liability_type: 'credit_card',
      current_balance: 5,
    }).id;
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('Only converted debts can be undone');
    expect(statusOf(() => api.getLiability(id))).toBe(200);
    expect(statusOf(() => revert('nope'))).toBe(404);
  });

  it('a second revert is a 404', () => {
    const id = convert('equity')['liability'].id as string;
    revert(id);
    expect(statusOf(() => revert(id))).toBe(404);
  });

  it('equity refuses after the price was edited', () => {
    const id = convert('equity')['liability'].id as string;
    db.execute("UPDATE positions SET current_price = 900000 WHERE id = 'pos-re'");
    const before = state();
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe(
      'The property value changed after the conversion, so it cannot be undone'
    );
    expect(state()).toBe(before);
  });

  it('equity refuses after the position was deleted', () => {
    const id = convert('equity')['liability'].id as string;
    db.execute("DELETE FROM positions WHERE id = 'pos-re'");
    const before = state();
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe(
      'The property was removed after the conversion, so it cannot be undone'
    );
    expect(state()).toBe(before);
  });

  it('equity keeps later edits to other columns', () => {
    const id = convert('equity')['liability'].id as string;
    db.execute(
      "UPDATE positions SET name = 'Renamed', updated_at = '2026-10-04 09:00:00' WHERE id = 'pos-re'"
    );
    const edited = row('positions', 'pos-re')!;
    revert(id);
    expect(row('positions', 'pos-re')).toEqual({ ...edited, current_price: 612000 });
  });

  it('loan refuses when the original account is gone', () => {
    const id = convert('loan')['liability'].id as string;
    db.execute("DELETE FROM positions WHERE id = 'pos-vti'");
    db.execute("DELETE FROM accounts WHERE id = 'acct-b'");
    const before = state();
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('The account that held this position no longer exists');
    expect(state()).toBe(before);
  });

  it('property_value ignores later edits to the position', () => {
    const id = convert('property_value')['liability'].id as string;
    db.execute("UPDATE positions SET current_price = 650000 WHERE id = 'pos-re'");
    const edited = hashes();
    revert(id);
    expect(hashes()).toEqual(edited);
  });

  it('refuses a corrupt source_detail', () => {
    const id = convert('equity')['liability'].id as string;
    db.execute("UPDATE liabilities SET source_detail = '{not json' WHERE id = ?", [id]);
    const before = state();
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('This conversion cannot be undone');
    expect(state()).toBe(before);
  });

  it('an unexpected failure is a fixed 500 and rolls back', () => {
    const id = convert('loan', {
      add_home: { name: 'SecretHouse', value: 700000 },
      cash_flow: { mode: 'create' },
    })['liability'].id as string;
    const before = state();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const real = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.startsWith('DELETE FROM liabilities')) throw new Error('248000 SecretHouse');
      return real(sql, params);
    });
    const err = errorOf(() => revert(id));
    expect(err?.status).toBe(500);
    expect(err?.message).toBe(SAVE_FAILED);
    const text = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    for (const secret of ['248000', 'SecretHouse']) expect(text).not.toContain(secret);
    vi.restoreAllMocks();
    expect(state()).toBe(before);
  });
});

describe('dispatcher routes', () => {
  beforeEach(async () => {
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    seed(clientDB);
  });

  afterEach(() => {
    clientDB.close();
  });

  it('routes convert-position (not swallowed by {id}) and revert-conversion', () => {
    const res = tryLocalRoute('/api/liabilities/convert-position', {
      method: 'POST',
      body: body('equity'),
    }) as Result;
    expect(res['liability'].source).toBe('converted_position');
    const id = res['liability'].id as string;
    expect(tryLocalRoute(`/api/liabilities/${id}/revert-conversion`, { method: 'POST' })).toEqual({
      reverted: true,
    });
  });
});
