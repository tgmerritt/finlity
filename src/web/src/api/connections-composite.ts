/**
 * Hosted-mode composites for the connection routes that need WebCrypto and a
 * v2 round trip (plan B6, design 6.2): POST /api/connections,
 * /api/connections/{id}/credentials, /{id}/accounts and /{id}/sync. apiCall
 * (client.ts) loads this module lazily in local data mode only; server mode
 * sends the same URLs to src/api/connections.py, so the UI is mode-agnostic.
 *
 * Each composite runs LocalAPI's steps (local-connections.ts) around one call
 * to the stateless /api/v2/connectors/* routes and answers with the server's
 * shapes, catalog errors and order of checks:
 *
 *   create:    check the body (an Access URL against the v2 status hosts),
 *              the provider (v2 status), the 10-connection limit and the
 *              key, then v2 claim, seal with the minted id,
 *              createConnection (status accounts_pending), then the listing
 *   reconnect: with a setup token: check, v2 claim, seal,
 *              replaceConnectionSecret, the listing (the token is spent, so
 *              it is saved first, as on the server); with a pasted Access
 *              URL or Akahu tokens: list with the new credential first and
 *              replace the stored one only when v2 accepted it
 *   refresh:   the listing: beginConnectionCall, unseal, v2 accounts,
 *              mergeConnectionAccounts
 *   sync:      getConnectionSyncPlan, beginConnectionCall, unseal, v2 sync
 *              with the profile's rules and categories, recordConnectionResult
 *
 * A claim that timed out is `claim_timeout`; a save that fails after a good
 * claim is `claim_not_saved` (the setup token is spent). Create and reconnect
 * keep the connection and its credential when the listing fails and report
 * `accounts_error`; refresh and sync rethrow. A provider failure is recorded
 * first, with `requested: false` when v2 refused before calling the provider
 * (the reservation beginConnectionCall made is then released).
 *
 * One composite per connection runs at a time in a tab (holdConnection), and
 * one create at a time, so the limit cannot be raced; a second one gets 409
 * `connection_busy` at once rather than waiting.
 *
 * Credentials exist in plaintext only in this module's locals for one v2
 * request body. They are never logged, stored, returned or put in an error:
 * LocalAPI only ever sees the sealed value.
 */

import { apiCall, ApiError } from './client';
import { getLocalAPI } from './dispatcher';
import type { LocalAPI } from '@/database/local-api';
import { CREATE_HOLD } from '@/database/local-connections';
import { LocalHttpError } from '@/database/local-error';
import { SmartImportHttpError } from '@/database/local-smart-import';
import { SealUnreadable, getOrCreateKey, webCryptoVault } from '@/utils/connector-seal';
import type { CredentialVault } from '@/utils/credential-vault';
import type {
  ClaimRequest,
  ClaimResponse,
  ConnectionCallStart,
  ConnectionListingResponse,
  ConnectionProvider,
  ConnectorAccountsRequest,
  ConnectorAccountsResponse,
  ConnectorCredentials,
  ConnectorSyncRequest,
  ConnectorSyncResponse,
} from '@/types/api';

type Raw = Record<string, unknown>;
/** The v2 `credentials` body: `{access_url}`, `{user_token, app_token}`, or `{}` for the demo. */
type V2Credentials = Record<string, string>;

/** Injection points for tests; production uses the defaults. */
export interface CompositeDeps {
  api?: () => LocalAPI;
  vault?: CredentialVault;
  /** Make sure the seal key is usable before a setup token is spent. */
  ready?: () => Promise<unknown>;
  newId?: () => string;
  /** What v2 /status reports here (enabled providers, allowed hosts), or null when unknown. */
  status?: () => Promise<ConnectorStatusInfo | null>;
}

/** The parts of GET /api/v2/connectors/status the composites use. */
export interface ConnectorStatusInfo {
  enabled: readonly string[];
  /** Exact hostnames per provider; a provider missing here is not checked. */
  hosts: Readonly<Record<string, readonly string[]>>;
}

interface Deps {
  api: () => LocalAPI;
  vault: CredentialVault;
  ready: () => Promise<unknown>;
  newId: () => string;
  status: () => Promise<ConnectorStatusInfo | null>;
}

const withDefaults = (deps: CompositeDeps): Deps => ({
  api: deps.api ?? getLocalAPI,
  vault: deps.vault ?? webCryptoVault,
  ready: deps.ready ?? getOrCreateKey,
  newId: deps.newId ?? ((): string => globalThis.crypto.randomUUID()),
  status: deps.status ?? connectorStatus,
});

const PROVIDERS: readonly ConnectionProvider[] = ['simplefin', 'akahu', 'demo'];
const MAX_CONNECTIONS = 10;
const CREDENTIAL_LIMITS: Record<string, number> = {
  setup_token: 4096,
  access_url: 4096,
  user_token: 512,
  app_token: 512,
};
const CREDENTIAL_FIELDS = Object.keys(CREDENTIAL_LIMITS);
const CREATE_FIELDS = [...CREDENTIAL_FIELDS, 'provider', 'label', 'first_sync_days'];
const FIRST_SYNC_DAYS: readonly unknown[] = [30, 60, 90];
const MAX_LABEL_CHARS = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
/** akahu.MAX_TOKEN_CHARS and _TOKEN. */
const AKAHU_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
/** Python's str.strip() whitespace (akahu.parse_credentials strips pasted tokens). */
const PY_SPACE =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g');
/** v2 refusals raised before any provider call: nothing to count. */
const NOT_REQUESTED = new Set([
  'bad_request',
  'bad_context',
  'connector_disabled',
  'host_not_allowed',
  'quota_reached',
  'rate_limit_exceeded',
  'window_too_long',
]);
const ERROR_TYPE = /^[a-z_]{1,64}$/;

const fail = (errorType: string): SmartImportHttpError => new SmartImportHttpError(errorType);
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s: string): number => Array.from(s).length;
const given = (v: unknown): boolean => v !== undefined && v !== null;

// --- v2 ---------------------------------------------------------------------------------------

let statusCache: Promise<ConnectorStatusInfo | null> | null = null;

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** v2 /status read into ConnectorStatusInfo, or null when it is not usable. */
function statusInfo(status: unknown): ConnectorStatusInfo | null {
  if (!isObj(status) || !strings(status.enabled)) return null;
  const hosts: Record<string, readonly string[]> = {};
  if (Array.isArray(status.providers)) {
    for (const entry of status.providers as unknown[]) {
      if (isObj(entry) && typeof entry.id === 'string' && strings(entry.allowed_hosts)) {
        hosts[entry.id] = entry.allowed_hosts;
      }
    }
  }
  return { enabled: status.enabled, hosts };
}

/** The v2 status, fetched once per page; null (and retried later) on failure. */
function connectorStatus(): Promise<ConnectorStatusInfo | null> {
  statusCache ??= apiCall<unknown>('/api/v2/connectors/status')
    .then(statusInfo)
    .catch(() => null)
    .then((info) => {
      if (info === null) statusCache = null;
      return info;
    });
  return statusCache;
}

/** Test hook: forget the cached v2 status. */
export function resetConnectorStatusCache(): void {
  statusCache = null;
}

const v2 = <T>(
  path: string,
  body: ClaimRequest | ConnectorAccountsRequest | ConnectorSyncRequest
): Promise<T> => apiCall<T>(`/api/v2/connectors/${path}`, { method: 'POST', body });

/** The catalog error type of a failure, read from its body, never from its text. */
function errorTypeOf(error: unknown): string {
  if (error instanceof SmartImportHttpError) return error.errorType;
  if (error instanceof ApiError || error instanceof LocalHttpError) {
    const type = isObj(error.data) ? error.data.error_type : undefined;
    if (typeof type === 'string' && ERROR_TYPE.test(type)) return type;
  }
  if (error instanceof ApiError && error.status === 0) {
    return error.message === 'Request timeout' ? 'provider_timeout' : 'provider_unavailable';
  }
  return 'provider_bad_response';
}

/** What to throw for a failed v2 call: the server's own error, or a catalog one. */
function rethrowable(error: unknown): unknown {
  if (error instanceof ApiError && isObj(error.data) && typeof error.data.error_type === 'string') {
    return error;
  }
  return fail(errorTypeOf(error));
}

// --- bodies -----------------------------------------------------------------------------------

interface CredentialInput {
  setupToken: string | null;
  credentials: V2Credentials | null;
}

/** The route's CredentialsRequest field rules (pydantic, before the service runs). */
function checkCredentialFields(body: Raw): void {
  for (const field of CREDENTIAL_FIELDS) {
    const value = body[field];
    if (!given(value)) continue;
    if (typeof value !== 'string' || value === '') throw fail('bad_request');
    if (codePoints(value) > CREDENTIAL_LIMITS[field]!) throw fail('bad_request');
  }
}

/**
 * simplefin.parse_access_url / http.check_simplefin_url for an Access URL:
 * https, a user and a password, port absent or 443, a path under /simplefin,
 * no query or fragment, and a host v2 /status allows. Checked before anything
 * is claimed, sealed or stored. Skipped when the hosts are unknown (v2 checks
 * again on every call).
 */
function checkAccessUrl(text: string, hosts: readonly string[] | undefined): void {
  if (hosts === undefined) return;
  const raw = text.replace(PY_STRIP, '');
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const ok =
    url !== null &&
    url.protocol === 'https:' &&
    url.username !== '' &&
    url.password !== '' &&
    url.port === '' &&
    (url.pathname === '/simplefin' || url.pathname.startsWith('/simplefin/')) &&
    !raw.includes('?') &&
    !raw.includes('#') &&
    hosts.includes(url.hostname);
  if (!ok) throw fail('host_not_allowed');
}

/** service._parse_input: exactly the fields the provider takes. */
function credentialInput(
  provider: ConnectionProvider,
  body: Raw,
  status: ConnectorStatusInfo | null
): CredentialInput {
  const fields = CREDENTIAL_FIELDS.filter((f) => given(body[f])).sort();
  const only = (...names: string[]): boolean => fields.join(',') === names.sort().join(',');
  if (provider === 'simplefin' && only('setup_token')) {
    return { setupToken: body.setup_token as string, credentials: null };
  }
  if (provider === 'simplefin' && only('access_url')) {
    checkAccessUrl(body.access_url as string, status?.hosts.simplefin);
    return { setupToken: null, credentials: { access_url: body.access_url as string } };
  }
  if (provider === 'akahu' && only('user_token', 'app_token')) {
    const user = (body.user_token as string).replace(PY_STRIP, '');
    const app = (body.app_token as string).replace(PY_STRIP, '');
    if (!AKAHU_TOKEN.test(user) || !AKAHU_TOKEN.test(app) || user === app) {
      throw fail('bad_request');
    }
    return { setupToken: null, credentials: { user_token: user, app_token: app } };
  }
  if (provider === 'demo' && fields.length === 0) return { setupToken: null, credentials: {} };
  throw fail('bad_request');
}

interface CreateRequest {
  provider: ConnectionProvider;
  label: string | null;
  firstSyncDays: 30 | 60 | 90 | null;
  body: Raw;
}

/** The route's CreateConnectionRequest. */
function parseCreate(body: unknown): CreateRequest {
  if (!isObj(body) || !Object.keys(body).every((k) => CREATE_FIELDS.includes(k))) {
    throw fail('bad_request');
  }
  const { provider, label, first_sync_days: days } = body;
  if (!PROVIDERS.includes(provider as ConnectionProvider)) throw fail('bad_request');
  if (
    given(label) &&
    !(
      typeof label === 'string' &&
      label !== '' &&
      codePoints(label) <= MAX_LABEL_CHARS &&
      !CONTROL.test(label)
    )
  ) {
    throw fail('bad_request');
  }
  if (given(days) && !FIRST_SYNC_DAYS.includes(days)) throw fail('bad_request');
  checkCredentialFields(body);
  return {
    provider: provider as ConnectionProvider,
    label: given(label) ? (label as string) : null,
    firstSyncDays: given(days) ? (days as 30 | 60 | 90) : null,
    body,
  };
}

/** The route's SyncConnectionRequest: `window_index` a strict int 0..3, default 0. */
function parseWindowIndex(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (!isObj(body) || !Object.keys(body).every((k) => k === 'window_index')) {
    throw fail('bad_request');
  }
  const index = body.window_index;
  if (index === undefined) return 0;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 3) {
    throw fail('bad_request');
  }
  return index;
}

// --- steps ------------------------------------------------------------------------------------

function requireEnabled(status: ConnectorStatusInfo | null, provider: ConnectionProvider): void {
  if (status && !status.enabled.includes(provider)) throw fail('connector_disabled');
}

/** store.check_key's twin: the seal key must work before a setup token is spent. */
async function requireKey(d: Deps, provider: ConnectionProvider): Promise<void> {
  if (provider === 'demo') return;
  try {
    await d.ready();
  } catch {
    throw fail('save_failed');
  }
}

/** v2 claim; a timed-out or lost answer is `claim_timeout` (the token may be spent). */
async function claim(setupToken: string): Promise<V2Credentials> {
  let answer: unknown;
  try {
    answer = await v2<Partial<ClaimResponse> | null>('simplefin/claim', {
      setup_token: setupToken,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) throw fail('claim_timeout');
    if (errorTypeOf(error) === 'provider_timeout') throw fail('claim_timeout');
    throw rethrowable(error);
  }
  const accessUrl = isObj(answer) ? answer.access_url : undefined;
  if (typeof accessUrl !== 'string' || accessUrl === '') throw fail('provider_bad_response');
  return { access_url: accessUrl };
}

/**
 * service._save_after_claim: after a good claim, any failure is
 * `claim_not_saved`. Without one, catalog errors pass and anything else is
 * `save_failed`.
 */
async function saveStep<T>(claimed: boolean, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (claimed) {
      console.error('connection_claim_not_saved');
      throw fail('claim_not_saved');
    }
    if (error instanceof LocalHttpError) throw error;
    throw fail('save_failed');
  }
}

const sealFor = (
  d: Deps,
  id: string,
  provider: ConnectionProvider,
  credentials: V2Credentials
): Promise<string | null> =>
  provider === 'demo'
    ? Promise.resolve(null)
    : d.vault.seal(id, JSON.stringify({ provider, ...credentials }));

/**
 * The v2 `credentials` for one call: `{}` for the demo, else the unsealed
 * value. A value this browser cannot open, or one for another provider, is
 * recorded as `reconnect_needed` with no provider call and refused. A key
 * store or WebCrypto failure is `storage_unavailable` and changes nothing.
 */
async function openCredentials(
  d: Deps,
  api: LocalAPI,
  id: string,
  start: ConnectionCallStart
): Promise<V2Credentials> {
  if (start.provider === 'demo') return {};
  let credentials: V2Credentials | null = null;
  try {
    const parsed: unknown = JSON.parse(await d.vault.unseal(id, start.sealed ?? ''));
    credentials = credentialsFor(start.provider, parsed);
  } catch (error) {
    // Only a value that cannot be opened here, or is not credentials JSON,
    // needs Reconnect. IndexedDB or WebCrypto failing (SealUnavailable) may
    // pass: nothing counted, the status left as it is.
    if (!(error instanceof SealUnreadable) && !(error instanceof SyntaxError)) {
      api.recordConnectionResult(id, {
        kind: 'failed',
        error_type: 'storage_unavailable',
        requested: false,
      });
      throw fail('storage_unavailable');
    }
    credentials = null;
  }
  if (credentials !== null) return credentials;
  api.recordConnectionResult(id, {
    kind: 'failed',
    error_type: 'reconnect_needed',
    requested: false,
  });
  throw fail('reconnect_needed');
}

function credentialsFor(provider: ConnectionProvider, value: unknown): V2Credentials | null {
  if (!isObj(value) || value.provider !== provider) return null;
  const names = provider === 'simplefin' ? ['access_url'] : ['user_token', 'app_token'];
  const out: V2Credentials = {};
  for (const name of names) {
    const field = value[name];
    if (typeof field !== 'string' || field === '') return null;
    out[name] = field;
  }
  return out;
}

function recordFailure(api: LocalAPI, id: string, error: unknown): void {
  const errorType = errorTypeOf(error);
  api.recordConnectionResult(id, {
    kind: 'failed',
    error_type: errorType,
    requested: !NOT_REQUESTED.has(errorType),
  });
}

/** service._list_accounts: one v2 accounts call on a stored connection, merged. */
async function listAccounts(
  d: Deps,
  api: LocalAPI,
  id: string
): Promise<ConnectionListingResponse> {
  const status = await d.status();
  const start = api.beginConnectionCall(id, status?.enabled);
  try {
    const credentials = await openCredentials(d, api, id, start);
    let answer: ConnectorAccountsResponse;
    try {
      answer = await v2<ConnectorAccountsResponse>(`${start.provider}/accounts`, {
        credentials: credentials as ConnectorCredentials,
      });
    } catch (error) {
      recordFailure(api, id, error);
      throw rethrowable(error);
    }
    return api.mergeConnectionAccounts(id, answer);
  } finally {
    api.endConnectionCall(id);
  }
}

/** service._try_accounts: a failed listing keeps the connection and is reported. */
async function tryAccounts(
  d: Deps,
  api: LocalAPI,
  id: string
): Promise<Pick<ConnectionListingResponse, 'account_errors' | 'accounts_error'>> {
  try {
    const listed = await listAccounts(d, api, id);
    return { accounts_error: null, account_errors: listed.account_errors };
  } catch (error) {
    return { accounts_error: errorTypeOf(error), account_errors: [] };
  }
}

// --- composites -------------------------------------------------------------------------------

/** POST /api/connections (service.create_connection). */
export async function handleLocalConnectionCreate(
  body: unknown,
  deps: CompositeDeps = {}
): Promise<ConnectionListingResponse> {
  const d = withDefaults(deps);
  const request = parseCreate(body);
  const status = await d.status();
  requireEnabled(status, request.provider);
  const input = credentialInput(request.provider, request.body, status);
  const api = d.api();
  const release = api.holdConnection(CREATE_HOLD);
  let releaseId = (): void => undefined;
  try {
    if (api.getConnections().length >= MAX_CONNECTIONS) throw fail('connection_limit');
    await requireKey(d, request.provider);
    const id = d.newId();
    releaseId = api.holdConnection(id);
    const claimed = input.setupToken !== null;
    const credentials =
      input.setupToken !== null ? await claim(input.setupToken) : input.credentials!;
    const sealed = await saveStep(claimed, () => sealFor(d, id, request.provider, credentials));
    await saveStep(claimed, () =>
      api.createConnection(
        {
          id,
          provider: request.provider,
          ...(request.label !== null ? { label: request.label } : {}),
          ...(request.firstSyncDays !== null ? { first_sync_days: request.firstSyncDays } : {}),
          claimed,
        },
        sealed
      )
    );
    const outcome = await tryAccounts(d, api, id);
    return { ...api.getConnection(id), ...outcome };
  } finally {
    releaseId();
    release();
  }
}

/**
 * Reconnect with a pasted credential (an Access URL or Akahu tokens): list the
 * accounts with it first and replace the stored secret only when v2 accepted
 * it, so a mistyped credential never overwrites a working one. A refusal
 * before any provider call is thrown, counting nothing; a provider failure
 * (for example a 401) is reported as `accounts_error` with the stored secret
 * and the status left as they were and the call counted. A claimed setup
 * token cannot wait like this (it is spent), so it is saved first, as on the
 * server.
 */
async function verifyThenReplace(
  d: Deps,
  api: LocalAPI,
  id: string,
  provider: ConnectionProvider,
  credentials: V2Credentials,
  status: ConnectorStatusInfo | null
): Promise<ConnectionListingResponse> {
  api.beginReplacementCall(id, status?.enabled);
  try {
    let answer: ConnectorAccountsResponse;
    try {
      answer = await v2<ConnectorAccountsResponse>(`${provider}/accounts`, {
        credentials: credentials as ConnectorCredentials,
      });
    } catch (error) {
      const errorType = errorTypeOf(error);
      if (NOT_REQUESTED.has(errorType)) {
        api.recordConnectionResult(id, { kind: 'failed', error_type: errorType, requested: false });
        throw rethrowable(error);
      }
      return { ...api.getConnection(id), accounts_error: errorType, account_errors: [] };
    }
    const sealed = await saveStep(false, () => sealFor(d, id, provider, credentials));
    await saveStep(false, () => api.replaceConnectionSecret(id, sealed, false));
    return { ...api.mergeConnectionAccounts(id, answer), accounts_error: null };
  } finally {
    api.endConnectionCall(id);
  }
}

/** POST /api/connections/{id}/credentials (service.replace_credentials). */
export async function handleLocalConnectionCredentials(
  id: string,
  body: unknown,
  deps: CompositeDeps = {}
): Promise<ConnectionListingResponse> {
  const d = withDefaults(deps);
  if (!isObj(body) || !Object.keys(body).every((k) => CREDENTIAL_FIELDS.includes(k))) {
    throw fail('bad_request');
  }
  checkCredentialFields(body);
  const api = d.api();
  const provider = api.getConnection(id).provider;
  const release = api.holdConnection(id);
  try {
    const status = await d.status();
    requireEnabled(status, provider);
    const input = credentialInput(provider, body, status);
    await requireKey(d, provider);
    if (input.setupToken === null && provider !== 'demo') {
      return await verifyThenReplace(d, api, id, provider, input.credentials!, status);
    }
    const claimed = input.setupToken !== null;
    const credentials =
      input.setupToken !== null ? await claim(input.setupToken) : input.credentials!;
    const sealed = await saveStep(claimed, () => sealFor(d, id, provider, credentials));
    await saveStep(claimed, () => api.replaceConnectionSecret(id, sealed, claimed));
    const outcome = await tryAccounts(d, api, id);
    return { ...api.getConnection(id), ...outcome };
  } finally {
    release();
  }
}

/** POST /api/connections/{id}/accounts (service.refresh_accounts). */
export async function handleLocalConnectionAccounts(
  id: string,
  deps: CompositeDeps = {}
): Promise<ConnectionListingResponse> {
  const d = withDefaults(deps);
  const api = d.api();
  const release = api.holdConnection(id);
  try {
    api.getConnection(id);
    return await listAccounts(d, api, id);
  } finally {
    release();
  }
}

/** POST /api/connections/{id}/sync (service.sync_connection). Nothing is applied. */
export async function handleLocalConnectionSync(
  id: string,
  body: unknown,
  deps: CompositeDeps = {}
): Promise<ConnectorSyncResponse> {
  const d = withDefaults(deps);
  const windowIndex = parseWindowIndex(body);
  const api = d.api();
  const release = api.holdConnection(id);
  try {
    const window = api.getConnectionSyncPlan(id).windows[windowIndex];
    if (window === undefined) throw fail('bad_request');
    const status = await d.status();
    const start = api.beginConnectionCall(id, status?.enabled);
    try {
      const credentials = await openCredentials(d, api, id, start);
      const context = api.getSmartImportContext();
      let answer: ConnectorSyncResponse;
      try {
        answer = await v2<ConnectorSyncResponse>(`${start.provider}/sync`, {
          credentials: credentials as ConnectorCredentials,
          start: window.start,
          end: window.end,
          accounts: window.accounts,
          context: { rules: context.rules, categories: context.categories },
        });
      } catch (error) {
        recordFailure(api, id, error);
        throw rethrowable(error);
      }
      api.recordConnectionResult(id, { kind: 'sync', response: answer });
      return answer;
    } finally {
      api.endConnectionCall(id);
    }
  } finally {
    release();
  }
}

const COMPOSITE_PATH = /^\/api\/connections\/([^/]+)\/(credentials|accounts|sync)$/;

/** Run the composite for a local-mode POST that client.ts matched. */
export function routeConnectionComposite(endpoint: string, body: unknown): Promise<unknown> {
  const path = endpoint.split('?')[0]!;
  if (path === '/api/connections') return handleLocalConnectionCreate(body);
  const match = path.match(COMPOSITE_PATH);
  if (!match) return Promise.reject(fail('bad_request'));
  const id = match[1]!;
  if (match[2] === 'credentials') return handleLocalConnectionCredentials(id, body);
  if (match[2] === 'accounts') return handleLocalConnectionAccounts(id);
  return handleLocalConnectionSync(id, body);
}
