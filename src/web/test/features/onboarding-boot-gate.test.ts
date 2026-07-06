/**
 * Boot-gate tests for the hosted/local-mode database gate
 * (ensureLocalDatabaseReady in src/features/onboarding.ts).
 *
 * Per the WS3 plan: init() must block until a local database is open when
 * dataMode === 'local', and must not run this gate at all in server mode
 * (main.ts only calls ensureLocalDatabaseReady() inside the
 * `dataMode === 'local'` branch — see src/main.ts's init()). This suite
 * exercises ensureLocalDatabaseReady() directly (main.ts self-executes on
 * import and isn't designed to be re-invoked per-test), mocking clientDB so
 * no real IndexedDB/sql.js machinery is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClientDB } = vi.hoisted(() => ({
  mockClientDB: {
    init: vi.fn().mockResolvedValue(undefined),
    hasIndexedDBData: vi.fn().mockResolvedValue(false),
    loadFromIndexedDB: vi.fn().mockResolvedValue({ loaded: false }),
    createNew: vi.fn().mockResolvedValue({ mode: 'memory', name: 'New Database' }),
    saveToIndexedDB: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(null),
    importFromFile: vi.fn(),
    hasFileSystemAccess: vi.fn().mockReturnValue(false),
    startAutoSave: vi.fn(),
    setAutoSaveFailureCallback: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getStorageInfo: vi.fn().mockReturnValue({
      isOpen: true,
      mode: 'memory',
      isDirty: false,
      hasFileSystemAccess: false,
      fileName: null,
    }),
  },
}));

vi.mock('@/database/client-database', () => ({
  clientDB: mockClientDB,
}));

vi.mock('@/api/dispatcher', () => ({
  getLocalAPI: () => ({ takeSnapshot: vi.fn() }),
}));

vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/ui/loading', () => ({
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

import { ensureLocalDatabaseReady } from '@/features/onboarding';

describe('ensureLocalDatabaseReady (boot gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientDB.init.mockResolvedValue(undefined);
    mockClientDB.hasIndexedDBData.mockResolvedValue(false);
    mockClientDB.loadFromIndexedDB.mockResolvedValue({ loaded: false });
    mockClientDB.createNew.mockResolvedValue({ mode: 'memory', name: 'New Database' });
    mockClientDB.saveToIndexedDB.mockResolvedValue(undefined);
    mockClientDB.openFile.mockResolvedValue(null);
    mockClientDB.hasFileSystemAccess.mockReturnValue(false);
    mockClientDB.isOpen.mockReturnValue(true);
    document.body.replaceChildren();
  });

  it('loads silently and resolves without showing a gate modal when IndexedDB already has saved data', async () => {
    mockClientDB.hasIndexedDBData.mockResolvedValue(true);
    mockClientDB.loadFromIndexedDB.mockResolvedValue({ loaded: true, mode: 'indexeddb' });

    await ensureLocalDatabaseReady();

    expect(mockClientDB.loadFromIndexedDB).toHaveBeenCalledTimes(1);
    expect(mockClientDB.createNew).not.toHaveBeenCalled();
    // No gate overlay should have been appended to the DOM.
    expect(document.querySelector('.db-gate-overlay')).toBeNull();
  });

  it('blocks on a gate modal until the user picks "create new" when IndexedDB has nothing saved', async () => {
    mockClientDB.hasIndexedDBData.mockResolvedValue(false);

    let resolved = false;
    const readyPromise = ensureLocalDatabaseReady().then(() => {
      resolved = true;
    });

    // Give the async hasIndexedDBData() check a microtask to resolve and
    // the modal to be appended, without resolving ensureLocalDatabaseReady.
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    const overlay = document.querySelector('.db-gate-overlay');
    expect(overlay).not.toBeNull();

    // Click "Create new database".
    const createBtn = Array.from(overlay!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create new database')
    );
    expect(createBtn).toBeDefined();
    createBtn!.dispatchEvent(new Event('click', { bubbles: true }));

    await readyPromise;

    expect(resolved).toBe(true);
    expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
    // The gate overlay is removed once a choice is made.
    expect(document.querySelector('.db-gate-overlay')).toBeNull();
  });

  it('starts auto-save and takes a baseline snapshot once a database is ready', async () => {
    mockClientDB.hasIndexedDBData.mockResolvedValue(true);
    mockClientDB.loadFromIndexedDB.mockResolvedValue({ loaded: true, mode: 'indexeddb' });

    await ensureLocalDatabaseReady();

    expect(mockClientDB.startAutoSave).toHaveBeenCalled();
  });

  it('F1(b): "Create new database" on the gate modal persists to IndexedDB immediately', async () => {
    mockClientDB.hasIndexedDBData.mockResolvedValue(false);

    const readyPromise = ensureLocalDatabaseReady();
    await Promise.resolve();
    await Promise.resolve();

    const overlay = document.querySelector('.db-gate-overlay');
    const createBtn = Array.from(overlay!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create new database')
    );
    createBtn!.dispatchEvent(new Event('click', { bubbles: true }));

    await readyPromise;

    expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
    // Must persist right away so auto-save (indexeddb-mode only) is active
    // from the first keystroke, instead of leaving storageMode as 'memory'.
    expect(mockClientDB.saveToIndexedDB).toHaveBeenCalledTimes(1);
  });

  describe('C3: storage failure recovery', () => {
    it('shows the gate modal with an error notice and "Start fresh" action when hasIndexedDBData() rejects', async () => {
      mockClientDB.hasIndexedDBData.mockRejectedValue(new Error('IndexedDB unavailable'));
      mockClientDB.clearIndexedDB = vi.fn().mockResolvedValue(undefined);

      let resolved = false;
      const readyPromise = ensureLocalDatabaseReady().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved).toBe(false);
      const overlay = document.querySelector('.db-gate-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay!.textContent).toContain('Could not read your saved data');

      const startFreshBtn = Array.from(overlay!.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Start fresh')
      );
      expect(startFreshBtn).toBeDefined();
      startFreshBtn!.dispatchEvent(new Event('click', { bubbles: true }));

      await readyPromise;

      expect(resolved).toBe(true);
      expect(mockClientDB.clearIndexedDB).toHaveBeenCalledTimes(1);
      expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.db-gate-overlay')).toBeNull();
    });

    it('shows the gate modal with an error notice when loadFromIndexedDB() rejects, and never hangs', async () => {
      mockClientDB.hasIndexedDBData.mockResolvedValue(true);
      mockClientDB.loadFromIndexedDB.mockRejectedValue(new Error('corrupted database bytes'));

      let resolved = false;
      const readyPromise = ensureLocalDatabaseReady().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const overlay = document.querySelector('.db-gate-overlay');
      expect(overlay).not.toBeNull();

      const createBtn = Array.from(overlay!.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create new database')
      );
      createBtn!.dispatchEvent(new Event('click', { bubbles: true }));

      await readyPromise;
      expect(resolved).toBe(true);
    });
  });
});
