/**
 * Tests for the conversion dialog and the undo prompt (src/features/debt-convert.ts).
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
import { on, _resetEventBus } from '@/state/events';
import { closeDynamicModal } from '@/ui/modal';
import { formatCurrency } from '@/utils/format';
import { openDebtConvert, openUndoConversion } from '@/features/debt-convert';
import type { LiabilityResponse, PositionResponse } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);

function position(over: Partial<PositionResponse> = {}): PositionResponse {
  return {
    id: 'pos1',
    account_id: 'acc1',
    account_name: 'Brokerage',
    ticker: 'RE',
    name: 'Home',
    shares: 1,
    current_price: 612000,
    cost_basis: 400000,
    market_value: 612000,
    gain_loss: 212000,
    gain_loss_pct: 53,
    is_fund: false,
    asset_class: 'alternatives',
    position_type: 'real_estate',
    ...over,
  } as PositionResponse;
}

const SUMMARY = {
  summary: { total_value: 1430000, liabilities_total: 0, net_worth: 1430000 },
};

const LIABILITY = { id: 'liab1', name: 'Mortgage' } as LiabilityResponse;

const modal = (): HTMLElement => document.getElementById('dynamic-modal')!;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const btn = (name: string): HTMLButtonElement =>
  modal().querySelector<HTMLButtonElement>(`[data-convert="${name}"]`)!;
const input = (key: string): HTMLInputElement =>
  modal().querySelector<HTMLInputElement>(`[data-convert-field="${key}"]`)!;
const field = (key: string): HTMLInputElement =>
  modal().querySelector<HTMLInputElement>(`[data-debt-field="${key}"]`)!;
const heading = (): string => modal().querySelector('.debt-convert-heading')?.textContent ?? '';
const changes = (): string[] =>
  Array.from(modal().querySelectorAll('.debt-convert-changes li')).map((li) => li.textContent!);
const effect = (label: string): string => {
  const rows = Array.from(modal().querySelectorAll('.debt-convert-effect .debt-review-row'));
  const row = rows.find((r) => r.querySelector('dt')?.textContent === label);
  return row?.querySelector('dd')?.textContent ?? '';
};

function set(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function pickMode(mode: string): void {
  const radio = modal().querySelector<HTMLInputElement>(`[data-convert-mode="${mode}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}
const posts = (): unknown[][] =>
  apiCallMock.mock.calls.filter(
    (c) => (c[1] as { method?: string } | undefined)?.method === 'POST'
  );

let pos: PositionResponse;
let expenses: unknown[];

beforeEach(() => {
  document.body.innerHTML = '';
  _resetEventBus();
  pos = position();
  expenses = [];
  apiCallMock.mockReset();
  apiCallMock.mockImplementation(async (url: string, options?: { method?: string }) => {
    if (options?.method === 'POST') {
      if (url === '/api/liabilities/convert-position') {
        return { liability: LIABILITY, position: null, created: {} };
      }
      return { reverted: true };
    }
    if (url === '/api/portfolio/positions') return [pos];
    if (url === '/api/dashboard/data') return SUMMARY;
    if (url === '/api/budget/expenses') return expenses;
    if (url === '/api/liabilities') return [];
    return {};
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
});
afterEach(() => {
  closeDynamicModal();
  vi.useRealTimers();
});

async function open(): Promise<void> {
  openDebtConvert('pos1', {});
  await vi.advanceTimersByTimeAsync(0);
  await flush();
}

/** Step 1 to the confirm screen for the given mode, with typical values. */
async function toConfirm(mode: 'property_value' | 'equity' | 'loan'): Promise<void> {
  await open();
  pickMode(mode);
  if (mode === 'equity') set(input('balance'), '248000');
  btn('next').click();
  await flush();
  if (mode === 'property_value') set(field('currentBalance'), '248000');
  set(field('paymentAmount'), '1980');
  btn('next').click();
  await flush();
}

describe('conversion dialog: the question', () => {
  it('asks what the row represents, with its name and value, and offers three choices', async () => {
    await open();
    expect(heading()).toBe(`What does Home (${formatCurrency(612000)}) represent?`);
    const radios = modal().querySelectorAll<HTMLInputElement>(
      'input[type="radio"][data-convert-mode]'
    );
    expect(Array.from(radios).map((r) => r.getAttribute('data-convert-mode'))).toEqual([
      'property_value',
      'equity',
      'loan',
    ]);
    radios.forEach((r) => expect(r.closest('label')).not.toBeNull());
    expect(new Set(Array.from(radios).map((r) => r.name)).size).toBe(1);
    expect(btn('next').disabled).toBe(true);
    pickMode('equity');
    expect(btn('next').disabled).toBe(false);
  });

  it('renders every name as text, never as markup', async () => {
    pos = position({ name: '<img src=x onerror=alert(1)>', account_name: '<b>x</b>' });
    await open();
    expect(modal().querySelector('img')).toBeNull();
    expect(modal().querySelector('b')).toBeNull();
    expect(heading()).toContain('<img src=x onerror=alert(1)>');
  });

  it('says so when the position cannot be found', async () => {
    apiCallMock.mockImplementation(async () => []);
    openDebtConvert('missing', {});
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(modal().textContent).toContain('could not be found');
    expect(posts()).toHaveLength(0);
  });

  it('prefills equity mode so home value minus loan adds up to the current value', async () => {
    await open();
    pickMode('equity');
    expect(input('homeValue').value).toBe('612000');
    expect(input('balance').value).toBe('');
    set(input('balance'), '248000');
    expect(input('homeValue').value).toBe('860000');
    // Once the person types a home value, the balance no longer moves it.
    set(input('homeValue'), '900000');
    set(input('balance'), '100000');
    expect(input('homeValue').value).toBe('900000');
  });

  it('prefills loan mode with the absolute value of the row', async () => {
    pos = position({ market_value: -248000, current_price: -248000 });
    await open();
    pickMode('loan');
    expect(input('balance').value).toBe('248000');
  });

  it('validates the equity amounts before moving on', async () => {
    await open();
    pickMode('equity');
    btn('next').click();
    expect(modal().querySelector('.debt-field-error')).not.toBeNull();
    expect(heading()).toContain('represent');
  });
});

describe('conversion dialog: nothing is sent before Confirm', () => {
  it('only reads while the person answers and reviews', async () => {
    await toConfirm('equity');
    expect(btn('confirm').textContent).toBe('Convert to mortgage');
    expect(posts()).toHaveLength(0);
    for (const call of apiCallMock.mock.calls) {
      const method = (call[1] as { method?: string } | undefined)?.method;
      expect(method === undefined || method === 'GET').toBe(true);
    }
  });

  it('closing from the confirm screen sends nothing', async () => {
    await toConfirm('loan');
    modal().querySelector<HTMLElement>('.modal-close')!.click();
    expect(posts()).toHaveLength(0);
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('Back keeps what was typed', async () => {
    await toConfirm('equity');
    btn('back').click();
    expect(field('paymentAmount').value).toBe('1980');
    btn('back').click();
    expect(input('balance').value).toBe('248000');
    expect(input('homeValue').value).toBe('860000');
  });
});

describe('conversion dialog: the confirm screen', () => {
  it('equity: lists each change and the before and after totals', async () => {
    await toConfirm('equity');
    const list = changes();
    expect(list).toContain(`Home: value ${formatCurrency(612000)} to ${formatCurrency(860000)}`);
    expect(list).toContain(`New debt: Mortgage ${formatCurrency(248000)}`);
    expect(list.some((t) => t.startsWith('New expense: Mortgage'))).toBe(true);
    expect(effect('Portfolio value')).toBe(
      `${formatCurrency(1430000)} to ${formatCurrency(1678000)}`
    );
    expect(effect('Net worth')).toBe(`${formatCurrency(1430000)} (unchanged)`);
  });

  it('home value: the row stays and net worth drops by the loan', async () => {
    await toConfirm('property_value');
    expect(changes()).toContain(
      `Home: Home stays at ${formatCurrency(612000)}, linked to the new debt`
    );
    expect(changes()).toContain(`New debt: Mortgage ${formatCurrency(248000)}`);
    expect(effect('Portfolio value')).toBe(`${formatCurrency(1430000)} (unchanged)`);
    expect(effect('Net worth')).toBe(
      `${formatCurrency(1430000)} to ${formatCurrency(1430000 - 248000)}`
    );
  });

  it('loan: removes the position, and adding the home changes both totals', async () => {
    pos = position({ market_value: -248000, current_price: -248000, name: 'RE' });
    await open();
    pickMode('loan');
    input('addHome').checked = true;
    input('addHome').dispatchEvent(new Event('change', { bubbles: true }));
    set(input('newHomeName'), 'Lake house');
    set(input('newHomeValue'), '700000');
    btn('next').click();
    await flush();
    set(field('paymentAmount'), '1980');
    btn('next').click();
    await flush();
    const list = changes();
    expect(list).toContain('Removed position: RE');
    expect(list).toContain(`New debt: Mortgage ${formatCurrency(248000)}`);
    expect(list).toContain(`New home: Lake house ${formatCurrency(700000)}`);
    expect(effect('Portfolio value')).toBe(
      `${formatCurrency(1430000)} to ${formatCurrency(1430000 + 248000 + 700000)}`
    );
    expect(effect('Net worth')).toBe(
      `${formatCurrency(1430000)} to ${formatCurrency(1430000 + 700000)}`
    );
  });

  it('names an existing expense when the person links one', async () => {
    expenses = [
      {
        id: 'e1',
        name: 'Mortgage payment',
        monthly_amount: 1980,
        amount: 1980,
        frequency: 'monthly',
      },
    ];
    await toConfirm('equity');
    expect(changes().some((t) => t.includes('Linked expense: Mortgage payment'))).toBe(true);
  });
});

describe('conversion dialog: keyboard and early refusals', () => {
  const enter = (el: Element): void => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  };

  it('Enter on step 2 goes to the review, not back through step 1', async () => {
    await open();
    pickMode('equity');
    set(input('balance'), '248000');
    enter(input('balance'));
    expect(heading()).toBe('Mortgage details');
    set(field('paymentAmount'), '1980');
    enter(field('paymentAmount'));
    expect(heading()).toBe('Review the changes');
  });

  it('Back then Next twice does not stack Enter handlers', async () => {
    await open();
    pickMode('equity');
    set(input('balance'), '248000');
    for (let i = 0; i < 2; i++) {
      btn('next').click();
      btn('back').click();
    }
    btn('next').click();
    const renders = vi.spyOn(modal().querySelector('.debt-wizard-step')!, 'appendChild');
    enter(field('name'));
    // One Enter validates once and moves on a single step.
    expect(heading()).toBe('Review the changes');
    expect(renders.mock.calls.filter((c) => (c[0] as HTMLElement).tagName === 'H3')).toHaveLength(
      1
    );
  });

  it('explains why linking an expense is unavailable', async () => {
    await toConfirm('equity');
    const radio = modal().querySelector<HTMLInputElement>('[data-cash-mode="link"]')!;
    expect(radio.disabled).toBe(true);
    const hint = document.getElementById(radio.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('No unlinked expenses yet');
  });

  it('refuses up front when the position is already converted', async () => {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (url: string, o?: { method?: string }) =>
      url === '/api/liabilities'
        ? [{ id: 'l9', source: 'converted_position', source_ref: 'pos1' }]
        : base(url, o as never)
    );
    await open();
    expect(modal().textContent).toContain('This position is already converted');
    expect(modal().querySelector('[data-convert-mode]')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('refuses up front when a debt already links the position', async () => {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (url: string, o?: { method?: string }) =>
      url === '/api/liabilities'
        ? [{ id: 'l9', source: 'manual', linked_position_id: 'pos1' }]
        : base(url, o as never)
    );
    await open();
    expect(modal().textContent).toContain('This position is already linked to a debt');
    expect(modal().querySelector('[data-convert-mode]')).toBeNull();
  });
});

describe('conversion dialog: Confirm', () => {
  it('sends one POST with the contract body for equity and emits the change events', async () => {
    const seen: string[] = [];
    on('liabilities:changed', () => seen.push('liabilities'));
    let legacy = 0;
    document.addEventListener('holdings:positionUpdated', () => (legacy += 1));
    await toConfirm('equity');
    btn('confirm').click();
    await flush();
    expect(posts()).toHaveLength(1);
    const [url, options] = posts()[0]! as [string, { body: Record<string, unknown> }];
    expect(url).toBe('/api/liabilities/convert-position');
    const body = options.body as {
      mortgage: Record<string, unknown>;
      [k: string]: unknown;
    };
    expect(body).toMatchObject({
      position_id: 'pos1',
      mode: 'equity',
      home_value: 860000,
      cash_flow: { mode: 'create' },
    });
    expect(body).not.toHaveProperty('add_home');
    expect(body.mortgage).toMatchObject({
      name: 'Mortgage',
      current_balance: 248000,
      payment_amount: 1980,
      payment_frequency: 'monthly',
    });
    for (const banned of [
      'liability_type',
      'source',
      'linked_position_id',
      'is_amortizing',
      'credit_limit',
    ]) {
      expect(body.mortgage).not.toHaveProperty(banned);
    }
    expect(seen).toEqual(['liabilities']);
    expect(legacy).toBe(1);
    expect(modal().textContent).toContain('Converted');
  });

  it('property value mode sends no home_value, loan mode sends add_home', async () => {
    await toConfirm('property_value');
    btn('confirm').click();
    await flush();
    const first = posts()[0]![1] as { body: Record<string, unknown> };
    expect(first.body).toMatchObject({ mode: 'property_value' });
    expect(first.body).not.toHaveProperty('home_value');
    expect(first.body).not.toHaveProperty('add_home');
    closeDynamicModal();

    apiCallMock.mockClear();
    pos = position({ market_value: -248000, current_price: -248000 });
    await open();
    pickMode('loan');
    input('addHome').checked = true;
    input('addHome').dispatchEvent(new Event('change', { bubbles: true }));
    set(input('newHomeName'), 'Lake house');
    set(input('newHomeValue'), '700000');
    btn('next').click();
    await flush();
    btn('next').click();
    await flush();
    btn('confirm').click();
    await flush();
    const second = posts()[0]![1] as { body: Record<string, unknown> };
    expect(second.body).toMatchObject({
      mode: 'loan',
      add_home: { name: 'Lake house', value: 700000 },
    });
    expect(second.body).not.toHaveProperty('home_value');
    expect(
      (second.body as { mortgage: { current_balance: number } }).mortgage.current_balance
    ).toBe(248000);
  });

  it.each([
    [409, 'This position is already converted'],
    [409, 'This position has tax lots and cannot be converted to a loan'],
    [404, 'Position not found'],
  ])('shows the fixed message for %i and changes nothing', async (status, message) => {
    const seen: string[] = [];
    on('liabilities:changed', () => seen.push('x'));
    await toConfirm('equity');
    apiCallMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw new ApiError(status, message);
      return [];
    });
    btn('confirm').click();
    await flush();
    expect(modal().querySelector('.debt-form-error')?.textContent).toBe(message);
    expect(btn('confirm')).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it('shows a generic message for 422 and never the server detail', async () => {
    await toConfirm('equity');
    apiCallMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw new ApiError(422, 'body.mortgage.secret: bad');
      return [];
    });
    btn('confirm').click();
    await flush();
    const text = modal().querySelector('.debt-form-error')?.textContent ?? '';
    expect(text).not.toContain('secret');
    expect(text.length).toBeGreaterThan(10);
  });

  it('does not send twice when Confirm is pressed twice', async () => {
    await toConfirm('equity');
    btn('confirm').click();
    btn('confirm').click();
    await flush();
    expect(posts()).toHaveLength(1);
  });
});

describe('undo conversion', () => {
  const debt = { id: 'liab1', name: 'Mortgage' } as LiabilityResponse;

  it('asks first and sends nothing until the person confirms', () => {
    openUndoConversion(debt);
    expect(modal().textContent).toContain('Undo this conversion?');
    expect(posts()).toHaveLength(0);
    modal().querySelector<HTMLElement>('.modal-close')!.click();
    expect(posts()).toHaveLength(0);
  });

  it('calls revert once on confirm, emits the change events and reports done', async () => {
    const seen: string[] = [];
    on('liabilities:changed', (e) => seen.push(e.reason));
    let legacy = 0;
    document.addEventListener('holdings:positionUpdated', () => (legacy += 1));
    const done = vi.fn();
    openUndoConversion(debt, { onDone: done });
    modal().querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flush();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe('/api/liabilities/liab1/revert-conversion');
    expect(seen).toEqual(['deleted']);
    expect(legacy).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('shows the fixed message on 409 and changes nothing', async () => {
    const message = 'The property value changed after the conversion, so it cannot be undone';
    apiCallMock.mockImplementation(async () => {
      throw new ApiError(409, message);
    });
    const seen: string[] = [];
    on('liabilities:changed', () => seen.push('x'));
    const done = vi.fn();
    openUndoConversion(debt, { onDone: done });
    modal().querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flush();
    expect(modal().querySelector('.debt-form-error')?.textContent).toBe(message);
    expect(seen).toEqual([]);
    expect(done).not.toHaveBeenCalled();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
  });

  it('does not show an unknown 409 message', async () => {
    apiCallMock.mockImplementation(async () => {
      throw new ApiError(409, 'internal: row 17 of table x');
    });
    openUndoConversion(debt);
    modal().querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flush();
    expect(modal().querySelector('.debt-form-error')?.textContent).not.toContain('row 17');
  });
});

describe('source hygiene', () => {
  it('has no em-dash anywhere in the feature file', () => {
    const src = readFileSync(resolve(__dirname, '../../src/features/debt-convert.ts'), 'utf8');
    expect(src.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});
