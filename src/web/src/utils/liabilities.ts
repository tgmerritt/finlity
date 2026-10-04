/**
 * Pure helpers for showing liabilities: the dashboard's Liabilities group and
 * shared labels. No DOM or network access.
 */
import type { DashboardLiability, LiabilityType, PortfolioSummary } from '@/types/api';

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
    subtotal: -owed,
    rows: [...debts]
      .sort((a, b) => b.balance - a.balance)
      .map((d) => ({ id: d.id, name: d.name, balance: -d.balance, meta: metaFor(d) })),
    footer: { label: 'Net worth', value: summary.net_worth ?? summary.total_value - owed },
  };
}
