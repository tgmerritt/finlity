import { describe, it, expect } from 'vitest';
import { effectivePayment, reviewDebt, suggestExpense } from '@/utils/debt-review';
import { defaultsFor } from '@/utils/debt-fields';
import type { Expense } from '@/types/api';

const mortgage = {
  ...defaultsFor('mortgage'),
  name: 'Home',
  currentBalance: '300000',
  aprPercent: '6.5',
};

describe('effectivePayment', () => {
  it('prefers the typed payment', () => {
    expect(effectivePayment({ ...mortgage, paymentAmount: '2000' })).toEqual({
      payment: 2000,
      calculated: false,
    });
  });
  it('calculates from the term, before a name is typed', () => {
    expect(effectivePayment({ ...mortgage, name: '' })).toEqual({
      payment: 1896.2,
      calculated: true,
    });
  });
  it('uses interest only for a HELOC and nothing for a bare card', () => {
    const heloc = {
      ...defaultsFor('heloc'),
      name: 'H',
      currentBalance: '60000',
      aprPercent: '8.5',
    };
    expect(effectivePayment(heloc)).toEqual({ payment: 425, calculated: true });
    const card = { ...defaultsFor('credit_card'), name: 'C', currentBalance: '900' };
    expect(effectivePayment(card).payment).toBeNull();
  });
});

describe('reviewDebt', () => {
  it('projects payoff, interest and this year from the shared math', () => {
    const r = reviewDebt(mortgage, '2026-10-04');
    expect(r.projected).toBe(true);
    // The payment is rounded to cents, so a tiny last payment may follow.
    expect([360, 361]).toContain(r.paymentsLeft);
    expect(r.payoffDate?.startsWith('2056')).toBe(true);
    expect(r.totalInterestLeft).toBeGreaterThan(380000);
    expect(r.totalInterestLeft).toBeLessThan(384000);
    // Three payments fall in 2026 (Nov 4 and Dec 4 after Oct 4): two here.
    expect(r.yearPrincipal + r.yearInterest).toBeCloseTo(2 * 1896.2, 0);
    expect(r.balances[0]).toBe(300000);
    expect(r.balances[r.balances.length - 1]).toBe(0);
  });
  it('adds escrow to the monthly cash flow', () => {
    const r = reviewDebt({ ...mortgage, escrowAmount: '500' }, '2026-10-04');
    expect(r.monthlyCashFlow).toBeCloseTo(2396.2, 2);
  });
  it('flags a payment that never pays the loan off', () => {
    const r = reviewDebt({ ...mortgage, paymentAmount: '1000' }, '2026-10-04');
    expect(r.neverPaysOff).toBe(true);
    expect(r.payoffDate).toBeNull();
  });
  it('does not project cards or lines', () => {
    const card = {
      ...defaultsFor('credit_card'),
      name: 'C',
      currentBalance: '900',
      paymentAmount: '100',
    };
    expect(reviewDebt(card, '2026-10-04').projected).toBe(false);
  });
});

const exp = (id: string, name: string, monthly: number): Expense => ({
  id,
  name,
  amount: monthly,
  monthly_amount: monthly,
  frequency: 'monthly',
});

describe('suggestExpense', () => {
  const list = [
    exp('e1', 'Groceries', 900),
    exp('e2', 'Mortgage', 3000),
    exp('e3', 'Car Payment #1', 410),
  ];
  it('matches by name first', () => {
    expect(suggestExpense(list, 'mortgage', 100)?.id).toBe('e2');
  });
  it('else by amount within 10%', () => {
    expect(suggestExpense([exp('e9', 'Rent-to-own', 450)], 'personal_loan', 420)?.id).toBe('e9');
    expect(suggestExpense([exp('e9', 'Rent-to-own', 500)], 'personal_loan', 420)).toBeNull();
  });
  it('skips expenses already linked', () => {
    expect(suggestExpense(list, 'mortgage', 100, new Set(['e2']))).toBeNull();
  });
});
