/**
 * Tests for the Debts page actions: detail view, update balance, delete,
 * missing-link warnings and the Add button.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/api/client', async () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { apiCall: vi.fn(), ApiError };
});
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/tabs', () => ({
  showTab: vi.fn(),
  onTabChange: vi.fn(),
  getCurrentTab: vi.fn(() => 'debts'),
}));
vi.mock('@/charts/plotly-utils', () => ({
  renderChart: vi.fn(async () => {}),
  ensureThemeUpdates: vi.fn(),
  getAxisConfig: vi.fn(() => ({})),
}));

import { apiCall, ApiError } from '@/api/client';
import { renderChart, ensureThemeUpdates } from '@/charts/plotly-utils';
import { closeDynamicModal } from '@/ui/modal';
import { store } from '@/state/store';
import { on, emit, _resetEventBus } from '@/state/events';
import { initDebts, loadDebts } from '@/pages/debts';
import type { LiabilityResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function debt(over: Partial<LiabilityResponse>): LiabilityResponse {
  return {
    id: 'd1',
    entity_id: null,
    name: 'Car loan',
    liability_type: 'auto_loan',
    lender: 'Credit Union',
    current_balance: 1200,
    balance_as_of: '2026-10-01',
    interest_rate: 0,
    payment_amount: 100,
    payment_frequency: 'monthly',
    next_payment_date: '2026-11-01',
    escrow_amount: null,
    original_principal: 5000,
    origination_date: '2024-01-01',
    term_months: 60,
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
    estimated_balance: 1200,
    payoff_date: '2027-10-01',
    periods_remaining: 12,
    total_interest_remaining: 0,
    monthly_payment: 100,
    monthly_cash_flow: 100,
    linked_position: null,
    linked_position_missing: false,
    expense: null,
    expense_missing: false,
    last_reported_date: '2026-10-01',
    ...over,
  };
}

const HISTORY = {
  liability_id: 'd1',
  reported: [
    { date: '2026-01-01', balance: 2000, source: 'manual' },
    { date: '2026-10-01', balance: 1200, source: 'manual' },
  ],
  series: [
    { date: '2026-01-01', balance: 2000, source: null },
    { date: '2026-06-01', balance: 1600, source: null },
    { date: '2026-10-01', balance: 1200, source: null },
  ],
};

let list: LiabilityResponse[] = [];
function setup(items: LiabilityResponse[]): void {
  list = items;
  apiCallMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method ?? 'GET';
    if (url.endsWith('/history')) return HISTORY;
    if (url === '/api/liabilities?include_archived=true') return list;
    if (url.startsWith('/api/liabilities') && method === 'DELETE') {
      return { deleted: true, id: 'd1', expense_deleted: false };
    }
    if (url.startsWith('/api/liabilities') && method !== 'GET') return list[0];
    if (url === '/api/portfolio/positions') {
      return [
        { id: 'pos9', name: 'Beach house', position_type: 'real_estate' },
        { id: 'pos8', name: 'AAPL', position_type: 'stock' },
        { id: 'pos7', name: null, ticker: 'HOME1', position_type: 'real_estate' },
      ];
    }
    if (url === '/api/budget/expenses') return [{ id: 'e9', name: 'Mortgage payment' }];
    return {};
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const modal = (): HTMLElement => document.getElementById('dynamic-modal')!;
const card = (id = 'd1'): HTMLElement => document.querySelector(`[data-debt-id="${id}"]`)!;
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent === label
  ) as HTMLButtonElement;
const calls = (method: string): Array<[string, { method?: string; body?: unknown }?]> =>
  apiCallMock.mock.calls.filter(
    (c) => ((c[1] as { method?: string } | undefined)?.method ?? 'GET') === method
  ) as never;

describe('Debts page actions', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="tab-content" id="tab-debts">
        <div id="debts-summary"></div>
        <div id="debts-list"></div>
      </div>`;
    store.set('currentEntityId', null);
    apiCallMock.mockReset();
    vi.mocked(renderChart).mockClear();
    vi.mocked(ensureThemeUpdates).mockClear();
    _resetEventBus();
    Element.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  });
  afterEach(() => {
    closeDynamicModal();
    _resetEventBus();
    vi.useRealTimers();
  });

  it('puts Details, Update balance, Edit and Delete on each card', async () => {
    setup([debt({})]);
    await loadDebts();
    const labels = Array.from(card().querySelectorAll('.debt-card-actions button')).map(
      (b) => b.textContent
    );
    expect(labels).toEqual(['Details', 'Update balance', 'Edit', 'Delete']);
  });

  it('opens the detail with the balance history chart through renderChart', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    expect(modal().querySelector('h2')?.textContent).toBe('Car loan');
    expect(apiCallMock).toHaveBeenCalledWith('/api/liabilities/d1/history');
    const call = vi.mocked(renderChart).mock.calls.at(-1)!;
    expect(call[0]).toBe('debt-detail-chart');
    const traces = call[1] as Array<{ x: string[]; y: number[]; mode: string }>;
    expect(traces).toHaveLength(2);
    const line = traces.find((t) => t.mode.includes('lines'))!;
    const dots = traces.find((t) => t.mode === 'markers')!;
    expect(line.y).toEqual([2000, 1600, 1200]);
    expect(dots.x).toEqual(['2026-01-01', '2026-10-01']);
    expect(ensureThemeUpdates).toHaveBeenCalledWith('debt-detail-chart');
    expect(modal().querySelector('#debt-detail-chart')).not.toBeNull();
  });

  it('summarizes the schedule by year and expands a year to its payments', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    const years = modal().querySelectorAll('.debt-year');
    expect(Array.from(years).map((y) => y.querySelector('summary')!.textContent)).toEqual([
      expect.stringContaining('2026'),
      expect.stringContaining('2027'),
    ]);
    expect(years[0]!.querySelectorAll('.debt-year-row')).toHaveLength(2);
    expect(years[1]!.querySelectorAll('.debt-year-row')).toHaveLength(10);
    expect(years[0]!.querySelector('summary')!.textContent).toContain('$200.00');
  });

  it('skips the schedule for a debt that never pays off', async () => {
    setup([debt({ interest_rate: 0.5, payment_amount: 1, estimated_balance: 100000 })]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    expect(modal().querySelectorAll('.debt-year')).toHaveLength(0);
    expect(modal().textContent).toContain('never');
  });

  it('warns about a missing home and relinks it', async () => {
    setup([debt({ linked_position_id: 'gone', linked_position_missing: true })]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    expect(modal().querySelector('.debt-link-warning')?.textContent).toContain('home');
    buttonIn(modal(), 'Remove link').click();
    await flush();
    const put = calls('PUT')[0]!;
    expect(put[0]).toBe('/api/liabilities/d1');
    expect(put[1]?.body).toEqual({ linked_position_id: null });
  });

  it('offers other homes and expenses to relink to', async () => {
    setup([debt({ expense_id: 'gone', expense_missing: true })]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    expect(modal().querySelector('.debt-link-warning')?.textContent).toContain('expense');
    buttonIn(modal(), 'Choose another').click();
    await flush();
    const select = modal().querySelector('select[data-debt-relink]') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Mortgage payment');
    select.value = 'e9';
    buttonIn(modal(), 'Link').click();
    await flush();
    expect(calls('PUT')[0]![1]?.body).toEqual({ expense_id: 'e9' });
  });

  it('labels a home with no name by its ticker', async () => {
    setup([debt({ linked_position_id: 'gone', linked_position_missing: true })]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    buttonIn(modal(), 'Choose another').click();
    await flush();
    const select = modal().querySelector('select[data-debt-relink]') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Beach house', 'HOME1']);
  });

  it('labels the payoff fact "Payoff" on active debts', async () => {
    setup([debt({})]);
    await loadDebts();
    const labels = Array.from(card().querySelectorAll('dt')).map((e) => e.textContent);
    expect(labels).toContain('Payoff');
    expect(labels).not.toContain('Paid off');
    buttonIn(card(), 'Details').click();
    await flush();
    const detail = Array.from(modal().querySelectorAll('dt')).map((e) => e.textContent);
    expect(detail).toContain('Payoff');
    expect(detail).not.toContain('Paid off');
  });

  it('puts focus back on the card after a write', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Update balance').click();
    modal().querySelector<HTMLInputElement>('[data-debt-field="balance"]')!.value = '1100';
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(document.activeElement).toBe(card());
  });

  it('puts focus on the list heading when the debt is gone after a delete', async () => {
    setup([debt({}), debt({ id: 'd2', name: 'Visa' })]);
    await loadDebts();
    buttonIn(card(), 'Delete').click();
    list = list.filter((d) => d.id !== 'd1');
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('[data-debt-id="d1"]')).toBeNull();
    const heading = document.querySelector('#debts-list h2') as HTMLElement;
    expect(heading.textContent).toBe('Your debts');
    expect(document.activeElement).toBe(heading);
  });

  it('does not stack theme listeners when the detail is opened repeatedly', async () => {
    setup([debt({})]);
    await loadDebts();
    for (let i = 0; i < 3; i++) {
      buttonIn(card(), 'Details').click();
      await flush();
    }
    const before = vi.mocked(renderChart).mock.calls.length;
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: 'dark' } }));
    await flush();
    expect(vi.mocked(renderChart).mock.calls.length).toBe(before + 1);
  });

  it('stops redrawing on theme change once the detail is closed', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    buttonIn(modal(), '\u00d7').click();
    const before = vi.mocked(renderChart).mock.calls.length;
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: 'dark' } }));
    await flush();
    expect(vi.mocked(renderChart).mock.calls.length).toBe(before);
  });

  it('records a balance as of today and refreshes dashboard and list', async () => {
    setup([debt({})]);
    await loadDebts();
    const seen = vi.fn();
    on('liabilities:changed', seen);
    const legacy = vi.fn();
    on('accounts:changed', legacy);
    buttonIn(card(), 'Update balance').click();
    const asOf = modal().querySelector<HTMLInputElement>('[data-debt-field="asOf"]')!;
    expect(asOf.value).toBe('2026-10-04');
    expect(asOf.max).toBe('2026-10-04');
    const bal = modal().querySelector<HTMLInputElement>('[data-debt-field="balance"]')!;
    bal.value = '1,100.50';
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    const post = calls('POST')[0]!;
    expect(post[0]).toBe('/api/liabilities/d1/balance');
    expect(post[1]?.body).toEqual({ balance: 1100.5, as_of: '2026-10-04' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ type: 'liabilities:changed', reason: 'balance' });
    expect(legacy).not.toHaveBeenCalled();
    expect(document.getElementById('dynamic-modal')).toBeNull();
    // The list was fetched again after the write.
    const listFetches = apiCallMock.mock.calls.filter(
      (c) => c[0] === '/api/liabilities?include_archived=true'
    );
    // One initial load plus exactly one reload (the page ignores its own event).
    expect(listFetches).toHaveLength(2);
  });

  it('refuses a future as-of date using the local clock', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Update balance').click();
    modal().querySelector<HTMLInputElement>('[data-debt-field="balance"]')!.value = '10';
    modal().querySelector<HTMLInputElement>('[data-debt-field="asOf"]')!.value = '2026-10-05';
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('POST')).toHaveLength(0);
    expect(modal().querySelector('.debt-field-error')?.textContent).toContain('future');
  });

  it('shows a generic message when the balance call fails with 422', async () => {
    setup([debt({})]);
    await loadDebts();
    apiCallMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') throw new ApiError(422, 'leaky server detail');
      return url.includes('include_archived') ? list : {};
    });
    buttonIn(card(), 'Update balance').click();
    modal().querySelector<HTMLInputElement>('[data-debt-field="balance"]')!.value = '10';
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    const err = modal().querySelector('.debt-form-error')!;
    expect(err.textContent).toBeTruthy();
    expect(err.textContent).not.toContain('leaky');
  });

  it('asks before deleting and sends delete_expense=false without a linked expense', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Delete').click();
    expect(modal().textContent).toContain('Car loan');
    expect(modal().querySelector('input[type="checkbox"]')).toBeNull();
    expect(calls('DELETE')).toHaveLength(0);
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('DELETE')[0]![0]).toBe('/api/liabilities/d1?delete_expense=false');
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('offers to delete the linked expense, unchecked by default', async () => {
    const withExpense = debt({
      expense_id: 'e1',
      expense: { id: 'e1', name: 'Car payment', monthly_amount: 100 },
    });
    setup([withExpense]);
    await loadDebts();
    buttonIn(card(), 'Delete').click();
    const box = modal().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    expect(modal().textContent).toContain('Also delete the linked budget expense');
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('DELETE')[0]![0]).toBe('/api/liabilities/d1?delete_expense=false');

    buttonIn(card(), 'Delete').click();
    modal().querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    (modal().querySelector('[data-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('DELETE')[1]![0]).toBe('/api/liabilities/d1?delete_expense=true');
  });

  it('does nothing when delete is cancelled', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Delete').click();
    (modal().querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('DELETE')).toHaveLength(0);
  });

  it('opens the plain add form from the Add button and from the empty state', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(document.getElementById('debts-list')!, 'Add a debt').click();
    expect(modal().querySelector('h2')?.textContent).toBe('Add a debt');
    closeDynamicModal();
    setup([]);
    await loadDebts();
    buttonIn(document.getElementById('debts-list')!, 'Add a debt').click();
    expect(modal().querySelector('h2')?.textContent).toBe('Add a debt');
  });

  it('opens the edit form from a card', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Edit').click();
    expect(modal().querySelector('h2')?.textContent).toBe('Edit debt');
  });

  it('reloads the list when a debt changes somewhere else', async () => {
    initDebts();
    setup([debt({})]);
    await loadDebts();
    const fetches = (): number =>
      apiCallMock.mock.calls.filter((c) => c[0] === '/api/liabilities?include_archived=true')
        .length;
    const before = fetches();
    emit({ type: 'liabilities:changed', reason: 'updated' });
    await flush();
    expect(fetches()).toBe(before + 1);
  });

  it('schedules from the first due date after today, matching the card payoff', async () => {
    // Due today: today's payment is not part of the schedule (server rule).
    setup([
      debt({
        current_balance: 300,
        estimated_balance: 300,
        payment_amount: 100,
        interest_rate: 0,
        next_payment_date: '2026-10-04',
        payoff_date: '2027-01-04',
      }),
    ]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    const rows = Array.from(modal().querySelectorAll('.debt-year-row')).map(
      (r) => r.firstElementChild!.textContent
    );
    expect(rows).toEqual(['Nov 4', 'Dec 4', 'Jan 4']);
    expect(card().textContent).toContain('Jan 2027');
  });

  it('redraws the chart when the theme changes', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    const before = vi.mocked(renderChart).mock.calls.length;
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: 'dark' } }));
    await flush();
    expect(vi.mocked(renderChart).mock.calls.length).toBe(before + 1);
  });

  it('shows a friendly 409 from the relink flow and guards the button while in flight', async () => {
    setup([debt({ expense_id: 'gone', expense_missing: true })]);
    await loadDebts();
    buttonIn(card(), 'Details').click();
    await flush();
    const base = apiCallMock.getMockImplementation()!;
    let release: () => void = () => {};
    apiCallMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') {
        await new Promise<void>((r) => (release = r));
        throw new ApiError(409, 'raw server words');
      }
      return base(url, opts as never);
    });
    buttonIn(modal(), 'Choose another').click();
    await flush();
    const link = buttonIn(modal(), 'Link');
    link.click();
    await flush();
    expect(link.disabled).toBe(true);
    release();
    await flush();
    expect(link.disabled).toBe(false);
    const msg = modal().querySelector('.debt-link-warning .debt-form-error')!.textContent!;
    expect(msg).toContain('already linked');
    expect(msg).not.toContain('raw server');
  });

  it('saves the balance dialog when Enter is pressed in a field', async () => {
    setup([debt({})]);
    await loadDebts();
    buttonIn(card(), 'Update balance').click();
    const bal = modal().querySelector<HTMLInputElement>('[data-debt-field="balance"]')!;
    bal.value = '500';
    bal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(calls('POST')[0]![0]).toBe('/api/liabilities/d1/balance');
  });
});
