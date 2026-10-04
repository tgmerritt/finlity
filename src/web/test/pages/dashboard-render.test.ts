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
vi.mock('@/ui/settings-sections', () => ({ goToSection: vi.fn() }));
vi.mock('@/ui/tabs', () => ({
  showTab: vi.fn(),
  onTabChange: vi.fn(),
  getCurrentTab: vi.fn(),
}));

vi.mock('@/utils/debt-wizard-launcher', () => ({ openDebtWizardLazy: vi.fn() }));

import { apiCall } from '@/api/client';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { goToSection } from '@/ui/settings-sections';
import { showToast } from '@/ui/toast';
import { getCurrentTab, onTabChange, showTab } from '@/ui/tabs';
import { store } from '@/state/store';
import { initDashboard, renderDashboard, resetDashboardRenderState } from '@/pages/dashboard';
import { on, emit, _resetEventBus } from '@/state/events';
import type {
  AccountResponse,
  DashboardData,
  DashboardLiability,
  DashboardPosition,
} from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const showTabMock = vi.mocked(showTab);
const onTabChangeMock = vi.mocked(onTabChange);

const MARKUP = `
  <section id="dash-hero">
    <div class="dash-hero-label">Portfolio value</div>
    <div id="total-value"></div>
    <div id="hero-breakdown" hidden></div>
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
  <div id="tab-debts"></div>
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
    const link = host.querySelector<HTMLAnchorElement>('a[data-action="open-settings"]');
    expect(link).not.toBeNull();
    link!.click();
    expect(showTabMock).toHaveBeenCalledWith('settings');
    expect(goToSection).toHaveBeenCalledWith('settings-targets');
    expect(host.querySelectorAll('.alloc-target').length).toBe(0);
  });

  it('asks for a birth date only when it is missing', async () => {
    stubApi({ '/api/settings/config/personal': { personal: { dob: '' } } });
    await renderDashboard(fixture());

    expect(text('on-track-body')).toContain("Add your birth date to see if you're on track.");
    document.querySelector<HTMLAnchorElement>('#on-track-body a')!.click();
    expect(showTabMock).toHaveBeenCalledWith('settings');
    expect(goToSection).toHaveBeenCalledWith('settings-profile');
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

  it('says no accounts match when a view filter hides every account', async () => {
    stubApi();
    const data = fixture();
    data.summary.accounts = [];
    data.positions = [];
    data.view_id = 'view-1';
    await renderDashboard(data);

    expect(document.getElementById('account-groups')!.textContent).toBe(
      'No accounts match this view.'
    );
  });
});

function withDebts(): DashboardData {
  const data = fixture();
  const mortgage: DashboardLiability = {
    id: 'l1',
    name: 'Mortgage',
    liability_type: 'mortgage',
    balance: 2000,
    interest_rate: 0.0625,
    payment_amount: 100,
    payment_frequency: 'monthly',
    payoff_date: '2052-07-01',
    linked_position_id: null,
    entity_id: null,
    is_amortizing: true,
    last_reported_date: '2026-09-30',
  };
  data.summary = {
    ...data.summary,
    liabilities_included: true,
    liabilities_total: 2000,
    net_worth: 6800,
    liabilities: [mortgage],
  };
  data.history = data.history.map((h) => ({ ...h, liabilities: 2000, net_worth: h.total - 2000 }));
  return data;
}

describe('net worth mode', () => {
  it('shows Net worth, the assets and debts breakdown and today as an assets move', async () => {
    stubApi();
    await renderDashboard(withDebts());

    expect(document.querySelector('.dash-hero-label')!.textContent).toBe('Net worth');
    expect(text('total-value')).toBe('$6,800.00');
    const breakdown = document.getElementById('hero-breakdown')!;
    expect(breakdown.hidden).toBe(false);
    expect(breakdown.textContent).toBe('Assets $8,800.00 \u00b7 Debts $2,000.00');
    // Assets moved +$400 today (VTI +10, FXAIX +1 per share); debts are held constant.
    expect(text('day-change')).toMatch(/^\+\$4\d\d\.00 \(\+\d+\.\d+%\) today$/);
    expect(text('range-change')).toContain('over 1Y');
    expect(text('total-gain')).toBe('Total gain +$800.00');
  });

  it('keeps the AI button in the hero label and names negative amounts for screen readers', async () => {
    stubApi();
    const label = document.querySelector('.dash-hero-label')!;
    const btn = document.createElement('button');
    btn.className = 'ai-info-btn';
    label.appendChild(btn);
    const data = withDebts();
    data.summary.net_worth = -1200;
    await renderDashboard(data);
    expect(label.querySelector('.ai-info-btn')).toBe(btn);
    expect(label.firstChild!.nodeValue).toBe('Net worth');
    expect(document.getElementById('total-value')!.getAttribute('aria-label')).toBe(
      'Net worth, $1,200.00 below zero'
    );
    const row = document.querySelector('#account-groups .account-row:last-of-type');
    await renderDashboard(withDebts());
    expect(document.getElementById('total-value')!.hasAttribute('aria-label')).toBe(false);
    const debtRow = [...document.querySelectorAll('#account-groups .account-row')].pop()!;
    expect(debtRow.getAttribute('aria-label')).toBe('Mortgage, $2,000.00 owed');
    expect(row).not.toBeNull();
  });

  it('shows a toast and stays on the dashboard when the Debts page is missing', async () => {
    stubApi();
    document.getElementById('tab-debts')!.remove();
    await renderDashboard(withDebts());
    [...document.querySelectorAll<HTMLButtonElement>('#account-groups .account-row')]
      .pop()!
      .click();
    expect(showTabMock).not.toHaveBeenCalled();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('shows a negative net worth with an ASCII minus and the negative color', async () => {
    stubApi();
    const data = withDebts();
    data.summary.net_worth = -1200;
    data.summary.liabilities_total = 10_000;
    await renderDashboard(data);
    expect(text('total-value')).toBe('-$1,200.00');
    expect(document.getElementById('total-value')!.classList.contains('negative')).toBe(true);
  });

  it('is identical to the portfolio hero without liabilities, and in a filtered view', async () => {
    stubApi();
    await renderDashboard(fixture());
    expect(document.querySelector('.dash-hero-label')!.textContent).toBe('Portfolio value');
    expect(document.getElementById('hero-breakdown')!.hidden).toBe(true);
    expect(document.getElementById('hero-breakdown')!.textContent).toBe('');
    expect(text('total-value')).toBe('$8,800.00');

    const filtered = withDebts();
    filtered.summary.liabilities_included = false;
    await renderDashboard(filtered);
    expect(document.querySelector('.dash-hero-label')!.textContent).toBe('Portfolio value');
    expect(document.getElementById('hero-breakdown')!.hidden).toBe(true);
    expect(document.getElementById('account-groups')!.textContent).not.toContain('Liabilities');
  });

  it('puts the property group and then a Liabilities group with a Net worth row in Accounts', async () => {
    stubApi();
    const data = withDebts();
    data.summary.accounts = [
      ...data.summary.accounts!,
      { ...account('a3', 'Home', 5000, false), account_type: 'property' } as AccountResponse,
    ];
    data.positions = [
      ...data.positions,
      {
        ...position('4', 'HOME', 'My Home', 'Home', 1, 5000, null),
        account_type: 'property',
        position_type: 'real_estate',
      },
    ];
    await renderDashboard(data);

    const heads = [...document.querySelectorAll('#account-groups .account-group-head')].map(
      (el) => el.textContent
    );
    expect(heads.map((t) => t!.replace(/-?\$.*/, '').trim())).toEqual([
      'Retirement',
      'Taxable',
      'Property',
      'Liabilities',
    ]);
    const groups = document.querySelectorAll('#account-groups .account-group');
    const liab = groups[groups.length - 1]!;
    expect(liab.querySelector('.account-group-head')!.textContent).toContain('-$2,000.00');
    const row = liab.querySelector('.account-row')!;
    expect(row.textContent).toContain('Mortgage');
    expect(row.textContent).toContain('-$2,000.00');
    expect(row.textContent).toContain('6.25% \u00b7 paid off Jul 2052');
    const foot = liab.querySelector('.account-group-foot')!;
    expect(foot.textContent).toBe('Net worth$6,800.00');
  });

  it('opens the wizard from the Add a debt link under the Liabilities group', async () => {
    stubApi();
    vi.mocked(openDebtWizardLazy).mockClear();
    await renderDashboard(withDebts());
    const link = document.querySelector<HTMLButtonElement>(
      '#account-groups [data-dashboard-action="add-debt"]'
    )!;
    expect(link.textContent).toBe('Add a debt');
    link.click();
    expect(vi.mocked(openDebtWizardLazy)).toHaveBeenCalledTimes(1);
  });

  it('opens the Debts page on the clicked liability', async () => {
    stubApi();
    const seen: string[] = [];
    const off = on('debts:open', (e) => seen.push(e.id));
    await renderDashboard(withDebts());
    const rows = document.querySelectorAll<HTMLButtonElement>('#account-groups .account-row');
    rows[rows.length - 1]!.click();
    expect(showTabMock).toHaveBeenCalledWith('debts');
    expect(seen).toEqual(['l1']);
    off();
  });
});

describe('debt attention items', () => {
  const noDebts = (): DashboardData => {
    const data = fixture();
    data.summary = { ...data.summary, liabilities_included: true, liabilities: [] };
    return data;
  };
  const items = (): string[] =>
    [...document.querySelectorAll('#attention-list .attention-message')].map(
      (el) => el.textContent ?? ''
    );

  const saved = new Map<string, string>();
  beforeEach(() => {
    saved.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => saved.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => {
      saved.set(k, v);
    });
  });

  it('asks for debts, opens the wizard from Add debts and persists I have none', async () => {
    stubApi();
    await renderDashboard(noDebts());
    expect(items()).toEqual(['Add your debts to see your net worth']);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#attention-list button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Add debts', 'I have none']);

    buttons[0]!.click();
    expect(vi.mocked(openDebtWizardLazy)).toHaveBeenCalledTimes(1);

    buttons[1]!.click();
    expect(document.getElementById('attention-list')!.textContent).toBe('All clear');
    expect(saved.get('finlity:attention-dismissed')).toContain('add-debts');

    await renderDashboard(noDebts());
    expect(items()).toEqual([]);
    expect(document.getElementById('attention-list')!.textContent).toBe('All clear');
  });

  it('scopes dismissals to the active profile', async () => {
    stubApi();
    store.set('activeProfileId', 'p1');
    await renderDashboard(noDebts());
    document.querySelectorAll<HTMLButtonElement>('#attention-list button')[1]!.click();
    expect([...saved.keys()]).toEqual(['finlity:attention-dismissed:p1']);
    store.set('activeProfileId', 'p2');
    await renderDashboard(noDebts());
    expect(items()).toEqual(['Add your debts to see your net worth']);
    store.set('activeProfileId', null);
  });

  it('still dismisses for the session when localStorage throws', async () => {
    stubApi();
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error('blocked');
    });
    await renderDashboard(noDebts());
    document.querySelectorAll<HTMLButtonElement>('#attention-list button')[1]!.click();
    await renderDashboard(noDebts());
    expect(items()).toEqual([]);
  });

  it('offers the property and stale balance actions', async () => {
    stubApi();
    const data = withDebts();
    data.positions = [
      ...data.positions,
      {
        ...position('4', 'HOME', 'Cabin', 'Brokerage', 1, 5000, null),
        position_type: 'real_estate',
      },
    ];
    data.summary.liabilities = [
      {
        ...data.summary.liabilities![0]!,
        id: 'c1',
        name: 'Chase Sapphire',
        liability_type: 'credit_card',
        is_amortizing: false,
        last_reported_date: '2020-01-01',
      },
    ];
    await renderDashboard(data);
    expect(items()).toEqual(['Is Cabin financed?', 'Update the Chase Sapphire balance']);
    const seen: string[] = [];
    const off = on('debts:open', (e) => seen.push(e.id));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#attention-list button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Review', 'Not financed', 'Update']);
    buttons[0]!.click();
    expect(showTabMock).toHaveBeenCalledWith('holdings');
    buttons[2]!.click();
    expect(showTabMock).toHaveBeenCalledWith('debts');
    expect(seen).toEqual(['c1']);
    off();
  });
});

describe('liabilities:changed', () => {
  const dataCalls = (): number =>
    apiCallMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/dashboard/data')).length;
  const stubWithData = (): void => {
    stubApi({ '/api/dashboard/data': fixture() });
  };

  it('refetches quietly: no overlay, no widget reload, no commentary invalidation', async () => {
    _resetEventBus();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="loading-overlay" class="hidden"><span class="loading-text"></span></div>'
    );
    stubWithData();
    initDashboard();
    vi.mocked(getCurrentTab).mockReturnValue('dashboard');
    const invalidated = vi.fn();
    on('commentary:invalidated', invalidated);
    const overlay = document.getElementById('loading-overlay')!;
    const seen: boolean[] = [];
    new MutationObserver(() => seen.push(overlay.classList.contains('visible'))).observe(overlay, {
      attributes: true,
    });
    apiCallMock.mockClear();
    emit({ type: 'liabilities:changed', reason: 'added' });
    await vi.waitFor(() => expect(dataCalls()).toBe(1));
    await vi.waitFor(() => expect(text('total-value')).toBe('$8,800.00'));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toContain(true);
    expect(invalidated).not.toHaveBeenCalled();
    expect(apiCallMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/plugins/widgets');
  });

  it('waits for the next dashboard show when another tab is current', async () => {
    _resetEventBus();
    stubWithData();
    initDashboard();
    const callback = onTabChangeMock.mock.calls[onTabChangeMock.mock.calls.length - 1]![0];
    vi.mocked(getCurrentTab).mockReturnValue('debts');
    apiCallMock.mockClear();
    emit({ type: 'liabilities:changed', reason: 'balance' });
    await new Promise((r) => setTimeout(r, 10));
    expect(dataCalls()).toBe(0);
    callback('dashboard');
    await vi.waitFor(() => expect(dataCalls()).toBe(1));
    // Only once: the next show is the ordinary cheap re-render.
    callback('dashboard');
    await new Promise((r) => setTimeout(r, 10));
    expect(dataCalls()).toBe(1);
  });
});
