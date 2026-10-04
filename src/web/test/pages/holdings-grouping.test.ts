/**
 * Tests for grouping holdings by account: header rows with subtotals, sorting
 * within groups, the persisted toggle, filters, and row actions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn().mockResolvedValue({}) }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/modal', () => ({
  showConfirmDialog: vi.fn(),
  showAddPositionModal: vi.fn(),
  hideAddPositionModal: vi.fn(),
  showEditPositionModal: vi.fn(),
  hideEditPositionModal: vi.fn(),
}));

vi.mock('@/utils/debt-convert-launcher', () => ({ openDebtConvertLazy: vi.fn() }));

import { store } from '@/state/store';
import { apiCall } from '@/api/client';
import { openDebtConvertLazy } from '@/utils/debt-convert-launcher';
import { showConfirmDialog } from '@/ui/modal';
import {
  updateHoldings,
  groupPositionsByAccount,
  setHoldingsGrouping,
  setHoldingsSort,
  initHoldings,
  isHoldingsGroupingEnabled,
} from '@/pages/holdings';
import type { DashboardPosition } from '@/types/api';

function pos(id: string, ticker: string, account: string, value: number, cost: number | null) {
  return {
    id,
    ticker,
    name: `${ticker} Inc`,
    shares: 10,
    price: value / 10,
    value,
    cost_basis: cost,
    account,
    account_type: 'taxable',
    is_fund: false,
    position_type: 'equity',
  } as DashboardPosition;
}

// Roth holds the most value, then Brokerage, then 401k.
const POSITIONS = [
  pos('1', 'AAA', 'Brokerage', 1000, 800),
  pos('2', 'BBB', 'Brokerage', 3000, 2000),
  pos('3', 'CCC', 'Roth', 9000, 5000),
  pos('4', 'DDD', '401k', 500, null),
  pos('5', 'EEE', 'Roth', 1000, 1200),
];

const MARKUP = `
  <input id="holdings-search" />
  <div id="account-filter-options"></div>
  <div class="table-container">
    <table id="holdings-table"><thead><tr><th class="sortable" data-sort="value"></th></tr></thead><tbody></tbody></table>
  </div>
  <label><input type="checkbox" id="holdings-group-toggle" /></label>
  <select id="holdings-sort-field">
    <option value="value">Value</option><option value="gain_loss">Gain/Loss</option>
    <option value="ticker">Ticker</option><option value="name">Name</option>
    <option value="shares">Shares</option><option value="price">Price</option>
    <option value="account">Account</option>
  </select>
  <select id="holdings-sort-direction"><option value="desc">High</option><option value="asc">Low</option></select>
`;

function mockStorage(map: Map<string, string> | 'throws') {
  const ls = window.localStorage as unknown as Record<string, ReturnType<typeof vi.fn>>;
  if (map === 'throws') {
    ls.getItem.mockImplementation(() => {
      throw new Error('denied');
    });
    ls.setItem.mockImplementation(() => {
      throw new Error('denied');
    });
    return;
  }
  ls.getItem.mockImplementation((k: string) => map.get(k) ?? null);
  ls.setItem.mockImplementation((k: string, v: string) => {
    map.set(k, v);
  });
}

function bodyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>('#holdings-table tbody tr'));
}

function describeRows(): string[] {
  return bodyRows().map((r) =>
    r.classList.contains('holdings-group-row')
      ? `# ${r.querySelector('.holdings-group-name')?.textContent}`
      : (r.querySelector('td strong')?.textContent ?? '?')
  );
}

describe('groupPositionsByAccount', () => {
  it('orders groups by account value descending and keeps input order within a group', () => {
    const groups = groupPositionsByAccount(POSITIONS);
    expect(groups.map((g) => g.account)).toEqual(['Roth', 'Brokerage', '401k']);
    expect(groups[1]!.positions.map((p) => p.ticker)).toEqual(['AAA', 'BBB']);
    expect(groups[0]).toMatchObject({ count: 2, value: 10000 });
  });

  it('totals gain/loss only over positions with a cost basis', () => {
    const groups = groupPositionsByAccount(POSITIONS);
    expect(groups.find((g) => g.account === 'Roth')!.gainLoss).toBe(3800);
    expect(groups.find((g) => g.account === '401k')!.gainLoss).toBeNull();
  });
});

describe('updateHoldings grouping', () => {
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    store.set('currentPositions', POSITIONS);
    store.set('selectedAccounts', new Set());
    mockStorage(new Map());
    setHoldingsGrouping(true); // reset the module's in-memory fallback
    mockStorage(new Map());
    store.set('currentSort', { field: 'ticker', direction: 'asc' });
    store.set('selectedAccounts', new Set());
    vi.mocked(showConfirmDialog).mockClear();
    vi.mocked(apiCall).mockClear();
  });

  it('renders account headers by account value, positions sorted within each', () => {
    updateHoldings(POSITIONS);
    expect(describeRows()).toEqual([
      '# Roth',
      'CCC',
      'EEE',
      '# Brokerage',
      'AAA',
      'BBB',
      '# 401k',
      'DDD',
    ]);
    const header = bodyRows()[0]!;
    expect(header.querySelectorAll('td').length).toBe(1);
    expect(header.querySelector('td')!.colSpan).toBe(8);
    const text = header.textContent ?? '';
    expect(text).toContain('Roth');
    expect(text).toContain('2 positions');
    expect(text).toContain('$10,000');
    expect(text).toContain('$3,800');
  });

  it('uses the singular for a one-position group', () => {
    updateHoldings(POSITIONS);
    expect(bodyRows().find((r) => r.textContent?.includes('401k'))!.textContent).toContain(
      '1 position'
    );
    expect(bodyRows().find((r) => r.textContent?.includes('401k'))!.textContent).not.toContain(
      '1 positions'
    );
  });

  it('applies the current sort within groups (value desc)', () => {
    store.set('currentSort', { field: 'value', direction: 'desc' });
    updateHoldings(POSITIONS);
    expect(describeRows()).toEqual([
      '# Roth',
      'CCC',
      'EEE',
      '# Brokerage',
      'BBB',
      'AAA',
      '# 401k',
      'DDD',
    ]);
  });

  it('shows no header rows and a flat sorted list when grouping is off', () => {
    setHoldingsGrouping(false);
    updateHoldings(POSITIONS);
    expect(describeRows()).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    expect(document.querySelector('.holdings-group-row')).toBeNull();
  });

  it('persists the toggle and survives a re-render', () => {
    setHoldingsGrouping(false);
    expect(window.localStorage.setItem).toHaveBeenCalled();
    updateHoldings(POSITIONS);
    updateHoldings(POSITIONS);
    expect(isHoldingsGroupingEnabled()).toBe(false);
    expect(document.querySelector('.holdings-group-row')).toBeNull();
    expect((document.getElementById('holdings-group-toggle') as HTMLInputElement).checked).toBe(
      false
    );
  });

  it('defaults on and still groups when localStorage throws', () => {
    mockStorage('throws');
    expect(isHoldingsGroupingEnabled()).toBe(true);
    expect(() => setHoldingsGrouping(true)).not.toThrow();
    updateHoldings(POSITIONS);
    expect(document.querySelectorAll('.holdings-group-row').length).toBe(3);
    expect((document.getElementById('holdings-group-toggle') as HTMLInputElement).checked).toBe(
      true
    );
  });

  it('narrows by search and omits groups with no matching rows', () => {
    (document.getElementById('holdings-search') as HTMLInputElement).value = 'ccc';
    updateHoldings(POSITIONS);
    expect(describeRows()).toEqual(['# Roth', 'CCC']);
    expect(document.querySelector('.holdings-group-row')!.textContent).toContain('1 position');
    expect(document.querySelector('.holdings-group-row')!.textContent).toContain('$9,000');
  });

  it('narrows by the account filter', () => {
    store.set('selectedAccounts', new Set(['Brokerage']));
    updateHoldings(POSITIONS);
    expect(describeRows()).toEqual(['# Brokerage', 'AAA', 'BBB']);
  });

  it('keeps the no-match state when the filter excludes everything', () => {
    (document.getElementById('holdings-search') as HTMLInputElement).value = 'zzz';
    updateHoldings(POSITIONS);
    expect(bodyRows().length).toBe(0);
    expect(document.querySelector('.table-container')!.textContent).toContain(
      'No holdings match the current filter'
    );
  });

  it('wires edit and delete to the right position inside a group', () => {
    ['edit-position-id', 'edit-position-ticker', 'edit-position-shares'].forEach((id) => {
      const input = document.createElement('input');
      input.id = id;
      document.body.appendChild(input);
    });
    updateHoldings(POSITIONS);
    const eeeRow = bodyRows().find((r) => r.querySelector('td strong')?.textContent === 'EEE')!;

    (eeeRow.querySelector('.icon-btn-edit') as HTMLElement).click();
    expect((document.getElementById('edit-position-id') as HTMLInputElement).value).toBe('5');
    expect((document.getElementById('edit-position-ticker') as HTMLInputElement).value).toBe('EEE');

    (eeeRow.querySelector('.icon-btn-delete') as HTMLElement).click();
    expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    const onConfirm = vi.mocked(showConfirmDialog).mock.calls[0]![1] as () => Promise<void>;
    return onConfirm().then(() => {
      expect(apiCall).toHaveBeenCalledWith('/api/portfolio/positions/5', { method: 'DELETE' });
    });
  });
});

describe('loan or property action', () => {
  const home = (over: Partial<DashboardPosition>): DashboardPosition =>
    ({
      ...pos('h1', 'RE', 'Brokerage', 612000, 400000),
      position_type: 'real_estate',
      ...over,
    }) as DashboardPosition;

  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    store.set('selectedAccounts', new Set());
    mockStorage(new Map());
    vi.mocked(openDebtConvertLazy).mockClear();
  });

  const rowFor = (ticker: string): HTMLTableRowElement =>
    bodyRows().find((r) => r.querySelector('td strong')?.textContent === ticker)!;

  it('appears on real estate rows only, as a third action', () => {
    updateHoldings([home({}), pos('2', 'BBB', 'Brokerage', 3000, 2000)]);
    const re = rowFor('RE');
    expect(re.querySelectorAll('.actions-cell button')).toHaveLength(3);
    const action = re.querySelector<HTMLButtonElement>('.icon-btn-convert')!;
    expect(action.getAttribute('aria-label')).toBe('Loan or property');
    expect(rowFor('BBB').querySelector('.icon-btn-convert')).toBeNull();
    expect(rowFor('BBB').querySelectorAll('.actions-cell button')).toHaveLength(2);
  });

  it('also appears on an RE ticker row that predates the position type', () => {
    updateHoldings([home({ position_type: 'equity' })]);
    expect(rowFor('RE').querySelector('.icon-btn-convert')).not.toBeNull();
  });

  it('opens the dialog for that position without sending anything', () => {
    updateHoldings([home({})]);
    rowFor('RE').querySelector<HTMLButtonElement>('.icon-btn-convert')!.click();
    expect(openDebtConvertLazy).toHaveBeenCalledWith('h1');
    expect(apiCall).not.toHaveBeenCalledWith(
      expect.stringContaining('convert-position'),
      expect.anything()
    );
  });
});

describe('updateHoldings state views', () => {
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    store.set('currentPositions', POSITIONS);
    store.set('selectedAccounts', new Set());
    store.set('currentSort', { field: 'ticker', direction: 'asc' });
    mockStorage(new Map());
    setHoldingsGrouping(true);
  });

  it('brings the rows back after a no-match filter is cleared', () => {
    const search = document.getElementById('holdings-search') as HTMLInputElement;
    search.value = 'zzz';
    updateHoldings(POSITIONS);
    search.value = '';
    updateHoldings(POSITIONS);
    expect(describeRows()).toContain('CCC');
    expect(document.querySelector('.state-view')).toBeNull();
  });
});

describe('holdings accessibility and sort controls', () => {
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    store.set('currentPositions', POSITIONS);
    store.set('selectedAccounts', new Set());
    store.set('currentSort', { field: 'ticker', direction: 'asc' });
    mockStorage(new Map());
    setHoldingsGrouping(true);
  });

  it('gives rows and cells explicit roles and the group name a heading role', () => {
    updateHoldings(POSITIONS);
    const rows = bodyRows();
    expect(rows.every((r) => r.getAttribute('role') === 'row')).toBe(true);
    const dataRow = rows.find((r) => !r.classList.contains('holdings-group-row'))!;
    expect(
      Array.from(dataRow.querySelectorAll('td')).every((c) => c.getAttribute('role') === 'cell')
    ).toBe(true);
    expect(dataRow.querySelector('td')!.dataset.label).toBe('Ticker');
    expect(Array.from(dataRow.querySelectorAll('td')).map((c) => c.dataset.label)).toContain(
      'Gain/Loss'
    );
    const name = document.querySelector('.holdings-group-name')!;
    expect(name.getAttribute('role')).toBe('heading');
    expect(name.getAttribute('aria-level')).toBe('3');
  });

  it('flags the table as grouped (Account column hidden by CSS) and clears it when ungrouped', () => {
    const table = document.getElementById('holdings-table')!;
    updateHoldings(POSITIONS);
    expect(table.classList.contains('holdings-grouped')).toBe(true);
    setHoldingsGrouping(false);
    expect(table.classList.contains('holdings-grouped')).toBe(false);
  });

  it('offers Account in the sort select only while ungrouped', () => {
    const field = document.getElementById('holdings-sort-field') as HTMLSelectElement;
    const account = Array.from(field.options).find((o) => o.value === 'account')!;
    updateHoldings(POSITIONS);
    expect(account.hidden).toBe(true);
    expect(account.disabled).toBe(true);
    setHoldingsGrouping(false);
    expect(account.hidden).toBe(false);
    expect(account.disabled).toBe(false);
  });

  it('shows Value in the sort select when grouped with a stored Account sort', () => {
    const field = document.getElementById('holdings-sort-field') as HTMLSelectElement;
    store.set('currentSort', { field: 'account', direction: 'asc' });
    updateHoldings(POSITIONS);
    expect(field.value).toBe('value');
    setHoldingsGrouping(false);
    expect(field.value).toBe('account');
  });

  it('drives the sort from the phone selects and reflects the store', () => {
    initHoldings();
    const field = document.getElementById('holdings-sort-field') as HTMLSelectElement;
    const dir = document.getElementById('holdings-sort-direction') as HTMLSelectElement;
    setHoldingsGrouping(false);

    field.value = 'value';
    dir.value = 'desc';
    field.dispatchEvent(new Event('change'));
    expect(store.get('currentSort')).toEqual({ field: 'value', direction: 'desc' });
    expect(describeRows()).toEqual(
      ['CCC', 'BBB', 'AAA', 'EEE', 'DDD'].sort((a, b) => {
        const v: Record<string, number> = { CCC: 9000, BBB: 3000, AAA: 1000, EEE: 1000, DDD: 500 };
        return v[b]! - v[a]!;
      })
    );

    dir.value = 'asc';
    dir.dispatchEvent(new Event('change'));
    expect(store.get('currentSort').direction).toBe('asc');
    expect(describeRows()[0]).toBe('DDD');

    setHoldingsSort('ticker', 'desc');
    expect(field.value).toBe('ticker');
    expect(dir.value).toBe('desc');
    expect(describeRows()[0]).toBe('EEE');
  });

  it('labels a group without cost basis instead of a bare dash', () => {
    updateHoldings(POSITIONS);
    const row = bodyRows().find(
      (r) => r.classList.contains('holdings-group-row') && r.textContent?.includes('401k')
    )!;
    expect(row.textContent).toContain('No cost basis');
  });

  it('brings the rows back after the No holdings yet state', () => {
    updateHoldings([]);
    expect(document.querySelector('.table-container')!.textContent).toContain('No holdings yet');
    updateHoldings(POSITIONS);
    expect(describeRows()).toContain('CCC');
    expect(document.querySelector('.state-view')).toBeNull();
  });
});
