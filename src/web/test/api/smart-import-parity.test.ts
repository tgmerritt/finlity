/**
 * Browser half of the smart import parity scenario. Runs
 * tests/fixtures/smart_import_scenario.json through tryLocalRoute against a
 * fresh browser database and compares with the file the server path produced
 * (tests/api/test_smart_import_parity.py). Money within 0.01, the rest exact,
 * error_type and detail included.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../database/helpers'; // points sql.js at the wasm binary
import { clientDB } from '@/database/client-database';
import { LocalHttpError } from '@/database/local-error';
import { tryLocalRoute, resetLocalAPICache } from '@/api/dispatcher';
import { connectionIds } from '@/database/local-connections-store';

const FIXTURES = path.resolve(process.cwd(), '../../tests/fixtures');

type Row = Record<string, unknown>;

interface Step {
  name: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path?: string;
  body?: unknown;
  save?: Record<string, string>;
  probe?: string;
  db?: string;
  id?: string;
  expense_name?: string;
  amount?: number;
  content_hash?: string;
  file_name?: string;
  value?: unknown;
}
interface Scenario {
  today: string;
  setup: {
    categories: Array<{ id: string; name: string; sort_order: number }>;
    liabilities: Row[];
    snapshots: Row[];
    expenses: Row[];
  };
  steps: Step[];
}
interface Result {
  name: string;
  ok?: unknown;
  error?: number;
  error_type?: unknown;
  detail?: unknown;
}

const scenario = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'smart_import_scenario.json'), 'utf8')
) as Scenario;
const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'smart_import_scenario.expected.json'), 'utf8')
) as Result[];

const ID_KEYS = new Set([
  'id',
  'import_id',
  'liability_id',
  'expense_id',
  'created_expense_id',
  'last_import_id',
  'target_id',
  'source_ref',
  // Connection ids: the scenario's stored ones are fixed; ids minted by a
  // create (plan B7) become placeholders like any other generated id.
  'connection_id',
]);
const TIMESTAMP_KEYS = new Set([
  'created_at',
  'updated_at',
  'imported_at',
  'analyzed_at',
  'uploaded_at',
]);

/** Connection ids the scenario writes itself (store_connections, store_connection_secret). */
function storedConnectionIds(): string[] {
  const ids: string[] = [];
  for (const st of scenario.steps) {
    if (st.db === 'store_connections') {
      ids.push(...Object.keys((st.value as { items: Record<string, unknown> }).items));
    } else if (st.db === 'store_connection_secret') {
      ids.push(st.id!);
    }
  }
  return ids;
}

function makeNormalizer(): (value: unknown, key?: string) => unknown {
  const s = scenario.setup;
  const fixed = new Set<string>([
    ...s.categories.map((r) => r.id),
    ...[...s.liabilities, ...s.snapshots, ...s.expenses].map((r) => String(r['id'])),
    ...scenario.steps.filter((st) => st.db === 'insert_legacy_import').map((st) => st.id!),
    ...storedConnectionIds(),
  ]);
  const seen = new Map<string, string>();
  const norm = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => norm(v, key));
    if (value !== null && typeof value === 'object') {
      const obj = value as Row;
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
  for (const l of s.liabilities) {
    clientDB.execute(
      `INSERT INTO liabilities (id, name, liability_type, lender, current_balance, balance_as_of,
         is_amortizing, is_active) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        l['id'],
        l['name'],
        l['liability_type'],
        l['lender'],
        l['current_balance'],
        l['balance_as_of'],
        l['is_active'] ? 1 : 0,
      ]
    );
  }
  for (const x of s.snapshots) {
    clientDB.execute(
      `INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source)
       VALUES (?, ?, ?, ?, ?)`,
      [x['id'], x['liability_id'], x['snapshot_date'], x['balance'], x['source']]
    );
  }
  for (const e of s.expenses) {
    clientDB.execute(
      `INSERT INTO budget_expenses (id, category_id, name, amount, frequency, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [e['id'], e['category_id'], e['name'], e['amount'], e['frequency'], e['is_active'] ? 1 : 0]
    );
  }
}

function count(table: string, where = '1=1'): number {
  return clientDB.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)[0]!.c;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const day = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 10) : v);

function probe(kind: string): unknown {
  switch (kind) {
    case 'counts': {
      const tables = [
        'bank_statement_imports',
        'smart_import_meta',
        'import_transactions',
        'merchant_rules',
        'smart_import_ledger',
        'recurring_candidates',
        'budget_expenses',
        'liabilities',
        'liability_balance_snapshots',
      ];
      const out: Record<string, number> = Object.fromEntries(tables.map((t) => [t, count(t)]));
      out['smart_import_settings_rows'] = count('app_settings', "key = 'smart_import'");
      return out;
    }
    case 'imports_raw':
      return clientDB
        .query<Row & { content_hash: string }>(
          'SELECT content_hash, file_name, row_count, status FROM bank_statement_imports'
        )
        .sort((a, b) => cmp(a.content_hash, b.content_hash));
    case 'transactions':
      return clientDB
        .query<Row & { dedupe_key: string }>(
          `SELECT import_id, account_key, posted_date, amount, description, merchant_key, kind,
                  category_id, category_source, dedupe_key FROM import_transactions`
        )
        .map((r) => ({ ...r, posted_date: day(r['posted_date']) }))
        .sort((a, b) => cmp(a.dedupe_key, b.dedupe_key));
    case 'rules':
      return clientDB
        .query<
          Row & { merchant_key: string; created_at: string | null; updated_at: string | null }
        >(
          `SELECT merchant_key, category_id, kind, hits, source, last_import_id, created_at, updated_at
             FROM merchant_rules`
        )
        .map(({ created_at, updated_at, ...rest }) => ({
          ...rest,
          has_updated_at: updated_at !== null,
          updated_since_created: updated_at !== created_at,
        }))
        .sort((a, b) => cmp(a.merchant_key, b.merchant_key));
    case 'expenses':
      return clientDB
        .query<Row & { name: string; amount: number }>(
          'SELECT id, name, amount, frequency, category_id, entity_id, is_active FROM budget_expenses'
        )
        .map((r) => ({ ...r, is_active: Boolean(r['is_active']) }))
        .sort((a, b) => cmp(a.name, b.name) || a.amount - b.amount);
    case 'candidates':
      return clientDB
        .query<Row & { name: string; status: string }>(
          `SELECT import_id, name, amount, frequency, occurrences, status, created_expense_id
             FROM recurring_candidates`
        )
        .sort((a, b) => cmp(a.name, b.name) || cmp(a.status, b.status));
    case 'liabilities':
      return clientDB
        .query<Row & { id: string }>('SELECT id, current_balance, balance_as_of FROM liabilities')
        .sort((a, b) => cmp(a.id, b.id))
        .map((l) => ({
          ...l,
          balance_as_of: day(l['balance_as_of']),
          snapshots: clientDB
            .query<Row & { snapshot_date: string }>(
              `SELECT snapshot_date, balance, source, source_ref FROM liability_balance_snapshots
                WHERE liability_id = ?`,
              [l.id]
            )
            .map((x) => ({ ...x, snapshot_date: day(x.snapshot_date) as string }))
            .sort((a, b) => cmp(a.snapshot_date, b.snapshot_date)),
        }));
    case 'ledger': {
      const out: Record<string, number> = {};
      for (const r of clientDB.query<{ action: string }>(
        'SELECT action FROM smart_import_ledger'
      )) {
        out[r.action] = (out[r.action] ?? 0) + 1;
      }
      return out;
    }
    case 'connections':
      return {
        ids: [...connectionIds(clientDB)].sort(cmp),
        secret_rows: count('app_settings', "key LIKE 'connection_secret:%'"),
      };
    default:
      throw new Error(`unknown probe ${kind}`);
  }
}

function dbOp(step: Step): void {
  switch (step.db) {
    case 'edit_expense':
      clientDB.execute('UPDATE budget_expenses SET amount = ? WHERE name = ?', [
        step.amount,
        step.expense_name,
      ]);
      break;
    case 'store_connections':
      // The connections row as the connection store writes it (plan B3). Replaces the row.
      clientDB.execute(
        `INSERT INTO app_settings (key, value, encrypted) VALUES ('connections', ?, 0)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [JSON.stringify(step.value)]
      );
      break;
    case 'store_connection_secret':
      // A stand-in sealed secret row (plan B4): disconnect deletes it without unsealing.
      clientDB.execute(
        "INSERT INTO app_settings (key, value, encrypted) VALUES (?, 'wc1:parity', 1)",
        [`connection_secret:${step.id!}`]
      );
      break;
    case 'insert_legacy_import':
      clientDB.execute(
        `INSERT INTO bank_statement_imports (id, file_name, content_hash, row_count, status, uploaded_at, analyzed_at)
         VALUES (?, ?, ?, 3, 'analyzed', '2026-01-15 09:30:00', '2026-01-15 09:31:00')`,
        [step.id, step.file_name, step.content_hash]
      );
      break;
    default:
      throw new Error(`unknown db op ${String(step.db)}`);
  }
}

function pick(body: unknown, dotted: string): string {
  let value = body;
  for (const part of dotted.split('.')) {
    value = Array.isArray(value) ? value[Number(part)] : (value as Row)[part];
  }
  return value as string;
}

/** Replace "{alias}" string values in a request body with saved ids. */
function substitute(value: unknown, aliases: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => substitute(v, aliases));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Row).map(([k, v]) => [k, substitute(v, aliases)])
    );
  }
  const match = typeof value === 'string' ? value.match(/^\{(\w+)\}$/) : null;
  return match ? aliases[match[1]!] : value;
}

function runScenario(): Result[] {
  const norm = makeNormalizer();
  const aliases: Record<string, string> = {};
  const results: Result[] = [];
  for (const step of scenario.steps) {
    // Each step happens a second later, so a second rule upsert moves updated_at
    // (the server's clock always moves between requests).
    vi.setSystemTime(new Date(Date.now() + 1000));
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
      const options: { method?: Step['method']; body?: unknown } = { method: step.method };
      if (step.body !== undefined) options.body = substitute(step.body, aliases);
      const body = tryLocalRoute(endpoint, options);
      for (const [alias, dotted] of Object.entries(step.save ?? {})) {
        aliases[alias] = pick(body, dotted);
      }
      results.push({ name: step.name, ok: norm(JSON.parse(JSON.stringify(body))) });
    } catch (e) {
      if (!(e instanceof LocalHttpError)) throw e;
      const data = (e.data ?? {}) as { error_type?: unknown; detail?: unknown };
      results.push({
        name: step.name,
        error: e.status,
        error_type: data.error_type ?? null,
        detail: data.detail ?? e.message,
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
    const a = actual as Row;
    expect(Object.keys(a).sort(), `${where} keys`).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) expectMatch(a[k], (want as Row)[k], `${where}.${k}`);
  } else if (typeof want === 'number') {
    expect(typeof actual, where).toBe('number');
    expect(
      Math.abs((actual as number) - want),
      `${where}: ${String(actual)} vs ${want}`
    ).toBeLessThanOrEqual(0.01);
  } else {
    expect(actual, where).toEqual(want);
  }
}

/**
 * Ids whose string order is the reverse of creation order, so any ordering that
 * falls back to an id (the server's ids are random) shows up as a diff.
 */
function useDescendingUuids(): () => void {
  const original = globalThis.crypto.randomUUID;
  let n = 0;
  globalThis.crypto.randomUUID = (() =>
    `id-${String(999999 - ++n).padStart(6, '0')}`) as typeof original;
  return () => {
    globalThis.crypto.randomUUID = original;
  };
}

describe('smart import parity scenario (browser path)', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [y, m, d] = scenario.today.split('-').map(Number) as [number, number, number];
    vi.setSystemTime(new Date(y, m - 1, d, 9, 0, 0));
    restoreUuids = useDescendingUuids();
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

  it('normalizes minted connection ids and keeps the stored ones (plan B7)', () => {
    const norm = makeNormalizer();
    const stored = storedConnectionIds()[0]!;
    const minted = '9f8e7d6c-5b4a-4398-8776-655443322110';
    expect(norm({ connection_id: minted, id: minted })).toEqual({
      connection_id: '<id-1>',
      id: '<id-1>',
    });
    expect(norm({ connection_id: stored })).toEqual({ connection_id: stored });
  });
});
