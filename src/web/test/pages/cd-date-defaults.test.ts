/**
 * Tests for CD purchase-date / maturity-date defaults in the Add Position
 * modal: maturity auto-fills to purchase + 12 months unless the user has
 * hand-edited it, both dates default when the modal opens, and the CD
 * submit payload carries the purchase date.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  apiCall: vi.fn(),
}));

import { apiCall } from '@/api/client';
import {
  addMonthsClamped,
  showAddPositionModal,
  addManualPosition,
  initHoldings,
} from '@/pages/holdings';

const apiCallMock = vi.mocked(apiCall);

function addInput(id: string, type = 'text'): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  document.body.appendChild(input);
  return input;
}

function addSelect(id: string, values: string[]): HTMLSelectElement {
  const select = document.createElement('select');
  select.id = id;
  values.forEach((v) => {
    const option = document.createElement('option');
    option.value = v;
    select.appendChild(option);
  });
  document.body.appendChild(select);
  return select;
}

/** Builds the slice of the Add Position modal DOM these tests need. */
function buildModalDom(): {
  positionType: HTMLSelectElement;
  purchase: HTMLInputElement;
  maturity: HTMLInputElement;
} {
  const positionType = addSelect('position-type', ['equity', 'fund', 'cash', 'cd', 'real_estate']);
  const purchase = addInput('cd-purchase-date', 'date');
  const maturity = addInput('cd-maturity', 'date');
  addInput('cd-name');
  addInput('cd-amount', 'number');
  addInput('cd-rate', 'number');
  return { positionType, purchase, maturity };
}

describe('addMonthsClamped', () => {
  it('adds twelve months to an ordinary date', () => {
    expect(addMonthsClamped('2026-08-03', 12)).toBe('2027-08-03');
  });

  it('clamps a leap day to the last day of the target month', () => {
    expect(addMonthsClamped('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('clamps month-end overflow instead of rolling into the next month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('handles year rollover from a late-year date', () => {
    expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('CD date defaults on modal open', () => {
  beforeEach(() => {
    document.body.textContent = '';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 3, 12, 0, 0)); // 2026-08-03 local
    apiCallMock.mockReset();
    apiCallMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults purchase date to today and maturity to today + 12 months', async () => {
    const { purchase, maturity } = buildModalDom();

    await showAddPositionModal();

    expect(purchase.value).toBe('2026-08-03');
    expect(maturity.value).toBe('2027-08-03');
  });

  it('re-arms auto-fill on each modal open', async () => {
    const { purchase, maturity } = buildModalDom();
    initHoldings();

    // Hand-edit maturity, which pins it for this modal session.
    maturity.value = '2026-12-31';
    maturity.dispatchEvent(new Event('input'));
    purchase.value = '2026-09-01';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2026-12-31');

    // Reopening the modal resets both dates and clears the hand-edit pin.
    await showAddPositionModal();
    expect(purchase.value).toBe('2026-08-03');
    expect(maturity.value).toBe('2027-08-03');

    purchase.value = '2026-10-01';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2027-10-01');
  });
});

describe('CD maturity auto-fill', () => {
  let purchase: HTMLInputElement;
  let maturity: HTMLInputElement;

  beforeEach(() => {
    document.body.textContent = '';
    ({ purchase, maturity } = buildModalDom());
    apiCallMock.mockReset();
    apiCallMock.mockResolvedValue([]);
    initHoldings();
  });

  it('follows the purchase date while maturity is untouched', () => {
    purchase.value = '2026-01-15';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2027-01-15');

    purchase.value = '2026-03-20';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2027-03-20');
  });

  it('stops following once the user hand-edits maturity', () => {
    purchase.value = '2026-01-15';
    purchase.dispatchEvent(new Event('change'));

    maturity.value = '2026-07-15';
    maturity.dispatchEvent(new Event('input'));

    purchase.value = '2026-02-01';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2026-07-15');
  });

  it('resumes following after the user clears maturity', () => {
    maturity.value = '2026-07-15';
    maturity.dispatchEvent(new Event('input'));

    maturity.value = '';
    maturity.dispatchEvent(new Event('input'));

    purchase.value = '2026-02-01';
    purchase.dispatchEvent(new Event('change'));
    expect(maturity.value).toBe('2027-02-01');
  });
});

describe('CD submit payload', () => {
  beforeEach(() => {
    document.body.textContent = '';
    apiCallMock.mockReset();
  });

  it('includes purchase_date when the field is set', async () => {
    const { positionType, purchase, maturity } = buildModalDom();
    positionType.value = 'cd';
    purchase.value = '2026-01-15';
    maturity.value = '2027-01-15';
    (document.getElementById('cd-name') as HTMLInputElement).value = 'Marcus 12-month CD';
    (document.getElementById('cd-amount') as HTMLInputElement).value = '10000';
    (document.getElementById('cd-rate') as HTMLInputElement).value = '4.5';

    const account = addSelect('position-account', ['acct-1']);
    account.value = 'acct-1';

    const form = document.createElement('form');
    document.body.appendChild(form);

    apiCallMock.mockResolvedValue({ id: 'pos-1' });

    await addManualPosition({
      preventDefault: () => {},
      target: form,
    } as unknown as Event);

    const cdCall = apiCallMock.mock.calls.find(
      ([url]) => url === '/api/portfolio/positions/cd'
    );
    expect(cdCall).toBeDefined();
    const body = (cdCall?.[1] as { body: Record<string, unknown> }).body;
    expect(body.purchase_date).toBe('2026-01-15');
    expect(body.maturity_date).toBe('2027-01-15');
    expect(body.interest_rate).toBeCloseTo(0.045);
  });
});
