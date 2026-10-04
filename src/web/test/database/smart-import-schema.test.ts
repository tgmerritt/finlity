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

// [name, notnull, default as PRAGMA table_info reports it]. Same literals as
// tests/test_smart_import_schema.py, which checks them against the models, so
// nullability and default drift fail on both paths.
type ColumnSpec = [string, number, string | null];
const NOW = 'CURRENT_TIMESTAMP';
const META_SPEC: ColumnSpec[] = [
  ['import_id', 1, null], ['batch_id', 1, null], ['origin', 1, null], ['format', 1, null],
  ['parser', 1, null], ['account_kind', 1, null], ['account_key', 0, null],
  ['account_label', 0, null], ['account_last4', 0, null], ['institution', 0, null],
  ['period_start', 0, null], ['period_end', 0, null], ['closing_balance', 0, null],
  ['closing_balance_date', 0, null], ['liability_id', 0, null], ['connection_id', 0, null],
  ['txn_new', 1, '0'], ['txn_duplicate', 1, '0'], ['txn_excluded', 1, '0'], ['ai_used', 1, '0'],
  ['ai_provider', 0, null], ['created_at', 0, NOW],
];
const TXN_SPEC: ColumnSpec[] = [
  ['id', 1, null], ['import_id', 1, null], ['entity_id', 0, null], ['account_key', 1, null],
  ['posted_date', 1, null], ['amount', 1, null], ['description', 1, null],
  ['merchant_key', 1, null], ['kind', 1, null], ['category_id', 0, null],
  ['category_source', 1, null], ['ai_confidence', 0, null], ['external_id', 0, null],
  ['dedupe_key', 1, null], ['created_at', 0, NOW],
];
const RULE_SPEC: ColumnSpec[] = [
  ['id', 1, null], ['merchant_key', 1, null], ['category_id', 0, null], ['kind', 0, null],
  ['hits', 1, '0'], ['source', 1, "'user'"], ['last_import_id', 0, null],
  ['created_at', 0, NOW], ['updated_at', 0, NOW],
];
const LEDGER_SPEC: ColumnSpec[] = [
  ['id', 1, null], ['import_id', 1, null], ['action', 1, null], ['target_table', 1, null],
  ['target_id', 1, null], ['before_json', 0, null], ['after_json', 0, null],
  ['created_at', 0, NOW],
];
const SPECS: Record<string, ColumnSpec[]> = {
  smart_import_meta: META_SPEC,
  import_transactions: TXN_SPEC,
  merchant_rules: RULE_SPEC,
  smart_import_ledger: LEDGER_SPEC,
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

function columnSpec(db: ClientDatabase, table: string): ColumnSpec[] {
  return db
    .query<{ name: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(${table})`)
    .map((c) => [c.name, c.notnull, c.dflt_value]);
}

function expectNewSchema(db: ClientDatabase): void {
  for (const t of NEW_TABLES) expect(tableNames(db)).toContain(t);
  for (const [table, spec] of Object.entries(SPECS)) {
    expect(columnSpec(db, table)).toEqual(spec);
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
        "INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES (?, 'imp1', 'acct:x', '2026-10-01', -4.5, 'COFFEE', 'COFFEE', 'expense', 'none', 'acct:x|abc')",
        [id]
      );
    insertTxn('t1');
    expect(() => insertTxn('t2')).toThrow(/UNIQUE/);

    const insertRule = (id: string): void =>
      db.execute("INSERT INTO merchant_rules (id, merchant_key) VALUES (?, 'COFFEE')", [id]);
    insertRule('r1');
    expect(() => insertRule('r2')).toThrow(/UNIQUE/);
    expect(db.query('SELECT hits, source FROM merchant_rules')).toEqual([{ hits: 0, source: 'user' }]);
  });

  it('rejects datetime-format dates (calendar days only) and defaults counters to 0', async () => {
    const db = await createTestDatabase();
    expect(() =>
      db.execute(
        "INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES ('t1', 'imp1', 'acct:x', '2026-10-01T00:00:00.000Z', -1, 'X', 'X', 'expense', 'none', 'k1')"
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

  it('guards masked text lengths, last4 and rule source', async () => {
    const db = await createTestDatabase();
    const insertTxn = (id: string, description: string, merchant: string, account: string | null = 'acct:x'): void =>
      db.execute(
        "INSERT INTO import_transactions (id, import_id, account_key, posted_date, amount, description, merchant_key, kind, category_source, dedupe_key) VALUES (?, 'imp1', ?, '2026-10-01', -1, ?, ?, 'expense', 'none', ?)",
        [id, account, description, merchant, `k-${id}`]
      );
    insertTxn('t1', 'D'.repeat(120), 'M'.repeat(120));
    expect(() => insertTxn('t2', 'D'.repeat(121), 'M')).toThrow(/CHECK/);
    expect(() => insertTxn('t3', 'D', 'M'.repeat(121))).toThrow(/CHECK/);
    expect(() => insertTxn('t4', 'D', 'M', null)).toThrow(/NOT NULL/);

    const insertMeta = (id: string, last4: string | null): void =>
      db.execute(
        "INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_last4) VALUES (?, 'b1', 'file', 'csv', 'csv', 'checking', ?)",
        [id, last4]
      );
    insertMeta('imp1', '1234');
    insertMeta('imp2', null);
    expect(() => insertMeta('imp3', '12345')).toThrow(/CHECK/);

    const insertRule = (id: string, merchant: string, source: string): void =>
      db.execute('INSERT INTO merchant_rules (id, merchant_key, source) VALUES (?, ?, ?)', [id, merchant, source]);
    ['user', 'import', 'ai', 'connector'].forEach((source, i) => insertRule(`r${i}`, `M${i}`, source));
    expect(() => insertRule('r9', 'OTHER', 'seed')).toThrow(/CHECK/);
    expect(() => insertRule('r8', 'M'.repeat(121), 'user')).toThrow(/CHECK/);
  });
});
