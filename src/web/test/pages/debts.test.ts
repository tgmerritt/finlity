/**
 * Tests for the Debts page: markup, summary strip, grouped cards, Paid off
 * section, Person filter, empty state and the debts:open request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
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

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { onTabChange } from '@/ui/tabs';
import { store } from '@/state/store';
import { emit, _resetEventBus } from '@/state/events';
import { initDebts, loadDebts, summarize } from '@/pages/debts';
import type { LiabilityResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function debt(over: Partial<LiabilityResponse>): LiabilityResponse {
  return {
    id: 'd1',
    entity_id: null,
    name: 'Home mortgage',
    liability_type: 'mortgage',
    lender: 'First Bank',
    current_balance: 300000,
    balance_as_of: '2026-10-01',
    interest_rate: 0.0625,
    payment_amount: 2000,
    payment_frequency: 'monthly',
    next_payment_date: null,
    escrow_amount: null,
    original_principal: 400000,
    origination_date: '2020-01-01',
    term_months: 360,
    maturity_date: '2050-01-01',
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
    estimated_balance: 299000,
    payoff_date: '2050-01-01',
    periods_remaining: 300,
    total_interest_remaining: 1000,
    monthly_payment: 2000,
    monthly_cash_flow: 2000,
    linked_position: null,
    linked_position_missing: false,
    expense: null,
    expense_missing: false,
    last_reported_date: '2026-10-01',
    ...over,
  };
}

const MORTGAGE = debt({});
const AUTO = debt({
  id: 'd2',
  name: 'Car loan',
  liability_type: 'auto_loan',
  lender: null,
  entity_id: 'p1',
  estimated_balance: 10000,
  original_principal: 20000,
  monthly_cash_flow: 400,
  payoff_date: '2028-03-01',
});
const CARD = debt({
  id: 'd3',
  name: 'Visa',
  liability_type: 'credit_card',
  lender: null,
  entity_id: 'p1',
  is_amortizing: false,
  estimated_balance: 1500,
  original_principal: null,
  payoff_date: null,
  monthly_cash_flow: 50,
});
const OLD = debt({
  id: 'd4',
  name: 'Old loan',
  liability_type: 'personal_loan',
  is_active: false,
  estimated_balance: 0,
  monthly_cash_flow: 0,
  payoff_date: null,
});

function mockList(list: LiabilityResponse[]): void {
  apiCallMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/liabilities')) return list;
    return {};
  });
}

const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';

describe('Debts page markup', () => {
  it('ships the sidebar item after Holdings and a #tab-debts container', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = Array.from(doc.querySelectorAll('.sidebar .nav-item[data-tab]')).map((e) =>
      e.getAttribute('data-tab')
    );
    expect(items.indexOf('debts')).toBe(items.indexOf('holdings') + 1);
    expect(doc.getElementById('tab-debts')?.classList.contains('tab-content')).toBe(true);
    expect(doc.querySelector('.bottom-tab[data-tab="debts"]')).toBeNull();
  });
});

describe('Debts page', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="tab-content" id="tab-debts">
        <div id="debts-summary"></div>
        <div id="debts-list"></div>
      </div>`;
    store.set('currentEntityId', null);
    apiCallMock.mockReset();
    vi.mocked(showToast).mockReset();
    vi.mocked(onTabChange).mockReset();
    _resetEventBus();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    _resetEventBus();
  });

  it('summarizes total owed, monthly payments and the debt-free month', () => {
    const s = summarize([MORTGAGE, AUTO, CARD, OLD]);
    expect(s.totalOwed).toBe(299000 + 10000 + 1500);
    expect(s.monthlyPayments).toBe(2450);
    expect(s.debtFreeBy).toBe('2050-01-01'); // latest among debts that have one
    expect(s.withoutPayoff).toBe(1); // the credit card
    expect(summarize([MORTGAGE, AUTO]).withoutPayoff).toBe(0);
    expect(summarize([CARD]).debtFreeBy).toBeNull();
  });

  it('renders the summary strip and one card per active debt, grouped by type', async () => {
    mockList([MORTGAGE, AUTO, CARD, OLD]);
    await loadDebts();
    expect(text('#debts-summary')).toContain('$310,500.00');
    expect(text('#debts-summary')).toContain('$2,450.00');
    expect(document.querySelectorAll('#debts-list .debt-card:not(.debt-card--paid)')).toHaveLength(
      3
    );
    const heads = Array.from(
      document.querySelectorAll('.debt-card:not(.debt-card--paid) .debt-card-type')
    ).map((e) => e.textContent);
    expect(heads).toEqual(['Mortgage', 'Auto loan', 'Credit card']);
    const card = document.querySelector('[data-debt-id="d1"]')!;
    expect(card.textContent).toContain('Home mortgage');
    expect(card.textContent).toContain('First Bank');
    expect(card.textContent).toContain('$299,000.00');
    expect(card.textContent).toContain('6.25%');
    expect(card.textContent).toContain('Jan 2050');
    const bar = card.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(document.querySelector('[data-debt-id="d3"] [role="progressbar"]')).toBeNull();
  });

  it('shows the latest payoff and a note when some debts have no payoff plan', async () => {
    mockList([MORTGAGE, CARD]);
    await loadDebts();
    expect(text('#debts-summary')).toContain('Jan 2050');
    expect(text('#debts-summary')).toContain('Excludes 1 debt without a payoff plan');
    mockList([MORTGAGE, CARD, debt({ id: 'd5', name: 'Other', payoff_date: null })]);
    await loadDebts();
    expect(text('#debts-summary')).toContain('Excludes 2 debts without a payoff plan');
  });

  it('shows Not projected only when no debt has a payoff date', async () => {
    mockList([CARD]);
    await loadDebts();
    expect(text('#debts-summary')).toContain('Not projected');
    expect(text('#debts-summary')).not.toContain('Excludes');
  });

  it('puts archived debts in a collapsed Paid off section', async () => {
    mockList([MORTGAGE, OLD]);
    await loadDebts();
    const section = document.querySelector('details.debts-paid-off') as HTMLDetailsElement;
    expect(section.open).toBe(false);
    expect(section.querySelector('summary')?.textContent).toBe('Paid off (1)');
    expect(section.querySelector('[data-debt-id="d4"]')).not.toBeNull();
    expect(document.querySelectorAll('.debt-card:not(.debt-card--paid)')).toHaveLength(1);
  });

  it('narrows by the Person filter on entity_id', async () => {
    mockList([MORTGAGE, AUTO, CARD]);
    store.set('currentEntityId', 'p1');
    await loadDebts();
    const ids = Array.from(document.querySelectorAll('.debt-card')).map((e) =>
      e.getAttribute('data-debt-id')
    );
    expect(ids).toEqual(['d2', 'd3']);
    expect(text('#debts-summary')).toContain('$11,500.00');
  });

  it('reloads when the Person filter changes', async () => {
    mockList([MORTGAGE, AUTO]);
    initDebts();
    await loadDebts();
    expect(document.querySelectorAll('.debt-card')).toHaveLength(2);
    store.set('currentEntityId', 'p1');
    await vi.waitFor(() => expect(document.querySelectorAll('.debt-card')).toHaveLength(1));
  });

  it('shows the empty state with an Add a debt button when there are no liabilities', async () => {
    mockList([]);
    await loadDebts();
    expect(text('#debts-list')).toContain('Add your debts to see your net worth');
    const btn = Array.from(document.querySelectorAll('#debts-list button')).find(
      (b) => b.textContent === 'Add a debt'
    );
    expect(btn).toBeTruthy();
    expect(document.querySelector('.debt-card')).toBeNull();
  });

  it('shows a generic error instead of the server detail when loading fails', async () => {
    apiCallMock.mockRejectedValue(new Error('boom: secret detail'));
    await loadDebts();
    expect(text('#debts-list')).toContain('Could not load your debts');
    expect(document.body.textContent).not.toContain('secret detail');
  });

  it('loads when the tab is shown', async () => {
    mockList([MORTGAGE]);
    initDebts();
    const cb = vi.mocked(onTabChange).mock.calls[0]![0];
    cb('debts');
    await vi.waitFor(() => expect(document.querySelectorAll('.debt-card')).toHaveLength(1));
  });

  it('scrolls to and highlights the card for a debts:open request', async () => {
    mockList([MORTGAGE, AUTO]);
    initDebts();
    await loadDebts();
    emit({ type: 'debts:open', id: 'd2' });
    const card = document.querySelector('[data-debt-id="d2"]') as HTMLElement;
    expect(card.classList.contains('debt-card--highlight')).toBe(true);
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(
      document.querySelector('[data-debt-id="d1"]')?.classList.contains('debt-card--highlight')
    ).toBe(false);
  });

  it('keeps a debts:open request that arrives before the list has loaded', async () => {
    mockList([MORTGAGE, AUTO]);
    initDebts();
    emit({ type: 'debts:open', id: 'd2' });
    await loadDebts();
    expect(
      document.querySelector('[data-debt-id="d2"]')?.classList.contains('debt-card--highlight')
    ).toBe(true);
  });

  it('opens Paid off when the requested debt is archived', async () => {
    mockList([MORTGAGE, OLD]);
    initDebts();
    await loadDebts();
    emit({ type: 'debts:open', id: 'd4' });
    expect((document.querySelector('details.debts-paid-off') as HTMLDetailsElement).open).toBe(
      true
    );
  });

  it('drops a debts:open request for a debt hidden by the Person filter and says so', async () => {
    mockList([MORTGAGE, AUTO]);
    store.set('currentEntityId', 'p1');
    initDebts();
    emit({ type: 'debts:open', id: 'd1' });
    await loadDebts();
    expect(showToast).toHaveBeenCalledWith('This debt is hidden by the person filter', 'info');
    expect(store.get('currentEntityId')).toBe('p1');
    expect(document.querySelector('.debt-card--highlight')).toBeNull();
    vi.mocked(showToast).mockClear();
    await loadDebts();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('treats a non-array response as a load failure', async () => {
    apiCallMock.mockResolvedValue({});
    await loadDebts();
    expect(text('#debts-list')).toContain('Could not load your debts');
  });

  it.each(['profile:switched', 'demo:toggled'] as const)(
    'discards a response that predates %s and shows loading at once',
    async (type) => {
      mockList([MORTGAGE]);
      await loadDebts();
      let resolveOld: (v: LiabilityResponse[]) => void = () => undefined;
      apiCallMock.mockImplementationOnce(
        () => new Promise((res) => (resolveOld = res as typeof resolveOld))
      );
      initDebts();
      const old = loadDebts();
      mockList([AUTO]);
      if (type === 'profile:switched') emit({ type, profileId: 'x' });
      else emit({ type, demoMode: true });
      expect(document.querySelector('.debt-card')).toBeNull();
      expect(document.querySelector('#debts-list .state-view--loading')).not.toBeNull();
      await vi.waitFor(() => expect(document.querySelector('[data-debt-id="d2"]')).not.toBeNull());
      resolveOld([MORTGAGE]);
      await old;
      expect(document.querySelector('[data-debt-id="d1"]')).toBeNull();
      expect(document.querySelector('[data-debt-id="d2"]')).not.toBeNull();
    }
  );

  it('has a hidden Your debts heading, h3 card titles and a labelled summary', async () => {
    mockList([MORTGAGE]);
    await loadDebts();
    expect(text('#debts-list h2.visually-hidden')).toBe('Your debts');
    expect(document.querySelector('.debt-card h3.debt-card-name')?.textContent).toBe(
      'Home mortgage'
    );
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.getElementById('debts-summary')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('focuses the card and sets progressbar aria values', async () => {
    mockList([MORTGAGE]);
    initDebts();
    await loadDebts();
    emit({ type: 'debts:open', id: 'd1' });
    const card = document.querySelector('[data-debt-id="d1"]') as HTMLElement;
    expect(document.activeElement).toBe(card);
    const bar = card.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-label')).toBe('Home mortgage paid off');
  });

  it('keeps the highlight through a refresh already in flight, then clears it after 2.5s', async () => {
    vi.useFakeTimers();
    try {
      mockList([MORTGAGE, AUTO]);
      initDebts();
      await loadDebts();
      let resolveList: (v: LiabilityResponse[]) => void = () => undefined;
      apiCallMock.mockImplementationOnce(
        () => new Promise((res) => (resolveList = res as typeof resolveList))
      );
      const refresh = loadDebts();
      emit({ type: 'debts:open', id: 'd2' });
      const before = document.querySelector('[data-debt-id="d2"]');
      expect(before?.classList.contains('debt-card--highlight')).toBe(true);
      resolveList([MORTGAGE, AUTO]);
      await refresh;
      const card = document.querySelector('[data-debt-id="d2"]') as HTMLElement;
      expect(card.classList.contains('debt-card--highlight')).toBe(true);
      vi.advanceTimersByTime(2600);
      expect(card.classList.contains('debt-card--highlight')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the highlight on blur', async () => {
    mockList([MORTGAGE]);
    initDebts();
    await loadDebts();
    emit({ type: 'debts:open', id: 'd1' });
    const card = document.querySelector('[data-debt-id="d1"]') as HTMLElement;
    card.dispatchEvent(new Event('blur'));
    expect(card.classList.contains('debt-card--highlight')).toBe(false);
  });

  it('writes data with textContent only', async () => {
    mockList([debt({ name: '<img src=x onerror=alert(1)>' })]);
    await loadDebts();
    expect(document.querySelector('#debts-list img')).toBeNull();
    expect(text('.debt-card')).toContain('<img src=x');
  });

  it('uses no em-dash in rendered copy', async () => {
    mockList([MORTGAGE, CARD, OLD]);
    await loadDebts();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
