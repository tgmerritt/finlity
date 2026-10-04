/**
 * Tests for the plain add/edit debt form (src/features/debt-form.ts).
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
import { closeDynamicModal } from '@/ui/modal';
import { openDebtForm, debtErrorMessage, draftFromDebt } from '@/features/debt-form';
import type { LiabilityResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function debt(over: Partial<LiabilityResponse> = {}): LiabilityResponse {
  return {
    id: 'd1',
    entity_id: 'p1',
    name: 'Home mortgage',
    liability_type: 'mortgage',
    lender: 'First Bank',
    current_balance: 300000,
    balance_as_of: '2026-10-01',
    interest_rate: 0.0625,
    payment_amount: 2000,
    payment_frequency: 'monthly',
    next_payment_date: '2026-11-01',
    escrow_amount: 400,
    original_principal: 400000,
    origination_date: '2020-01-01T00:00:00',
    term_months: 360,
    maturity_date: '2050-01-01',
    credit_limit: null,
    is_amortizing: true,
    linked_position_id: 'pos1',
    expense_id: 'e1',
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
    monthly_cash_flow: 2400,
    linked_position: null,
    linked_position_missing: false,
    expense: null,
    expense_missing: false,
    last_reported_date: '2026-10-01',
    ...over,
  };
}

const modal = (): HTMLElement => document.getElementById('dynamic-modal')!;
const field = <T extends HTMLElement = HTMLInputElement>(key: string): T =>
  modal().querySelector<T>(`[data-debt-field="${key}"]`)!;
function type(key: string, value: string): void {
  const el = field(key);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
const save = (): HTMLButtonElement => modal().querySelector('[data-action="save"]')!;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('debt form', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    apiCallMock.mockReset();
    apiCallMock.mockResolvedValue(debt());
  });
  afterEach(() => closeDynamicModal());

  it('creates a debt, converting the APR percent to a decimal', async () => {
    const onSaved = vi.fn();
    openDebtForm({ onSaved });
    expect(modal().querySelector('h2')?.textContent).toBe('Add a debt');
    type('name', 'Car loan');
    type('currentBalance', '12,500');
    type('aprPercent', '6.25');
    type('termMonths', '60');
    save().click();
    await flush();
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    const [url, opts] = apiCallMock.mock.calls[0]!;
    expect(url).toBe('/api/liabilities');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toMatchObject({
      name: 'Car loan',
      current_balance: 12500,
      interest_rate: 0.0625,
      term_months: 60,
      source: 'manual',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('shows field errors and sends nothing when the draft is invalid', async () => {
    openDebtForm({});
    save().click();
    await flush();
    expect(apiCallMock).not.toHaveBeenCalled();
    expect(modal().querySelector('.debt-field-error')?.textContent).toBe('Enter a name');
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('name'));
  });

  it('prefills an edit from the debt and keeps entity and linked home on save', async () => {
    openDebtForm({
      debt: debt(),
      entities: [
        { id: 'p1', name: 'Pat', is_household: false } as never,
        { id: 'p2', name: 'Sam', is_household: false } as never,
      ],
    });
    expect(modal().querySelector('h2')?.textContent).toBe('Edit debt');
    expect(field('aprPercent').value).toBe('6.25');
    expect(field('entityId').value).toBe('p1');
    // Balance changes go through Update balance, not the edit form.
    expect(modal().querySelector('[data-debt-field="currentBalance"]')).toBeNull();
    // Dates arrive as datetimes from some paths: only the day is shown.
    expect(field('originationDate').value).toBe('2020-01-01');
    // Advanced fields are reachable under More details.
    expect(modal().querySelector('details.debt-form-more')).not.toBeNull();
    type('name', 'Home loan');
    save().click();
    await flush();
    const [url, opts] = apiCallMock.mock.calls[0]!;
    expect(url).toBe('/api/liabilities/d1');
    expect(opts?.method).toBe('PUT');
    expect(opts?.body).toMatchObject({
      name: 'Home loan',
      entity_id: 'p1',
      linked_position_id: 'pos1',
      interest_rate: 0.0625,
    });
  });

  it('keeps an owner that is not in the loaded people list', () => {
    openDebtForm({ debt: debt({ entity_id: 'gone' }), entities: [] });
    expect(field('entityId').value).toBe('gone');
  });

  it('draftFromDebt trims datetimes to days', () => {
    const d = draftFromDebt(debt({ maturity_date: '2050-01-01T00:00:00' }));
    expect(d.maturityDate).toBe('2050-01-01');
    expect(d.linkedPositionId).toBe('pos1');
  });

  it('switches fields when the type changes', () => {
    openDebtForm({});
    expect(modal().querySelector('[data-debt-field="termMonths"]')).not.toBeNull();
    type('liabilityType', 'credit_card');
    expect(modal().querySelector('[data-debt-field="creditLimit"]')).not.toBeNull();
    expect(modal().querySelector('[data-debt-field="termMonths"]')).toBeNull();
  });

  it('keeps typed values across a type change', () => {
    openDebtForm({});
    type('name', 'Visa');
    type('currentBalance', '900');
    type('liabilityType', 'credit_card');
    expect(field('name').value).toBe('Visa');
    expect(field('currentBalance').value).toBe('900');
  });

  it('shows a generic message for a 422 and never the server detail', async () => {
    apiCallMock.mockRejectedValue(new ApiError(422, 'secret detail balance=123 xyz'));
    openDebtForm({});
    type('name', 'Car');
    type('currentBalance', '100');
    save().click();
    await flush();
    const banner = modal().querySelector('.debt-form-error')!;
    expect(banner.textContent).toBeTruthy();
    expect(banner.textContent).not.toContain('secret');
    expect(banner.textContent).not.toContain('xyz');
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    expect(save().disabled).toBe(false);
  });

  it('maps status codes to friendly messages', () => {
    expect(debtErrorMessage(new ApiError(409, 'x'))).toContain('already linked');
    expect(debtErrorMessage(new ApiError(404, 'x'))).toContain('no longer exists');
    expect(debtErrorMessage(new ApiError(403, 'x'))).toContain('demo');
    expect(debtErrorMessage(new ApiError(422, 'Date cannot be in the future'))).not.toContain(
      'future'
    );
    expect(debtErrorMessage(new ApiError(500, 'boom'))).not.toContain('boom');
    expect(debtErrorMessage(new Error('weird'))).not.toContain('weird');
  });

  it('renders user text as text, never as markup', () => {
    openDebtForm({ debt: debt({ name: '<img src=x onerror=alert(1)>', lender: '<b>Bank</b>' }) });
    expect(modal().querySelector('img')).toBeNull();
    expect(modal().querySelector('b')).toBeNull();
    expect(field('name').value).toBe('<img src=x onerror=alert(1)>');
  });

  it('source files contain no em-dash', () => {
    for (const rel of ['../../src/features/debt-form.ts', '../../src/pages/debts.ts']) {
      expect(readFileSync(resolve(__dirname, rel), 'utf8')).not.toContain(
        String.fromCharCode(0x2014)
      );
    }
  });
});
