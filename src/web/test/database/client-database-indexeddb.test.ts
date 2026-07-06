/**
 * Regression tests for the IndexedDB persistence paths on ClientDatabase
 * (see C1/C2 in the fix plan): hasIndexedDBData/saveToIndexedDB/
 * loadFromIndexedDB/clearIndexedDB all route through a shared openIDB()
 * helper that always installs `onupgradeneeded`, so the 'databases' object
 * store is guaranteed to exist before any caller's `onsuccess` runs.
 *
 * Uses fake-indexeddb (a real, spec-following in-memory IndexedDB
 * implementation) rather than mocking indexedDB.open() by hand, so these
 * tests exercise the actual open/upgrade/transaction sequence instead of a
 * simplified stand-in that could miss the exact bug being fixed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ClientDatabase } from '@/database/client-database';
// Side-effect import: points ClientDatabase.wasmLocateFile at the real wasm
// binary under node_modules (see helpers.ts) instead of the Vite-bundled
// asset URL, which doesn't resolve outside a browser build.
import { useSequentialUuids } from './helpers';

describe('ClientDatabase IndexedDB persistence', () => {
  let restoreUuids: () => void;

  beforeEach(() => {
    // Fresh, empty IndexedDB for every test - fake-indexeddb persists state
    // across tests within a module otherwise (it's a module-level singleton
    // mimicking a real browser profile).
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    // createNew() seeds 12 expense categories; the global test-setup stub
    // for crypto.randomUUID() always returns the same string, which would
    // violate the categories' PRIMARY KEY the moment more than one row is
    // inserted (see helpers.ts's docstring).
    restoreUuids = useSequentialUuids();
  });

  afterEach(() => {
    restoreUuids?.();
  });

  it('C1: hasIndexedDBData() on a completely fresh IndexedDB resolves false, not hang or throw', async () => {
    const db = new ClientDatabase();
    await expect(db.hasIndexedDBData()).resolves.toBe(false);
  });

  it('C1: saveToIndexedDB() after a fresh hasIndexedDBData() check actually persists (no NotFoundError)', async () => {
    const db = new ClientDatabase();
    await db.createNew();

    // This ordering — hasIndexedDBData() first, then saveToIndexedDB() —
    // is exactly ensureLocalDatabaseReady()'s boot sequence, and is the
    // reproduction for the original bug: hasIndexedDBData() with no
    // onupgradeneeded would commit an empty v1 database with no object
    // stores, and every subsequent open (including this save) would find
    // no 'databases' store and throw inside onsuccess with an unsettled
    // Promise.
    await expect(db.hasIndexedDBData()).resolves.toBe(false);
    await expect(db.saveToIndexedDB()).resolves.toBeUndefined();

    // The save must be durable and re-readable.
    await expect(db.hasIndexedDBData()).resolves.toBe(true);

    const loaded = new ClientDatabase();
    const result = await loaded.loadFromIndexedDB();
    expect(result.loaded).toBe(true);
    expect(result.mode).toBe('indexeddb');
  });

  it('C1: clearIndexedDB() on a fresh IndexedDB resolves without throwing', async () => {
    const db = new ClientDatabase();
    await expect(db.clearIndexedDB()).resolves.toBeUndefined();
  });

  it('round-trips data through save -> load across two separate ClientDatabase instances', async () => {
    const writer = new ClientDatabase();
    await writer.createNew();
    writer.execute(
      "INSERT INTO entities (id, name, entity_type) VALUES ('e1', 'Test Entity', 'individual')"
    );
    await writer.saveToIndexedDB();

    const reader = new ClientDatabase();
    const result = await reader.loadFromIndexedDB();
    expect(result.loaded).toBe(true);

    const rows = reader.query<{ name: string }>("SELECT name FROM entities WHERE id = 'e1'");
    expect(rows[0]?.name).toBe('Test Entity');
  });

  it('C2: loadFromIndexedDB() rejects (does not hang) when the stored bytes are not a valid sql.js database', async () => {
    // Seed IndexedDB directly with garbage bytes under the same key
    // ClientDatabase uses, bypassing saveToIndexedDB() so we control the
    // stored payload precisely.
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    await new Promise<void>((resolve, reject) => {
      const req = idb.open('PortfolioApp', 1);
      req.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;
        database.createObjectStore('databases');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('databases', 'readwrite');
        tx.objectStore('databases').put(new Uint8Array([1, 2, 3, 4, 5]).buffer, 'portfolio');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    const db = new ClientDatabase();
    // Previously this could leave the returned Promise permanently
    // unsettled (app hangs on boot); it must now reject so callers (see
    // ensureLocalDatabaseReady's C3 fix) can recover.
    await expect(db.loadFromIndexedDB()).rejects.toBeTruthy();
  });

  it('hasIndexedDBData() rejects (not resolves false) on a genuine IndexedDB open error, distinguishing errors from "no data"', async () => {
    const db = new ClientDatabase();
    const openSpy = vi
      .spyOn(globalThis.indexedDB, 'open')
      .mockImplementation(() => {
        throw new Error('simulated IndexedDB failure');
      });

    await expect(db.hasIndexedDBData()).rejects.toThrow('simulated IndexedDB failure');
    openSpy.mockRestore();
  });
});
