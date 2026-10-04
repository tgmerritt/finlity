/**
 * Tests for the dashboard's pure portfolio math.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPosition,
  allocationVsTarget,
  hasTargets,
  positionDayChange,
  portfolioDayChange,
  historyChange,
  rangeDays,
  defaultRange,
  groupAccounts,
  attentionItems,
  heroModel,
} from '@/utils/portfolio-metrics';
import type {
  AccountResponse,
  DashboardLiability,
  DashboardPosition,
  SnapshotHistory,
  DashboardData,
} from '@/types/api';

const pos = (over: Partial<DashboardPosition>): DashboardPosition =>
  ({
    id: over.ticker ?? 'x',
    ticker: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    shares: 10,
    price: 100,
    value: 1000,
    cost_basis: 800,
    account: 'Roth IRA',
    account_type: 'roth_ira',
    is_fund: true,
    position_type: 'fund',
    previous_close: 98,
    ...over,
  }) as DashboardPosition;

const snap = (date: string, total: number): SnapshotHistory =>
  ({ date, total, retirement: total / 2, taxable: total / 2 }) as SnapshotHistory;

describe('classifyPosition', () => {
  it('uses position type for non-funds', () => {
    expect(classifyPosition(pos({ position_type: 'cash', name: 'Settlement Cash' }))).toBe('cash');
    expect(classifyPosition(pos({ position_type: 'cd', name: '12-Month CD' }))).toBe('bonds');
    expect(classifyPosition(pos({ position_type: 'treasury', name: 'T-Note' }))).toBe('bonds');
    expect(classifyPosition(pos({ position_type: 'real_estate', name: 'Home' }))).toBe(
      'alternatives'
    );
    expect(classifyPosition(pos({ position_type: 'equity', name: 'Apple Inc.' }))).toBe('stocks');
  });

  it('classifies funds by name', () => {
    const fund = (name: string) => classifyPosition(pos({ position_type: 'fund', name }));
    expect(fund('Vanguard Total Bond Market ETF')).toBe('bonds');
    expect(fund('iShares 0-3 Month Treasury Bond ETF')).toBe('bonds');
    expect(fund('SPDR Bloomberg 1-3 Month T-Bill ETF')).toBe('bonds');
    expect(fund('Vanguard Short-Term Inflation-Protected Securities ETF')).toBe('bonds');
    expect(fund('iShares Core U.S. Aggregate Bond ETF')).toBe('bonds');
    expect(fund('Vanguard Real Estate ETF')).toBe('alternatives');
    expect(fund('Schwab U.S. REIT ETF')).toBe('alternatives');
    expect(fund('Fidelity Government Money Market Fund')).toBe('cash');
    expect(fund('Vanguard Total Stock Market ETF')).toBe('stocks');
  });
});

describe('allocationVsTarget', () => {
  const positions = [
    pos({ ticker: 'VTI', value: 600 }),
    pos({ ticker: 'BND', name: 'Vanguard Total Bond Market ETF', value: 300 }),
    pos({ ticker: 'CASH', position_type: 'cash', name: 'Cash', value: 100 }),
  ];

  it('computes actual percentages and drift against fractional targets', () => {
    const rows = allocationVsTarget(positions, {
      equities: 0.5,
      bonds: 0.4,
      alternatives: 0,
      cash: 0.1,
    });
    const stocks = rows.find((r) => r.cls === 'stocks')!;
    expect(stocks.actualPct).toBeCloseTo(60);
    expect(stocks.targetPct).toBeCloseTo(50);
    expect(stocks.driftPct).toBeCloseTo(10);
    expect(stocks.outOfBand).toBe(true);
    expect(rows.find((r) => r.cls === 'cash')!.outOfBand).toBe(false);
  });

  it('leaves property accounts out of allocation and drift', () => {
    const home = pos({
      ticker: 'HOME',
      name: 'Home',
      account: 'Home',
      account_type: 'property',
      position_type: 'real_estate',
      asset_class: 'alternative',
      value: 685000,
    });
    const rows = allocationVsTarget([...positions, home], {
      equities: 0.6,
      bonds: 0.3,
      alternatives: 0,
      cash: 0.1,
    });
    expect(rows.find((r) => r.cls === 'alternatives')).toBeUndefined();
    expect(rows.find((r) => r.cls === 'stocks')!.actualPct).toBeCloseTo(60);
    expect(rows.every((r) => !r.outOfBand)).toBe(true);
  });

  it('keeps real estate in other account types', () => {
    const rental = pos({
      ticker: 'RENTAL',
      name: 'Rental',
      account_type: 'taxable',
      position_type: 'real_estate',
      asset_class: 'alternative',
      value: 100,
    });
    const rows = allocationVsTarget([...positions, rental], null);
    expect(rows.find((r) => r.cls === 'alternatives')!.value).toBe(100);
  });

  it('accepts percentages as well as fractions', () => {
    const rows = allocationVsTarget(positions, {
      equities: 60,
      bonds: 30,
      alternatives: 0,
      cash: 10,
    });
    expect(rows.find((r) => r.cls === 'stocks')!.driftPct).toBeCloseTo(0);
  });

  it('omits classes with no value and no target, and has null targets without targets', () => {
    const rows = allocationVsTarget(positions, null);
    expect(rows.map((r) => r.cls)).toEqual(['stocks', 'bonds', 'cash']);
    expect(rows.every((r) => r.targetPct === null && r.driftPct === null && !r.outOfBand)).toBe(
      true
    );
  });

  it('hasTargets is true only when some target is above zero', () => {
    expect(hasTargets(null)).toBe(false);
    expect(hasTargets({})).toBe(false);
    expect(hasTargets({ equities: 0, bonds: 0 })).toBe(false);
    expect(hasTargets({ equities: 0.6 })).toBe(true);
  });

  it('treats units per object based on sum of targets', () => {
    const rows = allocationVsTarget(positions, {
      equities: 60,
      bonds: 34,
      alternatives: 1,
      cash: 5,
    });
    expect(rows.find((r) => r.cls === 'alternatives')!.targetPct).toBeCloseTo(1);
  });

  it('excludes negative position values from totals', () => {
    const withShort = [pos({ ticker: 'VTI', value: 600 }), pos({ ticker: 'SHORT', value: -100 })];
    const rows = allocationVsTarget(withShort, null);
    expect(rows.find((r) => r.cls === 'stocks')!.actualPct).toBeCloseTo(100);
  });
});

describe('day change', () => {
  it('uses price minus previous close times shares', () => {
    expect(positionDayChange(pos({ price: 100, previous_close: 98, shares: 10 }))).toBeCloseTo(20);
  });

  it('is null without a previous close and for cash, CDs and real estate', () => {
    expect(positionDayChange(pos({ previous_close: null }))).toBeNull();
    expect(positionDayChange(pos({ position_type: 'cash' }))).toBeNull();
    expect(positionDayChange(pos({ position_type: 'cd' }))).toBeNull();
    expect(positionDayChange(pos({ position_type: 'real_estate' }))).toBeNull();
  });

  it('applies the contract multiplier for options', () => {
    const option = pos({
      position_type: 'option',
      price: 2,
      previous_close: 1.5,
      shares: 1,
      contract_multiplier: 100,
    });
    expect(positionDayChange(option)).toBeCloseTo(50);
  });

  it('portfolio change is relative to yesterday', () => {
    const change = portfolioDayChange(
      [pos({ price: 110, previous_close: 100, shares: 10 })],
      1100
    )!;
    expect(change.amount).toBeCloseTo(100);
    expect(change.pct).toBeCloseTo(10);
    expect(portfolioDayChange([pos({ previous_close: null })], 1000)).toBeNull();
  });
});

describe('history ranges', () => {
  it('historyChange compares first and last points', () => {
    const c = historyChange([snap('2026-09-01', 1000), snap('2026-09-29', 1100)])!;
    expect(c.amount).toBeCloseTo(100);
    expect(c.pct).toBeCloseTo(10);
    expect(historyChange([snap('2026-09-29', 1000)])).toBeNull();
  });

  it('rangeDays covers each key, YTD from 1 January UTC', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    expect(rangeDays('1M', now)).toBe(30);
    expect(rangeDays('3M', now)).toBe(90);
    expect(rangeDays('YTD', now)).toBe(59);
    expect(rangeDays('1Y', now)).toBe(365);
    expect(rangeDays('ALL', now)).toBeGreaterThan(3650);
  });

  it('rangeDays YTD on 1 January returns 1, not 0', () => {
    expect(rangeDays('YTD', new Date('2026-01-01T10:00:00Z'))).toBe(1);
  });

  it('defaults to 1Y when history spans more than 30 days, otherwise ALL', () => {
    expect(defaultRange([snap('2026-01-01', 1), snap('2026-09-29', 1)])).toBe('1Y');
    expect(defaultRange([snap('2026-09-20', 1), snap('2026-09-29', 1)])).toBe('ALL');
    expect(defaultRange([])).toBe('ALL');
  });
});

describe('groupAccounts', () => {
  const account = (over: Partial<AccountResponse>): AccountResponse =>
    ({
      id: 'a',
      name: 'A',
      account_type: 'taxable',
      display_type: '',
      brokerage: 'other',
      value: 0,
      cost_basis: null,
      position_count: 0,
      is_retirement: false,
      ...over,
    }) as AccountResponse;

  it('groups into retirement, taxable and cash with subtotals and day change', () => {
    const accounts = [
      account({
        id: '1',
        name: 'Roth IRA',
        account_type: 'roth_ira',
        is_retirement: true,
        value: 1000,
      }),
      account({ id: '2', name: 'Brokerage', account_type: 'taxable', value: 500 }),
      account({ id: '3', name: 'Savings', account_type: 'hysa', value: 500 }),
    ];
    const positions = [pos({ account: 'Roth IRA', price: 100, previous_close: 98, shares: 10 })];
    const groups = groupAccounts(accounts, positions, 2000);
    expect(groups.map((g) => g.key)).toEqual(['retirement', 'taxable', 'cash']);
    expect(groups.map((g) => g.label)).toEqual(['Retirement', 'Taxable', 'Cash & savings']);
    expect(groups[0]!.subtotal).toBe(1000);
    expect(groups[0]!.rows[0]!.pctOfTotal).toBeCloseTo(50);
    expect(groups[0]!.rows[0]!.dayChange).toBeCloseTo(20);
    expect(groups[1]!.rows[0]!.dayChange).toBeNull();
  });

  it('omits empty groups', () => {
    const groups = groupAccounts([account({ id: '2', name: 'Brokerage', value: 5 })], [], 5);
    expect(groups.map((g) => g.key)).toEqual(['taxable']);
  });

  it('sets dayChange to null when account name is not unique', () => {
    const accounts = [
      account({ id: '1', name: 'Brokerage', account_type: 'taxable', value: 500 }),
      account({ id: '2', name: 'Brokerage', account_type: 'taxable', value: 300 }),
    ];
    const positions = [pos({ account: 'Brokerage', price: 100, previous_close: 98, shares: 10 })];
    const groups = groupAccounts(accounts, positions, 800);
    expect(groups[0]!.rows.every((r) => r.dayChange === null)).toBe(true);
  });
});

describe('attentionItems', () => {
  const today = new Date('2026-09-30T12:00:00Z');

  it('lists stale prices, maturing CDs, duplicates and triggered alerts', () => {
    const items = attentionItems({
      staleTickers: 3,
      positions: [
        pos({
          ticker: 'CD',
          name: '12-Month CD',
          position_type: 'cd',
          maturity_date: '2026-10-15',
        }),
        pos({ ticker: 'CD', name: '5-Year CD', position_type: 'cd', maturity_date: '2029-01-01' }),
      ],
      duplicateCount: 1,
      triggeredAlerts: [
        { trigger_name: 'Tech over 40%', triggered: true },
        { trigger_name: 'Off', triggered: false },
      ],
      today,
    });
    expect(items.map((i) => i.kind)).toEqual([
      'stale-prices',
      'cd-maturing',
      'duplicates',
      'alert',
    ]);
    expect(items[0]!.message).toBe('3 prices out of date');
    expect(items[1]!.message).toBe('12-Month CD matures Oct 15, 2026');
    expect(items[2]!.message).toBe('1 possible duplicate position');
    expect(items[3]!.message).toBe('Tech over 40%');
  });

  it('is empty when nothing needs attention', () => {
    expect(
      attentionItems({
        staleTickers: 0,
        positions: [],
        duplicateCount: 0,
        triggeredAlerts: [],
        today,
      })
    ).toEqual([]);
  });

  it('messages contain no em-dash', () => {
    const items = attentionItems({
      staleTickers: 1,
      positions: [],
      duplicateCount: 2,
      triggeredAlerts: [{ message: 'x' }],
      today,
    });
    expect(items.every((i) => !i.message.includes('\u2014'))).toBe(true);
  });

  it('skips CDs with unparseable maturity_date', () => {
    const items = attentionItems({
      staleTickers: 0,
      positions: [
        pos({
          ticker: 'CD',
          name: 'Bad CD',
          position_type: 'cd',
          maturity_date: 'not-a-date',
        }),
      ],
      duplicateCount: 0,
      triggeredAlerts: [],
      today,
    });
    expect(items).toEqual([]);
  });
});

describe('groupAccounts property group', () => {
  const acct = (over: Partial<AccountResponse>): AccountResponse =>
    ({
      id: 'a',
      name: 'A',
      account_type: 'taxable',
      display_type: '',
      brokerage: 'other',
      value: 0,
      cost_basis: null,
      position_count: 0,
      is_retirement: false,
      ...over,
    }) as AccountResponse;

  it('puts property accounts in a Property group after Cash & savings', () => {
    const groups = groupAccounts(
      [
        acct({ id: '1', name: 'Home', account_type: 'property', value: 600 }),
        acct({ id: '2', name: 'Savings', account_type: 'hysa', value: 100 }),
        acct({ id: '3', name: 'Brokerage', value: 300 }),
        acct({ id: '4', name: 'Roth', account_type: 'roth_ira', is_retirement: true, value: 1 }),
      ],
      [],
      1000
    );
    expect(groups.map((g) => g.key)).toEqual(['retirement', 'taxable', 'cash', 'property']);
    expect(groups[3]!.label).toBe('Property');
    expect(groups[3]!.rows[0]!.pctOfTotal).toBeCloseTo(60);
    expect(groups[1]!.rows.map((r) => r.name)).toEqual(['Brokerage']);
  });
});

describe('allocationVsTarget with property accounts', () => {
  it('ignores positions in property accounts', () => {
    const rows = allocationVsTarget(
      [
        pos({ ticker: 'VTI', value: 1000 }),
        pos({
          ticker: 'RE',
          position_type: 'real_estate',
          account_type: 'property',
          value: 9000,
        }),
      ],
      null
    );
    expect(rows.map((r) => r.cls)).toEqual(['stocks']);
    expect(rows[0]!.actualPct).toBeCloseTo(100);
  });
});

const debt = (over: Partial<DashboardLiability> = {}): DashboardLiability => ({
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

const dashboard = (over: {
  summary?: Partial<DashboardData['summary']>;
  history?: SnapshotHistory[];
  positions?: DashboardPosition[];
}): Pick<DashboardData, 'summary' | 'history' | 'positions'> => ({
  summary: {
    total_value: 1000,
    liabilities_included: true,
    liabilities_total: 400,
    net_worth: 600,
    liabilities: [debt()],
    ...over.summary,
  } as DashboardData['summary'],
  history: over.history ?? [],
  positions: over.positions ?? [],
});

describe('heroModel', () => {
  const nwSnap = (date: string, total: number, liabilities: number): SnapshotHistory =>
    ({
      date,
      total,
      retirement: 0,
      taxable: total,
      liabilities,
      net_worth: total - liabilities,
    }) as SnapshotHistory;

  it('is portfolio mode without liabilities', () => {
    const m = heroModel(
      dashboard({
        summary: {
          liabilities_included: true,
          liabilities_total: 0,
          net_worth: 1000,
          liabilities: [],
        },
        history: [snap('2026-09-01', 900), snap('2026-09-30', 1000)],
      })
    );
    expect(m.mode).toBe('portfolio');
    expect(m.label).toBe('Portfolio value');
    expect(m.value).toBe(1000);
    expect(m.breakdown).toBeNull();
    expect(m.rangeChange!.amount).toBe(100);
    expect(m.series.map((p) => p.value)).toEqual([900, 1000]);
    expect(m.series[0]!.debts).toBeNull();
  });

  it('is portfolio mode when a view excludes liabilities', () => {
    const m = heroModel(dashboard({ summary: { liabilities_included: false } }));
    expect(m.mode).toBe('portfolio');
    expect(m.value).toBe(1000);
  });

  it('is net worth mode with a breakdown and net worth series', () => {
    const m = heroModel(
      dashboard({ history: [nwSnap('2026-09-01', 900, 420), nwSnap('2026-09-30', 1000, 400)] })
    );
    expect(m.mode).toBe('net-worth');
    expect(m.label).toBe('Net worth');
    expect(m.value).toBe(600);
    expect(m.breakdown).toBe('Assets $1,000.00 \u00b7 Debts $400.00');
    expect(m.series).toEqual([
      { date: '2026-09-01', value: 480, assets: 900, debts: 420 },
      { date: '2026-09-30', value: 600, assets: 1000, debts: 400 },
    ]);
    expect(m.rangeChange!.amount).toBe(120);
    expect(m.rangeChange!.pct).toBeCloseTo(25);
  });

  it('computes the day change from assets against yesterday net worth', () => {
    const m = heroModel(
      dashboard({ positions: [pos({ price: 100, previous_close: 90, shares: 10 })] })
    );
    // Assets up 100, so yesterday's net worth was 500.
    expect(m.dayChange!.amount).toBeCloseTo(100);
    expect(m.dayChange!.pct).toBeCloseTo(20);
  });

  it('drops percents when the base is not positive and allows negative net worth', () => {
    const m = heroModel(
      dashboard({
        summary: { total_value: 100, liabilities_total: 400, net_worth: -300 },
        positions: [pos({ price: 100, previous_close: 90, shares: 10 })],
        history: [nwSnap('2026-09-01', 50, 400), nwSnap('2026-09-30', 100, 400)],
      })
    );
    expect(m.value).toBe(-300);
    expect(m.dayChange).toEqual({ amount: 100, pct: null });
    expect(m.rangeChange).toEqual({ amount: 50, pct: null });
  });

  it('has no range change with fewer than two points', () => {
    expect(
      heroModel(dashboard({ history: [nwSnap('2026-09-30', 1000, 400)] })).rangeChange
    ).toBeNull();
  });
});

describe('attentionItems with liabilities', () => {
  const today = new Date('2026-09-30T12:00:00Z');
  const base = { staleTickers: 0, duplicateCount: 0, triggeredAlerts: [], today };
  const home = pos({ id: 'p-home', ticker: 'RE', name: 'Home', position_type: 'real_estate' });

  it('asks for debts when included, none exist and an account exists', () => {
    const items = attentionItems({
      ...base,
      positions: [],
      accountCount: 2,
      liabilitiesIncluded: true,
      liabilities: [],
    });
    expect(items).toEqual([
      {
        kind: 'add-debts',
        message: 'Add your debts to see your net worth',
        action: 'add-debts',
        dismissKey: 'add-debts',
      },
    ]);
  });

  it('skips add-debts with no accounts, in a view, when dismissed or when debts exist', () => {
    const args = {
      ...base,
      positions: [],
      accountCount: 1,
      liabilitiesIncluded: true,
      liabilities: [],
    };
    expect(attentionItems({ ...args, accountCount: 0 })).toEqual([]);
    expect(attentionItems({ ...args, liabilitiesIncluded: false })).toEqual([]);
    expect(attentionItems({ ...args, dismissed: new Set(['add-debts']) })).toEqual([]);
    expect(attentionItems({ ...args, liabilities: [debt()] })).toEqual([]);
  });

  it('flags a real estate position no debt links to, once per position', () => {
    const items = attentionItems({
      ...base,
      positions: [home, pos({ id: 'p2', name: 'Cabin', position_type: 'real_estate' })],
      accountCount: 1,
      liabilitiesIncluded: true,
      liabilities: [debt({ linked_position_id: 'p2' })],
    });
    expect(items).toEqual([
      {
        kind: 'property-unlinked',
        message: 'Is Home financed?',
        action: 'review-property',
        targetId: 'p-home',
        dismissKey: 'property:p-home',
      },
    ]);
  });

  it('honors dismissed property items and ignores them in a filtered view', () => {
    const args = { ...base, positions: [home], accountCount: 1, liabilities: [debt()] };
    expect(
      attentionItems({
        ...args,
        liabilitiesIncluded: true,
        dismissed: new Set(['property:p-home']),
      })
    ).toEqual([]);
    expect(attentionItems({ ...args, liabilitiesIncluded: false })).toEqual([]);
  });

  it('flags revolving balances not reported for more than 45 days', () => {
    const card = debt({
      id: 'c1',
      name: 'Chase Sapphire',
      liability_type: 'credit_card',
      is_amortizing: false,
      last_reported_date: '2026-08-10',
    });
    const fresh = debt({ id: 'c2', is_amortizing: false, last_reported_date: '2026-08-16' });
    const oldLoan = debt({ id: 'm', last_reported_date: '2020-01-01' });
    const items = attentionItems({
      ...base,
      positions: [],
      accountCount: 1,
      liabilitiesIncluded: true,
      liabilities: [card, fresh, oldLoan],
    });
    expect(items).toEqual([
      {
        kind: 'stale-balance',
        message: 'Update the Chase Sapphire balance',
        action: 'update-balance',
        targetId: 'c1',
      },
    ]);
  });

  it('new messages contain no em-dash', () => {
    const items = attentionItems({
      ...base,
      positions: [home],
      accountCount: 1,
      liabilitiesIncluded: true,
      liabilities: [],
    });
    expect(items.length).toBe(2);
    expect(items.every((i) => !i.message.includes('\u2014'))).toBe(true);
  });
});
