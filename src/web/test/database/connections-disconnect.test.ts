/**
 * Disconnect in the browser database (plan B4, design 8.6). Ports
 * tests/api/test_connections_disconnect.py: a plain disconnect removes the
 * metadata entry and the secret row and keeps the imports (each still
 * undoable); remove_data undoes every import of the connection newest first
 * inside one savepoint, keeping what the undo rules keep; any failure rolls
 * all of it back. Also covers the dispatcher route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as smartImport from '@/database/local-smart-import';
import { SmartImportHttpError } from '@/database/local-smart-import';
import { connectionIds } from '@/database/local-connections-store';
import { parseRemoveData } from '@/database/local-connections';
import { clientDB } from '@/database/client-database';
import { tryLocalRoute, resetLocalAPICache, NOT_HANDLED } from '@/api/dispatcher';
import type { ClientDatabase } from '@/database/client-database';
import {
  CONN_ID,
  addConnections,
  addLiability,
  applyBody,
  candidate,
  connectionEntry,
  count,
  setup,
  statement,
  tableHashes,
  teardown,
  txn,
  type Env,
  type Row,
} from './smart-import-support';
import { useSequentialUuids } from './helpers';

const OTHER_ID = '11111111-2222-4333-8444-555555555555';
const H = {
  s1: '1'.repeat(64),
  s2: '2'.repeat(64),
  s3: '3'.repeat(64),
  f1: '4'.repeat(64),
  o1: '5'.repeat(64),
};
const CHK = 'acct:one';
const CARD = 'acct:card';
const PLANTED = [
  'zqdiscuser',
  'Zq9DiscPassw0rdPlanted',
  'ZQ Disc Everyday',
  'ZQXDISC WIDGETS',
  '6543.21',
];
const SEALED = 'wc1:AAAAAAAAAAAAAAAA:Zq9DiscPassw0rdPlantedAA';

let env: Env;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => teardown(env));

const later = (): void => vi.setSystemTime(new Date(Date.now() + 2000));

function store(db: ClientDatabase, ids: string[], secrets = true): void {
  addConnections(
    db,
    Object.fromEntries(ids.map((id) => [id, connectionEntry({ provider: 'simplefin' })]))
  );
  if (secrets) {
    for (const id of ids) {
      db.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
        `connection_secret:${id}`,
        SEALED,
      ]);
    }
  }
}

const secretRows = (): string[] =>
  env.db
    .query<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE 'connection_secret:%' ORDER BY key"
    )
    .map((r) => r.key);

const metas = (): Record<string, string | null> =>
  Object.fromEntries(
    env.db
      .query<{ import_id: string; connection_id: string | null }>(
        'SELECT import_id, connection_id FROM smart_import_meta'
      )
      .map((r) => [r.import_id, r.connection_id])
  );

function synced(fileHash: string, txns: Row[], o: Row = {}): Row {
  const { cid, ...rest } = o;
  return {
    ...statement(fileHash, txns, { origin: 'connector', connection_id: cid ?? CONN_ID, ...rest }),
    format: 'connector',
    parser: 'connector:simplefin',
    file_name: 'Sync',
  };
}

function apply(statements: Row[], o: Parameters<typeof applyBody>[1] = {}): string[] {
  later();
  const out = env.api.applySmartImport(applyBody(statements, o)) as unknown as Row;
  return (out.imports as Row[]).map((i) => i.import_id as string);
}

const chk = (posted: string, amount: number, merchant = 'NETFLIX'): Row =>
  txn(posted, amount, merchant, { dedupe_key: `${CHK}|${merchant}|${posted}|${amount}` });
const card = (posted: string, amount: number, merchant = 'BISTRO'): Row =>
  txn(posted, amount, merchant, { dedupe_key: `${CARD}|${merchant}|${posted}|${amount}` });

const disconnect = (id: string, removeData?: string | null): Row =>
  env.api.deleteConnection(id, removeData) as unknown as Row;

function expectError(fn: () => unknown, status: number, errorType: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SmartImportHttpError);
    expect((e as SmartImportHttpError).status).toBe(status);
    expect((e as SmartImportHttpError).errorType).toBe(errorType);
    const text = JSON.stringify((e as SmartImportHttpError).body());
    for (const p of PLANTED) expect(text).not.toContain(p);
    return;
  }
  throw new Error(`expected ${status} ${errorType}`);
}

const snapshot = (): unknown => [tableHashes(env.db), connectionIds(env.db), secretRows()];

describe('plain disconnect', () => {
  it('removes the secret and metadata and keeps the imports, which stay undoable', () => {
    store(env.db, [CONN_ID, OTHER_ID]);
    const first = apply([synced(H.s1, [chk('2026-09-03', -15.49)])]);
    const second = apply([synced(H.s2, [chk('2026-09-20', -20, 'GROCER')])]);
    const importRows = env.db.query('SELECT * FROM import_transactions ORDER BY id');

    expect(disconnect(CONN_ID)).toEqual({
      connection_id: CONN_ID,
      remove_data: false,
      imports_undone: 0,
      imports_kept: 2,
      deleted: { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 },
      reassigned: { transactions: 0 },
      kept: [],
    });
    expect(connectionIds(env.db)).toEqual([OTHER_ID]);
    expect(secretRows()).toEqual([`connection_secret:${OTHER_ID}`]);
    expect(env.db.query('SELECT * FROM import_transactions ORDER BY id')).toEqual(importRows);
    expect(metas()).toEqual({ [first[0]!]: CONN_ID, [second[0]!]: CONN_ID });
    expect(new Set(env.api.getSmartImports().map((r) => r.connection_id))).toEqual(
      new Set([CONN_ID])
    );
    for (const id of [...first, ...second]) env.api.undoSmartImport(id);
    expect(metas()).toEqual({});
  });

  it('treats remove_data=false like no flag', () => {
    store(env.db, [CONN_ID]);
    apply([synced(H.s1, [chk('2026-09-03', -15.49)])]);
    expect(disconnect(CONN_ID, 'false').imports_kept).toBe(1);
    expect(Object.keys(metas())).toHaveLength(1);
    expect(connectionIds(env.db)).toEqual([]);
  });

  it('disconnects a connection with no secret row (the demo)', () => {
    store(env.db, [CONN_ID], false);
    expect(disconnect(CONN_ID, 'true').imports_undone).toBe(0);
    expect(connectionIds(env.db)).toEqual([]);
  });

  it('is 404 the second time', () => {
    store(env.db, [CONN_ID]);
    disconnect(CONN_ID);
    expectError(() => disconnect(CONN_ID), 404, 'connection_not_found');
    expectError(() => disconnect(CONN_ID, 'true'), 404, 'connection_not_found');
  });

  it.each([OTHER_ID, CONN_ID.toUpperCase(), 'connections', 'not-a-uuid'])(
    'unknown id %s is 404 and changes nothing',
    (id) => {
      store(env.db, [CONN_ID]);
      const before = snapshot();
      expectError(() => disconnect(id), 404, 'connection_not_found');
      expectError(() => disconnect(id, 'true'), 404, 'connection_not_found');
      expect(snapshot()).toEqual(before);
    }
  );

  it.each(['maybe', '1', 'yes', 'True', ''])('remove_data=%j is bad_request', (value) => {
    store(env.db, [CONN_ID]);
    expectError(() => disconnect(CONN_ID, value), 422, 'bad_request');
    expect(connectionIds(env.db)).toEqual([CONN_ID]);
  });

  it('parses remove_data like the server', () => {
    expect(parseRemoveData(undefined)).toBe(false);
    expect(parseRemoveData(null)).toBe(false);
    expect(parseRemoveData('false')).toBe(false);
    expect(parseRemoveData('true')).toBe(true);
  });
});

describe('disconnect and remove imported data', () => {
  it('undoes every import and keeps what the undo rules keep', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    store(env.db, [CONN_ID, OTHER_ID]);
    const older = apply(
      [synced(H.s1, [chk('2026-09-03', -15.49), chk('2026-09-15', -10.99, 'SPOTIFY')])],
      {
        rules: [
          {
            merchant_key: 'SPOTIFY',
            category_id: 'cat-Other',
            kind: 'expense',
            source: 'connector',
          },
        ],
        recurring: [
          candidate('create', 'SPOTIFY', {
            fileHash: H.s1,
            name: 'Spotify',
            amount: 10.99,
            category: 'cat-Other',
          }),
        ],
      }
    )[0]!;
    const newer = apply(
      [
        synced(H.s2, [card('2026-09-14', -42), card('2026-09-25', -12, 'LOANFEE')], {
          key: CARD,
          kind: 'credit_card',
          closing: { amount: 640, as_of: '2026-09-25' },
          liabilityId: 'L1',
        }),
      ],
      {
        recurring: [
          candidate('create', 'LOANFEE', {
            fileHash: H.s2,
            name: 'Loan fee',
            amount: 12,
            category: 'cat-Other',
          }),
        ],
        batch: 'batch-2',
      }
    )[0]!;
    const fileId = apply([statement(H.f1, [chk('2026-09-03', -15.49)])], { batch: 'batch-3' })[0]!;
    const other = apply([synced(H.o1, [chk('2026-09-21', -7, 'KIOSK')], { cid: OTHER_ID })], {
      batch: 'batch-4',
    })[0]!;
    const spotify = env.db.query<Row>("SELECT id FROM budget_expenses WHERE name = 'Spotify'")[0]!
      .id as string;
    const loanFee = env.db.query<Row>("SELECT id FROM budget_expenses WHERE name = 'Loan fee'")[0]!
      .id as string;
    env.db.execute('UPDATE budget_expenses SET amount = 11.99 WHERE id = ?', [spotify]);
    env.db.execute("UPDATE liabilities SET expense_id = ? WHERE id = 'L1'", [loanFee]);
    const rulesBefore = env.db.query(
      'SELECT merchant_key FROM merchant_rules ORDER BY merchant_key'
    );
    later();

    const body = disconnect(CONN_ID, 'true');
    expect(body).toEqual({
      connection_id: CONN_ID,
      remove_data: true,
      imports_undone: 2,
      imports_kept: 0,
      deleted: { transactions: 3, recurring_candidates: 2, expenses: 0, snapshots: 1 },
      reassigned: { transactions: 1 },
      kept: [
        { table: 'budget_expenses', id: loanFee, reason: 'linked_to_debt' },
        { table: 'budget_expenses', id: spotify, reason: 'edited' },
      ],
    });
    expect(connectionIds(env.db)).toEqual([OTHER_ID]);
    expect(secretRows()).toEqual([`connection_secret:${OTHER_ID}`]);
    expect(metas()).toEqual({ [fileId]: null, [other]: OTHER_ID });
    expect(
      env.db.query('SELECT import_id, merchant_key FROM import_transactions ORDER BY merchant_key')
    ).toEqual([
      { import_id: other, merchant_key: 'KIOSK' },
      { import_id: fileId, merchant_key: 'NETFLIX' },
    ]);
    expect(count(env.db, 'smart_import_ledger', 'import_id IN (?, ?)', [older, newer])).toBe(0);
    expect(
      env.db.query("SELECT current_balance, balance_as_of FROM liabilities WHERE id = 'L1'")
    ).toEqual([{ current_balance: 500, balance_as_of: '2026-09-01' }]);
    expect(
      env.db.query("SELECT source FROM liability_balance_snapshots WHERE liability_id = 'L1'")
    ).toEqual([{ source: 'manual' }]);
    expect(env.db.query('SELECT name FROM budget_expenses ORDER BY name')).toEqual([
      { name: 'Loan fee' },
      { name: 'Spotify' },
    ]);
    expect(env.db.query('SELECT merchant_key FROM merchant_rules ORDER BY merchant_key')).toEqual(
      rulesBefore
    );
  });

  it('undoes newest first, so a claim by a newer sync of the same connection hands nothing over', () => {
    store(env.db, [CONN_ID]);
    const first = apply([synced(H.s1, [chk('2026-09-03', -15.49)])])[0]!;
    const second = apply(
      [synced(H.s2, [chk('2026-09-03', -15.49), chk('2026-09-20', -20, 'GROCER')])],
      { batch: 'batch-2' }
    )[0]!;
    const [third, fourth] = apply(
      [
        synced(H.s3, [chk('2026-09-25', -3, 'KIOSK')]),
        synced(H.f1, [chk('2026-09-26', -4, 'KIOSK')]),
      ],
      { batch: 'batch-3' }
    );
    expect(smartImport.connectionImportIds(env.db, CONN_ID)).toEqual([
      fourth,
      third,
      second,
      first,
    ]);
    const body = disconnect(CONN_ID, 'true');
    expect(body.reassigned).toEqual({ transactions: 0 });
    expect((body.deleted as Row).transactions).toBe(4);
    expect(count(env.db, 'import_transactions')).toBe(0);
    expect(metas()).toEqual({});
  });

  it("lists a connection's imports newest first, insertion order breaking a tie", () => {
    store(env.db, [CONN_ID]);
    const first = apply([synced(H.s1, [chk('2026-09-03', -15.49)])])[0]!;
    const second = apply([synced(H.s2, [chk('2026-09-20', -20, 'GROCER')])], {
      batch: 'batch-2',
    })[0]!;
    const [third, fourth] = apply(
      [
        synced(H.s3, [chk('2026-09-25', -3, 'KIOSK')]),
        synced(H.f1, [chk('2026-09-26', -4, 'KIOSK')]),
      ],
      { batch: 'batch-3' }
    );
    expect(smartImport.connectionImportIds(env.db, CONN_ID)).toEqual([
      fourth,
      third,
      second,
      first,
    ]);
  });

  it('rolls everything back when an undo fails, and the retry succeeds', () => {
    addLiability(env.db, 'L1', { balance: 500, asOf: '2026-09-01' });
    store(env.db, [CONN_ID]);
    const oldest = apply([
      synced(H.s1, [card('2026-09-14', -42)], {
        key: CARD,
        kind: 'credit_card',
        closing: { amount: 640, as_of: '2026-09-25' },
        liabilityId: 'L1',
      }),
    ])[0]!;
    apply([synced(H.s2, [chk('2026-09-20', -20, 'GROCER')])], { batch: 'b2' });
    apply([synced(H.s3, [chk('2026-09-21', -21, 'GROCER')])], { batch: 'b3' });
    // An unreadable ledger row in the oldest import, which is undone last.
    env.db.execute(
      "UPDATE smart_import_ledger SET after_json = '{not json' WHERE import_id = ? AND action = 'snapshot'",
      [oldest]
    );
    const before = snapshot();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expectError(() => disconnect(CONN_ID, 'true'), 500, 'save_failed');
    expect(snapshot()).toEqual(before);
    expect(Object.keys(metas())).toHaveLength(3);
    expect(errors.mock.calls.flat().join(' ')).toContain('undone_before=2');

    env.db.execute(
      "UPDATE smart_import_ledger SET after_json = ? WHERE import_id = ? AND action = 'snapshot'",
      [JSON.stringify({ balance: 640, snapshot_date: '2026-09-25' }), oldest]
    );
    expect(disconnect(CONN_ID, 'true').imports_undone).toBe(3);
    expect(metas()).toEqual({});
    expect(connectionIds(env.db)).toEqual([]);
    expect(secretRows()).toEqual([]);
  });

  it('logs no planted credential or content', () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    addConnections(env.db, {
      [CONN_ID]: connectionEntry({ provider: 'simplefin', label: 'ZQ Disc Everyday' }),
      [OTHER_ID]: connectionEntry({ provider: 'simplefin' }),
    });
    for (const id of [CONN_ID, OTHER_ID]) {
      env.db.execute('INSERT INTO app_settings (key, value, encrypted) VALUES (?, ?, 1)', [
        `connection_secret:${id}`,
        SEALED,
      ]);
    }
    apply([synced(H.s1, [chk('2026-09-03', -6543.21, 'ZQXDISC WIDGETS')])]);
    apply([synced(H.o1, [chk('2026-09-04', -6543.21, 'ZQXDISC WIDGETS')], { cid: OTHER_ID })], {
      batch: 'b2',
    });
    const out = JSON.stringify([disconnect(CONN_ID), disconnect(OTHER_ID, 'true')]);
    const text = lines.join('\n') + out;
    for (const p of PLANTED) expect(text).not.toContain(p);
    expect(lines.join('\n')).toContain('connection_disconnected');
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

  it('serves DELETE /api/connections/{id} from the browser database with the flag', () => {
    store(clientDB, [CONN_ID]);
    clientDB.execute('UPDATE app_settings SET updated_at = NULL');
    expect(() =>
      tryLocalRoute(`/api/connections/${CONN_ID}?remove_data=maybe`, { method: 'DELETE' })
    ).toThrow(SmartImportHttpError);
    const body = tryLocalRoute(`/api/connections/${CONN_ID}?remove_data=true`, {
      method: 'DELETE',
    });
    expect(body).not.toBe(NOT_HANDLED);
    expect((body as Row).remove_data).toBe(true);
    expect(connectionIds(clientDB)).toEqual([]);
    expect(() => tryLocalRoute(`/api/connections/${CONN_ID}`, { method: 'DELETE' })).toThrow(
      SmartImportHttpError
    );
  });
});
