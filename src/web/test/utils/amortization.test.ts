/**
 * Amortization math, driven by the golden file shared with the Python path.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  periodsPerYear,
  annuityPayment,
  balanceAfter,
  periodsToPayoff,
  dueDatesBetween,
  schedule,
  summarize,
  balanceAt,
} from '@/utils/amortization';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CASES: Record<string, any[]> = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), '../../tests/fixtures/amortization_cases.json'),
    'utf-8'
  )
);
const TOL = 0.01;

function money(actual: number, expected: number, label = ''): void {
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(TOL);
}

function rowMatches(actual: any, expected: any): void {
  expect(actual.date).toBe(expected.date);
  for (const key of ['payment', 'interest', 'principal', 'balance'])
    money(actual[key], expected[key], key);
}

describe('amortization golden cases', () => {
  it.each(CASES.annuity_payment.map((c) => [c.name, c]))('annuityPayment: %s', (_n, c) => {
    money(annuityPayment(c.balance, c.apr, c.n_periods, c.frequency), c.expected);
  });

  it('mortgage payment matches the published figure', () => {
    expect(Math.round(annuityPayment(520000, 0.0625, 360, 'monthly') * 100) / 100).toBe(3201.73);
  });

  it.each(CASES.balance_after.map((c) => [c.name, c]))('balanceAfter: %s', (_n, c) => {
    money(balanceAfter(c.balance, c.apr, c.payment, c.k, c.frequency), c.expected);
  });

  it.each(CASES.periods_to_payoff.map((c) => [c.name, c]))('periodsToPayoff: %s', (_n, c) => {
    expect(periodsToPayoff(c.balance, c.apr, c.payment, c.frequency)).toBe(c.expected);
  });

  it.each(CASES.due_dates_between.map((c) => [c.name, c]))('dueDatesBetween: %s', (_n, c) => {
    expect(
      dueDatesBetween(c.next_payment_date, c.frequency, c.start_exclusive, c.end_inclusive)
    ).toEqual(c.expected);
  });

  it.each(CASES.schedule.map((c) => [c.name, c]))('schedule: %s', (_n, c) => {
    const rows = schedule(c.balance, c.apr, c.payment, c.frequency, c.first_due);
    const e = c.expected;
    expect(rows.length).toBe(e.length);
    expect(rows.length).toBeLessThanOrEqual(600);
    rowMatches(rows[0], e.first);
    rowMatches(rows[rows.length - 1], e.last);
    money(
      rows.reduce((s, r) => s + r.interest, 0),
      e.total_interest,
      'interest'
    );
    money(
      rows.reduce((s, r) => s + r.payment, 0),
      e.total_payments,
      'payments'
    );
    (e.rows ?? []).forEach((want: any, i: number) => rowMatches(rows[i], want));
  });

  it.each(CASES.summarize.map((c) => [c.name, c]))('summarize: %s', (_n, c) => {
    const got = summarize(c.balance, c.apr, c.payment, c.frequency, c.first_due);
    const e = c.expected;
    expect(got.neverPaysOff).toBe(e.never_pays_off);
    expect(got.periodsRemaining).toBe(e.periods_remaining);
    expect(got.payoffDate).toBe(e.payoff_date);
    if (e.total_interest_remaining === null) expect(got.totalInterestRemaining).toBeNull();
    else money(got.totalInterestRemaining as number, e.total_interest_remaining);
  });

  it.each(CASES.balance_at.map((c) => [c.name, c]))('balanceAt: %s', (_n, c) => {
    const liab = {
      isAmortizing: !!c.liability.is_amortizing,
      interestRate: c.liability.interest_rate,
      paymentAmount: c.liability.payment_amount,
      paymentFrequency: c.liability.payment_frequency,
      nextPaymentDate: c.liability.next_payment_date,
      originationDate: c.liability.origination_date,
      closedDate: c.liability.closed_date,
    };
    const snaps = c.snapshots.map((s: any) => ({
      snapshotDate: s.snapshot_date,
      balance: s.balance,
    }));
    money(balanceAt(liab, snaps, c.on_date), c.expected);
  });

  it('rejects unknown frequencies everywhere', () => {
    expect(() => annuityPayment(1000, 0.05, 12, 'daily')).toThrow();
    expect(() => dueDatesBetween('2026-01-01', 'daily', '2026-01-01', '2026-03-01')).toThrow();
    expect(() => schedule(1000, 0.05, 100, 'daily', '2026-01-01')).toThrow();
  });

  it('treats a negative balance as paid off', () => {
    expect(balanceAfter(-500, 0.05, 100, 0, 'monthly')).toBe(0);
    expect(balanceAfter(-500, 0.05, 100, 3, 'monthly')).toBe(0);
    expect(periodsToPayoff(-500, 0.05, 100, 'monthly')).toBe(0);
    expect(schedule(-500, 0.05, 100, 'monthly', '2026-01-01')).toEqual([]);
    expect(summarize(-500, 0.05, 100, 'monthly', '2026-01-01')).toEqual({
      payoffDate: null,
      periodsRemaining: 0,
      totalInterestRemaining: 0,
      neverPaysOff: false,
    });
  });

  it('periodsPerYear rejects unknown frequencies', () => {
    expect(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'].map(periodsPerYear)).toEqual([
      52, 26, 12, 4, 1,
    ]);
    expect(() => periodsPerYear('daily')).toThrow();
  });
});
