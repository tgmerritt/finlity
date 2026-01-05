/**
 * Client-side SQLite database manager using sql.js
 *
 * Supports two storage modes:
 * 1. File System Access API - Direct file access (Chrome/Edge)
 * 2. IndexedDB - Browser storage fallback (all browsers)
 */

// Types for sql.js (loaded via CDN)
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
   * Initialize sql.js WebAssembly module.
   */
  async init(): Promise<void> {
    if (this.SQL) return;

    try {
      // initSqlJs is a global function from the CDN script
      const initSqlJs = (window as unknown as { initSqlJs: (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic> }).initSqlJs;
      this.SQL = await initSqlJs({
        locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
      });
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
        return { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
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
        return { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
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
    this.storageMode = 'imported';
    this.isDirty = false;

    return { name: file.name, size: file.size };
  }

  /**
   * Save to IndexedDB for persistence.
   */
  async saveToIndexedDB(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const data = this.db!.export();
      const request = indexedDB.open('PortfolioApp', 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases');
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');

        store.put(data, this.dbName);

        tx.oncomplete = () => {
          this.storageMode = 'indexeddb';
          this.isDirty = false;
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  /**
   * Load from IndexedDB.
   */
  async loadFromIndexedDB(): Promise<{ loaded: boolean; mode?: StorageMode }> {
    await this.init();

    return new Promise((resolve, reject) => {
      const request = indexedDB.open('PortfolioApp', 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases');
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('databases', 'readonly');
        const store = tx.objectStore('databases');
        const getRequest = store.get(this.dbName);

        getRequest.onsuccess = () => {
          if (getRequest.result) {
            this.db = new this.SQL!.Database(new Uint8Array(getRequest.result as ArrayBuffer));
            this.storageMode = 'indexeddb';
            this.isDirty = false;
            resolve({ loaded: true, mode: 'indexeddb' });
          } else {
            resolve({ loaded: false });
          }
        };
        getRequest.onerror = () => reject(getRequest.error);
      };
    });
  }

  /**
   * Check if IndexedDB has saved data.
   */
  async hasIndexedDBData(): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open('PortfolioApp', 1);
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('databases')) {
          resolve(false);
          return;
        }
        const tx = db.transaction('databases', 'readonly');
        const store = tx.objectStore('databases');
        const getRequest = store.get(this.dbName);
        getRequest.onsuccess = () => resolve(!!getRequest.result);
        getRequest.onerror = () => resolve(false);
      };
    });
  }

  /**
   * Clear IndexedDB data.
   */
  async clearIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('PortfolioApp', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('databases')) {
          resolve();
          return;
        }
        const tx = db.transaction('databases', 'readwrite');
        const store = tx.objectStore('databases');
        store.delete(this.dbName);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  /**
   * Initialize database schema (matches server schema).
   */
  initSchema(): void {
    if (!this.db) return;

    const schema = `
      -- Accounts table
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        brokerage TEXT,
        beneficiary TEXT,
        custom_type_name TEXT,
        is_retirement INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Positions table
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        name TEXT,
        shares REAL NOT NULL DEFAULT 0,
        cost_basis REAL DEFAULT 0,
        current_price REAL DEFAULT 0,
        sector TEXT,
        is_fund INTEGER DEFAULT 0,
        asset_class TEXT,
        position_type TEXT DEFAULT 'equity',
        maturity_date DATE,
        interest_rate REAL,
        purchase_date DATE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id)
      );

      -- App settings table
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        encrypted INTEGER DEFAULT 0
      );

      -- Price cache table
      CREATE TABLE IF NOT EXISTS price_cache (
        ticker TEXT PRIMARY KEY,
        current_price REAL,
        last_updated DATETIME
      );
    `;

    this.db.run(schema);
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
      if (this.isDirty && this.storageMode === 'indexeddb') {
        this.saveToIndexedDB()
          .then(() => {
            console.log('Auto-saved to IndexedDB');
            this.autoSaveFailCount = 0;
          })
          .catch((error) => {
            console.error('Auto-save failed:', error);
            this.autoSaveFailCount++;
            // Notify callback after 3 consecutive failures
            if (this.autoSaveFailCount >= 3 && this.onAutoSaveFailure) {
              this.onAutoSaveFailure(this.autoSaveFailCount);
            }
          });
      }
    }, intervalMs);
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
