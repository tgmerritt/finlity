/**
 * Tests for the debt wizard shell, type step and detail steps
 * (src/features/debt-wizard.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

import { apiCall, ApiError } from '@/api/client';
import { on } from '@/state/events';
import { closeDynamicModal } from '@/ui/modal';
import { openDebtWizard, type WizardState } from '@/features/debt-wizard';
import { DEBT_TYPES, defaultsFor, fieldsFor } from '@/utils/debt-fields';
import type { LiabilityType, PositionResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function position(over: Partial<PositionResponse>): PositionResponse {
  return {
    id: 'pos1',
    account_id: 'acc1',
    account_name: 'Real estate',
    ticker: 'RE',
    name: 'Lake house',
    shares: 1,
    current_price: 500000,
    cost_basis: 400000,
    market_value: 500000,
    gain_loss: 100000,
    gain_loss_pct: 25,
    is_fund: false,
    asset_class: 'alternatives',
    position_type: 'real_estate',
    ...over,
  } as PositionResponse;
}

const modal = (): HTMLElement => document.getElementById('dynamic-modal')!;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const next = (): HTMLButtonElement => modal().querySelector('[data-wizard="next"]')!;
const back = (): HTMLButtonElement => modal().querySelector('[data-wizard="back"]')!;
const heading = (): HTMLElement => modal().querySelector('.debt-wizard-heading')!;
const field = <T extends HTMLElement = HTMLInputElement>(key: string): T =>
  modal().querySelector<T>(`[data-debt-field="${key}"]`)!;
function type(key: string, value: string): void {
  const el = field(key);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function choose(t: LiabilityType): void {
  modal().querySelector<HTMLElement>(`[data-debt-type="${t}"]`)!.click();
}
function escape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}
const computed = (): string => modal().querySelector('.debt-computed')?.textContent ?? '';

async function toStep2(t: LiabilityType, onDetails?: (s: WizardState) => void): Promise<void> {
  openDebtWizard(onDetails ? { onDetails } : {});
  choose(t);
  next().click();
  await flush();
}

describe('debt wizard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    apiCallMock.mockReset();
    apiCallMock.mockImplementation(async (url: string) => {
      if (url === '/api/portfolio/positions') {
        return [
          position({}),
          position({ id: 'pos2', ticker: 'AAPL', position_type: 'stock', name: 'Apple' }),
        ];
      }
      return {};
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  });
  afterEach(() => {
    closeDynamicModal();
    vi.useRealTimers();
  });

  it('opens on step 1 with seven types and Next disabled until one is chosen', () => {
    openDebtWizard({});
    expect(modal().querySelectorAll('[data-debt-type]')).toHaveLength(7);
    expect(modal().querySelector('.debt-wizard-progress')?.textContent).toBe('Step 1 of 4');
    expect(next().disabled).toBe(true);
    choose('auto_loan');
    expect(next().disabled).toBe(false);
    const radio = (t: string): HTMLInputElement =>
      modal().querySelector<HTMLInputElement>(`[data-debt-type="${t}"]`)!;
    expect(radio('auto_loan').checked).toBe(true);
    expect(radio('mortgage').checked).toBe(false);
  });

  it('uses native radio inputs inside labels, in one group', () => {
    openDebtWizard({});
    const radios = modal().querySelectorAll<HTMLInputElement>(
      'input[type="radio"][data-debt-type]'
    );
    expect(radios).toHaveLength(7);
    expect(new Set(Array.from(radios).map((r) => r.name)).size).toBe(1);
    radios.forEach((r) => expect(r.closest('label')).not.toBeNull());
  });

  it('moves focus to the step heading on each step', async () => {
    openDebtWizard({});
    expect(document.activeElement).toBe(heading());
    choose('mortgage');
    next().click();
    await flush();
    expect(heading().textContent).toContain('Mortgage');
    expect(document.activeElement).toBe(heading());
    back().click();
    expect(document.activeElement).toBe(heading());
    expect(modal().querySelector('.debt-wizard-progress')?.textContent).toBe('Step 1 of 4');
  });

  it.each(DEBT_TYPES.map((t) => [t]))(
    "step 2 for %s shows that type's fields with its defaults",
    async (t) => {
      await toStep2(t);
      expect(modal().querySelector('.debt-wizard-progress')?.textContent).toBe('Step 2 of 4');
      const defaults = defaultsFor(t);
      for (const f of fieldsFor(t)) {
        const input = field(f.key);
        expect(input, `${t} ${f.key}`).not.toBeNull();
        if (f.key !== 'entityId') expect(input.value).toBe(defaults[f.key]);
      }
      // No type picker inside the details step.
      expect(modal().querySelector('[data-debt-field="liabilityType"]')).toBeNull();
    }
  );

  it('updates the Calculated payment as balance, APR or term change', async () => {
    await toStep2('mortgage');
    expect(computed()).toBe('');
    type('currentBalance', '300000');
    type('aprPercent', '6.5');
    expect(computed()).toContain('Calculated');
    expect(computed()).toContain('$1,896.21');
    type('termMonths', '180');
    expect(computed()).toContain('$2,613.');
    type('currentBalance', '200000');
    expect(computed()).toContain('$1,742.');
  });

  it('keeps an overridden payment, and the Calculated note steps aside', async () => {
    await toStep2('auto_loan');
    type('currentBalance', '20000');
    type('aprPercent', '7');
    expect(computed()).toContain('$396.03');
    type('paymentAmount', '450');
    expect(computed()).toBe('');
    back().click();
    next().click();
    await flush();
    expect(field('paymentAmount').value).toBe('450');
    expect(field('currentBalance').value).toBe('20000');
  });

  it('hides advanced fields under More details', async () => {
    await toStep2('student_loan');
    const more = modal().querySelector<HTMLDetailsElement>('details.debt-form-more')!;
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')?.textContent).toBe('More details');
    for (const key of ['originalPrincipal', 'originationDate', 'lender', 'entityId']) {
      expect(more.contains(field(key))).toBe(true);
    }
    expect(more.contains(field('currentBalance'))).toBe(false);
  });

  it('Back keeps entered values, and changing the type keeps shared ones', async () => {
    await toStep2('personal_loan');
    type('name', 'Wedding loan');
    type('currentBalance', '8000');
    back().click();
    choose('auto_loan');
    next().click();
    await flush();
    expect(field('name').value).toBe('Wedding loan');
    expect(field('currentBalance').value).toBe('8000');
    expect(field('termMonths').value).toBe('60');
  });

  it('asks before closing on Escape once data is entered', async () => {
    await toStep2('personal_loan');
    escape();
    expect(document.getElementById('dynamic-modal')).toBeNull();

    await toStep2('personal_loan');
    type('name', 'Wedding loan');
    escape();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    expect(modal().querySelector('.debt-wizard-confirm')?.textContent).toContain('Discard');
    // The close button asks too.
    modal().querySelector<HTMLElement>('.modal-close')!.click();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    // Keep editing returns to the form with values intact.
    modal().querySelector<HTMLElement>('[data-wizard="keep"]')!.click();
    expect(modal().querySelector('.debt-wizard-confirm')).toBeNull();
    expect(field('name').value).toBe('Wedding loan');
    escape();
    modal().querySelector<HTMLElement>('[data-wizard="discard"]')!.click();
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('closes without asking when only a type was chosen', () => {
    openDebtWizard({});
    choose('mortgage');
    escape();
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('is a sheet with a footer outside the scrolling body, and phone-friendly inputs', async () => {
    await toStep2('mortgage');
    const content = modal().querySelector('.modal-content')!;
    expect(modal().classList.contains('modal-sheet')).toBe(true);
    expect(modal().classList.contains('debt-wizard-modal')).toBe(true);
    expect(modal().querySelector('.modal-footer[data-action]')).toBeNull();
    const footer = content.querySelector(':scope > .debt-wizard-footer')!;
    expect(footer).not.toBeNull();
    expect(footer.previousElementSibling?.classList.contains('modal-body')).toBe(true);
    expect(field('currentBalance').inputMode).toBe('decimal');
    expect(field('termMonths').inputMode).toBe('numeric');
    const css = readFileSync(resolve(__dirname, '../../style.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 768px\)[^]*\.debt-wizard-modal\.modal-sheet/);
    expect(css).toMatch(/\.debt-wizard-footer\s*\{[^}]*flex:\s*none/);
    expect(css).toMatch(/\.debt-wizard-type\s*\{[^}]*min-height:\s*(5\d|6\d)px/);
  });

  it('renders user text as text, never as markup', async () => {
    apiCallMock.mockImplementation(async () => [
      position({ name: '<b>Lake</b> house', account_name: '<i>Acct</i>' }),
    ]);
    await toStep2('mortgage');
    await flush();
    type('name', '<b>Mine</b>');
    expect(modal().querySelector('b')).toBeNull();
    expect(modal().querySelector('i')).toBeNull();
    const select = field<HTMLSelectElement>('homePositionId');
    expect(select.textContent).toContain('<b>Lake</b> house');
  });

  describe('mortgage home choice', () => {
    it('lists only real estate positions and defaults to picking one', async () => {
      await toStep2('mortgage');
      await flush();
      expect(apiCallMock).toHaveBeenCalledWith('/api/portfolio/positions');
      const select = field<HTMLSelectElement>('homePositionId');
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels.some((l) => l?.includes('Lake house'))).toBe(true);
      expect(labels.some((l) => l?.includes('Apple'))).toBe(false);
      expect(modal().querySelector<HTMLInputElement>('[data-home-mode="pick"]')!.checked).toBe(
        true
      );
    });

    it('hands a tracked home to the conversion dialog without sending anything', async () => {
      const onConvertHome = vi.fn();
      openDebtWizard({ onConvertHome });
      choose('mortgage');
      next().click();
      await flush();
      expect(modal().textContent).toContain('Already tracking this home? Pick it');
      const handoff = modal().querySelector<HTMLButtonElement>('[data-wizard="convert-home"]')!;
      expect(handoff).not.toBeNull();
      expect(onConvertHome).not.toHaveBeenCalled();
      handoff.click();
      expect(onConvertHome).toHaveBeenCalledWith('pos1');
      expect(document.getElementById('dynamic-modal')).toBeNull();
      const methods = apiCallMock.mock.calls.map(
        (c) => (c[1] as { method?: string } | undefined)?.method ?? 'GET'
      );
      expect(methods.every((m) => m === 'GET')).toBe(true);
    });

    it('only offers the hand-off while a home is picked', async () => {
      const onConvertHome = vi.fn();
      openDebtWizard({ onConvertHome });
      choose('mortgage');
      next().click();
      await flush();
      modal().querySelector<HTMLInputElement>('[data-home-mode="skip"]')!.click();
      modal()
        .querySelector<HTMLInputElement>('[data-home-mode="skip"]')!
        .dispatchEvent(new Event('change', { bubbles: true }));
      expect(modal().querySelector('[data-wizard="convert-home"]')).toBeNull();
    });

    it('defaults to adding a home when none is tracked', async () => {
      apiCallMock.mockResolvedValue([]);
      await toStep2('mortgage');
      await flush();
      expect(modal().querySelector<HTMLInputElement>('[data-home-mode="add"]')!.checked).toBe(true);
      expect(modal().querySelector<HTMLInputElement>('[data-home-mode="pick"]')!.disabled).toBe(
        true
      );
      expect(field('homeName')).not.toBeNull();
      expect(field('homeValue')).not.toBeNull();
    });

    it('still works when positions cannot be loaded', async () => {
      apiCallMock.mockRejectedValue(new Error('down'));
      await toStep2('mortgage');
      await flush();
      expect(modal().querySelector<HTMLInputElement>('[data-home-mode="add"]')!.checked).toBe(true);
      expect(modal().querySelector('[data-home-mode="skip"]')).not.toBeNull();
    });

    it('other types have no home section', async () => {
      await toStep2('auto_loan');
      expect(modal().querySelector('[data-home-mode]')).toBeNull();
      expect(apiCallMock).not.toHaveBeenCalled();
    });

    it('requires a home name and value in add mode', async () => {
      const onDetails = vi.fn();
      apiCallMock.mockResolvedValue([]);
      await toStep2('mortgage', onDetails);
      await flush();
      type('name', 'Home loan');
      type('currentBalance', '300000');
      next().click();
      expect(onDetails).not.toHaveBeenCalled();
      expect(modal().querySelector('#debt-error-homeName')).not.toBeNull();
      expect(modal().querySelector('#debt-error-homeValue')).not.toBeNull();
      type('homeName', 'Main house');
      type('homeValue', '450,000');
      next().click();
      expect(onDetails).toHaveBeenCalledTimes(1);
      const state = onDetails.mock.calls[0]![0] as WizardState;
      expect(state.home).toMatchObject({ mode: 'add', name: 'Main house', value: '450,000' });
      expect(state.draft.name).toBe('Home loan');
      expect(state.draft.linkedPositionId).toBe('');
    });

    it('links the picked position and skip sends no home', async () => {
      const onDetails = vi.fn();
      await toStep2('mortgage', onDetails);
      await flush();
      type('name', 'Home loan');
      type('currentBalance', '300000');
      next().click();
      let state = onDetails.mock.calls[0]![0] as WizardState;
      expect(state.home.mode).toBe('pick');
      expect(state.draft.linkedPositionId).toBe('pos1');

      back().click();
      modal().querySelector<HTMLInputElement>('[data-home-mode="skip"]')!.click();
      next().click();
      state = onDetails.mock.calls[1]![0] as WizardState;
      expect(state.home.mode).toBe('skip');
      expect(state.draft.linkedPositionId).toBe('');
    });

    it('Back and forward keep the home entries', async () => {
      apiCallMock.mockResolvedValue([]);
      await toStep2('mortgage');
      await flush();
      type('homeName', 'Main house');
      type('homeValue', '450000');
      back().click();
      next().click();
      await flush();
      expect(field('homeName').value).toBe('Main house');
      expect(field('homeValue').value).toBe('450000');
    });
  });

  it('shows field errors on Next and does not advance', async () => {
    const onDetails = vi.fn();
    await toStep2('auto_loan', onDetails);
    next().click();
    expect(onDetails).not.toHaveBeenCalled();
    expect(modal().querySelector('.debt-field-error')?.textContent).toBe('Enter a name');
    expect(modal().querySelector('.debt-wizard-progress')?.textContent).toBe('Step 2 of 4');
  });

  it('hands valid details on with the raw draft', async () => {
    const onDetails = vi.fn();
    await toStep2('auto_loan', onDetails);
    type('name', 'Truck');
    type('currentBalance', '20000');
    next().click();
    const state = onDetails.mock.calls[0]![0] as WizardState;
    expect(state.draft).toMatchObject({ liabilityType: 'auto_loan', name: 'Truck' });
    expect(state.draft.paymentAmount).toBe('');
  });

  it('still asks on Escape after Back to step 1 with data retained', async () => {
    await toStep2('personal_loan');
    type('name', 'Wedding loan');
    back().click();
    escape();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    expect(modal().querySelector('.debt-wizard-confirm')).not.toBeNull();
  });

  it('swallows Escape while the discard prompt is showing', async () => {
    await toStep2('personal_loan');
    type('name', 'Wedding loan');
    escape();
    escape();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    expect(modal().querySelector('.debt-wizard-confirm')).not.toBeNull();
  });

  it('keeps Tab inside the dialog while the discard prompt is showing', async () => {
    await toStep2('personal_loan');
    type('name', 'Wedding loan');
    escape();
    modal().querySelector<HTMLElement>('[data-wizard="discard"]')!.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(modal().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(modal().querySelector('[data-wizard="discard"]'));
  });

  it('returns a close() that closes without asking and detaches its listener', async () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    const { modal: m, close } = openDebtWizard({});
    choose('mortgage');
    next().click();
    await flush();
    type('name', 'Entered data');
    close();
    expect(m.isConnected).toBe(false);
    expect(spy.mock.calls.some(([t]) => t === 'keydown')).toBe(true);
    spy.mockRestore();
  });

  it('removes its keydown listener when the modal is closed by something else', async () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    openDebtWizard({});
    closeDynamicModal();
    await flush();
    expect(spy.mock.calls.some(([t]) => t === 'keydown')).toBe(true);
    spy.mockRestore();
  });

  it('does not flip from add to pick once a home name or value is typed', async () => {
    let resolve!: (v: PositionResponse[]) => void;
    apiCallMock.mockImplementation(
      () => new Promise<PositionResponse[]>((r) => (resolve = r)) as never
    );
    await toStep2('mortgage');
    type('homeName', 'My house');
    resolve([position({})]);
    await flush();
    expect(modal().querySelector<HTMLInputElement>('[data-home-mode="add"]')!.checked).toBe(true);
    expect(field('homeName').value).toBe('My house');
  });

  it('offers Retry when homes cannot be loaded', async () => {
    apiCallMock.mockRejectedValueOnce(new Error('down'));
    await toStep2('mortgage');
    await flush();
    expect(modal().querySelector('.debt-wizard-home')?.textContent).toContain(
      'Couldn\u2019t load your homes'
    );
    apiCallMock.mockResolvedValue([position({})]);
    modal().querySelector<HTMLElement>('[data-wizard="retry-homes"]')!.click();
    await flush();
    expect(modal().querySelector('[data-wizard="retry-homes"]')).toBeNull();
    expect(modal().querySelector<HTMLInputElement>('[data-home-mode="pick"]')!.checked).toBe(true);
  });

  it('Enter in a details field advances like Next', async () => {
    const onDetails = vi.fn();
    await toStep2('auto_loan', onDetails);
    type('name', 'Truck');
    type('currentBalance', '20000');
    field('name').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  it('accepts an onConvertHome option for the conversion handoff', () => {
    expect(() => openDebtWizard({ onConvertHome: () => undefined })).not.toThrow();
  });

  it('source files contain no em-dash', () => {
    const src = readFileSync(resolve(__dirname, '../../src/features/debt-wizard.ts'), 'utf8');
    expect(src).not.toContain(String.fromCharCode(0x2014));
    const css = readFileSync(resolve(__dirname, '../../style.css'), 'utf8');
    // The stylesheet has older em-dashes in comments; check only this feature's block.
    expect(css.split('/* Debt wizard')[1]).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('debt wizard review and save', () => {
  const expense = (id: string, name: string, monthly: number) => ({
    id,
    name,
    amount: monthly,
    monthly_amount: monthly,
    frequency: 'monthly',
    is_active: true,
  });
  let expenses: ReturnType<typeof expense>[];
  let posts: { url: string; body: Record<string, unknown> }[];
  let postResult: () => Promise<unknown>;

  beforeEach(() => {
    document.body.innerHTML = '';
    expenses = [expense('e1', 'Groceries', 900)];
    posts = [];
    postResult = async () => ({ id: 'new1', name: 'Home loan' });
    apiCallMock.mockReset();
    apiCallMock.mockImplementation(
      async (url: string, opts?: { method?: string; body?: unknown }) => {
        if (opts?.method === 'POST') {
          posts.push({ url, body: opts.body as Record<string, unknown> });
          return postResult();
        }
        if (url === '/api/portfolio/positions') return [position({})];
        if (url === '/api/budget/expenses') return expenses;
        if (url === '/api/liabilities') return [];
        return {};
      }
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  });
  afterEach(() => {
    closeDynamicModal();
    vi.useRealTimers();
  });

  const saveBtn = (): HTMLButtonElement => modal().querySelector('[data-wizard="save"]')!;
  const cash = (mode: string): HTMLInputElement =>
    modal().querySelector<HTMLInputElement>(`[data-cash-mode="${mode}"]`)!;
  const progress = (): string => modal().querySelector('.debt-wizard-progress')?.textContent ?? '';

  async function toReview(
    t: LiabilityType,
    values: Record<string, string>,
    prep?: () => void
  ): Promise<void> {
    await toStep2(t);
    await flush();
    prep?.();
    for (const [k, v] of Object.entries(values)) type(k, v);
    next().click();
    await flush();
    await flush();
  }

  it('shows payoff, payments left, interest and this year from the shared math', async () => {
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(progress()).toBe('Step 3 of 4');
    expect(document.activeElement).toBe(heading());
    const text = modal().querySelector('.debt-review')!.textContent!;
    expect(text).toContain('Payoff date');
    expect(text).toContain('Payments left');
    expect(text).toContain('Total interest left');
    expect(text).toContain('Rest of this year');
    expect(text).toContain('$396.03');
    expect(saveBtn().disabled).toBe(false);
    expect(modal().querySelector('.debt-review-spark svg')).not.toBeNull();
  });

  it('blocks Save when the payment never pays the debt off', async () => {
    await toReview(
      'mortgage',
      {
        name: 'Home loan',
        currentBalance: '300000',
        aprPercent: '6.5',
        paymentAmount: '1000',
        homeName: 'House',
        homeValue: '400000',
      },
      () => {
        modal().querySelector<HTMLInputElement>('[data-home-mode="add"]')!.click();
      }
    );
    expect(modal().querySelector('.debt-review-warning')?.textContent).toContain('never pays off');
    expect(saveBtn().disabled).toBe(true);
    saveBtn().click();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it('defaults cash flow to linking an expense found by name, else by amount, else create', async () => {
    expenses = [expense('e1', 'Groceries', 900), expense('e2', 'Car Payment #1', 400)];
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(cash('link').checked).toBe(true);
    expect(field<HTMLSelectElement>('cashExpenseId').value).toBe('e2');
    closeDynamicModal();

    expenses = [expense('e1', 'Groceries', 900)];
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(cash('create').checked).toBe(true);
  });

  it('defaults a credit card paid in full to no cash flow entry', async () => {
    await toReview('credit_card', { name: 'Visa', currentBalance: '900' });
    const paid = modal().querySelector<HTMLInputElement>('[data-wizard="paid-in-full"]')!;
    expect(paid.checked).toBe(true);
    saveBtn().click();
    await flush();
    expect(posts[0]!.body.cash_flow).toEqual({ mode: 'none' });
  });

  it('saves once with source wizard, a new home and a linked expense', async () => {
    expenses = [expense('e2', 'Mortgage', 2000)];
    apiCallMock.mockImplementation(
      async (url: string, opts?: { method?: string; body?: unknown }) => {
        if (opts?.method === 'POST') {
          posts.push({ url, body: opts.body as Record<string, unknown> });
          return { id: 'new1', name: 'Home loan' };
        }
        if (url === '/api/portfolio/positions') return [];
        if (url === '/api/budget/expenses') return expenses;
        return [];
      }
    );
    const changed = vi.fn();
    const off = on('liabilities:changed', changed);
    const onSaved = vi.fn();
    openDebtWizard({ onSaved });
    choose('mortgage');
    next().click();
    await flush();
    await flush();
    type('name', 'Home loan');
    type('currentBalance', '300000');
    type('aprPercent', '6.5');
    type('homeName', 'Main house');
    type('homeValue', '450,000');
    type('homePurchasePrice', '400000');
    type('homePurchaseDate', '2019-05-01');
    next().click();
    await flush();
    await flush();
    expect(cash('link').checked).toBe(true);
    saveBtn().click();
    saveBtn().click();
    await flush();
    await flush();
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body;
    expect(posts[0]!.url).toBe('/api/liabilities');
    expect(body).toMatchObject({
      name: 'Home loan',
      liability_type: 'mortgage',
      current_balance: 300000,
      interest_rate: 0.065,
      payment_amount: 1896.21,
      source: 'wizard',
      property: {
        mode: 'create',
        name: 'Main house',
        value: 450000,
        cost_basis: 400000,
        purchase_date: '2019-05-01',
      },
      cash_flow: { mode: 'link', expense_id: 'e2' },
    });
    expect(body.linked_position_id).toBeUndefined();
    expect(changed).toHaveBeenCalledWith({ type: 'liabilities:changed', reason: 'added' });
    expect(onSaved).toHaveBeenCalledTimes(1);
    off();
  });

  it('links a picked home through the property block', async () => {
    await toReview('mortgage', { name: 'Home loan', currentBalance: '300000', aprPercent: '6.5' });
    saveBtn().click();
    await flush();
    expect(posts[0]!.body.property).toEqual({ mode: 'link', position_id: 'pos1' });
    expect(posts[0]!.body.linked_position_id).toBeUndefined();
  });

  it('sends no property block when the home is skipped, and none for other types', async () => {
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    expect(posts[0]!.body.property).toBeUndefined();
  });

  it('shows a friendly message for a 409 and stays on review', async () => {
    postResult = async () => {
      throw new ApiError(409, 'raw server detail');
    };
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    await flush();
    expect(modal().querySelector('.debt-form-error')?.textContent).toContain('already linked');
    expect(modal().textContent).not.toContain('raw server detail');
    expect(progress()).toBe('Step 3 of 4');
    expect(saveBtn().disabled).toBe(false);
  });

  it('shows a friendly message for a 422', async () => {
    postResult = async () => {
      throw new ApiError(422, 'raw');
    };
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    await flush();
    expect(modal().querySelector('.debt-form-error')?.textContent).toContain('not accepted');
  });

  it('Back from review keeps the details', async () => {
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    back().click();
    expect(progress()).toBe('Step 2 of 4');
    expect(field('name').value).toBe('Truck');
    expect(field('currentBalance').value).toBe('20000');
  });

  it('success offers Add another debt and Done, and Escape no longer asks', async () => {
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    await flush();
    expect(progress()).toBe('Step 4 of 4');
    expect(document.activeElement).toBe(heading());
    expect(modal().textContent).toContain('Debt added');
    modal().querySelector<HTMLElement>('[data-wizard="another"]')!.click();
    expect(progress()).toBe('Step 1 of 4');
    expect(modal().querySelector<HTMLInputElement>('[data-debt-type]:checked')).toBeNull();
    expect(next().disabled).toBe(true);
    // Fresh state: nothing carried over.
    choose('auto_loan');
    next().click();
    await flush();
    expect(field('name').value).toBe('');
  });

  it('Done closes without a prompt after saving', async () => {
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    await flush();
    escape();
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('shows 360 payments left for a 360-month loan, and the home and escrow lines', async () => {
    await toReview('mortgage', {
      name: 'Home loan',
      currentBalance: '300000',
      aprPercent: '6.5',
      escrowAmount: '500',
    });
    const text = modal().querySelector('.debt-review')!.textContent!;
    expect(text).toContain('Payments left360');
    expect(text).toContain('Links home: Lake house');
    expect(text).toContain('Escrow$500.00 per month');
  });

  it('shows the added home on review', async () => {
    apiCallMock.mockImplementation(async (url: string) =>
      url === '/api/budget/expenses' ? [] : url === '/api/portfolio/positions' ? [] : []
    );
    await toStep2('mortgage');
    await flush();
    type('homeName', 'Main house');
    type('homeValue', '450000');
    type('name', 'Loan');
    type('currentBalance', '300000');
    next().click();
    await flush();
    expect(modal().querySelector('.debt-review')!.textContent).toContain(
      'Adds home: Main house, $450,000.00'
    );
  });

  it('explains a disabled link choice and ties it to the radio', async () => {
    expenses = [];
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(cash('link').disabled).toBe(true);
    const hint = modal().querySelector('#debt-cash-link-hint')!;
    expect(hint.textContent).toBe('No unlinked expenses yet');
    expect(cash('link').getAttribute('aria-describedby')).toBe('debt-cash-link-hint');
  });

  it('compares the chosen expense with the payment', async () => {
    expenses = [expense('e2', 'Car Payment #1', 400)];
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(modal().textContent).toContain('Expense $400.00 a month vs payment $396.03');
  });

  it('keeps Save blocked after Escape, Keep editing re-renders the footer', async () => {
    await toReview('mortgage', {
      name: 'Home loan',
      currentBalance: '300000',
      aprPercent: '6.5',
      paymentAmount: '1000',
    });
    expect(saveBtn().disabled).toBe(true);
    escape();
    modal().querySelector<HTMLElement>('[data-wizard="keep"]')!.click();
    expect(saveBtn().disabled).toBe(true);
    saveBtn().disabled = false;
    saveBtn().click();
    await flush();
    expect(posts).toHaveLength(0);
  });

  it('emits liabilities:changed once on success and never on 409 or 422', async () => {
    const changed = vi.fn();
    const off = on('liabilities:changed', changed);
    for (const status of [409, 422]) {
      postResult = async () => {
        throw new ApiError(status, 'x');
      };
      await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
      saveBtn().click();
      await flush();
      await flush();
      closeDynamicModal();
    }
    expect(changed).not.toHaveBeenCalled();
    postResult = async () => ({ id: 'n', name: 'Truck' });
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    saveBtn().click();
    await flush();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  it('a throwing onSaved does not turn a saved debt into a failed save', async () => {
    const onSaved = vi.fn().mockRejectedValue(new Error('boom'));
    openDebtWizard({ onSaved });
    choose('auto_loan');
    next().click();
    await flush();
    type('name', 'Truck');
    type('currentBalance', '20000');
    next().click();
    await flush();
    await flush();
    saveBtn().click();
    await flush();
    await flush();
    expect(progress()).toBe('Step 4 of 4');
    expect(modal().querySelector('.debt-form-error')).toBeNull();
  });

  it('after a 409 it reloads the expense list and offers fresh choices', async () => {
    expenses = [expense('e2', 'Car Payment #1', 400)];
    postResult = async () => {
      throw new ApiError(409, 'x');
    };
    await toReview('auto_loan', { name: 'Truck', currentBalance: '20000', aprPercent: '7' });
    expect(cash('link').checked).toBe(true);
    expenses = [];
    saveBtn().click();
    await flush();
    await flush();
    await flush();
    expect(modal().querySelector('.debt-form-error')).not.toBeNull();
    expect(cash('link').disabled).toBe(true);
    expect(cash('create').checked).toBe(true);
  });

  it('renders expense names as text', async () => {
    expenses = [expense('e2', '<b>Mortgage</b>', 3000)];
    await toReview('mortgage', { name: 'Home loan', currentBalance: '300000', aprPercent: '6.5' });
    expect(modal().querySelector('b')).toBeNull();
  });
});
