/**
 * Migration safety for the liabilities tables on the browser path.
 * Mirrors tests/test_liabilities_schema.py: additive only, idempotent, and
 * pre-existing tables are byte-for-byte unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ClientDatabase } from '@/database/client-database';
import { createTestDatabase, useSequentialUuids } from './helpers';

const NEW_TABLES = ['liabilities', 'liability_balance_snapshots'];

const LIABILITY_COLUMNS = [
  'id', 'entity_id', 'name', 'liability_type', 'lender', 'current_balance',
  'balance_as_of', 'interest_rate', 'payment_amount', 'payment_frequency',
  'next_payment_date', 'escrow_amount', 'original_principal', 'origination_date',
  'term_months', 'maturity_date', 'credit_limit', 'is_amortizing',
  'linked_position_id', 'expense_id', 'source', 'source_ref', 'source_detail',
  'is_active', 'closed_date', 'notes', 'created_at', 'updated_at',
];
const SNAPSHOT_COLUMNS = ['id', 'liability_id', 'snapshot_date', 'balance', 'source', 'source_ref', 'created_at'];

function dropNewTables(db: ClientDatabase): void {
  db.execute('DROP TABLE IF EXISTS liability_balance_snapshots');
  db.execute('DROP TABLE IF EXISTS liabilities');
}

/** DDL + row hash of every table except the new ones. */
function fingerprint(db: ClientDatabase): Record<string, string> {
  const tables = db.query<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (NEW_TABLES.includes(t.name)) continue;
    const h = createHash('sha256');
    for (const row of db.query(`SELECT * FROM "${t.name}" ORDER BY rowid`)) {
      h.update(JSON.stringify(row));
    }
    out[t.name] = `${t.sql}|${h.digest('hex')}`;
  }
  return out;
}

function schemaVersionRow(db: ClientDatabase): unknown[] {
  return db.query("SELECT * FROM app_settings WHERE key = 'schema_version'");
}

function tableNames(db: ClientDatabase): string[] {
  return db
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name);
}

function columns(db: ClientDatabase, table: string): string[] {
  return db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
}

describe('liabilities schema migration safety', () => {
  let restoreUuids: () => void;
  beforeEach(() => {
    restoreUuids = useSequentialUuids();
  });
  afterEach(() => restoreUuids());

  it('createNew then migrateSchema twice only adds the new tables', async () => {
    const db = await createTestDatabase();
    dropNewTables(db);
    const before = fingerprint(db);
    const versionBefore = schemaVersionRow(db);
    expect(versionBefore.length).toBe(1);
    expect(tableNames(db)).not.toContain('liabilities');

    db.migrateSchema();
    db.migrateSchema();

    for (const t of NEW_TABLES) expect(tableNames(db)).toContain(t);
    expect(columns(db, 'liabilities')).toEqual(LIABILITY_COLUMNS);
    expect(columns(db, 'liability_balance_snapshots')).toEqual(SNAPSHOT_COLUMNS);
    expect(fingerprint(db)).toEqual(before);
    expect(schemaVersionRow(db)).toEqual(versionBefore);
    expect(ClientDatabase.SCHEMA_VERSION).toBe(1);
  });

  it('enforces one snapshot per liability per day', async () => {
    const db = await createTestDatabase();
    db.execute(
      "INSERT INTO liabilities (id, name, liability_type, current_balance, balance_as_of, is_amortizing) VALUES ('l1', 'Mortgage', 'mortgage', 100, '2026-10-01', 1)"
    );
    const insert = (id: string): void =>
      db.execute(
        "INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance) VALUES (?, 'l1', '2026-10-01', 100)",
        [id]
      );
    insert('s1');
    expect(() => insert('s2')).toThrow(/UNIQUE/);
  });

  it('rejects datetime-format dates (calendar days only)', async () => {
    const db = await createTestDatabase();
    expect(() =>
      db.execute(
        "INSERT INTO liabilities (id, name, liability_type, current_balance, balance_as_of, is_amortizing) VALUES ('l1', 'M', 'mortgage', 1, '2026-10-01T00:00:00.000Z', 1)"
      )
    ).toThrow(/CHECK/);
    db.execute(
      "INSERT INTO liabilities (id, name, liability_type, current_balance, balance_as_of, is_amortizing) VALUES ('l1', 'M', 'mortgage', 1, '2026-10-01', 1)"
    );
    expect(() =>
      db.execute(
        "INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance) VALUES ('s1', 'l1', '2026-10-01T00:00:00.000Z', 1)"
      )
    ).toThrow(/CHECK/);
    // Nullable calendar dates accept NULL.
    expect(db.query('SELECT closed_date FROM liabilities')[0]).toEqual({ closed_date: null });
  });

  it('upgrades a copy of the tracked demo.db without touching existing tables', async () => {
    const demoPath = path.resolve(process.cwd(), '../../data/demo/demo.db');
    const bytes = fs.readFileSync(demoPath);
    const before = new ClientDatabase();
    await before.init();
    await before.importFromFile(new File([new Uint8Array(bytes)], 'demo.db'));

    // The tracked file may or may not already carry the new tables.
    dropNewTables(before);
    const hashes = fingerprint(before);
    const versionBefore = schemaVersionRow(before);

    before.migrateSchema();

    for (const t of NEW_TABLES) expect(tableNames(before)).toContain(t);
    expect(fingerprint(before)).toEqual(hashes);
    expect(schemaVersionRow(before)).toEqual(versionBefore);

    before.migrateSchema();
    expect(fingerprint(before)).toEqual(hashes);
  });
});
