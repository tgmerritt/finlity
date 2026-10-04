/**
 * Client-side SQLite database manager using sql.js
 *
 * Supports two storage modes:
 * 1. File System Access API - Direct file access (Chrome/Edge)
 * 2. IndexedDB - Browser storage fallback (all browsers)
 *
 * The local `.db` file mirrors the server's SQLAlchemy schema (see
 * src/database/models.py) table-for-table and column-for-column so a
 * server profile export can be opened locally and vice versa.
 */

import initSqlJs from 'sql.js';
// Vite asset import - resolves to a hashed URL under the build output so the
// wasm binary is self-hosted rather than fetched from a CDN.
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

// Types for sql.js
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}

interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

// File System Access API types
interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  name: string;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: Blob | ArrayBuffer | string): Promise<void>;
  close(): Promise<void>;
}

interface FilePickerOptions {
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
  multiple?: boolean;
  suggestedName?: string;
}

declare global {
  interface Window {
    showOpenFilePicker?: (options?: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: FilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

export type StorageMode = 'file' | 'indexeddb' | 'memory' | 'imported' | null;

export interface DatabaseOpenResult {
  name: string;
  size?: number;
  mode: StorageMode;
}

/**
 * Result of a database save operation.
 * Uses discriminated union to prevent invalid state combinations.
 */
export type DatabaseSaveResult =
  | { status: 'saved'; name: string }
  | { status: 'downloaded'; name: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

export interface StorageInfo {
  isOpen: boolean;
  mode: StorageMode;
  isDirty: boolean;
  hasFileSystemAccess: boolean;
  fileName: string | null;
}

export interface QueryResult {
  changes: number;
  lastId: number | undefined;
}

/**
 * Callback type for auto-save failure notifications.
 */
export type AutoSaveFailureCallback = (failCount: number) => void;

/**
 * Client-side SQLite database manager.
 */
export class ClientDatabase {
  private db: SqlJsDatabase | null = null;
  private SQL: SqlJsStatic | null = null;
  private fileHandle: FileSystemFileHandle | null = null;
  private dbName = 'portfolio';
  private storageMode: StorageMode = null;
  private isDirty = false;
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  private autoSaveFailCount = 0;
  private onAutoSaveFailure: AutoSaveFailureCallback | null = null;

  /**
   * Optional override for locating the sql.js wasm binary. Defaults to the
   * self-hosted, Vite-bundled asset URL. Overridden in tests to point at the
   * wasm file under node_modules.
   */
  static wasmLocateFile: (file: string) => string = () => sqlWasmUrl;

  /**
   * Initialize sql.js WebAssembly module.
   */
  async init(): Promise<void> {
    if (this.SQL) return;

    try {
      this.SQL = (await initSqlJs({
        locateFile: ClientDatabase.wasmLocateFile,
      })) as unknown as SqlJsStatic;
      console.log('sql.js initialized successfully');
    } catch (error) {
      console.error('Failed to initialize sql.js:', error);
      throw new Error('Failed to initialize database engine');
    }
  }

  /**
   * Check if File System Access API is supported.
   */
  hasFileSystemAccess(): boolean {
    return 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
  }

  /**
   * Open a database file from the local filesystem.
   * Uses File System Access API (Chrome/Edge).
   */
  async openFile(): Promise<DatabaseOpenResult | null> {
    if (!this.hasFileSystemAccess()) {
      throw new Error('File System Access API not supported in this browser');
    }

    await this.init();

    try {
      const handles = await window.showOpenFilePicker!({
        types: [
          {
            description: 'SQLite Database',
            accept: { 'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'] },
          },
        ],
        multiple: false,
      });

      const handle = handles[0];
      if (!handle) {
        return null; // No file selected
      }

      this.fileHandle = handle;
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();

      this.db = new this.SQL!.Database(new Uint8Array(buffer));
      this.migrateSchema();
      this.storageMode = 'file';
      this.isDirty = false;

      this.startAutoSave();

      return {
        name: file.name,
        size: file.size,
        mode: 'file',
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return null; // User cancelled
      }
      throw error;
    }
  }

  /**
   * Create a new empty database.
   */
  async createNew(): Promise<DatabaseOpenResult> {
    await this.init();

    this.db = new this.SQL!.Database();
    this.initSchema();
    this.storageMode = 'memory';
    this.isDirty = true;

    return { mode: 'memory', name: 'New Database' };
  }

  /**
   * Save current database to file.
   * @throws Error if no database is open or save fails
   */
  async saveToFile(): Promise<DatabaseSaveResult> {
    if (!this.db) {
      throw new Error('No database open');
    }

    const data = this.db.export();
    // Copy to a new ArrayBuffer to avoid SharedArrayBuffer type issues
    const arrayBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(arrayBuffer).set(data);
    const blob = new Blob([arrayBuffer], { type: 'application/x-sqlite3' });

    if (this.fileHandle) {
      // Save to existing file
      try {
        const writable = await this.fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        this.isDirty = false;
        return { status: 'saved', name: this.fileHandle.name };
      } catch (error) {
        console.error('Failed to save to file:', error);
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    } else if (this.hasFileSystemAccess()) {
      // Save As - pick new location
      try {
        const handle = await window.showSaveFilePicker!({
          suggestedName: 'portfolio.db',
          types: [
            {
              description: 'SQLite Database',
              accept: { 'application/x-sqlite3': ['.db'] },
            },
          ],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        this.fileHandle = handle;
        this.storageMode = 'file';
        this.isDirty = false;

        return { status: 'saved', name: handle.name };
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return { status: 'cancelled' };
        }
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    } else {
      // Fallback: download file
      return this.downloadDatabase();
    }
  }

  /**
   * Download database as file (fallback for browsers without File System Access).
   * @param filename - Name for the downloaded file (default: 'portfolio.db')
   */
  downloadDatabase(filename = 'portfolio.db'): DatabaseSaveResult {
    if (!this.db) {
      throw new Error('No database open');
    }

    const data = this.db.export();
    // Copy to a new ArrayBuffer to avoid SharedArrayBuffer type issues
    const arrayBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(arrayBuffer).set(data);
    const blob = new Blob([arrayBuffer], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
    return { status: 'downloaded', name: filename };
  }

  /**
   * Import database from file input.
   */
  async importFromFile(file: File): Promise<{ name: string; size: number }> {
    await this.init();

    const buffer = await file.arrayBuffer();
    this.db = new this.SQL!.Database(new Uint8Array(buffer));
    this.migrateSchema();
    this.storageMode = 'imported';
    this.isDirty = false;

    return { name: file.name, size: file.size };
  }

  /**
   * Open the shared 'PortfolioApp' IndexedDB database, always installing
   * `onupgradeneeded` so the 'databases' object store is guaranteed to exist
   * before any caller's `onsuccess` handler runs.
   *
   * CRITICAL FIX (C1): every prior open call site (saveToIndexedDB,
   * loadFromIndexedDB, hasIndexedDBData, clearIndexedDB) independently
   * called `indexedDB.open('PortfolioApp', 1)`. Whichever one ran *first*
   * (in practice, `hasIndexedDBData()` from the boot gate) would commit the
   * database at version 1 with no object stores if it lacked
   * `onupgradeneeded`, or - even where a handler had its own
   * `onupgradeneeded` - a subsequent open at the same version never fires
   * `onupgradeneeded` again. Any caller opening after that point would find
   * no 'databases' store and throw a NotFoundError from inside `onsuccess`,
   * which (if unguarded) left its Promise permanently unsettled. Routing
   * every open through this single helper enforces the invariant in one
   * place instead of re-asserting it at each call site.
   *
   * Rejects (never hangs) on any request error.
   */
  private openIDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open('PortfolioApp', 1);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases');
        }
      };

      request.onsuccess = () => resolve(request.result);
    });
  }

  /**
   * Save to IndexedDB for persistence.
   */
  async saveToIndexedDB(): Promise<void> {
    if (!this.db) return;
    const data = this.db.export();

    const db = await this.openIDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');

        store.put(data, this.dbName);

        tx.oncomplete = () => {
          this.storageMode = 'indexeddb';
          this.isDirty = false;
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write transaction failed'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Load from IndexedDB.
   */
  async loadFromIndexedDB(): Promise<{ loaded: boolean; mode?: StorageMode }> {
    await this.init();

    const db = await this.openIDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('databases', 'readonly');
        const store = tx.objectStore('databases');
        const getRequest = store.get(this.dbName);

        getRequest.onsuccess = () => {
          try {
            if (getRequest.result) {
              // CRITICAL FIX (C2): `new SQL.Database(bytes)` and
              // `migrateSchema()` can throw (corrupted/incompatible bytes,
              // schema DDL error) - previously this ran unguarded inside the
              // onsuccess callback, so a throw here left the Promise
              // unsettled forever (the app hangs on boot with no recovery).
              // Wrapping in try/catch and rejecting lets callers (see
              // ensureLocalDatabaseReady's C3 fix) recover instead of
              // hanging.
              this.db = new this.SQL!.Database(new Uint8Array(getRequest.result as ArrayBuffer));
              this.migrateSchema();
              this.storageMode = 'indexeddb';
              this.isDirty = false;
              resolve({ loaded: true, mode: 'indexeddb' });
            } else {
              resolve({ loaded: false });
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB read failed'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Check if IndexedDB has saved data.
   *
   * CRITICAL FIX (C1): distinguishes "no data" (resolve false) from "error
   * opening/reading IndexedDB" (reject) - a genuine IndexedDB failure (e.g.
   * a corrupted browser profile) must not be silently reported as "no saved
   * data", which would make ensureLocalDatabaseReady() proceed as if this
   * were a fresh install and risk masking an existing database.
   */
  async hasIndexedDBData(): Promise<boolean> {
    const db = await this.openIDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('databases', 'readonly');
        const store = tx.objectStore('databases');
        const getRequest = store.get(this.dbName);
        getRequest.onsuccess = () => resolve(!!getRequest.result);
        getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB read failed'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Clear IndexedDB data.
   */
  async clearIndexedDB(): Promise<void> {
    const db = await this.openIDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');
        store.delete(this.dbName);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete transaction failed'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Full schema DDL - mirrors src/database/models.py table-for-table and
   * column-for-column so a server profile export (portfolio.db) opens
   * cleanly here and vice versa. All CREATE statements use IF NOT EXISTS so
   * this can be re-run against an existing file (see migrateSchema()).
   *
   * SQLite typing conventions (matching SQLAlchemy's SQLite storage):
   * - TEXT for ids/strings/datetimes (ISO 8601 strings)
   * - REAL for floats
   * - INTEGER 0/1 for booleans
   */
  private static readonly SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'individual',
        is_default INTEGER DEFAULT 0,
        is_household INTEGER DEFAULT 0,
        color TEXT DEFAULT '#4A90D9',
        icon TEXT DEFAULT 'user',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS file_imports (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        account_type TEXT NOT NULL,
        import_date TEXT DEFAULT CURRENT_TIMESTAMP,
        row_count REAL,
        status TEXT DEFAULT 'pending',
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        brokerage TEXT DEFAULT 'other',
        beneficiary TEXT,
        custom_type_name TEXT,
        is_retirement_account INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        name TEXT,
        shares REAL NOT NULL DEFAULT 0,
        cost_basis REAL,
        current_price REAL,
        sector TEXT,
        is_fund INTEGER DEFAULT 0,
        asset_class TEXT DEFAULT 'equity',
        position_type TEXT DEFAULT 'equity',
        maturity_date TEXT,
        interest_rate REAL,
        purchase_date TEXT,
        last_import_id TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        option_underlying TEXT,
        option_expiration TEXT,
        option_strike REAL,
        option_type TEXT,
        contract_multiplier REAL,
        FOREIGN KEY (account_id) REFERENCES accounts(id),
        FOREIGN KEY (last_import_id) REFERENCES file_imports(id)
      );

      CREATE TABLE IF NOT EXISTS position_lots (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        purchase_date TEXT NOT NULL,
        shares REAL NOT NULL,
        cost_basis REAL NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (position_id) REFERENCES positions(id)
      );

      CREATE TABLE IF NOT EXISTS realized_sales (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        sale_date TEXT NOT NULL,
        shares_sold REAL NOT NULL,
        proceeds REAL NOT NULL,
        cost_basis_realized REAL NOT NULL,
        gain_loss REAL NOT NULL,
        is_short_term INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id)
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id TEXT PRIMARY KEY,
        snapshot_date TEXT NOT NULL UNIQUE,
        total_value REAL,
        retirement_value REAL,
        taxable_value REAL,
        positions_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS price_cache (
        ticker TEXT PRIMARY KEY,
        current_price REAL,
        previous_close REAL,
        year_high REAL,
        year_low REAL,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        encrypted INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS allocation_triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        ticker TEXT,
        account_type TEXT,
        sector TEXT,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS portfolio_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        account_ids TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS budget_income_sources (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        name TEXT NOT NULL,
        income_type TEXT NOT NULL DEFAULT 'employment',
        gross_annual REAL NOT NULL,
        pay_frequency TEXT NOT NULL DEFAULT 'biweekly',
        state TEXT DEFAULT 'CA',
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE TABLE IF NOT EXISTS budget_tax_config (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        tax_year REAL NOT NULL DEFAULT 2024,
        filing_status TEXT NOT NULL DEFAULT 'single',
        state TEXT DEFAULT 'CA',
        ss_benefit_override REAL,
        additional_withholding REAL DEFAULT 0,
        itemized_deduction REAL,
        ss_claiming_age INTEGER DEFAULT 67,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE TABLE IF NOT EXISTS budget_expense_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '',
        color TEXT DEFAULT '#6b7280',
        sort_order REAL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS budget_expenses (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL,
        amount REAL NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'monthly',
        is_pretax INTEGER DEFAULT 0,
        is_mortgage INTEGER DEFAULT 0,
        principal_portion REAL,
        interest_portion REAL,
        is_active INTEGER DEFAULT 1,
        start_date TEXT,
        end_date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id),
        FOREIGN KEY (category_id) REFERENCES budget_expense_categories(id)
      );

      CREATE TABLE IF NOT EXISTS budget_pretax_deductions (
        id TEXT PRIMARY KEY,
        income_source_id TEXT,
        label TEXT,
        deduction_type TEXT NOT NULL DEFAULT '401k',
        amount_per_period REAL NOT NULL,
        employer_match REAL DEFAULT 0,
        is_percentage INTEGER DEFAULT 0,
        max_annual REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (income_source_id) REFERENCES budget_income_sources(id)
      );

      CREATE TABLE IF NOT EXISTS bank_statement_imports (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        file_name TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        row_count REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        analyzed_at TEXT,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE TABLE IF NOT EXISTS recurring_candidates (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        name TEXT NOT NULL,
        amount REAL NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'monthly',
        occurrences REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        created_expense_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (import_id) REFERENCES bank_statement_imports(id),
        FOREIGN KEY (created_expense_id) REFERENCES budget_expenses(id)
      );

      CREATE TABLE IF NOT EXISTS monte_carlo_results (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        run_date TEXT DEFAULT CURRENT_TIMESTAMP,
        current_age REAL NOT NULL,
        retirement_age REAL NOT NULL,
        portfolio_balance REAL NOT NULL,
        monthly_contribution REAL DEFAULT 0,
        monthly_withdrawal REAL DEFAULT 0,
        success_rate REAL NOT NULL,
        median_final_value REAL,
        worst_case_final REAL,
        best_case_final REAL,
        earliest_retirement_age REAL,
        projected_value_at_retirement REAL,
        conservative_value_at_retirement REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      -- Liabilities. entity_id, linked_position_id and expense_id are soft
      -- references (no FOREIGN KEY) so no existing delete path changes.
      -- Calendar dates are local-calendar 'YYYY-MM-DD' (never toISOString());
      -- the CHECKs reject datetime strings.
      CREATE TABLE IF NOT EXISTS liabilities (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        name TEXT NOT NULL,
        liability_type TEXT NOT NULL,
        lender TEXT,
        current_balance REAL NOT NULL,
        balance_as_of TEXT NOT NULL CHECK (length(balance_as_of) = 10),
        interest_rate REAL,
        payment_amount REAL,
        payment_frequency TEXT NOT NULL DEFAULT 'monthly',
        next_payment_date TEXT CHECK (length(next_payment_date) = 10),
        escrow_amount REAL,
        original_principal REAL,
        origination_date TEXT CHECK (length(origination_date) = 10),
        term_months INTEGER,
        maturity_date TEXT CHECK (length(maturity_date) = 10),
        credit_limit REAL,
        is_amortizing INTEGER NOT NULL,
        linked_position_id TEXT,
        expense_id TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        source_detail TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        closed_date TEXT CHECK (length(closed_date) = 10),
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS liability_balance_snapshots (
        id TEXT PRIMARY KEY,
        liability_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL CHECK (length(snapshot_date) = 10),
        balance REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (liability_id) REFERENCES liabilities(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_liability_snapshot_day
        ON liability_balance_snapshots(liability_id, snapshot_date);

      -- Smart import: soft references, calendar dates 'YYYY-MM-DD'.
      CREATE TABLE IF NOT EXISTS smart_import_meta (
        import_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        format TEXT NOT NULL,
        parser TEXT NOT NULL,
        account_kind TEXT NOT NULL,
        account_key TEXT,
        account_label TEXT,
        account_last4 TEXT,
        institution TEXT,
        period_start TEXT CHECK (length(period_start) = 10),
        period_end TEXT CHECK (length(period_end) = 10),
        closing_balance REAL,
        closing_balance_date TEXT CHECK (length(closing_balance_date) = 10),
        liability_id TEXT,
        txn_new INTEGER NOT NULL DEFAULT 0,
        txn_duplicate INTEGER NOT NULL DEFAULT 0,
        txn_excluded INTEGER NOT NULL DEFAULT 0,
        ai_used INTEGER NOT NULL DEFAULT 0,
        ai_provider TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS import_transactions (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        entity_id TEXT,
        account_key TEXT,
        posted_date TEXT NOT NULL CHECK (length(posted_date) = 10),
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        category_id TEXT,
        category_source TEXT NOT NULL,
        ai_confidence REAL,
        external_id TEXT,
        dedupe_key TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS ix_import_txn_import ON import_transactions(import_id);
      CREATE INDEX IF NOT EXISTS ix_import_txn_date ON import_transactions(posted_date);
      CREATE INDEX IF NOT EXISTS ix_import_txn_merchant ON import_transactions(merchant_key);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_import_txn_dedupe ON import_transactions(dedupe_key);

      CREATE TABLE IF NOT EXISTS merchant_rules (
        id TEXT PRIMARY KEY,
        merchant_key TEXT NOT NULL,
        category_id TEXT,
        kind TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_merchant_rule_key ON merchant_rules(merchant_key);

      CREATE TABLE IF NOT EXISTS smart_import_ledger (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS ix_smart_import_ledger_import ON smart_import_ledger(import_id);
  `;

  /**
   * Current local schema version, recorded as a row in app_settings under
   * key 'schema_version'. Bump when SCHEMA_SQL changes in a way that needs
   * tracking (informational only - migrateSchema() is idempotent via
   * CREATE TABLE IF NOT EXISTS and does not branch on this value today).
   */
  static readonly SCHEMA_VERSION = 1;

  /**
   * Initialize database schema on a brand new database (matches server
   * schema in src/database/models.py), then seed default rows.
   */
  initSchema(): void {
    if (!this.db) return;
    this.migrateSchema();
  }

  /**
   * Ensure all tables exist, creating any that are missing. Safe to call on
   * an existing file - CREATE TABLE IF NOT EXISTS never touches tables that
   * already exist (including legacy 4-table local DBs or full server
   * exports), so this only ever adds missing tables/rows, never mutates
   * existing columns. Called from every open path (openFile,
   * importFromFile, loadFromIndexedDB, createNew).
   */
  migrateSchema(): void {
    if (!this.db) return;
    this.db.run(ClientDatabase.SCHEMA_SQL);
    this.migrateAppSettingsUpdatedAt();
    this.recordSchemaVersion();
    this.seedDefaults();
  }

  /**
   * F12: retrofit `updated_at` onto app_settings when it's missing (legacy
   * local databases created before this column existed in SCHEMA_SQL).
   * CREATE TABLE IF NOT EXISTS (in SCHEMA_SQL above) never adds columns to
   * an existing table, so a legacy app_settings table would otherwise be
   * stuck without updated_at forever, and writeConfigSection's
   * `ON CONFLICT ... SET updated_at = excluded.updated_at` would fail
   * against it.
   *
   * NOTE: `ALTER TABLE ... ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP` is
   * rejected by SQLite - ADD COLUMN only accepts a literal constant or NULL
   * as its default, not an expression/keyword. So this adds a plain
   * nullable TEXT column with no default; existing rows get NULL (there is
   * no historical timestamp to backfill). LocalAPI's writeConfigSection
   * (the main app_settings writer, used by updateConfigSection/
   * updateTargetsSubsection) already sets updated_at explicitly via
   * nowIso() on every write, so config-section rows get a real timestamp
   * going forward even though this migration itself doesn't backfill one.
   */
  private migrateAppSettingsUpdatedAt(): void {
    if (!this.db) return;
    const columns = this.query<{ name: string }>('PRAGMA table_info(app_settings)');
    const hasUpdatedAt = columns.some((c) => c.name === 'updated_at');
    if (!hasUpdatedAt) {
      this.db.run('ALTER TABLE app_settings ADD COLUMN updated_at TEXT');
    }
  }

  /**
   * Record the current schema version in app_settings, if not already set
   * to a value greater than or equal to it.
   */
  private recordSchemaVersion(): void {
    if (!this.db) return;
    const existing = this.query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'schema_version'"
    );
    const currentVersion = existing[0] ? parseInt(existing[0].value, 10) : 0;
    if (
      !existing[0] ||
      Number.isNaN(currentVersion) ||
      currentVersion < ClientDatabase.SCHEMA_VERSION
    ) {
      this.db.run(`INSERT OR REPLACE INTO app_settings (key, value, encrypted) VALUES (?, ?, 0)`, [
        'schema_version',
        String(ClientDatabase.SCHEMA_VERSION),
      ]);
    }
  }

  /**
   * Seed default rows that the server also seeds on a fresh database:
   * - budget_expense_categories: 12 defaults (see src/budget/models.py DEFAULT_EXPENSE_CATEGORIES)
   * - entities: a default "Household" entity (see operations.py ensure_household_entity)
   * - portfolio_views: an "All Accounts" default view
   * Each block is idempotent - it only inserts when the relevant table is
   * empty (categories) or the specific row is absent (household entity,
   * All Accounts view), so re-running migrateSchema on every open never
   * duplicates rows.
   */
  private seedDefaults(): void {
    if (!this.db) return;

    // Default expense categories (matches src/budget/models.py DEFAULT_EXPENSE_CATEGORIES)
    const categoryCount = this.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM budget_expense_categories'
    )[0]?.count;
    if (!categoryCount) {
      const defaults: Array<[string, string, string, number]> = [
        ['Housing', 'home', '#3b82f6', 1],
        ['Utilities', 'bolt', '#8b5cf6', 2],
        ['Transportation', 'car', '#f97316', 3],
        ['Insurance', 'shield', '#06b6d4', 4],
        ['Healthcare', 'heart', '#ef4444', 5],
        ['Debt Payments', 'credit-card', '#f59e0b', 6],
        ['Food & Dining', 'utensils', '#22c55e', 7],
        ['Entertainment', 'film', '#ec4899', 8],
        ['Savings & Investments', 'piggy-bank', '#14b8a6', 9],
        ['Personal', 'user', '#6366f1', 10],
        ['Education', 'book', '#84cc16', 11],
        ['Other', 'ellipsis', '#6b7280', 99],
      ];
      for (const [name, icon, color, sortOrder] of defaults) {
        this.db.run(
          `INSERT INTO budget_expense_categories (id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), name, icon, color, sortOrder]
        );
      }
    }

    // Default household entity (matches operations.py ensure_household_entity)
    const household = this.query<{ id: string }>('SELECT id FROM entities WHERE is_household = 1');
    if (household.length === 0) {
      this.db.run(
        `INSERT INTO entities (id, name, entity_type, is_default, is_household, color, icon)
         VALUES (?, 'Household', 'household', 0, 1, '#2ECC71', 'users')`,
        [crypto.randomUUID()]
      );
    }

    // Default "All Accounts" portfolio view (matches seed_loader.py ensure_all_accounts_view)
    const allAccountsView = this.query<{ id: string }>(
      "SELECT id FROM portfolio_views WHERE name = 'All Accounts'"
    );
    if (allAccountsView.length === 0) {
      this.db.run(
        `INSERT INTO portfolio_views (id, name, account_ids, is_default) VALUES (?, 'All Accounts', '[]', 1)`,
        [crypto.randomUUID()]
      );
    }
  }

  /**
   * Execute a query and return results.
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (!this.db) {
      throw new Error('No database open');
    }

    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);

      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      stmt.free();

      return results;
    } catch (error) {
      console.error('Query error:', error, sql);
      throw error;
    }
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE).
   */
  execute(sql: string, params: unknown[] = []): QueryResult {
    if (!this.db) {
      throw new Error('No database open');
    }

    try {
      this.db.run(sql, params);
      this.isDirty = true;
      return { changes: this.db.getRowsModified(), lastId: this.getLastInsertId() };
    } catch (error) {
      console.error('Execute error:', error, sql);
      throw error;
    }
  }

  /**
   * Get last insert row ID.
   */
  getLastInsertId(): number | undefined {
    const result = this.query<{ id: number }>('SELECT last_insert_rowid() as id');
    return result[0]?.id;
  }

  /**
   * Set callback for auto-save failure notifications.
   * @param callback - Function called when auto-save fails repeatedly
   */
  setAutoSaveFailureCallback(callback: AutoSaveFailureCallback | null): void {
    this.onAutoSaveFailure = callback;
  }

  /**
   * Start auto-save interval.
   * Auto-save only persists data when in IndexedDB mode.
   * @param intervalMs - Interval between save attempts (default: 30000ms)
   */
  startAutoSave(intervalMs = 30000): void {
    this.stopAutoSave();
    this.autoSaveFailCount = 0;
    this.autoSaveInterval = setInterval(() => {
      if (!this.isDirty) return;

      if (this.storageMode === 'indexeddb') {
        this.saveToIndexedDB()
          .then(() => {
            console.log('Auto-saved to IndexedDB');
            this.autoSaveFailCount = 0;
          })
          .catch((error) => {
            console.error('Auto-save failed:', error);
            this.recordAutoSaveFailure();
          });
      } else if (this.storageMode === 'file' && this.fileHandle) {
        // F1(a): 'file' mode previously never auto-saved at all - only
        // 'indexeddb' mode did - so users who opened/saved to a real .db
        // file via the File System Access API had no protection against
        // losing unsaved work between manual saves. The File System Access
        // permission granted when the handle was obtained persists across
        // writes (no re-prompt needed) for the life of the page, so this is
        // safe to run unattended on the same interval as IndexedDB
        // auto-save. Routes failures through the same failure-count/
        // callback path as the IndexedDB branch.
        this.saveToFile()
          .then((result) => {
            if (result.status === 'saved') {
              console.log('Auto-saved to file');
              this.autoSaveFailCount = 0;
            } else if (result.status === 'failed') {
              console.error('Auto-save to file failed:', result.error);
              this.recordAutoSaveFailure();
            }
            // 'downloaded'/'cancelled' can't happen here: fileHandle is set,
            // so saveToFile() takes the "save to existing file" branch.
          })
          .catch((error) => {
            console.error('Auto-save to file failed:', error);
            this.recordAutoSaveFailure();
          });
      }
    }, intervalMs);
  }

  /**
   * Shared auto-save failure bookkeeping for both storage-mode branches of
   * startAutoSave(): increments the consecutive-failure counter and, once
   * it reaches 3, notifies the registered failure callback (see
   * setAutoSaveFailureCallback).
   */
  private recordAutoSaveFailure(): void {
    this.autoSaveFailCount++;
    if (this.autoSaveFailCount >= 3 && this.onAutoSaveFailure) {
      this.onAutoSaveFailure(this.autoSaveFailCount);
    }
  }

  /**
   * Stop auto-save interval.
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }

  /**
   * Close the database.
   */
  close(): void {
    this.stopAutoSave();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.fileHandle = null;
    this.storageMode = null;
  }

  /**
   * Check if database is open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Get current storage mode info.
   */
  getStorageInfo(): StorageInfo {
    return {
      isOpen: this.isOpen(),
      mode: this.storageMode,
      isDirty: this.isDirty,
      hasFileSystemAccess: this.hasFileSystemAccess(),
      fileName: this.fileHandle?.name ?? null,
    };
  }
}

// Global instance
export const clientDB = new ClientDatabase();
