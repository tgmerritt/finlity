/**
 * Pure portfolio math for the dashboard: allocation by asset class, day and
 * range changes, account grouping and "needs attention" items.
 *
 * No DOM or network access, so every function is unit tested.
 */
import type { AccountResponse, DashboardPosition, SnapshotHistory } from '@/types/api';

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

/** Target as a percentage, accepting fractions (0.6) or percentages (60). */
function targetPercent(
  targets: Record<string, unknown> | null | undefined,
  cls: AllocationClass
): number | null {
  const raw = targets?.[TARGET_KEYS[cls]];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw <= 1 ? raw * 100 : raw;
}

export function hasTargets(targets: Record<string, unknown> | null | undefined): boolean {
  return ALLOCATION_CLASSES.some((cls) => (targetPercent(targets, cls) ?? 0) > 0);
}

export function allocationVsTarget(
  positions: DashboardPosition[],
  targets: Record<string, unknown> | null | undefined,
  bandPct = 5
): AllocationRow[] {
  const totals: Record<AllocationClass, number> = { stocks: 0, bonds: 0, cash: 0, alternatives: 0 };
  let sum = 0;
  for (const p of positions) {
    const value = p.value || 0;
    totals[classifyPosition(p)] += value;
    sum += value;
  }
  const withTargets = hasTargets(targets);
  return ALLOCATION_CLASSES.map((cls): AllocationRow => {
    const actualPct = sum > 0 ? (totals[cls] / sum) * 100 : 0;
    const targetPct = withTargets ? (targetPercent(targets, cls) ?? 0) : null;
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
      return Math.round((today - startOfYear) / 86_400_000);
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

export type AccountGroupKey = 'retirement' | 'taxable' | 'cash';

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
};

function groupKey(a: AccountResponse): AccountGroupKey {
  if (CASH_ACCOUNT_TYPES.has(a.account_type)) return 'cash';
  return a.is_retirement ? 'retirement' : 'taxable';
}

export function groupAccounts(
  accounts: AccountResponse[],
  positions: DashboardPosition[],
  totalValue: number
): AccountGroup[] {
  const order: AccountGroupKey[] = ['retirement', 'taxable', 'cash'];
  return order
    .map((key): AccountGroup => {
      const rows = accounts
        .filter((a) => groupKey(a) === key)
        .map((a): AccountRow => {
          let dayChange: number | null = null;
          for (const p of positions) {
            if (p.account !== a.name) continue;
            const change = positionDayChange(p);
            if (change !== null) dayChange = (dayChange ?? 0) + change;
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
  kind: 'stale-prices' | 'cd-maturing' | 'duplicates' | 'alert';
  message: string;
  action: 'refresh-prices' | 'show-duplicates' | 'open-holdings' | 'open-analysis';
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

  return items;
}
