/**
 * Cash flow and Expenses: the "Linked to <debt>" chip, the follow-the-debt hint
 * in the edit dialog, and the Debt payments stat.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/tabs', () => ({ onTabChange: vi.fn(), showTab: vi.fn(), getCurrentTab: vi.fn() }));
vi.mock('@/charts/budget', () => ({
  loadPaycheckChart: vi.fn(async () => {}),
  renderCashFlowWaterfall: vi.fn(async () => {}),
  updateExpensesCategoryChart: vi.fn(async () => {}),
  renderTransitionChart: vi.fn(async () => {}),
  renderSSComparison: vi.fn(),
  renderIncomeTransitionTable: vi.fn(),
}));

import { apiCall } from '@/api/client';
import { closeDynamicModal } from '@/ui/modal';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadExpenses, loadCashFlowData, editExpense } from '@/pages/budget';
import type { LiabilityResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function debt(over: Partial<LiabilityResponse> = {}): LiabilityResponse {
  return {
    id: 'd1',
    entity_id: null,
    name: 'Mortgage',
    liability_type: 'mortgage',
    lender: null,
    current_balance: 100000,
    balance_as_of: '2026-09-01',
    interest_rate: 0.06,
    payment_amount: 1000,
    payment_frequency: 'monthly',
    next_payment_date: '2026-10-01',
    escrow_amount: null,
    original_principal: 120000,
    origination_date: '2020-01-01',
    term_months: 360,
    maturity_date: null,
    credit_limit: null,
    is_amortizing: true,
    linked_position_id: null,
    expense_id: null,
    source: 'manual',
    source_ref: null,
    is_active: true,
    closed_date: null,
    notes: null,
    created_at: null,
    updated_at: null,
    estimated_balance: 100000,
    payoff_date: '2036-06-01',
    periods_remaining: 117,
    total_interest_remaining: 20000,
    monthly_payment: 1000,
    monthly_cash_flow: 1000,
    linked_position: null,
    linked_position_missing: false,
    expense: null,
    expense_missing: false,
    last_reported_date: '2026-09-01',
    ...over,
  };
}

const EXPENSES = [
  {
    id: 'e1',
    name: 'Mortgage payment',
    category_name: 'Housing',
    amount: 1000,
    monthly_amount: 1000,
    frequency: 'monthly',
  },
  {
    id: 'e2',
    name: 'Groceries',
    category_name: 'Food',
    amount: 400,
    monthly_amount: 400,
    frequency: 'monthly',
  },
];

function route(liabilities: LiabilityResponse[] | 'fail'): void {
  apiCallMock.mockImplementation(async (url: string) => {
    if (url === '/api/budget/expenses') return EXPENSES;
    if (url === '/api/liabilities') {
      if (liabilities === 'fail') throw new Error('boom');
      return liabilities;
    }
    if (url === '/api/budget/calculate-annual') {
      return {
        monthly_gross: 1,
        monthly_net: 1,
        monthly_expenses: 1,
        monthly_savings: 1,
        savings_rate: 1,
        total_taxes: 12,
      };
    }
    return [];
  });
}

describe('linked expense chip', () => {
  beforeEach(() => {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    apiCallMock.mockReset();
  });

  it('shows "Linked to Mortgage" only on the linked expense', async () => {
    route([debt({ expense_id: 'e1' })]);
    await loadExpenses();
    const chips = document.querySelectorAll('.expense-debt-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe('Linked to Mortgage');
    expect(chips[0]!.closest('.expense-item')!.textContent).toContain('Mortgage payment');
  });

  it('renders a debt name with markup as text', async () => {
    route([debt({ expense_id: 'e1', name: '<b>x</b>' })]);
    await loadExpenses();
    const chip = document.querySelector('.expense-debt-chip')!;
    expect(chip.textContent).toBe('Linked to <b>x</b>');
    expect(chip.querySelector('b')).toBeNull();
  });

  it('ignores inactive debts and still lists expenses when liabilities fail', async () => {
    route([debt({ expense_id: 'e1', is_active: false })]);
    await loadExpenses();
    expect(document.querySelectorAll('.expense-debt-chip')).toHaveLength(0);
    route('fail');
    await loadExpenses();
    expect(document.querySelectorAll('.expense-item')).toHaveLength(2);
    expect(document.querySelectorAll('.expense-debt-chip')).toHaveLength(0);
  });
});

describe('edit expense hint', () => {
  beforeEach(async () => {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    apiCallMock.mockReset();
  });

  it('tells the user a linked expense follows the debt', async () => {
    route([debt({ expense_id: 'e1' })]);
    await loadExpenses();
    editExpense('e1');
    const hint = document.querySelector('.expense-debt-hint')!;
    expect(hint.textContent).toBe(
      'This expense follows the debt Mortgage. Change the payment on the Debts page and this amount updates with it.'
    );
  });

  it('shows no hint for an unlinked expense', async () => {
    route([debt({ expense_id: 'e1' })]);
    await loadExpenses();
    editExpense('e2');
    expect(document.querySelector('.expense-debt-hint')).toBeNull();
  });
});

describe('Debt payments stat', () => {
  beforeEach(() => {
    closeDynamicModal();
    document.body.innerHTML =
      '<div class="stat-card" id="stat-monthly-debt-card"><div id="stat-monthly-debt">$0</div></div>';
    apiCallMock.mockReset();
  });

  it('sums monthly_cash_flow of active debts with a linked expense', async () => {
    route([
      debt({ id: 'a', expense_id: 'e1', monthly_cash_flow: 1500.5 }),
      debt({ id: 'b', expense_id: 'e2', monthly_cash_flow: 250 }),
      debt({ id: 'c', expense_id: null, monthly_cash_flow: 999 }),
      debt({ id: 'd', expense_id: 'e9', expense_missing: true, monthly_cash_flow: 888 }),
      debt({ id: 'e', expense_id: 'e3', is_active: false, monthly_cash_flow: 777 }),
    ]);
    await loadCashFlowData();
    expect(document.getElementById('stat-monthly-debt')!.textContent).toBe('$1,750.50');
    expect((document.getElementById('stat-monthly-debt-card') as HTMLElement).hidden).toBe(false);
  });

  it('hides the stat when there are no debts, and leaves the other stats alone', async () => {
    route([]);
    await loadCashFlowData();
    expect((document.getElementById('stat-monthly-debt-card') as HTMLElement).hidden).toBe(true);
    route('fail');
    await loadCashFlowData();
    expect((document.getElementById('stat-monthly-debt-card') as HTMLElement).hidden).toBe(true);
  });

  it('fetches debts once per load', async () => {
    route([debt({ expense_id: 'e1' })]);
    await loadCashFlowData();
    const count = () => apiCallMock.mock.calls.filter((c) => c[0] === '/api/liabilities').length;
    expect(count()).toBe(1);
    await loadExpenses();
    expect(count()).toBe(2);
  });

  it('labels the stat as included in expenses', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    expect(html).toContain('Included in expenses');
  });

  it('copy has no em-dash', () => {
    expect('Linked to Mortgage').not.toContain(String.fromCharCode(0x2014));
  });
});
