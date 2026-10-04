/**
 * Connections in the browser database for hosted mode (plan B5): the twin of
 * src/connectors/service.py behind LocalAPI. Covers the shared plan cases
 * (tests/fixtures/connections_plan_cases.json, the server's own answers),
 * create with a sealed credential, list, detail, update, the account merge,
 * the call gates and result recording that the B6 composites use, the plan
 * from applied imports (Undo rewinds it), the dispatcher routes, and that no
 * credential ever leaves through a list or detail.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmartImportHttpError } from '@/database/local-smart-import';
import {
  instantOf,
  newestImportEnds,
  sanitize,
  readConnections,
} from '@/database/local-connections-store';
import { connectionDetail } from '@/database/local-connections';
import { clientDB } from '@/database/client-database';
import {
  tryLocalRoute,
  resetLocalAPICache,
  isPassthroughAllowed,
  NOT_HANDLED,
} from '@/api/dispatcher';
import { isSealedValue } from '@/utils/credential-vault';
import type { ClientDatabase } from '@/database/client-database';
import {
  addConnections,
  addLiability,
  applyBody,
  connectionEntry,
  setup,
  statement,
  teardown,
  txn,
  type Env,
  type Row,
} from './smart-import-support';
import { createTestApi, useSequentialUuids } from './helpers';
import { createMemoryVault } from './memory-vault';

interface PlanCase {
  name: string;
  today: string;
  now: string;
  id: string;
  connection: Row;
  import_ends: Record<string, string>;
  posted: Record<string, string>;
  /** Applied imports of any connection; when present, also run through the database. */
  imports?: { connection_id: string | null; account_key: string; period_end: string }[];
  detail: Row;
}

const PLAN_CASES = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), '../../tests/fixtures/connections_plan_cases.json'),
      'utf8'
    )
  ) as { cases: PlanCase[] }
).cases;

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ID2 = '11111111-2222-4333-8444-555555555555';
const KEY = `acct:${'a'.repeat(64)}`;
const KEY_B = `acct:${'b'.repeat(64)}`;
const KEY_C = `acct:${'c'.repeat(64)}`;
const LIAB = '0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d';
const SEALED = 'wc1:AAAAAAAAAAAAAAAA:Zq9SealedPlantedCipherAA';
const SEALED_2 = 'wc1:BBBBBBBBBBBBBBBB:Zq9SecondPlantedCipherAB';
const SUMMARY_KEYS = [
  'accounts_count',
  'accounts_enabled',
  'created_at',
  'first_sync_days',
  'id',
  'label',
  'last_synced_at',
  'provider',
  'quota_budget',
  'quota_left',
  'quota_resets_at',
  'status',
  'status_at',
];
const ACCOUNT_KEYS = [
  'account_key',
  'currency',
  'flip_balance',
  'institution',
  'kind',
  'label',
  'liability_id',
  'name',
  'next_since',
  'provider_account_id',
  'role',
  'same_as_key',
];
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('plan cases shared with the server', () => {
  it.each(PLAN_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const doc = sanitize({ version: 1, items: { [c.id]: c.connection } }, instantOf(c.now)!);
    const detail = connectionDetail(c.id, doc.items[c.id]!, c.import_ends, c.posted, c.today);
    expect(detail).toEqual(c.detail);
  });
});

let env: Env;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => teardown(env));

const api = (): Env['api'] => env.api;

describe('plan cases with imports, through the browser database', () => {
  const cases = PLAN_CASES.filter((c) => c.imports !== undefined);

  it('has some', () => {
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const [y, m, d] = c.today.split('-').map(Number) as [number, number, number];
    vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));
    c.imports!.forEach((row, i) => {
      env.db.execute(
        `INSERT INTO bank_statement_imports (id, file_name, content_hash, row_count, status)
         VALUES (?, 'x', ?, 0, 'applied')`,
        [`imp-${i}`, `h${i}`]
      );
      env.db.execute(
        `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind,
           account_key, period_start, period_end, connection_id)
         VALUES (?, 'b1', 'connector', 'connector', 'connector:demo', 'checking', ?, ?, ?, ?)`,
        [`imp-${i}`, row.account_key, row.period_end, row.period_end, row.connection_id]
      );
    });
    const keys = [...new Set(c.imports!.map((r) => r.account_key))];
    expect(newestImportEnds(env.db, c.id, keys)).toEqual(c.import_ends);
    addConnections(env.db, { [c.id]: c.connection });
    expect(api().getConnection(c.id)).toEqual(c.detail);
  });
});
const later = (ms = 2000): void => vi.setSystemTime(new Date(Date.now() + ms));
const nowStamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function expectError(fn: () => unknown, status: number, errorType: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SmartImportHttpError);
    expect((e as SmartImportHttpError).status).toBe(status);
    expect((e as SmartImportHttpError).errorType).toBe(errorType);
    const text = JSON.stringify((e as SmartImportHttpError).data);
    expect(text).not.toContain('Zq9');
    return;
  }
  throw new Error(`expected ${status} ${errorType}`);
}

const secretRow = (db: ClientDatabase, id: string): Row | undefined =>
  db.query<Row>('SELECT key, value, encrypted FROM app_settings WHERE key = ?', [
    `connection_secret:${id}`,
  ])[0];
const rawDoc = (db: ClientDatabase): Row =>
  JSON.parse(
    db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'connections'")[0]!
      .value
  ) as Row;

const create = (o: Row = {}, sealed: string | null = SEALED): Row =>
  api().createConnection(
    { id: ID, provider: 'simplefin', claimed: false, ...o } as never,
    sealed
  ) as unknown as Row;

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

const merge = (accounts: Row[], errors: string[] = [], id = ID): Row =>
  api().mergeConnectionAccounts(id, { accounts, errors } as never) as unknown as Row;

function scanForSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain('Zq9');
  expect(text).not.toContain('wc1:');
  expect(text).not.toContain('connection_secret');
}

describe('createConnection', () => {
  it('stores the sealed credential with encrypted=1 and never returns it', () => {
    const detail = create({ claimed: true, label: 'My bank', first_sync_days: 30 });
    expect(Object.keys(detail).sort()).toEqual([...SUMMARY_KEYS, 'accounts', 'windows'].sort());
    expect(detail).toMatchObject({
      id: ID,
      provider: 'simplefin',
      label: 'My bank',
      status: 'accounts_pending',
      last_synced_at: null,
      first_sync_days: 30,
      accounts_count: 0,
      accounts_enabled: 0,
      quota_budget: 20,
      quota_left: 19,
      quota_resets_at: null,
      accounts: [],
      windows: [],
    });
    expect(detail.created_at).toMatch(STAMP);
    expect(detail.status_at).toBe(detail.created_at);
    expect(secretRow(env.db, ID)).toEqual({
      key: `connection_secret:${ID}`,
      value: SEALED,
      encrypted: 1,
    });
    const stored = rawDoc(env.db).items[ID];
    expect(stored.requests).toEqual([detail.created_at]);
    expect(JSON.stringify(stored)).not.toContain('wc1:');
    scanForSecrets(detail);
    scanForSecrets(api().getConnections());
    scanForSecrets(api().getConnection(ID));
  });

  it('counts no request without a claim and defaults the label and range', () => {
    const detail = create();
    expect(detail.label).toBe('SimpleFIN');
    expect(detail.first_sync_days).toBe(90);
    expect(detail.quota_left).toBe(20);
    expect(create({ id: ID2, provider: 'akahu' }).label).toBe('Akahu');
  });

  it('keeps no secret row for the demo, and refuses one', () => {
    expectError(() => create({ provider: 'demo' }), 422, 'bad_request');
    const detail = create({ provider: 'demo' }, null);
    expect(detail).toMatchObject({ label: 'Demo', quota_budget: null, quota_left: null });
    expect(secretRow(env.db, ID)).toBeUndefined();
  });

  it.each([
    ['plaintext Access URL', 'https://zq9user:Zq9pass@bridge.simplefin.org/simplefin'],
    ['server value', 'fernet:Zq9AAAA'],
    ['JSON credentials', '{"access_url":"Zq9"}'],
    ['empty', ''],
    ['prefix only', 'wc1:'],
    ['one part', 'wc1:Zq9AAAA'],
    ['three parts', 'wc1:AAAA:BBBB:Zq9'],
    ['spaces', 'wc1:AA AA:Zq9B'],
    ['too long', `wc1:AAAA:${'Zq9'.repeat(6000)}`],
  ])('refuses a credential that is not sealed (%s)', (_name, value) => {
    expectError(() => create({}, value), 422, 'bad_request');
    expectError(() => create({}, null), 422, 'bad_request');
    expect(env.db.query("SELECT key FROM app_settings WHERE key LIKE 'connection%'")).toEqual([]);
  });

  it.each([
    ['uppercase id', { id: ID.toUpperCase() }],
    ['not a uuid', { id: 'connections' }],
    ['unknown provider', { provider: 'plaid' }],
    ['empty label', { label: '' }],
    ['long label', { label: 'x'.repeat(121) }],
    ['control in label', { label: 'a\nb' }],
    ['label not text', { label: 7 }],
    ['range', { first_sync_days: 45 }],
    ['range as text', { first_sync_days: '30' }],
    ['claimed not bool', { claimed: 'yes' }],
    ['extra field', { access_url: 'https://x' }],
  ])('validates the metadata (%s)', (_name, meta) => {
    expectError(() => create(meta), 422, 'bad_request');
    expect(env.db.query("SELECT key FROM app_settings WHERE key LIKE 'connection%'")).toEqual([]);
  });

  it('accepts a 120 character label counted in code points', () => {
    expect(create({ label: String.fromCodePoint(0x1f600).repeat(120) }).label).toHaveLength(240);
  });

  it('refuses an id that already exists', () => {
    create();
    expectError(() => create({}, SEALED_2), 422, 'bad_request');
    expect(secretRow(env.db, ID)!.value).toBe(SEALED);
  });

  it('refuses the eleventh connection with connection_limit', () => {
    for (let i = 0; i < 10; i++) {
      create({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
    }
    const before = env.db.query('SELECT key, value FROM app_settings ORDER BY key');
    expectError(() => create({ id: ID2 }), 422, 'connection_limit');
    expect(env.db.query('SELECT key, value FROM app_settings ORDER BY key')).toEqual(before);
  });

  it('writes the document sorted and sanitized', () => {
    addConnections(env.db, { [ID2]: { ...connectionEntry(), junk: 1 }, bad: connectionEntry() });
    create();
    const doc = rawDoc(env.db);
    expect(Object.keys(doc.items)).toEqual([ID, ID2].sort());
    expect(doc.items[ID2].junk).toBeUndefined();
    expect(doc.version).toBe(1);
  });
});

describe('list and detail', () => {
  it('lists summaries oldest first, then by id', () => {
    const b = '22222222-2222-4222-8222-222222222222';
    const a = '11111111-1111-4111-8111-111111111111';
    addConnections(env.db, {
      [b]: connectionEntry({ created_at: '2026-10-01T09:00:00Z' }),
      [ID]: connectionEntry({ created_at: '2026-10-02T09:00:00Z' }),
      [a]: connectionEntry({ created_at: '2026-10-01T09:00:00Z' }),
    });
    const list = api().getConnections() as unknown as Row[];
    expect(list.map((c) => c.id)).toEqual([a, b, ID]);
    for (const c of list) expect(Object.keys(c).sort()).toEqual(SUMMARY_KEYS);
  });

  it('is empty with no row and reads without writing', () => {
    expect(api().getConnections()).toEqual([]);
    expect(env.db.query("SELECT 1 FROM app_settings WHERE key = 'connections'")).toEqual([]);
  });

  it.each([ID2, ID.toUpperCase(), 'connections', 'not-a-uuid'])('detail of %s is 404', (id) => {
    create();
    expectError(() => api().getConnection(id), 404, 'connection_not_found');
  });

  it('returns accounts sorted with next_since and the windows', () => {
    create({ first_sync_days: 30 });
    merge([providerAccount('b'), providerAccount('a', { account_key: KEY_B })]);
    const detail = api().getConnection(ID) as unknown as Row;
    expect((detail.accounts as Row[]).map((a) => a.provider_account_id)).toEqual(['a', 'b']);
    for (const a of detail.accounts as Row[]) {
      expect(Object.keys(a).sort()).toEqual(ACCOUNT_KEYS);
      expect(a.next_since).toBe('2026-09-05');
    }
    expect(detail.windows).toEqual([{ start: '2026-09-05', end: '2026-10-04' }]);
  });
});

describe('mergeConnectionAccounts', () => {
  it('defaults the first listing by kind and suggests a debt', () => {
    addLiability(env.db, LIAB, { name: 'Visa', lender: 'Sample Bank', type: 'credit_card' });
    create();
    const out = merge([
      providerAccount('chk'),
      providerAccount('card', { kind_guess: 'credit_card', account_key: KEY_B, name: 'Visa' }),
      providerAccount('odd', { kind_guess: 'brokerage', account_key: KEY_C }),
    ]);
    const byId = Object.fromEntries((out.accounts as Row[]).map((a) => [a.provider_account_id, a]));
    expect(byId.chk).toMatchObject({ role: 'cash_flow', kind: 'checking', liability_id: null });
    expect(byId.card).toMatchObject({
      role: 'debt',
      kind: 'credit_card',
      label: 'Visa',
      liability_id: LIAB,
    });
    expect(byId.odd).toMatchObject({ role: 'cash_flow', kind: 'unknown' });
    expect(out.status).toBe('ok');
    expect(out.account_errors).toEqual([]);
    expect(out.quota_left).toBe(19);
  });

  it('suggests a debt whatever its id looks like, like the server', () => {
    addLiability(env.db, 'L-card', { name: 'Visa', lender: 'Sample Bank', type: 'credit_card' });
    create();
    const out = merge([providerAccount('card', { kind_guess: 'credit_card' })]);
    expect((out.accounts as Row[])[0]).toMatchObject({ role: 'debt', liability_id: 'L-card' });
  });

  it('suggests the debt an earlier import of the same key was linked to', () => {
    const other = '0a0b0c0d-0e0f-4a1b-8c2d-000000000002';
    addLiability(env.db, LIAB, { name: 'Visa', lender: 'Sample Bank', type: 'credit_card' });
    addLiability(env.db, other, { name: 'Other card', lender: 'Elsewhere', type: 'credit_card' });
    env.api.applySmartImport(
      applyBody([
        statement('7'.repeat(64), [], { key: KEY_B, kind: 'credit_card', liabilityId: other }),
      ])
    );
    create();
    const out = merge([providerAccount('card', { kind_guess: 'credit_card', account_key: KEY_B })]);
    expect((out.accounts as Row[])[0]).toMatchObject({ liability_id: other });
  });

  it('adds later accounts as ignore and keeps the mapping of known ones', () => {
    create();
    merge([providerAccount('chk')]);
    api().updateConnection(ID, { accounts: { chk: { label: 'Mine', role: 'ignore' } } });
    later();
    const out = merge([
      providerAccount('chk', { name: 'Renamed', institution: null, currency: 'eur' }),
      providerAccount('new', { account_key: KEY_B }),
    ]);
    const byId = Object.fromEntries((out.accounts as Row[]).map((a) => [a.provider_account_id, a]));
    expect(byId.chk).toMatchObject({
      label: 'Mine',
      role: 'ignore',
      name: 'Renamed',
      institution: null,
      currency: 'EUR',
    });
    expect(byId.new).toMatchObject({ role: 'ignore' });
    expect(out.quota_left).toBe(18);
  });

  it('cleans provider text like the server', () => {
    create();
    const out = merge([
      providerAccount('a', { name: '  Every\tday\u0000 ', institution: ' \u0085 ' }),
      providerAccount('b', { name: 'n'.repeat(250), account_key: KEY_B, currency: 'EURO' }),
      providerAccount('c', { name: '   ', account_key: KEY_C, currency: null }),
    ]);
    const byId = Object.fromEntries((out.accounts as Row[]).map((a) => [a.provider_account_id, a]));
    expect(byId.a).toMatchObject({ name: 'Every day', label: 'Every day', institution: null });
    expect(byId.b).toMatchObject({
      name: 'n'.repeat(200),
      label: 'n'.repeat(120),
      currency: 'XXX',
    });
    expect(byId.c).toMatchObject({ name: '', label: 'Account', currency: 'XXX' });
  });

  it('skips unusable provider account ids and keys', () => {
    create();
    const out = merge([
      providerAccount(''),
      providerAccount('x'.repeat(201)),
      providerAccount('ctl\u0001'),
      providerAccount('badkey', { account_key: 'acct:short' }),
      providerAccount('ok'),
    ]);
    expect((out.accounts as Row[]).map((a) => a.provider_account_id)).toEqual(['ok']);
  });

  it('reports flagged accounts and result codes, and a rate-limit warning', () => {
    create();
    const out = merge(
      [providerAccount('a', { error: 'connector_account_error' }), providerAccount('b')],
      ['connector_account_error', 'provider_rate_limited', 'provider_rate_limited']
    );
    expect(out.account_errors).toEqual([
      { provider_account_id: 'a', code: 'connector_account_error' },
      { provider_account_id: null, code: 'provider_rate_limited' },
    ]);
    expect(out.status).toBe('rate_limited');
    expect((out.accounts as Row[]).length).toBe(2);
  });

  it('stops at 50 accounts', () => {
    create();
    const many = Array.from({ length: 52 }, (_, i) =>
      providerAccount(`a${String(i).padStart(3, '0')}`)
    );
    expect((merge(many).accounts as Row[]).length).toBe(50);
  });

  it('is 404 for an unknown connection', () => {
    expectError(() => merge([providerAccount('a')], [], ID2), 404, 'connection_not_found');
  });
});

describe('updateConnection', () => {
  beforeEach(() => {
    addLiability(env.db, 'L-card', { name: 'Visa', type: 'credit_card' });
    create();
    merge([
      providerAccount('chk'),
      providerAccount('card', { kind_guess: 'credit_card', account_key: KEY_B }),
    ]);
  });

  it('changes only what was sent', () => {
    const out = api().updateConnection(ID, {
      label: 'Renamed',
      first_sync_days: 60,
      accounts: { card: { flip_balance: true, label: 'Card' } },
    }) as unknown as Row;
    expect(out.label).toBe('Renamed');
    expect(out.first_sync_days).toBe(60);
    const card = (out.accounts as Row[]).find((a) => a.provider_account_id === 'card')!;
    expect(card).toMatchObject({ flip_balance: true, label: 'Card', role: 'debt' });
  });

  it.each([
    ['not an object', []],
    ['extra field', { colour: 'red' }],
    ['null label', { label: null }],
    ['empty label', { label: '' }],
    ['range', { first_sync_days: 45 }],
    ['null range', { first_sync_days: null }],
    ['accounts not an object', { accounts: [] }],
    ['unknown account', { accounts: { nope: { role: 'ignore' } } }],
    ['null kind', { accounts: { chk: { kind: null } } }],
    ['bad kind', { accounts: { chk: { kind: 'brokerage' } } }],
    ['bad role', { accounts: { chk: { role: 'spend' } } }],
    ['null role', { accounts: { chk: { role: null } } }],
    ['flip not bool', { accounts: { chk: { flip_balance: 1 } } }],
    ['null flip', { accounts: { chk: { flip_balance: null } } }],
    ['account extra field', { accounts: { chk: { colour: 'red' } } }],
    ['own same_as key', { accounts: { chk: { same_as_key: KEY } } }],
    ['unknown same_as key', { accounts: { chk: { same_as_key: 'label:Nowhere' } } }],
    ['empty same_as key', { accounts: { chk: { same_as_key: '' } } }],
    ['same_as key too long', { accounts: { chk: { same_as_key: `label:${'x'.repeat(191)}` } } }],
    ['liability id too long', { accounts: { chk: { liability_id: 'x'.repeat(65) } } }],
    [
      'too many accounts',
      { accounts: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, {}])) },
    ],
  ])('refuses %s with bad_request', (_name, body) => {
    const before = rawDoc(env.db);
    expectError(() => api().updateConnection(ID, body), 422, 'bad_request');
    expect(rawDoc(env.db)).toEqual(before);
  });

  it('checks the liability', () => {
    expectError(
      () => api().updateConnection(ID, { accounts: { card: { liability_id: ID2 } } }),
      404,
      'liability_not_found'
    );
    expectError(
      () => api().updateConnection(ID, { accounts: { card: { liability_id: 'L-missing' } } }),
      404,
      'liability_not_found'
    );
  });

  it('accepts a debt whose id is not a UUID, such as the demo’s, and reads it back', () => {
    addLiability(env.db, 'demo-card', { name: 'Credit card', type: 'credit_card' });
    api().updateConnection(ID, { accounts: { card: { liability_id: 'demo-card' } } });
    const detail = api().getConnection(ID) as Row;
    expect(
      (detail.accounts as Row[]).find((a) => a.provider_account_id === 'card')!.liability_id
    ).toBe('demo-card');
  });

  it('accepts a known liability, and null clears it', () => {
    const lid = '0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d';
    addLiability(env.db, lid, { name: 'Loan', type: 'personal_loan' });
    let out = api().updateConnection(ID, { accounts: { card: { liability_id: lid } } }) as Row;
    expect(
      (out.accounts as Row[]).find((a) => a.provider_account_id === 'card')!.liability_id
    ).toBe(lid);
    out = api().updateConnection(ID, { accounts: { card: { liability_id: null } } }) as Row;
    expect(
      (out.accounts as Row[]).find((a) => a.provider_account_id === 'card')!.liability_id
    ).toBeNull();
  });

  it('accepts same_as keys of other accounts and of stored imports', () => {
    let out = api().updateConnection(ID, { accounts: { chk: { same_as_key: KEY_B } } }) as Row;
    expect((out.accounts as Row[]).find((a) => a.provider_account_id === 'chk')!.same_as_key).toBe(
      KEY_B
    );
    env.api.applySmartImport(applyBody([statement('f'.repeat(64), [], { key: 'label:Main' })]));
    out = api().updateConnection(ID, { accounts: { chk: { same_as_key: 'label:Main' } } }) as Row;
    expect((out.accounts as Row[]).find((a) => a.provider_account_id === 'chk')!.same_as_key).toBe(
      'label:Main'
    );
    out = api().updateConnection(ID, { accounts: { chk: { same_as_key: null } } }) as Row;
    expect(
      (out.accounts as Row[]).find((a) => a.provider_account_id === 'chk')!.same_as_key
    ).toBeNull();
  });

  it('refuses a same_as key the store would drop with save_failed, and writes nothing', () => {
    const long = `label:${'x'.repeat(180)}\u0001`;
    env.api.applySmartImport(applyBody([statement('e'.repeat(64), [], { key: 'label:Main' })]));
    env.db.execute('UPDATE smart_import_meta SET account_key = ?', [long]);
    const before = rawDoc(env.db);
    expectError(
      () => api().updateConnection(ID, { accounts: { chk: { same_as_key: long } } }),
      500,
      'save_failed'
    );
    expect(rawDoc(env.db)).toEqual(before);
  });

  it('is 404 for an unknown id, after the body is checked', () => {
    expectError(() => api().updateConnection(ID2, { label: 'x' }), 404, 'connection_not_found');
    expectError(() => api().updateConnection(ID2, { colour: 1 }), 422, 'bad_request');
  });
});

describe('beginConnectionCall', () => {
  it('returns the sealed value and reserves one request before the call', () => {
    create();
    expect(api().beginConnectionCall(ID)).toEqual({ provider: 'simplefin', sealed: SEALED });
    expect(rawDoc(env.db).items[ID].requests).toEqual([nowStamp()]);
    // The result of a reserved call counts nothing more.
    merge([providerAccount('chk')]);
    expect(rawDoc(env.db).items[ID].requests).toEqual([nowStamp()]);
  });

  it('a second call on the same connection is busy until the first is recorded', () => {
    create();
    api().beginConnectionCall(ID);
    expectError(() => api().beginConnectionCall(ID), 409, 'connection_busy');
    api().recordConnectionResult(ID, {
      kind: 'failed',
      error_type: 'provider_timeout',
      requested: true,
    } as never);
    api().beginConnectionCall(ID);
    api().endConnectionCall(ID);
    api().beginConnectionCall(ID);
    expect(rawDoc(env.db).items[ID].requests).toHaveLength(3);
  });

  it('at quota 1 the reservation refuses the next call', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({
        provider: 'simplefin',
        requests: Array(19).fill(new Date(Date.now() - 3600_000).toISOString()),
      }),
    });
    env.db.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
      `connection_secret:${ID}`,
      SEALED,
    ]);
    api().beginConnectionCall(ID);
    expect(api().getConnection(ID).quota_left).toBe(0);
    api().endConnectionCall(ID);
    expectError(() => api().beginConnectionCall(ID), 429, 'quota_reached');
  });

  it('a call never made releases its reservation', () => {
    create();
    api().beginConnectionCall(ID);
    later();
    api().recordConnectionResult(ID, {
      kind: 'failed',
      error_type: 'connector_disabled',
      requested: false,
    } as never);
    expect(rawDoc(env.db).items[ID].requests).toEqual([]);
    expect(api().getConnection(ID).quota_left).toBe(20);
  });

  it('refuses a disabled provider before the quota, as the server does', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({
        provider: 'simplefin',
        requests: Array(20).fill(new Date(Date.now() - 3600_000).toISOString()),
      }),
    });
    expectError(() => api().beginConnectionCall(ID, ['demo']), 503, 'connector_disabled');
    expectError(() => api().beginConnectionCall(ID, ['simplefin', 'demo']), 429, 'quota_reached');
    expectError(() => api().beginConnectionCall(ID), 429, 'quota_reached');
    expect(rawDoc(env.db).items[ID].status).toBe('ok');
  });

  it('keeps reconnect_needed first, before a disabled provider', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({ provider: 'simplefin', status: 'reconnect_needed' }),
    });
    expectError(() => api().beginConnectionCall(ID, ['demo']), 409, 'reconnect_needed');
  });

  it('returns no secret for the demo', () => {
    create({ provider: 'demo' }, null);
    expect(api().beginConnectionCall(ID)).toEqual({ provider: 'demo', sealed: null });
  });

  it('refuses reconnect_needed before anything else', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({
        provider: 'simplefin',
        status: 'reconnect_needed',
        requests: Array(20).fill('2026-10-04T09:00:00Z'),
      }),
    });
    expectError(() => api().beginConnectionCall(ID), 409, 'reconnect_needed');
  });

  it('refuses when the daily quota is used', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({
        provider: 'simplefin',
        requests: Array(20).fill(new Date(Date.now() - 3600_000).toISOString()),
      }),
    });
    env.db.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
      `connection_secret:${ID}`,
      SEALED,
    ]);
    expectError(() => api().beginConnectionCall(ID), 429, 'quota_reached');
    expect(rawDoc(env.db).items[ID].status).toBe('ok');
  });

  it.each([
    ['missing', null],
    ['a server value', 'fernet:gAAAAZq9'],
    ['plaintext', 'https://u:Zq9@bridge.simplefin.org/simplefin'],
  ])('a %s secret sets reconnect_needed', (_name, value) => {
    addConnections(env.db, { [ID]: connectionEntry({ provider: 'akahu' }) });
    if (value !== null) {
      env.db.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
        `connection_secret:${ID}`,
        value,
      ]);
    }
    expectError(() => api().beginConnectionCall(ID), 409, 'reconnect_needed');
    const stored = rawDoc(env.db).items[ID];
    expect(stored.status).toBe('reconnect_needed');
    expect(stored.status_at).toMatch(STAMP);
    expect(stored.requests).toEqual([]);
    expectError(() => api().beginConnectionCall(ID), 409, 'reconnect_needed');
  });

  it('is 404 for an unknown id', () => {
    expectError(() => api().beginConnectionCall(ID2), 404, 'connection_not_found');
  });
});

describe('recordConnectionResult', () => {
  const syncResponse = (codes: string[] = []): Row => ({
    statements: [],
    account_errors: codes.map((code) => ({ provider_account_id: null, code })),
    window: { start: '2026-09-05', end: '2026-10-04' },
  });

  it('records a good sync: status ok, last_synced_at, one request', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({ provider: 'simplefin', status: 'rate_limited' }),
    });
    const out = api().recordConnectionResult(ID, {
      kind: 'sync',
      response: syncResponse(),
    } as never) as unknown as Row;
    expect(out.status).toBe('ok');
    expect(out.last_synced_at).toBe(nowStamp());
    expect(out.status_at).toBe(nowStamp());
    expect(out.quota_left).toBe(19);
  });

  it('a rate-limit warning in a good sync sets rate_limited', () => {
    addConnections(env.db, { [ID]: connectionEntry({ provider: 'simplefin' }) });
    const out = api().recordConnectionResult(ID, {
      kind: 'sync',
      response: syncResponse(['connector_account_error', 'provider_rate_limited']),
    } as never) as unknown as Row;
    expect(out.status).toBe('rate_limited');
    expect(out.last_synced_at).toBe(nowStamp());
  });

  it.each([
    ['reconnect_needed', 'reconnect_needed'],
    ['payment_required', 'payment_required'],
    ['provider_rate_limited', 'rate_limited'],
    ['provider_timeout', 'ok'],
    ['provider_bad_response', 'ok'],
  ])('a failed call with %s leaves status %s', (errorType, status) => {
    addConnections(env.db, { [ID]: connectionEntry({ provider: 'simplefin' }) });
    const out = api().recordConnectionResult(ID, {
      kind: 'failed',
      error_type: errorType,
      requested: true,
    } as never) as unknown as Row;
    expect(out.status).toBe(status);
    expect(out.last_synced_at).toBeNull();
    expect(out.quota_left).toBe(19);
    expect(out.status_at).toBe(status === 'ok' ? '2026-10-01T09:00:00Z' : nowStamp());
  });

  it('counts nothing for a call that was never made (an unreadable seal)', () => {
    addConnections(env.db, { [ID]: connectionEntry({ provider: 'simplefin' }) });
    const out = api().recordConnectionResult(ID, {
      kind: 'failed',
      error_type: 'reconnect_needed',
      requested: false,
    } as never) as unknown as Row;
    expect(out.status).toBe('reconnect_needed');
    expect(out.quota_left).toBe(20);
  });

  it('ignores a connection removed during the call, as the server does', () => {
    const before = env.db.query('SELECT key, value FROM app_settings');
    expect(
      api().recordConnectionResult(ID, { kind: 'sync', response: syncResponse() } as never)
    ).toBeNull();
    expect(
      api().recordConnectionResult(ID, {
        kind: 'failed',
        error_type: 'reconnect_needed',
        requested: true,
      } as never)
    ).toBeNull();
    expect(env.db.query('SELECT key, value FROM app_settings')).toEqual(before);
  });

  it('logs only a well-formed error type', () => {
    addConnections(env.db, { [ID]: connectionEntry({ provider: 'simplefin' }) });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (const errorType of ['Zq9 https://u:p@x', 'a'.repeat(65), 'Provider_Timeout', 'x\ny']) {
      api().recordConnectionResult(ID, {
        kind: 'failed',
        error_type: errorType,
        requested: false,
      } as never);
    }
    api().recordConnectionResult(ID, {
      kind: 'failed',
      error_type: 'provider_timeout',
      requested: false,
    } as never);
    const lines = info.mock.calls.map((call) => String(call[0]));
    const failed = lines.filter((l) => l.startsWith('connection_call_failed'));
    expect(failed).toHaveLength(5);
    expect(failed.slice(0, 4).every((l) => l.includes('error_type=unknown '))).toBe(true);
    expect(failed[4]).toContain('error_type=provider_timeout ');
    expect(lines.join('\n')).not.toContain('Zq9');
  });

  it.each([
    ['unknown kind', { kind: 'other' }],
    ['no error type', { kind: 'failed', requested: true }],
    ['requested not bool', { kind: 'failed', error_type: 'x', requested: 1 }],
    ['sync without errors', { kind: 'sync', response: {} }],
  ])('refuses %s', (_name, result) => {
    addConnections(env.db, { [ID]: connectionEntry() });
    expectError(() => api().recordConnectionResult(ID, result as never), 422, 'bad_request');
  });
});

describe('replaceConnectionSecret', () => {
  it('keeps the id and mapping, replaces the sealed value and sets accounts_pending', () => {
    create();
    merge([providerAccount('chk')]);
    api().updateConnection(ID, { accounts: { chk: { label: 'Mine' } } });
    later();
    const out = api().replaceConnectionSecret(ID, SEALED_2, true) as unknown as Row;
    expect(out.status).toBe('accounts_pending');
    expect(out.quota_left).toBe(18);
    expect((out.accounts as Row[])[0]!.label).toBe('Mine');
    expect(secretRow(env.db, ID)).toMatchObject({ value: SEALED_2, encrypted: 1 });
    scanForSecrets(out);
  });

  it('refuses a value that is not sealed and changes nothing', () => {
    create();
    expectError(
      () => api().replaceConnectionSecret(ID, 'https://u:Zq9@x', false),
      422,
      'bad_request'
    );
    expect(secretRow(env.db, ID)!.value).toBe(SEALED);
    expectError(
      () => api().replaceConnectionSecret(ID2, SEALED_2, false),
      404,
      'connection_not_found'
    );
  });

  it('the demo takes no secret', () => {
    create({ provider: 'demo' }, null);
    expectError(() => api().replaceConnectionSecret(ID, SEALED_2, false), 422, 'bad_request');
    expect((api().replaceConnectionSecret(ID, null, false) as Row).status).toBe('accounts_pending');
    expect(secretRow(env.db, ID)).toBeUndefined();
  });
});

describe('getConnectionSyncPlan', () => {
  const synced = (end: string, key = KEY): Row => ({
    ...statement(
      '9'.repeat(64),
      [txn('2026-09-20', -10, 'CAFE', { dedupe_key: `${key}|CAFE|1` })],
      {
        origin: 'connector',
        connection_id: ID,
        key,
        period: { start: '2026-09-01', end },
      }
    ),
    format: 'connector',
    parser: 'connector:simplefin',
    file_name: 'Sync',
  });

  it('builds the windows and their accounts from applied imports; Undo rewinds', () => {
    create({ first_sync_days: 30 });
    merge([
      providerAccount('chk'),
      providerAccount('card', { kind_guess: 'credit_card', account_key: KEY_B }),
    ]);
    api().updateConnection(ID, { accounts: { card: { flip_balance: true } } });
    const first = api().getConnectionSyncPlan(ID) as unknown as Row;
    expect(first).toEqual({
      connection_id: ID,
      provider: 'simplefin',
      status: 'ok',
      quota_left: 19,
      windows: [
        {
          start: '2026-09-05',
          end: '2026-10-04',
          accounts: [
            {
              provider_account_id: 'card',
              since: '2026-09-05',
              account_key: KEY_B,
              kind: 'credit_card',
              flip_balance: true,
            },
            {
              provider_account_id: 'chk',
              since: '2026-09-05',
              account_key: KEY,
              kind: 'checking',
              flip_balance: false,
            },
          ],
        },
      ],
    });

    const applied = env.api.applySmartImport(applyBody([synced('2026-09-30')])) as unknown as Row;
    const importId = (applied.imports as Row[])[0]!.import_id as string;
    const after = api().getConnectionSyncPlan(ID) as unknown as Row;
    expect((after.windows as Row[])[0]).toMatchObject({ start: '2026-09-05', end: '2026-10-04' });
    expect(((after.windows as Row[])[0]!.accounts as Row[]).map((a) => a.since)).toEqual([
      '2026-09-05',
      '2026-09-25',
    ]);
    const detail = api().getConnection(ID) as unknown as Row;
    expect(
      (detail.accounts as Row[]).find((a) => a.provider_account_id === 'chk')!.next_since
    ).toBe('2026-09-25');

    env.api.undoSmartImport(importId);
    expect(api().getConnectionSyncPlan(ID)).toEqual(first);
  });

  it('a window only asks for accounts whose since is not after its end', () => {
    addConnections(env.db, {
      [ID]: connectionEntry({
        first_sync_days: 30,
        accounts: {
          old: { ...accountEntry(KEY) },
          recent: { ...accountEntry(KEY_B) },
        },
      }),
    });
    env.db.execute(
      `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind,
         account_key, period_end, connection_id, created_at)
       VALUES ('imp-old', 'b', 'connector', 'connector', 'connector:demo', 'checking', ?, '2026-04-01', ?, '2026-10-01T00:00:00')`,
      [KEY, ID]
    );
    const plan = api().getConnectionSyncPlan(ID) as unknown as Row;
    const windows = plan.windows as Row[];
    expect(windows.map((w) => [w.start, w.end])).toEqual([
      ['2026-03-27', '2026-06-24'],
      ['2026-06-25', '2026-09-22'],
      ['2026-09-23', '2026-10-04'],
    ]);
    expect((windows[0]!.accounts as Row[]).map((a) => [a.provider_account_id, a.since])).toEqual([
      ['old', '2026-03-27'],
    ]);
    expect((windows[2]!.accounts as Row[]).map((a) => [a.provider_account_id, a.since])).toEqual([
      ['old', '2026-09-23'],
      ['recent', '2026-09-23'],
    ]);
  });

  it('is 404 for an unknown id', () => {
    expectError(() => api().getConnectionSyncPlan(ID2), 404, 'connection_not_found');
  });
});

function accountEntry(key: string): Row {
  return {
    name: 'Everyday',
    institution: 'Sample Bank',
    currency: 'USD',
    kind: 'checking',
    role: 'cash_flow',
    label: 'Everyday',
    account_key: key,
    liability_id: null,
    flip_balance: false,
    same_as_key: null,
  };
}

describe('disconnect during a call', () => {
  it('is refused while a provider call or a composite holds the connection', () => {
    create();
    api().beginConnectionCall(ID);
    expectError(() => api().deleteConnection(ID, 'false'), 409, 'connection_busy');
    api().endConnectionCall(ID);
    const release = api().holdConnection(ID);
    expectError(() => api().holdConnection(ID), 409, 'connection_busy');
    expectError(() => api().deleteConnection(ID, 'false'), 409, 'connection_busy');
    release();
    release();
    expect(api().deleteConnection(ID, 'false').connection_id).toBe(ID);
  });

  it('holds are per connection and per database', async () => {
    const release = api().holdConnection(ID);
    expect(() => api().holdConnection(ID2)).not.toThrow();
    const other = await createTestApi();
    expect(() => other.api.holdConnection(ID)).not.toThrow();
    other.db.close();
    release();
  });
});

describe('disconnect writes the sanitized document', () => {
  it('drops entries the store would drop and keeps the rest', () => {
    addConnections(env.db, {
      [ID]: connectionEntry(),
      [ID2]: connectionEntry({ extra: 'x' }),
      'not-a-uuid': connectionEntry(),
    });
    api().deleteConnection(ID);
    const doc = rawDoc(env.db);
    expect(Object.keys(doc.items)).toEqual([ID2]);
    expect(doc.items[ID2].extra).toBeUndefined();
    expect(readConnections(env.db).items[ID2]!.label).toBe('Demo');
  });
});

describe('the credential vault seam', () => {
  it('recognises only sealed values', () => {
    expect(isSealedValue(SEALED)).toBe(true);
    for (const v of ['', 'wc1:', 'fernet:AAAA', 'https://u:p@x', null, 7, 'wc1:A:B:C']) {
      expect(isSealedValue(v)).toBe(false);
    }
  });

  it('accepts exactly the shape the WebCrypto seal writes', () => {
    const iv = 'AAAAAAAAAAAAAAAA';
    for (const ct of [
      'A'.repeat(24),
      `${'A'.repeat(22)}==`,
      `${'A'.repeat(27)}=`,
      'a+/9'.repeat(8),
    ]) {
      expect(isSealedValue(`wc1:${iv}:${ct}`)).toBe(true);
    }
    for (const v of [
      'wc1:AAAA:BBBBBBBBBBBBBBBBBBBBBBBB', // IV is not 12 bytes
      `wc1:${'A'.repeat(15)}=:${'A'.repeat(24)}`, // padded IV
      `wc1:${iv}:${'A'.repeat(20)}`, // shorter than the 16-byte tag
      `wc1:${iv}:${'A'.repeat(22)}`, // not a whole base64 group
      `wc1:${iv}:${'A'.repeat(21)}===`,
      `wc1:${iv}:${'A'.repeat(22)}-_`, // URL-safe alphabet
      `wc1:${'A'.repeat(14)}-_:${'A'.repeat(24)}`,
      `wc1:${iv}:${'A'.repeat(24)}\n`,
      `wc1:${iv}:${'A'.repeat(16_384)}`,
    ]) {
      expect(isSealedValue(v)).toBe(false);
    }
  });

  it('the test vault seals per connection and LocalAPI stores only its output', async () => {
    const vault = createMemoryVault();
    const sealed = await vault.seal(
      ID,
      '{"access_url":"https://u:Zq9@bridge.simplefin.org/simplefin"}'
    );
    expect(isSealedValue(sealed)).toBe(true);
    await expect(vault.unseal(ID2, sealed)).rejects.toThrow();
    create({}, sealed);
    const begun = api().beginConnectionCall(ID) as { sealed: string };
    expect(await vault.unseal(ID, begun.sealed)).toContain('Zq9');
    const all = JSON.stringify(env.db.query('SELECT key, value FROM app_settings'));
    expect(all).not.toContain('Zq9');
    await vault.delete(ID);
    expect(vault.size()).toBe(0);
  });
});

describe('no new browser storage', () => {
  it('the connection modules never touch IndexedDB or localStorage', () => {
    for (const file of ['local-connections.ts', 'local-connections-store.ts']) {
      const text = fs.readFileSync(path.resolve(process.cwd(), 'src/database', file), 'utf8');
      expect(text).not.toMatch(/indexedDB|localStorage|PortfolioApp/);
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('dispatcher', () => {
  let restoreUuids: () => void;
  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
  });
  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  it('serves list, detail and update from the browser database', () => {
    addConnections(clientDB, { [ID]: connectionEntry() });
    clientDB.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
      `connection_secret:${ID}`,
      SEALED,
    ]);
    const list = tryLocalRoute('/api/connections', { method: 'GET' });
    expect((list as Row[]).map((c) => c.id)).toEqual([ID]);
    const detail = tryLocalRoute(`/api/connections/${ID}`, { method: 'GET' });
    expect((detail as Row).id).toBe(ID);
    const put = tryLocalRoute(`/api/connections/${ID}`, { method: 'PUT', body: { label: 'New' } });
    expect((put as Row).label).toBe('New');
    scanForSecrets([list, detail, put]);
    expect(() => tryLocalRoute(`/api/connections/${ID2}`, { method: 'GET' })).toThrow(
      SmartImportHttpError
    );
  });

  // Wired in B6: apiCall serves these POSTs in local mode through the async
  // client.ts composites (test/api/connections-composite.test.ts), which must run
  // before tryLocalRoute because the dispatcher is synchronous. So the dispatcher
  // itself still leaves them unhandled, and they are not PASSTHROUGH either.
  it('serves the composite routes in client.ts, not the synchronous dispatcher (plan B6)', () => {
    for (const [method, url] of [
      ['POST', '/api/connections'],
      ['POST', `/api/connections/${ID}/credentials`],
      ['POST', `/api/connections/${ID}/accounts`],
      ['POST', `/api/connections/${ID}/sync`],
    ] as const) {
      expect(tryLocalRoute(url, { method, body: {} })).toBe(NOT_HANDLED);
      expect(isPassthroughAllowed(url, method)).toBe(false);
    }
  });
});
