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

import { apiCall } from '@/api/client';
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
    expect(
      modal().querySelector('[data-debt-type="auto_loan"]')?.getAttribute('aria-checked')
    ).toBe('true');
    expect(modal().querySelector('[data-debt-type="mortgage"]')?.getAttribute('aria-checked')).toBe(
      'false'
    );
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
    expect(computed()).toContain('$1,896.20');
    type('termMonths', '180');
    expect(computed()).toContain('$2,613.');
    type('currentBalance', '200000');
    expect(computed()).toContain('$1,742.');
  });

  it('keeps an overridden payment, and the Calculated note steps aside', async () => {
    await toStep2('auto_loan');
    type('currentBalance', '20000');
    type('aprPercent', '7');
    expect(computed()).toContain('$396.02');
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

  it('source files contain no em-dash', () => {
    const src = readFileSync(resolve(__dirname, '../../src/features/debt-wizard.ts'), 'utf8');
    expect(src).not.toContain(String.fromCharCode(0x2014));
    const css = readFileSync(resolve(__dirname, '../../style.css'), 'utf8');
    // The stylesheet has older em-dashes in comments; check only this feature's block.
    expect(css.split('/* Debt wizard')[1]).not.toContain(String.fromCharCode(0x2014));
  });
});
