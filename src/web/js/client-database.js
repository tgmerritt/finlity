/**
 * Client-side SQLite database manager using sql.js
 *
 * Supports two storage modes:
 * 1. File System Access API - Direct file access (Chrome/Edge)
 * 2. IndexedDB - Browser storage fallback (all browsers)
 */

class ClientDatabase {
    constructor() {
        this.db = null;
        this.SQL = null;
        this.fileHandle = null;  // File System Access API handle
        this.dbName = 'portfolio';  // IndexedDB database name
        this.storageMode = null;  // 'file' or 'indexeddb'
        this.isDirty = false;  // Track unsaved changes
        this.autoSaveInterval = null;
    }

    /**
     * Initialize sql.js WebAssembly module
     */
    async init() {
        if (this.SQL) return;

        try {
            this.SQL = await initSqlJs({
                locateFile: file => `https://sql.js.org/dist/${file}`
            });
            console.log('sql.js initialized successfully');
        } catch (error) {
            console.error('Failed to initialize sql.js:', error);
            throw new Error('Failed to initialize database engine');
        }
    }

    /**
     * Check if File System Access API is supported
     */
    hasFileSystemAccess() {
        return 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
    }

    /**
     * Open a database file from the local filesystem
     * Uses File System Access API (Chrome/Edge)
     */
    async openFile() {
        if (!this.hasFileSystemAccess()) {
            throw new Error('File System Access API not supported in this browser');
        }

        await this.init();

        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'SQLite Database',
                    accept: { 'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'] }
                }],
                multiple: false
            });

            this.fileHandle = handle;
            const file = await handle.getFile();
            const buffer = await file.arrayBuffer();

            this.db = new this.SQL.Database(new Uint8Array(buffer));
            this.storageMode = 'file';
            this.isDirty = false;

            // Start auto-save
            this.startAutoSave();

            return {
                name: file.name,
                size: file.size,
                mode: 'file'
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                return null;  // User cancelled
            }
            throw error;
        }
    }

    /**
     * Create a new empty database
     */
    async createNew() {
        await this.init();

        this.db = new this.SQL.Database();
        this.initSchema();
        this.storageMode = 'memory';
        this.isDirty = true;

        return { mode: 'memory', name: 'New Database' };
    }

    /**
     * Save current database to file
     */
    async saveToFile() {
        if (!this.db) {
            throw new Error('No database open');
        }

        const data = this.db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });

        if (this.fileHandle) {
            // Save to existing file
            try {
                const writable = await this.fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                this.isDirty = false;
                return { saved: true, name: this.fileHandle.name };
            } catch (error) {
                console.error('Failed to save to file:', error);
                throw error;
            }
        } else if (this.hasFileSystemAccess()) {
            // Save As - pick new location
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: 'portfolio.db',
                    types: [{
                        description: 'SQLite Database',
                        accept: { 'application/x-sqlite3': ['.db'] }
                    }]
                });

                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();

                this.fileHandle = handle;
                this.storageMode = 'file';
                this.isDirty = false;

                return { saved: true, name: handle.name };
            } catch (error) {
                if (error.name === 'AbortError') {
                    return { saved: false, cancelled: true };
                }
                throw error;
            }
        } else {
            // Fallback: download file
            return this.downloadDatabase();
        }
    }

    /**
     * Download database as file (fallback for browsers without File System Access)
     */
    downloadDatabase(filename = 'portfolio.db') {
        if (!this.db) {
            throw new Error('No database open');
        }

        const data = this.db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        URL.revokeObjectURL(url);
        return { saved: true, downloaded: true, name: filename };
    }

    /**
     * Import database from file input
     */
    async importFromFile(file) {
        await this.init();

        const buffer = await file.arrayBuffer();
        this.db = new this.SQL.Database(new Uint8Array(buffer));
        this.storageMode = 'imported';
        this.isDirty = false;

        return { name: file.name, size: file.size };
    }

    /**
     * Save to IndexedDB for persistence
     */
    async saveToIndexedDB() {
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const data = this.db.export();
            const request = indexedDB.open('PortfolioApp', 1);

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
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
     * Load from IndexedDB
     */
    async loadFromIndexedDB() {
        await this.init();

        return new Promise((resolve, reject) => {
            const request = indexedDB.open('PortfolioApp', 1);

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
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
                        this.db = new this.SQL.Database(new Uint8Array(getRequest.result));
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
     * Check if IndexedDB has saved data
     */
    async hasIndexedDBData() {
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
     * Clear IndexedDB data
     */
    async clearIndexedDB() {
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
     * Initialize database schema (matches server schema)
     */
    initSchema() {
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
     * Execute a query and return results
     */
    query(sql, params = []) {
        if (!this.db) {
            throw new Error('No database open');
        }

        try {
            const stmt = this.db.prepare(sql);
            stmt.bind(params);

            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();

            return results;
        } catch (error) {
            console.error('Query error:', error, sql);
            throw error;
        }
    }

    /**
     * Execute a statement (INSERT, UPDATE, DELETE)
     */
    execute(sql, params = []) {
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
     * Get last insert row ID
     */
    getLastInsertId() {
        const result = this.query('SELECT last_insert_rowid() as id');
        return result[0]?.id;
    }

    /**
     * Start auto-save interval (for IndexedDB mode)
     */
    startAutoSave(intervalMs = 30000) {
        this.stopAutoSave();
        this.autoSaveInterval = setInterval(async () => {
            if (this.isDirty && this.storageMode === 'indexeddb') {
                await this.saveToIndexedDB();
                console.log('Auto-saved to IndexedDB');
            }
        }, intervalMs);
    }

    /**
     * Stop auto-save interval
     */
    stopAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
    }

    /**
     * Close the database
     */
    close() {
        this.stopAutoSave();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.fileHandle = null;
        this.storageMode = null;
    }

    /**
     * Check if database is open
     */
    isOpen() {
        return this.db !== null;
    }

    /**
     * Get current storage mode info
     */
    getStorageInfo() {
        return {
            isOpen: this.isOpen(),
            mode: this.storageMode,
            isDirty: this.isDirty,
            hasFileSystemAccess: this.hasFileSystemAccess(),
            fileName: this.fileHandle?.name || null
        };
    }
}

// Global instance
const clientDB = new ClientDatabase();
