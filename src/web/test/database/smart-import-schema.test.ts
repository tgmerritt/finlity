/**
 * Migration safety for the smart import tables on the browser path.
 * Mirrors tests/test_smart_import_schema.py: additive only, idempotent, and
 * pre-existing tables are byte-for-byte unchanged. The column lists are the
 * same literals as the Python test, which checks them against the models.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ClientDatabase } from '@/database/client-database';
import { createTestDatabase, useSequentialUuids } from './helpers';

const NEW_TABLES = ['smart_import_meta', 'import_transactions', 'merchant_rules', 'smart_import_ledger'];
const REUSED_TABLES = ['bank_statement_imports', 'recurring_candidates'];

const META_COLUMNS = [
  'import_id', 'batch_id', 'origin', 'format', 'parser', 'account_kind',
  'account_key', 'account_label', 'account_last4', 'institution',
  'period_start', 'period_end', 'closing_balance', 'closing_balance_date',
  'liability_id', 'txn_new', 'txn_duplicate', 'txn_excluded', 'ai_used',
  'ai_provider', 'created_at',
];
const TXN_COLUMNS = [
  'id', 'import_id', 'entity_id', 'account_key', 'posted_date', 'amount',
  'description', 'merchant_key', 'kind', 'category_id', 'category_source',
  'ai_confidence', 'external_id', 'dedupe_key', 'created_at',
];
const RULE_COLUMNS = ['id', 'merchant_key', 'category_id', 'kind', 'hits', 'created_at', 'updated_at'];
const LEDGER_COLUMNS = [
  'id', 'import_id', 'action', 'target_table', 'target_id', 'before_json',
  'after_json', 'created_at',
];
const COLUMNS: Record<string, string[]> = {
  smart_import_meta: META_COLUMNS,
  import_transactions: TXN_COLUMNS,
  merchant_rules: RULE_COLUMNS,
  smart_import_ledger: LEDGER_COLUMNS,
};
// index name -> [table, columns, unique]
const INDEXES: Record<string, [string, string[], boolean]> = {
  ix_import_txn_import: ['import_transactions', ['import_id'], false],
  ix_import_txn_date: ['import_transactions', ['posted_date'], false],
  ix_import_txn_merchant: ['import_transactions', ['merchant_key'], false],
  ux_import_txn_dedupe: ['import_transactions', ['dedupe_key'], true],
  ux_merchant_rule_key: ['merchant_rules', ['merchant_key'], true],
  ix_smart_import_ledger_import: ['smart_import_ledger', ['import_id'], false],
};

function dropNewTables(db: ClientDatabase): void {
  for (const t of NEW_TABLES) db.execute(`DROP TABLE IF EXISTS ${t}`);
}

/** DDL + row hash of every table except the new ones, plus every other index's DDL. */
function fingerprint(db: ClientDatabase): Record<string, string> {
  const objects = db.query<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  );
  const out: Record<string, string> = {};
  for (const o of objects) {
    if (NEW_TABLES.includes(o.tbl_name)) continue;
    if (o.type !== 'table') {
      out[`${o.type}:${o.name}`] = String(o.sql);
      continue;
    }
    const h = createHash('sha256');
    for (const row of db.query(`SELECT * FROM "${o.name}" ORDER BY rowid`)) {
      h.update(JSON.stringify(row));
    }
    out[o.name] = `${o.sql}|${h.digest('hex')}`;
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

function expectNewSchema(db: ClientDatabase): void {
  for (const t of NEW_TABLES) expect(tableNames(db)).toContain(t);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    expect(columns(db, table)).toEqual(cols);
    expect(db.query(`PRAGMA foreign_key_list(${table})`)).toEqual([]);
  }
  for (const [name, [table, cols, unique]] of Object.entries(INDEXES)) {
    const row = db.query<{ tbl_name: string }>(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
      [name]
    );
    expect(row).toEqual([{ tbl_name: table }]);
    expect(db.query<{ name: string }>(`PRAGMA index_info("${name}")`).map((r) => r.name)).toEqual(cols);
    const flags = db.query<{ name: string; unique: number }>(`PRAGMA index_list("${table}")`);
    expect(flags.find((f) => f.name === name)?.unique).toBe(unique ? 1 : 0);
  }
  const named = db
    .query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${NEW_TABLES.map(() => '?').join(', ')})`,
      NEW_TABLES
    )
    .map((r) => r.name)
    .sort();
  expect(named).toEqual(Object.keys(INDEXES).sort());
}

describe('smart import schema migration safety', () => {
  let restoreUuids: () => void;
  beforeEach(() => {
    restoreUuids = useSequentialUuids();
  });
  afterEach(() => restoreUuids());

  it('createNew then migrateSchema twice only adds the new tables', async () => {
    const db = await createTestDatabase();
    dropNewTables(db);
    const before = fingerprint(db);
    for (const t of REUSED_TABLES) expect(Object.keys(before)).toContain(t);
    const versionBefore = schemaVersionRow(db);
    expect(versionBefore.length).toBe(1);
    for (const t of NEW_TABLES) expect(tableNames(db)).not.toContain(t);

    db.migrateSchema();
    expectNewSchema(db);
    expect(fingerprint(db)).toEqual(before);

    db.migrateSchema();
    expectNewSchema(db);
    expect(fingerprint(db)).toEqual(before);
    expect(schemaVersionRow(db)).toEqual(versionBefore);
    expect(ClientDatabase.SCHEMA_VERSION).toBe(1);
  });

  it('enforces unique dedupe keys and merchant rule keys', async () => {
    const db = await createTestDatabase();
    const insertTxn = (id: string): void =>
      db.execute(
        "INSERT INTO import_transactions (id, import_id, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES (?, 'imp1', '2026-10-01', -4.5, 'COFFEE', 'COFFEE', 'expense', 'none', 'acct:x|abc')",
        [id]
      );
    insertTxn('t1');
    expect(() => insertTxn('t2')).toThrow(/UNIQUE/);

    const insertRule = (id: string): void =>
      db.execute("INSERT INTO merchant_rules (id, merchant_key) VALUES (?, 'COFFEE')", [id]);
    insertRule('r1');
    expect(() => insertRule('r2')).toThrow(/UNIQUE/);
    expect(db.query('SELECT hits FROM merchant_rules')).toEqual([{ hits: 0 }]);
  });

  it('rejects datetime-format dates (calendar days only) and defaults counters to 0', async () => {
    const db = await createTestDatabase();
    expect(() =>
      db.execute(
        "INSERT INTO import_transactions (id, import_id, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES ('t1', 'imp1', '2026-10-01T00:00:00.000Z', -1, 'X', 'X', 'expense', 'none', 'k1')"
      )
    ).toThrow(/CHECK/);
    const insertMeta = (id: string, col: string, value: string): void =>
      db.execute(
        `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, ${col}) VALUES (?, 'b1', 'file', 'csv', 'csv', 'checking', ?)`,
        [id, value]
      );
    for (const col of ['period_start', 'period_end', 'closing_balance_date']) {
      expect(() => insertMeta(`bad-${col}`, col, '2026-10-01T00:00:00.000Z')).toThrow(/CHECK/);
    }
    insertMeta('imp1', 'period_end', '2026-09-30');
    expect(
      db.query(
        'SELECT period_start, period_end, txn_new, txn_duplicate, txn_excluded, ai_used FROM smart_import_meta'
      )
    ).toEqual([
      { period_start: null, period_end: '2026-09-30', txn_new: 0, txn_duplicate: 0, txn_excluded: 0, ai_used: 0 },
    ]);
  });

  it('upgrades a copy of the tracked demo.db without touching existing tables', async () => {
    const demoPath = path.resolve(process.cwd(), '../../data/demo/demo.db');
    const bytes = fs.readFileSync(demoPath);
    const db = new ClientDatabase();
    await db.init();
    await db.importFromFile(new File([new Uint8Array(bytes)], 'demo.db'));

    // The tracked file may or may not already carry the new tables.
    dropNewTables(db);
    const hashes = fingerprint(db);
    for (const t of REUSED_TABLES) expect(Object.keys(hashes)).toContain(t);
    const versionBefore = schemaVersionRow(db);

    db.migrateSchema();

    expectNewSchema(db);
    expect(fingerprint(db)).toEqual(hashes);
    expect(schemaVersionRow(db)).toEqual(versionBefore);

    db.migrateSchema();
    expect(fingerprint(db)).toEqual(hashes);
  });
});
