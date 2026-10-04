import { describe, it, expect } from 'vitest';
import { liabilityGroup, debtByYear, debtPayoffSummary } from '@/utils/liabilities';
import { balanceAt, shift } from '@/utils/amortization';
import { summarize as debtsPageSummary } from '@/pages/debts';
import type { DashboardLiability, PortfolioSummary } from '@/types/api';

const debt = (over: Partial<DashboardLiability>): DashboardLiability => ({
  id: 'l1',
  name: 'Mortgage',
  liability_type: 'mortgage',
  balance: 400,
  interest_rate: 0.0625,
  payment_amount: 3000,
  payment_frequency: 'monthly',
  payoff_date: '2052-07-01',
  linked_position_id: null,
  entity_id: null,
  is_amortizing: true,
  last_reported_date: '2026-09-30',
  ...over,
});

const summary = (
  liabilities: DashboardLiability[],
  over: Partial<PortfolioSummary> = {}
): PortfolioSummary =>
  ({
    total_value: 1000,
    liabilities_included: true,
    liabilities_total: liabilities.reduce((s, l) => s + l.balance, 0),
    net_worth: 1000 - liabilities.reduce((s, l) => s + l.balance, 0),
    liabilities,
    ...over,
  }) as PortfolioSummary;

describe('liabilityGroup', () => {
  it('returns null when liabilities are not included or none exist', () => {
    expect(liabilityGroup(summary([debt({})], { liabilities_included: false }))).toBeNull();
    expect(liabilityGroup(summary([]))).toBeNull();
    expect(liabilityGroup({ total_value: 1 } as PortfolioSummary)).toBeNull();
  });

  it('builds a negative group with sorted rows, meta text and a net worth footer', () => {
    const g = liabilityGroup(
      summary([
        debt({
          id: 'c',
          name: 'Chase Sapphire',
          liability_type: 'credit_card',
          balance: 100,
          interest_rate: 0.2299,
          is_amortizing: false,
          payoff_date: null,
          last_reported_date: '2026-09-12',
        }),
        debt({ id: 'm', balance: 300 }),
        debt({
          id: 'a',
          name: 'Auto',
          liability_type: 'auto_loan',
          balance: 200,
          interest_rate: 0.049,
          payoff_date: '2029-02-01',
        }),
      ])
    )!;
    expect(g.key).toBe('liabilities');
    expect(g.label).toBe('Liabilities');
    expect(g.subtotal).toBe(-600);
    expect(g.rows.map((r) => r.id)).toEqual(['m', 'a', 'c']);
    expect(g.rows.map((r) => r.balance)).toEqual([-300, -200, -100]);
    expect(g.rows[0]!.meta).toBe('6.25% · paid off Jul 2052');
    expect(g.rows[1]!.meta).toBe('4.9% · paid off Feb 2029');
    expect(g.rows[2]!.meta).toBe('Card · updated Sep 12');
    expect(g.footer).toEqual({ label: 'Net worth', value: 400 });
  });

  it('falls back gracefully when rate, payoff or report date are missing', () => {
    const g = liabilityGroup(
      summary([
        debt({ id: 'a', interest_rate: null, payoff_date: null }),
        debt({ id: 'b', liability_type: 'heloc', is_amortizing: false, last_reported_date: null }),
      ])
    )!;
    expect(g.rows.map((r) => r.meta)).toEqual(['Mortgage', 'HELOC']);
  });

  it('shows only the rate for an amortizing debt with no payoff date', () => {
    const g = liabilityGroup(summary([debt({ payoff_date: null })]))!;
    expect(g.rows[0]!.meta).toBe('6.25%');
  });

  it('never reports a negative zero', () => {
    const g = liabilityGroup(summary([debt({ balance: 0 })]))!;
    expect(Object.is(g.subtotal, -0)).toBe(false);
    expect(Object.is(g.rows[0]!.balance, -0)).toBe(false);
  });

  it('copy contains no em-dash', () => {
    const g = liabilityGroup(summary([debt({})]))!;
    expect(JSON.stringify(g)).not.toContain('\u2014');
  });
});

describe('debtByYear', () => {
  const full = (over: Record<string, unknown> = {}) => ({
    id: 'l1',
    is_active: true,
    is_amortizing: true,
    interest_rate: 0.06,
    payment_amount: 1000,
    payment_frequency: 'monthly',
    next_payment_date: '2026-10-01',
    origination_date: '2020-01-01',
    closed_date: null,
    current_balance: 100000,
    balance_as_of: '2026-09-01',
    ...over,
  });

  it('matches balanceAt at each anniversary and sums active debts', () => {
    const a = full();
    const b = full({ id: 'l2', payment_amount: 500, current_balance: 20000 });
    const out = debtByYear([a, b] as never, '2026-10-04', 5);
    expect(out).toHaveLength(6);
    const expected = (l: ReturnType<typeof full>, i: number) =>
      balanceAt(
        {
          isAmortizing: true,
          interestRate: l.interest_rate,
          paymentAmount: l.payment_amount,
          paymentFrequency: l.payment_frequency,
          nextPaymentDate: l.next_payment_date,
          originationDate: l.origination_date,
          closedDate: null,
        },
        [{ snapshotDate: l.balance_as_of, balance: l.current_balance }],
        shift('2026-10-04', 'annual', i)
      );
    for (let i = 0; i <= 5; i++) {
      expect(out[i]).toBeCloseTo(expected(a, i) + expected(b, i), 6);
    }
    expect(out[5]!).toBeLessThan(out[0]!);
  });

  it('keeps revolving balances flat and skips inactive debts', () => {
    const card = full({
      id: 'c',
      is_amortizing: false,
      payment_amount: null,
      next_payment_date: null,
      current_balance: 700,
    });
    const gone = full({ id: 'g', is_active: false });
    expect(debtByYear([card, gone] as never, '2026-10-04', 3)).toEqual([700, 700, 700, 700]);
  });

  it('is all zeros with no debts', () => {
    expect(debtByYear([], '2026-10-04', 2)).toEqual([0, 0, 0]);
  });
});

describe('debtPayoffSummary', () => {
  const base = {
    id: 'l1',
    name: 'Mortgage',
    is_active: true,
    payoff_date: '2052-03-01',
    total_interest_remaining: 1500,
  };
  it('returns null with no active debt', () => {
    expect(debtPayoffSummary([], '2026-10-04', 40)).toBeNull();
    expect(
      debtPayoffSummary([{ ...base, is_active: false }] as never, '2026-10-04', 40)
    ).toBeNull();
  });
  it('reports the latest payoff, the age then, interest and each debt', () => {
    const s = debtPayoffSummary(
      [
        base,
        {
          ...base,
          id: 'l2',
          name: 'Car',
          payoff_date: '2029-01-01',
          total_interest_remaining: 500,
        },
        { ...base, id: 'l3', name: 'Card', payoff_date: null, total_interest_remaining: null },
      ] as never,
      '2026-10-04',
      38
    )!;
    expect(s.debtFreeDate).toBe('2052-03-01');
    expect(s.debtFreeAge).toBe(63);
    expect(s.interestLeft).toBe(2000);
    expect(s.debts.map((d) => d.payoffDate)).toEqual(['2052-03-01', '2029-01-01', null]);
  });
});

describe('debtPayoffSummary mixed and rollover cases', () => {
  const d = (id: string, payoff: string | null) =>
    ({ id, name: id, is_active: true, payoff_date: payoff, total_interest_remaining: 1 }) as never;

  it('counts undated debts as excluded and agrees with the Debts page rule', () => {
    const list = [d('a', '2040-05-01'), d('b', null), d('c', '2033-01-01'), d('e', null)];
    const s = debtPayoffSummary(list, '2026-10-04', 38)!;
    expect(s.debtFreeDate).toBe('2040-05-01');
    expect(s.withoutPayoff).toBe(2);
    const page = debtsPageSummary(list.map((x) => ({ ...(x as object) })) as never);
    expect(s.debtFreeDate).toBe(page.debtFreeBy);
    expect(s.withoutPayoff).toBe(page.withoutPayoff);
  });

  it('has no date or age when no debt has a payoff date', () => {
    const s = debtPayoffSummary([d('a', null)], '2026-10-04', 38)!;
    expect(s.debtFreeDate).toBeNull();
    expect(s.debtFreeAge).toBeNull();
    expect(s.withoutPayoff).toBe(1);
  });

  it('rolls the age over on the birthday-style anniversary of today', () => {
    const age = (payoff: string) =>
      debtPayoffSummary([d('a', payoff)], '2026-10-04', 38)!.debtFreeAge;
    expect(age('2052-10-03')).toBe(63);
    expect(age('2052-10-04')).toBe(64);
    expect(age('2052-10-05')).toBe(64);
    expect(age('2053-01-01')).toBe(64);
    expect(age('2026-10-05')).toBe(38);
  });
});
