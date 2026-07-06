/**
 * Regression tests for F3: initSession()'s fail-safe dataMode resolution.
 *
 * Before this fix, any transient /api/session/init failure (network error
 * or non-OK status) made resolveDataMode() default to 'server' — on a
 * hosted (multi_user_mode=true) deployment that would silently route user
 * data to server-side v1 endpoints for the rest of the session. The fix:
 * cache the last confirmed multi_user_mode in localStorage on every
 * successful init, and on failure use that cached value (or 'local' if
 * there's no cache yet) instead of 'server'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { store } from '@/state/store';

vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
}));

import { showToast } from '@/ui/toast';
import { initSession } from '@/state/session';

const LAST_KNOWN_KEY = 'lastKnownMultiUserMode';

describe('initSession (F3 fail-safe dataMode)', () => {
  let storageBackend: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    store.resetState();

    // The global test setup (test/setup.ts) mocks localStorage as bare
    // vi.fn() spies with no backing store; F3 needs get/set to actually
    // round-trip, so replace it with a minimal real implementation for this
    // suite only.
    storageBackend = new Map();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storageBackend.get(key) ?? null,
        setItem: (key: string, value: string) => storageBackend.set(key, value),
        removeItem: (key: string) => storageBackend.delete(key),
        clear: () => storageBackend.clear(),
        length: 0,
        key: () => null,
      },
      configurable: true,
    });

    global.fetch = vi.fn();
  });

  it('branch 1 (success): caches multi_user_mode=true and resolves dataMode to local', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hmac_key: 'key123',
        signing_required: true,
        multi_user_mode: true,
      }),
    });

    await initSession();

    expect(store.get('dataMode')).toBe('local');
    expect(store.get('multiUserMode')).toBe(true);
    expect(window.localStorage.getItem(LAST_KNOWN_KEY)).toBe('true');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('branch 1 (success): caches multi_user_mode=false and resolves dataMode to server', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hmac_key: null,
        signing_required: false,
        multi_user_mode: false,
      }),
    });

    await initSession();

    expect(store.get('dataMode')).toBe('server');
    expect(window.localStorage.getItem(LAST_KNOWN_KEY)).toBe('false');
  });

  it('branch 2 (failure with cache): a network error after a prior successful hosted init stays in local mode, not server', async () => {
    // Simulate a prior successful init that confirmed multi_user_mode=true.
    window.localStorage.setItem(LAST_KNOWN_KEY, 'true');

    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    await initSession();

    expect(store.get('dataMode')).toBe('local');
    expect(showToast).toHaveBeenCalledWith(
      'Could not confirm server mode — using local data mode',
      'warning'
    );
  });

  it('branch 2 (failure with cache): a non-OK response after a prior confirmed non-hosted init stays server', async () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, 'false');

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });

    await initSession();

    expect(store.get('dataMode')).toBe('server');
    expect(showToast).toHaveBeenCalledWith(
      'Could not confirm server mode — using local data mode',
      'warning'
    );
  });

  it('branch 3 (failure with no cache): defaults to local (never leaks data) and warns', async () => {
    expect(window.localStorage.getItem(LAST_KNOWN_KEY)).toBeNull();

    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('Failed to fetch')
    );

    await initSession();

    expect(store.get('dataMode')).toBe('local');
    expect(showToast).toHaveBeenCalledWith(
      'Could not confirm server mode — using local data mode',
      'warning'
    );
  });
});
