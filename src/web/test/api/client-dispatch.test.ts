/**
 * Regression tests for the apiCall() dataMode branching in src/api/client.ts
 * (F5: passthrough allowlist).
 *
 * The whole server-mode compatibility guarantee for this refactor rides on
 * one guard: `store.get('dataMode') === 'local'` at the top of apiCall().
 * These tests assert that guarantee directly against the real dispatcher
 * route tables (not mocked), plus the new F5 behavior: in local mode,
 * anything that misses LOCAL, DISABLED, and PAYLOAD *and* isn't on the
 * explicit PASSTHROUGH allowlist must fail loud instead of silently hitting
 * the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@/state/store';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import { resetLocalAPICache } from '@/api/dispatcher';
import { apiCall, ApiError } from '@/api/client';

describe('apiCall dataMode dispatch', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
    store.resetState();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  describe('server mode: pure passthrough', () => {
    it('never consults the dispatcher — fetch is called with the original endpoint unchanged', async () => {
      store.set('dataMode', 'server');
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ accounts: [] }),
      });

      // /api/portfolio/accounts has a LOCAL route in local mode; in server
      // mode it must go straight to fetch() with the exact endpoint string,
      // never touching tryLocalRoute/matchPayloadRoute.
      await apiCall('/api/portfolio/accounts');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(url).toBe('/api/portfolio/accounts');
    });

    it('goes straight to fetch() even for an endpoint that would be F5-disallowed in local mode', async () => {
      store.set('dataMode', 'server');
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
      });

      // This endpoint has no LOCAL/PAYLOAD/DISABLED/allowlist entry at all —
      // in local mode it would throw. In server mode it must not.
      await expect(apiCall('/api/some/arbitrary/v1/endpoint')).resolves.toEqual({});
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('local mode: LOCAL route (no network)', () => {
    it('serves /api/portfolio/accounts from LocalAPI without calling fetch', async () => {
      store.set('dataMode', 'local');

      const result = await apiCall('/api/portfolio/accounts');

      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('local mode: PASSTHROUGH allowlist', () => {
    it('allows GET /api/settings/deployment-info through to the network unchanged', async () => {
      store.set('dataMode', 'local');
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ is_heroku: false }),
      });

      const result = await apiCall('/api/settings/deployment-info');

      expect(result).toEqual({ is_heroku: false });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('local mode: F5 fail-loud on unmapped endpoints', () => {
    it('throws ApiError and never calls fetch for an endpoint with no local route and no allowlist entry', async () => {
      store.set('dataMode', 'local');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(apiCall('/api/some/arbitrary/v1/endpoint')).rejects.toThrow(ApiError);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('throws for a method mismatch even when the path matches an allowlisted GET-only rule', async () => {
      store.set('dataMode', 'local');
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(apiCall('/api/settings/version', { method: 'POST', body: {} })).rejects.toThrow(
        ApiError
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('local mode: liabilities routes', () => {
    it('serves liabilities locally and surfaces local failures as ApiError with the status', async () => {
      store.set('dataMode', 'local');
      expect(await apiCall('/api/liabilities')).toEqual([]);
      const err = await apiCall('/api/liabilities/nope').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).message).toBe('Liability not found');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
  describe('local mode: smart import errors', () => {
    it('keeps error_type in ApiError.data, like the server body', async () => {
      store.set('dataMode', 'local');
      const err = await apiCall('/api/smart-import/rules/nope', { method: 'DELETE' }).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).message).toBe('Rule not found.');
      expect((err as ApiError).data).toEqual({
        error_type: 'rule_not_found',
        detail: 'Rule not found.',
      });
      const bad = await apiCall('/api/smart-import/settings', {
        method: 'PUT',
        body: { retention_months: 13 },
      }).catch((e: unknown) => e);
      expect((bad as ApiError).data).toEqual({
        error_type: 'bad_request',
        detail: 'The request could not be read.',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('leaves data undefined for other local errors', async () => {
      store.set('dataMode', 'local');
      const err = await apiCall('/api/liabilities/nope').catch((e: unknown) => e);
      expect((err as ApiError).data).toBeUndefined();
    });
  });
});
