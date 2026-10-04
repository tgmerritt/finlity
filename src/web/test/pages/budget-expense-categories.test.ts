/**
 * The Add and Edit Expense dialogs list the categories the API returns. Ids are
 * integers on the server but UUIDs in the browser database, so a fixed list of
 * '1' to '12' only ever worked in one of the two modes.
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
import { showToast } from '@/ui/toast';
import { closeDynamicModal } from '@/ui/modal';
import { store } from '@/state/store';
import { showAddExpenseModal, editExpense } from '@/pages/budget';

const apiCallMock = vi.mocked(apiCall);

const CATEGORIES = [
  { id: 'c-house', name: 'Housing' },
  { id: 'c-food', name: 'Food & Dining' },
  { id: 'c-pets', name: '<b>Pets</b>' },
];

function options(): HTMLOptionElement[] {
  const select = document.getElementById('expense-category') as HTMLSelectElement;
  return Array.from(select.options);
}

function answer(categories: unknown = CATEGORIES): void {
  apiCallMock.mockImplementation(async (url: string) => {
    if (url === '/api/budget/expense-categories') {
      if (categories === 'fail') throw new Error('boom');
      return categories;
    }
    return {};
  });
}

async function loaded(): Promise<void> {
  await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(options()[0]!.textContent).not.toBe('Loading categories...'));
}

describe('Add Expense dialog categories', () => {
  beforeEach(() => {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    apiCallMock.mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('builds the options from the API, ids included, with names as text', async () => {
    answer();
    showAddExpenseModal();
    await loaded();
    expect(options().map((o) => o.value)).toEqual(['c-house', 'c-food', 'c-pets']);
    expect(options()[2]!.textContent).toBe('<b>Pets</b>');
    expect(options()[2]!.querySelector('b')).toBeNull();
  });

  it('prefills the name, the category id and the amount', async () => {
    answer();
    showAddExpenseModal({ category_id: 'c-food', amount: 412.5, name: 'Groceries' });
    await loaded();
    expect((document.getElementById('expense-category') as HTMLSelectElement).value).toBe('c-food');
    expect((document.getElementById('expense-amount') as HTMLInputElement).value).toBe('412.5');
    expect((document.getElementById('expense-name') as HTMLInputElement).value).toBe('Groceries');
  });

  it('ignores a click event passed as the first argument', async () => {
    answer();
    showAddExpenseModal(new MouseEvent('click') as never);
    await loaded();
    expect((document.getElementById('expense-amount') as HTMLInputElement).value).toBe('');
  });

  it('saves the API id of the chosen category', async () => {
    answer();
    showAddExpenseModal({ category_id: 'c-food', amount: 100 });
    await loaded();
    (document.getElementById('expense-name') as HTMLInputElement).value = 'Groceries';
    document.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await vi.waitFor(() =>
      expect(apiCallMock).toHaveBeenCalledWith(
        '/api/budget/expenses',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ category_id: 'c-food', amount: 100 }),
        })
      )
    );
  });

  it('refuses to save without a category when the list could not load', async () => {
    answer('fail');
    showAddExpenseModal();
    await vi.waitFor(() => expect(options()[0]?.textContent).toBe('Categories unavailable'));
    document.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Choose a category.', 'error'));
    expect(apiCallMock.mock.calls.some(([url]) => url === '/api/budget/expenses')).toBe(false);
  });
});

describe('Edit Expense dialog categories', () => {
  beforeEach(() => {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    apiCallMock.mockReset();
    store.set('expenses', [
      {
        id: 'e1',
        name: 'Dog food',
        category_id: 'c-pets',
        category_name: 'Pets',
        amount: 40,
        monthly_amount: 40,
        frequency: 'monthly',
      } as never,
    ]);
  });

  it('selects the expense category among the API options, custom ones included', async () => {
    answer();
    editExpense('e1');
    await loaded();
    expect(options().map((o) => o.value)).toEqual(['c-house', 'c-food', 'c-pets']);
    expect((document.getElementById('expense-category') as HTMLSelectElement).value).toBe('c-pets');
  });
});

describe('Edit Expense keeps a category that is not in the list', () => {
  function edit(categoryId: unknown): void {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    apiCallMock.mockReset();
    vi.mocked(showToast).mockReset();
    store.set('expenses', [
      {
        id: 'e1',
        name: 'Dog food',
        category_id: categoryId,
        amount: 40,
        monthly_amount: 40,
        frequency: 'monthly',
      } as never,
    ]);
  }
  const value = (): string =>
    (document.getElementById('expense-category') as HTMLSelectElement).value;

  it('selects a matching UUID without a keep option', async () => {
    edit('c-food');
    answer();
    editExpense('e1');
    await loaded();
    expect(value()).toBe('c-food');
    expect(options().map((o) => o.textContent)).not.toContain('Current category (not in the list)');
  });

  it('matches a legacy "7" to an API id of 7', async () => {
    edit('7');
    answer([
      { id: '6', name: 'Debt' },
      { id: '7', name: 'Food & Dining' },
    ]);
    editExpense('e1');
    await loaded();
    expect(value()).toBe('7');
    expect(options()).toHaveLength(2);
  });

  it('matches numeric ids from the API', async () => {
    edit('7');
    answer([
      { id: 6, name: 'Debt' },
      { id: 7, name: 'Food & Dining' },
    ]);
    editExpense('e1');
    await loaded();
    expect(value()).toBe('7');
    expect(options()).toHaveLength(2);
  });

  it('preselects a keep option for an unknown id and saves the original id', async () => {
    edit('99');
    answer();
    editExpense('e1');
    await loaded();
    expect(value()).toBe('99');
    expect(options()[0]!.textContent).toBe('Current category (not in the list)');
    (document.getElementById('expense-amount') as HTMLInputElement).value = '55';
    document.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await vi.waitFor(() =>
      expect(apiCallMock).toHaveBeenCalledWith(
        '/api/budget/expenses/e1',
        expect.objectContaining({
          method: 'PUT',
          body: expect.objectContaining({ category_id: '99', amount: 55 }),
        })
      )
    );
  });

  const saveBody = async (): Promise<Record<string, unknown>> => {
    document.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await vi.waitFor(() =>
      expect(apiCallMock.mock.calls.some(([url]) => url === '/api/budget/expenses/e1')).toBe(true)
    );
    const put = apiCallMock.mock.calls.find(([url]) => url === '/api/budget/expenses/e1')!;
    return (put[1] as { body: Record<string, unknown> }).body;
  };

  it.each([null, ''])(
    'offers "No category" for an expense with category %j and never assigns one',
    async (none) => {
      edit(none);
      answer();
      editExpense('e1');
      await loaded();
      expect(options()[0]!.textContent).toBe('No category');
      expect(value()).toBe('');
      (document.getElementById('expense-amount') as HTMLInputElement).value = '55';
      const body = await saveBody();
      expect(body).toMatchObject({ amount: 55, name: 'Dog food' });
      expect('category_id' in body).toBe(false);
      expect(showToast).not.toHaveBeenCalledWith('Choose a category.', 'error');
    }
  );

  it('still lets a category be chosen for an expense that had none', async () => {
    edit(null);
    answer();
    editExpense('e1');
    await loaded();
    (document.getElementById('expense-category') as HTMLSelectElement).value = 'c-food';
    expect(await saveBody()).toMatchObject({ category_id: 'c-food' });
  });

  it('saves other edits and keeps the category when the list cannot load', async () => {
    edit('c-food');
    answer('fail');
    editExpense('e1');
    await vi.waitFor(() =>
      expect(options()[0]?.textContent).toBe('Current category (list unavailable)')
    );
    (document.getElementById('expense-amount') as HTMLInputElement).value = '60';
    const body = await saveBody();
    expect(body).toMatchObject({ amount: 60, category_id: 'c-food' });
  });

  it('saves other edits of an expense with no category when the list cannot load', async () => {
    edit(null);
    answer('fail');
    editExpense('e1');
    await vi.waitFor(() => expect(options()[0]?.textContent).toBe('No category'));
    (document.getElementById('expense-amount') as HTMLInputElement).value = '61';
    const body = await saveBody();
    expect(body).toMatchObject({ amount: 61 });
    expect('category_id' in body).toBe(false);
  });

  it('does not add a keep option in the Add dialog', async () => {
    closeDynamicModal();
    document.body.innerHTML = '<div id="expenses-list"></div>';
    answer();
    showAddExpenseModal({ category_id: '99' });
    await loaded();
    expect(options().map((o) => o.textContent)).not.toContain('Current category (not in the list)');
  });
});
