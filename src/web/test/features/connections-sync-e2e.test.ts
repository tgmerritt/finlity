/**
 * Sync now into the review wizard, end to end in hosted mode (plan C3 and the
 * PR C wizard end-to-end test): the connector statement fixture produced by
 * the Python mapping (tests/fixtures/connectors/statements/simplefin_sync.json)
 * comes back from a mocked v2 sync, runs through the real composite, the real
 * wizard, the browser `parseStatement` behind Apply and a fresh browser
 * database. Checks the dedupe keys, the salted external id, the card balance
 * (dated a day ahead, recorded as today), the warning copy, that nothing is
 * written before Apply apart from the connection's own sync record, Undo from
 * Done, and that the next Sync now offers the undone rows again.
 *
 * `fetch` answers only /api/v2/*: connector status, accounts and sync, the AI
 * status and the stateless recurring check. Anything else fails the test.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '../database/helpers'; // points sql.js at the wasm binary

vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/pages/budget', () => ({ showBudgetTab: vi.fn(), loadBudgetTab: vi.fn() }));
vi.mock('@/ui/tabs', () => ({
  onTabChange: vi.fn(),
  showTab: vi.fn(),
  getCurrentTab: vi.fn(() => 'settings'),
}));

import { store } from '@/state/store';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache } from '@/api/dispatcher';
import { apiCall } from '@/api/client';
import { resetConnectorStatusCache } from '@/api/connections-composite';
import { closeDynamicModal } from '@/ui/modal';
import { syncNow } from '@/features/connections';
import { installWebCrypto } from '../utils/webcrypto-support';
import type { ConnectionDetail, ConnectionListingResponse, NormalizedStatement } from '@/types/api';

type Row = Record<string, unknown>;

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../tests/fixtures/connectors/statements/simplefin_sync.json'),
    'utf8'
  )
) as { statements: NormalizedStatement[]; window: { start: string; end: string } };
const [CHK, CARD] = FIXTURE.statements as [NormalizedStatement, NormalizedStatement];
const ACCESS_URL = 'https://e2e:Zq9e2ePass@beta-bridge.simplefin.org/simplefin';

let v2Calls: string[];
let unexpected: string[];

function respond(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: '',
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/api/v2/connectors/status') {
      return respond(200, {
        enabled: ['simplefin', 'demo'],
        providers: [
          { id: 'simplefin', allowed_hosts: ['beta-bridge.simplefin.org', 'bridge.simplefin.org'] },
          { id: 'demo', allowed_hosts: [] },
        ],
        limits: {},
      });
    }
    // The wizard asks whether AI is available (read only): it is not here.
    if (method === 'GET' && url === '/api/v2/smart-import/status') {
      return respond(200, { ai_available: false, pdf_ai_available: false });
    }
    v2Calls.push(`${method} ${url}`);
    if (url === '/api/v2/connectors/simplefin/accounts') {
      return respond(200, {
        accounts: [
          {
            provider_account_id: 'sf-chk',
            name: 'Everyday',
            institution: 'Example Credit Union',
            currency: 'USD',
            balance: 1520.33,
            balance_date: '2026-10-04',
            kind_guess: 'checking',
            account_key: CHK.account.key,
            error: null,
          },
          {
            provider_account_id: 'sf-card',
            name: 'Visa',
            institution: 'Example Card Services',
            currency: 'USD',
            balance: -812.4,
            balance_date: '2026-10-05',
            kind_guess: 'credit_card',
            account_key: CARD.account.key,
            error: null,
          },
        ],
        errors: [],
      });
    }
    if (url === '/api/v2/connectors/simplefin/sync') {
      return respond(200, {
        statements: FIXTURE.statements,
        account_errors: [],
        window: FIXTURE.window,
      });
    }
    if (url === '/api/v2/smart-import/recurring') return respond(200, { candidates: [] });
    unexpected.push(`${method} ${url}`);
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

function seed(): void {
  clientDB.execute('DELETE FROM budget_expense_categories');
  for (const [id, name] of [
    ['cat-Dining', 'Dining'],
    ['cat-Bills', 'Bills'],
  ]) {
    clientDB.execute(
      'INSERT INTO budget_expense_categories (id, name, sort_order) VALUES (?, ?, 0)',
      [id, name]
    );
  }
  clientDB.execute(
    `INSERT INTO liabilities (id, name, liability_type, lender, current_balance, balance_as_of,
       is_amortizing, is_active) VALUES ('L-card', 'Visa card', 'credit_card', 'Example', 700,
       '2026-09-01', 0, 1)`
  );
}

/** Every table's rows, except the connection's own sync record (app_settings `connections`). */
function snapshot(): string {
  const tables = clientDB
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .map((r) => r.name);
  const out: Record<string, Row[]> = {};
  for (const t of tables) {
    const rows = clientDB.query<Row>(`SELECT * FROM "${t}"`);
    out[t] = rows
      .filter((r) => !(t === 'app_settings' && r['key'] === 'connections'))
      .map((r) => JSON.stringify(r))
      .sort()
      .map((r) => JSON.parse(r) as Row);
  }
  return JSON.stringify(out);
}

/** The connection's account mapping, which `snapshot()` leaves out with the sync record. */
async function mapping(id: string): Promise<unknown> {
  const detail = await apiCall<ConnectionDetail>(`/api/connections/${id}`);
  return detail.accounts.map((a) => ({
    id: a.provider_account_id,
    kind: a.kind,
    role: a.role,
    liability_id: a.liability_id,
  }));
}

const count = (table: string): number =>
  clientDB.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)[0]!.c;

const wizard = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#dynamic-modal.smart-import-modal');
const q = (sel: string): HTMLElement => wizard()!.querySelector<HTMLElement>(sel)!;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

async function next(): Promise<void> {
  q('[data-si="next"]').click();
  await settle();
}

async function toReview(): Promise<void> {
  for (let i = 0; i < 3; i++) await next();
  expect(q('.smart-import-heading').textContent).toBe('Review and apply');
}

let restoreCrypto: () => void;
let restoreUuid: () => void;

beforeAll(async () => {
  await import('@/features/smart-import');
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // The fixture's card balance is dated 2026-10-05: tomorrow by this clock.
  vi.setSystemTime(new Date(2026, 9, 4, 18, 0, 0));
  restoreCrypto = installWebCrypto();
  const original = globalThis.crypto.randomUUID;
  let uuid = 0;
  globalThis.crypto.randomUUID = (() =>
    `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`) as typeof original;
  restoreUuid = () => {
    globalThis.crypto.randomUUID = original;
  };
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  clientDB.close();
  await clientDB.createNew();
  resetLocalAPICache();
  resetConnectorStatusCache();
  store.resetState();
  store.set('dataMode', 'local');
  document.body.replaceChildren();
  seed();
  v2Calls = [];
  unexpected = [];
  installFetch();
});

afterEach(() => {
  closeDynamicModal();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreCrypto();
  restoreUuid();
  clientDB.close();
});

async function connect(): Promise<string> {
  const created = await apiCall<ConnectionListingResponse>('/api/connections', {
    method: 'POST',
    body: { provider: 'simplefin', access_url: ACCESS_URL, first_sync_days: 30 },
  });
  await apiCall(`/api/connections/${created.id}`, {
    method: 'PUT',
    body: {
      accounts: { 'sf-card': { role: 'debt', kind: 'credit_card', liability_id: 'L-card' } },
    },
  });
  return created.id;
}

describe('Sync now into the review wizard (hosted, end to end)', () => {
  it('reviews the fixture, applies it, undoes it, and offers it again', async () => {
    const id = await connect();
    const before = snapshot();
    const mappingBefore = await mapping(id);
    const baseline = {
      txns: count('import_transactions'),
      meta: count('smart_import_meta'),
      snapshots: count('liability_balance_snapshots'),
      balance: clientDB.query<{ b: number }>(
        "SELECT current_balance AS b FROM liabilities WHERE id = 'L-card'"
      )[0]!.b,
    };
    const firstSince = (await apiCall<ConnectionDetail>(`/api/connections/${id}`)).accounts.map(
      (a) => a.next_since
    );

    await syncNow(id);
    await settle();

    // Accounts, prefilled from the mapping.
    expect(q('.smart-import-heading').textContent).toBe('Check the accounts');
    const card = q('[data-statement="c2:0"]');
    expect(card.querySelector<HTMLSelectElement>('[data-si="kind"]')!.value).toBe('credit_card');
    expect(card.querySelector<HTMLSelectElement>('[data-si="debt"]')!.value).toBe('L-card');
    const chk = q('[data-statement="c1:0"]');
    expect(chk.textContent).toContain(
      'Some transactions outside this sync’s dates, or sent twice, were left out.'
    );

    await toReview();
    expect(q('[data-count="new"]').textContent).toBe('8');
    expect(q('[data-count="duplicates"]').textContent).toBe('0');
    const debtLine = q('[data-debt="L-card"]');
    expect(debtLine.querySelector('[data-si="debt-after"]')!.textContent).toBe('$812.40');
    expect(debtLine.textContent).not.toContain('in the future');

    // Nothing was written by the sync and the review, apart from the sync record.
    expect(snapshot()).toBe(before);
    // No early write-back: the mapping is untouched until Apply.
    expect(await mapping(id)).toEqual(mappingBefore);
    expect(v2Calls).toEqual([
      'POST /api/v2/connectors/simplefin/accounts',
      'POST /api/v2/connectors/simplefin/sync',
      'POST /api/v2/smart-import/recurring',
    ]);

    q('[data-si="apply"]').click();
    await settle();
    expect(q('.smart-import-heading').textContent).toBe('Import saved');
    // Nothing changed in the wizard, so nothing is written back after Apply either.
    expect(await mapping(id)).toEqual(mappingBefore);

    const stored = clientDB.query<{ dedupe_key: string; external_id: string | null }>(
      'SELECT dedupe_key, external_id FROM import_transactions ORDER BY posted_date, external_id'
    );
    const expectedKeys = FIXTURE.statements
      .flatMap((s) => s.transactions.map((t) => `${s.account.key}|${t.dedupe_base}`))
      .sort();
    expect(stored.map((r) => r.dedupe_key).sort()).toEqual(expectedKeys);
    expect(stored.map((r) => r.external_id)).toContain('simplefin:k1~920de79b');
    const meta = clientDB.query<{ origin: string; connection_id: string | null }>(
      'SELECT origin, connection_id FROM smart_import_meta'
    );
    expect(meta).toEqual([
      { origin: 'connector', connection_id: id },
      { origin: 'connector', connection_id: id },
    ]);
    // The card balance dated tomorrow (UTC) is recorded as today's.
    expect(
      clientDB.query<{ d: string; b: number }>(
        "SELECT snapshot_date AS d, balance AS b FROM liability_balance_snapshots WHERE liability_id = 'L-card' AND source = 'import'"
      )
    ).toEqual([{ d: '2026-10-04', b: 812.4 }]);
    const applied = await apiCall<ConnectionDetail>(`/api/connections/${id}`);
    expect(applied.accounts.find((a) => a.provider_account_id === 'sf-card')!.next_since).toBe(
      '2026-09-29'
    );

    // Undo from Done puts everything back and rewinds the plan.
    q('[data-si="undo"]').click();
    q('[data-si="undo-confirm"]').click();
    await settle();
    expect(q('.smart-import-heading').textContent).toBe('Import undone');
    expect(count('import_transactions')).toBe(baseline.txns);
    expect(count('smart_import_meta')).toBe(baseline.meta);
    expect(count('liability_balance_snapshots')).toBe(baseline.snapshots);
    expect(
      clientDB.query<{ b: number }>(
        "SELECT current_balance AS b FROM liabilities WHERE id = 'L-card'"
      )[0]!.b
    ).toBe(baseline.balance);
    const rewound = await apiCall<ConnectionDetail>(`/api/connections/${id}`);
    expect(rewound.accounts.map((a) => a.next_since)).toEqual(firstSince);
    q('[data-si="close"]').click();
    await settle();
    expect(wizard()).toBeNull();

    // The next Sync now offers the undone rows again, none of them duplicates.
    await syncNow(id);
    await settle();
    await toReview();
    expect(q('[data-count="new"]').textContent).toBe('8');
    expect(q('[data-count="duplicates"]').textContent).toBe('0');
    expect(unexpected).toEqual([]);
  });

  it('marks the overlap with an applied sync as duplicates and does not apply it again', async () => {
    const id = await connect();
    await syncNow(id);
    await settle();
    await toReview();
    q('[data-si="apply"]').click();
    await settle();
    q('[data-si="close"]').click();
    await settle();

    // A second sync of the same window: every row is stored, and the window
    // itself was applied, so there is nothing to review.
    await syncNow(id);
    await settle();
    expect(wizard()).toBeNull();
    const toast = (await import('@/ui/toast')).showToast;
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.stringMatching(/^No new transactions since /),
      'info'
    );
    expect(count('import_transactions')).toBe(8);
    expect(unexpected).toEqual([]);
  });
});
