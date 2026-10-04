/**
 * Browser twin of src/connectors/service.py for hosted mode (LocalAPI, plans
 * B4 and B5). Hosted visitors keep their connections in the browser
 * database: the metadata in the `connections` row (local-connections-store.ts)
 * and each credential in `connection_secret:<id>`, sealed (`wc1:`) by the
 * client.ts composites before it gets here. Nothing here seals, unseals or
 * calls a provider: LocalAPI is synchronous, so the composites (plan B6) do
 * the WebCrypto and v2 round trips and call these steps around them:
 *
 *   create:    v2 claim, seal, createConnection, beginConnectionCall,
 *              v2 accounts, mergeConnectionAccounts (or recordConnectionResult
 *              with the failure; the connection and its credential stay)
 *   reconnect: v2 claim, seal, replaceConnectionSecret, then as create
 *   refresh:   beginConnectionCall, unseal, v2 accounts, mergeConnectionAccounts
 *   sync:      getConnectionSyncPlan, beginConnectionCall, unseal, v2 sync,
 *              recordConnectionResult
 *
 * The rules match the server: the same validation, catalog errors and
 * shapes, the plan from applied imports (design 9.1, so Undo rewinds it), the
 * quota per rolling 24 hours, and the status a provider answer implies
 * (design 8.3).
 *
 * Counting and concurrency (B5 review). As on the server, a request is counted
 * before the call: beginConnectionCall reserves one timestamp once its gates
 * pass, and a result with `requested: false` (no provider call was made, for
 * example an unreadable seal or a v2 refusal) releases it. The merge or the
 * result of a reserved call counts nothing more, so a call is never counted
 * twice. Only one call per connection is out at a time in a tab: a second
 * beginConnectionCall, a composite holding the connection (holdConnection)
 * and Disconnect all get 409 `connection_busy` meanwhile; Disconnect refuses
 * rather than waits, because LocalAPI is synchronous. The state is per
 * browser database and per tab; each hosted tab has its own database copy.
 *
 * Tab close. The reservation is written to the in-memory database, which the
 * app saves to IndexedDB every 30 seconds and on explicit saves. So a call in
 * flight when the tab closes may not be counted (its reservation was never
 * saved), a call is never counted twice, and a finished call's count (or any
 * other change since the last save) can be lost the same way.
 *
 * Every write reads the sanitized document, changes it, writes it back
 * sanitized and checks that every connection and account the change left is
 * still there (otherwise `save_failed`), all inside one SAVEPOINT.
 *
 * Nothing here logs a credential, label, account name, institution,
 * description or amount: event names, connection ids, counts and error types.
 * The hosted browser has no demo protection (the demo is a private copy).
 */

import type { ClientDatabase } from './client-database';
import { LocalHttpError } from './local-error';
import {
  ACCOUNT_KINDS,
  DEFAULT_FIRST_SYNC_DAYS,
  FIRST_SYNC_DAYS,
  MAX_ACCOUNTS,
  MAX_CONNECTIONS,
  MAX_LABEL_CHARS,
  MAX_PROVIDER_ACCOUNT_ID_CHARS,
  MAX_PROVIDER_TEXT_CHARS,
  PROVIDER_IDS,
  REQUEST_WINDOW_US,
  ROLES,
  SECRET_KEY_PREFIX,
  chars,
  cmp,
  importedAccountKeys,
  instantOf,
  isConnectionId,
  liabilityExists,
  newestImportEnds,
  newestPostedDates,
  nowMicros,
  own,
  put,
  readConnections,
  stampOf,
  writeConnections,
  type AccountKind,
  type ConnectionStatus,
  type ConnectionsDocument,
  type ProviderId,
  type StoredAccount,
  type StoredConnection,
} from './local-connections-store';
import {
  SmartImportHttpError,
  connectionImportIds,
  suggestLiability,
  undoInside,
} from './local-smart-import';
import { today } from '@/utils/clock';
import { isSealedValue } from '@/utils/credential-vault';
import type {
  ConnectionAccountError,
  ConnectionCallStart,
  ConnectionDetail,
  ConnectionListingResponse,
  ConnectionSummary,
  ConnectionSyncPlan,
  ConnectorSyncAccount,
  DisconnectResponse,
} from '@/types/api';

export { SECRET_KEY_PREFIX };

const DISPLAY_NAMES: Record<ProviderId, string> = {
  simplefin: 'SimpleFIN',
  akahu: 'Akahu',
  demo: 'Demo',
};
/** limits.DAILY_BUDGET: provider calls per connection per rolling 24 hours; none for the demo. */
const DAILY_BUDGET: Partial<Record<ProviderId, number>> = { simplefin: 20, akahu: 48 };
/** Every provider's max_window_days (limits.MAX_WINDOW_DAYS). */
const MAX_WINDOW_DAYS = 90;
const MAX_WINDOWS_PER_SYNC = 4;
/** Design 9.1: later syncs start this many days before the newest synced end. */
const OVERLAP_DAYS = 5;
const DEBT_KINDS: readonly string[] = ['credit_card', 'loan'];
const FALLBACK_LABEL = 'Account';
/** ISO 4217 "no currency": the sync later skips the account with currency_unsupported. */
const NO_CURRENCY = 'XXX';
const MAX_SAME_AS_KEY_CHARS = 196;
const MAX_LIABILITY_ID_CHARS = 64;
/** Provider error -> connection status (design 8.3). Anything else leaves the status. */
const ERROR_STATUS: Record<string, ConnectionStatus> = {
  reconnect_needed: 'reconnect_needed',
  payment_required: 'payment_required',
  provider_rate_limited: 'rate_limited',
};
const RATE_LIMITED = 'provider_rate_limited';
/** An error type that is safe to log: catalog-shaped, else `unknown`. */
const loggable = (errorType: unknown): string =>
  typeof errorType === 'string' && /^[a-z_]{1,64}$/.test(errorType) ? errorType : 'unknown';
const SAVEPOINT = 'connections';
const DISCONNECT_SAVEPOINT = 'connections_disconnect';

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (errorType: string): SmartImportHttpError => new SmartImportHttpError(errorType);
const need = (ok: boolean): void => {
  if (!ok) throw fail('bad_request');
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\x00-\x1f\x7f]/g;
const CURRENCY = /^[A-Z]{3}$/;
const CONNECTOR_KEY = /^acct:[0-9a-f]{64}$/;
/** Python's str.isspace() set (str.strip), which differs from JS trim(): NEL (U+0085) yes, BOM (U+FEFF) no. */
const PY_SPACE =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g');

/** The route's `Label`: 1 to 120 characters, no control characters. */
const isLabel = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && chars(v) <= MAX_LABEL_CHARS && !CONTROL.test(v);
const textUpTo = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v !== '' && chars(v) <= max;
const onlyKeys = (v: Raw, allowed: string[]): boolean =>
  Object.keys(v).every((k) => allowed.includes(k));
const has = (v: Raw, key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');

// --- dates (YYYY-MM-DD on the calendar, no timezone) ---------------------------------

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d + days);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}
const minDay = (a: string, b: string): string => (a < b ? a : b);
const maxDay = (a: string, b: string): string => (a > b ? a : b);

// --- plan (service.next_since, windows_for, window_requests) -------------------------

/** The key a synced statement carries (design 5.2, 10): same_as_key, else account_key. */
export const effectiveKey = (account: StoredAccount): string =>
  account.same_as_key ? account.same_as_key : account.account_key;

/**
 * service.next_since (design 9.1), in order: the newest period_end of this
 * connection's imports for the account's key minus 5 days; for a "same as"
 * mapping the day after the newest stored posted_date for that key; else the
 * first-sync choice, both ends included. Never after today.
 */
export function nextSince(
  connection: StoredConnection,
  account: StoredAccount,
  importEnds: Record<string, string>,
  posted: Record<string, string>,
  day: string
): string {
  const key = effectiveKey(account);
  const end = own(importEnds, key);
  const last = own(posted, key);
  let since: string;
  if (end !== undefined) since = addDays(end, -OVERLAP_DAYS);
  else if (account.same_as_key && last !== undefined) since = addDays(last, 1);
  else since = addDays(day, -(connection.first_sync_days - 1));
  return minDay(since, day);
}

/** service.windows_for: at most 4 windows of at most `maxDays` days, oldest first. */
export function windowsFor(start: string, day: string, maxDays: number): [string, string][] {
  const out: [string, string][] = [];
  let begin = start;
  while (begin <= day && out.length < MAX_WINDOWS_PER_SYNC) {
    const end = minDay(addDays(begin, maxDays - 1), day);
    out.push([begin, end]);
    begin = addDays(end, 1);
  }
  return out;
}

interface Plan {
  accounts: ConnectorSyncAccount[];
  windows: [string, string][];
  sinceById: Record<string, string | null>;
}

const sortedAccounts = (connection: StoredConnection): [string, StoredAccount][] =>
  Object.entries(connection.accounts).sort(([a], [b]) => cmp(a, b));

function planFor(
  connection: StoredConnection,
  importEnds: Record<string, string>,
  posted: Record<string, string>,
  day: string
): Plan {
  const sinceById: Record<string, string | null> = {};
  const accounts: ConnectorSyncAccount[] = [];
  for (const [pid, account] of sortedAccounts(connection)) {
    if (account.role === 'ignore') continue;
    const since = nextSince(connection, account, importEnds, posted, day);
    put(sinceById, pid, since);
    accounts.push({
      provider_account_id: pid,
      since,
      account_key: effectiveKey(account),
      kind: account.kind,
      flip_balance: account.flip_balance,
    });
  }
  const windows =
    accounts.length > 0
      ? windowsFor(accounts.map((a) => a.since).reduce(minDay), day, MAX_WINDOW_DAYS)
      : [];
  return { accounts, windows, sinceById };
}

/** service.window_requests: the accounts one window fetches, each from max(since, start). */
function windowRequests(plan: Plan, [start, end]: [string, string]): ConnectorSyncAccount[] {
  return plan.accounts
    .filter((a) => a.since <= end)
    .map((a) => ({ ...a, since: maxDay(a.since, start) }));
}

function planFromDatabase(db: ClientDatabase, id: string, connection: StoredConnection): Plan {
  const enabled = Object.values(connection.accounts).filter((a) => a.role !== 'ignore');
  const keys = [...new Set(enabled.map(effectiveKey))];
  const importEnds = newestImportEnds(db, id, keys);
  const sameAs = [
    ...new Set(enabled.map((a) => a.same_as_key).filter((k): k is string => !!k)),
  ].filter((k) => own(importEnds, k) === undefined);
  return planFor(connection, importEnds, newestPostedDates(db, sameAs), today());
}

// --- quota and shapes ------------------------------------------------------------------

/** service.quota_left: provider calls left in the rolling 24 hours; null when unlimited. */
function quotaLeft(connection: StoredConnection): number | null {
  const budget = DAILY_BUDGET[connection.provider];
  return budget === undefined ? null : Math.max(0, budget - connection.requests.length);
}

/** When the oldest counted call leaves the window (only when none are left). */
function quotaResetsAt(connection: StoredConnection): string | null {
  const oldest = connection.requests[0];
  if (quotaLeft(connection) !== 0 || oldest === undefined) return null;
  return stampOf(instantOf(oldest)! + REQUEST_WINDOW_US);
}

function summary(id: string, connection: StoredConnection): ConnectionSummary {
  const accounts = Object.values(connection.accounts);
  return {
    id,
    provider: connection.provider,
    label: connection.label,
    status: connection.status,
    status_at: connection.status_at,
    created_at: connection.created_at,
    last_synced_at: connection.last_synced_at,
    first_sync_days: connection.first_sync_days as ConnectionSummary['first_sync_days'],
    accounts_count: accounts.length,
    accounts_enabled: accounts.filter((a) => a.role !== 'ignore').length,
    quota_budget: DAILY_BUDGET[connection.provider] ?? null,
    quota_left: quotaLeft(connection),
    quota_resets_at: quotaResetsAt(connection),
  };
}

function detailFromPlan(id: string, connection: StoredConnection, plan: Plan): ConnectionDetail {
  return {
    ...summary(id, connection),
    windows: plan.windows.map(([start, end]) => ({ start, end })),
    accounts: sortedAccounts(connection).map(([pid, a]) => ({
      provider_account_id: pid,
      name: a.name,
      institution: a.institution,
      currency: a.currency,
      kind: a.kind,
      role: a.role,
      label: a.label,
      account_key: a.account_key,
      liability_id: a.liability_id,
      flip_balance: a.flip_balance,
      same_as_key: a.same_as_key,
      next_since: own(plan.sinceById, pid) ?? null,
    })),
  };
}

/**
 * service._detail with the plan's database reads given: the summary, the
 * accounts with `next_since` and the windows. Pure, so the shared plan cases
 * (tests/fixtures/connections_plan_cases.json) check it against the server.
 */
export function connectionDetail(
  id: string,
  connection: StoredConnection,
  importEnds: Record<string, string>,
  posted: Record<string, string>,
  day: string
): ConnectionDetail {
  return detailFromPlan(id, connection, planFor(connection, importEnds, posted, day));
}

function detail(db: ClientDatabase, id: string, connection: StoredConnection): ConnectionDetail {
  return detailFromPlan(id, connection, planFromDatabase(db, id, connection));
}

// --- storage helpers ---------------------------------------------------------------------

function connectionOf(doc: ConnectionsDocument, id: unknown): StoredConnection {
  const connection = typeof id === 'string' ? own(doc.items, id) : undefined;
  if (connection === undefined) throw fail('connection_not_found');
  return connection;
}

/** Connection ids and their account ids (service._shape). */
const shape = (doc: ConnectionsDocument): string =>
  JSON.stringify(
    Object.keys(doc.items)
      .sort(cmp)
      .map((id) => [id, Object.keys(doc.items[id]!.accounts).sort(cmp)])
  );

/**
 * service._mutate: read the sanitized document, let `body` change it, write
 * it back sanitized, inside one SAVEPOINT. If the store dropped a connection
 * or account the change left, `save_failed` rolls everything back. Catalog
 * errors pass through; anything else is logged by type and is `save_failed`.
 */
function mutate<T>(
  db: ClientDatabase,
  operation: string,
  body: (doc: ConnectionsDocument, now: number) => T
): T {
  const now = nowMicros();
  let started = false;
  try {
    db.execute(`SAVEPOINT ${SAVEPOINT}`);
    started = true;
    const doc = readConnections(db, now);
    const value = body(doc, now);
    const clean = writeConnections(db, doc, now);
    if (shape(clean) !== shape(doc)) {
      console.error('connection_save_dropped_entries');
      throw fail('save_failed');
    }
    db.execute(`RELEASE ${SAVEPOINT}`);
    return value;
  } catch (error) {
    if (started) {
      try {
        db.execute(`ROLLBACK TO ${SAVEPOINT}`);
        db.execute(`RELEASE ${SAVEPOINT}`);
      } catch {
        // nothing left to undo
      }
    }
    if (error instanceof LocalHttpError) throw error;
    console.error(
      `connection_${operation}_failed error_type=${error instanceof Error ? error.name : 'Error'}`
    );
    throw fail('save_failed');
  }
}

/** service._set_status: set the status (and status_at when it changed). True when changed. */
function setStatus(connection: StoredConnection, status: ConnectionStatus, now: number): boolean {
  if (connection.status === status) return false;
  connection.status = status;
  connection.status_at = stampOf(now);
  return true;
}

function logStatus(id: string, status: string, changed: boolean): void {
  if (changed) console.info(`connection_status_changed connection_id=${id} status=${status}`);
}

function saveSecret(db: ClientDatabase, id: string, sealed: string): void {
  db.execute(
    `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 1,
       updated_at = excluded.updated_at`,
    [SECRET_KEY_PREFIX + id, sealed, stampOf(nowMicros())]
  );
}

/** The sealed value a non-demo connection needs: refuses anything else (never plaintext). */
function sealedFor(provider: ProviderId, sealed: unknown): string | null {
  if (provider === 'demo') {
    need(sealed === null || sealed === undefined);
    return null;
  }
  need(isSealedValue(sealed));
  return sealed as string;
}

// --- calls in flight (per database, per tab) ---------------------------------------------------

interface CallState {
  /** Keys a composite holds for its whole run (connection ids, or CREATE_HOLD). */
  held: Set<string>;
  /** Connection id -> the request timestamp reserved for its call in flight. */
  reserved: Map<string, string>;
}
const CALLS = new WeakMap<ClientDatabase, CallState>();

function callState(db: ClientDatabase): CallState {
  let state = CALLS.get(db);
  if (state === undefined) {
    state = { held: new Set(), reserved: new Map() };
    CALLS.set(db, state);
  }
  return state;
}

/** The hold key the create composite takes, so two creates cannot race the limit. */
export const CREATE_HOLD = 'create';

/**
 * Hold `key` (a connection id, or CREATE_HOLD) for a composite's whole run,
 * across its awaits. A second hold, a Disconnect or a call on a held
 * connection is 409 `connection_busy`. Returns the release (idempotent).
 */
export function holdConnection(db: ClientDatabase, key: string): () => void {
  const { held } = callState(db);
  if (held.has(key)) throw fail('connection_busy');
  held.add(key);
  let released = false;
  return () => {
    if (!released) held.delete(key);
    released = true;
  };
}

const busy = (db: ClientDatabase, id: string): boolean => {
  const state = callState(db);
  return state.held.has(id) || state.reserved.has(id);
};

/**
 * Count a call's request inside a `mutate` body, given the timestamp
 * beginConnectionCall reserved for it (read before the mutate): with a
 * reservation, `made` keeps it and otherwise it is removed (no provider call
 * was made); without one, a made call is counted now. The in-tab reservation
 * map itself changes only after the write succeeds (endConnectionCall).
 */
function countCall(
  connection: StoredConnection,
  reservedStamp: string | undefined,
  made: boolean,
  now: number
): void {
  if (reservedStamp === undefined) {
    if (made) connection.requests.push(stampOf(now));
    return;
  }
  if (!made) {
    const at = connection.requests.lastIndexOf(reservedStamp);
    if (at >= 0) connection.requests.splice(at, 1);
  }
}

/**
 * Forget the call in flight on `id` without changing its count (the
 * composites call this in `finally`, so an unexpected failure cannot leave
 * the connection busy). A reservation still here was counted: the call may
 * have reached the provider.
 */
export function endConnectionCall(db: ClientDatabase, id: string): void {
  callState(db).reserved.delete(id);
}

// --- list, detail, plan ----------------------------------------------------------------------

/** GET /api/connections: every connection as a summary, oldest first (created_at, then id). */
export function getConnections(db: ClientDatabase): ConnectionSummary[] {
  const doc = readConnections(db);
  return Object.entries(doc.items)
    .sort(([ia, a], [ib, b]) => cmp(a.created_at, b.created_at) || cmp(ia, ib))
    .map(([id, connection]) => summary(id, connection));
}

/** GET /api/connections/{id}: summary, accounts with next_since, and the windows. */
export function getConnection(db: ClientDatabase, id: string): ConnectionDetail {
  return detail(db, id, connectionOf(readConnections(db), id));
}

/**
 * The sync plan for the B6 sync composite (service.plan_sync): each window,
 * oldest first, with the v2 sync accounts it asks for. A window index the
 * plan does not have is `bad_request` there, as on the server.
 */
export function getConnectionSyncPlan(db: ClientDatabase, id: string): ConnectionSyncPlan {
  const connection = connectionOf(readConnections(db), id);
  const plan = planFromDatabase(db, id, connection);
  return {
    connection_id: id,
    provider: connection.provider,
    status: connection.status,
    quota_left: quotaLeft(connection),
    windows: plan.windows.map((w) => ({
      start: w[0],
      end: w[1],
      accounts: windowRequests(plan, w),
    })),
  };
}

// --- create and reconnect -----------------------------------------------------------------

interface ParsedMeta {
  id: string;
  provider: ProviderId;
  label: string | null;
  firstSyncDays: number | null;
  claimed: boolean;
}

function parseMeta(meta: unknown): ParsedMeta {
  need(isObj(meta));
  const m = meta as Raw;
  need(onlyKeys(m, ['id', 'provider', 'label', 'first_sync_days', 'claimed']));
  need(isConnectionId(m.id));
  need(typeof m.provider === 'string' && (PROVIDER_IDS as readonly string[]).includes(m.provider));
  need(m.label === undefined || m.label === null || isLabel(m.label));
  need(
    m.first_sync_days === undefined ||
      m.first_sync_days === null ||
      (FIRST_SYNC_DAYS as readonly unknown[]).includes(m.first_sync_days)
  );
  need(m.claimed === undefined || typeof m.claimed === 'boolean');
  return {
    id: m.id as string,
    provider: m.provider as ProviderId,
    label: (m.label as string | null | undefined) ?? null,
    firstSyncDays: (m.first_sync_days as number | null | undefined) ?? null,
    claimed: m.claimed === true,
  };
}

/**
 * The create composite's save (service.create_connection, the commit step):
 * the connection with status `accounts_pending` and no accounts, and its
 * sealed credential (`encrypted=1`) in one transaction. The demo stores no
 * secret. The composite minted `meta.id` and sealed with it; `claimed` counts
 * the claim as one provider call. The composite should refuse
 * `connection_limit` before it claims (getConnections().length), as the
 * server does; this check is the backstop. Never returns the sealed value.
 */
export function createConnection(
  db: ClientDatabase,
  meta: unknown,
  sealed: unknown
): ConnectionDetail {
  const parsed = parseMeta(meta);
  const value = sealedFor(parsed.provider, sealed);
  const connection = mutate(db, 'create', (doc, now) => {
    need(own(doc.items, parsed.id) === undefined);
    if (Object.keys(doc.items).length >= MAX_CONNECTIONS) throw fail('connection_limit');
    const stamp = stampOf(now);
    const entry: StoredConnection = {
      provider: parsed.provider,
      label: parsed.label ?? DISPLAY_NAMES[parsed.provider],
      created_at: stamp,
      status: 'accounts_pending',
      status_at: stamp,
      last_synced_at: null,
      first_sync_days: parsed.firstSyncDays ?? DEFAULT_FIRST_SYNC_DAYS,
      requests: parsed.claimed ? [stamp] : [],
      accounts: {},
    };
    put(doc.items, parsed.id, entry);
    if (value !== null) saveSecret(db, parsed.id, value);
    return entry;
  });
  console.info(
    `connection_created connection_id=${parsed.id} provider=${parsed.provider} ` +
      `claimed=${String(parsed.claimed)}`
  );
  return detail(db, parsed.id, connection);
}

/**
 * The reconnect composite's save (service.replace_credentials): replace the
 * sealed credential and set `accounts_pending`, keeping the id and mapping.
 * `claimed` counts a claim. The demo has no secret, so this only resets it.
 */
export function replaceConnectionSecret(
  db: ClientDatabase,
  id: string,
  sealed: unknown,
  claimed: unknown = false
): ConnectionDetail {
  const connection = mutate(db, 'credentials', (doc, now) => {
    const current = connectionOf(doc, id);
    need(typeof claimed === 'boolean');
    const value = sealedFor(current.provider, sealed);
    if (claimed === true) current.requests.push(stampOf(now));
    setStatus(current, 'accounts_pending', now);
    if (value !== null) saveSecret(db, id, value);
    return current;
  });
  console.info(
    `connection_credentials_replaced connection_id=${id} provider=${connection.provider}`
  );
  return detail(db, id, connection);
}

// --- provider calls: gates, merge, results ---------------------------------------------------

/**
 * The gates before a provider call on a stored connection, then the count
 * (service._begin_call): a call already out on this connection is
 * `connection_busy`; then `reconnect_needed`, then `connector_disabled` when
 * the composite passes the v2 status `enabled` list and the provider is not
 * in it, then the quota, then the secret. A missing secret, or one that is not
 * a browser-sealed value (a server `fernet:` value), sets `reconnect_needed`
 * and refuses. Once the gates pass, one request is reserved (counted) and the
 * connection is busy until the merge, the result or endConnectionCall.
 * Returns the sealed value for the composite to unseal for one v2 request
 * (null for the demo). The composite reports an unseal failure, or a
 * credential for another provider, as `recordConnectionResult(id, {kind:
 * 'failed', error_type: 'reconnect_needed', requested: false})`, which
 * releases the reservation. LocalAPI only: no route.
 */
export function beginConnectionCall(
  db: ClientDatabase,
  id: string,
  enabled?: readonly string[] | null
): ConnectionCallStart {
  const connection = connectionOf(readConnections(db), id);
  if (callState(db).reserved.has(id)) throw fail('connection_busy');
  if (connection.status === 'reconnect_needed') throw fail('reconnect_needed');
  if (enabled && !enabled.includes(connection.provider)) throw fail('connector_disabled');
  if (quotaLeft(connection) === 0) throw fail('quota_reached');
  let sealed: string | null = null;
  if (connection.provider !== 'demo') {
    const row = db.query<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', [
      SECRET_KEY_PREFIX + id,
    ])[0];
    if (!row || !isSealedValue(row.value)) return unreadableSecret(db, id);
    sealed = row.value;
  }
  reserve(db, id);
  return { provider: connection.provider, sealed };
}

/**
 * The gates before Reconnect tries a new credential, then the count: like
 * beginConnectionCall, but neither `reconnect_needed` nor the stored secret
 * matters, since the call uses the credential being offered. The reconnect
 * composite lists accounts with it first and replaces the stored secret
 * only when v2 accepted it, so a mistyped credential never overwrites a
 * working one. Returns the provider.
 */
export function beginReplacementCall(
  db: ClientDatabase,
  id: string,
  enabled?: readonly string[] | null
): ProviderId {
  const connection = connectionOf(readConnections(db), id);
  if (callState(db).reserved.has(id)) throw fail('connection_busy');
  if (enabled && !enabled.includes(connection.provider)) throw fail('connector_disabled');
  if (quotaLeft(connection) === 0) throw fail('quota_reached');
  reserve(db, id);
  return connection.provider;
}

/** Count before the call, as service._begin_call does, and mark the call in flight. */
function reserve(db: ClientDatabase, id: string): void {
  const stamp = mutate(db, 'reserve', (doc, now) => {
    const at = stampOf(now);
    connectionOf(doc, id).requests.push(at);
    return at;
  });
  callState(db).reserved.set(id, stamp);
}

/** A missing or unsealed secret: set `reconnect_needed` and refuse (nothing counted). */
function unreadableSecret(db: ClientDatabase, id: string): never {
  console.warn(`connection_secret_unreadable connection_id=${id}`);
  const changed = mutate(db, 'status', (doc, now) =>
    setStatus(connectionOf(doc, id), 'reconnect_needed', now)
  );
  logStatus(id, 'reconnect_needed', changed);
  throw fail('reconnect_needed');
}

/** Python's str.strip(). */
const pyStrip = (s: string): string => s.replace(PY_STRIP, '');
const cut = (s: string, max: number): string =>
  chars(s) <= max ? s : Array.from(s).slice(0, max).join('');

/** service._clip: control characters to spaces, trimmed and cut; null when empty. */
function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return pyStrip(cut(pyStrip(value.replace(CONTROL_ALL, ' ')), max)) || null;
}

/**
 * service._merge_accounts. Known accounts keep their mapping and get fresh
 * provider text; new ones on the first listing get defaults by kind (debt
 * with a suggested liability for card and loan, cash_flow otherwise), new
 * ones on a later listing are added as `ignore`. Accounts the provider no
 * longer lists are kept. One difference: the server recomputes an account
 * key that is not `acct:<64 hex>`, which needs a hash the browser never
 * computes (decision E4), so such an account is skipped here. v2 always
 * sends a valid key, so this does not happen in practice.
 */
function mergeAccounts(db: ClientDatabase, connection: StoredConnection, listed: Raw[]): void {
  const stored = connection.accounts;
  const first = Object.keys(stored).length === 0;
  for (const account of listed) {
    const pid = account.provider_account_id;
    if (
      typeof pid !== 'string' ||
      pid === '' ||
      chars(pid) > MAX_PROVIDER_ACCOUNT_ID_CHARS ||
      CONTROL.test(pid)
    ) {
      continue;
    }
    const name = clip(account.name, MAX_PROVIDER_TEXT_CHARS) ?? '';
    const institution = clip(account.institution, MAX_PROVIDER_TEXT_CHARS);
    let currency = typeof account.currency === 'string' ? account.currency.toUpperCase() : '';
    if (!CURRENCY.test(currency)) currency = NO_CURRENCY;
    const known = own(stored, pid);
    if (known !== undefined) {
      known.name = name;
      known.institution = institution;
      known.currency = currency;
      continue;
    }
    if (Object.keys(stored).length >= MAX_ACCOUNTS) continue;
    const accountKey = account.account_key;
    if (typeof accountKey !== 'string' || !CONNECTOR_KEY.test(accountKey)) continue;
    const kind: AccountKind = (ACCOUNT_KINDS as readonly unknown[]).includes(account.kind_guess)
      ? (account.kind_guess as AccountKind)
      : 'unknown';
    const role = first ? (DEBT_KINDS.includes(kind) ? 'debt' : 'cash_flow') : 'ignore';
    let liabilityId: string | null = null;
    if (role === 'debt') {
      const found = suggestLiability(db, institution, kind, accountKey);
      liabilityId = isConnectionId(found) ? found : null;
    }
    put(stored, pid, {
      name,
      institution,
      currency,
      kind,
      role,
      label: clip(name, MAX_LABEL_CHARS) ?? FALLBACK_LABEL,
      account_key: accountKey,
      liability_id: liabilityId,
      flip_balance: false,
      same_as_key: null,
    });
  }
}

/** Codes in first-seen order, each once, skipping those already listed. */
function appendCodes(out: ConnectionAccountError[], codes: string[]): ConnectionAccountError[] {
  const listed = new Set(out.map((e) => e.code));
  for (const code of codes) {
    if (!listed.has(code)) {
      out.push({ provider_account_id: null, code });
      listed.add(code);
    }
  }
  return out;
}

/**
 * The account listing's result (service._list_accounts after the call):
 * count the call (unless beginConnectionCall reserved it), merge the v2
 * accounts answer, status `ok` (or
 * `rate_limited` on a rate-limit warning). Returns the detail plus
 * `account_errors` (flagged accounts, then result codes), which is not stored.
 */
export function mergeConnectionAccounts(
  db: ClientDatabase,
  id: string,
  response: unknown
): ConnectionListingResponse {
  need(isObj(response));
  const { accounts, errors } = response as Raw;
  need(Array.isArray(accounts) && Array.isArray(errors));
  need((errors as unknown[]).every((c) => typeof c === 'string'));
  const listed = (accounts as unknown[]).filter(isObj);
  const codes = errors as string[];
  let changed = false;
  const reservedStamp = callState(db).reserved.get(id);
  const connection = mutate(db, 'accounts', (doc, now) => {
    const current = connectionOf(doc, id);
    // A reserved call was counted by beginConnectionCall; count only otherwise.
    countCall(current, reservedStamp, true, now);
    mergeAccounts(db, current, listed);
    changed = setStatus(current, codes.includes(RATE_LIMITED) ? 'rate_limited' : 'ok', now);
    return current;
  });
  endConnectionCall(db, id);
  logStatus(id, connection.status, changed);
  console.info(
    `connection_accounts connection_id=${id} provider=${connection.provider} ` +
      `accounts=${listed.length} errors=${codes.length}`
  );
  const flagged: ConnectionAccountError[] = listed
    .filter((a) => typeof a.error === 'string' && a.error !== '')
    .map((a) => ({
      provider_account_id: a.provider_account_id as string,
      code: a.error as string,
    }));
  return { ...detail(db, id, connection), account_errors: appendCodes(flagged, codes) };
}

/**
 * Record a provider call's outcome (service.sync_connection after the call,
 * service._record_failure). A call beginConnectionCall reserved is already
 * counted: `requested: false` releases that request, anything else keeps it.
 * Without a reservation the rules below count it here. A good sync: one
 * request counted, status `ok`
 * (or `rate_limited` when its codes include a rate-limit warning) and
 * `last_synced_at`. A failure: one request counted when the call was made
 * (`requested`), and the status the error implies (design 8.3); other errors
 * leave it. `{kind: 'failed', error_type: 'reconnect_needed', requested:
 * false}` records an unreadable seal. A connection that is gone (removed
 * while the call was out) is skipped and gives null, as the server skips it.
 */
export function recordConnectionResult(
  db: ClientDatabase,
  id: string,
  result: unknown
): ConnectionDetail | null {
  need(isObj(result));
  const r = result as Raw;
  let ok: boolean;
  let codes: string[] = [];
  if (r.kind === 'sync') {
    need(isObj(r.response) && Array.isArray(r.response.account_errors));
    const entries = (r.response as Raw).account_errors as unknown[];
    need(entries.every((e) => isObj(e) && typeof e.code === 'string'));
    codes = entries.map((e) => (e as Raw).code as string);
    ok = true;
  } else if (r.kind === 'failed') {
    need(typeof r.error_type === 'string' && r.error_type !== '');
    need(typeof r.requested === 'boolean');
    ok = false;
  } else {
    throw fail('bad_request');
  }
  // Disconnected while the call was out: nothing to record (the server skips it too).
  if (own(readConnections(db).items, id) === undefined) {
    endConnectionCall(db, id);
    console.info(`connection_result_dropped connection_id=${id}`);
    return null;
  }
  const made = ok || r.requested === true;
  let changed = false;
  let status: ConnectionStatus | undefined;
  const reservedStamp = callState(db).reserved.get(id);
  const connection = mutate(db, 'result', (doc, now) => {
    const current = connectionOf(doc, id);
    // A reserved call was counted already: keep it if made, else release it.
    countCall(current, reservedStamp, made, now);
    if (ok) {
      status = codes.includes(RATE_LIMITED) ? 'rate_limited' : 'ok';
      current.last_synced_at = stampOf(now);
    } else {
      status = own(ERROR_STATUS, r.error_type as string);
    }
    if (status !== undefined) changed = setStatus(current, status, now);
    return current;
  });
  endConnectionCall(db, id);
  if (status !== undefined) logStatus(id, status, changed);
  console.info(
    ok
      ? `connection_sync connection_id=${id} provider=${connection.provider} ` +
          `account_errors=${codes.length}`
      : `connection_call_failed connection_id=${id} provider=${connection.provider} ` +
          `error_type=${loggable(r.error_type)} requested=${String(r.requested)}`
  );
  return detail(db, id, connection);
}

// --- update ----------------------------------------------------------------------------------

const ACCOUNT_FIELDS = ['kind', 'role', 'label', 'liability_id', 'flip_balance', 'same_as_key'];
const REQUIRED_ACCOUNT_FIELDS = ['kind', 'role', 'label', 'flip_balance'] as const;

/** The route's UpdateConnectionRequest: what pydantic refuses (422) before the service runs. */
function parseUpdate(body: unknown): Raw {
  need(isObj(body));
  const b = body as Raw;
  need(onlyKeys(b, ['label', 'first_sync_days', 'accounts']));
  need(b.label === undefined || b.label === null || isLabel(b.label));
  need(
    b.first_sync_days === undefined ||
      b.first_sync_days === null ||
      (FIRST_SYNC_DAYS as readonly unknown[]).includes(b.first_sync_days)
  );
  if (b.accounts !== undefined && b.accounts !== null) {
    need(isObj(b.accounts));
    const entries = Object.entries(b.accounts as Raw);
    need(entries.length <= MAX_ACCOUNTS);
    const optional = (v: unknown, ok: (x: unknown) => boolean): boolean =>
      v === undefined || v === null || ok(v);
    for (const [pid, fields] of entries) {
      need(textUpTo(pid, MAX_PROVIDER_ACCOUNT_ID_CHARS));
      need(isObj(fields) && onlyKeys(fields, ACCOUNT_FIELDS));
      const f = fields as Raw;
      need(optional(f.kind, (x) => (ACCOUNT_KINDS as readonly unknown[]).includes(x)));
      need(optional(f.role, (x) => (ROLES as readonly unknown[]).includes(x)));
      need(optional(f.label, isLabel));
      need(optional(f.liability_id, (x) => textUpTo(x, MAX_LIABILITY_ID_CHARS)));
      need(optional(f.flip_balance, (x) => typeof x === 'boolean'));
      need(optional(f.same_as_key, (x) => textUpTo(x, MAX_SAME_AS_KEY_CHARS)));
    }
  }
  return b;
}

function knownKeys(db: ClientDatabase, doc: ConnectionsDocument): Set<string> {
  const keys = importedAccountKeys(db);
  for (const connection of Object.values(doc.items)) {
    for (const account of Object.values(connection.accounts)) keys.add(account.account_key);
  }
  return keys;
}

/**
 * PUT /api/connections/{id} (service.update_connection): change the label,
 * the first-sync range or the account mapping; only the fields sent change.
 * Per account, kind, role, label and flip_balance cannot be null;
 * liability_id must name an existing debt (404 `liability_not_found`) or be
 * null; same_as_key must be a key a stored import or a connected account
 * uses, other than the account's own, or be null. No provider call.
 */
export function updateConnection(db: ClientDatabase, id: string, body: unknown): ConnectionDetail {
  const update = parseUpdate(body);
  const changes = isObj(update.accounts) ? update.accounts : {};
  const connection = mutate(db, 'update', (doc) => {
    const current = connectionOf(doc, id);
    if (has(update, 'label')) {
      need(typeof update.label === 'string' && update.label !== '');
      current.label = update.label as string;
    }
    if (has(update, 'first_sync_days')) {
      need((FIRST_SYNC_DAYS as readonly unknown[]).includes(update.first_sync_days));
      current.first_sync_days = update.first_sync_days as number;
    }
    let known: Set<string> | null = null;
    for (const [pid, raw] of Object.entries(changes)) {
      const target = own(current.accounts, pid);
      if (target === undefined) throw fail('bad_request');
      const fields = raw as Raw;
      for (const name of REQUIRED_ACCOUNT_FIELDS) {
        if (has(fields, name)) {
          need(fields[name] !== null);
          (target as unknown as Raw)[name] = fields[name];
        }
      }
      if (has(fields, 'liability_id')) {
        const lid = fields.liability_id as string | null;
        if (lid !== null && !liabilityExists(db, lid)) throw fail('liability_not_found');
        target.liability_id = lid;
      }
      if (has(fields, 'same_as_key')) {
        const key = fields.same_as_key as string | null;
        if (key !== null) {
          known ??= knownKeys(db, doc);
          need(key !== target.account_key && known.has(key));
        }
        target.same_as_key = key;
      }
    }
    return current;
  });
  console.info(
    `connection_updated connection_id=${id} accounts_changed=${Object.keys(changes).length}`
  );
  return detail(db, id, connection);
}

// --- disconnect (plan B4) ---------------------------------------------------------------------

/**
 * The `remove_data` query value: absent means false, otherwise exactly
 * `true` or `false` (the server declares `Literal["true", "false"]`).
 */
export function parseRemoveData(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new SmartImportHttpError('bad_request');
}

/** Drop one entry and write the document back sanitized, as every write does. */
function removeEntry(db: ClientDatabase, connectionId: string): void {
  const now = nowMicros();
  const doc = readConnections(db, now);
  Reflect.deleteProperty(doc.items, connectionId);
  const clean = writeConnections(db, doc, now);
  if (shape(clean) !== shape(doc)) throw fail('save_failed');
}

function disconnectInside(
  db: ClientDatabase,
  connectionId: string,
  removeData: boolean,
  now: string,
  progress: { undone: number }
): DisconnectResponse {
  const result: DisconnectResponse = {
    connection_id: connectionId,
    remove_data: removeData,
    imports_undone: 0,
    imports_kept: 0,
    deleted: { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 },
    reassigned: { transactions: 0 },
    kept: [],
  };
  const importIds = connectionImportIds(db, connectionId);
  if (removeData) {
    for (const importId of importIds) {
      const undone = undoInside(db, importId, now);
      result.deleted.transactions += undone.deleted.transactions;
      result.deleted.recurring_candidates += undone.deleted.recurring_candidates;
      result.deleted.expenses += undone.deleted.expenses;
      result.deleted.snapshots += undone.deleted.snapshots;
      result.reassigned.transactions += undone.reassigned.transactions;
      result.kept.push(...undone.kept);
      progress.undone += 1;
    }
    result.imports_undone = progress.undone;
  } else {
    result.imports_kept = importIds.length;
  }
  db.execute('DELETE FROM app_settings WHERE key = ?', [SECRET_KEY_PREFIX + connectionId]);
  removeEntry(db, connectionId);
  return result;
}

/**
 * DELETE /api/connections/{id}[?remove_data=true|false]: remove the metadata
 * entry and the secret row in one transaction. With remove_data, first undo
 * every import of the connection, newest first, with the smart import undo
 * itself, so its keep rules hold. Any failure rolls everything back to the
 * savepoint and answers `save_failed`: the connection, its secret and every
 * import stay, so the same request can be repeated.
 */
export function deleteConnection(
  db: ClientDatabase,
  connectionId: string,
  removeDataParam?: string | null
): DisconnectResponse {
  const removeData = parseRemoveData(removeDataParam);
  connectionOf(readConnections(db), connectionId);
  // Refused, not queued, while a call is out: LocalAPI cannot wait for it.
  if (busy(db, connectionId)) throw fail('connection_busy');
  const now = new Date().toISOString();
  const progress = { undone: 0 };
  let started = false;
  try {
    db.execute(`SAVEPOINT ${DISCONNECT_SAVEPOINT}`);
    started = true;
    const result = disconnectInside(db, connectionId, removeData, now, progress);
    db.execute(`RELEASE ${DISCONNECT_SAVEPOINT}`);
    console.info(
      `connection_disconnected connection_id=${connectionId} remove_data=${String(removeData)} ` +
        `imports_undone=${result.imports_undone} imports_kept=${result.imports_kept} ` +
        `kept=${result.kept.length}`
    );
    return result;
  } catch (error) {
    if (started) {
      try {
        db.execute(`ROLLBACK TO ${DISCONNECT_SAVEPOINT}`);
        db.execute(`RELEASE ${DISCONNECT_SAVEPOINT}`);
      } catch {
        // nothing left to undo
      }
    }
    // Catalog errors carry no content and pass through, as on the server.
    if (error instanceof LocalHttpError) throw error;
    const errorType = error instanceof Error ? error.name : 'Error';
    console.error(
      `connection_disconnect_failed connection_id=${connectionId} remove_data=${String(removeData)} ` +
        `undone_before=${progress.undone} error_type=${errorType}`
    );
    throw new SmartImportHttpError('save_failed');
  }
}
