/**
 * Hosted-mode connection composites (plan B6): POST /api/connections,
 * /{id}/credentials, /{id}/accounts and /{id}/sync, served by apiCall in local
 * data mode through client.ts. Each one runs the LocalAPI steps around a v2
 * round trip with the credential sealed in this browser (real WebCrypto from
 * Node, fake-indexeddb), and must answer like src/api/connections.py.
 *
 * `fetch` is mocked: the only network the composites may use is
 * /api/v2/connectors/*, and the plaintext credential may appear only in those
 * request bodies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
// Side effect: points sql.js at its wasm file under node_modules.
import '../database/helpers';
import { store } from '@/state/store';
import { clientDB } from '@/database/client-database';
import { getLocalAPI, resetLocalAPICache, isPassthroughAllowed } from '@/api/dispatcher';
import { apiCall, ApiError } from '@/api/client';
import {
  handleLocalConnectionCreate,
  resetConnectorStatusCache,
} from '@/api/connections-composite';
import { seal, unseal } from '@/utils/connector-seal';
import { isSealedValue } from '@/utils/credential-vault';
import { installWebCrypto } from '../utils/webcrypto-support';
import { createMemoryVault } from '../database/memory-vault';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = `acct:${'a'.repeat(64)}`;
const KEY_B = `acct:${'b'.repeat(64)}`;
const KEY_C = `acct:${'c'.repeat(64)}`;
const SETUP_TOKEN = 'aHR0cHM6Ly9ZcTlTZXR1cFRva2VuUGxhbnRlZA==Zq9SetupTokenPlanted';
const ACCESS_URL = 'https://zq9user:Zq9AccessPassPlanted@bridge.simplefin.org/simplefin';
const USER_TOKEN = 'user_Zq9AkahuUserPlanted';
const APP_TOKEN = 'app_Zq9AkahuAppPlanted';
const PLANTED = ['Zq9', 'zq9user', SETUP_TOKEN, ACCESS_URL, USER_TOKEN, APP_TOKEN];
const ENABLED = ['simplefin', 'akahu', 'demo'];

function providerAccount(id: string, o: Row = {}): Row {
  return {
    provider_account_id: id,
    name: 'Everyday',
    institution: 'Sample Bank',
    currency: 'USD',
    balance: 12.5,
    balance_date: '2026-10-03',
    kind_guess: 'checking',
    account_key: KEY,
    error: null,
    ...o,
  };
}

const ACCOUNTS = {
  accounts: [
    providerAccount('chk'),
    providerAccount('card', { name: 'Rewards', kind_guess: 'credit_card', account_key: KEY_B }),
  ],
  errors: [],
};
const syncAnswer = (start: string, end: string, codes: string[] = []): Row => ({
  statements: [],
  account_errors: codes.map((code) => ({ provider_account_id: null, code })),
  window: { start, end },
});

interface Call {
  url: string;
  method: string;
  body: string | null;
}
type Answer = { status: number; body: unknown } | 'network';
type Route = (body: Row | undefined, call: Call) => Answer | Promise<Answer>;

let calls: Call[];
let routes: Record<string, Route>;
let restoreCrypto: () => void;
let restoreUuid: () => void;
let uuidCounter: number;

const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, errorType: string): Answer => ({
  status,
  body: { error_type: errorType, detail: 'Fixed text.' },
});

function installFetch(): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const route = routes[`${call.method} ${url}`];
    if (!route) throw new Error(`unexpected ${call.method} ${url}`);
    const answer = await route(call.body ? (JSON.parse(call.body) as Row) : undefined, call);
    if (answer === 'network') throw new TypeError('Failed to fetch');
    return {
      ok: answer.status < 400,
      status: answer.status,
      statusText: '',
      headers: { get: () => 'application/json' },
      json: async () => answer.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function defaultRoutes(): Record<string, Route> {
  return {
    'GET /api/v2/connectors/status': () =>
      ok({
        enabled: ENABLED,
        providers: [
          { id: 'simplefin', allowed_hosts: ['beta-bridge.simplefin.org', 'bridge.simplefin.org'] },
          { id: 'akahu', allowed_hosts: ['api.akahu.io'] },
          { id: 'demo', allowed_hosts: [] },
        ],
        limits: {},
      }),
    'POST /api/v2/connectors/simplefin/claim': () => ok({ access_url: ACCESS_URL }),
    'POST /api/v2/connectors/simplefin/accounts': () => ok(ACCOUNTS),
    'POST /api/v2/connectors/akahu/accounts': () => ok(ACCOUNTS),
    'POST /api/v2/connectors/demo/accounts': () => ok(ACCOUNTS),
    'POST /api/v2/connectors/simplefin/sync': (b) => ok(syncAnswer(b!.start, b!.end)),
    'POST /api/v2/connectors/demo/sync': (b) => ok(syncAnswer(b!.start, b!.end)),
  };
}

const post = <T = Row>(url: string, body?: unknown): Promise<T> =>
  apiCall<T>(url, { method: 'POST', body });

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  errorType: string
): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${status} ${errorType}`);
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  expect(((error as ApiError).data as Row | undefined)?.error_type).toBe(errorType);
  scan(error);
  scan((error as ApiError).message);
  return error as ApiError;
}

function scan(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const planted of PLANTED) expect(text ?? '').not.toContain(planted);
}

const rawDoc = (): Row => {
  const row = clientDB.query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'connections'"
  )[0];
  return row ? (JSON.parse(row.value) as Row) : { items: {} };
};
const secretOf = (id: string): string | undefined =>
  clientDB.query<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [
    `connection_secret:${id}`,
  ])[0]?.value;
const v2Calls = (suffix: string): Call[] =>
  calls.filter((c) => c.url.startsWith('/api/v2/connectors/') && c.url.endsWith(suffix));

async function createSimplefin(body: Row = { access_url: ACCESS_URL }): Promise<Row> {
  return post('/api/connections', { provider: 'simplefin', ...body });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  restoreCrypto = installWebCrypto();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  const original = globalThis.crypto.randomUUID;
  uuidCounter = 0;
  globalThis.crypto.randomUUID = (() =>
    `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`) as typeof original;
  restoreUuid = () => {
    globalThis.crypto.randomUUID = original;
  };
  clientDB.close();
  await clientDB.createNew();
  resetLocalAPICache();
  resetConnectorStatusCache();
  store.resetState();
  store.set('dataMode', 'local');
  calls = [];
  routes = defaultRoutes();
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreCrypto();
  restoreUuid();
  clientDB.close();
});

describe('routing', () => {
  it('never sends a connection POST to the network as is', () => {
    for (const url of [
      '/api/connections',
      '/api/connections/00000000-0000-4000-8000-000000000001/credentials',
      '/api/connections/00000000-0000-4000-8000-000000000001/accounts',
      '/api/connections/00000000-0000-4000-8000-000000000001/sync',
    ]) {
      expect(isPassthroughAllowed(url, 'POST')).toBe(false);
    }
  });

  it('server mode never enters the composites', async () => {
    store.set('dataMode', 'server');
    routes['POST /api/connections'] = () => ok({ id: 'server' });
    const result = await post('/api/connections', { provider: 'demo' });
    expect(result).toEqual({ id: 'server' });
    expect(calls.map((c) => c.url)).toEqual(['/api/connections']);
    expect(rawDoc().items).toEqual({});
  });

  it('a composite failure from the browser database is an ApiError with the catalog body', async () => {
    await expectApiError(
      post('/api/connections/00000000-0000-4000-8000-000000000099/accounts'),
      404,
      'connection_not_found'
    );
    expect(calls).toEqual([]);
  });
});

describe('create', () => {
  it('claims, seals with the minted id, stores accounts_pending, then lists accounts', async () => {
    let pendingAtListing: Row | undefined;
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => {
      const [id, entry] = Object.entries(rawDoc().items)[0] as [string, Row];
      pendingAtListing = { status: entry.status, secret: secretOf(id) };
      return ok(ACCOUNTS);
    };
    const out = await createSimplefin({ setup_token: SETUP_TOKEN, label: 'My bank' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/v2/connectors/status',
      'POST /api/v2/connectors/simplefin/claim',
      'POST /api/v2/connectors/simplefin/accounts',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ setup_token: SETUP_TOKEN });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ credentials: { access_url: ACCESS_URL } });
    expect(pendingAtListing!.status).toBe('accounts_pending');
    expect(isSealedValue(pendingAtListing!.secret)).toBe(true);
    expect(out).toMatchObject({
      provider: 'simplefin',
      label: 'My bank',
      status: 'ok',
      accounts_count: 2,
      quota_left: 18,
      accounts_error: null,
      account_errors: [],
    });
    expect(out.id).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
    expect(
      Object.fromEntries((out.accounts as Row[]).map((a) => [a.provider_account_id, a.role]))
    ).toEqual({
      card: 'debt',
      chk: 'cash_flow',
    });
    const sealed = secretOf(out.id as string)!;
    expect(isSealedValue(sealed)).toBe(true);
    expect(JSON.parse(await unseal(out.id as string, sealed))).toEqual({
      provider: 'simplefin',
      access_url: ACCESS_URL,
    });
  });

  it('keeps the plaintext in the v2 request bodies only', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const created = await createSimplefin({ setup_token: SETUP_TOKEN });
    const id = created.id as string;
    const akahu = await post('/api/connections', {
      provider: 'akahu',
      user_token: USER_TOKEN,
      app_token: APP_TOKEN,
    });
    const refreshed = await post(`/api/connections/${id}/accounts`);
    const synced = await post(`/api/connections/${id}/sync`, { window_index: 0 });
    const reconnected = await post(`/api/connections/${id}/credentials`, {
      access_url: ACCESS_URL,
    });
    routes['POST /api/v2/connectors/simplefin/sync'] = () => fail(502, 'provider_bad_response');
    await expectApiError(post(`/api/connections/${id}/sync`), 502, 'provider_bad_response');
    for (const value of [created, akahu, refreshed, synced, reconnected]) scan(value);
    for (const spy of spies) scan(spy.mock.calls);
    const everything = JSON.stringify(
      clientDB.query('SELECT key, value FROM app_settings') as unknown[]
    );
    scan(everything);
    for (const call of calls) {
      if (!call.url.startsWith('/api/v2/connectors/')) scan(call);
      expect(call.url).not.toContain('Zq9');
    }
    expect(calls.some((c) => c.body?.includes(SETUP_TOKEN))).toBe(true);
    expect(calls.some((c) => c.body?.includes(USER_TOKEN))).toBe(true);
    for (const id2 of [id, akahu.id as string]) expect(isSealedValue(secretOf(id2))).toBe(true);
  });

  it('refuses the eleventh connection before claiming', async () => {
    for (let i = 0; i < 10; i += 1) await post('/api/connections', { provider: 'demo' });
    calls = [];
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 422, 'connection_limit');
    expect(v2Calls('/claim')).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['unknown provider', { provider: 'plaid' }],
    ['extra field', { provider: 'demo', extra: 1 }],
    ['demo with a credential', { provider: 'demo', access_url: ACCESS_URL }],
    ['simplefin with both', { provider: 'simplefin', setup_token: 'x', access_url: ACCESS_URL }],
    ['simplefin with none', { provider: 'simplefin' }],
    ['simplefin with an akahu token', { provider: 'simplefin', user_token: 'a' }],
    ['akahu with one token', { provider: 'akahu', user_token: USER_TOKEN }],
    ['akahu tokens equal', { provider: 'akahu', user_token: 'abc', app_token: 'abc' }],
    ['akahu token characters', { provider: 'akahu', user_token: 'a b', app_token: 'c' }],
    ['akahu token too long', { provider: 'akahu', user_token: 'a'.repeat(513), app_token: 'c' }],
    ['empty setup token', { provider: 'simplefin', setup_token: '' }],
    ['setup token too long', { provider: 'simplefin', setup_token: 'x'.repeat(4097) }],
    ['setup token not text', { provider: 'simplefin', setup_token: 7 }],
    ['empty label', { provider: 'demo', label: '' }],
    ['long label', { provider: 'demo', label: 'x'.repeat(121) }],
    ['control in label', { provider: 'demo', label: 'a\tb' }],
    ['range', { provider: 'demo', first_sync_days: 45 }],
    ['range as text', { provider: 'demo', first_sync_days: '30' }],
  ])('refuses a bad body before any call (%s)', async (_name, body) => {
    await expectApiError(post('/api/connections', body), 422, 'bad_request');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(rawDoc().items).toEqual({});
  });

  it('accepts null optional fields like the server', async () => {
    const out = await post('/api/connections', {
      provider: 'demo',
      label: null,
      first_sync_days: null,
      setup_token: null,
    });
    expect(out).toMatchObject({ label: 'Demo', first_sync_days: 90, status: 'ok' });
  });

  it('a disabled provider is refused before the setup token is used', async () => {
    routes['GET /api/v2/connectors/status'] = () => ok({ enabled: ['demo'] });
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 503, 'connector_disabled');
    expect(v2Calls('/claim')).toEqual([]);
    expect(rawDoc().items).toEqual({});
  });

  it('without the status list, the claim itself refuses a disabled provider', async () => {
    routes['GET /api/v2/connectors/status'] = () => 'network';
    routes['POST /api/v2/connectors/simplefin/claim'] = () => fail(503, 'connector_disabled');
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 503, 'connector_disabled');
    expect(rawDoc().items).toEqual({});
  });

  it('an unusable key store refuses before the claim with save_failed', async () => {
    const saved = globalThis.indexedDB;
    (globalThis as unknown as { indexedDB: undefined }).indexedDB = undefined;
    try {
      await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 500, 'save_failed');
    } finally {
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = saved;
    }
    expect(v2Calls('/claim')).toEqual([]);
    expect(rawDoc().items).toEqual({});
  });

  it.each([
    ['a timeout answer', () => fail(504, 'provider_timeout')],
    ['a lost answer', () => 'network' as const],
  ])('a claim with %s is claim_timeout and stores nothing', async (_name, route) => {
    routes['POST /api/v2/connectors/simplefin/claim'] = route;
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 504, 'claim_timeout');
    expect(rawDoc().items).toEqual({});
  });

  it('a refused claim passes through and stores nothing', async () => {
    routes['POST /api/v2/connectors/simplefin/claim'] = () => fail(403, 'claim_refused');
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 403, 'claim_refused');
    expect(rawDoc().items).toEqual({});
  });

  it('a save that fails after a good claim is claim_not_saved', async () => {
    const api = getLocalAPI();
    vi.spyOn(api, 'createConnection').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expectApiError(createSimplefin({ setup_token: SETUP_TOKEN }), 500, 'claim_not_saved');
    vi.restoreAllMocks();
    // The same failure without a claim keeps its own error.
    const vault = createMemoryVault();
    vi.spyOn(api, 'createConnection').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      handleLocalConnectionCreate(
        { provider: 'simplefin', access_url: ACCESS_URL },
        { vault, ready: () => Promise.resolve(), api: () => api }
      )
    ).rejects.toMatchObject({ errorType: 'save_failed' });
  });

  it('a seal that fails after a good claim is claim_not_saved', async () => {
    const vault = createMemoryVault();
    vault.seal = () => Promise.reject(new Error('no key'));
    await expect(
      handleLocalConnectionCreate(
        { provider: 'simplefin', setup_token: SETUP_TOKEN },
        { vault, ready: () => Promise.resolve() }
      )
    ).rejects.toMatchObject({ errorType: 'claim_not_saved', status: 500 });
    expect(rawDoc().items).toEqual({});
  });

  it('an accounts failure after the claim keeps the connection and its credential', async () => {
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(502, 'provider_unavailable');
    const out = await createSimplefin({ setup_token: SETUP_TOKEN });
    expect(out).toMatchObject({
      status: 'accounts_pending',
      accounts_count: 0,
      quota_left: 18,
      accounts_error: 'provider_unavailable',
      account_errors: [],
    });
    const id = out.id as string;
    expect(isSealedValue(secretOf(id))).toBe(true);
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => ok(ACCOUNTS);
    const done = await post(`/api/connections/${id}/accounts`);
    expect(done).toMatchObject({ status: 'ok', accounts_count: 2, quota_left: 17 });
    expect(done.account_errors).toEqual([]);
    expect(done).not.toHaveProperty('accounts_error');
  });

  it('a network failure listing accounts is provider_unavailable and counted', async () => {
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => 'network';
    const out = await createSimplefin();
    expect(out).toMatchObject({ accounts_error: 'provider_unavailable', quota_left: 19 });
  });

  it('a 401 while listing sets reconnect_needed', async () => {
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(409, 'reconnect_needed');
    const out = await createSimplefin();
    expect(out).toMatchObject({ status: 'reconnect_needed', accounts_error: 'reconnect_needed' });
  });

  it('a v2 refusal before the provider call counts nothing', async () => {
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(503, 'connector_disabled');
    const out = await createSimplefin();
    expect(out).toMatchObject({ accounts_error: 'connector_disabled', quota_left: 20 });
  });

  it('the demo needs no credential and stores no secret', async () => {
    const out = await post('/api/connections', { provider: 'demo', first_sync_days: 30 });
    expect(out).toMatchObject({ provider: 'demo', status: 'ok', quota_left: null });
    expect(JSON.parse(v2Calls('/demo/accounts')[0]!.body!)).toEqual({ credentials: {} });
    expect(secretOf(out.id as string)).toBeUndefined();
    expect(v2Calls('/claim')).toEqual([]);
  });

  it('akahu tokens are trimmed like the server and sent as a pair', async () => {
    await post('/api/connections', {
      provider: 'akahu',
      user_token: ` ${USER_TOKEN}\n`,
      app_token: APP_TOKEN,
    });
    expect(JSON.parse(v2Calls('/akahu/accounts')[0]!.body!)).toEqual({
      credentials: { user_token: USER_TOKEN, app_token: APP_TOKEN },
    });
  });

  it('holds the minted id from the moment it exists', async () => {
    const api = getLocalAPI();
    const hold = vi.spyOn(api, 'holdConnection');
    const out = await createSimplefin({ setup_token: SETUP_TOKEN });
    expect(hold.mock.calls.map((c) => c[0])).toEqual(['create', out.id]);
    expect(() => api.holdConnection(out.id as string)()).not.toThrow();
  });

  it('two creates at once: the second is busy before it claims', async () => {
    let release!: () => void;
    routes['POST /api/v2/connectors/simplefin/claim'] = () =>
      new Promise((resolve) => {
        release = () => resolve(ok({ access_url: ACCESS_URL }));
      });
    const first = createSimplefin({ setup_token: SETUP_TOKEN });
    await vi.waitFor(() => expect(v2Calls('/claim')).toHaveLength(1));
    await expectApiError(createSimplefin({ setup_token: 'other' }), 409, 'connection_busy');
    release();
    await expect(first).resolves.toMatchObject({ status: 'ok' });
    expect(v2Calls('/claim')).toHaveLength(1);
  });
});

describe('access URL check', () => {
  it.each([
    ['http', 'http://u:p@bridge.simplefin.org/simplefin'],
    ['no password', 'https://u@bridge.simplefin.org/simplefin'],
    ['no userinfo', 'https://bridge.simplefin.org/simplefin'],
    ['another host', 'https://u:p@evil.example/simplefin'],
    ['a lookalike host', 'https://u:p@bridge.simplefin.org.evil.example/simplefin'],
    ['another port', 'https://u:p@bridge.simplefin.org:8443/simplefin'],
    ['another path', 'https://u:p@bridge.simplefin.org/other'],
    ['a prefix path', 'https://u:p@bridge.simplefin.org/simplefinx'],
    ['a query', 'https://u:p@bridge.simplefin.org/simplefin?x=1'],
    ['an empty query', 'https://u:p@bridge.simplefin.org/simplefin?'],
    ['a fragment', 'https://u:p@bridge.simplefin.org/simplefin#x'],
    ['not a URL', 'Zq9 not a url'],
  ])('create refuses %s before anything is stored', async (_name, url) => {
    await expectApiError(createSimplefin({ access_url: url }), 422, 'host_not_allowed');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(rawDoc().items).toEqual({});
    expect(clientDB.query("SELECT key FROM app_settings WHERE key LIKE 'connection%'")).toEqual([]);
  });

  it.each([
    ['port 443', 'https://u:p@bridge.simplefin.org:443/simplefin'],
    ['a deeper path', 'https://u:p@BETA-bridge.simplefin.org/simplefin/v2/'],
    ['surrounding space', ' https://u:p@bridge.simplefin.org/simplefin\n'],
  ])('create accepts %s', async (_name, url) => {
    await expect(createSimplefin({ access_url: url })).resolves.toMatchObject({ status: 'ok' });
  });

  it('without the status list the check is left to v2', async () => {
    routes['GET /api/v2/connectors/status'] = () => 'network';
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(422, 'host_not_allowed');
    const out = await createSimplefin({ access_url: 'https://u:p@evil.example/simplefin' });
    expect(out).toMatchObject({ accounts_error: 'host_not_allowed', quota_left: 20 });
  });
});

describe('reconnect', () => {
  it('replaces the credential, keeps id and mapping, and refreshes', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    await apiCall(`/api/connections/${id}`, {
      method: 'PUT',
      body: { accounts: { chk: { label: 'Mine' } } },
    });
    clientDB.execute('UPDATE app_settings SET value = ? WHERE key = ?', [
      'fernet:gAAAAABserver',
      `connection_secret:${id}`,
    ]);
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    expect(rawDoc().items[id].status).toBe('reconnect_needed');
    calls = [];
    const out = await post(`/api/connections/${id}/credentials`, { setup_token: SETUP_TOKEN });
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v2/connectors/simplefin/claim',
      '/api/v2/connectors/simplefin/accounts',
    ]);
    expect(out).toMatchObject({ id, status: 'ok', accounts_error: null });
    expect((out.accounts as Row[]).find((a) => a.provider_account_id === 'chk')!.label).toBe(
      'Mine'
    );
    expect(isSealedValue(secretOf(id))).toBe(true);
  });

  it.each([
    ['a provider field', { provider: 'simplefin', access_url: ACCESS_URL }],
    ['another provider', { user_token: USER_TOKEN, app_token: APP_TOKEN }],
    ['nothing', {}],
  ])('refuses %s', async (_name, body) => {
    const created = await createSimplefin();
    calls = [];
    await expectApiError(
      post(`/api/connections/${created.id as string}/credentials`, body),
      422,
      'bad_request'
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a save that fails after a good claim is claim_not_saved', async () => {
    const created = await createSimplefin();
    vi.spyOn(getLocalAPI(), 'replaceConnectionSecret').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expectApiError(
      post(`/api/connections/${created.id as string}/credentials`, { setup_token: SETUP_TOKEN }),
      500,
      'claim_not_saved'
    );
  });

  it('a bad Access URL keeps the working credential', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    const before = secretOf(id);
    calls = [];
    await expectApiError(
      post(`/api/connections/${id}/credentials`, {
        access_url: 'https://u:p@evil.example/simplefin',
      }),
      422,
      'host_not_allowed'
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(secretOf(id)).toBe(before);
    expect(rawDoc().items[id].status).toBe('ok');
    await post(`/api/connections/${id}/sync`);
    expect(JSON.parse(v2Calls('/sync')[0]!.body!).credentials).toEqual({ access_url: ACCESS_URL });
  });

  it('lists with a pasted credential before replacing the stored one', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    const before = secretOf(id);
    const NEW_URL = 'https://zq9new:Zq9NewPassPlanted@bridge.simplefin.org/simplefin';
    let storedDuringCall: string | undefined;
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => {
      storedDuringCall = secretOf(id);
      return ok(ACCOUNTS);
    };
    calls = [];
    const out = await post(`/api/connections/${id}/credentials`, { access_url: NEW_URL });
    expect(storedDuringCall).toBe(before);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ credentials: { access_url: NEW_URL } });
    expect(out).toMatchObject({ id, status: 'ok', accounts_error: null, quota_left: 18 });
    expect(secretOf(id)).not.toBe(before);
    expect(JSON.parse(await unseal(id, secretOf(id)!)).access_url).toBe(NEW_URL);
  });

  it('a credential the provider refuses is reported and replaces nothing', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    const before = secretOf(id);
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(409, 'reconnect_needed');
    const out = await post(`/api/connections/${id}/credentials`, { access_url: ACCESS_URL });
    expect(out).toMatchObject({
      status: 'ok',
      accounts_error: 'reconnect_needed',
      account_errors: [],
      quota_left: 18,
    });
    expect(secretOf(id)).toBe(before);
  });

  it('a v2 refusal of a pasted credential is thrown, counts nothing and replaces nothing', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    const before = secretOf(id);
    resetConnectorStatusCache();
    routes['GET /api/v2/connectors/status'] = () => 'network';
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(422, 'host_not_allowed');
    await expectApiError(
      post(`/api/connections/${id}/credentials`, {
        access_url: 'https://u:p@evil.example/simplefin',
      }),
      422,
      'host_not_allowed'
    );
    expect(secretOf(id)).toBe(before);
    expect(getLocalAPI().getConnection(id).quota_left).toBe(19);
  });

  it('a pasted credential restores a reconnect_needed connection', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    clientDB.execute('UPDATE app_settings SET value = ? WHERE key = ?', [
      'fernet:gAAAAABserver',
      `connection_secret:${id}`,
    ]);
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    const out = await post(`/api/connections/${id}/credentials`, { access_url: ACCESS_URL });
    expect(out).toMatchObject({ status: 'ok', accounts_error: null });
    expect(isSealedValue(secretOf(id))).toBe(true);
  });

  it('is 404 for an unknown connection, before any call', async () => {
    await expectApiError(
      post('/api/connections/00000000-0000-4000-8000-000000000099/credentials', {
        access_url: ACCESS_URL,
      }),
      404,
      'connection_not_found'
    );
    expect(calls).toEqual([]);
  });
});

describe('refresh', () => {
  it('unseals for one v2 request and adds new accounts as ignore', async () => {
    const created = await createSimplefin();
    const id = created.id as string;
    routes['POST /api/v2/connectors/simplefin/accounts'] = () =>
      ok({
        accounts: [
          ...ACCOUNTS.accounts,
          providerAccount('sav', { kind_guess: 'savings', account_key: KEY_C }),
        ],
        errors: ['provider_rate_limited'],
      });
    calls = [];
    const out = await post(`/api/connections/${id}/accounts`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ credentials: { access_url: ACCESS_URL } });
    expect(out).toMatchObject({ status: 'rate_limited', accounts_count: 3 });
    expect((out.accounts as Row[]).find((a) => a.provider_account_id === 'sav')!.role).toBe(
      'ignore'
    );
    expect(out.account_errors).toEqual([
      { provider_account_id: null, code: 'provider_rate_limited' },
    ]);
  });

  it('rethrows a provider failure after recording it', async () => {
    const created = await createSimplefin();
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(409, 'payment_required');
    await expectApiError(
      post(`/api/connections/${created.id as string}/accounts`),
      409,
      'payment_required'
    );
    expect(rawDoc().items[created.id as string].status).toBe('payment_required');
  });
});

describe('sync', () => {
  async function connected(): Promise<string> {
    const created = await createSimplefin();
    calls = [];
    return created.id as string;
  }

  it('sends the plan window, the accounts and the rules context, then records the result', async () => {
    const id = await connected();
    const api = getLocalAPI();
    const plan = api.getConnectionSyncPlan(id);
    const context = api.getSmartImportContext();
    const out = await post(`/api/connections/${id}/sync`, {});
    expect(calls.map((c) => c.url)).toEqual(['/api/v2/connectors/simplefin/sync']);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      credentials: { access_url: ACCESS_URL },
      start: plan.windows[0]!.start,
      end: plan.windows[0]!.end,
      accounts: plan.windows[0]!.accounts,
      context: { rules: context.rules, categories: context.categories },
    });
    expect(out).toEqual(syncAnswer(plan.windows[0]!.start, plan.windows[0]!.end));
    const stored = rawDoc().items[id];
    expect(stored.last_synced_at).toMatch(/Z$/);
    expect(stored.status).toBe('ok');
    expect(api.getConnection(id).quota_left).toBe(18);
  });

  it('an empty body means window 0', async () => {
    const id = await connected();
    await post(`/api/connections/${id}/sync`);
    expect(v2Calls('/sync')).toHaveLength(1);
  });

  it.each([
    ['text', { window_index: '0' }],
    ['fraction', { window_index: 0.5 }],
    ['bool', { window_index: true }],
    ['negative', { window_index: -1 }],
    ['above 3', { window_index: 4 }],
    ['outside the plan', { window_index: 1 }],
    ['extra field', { window_index: 0, all: true }],
    ['not an object', [0]],
  ])('refuses a window index that is %s before the network', async (_name, body) => {
    const id = await connected();
    await expectApiError(post(`/api/connections/${id}/sync`, body), 422, 'bad_request');
    expect(calls).toEqual([]);
  });

  it('a connection without accounts has no windows: bad_request', async () => {
    routes['POST /api/v2/connectors/simplefin/accounts'] = () => fail(502, 'provider_unavailable');
    const id = await connected();
    await expectApiError(post(`/api/connections/${id}/sync`), 422, 'bad_request');
    expect(calls).toEqual([]);
  });

  it('a server-sealed (fernet:) secret sets reconnect_needed before the network', async () => {
    const id = await connected();
    clientDB.execute('UPDATE app_settings SET value = ? WHERE key = ?', [
      'fernet:gAAAAABserver',
      `connection_secret:${id}`,
    ]);
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    expect(calls).toEqual([]);
    expect(rawDoc().items[id].status).toBe('reconnect_needed');
  });

  it('a value sealed in another browser (no key here) sets reconnect_needed and counts nothing', async () => {
    const id = await connected();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const before = getLocalAPI().getConnection(id).quota_left;
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(rawDoc().items[id].status).toBe('reconnect_needed');
    expect(getLocalAPI().getConnection(id).quota_left).toBe(before);
  });

  it('a credential sealed for another provider sets reconnect_needed', async () => {
    const id = await connected();
    const foreign = await seal(
      id,
      JSON.stringify({ provider: 'akahu', user_token: USER_TOKEN, app_token: APP_TOKEN })
    );
    clientDB.execute('UPDATE app_settings SET value = ? WHERE key = ?', [
      foreign,
      `connection_secret:${id}`,
    ]);
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a sealed value that is not credentials JSON sets reconnect_needed without echoing it', async () => {
    const id = await connected();
    const odd = await seal(id, 'Zq9 not json {');
    clientDB.execute('UPDATE app_settings SET value = ? WHERE key = ?', [
      odd,
      `connection_secret:${id}`,
    ]);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expectApiError(post(`/api/connections/${id}/sync`), 409, 'reconnect_needed');
    scan(spy.mock.calls);
  });

  it('refuses before the network when the daily quota is used', async () => {
    const id = await connected();
    for (let i = 0; i < 19; i += 1) await post(`/api/connections/${id}/sync`);
    calls = [];
    const error = await expectApiError(post(`/api/connections/${id}/sync`), 429, 'quota_reached');
    expect(error.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it('two concurrent syncs at quota 1 reach the provider once', async () => {
    const id = await connected();
    for (let i = 0; i < 18; i += 1) await post(`/api/connections/${id}/sync`);
    expect(getLocalAPI().getConnection(id).quota_left).toBe(1);
    calls = [];
    let release!: () => void;
    routes['POST /api/v2/connectors/simplefin/sync'] = (b) =>
      new Promise((resolve) => {
        release = () => resolve(ok(syncAnswer(b!.start, b!.end)));
      });
    const first = post(`/api/connections/${id}/sync`);
    const second = post(`/api/connections/${id}/sync`);
    await expectApiError(second, 409, 'connection_busy');
    await vi.waitFor(() => expect(v2Calls('/sync')).toHaveLength(1));
    // Mid-call the reservation already shows the quota as used.
    expect(getLocalAPI().getConnection(id).quota_left).toBe(0);
    release();
    await first;
    await expectApiError(post(`/api/connections/${id}/sync`), 429, 'quota_reached');
    expect(v2Calls('/sync')).toHaveLength(1);
    expect(getLocalAPI().getConnection(id).quota_left).toBe(0);
  });

  it('disconnect waits for nothing: it is refused while a sync is out', async () => {
    const id = await connected();
    let release!: () => void;
    routes['POST /api/v2/connectors/simplefin/sync'] = (b) =>
      new Promise((resolve) => {
        release = () => resolve(ok(syncAnswer(b!.start, b!.end)));
      });
    const running = post(`/api/connections/${id}/sync`);
    await vi.waitFor(() => expect(v2Calls('/sync')).toHaveLength(1));
    await expectApiError(
      apiCall(`/api/connections/${id}?remove_data=false`, { method: 'DELETE' }),
      409,
      'connection_busy'
    );
    release();
    await running;
    await apiCall(`/api/connections/${id}?remove_data=false`, { method: 'DELETE' });
    expect(rawDoc().items).toEqual({});
  });

  it.each([
    ['reconnect_needed', 409, 'reconnect_needed', 18],
    ['payment_required', 409, 'payment_required', 18],
    ['provider_rate_limited', 429, 'rate_limited', 18],
    ['provider_bad_response', 502, 'ok', 18],
    ['window_too_long', 422, 'ok', 19],
    ['connector_disabled', 503, 'ok', 19],
  ])('a v2 %s is recorded and rethrown', async (errorType, status, connStatus, quotaLeft) => {
    const id = await connected();
    routes['POST /api/v2/connectors/simplefin/sync'] = () => fail(status, errorType);
    await expectApiError(post(`/api/connections/${id}/sync`), status, errorType);
    expect(rawDoc().items[id].status).toBe(connStatus);
    expect(rawDoc().items[id].last_synced_at).toBeNull();
    expect(getLocalAPI().getConnection(id).quota_left).toBe(quotaLeft);
    // The connection is free again.
    routes['POST /api/v2/connectors/simplefin/sync'] = (b) => ok(syncAnswer(b!.start, b!.end));
    if (connStatus !== 'reconnect_needed') await post(`/api/connections/${id}/sync`);
  });

  it('a disabled provider from the status list is refused before the quota and the network', async () => {
    const id = await connected();
    resetConnectorStatusCache();
    routes['GET /api/v2/connectors/status'] = () => ok({ enabled: ['demo'] });
    calls = [];
    await expectApiError(post(`/api/connections/${id}/sync`), 503, 'connector_disabled');
    expect(calls.map((c) => c.url)).toEqual(['/api/v2/connectors/status']);
  });

  it('a key store failure is storage_unavailable and leaves the connection as it was', async () => {
    const id = await connected();
    const quota = getLocalAPI().getConnection(id).quota_left;
    const saved = globalThis.indexedDB;
    (globalThis as unknown as { indexedDB: undefined }).indexedDB = undefined;
    try {
      await expectApiError(post(`/api/connections/${id}/sync`), 503, 'storage_unavailable');
      await expectApiError(post(`/api/connections/${id}/accounts`), 503, 'storage_unavailable');
    } finally {
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = saved;
    }
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(rawDoc().items[id].status).toBe('ok');
    expect(getLocalAPI().getConnection(id).quota_left).toBe(quota);
    await post(`/api/connections/${id}/sync`);
    expect(rawDoc().items[id].status).toBe('ok');
  });

  it('a WebCrypto failure is storage_unavailable too', async () => {
    const id = await connected();
    const target = globalThis.crypto as unknown as Record<string, unknown>;
    const subtle = target.subtle;
    target.subtle = undefined;
    try {
      await expectApiError(post(`/api/connections/${id}/sync`), 503, 'storage_unavailable');
    } finally {
      target.subtle = subtle;
    }
    expect(rawDoc().items[id].status).toBe('ok');
    await post(`/api/connections/${id}/sync`);
  });

  it('releases the connection after a failure outside v2', async () => {
    const id = await connected();
    const api = getLocalAPI();
    vi.spyOn(api, 'getSmartImportContext').mockImplementationOnce(() => {
      throw new Error('broken');
    });
    await expect(post(`/api/connections/${id}/sync`)).rejects.toThrow();
    await post(`/api/connections/${id}/sync`);
    vi.spyOn(api, 'mergeConnectionAccounts').mockImplementationOnce(() => {
      throw new Error('broken');
    });
    await expect(post(`/api/connections/${id}/accounts`)).rejects.toThrow();
    await post(`/api/connections/${id}/accounts`);
    await apiCall(`/api/connections/${id}?remove_data=false`, { method: 'DELETE' });
    expect(rawDoc().items).toEqual({});
  });

  it('the demo syncs without a credential', async () => {
    const created = await post('/api/connections', { provider: 'demo' });
    calls = [];
    await post(`/api/connections/${created.id as string}/sync`);
    expect(JSON.parse(v2Calls('/demo/sync')[0]!.body!).credentials).toEqual({});
  });
});
