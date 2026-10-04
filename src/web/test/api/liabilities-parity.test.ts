/**
 * Browser half of the liabilities parity scenario. Runs
 * tests/fixtures/liabilities_scenario.json through tryLocalRoute against a
 * fresh browser database and compares with the file the server path produced
 * (tests/api/test_liabilities_parity.py). Money within 0.01, the rest exact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { LocalHttpError } from '@/database/local-error';
import { tryLocalRoute, resetLocalAPICache } from '@/api/dispatcher';

const FIXTURES = path.resolve(process.cwd(), '../../tests/fixtures');

interface Step {
  name: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path?: string;
  body?: unknown;
  save?: string;
  probe?: string;
  db?: string;
  id?: string;
  to?: string;
  table?: string;
  row?: Record<string, unknown>;
  price?: number;
}
interface Scenario {
  today: string;
  setup: {
    categories: Array<{ id: string; name: string; sort_order: number }>;
    accounts: Array<{ id: string; name: string; account_type: string }>;
    positions: Array<Record<string, unknown>>;
    expenses: Array<{
      id: string;
      category_id: string;
      name: string;
      amount: number;
      frequency: string;
    }>;
  };
  steps: Step[];
}
interface Result {
  name: string;
  ok?: unknown;
  error?: number;
  detail?: unknown;
}

const scenario = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'liabilities_scenario.json'), 'utf8')
) as Scenario;
const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'liabilities_scenario.expected.json'), 'utf8')
) as Result[];

const ID_KEYS = new Set([
  'id',
  'liability_id',
  'linked_position_id',
  'expense_id',
  'position_id',
  'account_id',
]);
const TIMESTAMP_KEYS = new Set(['created_at', 'updated_at']);
const EXACT_NUMBER_KEYS = new Set(['interest_rate', 'periods_remaining']);

function makeNormalizer(): (value: unknown, key?: string) => unknown {
  const fixed = new Set<string>(
    [
      ...scenario.setup.accounts,
      ...scenario.setup.positions,
      ...scenario.setup.expenses,
      ...scenario.steps.filter((s) => s.db === 'insert').map((s) => s.row!),
    ].map((r) => String(r['id']))
  );
  const seen = new Map<string, string>();
  const norm = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => norm(v, key));
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, norm(obj[k], k)])
      );
    }
    if (TIMESTAMP_KEYS.has(key)) return value ? '<ts>' : null;
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
  clientDB.execute('DELETE FROM budget_expense_categories');
  for (const c of s.categories) {
    clientDB.execute(
      'INSERT INTO budget_expense_categories (id, name, sort_order) VALUES (?, ?, ?)',
      [c.id, c.name, c.sort_order]
    );
  }
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
  for (const e of s.expenses) {
    clientDB.execute(
      'INSERT INTO budget_expenses (id, category_id, name, amount, frequency) VALUES (?, ?, ?, ?, ?)',
      [e.id, e.category_id, e.name, e.amount, e.frequency]
    );
  }
}

function count(table: string): number {
  return clientDB.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c;
}

function probe(kind: string): unknown {
  if (kind === 'counts') {
    return {
      liabilities: count('liabilities'),
      snapshots: count('liability_balance_snapshots'),
      accounts: count('accounts'),
      positions: count('positions'),
      expenses: count('budget_expenses'),
      categories: count('budget_expense_categories'),
    };
  }
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (kind === 'accounts') {
    return clientDB
      .query<{ name: string; account_type: string; entity_id: string | null }>(
        'SELECT name, account_type, entity_id FROM accounts'
      )
      .sort(byName);
  }
  if (kind === 'positions') {
    return clientDB
      .query<Record<string, unknown> & { name: string; purchase_date: string | null }>(
        `SELECT a.name AS account, p.name, p.ticker, p.shares, p.current_price, p.cost_basis, p.position_type, p.asset_class, p.purchase_date
         FROM positions p JOIN accounts a ON a.id = p.account_id`
      )
      .map((r) => ({ ...r, purchase_date: r.purchase_date ? r.purchase_date.slice(0, 10) : null }))
      .sort(byName);
  }
  return clientDB
    .query<
      Record<string, unknown> & {
        name: string;
        amount: number;
        is_mortgage: number;
        end_date: string | null;
      }
    >(
      `SELECT e.name, c.name AS category, e.amount, e.frequency, e.is_mortgage, e.principal_portion, e.interest_portion, e.end_date
       FROM budget_expenses e JOIN budget_expense_categories c ON c.id = e.category_id`
    )
    .map((r) => ({
      ...r,
      is_mortgage: Boolean(r.is_mortgage),
      end_date: r.end_date ? r.end_date.slice(0, 10) : null,
    }))
    .sort((a, b) => byName(a, b) || a.amount - b.amount);
}

function dbOp(step: Step): void {
  switch (step.db) {
    case 'rename_category':
      clientDB.execute('UPDATE budget_expense_categories SET name = ? WHERE id = ?', [
        step.to,
        step.id,
      ]);
      break;
    case 'delete_position':
      clientDB.execute('DELETE FROM positions WHERE id = ?', [step.id]);
      break;
    case 'delete_expense':
      clientDB.execute('DELETE FROM budget_expenses WHERE id = ?', [step.id]);
      break;
    case 'delete_all_expenses':
      clientDB.execute('DELETE FROM budget_expenses');
      break;
    case 'delete_all_categories':
      clientDB.execute('DELETE FROM budget_expense_categories');
      break;
    case 'insert': {
      if (!['positions', 'budget_expense_categories'].includes(step.table!)) {
        throw new Error(`unknown table ${String(step.table)}`);
      }
      const cols = Object.keys(step.row!);
      clientDB.execute(
        `INSERT INTO ${step.table!} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => step.row![c])
      );
      break;
    }
    case 'set_price':
      clientDB.execute('UPDATE positions SET current_price = ? WHERE id = ?', [
        step.price,
        step.id,
      ]);
      break;
    default:
      throw new Error(`unknown db op ${String(step.db)}`);
  }
}

function runScenario(): Result[] {
  const norm = makeNormalizer();
  const aliases: Record<string, string> = {};
  const results: Result[] = [];
  for (const step of scenario.steps) {
    if (step.db) {
      dbOp(step);
      results.push({ name: step.name, ok: 'done' });
      continue;
    }
    if (step.probe) {
      results.push({ name: step.name, ok: norm(probe(step.probe)) });
      continue;
    }
    const endpoint = step.path!.replace(/\{(\w+)\}/g, (_m, k: string) => aliases[k]!);
    try {
      const body = tryLocalRoute(endpoint, { method: step.method, body: step.body }) as {
        id?: string;
        liability?: { id: string };
      };
      if (step.save) aliases[step.save] = body.id ?? body.liability!.id;
      results.push({ name: step.name, ok: norm(JSON.parse(JSON.stringify(body))) });
    } catch (e) {
      if (!(e instanceof LocalHttpError)) throw e;
      results.push({
        name: step.name,
        error: e.status,
        detail: e.status === 422 ? '<validation>' : e.message,
      });
    }
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

describe('liabilities parity scenario (browser path)', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [y, m, d] = scenario.today.split('-').map(Number) as [number, number, number];
    vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    seed();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreUuids();
    clientDB.close();
  });

  it('produces the same results as the server path', () => {
    const results = runScenario();
    expect(results.map((r) => r.name)).toEqual(expected.map((e) => e.name));
    results.forEach((actual, i) => expectMatch(actual, expected[i], expected[i]!.name));
  });
});
