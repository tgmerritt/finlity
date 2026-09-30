/**
 * Tests for the overview dashboard renderer: hero figures, allocation rows,
 * on-track card, attention list and grouped accounts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  getCurrentTab: vi.fn(),
}));

import { apiCall } from '@/api/client';
import { onTabChange, showTab } from '@/ui/tabs';
import { store } from '@/state/store';
import { initDashboard, renderDashboard, resetDashboardRenderState } from '@/pages/dashboard';
import type { AccountResponse, DashboardData, DashboardPosition } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const showTabMock = vi.mocked(showTab);
const onTabChangeMock = vi.mocked(onTabChange);

const MARKUP = `
  <section id="dash-hero">
    <div id="total-value"></div>
    <span id="day-change"></span>
    <span id="range-change"></span>
    <span id="total-gain"></span>
    <button class="time-range-btn" data-range="1M"></button>
    <button class="time-range-btn" data-range="1Y"></button>
    <button class="time-range-btn" data-range="ALL"></button>
    <div id="chart-history"></div>
  </section>
  <div id="allocation-bars"></div>
  <div id="on-track-body"></div>
  <ul id="attention-list"></ul>
  <div id="account-groups"></div>
  <div id="account-filter-options">
    <input type="checkbox" value="Roth IRA" checked />
    <input type="checkbox" value="Brokerage" checked />
  </div>
  <form id="projection-form"></form>
`;

function account(id: string, name: string, value: number, retirement: boolean): AccountResponse {
  return {
    id,
    name,
    account_type: retirement ? 'ira' : 'brokerage',
    display_type: retirement ? 'IRA' : 'Brokerage',
    brokerage: 'schwab',
    value,
    cost_basis: null,
    position_count: 1,
    is_retirement: retirement,
  } as AccountResponse;
}

function position(
  id: string,
  ticker: string,
  name: string,
  accountName: string,
  shares: number,
  price: number,
  previousClose: number | null
): DashboardPosition {
  return {
    id,
    ticker,
    name,
    shares,
    price,
    value: shares * price,
    cost_basis: null,
    account: accountName,
    account_type: 'brokerage',
    is_fund: true,
    position_type: 'fund',
    previous_close: previousClose,
  };
}

function history60(): DashboardData['history'] {
  const out: DashboardData['history'] = [];
  const now = Date.now();
  for (let i = 60; i >= 1; i--) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const total = 10_000 + (60 - i) * 10;
    out.push({ date, total, retirement: total / 2, taxable: total / 2 });
  }
  return out;
}

function fixture(): DashboardData {
  const positions = [
    position('1', 'VTI', 'Vanguard Total Stock Market ETF', 'Roth IRA', 40, 110, 100),
    position('2', 'FXAIX', 'Fidelity 500 Index Fund', 'Brokerage', 20, 100, 99),
    position('3', 'BND', 'Vanguard Total Bond Market ETF', 'Brokerage', 30, 80, 80),
  ];
  return {
    summary: {
      total_value: 8800,
      total_cost_basis: 8000,
      total_gain_loss: 800,
      retirement_value: 4400,
      taxable_value: 4400,
      account_count: 2,
      position_count: 3,
      accounts: [account('a1', 'Roth IRA', 4400, true), account('a2', 'Brokerage', 4400, false)],
    },
    positions,
    history: history60(),
    imports: [],
    view_id: null,
    demo_mode: false,
  };
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  const responses: Record<string, unknown> = {
    '/api/settings/config': {
      targets: { asset_class: { equities: 0.6, bonds: 0.35, cash: 0.05 } },
    },
    '/api/settings/config/personal': { personal: { dob: '1980-05-05' } },
    '/api/portfolio/dashboard-metrics': { success_probability: 92 },
    '/api/imports/price-status': { all_fresh: true, stale_tickers: 0, market_open: true },
    '/api/portfolio/duplicates': { has_duplicates: false, count: 0, duplicates: [] },
    '/api/analysis/triggers/triggered': [],
    ...overrides,
  };
  apiCallMock.mockImplementation(async (url: string) => {
    const key = url.split('?')[0]!;
    if (!(key in responses)) throw new Error(`unexpected apiCall ${url}`);
    return responses[key] as never;
  });
}

beforeEach(() => {
  resetDashboardRenderState();
  document.body.innerHTML = MARKUP;
  store.set('currentEntityId', null);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const text = (id: string): string => document.getElementById(id)?.textContent ?? '';

describe('renderDashboard', () => {
  it('renders hero, allocation, accounts and an all-clear attention list', async () => {
    stubApi();
    await renderDashboard(fixture());

    expect(text('total-value')).toBe('$8,800.00');

    const day = document.getElementById('day-change')!;
    expect(day.classList.contains('positive')).toBe(true);
    expect(day.textContent).toMatch(/^\+\$\d/);
    expect(day.textContent).toContain('today');

    expect(text('range-change')).toContain('over 1Y');
    const yearBtn = document.querySelector('.time-range-btn[data-range="1Y"]')!;
    expect(yearBtn.classList.contains('active')).toBe(true);
    expect(yearBtn.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.querySelector('.time-range-btn[data-range="1M"]')!.getAttribute('aria-pressed')
    ).toBe('false');
    expect(text('total-gain')).toBe('Total gain +$800.00');

    // Stocks and Bonds from holdings, plus Cash because it has a target above zero.
    const rows = document.querySelectorAll('#allocation-bars .alloc-row');
    expect(rows.length).toBe(3);
    expect(document.querySelectorAll('#allocation-bars .alloc-target').length).toBe(3);

    expect(document.querySelectorAll('#account-groups .account-row').length).toBe(2);
    expect(document.querySelectorAll('#account-groups .account-group').length).toBe(2);

    const attention = document.getElementById('attention-list')!;
    expect(attention.querySelectorAll('li').length).toBe(1);
    expect(attention.textContent).toBe('All clear');

    // On-track card shows the simulated probability.
    expect(text('on-track-body')).toContain('92%');
    expect(text('on-track-body')).toContain('On track');
  });

  it('shows the no-targets prompt when targets are not set', async () => {
    stubApi({ '/api/settings/config': { targets: { asset_class: {} } } });
    await renderDashboard(fixture());

    const host = document.getElementById('allocation-bars')!;
    expect(host.textContent).toContain('No targets set.');
    expect(host.querySelector('a[data-action="open-settings"]')).not.toBeNull();
    expect(host.querySelectorAll('.alloc-target').length).toBe(0);
  });

  it('asks for a birth date only when it is missing', async () => {
    stubApi({ '/api/settings/config/personal': { personal: { dob: '' } } });
    await renderDashboard(fixture());

    expect(text('on-track-body')).toContain("Add your birth date to see if you're on track.");
    document.querySelector<HTMLAnchorElement>('#on-track-body a')!.click();
    expect(showTabMock).toHaveBeenCalledWith('settings');
  });

  it('treats the 1990-01-01 date as a real birth date', async () => {
    stubApi({ '/api/settings/config/personal': { personal: { dob: '1990-01-01' } } });
    await renderDashboard(fixture());

    expect(text('on-track-body')).toContain('92%');
  });

  it('still shows the result when the personal call fails', async () => {
    stubApi();
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (url: string, ...rest: unknown[]) => {
      if (url.startsWith('/api/settings/config/personal')) throw new Error('boom');
      return (base as (u: string, ...r: unknown[]) => Promise<never>)(url, ...rest);
    });
    await renderDashboard(fixture());

    expect(text('on-track-body')).toContain('92%');
  });

  it('uses ALL as the default range for a short history', async () => {
    stubApi();
    const data = fixture();
    data.history = history60().slice(-20);
    await renderDashboard(data);

    const all = document.querySelector('.time-range-btn[data-range="ALL"]')!;
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(text('range-change')).toContain('over all time');
  });

  it('offers a quick check when there is no simulation yet', async () => {
    stubApi({ '/api/portfolio/dashboard-metrics': { success_probability: null } });
    await renderDashboard(fixture());

    expect(text('on-track-body')).toContain('No simulation yet.');
    const button = document.querySelector<HTMLButtonElement>('#on-track-body button')!;
    expect(button.textContent).toBe('Run a quick check');

    const form = document.getElementById('projection-form') as HTMLFormElement;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;
    button.click();
    expect(showTabMock).toHaveBeenCalledWith('projections');
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it('lists attention items with actions', async () => {
    stubApi({
      '/api/imports/price-status': { all_fresh: false, stale_tickers: 3, market_open: true },
      '/api/portfolio/duplicates': { has_duplicates: true, count: 2, duplicates: [] },
      '/api/analysis/triggers/triggered': [{ message: 'Bonds drifted', triggered: true }],
    });
    await renderDashboard(fixture());

    const items = [...document.querySelectorAll('#attention-list li')];
    expect(items.map((li) => li.querySelector('.attention-message')?.textContent)).toEqual([
      '3 prices out of date',
      '2 possible duplicate positions',
      'Bonds drifted',
    ]);
    expect(items.map((li) => li.querySelector('button')?.textContent)).toEqual([
      'Refresh',
      'Review',
      'View alerts',
    ]);
  });

  it('opens Holdings filtered to the clicked account', async () => {
    stubApi();
    await renderDashboard(fixture());

    document.querySelectorAll<HTMLButtonElement>('#account-groups .account-row')[0]!.click();
    expect(showTabMock).toHaveBeenCalledWith('holdings');
    expect([...store.get('selectedAccounts')]).toEqual(['Roth IRA']);
    const checked = [
      ...document.querySelectorAll<HTMLInputElement>('#account-filter-options input:checked'),
    ].map((cb) => cb.value);
    expect(checked).toEqual(['Roth IRA']);
  });

  it('updates the range change and aria-pressed when a range button is clicked', async () => {
    stubApi();
    initDashboard();
    await renderDashboard(fixture());

    document.querySelector<HTMLButtonElement>('.time-range-btn[data-range="1M"]')!.click();
    await vi.waitFor(() => expect(text('range-change')).toContain('over 1M'));
    expect(
      document.querySelector('.time-range-btn[data-range="1M"]')!.getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      document.querySelector('.time-range-btn[data-range="1Y"]')!.getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('re-renders the cards when the Dashboard tab is shown, without refetching data', async () => {
    stubApi({ '/api/settings/config/personal': { personal: { dob: '' } } });
    initDashboard();
    await renderDashboard(fixture());
    expect(text('on-track-body')).toContain('Add your birth date');

    // The user saves a birth date in Settings, then returns to the Dashboard.
    stubApi();
    apiCallMock.mockClear();
    const callback = onTabChangeMock.mock.calls[onTabChangeMock.mock.calls.length - 1]![0];
    store.set('currentPositions', fixture().positions);
    callback('dashboard');
    await vi.waitFor(() => expect(text('on-track-body')).toContain('92%'));

    const urls = apiCallMock.mock.calls.map((c) => String(c[0]));
    expect(urls).not.toContain('/api/dashboard/data');
    expect(document.querySelectorAll('#allocation-bars .alloc-row').length).toBe(3);
  });

  it('discards a slow card response that resolves after a newer render', async () => {
    stubApi();
    const base = apiCallMock.getMockImplementation()! as (u: string) => Promise<never>;
    let releaseFirst: () => void = () => undefined;
    let calls = 0;
    apiCallMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/settings/config/personal')) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { personal: { dob: '' } } as never;
        }
      }
      return base(url);
    });

    const positions = fixture().positions;
    const { renderCards } = await import('@/pages/dashboard');
    const first = renderCards(positions);
    await renderCards(positions);
    expect(text('on-track-body')).toContain('92%');

    releaseFirst();
    await first;
    expect(text('on-track-body')).toContain('92%');
    expect(text('on-track-body')).not.toContain('Add your birth date');
  });

  it('hides day change when no previous close is known', async () => {
    stubApi();
    const data = fixture();
    data.positions.forEach((p) => {
      p.previous_close = null;
    });
    await renderDashboard(data);

    const day = document.getElementById('day-change') as HTMLElement;
    expect(day.hidden).toBe(true);
    expect(day.textContent).toBe('');
  });
});
