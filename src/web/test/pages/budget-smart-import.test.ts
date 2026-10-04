/**
 * Budget > Expenses: the import card markup, the import history with per-upload
 * Undo, and the planned vs actual card.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/api/client', async () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly data?: unknown
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
vi.mock('@/ui/tabs', () => ({ onTabChange: vi.fn(), showTab: vi.fn(), getCurrentTab: vi.fn() }));
vi.mock('@/charts/budget', () => ({
  loadPaycheckChart: vi.fn(async () => {}),
  renderCashFlowWaterfall: vi.fn(async () => {}),
  updateExpensesCategoryChart: vi.fn(async () => {}),
  renderTransitionChart: vi.fn(async () => {}),
  renderSSComparison: vi.fn(),
  renderIncomeTransitionTable: vi.fn(),
}));
vi.mock('@/utils/smart-import-launcher', () => ({ openSmartImportLazy: vi.fn() }));

import { apiCall, ApiError } from '@/api/client';
import { closeDynamicModal } from '@/ui/modal';
import { store } from '@/state/store';
import { on, _resetEventBus } from '@/state/events';
import { loadBudgetTab } from '@/pages/budget';
import { loadImportCards, type ImportCardDeps } from '@/pages/budget-smart-import';
import type { SmartImportSummary, SpendingSummary } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const EM_DASH = String.fromCharCode(0x2014);

function imp(over: Partial<SmartImportSummary>): SmartImportSummary {
  return {
    import_id: 'i1',
    batch_id: 'b1',
    file_name: 'checking.csv',
    origin: 'upload',
    format: 'csv',
    parser: 'csv',
    account_kind: 'checking',
    account_key: 'k1',
    account_label: 'Everyday checking',
    account_last4: '1234',
    institution: 'Sample Bank',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    closing_balance: null,
    closing_balance_date: null,
    liability_id: null,
    txn_new: 52,
    txn_duplicate: 3,
    txn_excluded: 1,
    ai_used: 0,
    ai_provider: null,
    imported_at: '2026-10-02T15:00:00',
    ...over,
  };
}

const IMPORTS: SmartImportSummary[] = [
  imp({
    import_id: 'i3',
    batch_id: 'b2',
    file_name: 'newer.csv',
    imported_at: '2026-10-03T09:00:00',
  }),
  imp({
    import_id: 'i2',
    batch_id: 'b1',
    file_name: 'card.ofx',
    account_kind: 'credit_card',
    account_label: null,
    account_last4: '5678',
    liability_id: 'd1',
    closing_balance: 2755,
    txn_new: 40,
    txn_duplicate: 0,
  }),
  imp({ import_id: 'i1', batch_id: 'b1', file_name: '<b>x</b>.csv', origin: 'sample' }),
];

const SUMMARY: SpendingSummary = {
  months_covered: 3,
  months: ['2026-07', '2026-08', '2026-09'],
  categories: [
    {
      category_id: 'c-food',
      category_name: 'Food & Dining',
      actual_monthly: 412.5,
      planned_monthly: 0,
      difference: 412.5,
    },
    {
      category_id: 'c-house',
      category_name: 'Housing',
      actual_monthly: 1800,
      planned_monthly: 1850,
      difference: -50,
    },
    {
      category_id: 'c-fun',
      category_name: 'Entertainment',
      actual_monthly: 80,
      planned_monthly: 40,
      difference: 40,
    },
    {
      category_id: null,
      category_name: 'Uncategorized',
      actual_monthly: 25,
      planned_monthly: 0,
      difference: 25,
    },
  ],
  totals: { actual_monthly: 2317.5, planned_monthly: 1890, difference: 427.5 },
};

const deps: ImportCardDeps = {
  addToPlan: vi.fn(),
  refresh: vi.fn(async () => {}),
};

function html(): void {
  document.body.innerHTML = `
    <div id="smart-import-history-list"></div>
    <p id="smart-import-history-status" role="status"></p>
    <div id="planned-actual-body"></div>
    <div id="expenses-list"></div>`;
}

interface Routes {
  imports?: SmartImportSummary[] | 'fail';
  summary?: SpendingSummary | 'fail';
  undo?: unknown;
}

function route(r: Routes = {}): void {
  apiCallMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/api/smart-import/imports' && !opts?.method) {
      if (r.imports === 'fail') throw new Error('boom');
      return r.imports ?? IMPORTS;
    }
    if (url.startsWith('/api/budget/spending-summary')) {
      if (r.summary === 'fail') throw new Error('boom');
      return r.summary ?? SUMMARY;
    }
    if (url.startsWith('/api/smart-import/imports/') && opts?.method === 'DELETE') {
      if (r.undo instanceof Error) throw r.undo;
      return (
        r.undo ?? {
          deleted: { transactions: 40, expenses: 1, snapshots: 1 },
          reassigned: { transactions: 0 },
          kept: [],
        }
      );
    }
    return [];
  });
}

const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';

describe('Expenses import card markup', () => {
  const doc = new DOMParser().parseFromString(
    readFileSync(resolve(__dirname, '../../index.html'), 'utf8'),
    'text/html'
  );

  it('is titled "Import statements" and accepts the four extensions', () => {
    const card = doc.getElementById('bank-statement-import-panel')!;
    expect(card.querySelector('h3')!.textContent).toBe('Import statements');
    expect(doc.getElementById('bank-statement-file')!.getAttribute('accept')).toBe(
      '.csv,.ofx,.qfx,.pdf'
    );
    expect(card.querySelector('#smart-import-history-list')).not.toBeNull();
    expect(card.textContent).toContain('Import history');
  });

  it('ships the planned vs actual card', () => {
    const card = doc.getElementById('planned-actual-card')!;
    expect(card.querySelector('h3')!.textContent).toBe('Planned vs actual');
    expect(card.querySelector('#planned-actual-body')).not.toBeNull();
  });

  it('keeps legacy candidates in their own panel and the new cards have no em-dash', () => {
    expect(doc.getElementById('recurring-candidates-panel')).not.toBeNull();
    const raw = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    const cards = raw.slice(
      raw.indexOf('<!-- Statement Import Card -->'),
      raw.indexOf('<!-- Expenses by Category Card -->')
    );
    expect(cards.length).toBeGreaterThan(1000);
    expect(cards).not.toContain(EM_DASH);
  });
});

describe('import history', () => {
  beforeEach(() => {
    html();
    apiCallMock.mockReset();
    vi.mocked(deps.refresh).mockClear();
    _resetEventBus();
    store.set('currentEntityId', null);
  });

  it('groups uploads by batch, newest batch first, one Undo per upload', async () => {
    route();
    await loadImportCards(deps);
    const groups = document.querySelectorAll('.import-history-batch');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelectorAll('.import-history-row')).toHaveLength(1);
    expect(groups[1]!.querySelectorAll('.import-history-row')).toHaveLength(2);
    expect(document.querySelectorAll('[data-si-history="undo"]')).toHaveLength(3);
    const first = groups[0]!.querySelector('.import-history-row')!.textContent!;
    expect(first).toContain('newer.csv');
    expect(first).toContain('52 new');
    expect(first).toContain('3 already imported');
  });

  it('names the account, marks samples, and renders file names as text', async () => {
    route();
    await loadImportCards(deps);
    const rows = Array.from(document.querySelectorAll('.import-history-row'));
    const card = rows.find((r) => r.textContent!.includes('card.ofx'))!;
    expect(card.textContent).toContain('Credit card ending 5678');
    const sample = rows.find((r) => r.textContent!.includes('<b>x</b>.csv'))!;
    expect(sample.querySelector('b')).toBeNull();
    expect(sample.textContent).toContain('Sample');
    expect(sample.textContent).toContain('Everyday checking');
  });

  it('shows an empty line when nothing was imported', async () => {
    route({ imports: [] });
    await loadImportCards(deps);
    expect(text('#smart-import-history-list')).toContain('No imports yet');
    expect(document.querySelector('.import-history-row')).toBeNull();
  });

  it('shows a fixed message when the list cannot load', async () => {
    route({ imports: 'fail' });
    await loadImportCards(deps);
    expect(text('#smart-import-history-list')).toBe(
      'Import history could not be loaded. Try again in a moment.'
    );
  });

  it('asks before undoing, listing what is removed, and sends nothing on Keep it', async () => {
    route();
    await loadImportCards(deps);
    const row = Array.from(document.querySelectorAll('.import-history-row')).find((r) =>
      r.textContent!.includes('card.ofx')
    )!;
    row.querySelector<HTMLButtonElement>('[data-si-history="undo"]')!.click();
    expect(row.querySelector('.import-history-confirm')!.textContent).toContain(
      'Undo this import? Removes 40 transactions, any expenses it added and any debt balance it recorded. Remembered merchants stay.'
    );
    row.querySelector<HTMLButtonElement>('[data-si-history="keep"]')!.click();
    expect(row.querySelector('.import-history-confirm')).toBeNull();
    expect(
      apiCallMock.mock.calls.some(([, o]) => (o as { method?: string })?.method === 'DELETE')
    ).toBe(false);
  });

  it('leaves the debt balance out of the confirm for an import with no debt', async () => {
    route();
    await loadImportCards(deps);
    const row = document.querySelector('.import-history-row')!;
    row.querySelector<HTMLButtonElement>('[data-si-history="undo"]')!.click();
    const confirm = row.querySelector('.import-history-confirm')!.textContent!;
    expect(confirm).toContain('Removes 52 transactions and any expenses it added.');
    expect(confirm).not.toContain('debt balance');
  });

  it('undoes one upload: one DELETE, a result line, and every view refreshed', async () => {
    route();
    const events: string[] = [];
    on('liabilities:changed', (e) => events.push(e.reason));
    await loadImportCards(deps);
    const row = Array.from(document.querySelectorAll('.import-history-row')).find((r) =>
      r.textContent!.includes('card.ofx')
    )!;
    row.querySelector<HTMLButtonElement>('[data-si-history="undo"]')!.click();
    apiCallMock.mockClear();
    route({
      imports: IMPORTS.filter((i) => i.import_id !== 'i2'),
      undo: {
        deleted: { transactions: 40, expenses: 1, snapshots: 1 },
        reassigned: { transactions: 2 },
        kept: [{ table: 'budget_expenses', id: 'e1', reason: 'edited' }],
      },
    });
    row.querySelector<HTMLButtonElement>('[data-si-history="confirm"]')!.click();
    await vi.waitFor(() => expect(events).toEqual(['balance']));
    const deletes = apiCallMock.mock.calls.filter(
      ([, o]) => (o as { method?: string })?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![0]).toBe('/api/smart-import/imports/i2');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.import-history-row')).toHaveLength(2)
    );
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    const status = text('#smart-import-history-status');
    expect(status).toContain('Removed 40 transactions, 1 expense and 1 debt balance.');
    expect(status).toContain('Kept 1 expense: it was changed after the import.');
    expect(status).toContain('2 transactions also in another import now belong to that import.');
    expect(status).toContain('Remembered merchants stay.');
    // the planned vs actual card was reloaded too
    expect(
      apiCallMock.mock.calls.some(([u]) => String(u).startsWith('/api/budget/spending-summary'))
    ).toBe(true);
  });

  it('treats a 404 as already undone and reloads', async () => {
    route();
    await loadImportCards(deps);
    const row = document.querySelector('.import-history-row')!;
    row.querySelector<HTMLButtonElement>('[data-si-history="undo"]')!.click();
    route({ imports: [], undo: new ApiError(404, 'gone') });
    row.querySelector<HTMLButtonElement>('[data-si-history="confirm"]')!.click();
    await vi.waitFor(() => expect(text('#smart-import-history-list')).toContain('No imports yet'));
    expect(text('#smart-import-history-status')).toContain('already undone');
  });

  it('shows fixed copy and keeps the row when Undo fails', async () => {
    route();
    await loadImportCards(deps);
    const row = document.querySelector('.import-history-row')!;
    row.querySelector<HTMLButtonElement>('[data-si-history="undo"]')!.click();
    route({ undo: new ApiError(500, 'secret server text') });
    row.querySelector<HTMLButtonElement>('[data-si-history="confirm"]')!.click();
    await vi.waitFor(() =>
      expect(text('#smart-import-history-status')).toContain('could not be undone')
    );
    expect(text('#smart-import-history-status')).not.toContain('secret');
    expect(document.querySelectorAll('.import-history-row')).toHaveLength(3);
  });
});

describe('planned vs actual', () => {
  beforeEach(() => {
    html();
    apiCallMock.mockReset();
    vi.mocked(deps.addToPlan).mockClear();
    store.set('currentEntityId', null);
  });

  it('renders a row with bars and numbers per category, plus the months covered', async () => {
    route();
    await loadImportCards(deps);
    const rows = document.querySelectorAll('.pva-row');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.querySelector('.pva-bars')).not.toBeNull();
    expect(rows[1]!.textContent).toContain('Housing');
    expect(rows[1]!.textContent).toContain('$1,850.00');
    expect(rows[1]!.textContent).toContain('$1,800.00');
    expect(rows[1]!.textContent).toContain('$50.00 under plan');
    expect(rows[2]!.textContent).toContain('$40.00 over plan');
    expect(text('#planned-actual-body')).toContain('3 months');
    expect(text('#planned-actual-body')).toContain('Jul 2026 to Sep 2026');
  });

  it('scales the bars to the largest value', async () => {
    route();
    await loadImportCards(deps);
    const rows = document.querySelectorAll('.pva-row');
    const widths = (row: Element): string[] =>
      Array.from(row.querySelectorAll<HTMLElement>('.pva-bar')).map((b) => b.style.width);
    expect(widths(rows[1]!)).toEqual(['100%', '97.3%']);
    expect(widths(rows[0]!)).toEqual(['0%', '22.3%']);
  });

  it('keeps a small amount visible and a zero amount empty', async () => {
    route({
      summary: {
        ...SUMMARY,
        categories: [
          {
            category_id: 'c1',
            category_name: 'Insurance',
            actual_monthly: 0,
            planned_monthly: 120,
            difference: -120,
          },
          {
            category_id: 'c2',
            category_name: 'Healthcare',
            actual_monthly: 7.39,
            planned_monthly: 0,
            difference: 7.39,
          },
        ],
      },
    });
    await loadImportCards(deps);
    const bars = (i: number): HTMLElement[] =>
      Array.from(
        document.querySelectorAll('.pva-row')[i]!.querySelectorAll<HTMLElement>('.pva-bar')
      );
    expect(bars(0)[1]!.style.minWidth).toBe('');
    expect(bars(1)[1]!.style.minWidth).toBe('2px');
  });

  it('shows an Uncategorized line without an Add to plan button', async () => {
    route();
    await loadImportCards(deps);
    const rows = Array.from(document.querySelectorAll('.pva-row'));
    const unc = rows.find((r) => r.textContent!.includes('Uncategorized'))!;
    expect(unc.textContent).toContain('$25.00');
    expect(unc.querySelector('[data-si-pva="add"]')).toBeNull();
  });

  it('offers Add to plan only where there is spending and no plan, with the API category id', async () => {
    route();
    await loadImportCards(deps);
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-si-pva="add"]');
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(deps.addToPlan).toHaveBeenCalledWith({ category_id: 'c-food', amount: 412.5 });
  });

  it('asks for the covered months only and passes the profile', async () => {
    route();
    store.set('currentEntityId', 'p1');
    await loadImportCards(deps);
    const call = apiCallMock.mock.calls.find(([u]) =>
      String(u).startsWith('/api/budget/spending')
    )!;
    expect(call[0]).toBe('/api/budget/spending-summary?months=3&entity_id=p1');
  });

  it('says what to do when no statement is covered yet', async () => {
    route({
      summary: {
        months_covered: 0,
        months: [],
        categories: [],
        totals: { actual_monthly: 0, planned_monthly: 0, difference: 0 },
      },
    });
    await loadImportCards(deps);
    expect(text('#planned-actual-body')).toContain('Import a statement');
    expect(document.querySelector('.pva-row')).toBeNull();
  });

  it('shows fixed copy when the summary cannot load', async () => {
    route({ summary: 'fail' });
    await loadImportCards(deps);
    expect(text('#planned-actual-body')).toBe(
      'Planned vs actual could not be loaded. Try again in a moment.'
    );
  });

  it('writes no em-dash into the DOM', async () => {
    route();
    await loadImportCards(deps);
    expect(document.body.textContent).not.toContain(EM_DASH);
  });
});

describe('budget tab wiring', () => {
  beforeEach(() => {
    closeDynamicModal();
    html();
    apiCallMock.mockReset();
  });

  it('loadBudgetTab loads the history and the planned vs actual card', async () => {
    route();
    await loadBudgetTab();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.import-history-row')).toHaveLength(3)
    );
    await vi.waitFor(() => expect(document.querySelectorAll('.pva-row')).toHaveLength(4));
  });

  it('Add to plan opens the Add Expense dialog prefilled with the API category id', async () => {
    route();
    apiCallMock.mockImplementation(async (url: string, opts?: unknown) => {
      if (url === '/api/budget/expense-categories') {
        return [
          { id: 'c-house', name: 'Housing' },
          { id: 'c-food', name: 'Food & Dining' },
        ];
      }
      if (url === '/api/smart-import/imports') return [];
      if (String(url).startsWith('/api/budget/spending-summary')) return SUMMARY;
      void opts;
      return [];
    });
    await loadBudgetTab();
    await vi.waitFor(() => expect(document.querySelector('[data-si-pva="add"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-si-pva="add"]')!.click();
    await vi.waitFor(() => {
      const select = document.getElementById('expense-category') as HTMLSelectElement | null;
      expect(select?.value).toBe('c-food');
    });
    expect((document.getElementById('expense-amount') as HTMLInputElement).value).toBe('412.5');
  });
});
