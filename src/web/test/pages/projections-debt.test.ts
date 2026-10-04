/**
 * Projections with debts: the "Median minus debt" trace, the Debt payoff card,
 * and an unchanged Monte Carlo request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn(), runAsyncApiCall: vi.fn() }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/loading', () => ({
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  updateLoadingMessage: vi.fn(),
}));
vi.mock('@/ui/tabs', () => ({ onTabChange: vi.fn(), showTab: vi.fn(), getCurrentTab: vi.fn() }));
vi.mock('@/charts/plotly-utils', async (orig) => ({
  ...(await orig<typeof import('@/charts/plotly-utils')>()),
  renderChart: vi.fn(async () => {}),
  ensureThemeUpdates: vi.fn(),
}));

import { apiCall, runAsyncApiCall } from '@/api/client';
import { renderChart, ensureThemeUpdates } from '@/charts/plotly-utils';
import { runProjection } from '@/pages/projections';
import type { LiabilityResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const runAsyncMock = vi.mocked(runAsyncApiCall);
const renderChartMock = vi.mocked(renderChart);

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

const AGES = [38, 39, 40, 41, 42, 43];
const RESULT = {
  success_rate: 0.9,
  median_final_value: 900000,
  worst_case_final: 100000,
  best_case_final: 2000000,
  ages: AGES,
  median_values: [500000, 520000, 540000, 560000, 580000, 600000],
  percentile_10: [1, 1, 1, 1, 1, 1],
  percentile_25: [1, 1, 1, 1, 1, 1],
  percentile_75: [1, 1, 1, 1, 1, 1],
  percentile_90: [1, 1, 1, 1, 1, 1],
};

const FORM = `
  <form id="projection-form">
    <input id="current-age" value="38"><input id="retirement-age" value="43">
    <input id="monthly-contribution" value="1000"><input id="monthly-withdrawal" value="0">
    <input id="stock-allocation" value="60"><input id="bond-allocation" value="40">
    <div id="monte-carlo-config-panel"></div>
  </form>
  <div id="projection-results" style="display:none">
    <div id="chart-projection"></div>
    <span id="success-rate"></span><span id="median-final"></span>
    <span id="worst-case"></span><span id="best-case"></span>
    <div id="debt-payoff-card" hidden></div>
  </div>`;

function setup(liabilities: LiabilityResponse[] | 'fail'): void {
  apiCallMock.mockReset();
  runAsyncMock.mockReset();
  renderChartMock.mockClear();
  runAsyncMock.mockResolvedValue(RESULT);
  apiCallMock.mockImplementation(async (url: string) => {
    if (url === '/api/liabilities') {
      if (liabilities === 'fail') throw new Error('boom');
      return liabilities;
    }
    return {};
  });
}

async function run(): Promise<void> {
  const form = document.getElementById('projection-form') as HTMLFormElement;
  await runProjection({ preventDefault: () => {}, target: form } as unknown as Event);
}

function traces(): { name?: string; y?: number[]; line?: { dash?: string } }[] {
  const call = renderChartMock.mock.calls.find((c) => c[0] === 'chart-projection')!;
  return call[1] as never;
}

describe('projections with debts', () => {
  beforeEach(() => {
    document.body.innerHTML = FORM;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 12));
  });
  afterEach(() => vi.useRealTimers());

  it('adds a dashed "Median minus debt" trace and the payoff card', async () => {
    setup([
      debt({ payoff_date: '2052-03-01', total_interest_remaining: 20000 }),
      debt({
        id: 'd2',
        name: 'Car loan',
        payoff_date: '2029-01-01',
        total_interest_remaining: 500,
      }),
    ]);
    await run();
    const trace = traces().find((t) => t.name === 'Median minus debt')!;
    expect(trace).toBeTruthy();
    expect(trace.line!.dash).toBe('dash');
    expect(trace.y).toHaveLength(AGES.length);
    expect(trace.y![0]!).toBeLessThan(RESULT.median_values[0]!);
    expect(vi.mocked(ensureThemeUpdates)).toHaveBeenCalledWith('chart-projection');

    const card = document.getElementById('debt-payoff-card')!;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain('Debt-free by Mar 2052 (age 63)');
    expect(card.textContent).toContain('Mortgage');
    expect(card.textContent).toContain('Car loan');
    expect(card.textContent).toContain('Jan 2029');
    expect(card.textContent).toContain(
      "Projections don't move paid-off payments into savings yet."
    );
    expect(card.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('shows neither with no active debts, or when the fetch fails', async () => {
    for (const list of [[], [debt({ is_active: false })], 'fail'] as const) {
      document.body.innerHTML = FORM;
      setup(list as never);
      await run();
      expect(traces().some((t) => t.name === 'Median minus debt')).toBe(false);
      expect((document.getElementById('debt-payoff-card') as HTMLElement).hidden).toBe(true);
    }
  });

  it('sends a byte-identical Monte Carlo request with and without debts', async () => {
    setup([]);
    await run();
    const without = JSON.stringify(runAsyncMock.mock.calls[0]);
    document.body.innerHTML = FORM;
    setup([debt({})]);
    await run();
    expect(JSON.stringify(runAsyncMock.mock.calls[0])).toBe(without);
    expect(
      apiCallMock.mock.calls
        .filter((c) => c[0] !== '/api/liabilities')
        .every((c) => !String(c[0]).includes('monte-carlo'))
    ).toBe(true);
  });
});
