/**
 * Pure amortization math.
 *
 * Mirrors src/liabilities/amortization.py; both are checked against
 * tests/fixtures/amortization_cases.json. Dates are ISO YYYY-MM-DD strings.
 * No intermediate rounding: callers round to cents at the display boundary.
 */

export type PaymentFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export interface ScheduleRow {
  date: string;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export interface AmortizationSummary {
  payoffDate: string | null;
  periodsRemaining: number | null;
  totalInterestRemaining: number | null;
  neverPaysOff: boolean;
}

export interface BalanceSnapshot {
  snapshotDate: string;
  balance: number;
}

export interface BalanceLiability {
  isAmortizing: boolean;
  interestRate: number | null;
  paymentAmount: number | null;
  paymentFrequency: string | null;
  nextPaymentDate: string | null;
  originationDate: string | null;
  closedDate: string | null;
}

export const PERIODS_PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};
const MONTH_STEP: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };
export const MAX_PERIODS = 600;
const EPS = 1e-9;
const DAY_MS = 86_400_000;

export function periodsPerYear(frequency: string): number {
  const n = PERIODS_PER_YEAR[frequency];
  if (n === undefined) throw new Error(`Unknown payment frequency: ${frequency}`);
  return n;
}

function rate(apr: number | null | undefined, frequency: string): number {
  return (apr ?? 0) / periodsPerYear(frequency);
}

export function annuityPayment(
  balance: number,
  apr: number,
  nPeriods: number,
  frequency: string
): number {
  if (nPeriods <= 0) return balance;
  const r = rate(apr, frequency);
  if (r === 0) return balance / nPeriods;
  return (balance * r) / (1 - Math.pow(1 + r, -nPeriods));
}

export function balanceAfter(
  balance: number,
  apr: number,
  payment: number,
  k: number,
  frequency: string
): number {
  if (k <= 0) return Math.max(balance, 0);
  const r = rate(apr, frequency);
  let value: number;
  if (r === 0) {
    value = balance - k * payment;
  } else {
    const growth = Math.pow(1 + r, k);
    value = balance * growth - (payment * (growth - 1)) / r;
  }
  return Math.max(value, 0);
}

/** Payments needed to clear `balance`; null when it never pays off (or exceeds the 600 cap). */
export function periodsToPayoff(
  balance: number,
  apr: number,
  payment: number,
  frequency: string
): number | null {
  if (balance <= 0) return 0;
  if (payment <= 0) return null;
  const r = rate(apr, frequency);
  let n: number;
  if (r === 0) {
    n = Math.ceil(balance / payment - EPS);
  } else {
    if (payment <= r * balance) return null;
    n = Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r) - EPS);
  }
  return n <= MAX_PERIODS ? n : null;
}

function parseDate(iso: string): { y: number; m: number; d: number } {
  const [y = 0, m = 1, d = 1] = iso.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function fmt(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Month-end dates from first's month while strictly before today, at most `limit` of them. */
export function monthEnds(first: string, today: string, limit: number): string[] {
  const out: string[] = [];
  let [year, month] = first.slice(0, 10).split('-').map(Number) as [number, number];
  while (out.length < limit) {
    const end = fmt(year, month, daysInMonth(year, month));
    if (end >= today) break;
    out.push(end);
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }
  return out;
}

function dayNumber(iso: string): number {
  const { y, m, d } = parseDate(iso);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** The anchor date moved by k whole periods (month-based dates clamp to month end). */
export function shift(anchor: string, frequency: string, k: number): string {
  const a = parseDate(anchor);
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const t = Date.UTC(a.y, a.m - 1, a.d) + (frequency === 'weekly' ? 7 : 14) * k * DAY_MS;
    return new Date(t).toISOString().slice(0, 10);
  }
  const step = MONTH_STEP[frequency];
  if (step === undefined) throw new Error(`Unknown payment frequency: ${frequency}`);
  const index = a.y * 12 + (a.m - 1) + step * k;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return fmt(y, m, Math.min(a.d, daysInMonth(y, m)));
}

/** Due dates in (startExclusive, endInclusive]: the anchor plus or minus whole periods. */
export function dueDatesBetween(
  nextPaymentDate: string,
  frequency: string,
  startExclusive: string,
  endInclusive: string
): string[] {
  const lo = startExclusive.slice(0, 10);
  const hi = endInclusive.slice(0, 10);
  if (hi <= lo) return [];
  let k: number;
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const stepDays = frequency === 'weekly' ? 7 : 14;
    k = Math.ceil((dayNumber(lo) - dayNumber(nextPaymentDate) + 1) / stepDays);
  } else {
    const step = MONTH_STEP[frequency];
    if (step === undefined) throw new Error(`Unknown payment frequency: ${frequency}`);
    const a = parseDate(nextPaymentDate);
    const l = parseDate(lo);
    k = Math.floor(((l.y - a.y) * 12 + l.m - a.m) / step) - 1;
  }
  const out: string[] = [];
  for (;;) {
    const d = shift(nextPaymentDate, frequency, k);
    if (d > hi) return out;
    if (d > lo) out.push(d);
    k += 1;
  }
}

/**
 * The next due date strictly after `today` (the anchor plus whole periods), or
 * one period on when there is no anchor. Mirrors the server's _first_due_after.
 */
export function firstDueAfter(
  anchor: string | null | undefined,
  frequency: string,
  today: string
): string {
  const base = (anchor ?? '').slice(0, 10) || today;
  const end = shift(today, 'weekly', 58); // 406 days: covers a yearly period
  const found = dueDatesBetween(base, frequency, today, end)[0];
  return found ?? shift(today, frequency, 1);
}

/** Payment rows until the balance clears or 600 periods; the last payment is the remainder. */
export function schedule(
  balance: number,
  apr: number,
  payment: number,
  frequency: string,
  firstDue: string
): ScheduleRow[] {
  const r = rate(apr, frequency);
  const rows: ScheduleRow[] = [];
  let bal = balance;
  while (bal > EPS && rows.length < MAX_PERIODS) {
    const interest = bal * r;
    let pay: number;
    let principal: number;
    let newBal: number;
    if (payment >= bal + interest - EPS) {
      pay = bal + interest;
      principal = bal;
      newBal = 0;
    } else {
      pay = payment;
      principal = payment - interest;
      newBal = bal - principal;
    }
    rows.push({
      date: shift(firstDue, frequency, rows.length),
      payment: pay,
      interest,
      principal,
      balance: newBal,
    });
    bal = newBal;
  }
  return rows;
}

export function summarize(
  balance: number,
  apr: number,
  payment: number,
  frequency: string,
  firstDue: string
): AmortizationSummary {
  if (periodsToPayoff(balance, apr, payment, frequency) === null) {
    return {
      payoffDate: null,
      periodsRemaining: null,
      totalInterestRemaining: null,
      neverPaysOff: true,
    };
  }
  const rows = schedule(balance, apr, payment, frequency, firstDue);
  return {
    payoffDate: rows[rows.length - 1]?.date ?? null,
    periodsRemaining: rows.length,
    totalInterestRemaining: rows.reduce((s, r) => s + r.interest, 0),
    neverPaysOff: false,
  };
}

/**
 * Balance on a date from reported snapshots (design section 3).
 * 0 on or after closedDate or before originationDate. Anchor on the latest snapshot on or
 * before the date (else the earliest: flat back-fill). Amortizing loans roll the anchor
 * forward by the due dates in (anchorDate, date]; revolving balances stay flat.
 */
export function balanceAt(
  liability: BalanceLiability,
  snapshots: BalanceSnapshot[],
  onDate: string
): number {
  const on = onDate.slice(0, 10);
  if (liability.closedDate && liability.closedDate.slice(0, 10) <= on) return 0;
  if (liability.originationDate && liability.originationDate.slice(0, 10) > on) return 0;
  if (snapshots.length === 0) return 0;
  const dated = snapshots
    .map((s) => ({ date: s.snapshotDate.slice(0, 10), balance: s.balance }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const prior = dated.filter((s) => s.date <= on);
  const anchor = prior[prior.length - 1];
  if (!anchor) return dated[0]?.balance ?? 0;
  const { paymentAmount, nextPaymentDate } = liability;
  if (!liability.isAmortizing || !paymentAmount || !nextPaymentDate) return anchor.balance;
  const frequency = liability.paymentFrequency || 'monthly';
  const k = dueDatesBetween(nextPaymentDate, frequency, anchor.date, on).length;
  return balanceAfter(anchor.balance, liability.interestRate ?? 0, paymentAmount, k, frequency);
}
