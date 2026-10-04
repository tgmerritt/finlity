/**
 * Browser twin of src/connectors/store.py: the `connections` row of
 * app_settings (design 7.1), one JSON document holding every connection's
 * metadata and never a credential, plus the read-only queries the sync plan
 * needs (design 9.1).
 *
 * `sanitize` mirrors `store.sanitize` rule for rule, and every read runs it,
 * so a hand-edited or corrupt row degrades to its valid entries. The shared
 * fixture tests/fixtures/connections_sanitize_cases.json is generated from
 * the server and checked here. `connectionExists(db, id)` (plan B3, the hook
 * smart import Apply uses) is true exactly when the server's
 * `read_connections(...)["items"]` holds `id`.
 *
 * Kept apart from local-smart-import.ts so local-connections.ts can use the
 * smart import undo without an import cycle (the server keeps `store` apart
 * from `service` for the same reason). This module never imports it.
 *
 * Known gaps, reachable only by hand-editing the row, because JSON.parse
 * differs from Python's json.loads: `NaN` and `Infinity` literals make the
 * whole row unreadable here (Python keeps the valid entries); `30.0` reads as
 * the integer 30 here (Python sees a float and falls back to 90 days); and
 * integer-like object keys (an account id "123") are enumerated first here,
 * which only changes which accounts the 50-account cap keeps. Finlity itself
 * never writes any of these.
 */

import type { ClientDatabase } from './client-database';

export const CONNECTIONS_KEY = 'connections';
export const SECRET_KEY_PREFIX = 'connection_secret:';
export const MAX_CONNECTIONS = 10;
export const MAX_ACCOUNTS = 50;
export const MAX_LABEL_CHARS = 120;
export const MAX_PROVIDER_TEXT_CHARS = 200;
export const MAX_PROVIDER_ACCOUNT_ID_CHARS = 200;
export const MAX_REQUESTS = 64;
/** The rolling quota window, in microseconds (store.REQUEST_WINDOW). */
export const REQUEST_WINDOW_US = 24 * 3600 * 1_000_000;
export const PROVIDER_IDS = ['simplefin', 'akahu', 'demo'] as const;
export const STATUSES = [
  'ok',
  'accounts_pending',
  'reconnect_needed',
  'payment_required',
  'rate_limited',
  'error',
] as const;
export const ROLES = ['debt', 'cash_flow', 'ignore'] as const;
export const ACCOUNT_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'unknown'] as const;
export const FIRST_SYNC_DAYS = [30, 60, 90] as const;
export const DEFAULT_FIRST_SYNC_DAYS = 90;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ConnectionStatus = (typeof STATUSES)[number];
export type AccountRole = (typeof ROLES)[number];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface StoredAccount {
  name: string;
  institution: string | null;
  currency: string;
  kind: AccountKind;
  role: AccountRole;
  label: string;
  account_key: string;
  liability_id: string | null;
  flip_balance: boolean;
  same_as_key: string | null;
}

export interface StoredConnection {
  provider: ProviderId;
  label: string;
  created_at: string;
  status: ConnectionStatus;
  status_at: string;
  last_synced_at: string | null;
  first_sync_days: number;
  requests: string[];
  accounts: Record<string, StoredAccount>;
}

export interface ConnectionsDocument {
  version: 1;
  items: Record<string, StoredConnection>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CURRENCY = /^[A-Z]{3}$/;
const CONNECTOR_ACCOUNT_KEY = /^acct:[0-9a-f]{64}$/;
// Any account key the smart import settings accept: a "same as" mapping may name a file key.
// eslint-disable-next-line no-control-regex
const ANY_ACCOUNT_KEY = /^(acct|label):[^\x00-\x1f\x7f]{1,190}$/u;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Length in code points, like Python's len(). */
export const chars = (s: string): number => (s.length <= 1 ? s.length : Array.from(s).length);
const member = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v);

/**
 * Set an own property, even one named `__proto__`: provider account ids are
 * provider text, and a plain assignment would change the object's prototype.
 */
export function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** An own property only (never one inherited from Object.prototype). */
export function own<T>(target: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
}

/** A canonical lowercase UUID, the only id form the store keeps. */
export const isConnectionId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const MAX_LIABILITY_ID_CHARS = 64;
/**
 * store._is_liability_id: 1 to 64 characters, no control characters. Not only
 * UUIDs: smart import Apply links any existing debt, and the demo's debts have
 * ids such as `demo-card`.
 */
export const isLiabilityId = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && chars(v) <= MAX_LIABILITY_ID_CHARS && !CONTROL.test(v);

/** Code point order, which is Python's str order. */
export function cmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

function utcMillis(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const date = new Date(0);
  // setUTCFullYear keeps years 1 to 99 as they are (Date.UTC maps them to 19xx).
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

function daysInMonth(y: number, mo: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo, 0);
  return date.getUTCDate();
}

/**
 * store._parse_iso as an instant: microseconds since the epoch, or null when
 * the text is not ISO 8601 with seconds and an explicit offset that Python's
 * fromisoformat accepts (a real date, hour up to 23, no leap second, a whole
 * offset under 24 hours; Python does not range-check the offset's minutes).
 */
export function instantOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(ISO);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  let offsetMinutes = 0;
  if (m[9] !== undefined) {
    offsetMinutes = Number(m[10]) * 60 + Number(m[11]);
    if (offsetMinutes >= 24 * 60) return null;
    if (m[9] === '-') offsetMinutes = -offsetMinutes;
  }
  const micros = Number((m[7] ?? '').padEnd(6, '0'));
  return (utcMillis(y, mo, d, h, mi, s) - offsetMinutes * 60_000) * 1000 + micros;
}

/** store._parse_iso as a check. */
export const isStoreTimestamp = (v: unknown): boolean => instantOf(v) !== null;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** store.now_iso: UTC, whole seconds, `Z` (microseconds are dropped, not rounded). */
export function stampOf(micros: number): string {
  const date = new Date(Math.floor(micros / 1000));
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`
  );
}

/** The current instant in microseconds (millisecond precision in a browser). */
export const nowMicros = (): number => Date.now() * 1000;

/** store._text: a string within `max` code points with no control characters. */
function text(v: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof v !== 'string' || chars(v) > max || CONTROL.test(v)) return null;
  if (v === '' && !allowEmpty) return null;
  return v;
}

function cleanRequests(raw: unknown, now: number): string[] {
  if (!Array.isArray(raw)) return [];
  const cutoff = now - REQUEST_WINDOW_US;
  const kept: [number, string][] = [];
  for (const item of raw) {
    const when = instantOf(item);
    if (when !== null && cutoff < when && when <= now) kept.push([when, item as string]);
  }
  kept.sort((a, b) => a[0] - b[0]); // stable, like Python's sorted()
  return kept.slice(-MAX_REQUESTS).map(([, value]) => value);
}

function cleanAccount(raw: unknown): StoredAccount | null {
  if (!isObj(raw)) return null;
  const name = text(raw.name, MAX_PROVIDER_TEXT_CHARS, true);
  let institution = raw.institution ?? null;
  if (institution !== null) {
    institution = text(institution, MAX_PROVIDER_TEXT_CHARS, true);
    if (institution === null) return null;
  }
  const { currency, kind, role, account_key: accountKey } = raw;
  const label = text(raw.label, MAX_LABEL_CHARS, false);
  const liabilityId = raw.liability_id ?? null;
  const sameAsKey = raw.same_as_key ?? null;
  if (
    name === null ||
    !(typeof currency === 'string' && CURRENCY.test(currency)) ||
    !member(kind, ACCOUNT_KINDS) ||
    !member(role, ROLES) ||
    label === null ||
    !(typeof accountKey === 'string' && CONNECTOR_ACCOUNT_KEY.test(accountKey)) ||
    !(liabilityId === null || isLiabilityId(liabilityId)) ||
    !(sameAsKey === null || (typeof sameAsKey === 'string' && ANY_ACCOUNT_KEY.test(sameAsKey)))
  ) {
    return null;
  }
  return {
    name,
    institution: institution as string | null,
    currency,
    kind,
    role,
    label,
    account_key: accountKey,
    liability_id: liabilityId,
    flip_balance: raw.flip_balance === true,
    same_as_key: sameAsKey,
  };
}

function cleanAccounts(raw: unknown): Record<string, StoredAccount> {
  const clean: Record<string, StoredAccount> = {};
  if (!isObj(raw)) return clean;
  let count = 0;
  for (const [accountId, entry] of Object.entries(raw)) {
    if (count >= MAX_ACCOUNTS) break;
    if (text(accountId, MAX_PROVIDER_ACCOUNT_ID_CHARS, false) === null) continue;
    const account = cleanAccount(entry);
    if (account !== null) {
      put(clean, accountId, account);
      count += 1;
    }
  }
  return clean;
}

function cleanConnection(raw: unknown, now: number): StoredConnection | null {
  if (!isObj(raw)) return null;
  const { provider, created_at: createdAt, status } = raw;
  const label = text(raw.label, MAX_LABEL_CHARS, false);
  if (
    !member(provider, PROVIDER_IDS) ||
    label === null ||
    !isStoreTimestamp(createdAt) ||
    !member(status, STATUSES)
  ) {
    return null;
  }
  const days = raw.first_sync_days;
  return {
    provider,
    label,
    created_at: createdAt as string,
    status,
    status_at: isStoreTimestamp(raw.status_at) ? (raw.status_at as string) : (createdAt as string),
    last_synced_at: isStoreTimestamp(raw.last_synced_at) ? (raw.last_synced_at as string) : null,
    first_sync_days:
      typeof days === 'number' && (FIRST_SYNC_DAYS as readonly number[]).includes(days)
        ? days
        : DEFAULT_FIRST_SYNC_DAYS,
    requests: cleanRequests(raw.requests, now),
    accounts: cleanAccounts(raw.accounts),
  };
}

/**
 * store.sanitize: the valid part of a stored `connections` document. Unknown
 * keys are dropped; an invalid connection or account is dropped, not
 * repaired. At most 10 connections and 50 accounts each, in stored order.
 * `requests` keeps timestamps from the 24 hours before `now` (microseconds),
 * at most 64, oldest first.
 */
export function sanitize(raw: unknown, now: number = nowMicros()): ConnectionsDocument {
  const result: ConnectionsDocument = { version: 1, items: {} };
  const items = isObj(raw) ? raw.items : undefined;
  if (!isObj(items)) return result;
  let count = 0;
  for (const [id, entry] of Object.entries(items)) {
    if (count >= MAX_CONNECTIONS) break;
    if (!isConnectionId(id)) continue;
    const connection = cleanConnection(entry, now);
    if (connection !== null) {
      put(result.items, id, connection);
      count += 1;
    }
  }
  return result;
}

/** The parsed `connections` row, or null when there is none or it is not JSON. */
function readRaw(db: ClientDatabase): unknown {
  const row = db.query<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', [
    CONNECTIONS_KEY,
  ])[0];
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null; // corrupt or too deeply nested: read as empty, like the server
  }
}

/** store.read_connections: the sanitized document (empty without a row). Never writes. */
export function readConnections(db: ClientDatabase, now?: number): ConnectionsDocument {
  return sanitize(readRaw(db), now);
}

/** JSON with keys in code point order at every level, like json.dumps(sort_keys=True). */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (isObj(value)) {
    const keys = Object.keys(value).sort(cmp);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * store.write_connections: sanitize `data` and replace the row with it
 * (encrypted=0). Returns what was stored. The caller owns the transaction.
 */
export function writeConnections(
  db: ClientDatabase,
  data: unknown,
  now: number = nowMicros()
): ConnectionsDocument {
  const clean = sanitize(data, now);
  db.execute(
    `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0,
       updated_at = excluded.updated_at`,
    [CONNECTIONS_KEY, sortedJson(clean), stampOf(now)]
  );
  return clean;
}

/** The ids the sanitized document holds, in stored order (at most MAX_CONNECTIONS). */
export function connectionIds(db: ClientDatabase): string[] {
  return Object.keys(readConnections(db).items);
}

/** Plan B3 hook: `id` names a stored connection (smart import Apply's `connection_id` check). */
export function connectionExists(db: ClientDatabase, id: string): boolean {
  return isConnectionId(id) && own(readConnections(db).items, id) !== undefined;
}

// --- reads for the plan and the update checks (store.py, plan B2) -----------------
// None of these writes.

const marks = (n: number): string => Array(n).fill('?').join(',');

/** store.newest_import_ends: newest period_end per key among this connection's imports. */
export function newestImportEnds(
  db: ClientDatabase,
  connectionId: string,
  keys: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  const rows = db.query<{ account_key: string; period_end: string }>(
    `SELECT account_key, MAX(period_end) AS period_end FROM smart_import_meta
      WHERE connection_id = ? AND account_key IN (${marks(keys.length)})
        AND period_end IS NOT NULL
      GROUP BY account_key`,
    [connectionId, ...keys]
  );
  for (const row of rows) put(out, row.account_key, row.period_end);
  return out;
}

/** store.newest_posted_dates: newest stored posted_date per key. */
export function newestPostedDates(db: ClientDatabase, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  const rows = db.query<{ account_key: string; posted_date: string }>(
    `SELECT account_key, MAX(posted_date) AS posted_date FROM import_transactions
      WHERE account_key IN (${marks(keys.length)}) AND posted_date IS NOT NULL
      GROUP BY account_key`,
    keys
  );
  for (const row of rows) put(out, row.account_key, row.posted_date);
  return out;
}

/** store.imported_account_keys: every key a stored import used. */
export function importedAccountKeys(db: ClientDatabase): Set<string> {
  return new Set(
    db
      .query<{ account_key: string }>(
        'SELECT DISTINCT account_key FROM smart_import_meta WHERE account_key IS NOT NULL'
      )
      .map((r) => r.account_key)
  );
}

/** store.liability_exists: an id the store could not keep (isLiabilityId) is missing. */
export function liabilityExists(db: ClientDatabase, liabilityId: string): boolean {
  if (!isLiabilityId(liabilityId)) return false;
  return db.query('SELECT 1 FROM liabilities WHERE id = ?', [liabilityId]).length > 0;
}
