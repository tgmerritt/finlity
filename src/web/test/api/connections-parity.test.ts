/**
 * Browser half of the connections parity scenario (plan B7, design 13). Runs
 * tests/fixtures/connections_scenario.json through `apiCall` in local data
 * mode, so the B6 composites (create, refresh, sync) and the `local()` routes
 * (list, detail, update, disconnect, smart import) answer it from a fresh
 * browser database, and compares with the file the server path produced
 * (tests/api/test_connections_parity.py). Money within 0.01, the rest exact,
 * error_type and detail included.
 *
 * The test transport: `fetch` answers only /api/v2/connectors/*, from
 * connections_scenario.v2.json, which the server run records from the real v2
 * routes. For each step the composites must make exactly the provider calls
 * the server's service made, in order, and each request must equal the
 * server's (the plan window, every account's `since`, key, kind and flip, and
 * the profile's rules and categories). Any other URL fails the test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '../database/helpers'; // points sql.js at the wasm binary
import { store } from '@/state/store';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache } from '@/api/dispatcher';
import { apiCall, ApiError } from '@/api/client';
import { resetConnectorStatusCache } from '@/api/connections-composite';
import { readConnections } from '@/database/local-connections-store';
import { SmartImportHttpError } from '@/database/local-smart-import';
import { installWebCrypto } from '../utils/webcrypto-support';

const FIXTURES = path.resolve(process.cwd(), '../../tests/fixtures');

type Row = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface ApplySync {
  sync: string;
  connection: string;
  batch_id: string;
  liabilities: Record<string, string>;
  rules?: Row[];
}
interface Step {
  name: string;
  method?: Method;
  path?: string;
  body?: unknown;
  save?: Record<string, string>;
  save_body?: string;
  apply_sync?: ApplySync;
  probe?: string;
  db?: string;
  id?: string;
  entry?: Row;
  recent_requests?: number;
  clock?: string;
}
interface ErrorCode {
  paths: 'both' | 'both-via-v2' | 'server-only' | 'browser-only';
  reached: boolean;
  why_not_reached?: string;
  status?: number;
  detail?: string;
}
interface Scenario {
  today: string;
  divergences: {
    allowlist: Array<{ id: string; handling: string }>;
    error_codes: Record<string, ErrorCode>;
    known: Array<{ id: string; handling: string }>;
  };
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
interface V2Call {
  path: string;
  request: Row;
  status: number;
  response: unknown;
}
interface V2File {
  status: unknown;
  calls: Record<string, V2Call[]>;
}

const read = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
const scenario = read<Scenario>('connections_scenario.json');
const expected = read<Result[]>('connections_scenario.expected.json');
const v2File = read<V2File>('connections_scenario.v2.json');

const ID_KEYS = new Set([
  'id',
  'import_id',
  'liability_id',
  'expense_id',
  'created_expense_id',
  'last_import_id',
  'target_id',
  'source_ref',
  'connection_id',
  'ids',
]);
const TIMESTAMP_KEYS = new Set([
  'created_at',
  'updated_at',
  'imported_at',
  'analyzed_at',
  'uploaded_at',
  'status_at',
  'last_synced_at',
  'quota_resets_at',
]);

function fixedIds(): Set<string> {
  const s = scenario.setup;
  return new Set<string>([
    ...s.categories.map((r) => r.id),
    ...[...s.liabilities, ...s.snapshots, ...s.expenses].map((r) => String(r['id'])),
    ...scenario.steps.filter((st) => st.db === 'put_connection').map((st) => st.id!),
  ]);
}

function makeNormalizer(): (value: unknown, key?: string) => unknown {
  const fixed = fixedIds();
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

/**
 * A v2 request as the transport file keeps it. Allowlisted divergence
 * `rule-ids`: each path mints its own merchant rule ids and the v2 core never
 * reads them, so they are left out (the server side does the same).
 */
function v2Request(body: Row): Row {
  const out = JSON.parse(JSON.stringify(body)) as Row;
  const context = out['context'] as { rules?: unknown } | undefined;
  if (context && Array.isArray(context.rules)) {
    context.rules = (context.rules as Row[]).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id'))
    );
  }
  return out;
}

// --- database --------------------------------------------------------------------------------

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

function count(table: string): number {
  return clientDB.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const day = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 10) : v);

/** Connections in list order: (created_at, id). */
function storedOrder(): Array<[string, { created_at: string; requests: string[] }]> {
  const items = readConnections(clientDB).items as unknown as Record<
    string,
    { created_at: string; requests: string[] }
  >;
  return Object.entries(items).sort(
    ([a, x], [b, y]) => cmp(x.created_at, y.created_at) || cmp(a, b)
  );
}

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
      return Object.fromEntries(tables.map((t) => [t, count(t)]));
    }
    case 'transaction_counts': {
      const out: Record<string, number> = {};
      for (const r of clientDB.query<{ account_key: string }>(
        'SELECT account_key FROM import_transactions'
      )) {
        out[r.account_key] = (out[r.account_key] ?? 0) + 1;
      }
      return out;
    }
    case 'liabilities':
      return clientDB
        .query<Row & { id: string }>('SELECT id, current_balance, balance_as_of FROM liabilities')
        .sort((a, b) => cmp(a.id, b.id))
        .map((l) => ({
          ...l,
          balance_as_of: day(l['balance_as_of']),
          snapshots: clientDB
            .query<Row & { snapshot_date: string }>(
              `SELECT snapshot_date, balance, source FROM liability_balance_snapshots
                WHERE liability_id = ?`,
              [l.id]
            )
            .map((x) => ({ ...x, snapshot_date: day(x.snapshot_date) as string }))
            .sort((a, b) => cmp(a.snapshot_date, b.snapshot_date)),
        }));
    case 'connections': {
      const secrets = clientDB.query<{ c: number }>(
        "SELECT COUNT(*) AS c FROM app_settings WHERE key LIKE 'connection_secret:%'"
      )[0]!.c;
      return { ids: storedOrder().map(([id]) => id), secret_rows: secrets };
    }
    case 'requests':
      return storedOrder().map(([id, c]) => ({ connection_id: id, requests: c.requests.length }));
    default:
      throw new Error(`unknown probe ${kind}`);
  }
}

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z';

function dbOp(step: Step): void {
  if (step.db !== 'put_connection') throw new Error(`unknown db op ${String(step.db)}`);
  const n = step.recent_requests!;
  const now = Date.now();
  const entry = {
    ...step.entry,
    requests: Array.from({ length: n }, (_v, i) => stamp(now - (n - i) * 60_000)),
  };
  const raw = clientDB.query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'connections'"
  )[0];
  const doc = raw ? (JSON.parse(raw.value) as { items: Row }) : { version: 1, items: {} as Row };
  doc.items[step.id!] = entry;
  clientDB.execute(
    `INSERT INTO app_settings (key, value, encrypted) VALUES ('connections', ?, 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(doc)]
  );
}

// --- requests --------------------------------------------------------------------------------

/** tests/connectors/apply_contract.py as_apply: one statement as the wizard applies it. */
function asApply(st: Row, connectionId: string): Row {
  const account = st['account'] as Row;
  const key = account['key'] as string;
  const out: Row = Object.fromEntries(
    Object.entries(st).filter(([k]) => k !== 'extras' && k !== 'warnings')
  );
  if (st['origin'] === 'connector') out['connection_id'] = connectionId;
  out['account'] = { ...account, label: null };
  out['transactions'] = (st['transactions'] as Row[]).map((t) => ({
    ...Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'row' && k !== 'dedupe_base')),
    dedupe_key: `${key}|${String(t['dedupe_base'])}`,
  }));
  return out;
}

function applyBody(
  spec: ApplySync,
  saved: Record<string, Row>,
  aliases: Record<string, string>
): Row {
  const statements = (saved[spec.sync]!['statements'] as Row[]).map((st) => {
    const out = asApply(st, aliases[spec.connection]!);
    out['liability_id'] = spec.liabilities[(st['account'] as Row)['key'] as string] ?? null;
    return out;
  });
  return { batch_id: spec.batch_id, statements, rules: spec.rules ?? [], recurring: [] };
}

function pick(body: unknown, dotted: string): string {
  let value = body;
  for (const part of dotted.split('.')) {
    value = Array.isArray(value) ? value[Number(part)] : (value as Row)[part];
  }
  return value as string;
}

// --- transport -------------------------------------------------------------------------------

let pending: V2Call[] = [];
let stepName = '';
let unexpected: string[] = [];

function respond(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: '',
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** JSON with sorted keys, for comparing request bodies. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Row)
              .sort()
              .map((k) => [k, sort((v as Row)[k])])
          )
        : v;
  return JSON.stringify(sort(value));
}

function installTransport(): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/api/v2/connectors/status') {
      return respond(200, v2File.status);
    }
    const prefix = '/api/v2/connectors/';
    const call = pending.shift();
    if (method !== 'POST' || !url.startsWith(prefix) || call === undefined) {
      unexpected.push(`${stepName}: ${method} ${url}`);
      throw new TypeError('Failed to fetch');
    }
    // Recorded, not thrown: a throw here would reach the composite as a
    // provider failure and hide the reason.
    const sent = canonical(v2Request(JSON.parse(String(init?.body)) as Row));
    if (url.slice(prefix.length) !== call.path || sent !== canonical(call.request)) {
      unexpected.push(
        `${stepName}: ${url} sent ${sent}, the server sent ${canonical(call.request)}`
      );
    }
    return respond(call.status, call.response);
  }) as unknown as typeof fetch;
}

// --- run -------------------------------------------------------------------------------------

function setClock(dayText: string): void {
  const [y, m, d] = dayText.split('-').map(Number) as [number, number, number];
  vi.setSystemTime(new Date(y, m - 1, d, 9, 0, 0));
}

async function runScenario(): Promise<Result[]> {
  const norm = makeNormalizer();
  const aliases: Record<string, string> = {};
  const saved: Record<string, Row> = {};
  const results: Result[] = [];
  for (const step of scenario.steps) {
    vi.setSystemTime(new Date(Date.now() + 1000));
    stepName = step.name;
    if (step.clock) {
      setClock(step.clock);
      results.push({ name: step.name, ok: 'done' });
      continue;
    }
    if (step.db) {
      dbOp(step);
      results.push({ name: step.name, ok: 'done' });
      continue;
    }
    if (step.probe) {
      results.push({ name: step.name, ok: norm(probe(step.probe)) });
      continue;
    }
    let method: Method;
    let endpoint: string;
    let body: unknown;
    if (step.apply_sync) {
      method = 'POST';
      endpoint = '/api/smart-import/apply';
      body = applyBody(step.apply_sync, saved, aliases);
    } else {
      method = step.method!;
      endpoint = step.path!.replace(/\{(\w+)\}/g, (_m, k: string) => aliases[k]!);
      body = step.body;
    }
    pending = [...(v2File.calls[step.name] ?? [])];
    try {
      const options: { method: Method; body?: unknown } = { method };
      if (body !== undefined && body !== null) options.body = body;
      const answer = await apiCall<unknown>(endpoint, options);
      for (const [alias, dotted] of Object.entries(step.save ?? {})) {
        aliases[alias] = pick(answer, dotted);
      }
      if (step.save_body) saved[step.save_body] = answer as Row;
      results.push({ name: step.name, ok: norm(JSON.parse(JSON.stringify(answer))) });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const data = (e.data ?? {}) as { error_type?: unknown; detail?: unknown };
      results.push({
        name: step.name,
        error: e.status,
        error_type: data.error_type ?? null,
        detail: data.detail ?? e.message,
      });
    }
    expect(
      pending.map((c) => c.path),
      `${step.name}: provider calls the server made but this path did not`
    ).toEqual([]);
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
 * Canonical UUIDs whose string order is the reverse of creation order, so any
 * ordering that falls back to an id (the server's are random) shows up as a
 * diff. Connection ids must be canonical lowercase UUIDs.
 */
function useDescendingUuids(): () => void {
  const original = globalThis.crypto.randomUUID;
  let n = 0;
  globalThis.crypto.randomUUID = (() =>
    `ffffffff-ffff-4fff-bfff-${(0xffffffffffff - ++n).toString(16).padStart(12, '0')}`) as typeof original;
  return () => {
    globalThis.crypto.randomUUID = original;
  };
}

describe('connections parity scenario (browser path)', () => {
  let restoreUuids: () => void;
  let restoreCrypto: () => void;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setClock(scenario.today);
    // The seal key check runs before a SimpleFIN claim (the server's
    // store.check_key), so the claim step needs WebCrypto and IndexedDB.
    restoreCrypto = installWebCrypto();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    restoreUuids = useDescendingUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    resetConnectorStatusCache();
    store.resetState();
    store.set('dataMode', 'local');
    seed();
    pending = [];
    unexpected = [];
    installTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreUuids();
    restoreCrypto();
    clientDB.close();
  });

  it('produces the same results as the server path', async () => {
    const results = await runScenario();
    expect(unexpected, 'requests outside the recorded v2 calls').toEqual([]);
    expect(results.map((r) => r.name)).toEqual(expected.map((e) => e.name));
    results.forEach((actual, i) => expectMatch(actual, expected[i], expected[i]!.name));
  });

  it('replays every recorded v2 call and only for steps of the scenario', () => {
    const names = new Set(scenario.steps.map((s) => s.name));
    for (const name of Object.keys(v2File.calls)) expect(names.has(name), name).toBe(true);
  });

  it('reaches or explains every connection error code, and the catalog follows each one', () => {
    // The browser catalog's answer for a code it does not know.
    const isFallback = (e: SmartImportHttpError): boolean =>
      e.status === 500 && e.message === 'Something went wrong.';
    const reached = new Set(expected.filter((r) => r.error !== undefined).map((r) => r.error_type));
    for (const [name, entry] of Object.entries(scenario.divergences.error_codes)) {
      expect(entry.reached, name).toBe(reached.has(name));
      if (!entry.reached) expect(entry.why_not_reached, name).toBeTruthy();
      const own = new SmartImportHttpError(name);
      if (entry.paths === 'both') {
        expect([own.status, own.message], name).toEqual([entry.status, entry.detail]);
      } else if (entry.paths === 'both-via-v2') {
        // The composites relay the v2 route's own body; a catalog copy must agree.
        if (!isFallback(own))
          expect([own.status, own.message], name).toEqual([entry.status, entry.detail]);
      } else if (entry.paths === 'server-only') {
        expect(isFallback(own), name).toBe(true);
      } else {
        expect(isFallback(own), name).toBe(false);
      }
    }
    for (const r of expected) {
      if (r.error !== undefined)
        expect(scenario.divergences.error_codes[String(r.error_type)]).toBeDefined();
    }
  });

  it('applies exactly the allowlisted normalizations', () => {
    expect(scenario.divergences.allowlist.map((a) => a.id)).toEqual([
      'minted-ids',
      'wall-clock-stamps',
      'rule-ids',
      'v2-status-call',
    ]);
    for (const key of TIMESTAMP_KEYS) {
      expect(JSON.stringify(scenario.divergences.allowlist[1]), key).toContain(key);
    }
  });

  it('normalizes minted ids and keeps the scenario ids', () => {
    const norm = makeNormalizer();
    const minted = '9f8e7d6c-5b4a-4398-8776-655443322110';
    const stored = scenario.steps.find((s) => s.db === 'put_connection')!.id!;
    expect(norm({ connection_id: minted, id: minted, ids: [minted, stored] })).toEqual({
      connection_id: '<id-1>',
      id: '<id-1>',
      ids: ['<id-1>', stored],
    });
    expect(norm({ last_synced_at: '2026-10-04T09:00:00Z', quota_resets_at: null })).toEqual({
      last_synced_at: '<ts>',
      quota_resets_at: null,
    });
  });
});
