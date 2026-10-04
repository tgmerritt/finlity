import { describe, it, expect } from 'vitest';
import { liabilityGroup } from '@/utils/liabilities';
import type { DashboardLiability, PortfolioSummary } from '@/types/api';

const debt = (over: Partial<DashboardLiability>): DashboardLiability => ({
  id: 'l1',
  name: 'Mortgage',
  liability_type: 'mortgage',
  balance: 400,
  interest_rate: 0.0625,
  payment_amount: 3000,
  payment_frequency: 'monthly',
  payoff_date: '2052-07-01',
  linked_position_id: null,
  entity_id: null,
  is_amortizing: true,
  last_reported_date: '2026-09-30',
  ...over,
});

const summary = (
  liabilities: DashboardLiability[],
  over: Partial<PortfolioSummary> = {}
): PortfolioSummary =>
  ({
    total_value: 1000,
    liabilities_included: true,
    liabilities_total: liabilities.reduce((s, l) => s + l.balance, 0),
    net_worth: 1000 - liabilities.reduce((s, l) => s + l.balance, 0),
    liabilities,
    ...over,
  }) as PortfolioSummary;

describe('liabilityGroup', () => {
  it('returns null when liabilities are not included or none exist', () => {
    expect(liabilityGroup(summary([debt({})], { liabilities_included: false }))).toBeNull();
    expect(liabilityGroup(summary([]))).toBeNull();
    expect(liabilityGroup({ total_value: 1 } as PortfolioSummary)).toBeNull();
  });

  it('builds a negative group with sorted rows, meta text and a net worth footer', () => {
    const g = liabilityGroup(
      summary([
        debt({
          id: 'c',
          name: 'Chase Sapphire',
          liability_type: 'credit_card',
          balance: 100,
          interest_rate: 0.2299,
          is_amortizing: false,
          payoff_date: null,
          last_reported_date: '2026-09-12',
        }),
        debt({ id: 'm', balance: 300 }),
        debt({
          id: 'a',
          name: 'Auto',
          liability_type: 'auto_loan',
          balance: 200,
          interest_rate: 0.049,
          payoff_date: '2029-02-01',
        }),
      ])
    )!;
    expect(g.key).toBe('liabilities');
    expect(g.label).toBe('Liabilities');
    expect(g.subtotal).toBe(-600);
    expect(g.rows.map((r) => r.id)).toEqual(['m', 'a', 'c']);
    expect(g.rows.map((r) => r.balance)).toEqual([-300, -200, -100]);
    expect(g.rows[0]!.meta).toBe('6.25% · paid off Jul 2052');
    expect(g.rows[1]!.meta).toBe('4.9% · paid off Feb 2029');
    expect(g.rows[2]!.meta).toBe('Card · updated Sep 12');
    expect(g.footer).toEqual({ label: 'Net worth', value: 400 });
  });

  it('falls back gracefully when rate, payoff or report date are missing', () => {
    const g = liabilityGroup(
      summary([
        debt({ id: 'a', interest_rate: null, payoff_date: null }),
        debt({ id: 'b', liability_type: 'heloc', is_amortizing: false, last_reported_date: null }),
      ])
    )!;
    expect(g.rows.map((r) => r.meta)).toEqual(['Mortgage', 'HELOC']);
  });

  it('copy contains no em-dash', () => {
    const g = liabilityGroup(summary([debt({})]))!;
    expect(JSON.stringify(g)).not.toContain('\u2014');
  });
});
