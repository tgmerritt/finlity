/**
 * Shared test helpers for database tests: initializes a real sql.js
 * instance in Node (pointed at the wasm binary under node_modules) and
 * provides a stable, collision-free crypto.randomUUID() stub, since the
 * global test setup (test/setup.ts) stubs randomUUID() to always return the
 * same constant string, which would violate PRIMARY KEY uniqueness the
 * moment a test inserts more than one row.
 */

import path from 'node:path';
import { ClientDatabase } from '@/database/client-database';
import { createLocalAPI, LocalAPI } from '@/database/local-api';

/**
 * Point sql.js at the real wasm binary shipped in node_modules instead of
 * the Vite-bundled asset URL (which doesn't exist outside a browser build).
 * sql.js's own loader uses this return value as a plain filesystem path, so
 * we resolve it from the test runner's cwd (src/web) rather than via
 * import.meta.url - under vitest/vite-node, relative URL resolution against
 * import.meta.url does not reliably map back to real filesystem paths.
 */
const SQL_WASM_DIR = path.resolve(process.cwd(), 'node_modules/sql.js/dist');
ClientDatabase.wasmLocateFile = (file: string): string => path.join(SQL_WASM_DIR, file);

/**
 * jsdom's File/Blob polyfills don't implement arrayBuffer() (a well-known
 * jsdom gap - real browsers support it fine). Patch it once here so
 * importFromFile()/openFile() tests can exercise real File objects.
 */
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

let uuidCounter = 0;

/**
 * Install a sequential, collision-free UUID generator for the duration of a
 * test. Call the returned restore function in an afterEach/finally to put
 * the global test-setup stub back.
 */
export function useSequentialUuids(): () => void {
  const original = globalThis.crypto.randomUUID;
  uuidCounter = 0;
  globalThis.crypto.randomUUID = (() => `test-uuid-${++uuidCounter}`) as typeof original;
  return () => {
    globalThis.crypto.randomUUID = original;
  };
}

/** Create a fresh in-memory ClientDatabase with schema + seed data applied. */
export async function createTestDatabase(): Promise<ClientDatabase> {
  const db = new ClientDatabase();
  await db.createNew();
  return db;
}

/** Create a fresh ClientDatabase + LocalAPI pair for a test. */
export async function createTestApi(): Promise<{ db: ClientDatabase; api: LocalAPI }> {
  const db = await createTestDatabase();
  const api = createLocalAPI(db);
  return { db, api };
}
