/**
 * Regression tests for onboarding.ts's storage-action helpers:
 *
 * - F1(b): createNewLocalDatabase() must persist to IndexedDB immediately
 *   (not leave storageMode as 'memory', under which auto-save is a no-op).
 * - F2: createNewLocalDatabase()/openLocalDatabase() must not silently
 *   discard unsaved changes - they should confirm with the user first via
 *   confirmDiscardUnsavedChanges() (window.confirm) when clientDB is open
 *   and dirty.
 *
 * Mocks clientDB the same way test/features/onboarding-boot-gate.test.ts
 * does, so no real IndexedDB/sql.js machinery is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClientDB } = vi.hoisted(() => ({
  mockClientDB: {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    createNew: vi.fn().mockResolvedValue({ mode: 'memory', name: 'New Database' }),
    saveToIndexedDB: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(null),
    importFromFile: vi.fn(),
    hasFileSystemAccess: vi.fn().mockReturnValue(false),
    startAutoSave: vi.fn(),
    setAutoSaveFailureCallback: vi.fn(),
    isOpen: vi.fn().mockReturnValue(false),
    getStorageInfo: vi.fn().mockReturnValue({
      isOpen: false,
      mode: null,
      isDirty: false,
      hasFileSystemAccess: false,
      fileName: null,
    }),
  },
}));

vi.mock('@/database/client-database', () => ({
  clientDB: mockClientDB,
}));

vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/ui/loading', () => ({
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

vi.mock('@/ui/tabs', () => ({
  showTab: vi.fn(),
}));

import { createNewLocalDatabase, openLocalDatabase } from '@/features/onboarding';

describe('onboarding.ts storage actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientDB.createNew.mockResolvedValue({ mode: 'memory', name: 'New Database' });
    mockClientDB.saveToIndexedDB.mockResolvedValue(undefined);
    mockClientDB.hasFileSystemAccess.mockReturnValue(false);
    mockClientDB.isOpen.mockReturnValue(false);
    mockClientDB.getStorageInfo.mockReturnValue({
      isOpen: false,
      mode: null,
      isDirty: false,
      hasFileSystemAccess: false,
      fileName: null,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  describe('F1(b): createNewLocalDatabase persists immediately', () => {
    it('calls saveToIndexedDB() right after createNew() so auto-save has somewhere to write', async () => {
      await createNewLocalDatabase();

      expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
      expect(mockClientDB.saveToIndexedDB).toHaveBeenCalledTimes(1);
      expect(mockClientDB.startAutoSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('F2: unsaved-changes confirmation', () => {
    it('createNewLocalDatabase proceeds without prompting when nothing is open', async () => {
      mockClientDB.isOpen.mockReturnValue(false);

      await createNewLocalDatabase();

      expect(window.confirm).not.toHaveBeenCalled();
      expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
    });

    it('createNewLocalDatabase proceeds without prompting when open but not dirty', async () => {
      mockClientDB.isOpen.mockReturnValue(true);
      mockClientDB.getStorageInfo.mockReturnValue({
        isOpen: true,
        mode: 'indexeddb',
        isDirty: false,
        hasFileSystemAccess: false,
        fileName: null,
      });

      await createNewLocalDatabase();

      expect(window.confirm).not.toHaveBeenCalled();
      expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
    });

    it('createNewLocalDatabase prompts and proceeds when open and dirty and the user confirms', async () => {
      mockClientDB.isOpen.mockReturnValue(true);
      mockClientDB.getStorageInfo.mockReturnValue({
        isOpen: true,
        mode: 'indexeddb',
        isDirty: true,
        hasFileSystemAccess: false,
        fileName: null,
      });
      (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await createNewLocalDatabase();

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(mockClientDB.createNew).toHaveBeenCalledTimes(1);
    });

    it('createNewLocalDatabase aborts without creating a new database when the user declines', async () => {
      mockClientDB.isOpen.mockReturnValue(true);
      mockClientDB.getStorageInfo.mockReturnValue({
        isOpen: true,
        mode: 'indexeddb',
        isDirty: true,
        hasFileSystemAccess: false,
        fileName: null,
      });
      (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await createNewLocalDatabase();

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(mockClientDB.createNew).not.toHaveBeenCalled();
    });

    it('openLocalDatabase (File System Access branch) prompts before overwriting dirty data', async () => {
      mockClientDB.isOpen.mockReturnValue(true);
      mockClientDB.getStorageInfo.mockReturnValue({
        isOpen: true,
        mode: 'file',
        isDirty: true,
        hasFileSystemAccess: true,
        fileName: 'portfolio.db',
      });
      mockClientDB.hasFileSystemAccess.mockReturnValue(true);
      (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);

      openLocalDatabase();

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(mockClientDB.openFile).not.toHaveBeenCalled();
    });

    it('openLocalDatabase proceeds to openFile() when the user confirms discarding unsaved changes', async () => {
      mockClientDB.isOpen.mockReturnValue(true);
      mockClientDB.getStorageInfo.mockReturnValue({
        isOpen: true,
        mode: 'file',
        isDirty: true,
        hasFileSystemAccess: true,
        fileName: 'portfolio.db',
      });
      mockClientDB.hasFileSystemAccess.mockReturnValue(true);
      mockClientDB.openFile.mockResolvedValue(null);
      (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(true);

      openLocalDatabase();
      await Promise.resolve();
      await Promise.resolve();

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(mockClientDB.openFile).toHaveBeenCalledTimes(1);
    });
  });
});
