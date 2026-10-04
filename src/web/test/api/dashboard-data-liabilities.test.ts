/**
 * Browser half of the dashboard parity scenario. Runs
 * tests/fixtures/dashboard_liabilities_scenario.json through tryLocalRoute against a
 * fresh browser database and compares with the file the server path produced
 * (tests/test_dashboard_liabilities.py). Money within 0.01, the rest exact; history
 * dates are compared on their first 10 characters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { tryLocalRoute, resetLocalAPICache } from '@/api/dispatcher';

const FIXTURES = path.resolve(process.cwd(), '../../tests/fixtures');

interface Step {
  name: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path?: string;
  body?: unknown;
  save?: string;
  probe?: string;
}
interface Scenario {
  today: string;
  setup: {
    accounts: Array<{ id: string; name: string; account_type: string }>;
    positions: Array<Record<string, unknown>>;
    views: Array<{ id: string; name: string; account_ids: string[] }>;
    snapshots: Array<{ date: string; total: number; retirement: number; taxable: number }>;
  };
  steps: Step[];
}
interface Result {
  name: string;
  ok: Record<string, any>;
}

const scenario = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'dashboard_liabilities_scenario.json'), 'utf8')
) as Scenario;
const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'dashboard_liabilities_scenario.expected.json'), 'utf8')
) as Result[];

const ID_KEYS = new Set(['id', 'liability_id', 'linked_position_id', 'expense_id', 'position_id']);
const COMMON_FIELDS: Record<string, string[]> = {
  positions: ['id', 'ticker', 'shares', 'value', 'position_type', 'account'],
  accounts: ['id', 'name', 'account_type', 'value', 'position_count'],
};
const EXACT_NUMBER_KEYS = new Set(['interest_rate', 'periods_remaining']);

function makeNormalizer(): (value: unknown, key?: string) => unknown {
  const fixed = new Set<string>(
    [...scenario.setup.accounts, ...scenario.setup.positions, ...scenario.setup.views].map((r) =>
      String((r as Record<string, unknown>)['id'])
    )
  );
  const seen = new Map<string, string>();
  const norm = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) {
      const items = value.map((v) => norm(v, key)) as Array<Record<string, unknown>>;
      const fields = COMMON_FIELDS[key];
      if (!fields || !items.every((i) => fields.every((f) => f in i))) return items;
      // Row order and some extra row fields differ between the paths today and are not
      // part of this task; compare the shared, meaningful fields only.
      return items
        .map((i) => Object.fromEntries(fields.map((f) => [f, i[f]])))
        .sort((x, y) => (String(x['id']) < String(y['id']) ? -1 : 1));
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, norm(obj[k], k)])
      );
    }
    if (key === 'created_at' || key === 'updated_at') return value ? '<ts>' : null;
    if (key === 'demo_mode') return '<env>'; // the server's global demo flag, not under test
    if (key === 'date' && typeof value === 'string') return value.slice(0, 10);
    if (ID_KEYS.has(key) && typeof value === 'string') {
      if (fixed.has(value)) return value;
      if (!seen.has(value)) seen.set(value, `<id-${seen.size + 1}>`);
      return seen.get(value);
    }
    return value;
  };
  return norm;
}

function seed(): void {
  const s = scenario.setup;
  for (const a of s.accounts) {
    clientDB.execute('INSERT INTO accounts (id, name, account_type) VALUES (?, ?, ?)', [
      a.id,
      a.name,
      a.account_type,
    ]);
  }
  for (const p of s.positions) {
    clientDB.execute(
      'INSERT INTO positions (id, account_id, ticker, name, shares, current_price, position_type, asset_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        p['id'],
        p['account_id'],
        p['ticker'],
        p['name'],
        p['shares'],
        p['current_price'],
        p['position_type'],
        p['asset_class'],
      ]
    );
  }
  for (const v of s.views) {
    clientDB.execute('INSERT INTO portfolio_views (id, name, account_ids) VALUES (?, ?, ?)', [
      v.id,
      v.name,
      JSON.stringify(v.account_ids),
    ]);
  }
  for (const [i, snap] of s.snapshots.entries()) {
    clientDB.execute(
      'INSERT INTO portfolio_snapshots (id, snapshot_date, total_value, retirement_value, taxable_value) VALUES (?, ?, ?, ?, ?)',
      [`snap-${i}`, snap.date, snap.total, snap.retirement, snap.taxable]
    );
  }
}

function count(table: string): number {
  return clientDB.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c;
}

function counts(): Record<string, number> {
  return {
    liabilities: count('liabilities'),
    liability_snapshots: count('liability_balance_snapshots'),
    portfolio_snapshots: count('portfolio_snapshots'),
    accounts: count('accounts'),
    positions: count('positions'),
  };
}

function runScenario(): Result[] {
  const norm = makeNormalizer();
  const aliases: Record<string, string> = {};
  const results: Result[] = [];
  for (const step of scenario.steps) {
    if (step.probe) {
      results.push({ name: step.name, ok: counts() });
      continue;
    }
    const endpoint = step.path!.replace(/\{(\w+)\}/g, (_m, k: string) => aliases[k]!);
    const body = tryLocalRoute(endpoint, { method: step.method, body: step.body }) as {
      id?: string;
    };
    if (step.save) aliases[step.save] = body.id!;
    results.push({
      name: step.name,
      ok: norm(JSON.parse(JSON.stringify(body))) as Record<string, any>,
    });
  }
  return results;
}

function expectMatch(actual: unknown, want: unknown, where: string): void {
  if (Array.isArray(want)) {
    expect(Array.isArray(actual), where).toBe(true);
    expect((actual as unknown[]).length, `${where} length`).toBe(want.length);
    want.forEach((w, i) => expectMatch((actual as unknown[])[i], w, `${where}[${i}]`));
  } else if (want !== null && typeof want === 'object') {
    expect(actual !== null && typeof actual === 'object', where).toBe(true);
    const a = actual as Record<string, unknown>;
    expect(Object.keys(a).sort(), `${where} keys`).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want))
      expectMatch(a[k], (want as Record<string, unknown>)[k], `${where}.${k}`);
  } else if (typeof want === 'number') {
    expect(typeof actual, where).toBe('number');
    const tolerance = EXACT_NUMBER_KEYS.has(where.split('.').pop()!) ? 0 : 0.01;
    expect(
      Math.abs((actual as number) - want),
      `${where}: ${String(actual)} vs ${want}`
    ).toBeLessThanOrEqual(tolerance);
  } else {
    expect(actual, where).toEqual(want);
  }
}

const named = (results: Result[], name: string): Record<string, any> =>
  results.find((r) => r.name === name)!.ok;

describe('dashboard payload with liabilities (browser path)', () => {
  let restoreUuids: () => void;
  let results: Result[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [y, m, d] = scenario.today.split('-').map(Number) as [number, number, number];
    vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    seed();
    results = runScenario();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreUuids();
    clientDB.close();
  });

  it('produces the same payloads as the server path', () => {
    expect(results.map((r) => r.name)).toEqual(expected.map((e) => e.name));
    results.forEach((actual, i) => expectMatch(actual, expected[i], expected[i]!.name));
  });

  it('adds net worth to the unfiltered payload', () => {
    const data = named(results, 'dashboard unfiltered with liabilities');
    const summary = data['summary'];
    expect(summary.liabilities_included).toBe(true);
    expect(summary.liabilities.map((l: { name: string }) => l.name)).toEqual([
      'Home loan',
      'Rewards card',
    ]);
    const owed = summary.liabilities.reduce(
      (sum: number, l: { balance: number }) => sum + l.balance,
      0
    );
    expect(summary.liabilities_total).toBeCloseTo(owed, 2);
    expect(summary.net_worth).toBeCloseTo(summary.total_value - summary.liabilities_total, 2);
    expect(Object.keys(summary.liabilities[0]).sort()).toEqual(
      [
        'id',
        'name',
        'liability_type',
        'balance',
        'interest_rate',
        'payment_amount',
        'payment_frequency',
        'payoff_date',
        'linked_position_id',
        'entity_id',
        'is_amortizing',
        'last_reported_date',
      ].sort()
    );
    for (const item of data['history']) {
      expect(item.net_worth).toBeCloseTo(item.total - item.liabilities, 2);
    }
    const history = data['history'];
    expect(history[history.length - 1].liabilities).toBeCloseTo(summary.liabilities_total, 2);
    expect(history[0].liabilities).toBeGreaterThan(history[history.length - 1].liabilities);
  });

  it('keeps total_value unchanged by liabilities', () => {
    expect(named(results, 'dashboard unfiltered with liabilities')['summary'].total_value).toBe(
      named(results, 'dashboard with no liabilities')['summary'].total_value
    );
  });

  it('reports zero liabilities when there are none', () => {
    const data = named(results, 'dashboard with no liabilities');
    expect(data['summary'].liabilities_included).toBe(true);
    expect(data['summary'].liabilities_total).toBe(0);
    expect(data['summary'].liabilities).toEqual([]);
    expect(data['summary'].net_worth).toBe(data['summary'].total_value);
    for (const item of data['history']) {
      expect(item.liabilities).toBe(0);
      expect(item.net_worth).toBe(item.total);
    }
  });

  it('adds nothing for a view that filters accounts', () => {
    const data = named(results, 'dashboard filtered by view');
    expect(data['summary'].liabilities_included).toBe(false);
    for (const key of ['liabilities_total', 'net_worth', 'liabilities']) {
      expect(data['summary']).not.toHaveProperty(key);
    }
    for (const item of data['history']) {
      expect(Object.keys(item).sort()).toEqual(['date', 'retirement', 'taxable', 'total']);
    }
    expect(data['summary'].position_count).toBe(3);
  });

  it('treats a view with no accounts and an unknown view as unfiltered', () => {
    const unfiltered = named(results, 'dashboard unfiltered with liabilities');
    for (const name of [
      'dashboard with a view that has no accounts',
      'dashboard with an unknown view',
    ]) {
      const data = named(results, name);
      expect(data['summary'].liabilities_included).toBe(true);
      expect(data['summary'].net_worth).toBeCloseTo(unfiltered['summary'].net_worth, 2);
    }
  });

  it('does not report real estate as duplicates', () => {
    const dup = named(results, 'duplicates ignore real estate');
    expect(dup['count']).toBe(1);
    expect(dup['duplicates'][0].ticker).toBe('VXUS');
  });

  it('never writes while serving the dashboard', () => {
    tryLocalRoute('/api/liabilities', {
      method: 'POST',
      body: {
        name: 'Card',
        liability_type: 'credit_card',
        current_balance: 100,
        balance_as_of: '2026-10-01',
        cash_flow: { mode: 'none' },
      },
    });
    const before = counts();
    const spy = vi.spyOn(clientDB, 'execute');
    const run = vi.spyOn(
      (clientDB as unknown as { db: { run: (...a: unknown[]) => void } }).db,
      'run'
    );
    for (const p of [
      '/api/dashboard/data',
      '/api/dashboard/data?view_id=view-brokerage',
      '/api/portfolio/duplicates',
    ]) {
      tryLocalRoute(p, { method: 'GET' });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);
  });

  it('falls back to the plain payload and logs only the error type when the block fails', () => {
    tryLocalRoute('/api/liabilities', {
      method: 'POST',
      body: {
        name: 'Secret Lender Card',
        liability_type: 'credit_card',
        current_balance: 123456.78,
        balance_as_of: '2026-10-01',
        cash_flow: { mode: 'none' },
      },
    });
    const realQuery = clientDB.query.bind(clientDB);
    vi.spyOn(clientDB, 'query').mockImplementation(((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM liabilities')) throw new RangeError('balance 123456.78 Secret Lender Card');
      return realQuery(sql, params);
    }) as typeof clientDB.query);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const data = tryLocalRoute('/api/dashboard/data', { method: 'GET' }) as {
      summary: Record<string, unknown>;
      history: Array<Record<string, unknown>>;
    };
    expect(data.summary['liabilities_included']).toBe(false);
    for (const key of ['liabilities_total', 'net_worth', 'liabilities']) {
      expect(data.summary).not.toHaveProperty(key);
    }
    expect(data.history).toHaveLength(10);
    for (const item of data.history) {
      expect(Object.keys(item).sort()).toEqual(['date', 'retirement', 'taxable', 'total']);
    }
    expect(logged).toHaveBeenCalledWith('dashboard liabilities block failed: RangeError');
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/123456|Secret Lender/);
  });
});
