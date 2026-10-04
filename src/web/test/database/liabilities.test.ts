/**
 * LocalAPI liabilities (browser path). Ports tests/api/test_liabilities_api.py
 * case by case against fresh in-memory databases. Today is pinned to 2026-10-04.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { LocalHttpError } from '@/database/local-error';
import { createTestApi, useSequentialUuids } from './helpers';

const TYPES = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'credit_card',
  'personal_loan',
  'heloc',
  'other',
];
const EXPECTED_AMORTIZING: Record<string, boolean> = {
  mortgage: true,
  auto_loan: true,
  student_loan: true,
  credit_card: false,
  personal_loan: true,
  heloc: false,
  other: false,
};

type Body = Record<string, unknown>;
type Liab = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let restoreUuids: () => void;
let db: ClientDatabase;
let api: LocalAPI;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  restoreUuids = useSequentialUuids();
  ({ db, api } = await createTestApi());
  db.execute('DELETE FROM budget_expense_categories');
  ['Housing', 'Transportation', 'Debt Payments', 'Other'].forEach((name, i) =>
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

function mortgageBody(over: Body = {}): Body {
  return {
    name: 'Home loan',
    liability_type: 'mortgage',
    current_balance: 520000,
    balance_as_of: '2026-10-01',
    interest_rate: 0.0625,
    payment_amount: 3201.73,
    next_payment_date: '2026-11-01',
    ...over,
  };
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof LocalHttpError) return e.status;
    throw e;
  }
  return 200;
}

function create(body: Body): Liab {
  return api.createLiability(body as never) as unknown as Liab;
}

function one<T = Liab>(sql: string, params: unknown[] = []): T {
  const rows = db.query<T>(sql, params);
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

function counts(): Record<string, number> {
  const n = (t: string): number => one<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`).c;
  return {
    liabilities: n('liabilities'),
    snapshots: n('liability_balance_snapshots'),
    accounts: n('accounts'),
    positions: n('positions'),
    expenses: n('budget_expenses'),
  };
}

function seedPosition(value = 600000): string {
  db.execute(
    "INSERT INTO accounts (id, name, account_type) VALUES ('acct-h', 'Houses', 'property')"
  );
  db.execute(
    "INSERT INTO positions (id, account_id, ticker, name, shares, current_price, position_type) VALUES ('pos-h', 'acct-h', 'RE', 'Home', 1.0, ?, 'real_estate')",
    [value]
  );
  return 'pos-h';
}

function seedExpense(amount = 1500, name = 'Mortgage'): string {
  db.execute(
    "INSERT INTO budget_expenses (id, category_id, name, amount, frequency) VALUES (?, 'cat-Housing', ?, ?, 'monthly')",
    [`exp-${name}`, name, amount]
  );
  return `exp-${name}`;
}

describe('create', () => {
  it.each(TYPES)('creates a %s with defaults and a first snapshot', (type) => {
    const body = create({
      name: 'Debt',
      liability_type: type,
      current_balance: 1000,
      balance_as_of: '2026-09-30',
    });
    expect(body.is_amortizing).toBe(EXPECTED_AMORTIZING[type]);
    expect(body.payment_frequency).toBe('monthly');
    expect(body.source).toBe('manual');
    expect(body.is_active).toBe(true);
    expect(body.balance_as_of).toBe('2026-09-30');
    const snap = one('SELECT * FROM liability_balance_snapshots');
    expect(snap.snapshot_date).toBe('2026-09-30');
    expect(snap.balance).toBe(1000);
  });

  it('derives other+term as amortizing and lets an explicit flag win', () => {
    expect(
      create({ name: 'x', liability_type: 'other', current_balance: 5, term_months: 24 })
        .is_amortizing
    ).toBe(true);
    expect(
      create({ name: 'x', liability_type: 'mortgage', current_balance: 5, is_amortizing: false })
        .is_amortizing
    ).toBe(false);
  });

  it('defaults balance_as_of to the local calendar day', () => {
    expect(create({ name: 'x', liability_type: 'other', current_balance: 5 }).balance_as_of).toBe(
      '2026-10-04'
    );
  });

  it('computes the golden mortgage fields', () => {
    const b = create(
      mortgageBody({ escrow_amount: 500, origination_date: '2026-10-01', term_months: 360 })
    );
    expect(b.estimated_balance).toBeCloseTo(520000, 2);
    expect(b.periods_remaining).toBe(360);
    expect(b.payoff_date).toBe('2056-10-01');
    expect(b.monthly_payment).toBeCloseTo(3201.73, 2);
    expect(b.monthly_cash_flow).toBeCloseTo(3701.73, 2);
    expect(Math.abs(b.total_interest_remaining - (3201.73 * 360 - 520000))).toBeLessThan(5);
    expect(b.maturity_date).toBe('2056-10-01');
    expect(b.last_reported_date).toBe('2026-10-01');
    expect(b.linked_position).toBeNull();
    expect(b.expense).toBeNull();
    expect(b.linked_position_missing).toBe(false);
    expect(b.expense_missing).toBe(false);
  });

  it('converts a biweekly payment to monthly', () => {
    const b = create({
      name: 'x',
      liability_type: 'auto_loan',
      current_balance: 10000,
      interest_rate: 0.05,
      payment_amount: 200,
      payment_frequency: 'biweekly',
      next_payment_date: '2026-10-10',
    });
    expect(b.monthly_payment).toBeCloseTo((200 * 26) / 12, 2);
  });

  it('gives an interest-only HELOC no payoff', () => {
    const b = create({
      name: 'h',
      liability_type: 'heloc',
      current_balance: 100000,
      interest_rate: 0.085,
      payment_amount: 708.33,
    });
    expect(b.payoff_date).toBeNull();
    expect(b.periods_remaining).toBeNull();
  });

  it.each<[string, Body]>([
    ['negative balance', { current_balance: -1 }],
    ['huge balance', { current_balance: 1e11 }],
    ['rate above 1', { interest_rate: 1.5 }],
    ['negative rate', { interest_rate: -0.1 }],
    ['unknown type', { liability_type: 'boat' }],
    ['term 0', { term_months: 0 }],
    ['term 601', { term_months: 601 }],
    ['empty name', { name: '' }],
    ['long name', { name: 'x'.repeat(121) }],
    ['bad frequency', { payment_frequency: 'daily' }],
    ['bad date', { balance_as_of: 'not-a-date' }],
    ['unknown field', { surprise: 1 }],
  ])('rejects %s with 422 and writes nothing', (_label, patch) => {
    const before = counts();
    expect(
      statusOf(() => create({ name: 'x', liability_type: 'other', current_balance: 10, ...patch }))
    ).toBe(422);
    expect(counts()).toEqual(before);
  });

  it('returns only the resource', () => {
    const b = create(mortgageBody({ property: null, cash_flow: { mode: 'none' } }));
    expect(b).not.toHaveProperty('property');
    expect(b).not.toHaveProperty('cash_flow');
    expect(b).not.toHaveProperty('source_detail');
    expect(b.id).toBeTruthy();
    expect(b.name).toBe('Home loan');
  });
});

describe('property', () => {
  it('creates an alternative real_estate position on a new Real estate account and reuses it', () => {
    const b = create(
      mortgageBody({
        property: {
          mode: 'create',
          name: 'Main St',
          value: 700000,
          cost_basis: 500000,
          purchase_date: '2015-06-01',
        },
      })
    );
    const acct = one('SELECT * FROM accounts');
    expect(acct.name).toBe('Real estate');
    expect(acct.account_type).toBe('property');
    expect(acct.entity_id).toBeNull();
    const pos = one('SELECT * FROM positions');
    expect(pos.position_type).toBe('real_estate');
    expect(pos.asset_class).toBe('alternative');
    expect(pos.ticker).toBe('RE');
    expect(pos.account_id).toBe(acct.id);
    expect(pos.name).toBe('Main St');
    expect(pos.current_price).toBe(700000);
    expect(pos.shares).toBe(1);
    expect(pos.cost_basis).toBe(500000);
    expect(pos.purchase_date).toBe('2015-06-01');
    expect(b.linked_position_id).toBe(pos.id);
    expect(b.linked_position.value).toBe(700000);
    create(mortgageBody({ property: { mode: 'create', name: 'Cabin', value: 1 } }));
    expect(counts().accounts).toBe(1);
    expect(counts().positions).toBe(2);
  });

  it('links an existing position and 404s a missing one without writing', () => {
    const posId = seedPosition();
    const b = create(mortgageBody({ property: { mode: 'link', position_id: posId } }));
    expect(b.linked_position).toEqual({ id: posId, name: 'Home', value: 600000 });
    const before = counts();
    expect(
      statusOf(() => create(mortgageBody({ property: { mode: 'link', position_id: 'nope' } })))
    ).toBe(404);
    expect(counts()).toEqual(before);
  });

  it('rolls back the created account and position when a later step fails (422)', () => {
    const before = counts();
    const status = statusOf(() =>
      create({
        name: 'd',
        liability_type: 'other',
        current_balance: 5,
        property: { mode: 'create', name: 'p', value: 1 },
        cash_flow: { mode: 'create' },
      })
    );
    expect(status).toBe(422);
    expect(counts()).toEqual(before);
  });

  it('rolls back everything when a write fails unexpectedly (fixed 500)', () => {
    const before = counts();
    const real = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO budget_expenses')) throw new Error('boom');
      return real(sql, params);
    });
    let err: unknown;
    try {
      create(
        mortgageBody({
          property: { mode: 'create', name: 'p', value: 1 },
          cash_flow: { mode: 'create' },
        })
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LocalHttpError);
    expect((err as LocalHttpError).status).toBe(500);
    expect((err as LocalHttpError).message).toBe('Could not save the liability');
    vi.restoreAllMocks();
    expect(counts()).toEqual(before);
  });

  it('leaves other positions of a reused property account unchanged', () => {
    seedPosition(600000);
    db.execute(
      "INSERT INTO positions (id, account_id, ticker, name, shares, current_price, cost_basis, position_type) VALUES ('pos-c', 'acct-h', 'RE', 'Cabin', 1.0, 90000, 70000, 'real_estate')"
    );
    const snap = (): unknown[] =>
      db.query(
        "SELECT id, name, shares, current_price, cost_basis, position_type, asset_class FROM positions WHERE name != 'New' ORDER BY id"
      );
    const before = snap();
    create(mortgageBody({ property: { mode: 'create', name: 'New', value: 1000 } }));
    expect(counts().accounts).toBe(1);
    expect(snap()).toEqual(before);
    expect(counts().positions).toBe(3);
  });
});

describe('cash flow', () => {
  it('creates an expense with the mortgage split', () => {
    const b = create(mortgageBody({ escrow_amount: 500, cash_flow: { mode: 'create' } }));
    const exp = one('SELECT * FROM budget_expenses');
    expect(exp.id).toBe(b.expense_id);
    expect(exp.category_id).toBe('cat-Housing');
    expect(exp.name).toBe('Home loan');
    expect(exp.frequency).toBe('monthly');
    expect(exp.amount).toBeCloseTo(3701.73, 2);
    expect(exp.is_mortgage).toBe(1);
    expect(exp.interest_portion).toBeCloseTo((520000 * 0.0625) / 12, 2);
    expect(exp.principal_portion).toBeCloseTo(3201.73 - (520000 * 0.0625) / 12, 2);
    expect(String(exp.end_date).slice(0, 10)).toBe('2056-10-01');
    expect(b.expense.monthly_amount).toBeCloseTo(3701.73, 2);
  });

  it.each([
    ['auto_loan', 'cat-Transportation'],
    ['student_loan', 'cat-Debt Payments'],
    ['heloc', 'cat-Housing'],
  ])('picks the category for %s', (type, category) => {
    create({
      name: 'd',
      liability_type: type,
      current_balance: 1000,
      interest_rate: 0.05,
      payment_amount: 100,
      next_payment_date: '2026-11-01',
      cash_flow: { mode: 'create' },
    });
    const exp = one('SELECT * FROM budget_expenses');
    expect(exp.category_id).toBe(category);
    expect(exp.is_mortgage).toBe(0);
  });

  it('uses an explicit category and 404s a missing one', () => {
    create(mortgageBody({ cash_flow: { mode: 'create', category_id: 'cat-Other' } }));
    expect(one('SELECT * FROM budget_expenses').category_id).toBe('cat-Other');
    expect(
      statusOf(() => create(mortgageBody({ cash_flow: { mode: 'create', category_id: 'nope' } })))
    ).toBe(404);
  });

  it('falls back to Other, then any category, and never creates one', () => {
    db.execute(
      "DELETE FROM budget_expense_categories WHERE name IN ('Housing', 'Debt Payments', 'Transportation')"
    );
    create(mortgageBody({ cash_flow: { mode: 'create' } }));
    expect(one('SELECT * FROM budget_expenses').category_id).toBe('cat-Other');
    db.execute('DELETE FROM budget_expenses');
    db.execute("DELETE FROM budget_expense_categories WHERE name = 'Other'");
    db.execute(
      "INSERT INTO budget_expense_categories (id, name, sort_order) VALUES ('cat-z', 'Zed', 9), ('cat-a', 'Aaa', 5)"
    );
    create(mortgageBody({ name: 'Second', cash_flow: { mode: 'create' } }));
    expect(one('SELECT * FROM budget_expenses').category_id).toBe('cat-a');
  });

  it('is 422 with no category at all, and creates none', () => {
    db.execute('DELETE FROM budget_expense_categories');
    const before = counts();
    expect(statusOf(() => create(mortgageBody({ cash_flow: { mode: 'create' } })))).toBe(422);
    expect(counts()).toEqual(before);
    expect(one<{ c: number }>('SELECT COUNT(*) AS c FROM budget_expense_categories').c).toBe(0);
  });

  it('is 422 when creating an expense without a payment', () => {
    const before = counts();
    expect(
      statusOf(() =>
        create({
          name: 'd',
          liability_type: 'other',
          current_balance: 5,
          cash_flow: { mode: 'create' },
        })
      )
    ).toBe(422);
    expect(counts()).toEqual(before);
  });

  it('links an expense, sets the mortgage split, keeps the amount, 404s a missing one', () => {
    const expId = seedExpense();
    const b = create(mortgageBody({ cash_flow: { mode: 'link', expense_id: expId } }));
    expect(b.expense_id).toBe(expId);
    const exp = one('SELECT * FROM budget_expenses WHERE id = ?', [expId]);
    expect(exp.is_mortgage).toBe(1);
    expect(exp.interest_portion).toBeTruthy();
    expect(exp.principal_portion).toBeTruthy();
    expect(exp.amount).toBe(1500);
    const before = counts();
    expect(
      statusOf(() => create(mortgageBody({ cash_flow: { mode: 'link', expense_id: 'nope' } })))
    ).toBe(404);
    expect(counts()).toEqual(before);
  });

  it('writes no expense for mode none', () => {
    create(mortgageBody({ cash_flow: { mode: 'none' } }));
    expect(counts().expenses).toBe(0);
  });

  it('409s an expense already linked elsewhere (create and update)', () => {
    const expId = seedExpense();
    const first = create(mortgageBody({ cash_flow: { mode: 'link', expense_id: expId } }));
    const before = counts();
    expect(
      statusOf(() => create(mortgageBody({ cash_flow: { mode: 'link', expense_id: expId } })))
    ).toBe(409);
    expect(counts()).toEqual(before);
    const other = create(mortgageBody({ name: 'Other' }));
    expect(statusOf(() => api.updateLiability(other.id, { expense_id: expId }))).toBe(409);
    expect(statusOf(() => api.updateLiability(first.id, { expense_id: expId }))).toBe(200);
  });
});

describe('update', () => {
  function withExpense(): Liab {
    return create(mortgageBody({ cash_flow: { mode: 'create' } }));
  }

  it('syncs the linked expense on a payment change by default', () => {
    const lid = withExpense().id;
    const b = api.updateLiability(lid, { payment_amount: 3500 }) as unknown as Liab;
    expect(b.payment_amount).toBe(3500);
    expect(one('SELECT * FROM budget_expenses').amount).toBeCloseTo(3500, 2);
  });

  it('leaves the expense when sync_expense is false', () => {
    const lid = withExpense().id;
    api.updateLiability(lid, { payment_amount: 3500 }, false);
    expect(one('SELECT * FROM budget_expenses').amount).toBeCloseTo(3201.73, 2);
  });

  it('does not touch the expense for unrelated fields', () => {
    const lid = withExpense().id;
    db.execute('UPDATE budget_expenses SET amount = 1.0');
    api.updateLiability(lid, { notes: 'hi', lender: 'Bank' });
    expect(one('SELECT * FROM budget_expenses').amount).toBe(1);
  });

  it('archives with a closed date and reactivates', () => {
    const lid = create(mortgageBody()).id;
    let b = api.updateLiability(lid, { is_active: false }) as unknown as Liab;
    expect(b.is_active).toBe(false);
    expect(b.closed_date).toBe('2026-10-04');
    expect(b.estimated_balance).toBe(0);
    b = api.updateLiability(lid, { is_active: true }) as unknown as Liab;
    expect(b.closed_date).toBeNull();
  });

  it('404s and validates', () => {
    expect(statusOf(() => api.updateLiability('nope', { notes: 'x' }))).toBe(404);
    const lid = create(mortgageBody()).id;
    expect(statusOf(() => api.updateLiability(lid, { interest_rate: 2 }))).toBe(422);
    expect(statusOf(() => api.updateLiability(lid, { current_balance: 1 } as never))).toBe(422);
  });

  it('rejects null for required fields', () => {
    const lid = create(mortgageBody()).id;
    for (const f of ['name', 'liability_type', 'payment_frequency', 'is_amortizing', 'is_active']) {
      expect(statusOf(() => api.updateLiability(lid, { [f]: null } as never))).toBe(422);
    }
  });

  it('sets updated_at explicitly on every update', () => {
    const lid = create(mortgageBody()).id;
    db.execute("UPDATE liabilities SET updated_at = '2000-01-01 00:00:00'");
    api.updateLiability(lid, { notes: 'n' });
    expect(one('SELECT updated_at FROM liabilities').updated_at).not.toBe('2000-01-01 00:00:00');
    db.execute("UPDATE liabilities SET updated_at = '2000-01-01 00:00:00'");
    api.recordLiabilityBalance(lid, { balance: 1000, as_of: '2026-10-04' });
    expect(one('SELECT updated_at FROM liabilities').updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('is 422 for a null or zero payment with sync and leaves everything; without sync it clears', () => {
    const lid = withExpense().id;
    const before = one('SELECT amount, end_date, principal_portion FROM budget_expenses');
    for (const bad of [null, 0]) {
      expect(statusOf(() => api.updateLiability(lid, { payment_amount: bad }))).toBe(422);
    }
    expect(one('SELECT amount, end_date, principal_portion FROM budget_expenses')).toEqual(before);
    expect(one('SELECT payment_amount FROM liabilities').payment_amount).toBe(3201.73);
    const b = api.updateLiability(lid, { payment_amount: null }, false) as unknown as Liab;
    expect(b.payment_amount).toBeNull();
    expect(one('SELECT amount FROM budget_expenses').amount).toBe(before.amount);
  });

  it('links and unlinks an expense with the mortgage split', () => {
    const lid = create(mortgageBody()).id;
    const expId = seedExpense(1500);
    let b = api.updateLiability(lid, { expense_id: expId }) as unknown as Liab;
    expect(b.expense_id).toBe(expId);
    const exp = one('SELECT * FROM budget_expenses WHERE id = ?', [expId]);
    expect(exp.amount).toBe(1500);
    expect(exp.is_mortgage).toBe(1);
    expect(exp.interest_portion).toBeCloseTo((520000 * 0.0625) / 12, 2);
    expect(exp.principal_portion).toBeCloseTo(3201.73 - (520000 * 0.0625) / 12, 2);
    b = api.updateLiability(lid, { expense_id: null }) as unknown as Liab;
    expect(b.expense_id).toBeNull();
    expect(b.expense_missing).toBe(false);
    expect(statusOf(() => api.updateLiability(lid, { expense_id: 'nope' }))).toBe(404);
  });

  it('links and unlinks a position, 404s a missing one', () => {
    const lid = create(mortgageBody()).id;
    const posId = seedPosition();
    expect(
      (api.updateLiability(lid, { linked_position_id: posId }) as unknown as Liab).linked_position
        .id
    ).toBe(posId);
    expect(
      (api.updateLiability(lid, { linked_position_id: null }) as unknown as Liab).linked_position_id
    ).toBeNull();
    expect(statusOf(() => api.updateLiability(lid, { linked_position_id: 'nope' }))).toBe(404);
  });

  it('re-derives is_amortizing on a type change unless sent', () => {
    const lid = create(mortgageBody()).id;
    const up = (c: Body): Liab => api.updateLiability(lid, c as never) as unknown as Liab;
    expect(up({ liability_type: 'credit_card' }).is_amortizing).toBe(false);
    expect(up({ liability_type: 'auto_loan' }).is_amortizing).toBe(true);
    expect(up({ liability_type: 'credit_card', is_amortizing: true }).is_amortizing).toBe(true);
    expect(up({ notes: 'n' }).is_amortizing).toBe(true);
  });
});

describe('delete', () => {
  it('keeps the expense by default and 404s a repeat', () => {
    const lid = create(mortgageBody({ cash_flow: { mode: 'create' } })).id;
    expect(api.deleteLiability(lid)).toEqual({ deleted: true, id: lid, expense_deleted: false });
    const c = counts();
    expect(c.liabilities).toBe(0);
    expect(c.snapshots).toBe(0);
    expect(c.expenses).toBe(1);
    expect(statusOf(() => api.deleteLiability(lid))).toBe(404);
  });

  it('deletes the expense on request', () => {
    const lid = create(mortgageBody({ cash_flow: { mode: 'create' } })).id;
    expect(api.deleteLiability(lid, true).expense_deleted).toBe(true);
    expect(counts().expenses).toBe(0);
  });
});

describe('record balance', () => {
  it('upserts per day and tracks the newest', () => {
    const lid = create(mortgageBody()).id; // reported 2026-10-01
    const rec = (b: Body): Liab => api.recordLiabilityBalance(lid, b as never) as unknown as Liab;
    let r = rec({ balance: 510000, as_of: '2026-10-03' });
    expect(r.current_balance).toBe(510000);
    expect(r.balance_as_of).toBe('2026-10-03');
    r = rec({ balance: 509000, as_of: '2026-10-03' });
    expect(r.current_balance).toBe(509000);
    expect(counts().snapshots).toBe(2);
    r = rec({ balance: 530000, as_of: '2026-09-01' });
    expect(r.current_balance).toBe(509000);
    expect(r.balance_as_of).toBe('2026-10-03');
    expect(counts().snapshots).toBe(3);
    expect(rec({ balance: 500000 }).balance_as_of).toBe('2026-10-04');
    expect(statusOf(() => rec({ balance: -5 }))).toBe(422);
    expect(statusOf(() => api.recordLiabilityBalance('nope', { balance: 5 }))).toBe(404);
  });
});

describe('history', () => {
  it('returns reported points and a month-end series ending today', () => {
    const lid = create({
      name: 'c',
      liability_type: 'credit_card',
      current_balance: 1000,
      balance_as_of: '2026-07-15',
    }).id;
    api.recordLiabilityBalance(lid, { balance: 1500, as_of: '2026-09-10' });
    const body = api.getLiabilityHistory(lid);
    expect(body.reported.map((p) => [p.date, p.balance])).toEqual([
      ['2026-07-15', 1000],
      ['2026-09-10', 1500],
    ]);
    expect(body.reported.every((p) => p.source === 'manual')).toBe(true);
    expect(body.series.map((p) => p.date)).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-04',
    ]);
    expect(body.series.map((p) => p.balance)).toEqual([1000, 1000, 1500, 1500]);
    expect(body.series.every((p) => p.source === null)).toBe(true);
    expect(statusOf(() => api.getLiabilityHistory('nope'))).toBe(404);
  });

  it('declines for an amortizing loan', () => {
    const lid = create(
      mortgageBody({ balance_as_of: '2026-01-15', next_payment_date: '2026-02-01' })
    ).id;
    const balances = api.getLiabilityHistory(lid).series.map((p) => p.balance);
    expect(balances).toEqual([...balances].sort((a, b) => b - a));
    expect(balances[balances.length - 1]).toBeLessThan(balances[0] as number);
  });
});

describe('reads', () => {
  it('returns dangling links as null with flags', () => {
    const posId = seedPosition();
    const expId = seedExpense();
    const lid = create(
      mortgageBody({
        property: { mode: 'link', position_id: posId },
        cash_flow: { mode: 'link', expense_id: expId },
      })
    ).id;
    db.execute('DELETE FROM positions WHERE id = ?', [posId]);
    db.execute('DELETE FROM budget_expenses WHERE id = ?', [expId]);
    const b = api.getLiability(lid) as unknown as Liab;
    expect(b.linked_position).toBeNull();
    expect(b.linked_position_missing).toBe(true);
    expect(b.expense).toBeNull();
    expect(b.expense_missing).toBe(true);
    expect(b.linked_position_id).toBeNull();
    expect(b.expense_id).toBeNull();
  });

  it('filters, orders and 404s', () => {
    const a = create({
      name: 'A',
      liability_type: 'other',
      current_balance: 1,
      entity_id: 'e1',
    }).id;
    const b = create({ name: 'B', liability_type: 'other', current_balance: 2 }).id;
    api.updateLiability(b, { is_active: false });
    const ids = (rows: unknown[]): string[] => (rows as Liab[]).map((x) => x.id);
    expect(ids(api.getLiabilities())).toEqual([a]);
    expect(new Set(ids(api.getLiabilities(null, true)))).toEqual(new Set([a, b]));
    expect(ids(api.getLiabilities('e1'))).toEqual([a]);
    expect(api.getLiabilities('zzz')).toEqual([]);
    expect(statusOf(() => api.getLiability('nope'))).toBe(404);
  });
});

describe('validation of dates', () => {
  it('rejects future balance dates (create and record)', () => {
    const before = counts();
    expect(statusOf(() => create(mortgageBody({ balance_as_of: '2026-10-05' })))).toBe(422);
    expect(counts()).toEqual(before);
    const lid = create(mortgageBody({ balance_as_of: '2026-10-04' })).id;
    expect(
      statusOf(() => api.recordLiabilityBalance(lid, { balance: 1, as_of: '2026-10-05' }))
    ).toBe(422);
    expect(
      statusOf(() => api.recordLiabilityBalance(lid, { balance: 1, as_of: '2026-10-04' }))
    ).toBe(200);
  });

  it.each([
    '2026-10-01T00:00:00',
    '2026-10-01T00:00:00Z',
    '2026-10-01 00:00',
    '2026-02-30',
    '20261001',
    20261001,
  ])('rejects datetime or bad day %s everywhere', (value) => {
    const before = counts();
    for (const field of [
      'balance_as_of',
      'next_payment_date',
      'origination_date',
      'maturity_date',
    ]) {
      expect(statusOf(() => create(mortgageBody({ [field]: value })))).toBe(422);
    }
    expect(
      statusOf(() =>
        create(
          mortgageBody({ property: { mode: 'create', name: 'p', value: 1, purchase_date: value } })
        )
      )
    ).toBe(422);
    const lid = create(mortgageBody()).id;
    expect(
      statusOf(() => api.recordLiabilityBalance(lid, { balance: 1, as_of: value as never }))
    ).toBe(422);
    expect(statusOf(() => api.updateLiability(lid, { next_payment_date: value as never }))).toBe(
      422
    );
    expect(counts().liabilities).toBe(before.liabilities + 1);
  });

  it('rejects maturity before origination, allows equal', () => {
    expect(
      statusOf(() =>
        create(mortgageBody({ origination_date: '2026-01-01', maturity_date: '2025-12-31' }))
      )
    ).toBe(422);
    const lid = create(mortgageBody()).id;
    expect(
      statusOf(() =>
        api.updateLiability(lid, { origination_date: '2026-01-01', maturity_date: '2025-12-31' })
      )
    ).toBe(422);
    expect(
      statusOf(() =>
        create(mortgageBody({ origination_date: '2026-01-01', maturity_date: '2026-01-01' }))
      )
    ).toBe(200);
  });
});

describe('logging and errors', () => {
  it('never logs balances, payments, names or lenders', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const lid = create(
      mortgageBody({
        current_balance: 248000,
        name: 'SecretName',
        lender: 'SecretLender',
        cash_flow: { mode: 'create' },
      })
    ).id;
    api.updateLiability(lid, { payment_amount: 1999.99 });
    api.recordLiabilityBalance(lid, { balance: 247000 });
    api.getLiabilityHistory(lid);
    statusOf(() => create({ name: 'x', liability_type: 'boat', current_balance: 248000 }));
    api.deleteLiability(lid);
    const text = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    for (const secret of ['248000', '247000', '1999.99', 'SecretName', 'SecretLender', '3201.73']) {
      expect(text).not.toContain(secret);
    }
  });

  it('turns unexpected errors into a fixed 500 without leaking, and rolls back', () => {
    const lid = create(mortgageBody({ current_balance: 248000 })).id;
    const real = db.execute.bind(db);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (/INSERT INTO liability|UPDATE liabilities|DELETE FROM liability_balance/.test(sql)) {
        throw new Error('UNIQUE 248000 SecretName');
      }
      return real(sql, params);
    });
    const before = counts();
    const calls = [
      () => create(mortgageBody({ current_balance: 248000, name: 'SecretName' })),
      () => api.updateLiability(lid, { notes: 'x' }),
      () => api.recordLiabilityBalance(lid, { balance: 248000, as_of: '2026-10-02' }),
      () => api.deleteLiability(lid),
    ];
    for (const call of calls) {
      let err: unknown;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LocalHttpError);
      expect((err as LocalHttpError).status).toBe(500);
      expect((err as LocalHttpError).message).toBe('Could not save the liability');
    }
    const text = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    for (const secret of ['248000', 'SecretName']) expect(text).not.toContain(secret);
    vi.restoreAllMocks();
    expect(counts()).toEqual(before);
  });
});

describe('empty and no-op updates', () => {
  it('returns 200 for {}, for activating an active row and for archiving an archived one', () => {
    const lid = create(mortgageBody()).id;
    expect(statusOf(() => api.updateLiability(lid, {}))).toBe(200);
    expect(statusOf(() => api.updateLiability(lid, { is_active: true }))).toBe(200);
    api.updateLiability(lid, { is_active: false });
    const closed = one('SELECT closed_date FROM liabilities').closed_date;
    expect(statusOf(() => api.updateLiability(lid, { is_active: false }))).toBe(200);
    expect(one('SELECT closed_date FROM liabilities').closed_date).toBe(closed);
  });

  it('sets updated_at even for an empty update', () => {
    const lid = create(mortgageBody()).id;
    db.execute("UPDATE liabilities SET updated_at = '2000-01-01 00:00:00'");
    api.updateLiability(lid, {});
    expect(one('SELECT updated_at FROM liabilities').updated_at).not.toBe('2000-01-01 00:00:00');
  });
});

describe('null and empty values', () => {
  it('create accepts is_amortizing null (derived from type); update rejects it', () => {
    expect(create(mortgageBody({ is_amortizing: null })).is_amortizing).toBe(true);
    expect(
      create({ name: 'c', liability_type: 'credit_card', current_balance: 1, is_amortizing: null })
        .is_amortizing
    ).toBe(false);
    const lid = create(mortgageBody()).id;
    expect(statusOf(() => api.updateLiability(lid, { is_amortizing: null }))).toBe(422);
  });

  it('PUT expense_id "" is a 404 like the server', () => {
    const lid = create(mortgageBody()).id;
    expect(statusOf(() => api.updateLiability(lid, { expense_id: '' }))).toBe(404);
  });

  it('sets updated_at on the expense link written during create', () => {
    const expId = seedExpense();
    create(mortgageBody({ cash_flow: { mode: 'link', expense_id: expId } }));
    expect(one('SELECT updated_at FROM liabilities').updated_at).toBeTruthy();
  });
});

describe('nest-safety', () => {
  it('a failing write inside an outer transaction leaves the outer transaction intact', () => {
    db.execute('BEGIN');
    db.execute(
      "INSERT INTO accounts (id, name, account_type) VALUES ('outer', 'Outer', 'taxable')"
    );
    const real = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO liability_balance_snapshots')) throw new Error('boom');
      return real(sql, params);
    });
    expect(statusOf(() => create(mortgageBody()))).toBe(500);
    vi.restoreAllMocks();
    expect(counts().liabilities).toBe(0);
    // the outer transaction is still open: a successful write nests, then the outer rolls back
    const ok = create(mortgageBody());
    expect(ok.id).toBeTruthy();
    expect(counts().accounts).toBe(1);
    db.execute('ROLLBACK');
    expect(counts().accounts).toBe(0);
    expect(counts().liabilities).toBe(0);
  });

  it('keeps the outer work when it commits after an inner failure', () => {
    db.execute('BEGIN');
    db.execute(
      "INSERT INTO accounts (id, name, account_type) VALUES ('outer', 'Outer', 'taxable')"
    );
    expect(
      statusOf(() => create(mortgageBody({ cash_flow: { mode: 'link', expense_id: 'nope' } })))
    ).toBe(404);
    db.execute('COMMIT');
    expect(counts().accounts).toBe(1);
    expect(counts().liabilities).toBe(0);
  });
});
