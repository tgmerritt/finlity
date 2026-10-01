/**
 * Tests for the first-run empty state on the Dashboard: shown when there are
 * no accounts, hidden otherwise, with four actions wired to existing flows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn().mockResolvedValue({}) }));
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
vi.mock('@/pages/holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/holdings')>()),
  showAddPositionModal: vi.fn().mockResolvedValue(undefined),
  showNewAccountForm: vi.fn(),
}));
vi.mock('@/features/onboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/onboarding')>()),
  startDemoMode: vi.fn().mockResolvedValue(undefined),
  seedDemoDatasetIfEmpty: vi.fn().mockResolvedValue(true),
  startTour: vi.fn(),
}));

import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import { showAddPositionModal, showNewAccountForm } from '@/pages/holdings';
import { seedDemoDatasetIfEmpty, startDemoMode, startTour } from '@/features/onboarding';
import { initDashboard, renderDashboard, resetDashboardRenderState } from '@/pages/dashboard';
import type { AccountResponse, DashboardData } from '@/types/api';

const MARKUP = `
  <section id="dashboard-empty" class="hidden">
    <button data-empty-action="import"></button>
    <button data-empty-action="add-account"></button>
    <button data-empty-action="demo"></button>
    <a href="#" data-empty-action="tour"></a>
  </section>
  <section id="dash-hero">
    <div id="total-value"></div>
    <div id="chart-history"></div>
  </section>
  <section class="dash-cards">
    <div id="allocation-bars"></div>
    <div id="on-track-body"></div>
    <ul id="attention-list"></ul>
  </section>
  <section id="accounts-card"><div id="account-groups"></div></section>
  <div id="account-filter-options"></div>
  <form id="projection-form"></form>
`;

function data(accounts: AccountResponse[]): DashboardData {
  return {
    summary: {
      total_value: 0,
      total_cost_basis: 0,
      total_gain_loss: 0,
      retirement_value: 0,
      taxable_value: 0,
      account_count: accounts.length,
      position_count: 0,
      accounts,
    },
    positions: [],
    history: [],
    imports: [],
    view_id: null,
    demo_mode: false,
  } as DashboardData;
}

const account = {
  id: 'a1',
  name: 'Brokerage',
  account_type: 'brokerage',
  display_type: 'Brokerage',
  brokerage: 'schwab',
  value: 100,
  cost_basis: null,
  position_count: 1,
  is_retirement: false,
} as AccountResponse;

const hidden = (sel: string): boolean =>
  document.querySelector(sel)!.classList.contains('hidden');
const click = (action: string): void =>
  document.querySelector<HTMLElement>(`[data-empty-action="${action}"]`)!.click();

beforeEach(() => {
  resetDashboardRenderState();
  document.body.innerHTML = MARKUP;
  store.set('dataMode', 'server');
  initDashboard();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('dashboard first-run empty state', () => {
  it('shows the empty state and hides hero, cards and accounts when there are no accounts', async () => {
    await renderDashboard(data([]));
    expect(hidden('#dashboard-empty')).toBe(false);
    expect(hidden('#dash-hero')).toBe(true);
    expect(hidden('.dash-cards')).toBe(true);
    expect(hidden('#accounts-card')).toBe(true);
  });

  it('hides the empty state and shows the rest when accounts exist', async () => {
    await renderDashboard(data([]));
    await renderDashboard(data([account]));
    expect(hidden('#dashboard-empty')).toBe(true);
    expect(hidden('#dash-hero')).toBe(false);
    expect(hidden('.dash-cards')).toBe(false);
    expect(hidden('#accounts-card')).toBe(false);
  });

  it('import opens the Add Position modal', async () => {
    await renderDashboard(data([]));
    click('import');
    expect(showAddPositionModal).toHaveBeenCalledTimes(1);
    expect(showNewAccountForm).not.toHaveBeenCalled();
  });

  it('add-account opens the modal and then the new-account form', async () => {
    await renderDashboard(data([]));
    click('add-account');
    await vi.waitFor(() => expect(showNewAccountForm).toHaveBeenCalledTimes(1));
    expect(showAddPositionModal).toHaveBeenCalledTimes(1);
  });

  it('demo calls startDemoMode in server data mode', async () => {
    await renderDashboard(data([]));
    click('demo');
    expect(startDemoMode).toHaveBeenCalledTimes(1);
    expect(seedDemoDatasetIfEmpty).not.toHaveBeenCalled();
  });

  it('demo seeds the local dataset and requests a refresh in local data mode', async () => {
    store.set('dataMode', 'local');
    const refresh = vi.fn();
    document.addEventListener('dashboard:refreshRequested', refresh);
    await renderDashboard(data([]));
    click('demo');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    document.removeEventListener('dashboard:refreshRequested', refresh);
    expect(seedDemoDatasetIfEmpty).toHaveBeenCalledTimes(1);
    expect(startDemoMode).not.toHaveBeenCalled();
  });

  it('demo in local mode toasts and does not refresh when nothing was seeded', async () => {
    store.set('dataMode', 'local');
    vi.mocked(seedDemoDatasetIfEmpty).mockResolvedValueOnce(false);
    const refresh = vi.fn();
    document.addEventListener('dashboard:refreshRequested', refresh);
    await renderDashboard(data([]));
    click('demo');
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Demo data isn't available on this site.", 'info')
    );
    document.removeEventListener('dashboard:refreshRequested', refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('with a view filter and zero accounts shows the normal dashboard, not the first-run state', async () => {
    await renderDashboard({ ...data([]), view_id: 'v1' } as DashboardData);
    expect(hidden('#dashboard-empty')).toBe(true);
    expect(hidden('#dash-hero')).toBe(false);
    expect(hidden('#accounts-card')).toBe(false);
  });

  it('an empty string view_id counts as no filter', async () => {
    await renderDashboard({ ...data([]), view_id: '' } as DashboardData);
    expect(hidden('#dashboard-empty')).toBe(false);
  });

  it('the tour link starts the tour without navigating', async () => {
    await renderDashboard(data([]));
    const link = document.querySelector<HTMLElement>('[data-empty-action="tour"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(startTour).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});
