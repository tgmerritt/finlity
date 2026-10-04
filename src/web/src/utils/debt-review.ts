/**
 * Pure figures for the wizard's review step: the payment that will be saved,
 * the payoff picture from the shared amortization math, and the cash flow
 * suggestion. No DOM, no network.
 */
import { firstDueAfter, periodsPerYear, schedule, summarize } from '@/utils/amortization';
import { computedPayment, validateAmounts, type DebtDraft } from '@/utils/debt-fields';
import type { Expense, LiabilityType } from '@/types/api';

export interface DebtReview {
  /** Payment per period that will be saved, or null when none is known. */
  payment: number | null;
  /** True when the payment came from the term (or interest-only), not from the person. */
  paymentCalculated: boolean;
  /** Payment plus escrow, per month. */
  monthlyCashFlow: number | null;
  /** A payoff projection exists (amortizing with a payment). */
  projected: boolean;
  neverPaysOff: boolean;
  payoffDate: string | null;
  paymentsLeft: number | null;
  totalInterestLeft: number | null;
  /** Principal and interest scheduled in the current calendar year. */
  yearPrincipal: number;
  yearInterest: number;
  /** Balance after each scheduled payment, thinned for a sparkline (starts at today's balance). */
  balances: number[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The payment per period to save: the typed one, else the term's, else a HELOC's interest-only one. */
export function effectivePayment(draft: DebtDraft): {
  payment: number | null;
  calculated: boolean;
} {
  const { values } = validateAmounts(draft);
  if (!values) return { payment: null, calculated: false };
  if (values.paymentAmount !== null && values.paymentAmount > 0) {
    return { payment: values.paymentAmount, calculated: false };
  }
  const fromTerm = computedPayment(draft);
  if (fromTerm !== null && fromTerm > 0) return { payment: fromTerm, calculated: true };
  if (draft.liabilityType === 'heloc' && values.currentBalance > 0 && values.interestRate) {
    const interestOnly = round2(
      (values.currentBalance * values.interestRate) / periodsPerYear(draft.paymentFrequency)
    );
    if (interestOnly > 0) return { payment: interestOnly, calculated: true };
  }
  return { payment: null, calculated: false };
}

/** Revolving lines are not projected: a HELOC is interest-only and a card is open-ended. */
const NOT_PROJECTED: ReadonlySet<LiabilityType> = new Set(['credit_card', 'heloc']);

export function reviewDebt(draft: DebtDraft, today: string): DebtReview {
  const { values } = validateAmounts(draft);
  const { payment, calculated } = effectivePayment(draft);
  const out: DebtReview = {
    payment,
    paymentCalculated: calculated,
    monthlyCashFlow: null,
    projected: false,
    neverPaysOff: false,
    payoffDate: null,
    paymentsLeft: null,
    totalInterestLeft: null,
    yearPrincipal: 0,
    yearInterest: 0,
    balances: [],
  };
  if (!values) return out;
  const perYear = periodsPerYear(draft.paymentFrequency);
  if (payment !== null) {
    out.monthlyCashFlow = round2(
      (payment * perYear) / 12 + ((values.escrowAmount ?? 0) * perYear) / 12
    );
  }
  if (payment === null || NOT_PROJECTED.has(draft.liabilityType) || values.currentBalance <= 0) {
    return out;
  }
  out.projected = true;
  const apr = values.interestRate ?? 0;
  const firstDue = firstDueAfter(draft.nextPaymentDate || null, draft.paymentFrequency, today);
  const summary = summarize(values.currentBalance, apr, payment, draft.paymentFrequency, firstDue);
  if (summary.neverPaysOff) {
    out.neverPaysOff = true;
    return out;
  }
  out.payoffDate = summary.payoffDate;
  out.paymentsLeft = summary.periodsRemaining;
  out.totalInterestLeft = summary.totalInterestRemaining;
  const rows = schedule(values.currentBalance, apr, payment, draft.paymentFrequency, firstDue);
  const year = today.slice(0, 4);
  for (const r of rows) {
    if (r.date.slice(0, 4) === year) {
      out.yearPrincipal += r.principal;
      out.yearInterest += r.interest;
    }
  }
  const step = Math.max(1, Math.ceil(rows.length / 60));
  out.balances = [values.currentBalance];
  rows.forEach((r, i) => {
    if (i % step === step - 1 || i === rows.length - 1) out.balances.push(r.balance);
  });
  return out;
}

const TYPE_WORDS: Record<LiabilityType, string[]> = {
  mortgage: ['mortgage'],
  auto_loan: ['auto', 'car'],
  student_loan: ['student'],
  credit_card: ['credit card', 'card'],
  personal_loan: ['personal'],
  heloc: ['heloc'],
  other: [],
};

const escapeRe = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const gapOf = (amount: number, payment: number): number => Math.abs(amount - payment) / payment;

/**
 * An existing expense that probably is this debt's payment. A whole-word match
 * on the type word counts only when the amount is also within 50% of the
 * monthly payment (so "Auto insurance" is not a car loan); otherwise the
 * closest amount within 10% wins. Null when nothing passes: the caller creates
 * a new expense. `taken` holds expense ids already linked to a debt.
 */
export function suggestExpense(
  expenses: readonly Expense[],
  type: LiabilityType,
  monthlyPayment: number | null,
  taken: ReadonlySet<string> = new Set()
): Expense | null {
  const free = expenses.filter((e) => e.is_active !== false && !taken.has(e.id));
  if (monthlyPayment === null || monthlyPayment <= 0) return null;
  const patterns = TYPE_WORDS[type].map((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i'));
  const byName = free.find(
    (e) => patterns.some((re) => re.test(e.name)) && gapOf(e.monthly_amount, monthlyPayment) <= 0.5
  );
  if (byName) return byName;
  let best: Expense | null = null;
  let bestGap = Infinity;
  for (const e of free) {
    const gap = gapOf(e.monthly_amount, monthlyPayment);
    if (gap <= 0.1 && gap < bestGap) {
      best = e;
      bestGap = gap;
    }
  }
  return best;
}
