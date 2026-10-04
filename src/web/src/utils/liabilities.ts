/**
 * Pure helpers for showing liabilities: the dashboard's Liabilities group and
 * shared labels. No DOM or network access.
 */
import { balanceAt, shift } from '@/utils/amortization';
import type {
  DashboardLiability,
  LiabilityResponse,
  LiabilityType,
  PortfolioSummary,
} from '@/types/api';

export const LIABILITY_TYPE_LABELS: Record<LiabilityType, string> = {
  mortgage: 'Mortgage',
  auto_loan: 'Auto loan',
  student_loan: 'Student loan',
  credit_card: 'Credit card',
  personal_loan: 'Personal loan',
  heloc: 'HELOC',
  other: 'Other',
};

/** Short type word for meta lines on revolving debts. */
const SHORT_TYPE: Record<LiabilityType, string> = {
  ...LIABILITY_TYPE_LABELS,
  credit_card: 'Card',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string): { y: string; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { y: match[1]!, m: m - 1, d: Number(match[3]) } : null;
}

/** "Jul 2052" from an ISO date, or '' when unparseable. */
export function formatMonthYear(iso: string): string {
  const p = parts(iso);
  return p ? `${MONTHS[p.m]} ${p.y}` : '';
}

/** "Sep 12" from an ISO date, or '' when unparseable. */
export function formatMonthDay(iso: string): string {
  const p = parts(iso);
  return p ? `${MONTHS[p.m]} ${p.d}` : '';
}

/** APR decimal as a percent without trailing zeros: 0.0625 -> "6.25%". */
export function formatApr(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

export interface LiabilityRow {
  id: string;
  name: string;
  /** Negative: what is owed. */
  balance: number;
  meta: string;
}

export interface LiabilityGroup {
  key: 'liabilities';
  label: string;
  /** Negative total owed. */
  subtotal: number;
  rows: LiabilityRow[];
  footer: { label: 'Net worth'; value: number };
}

function metaFor(d: DashboardLiability): string {
  if (d.is_amortizing) {
    const rate = d.interest_rate == null ? '' : formatApr(d.interest_rate);
    const payoff = d.payoff_date ? formatMonthYear(d.payoff_date) : '';
    if (rate && payoff) return `${rate} · paid off ${payoff}`;
    return rate || SHORT_TYPE[d.liability_type];
  }
  const type = SHORT_TYPE[d.liability_type];
  const updated = d.last_reported_date ? formatMonthDay(d.last_reported_date) : '';
  return updated ? `${type} · updated ${updated}` : type;
}

/**
 * The dashboard Accounts card's Liabilities group and its Net worth footer, or
 * null when liabilities are not included (filtered view) or none exist.
 */
export function liabilityGroup(summary: PortfolioSummary): LiabilityGroup | null {
  const debts = summary.liabilities ?? [];
  if (summary.liabilities_included !== true || debts.length === 0) return null;
  const owed = summary.liabilities_total ?? debts.reduce((s, d) => s + d.balance, 0);
  return {
    key: 'liabilities',
    label: 'Liabilities',
    subtotal: -owed || 0,
    rows: [...debts]
      .sort((a, b) => b.balance - a.balance)
      .map((d) => ({ id: d.id, name: d.name, balance: -d.balance || 0, meta: metaFor(d) })),
    footer: { label: 'Net worth', value: summary.net_worth ?? summary.total_value - owed },
  };
}

/**
 * Total owed on active debts at today and each yearly anniversary after it
 * (years + 1 values), from each debt's latest reported balance. Same math as
 * the server's balance_at, so both modes agree.
 */
export function debtByYear(
  liabilities: readonly LiabilityResponse[],
  todayIso: string,
  years: number
): number[] {
  const active = liabilities.filter((d) => d.is_active);
  const out: number[] = [];
  for (let i = 0; i <= years; i++) {
    const on = shift(todayIso, 'annual', i);
    out.push(
      active.reduce(
        (sum, d) =>
          sum +
          balanceAt(
            {
              isAmortizing: d.is_amortizing,
              interestRate: d.interest_rate,
              paymentAmount: d.payment_amount,
              paymentFrequency: d.payment_frequency,
              nextPaymentDate: d.next_payment_date,
              originationDate: d.origination_date,
              closedDate: d.closed_date,
            },
            [{ snapshotDate: d.balance_as_of, balance: d.current_balance }],
            on
          ),
        0
      )
    );
  }
  return out;
}

export interface DebtPayoffSummary {
  debtFreeDate: string | null;
  debtFreeAge: number | null;
  interestLeft: number;
  debts: { id: string; name: string; payoffDate: string | null }[];
}

/** The Projections debt card: latest payoff, age then, interest left, per-debt dates. */
export function debtPayoffSummary(
  liabilities: readonly LiabilityResponse[],
  todayIso: string,
  currentAge: number
): DebtPayoffSummary | null {
  const active = liabilities.filter((d) => d.is_active);
  if (active.length === 0) return null;
  let last: string | null = null;
  for (const d of active)
    if (d.payoff_date && (!last || d.payoff_date > last)) last = d.payoff_date;
  let age: number | null = null;
  if (last) {
    const [ty, tm, td] = [todayIso.slice(0, 4), todayIso.slice(5, 7), todayIso.slice(8, 10)].map(
      Number
    ) as [number, number, number];
    const [ly, lm, ld] = [last.slice(0, 4), last.slice(5, 7), last.slice(8, 10)].map(Number) as [
      number,
      number,
      number,
    ];
    const full = ly - ty - (lm * 32 + ld < tm * 32 + td ? 1 : 0);
    age = currentAge + Math.max(0, full);
  }
  return {
    debtFreeDate: last,
    debtFreeAge: age,
    interestLeft: active.reduce((sum, d) => sum + (d.total_interest_remaining ?? 0), 0),
    debts: active.map((d) => ({ id: d.id, name: d.name, payoffDate: d.payoff_date })),
  };
}
