import { describe, it, expect } from 'vitest';
import {
  DEBT_TYPES,
  defaultsFor,
  fieldsFor,
  switchType,
  toCreateInput,
  toUpdateInput,
  validateDraft,
  type DebtDraft,
} from '@/utils/debt-fields';

const draft = (over: Partial<DebtDraft> = {}): DebtDraft => ({
  ...defaultsFor('mortgage'),
  name: 'Mortgage',
  currentBalance: '400,000',
  aprPercent: '6.25',
  ...over,
});

describe('fieldsFor', () => {
  it('always asks for name and balance first', () => {
    for (const t of DEBT_TYPES) {
      const keys = fieldsFor(t).map((f) => f.key);
      expect(keys.slice(0, 2)).toEqual(['name', 'currentBalance']);
    }
  });

  it('offers escrow only for mortgages and credit limit only for revolving credit', () => {
    const has = (t: Parameters<typeof fieldsFor>[0], k: string): boolean =>
      fieldsFor(t).some((f) => f.key === k);
    expect(has('mortgage', 'escrowAmount')).toBe(true);
    expect(has('auto_loan', 'escrowAmount')).toBe(false);
    expect(has('credit_card', 'creditLimit')).toBe(true);
    expect(has('heloc', 'creditLimit')).toBe(true);
    expect(has('auto_loan', 'creditLimit')).toBe(false);
    expect(has('credit_card', 'termMonths')).toBe(false);
  });

  it('keeps original principal, origination date, lender and owner under more details', () => {
    const adv = fieldsFor('auto_loan')
      .filter((f) => f.advanced)
      .map((f) => f.key);
    expect(adv).toEqual(
      expect.arrayContaining(['originalPrincipal', 'originationDate', 'lender', 'entityId'])
    );
  });

  it('marks the percent field so UI can label it', () => {
    expect(fieldsFor('mortgage').find((f) => f.key === 'aprPercent')!.kind).toBe('percent');
  });
});

describe('defaultsFor', () => {
  it('sets term and frequency by type', () => {
    expect(defaultsFor('mortgage')).toMatchObject({
      liabilityType: 'mortgage',
      termMonths: '360',
      paymentFrequency: 'monthly',
    });
    expect(defaultsFor('auto_loan').termMonths).toBe('60');
    expect(defaultsFor('credit_card').termMonths).toBe('');
  });
});

describe('validateDraft', () => {
  it('accepts a valid draft and returns APR as a decimal', () => {
    const r = validateDraft(draft());
    expect(r.errors).toEqual({});
    expect(r.values!.interestRate).toBeCloseTo(0.0625, 10);
    expect(r.values!.currentBalance).toBe(400000);
  });

  it('requires name and a non-negative balance', () => {
    const r = validateDraft(draft({ name: '  ', currentBalance: '' }));
    expect(r.values).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual(['currentBalance', 'name']);
    expect(validateDraft(draft({ currentBalance: '-5' })).errors.currentBalance).toBeTruthy();
  });

  it('rejects APR outside 0 to 100 percent and non-numeric text', () => {
    expect(validateDraft(draft({ aprPercent: '101' })).errors.aprPercent).toBeTruthy();
    expect(validateDraft(draft({ aprPercent: '-1' })).errors.aprPercent).toBeTruthy();
    expect(validateDraft(draft({ aprPercent: 'abc' })).errors.aprPercent).toBeTruthy();
    expect(validateDraft(draft({ aprPercent: '' })).errors).toEqual({});
  });

  it('validates term and date ordering', () => {
    expect(validateDraft(draft({ termMonths: '0' })).errors.termMonths).toBeTruthy();
    expect(validateDraft(draft({ termMonths: '601' })).errors.termMonths).toBeTruthy();
    expect(validateDraft(draft({ termMonths: '12.5' })).errors.termMonths).toBeTruthy();
    expect(
      validateDraft(draft({ originationDate: '2024-05-01', maturityDate: '2024-01-01' })).errors
        .maturityDate
    ).toBeTruthy();
    expect(
      validateDraft(draft({ originationDate: '05/01/2024' })).errors.originationDate
    ).toBeTruthy();
  });

  it('rejects dates that are not on the calendar', () => {
    expect(
      validateDraft(draft({ nextPaymentDate: '2026-13-45' })).errors.nextPaymentDate
    ).toBeTruthy();
    expect(
      validateDraft(draft({ originationDate: '2026-02-30' })).errors.originationDate
    ).toBeTruthy();
    expect(
      validateDraft(draft({ originationDate: '2024-02-29' })).errors.originationDate
    ).toBeUndefined();
  });

  it('rounds the APR decimal to 6 places', () => {
    expect(validateDraft(draft({ aprPercent: '6.1234567' })).values?.interestRate).toBe(0.061235);
    expect(validateDraft(draft({ aprPercent: '7.35' })).values?.interestRate).toBe(0.0735);
  });

  it('errors contain no em-dash', () => {
    const r = validateDraft(
      draft({ name: '', currentBalance: 'x', aprPercent: '500', termMonths: '0' })
    );
    expect(JSON.stringify(r.errors)).not.toContain('\u2014');
  });
});

describe('toCreateInput', () => {
  it('maps a draft to the API body with decimal APR and numbers', () => {
    const input = toCreateInput(
      draft({ paymentAmount: '2,500.50', escrowAmount: '600', lender: ' Rocket ', entityId: 'e1' })
    )!;
    expect(input).toMatchObject({
      name: 'Mortgage',
      liability_type: 'mortgage',
      current_balance: 400000,
      interest_rate: 0.0625,
      payment_amount: 2500.5,
      payment_frequency: 'monthly',
      escrow_amount: 600,
      term_months: 360,
      lender: 'Rocket',
      entity_id: 'e1',
      source: 'manual',
    });
  });

  it('omits blank optionals and returns null for an invalid draft', () => {
    const input = toCreateInput(draft({ aprPercent: '' }))!;
    expect('interest_rate' in input).toBe(false);
    expect('payment_amount' in input).toBe(false);
    expect(toCreateInput(draft({ name: '' }))).toBeNull();
  });
});

describe('toUpdateInput', () => {
  it('sends blank optionals as null so they can be cleared, and never the balance', () => {
    const input = toUpdateInput(draft({ lender: '', aprPercent: '4.9' }))!;
    expect(input.lender).toBeNull();
    expect(input.interest_rate).toBeCloseTo(0.049, 10);
    expect('current_balance' in input).toBe(false);
  });
});

describe('switchType', () => {
  it('drops fields the new type does not have and keeps shared ones', () => {
    const card = draft({
      liabilityType: 'credit_card',
      creditLimit: '15000',
      termMonths: '',
      name: 'Card',
    });
    const loan = switchType(card, 'auto_loan');
    expect(loan.liabilityType).toBe('auto_loan');
    expect(loan.creditLimit).toBe('');
    expect(loan.name).toBe('Card');
    expect(loan.termMonths).toBe('60');
    const back = switchType({ ...loan, termMonths: '48', escrowAmount: '200' }, 'credit_card');
    expect(back.termMonths).toBe('');
    expect(back.escrowAmount).toBe('');
  });

  it('keeps a term the user typed and escrow only for mortgages', () => {
    const d = switchType(draft({ liabilityType: 'auto_loan', termMonths: '48' }), 'personal_loan');
    expect(d.termMonths).toBe('48');
    expect(switchType(draft({ escrowAmount: '300' }), 'auto_loan').escrowAmount).toBe('');
  });

  it('does not let toCreateInput send fields of another type', () => {
    const d = { ...draft({ liabilityType: 'auto_loan' }), creditLimit: '9000' };
    expect(toCreateInput(d)).not.toHaveProperty('credit_limit');
  });
});
