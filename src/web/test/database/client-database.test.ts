/**
 * Tests for ClientDatabase schema creation and migration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ClientDatabase } from '@/database/client-database';
import { createTestDatabase, useSequentialUuids } from './helpers';

const EXPECTED_TABLES = [
  'entities',
  'file_imports',
  'accounts',
  'positions',
  'position_lots',
  'realized_sales',
  'portfolio_snapshots',
  'price_cache',
  'app_settings',
  'allocation_triggers',
  'portfolio_views',
  'budget_income_sources',
  'budget_tax_config',
  'budget_expense_categories',
  'budget_expenses',
  'budget_pretax_deductions',
  'bank_statement_imports',
  'recurring_candidates',
  'monte_carlo_results',
];

describe('ClientDatabase schema', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it('creates all expected tables on a new database', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const tableNames = new Set(tables.map((t) => t.name));

    for (const expected of EXPECTED_TABLES) {
      expect(tableNames.has(expected)).toBe(true);
    }
  });

  it('seeds default expense categories exactly once', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    const categories = db.query<{ name: string }>('SELECT name FROM budget_expense_categories');
    expect(categories.length).toBe(12);
    expect(categories.map((c) => c.name)).toContain('Housing');
    expect(categories.map((c) => c.name)).toContain('Other');

    // Re-running migrateSchema should not duplicate seed rows.
    db.migrateSchema();
    const again = db.query<{ name: string }>('SELECT name FROM budget_expense_categories');
    expect(again.length).toBe(12);
  });

  it('seeds a default household entity exactly once', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    const households = db.query<{ id: string; name: string }>(
      'SELECT id, name FROM entities WHERE is_household = 1'
    );
    expect(households.length).toBe(1);
    expect(households[0]?.name).toBe('Household');

    db.migrateSchema();
    const again = db.query<{ id: string }>('SELECT id FROM entities WHERE is_household = 1');
    expect(again.length).toBe(1);
  });

  it('seeds a default "All Accounts" portfolio view exactly once', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    const views = db.query<{ name: string; is_default: number }>(
      "SELECT name, is_default FROM portfolio_views WHERE name = 'All Accounts'"
    );
    expect(views.length).toBe(1);
    expect(views[0]?.is_default).toBe(1);

    db.migrateSchema();
    const again = db.query<{ name: string }>(
      "SELECT name FROM portfolio_views WHERE name = 'All Accounts'"
    );
    expect(again.length).toBe(1);
  });

  it('records a schema_version row in app_settings', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    const version = db.query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'schema_version'"
    );
    expect(version.length).toBe(1);
    expect(Number(version[0]?.value)).toBe(ClientDatabase.SCHEMA_VERSION);
  });

  it('migrateSchema adds missing tables to a legacy 4-table database without touching existing data', async () => {
    restore = useSequentialUuids();

    // Build a "legacy" (pre-WS2) 4-table buffer directly with sql.js,
    // matching the old INTEGER PK accounts/positions schema.
    const bootstrap = new ClientDatabase();
    await bootstrap.init();
    const SQLctor = (bootstrap as unknown as { SQL: { Database: new () => RawSqlJsDb } }).SQL;
    const raw = new SQLctor.Database();
    raw.run(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        is_retirement INTEGER DEFAULT 0
      );
      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        shares REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, encrypted INTEGER DEFAULT 0);
      CREATE TABLE price_cache (ticker TEXT PRIMARY KEY, current_price REAL, last_updated DATETIME);
      INSERT INTO accounts (name, account_type) VALUES ('Legacy Account', 'taxable');
    `);
    const legacyBuffer = raw.export();

    const opened = new ClientDatabase();
    await opened.init();
    await opened.importFromFile(new File([legacyBuffer], 'legacy.db', { type: 'application/x-sqlite3' }));

    const tables = opened.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    const tableNames = new Set(tables.map((t) => t.name));
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames.has(expected)).toBe(true);
    }

    // Legacy row survives migration untouched (still has an INTEGER id).
    const legacyAccounts = opened.query<{ id: number; name: string }>('SELECT id, name FROM accounts');
    expect(legacyAccounts.length).toBe(1);
    expect(legacyAccounts[0]?.name).toBe('Legacy Account');
  });

  it('F12: migrateSchema retrofits updated_at onto a legacy app_settings table missing it', async () => {
    restore = useSequentialUuids();

    // Build a legacy app_settings table with no updated_at column at all
    // (matches real pre-WS2 local databases) and a pre-existing row, to
    // exercise the ALTER TABLE ADD COLUMN migration path specifically -
    // migrateSchema() on a brand-new database never exercises it, since
    // SCHEMA_SQL already includes updated_at for a fresh CREATE TABLE.
    const bootstrap = new ClientDatabase();
    await bootstrap.init();
    const SQLctor = (bootstrap as unknown as { SQL: { Database: new () => RawSqlJsDb } }).SQL;
    const raw = new SQLctor.Database();
    raw.run(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, encrypted INTEGER DEFAULT 0);
      INSERT INTO app_settings (key, value) VALUES ('existing_key', 'existing_value');
    `);
    const legacyBuffer = raw.export();

    const opened = new ClientDatabase();
    await opened.init();
    // Must not throw - this is the exact scenario that would hit "ALTER
    // TABLE ... ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP", which SQLite
    // rejects, if the fix used an expression default instead of a plain
    // nullable column.
    await expect(
      opened.importFromFile(new File([legacyBuffer], 'legacy.db', { type: 'application/x-sqlite3' }))
    ).resolves.toBeDefined();

    const columns = opened.query<{ name: string }>('PRAGMA table_info(app_settings)');
    expect(columns.some((c) => c.name === 'updated_at')).toBe(true);

    // Pre-existing row survives, with updated_at NULL (no historical
    // timestamp to backfill).
    const existing = opened.query<{ value: string; updated_at: string | null }>(
      "SELECT value, updated_at FROM app_settings WHERE key = 'existing_key'"
    )[0];
    expect(existing?.value).toBe('existing_value');
    expect(existing?.updated_at).toBeNull();

    // A fresh config-section write (writeConfigSection, used by
    // LocalAPI.updateConfigSection) sets updated_at going forward - the
    // retrofitted column isn't just present, it's actually usable.
    opened.execute(
      `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['a_new_key', 'a_new_value', new Date().toISOString()]
    );
    const newRow = opened.query<{ updated_at: string | null }>(
      "SELECT updated_at FROM app_settings WHERE key = 'a_new_key'"
    )[0];
    expect(newRow?.updated_at).toBeTruthy();
  });

  it('migrateSchema is idempotent when updated_at already exists (fresh database)', async () => {
    restore = useSequentialUuids();
    const db = await createTestDatabase();

    // Should not throw on a second migrateSchema() call against a database
    // that already has the column.
    expect(() => db.migrateSchema()).not.toThrow();

    const columns = db.query<{ name: string }>('PRAGMA table_info(app_settings)');
    expect(columns.some((c) => c.name === 'updated_at')).toBe(true);
  });
});

interface RawSqlJsDb {
  run(sql: string): void;
  export(): Uint8Array;
}
