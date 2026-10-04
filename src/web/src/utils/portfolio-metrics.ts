/**
 * Pure portfolio math for the dashboard: allocation by asset class, day and
 * range changes, account grouping and "needs attention" items.
 *
 * No DOM or network access, so every function is unit tested.
 */
import type {
  AccountResponse,
  DashboardData,
  DashboardLiability,
  DashboardPosition,
  SnapshotHistory,
} from '@/types/api';
import { formatCurrency } from '@/utils/format';

export type AllocationClass = 'stocks' | 'bonds' | 'cash' | 'alternatives';

export const ALLOCATION_CLASSES: AllocationClass[] = ['stocks', 'bonds', 'cash', 'alternatives'];

export const ALLOCATION_LABELS: Record<AllocationClass, string> = {
  stocks: 'Stocks',
  bonds: 'Bonds',
  cash: 'Cash',
  alternatives: 'Alternatives',
};

/** Keys used by Settings for asset class targets (targets.asset_class). */
const TARGET_KEYS: Record<AllocationClass, string> = {
  stocks: 'equities',
  bonds: 'bonds',
  cash: 'cash',
  alternatives: 'alternatives',
};

const BOND_NAME =
  /\b(bonds?|treasury|treasuries|t-bill|aggregate|fixed income|inflation-protected|tips|municipal|muni)\b/i;
const CASH_NAME = /\b(money market|cash reserves?)\b/i;
const ALT_NAME = /\b(real estate|reits?|gold|commodit(?:y|ies))\b/i;

/**
 * Asset class for a position. Non-fund positions use their type; funds are
 * classified by name because stored asset classes are not reliable.
 */
export function classifyPosition(
  p: Pick<DashboardPosition, 'position_type' | 'name' | 'ticker'>
): AllocationClass {
  switch (p.position_type) {
    case 'cash':
      return 'cash';
    case 'cd':
    case 'bond':
    case 'treasury':
      return 'bonds';
    case 'real_estate':
      return 'alternatives';
    case 'fund': {
      const name = p.name ?? '';
      if (CASH_NAME.test(name)) return 'cash';
      if (BOND_NAME.test(name)) return 'bonds';
      if (ALT_NAME.test(name)) return 'alternatives';
      return 'stocks';
    }
    default:
      return 'stocks';
  }
}

export interface AllocationRow {
  cls: AllocationClass;
  label: string;
  value: number;
  actualPct: number;
  targetPct: number | null;
  driftPct: number | null;
  outOfBand: boolean;
}

/** Target as a percentage, accepting fractions (0.6) or percentages (60). Units are decided per object. */
function targetPercent(
  targets: Record<string, unknown> | null | undefined,
  cls: AllocationClass,
  usePercentages: boolean
): number | null {
  const raw = targets?.[TARGET_KEYS[cls]];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return usePercentages ? raw : raw * 100;
}

export function hasTargets(targets: Record<string, unknown> | null | undefined): boolean {
  return ALLOCATION_CLASSES.some((cls) => {
    const raw = targets?.[TARGET_KEYS[cls]];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
  });
}

export function allocationVsTarget(
  positions: DashboardPosition[],
  targets: Record<string, unknown> | null | undefined,
  bandPct = 5
): AllocationRow[] {
  const totals: Record<AllocationClass, number> = { stocks: 0, bonds: 0, cash: 0, alternatives: 0 };
  let sum = 0;
  for (const p of positions) {
    // Property accounts are a home, not investable allocation (plan decision D6).
    if (p.account_type === 'property') continue;
    const value = Math.max(0, p.value || 0);
    totals[classifyPosition(p)] += value;
    sum += value;
  }

  // Determine if targets are fractions or percentages based on sum
  let targetSum = 0;
  let usePercentages = false;
  if (targets) {
    for (const cls of ALLOCATION_CLASSES) {
      const raw = targets[TARGET_KEYS[cls]];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        targetSum += raw;
      }
    }
    usePercentages = targetSum > 1.5;
  }

  const withTargets = hasTargets(targets);
  return ALLOCATION_CLASSES.map((cls): AllocationRow => {
    const actualPct = sum > 0 ? (totals[cls] / sum) * 100 : 0;
    const targetPct = withTargets ? (targetPercent(targets, cls, usePercentages) ?? 0) : null;
    const driftPct = targetPct === null ? null : actualPct - targetPct;
    return {
      cls,
      label: ALLOCATION_LABELS[cls],
      value: totals[cls],
      actualPct,
      targetPct,
      driftPct,
      outOfBand: driftPct !== null && Math.abs(driftPct) > bandPct,
    };
  }).filter((row) => row.value > 0 || (row.targetPct ?? 0) > 0);
}

const NO_DAY_CHANGE: ReadonlySet<string> = new Set(['cash', 'cd', 'real_estate']);

function multiplier(p: DashboardPosition): number {
  return p.position_type === 'option' ? (p.contract_multiplier ?? 100) : 1;
}

/** Dollar change since the previous close, or null when it cannot be known. */
export function positionDayChange(p: DashboardPosition): number | null {
  if (NO_DAY_CHANGE.has(p.position_type)) return null;
  if (p.previous_close == null || p.price == null || !p.shares) return null;
  return (p.price - p.previous_close) * p.shares * multiplier(p);
}

export interface Change {
  amount: number;
  pct: number | null;
}

/** Portfolio change today; percent is relative to yesterday's value. */
export function portfolioDayChange(
  positions: DashboardPosition[],
  totalValue: number
): Change | null {
  let amount = 0;
  let known = false;
  for (const p of positions) {
    const change = positionDayChange(p);
    if (change === null) continue;
    known = true;
    amount += change;
  }
  if (!known) return null;
  const yesterday = totalValue - amount;
  return { amount, pct: yesterday > 0 ? (amount / yesterday) * 100 : null };
}

/** Change from the first to the last snapshot of an already filtered history. */
export function historyChange(history: SnapshotHistory[]): Change | null {
  if (history.length < 2) return null;
  const first = history[0]!.total;
  const last = history[history.length - 1]!.total;
  return { amount: last - first, pct: first > 0 ? ((last - first) / first) * 100 : null };
}

export type RangeKey = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export function rangeDays(key: RangeKey, now: Date = new Date()): number {
  switch (key) {
    case '1M':
      return 30;
    case '3M':
      return 90;
    case '1Y':
      return 365;
    case 'YTD': {
      const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return Math.max(1, Math.round((today - startOfYear) / 86_400_000));
    }
    case 'ALL':
      return 36_500;
  }
}

/** 1Y when history spans more than 30 days, otherwise everything. */
export function defaultRange(history: SnapshotHistory[]): RangeKey {
  if (history.length < 2) return 'ALL';
  const first = Date.parse(String(history[0]!.date).slice(0, 10));
  const last = Date.parse(String(history[history.length - 1]!.date).slice(0, 10));
  return (last - first) / 86_400_000 > 30 ? '1Y' : 'ALL';
}

export type AccountGroupKey = 'retirement' | 'taxable' | 'cash' | 'property';

export interface AccountRow {
  id: string;
  name: string;
  value: number;
  pctOfTotal: number;
  dayChange: number | null;
}

export interface AccountGroup {
  key: AccountGroupKey;
  label: string;
  subtotal: number;
  rows: AccountRow[];
}

const CASH_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'hysa',
  'checking',
  'savings',
  'treasury_direct',
  'cash',
]);

const GROUP_LABELS: Record<AccountGroupKey, string> = {
  retirement: 'Retirement',
  taxable: 'Taxable',
  cash: 'Cash & savings',
  property: 'Property',
};

function groupKey(a: AccountResponse): AccountGroupKey {
  if (a.account_type === 'property') return 'property';
  if (CASH_ACCOUNT_TYPES.has(a.account_type)) return 'cash';
  return a.is_retirement ? 'retirement' : 'taxable';
}

export function groupAccounts(
  accounts: AccountResponse[],
  positions: DashboardPosition[],
  totalValue: number
): AccountGroup[] {
  // Track which account names appear more than once
  const nameCounts: Record<string, number> = {};
  for (const a of accounts) {
    nameCounts[a.name] = (nameCounts[a.name] ?? 0) + 1;
  }
  const duplicateNames = new Set(
    Object.entries(nameCounts)
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
  );

  const order: AccountGroupKey[] = ['retirement', 'taxable', 'cash', 'property'];
  return order
    .map((key): AccountGroup => {
      const rows = accounts
        .filter((a) => groupKey(a) === key)
        .map((a): AccountRow => {
          let dayChange: number | null = null;
          if (!duplicateNames.has(a.name)) {
            for (const p of positions) {
              if (p.account !== a.name) continue;
              const change = positionDayChange(p);
              if (change !== null) dayChange = (dayChange ?? 0) + change;
            }
          }
          return {
            id: a.id,
            name: a.name,
            value: a.value,
            pctOfTotal: totalValue > 0 ? (a.value / totalValue) * 100 : 0,
            dayChange,
          };
        })
        .sort((x, y) => y.value - x.value);
      return {
        key,
        label: GROUP_LABELS[key],
        subtotal: rows.reduce((s, r) => s + r.value, 0),
        rows,
      };
    })
    .filter((g) => g.rows.length > 0);
}

export interface AttentionItem {
  kind:
    | 'stale-prices'
    | 'cd-maturing'
    | 'duplicates'
    | 'alert'
    | 'add-debts'
    | 'property-unlinked'
    | 'stale-balance';
  message: string;
  action:
    | 'refresh-prices'
    | 'show-duplicates'
    | 'open-holdings'
    | 'open-analysis'
    | 'add-debts'
    | 'review-property'
    | 'update-balance';
  /** Position id (review-property) or liability id (update-balance). */
  targetId?: string;
  /** Key to store in the dismissed set; present only on dismissible items. */
  dismissKey?: string;
}

export interface TriggeredAlert {
  trigger_name?: string | null;
  message?: string | null;
  triggered?: boolean | null;
}

const MATURITY_WINDOW_DAYS = 60;

function formatDay(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function attentionItems(input: {
  staleTickers: number;
  positions: DashboardPosition[];
  duplicateCount: number;
  triggeredAlerts: TriggeredAlert[];
  today: Date;
  /** Number of accounts; the add-debts prompt needs at least one. */
  accountCount?: number;
  /** summary.liabilities_included; debt items are skipped unless true. */
  liabilitiesIncluded?: boolean;
  liabilities?: DashboardLiability[];
  /** Dismissal keys (AttentionItem.dismissKey) the user has already cleared. */
  dismissed?: ReadonlySet<string>;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (input.staleTickers > 0) {
    items.push({
      kind: 'stale-prices',
      message: `${plural(input.staleTickers, 'price')} out of date`,
      action: 'refresh-prices',
    });
  }

  const todayUtc = Date.UTC(
    input.today.getUTCFullYear(),
    input.today.getUTCMonth(),
    input.today.getUTCDate()
  );
  for (const p of input.positions) {
    if (p.position_type !== 'cd' || !p.maturity_date) continue;
    const maturity = Date.parse(`${p.maturity_date.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(maturity)) continue;
    const days = Math.round((maturity - todayUtc) / 86_400_000);
    if (days > MATURITY_WINDOW_DAYS) continue;
    const label = p.name || p.ticker;
    items.push({
      kind: 'cd-maturing',
      message:
        days < 0
          ? `${label} matured ${formatDay(p.maturity_date)}`
          : `${label} matures ${formatDay(p.maturity_date)}`,
      action: 'open-holdings',
    });
  }

  if (input.duplicateCount > 0) {
    items.push({
      kind: 'duplicates',
      message: `${plural(input.duplicateCount, 'possible duplicate position')}`,
      action: 'show-duplicates',
    });
  }

  for (const alert of input.triggeredAlerts) {
    if (alert.triggered === false) continue;
    items.push({
      kind: 'alert',
      message: alert.message || alert.trigger_name || 'Allocation alert triggered',
      action: 'open-analysis',
    });
  }

  items.push(...debtAttentionItems(input, todayUtc));

  return items;
}

const STALE_BALANCE_DAYS = 45;

function debtAttentionItems(
  input: {
    positions: DashboardPosition[];
    accountCount?: number;
    liabilitiesIncluded?: boolean;
    liabilities?: DashboardLiability[];
    dismissed?: ReadonlySet<string>;
  },
  todayUtc: number
): AttentionItem[] {
  if (!input.liabilitiesIncluded) return [];
  const items: AttentionItem[] = [];
  const debts = input.liabilities ?? [];
  const dismissed = input.dismissed;

  if (debts.length === 0 && (input.accountCount ?? 0) > 0 && !dismissed?.has('add-debts')) {
    items.push({
      kind: 'add-debts',
      message: 'Add your debts to see your net worth',
      action: 'add-debts',
      dismissKey: 'add-debts',
    });
  }

  const linked = new Set(debts.map((d) => d.linked_position_id).filter(Boolean));
  for (const p of input.positions) {
    if (p.position_type !== 'real_estate' || linked.has(p.id)) continue;
    const key = `property:${p.id}`;
    if (dismissed?.has(key)) continue;
    items.push({
      kind: 'property-unlinked',
      message: `Is ${p.name || p.ticker} financed?`,
      action: 'review-property',
      targetId: p.id,
      dismissKey: key,
    });
  }

  for (const d of debts) {
    if (d.is_amortizing || !d.last_reported_date) continue;
    const reported = Date.parse(`${d.last_reported_date.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(reported)) continue;
    if ((todayUtc - reported) / 86_400_000 <= STALE_BALANCE_DAYS) continue;
    items.push({
      kind: 'stale-balance',
      message: `Update the ${d.name} balance`,
      action: 'update-balance',
      targetId: d.id,
    });
  }
  return items;
}

export interface HeroPoint {
  date: string;
  /** Net worth in net-worth mode, total assets in portfolio mode. */
  value: number;
  assets: number;
  /** Total owed, or null in portfolio mode. */
  debts: number | null;
}

export interface HeroModel {
  mode: 'portfolio' | 'net-worth';
  label: string;
  value: number;
  assets: number;
  debts: number | null;
  /** "Assets $1,284,000.00 · Debts $412,300.00" in net-worth mode, otherwise null. */
  breakdown: string | null;
  dayChange: Change | null;
  rangeChange: Change | null;
  series: HeroPoint[];
}

function change(first: number, last: number): Change {
  return { amount: last - first, pct: first > 0 ? ((last - first) / first) * 100 : null };
}

/**
 * Hero figures for the dashboard. `history` should already be filtered to the
 * selected range. Net-worth mode needs liabilities_included and at least one
 * active liability; otherwise the hero is exactly the portfolio hero.
 */
export function heroModel(
  data: Pick<DashboardData, 'summary' | 'positions' | 'history'>
): HeroModel {
  const { summary, positions, history } = data;
  const assets = summary.total_value;
  const debtCount = summary.liabilities?.length ?? 0;
  const netWorthMode = summary.liabilities_included === true && debtCount > 0;
  const dayAssets = portfolioDayChange(positions, assets);

  if (!netWorthMode) {
    return {
      mode: 'portfolio',
      label: 'Portfolio value',
      value: assets,
      assets,
      debts: null,
      breakdown: null,
      dayChange: dayAssets,
      rangeChange: historyChange(history),
      series: history.map((h) => ({ date: h.date, value: h.total, assets: h.total, debts: null })),
    };
  }

  const debts = summary.liabilities_total ?? 0;
  const netWorth = summary.net_worth ?? assets - debts;
  const series = history.map((h): HeroPoint => {
    const owed = h.liabilities ?? 0;
    return { date: h.date, value: h.net_worth ?? h.total - owed, assets: h.total, debts: owed };
  });
  return {
    mode: 'net-worth',
    label: 'Net worth',
    value: netWorth,
    assets,
    debts,
    breakdown: `Assets ${formatCurrency(assets)} \u00b7 Debts ${formatCurrency(debts)}`,
    // Debts do not move intraday, so only assets contribute; percent is against yesterday's net worth.
    dayChange: dayAssets && {
      amount: dayAssets.amount,
      pct:
        netWorth - dayAssets.amount > 0
          ? (dayAssets.amount / (netWorth - dayAssets.amount)) * 100
          : null,
    },
    rangeChange:
      series.length < 2 ? null : change(series[0]!.value, series[series.length - 1]!.value),
    series,
  };
}
