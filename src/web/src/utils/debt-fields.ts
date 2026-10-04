/**
 * Field definitions, defaults and validation for adding and editing a debt.
 * Shared by the Debts page form and the wizard. Drafts hold the raw strings
 * from form inputs; APR is typed as a percent and sent as a decimal.
 */
import type {
  CreateLiabilityInput,
  LiabilityFrequency,
  LiabilityType,
  UpdateLiabilityInput,
} from '@/types/api';

export const DEBT_TYPES: readonly LiabilityType[] = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'credit_card',
  'personal_loan',
  'heloc',
  'other',
];

export const FREQUENCIES: readonly LiabilityFrequency[] = [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
];

export interface DebtDraft {
  liabilityType: LiabilityType;
  name: string;
  currentBalance: string;
  aprPercent: string;
  paymentAmount: string;
  paymentFrequency: LiabilityFrequency;
  nextPaymentDate: string;
  escrowAmount: string;
  creditLimit: string;
  termMonths: string;
  originalPrincipal: string;
  originationDate: string;
  maturityDate: string;
  lender: string;
  entityId: string;
  linkedPositionId: string;
  notes: string;
}

export type DebtFieldKey = Exclude<keyof DebtDraft, 'liabilityType'>;
export type DebtFieldKind = 'text' | 'money' | 'percent' | 'integer' | 'date' | 'select';

export interface DebtField {
  key: DebtFieldKey;
  label: string;
  kind: DebtFieldKind;
  required: boolean;
  /** Shown under "More details". */
  advanced: boolean;
  hint?: string;
}

const REVOLVING: ReadonlySet<LiabilityType> = new Set(['credit_card', 'heloc']);

const DEFAULT_TERM: Partial<Record<LiabilityType, string>> = {
  mortgage: '360',
  auto_loan: '60',
  student_loan: '120',
  personal_loan: '36',
};

const f = (
  key: DebtFieldKey,
  label: string,
  kind: DebtFieldKind,
  extra: Partial<Pick<DebtField, 'required' | 'advanced' | 'hint'>> = {}
): DebtField => ({ key, label, kind, required: false, advanced: false, ...extra });

/** Ordered fields for a debt type. Name and balance always come first. */
export function fieldsFor(type: LiabilityType): DebtField[] {
  const revolving = REVOLVING.has(type);
  const out: DebtField[] = [
    f('name', 'Name', 'text', { required: true }),
    f('currentBalance', 'Current balance', 'money', { required: true }),
    f('aprPercent', 'Interest rate (APR, %)', 'percent'),
    f(
      'paymentAmount',
      revolving ? 'Planned payment' : 'Payment',
      'money',
      revolving ? {} : { hint: 'Leave blank to calculate it from the term' }
    ),
    f('paymentFrequency', 'Payment frequency', 'select'),
    f('nextPaymentDate', 'Next payment date', 'date'),
  ];
  if (type === 'mortgage')
    out.push(f('escrowAmount', 'Escrow (taxes and insurance) per payment', 'money'));
  if (revolving) out.push(f('creditLimit', 'Credit limit', 'money'));
  else out.push(f('termMonths', 'Term (months)', 'integer'));
  out.push(
    f('originalPrincipal', 'Original amount', 'money', { advanced: true }),
    f('originationDate', 'Start date', 'date', { advanced: true }),
    f('maturityDate', 'Payoff date', 'date', { advanced: true }),
    f('lender', 'Lender', 'text', { advanced: true }),
    f('entityId', 'Owner', 'select', { advanced: true }),
    f('notes', 'Notes', 'text', { advanced: true })
  );
  return out;
}

export function defaultsFor(type: LiabilityType): DebtDraft {
  return {
    liabilityType: type,
    name: '',
    currentBalance: '',
    aprPercent: '',
    paymentAmount: '',
    paymentFrequency: 'monthly',
    nextPaymentDate: '',
    escrowAmount: '',
    creditLimit: '',
    termMonths: DEFAULT_TERM[type] ?? '',
    originalPrincipal: '',
    originationDate: '',
    maturityDate: '',
    lender: '',
    entityId: '',
    linkedPositionId: '',
    notes: '',
  };
}

/**
 * Change a draft's type: fields the new type does not offer are cleared (a
 * credit limit must not follow a card into an auto loan), and the term follows
 * the new type's default unless the user typed their own.
 */
export function switchType(draft: DebtDraft, type: LiabilityType): DebtDraft {
  const shown = new Set<string>(fieldsFor(type).map((x) => x.key));
  const blank = defaultsFor(type);
  const next: DebtDraft = { ...draft, liabilityType: type };
  for (const key of Object.keys(blank)) {
    if (key !== 'liabilityType' && key !== 'linkedPositionId' && !shown.has(key)) {
      Object.assign(next, { [key]: blank[key as DebtFieldKey] });
    }
  }
  if (shown.has('termMonths') && draft.termMonths === (DEFAULT_TERM[draft.liabilityType] ?? '')) {
    next.termMonths = blank.termMonths;
  }
  return next;
}

export interface ParsedDebt {
  name: string;
  currentBalance: number;
  /** Decimal (0.0625), or null when left blank. */
  interestRate: number | null;
  paymentAmount: number | null;
  escrowAmount: number | null;
  creditLimit: number | null;
  originalPrincipal: number | null;
  termMonths: number | null;
}

export interface DraftValidation {
  errors: Partial<Record<DebtFieldKey, string>>;
  /** Null when there are errors. */
  values: ParsedDebt | null;
}

const MAX_MONEY = 1e10;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written YYYY-MM-DD. */
function isRealDay(raw: string): boolean {
  if (!ISO_DAY.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

function num(raw: string): number {
  const t = raw.replace(/[$,\s]/g, '');
  return t === '' ? NaN : Number(t);
}

export function validateDraft(draft: DebtDraft): DraftValidation {
  const errors: DraftValidation['errors'] = {};
  const money = (key: DebtFieldKey, raw: string, required = false): number | null => {
    if (raw.trim() === '') {
      if (required) errors[key] = 'Enter an amount';
      return null;
    }
    const n = num(raw);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
      errors[key] = 'Enter an amount of zero or more';
      return null;
    }
    return n;
  };

  const name = draft.name.trim();
  if (!name) errors.name = 'Enter a name';
  else if (name.length > 120) errors.name = 'Use 120 characters or fewer';

  const currentBalance = money('currentBalance', draft.currentBalance, true);
  const paymentAmount = money('paymentAmount', draft.paymentAmount);
  const escrowAmount = money('escrowAmount', draft.escrowAmount);
  const creditLimit = money('creditLimit', draft.creditLimit);
  const originalPrincipal = money('originalPrincipal', draft.originalPrincipal);

  let interestRate: number | null = null;
  if (draft.aprPercent.trim() !== '') {
    const pct = num(draft.aprPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100)
      errors.aprPercent = 'Enter a rate from 0 to 100';
    else interestRate = Number((pct / 100).toFixed(6));
  }

  let termMonths: number | null = null;
  if (draft.termMonths.trim() !== '') {
    const t = num(draft.termMonths);
    if (!Number.isInteger(t) || t < 1 || t > 600)
      errors.termMonths = 'Enter a whole number from 1 to 600';
    else termMonths = t;
  }

  for (const key of ['nextPaymentDate', 'originationDate', 'maturityDate'] as const) {
    if (draft[key] && !isRealDay(draft[key])) errors[key] = 'Use the date format YYYY-MM-DD';
  }
  if (
    !errors.maturityDate &&
    !errors.originationDate &&
    draft.originationDate &&
    draft.maturityDate &&
    draft.maturityDate < draft.originationDate
  ) {
    errors.maturityDate = 'Payoff date must be on or after the start date';
  }

  if (Object.keys(errors).length > 0 || currentBalance === null) return { errors, values: null };
  return {
    errors,
    values: {
      name,
      currentBalance,
      interestRate,
      paymentAmount,
      escrowAmount,
      creditLimit,
      originalPrincipal,
      termMonths,
    },
  };
}

type Optionals = Pick<
  UpdateLiabilityInput,
  | 'lender'
  | 'interest_rate'
  | 'payment_amount'
  | 'next_payment_date'
  | 'escrow_amount'
  | 'original_principal'
  | 'origination_date'
  | 'term_months'
  | 'maturity_date'
  | 'credit_limit'
  | 'entity_id'
  | 'linked_position_id'
  | 'notes'
>;

/** Optional fields; blanks become null when `clear` is set (edits), else are omitted (creates). */
function optionals(draft: DebtDraft, v: ParsedDebt, clear: boolean): Optionals {
  const out: Record<string, string | number | null> = {};
  const shown = new Set<string>(fieldsFor(draft.liabilityType).map((x) => x.key));
  const put = (key: string, value: string | number | null, field?: DebtFieldKey): void => {
    // A field the type does not offer is treated as blank, whatever the draft holds.
    if (field && !shown.has(field)) value = null;
    if (value !== null && value !== '') out[key] = value;
    else if (clear) out[key] = null;
  };
  put('lender', draft.lender.trim());
  put('interest_rate', v.interestRate);
  put('payment_amount', v.paymentAmount);
  put('next_payment_date', draft.nextPaymentDate);
  put('escrow_amount', v.escrowAmount, 'escrowAmount');
  put('original_principal', v.originalPrincipal);
  put('origination_date', draft.originationDate);
  put('term_months', v.termMonths, 'termMonths');
  put('maturity_date', draft.maturityDate);
  put('credit_limit', v.creditLimit, 'creditLimit');
  put('entity_id', draft.entityId);
  put('linked_position_id', draft.linkedPositionId);
  put('notes', draft.notes.trim());
  return out;
}

/** API body for a new debt, or null when the draft is invalid. */
export function toCreateInput(draft: DebtDraft): CreateLiabilityInput | null {
  const { values } = validateDraft(draft);
  if (!values) return null;
  return {
    name: values.name,
    liability_type: draft.liabilityType,
    current_balance: values.currentBalance,
    payment_frequency: draft.paymentFrequency,
    source: 'manual',
    ...optionals(draft, values, false),
  };
}

/** API body for editing a debt (balances go through the record-balance call), or null when invalid. */
export function toUpdateInput(draft: DebtDraft): UpdateLiabilityInput | null {
  const { values } = validateDraft(draft);
  if (!values) return null;
  return {
    name: values.name,
    liability_type: draft.liabilityType,
    payment_frequency: draft.paymentFrequency,
    ...optionals(draft, values, true),
  };
}
